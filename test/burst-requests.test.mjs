/* Many people requesting at once, and one person spamming.
   Run: node test/burst-requests.test.mjs

   These are opposite cases and must not be confused. Ten different people
   requesting in the same second is a busy group working normally - every one
   must go through. One person firing fifteen in a row is throttled, but the
   throttle used to `return` silently: no reaction, no reply, nothing. The
   requester assumed the bot had missed them, which is exactly what it looked
   like from the group.

   Since 2026-10-01 a member's clock starts only when a request of theirs
   queues a film (the operator's rule after Ben Lewis's three 🚫,
   test/cooldown-after-queued.test.mjs). offer() below stops each request at
   its 🔍, before anything is queued, so the spamming cases write the clock
   the first request's film would have started (queued), and "accepted"
   means the request reached the lookup - it no longer moves the clock by
   arriving. */
import fs from 'node:fs';
import plugin from '../src/plugins/movie-requests/index.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const GROUP = 'req@g.us';

function harness({ cooldownSeconds = 30, admins = [], replyOnBlock = true } = {}) {
  const store = {};
  const seen = { reacted: [], replied: [], accepted: [] };
  const ctx = {
    store: {
      get: (k, d) => store[k] ?? d,
      set: (k, v) => { store[k] = v; },
    },
    log: { info() {}, warn() {}, debug() {}, error() {} },
    config: {
      movieRequests: {
        requestGroups: [GROUP], requirePrefix: true, prefix: '#request',
        cooldownSecondsPerUser: cooldownSeconds, replyOnBlock,
        reactions: { researching: '🔍', tooFast: '🚫' },
      },
    },
    bot: {
      isGroupAdmin: (g, { jid }) => admins.includes(jid),
      react: async (msg, e) => { seen.reacted.push({ from: msg.senderJid, emoji: e }); },
      sendText: async (jid, body) => { seen.replied.push(body); },
      // Anything past the cooldown gate reaches the lookup; stop it there.
      isConnected: () => true,
      deleteMessage: async () => {},
    },
  };
  return { ctx, seen, store };
}

function message(from, text, at = Date.now()) {
  return {
    id: `m-${from}-${at}-${Math.random()}`,
    chatJid: GROUP, senderJid: from, senderNumber: from.split('@')[0],
    pushName: from, text, timestamp: at,
    isGroup: true, fromMe: false,          // the handler returns early without these
    key: { id: 'k', remoteJid: GROUP },
  };
}

/**
 * Drive only the cooldown gate. The full handler goes on to hit OMDb, so stop
 * as soon as the request is accepted - the gate is what is under test.
 */
async function offer(ctx, msg) {
  let accepted = false;
  const bot = ctx.bot;
  const patched = { ...ctx, bot: { ...bot, react: async (m, e) => {
    if (e === '🔍') { accepted = true; throw new Error('stop here'); }
    return bot.react(m, e);
  } } };
  try { await plugin.onMessage(msg, patched); } catch { /* stopped deliberately */ }
  return { accepted };
}

/** The clock a request's queued film starts (src/core/request-cooldown.js). */
const queued = (store, jid, at = Date.now()) => { store[`cooldown:${jid}`] = { at, what: 'a film' }; };

console.log('=== ten different people requesting at the same moment ===');
{
  const { ctx, seen } = harness();
  const now = Date.now();
  const results = [];
  for (let i = 0; i < 10; i++) {
    results.push(await offer(ctx, message(`person${i}@lid`, `#request Movie ${i}`, now)));
  }
  const through = results.filter((r) => r.accepted).length;
  ok(through === 10, `all ten got through (${through}/10) — a busy group is not abuse`);
  ok(seen.reacted.filter((r) => r.emoji === '🚫').length === 0, 'nobody was throttled');
  ok(seen.replied.length === 0, 'and nobody was told to wait');
}

