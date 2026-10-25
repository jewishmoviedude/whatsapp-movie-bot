/* A film interrupted by a restart goes on from where it stopped.
   Run: node test/movie-resume-after-restart.test.mjs

   The operator, 2026-09-29: "parent trap is already downloaded, if bot gets
   interrupted it should be able to continue where left off and not need to
   start over from step 1". The Parent Trap (1998), 2.62 GB, was downloaded
   18:42-18:44 UTC and was 23 minutes into its encode when the bot restarted
   at 19:07. Recovery resumed it - "recovering 3 job(s) interrupted by a
   restart", "resumed "The Parent Trap"" - and it began a fresh download
   under a new name: the start-up sweep had deleted the old download and the
   partial encode, and nothing tied them to the job anyway. A second restart
   11 seconds later started it over again.

   Each case here runs the film in a process of its own and kills it with
   SIGKILL at the step named (test/fixtures/killable-job.mjs), then runs it
   again in this process as the next start would: the start-up sweep first
   (src/index.js), then recovery (recoverPending), then the job it queued.
   The library is a local server standing in for Jellyfin's download
   endpoint and the library's search (test/fixtures/restart-kit.mjs).

   Found in review of that work, and pinned here:
   - recovery took every film out of the journal before putting each back,
     one lookup at a time, so a restart in between (the incident's second
     came 11 seconds after the first) lost the rest, and the next start's
     sweep deleted their work;
   - a film whose retries in this process ran out had its work deleted, and
     the restart the hourly check then made began it again from step 1;
   - a film posted just before a restart was posted again when the library
     had changed meanwhile, or when its work directory had already gone
     while the journal's removal was still waiting to be saved;
   - a film read in place went on from whichever copy the library listed
     first, not the one its work was made from;
   - a download resumed from a partial reported the whole file's size over
     the last part's time as its speed. */
import './fixtures/roomy-disk.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';
import moviePlugin, { MAX_RECOVERIES } from '../src/plugins/movie-requests/index.js';
import { RetryBook, finishedOutput } from '../src/media/resume.js';
import { keptFiles } from '../src/media/disk-space.js';
import { StateStore } from '../src/core/state.js';
import {
  openWork, workKey, jobDirName, sweepWorkDir, liveWorkDirs, isSafeToDeleteIn, forgetThisProcess, statOf,
} from '../src/media/work-files.js';
import { makeKit, sleep } from './fixtures/restart-kit.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const kit = await makeKit('movie-restart');
const { WORK, LIB, server } = kit;
const isSafe = (p) => isSafeToDeleteIn(p, { workDir: WORK, roots: [LIB] });

const base = {
  movieRequests: {
    postsGroup: 'posts@g.us', notify: {}, blockedRatings: [],
    reactions: { redo: '🔄', failed: '⚠️', cancelled: '❌', skipped: '⏭️', done: '✅', sending: '⬆️', downloading: '⬇️', converting: '⚙️' },
  },
  media: { workDir: WORK, ffprobePath: kit.FFPROBE, ffmpegPath: kit.FFMPEG, deleteAfterSend: true },
};
const config = mergeDefaults({ ...base, library: { provider: 'local', local: { roots: [LIB], extensions: ['.mkv'] } } }, DEFAULT_CONFIG);
// Recovery looks each film up again: the library's search, on the kit's server.
const searchConfig = mergeDefaults({
  ...base, library: { provider: 'http', http: { searchUrl: `${kit.base}/search` }, searchTimeoutMs: 600_000 },
}, DEFAULT_CONFIG);

const logs = [];
const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), debug() {} };
const MOVIE = { title: 'The Parent Trap', year: 1998, imdbId: 'tt0120783', rated: 'PG' };
const HEAT = { title: 'Heat', year: 1995, imdbId: 'tt0113277', rated: 'R' };

let n = 0;
/** A request for the film, journalled as onMessage journals it. */
function request(movie = MOVIE) {
  n += 1;
  const jobKey = `PT${n}:${movie.imdbId}`;
  const record = { id: `PT${n}`, request: movie.title.toLowerCase(), status: 'queued', title: movie.title, year: movie.year, rated: movie.rated };
  const hit = {
    id: `pt-${n}`, provider: 'jellyfin', access: 'download', container: 'mkv', size: server.body.length,
    downloadUrl: `${kit.base}/Items/pt-${n}/Download`, downloadHeaders: { 'X-Emby-Token': 'TOK' },
  };
  const store = kit.loadStore();
  store.set('pending', [...store.get('pending', []), {
    jobKey, msgId: `PT${n}`, msgKey: { remoteJid: 'req@g.us', id: `PT${n}` }, chatJid: 'req@g.us', movie, meta: {}, record, at: Date.now(),
  }]);
  store.set('history', [...store.get('history', []), { ...record }]);
  return { jobKey, record, hit, movie, spec: { kind: 'movie', config, movie, hit, record, jobKey } };
}
/** What the library's search answers for these films: each one's own copy. */
function catalog(...rs) {
  server.catalog = rs.map((r) => ({ id: r.hit.id, title: r.movie.title, year: r.movie.year, url: r.hit.downloadUrl, size: server.body.length }));
}

