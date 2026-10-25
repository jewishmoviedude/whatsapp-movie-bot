/* A film already waiting or in progress for a group is not queued for it again, and a restart runs a film journalled twice once.
   Run: node test/film-duplicate-request.test.mjs

   The incident, 2026-09-28: Aaron asked for "minority report 2002" at 14:38,
   16:27 and 17:09 EDT while it kept failing, and every request was queued.
   Two copies ran at once - two 4.75 GB downloads on a disk that filled that
   evening - and the film was posted twice. The live journal still held two
   Minority Report jobs afterwards, which the next restart would have run
   side by side again. The TV side answers a season asked for twice with 🎬,
   "already in the queue, not added again" and a "duplicate" History row
   (tv-duplicate-request); films had no check at all.

   Since 2026-09-29 a duplicate is answered 🤥 (reactions.duplicate) rather
   than 🎬, at the operator's request, so a repeat is told apart from a fresh
   request - on films and TV alike.

   The film is not queued a second time whatever the beta mode - that is the
   fix. What the notifications group is told is new text, so it is staged
   through the beta group (movie-duplicate-notice): Off, the "added to the
   queue" line the request was always given.

   Since 2026-10-11 🤥 is for a DIFFERENT member asking for a film already
   queued for the group. The member it is queued for, sending it again, is
   shown where it is instead, and their row is not a duplicate
   (test/no-redo-reaction.test.mjs): a restart had put 🔄 on Ethan
   Adams's "Iron Man 3 2013", he sent it again, and was answered 🤥. So
   each member here has a number of their own, as on WhatsApp. */
import './fixtures/roomy-disk.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import { RetryBook } from '../src/media/resume.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const REQ = 'movie-requests@g.us';
const POSTS = 'movie-posts@g.us';
const NOTIFY = 'movie-notify@g.us';
const TESTING = '120363900000000013@g.us';
const BETA_POSTS = '120363900000000014@g.us';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'film-dup-'));
const LIB = path.join(TMP, 'lib');
const WORK = path.join(TMP, 'work');
fs.mkdirSync(LIB); fs.mkdirSync(WORK);
fs.writeFileSync(path.join(LIB, 'Minority Report (2002).mp4'), 'not really a film');
fs.writeFileSync(path.join(LIB, 'Heat (1995).mp4'), 'not really a film');
const FFPROBE = path.join(TMP, 'ffprobe');
fs.writeFileSync(FFPROBE, `#!/bin/sh
cat <<'JSON'
{"streams":[{"codec_type":"video","codec_name":"h264","width":1280,"height":720},{"codec_type":"audio","codec_name":"aac","channels":2}],"format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"60","size":"17"}}
JSON
`, { mode: 0o755 });

const FILMS = {
  minority: { Title: 'Minority Report', Year: '2002', Rated: 'PG-13', imdbID: 'tt0181689' },
  heat: { Title: 'Heat', Year: '1995', Rated: 'R', imdbID: 'tt0113277' },
};
let omdbDelayMs = 0;
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.hostname.includes('omdbapi')) {
    if (omdbDelayMs) await tick(omdbDelayMs);
    const q = String(u.searchParams.get('t') ?? u.searchParams.get('s') ?? '').toLowerCase();
    const f = Object.entries(FILMS).find(([k]) => q.includes(k))?.[1];
    const body = f ? { Response: 'True', Type: 'movie', ...f } : { Response: 'False', Error: 'Movie not found!' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 404 });
};

function config({ mode = 'off' } = {}) {
  return mergeDefaults({
    movieRequests: {
      requestGroups: [REQ], postsGroup: POSTS, notify: { group: NOTIFY }, cooldownSecondsPerUser: 0, blockedRatings: [],
      // The request rules this was written against, the defaults until 2026-10-12
      // (request-rule-defaults): no prefix needed, react only, 50 waiting.
      requirePrefix: false, replyOnBlock: false, maxQueueLength: 50,
    },
    omdb: { apiKey: 'test-key' },
    library: { provider: 'local', local: { roots: [LIB], extensions: ['.mp4'] } },
    media: { workDir: WORK, ffprobePath: FFPROBE, ffmpegPath: '/bin/false', deleteAfterSend: true },
    beta: { groups: [TESTING], postsGroup: BETA_POSTS, features: { 'movie-duplicate-notice': mode } },
    whatsapp: { broadcastPacingMs: 0 },
  }, DEFAULT_CONFIG);
}

