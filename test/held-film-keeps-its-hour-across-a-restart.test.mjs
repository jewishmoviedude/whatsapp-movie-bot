/* An extra film is held behind the TV for the film cooldown from when it was first queued, restart or not.
   Run: node test/held-film-keeps-its-hour-across-a-restart.test.mjs

   With the fair order on (queue.fairShare), a member's extra film - asked
   for inside their cooldown (test/request-inside-cooldown-is-an-extra.test.mjs),
   or their second request by count - waits behind the TV until the film
   cooldown has passed since it was queued (queue.extraFilmHoldMs, the
   operator's rule of 2026-09-30). The queue held it from the moment the job
   was added to it, and a restart adds every journalled job again: a marked
   film got a fresh full hour behind the TV after every restart, past the end
   of its member's cooldown. Avi's Dune, queued at 10:00 inside his cooldown
   and held to 11:00; the bot restarts at 10:50; Dune is held to 11:50
   (found in review, 2026-10-12, and reproduced). The live log had restarts
   at 07:16, 21:16 and 21:59 that day.

   Now the hold runs from when the request was first queued - the time a
   restart gives back from the journal (queue.expectBack) - so it ends when
   it would have ended with no restart. Driven on the real JobQueue, and
   through the real movie plugin's recovery. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobQueue } from '../src/core/queue.js';
import moviePlugin from '../src/plugins/movie-requests/index.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));

const MIN = 60_000;
const HOLD = 60 * MIN;                                 // the live film cooldown: an hour
const T0 = Date.parse('2026-10-12T10:00:00Z');
const MARK = { what: 'Heat (1995)', at: T0 - 5 * MIN, gapMs: 5 * MIN };
const clockTime = (t) => new Date(t).toISOString().slice(11, 16);

/** A clock the test moves by hand, with the timers the queue sets on it. */
function fakeClock(start) {
  let t = start;
  const timers = [];
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const h = { fn, at: t + ms, cleared: false, unref() {} }; timers.push(h); return h; },
    clearTimeout: (h) => { if (h) h.cleared = true; },
    advance(ms) {
      t += ms;
      for (const h of timers.filter((x) => !x.cleared && x.at <= t)) { h.cleared = true; h.fn(); }
    },
  };
}

const film = (label, member, { meta = {}, ...extra } = {}) => ({ label, meta: { memberKey: member, ...meta }, ...extra, run: async () => {} });
const tv = (label, member, extra = {}) => ({
  label, kind: 'tv', group: `tv-${member}`, groupMeta: { memberKey: member }, meta: { memberKey: member }, ...extra, run: async () => {},
});
const waiting = (q) => q.snapshot().pending.map((e) => e.label);
const heldUntil = (q, label) => q.snapshot().pending.find((e) => e.label === label)?.fair?.heldUntil ?? null;

console.log('=== the queue: Avi\'s marked Dune, held to 11:00, is still held to 11:00 after a restart at 10:50 ===');
{
  const before = fakeClock(T0);
  const q = new JobQueue({ concurrency: 1, fairShare: true, extraFilmHoldMs: HOLD, clock: before });
  q.pause();
  q.add(tv('Bob: Arrow S01E01', 'bob'));
  q.add(film('Avi: Dune', 'avi', { meta: { insideCooldown: MARK } }));
  ok(waiting(q).join() === 'Bob: Arrow S01E01,Avi: Dune', `Dune waits behind the TV (${waiting(q).join()})`);
  ok(heldUntil(q, 'Avi: Dune') === T0 + HOLD, `held until 11:00 (${clockTime(heldUntil(q, 'Avi: Dune'))})`);
  q.close();

  // The restart: a new queue, told what the journal holds before anything is back.
  const after = fakeClock(T0 + 50 * MIN);
  const r = new JobQueue({ concurrency: 1, fairShare: true, extraFilmHoldMs: HOLD, clock: after });
  r.pause();
  r.expectBack([
    { key: 'dune', meta: { memberKey: 'avi', insideCooldown: MARK }, at: T0, label: 'Avi: Dune' },
    { key: 'arrow', meta: { memberKey: 'bob' }, at: T0 - MIN, label: 'Bob: Arrow' },
  ]);
  r.add(film('Avi: Dune', 'avi', { rankKey: 'dune' }));
  r.add(tv('Bob: Arrow S01E01', 'bob', { rankKey: 'arrow' }));
  ok(waiting(r).join() === 'Bob: Arrow S01E01,Avi: Dune', `back behind the TV (${waiting(r).join()})`);
  ok(heldUntil(r, 'Avi: Dune') === T0 + HOLD,
    `still held until 11:00, not 11:50 (${clockTime(heldUntil(r, 'Avi: Dune'))})`);
  after.advance(10 * MIN + 1);
  ok(waiting(r).join() === 'Avi: Dune,Bob: Arrow S01E01' && heldUntil(r, 'Avi: Dune') == null,
    `at 11:00 it goes ahead of the TV, as it would have with no restart (${waiting(r).join()})`);
  r.close();
}

