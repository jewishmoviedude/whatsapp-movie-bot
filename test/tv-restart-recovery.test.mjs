/* A restart must not silently swallow a season.
   Run: node test/tv-restart-recovery.test.mjs

   This is a real incident, not a hypothetical. A restart on 31 Aug dropped 47
   queued episodes - American Dad season 2 (16), The Summer I Turned Pretty
   season 2 (8) and The Mentalist season 1 (23). The queue lives in memory;
   movies were journalled to disk and replayed, TV was not, so every episode
   vanished and nobody who asked for one was told anything.

   Journalling is per REQUEST, not per episode: a season shares one notifier
   and one history row, so recovering episodes individually would report
   "1 of 1 posted" twenty-three times. */
import fs from 'node:fs';
import plugin from '../src/plugins/tv-requests/index.js';
import { JobQueue } from '../src/core/queue.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const ep = (n, series = 'The Mentalist', season = 1) =>
  ({ id: `id-${series}-${season}-${n}`, series, season, episode: n, title: `Ep ${n}`, size: 1e8 });

function ctxFor(store = {}) {
  const queued = [];
  return {
    queued,
    store: { get: (k, d) => (k in store ? store[k] : d), set: (k, v) => { store[k] = v; } },
    raw: store,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    config: { tvRequests: {}, movieRequests: { reactions: { redo: '🔄', done: '✅' } } },
    queue: {
      // A real cap, honouring overLimit exactly as JobQueue.add does.
      maxLength: 500, pending: [], overLimit: 0,
      add(j, { overLimit = false } = {}) {
        if (!overLimit && this.pending.length >= this.maxLength) {
          throw Object.assign(new Error('Queue is full'), { code: 'QUEUE_FULL' });
        }
        if (overLimit) this.overLimit += 1;
        this.pending.push(j); queued.push(j); return 'id';
      },
    },
    bot: { isConnected: () => true, react: async () => {}, on() {}, off() {} },
  };
}

console.log('=== a queued season is written to disk ===');
{
  const ctx = ctxFor();
  const episodes = [1, 2, 3].map((n) => ep(n));
  plugin._journalAdd(ctx, { reqKey: 'r1', label: 'The Mentalist season 1', episodes });
  const pending = ctx.raw.pending;
  ok(pending?.length === 1, 'the request is journalled');
  ok(pending[0].episodes.length === 3, 'with all three episodes');
}

console.log('=== finished episodes come off, the rest stay ===');
{
  const ctx = ctxFor();
  plugin._journalAdd(ctx, { reqKey: 'r1', label: 'x', episodes: [1, 2, 3].map((n) => ep(n)) });
  plugin._journalEpisodeDone(ctx, 'r1', 'id-The Mentalist-1-1');
  ok(ctx.raw.pending[0].episodes.length === 2, 'one done, two still outstanding');
  ok(!ctx.raw.pending[0].episodes.some((e) => e.episode === 1), 'and it is the right one');

  plugin._journalEpisodeDone(ctx, 'r1', 'id-The Mentalist-1-2');
  plugin._journalEpisodeDone(ctx, 'r1', 'id-The Mentalist-1-3');
  ok(ctx.raw.pending.length === 0, 'the request disappears once every episode is done');
}

console.log('=== an unknown key is harmless ===');
{
  const ctx = ctxFor();
  plugin._journalAdd(ctx, { reqKey: 'r1', label: 'x', episodes: [ep(1)] });
  plugin._journalEpisodeDone(ctx, 'nope', 'id-x');
  plugin._journalEpisodeDone(ctx, null, 'id-x');
  ok(ctx.raw.pending[0].episodes.length === 1, 'nothing is dropped by a stray call');
}

