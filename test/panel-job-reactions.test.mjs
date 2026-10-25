/* A job with no WhatsApp message behind it never reacts.
   Run: node test/panel-job-reactions.test.mjs

   The incident, 2026-09-28 01:36 UTC: a restart resumed films an admin had
   queued from the panel. Their journal entries carry a placeholder message
   id ("manual-1790263529080") and no message key. requeue() gives such a job
   a no-op react; recoverPending did not, so every stage of every resumed
   panel job sent a reaction with key: null - "reacted 🔄 on
   manual-1790263529080" - and Baileys threw while echoing that reaction back
   to itself (stringifyMessageKey, event-buffer.js), in a promise no code of
   ours holds: 24 "unhandled rejection: Cannot read properties of null
   (reading 'remoteJid')" that day, 23 of them as the restart resumed them. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WhatsAppBot } from '../src/core/bot.js';
import moviePlugin from '../src/plugins/movie-requests/index.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

function makeBot() {
  const bot = new WhatsAppBot({ configStore: { get: () => ({ whatsapp: {} }) }, dataDir: '/tmp' });
  bot.state = 'connected';
  bot.sent = [];
  bot.sock = { sendMessage: async (jid, content) => { bot.sent.push({ jid, content }); return {}; } };
  return bot;
}

console.log('=== bot.react does nothing without a real message key ===');
{
  const bot = makeBot();
  const before = JSON.stringify(bot.budget.toJSON());
  const r1 = await bot.react({ id: 'manual-1790263529080', key: null, chatJid: 'posts@g.us' }, '🔄');
  const r2 = await bot.react({ id: 'x', key: { id: 'x' }, chatJid: 'posts@g.us' }, '⬇️');
  const r3 = await bot.react(null, '✅');
  ok(r1 === false && r2 === false && r3 === false, 'it answers false, as a shed reaction does');
  ok(bot.sent.length === 0, 'and nothing reaches the socket - the null key never goes on the wire');
  ok(JSON.stringify(bot.budget.toJSON()) === before, 'nor is it counted against the outbound budget');

  bot.state = 'connecting';
  let threw = null;
  try { await bot.react({ id: 'manual-1', key: null }, '🔄'); } catch (e) { threw = e; }
  ok(!threw, 'even while disconnected it is a quiet no-op, not "WhatsApp is not connected"');
  bot.state = 'connected';

  const real = { id: 'AC0C4E3B', key: { remoteJid: 'req@g.us', id: 'AC0C4E3B', fromMe: false }, chatJid: 'req@g.us' };
  const r4 = await bot.react(real, '🔄');
  ok(r4 === true && bot.sent.length === 1, 'a real request message still gets its reaction');
  ok(bot.sent[0].content.react.key.remoteJid === 'req@g.us', 'with its key intact');
}

console.log('=== a panel job resumed after a restart never reacts; a group request still does ===');
{
  const LIB = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-lib-'));
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-work-'));
  fs.writeFileSync(path.join(LIB, 'Ready Player One 2018.mp4'), 'x');
  fs.writeFileSync(path.join(LIB, 'Spaceballs 1987.mp4'), 'x');

  const data = {};
  const store = { get: (k, d = null) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; }, push() {} };
  // Exactly what requeue() journals for a film typed into the panel...
  const panel = { id: 'manual-1790263529080', request: 'ready player one', status: 'queued',
    title: 'Ready Player One', year: 2018, rated: 'PG-13', groupJid: 'posts@g.us' };
  // ...and what onMessage journals for a request in a group.
  const group = { id: 'AC0C4E3B', request: 'spaceballs', status: 'queued', title: 'Spaceballs', year: 1987, rated: 'PG' };
  store.set('pending', [{
    jobKey: 'manual-1790263529080:tt1677720', msgId: panel.id, msgKey: null, chatJid: 'posts@g.us',
    movie: { title: 'Ready Player One', year: 2018, imdbId: 'tt1677720', rated: 'PG-13' },
    meta: { requester: 'manual (admin)', group: 'posts@g.us' }, record: panel, at: Date.now(),
  }, {
    jobKey: 'AC0C4E3B:tt0094012', msgId: group.id, msgKey: { remoteJid: 'req@g.us', id: 'AC0C4E3B', fromMe: false },
    chatJid: 'req@g.us', movie: { title: 'Spaceballs', year: 1987, imdbId: 'tt0094012', rated: 'PG' },
    meta: { requester: 'Dana', group: 'req@g.us' }, record: group, at: Date.now(),
  }]);

  const reacted = [];
  const added = [];
  const ctx = {
    store,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    queue: { add: (job, opts) => { added.push({ job, opts }); return `q${added.length}`; } },
    bot: {
      isConnected: () => false,               // fails each job at once, transiently
      react: async (msg, e) => { reacted.push(`${msg.id} ${e}`); return true; },
      on() {}, off() {}, sendText: async () => ({}), groups: () => [],
    },
    config: {
      movieRequests: { reactions: { redo: '🔄', added: '🎬', failed: '⚠️', downloading: '⬇️', rated: '⛔' }, notify: {}, blockedRatings: [] },
      media: { workDir: WORK },
      library: { provider: 'local', local: { roots: [LIB] } },
      omdb: {},
    },
  };

  await moviePlugin.recoverPending(ctx);
  ok(added.length === 2, 'both jobs are resumed');
  ok(!reacted.some((r) => r.startsWith('manual-')), `no reaction on "manual-..." (${reacted.join(', ') || 'none'})`);
  // Where it is - nothing of it done yet, so 🎬 - not 🔄, which a member
  // read as "send it again" (Iron Man 3, 2026-10-11).
  ok(reacted.includes('AC0C4E3B 🎬') && !reacted.some((r) => r.endsWith('🔄')),
    `while the group request is still shown where it is, 🎬 (${reacted.join(', ')})`);

  // And its delivery: every stage reaction goes through that same react.
  reacted.length = 0;
  for (const { job } of added) {
    try {
      await job.run({ id: 'j1', signal: new AbortController().signal, progress() {}, isCancelled: () => false, cancelReason: () => null });
    } catch { /* the transient failure is the point */ }
  }
  ok(!reacted.some((r) => r.startsWith('manual-')), 'nor on any stage of the panel job\'s delivery');
  // Its transient failure leaves it where it was, 🎬, which its message
  // shows already: nothing is sent twice (_reactFor), and never 🔄.
  ok(!reacted.some((r) => r.endsWith('🔄')) && !reacted.includes('AC0C4E3B 🎬'),
    `where the group request, failing transiently, is left on the 🎬 it shows (${reacted.join(', ') || 'none'})`);

  fs.rmSync(LIB, { recursive: true, force: true });
  fs.rmSync(WORK, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
