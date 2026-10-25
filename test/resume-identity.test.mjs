/* Kept work is built on only while the library still holds the file it was made from.
   Run: node test/resume-identity.test.mjs

   Since The Parent Trap (2026-09-29: downloaded, 23 minutes into its
   encode, and started over from the first byte by a restart, twice) a job
   keeps what it has done across restarts (media/work-files.js). Kept work
   can be hours or days old by the time it is resumed, and a library file
   can be replaced in that time - a better copy, a fixed rip - or the
   library can answer a request with another item than before. Finishing a
   film from the old file would post something other than what the library
   now holds. So a resumed job first asks the library about its file - one
   byte of it, whose answer carries its length and Last-Modified (Jellyfin
   sends no ETag) - or, for a file read in place, looks at it on the disk,
   and starts again when anything differs. An unanswered question is not a
   yes or a no: the job waits, with its files, and asks again. */
import './fixtures/roomy-disk.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import { RetryBook, finishedOutput, isTransient } from '../src/media/resume.js';
import {
  openWork, workKey, isSafeToDeleteIn, forgetThisProcess, verifyIdentity, probeDownload, statOf,
} from '../src/media/work-files.js';
import { makeKit } from './fixtures/restart-kit.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const kit = await makeKit('resume-identity', { filmBytes: 256 * 1024 });
const { WORK, LIB, server } = kit;
const isSafe = (p) => isSafeToDeleteIn(p, { workDir: WORK, roots: [LIB] });
const config = mergeDefaults({
  movieRequests: { postsGroup: 'posts@g.us', notify: {}, blockedRatings: [], reactions: { redo: '🔄', failed: '⚠️', done: '✅' } },
  library: { provider: 'local', local: { roots: [LIB], extensions: ['.mkv'] } },
  media: { workDir: WORK, ffprobePath: kit.FFPROBE, ffmpegPath: kit.FFMPEG, deleteAfterSend: true },
}, DEFAULT_CONFIG);
const logs = [];
const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), debug() {} };
const MOVIE = { title: 'The Parent Trap', year: 1998, imdbId: 'tt0120783', rated: 'PG' };
const OLD = Buffer.from('the film made from the file the library used to have');

const copy = (id) => ({
  id, provider: 'jellyfin', access: 'download', container: 'mkv', size: server.body.length,
  downloadUrl: `${kit.base}/Items/${id}/Download`, downloadHeaders: { 'X-Emby-Token': 'TOK' },
});
let n = 0;
function film() {
  n += 1;
  const jobKey = `ID${n}:tt0120783`;
  const record = { id: `ID${n}`, request: 'the parent trap', status: 'queued', title: MOVIE.title, year: MOVIE.year };
  const store = { data: {}, get(k, d = null) { return k in this.data ? this.data[k] : d; }, set(k, v) { this.data[k] = v; }, push(k, v) { (this.data[k] ??= []).unshift(v); } };
  store.set('pending', [{ jobKey, msgId: `ID${n}`, msgKey: null, chatJid: 'req@g.us', movie: MOVIE, meta: {}, record, at: Date.now() }]);
  store.set('history', [{ ...record }]);
  const bot = {
    sent: [], isConnected: () => true, react: async () => true, sendText: async () => ({}), groups: () => [],
    groupMemberInfo: () => ({ isMember: false }), on() {}, off() {},
    sendDocument: async (jid, file) => { bot.sent.push(fs.readFileSync(file)); return {}; },
  };
  const ctx = { bot, store, log, config, queue: { pending: [], active: new Map(), on() {}, off() {}, add() { return 'q'; } } };
  const work = openWork({ workDir: WORK, key: workKey.movie(jobKey), isSafe });
  return { jobKey, record, ctx, work };
}
/** Kept work, as a process before the restart left it: the film made from `id`'s file, as it was then. */
function keptFrom(f, id, { total = server.body.length, lastModified = server.lastModified } = {}) {
  f.work.record({
    item: { provider: 'jellyfin', id, access: 'download', librarySize: server.body.length, total, lastModified, etag: null, local: null },
    source: { name: 'source.mkv', state: 'dropped', bytes: total },
    output: { name: 'output.mp4', size: OLD.length, action: 'remux' },
  });
  fs.writeFileSync(f.work.outPath, OLD);
}
async function run(f, hit) {
  forgetThisProcess();                                  // the restart
  moviePlugin._retries = new RetryBook({ delayMs: () => 3_600_000, log });
  const err = await moviePlugin.deliver({
    msg: null, movie: MOVIE, hit, ctx: f.ctx, job: { id: `j${n}`, signal: new AbortController().signal, progress() {}, isCancelled: () => false, cancelReason: () => null },
    record: { ...f.record }, react: async () => {}, jobKey: f.jobKey,
  }).then(() => null, (e) => e);
  return err;
}
const sentOld = (f) => f.ctx.bot.sent.some((b) => Buffer.compare(b, OLD) === 0);
const sentNew = (f) => f.ctx.bot.sent.some((b) => Buffer.compare(b, server.body) === 0);

console.log('=== the library is asked, and answers, about one byte ===');
{
  server.requests.length = 0;
  const p = await probeDownload(`${kit.base}/Items/pt/Download`, { headers: { 'X-Emby-Token': 'TOK' } });
  ok(p.ok && p.total === server.body.length && p.lastModified === server.lastModified && p.etag === null && p.ranges,
    'its length from Content-Range, its Last-Modified, and no ETag - as Jellyfin answers');
  ok(server.requests.length === 1 && server.requests[0].range === 'bytes=0-0', 'with a request for its first byte');
  server.ranges = false;
  const whole = await probeDownload(`${kit.base}/Items/pt/Download`);
  server.ranges = true;
  ok(whole.ok && whole.total === server.body.length && !whole.ranges, 'a server that sends the whole file is read by its Content-Length, and cut off');
  server.missing.add('/Items/gone/Download');
  const gone = await probeDownload(`${kit.base}/Items/gone/Download`);
  ok(!gone.ok && gone.status === 404, 'a 404 is an answer: not there');
  let err = null;
  try { await probeDownload('http://127.0.0.1:9/Items/pt/Download'); } catch (e) { err = e; }
  ok(err && isTransient(err) && /could not reach the library/.test(err.message), `no answer throws, as a transient failure (${err?.message})`);
}

