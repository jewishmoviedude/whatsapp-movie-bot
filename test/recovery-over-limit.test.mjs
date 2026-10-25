/* Work accepted before a restart is always resumed, films first.
   Run: node test/recovery-over-limit.test.mjs

   The incident, 2026-09-28 01:36 UTC: the restart found 13 films and 124 TV
   episodes journalled. Both plugins recovered at once when WhatsApp
   connected; TV filled the queue to its limit of 104 while the movie side was
   still looking its films up one at a time, and "Doctor Strange" and "Ready
   Player One" (twice) were refused - "could not resume ...: Queue is full
   (104 waiting)". Refused, but already re-journalled: the next start, at
   06:43, replayed all three, and an admin cancelled them by hand. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { JobQueue } from '../src/core/queue.js';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import tvPlugin from '../src/plugins/tv-requests/index.js';
import { holdTvRecovery, afterMovieRecovery } from '../src/media/resume.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const LIB = fs.mkdtempSync(path.join(os.tmpdir(), 'overlimit-lib-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'overlimit-work-'));
for (const f of ['Ready Player One 2018.mp4', 'Doctor Strange 2016.mp4']) fs.writeFileSync(path.join(LIB, f), 'x');

const store = (data = {}) => ({
  get: (k, d = null) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; }, push() {}, data,
});
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const errors = [];
const log = { ...quiet, error: (m) => errors.push(m) };

/** A queue like the live one at 01:36: at its limit, and not running anything. */
function fullQueue(maxLength = 4) {
  const q = new JobQueue({ concurrency: 3, maxLength });
  q.pause();
  for (let i = 0; i < maxLength; i++) q.add({ kind: 'tv', label: `One Piece S02E${i + 1}`, meta: { kind: 'tv' }, run: async () => {} });
  return q;
}

function movieEntry(id, title, year) {
  return {
    jobKey: `${id}:${title}`, msgId: id, msgKey: null, chatJid: 'posts@g.us',
    movie: { title, year, rated: 'PG-13' }, meta: { requester: 'manual (admin)' },
    record: { id, request: title.toLowerCase(), status: 'queued', title, year }, at: Date.now(),
  };
}

function movieCtx(queue, data, bot = { isConnected: () => true, react: async () => true, on() {}, off() {} }) {
  return {
    store: store(data), queue, log, bot,
    config: {
      movieRequests: { reactions: { redo: '🔄', rated: '⛔' }, blockedRatings: [], rules: 'be nice', notify: {} },
      media: { workDir: WORK }, library: { provider: 'local', local: { roots: [LIB] } }, omdb: {},
    },
  };
}

const ep = (n) => ({ id: `op-${n}`, series: 'One Piece', season: 2, episode: n });

console.log('=== a film accepted before the restart is resumed past a full queue ===');
{
  const queue = fullQueue(4);
  const data = { pending: [movieEntry('manual-1790277456673', 'Ready Player One', 2018),
                           movieEntry('manual-1790263540054', 'Doctor Strange', 2016)] };
  await moviePlugin.recoverPending(movieCtx(queue, data));
  const labels = queue.pendingLabels();
  ok(labels.includes('Ready Player One (2018)') && labels.includes('Doctor Strange (2016)'),
    'both films are back in the queue');
  ok(queue.pending.length === 6, `past the limit of 4 (${queue.pending.length} waiting)`);
  ok(!errors.some((e) => /Queue is full/.test(e)), 'and nothing was refused as "Queue is full"');
  ok(data.pending.length === 2, 'both journalled once, for the next restart');
  // A new request is still held to the limit: that is what it is for.
  let refused = null;
  try { queue.add({ label: 'a new request', run: async () => {} }); } catch (e) { refused = e; }
  ok(refused?.code === 'QUEUE_FULL', 'while a NEW request still meets the limit');
}

console.log('=== a job the queue will not take leaves the journal ===');
{
  const data = { pending: [movieEntry('manual-1', 'Ready Player One', 2018)] };
  const ctx = movieCtx({ add: () => { throw new Error('the queue is gone'); } }, data);
  errors.length = 0;
  await moviePlugin.recoverPending(ctx);
  ok(errors.some((e) => /could not resume "Ready Player One"/.test(e)), 'the refusal is logged');
  ok(data.pending.length === 0, 'and the entry is gone - the 06:43 start replayed exactly such entries');
}

