/* A request picked back up or retried shows where it is, never 🔄; a member sending their own request again is not 🤥.
   Run: node test/no-redo-reaction.test.mjs

   THE INCIDENT, 2026-10-11, in the movie requests group. Ethan Adams asked
   for "Iron Man 3 2013" at 14:21 UTC; it was queued, downloaded by 14:55, and
   waiting for the encoder when the hourly check restarted the bot at 15:22.
   Resuming it, the bot reacted 🔄 on his message - reactions.redo, "resumed
   after a restart / retried" in the schema, "Picked back up after a restart"
   in the panel's reaction guide. A member reads 🔄 as "do it again": at 15:49
   he sent "Iron Man 3 2013" again, the bot logged "Iron Man 3 (2013) is
   already in the queue - not queueing it again" and reacted 🤥
   (reactions.duplicate, which the operator chose on 2026-09-29 so a repeat
   request is told apart from a fresh one), and he asked the discussions group
   "what shld I do?". The operator: "Bot asked Ethan to redo the iron man
   request and then reacted with 🤥 when he did". There were three restarts
   that day (08:53, 12:37 and 15:22 UTC), each putting 🔄 on several members'
   messages.

   So, for films and TV alike:
   - a request picked back up after a restart, or retried after a failure,
     shows its place in line while it waits and otherwise the stage it is at
     (⬇️ ⚙️ ⬆️), or 🎬 with nothing of it started - never 🔄, and no more
     reactions than the 🔄 it replaces (media/stage-reaction.js);
   - the member's own request, sent again while it waits or runs for them,
     gets no 🤥: the new message shows where the first one is - 🎬 and its
     place, as their first message was shown, or the stage it is at -
     follows it to its ✅, and nothing holds it against them: its History
     row is "resent", not "duplicate", the hourly check's repeat-request
     findings leave it out, and the cooldown's flood backstop does not count
     it the first time;
   - a season part-way posted is still in progress: sent again, its posted
     episodes are not queued again;
   - sent again and again, the backstop counts every one after the first,
     the notifications group hears it once, and only the latest message
     follows the line - before a restart and after it, where a message whose
     place has not moved is sent nothing;
   - another member asking for it is still a duplicate, and gets 🤥 - every
     time they ask;
   - the redo reaction is gone from the schema and the panel, and an old
     config.json that still holds one loses it on load.

   Every config here still holds redo: '🔄', as every install's config.json
   does. It must never be sent. */
import './fixtures/roomy-disk.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';
import { ConfigStore } from '../src/config/store.js';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import tvPlugin from '../src/plugins/tv-requests/index.js';
import { JobQueue } from '../src/core/queue.js';
import { RetryBook } from '../src/media/resume.js';
import { openWork, workKey, isSafeToDeleteIn } from '../src/media/work-files.js';
import { stageReaction, workStage, liveStage } from '../src/media/stage-reaction.js';
import { requestChains } from '../src/core/incident-scan.js';
import { cooldownKeys } from '../src/core/request-cooldown.js';
import { LEGEND, TV_LEGEND } from '../tools/legends.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

const REQ = 'movie-requests@g.us';
const POSTS = 'movie-posts@g.us';
const NOTIFY = 'movie-notify@g.us';
const TVREQ = 'tvreq@g.us';
const TVPOSTS = 'tvposts@g.us';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'no-redo-'));
const LIB = path.join(TMP, 'lib');
const WORK = path.join(TMP, 'work');
fs.mkdirSync(LIB); fs.mkdirSync(WORK);
const IRON_FILE = path.join(LIB, 'Iron Man 3 (2013).mp4');
fs.writeFileSync(IRON_FILE, 'not really a film');
const FFPROBE = path.join(TMP, 'ffprobe');
fs.writeFileSync(FFPROBE, `#!/bin/sh
cat <<'JSON'
{"streams":[{"codec_type":"video","codec_name":"h264","width":1280,"height":720},{"codec_type":"audio","codec_name":"aac","channels":2}],"format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"60","size":"17"}}
JSON
`, { mode: 0o755 });
const isSafe = (p) => isSafeToDeleteIn(p, { workDir: WORK, roots: [LIB] });

// OMDb for the films, Jellyfin for the TV: one show, two seasons of three.
const IRON = { Title: 'Iron Man 3', Year: '2013', Rated: 'PG-13', imdbID: 'tt1300854' };
const SERIES = { Items: [{ Id: 'SER1', Name: 'The Boys', ProductionYear: 2019 }] };
const SEASONS = { Items: [{ Id: 'S1', IndexNumber: 1 }, { Id: 'S2', IndexNumber: 2 }] };
const episodesOf = (season) => ({
  Items: [1, 2, 3].map((n) => ({
    Id: `S${season}E${n}`, SeriesName: 'The Boys', ParentIndexNumber: season, IndexNumber: n,
    Name: `Ep ${n}`, MediaSources: [{ Path: `/s${season}e${n}.mkv`, Size: n }],
  })),
});
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.hostname.includes('omdbapi')) {
    const q = String(u.searchParams.get('t') ?? u.searchParams.get('s') ?? '').toLowerCase();
    const body = q.includes('iron man') ? { Response: 'True', Type: 'movie', ...IRON } : { Response: 'False', Error: 'Movie not found!' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const season = Number(u.searchParams.get('season') ?? 1);
  for (const [k, v] of Object.entries({ '/Items': SERIES, '/Seasons': SEASONS, '/Episodes': episodesOf(season) })) {
    if (u.pathname.includes(k)) return { ok: true, status: 200, json: async () => v };
  }
  return { ok: false, status: 404, statusText: 'NF', json: async () => ({}) };
};

// Ethan, whose request it is, and another member, each with a number of
// their own: the same number is the same member (requestMemberKey).
const MEMBERS = {
  elya: { senderJid: '100000000000005@lid', senderNumber: '27673749190', senderNumberDisplay: '+27673749190', pushName: 'Ethan Adams' },
  dina: { senderJid: '155500011112222@lid', senderNumber: '15550001111', senderNumberDisplay: '+15550001111', pushName: 'Diane' },
};
let seq = 0;
const message = (text, who, chatJid) => {
  const id = `M${++seq}`;
  return {
    id, key: { id, remoteJid: chatJid }, text, chatJid, isGroup: true, fromMe: false, messageType: 'conversation',
    ...MEMBERS[who], timestamp: Date.now(),
  };
};

/**
 * Every reaction asked for, in order, by message: what the members were
 * shown. `shedLow` drops every 'low' reaction - the place numbers - as the
 * outbound budget does from 75% use (bot.js), and `shown_` is then what
 * really landed.
 */
function fakeBot({ shedLow = false } = {}) {
  const out = [];
  const shown = [];
  const bot = {
    out,
    connected: true,
    sendDocumentFails: null,
    isConnected: () => bot.connected,
    react: async (msg, emoji, opts = {}) => {
      out.push({ op: 'react', id: msg.id, emoji, kind: opts.kind ?? 'normal' });
      if (shedLow && opts.kind === 'low') return false;
      if (shedLow && opts.unless?.()) return false;
      shown.push({ id: msg.id, emoji });
      return true;
    },
    shown_: (id) => shown.filter((e) => e.id === id).map((e) => e.emoji).join(' '),
    sendText: async (jid, body) => { out.push({ op: 'text', jid, body }); return { key: { id: 'sent' } }; },
    sendDocument: async (jid, file, opts) => {
      if (bot.sendDocumentFails) throw new Error(bot.sendDocumentFails);
      out.push({ op: 'document', jid, file: opts?.fileName });
      return {};
    },
    deleteMessage: async () => {}, archiveChat: async () => {}, isGroupAdmin: () => false,
    groupMemberInfo: () => ({ isMember: false }), groups: () => [], on() {}, off() {},
    on_: (id) => out.filter((e) => e.op === 'react' && e.id === id).map((e) => e.emoji).join(' '),
  };
  return bot;
}
const everyReaction = [];          // across every case: no 🔄, ever
const record = (bot) => everyReaction.push(...bot.out.filter((e) => e.op === 'react').map((e) => e.emoji));

const fakeStore = (data = {}) => ({
  get: (k, d = null) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; },
  push: (k, v) => { (data[k] ??= []).unshift(v); }, all: () => ({ ...data }), data,
});
const log = { info() {}, warn() {}, error() {}, debug() {} };
const job = () => ({ id: `j${++seq}`, signal: new AbortController().signal, progress() {}, isCancelled: () => false, cancelReason: () => null });