console.log('=== the incident: 47 episodes survive a restart ===');
{
  const store = {};
  const before = ctxFor(store);
  const seasons = [
    ['American Dad!', 2, 16],
    ['The Summer I Turned Pretty', 2, 8],
    ['The Mentalist', 1, 23],
  ];
  for (const [series, season, count] of seasons) {
    plugin._journalAdd(before, {
      reqKey: `r-${series}`, label: `${series} season ${season}`,
      msgId: 'm1', msgKey: { id: 'm1' }, chatJid: 'g@g.us',
      episodes: Array.from({ length: count }, (_, i) => ep(i + 1, series, season)),
    });
  }
  const total = store.pending.reduce((n, r) => n + r.episodes.length, 0);
  ok(total === 47, `all 47 episodes are on disk before the restart (${total})`);

  // --- process restarts; a fresh ctx reads the same store ---
  const after = ctxFor(store);
  await plugin.recoverPending(after);
  ok(after.queued.length === 47, `all 47 are re-queued (${after.queued.length})`);
  ok(after.queued.every((j) => j.kind === 'tv'), 'still TV, so they stay behind movies');
  ok(after.queued.every((j) => j.meta.resumed), 'and marked resumed');

  const mentalist = after.queued.filter((j) => j.meta.series === 'The Mentalist');
  ok(mentalist.length === 23, 'The Mentalist keeps all 23');
  ok(mentalist[0].meta.position === '1/23', `positions are renumbered for the run (${mentalist[0].meta.position})`);
}

console.log('=== a partly-finished season resumes only what is left ===');
{
  const store = {};
  const c = ctxFor(store);
  plugin._journalAdd(c, { reqKey: 'r1', label: 'S1', episodes: [1, 2, 3, 4, 5].map((n) => ep(n)) });
  plugin._journalEpisodeDone(c, 'r1', 'id-The Mentalist-1-1');
  plugin._journalEpisodeDone(c, 'r1', 'id-The Mentalist-1-2');

  const after = ctxFor(store);
  await plugin.recoverPending(after);
  ok(after.queued.length === 3, `only the outstanding three are re-queued (${after.queued.length})`);
  ok(!after.queued.some((j) => j.meta.episode <= 2), 'the two already posted are not sent twice');
}

console.log('=== an episode that failed before a restart still ends the season on ⚠️ ===');
{
  // Found in review (2026-09-29), with this example: a season loses E02 for
  // good, its message shows ⚠️, and the episode leaves the journal with
  // nothing on the entry to say how. The hourly check restarts the bot into
  // a fix while E05 runs, and the rest comes back as a request of six with
  // nothing failed: it ends on ✅, History says "sent, 6 episode(s) posted
  // (resumed)", and followers are told ✅. The journal now keeps a tally of
  // how its episodes ended, and the resumed request starts from it.
  const store = {};
  const before = ctxFor(store);
  plugin._journalAdd(before, {
    reqKey: 'r1', label: 'The Boys season 1', msgId: 'M', msgKey: { id: 'M' }, chatJid: 'g@g.us',
    baseRow: { id: 'M', kind: 'tv', title: 'The Boys', season: 1, status: 'queued' },
    episodes: [1, 2, 3, 4].map((n) => ep(n, 'The Boys')),
  });
  plugin._journalEpisodeDone(before, 'r1', 'id-The Boys-1-1', 'done');
  plugin._journalEpisodeDone(before, 'r1', 'id-The Boys-1-2', 'failed', 'media file is too large for WhatsApp');
  ok(JSON.stringify(store.pending[0].tally) === '{"completed":1,"failed":1,"cancelled":0,"skipped":0,"why":"media file is too large for WhatsApp"}',
    `the journal counts E01 posted and E02 failed (${JSON.stringify(store.pending[0].tally)})`);
  plugin._journalEpisodeDone(before, 'r1', 'id-The Boys-1-2', 'failed');
  ok(store.pending[0].tally.failed === 1, 'an episode already gone is not counted twice');

  // --- the bot restarts; E03 and E04 are resumed and posted ---
  const after = ctxFor(store);
  const reacted = [];
  after.bot.react = async (msg, emoji) => { reacted.push(emoji); return true; };
  await plugin.recoverPending(after);
  ok(after.queued.length === 2, `the two left are resumed (${after.queued.length})`);
  const live = plugin._live.get('r1');
  ok(live?.notifier.total === 4, `as the request of four it was (${live?.notifier.total})`);
  live.notifier.episodeDone();
  live.notifier.episodeDone();
  await plugin._reactEnding(after, live.notifier, live.react);
  ok(reacted.at(-1) === '⚠️' && !reacted.includes('✅'), `the message ends on ⚠️, not ✅ (${reacted.join(' ')})`);
  const row = (store.history ?? []).find((h) => h.id === 'M');
  ok(row?.status === 'partial' && /^3 of 4 posted after a restart, 1 failed/.test(row.detail ?? ''),
    `History says partial (${row?.status}: ${row?.detail})`);
  plugin._live.clear();
}

