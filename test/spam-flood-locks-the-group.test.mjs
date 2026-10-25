/* A member flooding a group locks it, with one message, until a person opens
   it. Run: node test/spam-flood-locks-the-group.test.mjs

   The operator, 2026-10-21: "if someone goes rogue on one of the request
   chats and start spamming random stickers or messages then the bot can
   detect that and lock the chat", in every open group at once; "Chat should
   get locked and one message"; nothing deleted, nobody removed; and no
   automatic unlock. The Shabbos unlock must not reopen it either. */
import fs from 'node:fs';
import { SpamGuard, SPAM_DEFAULTS } from '../src/core/spam-guard.js';
import { WhatsAppBot } from '../src/core/bot.js';
import { DEFAULT_CONFIG } from '../src/config/schema.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const settle = () => new Promise((r) => setTimeout(r, 10));

const G = '120363000000000001@g.us';
function mk({ admins = [], subject = '02 MOVIE REQUESTS', cfg = {}, lockFails = false } = {}) {
  const data = {};
  const locks = [];
  let t = 1_800_000_000_000;
  const guard = new SpamGuard({
    store: { get: (k, d) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; } },
    getConfig: () => ({ spamGuard: cfg }),
    isAdmin: (jid, senderJid) => admins.includes(senderJid),
    groupName: () => subject,
    lock: async (jid, inc) => { if (lockFails) throw new Error('not-authorized'); locks.push({ jid, inc }); },
    now: () => t,
  });
  let n = 0;
  const send = (who, { type = 'conversation', text = 'hi', chat = G, at = null, ...rest } = {}) => guard.observe({
    id: `M${++n}`, chatJid: chat, isGroup: true, fromMe: false, senderJid: `${who}@lid`, senderNumber: who,
    messageType: type, text: type === 'stickerMessage' ? '' : text, timestamp: at ?? t, ...rest,
  });
  return { guard, locks, send, tick: (ms) => { t += ms; }, now: () => t };
}

console.log('=== one member flooding: locked once, with the incident ===');
{
  const h = mk();
  for (let i = 0; i < SPAM_DEFAULTS.perSender - 1; i++) { ok(h.send('111') === null, `message ${i + 1} is not a flood`); h.tick(2000); }
  const inc = h.send('111');
  await settle();
  ok(!!inc && /10 messages from one member/.test(inc.why), `the tenth in a minute is: ${inc?.why}`);
  ok(h.locks.length === 1 && h.locks[0].jid === G, 'the group is locked');
  ok(inc.senders[0].sender === '111', 'the sender is named for the report');
  ok(h.guard.isHeld(G), 'and held');
  for (let i = 0; i < 20; i++) h.send('111');
  await settle();
  ok(h.locks.length === 1, 'the rest of the flood locks nothing again: one lock, one message');
}

console.log('=== stickers trip it sooner ===');
{
  const h = mk();
  let inc = null;
  for (let i = 0; i < SPAM_DEFAULTS.perSenderMedia; i++) { inc = h.send('222', { type: 'stickerMessage' }); h.tick(1000); }
  await settle();
  ok(!!inc && /stickers or pictures/.test(inc.why), `six stickers in a minute: ${inc?.why}`);
}

console.log('=== what is not a flood ===');
{
  const slow = mk();
  for (let i = 0; i < 30; i++) { slow.send('333'); slow.tick(20_000); }
  await settle();
  ok(slow.locks.length === 0, 'thirty messages over ten minutes is a conversation');

  const admin = mk({ admins: ['999@lid'] });
  for (let i = 0; i < 40; i++) admin.send('999');
  await settle();
  ok(admin.locks.length === 0, 'an admin is never counted');

  const backlog = mk();
  for (let i = 0; i < 40; i++) backlog.send('444', { at: backlog.now() - 3600_000 + i * 60_000 });
  await settle();
  ok(backlog.locks.length === 0, 'an hour of messages handed over at once after a reconnect is not a flood');

  const priv = mk({ subject: '$ admins' });
  for (let i = 0; i < 40; i++) priv.send('555');
  await settle();
  ok(priv.locks.length === 0, 'a private ($) group is left alone');

  const reacts = mk();
  for (let i = 0; i < 40; i++) reacts.send('666', { type: 'reactionMessage', reaction: { emoji: '😂' } });
  await settle();
  ok(reacts.locks.length === 0, 'reactions add nothing to the chat and are not counted');

  const off = mk({ cfg: { enabled: false } });
  for (let i = 0; i < 40; i++) off.send('777');
  await settle();
  ok(off.locks.length === 0, 'switched off, it does nothing');
}

