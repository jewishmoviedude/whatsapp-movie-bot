/* A request that had started before a restart keeps its turn after it.
   Run: node test/started-keeps-its-turn.test.mjs

   The incident, 2026-10-11, in the movie requests group, with the fair
   order on (queue.fairShare). Thor: The Dark World, Ethan Adams's second
   request, started at 14:54 UTC and finished downloading its 1.79 GB at
   14:56. At 15:22 the hourly check deployed a fix and restarted the bot
   ("recovering 8 job(s) interrupted by a restart"). Recovery put Thor back
   as one more waiting request: behind Iron Man 3, Ethan's other film, it
   ranked as his second, was held behind the TV for the film cooldown, and
   got 1️⃣ on its message - while Ocean's Eleven, Ari Mills's first request,
   queued at 15:18, started in the free slot ("start Ocean's Eleven (2001)
   (3/3 active, 5 waiting)"). A request that had started before the restart
   lost its turn to one queued four minutes before it.

   The queue's own rule (src/core/queue.js, its class comment): once any job
   of a request has started, the request is running until its last job is
   done, and never drops back into the waiting line. So a request that was
   running when the bot stopped comes back running (queue.add
   `startedBefore`): ahead of every waiting request whatever its rank, in
   the order the interrupted ones had started, never held behind the TV, and
   with no place number. Everything that had not started keeps the fair
   order. A TV season that had started likewise. The plugins journal when a
   request first starts (_journalStarted); a journal written before that
   was recorded is read from the work on disk, and for TV from the episodes
   that ended before the restart.

   Found in review of that change, the same day (the sections at the end):
   work taken over from a parked request was read as a start for every
   entry, and a request that never started came back running; a member's
   film was ranked before his running season was back, TV going back after
   the films, and passed another member's first request; and a started film
   whose lookup failed once at boot lost its slot to a waiting one, as Thor
   did. Both plugins now tell the queue what will come back before any of it
   does (queue.expectBack). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobQueue } from '../src/core/queue.js';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import tvPlugin from '../src/plugins/tv-requests/index.js';
import { openWork, workKey, isSafeToDeleteIn, forgetThisProcess, MANIFEST } from '../src/media/work-files.js';
import { holdTvRecovery, RetryBook } from '../src/media/resume.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));

const NUM = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const HOLD = 30_000;                       // the live film cooldown, movieRequests.cooldownSecondsPerUser 30
const at = (hhmm) => Date.parse(`2026-10-11T${hhmm}:00Z`);

/** Every reaction sent, by message; `unless` is asked as the pacer would, at once. */
function fakeBot() {
  const t = { calls: [] };
  t.bot = {
    isConnected: () => true,
    react: async (msg, emoji, { unless = null } = {}) => {
      if (unless?.()) return false;
      t.calls.push({ id: msg.id, emoji });
      return true;
    },
    sendText: async () => ({}),
    on() {}, off() {},
  };
  t.on = (id) => t.calls.filter((c) => c.id === id).map((c) => c.emoji);
  t.numbersOn = (id) => t.on(id).filter((e) => NUM.includes(e) || e === '🔢');
  return t;
}

/** A store over a plain object, as state.js namespaces behave. */
const storeOf = (data) => ({
  get: (k, d = null) => (k in data ? structuredClone(data[k]) : d),
  set: (k, v) => { data[k] = structuredClone(v); },
  data,
});

/* ------------------------------------------------------------ the queue */

console.log('=== the queue: a request put back as running goes ahead of every waiting one, whatever its rank ===');
{
  const q = new JobQueue({ concurrency: 1, fairShare: true, extraFilmHoldMs: HOLD });
  const started = [];
  const gates = new Map();
  const job = (label, member, extra = {}) => ({
    label, meta: { memberKey: member }, ...extra,
    run: () => { started.push(label); return new Promise((r) => gates.set(label, r)); },
  });
  q.pause();
  // Ethan's other film first, as recovery put Iron Man 3 back before Thor;
  // then two members with one request each; Thor last of all.
  q.add(job('Iron Man 3', 'ethan'));
  q.add(job("Ocean's Eleven", 'ari'));
  q.add(job('Fast X', 'jake'));
  q.add(job('Thor: The Dark World', 'ethan', { startedBefore: at('14:54') }), { overLimit: true });
  const snap = q.snapshot();
  ok(snap.active.map((e) => e.label).join() === 'Thor: The Dark World',
    `Thor is running, not waiting, though it has no slot yet (running: ${snap.active.map((e) => e.label).join()})`);
  ok(snap.pending.map((e) => e.label).join() === "Iron Man 3,Ocean's Eleven,Fast X",
    `the waiting line is the other three, in the fair order (${snap.pending.map((e) => e.label).join()})`);
  ok(!snap.pending.some((e) => /Thor/.test(e.label)), 'so Thor has no place in it, and no place number to be given');
  ok(/restart/.test(snap.active[0]?.progress?.text ?? ''), `the panel says why it waits (${snap.active[0]?.progress?.text})`);
  ok(q.waitingCount() === 3 && q.requestCounts().active === 1, 'it counts as running, not against the waiting limit');
  q.resume();
  await settle();
  ok(started.join() === 'Thor: The Dark World', `Thor starts first, in the one slot (${started.join()})`);
  gates.get('Thor: The Dark World')?.();
  await settle();
  ok(started.join() === 'Thor: The Dark World,Iron Man 3', `then the waiting line, in its order (${started.join()})`);
  q.close();
}