/* ---------------------------------------------------------------- films */

// The beta modes this was written against, the defaults until 2026-10-12
// (live-settings-defaults): every feature Off.
const MODES_BEFORE = { 'tv-rating-notice': 'off', 'movie-duplicate-notice': 'off', 'tv-duplicate-notice': 'off' };

function movieConfig({ cooldown = 0 } = {}) {
  return mergeDefaults({
    movieRequests: {
      requestGroups: [REQ], postsGroup: POSTS, notify: { group: NOTIFY }, cooldownSecondsPerUser: cooldown, blockedRatings: [],
      reactions: { redo: '🔄' },           // an old config.json's, never to be sent
      // The request rules this was written against, the defaults until 2026-10-12
      // (request-rule-defaults): no prefix needed, react only, 50 waiting.
      requirePrefix: false, replyOnBlock: false, maxQueueLength: 50,
    },
    omdb: { apiKey: 'test-key' },
    library: { provider: 'local', local: { roots: [LIB], extensions: ['.mp4'] } },
    media: { workDir: WORK, ffprobePath: FFPROBE, ffmpegPath: '/bin/false', deleteAfterSend: true },
    whatsapp: { broadcastPacingMs: 0 },
    beta: { features: MODES_BEFORE },
  }, DEFAULT_CONFIG);
}

/**
 * The queue as the plugin sees it: what it was given (`jobs`) and the view
 * snapshot() gives - a film's place while it waits, and its progress once it
 * runs - which a case moves by hand. `startAtOnce` starts every film added.
 */
function movieQueue({ startAtOnce = false, snapshot = true } = {}) {
  const q = {
    maxLength: 50, pending: [], active: new Map(), on() {}, off() {}, jobs: [],
    view: { pending: [], active: [] },
    add(j) {
      q.jobs.push(j);
      const id = `job-${q.jobs.length}`;
      const v = { id, kind: 'movie', label: j.label, meta: j.meta, progress: null };
      if (startAtOnce) q.view.active.push({ ...v, state: 'running' });
      else q.view.pending.push({ ...v, place: q.view.pending.length + 1 });
      return id;
    },
    moveTop() { return true; },
    renumber() { q.view.pending.forEach((e, i) => { e.place = i + 1; }); },
    start(id, progress = null) {
      const i = q.view.pending.findIndex((v) => v.id === id);
      const [v] = q.view.pending.splice(i, 1);
      q.renumber();
      q.view.active.push({ ...v, state: 'running', progress });
    },
  };
  if (snapshot) q.snapshot = () => q.view;
  return q;
}

function movieHarness(opts = {}) {
  const bot = fakeBot(opts);
  const store = opts.store ?? fakeStore();
  const queue = movieQueue(opts);
  const ctx = { config: movieConfig(opts), store, bot, queue, log, configStore: { update() {} } };
  moviePlugin._reactors = new Map();
  moviePlugin._handoffs = new Map();
  moviePlugin._cooldown = null;           // a fresh clock and backstop (_cool)
  return { ctx, bot, store, queue };
}
const rowOf = (store, id) => (store.data.history ?? []).find((h) => h.id === id);
const notesOf = (bot) => bot.out.filter((e) => e.op === 'text' && e.jid === NOTIFY).map((e) => e.body);

/** Iron Man 3 as the journal held it at 15:22: Ethan's, from 14:21. */
function ironJournal(id = 'IM3') {
  const rec = {
    id, request: 'Iron Man 3 2013', status: 'queued', title: 'Iron Man 3', year: 2013, rated: 'PG-13',
    requester: 'Ethan Adams', requesterJid: MEMBERS.elya.senderJid, requesterNumber: MEMBERS.elya.senderNumber,
  };
  return {
    jobKey: `${id}:tt1300854`, msgId: id, msgKey: { id, remoteJid: REQ }, chatJid: REQ,
    movie: { title: 'Iron Man 3', year: 2013, imdbId: 'tt1300854', rated: 'PG-13' },
    meta: { requester: 'Ethan Adams', memberKey: `num:${MEMBERS.elya.senderNumber}` }, record: rec, at: 1,
  };
}
/** What its work held: the whole download (`downloaded`), or the finished film too (`made`). */
function ironWork(jobKey, { made = false } = {}) {
  const w = openWork({ workDir: WORK, key: workKey.movie(jobKey), kind: 'movie', isSafe });
  w.record({
    item: { provider: 'jellyfin', id: 'jf-iron', access: 'download', librarySize: 17, total: 17, lastModified: null, etag: null, local: null },
    source: { name: 'source.mkv', state: 'complete', bytes: 17 },
    ...(made ? { output: { name: 'output.mp4', size: 17, action: 'remux' } } : {}),
  });
  fs.writeFileSync(w.path('source.mkv'), 'not really a film');
  if (made) fs.writeFileSync(w.outPath, 'not really a film');
  return w;
}

