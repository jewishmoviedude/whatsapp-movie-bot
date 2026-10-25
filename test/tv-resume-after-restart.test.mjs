/* An episode interrupted by a restart goes on from where it stopped.
   Run: node test/tv-resume-after-restart.test.mjs

   A season is resumed an episode at a time: One Piece season 17, 118
   episodes of about 250 MB each, journalled per request. The operator,
   2026-09-29, of The Parent Trap - downloaded, 23 minutes into its encode,
   and started over from the first byte by a restart, twice: "if bot gets
   interrupted it should be able to continue where left off and not need to
   start over from step 1". An episode did the same: its download went with
   the start-up sweep, its finished file too unless a lost send had
   journalled it, and a restart between two groups posted it to the first
   one again.

   Each case runs the episode in a process of its own, kills it with SIGKILL
   at the step named (test/fixtures/killable-job.mjs), and runs it again in
   this process as the next start would - the start-up sweep, then
   recovery (recoverPending) and the jobs it queues. The library is a local
   server standing in for Jellyfin (test/fixtures/restart-kit.mjs).

   Found in review of that work, and pinned here: an episode posted just
   before a restart was checked against the library before anything else,
   and a changed or missing file reset its work - the record of where it had
   been posted with it - so it was fetched and posted again, or failed; and
   its work, with that record, was deleted before the journal's removal was
   saved, so a kill in that half second posted it again at the next start. */
import './fixtures/roomy-disk.mjs';
import fs from 'node:fs';
import path from 'node:path';
import tvPlugin from '../src/plugins/tv-requests/index.js';
import { RetryBook, finishedOutput } from '../src/media/resume.js';
import {
  openWork, workKey, jobDirName, sweepWorkDir, liveWorkDirs, isSafeToDeleteIn, forgetThisProcess,
} from '../src/media/work-files.js';
import { makeKit, sleep } from './fixtures/restart-kit.mjs';
import { stageSems, STAGE_PRIORITY } from '../src/media/stages.js';
import { StateStore } from '../src/core/state.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const kit = await makeKit('tv-restart', { filmBytes: 2 * 1024 * 1024 });
const { WORK, server } = kit;
const isSafe = (p) => isSafeToDeleteIn(p, { workDir: WORK });
const A = 'tv-a@g.us';
const B = 'tv-b@g.us';

const config = {
  tvRequests: { postsGroups: [A, B] },
  movieRequests: {
    reactions: { redo: '🔄', failed: '⚠️', done: '✅', cancelled: '❌', skipped: '⏭️', downloading: '⬇️', converting: '⚙️', sending: '⬆️' },
    notify: {},
  },
  library: { jellyfin: { baseUrl: kit.base, accessToken: 'TOK' } },
  media: { workDir: WORK, ffprobePath: kit.FFPROBE, ffmpegPath: kit.FFMPEG, maxOutputBytes: 1932735283, deleteAfterSend: true },
  whatsapp: { broadcastPacingMs: 0 },
};
const logs = [];
const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), debug() {} };

let n = 0;
/** One episode of One Piece season 17, journalled as its request journals it. */
function request() {
  n += 1;
  const reqKey = `tv-OP17-${n}`;
  const ep = { id: `op-17-${n}`, series: 'One Piece', season: 17, episode: n, title: `Ep ${n}`, size: server.body.length };
  const store = kit.loadStore();
  store.set('pending', [...store.get('pending', []), {
    reqKey, label: 'One Piece season 17', episodes: [ep], msgId: `OP${n}`, msgKey: { remoteJid: 'req@g.us', id: `OP${n}` }, chatJid: 'req@g.us',
  }]);
  return { reqKey, ep, spec: { kind: 'tv', config, ep, reqKey } };
}
/** Only this request journalled: recovery resumes whatever the journal holds. */
function only(r) {
  const store = kit.loadStore();
  store.set('pending', (store.get('pending', []) ?? []).filter((q) => r && q.reqKey === r.reqKey));
}
function fakeBot() {
  const bot = {
    sent: [], reacted: [],
    isConnected: () => true, react: async (m, e) => { bot.reacted.push(e); return true; }, sendText: async () => ({}),
    groups: () => [], groupMemberInfo: () => ({ isMember: false }), on() {}, off() {},
    sendDocument: async (jid, file) => { bot.sent.push({ jid, file, bytes: fs.readFileSync(file) }); return {}; },
  };
  return bot;
}
const job = (o = {}) => ({ id: `j${Math.random().toString(16).slice(2, 8)}`, signal: new AbortController().signal,
  progress() {}, isCancelled: () => false, cancelReason: () => null, ...o });
