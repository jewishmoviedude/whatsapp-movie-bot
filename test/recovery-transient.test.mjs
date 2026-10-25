/* A film whose resume after a restart hits a network blip is tried again, not lost.
   Run: node test/recovery-transient.test.mjs

   recoverPending clears the journal before it replays it, and _resume looks
   the film up again in Jellyfin (and re-checks its rating) before putting it
   back. A "fetch failed" from either used to drop the film for good: out of
   the journal, its finished file kept for a retry deleted, no reaction on
   the member's message, and its History row "lost" once reconcileHistory
   ran - "Film Number C" in review scenario f-recovery, from one failed
   Jellyfin search as the bot started. A retry in this process (_retryNow)
   already treated the same error as transient; recovery now does too.

   Its finished file is in its work since The Parent Trap (2026-09-29):
   media/work-files.js. */
import './fixtures/roomy-disk.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import { RetryBook, finishedOutput } from '../src/media/resume.js';
import { openWork, workKey, isSafeToDeleteIn } from '../src/media/work-files.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const REQ = 'movie-requests@g.us';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'recover-transient-'));
const LIB = path.join(TMP, 'lib');
const WORK = path.join(TMP, 'work');
fs.mkdirSync(LIB); fs.mkdirSync(WORK);
fs.writeFileSync(path.join(LIB, 'Heat (1995).mp4'), 'not really a film');

const config = mergeDefaults({
  movieRequests: { requestGroups: [REQ], postsGroup: 'posts@g.us', notify: {}, blockedRatings: [] },
  library: { provider: 'local', local: { roots: [LIB], extensions: ['.mp4'] } },
  media: { workDir: WORK, ffmpegPath: '/bin/false', deleteAfterSend: true },
}, DEFAULT_CONFIG);

const data = {};
const store = { get: (k, d = null) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; }, push: (k, v) => { (data[k] ??= []).unshift(v); } };
const reacts = [];
const jobs = [];
const logs = [];
const ctx = {
  config, store,
  log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), debug() {} },
  bot: { isConnected: () => true, react: async (m, e) => { reacts.push(`${m.id} ${e}`); return true; }, on() {}, off() {} },
  queue: {
    pending: [], active: new Map(), on() {}, off() {},
    add(j) { jobs.push(j); this.pending.push({ id: `q${jobs.length}`, meta: j.meta }); return `q${jobs.length}`; },
    moveTop() { return true; },
    snapshot() { return { pending: [], active: [] }; },
  },
};
moviePlugin._reactors = new Map();
moviePlugin._retries = new RetryBook({ delayMs: () => 10, log: ctx.log });

// The finished film its work holds, made from the library file before the restart.
const work = () => openWork({ workDir: WORK, key: workKey.movie('HEAT1:tt0113277'), isSafe: (p) => isSafeToDeleteIn(p, { workDir: WORK }) });
const w = work();
const libFilm = path.join(LIB, 'Heat (1995).mp4');
const st = fs.statSync(libFilm);
w.record({
  item: { provider: 'local', id: libFilm, access: 'local', librarySize: null, total: null, lastModified: null, etag: null,
    local: { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs } },
  output: { name: 'output.mp4', size: 2048, action: 'remux' },
});
fs.writeFileSync(w.outPath, Buffer.alloc(2048, 1));
const kept = w.outPath;
const record = { id: 'HEAT1', request: 'heat 1995', status: 'queued', title: 'Heat', year: 1995, requester: 'Mommy' };
store.set('pending', [{
  jobKey: 'HEAT1:tt0113277', msgId: 'HEAT1', msgKey: { id: 'HEAT1', remoteJid: REQ }, chatJid: REQ,
  movie: { title: 'Heat', year: 1995, imdbId: 'tt0113277', rated: 'R' }, meta: {}, at: 1, record,
}]);
store.set('history', [{ ...record }]);

console.log('=== one failed lookup as the bot starts ===');
const realResume = moviePlugin._resume;
let blips = 1;
moviePlugin._resume = async function (c, p, o) {
  if (blips-- > 0) throw new Error('Jellyfin (jf.test:8096): fetch failed');
  return realResume.call(this, c, p, o);
};
try {
  await moviePlugin.recoverPending(ctx, { leftover: new Set(['HEAT1:tt0113277']) });
  moviePlugin.reconcileHistory(ctx);
  ok(jobs.length === 0 && (store.get('pending') ?? []).map((p) => p.jobKey).join() === 'HEAT1:tt0113277',
    'not queued yet, but back in the journal');
  ok(finishedOutput(work())?.outPath === kept && fs.existsSync(kept), 'with its finished file kept, not deleted');
  ok(moviePlugin._retries.isWaiting('HEAT1:tt0113277'), 'and a retry booked in this process');
  // Where it is - its finished file is kept, so it is to be sent - and not
  // 🔄, which a member read as "send it again" (Iron Man 3, 2026-10-11).
  ok(reacts.includes('HEAT1 ⬆️') && !reacts.some((r) => r.endsWith('🔄')),
    `the member sees ⬆️, the stage it is at, not 🔄 (${reacts.join(', ')})`);
  ok((store.get('history') ?? [])[0]?.status === 'queued', 'its History row stays queued, not "lost"');
  ok(logs.some((l) => /could not resume "Heat" yet \(Jellyfin \(jf\.test:8096\): fetch failed\) - trying again \(attempt 1 of 3\)/.test(l)),
    'the log says it will try again');

  await tick(80);
  ok(jobs.length === 1 && jobs[0].meta?.jobKey === 'HEAT1:tt0113277' && jobs[0].meta?.retry === 1,
    'the retry puts it in the queue');
} finally {
  moviePlugin._resume = realResume;
}

console.log('=== anything else is still dropped, as before ===');
{
  jobs.length = 0;
  store.set('pending', [{
    jobKey: 'GONE1:tt0000001', msgId: 'GONE1', msgKey: null, chatJid: REQ,
    movie: { title: 'Not On The Server', year: 1990, imdbId: 'tt0000001', rated: 'PG' }, meta: {}, at: 1,
    record: { id: 'GONE1', status: 'queued', title: 'Not On The Server', year: 1990 },
  }]);
  await moviePlugin.recoverPending(ctx, { leftover: new Set(['GONE1:tt0000001']) });
  ok(jobs.length === 0 && !(store.get('pending') ?? []).length && !moviePlugin._retries.isWaiting('GONE1:tt0000001'),
    'a film no longer in the library leaves the journal and is not retried');
}

moviePlugin._retries.clear();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
