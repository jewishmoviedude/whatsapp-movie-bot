/* A full disk is waited out, not failed on; and a job waits for room before it starts, rather than starting and crashing.
   Run: node test/disk-full-retry.test.mjs

   The incident, bot-box, 2026-09-28: the 29 GB disk reached 0 bytes free.
   Three jobs were running at once, each holding its source (Minority Report's
   was 4.75 GB, a second copy of it was downloading) until it was posted, and
   Baileys' encrypted upload copy sat beside the converted file on the same
   disk. "Charlie and the Chocolate Factory" died in ffmpeg at 20:34:47 UTC
   ("ffmpeg exited 228: drop_frames=0 | speed=2.78x | progress=end" - 228 is
   -ENOSPC), "The Parent Trap" in its download at 21:01:08 ("ENOSPC: no space
   left on device, write"), and "Minority Report" uploaded a copy the full
   disk had cut short for 33 minutes before "Media upload failed on all
   hosts" at 21:07:03. All three were marked failed - ⚠️ to the requester, and
   nothing tried them again - although each would have gone through once the
   jobs ahead of it had finished.

   Nothing here fills a real disk: free space is whatever these tests say it
   is (fs.statfsSync, the seam upload-temp-space and send-retry-keeps-file
   use), and every file written is a few kilobytes in a temp directory. Once
   something "fills" it - a download or an encode that failed on ENOSPC - the
   disk reports next to nothing free until the test says otherwise. A job the
   disk filled under keeps what it has done for the retry all the same: since
   The Parent Trap (2026-09-29) a job keeps its work across a failure
   (media/work-files.js), and since 2026-09-30 nothing in it is deleted
   before the file is sent, however full the disk - the operator: "files
   should remain in their folders until fully sent on whatsapp". */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import tvPlugin from '../src/plugins/tv-requests/index.js';
import { RetryBook } from '../src/media/resume.js';
import { runFfmpeg } from '../src/media/ffmpeg.js';
import {
  isDiskFull, jobNeed, roomFor, waitForRoom, claimRoom, reserveRoom, noteDiskFull, heldRoom,
  SPARE_BYTES, UNKNOWN_SOURCE_BYTES, keepRoom, forgetKept, keptFiles, describeNeed, dirBytes,
} from '../src/media/disk-space.js';
import { WhatsAppBot } from '../src/core/bot.js';
import { openWork, workKey, isSafeToDeleteIn, itemIdOf } from '../src/media/work-files.js';
import { scan, parseLog } from '../src/core/incident-scan.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const GB = 1024 ** 3;

// Free space on "the disk", as every part of the bot will be told it.
const realStatfs = fs.statfsSync;
let free = 50 * GB;
let statfsCalls = 0;
// Set by whatever "fills" the disk: then almost nothing is free.
let filled = false;
fs.statfsSync = (p, ...rest) => {
  statfsCalls += 1;
  const now = filled || fs.existsSync(`${FULL}.hit`) ? 0.1 * GB : free;
  return { ...realStatfs(p, ...rest), bavail: Math.floor(now / 4096), bsize: 4096 };
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-full-'));
const LIB = path.join(TMP, 'lib');
const WORK = path.join(TMP, 'work');
fs.mkdirSync(LIB); fs.mkdirSync(WORK);
fs.writeFileSync(path.join(LIB, 'Heat 1995.mp4'), Buffer.alloc(4096, 3));

// A matroska source is remuxed by the stub ffmpeg, which copies half of it -
// or, once told the disk is full, exits 228 as the real one did.
const FFPROBE = path.join(TMP, 'ffprobe');
fs.writeFileSync(FFPROBE, `#!/bin/sh
cat <<JSON
{"streams":[{"codec_type":"video","codec_name":"h264","width":1280,"height":720},{"codec_type":"audio","codec_name":"aac","channels":2}],"format":{"format_name":"matroska,webm","duration":"60","size":"4096"}}
JSON
`, { mode: 0o755 });
const FULL = path.join(TMP, 'full');
const FFMPEG = path.join(TMP, 'ffmpeg');
fs.writeFileSync(FFMPEG, `#!/bin/sh
if [ -f '${FULL}' ]; then touch '${FULL}.hit'; echo "drop_frames=0" >&2; echo "speed=2.78x" >&2; echo "progress=end" >&2; exit 228; fi
prev=""; in=""; out=""
for a in "$@"; do
  [ "$prev" = "-i" ] && in="$a"
  [ "$a" = "-progress" ] && out="$prev"
  prev="$a"
done
head -c 2048 "$in" > "$out"
`, { mode: 0o755 });

const MAX_OUT = 1 * GB;
const config = () => {
  const c = mergeDefaults({
    movieRequests: { postsGroup: 'posts@g.us', notify: {}, blockedRatings: [] },
    library: { provider: 'local', local: { roots: [LIB], extensions: ['.mp4'] } },
    media: { workDir: WORK, ffprobePath: FFPROBE, ffmpegPath: FFMPEG, deleteAfterSend: true, maxOutputBytes: MAX_OUT },
    tvRequests: { postsGroups: ['tvposts@g.us'] },
    whatsapp: { broadcastPacingMs: 0 },
  }, DEFAULT_CONFIG);
  c.library.jellyfin = { baseUrl: 'http://jf.test', accessToken: 'TOK' };
  return c;
};

const logs = [];
const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), debug() {} };

function fakeBot() {
  const bot = {
    sent: [], reacted: [], connected: true,
    isConnected: () => bot.connected, react: async (m, e) => { bot.reacted.push(e); return true; },
    sendText: async () => ({}), groups: () => [], groupMemberInfo: () => ({ isMember: false }), on() {}, off() {},
    sendDocument: async (jid, file) => { bot.sent.push({ jid, file, size: fs.statSync(file).size }); return {}; },
  };
  return bot;
}
function fakeStore(data = {}) {
  return { get: (k, d = null) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; }, push: (k, v) => { (data[k] ??= []).unshift(v); }, data };
}
function fakeQueue() {
  return { pending: [], active: new Map(), added: [], on() {}, off() {},
    add(job, opts = {}) { this.added.push({ job, opts }); return `q${this.added.length}`; }, moveTop() { return true; } };
}
function job() {
  const ac = new AbortController();
  const j = { id: `j${Math.random().toString(16).slice(2, 8)}`, signal: ac.signal, stages: [],
    progress: (p) => { if (p?.stage) j.stages.push(p); }, isCancelled: () => false, cancelReason: () => null, abort: () => ac.abort() };
  return j;
}

