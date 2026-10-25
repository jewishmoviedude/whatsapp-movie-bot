/* A film that lost only its send is sent again, not made again.
   Run: node test/send-retry-keeps-file.test.mjs

   The incident, 2026-09-28: "Minority Report" was downloaded (4.75 GB) and
   encoded for 38 minutes into a 1.67 GB file. Its upload started at
   19:39:18 UTC, WhatsApp closed the connection at 19:40:25 (the bot was back
   seconds later), and the upload failed at 19:47:59 with "Connection Closed".
   The failure was rightly transient - but cleanup() had already deleted the
   finished encode ("removed ...Minority Report (2002).mp4"), so the retry
   would have downloaded 4.75 GB and encoded for 38 minutes again, just to
   send a file that had been ready. Episodes lost their file the same way.

   The fixtures stand in for the heavy parts: a library file read in place
   and a stub ffprobe that plans a plain copy, so "converting" is a link into
   the work directory - the retry must not do even that again.

   Since The Parent Trap (2026-09-29, downloaded and 23 minutes into its
   encode when a restart made it start over, twice) the kept file is found
   through the job's own directory and its manifest (media/work-files.js),
   not a path journalled beside the job. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import tvPlugin from '../src/plugins/tv-requests/index.js';
import { RetryBook, MAX_RETRIES, finishedOutput } from '../src/media/resume.js';
import { openWork, workKey, sweepWorkDir, liveWorkDirs, isSafeToDeleteIn, forgetThisProcess } from '../src/media/work-files.js';
import { keptFiles } from '../src/media/disk-space.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'keepfile-'));
const LIB = path.join(TMP, 'lib');
const WORK = path.join(TMP, 'work');
fs.mkdirSync(LIB); fs.mkdirSync(WORK);
const FILM = path.join(LIB, 'Minority Report 2002.mp4');
fs.writeFileSync(FILM, Buffer.alloc(4096, 7));

// ffprobe that describes a sendable mp4, and counts how often it is asked:
// every conversion starts with a probe.
const PROBES = path.join(TMP, 'probes');
const FFPROBE = path.join(TMP, 'ffprobe');
fs.writeFileSync(FFPROBE, `#!/bin/sh
echo x >> '${PROBES}'
cat <<'JSON'
{"streams":[{"codec_type":"video","codec_name":"h264","width":1280,"height":720},{"codec_type":"audio","codec_name":"aac","channels":2}],"format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"60","size":"4096"}}
JSON
`, { mode: 0o755 });
const probes = () => (fs.existsSync(PROBES) ? fs.readFileSync(PROBES, 'utf8').split('\n').filter(Boolean).length : 0);

// Free space as the bot will see it, so these do not depend on the disk of
// whatever box runs them (this one has a few GB free, and the live bot's
// work directory shares it).
const realStatfs = fs.statfsSync;
let freeBytes = 50 * 1024 ** 3;
fs.statfsSync = (p) => {
  if (freeBytes == null) throw new Error('ENOSYS');
  return { ...realStatfs(p), bavail: Math.floor(freeBytes / 4096), bsize: 4096 };
};

const config = mergeDefaults({
  movieRequests: {
    postsGroup: 'posts@g.us', notify: {}, blockedRatings: [],
    reactions: { redo: '🔄', failed: '⚠️', cancelled: '❌', done: '✅', sending: '⬆️', downloading: '⬇️', converting: '⚙️' },
  },
  library: { provider: 'local', local: { roots: [LIB], extensions: ['.mp4'] } },
  media: { workDir: WORK, ffprobePath: FFPROBE, ffmpegPath: '/bin/false', deleteAfterSend: true },
  tvRequests: { postsGroups: ['tvposts@g.us'] },
  whatsapp: { broadcastPacingMs: 0 },
}, DEFAULT_CONFIG);
config.library.jellyfin = { baseUrl: 'http://jf.test', accessToken: 'TOK' };

const logs = [];
const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), debug: (m) => logs.push(m) };

/** WhatsApp whose uploads fail the way 19:47:59 did, `failures` times. */
function fakeBot(failures) {
  const bot = {
    sent: [], failures,
    isConnected: () => true,
    react: async () => true,
    sendText: async () => ({}),
    groups: () => [],
    groupMemberInfo: () => ({ isMember: false }),
    on() {}, off() {},
    sendDocument: async (jid, file) => {
      bot.sent.push({ jid, file, size: fs.statSync(file).size });
      if (bot.failures > 0) { bot.failures -= 1; throw new Error('Connection Closed'); }
      return {};
    },
  };
  return bot;
}