function fakeBot() {
  const bot = {
    sent: [], reacted: [],
    isConnected: () => true, react: async (m, e) => { bot.reacted.push(e); return true; },
    sendText: async () => ({}), groups: () => [], groupMemberInfo: () => ({ isMember: false }), on() {}, off() {},
    sendDocument: async (jid, file) => { bot.sent.push({ jid, file, bytes: fs.readFileSync(file) }); return {}; },
  };
  return bot;
}
const job = (o = {}) => ({ id: `j${Math.random().toString(16).slice(2, 8)}`, signal: new AbortController().signal,
  progress() {}, isCancelled: () => false, cancelReason: () => null, ...o });

/** The next process: it knows nothing of the last one, and sweeps the work directory before anything runs. */
function restart(cfg = config) {
  forgetThisProcess();
  moviePlugin._parked = null;
  const store = kit.loadStore();
  sweepWorkDir(WORK, { all: true, live: liveWorkDirs({ movie: store.get('pending', []), tv: [] }), isSafe, log });
  return { bot: fakeBot(), store, queue: { pending: [], active: new Map(), on() {}, off() {}, add() { return 'q'; } }, log, config: cfg };
}
/** The job again, run straight through deliver() - as its queued run() does. */
async function resume(ctx, r, jobOpts = {}, hit = r.hit) {
  moviePlugin._retries = new RetryBook({ delayMs: () => 3_600_000, log });
  try {
    await moviePlugin.deliver({
      msg: null, movie: r.movie, hit, ctx, job: job(jobOpts), record: { ...r.record }, react: (e) => ctx.bot.react(null, e), jobKey: r.jobKey,
    });
    return null;
  } catch (e) { return e; } finally { moviePlugin._retries.clear(); }
}
/** Recovery, as a start runs it: the films it puts back in the queue, in order. */
async function recover(ctx) {
  const added = [];
  ctx.queue = { pending: [], active: new Map(), on() {}, off() {}, add(j) { added.push(j); return `q${added.length}`; } };
  moviePlugin._retries = new RetryBook({ delayMs: () => 3_600_000, log });
  moviePlugin._reactors = new Map();
  await moviePlugin.recoverPending(ctx);
  return added;
}
/** Run what recovery queued, one after another, as the queue would. */
async function runAll(added) {
  let err = null;
  for (const j of added) {
    try { await j.run(job()); } catch (e) { err ??= e; }
  }
  moviePlugin._retries?.clear();
  return err;
}
const workOf = (r) => openWork({ workDir: WORK, key: workKey.movie(r.jobKey), isSafe });
const dirOf = (r) => path.join(WORK, jobDirName(workKey.movie(r.jobKey)));
const entryOf = (store, r) => (store.get('pending', []) ?? []).find((p) => p.jobKey === r.jobKey);
const journalled = (store, r) => !!entryOf(store, r);
const row = (store, r) => (store.get('history', []) ?? []).find((h) => h.id === r.record.id);
const downloadsOf = (r) => kit.downloads().filter((d) => d.url.startsWith(`/Items/${r.hit.id}/`));
const reset = () => {
  server.requests.length = 0;
  server.searches.length = 0;
  server.catalog = [];
  fs.rmSync(kit.flag('PROBES'), { force: true });
  fs.rmSync(kit.flag('RUNS'), { force: true });
  fs.rmSync(path.join(kit.TMP, 'events.log'), { force: true });
  logs.length = 0;
};
/** Only the pending journal of the films in `rs` - the cases do not share one. */
const only = (...rs) => {
  const store = kit.loadStore();
  store.set('pending', (store.get('pending', []) ?? []).filter((p) => rs.some((r) => r.jobKey === p.jobKey)));
};