console.log('=== the queue: the fair order off, with movie priority or without, it goes first all the same ===');
{
  for (const strict of [true, false]) {
    const q = new JobQueue({ concurrency: 1, strictMoviePriority: strict });
    const started = [];
    q.pause();
    q.add({ label: 'Up', run: async () => { started.push('Up'); } });
    q.add({ kind: 'tv', label: 'Loki S01E01', run: async () => { started.push('Loki S01E01'); } });
    q.add({ label: 'Thor', startedBefore: at('14:54'), run: async () => { started.push('Thor'); } }, { overLimit: true });
    ok(q.snapshot().pending.map((e) => e.label).join() === 'Up,Loki S01E01', `strict ${strict}: Thor is not in the waiting line`);
    q.resume();
    await settle();
    ok(started[0] === 'Thor', `strict ${strict}: and it starts first (${started.join()})`);
    q.close();
  }
}

console.log('=== the queue: two put back start in the order they had started, whatever order they come back in ===');
{
  const q = new JobQueue({ concurrency: 1, fairShare: true, extraFilmHoldMs: HOLD });
  const started = [];
  const gates = new Map();
  const job = (label, member, extra = {}) => ({
    label, meta: { memberKey: member }, ...extra,
    run: () => { started.push(label); return new Promise((r) => gates.set(label, r)); },
  });
  q.pause();
  q.add(job('Waiting film', 'ari'));
  q.add(job('Started second', 'ethan', { startedBefore: at('14:54') }), { overLimit: true });
  q.add(job('Started first', 'jake', { startedBefore: at('13:29') }), { overLimit: true });
  ok(q.snapshot().active.map((e) => e.label).join() === 'Started first,Started second',
    `the running list is in the order they had started (${q.snapshot().active.map((e) => e.label).join()})`);
  q.resume();
  await settle();
  gates.get(started.at(-1))?.();
  await settle();
  gates.get(started.at(-1))?.();
  await settle();
  ok(started.join() === 'Started first,Started second,Waiting film', `and they start in that order (${started.join()})`);
  q.close();
}

console.log('=== the queue: a season put back as running goes ahead of the waiting TV, and stays one request ===');
{
  const q = new JobQueue({ concurrency: 1, fairShare: true });
  const started = [];
  const gates = new Map();
  const ep = (label, group, member, extra = {}) => ({
    kind: 'tv', label, group, groupLabel: group, groupMeta: { memberKey: member }, meta: { memberKey: member }, ...extra,
    run: () => { started.push(label); return new Promise((r) => gates.set(label, r)); },
  });
  q.pause();
  q.add(ep('Friends S01E01', 'Friends season 1', 'ari'));
  q.add(ep('Loki S01E01', 'Loki season 1', 'ethan'));
  q.add(ep('The Rookie S03E03', 'The Rookie season 3', 'ethan', { startedBefore: at('12:00') }), { overLimit: true });
  q.add(ep('The Rookie S03E04', 'The Rookie season 3', 'ethan', { startedBefore: at('12:00') }), { overLimit: true });
  const snap = q.snapshot();
  ok(snap.active.length === 1 && snap.active[0].label === 'The Rookie season 3' && snap.active[0].state === 'running',
    `the season is one running request (${snap.active.map((e) => `${e.label}:${e.state}`).join()})`);
  ok(snap.active[0]?.jobs?.total === 2, `with its two remaining episodes (${snap.active[0]?.jobs?.total})`);
  ok(snap.pending.map((e) => e.label).join() === 'Friends season 1,Loki season 1',
    `the waiting line is the other two (${snap.pending.map((e) => e.label).join()})`);
  q.resume();
  await settle();
  for (let i = 0; i < 3; i++) { gates.get(started.at(-1))?.(); await settle(); }
  ok(started.join() === 'The Rookie S03E03,The Rookie S03E04,Friends S01E01,Loki S01E01',
    `the season's episodes run first, then the waiting line (${started.join()})`);
  q.close();
}

console.log('=== the queue: one cancelled before it runs again still counts as its member\'s ===');
{
  // It did run, before the restart. Dropped as never run, it would lift the
  // member's next request to the front of the fair order.
  const q = new JobQueue({ concurrency: 1, fairShare: true });
  q.pause();
  const thor = q.add({ label: 'Thor', meta: { memberKey: 'ethan' }, startedBefore: at('14:54'), run: async () => {} }, { overLimit: true });
  q.add({ label: 'Hulk', meta: { memberKey: 'ethan' }, run: async () => {} });
  q.add({ label: 'Up', meta: { memberKey: 'ari' }, run: async () => {} });
  q.cancel(thor);
  ok(q.snapshot().pending.map((e) => e.label).join() === 'Up,Hulk',
    `Ethan's next is still his second (${q.snapshot().pending.map((e) => e.label).join()})`);
  q.close();
}

console.log('=== the queue: what a restart left is ranked by when it was asked for, whatever order it comes back in ===');
{
  // Found in review of this change: TV goes back after the films, and a
  // film ranked before its member's season was back came back as his first.
  const q = new JobQueue({ concurrency: 1, fairShare: true });
  q.pause();
  q.expectBack([
    { key: 'loki', meta: { memberKey: 'ethan' }, at: at('11:00'), started: false, label: 'Loki season 1' },
    { key: 'heat', meta: { memberKey: 'ethan' }, at: at('14:30'), started: false, label: 'Heat' },
    { key: 'up', meta: { memberKey: 'ari' }, at: at('14:40'), started: false, label: 'Up' },
    { key: 'panel', meta: { memberKey: 'ethan', requester: 'panel (admin)' }, at: at('10:00'), started: false, label: 'Alien' },
  ]);
  const film = (label, member, rankKey) => ({ label, rankKey, meta: { memberKey: member }, run: async () => {} });
  q.add(film('Heat', 'ethan', 'heat'));
  q.add(film('Up', 'ari', 'up'));
  q.add(film('Hulk', 'ari'));                       // asked for now: Ari's second
  const line = () => q.snapshot().pending.map((e) => e.label).join();
  ok(line() === 'Up,Heat,Hulk',
    `Heat is Ethan's second, his season still to come back counting, and the panel's film not (${line()})`);
  q.forgetExpected('loki');
  ok(line() === 'Heat,Up,Hulk', `a request that will not come back, never having run, stops counting (${line()})`);
  q.close();
}

