/* A retried TV episode is still part of its request.
   Run: node test/tv-retry-grouping.test.mjs

   Two branches met here. incident-fixes retries an episode that lost its
   send, once WhatsApp is back (One Piece S12E27 and S12E32, "Connection
   Closed", 06:42 and 06:50 UTC on 2026-09-28): back into the queue at the
   front, with the finished file it kept. tv-queue made a TV request - a whole
   season - ONE item of the queue, counted, shown, moved and cancelled whole.
   Put together as they were, a retried episode was a stranger to its own
   season:
   - with the rest of the season in hand it was pushed to the BACK of the
     queue, behind every request that had not even started;
   - the panel counted it as one more episode: "23 episodes · 1 failed" for a
     22-episode season;
   - Cancel on the season could not reach an episode waiting on its retry
     (it is in no queue until the retry fires), so after the cancel it came
     back on its own;
   - and a resumed request still waiting for its place was not "waiting" to
     the duplicate check, so asking for it again queued it twice. */
import './fixtures/roomy-disk.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tvPlugin from '../src/plugins/tv-requests/index.js';
import { JobQueue } from '../src/core/queue.js';
import { RetryBook } from '../src/media/resume.js';
import { openWork, workKey, isSafeToDeleteIn } from '../src/media/work-files.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-retry-group-'));
const logs = [];
const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), debug() {} };

let fetched = 0;
globalThis.fetch = async () => { fetched += 1; throw new TypeError('fetch failed'); };

function fakeStore(data = {}) {
  return { get: (k, d = null) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; }, data };
}

function makeCtx(queue) {
  const bot = {
    sent: [], reacted: [],
    isConnected: () => true,
    react: async (m, e) => { bot.reacted.push(e); return true; },
    sendText: async () => ({}),
    sendDocument: async (jid, file) => { bot.sent.push({ jid, file }); return {}; },
    groups: () => [], groupMemberInfo: () => ({ isMember: false }), on() {}, off() {},
  };
  return {
    bot, queue, log, store: fakeStore(),
    config: {
      tvRequests: { postsGroups: ['tvposts@g.us'] },
      movieRequests: {
        reactions: { redo: '🔄', failed: '⚠️', done: '✅', cancelled: '❌', skipped: '⏭️', downloading: '⬇️', sending: '⬆️' },
        notify: {},
      },
      library: { jellyfin: { baseUrl: 'http://jf.invalid', accessToken: 'T' } },
      media: { workDir: WORK },
      whatsapp: { broadcastPacingMs: 0 },
    },
  };
}

const ep = (n, series = 'One Piece', season = 12) =>
  ({ id: `${series}-${season}-${n}`, series, season, episode: n, title: `Ep ${n}`, size: 64 });

/** Queue jobs whose work is a gate the test opens (or fails). */
function gated(q) {
  const gates = new Map();
  return {
    gates,
    add: (job, label, o) => q.add({ kind: 'tv', ...job, label, run: () => new Promise((res, rej) => gates.set(label, { res, rej })) }, o),
  };
}

/** The request's own notifier, recording how it ends. */
function notifierFor(ctx, total, finished) {
  return tvPlugin._makeRequestNotifier(ctx, {
    label: 'One Piece season 12', total, msg: null, single: total === 1, onFinish: (r) => finished.push(r),
  });
}

