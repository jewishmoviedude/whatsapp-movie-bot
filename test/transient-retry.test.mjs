/* A transient failure is retried in this process once WhatsApp is back.
   Run: node test/transient-retry.test.mjs

   The incident, 2026-09-28: at 18:50 UTC the bot started uploading
   "Spaceballs (1987)" (1.7 GB) to the posts group. WhatsApp closed the
   connection at 18:53:27, the bot was connected again at 18:53:32, and the
   upload died at 18:56:37 with "Connection Closed". The job was classed as
   transient, kept in the journal, marked "interrupted", reacted 🔄 and logged
   "will retry on next start" - and then nothing happened until somebody
   restarted the service, which can be days.

   The TV side had no retry at all: "TV delivery failed for One Piece S12E27:
   could not post to any group: Connection Closed" (06:42) and S12E32 (06:50)
   were failed for good and reported to the group as such.

   Since 2026-10-11 the requester sees where the job is - the stage its kept
   work reached, or 🎬 with nothing done - and never 🔄, which a member read as
   "send it again" (Iron Man 3; test/no-redo-reaction.test.mjs). The configs
   below still hold an old redo reaction, which must never be sent. */
import './fixtures/roomy-disk.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import tvPlugin from '../src/plugins/tv-requests/index.js';
import { JobQueue } from '../src/core/queue.js';
import { RetryBook, MAX_RETRIES, retryDelayMs, isTransient, watchCancelledWhileWaiting } from '../src/media/resume.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-work-'));
const LIB = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-lib-'));
fs.writeFileSync(path.join(LIB, 'Spaceballs 1987.mp4'), 'not really a film');

/** A bot that can drop and regain its connection, as the real one does. */
function fakeBot(connected = true) {
  const bot = new EventEmitter();
  bot.connected = connected;
  bot.reacted = [];
  bot.isConnected = () => bot.connected;
  bot.react = async (msg, emoji) => { bot.reacted.push({ id: msg?.id, emoji }); return true; };
  bot.sendText = async () => ({});
  bot.groups = () => [];
  bot.groupMemberInfo = () => ({ isMember: false });
  bot.connect = () => { bot.connected = true; bot.emit('state', { state: 'connected' }); };
  return bot;
}

function fakeStore(data = {}) {
  return {
    get: (k, d = null) => (k in data ? data[k] : d),
    set: (k, v) => { data[k] = v; },
    push: (k, v) => { (data[k] ??= []).unshift(v); },
    data,
  };
}

function fakeQueue() {
  return {
    maxLength: 1, pending: [], active: new Map(), added: [], movedTop: [],
    add(job, opts = {}) {
      const id = `q${this.added.length + 1}`;
      this.added.push({ job, opts, id });
      this.pending.push({ ...job, kind: job.kind ?? 'movie' });
      return id;
    },
    moveTop(id) { this.movedTop.push(id); return true; },
  };
}

const logs = [];
const log = {
  info: (m) => logs.push(`info ${m}`), warn: (m) => logs.push(`warn ${m}`),
  error: (m) => logs.push(`error ${m}`), debug: () => {},
};

function movieCtx({ bot = fakeBot(), store = fakeStore(), queue = fakeQueue() } = {}) {
  return {
    bot, store, queue, log,
    config: {
      movieRequests: {
        reactions: { redo: '🔄', added: '🎬', failed: '⚠️', cancelled: '❌', skipped: '⏭️', rated: '⛔', downloading: '⬇️' },
        notify: {}, blockedRatings: ['R'],
      },
      media: { workDir: WORK },
      library: { provider: 'local', local: { roots: [LIB] } },
      omdb: {},
    },
  };
}

function fakeJob({ cancelled = false, reason = 'cancelled' } = {}) {
  const ac = new AbortController();
  return {
    id: `job-${Math.random().toString(16).slice(2, 8)}`,
    signal: ac.signal, progress: () => {},
    isCancelled: () => cancelled, cancelReason: () => (cancelled ? reason : null),
  };
}