function restart() {
  forgetThisProcess();
  const store = kit.loadStore();
  sweepWorkDir(WORK, { all: true, live: liveWorkDirs({ movie: [], tv: store.get('pending', []) }), isSafe, log });
  return { bot: fakeBot(), store, queue: { pending: [], active: new Map(), on() {}, off() {}, add() { return 'q'; } }, log, config };
}
const outcome = [];
const notifier = { stage() {}, episodeDone: () => outcome.push('done'), episodeFailed: () => outcome.push('failed'), episodeCancelled: (s) => outcome.push(s ?? 'cancelled') };
async function resume(ctx, r, jobOpts = {}) {
  tvPlugin._retries = new RetryBook({ delayMs: () => 3_600_000, log });
  try {
    await tvPlugin.deliverEpisode({
      ep: r.ep, ctx, job: job(jobOpts), msg: null, react: async () => {}, notifier, reqKey: r.reqKey, isLast: true, index: 0, total: 1,
    });
    return null;
  } catch (e) { return e; }
}
/** Recovery, as a start runs it, and then the episodes it queued, as the queue would run them. */
async function recover(ctx) {
  const added = [];
  ctx.queue = { pending: [], active: new Map(), on() {}, off() {}, add(j) { added.push(j); return `q${added.length}`; } };
  tvPlugin._retries = new RetryBook({ delayMs: () => 3_600_000, log });
  tvPlugin._live = new Map();
  tvPlugin._reactors = null;
  await tvPlugin.recoverPending(ctx);
  let err = null;
  for (const j of added) {
    try { await j.run(job()); } catch (e) { err ??= e; }
  }
  tvPlugin._retries.clear();
  return { added, err };
}
const workOf = (r) => openWork({ workDir: WORK, key: workKey.tv(r.reqKey, r.ep.id), isSafe });
const dirOf = (r) => path.join(WORK, jobDirName(workKey.tv(r.reqKey, r.ep.id)));
const journalled = (store, r) => (store.get('pending', []) ?? []).some((q) => q.reqKey === r.reqKey && q.episodes?.some((e) => e.id === r.ep.id));
const reset = () => {
  server.requests.length = 0;
  for (const f of ['PROBES', 'RUNS', 'events.log']) fs.rmSync(kit.flag(f), { force: true });
  logs.length = 0;
  outcome.length = 0;
};

console.log('=== an episode restarted mid-download resumes with Range ===');
{
  reset();
  const r = request();
  const part = () => { try { return fs.statSync(path.join(dirOf(r), 'source.mkv.part')).size; } catch { return 0; } };
  server.slow = 64 * 1024;
  const first = await kit.runChild(r.spec, { killWhen: () => part() >= 512 * 1024 });
  server.slow = false;
  const had = part();
  ok(first.killed && had >= 512 * 1024 && had < server.body.length, `killed with ${had} bytes of it downloaded`);
  const ctx = restart();
  const err = await resume(ctx, r);
  const dl = kit.downloads();
  ok(!err && dl.length === 2 && dl[1].range === `bytes=${had}-` && dl[1].ifRange === server.lastModified,
    `after the restart it asks for the rest (${dl.map((d) => d.range ?? 'all').join(', ')})`);
  ok(ctx.bot.sent.length === 2 && ctx.bot.sent.every((s) => Buffer.compare(s.bytes, server.body) === 0), 'and posts the whole episode');
}