console.log('=== the incident: Iron Man 3, downloaded, picked back up at the 15:22 restart, gets ⚙️ - not 🔄 ===');
{
  const store = fakeStore();
  const p = ironJournal();
  store.set('pending', [p]);
  store.set('history', [{ ...p.record }]);
  ironWork(p.jobKey);
  // A free slot: it starts at once, and waits for the encoder.
  const { ctx, bot, queue } = movieHarness({ store, startAtOnce: true });
  await moviePlugin.recoverPending(ctx, { leftover: new Set([p.jobKey]) });
  await tick();
  record(bot);
  ok(queue.jobs.length === 1 && queue.view.active.length === 1, 'it is resumed, and running');
  ok(bot.on_('IM3') === '⚙️', `its message shows ⚙️, the stage it is at - its download was whole (${bot.on_('IM3')})`);
  ok(!bot.out.some((e) => e.emoji === '🔄'), 'and no 🔄, though the config still holds one');
}

console.log('=== a film picked back up shows the stage its work reached, or ⬇️ when it starts with nothing done, or 🎬 ===');
{
  const store = fakeStore();
  const made = ironJournal('MADE');
  const none = ironJournal('NONE');
  store.set('pending', [made, none]);
  ironWork(made.jobKey, { made: true });
  const { ctx, bot } = movieHarness({ store, startAtOnce: true });
  await moviePlugin.recoverPending(ctx, { leftover: new Set([made.jobKey, none.jobKey]) });
  await tick();
  record(bot);
  ok(bot.on_('MADE') === '⬆️', `its finished film is to be sent: ⬆️ (${bot.on_('MADE')})`);
  // The second is journalled for the same film: resumed once, for the first.
  ok(bot.on_('NONE') === '', `one journalled twice is resumed once, and says nothing of its own (${bot.on_('NONE')})`);

  const s2 = fakeStore();
  const fresh = ironJournal('FRESH');
  s2.set('pending', [fresh]);
  const h2 = movieHarness({ store: s2, startAtOnce: true });
  await moviePlugin.recoverPending(h2.ctx, { leftover: new Set([fresh.jobKey]) });
  await tick();
  record(h2.bot);
  ok(h2.bot.on_('FRESH') === '⬇️', `started with nothing done: the download is its stage, ⬇️ (${h2.bot.on_('FRESH')})`);

  // A queue that shows nothing - neither its place nor that it runs: 🎬.
  const s3 = fakeStore();
  const quiet = ironJournal('QUIET');
  s3.set('pending', [quiet]);
  const h3 = movieHarness({ store: s3, snapshot: false });
  await moviePlugin.recoverPending(h3.ctx, { leftover: new Set([quiet.jobKey]) });
  await tick();
  record(h3.bot);
  ok(h3.bot.on_('QUIET') === '🎬', `accepted, and nothing of it started: 🎬 (${h3.bot.on_('QUIET')})`);
}

console.log('=== a film picked back up that waits for its turn gets its number, and nothing else ===');
{
  // Nothing of it done: it had not started, so it goes back in the line. (A
  // film with work kept had started, and goes back in running, as
  // wf/started-keeps-its-turn puts it: that one shows its stage.)
  const store = fakeStore();
  const p = ironJournal('WAIT');
  store.set('pending', [p]);
  const { ctx, bot, queue } = movieHarness({ store });
  queue.view.pending.push({ id: 'job-ahead', kind: 'movie', meta: { jobKey: 'AHEAD' }, place: 1 });
  await moviePlugin.recoverPending(ctx, { leftover: new Set([p.jobKey]) });
  await tick();
  record(bot);
  ok(bot.on_('WAIT') === '2️⃣', `its place behind the film ahead, and no stage as well (${bot.on_('WAIT')})`);
}

console.log('=== a film\'s own reaction does not send the same stage twice running ===');
{
  // The resume's ⚙️ and then its run's own ⚙️ on reaching the encoder would
  // be two reactions where the 🔄 and the ⚙️ were: no more than before, and
  // one fewer this way. One the budget shed is not taken as shown.
  const { ctx, bot } = movieHarness();
  const p = ironJournal('DEDUP');
  let shed = true;
  ctx.bot.react = async (msg, emoji) => {
    bot.out.push({ op: 'react', id: msg.id, emoji });
    if (shed) { shed = false; return false; }
    return true;
  };
  const react = moviePlugin._reactFor(ctx, p);
  await react('⚙️');                     // shed
  await react('⚙️');                     // so sent again
  await react('⚙️');                     // shown: not sent
  await react('⬆️');
  record(bot);
  ok(bot.on_('DEDUP') === '⚙️ ⚙️ ⬆️', `a shed one is sent again, a shown one is not (${bot.on_('DEDUP')})`);
}

console.log('=== a film retried after a failure shows the stage it goes on from ===');
{
  const store = fakeStore();
  const p = ironJournal('RETRY');
  store.set('pending', [p]);
  store.set('history', [{ ...p.record }]);
  const { ctx, bot } = movieHarness({ store });
  bot.sendDocumentFails = 'Connection Closed';
  moviePlugin._retries = new RetryBook({ delayMs: () => 3_600_000, log });
  const hit = { title: 'Iron Man 3', year: 2013, access: 'local', localPath: IRON_FILE, size: 17, provider: 'local', container: 'mp4' };
  let err = null;
  try {
    await moviePlugin.deliver({
      msg: { id: p.msgId, key: p.msgKey, chatJid: REQ }, movie: p.movie, hit, ctx, job: job(),
      record: { ...p.record }, react: moviePlugin._reactFor(ctx, p), jobKey: p.jobKey,
    });
  } catch (e) { err = e; }
  moviePlugin._retries.clear();
  record(bot);
  ok(/Connection Closed/.test(err?.message ?? '') && rowOf(store, 'RETRY')?.status === 'interrupted',
    `its upload lost to a dropped connection, it is to be retried (${rowOf(store, 'RETRY')?.status})`);
  const R = bot.on_('RETRY').split(' ');
  ok(R.at(-1) === '⬆️' && R.filter((e) => e === '⬆️').length === 1 && !R.includes('🔄') && !R.includes('⚠️'),
    `it stays on ⬆️, the stage its finished file goes on from - not 🔄, not sent twice (${R.join(' ')})`);
}