console.log('=== several numbers together ===');
{
  const h = mk();
  let inc = null;
  for (let i = 0; i < SPAM_DEFAULTS.perGroup; i++) { inc = h.send(String(800 + (i % 5))); h.tick(500); }
  await settle();
  ok(!!inc && /from 5 members/.test(inc.why), `30 messages from five numbers in a minute: ${inc?.why}`);
}

console.log('=== a failed lock is not retried on every message ===');
{
  const h = mk({ lockFails: true });
  for (let i = 0; i < 10; i++) h.send('111');
  await settle();
  ok(!h.guard.isHeld(G), 'not held when the lock failed');
  ok(h.send('111') === null, 'the next message of the same flood does not try again at once');
  h.tick(11 * 60_000);
  for (let i = 0; i < 9; i++) h.send('111');
  ok(h.send('111') !== null, 'ten minutes on, a flood tries again');
}

console.log('=== only a person reopens it ===');
{
  const h = mk();
  for (let i = 0; i < 10; i++) h.send('111');
  await settle();
  ok(h.guard.isHeld(G), 'held');
  ok(h.guard.release(G, 'test') && !h.guard.isHeld(G), 'released when an admin opens it');

  const bot = new WhatsAppBot({ configStore: { get: () => ({ whatsapp: {}, lockdown: { alwaysLocked: [], pacingMs: 0 } }) }, dataDir: '/tmp' });
  bot.state = 'connected';
  const calls = [];
  bot.sock = { user: { id: '1@s.whatsapp.net' }, groupSettingUpdate: async (jid, mode) => { calls.push({ jid, mode }); } };
  bot.groups = () => [{ jid: G, subject: '02 MOVIE REQUESTS' }, { jid: 'other@g.us', subject: '03 TV REQUESTS' }];
  bot.spamGuard = { isHeld: (jid) => jid === G };
  const res = await bot.setAllGroupsLocked(false);
  ok(!calls.some((c) => c.jid === G), 'havdalah does not open a group locked for spam');
  ok(calls.some((c) => c.jid === 'other@g.us' && c.mode === 'not_announcement'), 'and opens the others');
  ok(res.summary.spam === 1 && res.summary.alwaysLocked === 0, `counted as its own skip: ${JSON.stringify(res.summary)}`);
}

console.log('=== wired in ===');
{
  const idx = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  ok(/spamGuard\.observe\(msg\)/.test(idx), 'every message is counted');
  ok(/setGroupLocked\(jid, true\)/.test(idx) && /sendText\(jid, spamConfig/.test(idx), 'the lock and the one notice');
  ok(!/deleteMessage|modifyParticipants|removeParticipant/.test(idx.match(/bot\.spamGuard = new SpamGuard[\s\S]*?\n  \}\);/)[0]),
    'nothing deleted, nobody removed');
  ok(/bot\.on\('group-opened'/.test(idx), 'an admin opening it in WhatsApp lifts the hold');
  const bot = fs.readFileSync(new URL('../src/core/bot.js', import.meta.url), 'utf8');
  ok(/u\.announce === false/.test(bot), 'groups.update with announce off is noticed');
  const api = fs.readFileSync(new URL('../src/web/api.js', import.meta.url), 'utf8');
  ok(/if \(!locked\) bot\.spamGuard\?\.release/.test(api), 'the panel unlock lifts the hold');
  ok(DEFAULT_CONFIG.spamGuard?.enabled === true, 'on by default');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