console.log('=== The Parent Trap: downloaded, killed mid-encode, resumed from the download ===');
{
  reset();
  const r = request();
  kit.slowEncode(true);
  const first = await kit.runChild(r.spec, { killWhen: kit.encoding });
  ok(first.killed && kit.downloads().length === 1 && kit.count('RUNS') === 1,
    `the first process downloaded it once and was killed while encoding (${kit.downloads().length} download, ${kit.count('RUNS')} encode)`);
  const m = workOf(r).manifest;
  ok(m.source?.state === 'complete' && m.source.bytes === server.body.length && m.item?.lastModified === server.lastModified,
    'its work records the whole download, and which library file it is');
  kit.slowEncode(false);

  const ctx = restart(searchConfig);
  ok(fs.existsSync(path.join(dirOf(r), m.source.name)) && journalled(ctx.store, r), 'the start-up sweep keeps it: the journal still holds the film');
  catalog(r);
  const added = await recover(ctx);
  ok(added.length === 1 && added[0].meta?.jobKey === r.jobKey, 'recovery puts it back in the queue');
  const err = await runAll(added);
  ok(!err, `the resumed film is posted (${err?.message ?? 'no error'})`);
  ok(kit.downloads().length === 1 && kit.probes().length === 1,
    `the library is asked one byte, whether its file is still the same - nothing is downloaded again (${kit.downloads().length} download, ${kit.probes().length} probe)`);
  ok(kit.count('RUNS') === 2, 'it is converted from the kept download');
  ok(Buffer.compare(ctx.bot.sent[0]?.bytes ?? Buffer.alloc(0), server.body) === 0, 'and the film posted is the library\'s, byte for byte');
  ok(logs.some((l) => /The Parent Trap: its 3\.00 MB download finished before the restart - converting it without fetching it again/.test(l)),
    'the log says what it went on from');
  // Shown the step it is on as it is picked back up: never ⬇️, which it
  // does not do again, and never 🔄, which a member read as "send it again"
  // (Iron Man 3, 2026-10-11) - and the ⚙️ its run reaches is not sent twice.
  const R = ctx.bot.reacted;
  ok(R.join(' ') === '⚙️ ⬆️ ✅',
    `its message shows ⚙️, the stage it is at, then ⬆️ and ✅ - never 🔄 or ⬇️, nothing twice (${R.join(' ')})`);
  ok(!fs.existsSync(dirOf(r)) && !journalled(ctx.store, r) && row(ctx.store, r)?.status === 'sent',
    'then its work is gone, the journal is clear, and History says sent');
}

console.log('=== killed mid-download: the restart goes on from the byte it reached ===');
{
  reset();
  const r = request();
  const part = () => { try { return fs.statSync(path.join(dirOf(r), 'source.mkv.part')).size; } catch { return 0; } };
  server.slow = 64 * 1024;                           // about 3 MB a second
  const first = await kit.runChild(r.spec, { killWhen: () => part() >= 1024 * 1024 });
  const had = part();
  ok(first.killed && had >= 1024 * 1024 && had < server.body.length && workOf(r).manifest.source?.state === 'partial',
    `killed with ${had} of its ${server.body.length} bytes downloaded, recorded as a partial download`);
  const ctx = restart();
  ok(part() === had, 'the start-up sweep keeps the partial');
  // Slowly enough that the rest takes a second or more.
  server.slow = 16 * 1024;
  const err = await resume(ctx, r);
  server.slow = false;
  const dl = kit.downloads();
  ok(!err && dl.length === 2 && dl[1].range === `bytes=${had}-` && dl[1].ifRange === server.lastModified,
    `the restart asks for the rest, if the file is still the same (${dl.map((d) => d.range ?? 'all').join(', ')})`);
  ok(Buffer.compare(ctx.bot.sent[0]?.bytes ?? Buffer.alloc(0), server.body) === 0, 'and the film posted is whole, byte for byte');
  ok(logs.some((l) => new RegExp(`download START .* - going on from the ${(had / 1024 / 1024).toFixed(2)} MB it had before`).test(l)),
    'the log says it went on from what it had');
  // Its speed is of what it fetched: over the whole file, a download that
  // went on from 2.3 of its 2.62 GB showed some 87 MB/s for about 11.
  const t = (ctx.store.get('transfers', []) ?? [])[0];
  ok(t && t.downloadSec > 0 && t.resumedFromBytes === had && t.avgBytesPerSec === Math.round((server.body.length - had) / t.downloadSec),
    `the transfer's speed is the rest's over its time (${t?.avgBytesPerSec} B/s over ${t?.downloadSec}s, from ${t?.resumedFromBytes})`);
  ok(logs.some((l) => /download DONE .* 3\.00 MB, the last [\d.]+ [KM]B of it in \d/.test(l)), 'and the log says how much of it was fetched now');
}