function fakeStore(data = {}) {
  return {
    get: (k, d = null) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; },
    push: (k, v) => { (data[k] ??= []).unshift(v); }, data,
  };
}

function fakeQueue() {
  return { maxLength: 100, pending: [], active: new Map(), added: [], history: [], on() {}, off() {},
    add(job, opts = {}) { this.added.push({ job, opts }); return `q${this.added.length}`; } };
}

function movieCtx(failures, store = fakeStore()) {
  return { bot: fakeBot(failures), store, queue: fakeQueue(), log, config };
}

function journalled(store) {
  const record = { id: 'AC7E6087', request: 'minority report 2002', status: 'queued', title: 'Minority Report', year: 2002, rated: 'PG-13' };
  store.set('pending', [{
    jobKey: 'AC7E6087:tt0181689', msgId: 'AC7E6087', msgKey: { remoteJid: 'req@g.us', id: 'AC7E6087' }, chatJid: 'req@g.us',
    movie: { title: 'Minority Report', year: 2002, imdbId: 'tt0181689', rated: 'PG-13' },
    meta: { requester: 'Aaron' }, record, at: Date.now(),
  }]);
}

const job = () => ({ id: `j${Math.random().toString(16).slice(2, 8)}`, signal: new AbortController().signal,
  progress() {}, isCancelled: () => false, cancelReason: () => null });
/** Run the newest queued job; answers the error it threw, if any. */
async function runLatest(ctx) {
  try { await ctx.queue.added.at(-1).job.run(job()); return null; } catch (e) { return e; }
}
const workFiles = () => fs.readdirSync(WORK);
/** Every file under the work directory bar the manifests, as paths inside it. */
const dataFiles = (dir = WORK) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return dataFiles(p);
  return e.name === 'manifest.json' ? [] : [path.relative(WORK, p)];
});
const isSafe = (p) => isSafeToDeleteIn(p, { workDir: WORK, roots: [LIB] });
const JOB = 'AC7E6087:tt0181689';
/** The film's work, as the plugin keeps it. */
const filmWork = (jobKey = JOB) => openWork({ workDir: WORK, key: workKey.movie(jobKey), isSafe });
/** The finished file its work holds, re-read from the disk. */
const keptFilm = (jobKey = JOB) => finishedOutput(filmWork(jobKey));

console.log('=== the incident: the send is lost, the finished film is kept ===');
{
  const ctx = movieCtx(1);
  moviePlugin._retries = new RetryBook({ delayMs: () => 5, log });
  journalled(ctx.store);
  await moviePlugin.recoverPending(ctx);
  const before = probes();
  const err = await runLatest(ctx);
  ok(/Connection Closed/.test(err?.message ?? ''), 'the upload fails with "Connection Closed"');
  ok(probes() === before + 1, 'after the film was made (probed and converted once)');
  const ready = keptFilm();
  ok(ready?.outPath?.startsWith(WORK) && fs.existsSync(ready.outPath), `the finished file is kept (${path.basename(ready?.outPath ?? '?')})`);
  ok(ready?.size === 4096 && ready.outPath === ctx.bot.sent[0].file && ctx.store.data.pending.length === 1,
    'and recorded with its size in the job\'s manifest - the file that was being sent - with the job still journalled');
  ok(logs.some((l) => /retrying once WhatsApp is connected \(attempt 1 of 3\), sending the finished 4\.00 KB file as it is/.test(l)),
    'the log says the retry will send it as it is');

  await tick();
  ok(ctx.queue.added.length === 2, 'the retry is queued');
  const err2 = await runLatest(ctx);
  ok(!err2, `and it succeeds (${err2?.message ?? 'no error'})`);
  ok(probes() === before + 1, 'without probing or converting anything again');
  ok(ctx.bot.sent[1]?.file === ready.outPath, 'sending the very file that was kept');
  ok(logs.some((l) => /reusing Minority Report \(2002\)\.mp4 \(4\.00 KB\), finished before the send was lost/.test(l)),
    'and says so');
  ok(!fs.existsSync(ready.outPath) && workFiles().length === 0, 'it is gone once posted, with nothing else left behind');
  ok((ctx.store.data.pending ?? []).length === 0, 'and so is the journal entry');
}