function fakeStore(data = {}) {
  return { get: (k, d = null) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; }, push: (k, v) => { (data[k] ??= []).unshift(v); }, data };
}

function harness(cfg = config(), store = fakeStore()) {
  const out = [];
  const jobs = [];
  const bot = {
    connected: true,
    isConnected: () => bot.connected,
    react: async (msg, emoji) => { out.push({ op: 'react', id: msg.id, emoji }); return true; },
    sendText: async (jid, body) => { out.push({ op: 'text', jid, body }); return { key: { id: 'sent' } }; },
    sendDocument: async (jid, file, opts) => { out.push({ op: 'document', jid, file: opts?.fileName }); return {}; },
    deleteMessage: async () => {}, archiveChat: async () => {}, isGroupAdmin: () => false,
    groupMemberInfo: () => ({ isMember: false }), groups: () => [], on() {}, off() {},
  };
  const queue = {
    maxLength: 50, pending: [], active: new Map(), on() {}, off() {},
    add(j) { jobs.push(j); this.pending.push({ id: `job-${jobs.length}`, kind: 'movie', meta: j.meta }); return `job-${jobs.length}`; },
    moveTop() { return true; },
    snapshot() { return { pending: [], active: [] }; },
  };
  const ctx = { config: cfg, store, bot, queue, log: { info() {}, warn() {}, error() {}, debug() {} }, configStore: { update() {} } };
  return { ctx, out, jobs, store };
}

let seq = 0;
// One number each: the same number is the same member (requestMemberKey).
const NUMBERS = {
  Aaron: { senderNumber: '15558150192', senderNumberDisplay: '+1 (555) 815-0192' },
  Mia: { senderNumber: '15558150171', senderNumberDisplay: '+1 (555) 815-0171' },
  Mommy: { senderNumber: '15558150172', senderNumberDisplay: '+1 (555) 815-0172' },
};
const ask = (text, { chatJid = REQ, who = 'Aaron' } = {}) => {
  const id = `MSG${++seq}`;
  return {
    id, key: { id, remoteJid: chatJid }, text, chatJid, isGroup: true, fromMe: false, messageType: 'conversation',
    senderJid: `${who}@lid`, ...NUMBERS[who] ?? NUMBERS.Aaron, pushName: who, timestamp: Date.now(),
  };
};
const job = () => ({ id: `j${++seq}`, progress() {}, isCancelled: () => false, cancelReason: () => null });
const rowOf = (store, id) => (store.data.history ?? []).find((h) => h.id === id);
const notes = (out, jid = NOTIFY) => out.filter((e) => e.op === 'text' && e.jid === jid).map((e) => e.body);

moviePlugin._reactors = new Map();                    // normally made by setup()

console.log('=== the incident: the same film asked for again while it waits is not queued again ===');
{
  const { ctx, out, jobs, store } = harness();
  const first = ask('minority report 2002');
  await moviePlugin.onMessage(first, ctx);
  ok(jobs.length === 1 && store.data.pending.length === 1, 'the first request is queued');

  // Aaron asking again is his own request sent again: not queued, and
  // shown where it is rather than 🤥 (test/no-redo-reaction.test.mjs).
  const again = ask('minority report 2002');
  out.length = 0;
  await moviePlugin.onMessage(again, ctx);
  ok(jobs.length === 1 && store.data.pending.length === 1, 'the second is not: one job, one journal entry');
  ok(!out.some((e) => e.op === 'react' && e.id === again.id && e.emoji === '🤥') && rowOf(store, again.id)?.status === 'resent',
    'asked again by Aaron, whose request it is: no 🤥, and History says resent');

  // Somebody else asking for it is the duplicate.
  const second = ask('minority report 2002', { who: 'Mia' });
  out.length = 0;
  await moviePlugin.onMessage(second, ctx);
  ok(jobs.length === 1 && store.data.pending.length === 1, 'nor is another member\'s: one job, one journal entry');
  ok(ctx.config.movieRequests.reactions.duplicate === '🤥'
    && out.some((e) => e.op === 'react' && e.id === second.id && e.emoji === '🤥')
    && !out.some((e) => e.op === 'react' && e.id === second.id && e.emoji === '🎬'),
    'the requester gets 🤥, the duplicate reaction, not the 🎬 of a fresh request');
  const row = rowOf(store, second.id);
  ok(row?.status === 'duplicate' && row.detail === 'already in the queue — waiting from an earlier request'
    && row.title === 'Minority Report' && row.year === 2002, 'History records it as a duplicate');
  ok(notes(out).join() === '🎬 Minority Report (2002) — added to the queue',
    `with the notice Off, the notifications group gets the line it always got (${notes(out).join(' | ')})`);
  ok(rowOf(store, first.id)?.status === 'queued', 'the first request is untouched');

  // Still a duplicate while it runs, and while a retry is booked for it:
  // both keep its journal entry.
  ctx.queue.pending.length = 0;
  ctx.queue.active.set('job-1', { meta: jobs[0].meta });
  await moviePlugin.onMessage(ask('minority report 2002'), ctx);
  ok(jobs.length === 1, 'while it is being made, too');

  // Posted: nothing is waiting any more, and asking again is a new request.
  ctx.queue.active.clear();
  await jobs[0].run(job());
  ok(out.some((e) => e.op === 'document' && e.jid === POSTS) && !store.data.pending.length, 'the first copy is posted');
  await moviePlugin.onMessage(ask('minority report 2002'), ctx);
  ok(jobs.length === 2, 'once it is posted, asking again queues it again (a re-post is somebody else\'s decision)');
}