console.log('=== a second restart 11 seconds later still resumes ===');
{
  reset();
  const r = request();
  kit.slowEncode(true);
  await kit.runChild(r.spec, { killWhen: kit.encoding });
  // 19:07, and again at 19:07:11: the second process gets as far as the
  // encode, on the download the first one made, and is killed there too.
  forgetThisProcess();
  sweepWorkDir(WORK, { all: true, live: liveWorkDirs({ movie: kit.loadStore().get('pending', []) }), isSafe, log });
  const second = await kit.runChild(r.spec, { killWhen: kit.encoding });
  ok(second.killed && kit.downloads().length === 1 && kit.probes().length === 1,
    `the second process converts from the first one's download (${kit.downloads().length} download, ${kit.probes().length} probe)`);
  kit.slowEncode(false);
  const ctx = restart();
  const err = await resume(ctx, r);
  ok(!err && kit.downloads().length === 1 && kit.probes().length === 2 && kit.count('RUNS') === 3,
    `and the third finishes it, still from that one download (${kit.downloads().length} download, ${kit.probes().length} probes, ${kit.count('RUNS')} encodes)`);
  ok(ctx.bot.sent.length === 1 && !fs.existsSync(dirOf(r)), 'posted once, and its work is gone');
}

console.log('=== a restart while recovery is looking the films up loses none of them ===');
{
  // Recovery took every film out of the journal first, and put each back
  // only once its lookup and rating check were done. The Parent Trap's
  // second restart came 11 seconds after the first: a restart in that
  // window left the films not yet put back in no journal, and the next
  // start's sweep deleted their downloads and pieces.
  reset();
  const a = request(HEAT);
  const b = request();
  const partOf = (r) => { try { return fs.statSync(path.join(dirOf(r), 'source.mkv.part')).size; } catch { return 0; } };
  server.slow = 64 * 1024;
  await kit.runChild(a.spec, { killWhen: () => partOf(a) >= 1024 * 1024 });
  server.slow = false;
  kit.slowEncode(true);
  await kit.runChild(b.spec, { killWhen: kit.encoding });
  kit.slowEncode(false);
  only(a, b);
  ok(fs.existsSync(dirOf(a)) && fs.existsSync(dirOf(b)), 'both films have work: Heat half downloaded, The Parent Trap mid-encode');

  // The next start: Heat's lookup never answers, and the process is killed
  // while it waits.
  const ctx = restart(searchConfig);
  catalog(a, b);
  server.hangSearch.add(HEAT.title);
  moviePlugin._retries = new RetryBook({ delayMs: () => 3_600_000, log });
  moviePlugin._reactors = new Map();
  const stuck = [];
  ctx.queue = { pending: [], active: new Map(), on() {}, off() {}, add(j) { stuck.push(j); return 'q'; } };
  moviePlugin.recoverPending(ctx).catch(() => {});
  for (let i = 0; i < 200 && !server.searches.includes(HEAT.title); i++) await sleep(10);
  ok(server.searches.includes(HEAT.title) && stuck.length === 0, 'killed while Heat is being looked up, with nothing queued yet');

  // And the start after it.
  moviePlugin._retries.clear();
  const again = restart(searchConfig);
  ok(journalled(again.store, a) && journalled(again.store, b), 'both films are still journalled');
  ok(entryOf(again.store, a)?.recoveries === 1 && entryOf(again.store, b)?.recoveries === 1,
    'each stamped with the one start that tried to put it back');
  ok(fs.existsSync(dirOf(a)) && fs.existsSync(dirOf(b)), 'and the start-up sweep keeps the work of both');
  server.hangSearch.clear();
  const added = await recover(again);
  ok(added.map((j) => j.meta?.jobKey).join() === `${a.jobKey},${b.jobKey}`, 'recovery puts both back in the queue');
  ok(!('recoveries' in (entryOf(again.store, a) ?? {})) && !('recoveries' in (entryOf(again.store, b) ?? {})),
    'with the stamp gone once each is back');
  const err = await runAll(added);
  ok(!err && again.bot.sent.length === 2 && again.bot.sent.every((s) => Buffer.compare(s.bytes, server.body) === 0), 'and both are posted, whole');
  ok(downloadsOf(b).length === 1 && downloadsOf(a).length === 2 && downloadsOf(a)[1].range?.startsWith('bytes='),
    'The Parent Trap from the download it had, Heat from the byte it reached');
}

console.log(`=== a film whose recovery has stopped the process ${MAX_RECOVERIES} times is given up, and says so ===`);
{
  // What clearing the journal first was for: a film whose recovery kills the
  // process must not be tried at every start for ever.
  reset();
  const r = request();
  only(r);
  const store = kit.loadStore();
  store.set('pending', store.get('pending').map((p) => ({ ...p, recoveries: MAX_RECOVERIES })));
  workOf(r).record({ item: { provider: 'jellyfin', id: r.hit.id, access: 'download', total: server.body.length, lastModified: server.lastModified } });
  const ctx = restart(searchConfig);
  catalog(r);
  const added = await recover(ctx);
  ok(added.length === 0 && server.searches.length === 0, 'it is not looked up or queued');
  ok(!journalled(ctx.store, r) && !fs.existsSync(dirOf(r)), 'it leaves the journal, and its work goes');
  ok(row(ctx.store, r)?.status === 'failed' && /stopped 3 times while putting it back/.test(row(ctx.store, r)?.detail ?? ''),
    `History says why (${row(ctx.store, r)?.detail})`);
  ok(ctx.bot.reacted.join() === '⚠️', 'and its requester sees ⚠️');
}