console.log('=== after the last retry the kept file waits for the next start, which sends it as it is ===');
{
  // It used to be deleted once the retries in this process were spent -
  // "kept work is room no job in this process will give back" - and the
  // next start, which the hourly check brings about for a film left this
  // way, made it again from step 1. The operator, 2026-09-29: "if bot gets
  // interrupted it should be able to continue where left off and not need
  // to start over from step 1".
  const store = fakeStore();
  const ctx = movieCtx(99, store);
  moviePlugin._retries = new RetryBook({ delayMs: () => 5, log });
  journalled(ctx.store);
  await moviePlugin.recoverPending(ctx);
  let kept = null;
  for (let i = 0; i <= MAX_RETRIES; i++) {
    await runLatest(ctx);
    kept ??= keptFilm()?.outPath;
    await tick();
  }
  ok(ctx.bot.sent.length === MAX_RETRIES + 1 && new Set(ctx.bot.sent.map((s) => s.file)).size === 1,
    `every attempt sent the same kept file (${ctx.bot.sent.length} sends)`);
  ok(kept && fs.existsSync(kept) && keptFilm()?.outPath === kept && ctx.store.data.pending.length === 1,
    'after the third retry the finished film is still there, and the job still journalled for the next start');
  ok(logs.some((l) => /retried 3 times in this process; will retry on next start, going on from what it had done$/.test(l)),
    'the log says the next start goes on from it');
  ok(!keptFiles().some((k) => k.key === JOB) && moviePlugin._parked?.has(JOB),
    'no room is held for it in this process, which will not run it - it is parked, for the next start');

  // The next start: the start-up sweep, then recovery.
  moviePlugin._retries.clear();
  forgetThisProcess();
  moviePlugin._parked = null;
  sweepWorkDir(WORK, { all: true, live: liveWorkDirs({ movie: store.data.pending, tv: [] }), isSafe, log });
  const after = movieCtx(0, store);
  moviePlugin._retries = new RetryBook({ delayMs: () => 5, log });
  await moviePlugin.recoverPending(after);
  const before = probes();
  const err = await runLatest(after);
  ok(!err && after.bot.sent.length === 1 && after.bot.sent[0].file === kept && probes() === before,
    'the next start sends the film it kept, with nothing probed or converted again');
  ok(!fs.existsSync(kept) && (store.data.pending ?? []).length === 0 && workFiles().length === 0,
    'and then it is gone, and the journal is clear');
  moviePlugin._retries.clear();
}

console.log('=== a restart while the retry waits keeps the file; the start-up sweep spares it ===');
{
  const store = fakeStore();
  const ctx = movieCtx(1, store);
  moviePlugin._retries = new RetryBook({ delayMs: () => 60_000, log });
  journalled(store);
  await moviePlugin.recoverPending(ctx);
  await runLatest(ctx);
  moviePlugin._retries.clear();                     // the process stops
  forgetThisProcess();
  const kept = keptFilm().outPath;
  fs.writeFileSync(path.join(WORK, '123-abc-source.mkv'), 'left behind by a killed job');

  // The next process: src/index.js sweeps the work directory before any
  // plugin loads, sparing what the journals hold.
  sweepWorkDir(WORK, { all: true, live: liveWorkDirs({ movie: store.data.pending, tv: [] }), isSafe, log });
  ok(fs.existsSync(kept), 'the kept film survives the start-up sweep');
  ok(!fs.existsSync(path.join(WORK, '123-abc-source.mkv')), 'while everything else there is swept, as before');

  const after = movieCtx(0, store);
  moviePlugin._retries = new RetryBook({ delayMs: () => 5, log });
  await moviePlugin.recoverPending(after);
  const before = probes();
  const err = await runLatest(after);
  ok(!err && after.bot.sent[0]?.file === kept && probes() === before, 'and recovery sends it as it is');
  ok(!fs.existsSync(kept) && (store.data.pending ?? []).length === 0, 'then it is gone');
}