console.log('=== recovery re-journals, so a second restart still works ===');
{
  const store = {};
  plugin._journalAdd(ctxFor(store), { reqKey: 'r1', label: 'S1', episodes: [ep(1), ep(2)] });

  const first = ctxFor(store);
  await plugin.recoverPending(first);
  ok(store.pending?.length === 1, 'the journal is rewritten, not just consumed');

  const second = ctxFor(store);
  await plugin.recoverPending(second);
  ok(second.queued.length === 2, 'a restart during recovery still recovers');
}

console.log('=== a bad entry cannot replay for ever ===');
{
  const store = { pending: [{ reqKey: 'bad', label: 'broken', episodes: null }] };
  const c = ctxFor(store);
  await plugin.recoverPending(c);
  ok(c.queued.length === 0, 'an entry with no episodes queues nothing');
  ok((store.pending ?? []).length === 0, 'and is cleared rather than retried on every boot');
}

/** The same, over the real queue - paused, so nothing runs. */
function realCtx(store, { maxLength = 50 } = {}) {
  const c = ctxFor(store);
  const q = new JobQueue({ concurrency: 1, maxLength });
  q.pause();
  const add = q.add.bind(q);
  q.add = (j, o) => { const id = add(j, o); c.queued.push(j); return id; };
  c.queue = q;
  return c;
}

console.log('=== a season bigger than the whole queue is resumed whole, as one request ===');
{
  // The real shape: 122 episodes were journalled against a 50-place queue.
  // Fed in one episode per place, a season took every place in the line on
  // its own; a request is one place now, however many episodes it has. And
  // it goes back past the limit: fed in only as places freed, a queue already
  // full of recovered films (which go past the limit too - the 01:36 restart
  // on 2026-09-28 refused "Ready Player One" otherwise) left it waiting.
  const store = {};
  plugin._journalAdd(ctxFor(store), {
    reqKey: 'big', label: 'Prison Break season 4 — 22 episode(s)',
    episodes: Array.from({ length: 22 }, (_, i) => ep(i + 1, 'Prison Break', 4)),
  });

  const after = realCtx(store, { maxLength: 8 });
  for (let i = 0; i < 8; i++) after.queue.add({ label: `Film ${i}`, run: async () => {} });   // every place taken
  after.queued.length = 0;
  await plugin.recoverPending(after);
  ok(after.queued.length === 22, `all 22 are queued, past the full queue (${after.queued.length})`);
  ok(after.queue.waitingCount() === 9, `as ONE request next to the 8 films (${after.queue.waitingCount()})`);
  const row = after.queue.snapshot().pending.find((it) => it.group === 'big');
  ok(row?.label === 'Prison Break season 4' && row?.jobs.total === 22,
    `one row: "${row?.label}", ${row?.jobs.total} episodes`);
  ok(store.pending[0].episodes.length === 22, 'all 22 stay journalled until each is done');
  ok(after.queued.at(-1).meta.position === '22/22' && /isLast: i === episodes\.length - 1/.test(
    fs.readFileSync(new URL('../src/plugins/tv-requests/index.js', import.meta.url), 'utf8')),
  'the whole remainder goes in together, so its last episode is known - a resumed season gets its ✅');

  const first = after.queue.pending.find((e) => e.group === 'big');
  after.queue.pending.splice(after.queue.pending.indexOf(first), 1);
  plugin._journalEpisodeDone(after, 'big', `id-Prison Break-4-${first.meta.episode}`);
  ok(after.queued.length === 22, 'a finished episode pulls nothing in twice');
  ok(store.pending[0].episodes.length === 21, 'and the finished one is struck off');
}