console.log('=== a retried episode rejoins its running season, ahead of the waiting line ===');
{
  const q = new JobQueue({ concurrency: 1, maxLength: 104 });
  const ctx = makeCtx(q);
  const g = gated(q);
  const [e1, e2] = [ep(1), ep(2)];
  tvPlugin._journalAdd(ctx, { reqKey: 'r', label: 'One Piece season 12 — 2 episode(s)', requester: '+1 555', episodes: [e1, e2] });
  g.add({ group: 'r', groupLabel: 'One Piece season 12', meta: { kind: 'tv', series: 'One Piece', season: 12, episode: 1 } }, 'One Piece S12E01');
  g.add({ group: 'r', meta: { kind: 'tv', series: 'One Piece', season: 12, episode: 2 } }, 'One Piece S12E02');
  g.add({ group: 'o', groupLabel: 'Loki season 1', meta: { kind: 'tv', series: 'Loki', season: 1, episode: 1 } }, 'Loki S01E01');
  await tick();
  g.gates.get('One Piece S12E01').rej(new Error('Connection Closed'));   // E1 loses its send...
  await tick();                                                        // ...and E2 is now in hand
  q.pause();
  ok(q.active.size === 1 && [...q.active.values()][0].label === 'One Piece S12E02', 'E2 is in hand, Loki waits');

  // The finished E1 the failed attempt kept, as deliverEpisode keeps it:
  // in the episode's work, made in this process.
  const w = openWork({ workDir: WORK, key: workKey.tv('r', e1.id), isSafe: (p) => isSafeToDeleteIn(p, { workDir: WORK }) });
  w.record({
    item: { provider: 'jellyfin', id: e1.id, access: 'download', librarySize: 64, total: 64, lastModified: null, etag: null, local: null },
    output: { name: 'output.mp4', size: 128, action: 'copy' },
  });
  fs.writeFileSync(w.outPath, Buffer.alloc(128, 1));
  w.vouch();
  const kept = w.outPath;
  const finished = [];
  const notifier = notifierFor(ctx, 2, finished);
  const reacts = [];
  const react = async (e) => { reacts.push(e); };
  tvPlugin._retryEpisodeNow(ctx, {
    ep: e1, msg: null, react, notifier, route: null, reqKey: 'r', index: 0, total: 2, isLast: false,
  }, 1);

  const retry = q.pending.find((e) => e.meta?.retryKey === `r:${e1.id}`);
  ok(retry?.group === 'r', `the retry is queued in its own request (${retry?.group})`);
  ok(q.pending[0] === retry, `ahead of the request still waiting (${q.pending.map((e) => e.label).join(', ')})`);
  ok(q.pendingLabels().join() === 'Loki season 1', `the waiting line is unchanged: Loki is still 1st (${q.pendingLabels().join()})`);
  const row = q.snapshot().active.find((it) => it.group === 'r');
  ok(row?.jobs.total === 2 && row.jobs.failed === 0 && row.jobs.waiting === 1,
    `the season is still 2 episodes, with the failed attempt taken back off (${JSON.stringify(row?.jobs)})`);

  // E2 lands; the retry is next, sends the file it kept, and closes the request.
  g.gates.get('One Piece S12E02').res();
  notifier.episodeDone();
  tvPlugin._journalEpisodeDone(ctx, 'r', e2.id);
  await tick();
  q.resume();
  await tick(60);
  const started = [...q.active.values()].map((e) => e.label);
  ok(started.join() === 'Loki S01E01', `the retry ran before Loki started (${started.join()})`);
  ok(ctx.bot.sent.length === 1 && ctx.bot.sent[0].file === kept && fetched === 0,
    'it sent the file it kept, fetching nothing again');
  ok(finished.length === 1 && finished[0].completed === 2, 'the request reports once: both posted');
  ok(reacts.at(-1) === '✅', `and its message ends on ✅ (${reacts.join(' ')})`);
  ok(q.history.find((h) => h.label === 'One Piece S12E01' && h.state === 'done'), 'the queue records the retry as done');
  g.gates.get('Loki S01E01')?.res();
  await tvPlugin.teardown();
}