// Jellyfin's download: whole, or cut off by a disk that filled mid-write.
let fetches = 0;
let downloadFails = false;
globalThis.fetch = async () => {
  fetches += 1;
  if (!downloadFails) return new Response(Buffer.alloc(4096, 1), { status: 200, headers: { 'content-length': '4096' } });
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(1024));
      filled = true;
      c.error(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }));
    },
  });
  return new Response(body, { status: 200, headers: { 'content-length': '4096' } });
};

const HEAT = { title: 'Heat', year: 1995, imdbId: 'tt0113277', rated: 'R' };
const dlHit = () => ({ access: 'http', provider: 'jellyfin', downloadUrl: 'http://jf.test/heat', container: 'mkv', size: 4096 });
function journalled(store, id = 'R1') {
  const record = { id, request: 'heat 1995', status: 'queued', title: 'Heat', year: 1995, rated: 'R' };
  store.set('history', [{ ...record }]);
  store.set('pending', [{ jobKey: `${id}:tt0113277`, msgId: id, msgKey: null, chatJid: 'req@g.us',
    movie: HEAT, meta: {}, record, at: Date.now() }]);
  return record;
}
function film(ctx, { record, j = job(), hit = dlHit(), id = 'R1' } = {}) {
  const reacts = [];
  const done = moviePlugin.deliver({
    msg: null, movie: HEAT, hit, ctx, job: j, record, react: async (e) => { reacts.push(e); }, jobKey: `${id}:tt0113277`,
  }).then(() => null, (e) => e);
  return { done, reacts, j };
}
/** Every file under the work directory bar the jobs' manifests. */
const workFiles = (dir = WORK) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return workFiles(p);
  return e.name === 'manifest.json' ? [] : [path.relative(WORK, p)];
});
const clearWork = () => { for (const f of fs.readdirSync(WORK)) fs.rmSync(path.join(WORK, f), { recursive: true, force: true }); };
const isSafe = (p) => isSafeToDeleteIn(p, { workDir: WORK, roots: [LIB] });
const needFor = (o = {}) => jobNeed({ workDir: WORK, kind: 'movie', sourceBytes: 4096, maxOutputBytes: MAX_OUT, ...o });

console.log('=== a full disk is known for what it is ===');
{
  ok(isDiskFull(Object.assign(new Error('write failed'), { code: 'ENOSPC' })), 'anything coded ENOSPC');
  ok(isDiskFull(new Error('ENOSPC: no space left on device, write')), 'The Parent Trap\'s download, 21:01:08');
  ok(isDiskFull(new Error('ffmpeg exited 228: drop_frames=0 | speed=2.78x | progress=end')),
    'Charlie and the Chocolate Factory\'s encode, 20:34:47 - 228 is -ENOSPC, whatever the last lines say');
  ok(!isDiskFull(new Error('ffmpeg exited 1: Invalid data found')) && !isDiskFull(new Error('Connection Closed')) && !isDiskFull(null),
    'an encoder\'s own failure or a dropped connection is not');
  ok(!isDiskFull(Object.assign(new Error('not enough disk space for Heat'), { code: 'DISK_TOO_SMALL' })),
    'nor the refusal of a job the disk cannot hold at all - waiting would not change that');

  fs.writeFileSync(FULL, '');
  let err = null;
  try { await runFfmpeg(['-i', 'x', 'y'], { cfg: { ffmpegPath: FFMPEG } }); } catch (e) { err = e; }
  fs.rmSync(FULL);
  fs.rmSync(`${FULL}.hit`, { force: true });
  ok(err?.code === 'ENOSPC' && /^ffmpeg exited 228 \(no space left on device\): /.test(err.message),
    `ffmpeg exiting 228 is coded as a full disk, and says so (${err?.message})`);

  // Baileys' upload copy, cut short: the real bot, over a socket whose
  // upload fails the way 21:07:03 did after an uncaught ENOSPC at 20:34:47.
  const FILM = path.join(TMP, 'Minority Report (2002).mp4');
  fs.writeFileSync(FILM, Buffer.alloc(40_000, 3));
  let full = true;
  const sock = {
    user: { id: '15550001111:4@s.whatsapp.net' }, authState: { creds: { me: { id: '15550001111:4@s.whatsapp.net' } } },
    waUploadToServer: async () => {
      if (full) noteDiskFull();
      throw new Error('Media upload failed on all hosts');
    },
    relayMessage: async (jid, message, opts) => opts.messageId,
    sendMessage: async () => ({}),
  };
  const bot = new WhatsAppBot({ configStore: { get: () => ({ whatsapp: {} }) }, dataDir: TMP });
  bot.state = 'connected';
  bot.sock = sock;
  bot.activeAccountId = 'a';
  err = null;
  try { await bot.sendDocument('posts@g.us', FILM); } catch (e) { err = e; }
  ok(err?.code === 'ENOSPC' && /the disk filled while Minority Report \(2002\)\.mp4 was uploading/.test(err.message)
    && /Media upload failed on all hosts/.test(err.message) && isDiskFull(err),
    'an upload that fails after the disk filled under it is a full disk, not WhatsApp refusing it');
  await tick(5);
  full = false;
  err = null;
  try { await bot.sendDocument('posts@g.us', FILM); } catch (e) { err = e; }
  ok(err && !err.code && err.message === 'Media upload failed on all hosts',
    'the same failure with the disk fine since the upload started is left as it was');
  fs.rmSync(FILM);
}