console.log('=== every leftover request goes back, one place each, however full the queue ===');
{
  const store = {};
  for (const k of ['r1', 'r2']) {
    plugin._journalAdd(ctxFor(store), { reqKey: k, label: `${k} season 1`, episodes: [1, 2, 3].map((n) => ep(n, k)) });
  }
  const c = realCtx(store, { maxLength: 1 });
  c.queue.add({ label: 'A film', run: async () => {} });   // the only place is taken
  c.queued.length = 0;
  await plugin.recoverPending(c);
  ok(c.queued.length === 6, `both requests are queued whole (${c.queued.length})`);
  ok(c.queue.pendingLabels().join() === 'A film,r1 season 1,r2 season 1',
    `each as one item, in journal order, films first (${c.queue.pendingLabels().join()})`);
  plugin._pump(c);
  ok(c.queued.length === 6, 'and a later pump, with no place free, adds nothing');
}

console.log('=== nothing is queued twice ===');
{
  const store = {};
  plugin._journalAdd(ctxFor(store), { reqKey: 'r', label: 'S1', episodes: [1, 2, 3, 4].map((n) => ep(n)) });
  const c = realCtx(store, { maxLength: 2 });
  await plugin.recoverPending(c);
  ok(c.queued.length === 4, 'four episodes queued');
  plugin._pump(c);
  plugin._pump(c, { overLimit: true });
  ok(c.queued.length === 4 && c.queue.pending.length === 4, 'and pumping again does not duplicate them');
}

console.log('=== the notifier counts the whole request, not the batch ===');
{
  // A season fed in over three passes must still conclude exactly once, and
  // report "22 of 22", not "8 of 8" three times.
  const src = fs.readFileSync(new URL('../src/plugins/tv-requests/index.js', import.meta.url), 'utf8');
  const rec = src.slice(src.indexOf('async recoverPending'), src.indexOf('async deliverEpisode'));
  // The episodes that ended before the restart count too (the journal's
  // tally), so a season that lost one then still ends on ⚠️.
  ok(/const total = episodes\.length \+ counts\.completed \+ counts\.failed \+ counts\.cancelled;/.test(rec)
    && /total, msg, single: total === 1/.test(rec),
    'the notifier total is the whole request: what is outstanding, and what ended before the restart');
  ok(/this\._live\.set\(req\.reqKey, \{ notifier, msg, react, (?:share, )?queued: new Set\(\)(?:, redo: true)?(?:, startedBefore)? \}\)/.test(rec),
    'and the notifier is kept so later batches report to the SAME one');
  ok(/this\._live\?\.delete\(req\.reqKey\)/.test(rec), 'released when the request concludes');
}

console.log('=== the wiring is actually in place ===');
{
  const src = fs.readFileSync(new URL('../src/plugins/tv-requests/index.js', import.meta.url), 'utf8');
  ok((src.match(/this\._journalAdd\(ctx, \{/g) ?? []).length >= 3,
    'both enqueue paths journal, and recovery re-journals');
  ok(/this\._journalEpisodeDone\(ctx, reqKey, ep\.id(?:, [^;]*)?\);/.test(src),
    'a finished episode is cleared');
  // It must sit in the finally, so a failure or cancellation clears it too -
  // otherwise a permanently failing episode retries on every single boot.
  const finallyBlock = src.match(/\} finally \{\n      \/\/ Reaching here[\s\S]*?\n    \}/);
  ok(!!finallyBlock, 'from the finally block, so failures and cancellations clear it too');
  ok(/reqKey = null \}\) \{/.test(src), 'deliverEpisode accepts the request key');
  ok(/await this\.recoverPending\(ctx[,)]/.test(src) && /st\.state !== 'connected'/.test(src),
    'and recovery waits for WhatsApp rather than downloading into a dead socket');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
