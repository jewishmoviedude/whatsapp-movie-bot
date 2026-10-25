/* Ban wipes recent messages. Run: node test/ban-wipe.test.mjs */
import { MessageIndex, senderKeyOf, DEFAULT_WINDOW_MS } from '../src/core/message-index.js';
import { WhatsAppBot } from '../src/core/bot.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const NOW = 1_800_000_000_000;
const mkMsg = (o = {}) => ({
  isGroup: true, fromMe: false, id: 'M1', chatJid: 'g1@g.us',
  senderJid: 'aaa@lid', senderNumber: '15551112222', timestamp: NOW, ...o,
});

console.log('=== senderKeyOf ===');
ok(senderKeyOf({ senderNumber: '1555', senderJid: 'x@lid' }) === 'num:1555', 'number preferred');
ok(senderKeyOf({ senderJid: 'x@lid' }) === 'lid:x@lid', 'falls back to jid');
ok(senderKeyOf({}) === null, 'nothing -> null');
ok(DEFAULT_WINDOW_MS === 172800000, 'default window is 2 days');

console.log('=== recording ===');
{
  const ix = new MessageIndex();
  ok(ix.record(mkMsg(), NOW) === true, 'records a group message');
  ok(ix.record(mkMsg({ isGroup: false }), NOW) === false, 'ignores DMs');
  ok(ix.record(mkMsg({ fromMe: true }), NOW) === false, "ignores the bot's own messages");
  ok(ix.record(mkMsg({ id: null }), NOW) === false, 'ignores messages with no id');
  ok(ix.size === 1, 'only the valid one was kept');
}

console.log('=== 2-day window ===');
{
  const ix = new MessageIndex();
  ix.record(mkMsg({ id: 'fresh', timestamp: NOW - 3600_000 }), NOW);              // 1h old
  ix.record(mkMsg({ id: 'old', timestamp: NOW - 3 * 86_400_000 }), NOW);          // 3 days old
  const found = ix.forSender({ number: '15551112222' }, NOW);
  ok(found.length === 1 && found[0].key.id === 'fresh', 'only messages inside the 2-day window are returned');
  ok(ix.size === 1, 'expired entries pruned from storage');
}

console.log('=== matches by number or lid ===');
{
  const ix = new MessageIndex();
  ix.record(mkMsg({ id: 'byNum', senderNumber: '15551112222', senderJid: null }), NOW);
  ix.record(mkMsg({ id: 'byLid', senderNumber: null, senderJid: 'bbb@lid' }), NOW);
  ok(ix.forSender({ number: '15551112222' }, NOW).length === 1, 'found by phone number');
  ok(ix.forSender({ jid: 'bbb@lid' }, NOW).length === 1, 'found by @lid');
  ok(ix.forSender({ number: '19999999999' }, NOW).length === 0, 'stranger matches nothing');
}

console.log('=== delete key shape (Baileys delete-for-everyone) ===');
{
  const ix = new MessageIndex();
  ix.record(mkMsg({ id: 'K1' }), NOW);
  const [t] = ix.forSender({ number: '15551112222' }, NOW);
  ok(t.key.remoteJid === 'g1@g.us' && t.key.id === 'K1', 'key carries chat + message id');
  ok(t.key.fromMe === false && t.key.participant === 'aaa@lid', 'key marks the original sender (required to revoke someone else)');
}

console.log('=== forget clears a person ===');
{
  const ix = new MessageIndex();
  ix.record(mkMsg({ id: 'A' }), NOW);
  ix.record(mkMsg({ id: 'B', senderNumber: '19998887777', senderJid: 'zzz@lid' }), NOW);
  const removed = ix.forget({ number: '15551112222' });
  ok(removed === 1, 'forget drops that person only');
  ok(ix.forSender({ number: '19998887777' }, NOW).length === 1, 'other people untouched');
}