console.log('=== the count takes back the attempt the retry replaces, however it ended ===');
{
  // A season with one episode failed for good and one the failover took off
  // a dying connection ('interrupted', which the queue records as cancelled).
  // The interrupted one is retried: it is the cancelled count that comes off.
  const q = new JobQueue({ concurrency: 1, maxLength: 104 });
  const g = gated(q);
  g.add({ group: 's', groupLabel: 'Suits season 2' }, 'Suits S02E01');
  g.add({ group: 's' }, 'Suits S02E02');
  g.add({ group: 's' }, 'Suits S02E03');
  await tick();
  g.gates.get('Suits S02E01').rej(new Error('ffmpeg exited 1'));
  await tick();
  q.cancel([...q.active.values()][0].id, 'interrupted');       // E2, in hand
  g.gates.get('Suits S02E02').rej(new Error('Connection Closed'));
  await tick();
  q.pause();
  const before = q.snapshot().active.find((it) => it.group === 's')?.jobs;
  q.add({ kind: 'tv', group: 's', retry: 'cancelled', label: 'Suits S02E02', run: async () => {} }, { overLimit: true });
  const after = q.snapshot().active.find((it) => it.group === 's')?.jobs;
  ok(before?.failed === 1 && before?.cancelled === 1, `before: one failed, one interrupted (${JSON.stringify(before)})`);
  ok(after?.total === 3 && after?.failed === 1 && after?.cancelled === 0,
    `after: still 3 episodes, the real failure kept (${JSON.stringify(after)})`);
  g.gates.get('Suits S02E03')?.res();
}

console.log('=== a retry whose request has left the queue goes back at the front of its lane ===');
{
  const q = new JobQueue({ concurrency: 1, maxLength: 104 });
  q.pause();
  const ctx = makeCtx(q);
  const g = gated(q);
  const e27 = ep(27);
  tvPlugin._journalAdd(ctx, { reqKey: 'solo', label: 'One Piece S12E27', episodes: [e27] });
  g.add({ group: 'o', groupLabel: 'Loki season 1', meta: { kind: 'tv' } }, 'Loki S01E01');
  g.add({ group: 'o', meta: { kind: 'tv' } }, 'Loki S01E02');
  const finished = [];
  tvPlugin._retryEpisodeNow(ctx, {
    ep: e27, msg: null, react: async () => {}, notifier: notifierFor(ctx, 1, finished), route: null, reqKey: 'solo', index: 0, total: 1,
  }, 1);
  ok(q.pendingLabels().join() === 'One Piece S12E27,Loki season 1',
    `a one-episode request is back as one item, first in line (${q.pendingLabels().join()})`);
  const row = q.snapshot().pending[0];
  ok(row.group === 'solo' && row.jobs.total === 1, `counted as the one episode it is (${row.jobs.total})`);
  await tvPlugin.teardown();
}

console.log('=== Cancel on a season takes an episode waiting on its retry with it ===');
{
  const q = new JobQueue({ concurrency: 1, maxLength: 104 });
  q.pause();
  const ctx = makeCtx(q);
  tvPlugin._retries = new RetryBook({ delayMs: () => 60_000, log });
  const [e1, e2] = [ep(1), ep(2)];
  tvPlugin._journalAdd(ctx, { reqKey: 'r', label: 'One Piece season 12 — 2 episode(s)', episodes: [e1, e2] });
  const finished = [];
  const notifier = notifierFor(ctx, 2, finished);
  const reacts = [];
  const react = async (e) => { if (reacts.at(-1) !== e) reacts.push(e); };   // as onMessage's react: never the same twice
  const discard = tvPlugin._discarder(ctx, { reqKey: 'r', label: 'One Piece season 12', notifier, react });
  q.add({ kind: 'tv', group: 'r', groupLabel: 'One Piece season 12', label: 'One Piece S12E02', meta: { kind: 'tv' },
    run: async () => {}, onDiscard: discard(e2) });

  // E1 loses its connection mid-download; its retry is booked for later.
  const job = { id: 'j1', signal: new AbortController().signal, progress() {}, isCancelled: () => false, cancelReason: () => null };
  try {
    await tvPlugin.deliverEpisode({ ep: e1, ctx, job, msg: null, react, notifier, reqKey: 'r', index: 0, total: 2, isLast: false });
  } catch { /* fetch failed: transient */ }
  ok(tvPlugin._retries.isWaiting(`r:${e1.id}`), 'E1 waits on its retry, in no queue');

  const row = q.snapshot().pending.find((it) => it.group === 'r');
  q.cancel(row.id);                                  // the panel's Cancel, on the request's row
  ok(!tvPlugin._retries.isWaiting(`r:${e1.id}`), 'the booked retry is dropped with the rest of the request');
  ok(!(ctx.store.data.pending ?? []).some((r) => r.reqKey === 'r'), 'and the request leaves the journal: a restart cannot bring it back');
  ok(finished.length === 1 && finished[0].cancelled === 2 && finished[0].completed === 0,
    `the request reports once: both cancelled (${JSON.stringify(finished)})`);
  ok(reacts.filter((e) => e === '❌').length === 1 && reacts.at(-1) === '❌', `its message ends on one ❌ (${reacts.join(' ')})`);
  await tick();
  ok(q.pending.length === 0, 'nothing of it is back in the queue');
  await tvPlugin.teardown();
}