console.log('=== two journalled films, only the second with work: it goes back in first ===');
{
  reset();
  const a = request(HEAT);
  const b = request();
  kit.slowEncode(true);
  await kit.runChild(b.spec, { killWhen: kit.encoding });
  kit.slowEncode(false);
  only(a, b);
  const ctx = restart(searchConfig);
  catalog(a, b);
  const added = await recover(ctx);
  ok(added.map((j) => j.meta?.jobKey).join() === `${b.jobKey},${a.jobKey}`, 'the film with work is queued first, the other after it');
  ok(keptFiles().some((k) => k.key === b.jobKey) && !keptFiles().some((k) => k.key === a.jobKey),
    'room is held for the work it has still to finish');
  await added[0].run(job());
  ok(!keptFiles().some((k) => k.key === b.jobKey) && ctx.bot.sent.length === 1, 'until it has run');
  await runAll(added.slice(1));
}

console.log('=== a film encoded before a restart is sent after it without downloading or encoding again ===');
{
  // The operator, 2026-09-30: a restart deleted three fully converted films
  // (La La Land's upload was still running, and it began again from the
  // download) - "files should remain in their folders until fully sent on
  // whatsapp", and "3 files are already fully converted so upon bot reboot
  // they should send 1x1". Killed part way through its upload, twice.
  reset();
  const r = request();
  const first = await kit.runChild({ ...r.spec, send: 'hang' }, { killWhen: () => kit.events().some((e) => e.sending) });
  ok(first.killed && kit.count('RUNS') === 1, 'killed in the middle of its upload');
  ok(finishedOutput(workOf(r))?.size === server.body.length, 'its work records the finished film');
  const name = path.basename(dirOf(r));
  ok(kit.listWork().sort().join() === [`${name}/output.mp4`, `${name}/source.mkv`].join(),
    `and its directory holds the finished film and the download it was made from (${kit.listWork().join(', ')})`);
  // A second restart, as the incident's came 11 seconds after the first:
  // killed part way through the upload again.
  only(r);
  forgetThisProcess();
  fs.rmSync(path.join(kit.TMP, 'events.log'), { force: true });
  const second = await kit.runChild({ ...r.spec, send: 'hang' }, { killWhen: () => kit.events().some((e) => e.sending) });
  ok(second.killed && kit.count('RUNS') === 1 && kit.downloads().length === 1 && !kit.events().some((e) => e.sent),
    'the second process went straight to the upload, and was killed in it too');
  ok(kit.listWork().length === 2, 'and everything is still there');
  only(r);
  const ctx = restart(searchConfig);
  catalog(r);
  const probesBefore = kit.count('PROBES');
  const err = await runAll(await recover(ctx));
  ok(!err && ctx.bot.sent.length === 1 && Buffer.compare(ctx.bot.sent[0].bytes, server.body) === 0,
    'the restarted job sends the finished film, once');
  ok(kit.count('RUNS') === 1 && kit.count('PROBES') === probesBefore && kit.downloads().length === 1,
    'without inspecting, converting or downloading it again');
  ok(!fs.existsSync(dirOf(r)) && !journalled(ctx.store, r), 'and only once it is sent does its directory go');
  ok(logs.some((l) => /reusing The Parent Trap \(1998\)\.mp4 \(3\.00 MB\)/.test(l)), 'and says so');
  const R = ctx.bot.reacted;
  ok(R.join(' ') === '⬆️ ✅', `its message shows ⬆️, the stage it is at, then ✅ - no 🔄, ⬇️ or ⚙️ (${R.join(' ')})`);
}