console.log('=== an episode that gives way to a movie keeps its partial and resumes it ===');
{
  reset();
  const r = request();
  const ctx = restart();
  const part = () => { try { return fs.statSync(path.join(dirOf(r), 'source.mkv.part')).size; } catch { return 0; } };
  server.slow = 64 * 1024;
  const running = resume(ctx, r);
  while (part() < 512 * 1024) await sleep(10);
  // A film wants the download slot: the episode gives it up.
  const movie = stageSems.download.acquire(STAGE_PRIORITY.movie, 'Heat (1995)');
  await movie;
  const had = part();
  server.slow = false;
  ok(had >= 512 * 1024 && logs.some((l) => /gave the download slot to a movie — will restart from where it stopped/.test(l)),
    `the episode gave way with ${had} bytes, and kept them`);
  await sleep(50);
  stageSems.download.release('Heat (1995)');
  const err = await running;
  const dl = kit.downloads();
  ok(!err && dl.length === 2 && Number(/^bytes=(\d+)-$/.exec(dl[1].range ?? '')?.[1]) >= had && kit.probes().length === 0,
    `and went on from them once the film was done with the slot (${dl.map((d) => d.range ?? 'all').join(', ')})`);
  ok(ctx.bot.sent.length === 2 && ctx.bot.sent.every((s) => Buffer.compare(s.bytes, server.body) === 0), 'the episode posted is whole');
}

console.log('=== an episode killed mid-encode goes on from its download, and says so ===');
{
  reset();
  const r = request();
  kit.slowEncode(true);
  const first = await kit.runChild(r.spec, { killWhen: kit.encoding });
  kit.slowEncode(false);
  ok(first.killed && workOf(r).manifest.source?.state === 'complete', 'killed while converting, with its download whole');
  only(r);
  const ctx = restart();
  const { added, err } = await recover(ctx);
  ok(added.length === 1 && !err && ctx.bot.sent.length === 2 && kit.downloads().length === 1,
    `recovery puts it back, and it is posted from the download it had (${kit.downloads().length} download)`);
  // The stage it is at as it is picked back up, never 🔄, which a member
  // read as "send it again" (Iron Man 3, 2026-10-11); its own ⚙️ is not
  // sent twice (_sameTwiceSkipped).
  const R = ctx.bot.reacted;
  ok(R[0] === '⚙️' && !R.includes('🔄') && !R.includes('⬇️') && R.filter((e) => e === '⚙️').length === 1 && R.at(-1) === '✅',
    `its message shows ⚙️, the stage it is at, and never 🔄 or ⬇️ (${R.join(' ')})`);
}

console.log('=== an episode encoded before a restart is sent after it without downloading or encoding again ===');
{
  // As a film (the operator, 2026-09-30: "files should remain in their
  // folders until fully sent on whatsapp").
  reset();
  const r = request();
  const first = await kit.runChild({ ...r.spec, send: 'hang' }, { killWhen: () => kit.events().some((e) => e.sending) });
  ok(first.killed && kit.count('RUNS') === 1 && finishedOutput(workOf(r))?.size === server.body.length,
    'killed during its upload, with the finished episode in its work');
  const name = path.basename(dirOf(r));
  ok(kit.listWork().sort().join() === [`${name}/output.mp4`, `${name}/source.mkv`].join(),
    `and the download it was made from beside it (${kit.listWork().join(', ')})`);
  only(r);
  const ctx = restart();
  const probes = kit.count('PROBES');
  const { err } = await recover(ctx);
  ok(!err && ctx.bot.sent.map((s) => s.jid).join() === `${A},${B}` && Buffer.compare(ctx.bot.sent[0].bytes, server.body) === 0,
    'after the restart it is posted to both groups, once each');
  ok(kit.count('RUNS') === 1 && kit.count('PROBES') === probes && kit.downloads().length === 1 && kit.probes().length === 1,
    `without converting or downloading it again - the library is only asked whether it is the same file (${kit.probes().length} probe)`);
  ok(!journalled(ctx.store, r) && !fs.existsSync(dirOf(r)), 'out of the journal; its work gone');
  const R = ctx.bot.reacted;
  ok(R[0] === '⬆️' && !R.includes('🔄') && !R.includes('⬇️') && !R.includes('⚙️'), `its message shows ⬆️, the stage it is at - no 🔄, ⬇️ or ⚙️ (${R.join(' ')})`);
}