console.log('=== the queue: one that ran before the restart counts on if it does not come back ===');
{
  const q = new JobQueue({ concurrency: 1, fairShare: true });
  q.pause();
  q.expectBack([{ key: 'thor', meta: { memberKey: 'ethan' }, at: at('14:39'), started: true, label: 'Thor' }]);
  q.add({ label: 'Hulk', meta: { memberKey: 'ethan' }, run: async () => {} });
  q.add({ label: 'Up', meta: { memberKey: 'ari' }, run: async () => {} });
  q.forgetExpected('thor');
  ok(q.snapshot().pending.map((e) => e.label).join() === 'Up,Hulk',
    `Ethan's next is still his second (${q.snapshot().pending.map((e) => e.label).join()})`);
  q.close();
}

console.log('=== the queue: a slot is kept for a request that had started until it is back, let go, or ten minutes have passed ===');
for (const how of ['back', 'let go', 'ten minutes']) {
  let now = at('15:22');
  const timers = [];
  const clock = {
    now: () => now,
    setTimeout: (fn, ms) => { const tm = { fn, at: now + ms }; timers.push(tm); return tm; },
    clearTimeout: (tm) => { const i = timers.indexOf(tm); if (i >= 0) timers.splice(i, 1); },
  };
  const q = new JobQueue({ concurrency: 2, fairShare: true, clock });
  const started = [];
  const job = (label, member, extra = {}) => ({
    label, meta: { memberKey: member }, ...extra, run: () => { started.push(label); return new Promise(() => {}); },
  });
  q.expectBack([
    { key: 'f7', meta: { memberKey: 'jake' }, at: at('12:01'), started: true, label: 'Furious 7' },
    { key: 'thor', meta: { memberKey: 'ethan' }, at: at('14:39'), started: true, label: 'Thor' },
  ]);
  q.add(job('Furious 7', 'jake', { rankKey: 'f7', startedBefore: at('13:29') }), { overLimit: true });
  q.add(job("Ocean's Eleven", 'ari', { rankKey: 'oe' }));
  await settle();
  ok(started.join() === 'Furious 7', `${how}: Ocean's Eleven does not take the slot kept for Thor (${started.join()})`);
  if (how === 'back') q.add(job('Thor', 'ethan', { rankKey: 'thor', startedBefore: at('14:54') }), { overLimit: true });
  else if (how === 'let go') q.forgetExpected('thor');
  else {
    const due = () => { for (const tm of timers.filter((x) => x.at <= now)) { clock.clearTimeout(tm); tm.fn(); } };
    now += 10 * 60_000 - 1000;
    due();
    await settle();
    ok(started.join() === 'Furious 7', `${how}: not before then (${started.join()})`);
    ok(timers.length === 1, `${how}: a wake-up is set for then, when nothing else may happen (${timers.length})`);
    now += 2000;
    due();
  }
  await settle();
  const next = how === 'back' ? 'Thor' : "Ocean's Eleven";
  ok(started.join() === `Furious 7,${next}`, `${how}: then the slot is ${next}'s (${started.join()})`);
  q.close();
}

/* ----------------------------------------------------- the movie plugin */