console.log('=== posted before the restart: not posted twice ===');
{
  // Killed after WhatsApp took the film and before the journal could say so.
  const killedOnDone = async () => {
    reset();
    const r = request();
    const first = await kit.runChild({ ...r.spec, hangOnReact: '✅' }, {
      killWhen: () => kit.events().some((e) => e.react === '✅'),
    });
    only(r);
    return { r, first };
  };
  {
    const { r, first } = await killedOnDone();
    ok(first.killed && kit.events().filter((e) => e.sent).length === 1, 'the first process posted it, then was killed');
    const ctx = restart(searchConfig);
    ok(journalled(ctx.store, r), 'the journal still holds it');
    catalog(r);
    const added = await recover(ctx);
    ok(added.length === 0 && ctx.bot.sent.length === 0 && server.searches.length === 0,
      'recovery queues nothing and posts nothing - it does not even look the film up');
    ok(logs.some((l) => /"The Parent Trap" was already posted to its group before the restart - not posting it twice/.test(l)),
      'and says why');
    ok(ctx.bot.reacted.join() === '✅' && !journalled(ctx.store, r) && row(ctx.store, r)?.status === 'sent' && !fs.existsSync(dirOf(r)),
      'the job is finished: ✅, out of the journal, History says sent, its work gone');
  }
  // The library moved on meanwhile: the check against it used to come
  // first, reset the work - the record that it was posted with it - and the
  // film was fetched, converted and posted again.
  for (const [how, change] of [
    ['a rescan gave the library item a new id', (h) => ({ ...h, id: 'pt-rescanned' })],
    ['the library is now mounted here, and the film read in place', (h) => {
      const file = path.join(LIB, 'The Parent Trap 1998.mkv');
      fs.writeFileSync(file, server.body);
      return { ...h, access: 'local', localPath: file, downloadUrl: null };
    }],
  ]) {
    const { r } = await killedOnDone();
    const ctx = restart();
    const err = await resume(ctx, r, {}, change(r.hit));
    ok(!err && ctx.bot.sent.length === 0 && kit.downloads().length === 1 && row(ctx.store, r)?.status === 'sent',
      `${how}: nothing is posted again (${ctx.bot.sent.length} post, ${kit.downloads().length} download)`);
  }
  fs.rmSync(path.join(LIB, 'The Parent Trap 1998.mkv'), { force: true });
  // Its work gone - by a version that deleted it before the journal's
  // removal was saved - and the journal still holding it: the journal says
  // it was posted too.
  {
    const { r } = await killedOnDone();
    ok((entryOf(kit.loadStore(), r)?.sent?.to ?? []).includes('posts@g.us'), 'its journal entry says where it was posted');
    fs.rmSync(dirOf(r), { recursive: true, force: true });
    const ctx = restart(searchConfig);
    catalog(r);
    const added = await recover(ctx);
    ok(added.length === 0 && ctx.bot.sent.length === 0 && kit.downloads().length === 1 && !journalled(ctx.store, r),
      'with its work gone, the restart still posts nothing, and finishes it');
  }
}

console.log('=== killed between the post and the journal\'s save: not posted twice ===');
{
  // The journal is saved half a second after a change, and never synced;
  // the work - with the record that the film was posted - was deleted
  // before that. A kill in that half second (an out-of-memory kill, a
  // power cut) left the job journalled with nothing to say it was posted.
  // The store here is the real one, and what the next start reads is what
  // is on the disk the moment the job has finished.
  reset();
  const file = path.join(kit.TMP, `state-${n}.json`);
  const r = request();
  const entry = entryOf(kit.loadStore(), r);
  only();
  const live = new StateStore(file);
  live.namespace('movie-requests').set('pending', [entry]);
  live.flush();
  forgetThisProcess();
  const ctx = { bot: fakeBot(), store: live.namespace('movie-requests'), queue: { pending: [], active: new Map(), on() {}, off() {}, add() { return 'q'; } }, log, config };
  const err = await resume(ctx, r);
  ok(!err && ctx.bot.sent.length === 1, 'the film is posted');
  // Killed now: the next start reads the disk.
  forgetThisProcess();
  const next = new StateStore(file).namespace('movie-requests');
  const left = next.get('pending', []) ?? [];
  sweepWorkDir(WORK, { all: true, live: liveWorkDirs({ movie: left }), isSafe, log });
  const after = { ...ctx, bot: fakeBot(), store: next };
  for (const p of left) await resume(after, { ...r, jobKey: p.jobKey });
  ok(after.bot.sent.length === 0, `the next start posts nothing (${left.length} journalled, ${after.bot.sent.length} posted)`);
}

console.log('=== its retries spent, a film keeps its work for the next start, which sends it as it is ===');
{
  // It used to be deleted with the attempts in this process - "kept work is
  // room no job in this process would give back" - and the next start, which
  // the hourly check brings about for a film left this way, began again from
  // step 1: with Jellyfin up after the bot, four failed checks deleted a
  // complete 2.62 GB download and its pieces.
  reset();
  const r = request();
  only(r);
  const ctx = restart();
  ctx.bot.sendDocument = async () => { throw new Error('Connection Closed'); };
  moviePlugin._retries = new RetryBook({ max: 0, log });
  await moviePlugin.deliver({ msg: null, movie: MOVIE, hit: r.hit, ctx, job: job(), record: { ...r.record }, react: async () => {}, jobKey: r.jobKey })
    .catch(() => {});
  ok(journalled(ctx.store, r) && finishedOutput(workOf(r))?.size === server.body.length,
    'parked: still journalled for the next start, with the film it made');
  ok(logs.some((l) => /will retry on next start, going on from what it had done$/.test(l)), 'and the log says the next start goes on from it');
  const [runs, probes, dls] = [kit.count('RUNS'), kit.count('PROBES'), kit.downloads().length];
  const after = restart();
  const err = await resume(after, r);
  ok(!err && after.bot.sent.length === 1 && Buffer.compare(after.bot.sent[0].bytes, server.body) === 0
    && kit.count('RUNS') === runs && kit.count('PROBES') === probes && kit.downloads().length === dls,
  'the next start sends that film, with nothing downloaded, inspected or converted again');
  ok(!fs.existsSync(dirOf(r)) && !journalled(after.store, r), 'and then its work is gone');
}