console.log('=== posted to one of two groups before the restart: posted only to the other ===');
{
  reset();
  const r = request();
  const first = await kit.runChild({ ...r.spec, send: { [A]: 'ok', [B]: 'hang' } }, {
    killWhen: () => kit.events().some((e) => e.sending === B),
  });
  ok(first.killed && kit.events().filter((e) => e.sent).map((e) => e.sent).join() === A, 'the first process posted it to the first group, and was killed on the second');
  ok((workOf(r).manifest.sent?.to ?? []).join() === A, 'its work records the group it was posted to');
  const ctx = restart();
  const err = await resume(ctx, r);
  ok(!err && ctx.bot.sent.map((s) => s.jid).join() === B, `after the restart it is posted only to the other (${ctx.bot.sent.map((s) => s.jid).join()})`);
  ok(logs.some((l) => /was posted to 1 of its 2 group\(s\) before the restart - posting it to the rest/.test(l)), 'and the log says so');
  ok(outcome.join() === 'done' && !fs.existsSync(dirOf(r)), 'it counts as posted, and its work is gone');
}

console.log('=== an episode posted to every group before the restart is not posted again ===');
{
  const killedOnDone = async () => {
    reset();
    const r = request();
    await kit.runChild({ ...r.spec, hangOnReact: '✅' }, { killWhen: () => kit.events().some((e) => e.react === '✅') });
    only(r);
    return r;
  };
  {
    const r = await killedOnDone();
    const ctx = restart();
    ok(journalled(ctx.store, r), 'killed after posting it everywhere, before the journal could say so');
    const { err } = await recover(ctx);
    ok(!err && ctx.bot.sent.length === 0 && !journalled(ctx.store, r), 'the restart posts nothing, and finishes it');
    const R = ctx.bot.reacted;
    ok(R.at(-1) === '✅' && !R.some((e) => ['⬇️', '⚙️', '⬆️'].includes(e)), `its message ends on ✅, with no step shown again (${R.join(' ')})`);
  }
  // The library moved on meanwhile. It used to be asked first: its answer
  // reset the work - the record of where it was posted with it - and the
  // episode was fetched and posted again, or failed trying.
  {
    const r = await killedOnDone();
    ok((kit.loadStore().get('pending')[0]?.episodes?.[0]?.sentTo ?? []).join() === `${A},${B}`,
      'its journal entry says where it was posted');
    server.missing.add(`/Items/${r.ep.id}/Download`);
    const ctx = restart();
    const err = await resume(ctx, r);
    server.missing.clear();
    ok(!err && ctx.bot.sent.length === 0 && outcome.join() === 'done' && kit.downloads().length === 1,
      `its file now 404s: nothing is posted, nothing fetched, and it counts as posted (${outcome.join()})`);
  }
  {
    const r = await killedOnDone();
    const was = { body: server.body, lastModified: server.lastModified };
    server.body = Buffer.concat([server.body, Buffer.alloc(1024, 9)]);
    server.lastModified = new Date(Date.UTC(2026, 8, 29, 20, 0, 0)).toUTCString();
    const ctx = restart();
    const err = await resume(ctx, r);
    Object.assign(server, was);
    ok(!err && ctx.bot.sent.length === 0 && outcome.join() === 'done' && kit.downloads().length === 1,
      'its file has changed: nothing is fetched or posted again');
  }
  // Its work gone, and the journal still holding it: the journal says it
  // was posted too.
  {
    const r = await killedOnDone();
    fs.rmSync(dirOf(r), { recursive: true, force: true });
    const ctx = restart();
    const err = await resume(ctx, r);
    ok(!err && ctx.bot.sent.length === 0 && kit.downloads().length === 1, 'with its work gone, nothing is posted again');
  }
}