console.log('=== the queue: an extra by count is held from when it was queued too ===');
{
  const after = fakeClock(T0 + 50 * MIN);
  const r = new JobQueue({ concurrency: 1, fairShare: true, extraFilmHoldMs: HOLD, clock: after });
  r.pause();
  r.expectBack([
    { key: 'heat', meta: { memberKey: 'avi' }, at: T0 - MIN, label: 'Avi: Heat' },
    { key: 'dune', meta: { memberKey: 'avi' }, at: T0, label: 'Avi: Dune' },
  ]);
  r.add(film('Avi: Heat', 'avi', { rankKey: 'heat' }));
  r.add(film('Avi: Dune', 'avi', { rankKey: 'dune' }));
  r.add(tv('Bob: Arrow S01E01', 'bob'));
  ok(waiting(r).join() === 'Avi: Heat,Bob: Arrow S01E01,Avi: Dune', `his second film waits behind the TV (${waiting(r).join()})`);
  ok(heldUntil(r, 'Avi: Dune') === T0 + HOLD, `until 11:00, an hour after it was queued (${clockTime(heldUntil(r, 'Avi: Dune'))})`);
  r.close();
}

console.log('=== the queue: one put back after its hour has passed is not held at all ===');
{
  const after = fakeClock(T0 + 70 * MIN);
  const r = new JobQueue({ concurrency: 1, fairShare: true, extraFilmHoldMs: HOLD, clock: after });
  r.pause();
  r.expectBack([{ key: 'dune', meta: { memberKey: 'avi', insideCooldown: MARK }, at: T0, label: 'Avi: Dune' }]);
  r.add(tv('Bob: Arrow S01E01', 'bob'));
  r.add(film('Avi: Dune', 'avi', { rankKey: 'dune' }));
  ok(waiting(r).join() === 'Avi: Dune,Bob: Arrow S01E01' && heldUntil(r, 'Avi: Dune') == null,
    `a restart at 11:10 puts it ahead of the TV at once (${waiting(r).join()})`);
  r.close();
}

console.log('=== the queue: a film queued in this process is held from then, as before ===');
{
  const clock = fakeClock(T0);
  const q = new JobQueue({ concurrency: 1, fairShare: true, extraFilmHoldMs: HOLD, clock });
  q.pause();
  clock.advance(5 * MIN);
  q.add(tv('Bob: Arrow S01E01', 'bob'));
  q.add(film('Avi: Dune', 'avi', { meta: { insideCooldown: MARK } }));
  ok(heldUntil(q, 'Avi: Dune') === T0 + 5 * MIN + HOLD, `held until 11:05 (${clockTime(heldUntil(q, 'Avi: Dune'))})`);
  q.close();
}

/* ------------------------------------------------- the movie plugin */

console.log('=== the movie plugin: a restart puts Dune back held until an hour after it was journalled ===');
{
  const LIB = fs.mkdtempSync(path.join(os.tmpdir(), 'held-film-lib-'));
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'held-film-work-'));
  process.on('exit', () => { for (const d of [LIB, WORK]) fs.rmSync(d, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(LIB, 'Dune 2021.mp4'), 'not really a film');
  // Queued 50 minutes before this start, inside Avi's cooldown, and journalled so.
  const queuedAt = Date.now() - 50 * MIN;
  const data = {
    pending: [{
      jobKey: 'D1:tt1160419', msgId: 'D1', msgKey: { id: 'D1', remoteJid: 'movies@g.us' }, chatJid: 'movies@g.us',
      movie: { title: 'Dune', year: 2021, imdbId: 'tt1160419', rated: 'PG-13' },
      meta: { requester: 'Avi', memberKey: 'avi', insideCooldown: { ...MARK, at: queuedAt - 5 * MIN } },
      record: { id: 'D1', request: 'dune 2021', status: 'queued', title: 'Dune', year: 2021, requester: 'Avi', enqueuedAt: queuedAt },
      at: queuedAt, startedAt: 0,
    }],
  };
  const store = { get: (k, d = null) => (k in data ? structuredClone(data[k]) : d), set: (k, v) => { data[k] = structuredClone(v); } };
  const q = new JobQueue({ concurrency: 1, maxLength: 50, fairShare: true, extraFilmHoldMs: HOLD });
  q.pause();
  q.add(tv('Bob: Arrow S01E01', 'bob'));
  const plugin = Object.create(moviePlugin);
  plugin._reactors = new Map();
  plugin._recovering = null;
  plugin.deliver = () => new Promise(() => {});
  const NUM = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
  const ctx = {
    store, queue: q, log: { info() {}, warn() {}, error() {}, debug() {} },
    bot: { isConnected: () => true, react: async () => true, sendText: async () => ({}), on() {}, off() {} },
    config: {
      movieRequests: {
        blockedRatings: [], notify: {},
        reactions: { rated: '⛔', failed: '⚠️', cancelled: '❌', added: '🎬', downloading: '⬇️', converting: '⚙️', sending: '⬆️', positions: NUM, positionOverflow: '🔢' },
      },
      media: { workDir: WORK }, library: { provider: 'local', local: { roots: [LIB] } }, omdb: {},
    },
  };
  plugin._expectBack(ctx, new Set(data.pending.map((p) => p.jobKey)));      // as setup() does
  await plugin.recoverPending(ctx);
  await settle();
  const line = waiting(q);
  ok(line.join() === 'Bob: Arrow S01E01,Dune (2021)', `Dune is back, behind the TV (${line.join()})`);
  const until = heldUntil(q, 'Dune (2021)');
  ok(until === queuedAt + HOLD, `held until an hour after it was first queued, ten minutes from now, not an hour from now `
    + `(${until == null ? 'not held' : `${Math.round((until - Date.now()) / MIN)} min from now`})`);
  q.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