/** The journal entry onMessage writes for a group request. */
function journalled(store, { msgKey = { remoteJid: 'req@g.us', id: 'MSG1', fromMe: false } } = {}) {
  const record = { id: 'MSG1', request: 'spaceballs', status: 'queued', title: 'Spaceballs', year: 1987, rated: 'PG' };
  const entry = {
    jobKey: 'MSG1:tt0094012', msgId: 'MSG1', msgKey, chatJid: 'req@g.us',
    movie: { title: 'Spaceballs', year: 1987, imdbId: 'tt0094012', rated: 'PG' },
    meta: { requester: 'Dana', group: 'req@g.us', imdbId: 'tt0094012' }, record, at: Date.now(),
  };
  store.set('pending', [entry]);
  return entry;
}

/** Run one delivery of the film that fails the way 18:56 did. */
async function failTransiently(ctx, entry, { job = fakeJob(), react = null } = {}) {
  const rec = { ...entry.record };
  const reacts = [];
  const r = react ?? (async (e) => { reacts.push(e); });
  let thrown = null;
  // Not connected at the start of the job is the cheapest transient failure
  // to stage: it is classed exactly as "Connection Closed" is.
  const wasUp = ctx.bot.connected;
  ctx.bot.connected = false;
  try {
    await moviePlugin.deliver({
      msg: { id: entry.msgId, key: entry.msgKey, chatJid: entry.chatJid },
      movie: entry.movie, hit: { title: 'Spaceballs', year: 1987, access: 'local', localPath: '/x' },
      ctx, job, record: rec, react: r, jobKey: entry.jobKey,
    });
  } catch (e) { thrown = e; }
  ctx.bot.connected = wasUp;
  return { thrown, rec, reacts };
}

console.log('=== the retry book: bounded, backed off, never doubled ===');
{
  ok(MAX_RETRIES === 3, 'three attempts in a process');
  ok(retryDelayMs(1) === 30_000 && retryDelayMs(2) === 60_000 && retryDelayMs(3) === 120_000,
    'a short backoff for a dropped connection: 30 s, 1 min, 2 min');
  ok(retryDelayMs(1, new Error('rate-overlimit')) >= 15 * 60_000,
    'but a rate limit backs off for a quarter of an hour (CLAUDE.md rule 4)');
  ok(isTransient(new Error('Connection Closed')) && isTransient(new Error('could not post to any group: Connection Closed')),
    'the 18:56 and 06:42 errors are transient');
  ok(!isTransient(new Error('ffmpeg exited 1')), 'an encoder failure is not');

  const bot = fakeBot(true);
  const book = new RetryBook({ delayMs: () => 5 });
  const runs = [];
  const a = book.schedule('k', { bot, run: (n) => runs.push(n) });
  const b = book.schedule('k', { bot, run: (n) => runs.push(`dup${n}`) });
  ok(a === 1 && b === 1, 'booking a key that is already waiting returns the same attempt');
  await tick();
  ok(runs.length === 1 && runs[0] === 1, `and it runs once (${runs.join(',')})`);

  book.schedule('k', { bot, run: (n) => runs.push(n) });
  await tick();
  book.schedule('k', { bot, run: (n) => runs.push(n) });
  await tick();
  ok(runs.join(',') === '1,2,3', 'attempts count up per key');
  ok(book.schedule('k', { bot, run: () => runs.push('x') }) === 0, 'and stop at the cap');
  await tick();
  ok(!runs.includes('x'), 'nothing runs past the cap');

  const down = fakeBot(false);
  const late = [];
  book.schedule('j', { bot: down, run: (n) => late.push(n) });
  await tick();
  ok(late.length === 0, 'while WhatsApp is down the retry waits, whatever the clock says');
  ok(down.listenerCount('state') === 1, 'on one listener');
  book.schedule('j2', { bot: down, run: (n) => late.push(`j2:${n}`) });
  await tick();
  ok(down.listenerCount('state') === 1, 'still one listener for two waiting jobs');
  down.emit('state', { state: 'connecting' });
  ok(late.length === 0, '"connecting" is not connected');
  down.connect();
  await tick();
  ok(late.length === 2, 'both run once it is connected');
  ok(down.listenerCount('state') === 0, 'and the listener is gone');

  const gone = fakeBot(false);
  book.schedule('f', { bot: gone, run: () => late.push('forgotten') });
  await tick();
  book.forget('f');
  gone.connect();
  await tick();
  ok(!late.includes('forgotten') && gone.listenerCount('state') === 0, 'a forgotten key never runs');
}