console.log('=== killed between the post and the journal\'s save: not posted twice ===');
{
  // The journal is saved half a second after a change, and never synced;
  // the episode's work - with the record of where it was posted - was
  // deleted before that. The store here is the real one, and what the next
  // start reads is what is on the disk the moment the episode has finished.
  reset();
  const file = path.join(kit.TMP, 'state-tv.json');
  const r = request();
  const entry = kit.loadStore().get('pending').find((q) => q.reqKey === r.reqKey);
  only(null);
  const live = new StateStore(file);
  live.namespace('tv-requests').set('pending', [entry]);
  live.flush();
  forgetThisProcess();
  const ctx = { ...restart(), store: live.namespace('tv-requests') };
  const err = await resume(ctx, r);
  ok(!err && ctx.bot.sent.length === 2, 'the episode is posted to both groups');
  forgetThisProcess();
  const next = new StateStore(file).namespace('tv-requests');
  const left = (next.get('pending', []) ?? []).flatMap((q) => q.episodes ?? []);
  sweepWorkDir(WORK, { all: true, live: liveWorkDirs({ movie: [], tv: next.get('pending', []) ?? [] }), isSafe, log });
  const after = { ...ctx, bot: fakeBot(), store: next };
  for (const ep of left) await resume(after, { ...r, ep });
  ok(after.bot.sent.length === 0, `the next start posts nothing (${left.length} journalled, ${after.bot.sent.length} posted)`);
}

console.log('=== an episode\'s work is deleted however it ends ===');
{
  reset();
  const ends = [];
  // Posted.
  { const r = request(); const ctx = restart(); await resume(ctx, r); ends.push(['posted', r]); }
  // Failed for good.
  {
    const r = request();
    const ctx = restart();
    ctx.config = { ...config, media: { ...config.media, ffmpegPath: '/bin/false' } };
    const err = await resume(ctx, r);
    ok(/ffmpeg exited 1/.test(err?.message ?? '') && outcome.at(-1) === 'failed', 'an episode the encoder fails on fails');
    ends.push(['failed', r]);
  }
  // Skipped from the panel while it ran.
  {
    const r = request();
    const ctx = restart();
    let calls = 0;
    await resume(ctx, r, { isCancelled: () => (calls++ > 1), cancelReason: () => 'skipped' });
    ok(outcome.at(-1) === 'skipped', 'an episode skipped while it ran is skipped');
    ends.push(['skipped', r]);
  }
  // Lost its send and waiting on a retry, then cancelled with its request.
  {
    const r = request();
    const ctx = restart();
    ctx.bot.sendDocument = async () => { throw new Error('Connection Closed'); };
    tvPlugin._retries = new RetryBook({ delayMs: () => 3_600_000, log });
    await tvPlugin.deliverEpisode({ ep: r.ep, ctx, job: job(), msg: null, react: async () => {}, notifier, reqKey: r.reqKey, isLast: true, index: 0, total: 1 })
      .catch(() => {});
    ok(finishedOutput(workOf(r)) && tvPlugin._retries.isWaiting(`${r.reqKey}:${r.ep.id}`), 'an episode that lost its send keeps its work for the retry');
    tvPlugin._dropBookedRetries(ctx, r.reqKey, 'cancelled');
    ends.push(['cancelled with its request, while its retry waited', r]);
  }
  // Resumed after a restart with its work, and cancelled with its request
  // while it waited in the queue.
  {
    const r = request();
    await kit.runChild({ ...r.spec, send: 'hang' }, { killWhen: () => kit.events().some((e) => e.sending) });
    const ctx = restart();
    ok(fs.existsSync(dirOf(r)), 'an episode killed at its upload has its work after the restart');
    tvPlugin._discarder(ctx, { reqKey: r.reqKey, label: 'One Piece season 17', notifier })(r.ep)('cancelled');
    ends.push(['cancelled with its request, waiting in the queue after a restart', r]);
  }
  for (const [how, r] of ends) ok(!fs.existsSync(dirOf(r)), `${how}: no work directory`);
  tvPlugin._retries?.clear();
}

await sleep(10);
kit.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