console.log('=== with the notice on, the line says what happened ===');
{
  const { ctx, out, jobs } = harness(config({ mode: 'on' }));
  await moviePlugin.onMessage(ask('heat 1995'), ctx);
  out.length = 0;
  await moviePlugin.onMessage(ask('heat 1995', { who: 'Mia' }), ctx);
  ok(jobs.length === 1 && notes(out).join() === '🤥 Heat (1995) — already in the queue, not added again',
    `"already in the queue, not added again", whoever asked the first time (${notes(out).join(' | ')})`);
}

console.log('=== on Beta, only a beta group\'s duplicate is told so ===');
{
  // Since 2026-09-29 a beta-group request is a test that queues nothing
  // (beta.js), so "asked for twice" is tried against the REAL queue: a film a
  // member asked for, tested again under $beta004.
  const { ctx, out, jobs, store } = harness(config({ mode: 'beta' }));
  const real = ask('heat 1995');
  await moviePlugin.onMessage(real, ctx);
  ok(jobs.length === 1, 'a member\'s request is queued');
  out.length = 0;
  const test = ask('$beta004 heat 1995', { chatJid: TESTING });
  await moviePlugin.onMessage(test, ctx);
  await moviePlugin.onMessage(ask('heat 1995', { who: 'Mia' }), ctx);
  ok(jobs.length === 1, 'asked again, by the test and in the main group, it is a duplicate of the waiting copy');
  ok(out.some((e) => e.op === 'react' && e.id === test.id && e.emoji === '🤥'), 'the test gets 🤥');
  ok(notes(out, TESTING).some((b) => /Heat \(1995\) — already in the queue, not added again/.test(b)),
    'the beta group\'s duplicate gets the new line, in the beta group');
  ok(notes(out).join() === '🎬 Heat (1995) — added to the queue' && !notes(out).some((b) => /not added again/.test(b)),
    'the main group\'s gets the line it always got');
  ok(rowOf(store, test.id)?.status === 'duplicate' && rowOf(store, test.id)?.beta === true, 'History: a beta duplicate row');
  // The test is over once answered: the real job's outcome is not reported
  // on the test's row, nor in the beta group.
  await jobs[0].run(job());
  ok(rowOf(store, test.id)?.status === 'duplicate' && !out.some((e) => e.op === 'document' && e.jid !== POSTS),
    'when the real film is posted, the test\'s row is left as it was, and nothing goes to the beta group');
}

console.log('=== two requests at once: one is queued ===');
{
  const { ctx, jobs, store } = harness();
  omdbDelayMs = 15;
  const a = ask('heat 1995');
  const b = ask('heat 1995', { who: 'Mia' });
  await Promise.all([moviePlugin.onMessage(a, ctx), moviePlugin.onMessage(b, ctx)]);
  omdbDelayMs = 0;
  ok(jobs.length === 1 && store.data.pending.length === 1, 'arriving together, through every lookup at once, the film is queued once');
  ok([rowOf(store, a.id)?.status, rowOf(store, b.id)?.status].sort().join() === 'duplicate,queued', 'and the other is the duplicate');
}