console.log('=== a kept file that is gone or changed is made again ===');
{
  const store = fakeStore();
  journalled(store);
  // The film's work says it was made - of this very library file - but the
  // file is not there.
  const w = filmWork();
  const st = fs.statSync(FILM);
  w.record({
    item: { provider: 'local', id: FILM, access: 'local', librarySize: null, total: null, lastModified: null, etag: null,
      local: { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs } },
    output: { name: 'output.mp4', size: 4096, action: 'copy' },
  });
  const ctx = movieCtx(0, store);
  await moviePlugin.recoverPending(ctx);
  const before = probes();
  const err = await runLatest(ctx);
  ok(!err && probes() === before + 1, 'a missing file: fetched and converted again, and sent');
  ok(logs.some((l) => /the finished file kept for "Minority Report" is gone or has changed/.test(l)), 'with a log line saying why');

  const v = filmWork('Y:tt0181689');
  v.lock();
  fs.writeFileSync(v.outPath, 'truncated');
  v.record({ output: { name: 'output.mp4', size: 4096, action: 'copy' } });
  ok(finishedOutput(v) === null, 'a file of the wrong size is not trusted');
  v.record({ output: { name: '../../lib/Minority Report 2002.mp4', size: 4096, action: 'copy' } });
  ok(finishedOutput(v) === null, 'nor one outside the job\'s own directory');
  v.record({ output: { name: 'output.mp4', size: 9, action: 'copy' } });
  ok(finishedOutput(v)?.outPath === v.outPath, 'an intact one is');
  v.release();
  v.drop();
}

console.log('=== a cancel takes the kept file with it ===');
{
  const ctx = movieCtx(1);
  moviePlugin._retries = new RetryBook({ delayMs: () => 60_000, log });
  journalled(ctx.store);
  await moviePlugin.recoverPending(ctx);
  await runLatest(ctx);
  const kept = keptFilm().outPath;
  moviePlugin._cancelledWhileWaiting(ctx, { id: 'q9', label: 'Minority Report (2002)', state: 'cancelled', meta: { jobKey: 'AC7E6087:tt0181689' } });
  ok(!fs.existsSync(kept) && (ctx.store.data.pending ?? []).length === 0 && workFiles().length === 0,
    'cancelled while its retry waited: file, job directory and journal entry all gone');
  moviePlugin._retries.clear();

  // Cancelled while the retry itself runs: the send fails, the admin's cancel wins.
  const c2 = movieCtx(1);
  moviePlugin._retries = new RetryBook({ delayMs: () => 5, log });
  journalled(c2.store);
  await moviePlugin.recoverPending(c2);
  await runLatest(c2);
  await tick();
  const kept2 = keptFilm().outPath;
  c2.bot.failures = 1;
  try {
    await c2.queue.added.at(-1).job.run({ ...job(), isCancelled: () => true, cancelReason: () => 'cancelled' });
  } catch { /* not expected */ }
  ok(!fs.existsSync(kept2) && (c2.store.data.pending ?? []).length === 0, 'cancelled mid-send: file and journal entry both gone');
  moviePlugin._retries.clear();
}

console.log('=== kept whatever the disk has free ===');
{
  // It used to be deleted when a lost send found the disk nearly full, and
  // the retry started over from the download. The operator, 2026-09-30,
  // after a restart deleted three fully converted films: "files should
  // remain in their folders until fully sent on whatsapp". A job asked for
  // meanwhile waits for the room instead (test/disk-room-kept-work.test.mjs).
  const ctx = movieCtx(1);
  moviePlugin._retries = new RetryBook({ delayMs: () => 60_000, log });
  journalled(ctx.store);
  await moviePlugin.recoverPending(ctx);
  // The disk fills while the film is made and sent - by the time the send
  // is lost there is next to nothing free.
  const send = ctx.bot.sendDocument;
  ctx.bot.sendDocument = async (...a) => { freeBytes = 4096; return send(...a); };
  logs.length = 0;
  await runLatest(ctx);
  freeBytes = 50 * 1024 ** 3;
  ok(!!keptFilm() && fs.existsSync(keptFilm().outPath), 'with the disk nearly full the finished film is kept all the same');
  ok(!logs.some((l) => /nearly full/.test(l)), 'and nothing is said about giving it up');
  ok(moviePlugin._retries.isWaiting('AC7E6087:tt0181689'), 'the retry sends it');
  moviePlugin._retries.clear();
  for (const f of fs.readdirSync(WORK)) fs.rmSync(path.join(WORK, f), { recursive: true, force: true });
}