console.log('=== Ethan sends his own request again while it waits: its place, not 🤥, and ✅ with it ===');
let filmHistory = null;
{
  const { ctx, bot, store, queue } = movieHarness();
  queue.view.pending.push({ id: 'job-ahead', kind: 'movie', meta: { jobKey: 'AHEAD' }, place: 1 });
  const first = message('Iron Man 3 2013', 'elya', REQ);
  await moviePlugin.onMessage(first, ctx);
  await tick();
  ok(queue.jobs.length === 1 && bot.on_(first.id) === '🔍 🎬 2️⃣', `his request is queued, second in line (${bot.on_(first.id)})`);

  const again = message('Iron Man 3 2013', 'elya', REQ);
  await moviePlugin.onMessage(again, ctx);
  await tick();
  ok(queue.jobs.length === 1 && (store.data.pending ?? []).length === 1, 'sent again, it is not queued again');
  // 🎬 and then the number, as his first message was shown: no 🤥.
  ok(bot.on_(again.id) === '🔍 🎬 2️⃣', `his new message shows the first one's place - no 🤥 (${bot.on_(again.id)})`);
  ok((store.data.pending ?? [])[0]?.followers?.find((f) => f.msgId === again.id)?.shown === '2️⃣',
    'the number that landed on it is journalled, so a restart does not send it again');
  const row = rowOf(store, again.id);
  ok(row?.status === 'resent' && row.resendOf === first.id && /the same request, not a second one/.test(row.detail ?? ''),
    `History: "resent", pointing at his first request - not a duplicate (${row?.status}, ${row?.resendOf})`);
  ok(notesOf(bot).at(-1) === '🎬 Iron Man 3 (2013) — added to the queue' && !notesOf(bot).some((n) => n.startsWith('🤥')),
    `the notifications group hears the line a duplicate's would be, under 🎬 (${notesOf(bot).at(-1)})`);

  // Another member asking for it is the duplicate it always was.
  const other = message('Iron Man 3 2013', 'dina', REQ);
  await moviePlugin.onMessage(other, ctx);
  await tick();
  ok(bot.on_(other.id) === '🔍 🤥' && rowOf(store, other.id)?.status === 'duplicate',
    `another member's request for the film queued for the group still gets 🤥, and a duplicate row (${bot.on_(other.id)})`);

  // The line moves, and his new message moves with the first.
  queue.view.pending.shift();
  queue.renumber();
  moviePlugin._updatePositions(ctx);
  await tick();
  ok(bot.on_(again.id) === '🔍 🎬 2️⃣ 1️⃣' && bot.on_(first.id).endsWith('1️⃣'), `both show 1st once the film ahead has gone (${bot.on_(again.id)})`);

  // It starts: the number gives way to ⬇️, as its own message's does.
  queue.start('job-1');
  moviePlugin._updatePositions(ctx);
  await tick();
  ok(bot.on_(again.id) === '🔍 🎬 2️⃣ 1️⃣ ⬇️', `it starts, and his new message is moved on to ⬇️ (${bot.on_(again.id)})`);

  // And posted: ✅ on both his messages.
  queue.view.active.length = 0;
  await queue.jobs[0].run(job());
  await tick();
  record(bot);
  ok(bot.out.some((e) => e.op === 'document' && e.jid === POSTS), 'the film is posted, once');
  ok(bot.on_(first.id).endsWith('✅') && bot.on_(again.id).endsWith('✅') && bot.on_(other.id).endsWith('✅'),
    `his first message, the one he sent again and Diane's all end on ✅ (${bot.on_(again.id)})`);
  ok(rowOf(store, again.id)?.status === 'resent' && rowOf(store, again.id)?.detail === 'posted, with their first request for it',
    `the row sent again stays "resent", saying how the first one ended (${rowOf(store, again.id)?.detail})`);
  ok(rowOf(store, first.id)?.status === 'sent' && rowOf(store, other.id)?.status === 'sent', 'his first row and Diane\'s say sent');
  filmHistory = store.data.history;
}

console.log('=== sent again while it is being made: the stage it is at ===');
{
  const { ctx, bot, queue } = movieHarness();
  const first = message('Iron Man 3 2013', 'elya', REQ);
  await moviePlugin.onMessage(first, ctx);
  queue.start('job-1', { stage: 'convert', text: 'converting' });
  moviePlugin._updatePositions(ctx);
  const again = message('Iron Man 3 2013', 'elya', REQ);
  await moviePlugin.onMessage(again, ctx);
  await tick();
  record(bot);
  ok(bot.on_(again.id) === '🔍 ⚙️', `it is converting: ⚙️ (${bot.on_(again.id)})`);
}

console.log('=== nothing of it is held against him: the cooldown\'s backstop does not count it ===');
{
  const { ctx, bot, queue } = movieHarness();
  await moviePlugin.onMessage(message('Iron Man 3 2013', 'elya', REQ), ctx);
  const settled = [];
  const lookup = () => ({ settle: (s, o) => { settled.push(o); return null; } });
  await moviePlugin._runCounted(message('Iron Man 3 2013', 'elya', REQ), 'Iron Man 3 2013', ctx, { beta: false, test: null }, lookup());
  await moviePlugin._runCounted(message('Iron Man 3 2013', 'dina', REQ), 'Iron Man 3 2013', ctx, { beta: false, test: null }, lookup());
  record(bot);
  ok(queue.jobs.length === 1, 'neither is queued');
  ok(settled[0]?.queued === false && settled[0]?.counts === false, 'his own request sent again is not an answer the backstop counts');
  ok(settled[1]?.counts === true, 'another member\'s duplicate still is, as before');
}

console.log('=== nor do the hourly check\'s repeat-request findings ===');
{
  const chains = requestChains({ 'movie-requests': { history: filmHistory } });
  const his = chains.filter((c) => c.who === MEMBERS.elya.senderJid);
  ok(his.length === 1 && his[0].asks.length === 1, `his request is one ask, not two (${his.map((c) => c.asks.length).join()})`);
  // What it would have been, as a duplicate row: the finding the incident drew.
  const asDuplicate = filmHistory.map((r) => (r.resendOf ? { ...r, resendOf: undefined, status: 'duplicate' } : r));
  const before = requestChains({ 'movie-requests': { history: asDuplicate } }).filter((c) => c.who === MEMBERS.elya.senderJid);
  ok(before.some((c) => c.asks.length === 2), 'where a duplicate row would have been a member asking twice');
}

/* ------------------------------------------------------------------- TV */

/** The real queue, each job's run a gate the case opens - as test/tv-queue-positions.test.mjs. */
function realQueue() {
  const q = new JobQueue({ concurrency: 1, maxLength: 104 });
  const gates = new Map();
  const add = q.add.bind(q);
  q.add = (j, o) => add({ ...j, run: () => new Promise((r) => gates.set(j.label, r)) }, o);
  q.finish = (label) => gates.get(label)?.();
  return q;
}