console.log('=== the incident: Spaceballs comes back after the reconnect ===');
{
  const ctx = movieCtx();
  moviePlugin._retries = new RetryBook({ delayMs: () => 5, log });
  const entry = journalled(ctx.store);

  const { thrown, rec, reacts } = await failTransiently(ctx, entry);
  ok(/not connected/.test(thrown?.message ?? ''), 'the job still fails, so the queue records it');
  ok(rec.status === 'interrupted' && /retrying \(attempt 1 of 3\)/.test(rec.detail ?? ''),
    `History says it is being retried (${rec.detail})`);
  ok(reacts.join('') === '🎬', `the requester sees where it is - 🎬, nothing of it done yet - not 🔄 (${reacts.join('')})`);
  ok(logs.some((l) => /Spaceballs" failed transiently .* retrying once WhatsApp is connected \(attempt 1 of 3\)/.test(l)),
    'and the log says it is coming back in this process, not "on next start"');
  ok(ctx.store.data.pending.length === 1, 'the journal entry stays while it waits');

  await tick();
  const [again] = ctx.queue.added;
  ok(ctx.queue.added.length === 1, 'it is queued again without a restart');
  ok(again?.opts.overLimit === true, 'past the queue limit - it was accepted already');
  ok(again?.job.meta.retry === 1 && again?.job.label === 'Spaceballs (1987)', 'labelled as the retry it is');
  ok(ctx.queue.movedTop.includes(again?.id), 'at the front of the queue, where it was when it failed');
  ok(ctx.store.data.pending.length === 1 && ctx.store.data.pending[0].jobKey === entry.jobKey,
    'still exactly one journal entry, so the next start cannot run it twice');
  ok(ctx.bot.reacted.length === 0, 'no second reaction on the way back in: it is already showing');
}

console.log('=== it waits for the connection, then goes ===');
{
  const ctx = movieCtx({ bot: fakeBot(false) });
  moviePlugin._retries = new RetryBook({ delayMs: () => 5, log });
  const entry = journalled(ctx.store);
  ctx.bot.connected = false;
  await failTransiently(ctx, entry);
  ctx.bot.connected = false;
  await tick(40);
  ok(ctx.queue.added.length === 0, 'nothing is queued while WhatsApp is still down');
  ctx.bot.connect();
  await tick();
  ok(ctx.queue.added.length === 1, 'and it is queued as soon as the bot is connected');
}

console.log('=== three retries, then left for the next start as before ===');
{
  const ctx = movieCtx();
  moviePlugin._retries = new RetryBook({ delayMs: () => 5, log });
  const entry = journalled(ctx.store);
  let last = null;
  for (let i = 0; i <= MAX_RETRIES; i++) {
    last = await failTransiently(ctx, entry);
    await tick();
    // The queue starts the retry it was given, which then fails again: it is
    // no longer waiting there (a retry that finds its job waiting adds none).
    ctx.queue.pending.length = 0;
  }
  ok(ctx.queue.added.length === MAX_RETRIES, `retried ${MAX_RETRIES} times in this process (${ctx.queue.added.length})`);
  ok(/retried 3 times; will retry on the next start/.test(last.rec.detail ?? ''),
    `then History says it waits for the next start (${last.rec.detail})`);
  ok(logs.some((l) => /retried 3 times in this process; will retry on next start/.test(l)),
    'and so does the log');
  ok(ctx.store.data.pending.length === 1, 'the journal still holds it for that start');

  // The next start replays it once - not once per retry.
  const next = movieCtx({ store: ctx.store });
  await moviePlugin.recoverPending(next);
  ok(next.queue.added.length === 1, `the next start queues it exactly once (${next.queue.added.length})`);
  ok(next.store.data.pending.length === 1, 'with one journal entry');
}

console.log('=== a cancelled job never comes back ===');
{
  const ctx = movieCtx();
  moviePlugin._retries = new RetryBook({ delayMs: () => 5, log });
  const entry = journalled(ctx.store);
  const { rec } = await failTransiently(ctx, entry, { job: fakeJob({ cancelled: true }) });
  await tick();
  ok(ctx.queue.added.length === 0, 'a transient-looking error on a cancelled job is not retried');
  ok(rec.status === 'cancelled', `History says cancelled (${rec.status})`);
  ok((ctx.store.data.pending ?? []).length === 0, 'and it is out of the journal, so no restart replays it');
}

console.log('=== a job the failover took off a dead connection is retried, not cancelled ===');
{
  // failover.js cancels running jobs with reason 'interrupted' when it
  // switches numbers, meaning "put it back". Counted as an admin's cancel,
  // the job left the journal with ❌ and History "cancelled".
  const ctx = movieCtx();
  moviePlugin._retries = new RetryBook({ delayMs: () => 5, log });
  const entry = journalled(ctx.store);
  const { rec, reacts } = await failTransiently(ctx, entry, { job: fakeJob({ cancelled: true, reason: 'interrupted' }) });
  await tick();
  ok(ctx.queue.added.length === 1, 'it is queued again');
  ok(rec.status === 'interrupted' && reacts.join('') === '🎬', `as a transient failure (${rec.status}, ${reacts.join('')})`);
  ok(ctx.store.data.pending.length === 1, 'and stays journalled');
}

console.log('=== a retry cancelled while it waits in the queue never comes back ===');
{
  // A cancel of a job that has not started never calls its run(), so
  // deliver() - which takes a cancelled job out of the journal - never hears
  // of it, and the next start queued it again. A retried job waits in the
  // queue like any other.
  const queue = new JobQueue({ concurrency: 1, maxLength: 10 });
  queue.pause();
  const bot = fakeBot(true);
  const store = fakeStore();
  const ctx = {
    ...movieCtx({ bot, store, queue }),
    configStore: { update() {} },
  };
  ctx.config.movieRequests.rules = 'be nice';
  await moviePlugin.setup(ctx);
  moviePlugin._retries = new RetryBook({ delayMs: () => 5, log });

  const entry = journalled(store);
  store.set('history', [{ ...entry.record, status: 'interrupted', detail: 'Connection Closed — retrying (attempt 1 of 3)' }]);
  await failTransiently(ctx, entry);
  await tick();
  const [retryJob] = queue.pending;
  ok(retryJob?.meta?.jobKey === entry.jobKey && retryJob.meta.retry === 1, 'the retry is waiting in the queue');
  queue.cancel(retryJob.id);
  ok((store.data.pending ?? []).length === 0, 'cancelling it takes it out of the journal');
  const row = (store.data.history ?? []).find((h) => h.id === entry.record.id);
  ok(row?.status === 'cancelled', `History says cancelled (${row?.status})`);

  const next = movieCtx({ store });
  await moviePlugin.recoverPending(next);
  ok(next.queue.added.length === 0, 'and the next start does not bring it back');

  // The same for a request cancelled before it ever ran, and for "clear the
  // queue": neither used to leave the journal.
  const second = journalled(store, { msgKey: { remoteJid: 'req@g.us', id: 'MSG2' } });
  store.set('pending', [{ ...second, jobKey: 'MSG2:x' }, { ...second, jobKey: 'MSG3:y' }]);
  queue.add({ label: 'Spaceballs (1987)', meta: { jobKey: 'MSG2:x' }, run: async () => {} });
  queue.add({ label: 'Spaceballs (1987)', meta: { jobKey: 'MSG3:y' }, run: async () => {} });
  queue.skip(queue.pending[0].id);
  ok(store.data.pending.length === 1 && store.data.pending[0].jobKey === 'MSG3:y', 'a skip takes it out too');
  queue.clearPending();
  ok(store.data.pending.length === 0, 'and so does clearing the queue');
  await moviePlugin.teardown();
}

console.log('=== both plugins watch the queue on one set of listeners ===');
{
  // The queue is a plain EventEmitter that every open panel tab listens to as
  // well; ten listeners on an event is where Node starts warning.
  const queue = new JobQueue({ concurrency: 1, maxLength: 10 });
  queue.pause();
  const base = queue.listenerCount('updated');
  const baseAdded = queue.listenerCount('added');
  const seenA = [], seenB = [];
  const offA = watchCancelledWhileWaiting(queue, (e) => seenA.push(e.label));
  const offB = watchCancelledWhileWaiting(queue, (e) => seenB.push(e.label));
  ok(queue.listenerCount('updated') === base + 1 && queue.listenerCount('state') === 1
    && queue.listenerCount('added') === baseAdded + 1, 'one listener each, for two watchers');
  queue.add({ label: 'one', run: async () => {} });
  queue.add({ label: 'two', run: async () => {} });
  queue.cancel(queue.pending[0].id);
  queue.clearPending();
  queue.emit('state', queue.snapshot());           // any later event re-scans
  ok(seenA.join() === 'one,two' && seenB.join() === 'one,two', `each hears each dropped job once (${seenA.join()} / ${seenB.join()})`);
  offA(); offB();
  ok(queue.listenerCount('updated') === base && queue.listenerCount('state') === 0
    && queue.listenerCount('added') === baseAdded, 'and both are gone after unsubscribing');
}

console.log('=== a job that has left the journal is not retried ===');
{
  const ctx = movieCtx();
  moviePlugin._retries = new RetryBook({ delayMs: () => 20, log });
  const entry = journalled(ctx.store);
  await failTransiently(ctx, entry);
  ctx.store.set('pending', []);                  // gone before the retry ran
  await tick(50);
  ok(ctx.queue.added.length === 0, 'nothing is queued for it');
}

console.log('=== a delivered job leaves the journal ===');
{
  const src = fs.readFileSync(new URL('../src/plugins/movie-requests/index.js', import.meta.url), 'utf8');
  // Its work goes after the journal's removal is on the disk (_journalDone):
  // since The Parent Trap (2026-09-29) a job's files live in a directory of
  // their own, with the record that it was posted.
  ok(/this\._retries\?\.forget\(jobKey\);\n(?:.*_tellFollowers.*\n)?(?:\s*\/\/.*\n)*\s*const freed = this\._journalDone\(ctx, jobKey, \{ work, drop: !!mediaCfg\.deleteAfterSend \}\);\n.*\n      return \{ file: outName/.test(src),
    'the success path forgets the retry and clears the journal, so nothing replays a posted film');
}

/* ------------------------------- TV ------------------------------- */

const ep = (n) => ({ id: `op-12-${n}`, series: 'One Piece', season: 12, episode: n, title: `Ep ${n}`, size: 1e8 });

function tvCtx({ bot = fakeBot(true), store = fakeStore() } = {}) {
  return {
    bot, store, queue: fakeQueue(), log,
    config: {
      tvRequests: { postsGroups: ['tvposts@g.us'] },
      movieRequests: { reactions: { redo: '🔄', added: '🎬', failed: '⚠️', done: '✅', cancelled: '❌', downloading: '⬇️' }, notify: {} },
      library: { jellyfin: { baseUrl: 'http://jf.invalid', accessToken: 'T' } },
      media: { workDir: WORK },
      whatsapp: {},
    },
  };
}

/** One episode that fails the way 06:42 did - the network, not the file. */
async function tvAttempt(ctx, args, job = fakeJob()) {
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  let thrown = null;
  try { await tvPlugin.deliverEpisode({ ...args, ctx, job }); } catch (e) { thrown = e; }
  return thrown;
}

console.log('=== TV: a transient failure is retried, and the request reports once ===');
{
  const ctx = tvCtx();
  tvPlugin._retries = new RetryBook({ delayMs: () => 5, log });
  const reqKey = 'tv-AC729872-1';
  tvPlugin._journalAdd(ctx, { reqKey, label: 'One Piece season 12', requester: '+1 555', episodes: [ep(27), ep(28)] });

  const finished = [];
  const notifier = tvPlugin._makeRequestNotifier(ctx, {
    label: 'One Piece season 12', total: 2, msg: null, single: false,
    onFinish: (r) => finished.push(r),
  });
  const reacts = [];
  const react = async (e) => { reacts.push(e); };
  const args = { ep: ep(27), msg: null, react, notifier, reqKey, route: null, isLast: false, index: 0, total: 2 };

  const err = await tvAttempt(ctx, args);
  ok(/fetch failed/.test(err?.message ?? ''), 'the episode fails transiently');
  ok(finished.length === 0, 'the request is not told anything yet');
  ok(ctx.store.data.pending[0].episodes.some((e) => e.id === 'op-12-27'), 'the episode stays journalled');
  ok(reacts.includes('🎬') && !reacts.includes('⚠️') && !reacts.includes('🔄'),
    `the requester sees where it is - 🎬, nothing of it fetched - not ⚠️ or 🔄 (${reacts.join(' ')})`);

  // The other episode lands meanwhile.
  notifier.episodeDone();
  tvPlugin._journalEpisodeDone(ctx, reqKey, 'op-12-28');
  ok(finished.length === 0, 'one of two posted does not close the request');

  await tick();
  const [again] = ctx.queue.added;
  ok(ctx.queue.added.length === 1 && again.job.kind === 'tv', 'the episode is queued again, as TV');
  ok(again.opts.overLimit === true, 'past the limit');
  ok(again.job.meta.retry === 1 && again.job.meta.requester === '+1 555', 'with its requester and attempt');
  ok(ctx.queue.movedTop.includes(again.id), 'at the front of the queue');

  // It keeps failing: three retries, then the failure it always was.
  // Each retry runs as the queue would run it: through the job it queued.
  let runs = 1;
  let job = again.job;
  while (job) {
    const before = ctx.queue.added.length;
    try { await job.run(fakeJob()); } catch { /* the transient failure, again */ }
    runs += 1;
    await tick();
    job = ctx.queue.added.length > before ? ctx.queue.added.at(-1).job : null;
  }
  ok(runs === MAX_RETRIES + 1, `tried ${runs} times in all`);
  ok(finished.length === 1, `the request reports exactly once (${finished.length})`);
  ok(finished[0]?.completed === 1 && finished[0]?.failed === 1, '"1 of 2 posted, 1 failed" - the arithmetic holds');
  ok(!(ctx.store.data.pending ?? []).length, 'and the journal is clear');
}

console.log('=== TV: a cancelled episode is not retried ===');
{
  const ctx = tvCtx();
  tvPlugin._retries = new RetryBook({ delayMs: () => 5, log });
  tvPlugin._journalAdd(ctx, { reqKey: 'r', label: 'x', episodes: [ep(32)] });
  const outcome = [];
  const notifier = { stage() {}, episodeDone: () => outcome.push('done'), episodeFailed: () => outcome.push('failed'), episodeCancelled: () => outcome.push('cancelled') };
  await tvAttempt(ctx, { ep: ep(32), msg: null, react: async () => {}, notifier, reqKey: 'r', route: null, isLast: true, index: 0, total: 1 },
    fakeJob({ cancelled: true }));
  await tick();
  ok(ctx.queue.added.length === 0, 'nothing is queued again');
  ok(outcome.length === 1, `the request hears one outcome (${outcome.join(',')})`);
}

console.log('=== TV: a restart while the retry waits replays the episode once ===');
{
  const store = fakeStore();
  const ctx = tvCtx({ store });
  tvPlugin._retries = new RetryBook({ delayMs: () => 60_000, log });
  tvPlugin._journalAdd(ctx, { reqKey: 'r2', label: 'One Piece S12E32', episodes: [ep(32)] });
  const notifier = tvPlugin._makeRequestNotifier(ctx, { label: 'x', total: 1, msg: null, single: true });
  await tvAttempt(ctx, { ep: ep(32), msg: null, react: async () => {}, notifier, reqKey: 'r2', route: null, isLast: true, index: 0, total: 1 });
  tvPlugin._retries.clear();                       // the process stops
  const next = tvCtx({ store });
  await tvPlugin.recoverPending(next);
  ok(next.queue.added.length === 1, `the next start queues it once (${next.queue.added.length})`);
}

console.log('=== TV: an episode waiting on its retry counts as already in the queue ===');
{
  const ctx = tvCtx();
  tvPlugin._retries = new RetryBook({ delayMs: () => 60_000, log });
  tvPlugin._journalAdd(ctx, { reqKey: 'r3', label: 'One Piece S12E32', episodes: [ep(32)] });
  const notifier = tvPlugin._makeRequestNotifier(ctx, { label: 'x', total: 1, msg: null, single: true });
  await tvAttempt(ctx, { ep: ep(32), msg: null, react: async () => {}, notifier, reqKey: 'r3', route: null, isLast: true, index: 0, total: 1 });
  ok(tvPlugin._waitingEpisodeIds(ctx, null).has('op-12-32'),
    'a request for it meanwhile is answered "already in the queue", not queued twice');
  tvPlugin._retries.clear();
}

console.log('=== TV: the failover\'s "interrupted" is retried, not cancelled ===');
{
  const ctx = tvCtx();
  tvPlugin._retries = new RetryBook({ delayMs: () => 5, log });
  tvPlugin._journalAdd(ctx, { reqKey: 'r4', label: 'x', episodes: [ep(33)] });
  const outcome = [];
  const notifier = { stage() {}, episodeDone: () => outcome.push('done'), episodeFailed: () => outcome.push('failed'), episodeCancelled: () => outcome.push('cancelled') };
  await tvAttempt(ctx, { ep: ep(33), msg: null, react: async () => {}, notifier, reqKey: 'r4', route: null, isLast: true, index: 0, total: 1 },
    fakeJob({ cancelled: true, reason: 'interrupted' }));
  await tick();
  ok(ctx.queue.added.length === 1 && outcome.length === 0, `it is queued again, with nothing reported yet (${outcome.join(',') || 'none'})`);
  tvPlugin._retries.clear();
}

console.log('=== TV: a retry cancelled while it waits in the queue ===');
{
  const queue = new JobQueue({ concurrency: 1, maxLength: 10 });
  queue.pause();
  const ctx = { ...tvCtx(), queue };
  tvPlugin._retries = new RetryBook({ delayMs: () => 5, log });
  tvPlugin._journalAdd(ctx, { reqKey: 'r5', label: 'One Piece season 12', episodes: [ep(27), ep(28)] });
  const finished = [];
  const notifier = tvPlugin._makeRequestNotifier(ctx, {
    label: 'One Piece season 12', total: 2, msg: null, single: false, onFinish: (r) => finished.push(r),
  });
  await tvAttempt(ctx, { ep: ep(27), msg: null, react: async () => {}, notifier, reqKey: 'r5', route: null, isLast: false, index: 0, total: 2 });
  await tick();
  const retry = queue.pending.find((e) => e.meta.retry === 1);
  ok(!!retry, 'the retry is waiting in the queue');
  queue.cancel(retry.id);
  ok(!ctx.store.data.pending[0].episodes.some((e) => e.id === 'op-12-27'), 'cancelling it takes the episode out of the journal');
  notifier.episodeDone();                          // E28 lands
  ok(finished.length === 1 && finished[0].cancelled === 1 && finished[0].completed === 1,
    'and the request still concludes, "1 of 2 posted, 1 cancelled"');
  await tvPlugin.teardown();
}

console.log('=== a job waiting for its retry is on the panel, can be cancelled, and keeps the bot busy ===');
{
  // Between the failure and the retry going back in, the job is in no queue:
  // the panel listed it only as failed, Cancel by the ids it had answered
  // false, and queue-status said busy:false, safeToRestart:true - and then
  // Spaceballs and Loki S01E01 were posted anyway (review scenario
  // g-retry-invisible).
  const { runAdminCommand } = await import('../src/core/admin-commands.js');
  const queue = new JobQueue({ concurrency: 1, maxLength: 10 });
  const ctx = movieCtx({ queue });
  moviePlugin._retries = new RetryBook({ delayMs: () => 60_000, log });
  const entry = journalled(ctx.store);
  ctx.store.set('history', [{ ...entry.record }]);
  const reacted = [];
  ctx.bot.react = async (msg, emoji) => { reacted.push(`${msg?.id} ${emoji}`); return true; };
  await failTransiently(ctx, entry);
  const snap = queue.snapshot();
  const row = snap.retrying?.[0];
  ok(snap.retrying?.length === 1 && row.label === 'Spaceballs (1987)' && row.state === 'retrying' && row.attempt === 1 && row.max === 3,
    `the queue lists it as retrying (${JSON.stringify(row)})`);
  ok(row && !JSON.stringify(snap.retrying).includes('MSG1') && typeof row.cancel === 'undefined',
    'by an id of the queue\'s own - not the WhatsApp message id - and with nothing that cannot go to the panel');
  const status = await runAdminCommand({ op: 'queue-status' }, { bot: ctx.bot, dataDir: WORK, queue });
  ok(status.busy === true && status.safeToRestart === false && status.media.retrying === 1,
    `queue-status counts it: busy ${status.busy}, retrying ${status.media.retrying}`);
  const health = await runAdminCommand({ op: 'health' }, { bot: { status: () => ({}) }, dataDir: WORK, queue });
  ok(health.queues.media.retrying === 1 && health.safeToRestart === false, 'and so does health');
  ok(queue.describe(row.id)?.label === 'Spaceballs (1987)', 'the audit log can name it before a cancel');

  ok(queue.cancel(row.id) === true, 'Cancel by the panel\'s id works');
  ok(!moviePlugin._retries.isWaiting(entry.jobKey) && !(ctx.store.data.pending ?? []).length,
    'the retry is forgotten and the film leaves the journal, so nothing brings it back');
  const hist = (ctx.store.data.history ?? [])[0];
  ok(hist?.status === 'cancelled' && /while waiting to retry/.test(hist.detail ?? ''), `History says so (${hist?.status}: ${hist?.detail})`);
  await tick();
  ok(reacted.includes('MSG1 ❌'), `the requester, shown where it had got to, sees ❌ (${reacted.join(', ')})`);
  ok(!queue.snapshot().retrying.length && (await runAdminCommand({ op: 'queue-status' }, { bot: ctx.bot, dataDir: WORK, queue })).busy === false,
    'and the queue is idle again');
  moviePlugin._retries.clear();
}

console.log('=== a retry that goes back in the queue leaves the retrying list ===');
{
  const queue = new JobQueue({ concurrency: 1, maxLength: 10 });
  queue.pause();
  const ctx = movieCtx({ queue });
  moviePlugin._retries = new RetryBook({ delayMs: () => 5, log });
  const entry = journalled(ctx.store);
  await failTransiently(ctx, entry);
  ok(queue.snapshot().retrying.length === 1, 'listed while it waits');
  await tick(40);
  const snap = queue.snapshot();
  ok(!snap.retrying.length && snap.pending.length === 1 && snap.pending[0].meta.retry === 1,
    'once back in the queue it is an ordinary waiting job, listed once');
  moviePlugin._retries.clear();
}

console.log('=== TV: an episode waiting for its retry is listed, and Cancel stops its request ===');
{
  const queue = new JobQueue({ concurrency: 1, maxLength: 10 });
  queue.pause();
  const ctx = { ...tvCtx(), queue };
  tvPlugin._retries = new RetryBook({ delayMs: () => 60_000, log });
  tvPlugin._journalAdd(ctx, { reqKey: 'r7', label: 'One Piece season 12', episodes: [ep(27), ep(28)] });
  const finished = [];
  const notifier = tvPlugin._makeRequestNotifier(ctx, {
    label: 'One Piece season 12', total: 2, msg: null, single: false, onFinish: (r) => finished.push(r),
  });
  const reacts = [];
  // E28 is still waiting in the queue, as one request with E27.
  queue.add({ kind: 'tv', group: 'r7', groupLabel: 'One Piece season 12', label: 'One Piece S12E28', meta: { kind: 'tv' }, run: async () => {},
    onDiscard: () => { notifier.episodeCancelled(); tvPlugin._journalEpisodeDone(ctx, 'r7', 'op-12-28'); } });
  await tvAttempt(ctx, { ep: ep(27), msg: null, react: async (e) => { reacts.push(e); }, notifier, reqKey: 'r7', route: null, isLast: false, index: 0, total: 2 });
  const row = queue.snapshot().retrying[0];
  ok(row?.label === 'One Piece S12E27' && row.kind === 'tv', `listed as retrying (${row?.label})`);
  ok(queue.cancel(row.id) === true, 'cancelled by its id');
  ok(!tvPlugin._retries.isWaiting('r7:op-12-27') && !queue.snapshot().pending.length,
    'its retry is forgotten, and the rest of its request is cancelled with it');
  ok(finished.length === 1 && finished[0].cancelled === 2 && reacts.at(-1) === '❌',
    `the request concludes once, all cancelled, and its message shows ❌ (${JSON.stringify(finished[0])})`);
  ok(!(ctx.store.data.pending ?? []).length, 'and nothing of it is journalled');
  await tvPlugin.teardown();
}

fs.rmSync(WORK, { recursive: true, force: true });
fs.rmSync(LIB, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