console.log('=== the retry book waits for room before an attempt ===');
{
  const book = new RetryBook({ delayMs: () => 5, log });
  let runs = 0;
  let room = null;
  let signal = null;
  book.schedule('a', { bot: null, run: () => { runs += 1; }, until: (s) => { signal = s; return new Promise((r) => { room = r; }); } });
  await tick();
  ok(runs === 0 && book.isWaiting('a'), 'past its delay, it still waits while there is no room - and counts as waiting');
  room();
  await tick();
  ok(runs === 1 && !book.isWaiting('a'), 'and runs once there is');

  book.schedule('b', { bot: null, run: () => { runs += 1; }, until: (s) => { signal = s; return new Promise(() => {}); } });
  await tick();
  book.forget('b');
  await tick();
  ok(signal?.aborted && runs === 1, 'a retry forgotten while it waits (a cancel) stops waiting, and never runs');

  logs.length = 0;
  book.schedule('c', { bot: null, run: () => { runs += 1; }, until: async () => { throw new Error('statfs broke'); } });
  await tick();
  ok(runs === 2 && logs.some((l) => /retry of c: statfs broke - trying it anyway/.test(l)),
    'a wait that fails does not strand the job: it is tried, and decides for itself');
  book.clear();
}

console.log('=== what a job needs, and what the jobs ahead still have to write ===');
{
  const n = needFor({ sourceBytes: 3 * GB });
  ok(n.source === 3 * GB && n.output === MAX_OUT && n.upload === MAX_OUT && n.spare === SPARE_BYTES
    && n.total === 3 * GB + 2 * MAX_OUT + SPARE_BYTES,
  'the download, the converted file at its largest and its upload copy - the download is kept until the file is sent - and a margin');
  const small = needFor({ sourceBytes: 0.5 * GB });
  ok(small.total === 0.5 * GB + 2 * MAX_OUT + SPARE_BYTES,
    'a download smaller than its upload copy: all three all the same');
  // Minority Report (review scenario D2): a 4.64 GB source, encoded under a
  // 1.8 GB cap. While its download was deleted once the file was made, it
  // never held more than 6.44 GB; kept until the film is sent, the download
  // is on the disk beside the file and its upload copy.
  const mr = jobNeed({ workDir: WORK, kind: 'movie', sourceBytes: 4.64 * GB, maxOutputBytes: 1.8 * GB });
  ok(Math.abs(mr.total - (8.24 * GB + SPARE_BYTES)) < 1024,
    `Minority Report needs ${(mr.total / GB).toFixed(2)} GB: its download, the file and the upload copy together`);
  ok(describeNeed(mr) === "a 4.64 GB download and up to 1.80 GB converted, then 1.80 GB for the upload's copy, 512.00 MB spare",
    `and the reason reads in that order (${describeNeed(mr)})`);
  ok(needFor({ sourceBytes: null }).source === UNKNOWN_SOURCE_BYTES.movie && UNKNOWN_SOURCE_BYTES.movie >= 5.1 * GB,
    'a download Jellyfin gave no size for is counted as more than the largest film seen (5.1 GB)');
  ok(needFor({ kind: 'tv', sourceBytes: 0 }).source === UNKNOWN_SOURCE_BYTES.tv, 'an episode has its own estimate');
  ok(needFor({ download: false }).source === 0, 'a film read in place from the library downloads nothing');
  ok(needFor({ made: 1.5 * GB }).total === 1.5 * GB + SPARE_BYTES, 'a finished file kept for a retry needs only its upload copy');
  ok(needFor({ tmpDir: '/proc' }).upload === 0, 'and no upload copy is counted when the temp directory is another disk');

  free = 10 * GB;
  const src = path.join(WORK, 'ahead-source.mkv');
  fs.writeFileSync(src, Buffer.alloc(1024 * 1024));
  const ahead = claimRoom('ahead', { dir: WORK, source: { path: src, bytes: 3 * GB }, out: { path: path.join(WORK, 'ahead.mp4'), bytes: MAX_OUT }, upload: MAX_OUT });
  const r = roomFor(WORK, needFor());
  ok(r.others === 1 && r.held === 3 * GB - 1024 * 1024 + 2 * MAX_OUT && r.available === free - r.held,
    'a job downloading still has the rest of its download, its converted file and its upload copy to write - which is not free');
  ahead.made(0.5 * GB);
  ok(roomFor(WORK, needFor()).held === 0.5 * GB, 'once it is converted, only its upload copy, at the size it came out');
  ahead.release();
  ok(roomFor(WORK, needFor()).held === 0 && !heldRoom().length, 'and nothing once it is done');
  fs.rmSync(src);
  free = 50 * GB;
}

console.log('=== a job waits for room instead of starting and crashing ===');
{
  const store = fakeStore();
  const record = journalled(store);
  const ctx = { bot: fakeBot(), store, queue: fakeQueue(), log, config: config() };
  // A job ahead is converting: its file and upload copy are still to come.
  const ahead = claimRoom('ahead', { dir: WORK, out: { path: path.join(WORK, 'ahead.mp4'), bytes: MAX_OUT }, upload: MAX_OUT });
  free = 3 * GB;                               // 1 GB once the job ahead has written its part; Heat needs 2.5
  fetches = 0; logs.length = 0; statfsCalls = 0;
  const { done, j } = film(ctx, { record: { ...record } });
  await tick(80);
  ok(fetches === 0 && workFiles().length === 0, 'it has not started its download');
  ok(j.stages.at(-1)?.stage === 'wait' && /^waiting for disk space — it needs 2\.50 GB, 1\.00 GB is free$/.test(j.stages.at(-1)?.text),
    `the queue shows why it waits (${j.stages.at(-1)?.text})`);
  ok(/^waiting for disk space/.test(store.data.history.find((h) => h.id === 'R1')?.detail ?? ''), 'and so does its History row');
  ok(logs.filter((l) => /waiting for disk space for Heat/.test(l)).length === 1, 'the log says so once');
  ok(statfsCalls <= 3, `and it does not spin: the disk was looked at ${statfsCalls} time(s) while it waited`);

  // The job ahead finishes and frees its files.
  free = 10 * GB;
  ahead.release();
  const err = await done;
  ok(!err && fetches === 1 && ctx.bot.sent.length === 1, 'room freed by the job ahead, it goes ahead and is posted');
  ok(logs.some((l) => /room on the disk for Heat after \d+s/.test(l)) && !heldRoom().length,
    'the log says when the wait ended, and the job holds no room once it is done');
  ok(store.data.history.find((h) => h.id === 'R1')?.status === 'sent', 'its row ends as sent');
}