console.log('=== a different film, or the same title in another year, is not a duplicate ===');
{
  const { ctx, jobs } = harness();
  await moviePlugin.onMessage(ask('heat 1995'), ctx);
  await moviePlugin.onMessage(ask('minority report 2002'), ctx);
  ok(jobs.length === 2, 'two films, two jobs');
}

console.log('=== a film whose retries ran out is queued when asked for again, and its old job is let go ===');
{
  const { ctx, out, jobs, store } = harness();
  moviePlugin._retries = new RetryBook({ max: 0 });     // nothing left to try in this process
  const first = ask('minority report 2002');
  await moviePlugin.onMessage(first, ctx);
  ctx.bot.connected = false;
  await jobs[0].run(job()).catch(() => {});
  ctx.bot.connected = true;
  ctx.queue.pending.length = 0;
  ok(store.data.pending.length === 1 && rowOf(store, first.id)?.status === 'interrupted',
    'it failed transiently with no retries left: journalled for the next start, and nothing runs it before then');
  out.length = 0;
  const again = ask('minority report 2002');
  await moviePlugin.onMessage(again, ctx);
  ok(jobs.length === 2 && rowOf(store, again.id)?.status === 'queued', 'asking again queues it now, rather than waiting for a restart');
  ok(store.data.pending.length === 1 && store.data.pending[0].msgId === again.id,
    'and the old job leaves the journal, or the next start would post it a second time');
  ok(rowOf(store, first.id)?.status === 'duplicate' && /newer request takes it/.test(rowOf(store, first.id)?.detail ?? ''),
    'its row says the newer request took its place');
  moviePlugin._retries = null;
}

console.log('=== a restart runs a film journalled twice once ===');
{
  const store = fakeStore();
  const entry = (id, who, at) => ({
    jobKey: `${id}:tt0181689`, msgId: id, msgKey: { id, remoteJid: REQ }, chatJid: REQ,
    movie: { title: 'Minority Report', year: 2002, imdbId: 'tt0181689', rated: 'PG-13' },
    meta: { requester: who }, at,
    record: { id, request: 'minority report 2002', status: 'queued', title: 'Minority Report', year: 2002, requester: who },
  });
  // The live journal, 2026-09-28 21:1x UTC: two Minority Report jobs.
  store.set('pending', [entry('AC8347C9', 'Aaron', 1), entry('ACDACFAA', 'Aaron', 2)]);
  store.set('history', [{ ...entry('AC8347C9', 'Aaron').record }, { ...entry('ACDACFAA', 'Aaron').record }]);
  const { ctx, jobs, out } = harness(config(), store);
  const leftover = new Set(store.data.pending.map((p) => p.jobKey));
  await moviePlugin.recoverPending(ctx, { leftover });
  ok(jobs.length === 1 && jobs[0].meta?.jobKey === 'AC8347C9:tt0181689', 'the earlier request is resumed, and only it');
  // Not 🔄 (2026-10-11, Iron Man 3): where it is. Nothing of it done yet,
  // and the queue shows it neither waiting nor running: 🎬.
  ok(out.some((e) => e.op === 'react' && e.id === 'AC8347C9' && e.emoji === '🎬') && !out.some((e) => e.emoji === '🔄'),
    'a film not waiting for a place (it started, or the queue shows none) is shown where it is - 🎬, nothing done yet - never 🔄');
  ok(store.data.pending.map((p) => p.msgId).join() === 'AC8347C9', 'the journal holds the one');
  ok(rowOf(store, 'ACDACFAA')?.status === 'duplicate' && /not resumed twice after a restart/.test(rowOf(store, 'ACDACFAA')?.detail ?? ''),
    'the other\'s History row says why it was not resumed');
}