const LIB = fs.mkdtempSync(path.join(os.tmpdir(), 'started-turn-lib-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'started-turn-work-'));
const FILMS = [
  ['Furious 7', 2015], ['Iron Man 3', 2013], ['Thor The Dark World', 2013], ['The Fate of the Furious', 2017],
  ['Fast X', 2023], ["Oceans Eleven", 2001], ['Up', 2009], ['Heat', 1995], ['Alien', 1979],
];
for (const [title, year] of FILMS) fs.writeFileSync(path.join(LIB, `${title} ${year}.mp4`), 'x');

/** A journal entry as _runRequest writes one; `startedAt` as deliver() adds it. */
function film(id, title, year, member, requester, { startedAt = null, queuedAt = at('12:00') } = {}) {
  return {
    jobKey: `${id}:tt-${title}`, msgId: id, msgKey: { id, remoteJid: 'movies@g.us' }, chatJid: 'movies@g.us',
    movie: { title, year, rated: 'PG-13' }, meta: { requester, memberKey: member },
    record: { id: `h-${id}`, request: title.toLowerCase(), status: 'queued', title, year, requester },
    at: queuedAt, ...(startedAt ? { startedAt } : {}),
  };
}

/**
 * The movie plugin as recovery runs it, with deliver() replaced by a gate
 * the test opens: `started` is the order the films really started in.
 */
function movieRig({ concurrency, journal, queue = null, bot = null }) {
  const t = bot ?? fakeBot();
  const data = { pending: journal };
  const q = queue ?? new JobQueue({ concurrency, maxLength: 50, fairShare: true, extraFilmHoldMs: HOLD });
  const started = [];
  const gates = new Map();
  const plugin = Object.create(moviePlugin);
  plugin._reactors = new Map();
  plugin._recovering = null;
  plugin.deliver = ({ movie }) => { started.push(movie.title); return new Promise((r) => gates.set(movie.title, r)); };
  const ctx = {
    store: storeOf(data), queue: q, log: quiet, bot: t.bot,
    config: {
      movieRequests: {
        blockedRatings: [], notify: {},
        reactions: { rated: '⛔', failed: '⚠️', cancelled: '❌', added: '🎬', downloading: '⬇️', converting: '⚙️', sending: '⬆️', positions: NUM, positionOverflow: '🔢' },
      },
      media: { workDir: WORK }, library: { provider: 'local', local: { roots: [LIB] } }, omdb: {},
    },
  };
  // What setup() hooks up: each waiting request's number follows the line.
  const onQ = () => plugin._updatePositions(ctx);
  for (const ev of ['added', 'updated', 'state']) q.on(ev, onQ);
  const finish = async (title) => { gates.get(title)?.(); await settle(); };
  return { t, data, q, ctx, plugin, started, finish };
}

console.log('=== the incident: Thor, started before the restart, runs again ahead of Ocean\'s Eleven ===');
{
  // The live journal at 15:22, as far as it matters: three films running
  // (3/3), and the members' waiting ones. Thor has its download on disk, as
  // it did; the journal says when each film started.
  const journal = [
    film('ACF6', 'Furious 7', 2015, 'jake', 'jake ingram', { startedAt: at('13:29') }),
    film('3A11', 'Iron Man 3', 2013, 'ethan', 'Ethan Adams', { startedAt: at('14:53') }),
    film('3A78', 'Thor The Dark World', 2013, 'ethan', 'Ethan Adams', { startedAt: at('14:54') }),
    film('AC2C', 'The Fate of the Furious', 2017, 'jake', 'jake ingram'),
    film('AC9C', 'Fast X', 2023, 'jake', 'jake ingram'),
    film('3A75', 'Oceans Eleven', 2001, 'ari', 'Ari Mills', { queuedAt: at('15:18') }),
  ];
  const thorWork = openWork({
    workDir: WORK, key: workKey.movie(journal[2].jobKey), kind: 'movie', label: 'Thor The Dark World',
    isSafe: (p) => isSafeToDeleteIn(p, { workDir: WORK }),
  });
  thorWork.record({ item: { id: 'thor', access: 'download', total: 1_790_000_000 }, source: { name: 'source.mp4', bytes: 1_790_000_000 } });
  const { t, q, ctx, plugin, started, finish } = movieRig({ concurrency: 3, journal });
  plugin._expectBack(ctx, new Set(journal.map((p) => p.jobKey)));        // as setup() does
  await plugin.recoverPending(ctx);
  await settle();
  ok(started.join() === 'Furious 7,Iron Man 3,Thor The Dark World',
    `the three films that were running are the three running again (${started.join()})`);
  ok(!started.includes('Oceans Eleven'), "Ocean's Eleven does not take Thor's slot");
  ok(t.numbersOn('3A78').length === 0, `no place number on Thor's message (${t.on('3A78').join(' ')})`);
  // Its stage, never 🔄: a member read 🔄 as "send it again" (Iron Man 3,
  // 2026-10-11, test/no-redo-reaction.test.mjs).
  ok(t.on('3A78').join(' ') === '⬇️', `it shows its stage, not 🔄 (${t.on('3A78').join(' ')})`);
  const line = q.snapshot().pending.map((e) => e.label);
  ok(line.join() === "Oceans Eleven (2001),The Fate of the Furious (2017),Fast X (2023)",
    `the waiting films keep the fair order: Ari's first before jake's second and third (${line.join()})`);
  // Put back one at a time, the line moves as each one comes: what counts
  // is the place each message is left showing.
  const shows = (id) => t.on(id).at(-1);
  ok(shows('3A75') === '1️⃣' && shows('AC2C') === '2️⃣' && shows('AC9C') === '3️⃣',
    `and each shows its place (${['3A75', 'AC2C', 'AC9C'].map(shows).join(' ')})`);
  await finish('Furious 7');
  ok(started.at(-1) === 'Oceans Eleven', `the first slot to free goes to the head of the line (${started.at(-1)})`);
  for (const title of [...started]) await finish(title);
  q.close();
}

console.log('=== more started films than slots: the rest wait as running, in the order they had started ===');
{
  // Journalled in another order than they started in, and behind a member
  // with one request: one slot, so each started film has to wait its turn.
  const journal = [
    film('W1', 'Up', 2009, 'ari', 'Ari Mills'),
    film('S2', 'Heat', 1995, 'ethan', 'Ethan Adams', { startedAt: at('14:54') }),
    film('S1', 'Alien', 1979, 'ethan', 'Ethan Adams', { startedAt: at('13:10') }),
  ];
  const { t, q, ctx, plugin, started, finish } = movieRig({ concurrency: 1, journal });
  await plugin.recoverPending(ctx);
  await settle();
  ok(started.join() === 'Alien', `the one that started first takes the slot (${started.join()})`);
  const snap = q.snapshot();
  ok(snap.active.map((e) => e.label).join() === 'Alien (1979),Heat (1995)',
    `the other is running too, waiting for a slot (${snap.active.map((e) => e.label).join()})`);
  ok(snap.pending.map((e) => e.label).join() === 'Up (2009)', `only Up is waiting (${snap.pending.map((e) => e.label).join()})`);
  ok(t.numbersOn('S2').length === 0 && t.on('S2').join(' ') === '⬇️', `Heat shows its stage, never a number and never 🔄 (${t.on('S2').join(' ')})`);
  ok(t.on('W1').join(' ') === '1️⃣', `Up gets its place (${t.on('W1').join(' ')})`);
  await finish('Alien');
  ok(started.join() === 'Alien,Heat', `Heat goes next, not Up, Ari's first (${started.join()})`);
  await finish('Heat');
  ok(started.join() === 'Alien,Heat,Up', `then Up (${started.join()})`);
  await finish('Up');
  ok(t.numbersOn('S2').length === 0, 'and Heat was never given a number');
  q.close();
}

console.log('=== a journal from before starts were recorded: a film with work on disk had started ===');
{
  const journal = [
    film('W2', 'Up', 2009, 'ari', 'Ari Mills'),
    film('E1', 'Alien', 1979, 'ethan', 'Ethan Adams'),
    film('E2', 'Heat', 1995, 'ethan', 'Ethan Adams'),
  ];
  const w = openWork({
    workDir: WORK, key: workKey.movie(journal[2].jobKey), kind: 'movie', label: 'Heat',
    isSafe: (p) => isSafeToDeleteIn(p, { workDir: WORK }),
  });
  w.record({ item: { id: 'heat', access: 'download', total: 1000 }, source: { name: 'source.mp4', bytes: 1000 } });
  const { t, q, ctx, plugin, started, finish } = movieRig({ concurrency: 1, journal });
  q.pause();
  await plugin.recoverPending(ctx);
  await settle();
  ok(q.snapshot().active.map((e) => e.label).join() === 'Heat (1995)', 'Heat, downloaded before the restart, is running');
  ok(q.snapshot().pending.map((e) => e.label).join() === 'Up (2009),Alien (1979)',
    `the rest wait in the fair order (${q.snapshot().pending.map((e) => e.label).join()})`);
  ok(t.numbersOn('E2').length === 0, 'with no number on Heat');
  q.resume();
  await settle();
  ok(started.join() === 'Heat', `and Heat starts first (${started.join()})`);
  await finish('Heat');
  q.close();
}

console.log('=== a film\'s start is journalled once, as it starts ===');
{
  const data = { pending: [film('J1', 'Up', 2009, 'ari', 'Ari Mills')] };
  const ctx = { store: storeOf(data), log: quiet };
  moviePlugin._journalStarted?.(ctx, data.pending[0].jobKey);
  const first = data.pending[0].startedAt;
  ok(first > 0, 'its journal entry says when it started');
  await settle(5);
  moviePlugin._journalStarted?.(ctx, data.pending[0].jobKey);
  ok(data.pending[0].startedAt === first, 'and a second run (a retry) keeps the first start');
  moviePlugin._journalStarted?.(ctx, 'not-journalled');
  ok(data.pending.length === 1, 'a job with no entry is left alone');
  moviePlugin._journalAdd(ctx, film('J1', 'Up', 2009, 'ari', 'Ari Mills'));
  ok(data.pending.length === 1 && data.pending[0].startedAt === first, 'the entry written again over it keeps the start');
  // Found in review: only an entry an older version wrote may be judged by
  // its work, so this version says "not yet" on every entry it writes.
  moviePlugin._journalAdd(ctx, film('J2', 'Alien', 1979, 'ari', 'Ari Mills'));
  ok(data.pending.find((p) => p.msgId === 'J2')?.startedAt === 0, 'a new entry says it has not started');
  const older = { pending: [film('J3', 'Heat', 1995, 'ari', 'Ari Mills')] };
  moviePlugin._journalAdd({ store: storeOf(older), log: quiet }, film('J3', 'Heat', 1995, 'ari', 'Ari Mills'));
  ok(!('startedAt' in older.pending[0]), 'and one an older version wrote is left for its work to answer');
  const src = fs.readFileSync(new URL('../src/plugins/movie-requests/index.js', import.meta.url), 'utf8');
  const deliver = src.slice(src.indexOf('  async deliver({'), src.indexOf('work.lock();', src.indexOf('  async deliver({')));
  ok(/this\._journalStarted\(ctx, jobKey\);/.test(deliver), 'deliver() journals it before anything can fail');
}

/* -------------------------------------------------------- the TV plugin */

/** A TV journal entry as onMessage writes one. */
function season(reqKey, label, member, eps, extra = {}) {
  return {
    reqKey, label, msgId: `m-${reqKey}`, msgKey: { id: `m-${reqKey}`, remoteJid: 'tv@g.us' }, chatJid: 'tv@g.us',
    requester: member, requesterNumber: null, memberKey: member,
    baseRow: { id: `h-${reqKey}`, kind: 'tv', status: 'queued', at: at('11:00') },
    episodes: eps.map(([series, s, e]) => ({ id: `${series}-${s}-${e}`, series, season: s, episode: e, title: `Ep ${e}` })),
    ...extra,
  };
}

function tvRig(journal, { queue = null, bot = null } = {}) {
  const t = bot ?? fakeBot();
  const data = { pending: journal };
  const q = queue ?? new JobQueue({ concurrency: 1, maxLength: 50, fairShare: true });
  const started = [];
  const gates = new Map();
  const plugin = Object.create(tvPlugin);
  plugin._live = new Map();
  plugin._reactors = new Map();
  plugin._awaitingRecovery = null;
  plugin.deliverEpisode = ({ ep }) => {
    const label = `${ep.series} S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`;
    started.push(label);
    return new Promise((r) => gates.set(label, r));
  };
  const ctx = {
    store: storeOf(data), queue: q, log: quiet, bot: t.bot,
    config: {
      tvRequests: {},
      movieRequests: { reactions: { done: '✅', added: '🎬', downloading: '⬇️', converting: '⚙️', sending: '⬆️', positions: NUM, positionOverflow: '🔢' } },
    },
  };
  const onQ = () => plugin._updatePositions(ctx);
  for (const ev of ['added', 'updated', 'state']) q.on(ev, onQ);
  const finish = async () => { gates.get(started.at(-1))?.(); await settle(); };
  return { t, data, q, ctx, plugin, started, finish };
}

console.log('=== TV: a season that had started resumes before the waiting requests, with no number ===');
{
  // Journalled behind two waiting requests (an admin had moved it up), and
  // its member's second: the fair order and the journal both put it last.
  const journal = [
    season('tv-loki', 'Loki season 1', 'ethan', [['Loki', 1, 1]]),
    season('tv-friends', 'Friends season 1', 'ari', [['Friends', 1, 1]]),
    season('tv-rookie', 'The Rookie season 3', 'ethan', [['The Rookie', 3, 3], ['The Rookie', 3, 4]],
      { startedAt: at('12:00'), tally: { completed: 2, failed: 0, cancelled: 0, skipped: 0 } }),
  ];
  const { t, q, ctx, plugin, started, finish } = tvRig(journal);
  q.pause();
  await plugin.recoverPending(ctx);
  await settle();
  const snap = q.snapshot();
  ok(snap.active.map((e) => e.label).join() === 'The Rookie season 3', `The Rookie is running (${snap.active.map((e) => e.label).join()})`);
  ok(snap.pending.map((e) => e.label).join() === 'Friends season 1,Loki season 1',
    `the waiting requests keep the fair order: Ari's first before Ethan's second (${snap.pending.map((e) => e.label).join()})`);
  ok(t.numbersOn('m-tv-rookie').length === 0, `no place number on The Rookie's message (${t.on('m-tv-rookie').join(' ')})`);
  ok(t.on('m-tv-rookie').join(' ') === '⬇️', `it shows its stage, not 🔄 (${t.on('m-tv-rookie').join(' ')})`);
  ok(t.on('m-tv-friends').join(' ') === '1️⃣' && t.on('m-tv-loki').join(' ') === '2️⃣',
    `the waiting ones show their places (${t.on('m-tv-friends').join('')} ${t.on('m-tv-loki').join('')})`);
  q.resume();
  await settle();
  for (let i = 0; i < 3; i++) await finish();
  ok(started.join() === 'The Rookie S03E03,The Rookie S03E04,Friends S01E01,Loki S01E01',
    `the season finishes first, then the line (${started.join()})`);
  await finish();
  q.close();
}

console.log('=== TV: not paused, the started season still goes first though it was journalled last ===');
{
  const journal = [
    season('tv-friends2', 'Friends season 2', 'ari', [['Friends', 2, 1]]),
    season('tv-rookie2', 'The Rookie season 4', 'ethan', [['The Rookie', 4, 5]], { startedAt: at('12:30') }),
  ];
  const { t, q, ctx, plugin, started, finish } = tvRig(journal);
  await plugin.recoverPending(ctx);
  await settle();
  ok(started.join() === 'The Rookie S04E05', `the interrupted season takes the free slot (${started.join()})`);
  ok(t.on('m-tv-friends2').join(' ') === '1️⃣', `Friends waits, first in line (${t.on('m-tv-friends2').join(' ')})`);
  await finish();
  await finish();
  q.close();
}

console.log('=== TV: a journal from before starts were recorded - an episode that ended says it had started ===');
{
  const journal = [
    season('tv-a', 'Friends season 3', 'ari', [['Friends', 3, 1]]),
    season('tv-b', 'Loki season 2', 'ethan', [['Loki', 2, 1]]),
    season('tv-c', 'The Rookie season 5', 'ethan', [['The Rookie', 5, 2]], { tally: { completed: 1, failed: 0, cancelled: 0, skipped: 0 } }),
    season('tv-d', 'Elle season 1', 'ari', [['Elle', 1, 1]], { tally: { completed: 0, failed: 0, cancelled: 1, skipped: 1 } }),
  ];
  const { t, q, ctx, plugin } = tvRig(journal);
  q.pause();
  await plugin.recoverPending(ctx);
  await settle();
  const snap = q.snapshot();
  ok(snap.active.map((e) => e.label).join() === 'The Rookie season 5', `the season with a finished episode is running (${snap.active.map((e) => e.label).join()})`);
  ok(snap.pending.map((e) => e.label).join() === 'Friends season 3,Loki season 2,Elle season 1',
    `one whose only ending was a skip before it ran is waiting (${snap.pending.map((e) => e.label).join()})`);
  ok(t.numbersOn('m-tv-c').length === 0, 'and the running one has no number');
  q.close();
}

console.log('=== TV: a request\'s first start is journalled once, as its episode starts ===');
{
  const data = { pending: [season('tv-j', 'Loki season 1', 'ethan', [['Loki', 1, 1]])] };
  const ctx = { store: storeOf(data), log: quiet };
  tvPlugin._journalStarted?.(ctx, 'tv-j');
  const first = data.pending[0].startedAt;
  ok(first > 0, 'its journal entry says when it started');
  await settle(5);
  tvPlugin._journalStarted?.(ctx, 'tv-j');
  ok(data.pending[0].startedAt === first, 'and its next episode keeps the first start');
  // onMessage writes the entry again once it knows what the queue took; an
  // episode may have started in between.
  tvPlugin._journalAdd(ctx, season('tv-j', 'Loki season 1', 'ethan', [['Loki', 1, 1]]));
  ok(data.pending.length === 1 && data.pending[0].startedAt === first, 'and so does the entry written again over it');
  tvPlugin._journalAdd(ctx, season('tv-k', 'Loki season 2', 'ethan', [['Loki', 2, 1]]));
  ok(data.pending.find((r) => r.reqKey === 'tv-k')?.startedAt === 0, 'a new entry says it has not started');
  ok(tvPlugin._startOf({ config: {} }, { reqKey: 'x', startedAt: 0, tally: { completed: 1 }, baseRow: { at: at('11:00') } }) === null,
    'and that is the answer, whatever else the entry holds');
  ok(tvPlugin._startOf({ config: {} }, { reqKey: 'x', tally: { completed: 1 }, baseRow: { at: at('11:00') } }) === at('11:00'),
    'while one an older version wrote is answered by the episodes that ended');
  const src = fs.readFileSync(new URL('../src/plugins/tv-requests/index.js', import.meta.url), 'utf8');
  const head = src.slice(src.indexOf('  async deliverEpisode({'), src.indexOf('work.lock();', src.indexOf('  async deliverEpisode({')));
  ok(/this\._journalStarted\(ctx, reqKey\);/.test(head), 'deliverEpisode() journals it before anything can fail');
}

/* ------------------------------------------------ found in review of it */

console.log('=== a request that took over a parked film\'s work, and never started, comes back waiting in the fair order ===');
for (const older of [false, true]) {
  // Found in review of this change, 2026-10-11. Work on disk was read as a
  // start for every journal entry, not only for one journalled before starts
  // were recorded. A member asking again for a film left for the next start
  // (_park: "will retry on next start", the line the hourly check restarts
  // the bot for) queues a new request that takes the old one's work over
  // (_supersedeParked), work begun hours before the new request was made. At
  // the restart that request, which had never started, came back running:
  // Heat took the one slot ahead of Up, which really had been running, got no
  // place number, and Ari's first request, Fast X, was ranked as her second
  // and fell behind Alien. `older`: the same journal as a version from before
  // starts were recorded wrote it, where only the work can say.
  const tag = older ? 'o' : 'n';
  const isSafe = (f) => isSafeToDeleteIn(f, { workDir: WORK });
  const data = { pending: [] };
  const ctx0 = {
    store: storeOf(data), log: quiet,
    config: { media: { workDir: WORK }, library: { local: { roots: [LIB] } }, movieRequests: { reactions: {} } },
  };
  const before = Object.create(moviePlugin);
  const parked = film(`P${tag}`, 'Heat', 1995, 'ari', 'Ari Mills', { startedAt: at('13:00'), queuedAt: at('12:50') });
  before._journalAdd(ctx0, parked);
  const old = openWork({ workDir: WORK, key: workKey.movie(parked.jobKey), kind: 'movie', label: 'Heat', isSafe });
  old.record({ item: { id: 'heat', access: 'download', total: 1000 }, source: { name: 'source.mp4', bytes: 1000 } });
  // Begun at 13:00, by the old request's run.
  const mf = path.join(old.dir, MANIFEST);
  fs.writeFileSync(mf, JSON.stringify({ ...JSON.parse(fs.readFileSync(mf, 'utf8')), createdAt: at('13:00') }));
  before._parked = new Set([parked.jobKey]);
  before._journalAdd(ctx0, film(`U${tag}`, 'Up', 2009, 'jake', 'jake ingram', { startedAt: at('15:00'), queuedAt: at('14:50') }));
  before._journalAdd(ctx0, film(`F${tag}`, 'Fast X', 2023, 'ari', 'Ari Mills', { queuedAt: at('15:01') }));
  before._journalAdd(ctx0, film(`A${tag}`, 'Alien', 1979, 'ethan', 'Ethan Adams', { queuedAt: at('15:02') }));
  // Ari asks for Heat again at 15:10: the new request takes the old one's place, and its work.
  const heat = film(`H${tag}`, 'Heat', 1995, 'ari', 'Ari Mills', { queuedAt: at('15:10') });
  before._supersedeParked(ctx0, heat.movie, null, heat.jobKey);
  before._journalAdd(ctx0, heat);
  ok(!data.pending.some((p) => p.jobKey === parked.jobKey), `${tag}: the parked request has left the journal`);
  const w = openWork({ workDir: WORK, key: workKey.movie(heat.jobKey), kind: 'movie', label: 'Heat', isSafe });
  ok(w.has() && w.manifest.createdAt === at('13:00'), `${tag}: and the new one holds its work, begun at 13:00`);
  if (older) {
    for (const p of data.pending) delete p.startedAt;
    data.pending.find((p) => p.jobKey === `U${tag}:tt-Up`).startedAt = at('15:00');
  }

  // The restart.
  forgetThisProcess();
  const { t, q, ctx, plugin, started, finish } = movieRig({ concurrency: 1, journal: data.pending });
  plugin._expectBack(ctx, new Set(data.pending.map((p) => p.jobKey)));
  await plugin.recoverPending(ctx);
  await settle();
  ok(started.join() === 'Up', `${tag}: Up, which had been running, takes the one slot (${started.join()})`);
  const snap = q.snapshot();
  ok(snap.active.map((e) => e.label).join() === 'Up (2009)', `${tag}: and is the only one running (${snap.active.map((e) => e.label).join()})`);
  ok(snap.pending.map((e) => e.label).join() === 'Fast X (2023),Alien (1979),Heat (1995)',
    `${tag}: Heat waits behind both first requests, as Ari's second (${snap.pending.map((e) => e.label).join()})`);
  ok(t.on(`H${tag}`).at(-1) === '3️⃣', `${tag}: with its place number (${t.on(`H${tag}`).join(' ')})`);
  ok(t.on(`F${tag}`).at(-1) === '1️⃣' && !t.on(`F${tag}`).includes('2️⃣'),
    `${tag}: Fast X is Ari's first, and never shown as second (${t.on(`F${tag}`).join(' ')})`);
  for (let i = 0; i < 4; i++) await finish(started.at(-1));
  q.close();
}

console.log('=== a member\'s started season counts before his waiting film is ranked, though TV goes back after the films ===');
{
  // Found in review of this change, 2026-10-11. TV recovery waits for the
  // films (holdTvRecovery), and a film's rank was fixed from its member's
  // requests in the queue when it was added - so Ethan's waiting Heat was
  // ranked before his running Loki season was back: as his first, ahead of
  // Ari's first request and not held behind the TV, and it started in the
  // free slot. Before the restart the same requests stood Up 1️⃣, Heat 2️⃣.
  const q = new JobQueue({ concurrency: 1, maxLength: 50, fairShare: true, extraFilmHoldMs: HOLD });
  const bot = fakeBot();
  const tvJournal = [season('tv-loki9', 'Loki season 1', 'ethan', [['Loki', 1, 1], ['Loki', 1, 2]], { startedAt: at('14:00') })];
  // Queued seconds before the restart: a film's hold behind the TV runs from
  // when it was first queued, not from when recovery puts it back (queue.js
  // _holdEnd; test/held-film-keeps-its-hour-across-a-restart.test.mjs), so
  // Heat is still inside its film cooldown.
  const filmJournal = [
    film('E9', 'Heat', 1995, 'ethan', 'Ethan Adams', { queuedAt: Date.now() - 2000 }),
    film('A9', 'Up', 2009, 'ari', 'Ari Mills', { queuedAt: Date.now() - 1000 }),
  ];
  const m = movieRig({ concurrency: 1, journal: filmJournal, queue: q, bot });
  const tv = tvRig(tvJournal, { queue: q, bot });
  // As setup() does, in the order the plugins load; then recovery as it runs.
  m.plugin._expectBack(m.ctx, new Set(filmJournal.map((p) => p.jobKey)));
  tv.plugin._expectBack(tv.ctx, new Set(tvJournal.map((r) => r.reqKey)));
  const release = holdTvRecovery(q);
  const tvDone = tv.plugin.recoverPending(tv.ctx);
  try { await m.plugin.recoverPending(m.ctx); } finally { release(); }
  await tvDone;
  await settle();
  ok(m.started.join() === 'Up' && !tv.started.length,
    `Ari's first request takes the slot, films before TV (films: ${m.started.join()}; TV: ${tv.started.join()})`);
  const snap = q.snapshot();
  ok(snap.active.map((e) => e.label).join() === 'Loki season 1,Up (2009)',
    `Loki is running, between two episodes (${snap.active.map((e) => e.label).join()})`);
  ok(snap.pending.map((e) => e.label).join() === 'Heat (1995)', `Heat waits (${snap.pending.map((e) => e.label).join()})`);
  ok(!bot.on('A9').includes('2️⃣'), `Up was never shown behind Heat (${bot.on('A9').join(' ')})`);
  ok(bot.numbersOn('m-tv-loki9').length === 0, 'and Loki got no number');
  await m.finish('Up');
  ok(tv.started.join() === 'Loki S01E01' && m.started.join() === 'Up',
    `Heat, Ethan's second, is held behind his season for the film cooldown (TV: ${tv.started.join()}; films: ${m.started.join()})`);
  await tv.finish();
  await tv.finish();
  await m.finish('Heat');
  q.close();
}

console.log('=== a started film whose lookup fails at the restart keeps its slot until its retry puts it back ===');
{
  // Found in review of this change, 2026-10-11. The started films went first
  // only if every one of their library lookups succeeded at boot. One "fetch
  // failed" - Jellyfin or OMDb away for a minute as the bot starts, which
  // recovery allows for by trying again shortly (_retryLater) - and the
  // waiting films behind it started in the free slot at once: Thor, failing
  // once, lost its slot to Ocean's Eleven as on the day.
  const journal = [
    film('RF7', 'Furious 7', 2015, 'jake', 'jake ingram', { startedAt: at('13:29') }),
    film('RIM', 'Iron Man 3', 2013, 'ethan', 'Ethan Adams', { startedAt: at('14:53') }),
    film('RTH', 'Thor The Dark World', 2013, 'ethan', 'Ethan Adams', { startedAt: at('14:54') }),
    film('RFF', 'The Fate of the Furious', 2017, 'jake', 'jake ingram'),
    film('ROE', 'Oceans Eleven', 2001, 'ari', 'Ari Mills', { queuedAt: at('15:18') }),
  ];
  const { t, q, ctx, plugin, started, finish } = movieRig({ concurrency: 3, journal });
  plugin._retries = new RetryBook({ delayMs: () => 60, log: quiet });
  const real = plugin._resume;
  let failures = 0;
  plugin._resume = function (c, p, opts) {
    if (/Thor/.test(p.movie.title) && !failures++) return Promise.reject(new Error('fetch failed'));
    return real.call(this, c, p, opts);
  };
  plugin._expectBack(ctx, new Set(journal.map((p) => p.jobKey)));
  await plugin.recoverPending(ctx);
  await settle();
  ok(started.join() === 'Furious 7,Iron Man 3', `the two films put back run (${started.join()})`);
  ok(!started.includes('Oceans Eleven'), "Ocean's Eleven does not take the slot Thor is coming back to");
  ok(q.snapshot().retrying.map((r) => r.label).join() === 'Thor The Dark World (2013)',
    `Thor is on the panel, waiting for its retry (${q.snapshot().retrying.map((r) => r.label).join()})`);
  await settle(120);
  ok(started.join() === 'Furious 7,Iron Man 3,Thor The Dark World', `its retry puts Thor back in the slot (${started.join()})`);
  ok(t.numbersOn('RTH').length === 0, `Thor was never given a place number (${t.on('RTH').join(' ')})`);
  ok(q.snapshot().active.find((e) => /Thor/.test(e.label))?.state === 'running', 'and it runs as it did');
  ok(q.snapshot().pending.map((e) => e.label).join() === 'Oceans Eleven (2001),The Fate of the Furious (2017)',
    `the waiting films keep the fair order (${q.snapshot().pending.map((e) => e.label).join()})`);
  await finish('Furious 7');
  ok(started.at(-1) === 'Oceans Eleven', `the first slot to free goes to the head of the line (${started.at(-1)})`);
  for (const title of [...started]) await finish(title);
  plugin._retries.clear();
  q.close();
}

fs.rmSync(LIB, { recursive: true, force: true });
fs.rmSync(WORK, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