console.log('=== a job ahead finishing its conversion is enough to wake it ===');
{
  const store = fakeStore();
  const record = journalled(store);
  const ctx = { bot: fakeBot(), store, queue: fakeQueue(), log, config: config() };
  const ahead = claimRoom('ahead', { dir: WORK, out: { path: path.join(WORK, 'ahead.mp4'), bytes: MAX_OUT }, upload: MAX_OUT });
  free = 3 * GB;
  fetches = 0;
  const { done } = film(ctx, { record: { ...record } });
  await tick(60);
  ok(fetches === 0, 'waiting');
  ahead.made(0.2 * GB);                        // converted small: 2.8 GB of room left for Heat's 2.5
  const err = await done;
  ok(!err && fetches === 1, 'woken by the job ahead shrinking, not by a timer');
  ahead.release();
  free = 50 * GB;
}

console.log('=== a finished film kept for its retry holds room for its upload copy ===');
{
  const store = fakeStore();
  const record = journalled(store);
  const ctx = { bot: fakeBot(), store, queue: fakeQueue(), log, config: config() };
  // The film's work holds the finished film, made in this process by the
  // attempt whose send was lost.
  const w = openWork({ workDir: WORK, key: workKey.movie('R1:tt0113277'), isSafe });
  w.record({
    item: { provider: 'jellyfin', id: itemIdOf(dlHit()), access: 'download', librarySize: 4096, total: 4096, lastModified: null, etag: null, local: null },
    output: { name: 'output.mp4', size: 3000, action: 'remux' },
  });
  fs.writeFileSync(w.outPath, Buffer.alloc(3000, 2));
  w.vouch();
  const kept = w.outPath;
  let held = null;
  ctx.bot.sendDocument = async (jid, file) => { held = heldRoom(); ctx.bot.sent.push({ file }); return {}; };
  fetches = 0;
  const err = await moviePlugin.deliver({
    msg: null, movie: HEAT, hit: dlHit(), ctx, job: job(), record: { ...record }, react: async () => {},
    jobKey: 'R1:tt0113277',
  }).then(() => null, (e) => e);
  ok(!err && fetches === 0 && ctx.bot.sent[0]?.file === kept, 'it is sent as it is, with nothing fetched');
  ok(held?.length === 1 && held[0].made && held[0].outstanding === 3000,
    'and while it uploads it holds room for the upload\'s copy, at the file\'s size - which a download started meanwhile cannot take');
  ok(!heldRoom().length && workFiles().length === 0, 'none once it is sent, and the file is gone');
}

console.log('=== a converted file that is a hard link of its download is counted once ===');
{
  free = 10 * GB;
  const src = path.join(WORK, 'linked-source.mkv');
  const out = path.join(WORK, 'linked.mp4');
  fs.writeFileSync(src, Buffer.alloc(1024 * 1024));
  fs.linkSync(src, out);
  const c = claimRoom('linked', { dir: WORK, source: { path: src, bytes: 2 * 1024 * 1024 }, out: { path: out, bytes: 2 * 1024 * 1024 }, upload: 2 * 1024 * 1024 });
  ok(roomFor(WORK, needFor()).held === 5 * 1024 * 1024,
    `plan=copy shares its source's bytes: 1 MB on the disk, not 2 (${roomFor(WORK, needFor()).held} bytes still to come)`);
  c.release();
  fs.rmSync(src); fs.rmSync(out);
  free = 50 * GB;
}

console.log('=== a finished file kept for a retry is room that comes back, not room gone for good ===');
{
  // Review scenario o-kept-blocks: Spaceballs lost its upload and kept its
  // file; Minority Report, asked for next, found "nothing else in progress
  // that will free more" and was refused for good - and seconds later
  // Spaceballs' retry posted it and the disk was empty again.
  const store = fakeStore();
  const record = journalled(store);
  const ctx = { bot: fakeBot(), store, queue: fakeQueue(), log, config: config() };
  moviePlugin._retries = new RetryBook({ delayMs: () => 5, log });
  const keptDir = path.join(WORK, 'job-spaceballs');
  fs.mkdirSync(keptDir);
  fs.writeFileSync(path.join(keptDir, 'output.mp4'), Buffer.alloc(4096, 7));
  keepRoom('S1:tt0094012', { dir: WORK, jobDir: keptDir, made: 0.5 * GB, label: 'Spaceballs' });
  free = 2.7 * GB;                               // Heat needs 2.5 GB; 2.2 once Spaceballs' upload copy is counted
  fetches = 0;
  const { done, reacts } = film(ctx, { record: { ...record } });
  const err = await done;
  ok(err?.code === 'DISK_WAIT' && isDiskFull(err) && /^not enough disk space for Heat yet: .* until 1 finished file\(s\) kept for a retry have been sent$/.test(err.message),
    `refused for now, not for good (${err?.code}: ${err?.message})`);
  const row = store.data.history.find((h) => h.id === 'R1');
  // Where it is - nothing of it done, so 🎬 - not 🔄, which a member read as
  // "send it again" (Iron Man 3, 2026-10-11).
  ok(fetches === 0 && row?.status === 'interrupted' && /^waiting for disk space/.test(row.detail) && reacts.at(-1) === '🎬'
    && !reacts.includes('⚠️') && !reacts.includes('🔄'),
    `nothing downloaded; the requester sees 🎬 and History says it waits (${row?.status}: ${row?.detail})`);
  ok(moviePlugin._retries.isWaiting('R1:tt0113277') && store.data.pending.length === 1, 'it is booked to try again, still journalled');
  await tick(60);
  ok(ctx.queue.added.length === 0, 'and waits while the kept file is still to be sent');
  // Spaceballs is posted: its work goes.
  fs.rmSync(keptDir, { recursive: true });
  forgetKept('S1:tt0094012');
  free = 10 * GB;
  await tick(60);
  ok(ctx.queue.added.length === 1 && ctx.queue.added[0].job.meta?.retry === 1, 'then goes back in the queue by itself');
  moviePlugin._retries.clear();
  free = 50 * GB;
}