console.log('=== one person firing repeatedly IS throttled ===');
{
  const { ctx, seen, store } = harness();
  const now = Date.now();
  const first = await offer(ctx, message('spammer@lid', '#request One', now));
  ok(first.accepted, 'the first request is accepted');
  queued(store, 'spammer@lid');                     // and its film queued

  const results = [];
  for (let i = 0; i < 5; i++) {
    results.push(await offer(ctx, message('spammer@lid', `#request Number ${i}`, now)));
  }
  ok(results.every((r) => !r.accepted), 'the rest are held back');
  ok(seen.reacted.filter((r) => r.emoji === '🚫').length === 5,
    'and EVERY held request gets a reaction — silence is what made this look broken');
}

console.log('=== the throttled person is told why, and for how long ===');
{
  const { ctx, seen, store } = harness({ cooldownSeconds: 30 });
  const now = Date.now();
  await offer(ctx, message('u@lid', '#request One', now));
  queued(store, 'u@lid');
  await offer(ctx, message('u@lid', '#request Two', now));
  ok(seen.replied.length === 1, 'a reply is sent');
  const r = seen.replied[0];
  ok(/denied/i.test(r) && /too many at once/i.test(r), `it says what happened: "${r.slice(0, 60)}…"`);
  ok(/\d+s/.test(r), 'and how long to wait');
  ok(/everyone gets a turn/i.test(r), 'and why the rule exists');
}

console.log('=== admins are exempt, so testing does not throttle you ===');
{
  const { ctx, seen } = harness({ admins: ['boss@lid'] });
  const now = Date.now();
  const results = [];
  for (let i = 0; i < 8; i++) {
    results.push(await offer(ctx, message('boss@lid', `#request Film ${i}`, now)));
  }
  ok(results.every((r) => r.accepted), 'an admin is never held back');
  ok(seen.reacted.filter((r) => r.emoji === '🚫').length === 0, 'and never told to slow down');
  ok(seen.replied.length === 0, 'with no reply either');
}

console.log('=== the cooldown expires ===');
{
  const { ctx, store } = harness({ cooldownSeconds: 30 });
  const now = Date.now();
  await offer(ctx, message('u@lid', '#request One', now));
  queued(store, 'u@lid', now - 31_000);           // its film queued 31s ago
  const later = await offer(ctx, message('u@lid', '#request Two', now));
  ok(later.accepted, 'after the wait the next request is accepted');
}

console.log('=== the reply can be switched off without losing the reaction ===');
{
  const { ctx, seen, store } = harness({ replyOnBlock: false });
  const now = Date.now();
  await offer(ctx, message('u@lid', '#request One', now));
  queued(store, 'u@lid');
  await offer(ctx, message('u@lid', '#request Two', now));
  ok(seen.replied.length === 0, 'no message is posted to the group');
  ok(seen.reacted.some((r) => r.emoji === '🚫'),
    'but the reaction still marks it, so it is never silently dropped');
}

console.log('=== the throttle is keyed per PERSON, never globally ===');
{
  // The keys live in src/core/request-cooldown.js since 2026-10-01, and the
  // plugin asks for them by the sender.
  const mod = fs.readFileSync(new URL('../src/core/request-cooldown.js', import.meta.url), 'utf8');
  const src = fs.readFileSync(new URL('../src/plugins/movie-requests/index.js', import.meta.url), 'utf8');
  ok(/clock: `cooldown:\$\{who\}`/.test(mod) && /cooldownKeys\(msg\.senderJid/.test(src),
    'the key includes the sender — a global key would throttle a whole group for one person');
  // The property that matters is not the shape of the code but that nothing
  // leaves the gate unacknowledged: the throttled branch reacts before it
  // returns.
  const gate = src.match(/if \(!turn\.go\) \{[\s\S]*?\n    \}/)[0];
  ok(/this\._tooSoon\(/.test(gate) && gate.indexOf('_tooSoon(') < gate.lastIndexOf('return'), 'the throttled branch answers before returning');
  const tooSoon = src.match(/async _tooSoon\(ctx, msg, no\) \{[\s\S]*?\n  \},/)[0];
  ok(/ctx\.bot\.react\(/.test(tooSoon), 'and the answer is a reaction, whatever else it says');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