console.log('=== the hourly sweep still clears a leftover in the end ===');
{
  // A kept file belongs to a journalled job now, and is kept as long as the
  // job is (test/work-sweep-keeps-journalled.test.mjs); what no journal holds
  // is swept six hours on, as before.
  const old = path.join(WORK, 'z-kept.mp4');
  fs.writeFileSync(old, 'x');
  const past = new Date(Date.now() - 7 * 3600 * 1000);
  fs.utimesSync(old, past, past);
  sweepWorkDir(WORK, { olderThanMs: 6 * 3600_000, live: new Set(), isSafe, log });
  ok(!fs.existsSync(old), 'six hours on, it is swept like any leftover');
}

console.log('=== TV: an episode that lost its send is sent again as it is ===');
{
  const downloads = [];
  // A download, as counted here, is not the one-byte question a resumed job
  // asks the library first (media/work-files.js probeDownload).
  globalThis.fetch = async (url, init = {}) => {
    if (init.headers?.Range !== 'bytes=0-0') downloads.push(String(url));
    return new Response(Buffer.alloc(2048, 1), { status: 200, headers: { 'content-length': '2048' } });
  };
  const store = fakeStore();
  const ctx = { bot: fakeBot(1), store, queue: fakeQueue(), log, config };
  tvPlugin._retries = new RetryBook({ delayMs: () => 5, log });
  const ep = { id: 'op-12-27', series: 'One Piece', season: 12, episode: 27, title: 'S12E27', size: 2048 };
  tvPlugin._journalAdd(ctx, { reqKey: 'tv-op', label: 'One Piece season 12', episodes: [ep] });
  const outcome = [];
  const notifier = { stage() {}, episodeDone: () => outcome.push('done'), episodeFailed: () => outcome.push('failed'), episodeCancelled: () => outcome.push('cancelled') };
  let err = null;
  try {
    await tvPlugin.deliverEpisode({ ep, ctx, job: job(), msg: null, react: async () => {}, notifier, reqKey: 'tv-op', isLast: true, index: 0, total: 1 });
  } catch (e) { err = e; }
  ok(/Connection Closed/.test(err?.message ?? '') && downloads.length === 1, 'the episode is downloaded once and loses its send');
  const kept = ctx.bot.sent[0].file;
  ok(fs.existsSync(kept), 'the finished episode is kept');
  await tick();
  const err2 = await runLatest(ctx);
  ok(!err2 && downloads.length === 1, `the retry downloads nothing (${downloads.length} download)`);
  ok(ctx.bot.sent[1]?.file === kept && outcome.join() === 'done', 'and sends the kept file, reporting once');
  ok(!fs.existsSync(path.dirname(kept)) && dataFiles().length === 0,
    `which is then deleted with its directory, like any posted episode (${dataFiles().join(', ')})`);
  tvPlugin._retries.clear();
}

console.log('=== TV: a kept episode outlives a restart, as a film does ===');
{
  // It lived only in memory: after a restart the episode was downloaded and
  // converted again (review scenario l-restart-kept: 2 re-downloads), and
  // the movie plugin's start-up sweep - which runs first, and spared only
  // the films' kept files - deleted it anyway.
  const downloads = [];
  // A download, as counted here, is not the one-byte question a resumed job
  // asks the library first (media/work-files.js probeDownload).
  globalThis.fetch = async (url, init = {}) => {
    if (init.headers?.Range !== 'bytes=0-0') downloads.push(String(url));
    return new Response(Buffer.alloc(2048, 1), { status: 200, headers: { 'content-length': '2048' } });
  };
  const tvStore = fakeStore();
  const ctx = { bot: fakeBot(1), store: tvStore, queue: fakeQueue(), log, config };
  tvPlugin._retries = new RetryBook({ delayMs: () => 60_000, log });
  const ep = { id: 'op-12-29', series: 'One Piece', season: 12, episode: 29, title: 'S12E29', size: 2048 };
  tvPlugin._journalAdd(ctx, { reqKey: 'tv-op5', label: 'One Piece season 12', episodes: [ep] });
  try {
    await tvPlugin.deliverEpisode({ ep, ctx, job: job(), msg: null, react: async () => {}, notifier: null, reqKey: 'tv-op5', isLast: true, index: 0, total: 1 });
  } catch { /* the send is lost */ }
  const kept = ctx.bot.sent[0]?.file;
  const recorded = finishedOutput(openWork({ workDir: WORK, key: workKey.tv('tv-op5', 'op-12-29'), isSafe }));
  ok(kept && recorded?.outPath === kept && recorded.size === 2048 && tvStore.data.pending?.[0]?.episodes?.length === 1,
    `the kept file is recorded in the episode's work, the episode still journalled (${recorded?.outPath})`);
  tvPlugin._retries.clear();                          // the process stops
  await tvPlugin.teardown();
  forgetThisProcess();

  // The next process sweeps the shared work directory first, sparing what
  // either journal holds (src/index.js).
  sweepWorkDir(WORK, { all: true, live: liveWorkDirs({ movie: [], tv: tvStore.data.pending }), isSafe, log });
  ok(fs.existsSync(kept), 'the start-up sweep spares it');

  const after = { bot: fakeBot(0), store: tvStore, queue: fakeQueue(), log, config };
  await tvPlugin.recoverPending(after);
  const err = await runLatest(after);
  ok(!err && downloads.length === 1 && after.bot.sent[0]?.file === kept,
    `recovery sends it as it is, once the library says it is still the same file (${downloads.length} download in all)`);
  ok(!fs.existsSync(kept) && !(tvStore.data.pending ?? []).length, 'then it is gone, and the journal is clear');
  await tvPlugin.teardown();
}