console.log('=== a retry sending its kept file never waits on another kept file ===');
{
  // Two kept files that could each wait for the other's room would wait for
  // ever; a retry counts only the running jobs, and its own file is its own.
  const a = path.join(WORK, 'job-a');
  const b = path.join(WORK, 'job-b');
  fs.mkdirSync(a); fs.mkdirSync(b);
  fs.writeFileSync(path.join(a, 'output.mp4'), 'a'); fs.writeFileSync(path.join(b, 'output.mp4'), 'b');
  keepRoom('A', { dir: WORK, jobDir: a, made: 1 * GB });
  keepRoom('B', { dir: WORK, jobDir: b, made: 1 * GB });
  free = 1.6 * GB;
  const claim = await reserveRoom({ key: 'jobA', keptKey: 'A', label: 'A', workDir: WORK, made: 1 * GB, log });
  ok(claim && keptFiles().map((k) => k.key).join() === 'B', 'A goes ahead, and its file is no longer counted apart from it');
  const r = roomFor(WORK, needFor(), { withKept: true });
  ok(r.others === 1 && r.keptOthers === 1 && r.held === 2 * GB, 'new work counts A running and B kept, each for its upload copy');
  claim.release();
  fs.rmSync(b, { recursive: true });
  ok(roomFor(WORK, needFor(), { withKept: true }).keptOthers === 0 && !keptFiles().length, 'kept work that is gone counts for nothing');
  fs.rmSync(a, { recursive: true });
  free = 50 * GB;
}

