/* A job's files stay in its directory until WhatsApp has taken the file.
   Run: node test/files-kept-until-sent.test.mjs

   The operator, 2026-09-30. The restart that brought in per-job work
   directories deleted three fully converted films the older build had made
   - La La Land had finished encoding and its upload was still running;
   after the restart it began again from the download: "in the future files
   should remain in their folders until fully sent on whatsapp to avoid
   this". The downloaded original used to be deleted the moment the file to
   send was made (the owner's rule of 2026-09-28, for a disk that kept
   filling), so anything that went wrong after that - a lost upload, a join
   that failed - had only a download to start again from. Now the download
   stays beside the file until the send has resolved, and the job's whole
   directory goes then. A film read in place from the library has no
   download, and its library file is never touched (CLAUDE.md rule 5).

   A stub ffprobe describes each file; a stub ffmpeg "remuxes" by copying,
   and plan=copy hard-links the made file to the original, as ffmpeg.js does.
   What the tests look at is the disk at the moment the upload starts - every
   file under the work directory, each job keeping its own in a directory
   of its own (media/work-files.js). */
import './fixtures/roomy-disk.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import tvPlugin from '../src/plugins/tv-requests/index.js';
import { RetryBook, finishedOutput } from '../src/media/resume.js';
import { openWork, workKey, isSafeToDeleteIn } from '../src/media/work-files.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-original-'));
const LIB = path.join(TMP, 'lib');
const WORK = path.join(TMP, 'work');
fs.mkdirSync(LIB); fs.mkdirSync(WORK);
const LIB_FILM = path.join(LIB, 'Heat 1995.mp4');
fs.writeFileSync(LIB_FILM, Buffer.alloc(4096, 3));

// The container the stub ffprobe reports: an mp4 is sent as it is (a hard
// link), a matroska file is remuxed into a new one.
const CONTAINER = path.join(TMP, 'container');
const FFPROBE = path.join(TMP, 'ffprobe');
fs.writeFileSync(FFPROBE, `#!/bin/sh
c=$(cat '${CONTAINER}')
cat <<JSON
{"streams":[{"codec_type":"video","codec_name":"h264","width":1280,"height":720},{"codec_type":"audio","codec_name":"aac","channels":2}],"format":{"format_name":"$c","duration":"60","size":"4096"}}
JSON
`, { mode: 0o755 });
const FFMPEG = path.join(TMP, 'ffmpeg');
fs.writeFileSync(FFMPEG, `#!/bin/sh
prev=""; in=""; out=""
for a in "$@"; do
  [ "$prev" = "-i" ] && in="$a"
  [ "$a" = "-progress" ] && out="$prev"
  prev="$a"
done
head -c 2048 "$in" > "$out"
`, { mode: 0o755 });
const container = (c) => fs.writeFileSync(CONTAINER, c);

const config = (media = {}) => withJellyfin(mergeDefaults({
  movieRequests: { postsGroup: 'posts@g.us', notify: {}, blockedRatings: [], reactions: {} },
  library: { provider: 'local', local: { roots: [LIB], extensions: ['.mp4'] } },
  media: { workDir: WORK, ffprobePath: FFPROBE, ffmpegPath: FFMPEG, deleteAfterSend: true, ...media },
  tvRequests: { postsGroups: ['tvposts@g.us'] },
  whatsapp: { broadcastPacingMs: 0 },
}, DEFAULT_CONFIG));
function withJellyfin(c) { c.library.jellyfin = { baseUrl: 'http://jf.test', accessToken: 'TOK' }; return c; }

const logs = [];
const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), debug() {} };

/** Every file under `dir` bar the jobs' manifests, as paths inside the work directory. */
const listWork = (dir = WORK) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return listWork(p);
  return e.name === 'manifest.json' ? [] : [path.relative(WORK, p)];
});
const clearWork = () => { for (const f of fs.readdirSync(WORK)) fs.rmSync(path.join(WORK, f), { recursive: true, force: true }); };