console.log('=== kept files are never used for a different library item ===');
{
  const f = film();
  keptFrom(f, 'pt-old');
  server.requests.length = 0;
  const err = await run(f, copy('pt-new'));
  ok(!err && sentNew(f) && !sentOld(f), 'the library now answers with another item: its file is fetched and posted, not the kept film');
  ok(logs.some((l) => /"The Parent Trap": the library's file changed since it was downloaded \(the library no longer lists the copy it came from\) - fetching it again/.test(l)),
    'and the log says why');
  ok(kit.downloads().length === 1 && kit.downloads()[0].url === '/Items/pt-new/Download', 'the one download is the new item\'s');
  const m = { item: { id: 'a', access: 'download', total: 1 } };
  ok(!(await verifyIdentity(m, { id: 'b', access: 'download' }, { probe: async () => ({ ok: true, total: 1 }) })).ok,
    'verifyIdentity: another id is never the same file');
  ok(!(await verifyIdentity(m, { id: 'a', access: 'local', localPath: '/x' })).ok, 'nor is the same id read another way');
}

console.log('=== kept files from before the library\'s file changed are thrown away ===');
{
  const bySize = film();
  keptFrom(bySize, 'pt-1', { total: server.body.length + 4096 });
  let err = await run(bySize, copy('pt-1'));
  ok(!err && sentNew(bySize) && !sentOld(bySize), 'a file of another length: fetched again');
  ok(logs.some((l) => /changed since it was downloaded \(the library's file was 260\.00 KB and is now 256\.00 KB\)/.test(l)), 'saying which length it was and is');

  const byDate = film();
  keptFrom(byDate, 'pt-1', { lastModified: 'Mon, 01 Sep 2025 00:00:00 GMT' });
  err = await run(byDate, copy('pt-1'));
  ok(!err && sentNew(byDate) && !sentOld(byDate), 'a file modified since (Last-Modified): fetched again');

  const same = film();
  keptFrom(same, 'pt-1');
  server.requests.length = 0;
  err = await run(same, copy('pt-1'));
  ok(!err && sentOld(same) && kit.downloads().length === 0 && kit.probes().length === 1,
    'the same file - same item, length and date - is built on, after one probe');

  // A film read in place from the library: what it is on the disk.
  const libFilm = path.join(LIB, 'The Parent Trap 1998.mkv');
  fs.writeFileSync(libFilm, server.body);
  const local = { id: libFilm, provider: 'local', access: 'local', localPath: libFilm, size: server.body.length };
  const was = { item: { id: libFilm, access: 'local', local: statOf(libFilm) } };
  ok((await verifyIdentity(was, { id: libFilm, access: 'local', localPath: libFilm })).ok, 'a library file untouched is the same file');
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(libFilm, later, later);
  ok(!(await verifyIdentity(was, { id: libFilm, access: 'local', localPath: libFilm })).ok, 'one modified since is not');
  const inPlace = film();
  inPlace.work.record({ item: was.item, output: { name: 'output.mp4', size: OLD.length, action: 'remux' } });
  fs.writeFileSync(inPlace.work.outPath, OLD);
  err = await run(inPlace, local);
  ok(!err && sentNew(inPlace) && !sentOld(inPlace) && fs.existsSync(libFilm), 'and is converted again from the library, which is never touched');
  fs.rmSync(libFilm);
}

console.log('=== an unanswered identity check waits as a transient failure and keeps the files ===');
{
  const f = film();
  const dead = { ...copy('pt-1'), downloadUrl: 'http://127.0.0.1:9/Items/pt-1/Download' };
  keptFrom(f, 'pt-1');
  const err = await run(f, dead);
  ok(err && isTransient(err) && /could not reach the library to check the kept files/.test(err.message), `it fails transiently (${err?.message})`);
  ok(moviePlugin._retries.isWaiting(f.jobKey) && f.ctx.store.get('pending').length === 1, 'it is booked to try again, still journalled');
  ok(finishedOutput(openWork({ workDir: WORK, key: workKey.movie(f.jobKey), isSafe }))?.size === OLD.length,
    'and its finished film is still there for when the library answers');
  moviePlugin._retries.clear();
}

console.log('=== the copy that was downloaded is the one resumed, even when the library lists another first ===');
{
  // A library listing the same film twice (movie-requests: "try each copy
  // in turn"), whose order changed between the two processes.
  const f = film();
  f.work.record({
    item: { provider: 'jellyfin', id: 'pt-second', access: 'download', librarySize: server.body.length, total: server.body.length, lastModified: server.lastModified, etag: null, local: null },
  });
  fs.writeFileSync(f.work.path('source.mkv'), server.body);
  f.work.record({ source: { name: 'source.mkv', state: 'complete', bytes: server.body.length } });
  server.requests.length = 0;
  const err = await run(f, { ...copy('pt-first'), alternates: [copy('pt-second')] });
  ok(!err && sentNew(f), 'it is converted and posted');
  ok(kit.downloads().length === 0 && kit.probes().length === 1 && kit.probes()[0].url === '/Items/pt-second/Download',
    `the library is asked about the copy it downloaded, and nothing is downloaded (${server.requests.map((r) => r.url).join(', ')})`);
}

kit.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