console.log('=== with nothing ahead to free room, a job that cannot fit is refused with the numbers ===');
{
  const store = fakeStore();
  const record = journalled(store);
  const ctx = { bot: fakeBot(), store, queue: fakeQueue(), log, config: config() };
  moviePlugin._retries = new RetryBook({ delayMs: () => 5, log });
  free = 1 * GB;
  fetches = 0;
  const { done, reacts } = film(ctx, { record: { ...record } });
  const err = await done;
  ok(err?.code === 'DISK_TOO_SMALL' && /^not enough disk space for Heat: it needs 2\.50 GB \(a 4\.00 KB download and up to 1\.00 GB converted, then 1\.00 GB for the upload's copy, 512\.00 MB spare\) and only 1\.00 GB is free, with nothing else in progress that will free more$/.test(err.message),
    `refused at once - no waiting on nothing (${err?.message})`);
  const row = store.data.history.find((h) => h.id === 'R1');
  ok(fetches === 0 && row?.status === 'failed' && row.detail === err.message && reacts.includes('⚠️'),
    'nothing downloaded; failed, with the reason in History, and ⚠️');
  ok(!moviePlugin._retries.isWaiting('R1:tt0113277') && !store.data.pending.length, 'and not retried: waiting would not change it');
  free = 50 * GB;
}

console.log('=== the disk filling during a download (The Parent Trap): waits for room, then tries again ===');
let waitingLine = null;
{
  const store = fakeStore();
  const record = journalled(store);
  const ctx = { bot: fakeBot(), store, queue: fakeQueue(), log, config: config() };
  moviePlugin._retries = new RetryBook({ delayMs: () => 5, log });
  logs.length = 0;
  downloadFails = true;
  const { done, reacts } = film(ctx, { record });
  const err = await done;
  downloadFails = false;
  filled = false;
  ok(isDiskFull(err), `the download fails on the full disk (${err?.message})`);
  ok(record.status === 'interrupted' && /^waiting for disk space — .*ENOSPC.* \(attempt 1 of 3\)$/.test(record.detail),
    `not failed: History says it is waiting for disk space (${record.detail})`);
  ok(reacts.at(-1) === '⬇️' && !reacts.includes('⚠️') && !reacts.includes('🔄'),
    `the requester sees ⬇️, the stage it is coming back to - not ⚠️ or 🔄 (${reacts.join('')})`);
  waitingLine = logs.find((l) => /^"Heat" failed transiently \(.*ENOSPC.*\) - retrying once WhatsApp is connected and there is room on the disk \(attempt 1 of 3\), going on from what it had done$/.test(l));
  ok(!!waitingLine, 'the log says it will try again once there is room, from what it had');
  // What the stub wrote before the disk "filled" never reached the file, and
  // an empty partial is nothing to keep (download.js); the record of it is.
  const kept = openWork({ workDir: WORK, key: workKey.movie('R1:tt0113277') }).manifest;
  ok(kept.item && kept.source?.state === 'partial' && store.data.pending.length === 1,
    `its work is kept, full disk or not, and it stays journalled (${JSON.stringify(kept.source)})`);

  // The disk is still full, with a job ahead that will free some.
  const ahead = claimRoom('ahead', { dir: WORK, out: { path: path.join(WORK, 'ahead.mp4'), bytes: MAX_OUT }, upload: MAX_OUT });
  free = 3 * GB;
  await tick(60);
  ok(ctx.queue.added.length === 0 && moviePlugin._retries.isWaiting('R1:tt0113277'),
    'past its delay, the retry waits for room rather than going back in to fail again');
  free = 10 * GB;
  ahead.release();
  await tick(60);
  ok(ctx.queue.added.length === 1 && ctx.queue.added[0].job.meta?.retry === 1,
    'room freed, it goes back in the queue (attempt 1)');
  moviePlugin._retries.clear();
  free = 50 * GB;
}

console.log('=== the hourly check leaves a film waiting for room alone ===');
{
  // Its row reads "interrupted" while it waits. A restart would throw away
  // the jobs whose files are about to free the room, and do nothing for it.
  const NOW = Date.now();
  const iso = (ts) => new Date(ts).toISOString();
  const L = (ts, level, scope, msg) => `${iso(ts)} [${level.toUpperCase().padEnd(5)}] (${scope}) ${msg}`;
  const lines = parseLog([L(NOW - 3600_000, 'info', 'main', 'debug log -> /d'), L(NOW - 60_000, 'warn', 'movie-requests', waitingLine ?? '')].join('\n'));
  const row = { id: 'R1', at: NOW - 120_000, status: 'interrupted', title: 'Heat', year: 1995, request: 'heat 1995', requester: 'Mia',
    groupJid: 'req@g.us', detail: 'waiting for disk space — ENOSPC: no space left on device, write (attempt 1 of 3)' };
  const r = scan({
    now: NOW, config: { movieRequests: { requestGroups: ['req@g.us'] } }, lines, unit: { ActiveState: 'active', NRestarts: '0' },
    state: { 'movie-requests': { history: [row], pending: [{ jobKey: 'R1:tt0113277', msgId: 'R1' }] }, 'tv-requests': { history: [], pending: [] } },
  });
  ok(!r.incidents.some((f) => f.request?.id === 'R1') && !r.restart.advised, 'no finding, and no restart');
}

console.log('=== ffmpeg exiting 228 (Charlie and the Chocolate Factory) is retried, not failed ===');
{
  const store = fakeStore();
  const record = journalled(store);
  const ctx = { bot: fakeBot(), store, queue: fakeQueue(), log, config: config() };
  moviePlugin._retries = new RetryBook({ delayMs: () => 60_000, log });
  fs.writeFileSync(FULL, '');
  const { done, reacts } = film(ctx, { record });
  const err = await done;
  fs.rmSync(FULL);
  fs.rmSync(`${FULL}.hit`, { force: true });
  ok(/^ffmpeg exited 228/.test(err?.message ?? '') && record.status === 'interrupted' && /^waiting for disk space/.test(record.detail),
    'the encode that died on the full disk waits for room and tries again');
  ok(moviePlugin._retries.isWaiting('R1:tt0113277') && !reacts.includes('⚠️') && workFiles().some((f) => /\/source\.mkv$/.test(f)),
    `booked, no ⚠️, and its download kept for the retry, full disk or not (${workFiles().join(', ')})`);
  moviePlugin._retries.clear();
  clearWork();
}

console.log('=== an upload whose copy the full disk cut short (Minority Report) is retried ===');
{
  const store = fakeStore();
  const record = journalled(store);
  const ctx = { bot: fakeBot(), store, queue: fakeQueue(), log, config: config() };
  ctx.bot.sendDocument = async () => {
    throw Object.assign(new Error('the disk filled while Heat (1995).mp4 was uploading, cutting its upload copy short (Media upload failed on all hosts)'), { code: 'ENOSPC' });
  };
  moviePlugin._retries = new RetryBook({ delayMs: () => 60_000, log });
  const { done } = film(ctx, { record });
  await done;
  ok(record.status === 'interrupted' && /^waiting for disk space — the disk filled while/.test(record.detail)
    && moviePlugin._retries.isWaiting('R1:tt0113277'), 'waiting for room, and booked to try again');
  moviePlugin._retries.clear();
  clearWork();
}

console.log('=== a TV episode the disk filled under waits and tries again ===');
{
  const store = fakeStore();
  const reqKey = 'tv-A1-1';
  const ep = { id: 'op-12-27', series: 'One Piece', season: 12, episode: 27, title: 'S12E27', size: 4096 };
  store.set('history', [{ id: 'A1', kind: 'tv', status: 'queued', detail: 'One Piece S12E27' }]);
  store.set('pending', [{ reqKey, label: 'One Piece S12E27', baseRow: { id: 'A1' }, episodes: [ep] }]);
  const ctx = { bot: fakeBot(), store, queue: fakeQueue(), log, config: config() };
  tvPlugin._retries = new RetryBook({ delayMs: () => 5, log });
  const told = [];
  const notifier = { stage() {}, episodeDone: () => told.push('done'), episodeFailed: () => told.push('failed'), episodeCancelled: () => told.push('cancelled') };
  const reacts = [];
  const ahead = claimRoom('ahead', { dir: WORK, out: { path: path.join(WORK, 'ahead.mp4'), bytes: MAX_OUT }, upload: MAX_OUT });
  downloadFails = true;
  let err = null;
  try {
    await tvPlugin.deliverEpisode({ ep, ctx, job: job(), msg: null, react: async (e) => { reacts.push(e); }, notifier, reqKey, isLast: true, index: 0, total: 1 });
  } catch (e) { err = e; }
  downloadFails = false;
  filled = false;
  free = 3 * GB;
  ok(isDiskFull(err) && !told.length && reacts.at(-1) === '⬇️' && !reacts.includes('🔄'),
    `not failed: the request is told nothing yet, and the requester sees ⬇️, its stage (${reacts.join('')})`);
  ok(/^S12E27 is waiting for disk space|One Piece S12E27 is waiting for disk space/.test(store.data.history[0].detail ?? '')
    && store.data.history[0].status === 'queued', `the request's History row says why it has stopped (${store.data.history[0].detail})`);
  ok(store.data.pending[0]?.episodes?.length === 1, 'the episode stays journalled');
  await tick(60);
  ok(ctx.queue.added.length === 0 && tvPlugin._retries.isWaiting(`${reqKey}:${ep.id}`), 'it waits for room');
  free = 10 * GB;
  ahead.release();
  await tick(60);
  ok(ctx.queue.added.length === 1 && ctx.queue.added[0].job.meta?.retry === 1, 'and goes back in the queue once there is some');
  tvPlugin._retries.clear();
  free = 50 * GB;
}

console.log('=== a TV episode the disk filled under at its upload waits and tries again, as a film does ===');
{
  // broadcastFile kept only each failure's message, and the episode threw a
  // new, code-less "could not post to any group: ...": the upload's ENOSPC -
  // its pre-flight refusal, or a copy the full disk cut short - was lost on
  // the way, and every such episode got ⚠️ and History "failed" (the
  // Minority Report failure of 21:07 UTC on 2026-09-28, for TV).
  const cases = [
    ['the pre-flight refusal', 'not enough disk space to upload One Piece S01E01 Ep 1.mp4: 764 MB needed in /tmp, 50 MB free'],
    ['a copy the disk cut short', 'the disk filled while One Piece S01E01 Ep 1.mp4 was uploading, cutting its upload copy short (Media upload failed on all hosts)'],
  ];
  for (const [what, message] of cases) {
    const store = fakeStore();
    const reqKey = 'tv-B1-1';
    const ep = { id: 'op-1-1', series: 'One Piece', season: 1, episode: 1, title: 'S01E01', size: 4096 };
    store.set('history', [{ id: 'B1', kind: 'tv', status: 'queued', detail: 'One Piece S01E01' }]);
    store.set('pending', [{ reqKey, label: 'One Piece S01E01', baseRow: { id: 'B1' }, episodes: [ep] }]);
    const ctx = { bot: fakeBot(), store, queue: fakeQueue(), log, config: config() };
    ctx.bot.sendDocument = async () => { throw Object.assign(new Error(message), { code: 'ENOSPC' }); };
    tvPlugin._retries = new RetryBook({ delayMs: () => 60_000, log });
    const told = [];
    const notifier = { stage() {}, episodeDone: () => told.push('done'), episodeFailed: (m) => told.push(`failed: ${m}`), episodeCancelled: () => told.push('cancelled') };
    const reacts = [];
    let err = null;
    try {
      await tvPlugin.deliverEpisode({ ep, ctx, job: job(), msg: null, react: async (e) => { reacts.push(e); }, notifier, reqKey, isLast: true, index: 0, total: 1 });
    } catch (e) { err = e; }
    ok(err?.code === 'ENOSPC' && /^could not post to any group: /.test(err.message),
      `${what}: the episode's error keeps the upload's code (${err?.code}: ${err?.message})`);
    ok(!told.length && reacts.at(-1) === '⬆️' && !reacts.includes('⚠️') && !reacts.includes('🔄'),
      `${what}: not failed - the request is told nothing yet, and the requester sees ⬆️, its stage (${reacts.join('')}; ${told.join()})`);
    ok(tvPlugin._retries.isWaiting(`${reqKey}:${ep.id}`) && store.data.pending[0]?.episodes?.length === 1,
      `${what}: it waits for room to try again, still journalled`);
    tvPlugin._retries.clear();
    clearWork();
  }
}

console.log('=== a TV episode out of retries for want of room keeps its work for the next start ===');
{
  // Giving up on it deleted its download and its finished file, and nothing
  // is deleted before an episode is sent now (the operator, 2026-09-30:
  // "files should remain in their folders until fully sent on whatsapp").
  const store = fakeStore();
  const reqKey = 'tv-C1-1';
  const ep = { id: 'op-2-2', series: 'One Piece', season: 2, episode: 2, title: 'S02E02', size: 4096 };
  store.set('history', [{ id: 'C1', kind: 'tv', status: 'queued', detail: 'One Piece S02E02' }]);
  store.set('pending', [{ reqKey, label: 'One Piece S02E02', baseRow: { id: 'C1' }, episodes: [ep] }]);
  const ctx = { bot: fakeBot(), store, queue: fakeQueue(), log, config: config() };
  ctx.bot.sendDocument = async () => { throw Object.assign(new Error('not enough disk space to upload it: 764 MB needed in /tmp, 50 MB free'), { code: 'ENOSPC' }); };
  // No attempts left in this process.
  tvPlugin._retries = new RetryBook({ max: 0, delayMs: () => 60_000, log });
  const told = [];
  const notifier = { stage() {}, episodeDone: () => told.push('done'), episodeFailed: () => told.push('failed'), episodeCancelled: () => told.push('cancelled') };
  logs.length = 0;
  const err = await tvPlugin.deliverEpisode({ ep, ctx, job: job(), msg: null, react: async () => {}, notifier, reqKey, isLast: true, index: 0, total: 1 })
    .then(() => null, (e) => e);
  ok(isDiskFull(err) && !told.length && store.data.pending[0]?.episodes?.length === 1, 'not failed, and still journalled');
  ok(workFiles().some((f) => /\/source\.mkv$/.test(f)) && workFiles().some((f) => /\/output\.mp4$/.test(f)),
    `its download and its finished episode are kept (${workFiles().join(', ')})`);
  ok(logs.some((l) => /^TV: One Piece S02E02.* will retry on next start, going on from what it had done$/.test(l)), 'and the log says the next start goes on from them');
  tvPlugin._retries.clear();
  clearWork();
}

console.log('=== a job waiting for room can still be cancelled, and holds nothing ===');
{
  const ahead = claimRoom('ahead', { dir: WORK, out: { path: null, bytes: MAX_OUT }, upload: MAX_OUT });
  free = 3 * GB;
  const ac = new AbortController();
  const waiting = reserveRoom({ key: 'w', label: 'Heat', workDir: WORK, sourceBytes: 4096, maxOutputBytes: MAX_OUT, signal: ac.signal, log })
    .then(() => null, (e) => e);
  await tick(30);
  ok(heldRoom().map((c) => c.key).join() === 'ahead', 'while it waits it holds no room, so nothing can end up waiting on it');
  ac.abort();
  const err = await waiting;
  ok(err?.code === 'CANCELLED', 'a cancel ends the wait as a cancel');
  ahead.release();
  free = 1 * GB;
  const r = await waitForRoom({ dir: WORK, need: needFor(), label: 'Heat', log });
  ok(r.fits === false && r.waited === false && r.others === 0,
    'with nothing ahead, the answer is at once: there is nothing to wait for');
  free = 50 * GB;
  const roomy = await waitForRoom({ dir: WORK, need: needFor(), label: 'Heat', log });
  ok(roomy.fits && !roomy.waited, 'and at once when it fits');
}

console.log('=== no job\'s files are deleted to make room; new downloads wait instead ===');
{
  // The operator, 2026-09-30, after the restart that brought in per-job work
  // directories deleted three fully converted films (La La Land had finished
  // encoding and was uploading; after the restart it began again from the
  // download): "in the future files should remain in their folders until
  // fully sent on whatsapp to avoid this". A film parked for the next start
  // used to be given up - download, finished file and all - for a new job
  // that could not fit beside it (disk-space.js, until then), and a lost send
  // on a nearly full disk reset its own work. Now the new job does not
  // start its download, the operator is told, and it waits for the kept
  // film to be sent.
  clearWork();
  // In the library, for its retry to find again.
  fs.writeFileSync(path.join(LIB, 'Spaceballs 1987.mp4'), Buffer.alloc(4096, 5));
  const store = fakeStore();
  const heat = { id: 'K1', request: 'heat', status: 'queued', title: 'Heat', year: 1995, rated: 'R' };
  const SPACEBALLS = { title: 'Spaceballs', year: 1987, imdbId: 'tt0094012', rated: 'PG' };
  const balls = { id: 'K2', request: 'spaceballs', status: 'queued', title: 'Spaceballs', year: 1987, rated: 'PG' };
  store.set('history', [{ ...heat }, { ...balls }]);
  store.set('pending', [
    { jobKey: 'K1:tt0113277', msgId: 'K1', msgKey: null, chatJid: 'req@g.us', movie: HEAT, meta: {}, record: heat, at: Date.now() },
    { jobKey: 'K2:tt0094012', msgId: 'K2', msgKey: null, chatJid: 'req@g.us', movie: SPACEBALLS, meta: {}, record: balls, at: Date.now() },
  ]);
  const ctx = { bot: fakeBot(), store, queue: fakeQueue(), log, config: config() };
  moviePlugin._retries = new RetryBook({ delayMs: () => 5, log });

  // Heat is made, and its send is lost; its retries spent, it is parked for
  // the next start with its download and its finished file.
  let lose = true;
  const send = ctx.bot.sendDocument;
  const atSend = [];
  ctx.bot.sendDocument = async (jid, file) => {
    atSend.push(workFiles());
    if (lose) throw new Error('Connection Closed');
    return send(jid, file);
  };
  await film(ctx, { record: { ...heat }, id: 'K1' }).done;
  moviePlugin._retries.forget('K1:tt0113277');
  moviePlugin._park(ctx, 'K1:tt0113277');
  const heatFiles = workFiles();
  ok(heatFiles.some((f) => /\/source\.mkv$/.test(f)) && heatFiles.some((f) => /\/output\.mp4$/.test(f)),
    `Heat is parked with its download and its finished film (${heatFiles.join(', ')})`);

  // The disk: room for Spaceballs only once Heat's files have gone.
  const needBalls = jobNeed({ workDir: WORK, kind: 'movie', sourceBytes: 4096, maxOutputBytes: MAX_OUT });
  const DISK = needBalls.total + 1024;
  const before = fs.statfsSync;
  // To the byte, not the block: Heat's files are a few kilobytes.
  fs.statfsSync = (q, ...rest) => ({ ...realStatfs(q, ...rest), bavail: (DISK - dirBytes(WORK)) / 4096, bsize: 4096 });
  logs.length = 0;
  fetches = 0;
  const reacts = [];
  const err = await moviePlugin.deliver({
    msg: null, movie: SPACEBALLS, hit: { ...dlHit(), downloadUrl: 'http://jf.test/spaceballs' }, ctx, job: job(), record: balls,
    react: async (e) => { reacts.push(e); }, jobKey: 'K2:tt0094012',
  }).then(() => null, (e) => e);
  ok(err?.code === 'DISK_HELD' && fetches === 0, `Spaceballs does not start its download (${err?.code}, ${fetches} fetches)`);
  ok(JSON.stringify(workFiles().filter((f) => heatFiles.includes(f))) === JSON.stringify(heatFiles),
    'and not one of Heat\'s files is deleted to make room for it');
  ok(logs.some((l) => /^Spaceballs: not enough disk space for Spaceballs yet: .*held by the work of 1 other job\(s\), kept until each is sent - it waits, and nothing is deleted to make room$/.test(l)),
    'the operator is told, in a line the hourly check reports as the disk filling up');
  ok(balls.status === 'interrupted' && /^waiting for disk space — not enough disk space/.test(balls.detail) && reacts.at(-1) === '🎬'
    && !reacts.includes('⚠️') && !reacts.includes('🔄'),
    `Spaceballs is waiting, not failed (${balls.detail})`);
  await tick(60);
  ok(moviePlugin._retries.isWaiting('K2:tt0094012') && ctx.queue.added.length === 0,
    'past its delay it still waits: nothing runs it while Heat holds the room');

  // Heat is sent - by the next start, or an operator's retry - and only then
  // does its directory go, and Spaceballs with it back into the queue.
  lose = false;
  await film(ctx, { record: { ...heat }, id: 'K1' }).done;
  ok(ctx.bot.sent.length === 1 && atSend.at(-1).some((f) => /\/source\.mkv$/.test(f)),
    'Heat is sent, its download still beside it as it uploads');
  ok(!workFiles().some((f) => heatFiles.includes(f)), 'and then its directory goes');
  await tick(60);
  ok(ctx.queue.added.length === 1 && ctx.queue.added[0].job.meta?.jobKey === 'K2:tt0094012',
    'with the room back, Spaceballs goes back in the queue to download');
  fs.statfsSync = before;
  moviePlugin._retries.clear();
  moviePlugin._parked = null;
  clearWork();
}

fs.statfsSync = realStatfs;
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