async function tvHarness({ store = new Map(), paused = false, movieAhead = false, shedLow = false, cooldown = 0 } = {}) {
  await tvPlugin.teardown();
  const bot = fakeBot({ shedLow });
  const queue = realQueue();
  if (paused) queue.pause();
  if (movieAhead) queue.add({ kind: 'movie', label: 'Up (2009)', run: null });
  const ctx = {
    config: mergeDefaults({
      // No TV prefix needed, the default until 2026-10-12 (live-settings-defaults).
      tvRequests: { enabled: true, requestGroups: [TVREQ], postsGroups: [TVPOSTS], cooldownSecondsPerUser: cooldown, blockedRatings: [], requirePrefix: false },
      movieRequests: { reactions: { redo: '🔄' }, notify: { group: 'notify@g.us' } },
      library: { jellyfin: { baseUrl: 'http://jf:8096', accessToken: 'TOK', userId: 'U1' } },
      media: { workDir: WORK },
      beta: { groups: [], postsGroup: '', features: MODES_BEFORE },
    }, DEFAULT_CONFIG),
    bot, queue,
    store: { get: (k, d) => (store.has(k) ? structuredClone(store.get(k)) : d), set: (k, v) => store.set(k, structuredClone(v)) },
    log,
  };
  await tvPlugin.setup(ctx);
  await tick();
  return { ctx, bot, queue, store };
}
const tvAsk = async (ctx, text, who) => { const m = message(text, who, TVREQ); await tvPlugin.onMessage(m, ctx); await tick(); return m; };
const tvRow = (store, id) => (store.get('history') ?? []).find((h) => h.id === id);
const season1 = () => episodesOf(1).Items.map((e) => ({ id: e.Id, series: 'The Boys', season: 1, episode: e.IndexNumber, title: e.Name }));
const tvJournal = (key, msgId) => ({
  reqKey: key, label: 'The Boys season 1 — 3 episode(s)', msgId, msgKey: { id: msgId, remoteJid: TVREQ }, chatJid: TVREQ,
  requester: '+27673749190', requesterNumber: '27673749190', memberKey: `num:${MEMBERS.elya.senderNumber}`,
  baseRow: { id: msgId, kind: 'tv', status: 'queued', requesterJid: MEMBERS.elya.senderJid }, episodes: season1(),
});

console.log('=== TV: a season picked back up that starts at once shows its stage - not 🔄 ===');
{
  const store = new Map();
  store.set('pending', [tvJournal('tv-old-1', 'OLD1')]);
  // Its first episode was downloaded whole before the restart.
  const w = openWork({ workDir: WORK, key: workKey.tv('tv-old-1', 'S1E1'), kind: 'tv', isSafe });
  w.record({ item: { provider: 'jellyfin', id: 'S1E1', access: 'download', librarySize: 1, total: 1 }, source: { name: 'source.mkv', state: 'complete', bytes: 1 } });
  fs.writeFileSync(w.path('source.mkv'), 'x');
  const { bot, queue } = await tvHarness({ store });
  record(bot);
  ok(queue.snapshot().active.some((e) => e.group === 'tv-old-1'), 'it is running');
  ok(bot.on_('OLD1') === '⚙️', `its message shows ⚙️, the stage its first episode is at - not 🔄 (${bot.on_('OLD1')})`);
  await tvPlugin.teardown();
}

console.log('=== TV: a season picked back up that waits gets its number, and nothing else ===');
{
  const store = new Map();
  store.set('pending', [tvJournal('tv-old-2', 'OLD2')]);
  const { bot } = await tvHarness({ store, paused: true, movieAhead: true });
  record(bot);
  ok(bot.on_('OLD2') === '2️⃣', `its place behind the film (${bot.on_('OLD2')})`);
  await tvPlugin.teardown();
}

console.log('=== TV: an episode retried after a failure shows the stage it goes on from ===');
{
  // Its download had begun: the retry goes on from it, and it is downloading.
  const reqKey = 'tv-retry-1';
  const store = new Map();
  const ctx = {
    config: mergeDefaults({
      tvRequests: { postsGroups: [TVPOSTS] }, movieRequests: { reactions: { redo: '🔄' } },
      library: { jellyfin: { baseUrl: 'http://jf.invalid', accessToken: 'T' } }, media: { workDir: WORK },
    }, DEFAULT_CONFIG),
    bot: fakeBot(), queue: { add() { return 'q'; }, on() {}, off() {} }, log,
    store: { get: (k, d) => (store.has(k) ? store.get(k) : d), set: (k, v) => store.set(k, v) },
  };
  const ep = { id: 'S1E1', series: 'The Boys', season: 1, episode: 1, title: 'Ep 1', size: 100 };
  tvPlugin._journalAdd(ctx, { reqKey, label: 'The Boys S01E01', episodes: [ep] });
  const w = openWork({ workDir: WORK, key: workKey.tv(reqKey, ep.id), kind: 'tv', isSafe });
  w.record({ item: { provider: 'jellyfin', id: 'S1E1', access: 'download', librarySize: 100, total: 100 }, source: { name: 'source.mkv', state: 'partial', bytes: 100 } });
  fs.writeFileSync(`${w.path('source.mkv')}.part`, 'x'.repeat(40));
  w.vouch();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  tvPlugin._retries = new RetryBook({ delayMs: () => 3_600_000, log });
  const shown = [];
  const react = tvPlugin._sameTwiceSkipped(async (e) => { shown.push(e); return true; });
  let err = null;
  try {
    await tvPlugin.deliverEpisode({ ep, ctx, job: job(), msg: null, react, notifier: null, reqKey, route: null, isLast: true, index: 0, total: 1 });
  } catch (e) { err = e; }
  globalThis.fetch = realFetch;
  tvPlugin._retries.clear();
  everyReaction.push(...shown);
  ok(/fetch failed/.test(err?.message ?? ''), 'its download fails on the network, transiently');
  ok(shown.join(' ') === '⬇️' && !shown.includes('🔄') && !shown.includes('⚠️'),
    `it stays on ⬇️, where its retry goes on from - not 🔄, and not sent twice (${shown.join(' ')})`);
}

console.log('=== TV: Ethan sends his own season again while it waits: its place, not 🤥, and ✅ with it ===');
let tvHistory = null;
{
  const { ctx, bot, store } = await tvHarness({ paused: true, movieAhead: true });
  const first = await tvAsk(ctx, 'The Boys season 1', 'elya');
  ok(bot.on_(first.id) === '🔍 🎬 2️⃣', `his season is queued, second in line (${bot.on_(first.id)})`);
  const reqKey = (store.get('pending') ?? [])[0]?.reqKey;

  const again = await tvAsk(ctx, 'The Boys season 1', 'elya');
  ok((store.get('pending') ?? []).length === 1 && ctx.queue.snapshot().pending.filter((e) => e.kind === 'tv').length === 1,
    'sent again, nothing more is queued');
  ok(bot.on_(again.id) === '🔍 🎬 2️⃣', `his new message shows 🎬 and the season's place - no 🤥 (${bot.on_(again.id)})`);
  const row = tvRow(store, again.id);
  ok(row?.status === 'resent' && row.resendOf === first.id, `History: "resent", pointing at his first request (${row?.status}, ${row?.resendOf})`);

  const other = await tvAsk(ctx, 'The Boys season 1', 'dina');
  ok(bot.on_(other.id) === '🔍 🤥 2️⃣' && tvRow(store, other.id)?.status === 'duplicate',
    `another member's request for it still gets 🤥, and a duplicate row (${bot.on_(other.id)})`);

  tvPlugin._tellTvFollowers(ctx, reqKey, { status: 'sent', emoji: '✅' });   // the season is posted
  await tick();
  record(bot);
  ok(bot.on_(again.id).endsWith('✅') && bot.on_(other.id).endsWith('✅'), `both follow it to its ✅ (${bot.on_(again.id)})`);
  ok(tvRow(store, again.id)?.status === 'resent' && tvRow(store, again.id)?.detail === 'posted, with their first request for it',
    `his row sent again stays "resent" (${tvRow(store, again.id)?.detail})`);
  ok(tvRow(store, other.id)?.status === 'sent', 'Diane\'s duplicate row says sent, as a duplicate\'s does');
  tvHistory = store.get('history');
  await tvPlugin.teardown();
}