console.log('=== TV recovery waits for the films, then resumes every episode ===');
{
  const queue = new JobQueue({ concurrency: 3, maxLength: 2 });
  queue.pause();
  const release = holdTvRecovery(queue);
  const data = { pending: [{ reqKey: 'tv-old', label: 'One Piece season 2', episodes: [1, 2, 3].map(ep) }] };
  const ctx = {
    store: store(data), queue, log: quiet,
    config: { tvRequests: {}, movieRequests: { reactions: { redo: '🔄' } } },
    bot: { isConnected: () => true, react: async () => true, on() {}, off() {} },
  };
  const tv = tvPlugin.recoverPending(ctx);
  await tick();
  ok(queue.pending.length === 0, 'no episode is queued while the movie side is still recovering');

  // A new request arrives meanwhile and queues itself, as onMessage does.
  data.pending.push({ reqKey: 'tv-new', label: 'Loki season 1', episodes: [{ id: 'loki-1', series: 'Loki', season: 1, episode: 1 }] });
  queue.add({ kind: 'tv', label: 'Loki S01E01', meta: { kind: 'tv' }, run: async () => {} });

  queue.add({ label: 'Ready Player One (2018)', run: async () => {} }, { overLimit: true });
  release();
  await tv;
  ok(queue.pending[0].label === 'Loki S01E01' && queue.pending[1].label === 'Ready Player One (2018)',
    'the film went in before any recovered episode');
  const onePiece = queue.pending.filter((e) => /One Piece/.test(e.label));
  ok(onePiece.length === 3, `every recovered episode is queued, past the limit of 2 (${onePiece.length})`);
  ok(queue.pending.filter((e) => e.label === 'Loki S01E01').length === 1,
    'and the request that arrived during the wait is not taken for one to resume');
  ok(data.pending.some((r) => r.reqKey === 'tv-new'), 'its journal entry is kept, too');
}

console.log('=== the restart itself: both plugins set up, WhatsApp connects ===');
{
  // The live order: the movie plugin loads first, both wait for 'connected',
  // and both recoveries start on the same event.
  const bot = new EventEmitter();
  bot.connected = false;
  bot.isConnected = () => bot.connected;
  bot.react = async () => true;
  bot.sendText = async () => ({});
  const queue = new JobQueue({ concurrency: 3, maxLength: 3 });
  queue.pause();
  const movieData = { pending: [movieEntry('manual-1', 'Ready Player One', 2018), movieEntry('manual-2', 'Doctor Strange', 2016)] };
  const tvData = { pending: [{ reqKey: 'tv-op', label: 'One Piece season 2', episodes: [1, 2, 3, 4].map(ep) }] };
  const mctx = movieCtx(queue, movieData, bot);
  const tctx = {
    store: store(tvData), queue, log: quiet, bot,
    config: { tvRequests: {}, movieRequests: { reactions: { redo: '🔄' } } },
  };
  errors.length = 0;
  await moviePlugin.setup(mctx);
  await tvPlugin.setup(tctx);
  bot.connected = true;
  bot.emit('state', { state: 'connected' });
  for (let i = 0; i < 100 && queue.pending.length < 6; i++) await tick(10);
  const kinds = queue.pending.map((e) => e.kind).join(',');
  ok(queue.pending.length === 6, `every film and episode is back (${queue.pending.length} of 6, limit 3)`);
  ok(kinds === 'movie,movie,tv,tv,tv,tv', `the films were queued before any episode (${kinds})`);
  ok(!errors.length, `and nothing was refused (${errors.join('; ') || 'no errors'})`);
  await moviePlugin.teardown();
  await tvPlugin.teardown();
}

console.log('=== a stuck movie recovery cannot hold TV back for ever ===');
{
  const q = {};
  holdTvRecovery(q);
  const t0 = Date.now();
  // The timeout is unref'd so it cannot hold a stopping bot open; this keeps
  // the test process alive long enough to see it fire.
  const keepAlive = setTimeout(() => {}, 2000);
  const r = await afterMovieRecovery(q, { timeoutMs: 30 });
  clearTimeout(keepAlive);
  ok(r === false && Date.now() - t0 < 1000, 'it gives up waiting after the timeout');
  ok(await afterMovieRecovery({}) === true, 'and with no movie side there is nothing to wait for');
}

fs.rmSync(LIB, { recursive: true, force: true });
fs.rmSync(WORK, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