console.log('=== asked for again once its retries are spent, the new request takes over its work ===');
{
  reset();
  const r = request();
  only(r);
  const ctx = restart();
  ctx.bot.sendDocument = async () => { throw new Error('Connection Closed'); };
  moviePlugin._retries = new RetryBook({ max: 0, log });
  await moviePlugin.deliver({ msg: null, movie: MOVIE, hit: r.hit, ctx, job: job(), record: { ...r.record }, react: async () => {}, jobKey: r.jobKey })
    .catch(() => {});
  const made = finishedOutput(workOf(r));
  ok(made && journalled(ctx.store, r), 'parked, with the film it made');
  // Queued again from the panel, for the same place.
  const added = [];
  ctx.bot = fakeBot();
  ctx.queue = { pending: [], active: new Map(), on() {}, off() {}, hasRoom: () => true, add(j) { added.push(j); return 'q1'; } };
  await moviePlugin.queueLibraryItem({ id: r.hit.id, title: MOVIE.title, year: MOVIE.year, rated: 'PG', downloadUrl: r.hit.downloadUrl, headers: {} }, ctx);
  const now = (ctx.store.get('pending', []) ?? []).map((p) => p.jobKey);
  ok(!now.includes(r.jobKey) && now.length === 1 && !fs.existsSync(dirOf(r)), 'the old job leaves the journal');
  const taken = openWork({ workDir: WORK, key: workKey.movie(now[0]), isSafe });
  ok(finishedOutput(taken)?.size === made.size && logs.some((l) => /the new request takes over the work the old one had done/.test(l)),
    'and the new one has the film it made');
  const [runs, dls] = [kit.count('RUNS'), kit.downloads().length];
  await added[0].run(job());
  moviePlugin._retries?.clear();
  ok(ctx.bot.sent.length === 1 && kit.count('RUNS') === runs && kit.downloads().length === dls,
    'which it posts, with nothing downloaded or converted again');
}

console.log('=== a film read in place goes on from the copy its work was made from ===');
{
  // A library can list the same film twice. The work of a film read in
  // place was continued from whichever copy the library listed first now:
  // pieces made from one file, finished from another.
  reset();
  const A = path.join(LIB, 'The Parent Trap 1998 (a).mkv');
  const B = path.join(LIB, 'The Parent Trap 1998 (b).mkv');
  const bytesA = crypto.randomBytes(4096);
  const bytesB = crypto.randomBytes(4096);
  fs.writeFileSync(A, bytesA);
  fs.writeFileSync(B, bytesB);
  const copy = (p) => ({ id: p, provider: 'local', access: 'local', localPath: p, size: 4096, container: 'mkv' });
  const hit = { ...copy(A), alternates: [copy(B)] };
  const made = (r) => workOf(r).record({
    item: { provider: 'local', id: B, access: 'local', librarySize: 4096, total: null, lastModified: null, etag: null, local: statOf(B) },
  });
  {
    const r = request();
    only(r);
    made(r);
    const ctx = restart();
    const err = await resume(ctx, r, {}, hit);
    ok(!err && Buffer.compare(ctx.bot.sent[0]?.bytes ?? Buffer.alloc(0), bytesB) === 0,
      'the library lists copy A first: it is converted from copy B, which its work came from');
  }
  if (process.getuid?.() !== 0) {
    const r = request();
    only(r);
    made(r);
    fs.chmodSync(B, 0o000);
    const ctx = restart();
    const err = await resume(ctx, r, {}, hit);
    fs.chmodSync(B, 0o644);
    ok(!err && Buffer.compare(ctx.bot.sent[0]?.bytes ?? Buffer.alloc(0), bytesA) === 0
      && logs.some((l) => /the copy its work came from cannot be read here/.test(l)),
    'copy B no longer readable here: its work is started again, from copy A');
  }
  fs.rmSync(A);
  fs.rmSync(B);
}