console.log('=== cap enforced (oldest dropped) ===');
{
  const ix = new MessageIndex({ cap: 3 });
  for (let i = 0; i < 6; i++) ix.record(mkMsg({ id: `m${i}`, timestamp: NOW - (10 - i) * 1000 }), NOW);
  ok(ix.size === 3, 'cap respected');
  const ids = ix.forSender({ number: '15551112222' }, NOW).map((t) => t.key.id);
  ok(ids.includes('m5') && !ids.includes('m0'), 'newest kept, oldest dropped');
}

console.log('=== persistence through a store ===');
{
  const backing = {};
  const store = { get: (k, d) => backing[k] ?? d, set: (k, v) => { backing[k] = v; } };
  const ix = new MessageIndex({ store });
  ix.record(mkMsg({ id: 'P1' }), NOW);
  ok(Array.isArray(backing.entries) && backing.entries.length === 1, 'written through to the store');
  const reloaded = new MessageIndex({ store });
  ok(reloaded.forSender({ number: '15551112222' }, NOW).length === 1, 'survives a restart');
}

console.log('=== bot.deleteRecentMessagesFrom revokes each message ===');
{
  const bot = new WhatsAppBot({ configStore: { get: () => ({ whatsapp: {} }) }, dataDir: '/tmp' });
  const sent = [];
  bot.sock = { sendMessage: async (jid, content) => { sent.push({ jid, content }); return {}; } };
  bot.state = 'connected';
  bot.messageIndex = new MessageIndex();
  bot.messageIndex.record(mkMsg({ id: 'X1', chatJid: 'g1@g.us' }), Date.now());
  bot.messageIndex.record(mkMsg({ id: 'X2', chatJid: 'g2@g.us' }), Date.now());
  const r = await bot.deleteRecentMessagesFrom({ number: '15551112222' });
  ok(r.deleted === 2, 'both messages revoked');
  ok(sent.every((s) => s.content.delete), 'sent as { delete: key } (delete-for-everyone)');
  ok(sent[0].content.delete.participant === 'aaa@lid', 'revoke targets the original sender');
  ok(bot.messageIndex.size === 0, 'index cleared for that person afterwards');
}

console.log('=== a failing revoke is counted, not fatal ===');
{
  const bot = new WhatsAppBot({ configStore: { get: () => ({ whatsapp: {} }) }, dataDir: '/tmp' });
  bot.sock = { sendMessage: async () => { throw new Error('not-admin'); } };
  bot.state = 'connected';
  bot.messageIndex = new MessageIndex();
  bot.messageIndex.record(mkMsg({ id: 'Y1' }), Date.now());
  const r = await bot.deleteRecentMessagesFrom({ number: '15551112222' });
  ok(r.deleted === 0 && r.failed === 1, 'failure counted without throwing');
}

console.log('=== ban wipes first, then removes ===');
{
  const bot = new WhatsAppBot({ configStore: { get: () => ({ whatsapp: {} }) }, dataDir: '/tmp' });
  const order = [];
  bot.sock = { sendMessage: async (jid, c) => { if (c.delete) order.push('wipe'); return {}; } };
  bot.state = 'connected';
  bot.messageIndex = new MessageIndex();
  bot.messageIndex.record(mkMsg({ id: 'Z1' }), Date.now());
  bot.groupCache = new Map([['g1@g.us', { jid: 'g1@g.us', subject: 'G1', memberIds: new Set(['aaa@lid']), memberNumbers: new Set(['15551112222']) }]]);
  bot._rawParticipant = async () => { order.push('remove'); return 'removed'; };
  bot.refreshGroups = async () => [];
  const results = await bot.banFromAllGroups('15551112222');
  ok(order[0] === 'wipe' && order.includes('remove'), 'messages wiped BEFORE removal');
  ok(results.wiped.deleted === 1, 'wipe count reported on the result');
  // and it can be turned off
  order.length = 0;
  bot.messageIndex.record(mkMsg({ id: 'Z2' }), Date.now());
  await bot.banFromAllGroups('15551112222', { wipeMessages: false });
  ok(!order.includes('wipe'), 'wipeMessages:false skips deletion');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