/** WhatsApp, noting what is in the work directory as each upload starts. */
function fakeBot() {
  const bot = {
    sent: [],
    isConnected: () => true, react: async () => true, sendText: async () => ({}),
    groups: () => [], groupMemberInfo: () => ({ isMember: false }), on() {}, off() {},
    sendDocument: async (jid, file) => {
      bot.sent.push({ file, size: fs.statSync(file).size, work: listWork(), libIntact: fs.existsSync(LIB_FILM) });
      return {};
    },
  };
  return bot;
}
function fakeStore(data = {}) {
  return { get: (k, d = null) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; }, push: (k, v) => { (data[k] ??= []).unshift(v); }, data };
}
const job = () => ({ id: `j${Math.random().toString(16).slice(2, 8)}`, signal: new AbortController().signal,
  progress() {}, isCancelled: () => false, cancelReason: () => null });
const sources = (names) => names.filter((n) => /(^|\/)source\./.test(n));

globalThis.fetch = async () => new Response(Buffer.alloc(4096, 1), { status: 200, headers: { 'content-length': '4096' } });

async function film({ media = {}, hit }) {
  const ctx = { bot: fakeBot(), store: fakeStore(), queue: { on() {}, off() {} }, log, config: config(media) };
  const record = { id: 'R1', request: 'heat', status: 'queued', title: 'Heat', year: 1995, rated: 'R' };
  await moviePlugin.deliver({
    msg: null, movie: { title: 'Heat', year: 1995, rated: 'R' }, hit, ctx, job: job(), record,
    react: async () => {}, jobKey: 'R1:tt0113277',
  });
  return ctx;
}
const downloadHit = (c) => ({ access: 'http', provider: 'jellyfin', downloadUrl: 'http://jf.test/heat', container: c, size: 4096 });

console.log('=== a film: the original stays beside the converted file until it is sent ===');
{
  container('matroska,webm');
  logs.length = 0;
  const ctx = await film({ hit: downloadHit('mkv') });
  const at = ctx.bot.sent[0];
  ok(at && at.size === 2048, `the converted film is sent (${at?.size} bytes)`);
  ok(at && sources(at.work).length === 1 && at.work.some((f) => /\/output\.mp4$/.test(f)),
    `and the 4 KB original was still beside it as its upload started (${at?.work.join(', ')})`);
  ok(!logs.some((l) => /removed the original/.test(l)), 'nothing says the original was removed');
  ok(fs.readdirSync(WORK).length === 0, 'once it is posted its whole directory goes');
}

console.log('=== a film sent as it is: the original and the file sent are both there ===');
{
  container('mov,mp4,m4a,3gp,3g2,mj2');
  const ctx = await film({ hit: downloadHit('mp4') });
  const at = ctx.bot.sent[0];
  ok(at && at.size === 4096 && sources(at.work).length === 1,
    'the original keeps its name, and the file sent - a hard link of it - is whole');
  ok(fs.readdirSync(WORK).length === 0, 'and both go once it is posted');
}

console.log('=== a film read from the library in place: the library file is never touched ===');
{
  container('mov,mp4,m4a,3gp,3g2,mj2');
  const ctx = await film({ hit: { access: 'local', provider: 'local', localPath: LIB_FILM, size: 4096 } });
  ok(ctx.bot.sent[0]?.libIntact && fs.existsSync(LIB_FILM) && fs.statSync(LIB_FILM).size === 4096,
    'the library original is still there, whole, during the upload and after it');
}

console.log('=== an operator who keeps the local copy keeps the original too ===');
{
  container('matroska,webm');
  const ctx = await film({ media: { deleteAfterSend: false }, hit: downloadHit('mkv') });
  ok(sources(ctx.bot.sent[0]?.work ?? []).length === 1 && sources(listWork()).length === 1,
    'with "Delete the local copy once it\'s sent" off, the original stays after the send too');
  clearWork();
}