console.log('=== a film that ends leaves no work directory, however it ends ===');
{
  reset();
  const ends = [];
  const setup = () => { forgetThisProcess(); const r = request(); only(r); return { r, ctx: restart() }; };
  // Posted.
  { const { r, ctx } = setup(); await resume(ctx, r); ends.push(['posted', r]); }
  // Failed for good: an encoder that fails is not a thing to wait out.
  {
    const { r, ctx } = setup();
    ctx.config = { ...config, media: { ...config.media, ffmpegPath: '/bin/false' } };
    const err = await resume(ctx, r);
    ok(/ffmpeg exited 1/.test(err?.message ?? ''), `the encoder fails (${err?.message})`);
    ends.push(['failed for good', r]);
  }
  // Cancelled while it ran.
  {
    const { r, ctx } = setup();
    let calls = 0;
    await resume(ctx, r, { isCancelled: () => (calls++ > 2), cancelReason: () => 'cancelled' });
    ok(row(ctx.store, r)?.status === 'cancelled', 'a film cancelled while it runs is cancelled');
    ends.push(['cancelled', r]);
  }
  // Lost its send, waiting for the retry, and then cancelled from the queue
  // before it started again, or from the panel while its retry was booked.
  for (const how of ['cancelled while waiting', 'cancelled during a booked retry']) {
    const { r, ctx } = setup();
    ctx.bot.sendDocument = async () => { throw new Error('Connection Closed'); };
    moviePlugin._retries = new RetryBook({ delayMs: () => 3_600_000, log });
    await moviePlugin.deliver({ msg: null, movie: MOVIE, hit: r.hit, ctx, job: job(), record: { ...r.record }, react: async () => {}, jobKey: r.jobKey })
      .catch(() => {});
    ok(finishedOutput(workOf(r)) && moviePlugin._retries.isWaiting(r.jobKey), `${how}: the film it made is kept for its retry first`);
    if (how === 'cancelled while waiting') {
      moviePlugin._cancelledWhileWaiting(ctx, { id: 'q9', state: 'cancelled', meta: { jobKey: r.jobKey } });
    } else moviePlugin._cancelBookedRetry(ctx, r.jobKey, 'cancelled');
    moviePlugin._retries.clear();
    ends.push([how, r]);
  }
  for (const [how, r] of ends) ok(!fs.existsSync(dirOf(r)), `${how}: no work directory`);
  moviePlugin._retries = null;
}

console.log('=== of two journalled twins, the one resumed takes the other\'s work ===');
{
  // The live journal held two "Minority Report" jobs on 2026-09-28; recovery
  // resumes one of them. The other had got further - its film is made.
  reset();
  forgetThisProcess();
  const film = path.join(LIB, 'The Parent Trap 1998.mkv');
  fs.writeFileSync(film, server.body);
  const st = fs.statSync(film);
  const store = kit.loadStore();
  const entry = (id) => ({
    jobKey: `${id}:tt0120783`, msgId: id, msgKey: null, chatJid: 'req@g.us', movie: MOVIE, meta: {}, at: Date.now(),
    record: { id, request: 'the parent trap 1998', status: 'queued', title: MOVIE.title, year: MOVIE.year },
  });
  store.set('pending', [entry('TWIN1'), entry('TWIN2')]);
  const later = openWork({ workDir: WORK, key: workKey.movie('TWIN2:tt0120783'), isSafe });
  later.record({
    item: { provider: 'local', id: film, access: 'local', librarySize: null, total: null, lastModified: null, etag: null,
      local: { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs } },
    output: { name: 'output.mp4', size: server.body.length, action: 'remux' },
  });
  fs.writeFileSync(later.outPath, server.body);
  const ctx = restart();
  const added = await recover(ctx);
  ok(added.length === 1 && added[0].meta?.jobKey === 'TWIN1:tt0120783', 'the earlier request is the one resumed');
  ok(!(ctx.store.get('pending', []) ?? []).some((p) => p.jobKey === 'TWIN2:tt0120783'), 'the other leaves the journal');
  ok(finishedOutput(openWork({ workDir: WORK, key: workKey.movie('TWIN1:tt0120783'), isSafe }))?.size === server.body.length
    && !fs.existsSync(path.join(WORK, jobDirName(workKey.movie('TWIN2:tt0120783')))),
  'and the one resumed has its finished film');
  const probes = kit.count('PROBES');
  await added[0].run(job());
  ok(ctx.bot.sent.length === 1 && Buffer.compare(ctx.bot.sent[0].bytes, server.body) === 0 && kit.count('PROBES') === probes,
    'which it posts as it is, with nothing converted again');
  ok(!fs.existsSync(path.join(WORK, jobDirName(workKey.movie('TWIN1:tt0120783')))), 'and then its work is gone');
  moviePlugin._retries.clear();
  fs.rmSync(film);
}

await sleep(10);
kit.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