console.log('=== nor when a request since the start has it already ===');
{
  const store = fakeStore();
  const old = {
    jobKey: 'OLD:tt0113277', msgId: 'OLD', msgKey: null, chatJid: REQ,
    movie: { title: 'Heat', year: 1995, imdbId: 'tt0113277', rated: 'R' }, meta: {}, at: 1,
    record: { id: 'OLD', request: 'heat 1995', status: 'queued', title: 'Heat', year: 1995 },
  };
  store.set('pending', [old]);
  const { ctx, jobs } = harness(config(), store);
  const leftover = new Set(['OLD:tt0113277']);
  // Before the connect, someone asks for it: the leftover is journalled, so
  // that is a duplicate; and a panel re-run journalled since then is not
  // resumed over either.
  const early = ask('heat 1995');
  await moviePlugin.onMessage(early, ctx);
  ok(jobs.length === 0 && rowOf(store, early.id)?.status === 'duplicate',
    'a request before recovery has run finds the leftover waiting, and is a duplicate');
  store.set('pending', [old, { ...old, jobKey: 'NEW:tt0113277', msgId: 'NEW', record: { ...old.record, id: 'NEW' } }]);
  await moviePlugin.recoverPending(ctx, { leftover });
  ok(jobs.length === 0 && store.data.pending.map((p) => p.msgId).join() === 'NEW',
    'the leftover is not resumed over a job journalled since the start');
}

console.log('=== a request arriving while recovery puts the films back is a duplicate ===');
{
  const store = fakeStore();
  const mk = (id, key, title, year, imdbId) => ({
    jobKey: `${id}:${imdbId}`, msgId: id, msgKey: null, chatJid: REQ, movie: { title, year, imdbId, rated: 'PG-13' }, meta: {}, at: 1,
    record: { id, request: title, status: 'queued', title, year },
  });
  store.set('pending', [mk('A', 'a', 'Heat', 1995, 'tt0113277'), mk('B', 'b', 'Minority Report', 2002, 'tt0181689')]);
  const { ctx, jobs } = harness(config(), store);
  const leftover = new Set(store.data.pending.map((p) => p.jobKey));
  const realResume = moviePlugin._resume;
  let asked = null;
  moviePlugin._resume = async function (c, p, o) {
    // Heat is being put back; Minority Report is out of the journal and not
    // back in yet - the moment a new request used to slip through.
    if (p.msgId === 'A' && !asked) {
      asked = ask('minority report 2002');
      await moviePlugin.onMessage(asked, ctx);
    }
    return realResume.call(this, c, p, o);
  };
  try { await moviePlugin.recoverPending(ctx, { leftover }); } finally { moviePlugin._resume = realResume; }
  ok(jobs.length === 2 && rowOf(store, asked.id)?.status === 'duplicate',
    'it is answered as a duplicate, and both films are resumed, once each');
}

console.log('=== a film resumed after a restart is still queued, not "lost" ===');
{
  // reconcileHistory matched History rows on `${id}:${imdbId ?? title}`, but
  // a History row never carries the imdbId the jobKey is built from: every
  // film resumed after a restart - queued and journalled - was marked
  // "lost", which the hourly check calls re-runnable (review scenario
  // a-lost-rerun, Minority Report AC8347C9).
  const store = fakeStore();
  const rec = { id: 'AC8347C9', request: 'minority report 2002', status: 'queued', title: 'Minority Report', year: 2002, requester: 'Aaron' };
  store.set('pending', [{
    jobKey: 'AC8347C9:tt0181689', msgId: 'AC8347C9', msgKey: { id: 'AC8347C9', remoteJid: REQ }, chatJid: REQ,
    movie: { title: 'Minority Report', year: 2002, imdbId: 'tt0181689', rated: 'PG-13' }, meta: {}, at: 1, record: rec,
  }]);
  store.set('history', [{ ...rec }, { id: 'GONE', request: 'heat', status: 'queued', title: 'Heat', year: 1995 }]);
  const { ctx, jobs } = harness(config(), store);
  await moviePlugin.recoverPending(ctx, { leftover: new Set(['AC8347C9:tt0181689']) });
  moviePlugin.reconcileHistory(ctx);
  ok(jobs.length === 1 && rowOf(store, 'AC8347C9')?.status === 'queued',
    `the resumed film's row stays queued (${rowOf(store, 'AC8347C9')?.status})`);
  ok(rowOf(store, 'GONE')?.status === 'lost', 'a row nothing journals any more is still marked lost');
}