console.log('=== TV: sent again while it runs, the stage it is at; and not counted against him ===');
{
  const { ctx, bot } = await tvHarness();
  await tvAsk(ctx, 'The Boys season 1', 'elya');             // starts at once
  const settled = [];
  const again = message('The Boys season 1', 'elya', TVREQ);
  await tvPlugin._afterIntake(again, 'The Boys season 1', ctx,
    { lookup: { settle: (s, o) => { settled.push(o); return null; } } });
  await tick();
  ok(bot.on_(again.id) === '🔍 ⬇️', `it runs, nothing of it done yet: ⬇️ (${bot.on_(again.id)})`);
  await tvPlugin._afterIntake(message('The Boys season 1', 'dina', TVREQ), 'The Boys season 1', ctx,
    { lookup: { settle: (s, o) => { settled.push(o); return null; } } });
  record(bot);
  ok(settled[0]?.queued === false && settled[0]?.counts === false, 'his own request sent again is not counted by the backstop');
  ok(settled[1]?.counts === true, 'another member\'s duplicate still is');
  await tvPlugin.teardown();
}

console.log('=== TV: nor do the hourly check\'s repeat-request findings ===');
{
  const chains = requestChains({ 'tv-requests': { history: tvHistory } });
  const his = chains.filter((c) => c.who === MEMBERS.elya.senderJid);
  ok(his.length === 1 && his[0].asks.length === 1, `his season is one ask, not two (${his.map((c) => c.asks.length).join()})`);
}

/* ------------------------------------------------ found in review, 2026-10-11 */
//
// The fix as first written left five holes, each reproduced in review. A
// message sent again showed only a 'low' place number, so where the budget
// shed it, or the film started before it went, the message stayed on 🔍
// ("looking it up") until ✅ - which invites yet another resend. A season
// part-way posted, sent again, queued its posted episodes again as a new
// request of his. A different member, given 🤥 once, was taken for the
// owner when she asked again. Resends were never counted by the flood
// backstop, while each still cost a notifications line and, on TV, a
// reaction on every move of the line. And a film restart sent each
// journalled resend its number again: eight reactions for four films.

const notifyLines = (bot, jid) => bot.out.filter((e) => e.op === 'text' && e.jid === jid).length;

console.log('=== review: a message sent again is never left on 🔍 - 🎬 first, then its number, then ⬇️ ===');
{
  // Every 'low' reaction shed, as the outbound budget does from 75% use.
  const { ctx, bot, queue } = movieHarness({ shedLow: true });
  queue.view.pending.push({ id: 'job-ahead', kind: 'movie', meta: { jobKey: 'AHEAD' }, place: 1 });
  await moviePlugin.onMessage(message('Iron Man 3 2013', 'elya', REQ), ctx);
  const again = message('Iron Man 3 2013', 'elya', REQ);
  await moviePlugin.onMessage(again, ctx);
  await tick();
  ok(bot.shown_(again.id) === '🔍 🎬', `its number shed, it shows 🎬, as a fresh request does - not 🔍 (${bot.shown_(again.id)})`);
  queue.view.pending.shift();
  queue.start('job-1');
  moviePlugin._updatePositions(ctx);
  await tick();
  record(bot);
  ok(bot.shown_(again.id) === '🔍 🎬 ⬇️', `the film starts, and it is moved on to ⬇️ though no number ever landed (${bot.shown_(again.id)})`);
}
{
  const { ctx, bot, queue } = await tvHarness({ paused: true, movieAhead: true, shedLow: true });
  await tvAsk(ctx, 'The Boys season 1', 'elya');
  const again = await tvAsk(ctx, 'The Boys season 1', 'elya');
  ok(bot.shown_(again.id) === '🔍 🎬', `TV: its number shed, it shows 🎬 - not 🔍 (${bot.shown_(again.id)})`);
  queue.resume();
  await tick();
  queue.finish('Up (2009)');
  await tick(40);
  record(bot);
  ok(queue.snapshot().active.some((e) => e.kind === 'tv'), 'TV: the film ahead is done, and the season has started');
  ok(bot.shown_(again.id) === '🔍 🎬 ⬇️', `TV: moved on to ⬇️ with it (${bot.shown_(again.id)})`);
  await tvPlugin.teardown();
}

console.log('=== review, TV: his season sent again once some of it is posted is not queued again ===');
{
  const { ctx, bot, store, queue } = await tvHarness();
  const first = await tvAsk(ctx, 'The Boys season 1', 'elya');          // E1 starts at once
  const reqKey = (store.get('pending') ?? [])[0]?.reqKey;
  tvPlugin._journalEpisodeDone(ctx, reqKey, 'S1E1', 'done');            // E1 is posted
  queue.finish('The Boys S01E01');                                      // and E2 starts
  await tick();
  const tvJobs = () => [...queue.pending, ...queue.active.values()].filter((e) => e.kind === 'tv').length;
  const jobs = tvJobs();
  const again = await tvAsk(ctx, 'The Boys season 1', 'elya');
  const pending = store.get('pending') ?? [];
  ok(pending.length === 1 && pending[0].reqKey === reqKey && pending[0].episodes.map((e) => e.id).join() === 'S1E2,S1E3'
    && tvJobs() === jobs,
  `nothing is queued again: E1, posted already, is not posted twice (${pending.map((p) => p.episodes.map((e) => e.id).join('+')).join(' | ')})`);
  const row = tvRow(store, again.id);
  ok(row?.status === 'resent' && row.resendOf === first.id, `History: "resent", pointing at his first request (${row?.status}, ${row?.resendOf})`);
  ok(bot.on_(again.id) === '🔍 ⬇️', `his message shows the stage the season is at, E2 downloading (${bot.on_(again.id)})`);
  const his = requestChains({ 'tv-requests': { history: store.get('history') } }).filter((c) => c.who === MEMBERS.elya.senderJid);
  ok(his.length === 1 && his[0].asks.length === 1, `one ask to the hourly check, not two (${his.map((c) => c.asks.length).join()})`);
  // An episode he asks for on its own once it is posted is a new request:
  // that one is not in progress for him any more.
  const e1 = await tvAsk(ctx, 'The Boys S01E01', 'elya');
  ok(tvRow(store, e1.id)?.status === 'queued', `E1 on its own, posted already, is queued as asked (${tvRow(store, e1.id)?.status})`);
  record(bot);
  await tvPlugin.teardown();
}