console.log('=== so does Cancel reaching an episode in hand; Skip does not ===');
{
  for (const reason of ['cancelled', 'skipped']) {
    const q = new JobQueue({ concurrency: 1, maxLength: 104 });
    q.pause();
    const ctx = makeCtx(q);
    tvPlugin._retries = new RetryBook({ delayMs: () => 60_000, log });
    const [e1, e2] = [ep(1), ep(2)];
    tvPlugin._journalAdd(ctx, { reqKey: 'r', label: 'One Piece season 12', episodes: [e1, e2] });
    const finished = [];
    const notifier = notifierFor(ctx, 2, finished);
    const live = { id: 'j1', signal: new AbortController().signal, progress() {}, isCancelled: () => false, cancelReason: () => null };
    try { await tvPlugin.deliverEpisode({ ep: e1, ctx, job: live, msg: null, react: async () => {}, notifier, reqKey: 'r', index: 0, total: 2 }); } catch { /* transient */ }
    const stopped = { id: 'j2', signal: AbortSignal.abort(), progress() {}, isCancelled: () => true, cancelReason: () => reason };
    await tvPlugin.deliverEpisode({ ep: e2, ctx, job: stopped, msg: null, react: async () => {}, notifier, reqKey: 'r', index: 1, total: 2 });
    if (reason === 'cancelled') {
      ok(!tvPlugin._retries.isWaiting(`r:${e1.id}`) && finished[0]?.cancelled === 2,
        'a cancelled episode in hand ends the request, booked retry and all');
    } else {
      ok(tvPlugin._retries.isWaiting(`r:${e1.id}`) && finished.length === 0,
        'a skipped one is that episode only: E1 still waits on its retry');
    }
    await tvPlugin.teardown();
  }
}

console.log('=== a resumed request waiting for its place counts as waiting ===');
{
  // Recovery puts leftover requests back past the limit, all at once; but
  // the queue's own events run _pump while recovery is still picking them
  // up, and a pump with no free place holds a request back until one frees.
  const q = new JobQueue({ concurrency: 1, maxLength: 1 });
  q.pause();
  const ctx = makeCtx(q);
  q.add({ label: 'A film (2020)', run: async () => {} });               // the only place, taken
  const eps = [ep(5, 'The Mentalist', 3)];
  tvPlugin._journalAdd(ctx, { reqKey: 'tv-old', label: 'The Mentalist S03E05', episodes: eps });
  tvPlugin._live = new Map([['tv-old', { notifier: null, msg: null, react: async () => {}, queued: new Set() }]]);
  tvPlugin._pump(ctx);
  ok(q.pending.length === 1, 'the queue is full, so the resumed request is held back');
  ok(tvPlugin._waitingEpisodeIds(ctx, null).has(eps[0].id), 'its episode still counts as waiting for the duplicate check');
  tvPlugin._pump(ctx, { overLimit: true });
  ok(q.pendingLabels().join() === 'A film (2020),The Mentalist S03E05', 'and goes in, past the limit, once recovery ends');
  tvPlugin._live = new Map();
  await tvPlugin.teardown();
}

fs.rmSync(WORK, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