console.log('=== a TV episode: the same ===');
{
  container('matroska,webm');
  logs.length = 0;
  const ctx = { bot: fakeBot(), store: fakeStore(), queue: { on() {}, off() {} }, log, config: config() };
  const ep = { id: 'op-12-27', series: 'One Piece', season: 12, episode: 27, title: 'S12E27', size: 4096 };
  const done = [];
  const notifier = { stage() {}, episodeDone: () => done.push('done'), episodeFailed() {}, episodeCancelled() {} };
  await tvPlugin.deliverEpisode({ ep, ctx, job: job(), msg: null, react: async () => {}, notifier, reqKey: null, isLast: true, index: 0, total: 1 });
  const at = ctx.bot.sent[0];
  ok(at && at.size === 2048 && sources(at.work).length === 1, `the episode's original was still there as its upload started (${at?.work.join(', ')})`);
  ok(done.join() === 'done' && fs.readdirSync(WORK).length === 0, 'it is posted, and nothing is left behind');
}

console.log('=== a lost send keeps the original and the file; the retry sends the file, and fetches again only when both are gone ===');
{
  container('matroska,webm');
  let fetches = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...a) => { fetches += 1; return realFetch(...a); };
  moviePlugin._retries = new RetryBook({ delayMs: () => 60_000, log });
  const store = fakeStore();
  const record = { id: 'R2', request: 'heat', status: 'queued', title: 'Heat', year: 1995, rated: 'R' };
  store.set('pending', [{ jobKey: 'R2:tt0113277', msgId: 'R2', msgKey: null, chatJid: 'req@g.us',
    movie: { title: 'Heat', year: 1995, imdbId: 'tt0113277', rated: 'R' }, meta: {}, record, at: Date.now() }]);
  const bot = fakeBot();
  let lose = 1;
  const send = bot.sendDocument;
  bot.sendDocument = async (jid, file) => {
    await send(jid, file);
    if (lose > 0) { lose -= 1; throw new Error('Connection Closed'); }
    return {};
  };
  const ctx = { bot, store, queue: { on() {}, off() {} }, log, config: config() };
  const run = () => moviePlugin.deliver({
    msg: null, movie: { title: 'Heat', year: 1995, imdbId: 'tt0113277', rated: 'R' }, hit: downloadHit('mkv'), ctx,
    job: job(), record: { ...record }, react: async () => {}, jobKey: 'R2:tt0113277',
  }).then(() => null, (e) => e);
  const kept = () => finishedOutput(openWork({
    workDir: WORK, key: workKey.movie('R2:tt0113277'), isSafe: (p) => isSafeToDeleteIn(p, { workDir: WORK }),
  }));

  const err = await run();
  const ready = kept();
  ok(/Connection Closed/.test(err?.message ?? '') && ready && fs.existsSync(ready.outPath),
    'a send lost after the conversion keeps the converted file for the retry');
  ok(sources(listWork()).length === 1 && listWork().length === 2,
    `and the original beside it: nothing goes before the film is sent (${listWork().join(', ')})`);
  moviePlugin._retries.forget('R2:tt0113277');

  const again = await run();
  ok(!again && fetches === 1 && bot.sent.at(-1).file === ready.outPath && bot.sent.at(-1).size === 2048,
    'the retry sends that file as it is - nothing is fetched again');
  ok(fs.readdirSync(WORK).length === 0 && !store.data.pending.length, 'and then it is gone, and the job is done');

  // Lost once more, and this time neither the kept file nor its original
  // survives - an operator clearing the disk by hand: the retry starts over
  // from the download.
  store.set('pending', [{ jobKey: 'R2:tt0113277', msgId: 'R2', msgKey: null, chatJid: 'req@g.us',
    movie: { title: 'Heat', year: 1995, imdbId: 'tt0113277', rated: 'R' }, meta: {}, record, at: Date.now() }]);
  lose = 1;
  await run();
  const second = kept();
  moviePlugin._retries.forget('R2:tt0113277');
  fs.rmSync(path.dirname(second.outPath), { recursive: true });
  const third = await run();
  ok(!third && fetches === 3 && bot.sent.at(-1).size === 2048,
    `with the kept file gone as well, the retry downloads and converts it again (${fetches} fetches)`);
  ok(fs.readdirSync(WORK).length === 0, 'and leaves nothing behind');
  globalThis.fetch = realFetch;
  moviePlugin._retries.clear();
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