console.log('=== review: a different member asking again is still a duplicate - 🤥 each time ===');
{
  const { ctx, bot, store } = movieHarness();
  await moviePlugin.onMessage(message('Iron Man 3 2013', 'elya', REQ), ctx);
  const once = message('Iron Man 3 2013', 'dina', REQ);
  await moviePlugin.onMessage(once, ctx);
  const twice = message('Iron Man 3 2013', 'dina', REQ);
  await moviePlugin.onMessage(twice, ctx);
  await tick();
  record(bot);
  ok(bot.on_(once.id) === '🔍 🤥' && bot.on_(twice.id) === '🔍 🤥', `Diane gets 🤥 both times: the film is Ethan's (${bot.on_(twice.id)})`);
  ok(rowOf(store, twice.id)?.status === 'duplicate' && !rowOf(store, twice.id)?.resendOf, 'her second row is a duplicate, as before');
  const hers = requestChains({ 'movie-requests': { history: store.data.history } }).filter((c) => c.who === MEMBERS.dina.senderJid);
  ok(hers.some((c) => c.asks.length === 2), 'and the hourly check sees her asking twice, as it did');
}
{
  const { ctx, bot, store } = await tvHarness({ paused: true, movieAhead: true });
  await tvAsk(ctx, 'The Boys season 1', 'elya');
  const once = await tvAsk(ctx, 'The Boys season 1', 'dina');
  const twice = await tvAsk(ctx, 'The Boys season 1', 'dina');
  record(bot);
  ok(bot.on_(once.id) === '🔍 🤥 2️⃣' && bot.on_(twice.id) === '🔍 🤥 2️⃣', `TV: Diane gets 🤥 both times (${bot.on_(twice.id)})`);
  ok(tvRow(store, twice.id)?.status === 'duplicate', 'TV: her second row is a duplicate, as before');
  await tvPlugin.teardown();
}

console.log('=== review: sent again and again - the first is free, the rest meet the backstop, one notifications line ===');
{
  const { ctx, bot, store, queue } = movieHarness({ cooldown: 3600 });
  queue.view.pending.push({ id: 'job-ahead', kind: 'movie', meta: { jobKey: 'AHEAD' }, place: 1 });
  await moviePlugin.onMessage(message('Iron Man 3 2013', 'elya', REQ), ctx);
  // An hour and more on, as at 15:49: his cooldown has passed.
  const clock = cooldownKeys(MEMBERS.elya.senderJid).clock;
  store.set(clock, { ...store.get(clock), at: Date.now() - 2 * 3600_000 });
  const lines = notifyLines(bot, NOTIFY);
  const resends = [];
  for (let i = 0; i < 8; i += 1) {
    const m = message('Iron Man 3 2013', 'elya', REQ);
    await moviePlugin.onMessage(m, ctx);
    await tick();
    resends.push(m);
  }
  record(bot);
  const told = resends.map((m) => bot.on_(m.id));
  ok(queue.jobs.length === 1, 'none of them is queued');
  ok(told.slice(0, 6).every((t) => !t.includes('🚫') && !t.includes('🤥')) && told.slice(6).every((t) => t === '🚫'),
    `the first is not counted, the next five are, and the backstop refuses the rest, as it did before (${told.join(' | ')})`);
  ok(notifyLines(bot, NOTIFY) - lines === 1, `one notifications line for all of them, not one each (${notifyLines(bot, NOTIFY) - lines})`);
  ok(resends.slice(0, 6).every((m) => rowOf(store, m.id)?.status === 'resent'), 'each row the backstop let through is "resent"');
}
{
  const { ctx, bot, store, queue } = await tvHarness({ paused: true, movieAhead: true });
  const first = await tvAsk(ctx, 'The Boys season 1', 'elya');
  const lines = notifyLines(bot, 'notify@g.us');
  const settled = [];
  const resends = [];
  for (let i = 0; i < 3; i += 1) {
    const m = message('The Boys season 1', 'elya', TVREQ);
    await tvPlugin._afterIntake(m, m.text, ctx, { lookup: { settle: (s, o) => { settled.push(o); return null; } } });
    await tick();
    resends.push(m);
  }
  ok(settled.map((o) => o.counts).join() === 'false,true,true', `TV: the first is not counted by the backstop, the later ones are (${settled.map((o) => o.counts).join()})`);
  ok(notifyLines(bot, 'notify@g.us') - lines === 1, `TV: one notifications line for the three (${notifyLines(bot, 'notify@g.us') - lines})`);
  // One move of the line - the film ahead is cancelled - reacts on his
  // first message and the latest sent again, not on each one.
  const mark = bot.out.length;
  queue.cancel(queue.snapshot().pending.find((e) => e.kind === 'movie').id);
  await tick(40);
  const name = (id) => (id === first.id ? 'first' : id === resends.at(-1).id ? 'latest' : resends.some((m) => m.id === id) ? 'earlier' : id);
  const moved = bot.out.slice(mark).filter((e) => e.op === 'react').map((e) => `${name(e.id)}:${e.emoji}`);
  ok(moved.join() === 'first:1️⃣,latest:1️⃣', `TV: one move of the line, two reactions (${moved.join()})`);
  const places = tvPlugin._followerPlaces((store.get('pending') ?? [])[0]);
  ok(places.length === 1 && places[0].msg.id === resends.at(-1).id, `TV: and after a restart only the latest follows it (${places.map((p) => name(p.msg.id)).join()})`);
  record(bot);
  await tvPlugin.teardown();
}