console.log('=== a re-run from the panel or the box does not queue a film that is waiting ===');
{
  // The hourly check's requeue, the panel's Re-run and its bulk re-run (which
  // takes every "queued" and "interrupted" row too) all go through
  // requeue(), which had no duplicate check: the film was queued twice.
  const { ctx, jobs, store } = harness();
  const first = ask('minority report 2002');
  await moviePlugin.onMessage(first, ctx);
  ok(jobs.length === 1, 'a group request is queued');
  let err = null;
  try { await moviePlugin.requeue('minority report 2002', ctx, { requester: 'Aaron (re-run by the hourly check)' }); } catch (e) { err = e; }
  ok(err?.code === 'DUPLICATE' && /Minority Report \(2002\) is already in the queue/.test(err.message),
    `requeue refuses it, saying why (${err?.message})`);
  ok(jobs.length === 1 && store.data.pending.length === 1 && !(store.data.history ?? []).some((h) => /^manual-/.test(h.id)),
    'nothing queued, journalled or written to History');
  err = null;
  try {
    await moviePlugin.queueLibraryItem({ id: 'jf1', title: 'Minority Report', year: 2002, rated: 'PG-13' }, ctx);
  } catch (e) { err = e; }
  ok(err?.code === 'DUPLICATE' && jobs.length === 1, 'nor does queueing it from a Jellyfin link');
  const r = await moviePlugin.requeue('heat 1995', ctx, { requester: 'manual (admin)' });
  ok(r.title === 'Heat' && jobs.length === 2, 'a film that is not waiting is queued as before');
}

console.log('=== a duplicate hears how the film it followed ends ===');
{
  // Aaron's second and third "minority report" and another member's stayed
  // on 🎬 while the first went on to ✅ (review scenario m-triple-mr); with
  // the only copy failed, the duplicate's row still read "duplicate".
  const { ctx, out, jobs, store } = harness();
  const first = ask('minority report 2002');
  await moviePlugin.onMessage(first, ctx);
  const second = ask('minority report 2002', { who: 'Mommy' });
  await moviePlugin.onMessage(second, ctx);
  ok((store.data.pending[0]?.followers ?? []).map((f) => f.historyId).join() === second.id,
    'the duplicate is written on the film\'s journal entry, so a restart keeps it');
  // The only copy fails for good, at its send.
  ctx.bot.sendDocument = async () => { throw new Error('forbidden: not allowed to post in this group'); };
  let err = null;
  try { await jobs[0].run(job()); } catch (e) { err = e; }
  await tick();
  ok(!!err && out.some((e) => e.op === 'react' && e.id === second.id && e.emoji === ctx.config.movieRequests.reactions.failed),
    `the duplicate's message gets ⚠️ with the original's (${out.filter((e) => e.id === second.id).map((e) => e.emoji).join(' ')})`);
  const row = rowOf(store, second.id);
  ok(row?.status === 'failed' && /^failed, with an earlier request for it — /.test(row.detail ?? ''),
    `and its row reads failed, which the hourly check sees (${row?.detail})`);
  ok(!(store.data.pending ?? []).length, 'nothing is left journalled');
}

console.log('=== and when it is posted, or cancelled before it starts ===');
{
  const { ctx, out, jobs, store } = harness();
  // The library file is sent as it is (plan=copy): posted.
  const first = ask('heat 1995');
  await moviePlugin.onMessage(first, ctx);
  const second = ask('heat 1995', { who: 'Mommy' });
  await moviePlugin.onMessage(second, ctx);
  let err = null;
  try { await jobs[0].run(job()); } catch (e) { err = e; }
  await tick();
  ok(!err && out.some((e) => e.op === 'document'), `the film is posted (${err?.message ?? 'ok'})`);
  ok(out.some((e) => e.op === 'react' && e.id === second.id && e.emoji === ctx.config.movieRequests.reactions.done)
    && rowOf(store, second.id)?.status === 'sent', 'the duplicate gets ✅, and its row "sent"');

  const h2 = harness();
  const a = ask('minority report 2002');
  await moviePlugin.onMessage(a, h2.ctx);
  const b = ask('minority report 2002', { who: 'Mommy' });
  await moviePlugin.onMessage(b, h2.ctx);
  moviePlugin._cancelledWhileWaiting(h2.ctx, { meta: { jobKey: h2.store.data.pending[0].jobKey }, state: 'cancelled', label: 'Minority Report (2002)' });
  await tick();
  ok(h2.out.some((e) => e.op === 'react' && e.id === b.id && e.emoji === h2.ctx.config.movieRequests.reactions.cancelled)
    && rowOf(h2.store, b.id)?.status === 'cancelled', 'cancelled before it started: the duplicate gets ❌, and its row "cancelled"');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