console.log('=== TV: a retried episode shows ✅ only once the whole request is done ===');
{
  // The retry used to run as the season's last episode whatever its place, so
  // a retried first episode put ✅ on the request while the rest of the season
  // was still waiting - and the next episode's ⬇️ then replaced it.
  const eps = [1, 2, 3].map((n) => ({ id: `op-12-${n}`, series: 'One Piece', season: 12, episode: n, title: `S12E0${n}`, size: 2048 }));
  globalThis.fetch = async () => new Response(Buffer.alloc(2048, 1), { status: 200, headers: { 'content-length': '2048' } });
  const store = fakeStore();
  const ctx = { bot: fakeBot(1), store, queue: fakeQueue(), log, config };
  tvPlugin._retries = new RetryBook({ delayMs: () => 5, log });
  tvPlugin._journalAdd(ctx, { reqKey: 'tv-op3', label: 'One Piece season 12', episodes: eps });
  const finished = [];
  const notifier = tvPlugin._makeRequestNotifier(ctx, {
    label: 'One Piece season 12', total: 3, msg: null, single: false, onFinish: (r) => finished.push(r),
  });
  const reacts = [];
  const react = async (e) => { reacts.push(e); };
  const episode = (i) => ({ ep: eps[i], ctx, job: job(), msg: null, react, notifier, reqKey: 'tv-op3',
    isLast: i === eps.length - 1, index: i, total: eps.length });

  try { await tvPlugin.deliverEpisode(episode(0)); } catch { /* E1 loses its send */ }
  await tick();
  ok(!(await runLatest(ctx)), 'the retried first episode is sent');
  ok(!reacts.includes('✅') && finished.length === 0, `no ✅ while two episodes are still to come (${reacts.join(' ')})`);
  await tvPlugin.deliverEpisode(episode(1));
  ok(!reacts.includes('✅'), 'nor after the second');
  await tvPlugin.deliverEpisode(episode(2));
  ok(reacts.at(-1) === '✅' && finished.length === 1, 'the last episode ends the request on ✅');

  // The other order: the last episode lands while the first waits on its retry.
  const store2 = fakeStore();
  const ctx2 = { bot: fakeBot(1), store: store2, queue: fakeQueue(), log, config };
  tvPlugin._journalAdd(ctx2, { reqKey: 'tv-op4', label: 'One Piece season 12', episodes: eps.slice(0, 2) });
  const notifier2 = tvPlugin._makeRequestNotifier(ctx2, { label: 'One Piece season 12', total: 2, msg: null, single: false });
  const reacts2 = [];
  const react2 = async (e) => { reacts2.push(e); };
  const ep2 = (i) => ({ ep: eps[i], ctx: ctx2, job: job(), msg: null, react: react2, notifier: notifier2, reqKey: 'tv-op4',
    isLast: i === 1, index: i, total: 2 });
  try { await tvPlugin.deliverEpisode(ep2(0)); } catch { /* E1 loses its send */ }
  await tvPlugin.deliverEpisode(ep2(1));
  ok(!reacts2.includes('✅'), 'the season\'s last episode does not show ✅ while an earlier one waits on its retry');
  await tick();
  await runLatest(ctx2);
  ok(reacts2.at(-1) === '✅', 'the retry that completes the request does');
  tvPlugin._retries.clear();
}

fs.statfsSync = realStatfs;
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