console.log('=== review: a film restart sends no more reactions than before, resends and all ===');
{
  // Four films waiting, each sent again by its member before the restart,
  // whose message showed the film's place. Before the resends were followed,
  // a start sent the four films' own numbers; it still does, and nothing to
  // a message whose place has not moved. Built as tv-queue-positions' "films
  // picked back up after a restart".
  const FILMS = [['Heat', 1995], ['Up', 2009], ['Alien', 1979], ['Jaws', 1975]];
  const NUM = DEFAULT_CONFIG.movieRequests.reactions.positions;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const term = new URL(String(url)).searchParams.get('searchTerm') ?? '';
    const f = FILMS.find(([title]) => title.toLowerCase() === term.toLowerCase());
    const items = f ? [{ Id: `id-${f[0]}`, Name: f[0], ProductionYear: f[1], OfficialRating: 'PG', Type: 'Movie',
      Path: `/m/${f[0]}.mkv`, MediaSources: [{ Path: `/m/${f[0]}.mkv`, Size: 1 }] }] : [];
    return { ok: true, status: 200, json: async () => ({ Items: items, TotalRecordCount: items.length }) };
  };
  const data = {};
  const store = { get: (k, d = null) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; } };
  store.set('pending', FILMS.map(([title, year], i) => ({
    jobKey: `k${i}`, msgId: `msg-${title}`, msgKey: { id: `msg-${title}` }, chatJid: REQ,
    movie: { title, year, rated: 'PG' }, meta: { requester: 'x' }, record: { request: title },
    followers: [{
      msgId: `again-${title}`, msgKey: { id: `again-${title}` }, chatJid: REQ, historyId: `again-${title}`,
      resend: true, shown: NUM[i],
    }],
  })));
  const low = [];
  const sent = [];
  const bot = {
    react: (msg, emoji, { kind = 'normal', unless = null } = {}) => {
      if (kind !== 'low') { sent.push(`${msg.id}:${emoji}`); return Promise.resolve(true); }
      return new Promise((resolve) => low.push({ msg, emoji, unless, resolve }));
    },
  };
  const flush = async () => {                       // the pacer gets round to the numbers
    for (let n = 0; n < 5; n += 1) {
      while (low.length) {
        const x = low.shift();
        if (x.unless?.()) { x.resolve(false); continue; }
        sent.push(`${x.msg.id}:${x.emoji}`);
        x.resolve(true);
      }
      await tick();
    }
  };
  const q = new JobQueue({ concurrency: 1, maxLength: 104 });
  q.pause();
  const mctx = {
    store, bot, queue: q, log,
    config: {
      library: { provider: 'jellyfin', jellyfin: { baseUrl: 'http://jf:8096', apiKey: 'K', authMethod: 'apikey' } },
      media: {}, omdb: {},
      movieRequests: { blockedRatings: [], reactions: { ...DEFAULT_CONFIG.movieRequests.reactions, redo: '🔄' } },
    },
  };
  moviePlugin._reactors = new Map();
  moviePlugin._handoffs = new Map();
  const onQ = () => moviePlugin._updatePositions(mctx);
  for (const ev of ['added', 'updated', 'state']) q.on(ev, onQ);
  try {
    await moviePlugin.recoverPending(mctx);
  } finally {
    globalThis.fetch = realFetch;
  }
  await flush();
  everyReaction.push(...sent.map((x) => x.split(':')[1]));
  ok(q.pending.length === 4, `all four films are picked back up (${q.pending.length})`);
  ok(sent.join() === 'msg-Heat:1️⃣,msg-Up:2️⃣,msg-Alien:3️⃣,msg-Jaws:4️⃣',
    `four reactions, the films' own numbers - none to a message sent again whose place has not moved (${sent.length}: ${sent.join()})`);
  // The line moves after the restart, and the messages sent again move with it.
  const mark = sent.length;
  q.cancel(q.pending[0].id);
  await flush();
  const resent = sent.slice(mark).filter((x) => x.startsWith('again-') && NUM.some((n) => x.endsWith(n)));
  ok(resent.join() === 'again-Up:1️⃣,again-Alien:2️⃣,again-Jaws:3️⃣', `Heat cancelled, each moves up one (${resent.join()})`);
  const up = (data.pending ?? []).find((p) => p.jobKey === 'k1')?.followers?.[0];
  ok(up?.shown === '1️⃣', `and what it shows now is journalled, for the next start (${up?.shown})`);
  for (const ev of ['added', 'updated', 'state']) q.off(ev, onQ);
}

/* ------------------------------------------- the reaction, the schema, the panel */

console.log('=== where a request is, as a reaction ===');
{
  const R = DEFAULT_CONFIG.movieRequests.reactions;
  const w = (m) => ({ has: () => !!m.item, manifest: m, dir: WORK });
  ok(workStage(null) === null && workStage(w({})) === null, 'no work: no stage');
  ok(workStage(w({ item: {}, source: { state: 'partial' } })) === 'downloading', 'a download begun: downloading');
  ok(workStage(w({ item: {}, source: { state: 'complete' } })) === 'converting', 'a whole download: converting');
  ok(workStage(w({ item: {}, convert: { chunks: [{}] } })) === 'converting', 'pieces of an encode: converting');
  ok(liveStage({ progress: { stage: 'upload' } }) === 'sending' && liveStage({ progress: { stage: 'wait' }, waiting: { stage: 'convert' } }) === 'converting'
    && liveStage({ progress: { stage: 'start' } }) === null, 'the queue says what a running job is doing, or which slot it waits for');
  ok(stageReaction(R, {}) === '🎬' && stageReaction(R, { running: true }) === '⬇️'
    && stageReaction(R, { view: { progress: { stage: 'upload' } } }) === '⬆️', '🎬 not started, ⬇️ started with nothing done, else its stage');
}

console.log('=== the redo reaction is gone: schema, panel, legends, code ===');
{
  ok(!('redo' in DEFAULT_CONFIG.movieRequests.reactions) && !('redo' in (DEFAULT_CONFIG.tvRequests.reactions ?? {})),
    'the schema has no redo reaction, for films or TV');
  const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  ok(!/r-redo|Redo \/ resumed/.test(html), 'Settings has no "Redo / resumed" field');
  ok(!/r-redo|r\.redo\b|\bredo:/.test(app) && !/Picked back up after a restart/.test(app),
    'the panel neither fills nor saves it, and the reaction guide has no "Picked back up after a restart" row');
  ok(!LEGEND.includes('🔄') && !TV_LEGEND.includes('🔄'), 'neither group legend explains a 🔄 no request gets');
  const code = ['movie-requests', 'tv-requests'].map((p) => fs.readFileSync(new URL(`../src/plugins/${p}/index.js`, import.meta.url), 'utf8')).join('\n');
  ok(!/reactions\??\.redo|\bR0?\.redo|_react\(ctx\)\.redo/.test(code), 'and no code reads it');
  ok(everyReaction.length > 20 && !everyReaction.includes('🔄'), `no 🔄 was sent in any case here (${everyReaction.length} reactions)`);
}

console.log('=== an old config.json that still holds it loses it, harmlessly ===');
{
  const dir = fs.mkdtempSync(path.join(TMP, 'cfg-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    movieRequests: { reactions: { redo: '🔄', done: '✅' } }, tvRequests: { reactions: { redo: '🔄' } },
  }));
  const cs = new ConfigStore({ dataDir: dir, masterKey: 'test-master-key-for-no-redo' });
  cs.load();
  ok(!('redo' in cs.get().movieRequests.reactions) && !('redo' in cs.get().tvRequests.reactions) && cs.get().movieRequests.reactions.done === '✅',
    'loaded, it has no redo, and keeps the rest');
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  ok(!('redo' in disk.movieRequests.reactions) && !('redo' in (disk.tvRequests.reactions ?? {})), 'and config.json is saved without it');
  cs.update({ movieRequests: { reactions: { redo: '🔄', added: '🎬' } } });
  ok(!('redo' in cs.get().movieRequests.reactions) && cs.get().movieRequests.reactions.added === '🎬',
    'a Save from a panel tab opened before it went cannot put it back');
}

await tvPlugin.teardown();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
