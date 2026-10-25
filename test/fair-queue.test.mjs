/* The fair queue: one member's extra requests wait behind everybody else's first.
   Run: node test/fair-queue.test.mjs

   The operator's request (2026-09-30), after the per-user cooldown was
   pointed out to them: "option in panel if another user requests something;
   the additional items of the person who did multiple should get bumped to
   bottom of queue so the other person can get the 1 item they need, if more
   people request 1 item then the items of person with additional should keep
   getting bumped to bottom of queue", and "those additional items should not
   go ahead of tv episodes until the cooldown timer ends, once timer ends they
   can jump the tv episodes in the queue". And: "the below should be OPTIONS
   for me to control and change in panel".

   So queue.fairShare, on by default in the config (JobQueue's own default is off): the waiting line goes round the members
   (everyone's first before anyone's second, a running request counting as
   the member's first), a TV season is one request, films still go before TV,
   and a member's extra film waits behind the TV for the film cooldown after
   it was queued - the queue wakes itself when that ends. Jobs queued from the
   panel, retries and jobs with no member count as first requests, never
   bumped, and once an admin moves something the line keeps the order it is
   left in. The pick follows the order the panel and the number reactions
   show. And queue.hasOthers(), which the cooldown's "nobody else is
   waiting" option asks. Off, everything is exactly as it was.

   queue.queuedSince() is gone (2026-10-01). The option asked it whether the
   request that started the member's clock had queued anything, because the
   clock started at every request; since the operator's rule of that day
   ("cooldown is only if the members first request actually puts an item in
   queue") the clock starts only when one does, so the question answers
   itself (test/cooldown-after-queued.test.mjs). */
import { JobQueue } from '../src/core/queue.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const tick = () => new Promise((r) => setTimeout(r, 15));

/** A clock the test moves by hand, with the timers the queue sets on it. */
function fakeClock(start = 1_000_000) {
  let t = start;
  const timers = [];
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const h = { fn, at: t + ms, cleared: false, unref() { h.unrefd = true; } }; timers.push(h); return h; },
    clearTimeout: (h) => { if (h) h.cleared = true; },
    advance(ms) {
      t += ms;
      for (const h of timers.filter((x) => !x.cleared && x.at <= t)) { h.cleared = true; h.fn(); }
    },
    armed: () => timers.filter((x) => !x.cleared),
  };
}

/**
 * Jobs that start when the queue says and end when the test says. `who` is
 * the member; `extra` is merged into the job (kind, group, retry, meta...).
 */
function jobs(order) {
  const gates = new Map();
  const make = (label, who, extra = {}) => {
    let release;
    const done = new Promise((r) => { release = r; });
    gates.set(label, release);
    const meta = { ...(who ? { memberKey: who } : {}), ...(extra.meta ?? {}) };
    return { label, ...extra, meta, run: async () => { order.push(label); await done; } };
  };
  const release = async (label) => { gates.get(label)?.(); await tick(); };
  return { make, release };
}

const waiting = (q) => q.snapshot().pending.map((e) => e.label);

console.log('=== fair queue off: the order is exactly what it always was ===');
{
  for (const strict of [true, false]) {
    const order = [];
    const q = new JobQueue({ concurrency: 1, strictMoviePriority: strict });
    const { make, release } = jobs(order);
    q.pause();
    for (const [l, who, kind] of [['A1', 'A', 'movie'], ['A2', 'A', 'movie'], ['T1', 'B', 'tv'], ['A3', 'A', 'movie'], ['B1', 'B', 'movie'], ['C1', 'C', 'movie']]) {
      q.add(make(l, who, { kind }));
    }
    const expect = strict ? 'A1,A2,A3,B1,C1,T1' : 'A1,A2,T1,A3,B1,C1';
    ok(q.fairShare === false, 'a JobQueue built without the config is the old queue (fairShare off)');
    ok(waiting(q).join() === expect, `strict ${strict}: arrival order (${waiting(q).join()})`);
    q.resume();
    await tick();
    for (let i = 0; i < 6; i++) await release(order[order.length - 1]);
    ok(order.join() === expect, `strict ${strict}: and they start in that order (${order.join()})`);
  }
  // With the fair order on but no member on any job (a queue of old journal
  // entries), nothing moves either.
  const q = new JobQueue({ concurrency: 1, fairShare: true });
  q.pause();
  for (const l of ['x1', 'x2', 'x3']) q.add({ label: l, run: async () => {} });
  q.add({ label: 't1', kind: 'tv', run: async () => {} });
  q.add({ label: 'x4', run: async () => {} });
  ok(waiting(q).join() === 'x1,x2,x3,x4,t1', `with no members, on changes nothing (${waiting(q).join()})`);
}

console.log('=== round robin: every first request before anyone\'s second ===');
{
  const order = [];
  const q = new JobQueue({ concurrency: 1, fairShare: true, strictMoviePriority: false });
  const { make, release } = jobs(order);
  q.pause();
  for (const [l, who] of [['A1', 'A'], ['A2', 'A'], ['A3', 'A'], ['B1', 'B'], ['B2', 'B'], ['C1', 'C']]) q.add(make(l, who));
  ok(waiting(q).join() === 'A1,B1,C1,A2,B2,A3', `three members take turns (${waiting(q).join()})`);
  ok(q.snapshot().pending.map((e) => e.place).join() === '1,2,3,4,5,6', 'placed 1 to 6 in that order');
  const extras = q.snapshot().pending.filter((e) => e.fair?.extra).map((e) => `${e.label}:${e.fair.rank}`);
  ok(extras.join() === 'A2:2,B2:2,A3:3', `the extra ones are marked, with their rank (${extras.join()})`);
  const shown = waiting(q).join();
  q.resume();
  await tick();
  for (let i = 0; i < 6; i++) await release(order[order.length - 1]);
  ok(order.join() === shown, `and they start in the order shown (${order.join()})`);
}

console.log('=== a member asking for one thing goes ahead of another\'s extras, again and again ===');
{
  const order = [];
  const q = new JobQueue({ concurrency: 1, fairShare: true });
  const { make, release } = jobs(order);
  q.add(make('A1', 'A'));
  await tick();
  ok(order.join() === 'A1', 'A\'s first film starts at once');
  q.add(make('A2', 'A'));
  q.add(make('A3', 'A'));
  ok(waiting(q).join() === 'A2,A3', 'A\'s extras wait');
  q.add(make('B1', 'B'));
  ok(waiting(q).join() === 'B1,A2,A3', `B's one film goes ahead of them (${waiting(q).join()})`);
  q.add(make('C1', 'C'));
  ok(waiting(q).join() === 'B1,C1,A2,A3', `and C's, after B's (${waiting(q).join()})`);
  await release('A1');
  ok(order.join() === 'A1,B1', `A's first finishing does not bring A2 back ahead: B1 runs next (${order.join()})`);
  q.add(make('D1', 'D'));
  ok(waiting(q).join() === 'C1,D1,A2,A3', `D's goes ahead of A's extras too (${waiting(q).join()})`);
  await release('B1');
  await release('C1');
  await release('D1');
  await release('A2');
  await release('A3');
  ok(order.join() === 'A1,B1,C1,D1,A2,A3', `A's extras run once nobody else is waiting (${order.join()})`);
  ok(!q.snapshot().pending.length && !q.snapshot().active.length, 'the queue is empty');
  q.add(make('A4', 'A'));
  await tick();
  ok(order[order.length - 1] === 'A4', 'and A\'s next request, in an empty queue, is a first one again');
  await release('A4');
}

console.log('=== a request running counts as its member\'s first; one cancelled unstarted does not ===');
{
  const order = [];
  const q = new JobQueue({ concurrency: 1, fairShare: true });
  const { make, release } = jobs(order);
  q.add(make('A1', 'A'));
  await tick();
  q.add(make('A2', 'A'));
  q.add(make('B1', 'B'));
  ok(waiting(q).join() === 'B1,A2', `A1 running makes A2 A's second (${waiting(q).join()})`);
  await release('A1');
  await release('B1');
  await release('A2');

  const q2 = new JobQueue({ concurrency: 1, fairShare: true });
  q2.pause();
  const a1 = q2.add(make('a1', 'A'));
  q2.add(make('a2', 'A'));
  q2.add(make('b1', 'B'));
  ok(waiting(q2).join() === 'a1,b1,a2', `paused: a1, b1, then a2 (${waiting(q2).join()})`);
  q2.cancel(a1);
  ok(waiting(q2).join() === 'a2,b1', `a1 cancelled before it started: a2 is A's first now, and came before b1 (${waiting(q2).join()})`);
}

console.log('=== a TV season is one request ===');
{
  const order = [];
  const q = new JobQueue({ concurrency: 1, fairShare: true });
  q.pause();
  const season = (key, who, n) => {
    for (let e = 1; e <= n; e++) {
      q.add({
        kind: 'tv', group: key, groupLabel: key, groupMeta: { memberKey: who },
        label: `${key}E${e}`, meta: { memberKey: who }, run: async () => { order.push(`${key}E${e}`); },
      });
    }
  };
  season('AS1', 'A', 3);
  season('AS2', 'A', 2);
  season('BS1', 'B', 2);
  ok(waiting(q).join() === 'AS1,BS1,AS2', `A's second season waits behind B's first (${waiting(q).join()})`);
  q.add({ label: 'Afilm', meta: { memberKey: 'A' }, run: async () => { order.push('Afilm'); } });
  const film = q.snapshot().pending.find((e) => e.label === 'Afilm');
  ok(film.fair?.rank === 3, `a film after two seasons is A's third request, not their sixth (${film.fair?.rank})`);
  q.resume();
  await tick(); await tick();
  ok(order.join() === 'Afilm,AS1E1,AS1E2,AS1E3,BS1E1,BS1E2,AS2E1,AS2E2',
    `films first, then the seasons in the fair order, each whole (${order.join()})`);
  // B's season started from behind A's second one in the array: its last
  // episode must not then wait behind a season that had not started (found
  // writing this test - AS2E1 ran between BS1E1 and BS1E2).
  ok(order.indexOf('BS1E2') < order.indexOf('AS2E1'), 'a season the fair order started out of turn finishes before the next one starts');
}

console.log('=== movies still go before TV, and the extra film is held behind the TV only for the cooldown ===');
{
  const order = [];
  const q = new JobQueue({ concurrency: 1, fairShare: true, extraFilmHoldMs: 0 });
  const { make } = jobs(order);
  q.pause();
  q.add(make('A1', 'A'));
  q.add(make('A2', 'A'));
  q.add(make('T1', 'B', { kind: 'tv' }));
  q.add(make('C1', 'C'));
  ok(waiting(q).join() === 'A1,C1,A2,T1', `films first, fair among themselves; with no cooldown, no hold (${waiting(q).join()})`);

  // The hold: the film cooldown is 30 s.
  const clock = fakeClock();
  const order2 = [];
  const h = new JobQueue({ concurrency: 1, fairShare: true, extraFilmHoldMs: 30_000, clock });
  const j2 = jobs(order2);
  let states = 0;
  h.on('state', () => { states += 1; });
  h.add(j2.make('A1', 'A'));
  await tick();
  h.add(j2.make('T1', 'B', { kind: 'tv' }));
  h.add(j2.make('A2', 'A'));
  const snap = h.snapshot();
  ok(waiting(h).join() === 'T1,A2', `A's extra film, just asked for, waits behind the TV (${waiting(h).join()})`);
  const a2 = snap.pending.find((e) => e.label === 'A2');
  ok(a2.place === 2 && a2.fair?.heldUntil === clock.now() + 30_000, `placed 2nd, held until the cooldown ends (${a2.place}, ${a2.fair?.heldUntil})`);
  ok(clock.armed().length === 1 && clock.armed()[0].at === clock.now() + 30_001 && clock.armed()[0].unrefd,
    'the queue has set one timer, unref\'d, for when the hold ends');
  await j2.release('A1');
  ok(order2.join() === 'A1,T1', `A1 done: the TV goes next, not the held film (${order2.join()})`);
  h.add(j2.make('T2', 'C', { kind: 'tv' }));
  ok(waiting(h).join() === 'T2,A2', `a TV request asked for later goes ahead of it too (${waiting(h).join()})`);
  const before = states;
  clock.advance(30_001);
  ok(states > before, 'when the hold ends the queue says so by itself (a state event), with nothing else happening');
  ok(waiting(h).join() === 'A2,T2', `and the film goes ahead of the TV now (${waiting(h).join()})`);
  ok(!h.snapshot().pending.find((e) => e.label === 'A2').fair.heldUntil, 'no longer shown as held');
  ok(clock.armed().length === 0, 'no timer left armed');
  await j2.release('T1');
  ok(order2.join() === 'A1,T1,A2', `the film starts when the episode ends (${order2.join()})`);
  await j2.release('A2');
  await j2.release('T2');

  // At the end of a hold the film may be able to start at once: the timer drains.
  const clock3 = fakeClock();
  const order3 = [];
  const r = new JobQueue({ concurrency: 2, fairShare: true, extraFilmHoldMs: 30_000, clock: clock3 });
  const j3 = jobs(order3);
  r.add(j3.make('Afirst', 'A', { kind: 'tv', group: 'AS', groupMeta: { memberKey: 'A' } }));
  await tick();
  r.add(j3.make('Afilm', 'A'));
  await tick();
  ok(order3.join() === 'Afirst', `with the slot kept for films, a held film does not take it (${order3.join()})`);
  clock3.advance(30_001);
  await tick();
  ok(order3.join() === 'Afirst,Afilm', `once the hold ends it starts in that slot, with no other event (${order3.join()})`);
  await j3.release('Afilm');
  await j3.release('Afirst');

  // Strict priority off: films never go ahead of TV anyway, so nothing is held.
  const clock4 = fakeClock();
  const s = new JobQueue({ concurrency: 1, fairShare: true, strictMoviePriority: false, extraFilmHoldMs: 30_000, clock: clock4 });
  s.pause();
  s.add({ label: 'A1', meta: { memberKey: 'A' }, run: async () => {} });
  s.add({ label: 'A2', meta: { memberKey: 'A' }, run: async () => {} });
  s.add({ label: 'T1', kind: 'tv', meta: { memberKey: 'B' }, run: async () => {} });
  ok(waiting(s).join() === 'A1,T1,A2' && clock4.armed().length === 0, `strict off: plain fair order, no hold (${waiting(s).join()})`);

  // close() stops the timer for good.
  const clock5 = fakeClock();
  const c = new JobQueue({ concurrency: 1, fairShare: true, extraFilmHoldMs: 30_000, clock: clock5 });
  c.pause();
  c.add({ label: 'A1', meta: { memberKey: 'A' }, run: async () => {} });
  c.add({ label: 'A2', meta: { memberKey: 'A' }, run: async () => {} });
  c.add({ label: 'T1', kind: 'tv', run: async () => {} });
  ok(clock5.armed().length === 1, 'a hold arms the timer');
  c.close();
  ok(clock5.armed().length === 0, 'close() clears it');
  c.snapshot();
  ok(clock5.armed().length === 0, 'and nothing arms it again');
}

console.log('=== turning it on or off reorders the line at once, and tells everyone ===');
{
  const q = new JobQueue({ concurrency: 1 });
  q.pause();
  for (const [l, who] of [['A1', 'A'], ['A2', 'A'], ['B1', 'B']]) q.add({ label: l, meta: { memberKey: who }, run: async () => {} });
  let states = 0;
  q.on('state', () => { states += 1; });
  ok(waiting(q).join() === 'A1,A2,B1', 'off: arrival order');
  ok(q.setFairShare({ fairShare: true }) === true && states === 1, 'setFairShare on: one state event');
  ok(waiting(q).join() === 'A1,B1,A2', `the waiting line is fair at once (${waiting(q).join()})`);
  ok(q.setFairShare({ fairShare: true }) === false && states === 1, 'the same settings again change nothing and say nothing');
  q.setFairShare({ fairShare: false });
  ok(waiting(q).join() === 'A1,A2,B1', 'off again: arrival order again');
}

console.log('=== left where they are: the panel\'s, an assigned member\'s, a retry, an admin\'s move, no member ===');
{
  const q = new JobQueue({ concurrency: 1, fairShare: true });
  q.pause();
  q.add({ label: 'A1', meta: { memberKey: 'A' }, run: async () => {} });
  q.add({ label: 'A2', meta: { memberKey: 'A' }, run: async () => {} });
  q.add({ label: 'panel', meta: { requester: 'manual (admin)' }, run: async () => {} });
  q.add({ label: 'panel2', meta: { requester: 'panel (mark)' }, run: async () => {} });
  q.add({ label: 'forA', meta: { requester: 'Avi', assigned: true, memberKey: 'A' }, run: async () => {} });
  q.add({ label: 'B1', meta: { memberKey: 'B' }, run: async () => {} });
  ok(waiting(q).join() === 'A1,panel,panel2,forA,B1,A2',
    `panel jobs, and one assigned to A, are first requests in arrival order (${waiting(q).join()})`);
  q.add({ label: 'A3', meta: { memberKey: 'A' }, run: async () => {} });
  ok(q.snapshot().pending.find((e) => e.label === 'A3').fair?.rank === 3,
    'the job assigned to A from the panel does not count against A: A3 is their third, not fourth');

  // A retry goes back to the front and counts for nobody.
  const r = new JobQueue({ concurrency: 1, fairShare: true });
  r.pause();
  r.add({ label: 'A1', meta: { memberKey: 'A' }, run: async () => {} });
  r.add({ label: 'B1', meta: { memberKey: 'B' }, run: async () => {} });
  r.add({ label: 'Aretry', retry: 'failed', meta: { memberKey: 'A' }, run: async () => {} });
  r.add({ label: 'A2', meta: { memberKey: 'A' }, run: async () => {} });
  ok(waiting(r).join() === 'Aretry,A1,B1,A2', `a retried film goes first; A2 is A's second (${waiting(r).join()})`);

  // Jobs with no member (journalled before members were recorded) are never moved.
  const n = new JobQueue({ concurrency: 1, fairShare: true });
  n.pause();
  n.add({ label: 'old1', run: async () => {} });
  n.add({ label: 'A1', meta: { memberKey: 'A' }, run: async () => {} });
  n.add({ label: 'A2', meta: { memberKey: 'A' }, run: async () => {} });
  n.add({ label: 'old2', run: async () => {} });
  ok(waiting(n).join() === 'old1,A1,old2,A2', `a job with no member is a first request, never bumped (${waiting(n).join()})`);

  // An admin's move stays: up, down and to the top.
  const m = new JobQueue({ concurrency: 1, fairShare: true });
  m.pause();
  const id = {};
  for (const [l, who] of [['A1', 'A'], ['A2', 'A'], ['A3', 'A'], ['B1', 'B'], ['C1', 'C']]) {
    id[l] = m.add({ label: l, meta: { memberKey: who }, run: async () => {} });
  }
  ok(waiting(m).join() === 'A1,B1,C1,A2,A3', `fair to begin with (${waiting(m).join()})`);
  ok(m.move(id.A2, 'up') && waiting(m).join() === 'A1,B1,A2,C1,A3', `A2 moved up one: above C1 (${waiting(m).join()})`);
  m.add({ label: 'D1', meta: { memberKey: 'D' }, run: async () => {} });
  ok(waiting(m).join() === 'A1,B1,A2,C1,D1,A3', `a new first request goes behind A2 now - the move is not undone (${waiting(m).join()})`);
  ok(m.move(id.B1, 'down') && m.move(id.B1, 'down') && m.move(id.B1, 'down') && waiting(m).join() === 'A1,A2,C1,D1,B1,A3',
    `B1 moved down three places, past three first requests (${waiting(m).join()})`);
  ok(m.move(id.B1, 'down') && waiting(m).join() === 'A1,A2,C1,D1,A3,B1', `and once more, below A's third (${waiting(m).join()})`);
  m.add({ label: 'E1', meta: { memberKey: 'E' }, run: async () => {} });
  ok(waiting(m).join() === 'A1,A2,C1,D1,E1,A3,B1', `E1 goes ahead of A3, and B1 stays below it (${waiting(m).join()})`);
  ok(m.moveTop(id.A3) && waiting(m).join() === 'A3,A1,A2,C1,D1,E1,B1', `A3 sent to the top (${waiting(m).join()})`);
  m.add({ label: 'F1', meta: { memberKey: 'F' }, run: async () => {} });
  ok(waiting(m).join() === 'A3,A1,A2,C1,D1,E1,F1,B1', `and stays there as F1 comes (${waiting(m).join()})`);
  const shown = waiting(m).join();
  const started = [];
  for (const it of m.pending) { const run = it.run; it.run = async () => { started.push(it.label); return run(); }; }
  m.resume();
  await tick(); await tick();
  ok(started.join() === shown, `the moved line starts in the order shown (${started.join()})`);
}

console.log('=== the places shown are the order things start in ===');
{
  // Films and TV, five members, a running season with episodes left, and
  // extra films held behind the TV: the waiting list, then everything run
  // one at a time.
  const clock = fakeClock();
  const started = [];
  const q = new JobQueue({ concurrency: 1, fairShare: true, extraFilmHoldMs: 60_000, clock });
  const { make, release } = jobs(started);
  for (let e = 1; e <= 3; e++) q.add(make(`CS1E${e}`, 'C', { kind: 'tv', group: 'CS1', groupMeta: { memberKey: 'C' } }));
  await tick();
  q.pause();
  q.add(make('A1', 'A')); q.add(make('A2', 'A')); q.add(make('A3', 'A'));
  q.add(make('BT', 'B', { kind: 'tv', group: 'BS1', groupMeta: { memberKey: 'B' } }));
  q.add(make('D1', 'D')); q.add(make('C2', 'C')); q.add(make('E1', 'E'));
  const snap = q.snapshot();
  const shown = snap.pending.map((e) => e.label);
  ok(snap.active.length === 1 && snap.active[0].group === 'CS1' && snap.active[0].jobs.waiting === 2, 'C\'s season is running, with episodes left');
  ok(shown.join() === 'A1,D1,E1,BT,A2,C2,A3',
    `the waiting line: first films, the TV, then the extra films held behind it - C's film is C's second (${shown.join()})`);
  q.resume();
  for (let i = 0; i < 12 && started.length < 10; i++) await release(started[started.length - 1]);
  await release(started[started.length - 1]);
  const waitingStarts = started.filter((l) => !/^CS1/.test(l));
  ok(waitingStarts.join() === shown.join(), `and that is the order they started in (${waitingStarts.join()})`);
  ok(started.join() === 'CS1E1,A1,D1,E1,CS1E2,CS1E3,BT,A2,C2,A3',
    `the running season goes on after the films, ahead of the waiting TV, as it always has (${started.join()})`);
}

/*
 * Found in review (2026-09-30), before it shipped:
 * - a cancel that made a held film its member's first request lifted the
 *   hold and only said so: the film showed as waiting #1 beside a free slot
 *   and did not start until something unrelated happened;
 * - the hold timer, due 1 ms after the hold ends, was replaced whenever the
 *   panel read the queue in that gap, so its wake-up never came;
 * - an admin's move was undone by a later cancel: A3 moved above B2, B1
 *   cancelled, and B2 was back above A3;
 * - a hold longer than setTimeout's ceiling (a 30-day film cooldown) fired
 *   the timer every millisecond.
 */
console.log('=== a cancel that lifts a hold starts the film, with nothing else happening ===');
{
  // bot-box's shape: two slots, one kept for films. X's season runs; A's first
  // request is a season waiting behind the kept slot, and A's film, an extra,
  // is held behind the TV. A's season is cancelled: the film is A's first
  // request now, and takes the free slot at once.
  const clock = fakeClock();
  const started = [];
  const q = new JobQueue({ concurrency: 2, fairShare: true, extraFilmHoldMs: 30_000, clock });
  const { make } = jobs(started);
  for (const e of [1, 2]) q.add(make(`XS${e}`, 'X', { kind: 'tv', group: 'XS', groupMeta: { memberKey: 'X' } }));
  await tick();
  q.add(make('AS1', 'A', { kind: 'tv', group: 'AS', groupMeta: { memberKey: 'A' } }));
  q.add(make('Afilm', 'A'));
  await tick();
  const before = q.snapshot();
  ok(started.join() === 'XS1' && before.pending.find((e) => e.label === 'Afilm')?.fair?.heldUntil,
    `X's season runs, A's season waits for the kept slot, A's film is held (${started.join()})`);
  let states = 0;
  q.on('state', () => { states += 1; });
  q.cancel(before.pending.find((e) => e.group === 'AS').id);
  await tick();
  ok(started.join() === 'XS1,Afilm', `A's season cancelled: the film is A's first now, and starts (${started.join()})`);
  ok(states >= 1, 'and the panel and the place reactions are told');
  ok(clock.armed().length === 0, 'no hold is left to wait for');

  // The same through skip, which cancels a request that has not started.
  const clock2 = fakeClock();
  const s2 = [];
  const k = new JobQueue({ concurrency: 2, fairShare: true, extraFilmHoldMs: 30_000, clock: clock2 });
  const j2 = jobs(s2);
  for (const e of [1, 2]) k.add(j2.make(`XS${e}`, 'X', { kind: 'tv', group: 'XS', groupMeta: { memberKey: 'X' } }));
  await tick();
  k.add(j2.make('AS1', 'A', { kind: 'tv', group: 'AS', groupMeta: { memberKey: 'A' } }));
  k.add(j2.make('Afilm', 'A'));
  await tick();
  k.skip(k.snapshot().pending.find((e) => e.group === 'AS').id);
  await tick();
  ok(s2.join() === 'XS1,Afilm', `skipped instead: the film starts too (${s2.join()})`);
}

console.log('=== a read of the queue just as a hold ends does not lose the wake-up ===');
{
  const clock = fakeClock();
  const started = [];
  const q = new JobQueue({ concurrency: 2, fairShare: true, extraFilmHoldMs: 30_000, clock });
  const { make } = jobs(started);
  for (const e of [1, 2]) q.add(make(`XS${e}`, 'X', { kind: 'tv', group: 'XS', groupMeta: { memberKey: 'X' } }));
  await tick();
  q.add(make('AS1', 'A', { kind: 'tv', group: 'AS', groupMeta: { memberKey: 'A' } }));
  q.add(make('Afilm', 'A'));
  await tick();
  ok(clock.armed().length === 1 && clock.armed()[0].at === clock.now() + 30_001, 'the hold timer is due 1 ms after the hold ends');
  clock.advance(30_000);                // the hold is over; its timer has not fired yet
  q.snapshot();                         // the panel reads the queue in that gap (it does at every progress tick)
  await tick();
  ok(started.join() === 'XS1,Afilm', `the film starts all the same (${started.join()})`);
  ok(clock.armed().length === 0, 'and no timer is left');
}

console.log('=== an admin\'s move is not undone by a later cancel ===');
{
  const q = new JobQueue({ concurrency: 1, fairShare: true });
  q.pause();
  const id = {};
  for (const [l, who] of [['A1', 'A'], ['A2', 'A'], ['A3', 'A'], ['B1', 'B'], ['B2', 'B']]) {
    id[l] = q.add({ label: l, meta: { memberKey: who }, run: async () => {} });
  }
  ok(waiting(q).join() === 'A1,B1,A2,B2,A3', `fair to begin with (${waiting(q).join()})`);
  ok(q.move(id.A3, 'up') && waiting(q).join() === 'A1,B1,A2,A3,B2', `the admin moves A3 above B2 (${waiting(q).join()})`);
  q.cancel(id.B1);
  ok(waiting(q).join() === 'A1,A2,A3,B2', `B1 cancelled: B2 stays below A3, where the admin left it (${waiting(q).join()})`);
  q.add({ label: 'C1', meta: { memberKey: 'C' }, run: async () => {} });
  ok(waiting(q).join() === 'A1,C1,A2,A3,B2', `a new first request still goes ahead of the extras (${waiting(q).join()})`);

  // To the top: a request whose rank later drops does not pass it.
  const t = new JobQueue({ concurrency: 1, fairShare: true });
  t.pause();
  const tid = {};
  for (const [l, who] of [['B1', 'B'], ['B2', 'B'], ['B3', 'B'], ['A1', 'A'], ['A2', 'A'], ['A3', 'A']]) {
    tid[l] = t.add({ label: l, meta: { memberKey: who }, run: async () => {} });
  }
  ok(waiting(t).join() === 'B1,A1,B2,A2,B3,A3', `fair to begin with (${waiting(t).join()})`);
  ok(t.moveTop(tid.A3) && waiting(t).join() === 'A3,B1,A1,B2,A2,B3', `A3 sent to the top (${waiting(t).join()})`);
  t.cancel(tid.B1);
  t.cancel(tid.B2);
  ok(waiting(t).join() === 'A3,A1,A2,B3', `B1 and B2 cancelled: B3 does not climb past A3, or past the line as it was (${waiting(t).join()})`);

  // A held film the admin put below another held film stays below it when a
  // cancel makes it its member's first.
  const clock = fakeClock();
  const h = new JobQueue({ concurrency: 1, fairShare: true, extraFilmHoldMs: 30_000, clock });
  h.pause();
  const hid = {};
  for (const [l, who, kind] of [['A1', 'A', 'movie'], ['B1', 'B', 'movie'], ['T1', 'C', 'tv'], ['A2', 'A', 'movie'], ['B2', 'B', 'movie']]) {
    hid[l] = h.add({ label: l, kind, meta: { memberKey: who }, run: async () => {} });
  }
  ok(waiting(h).join() === 'A1,B1,T1,A2,B2', `the extra films are held behind the TV (${waiting(h).join()})`);
  ok(h.move(hid.B2, 'up') && waiting(h).join() === 'A1,B1,T1,B2,A2', `the admin puts B2 above A2 (${waiting(h).join()})`);
  h.cancel(hid.A1);
  await tick();
  ok(waiting(h).join() === 'B1,T1,B2,A2', `A1 cancelled: A2 is still held, below B2 (${waiting(h).join()})`);
  clock.advance(30_001);
  ok(waiting(h).join() === 'B1,B2,A2,T1', `when the holds end both films go ahead of the TV, in the admin's order (${waiting(h).join()})`);
  h.close();
}

console.log('=== a hold longer than setTimeout allows waits in steps, quietly ===');
{
  const clock = fakeClock();
  const MAX = 2 ** 31 - 1;
  const hold = 30 * 24 * 3600 * 1000;          // a 30-day film cooldown
  const q = new JobQueue({ concurrency: 1, fairShare: true, extraFilmHoldMs: hold, clock });
  q.pause();
  q.add({ label: 'A1', meta: { memberKey: 'A' }, run: async () => {} });
  q.add({ label: 'A2', meta: { memberKey: 'A' }, run: async () => {} });
  q.add({ label: 'T1', kind: 'tv', meta: { memberKey: 'B' }, run: async () => {} });
  const t0 = clock.now();
  ok(clock.armed().length === 1 && clock.armed()[0].at - t0 === MAX, `one timer, at setTimeout's ceiling (${clock.armed()[0]?.at - t0} ms)`);
  let states = 0;
  q.on('state', () => { states += 1; });
  clock.advance(MAX);
  ok(states === 0, 'woken early, it says nothing: nothing has changed');
  ok(clock.armed().length === 1 && clock.armed()[0].at === t0 + hold + 1, 'and waits again, for the rest of the hold');
  ok(waiting(q).join() === 'A1,T1,A2', `the film is still held (${waiting(q).join()})`);
  clock.advance(hold - MAX + 1);
  ok(states >= 1 && waiting(q).join() === 'A1,A2,T1', `at the real end it is released, and says so (${waiting(q).join()})`);
  q.close();
}

console.log('=== hasOthers: is anyone else in the queue? ===');
{
  const q = new JobQueue({ concurrency: 1 });
  q.pause();
  ok(q.hasOthers('num:1') === false, 'an empty queue: nobody');
  q.add({ label: 'mine', meta: { memberKey: 'num:1' }, run: async () => {} });
  q.add({ kind: 'tv', group: 'g', groupMeta: { memberKey: 'num:1' }, label: 'my ep', meta: { memberKey: 'num:1' }, run: async () => {} });
  ok(q.hasOthers('num:1') === false, 'only my own film and season: nobody else');
  ok(q.hasOthers('num:2') === true, 'for somebody else, I am someone');
  ok(q.hasOthers(null) === true, 'for an unknown sender, anything is someone else\'s');
  const panel = q.add({ label: 'panel', meta: { requester: 'manual (admin)' }, run: async () => {} });
  ok(q.hasOthers('num:1') === true, 'a job queued from the panel counts as somebody else\'s');
  q.cancel(panel);
  q.holdRetry({ key: 'r', label: 'their retry', meta: { memberKey: 'num:3' } });
  ok(q.hasOthers('num:1') === true, 'so does another member\'s film waiting for its retry');
  q.releaseRetry('r');
  q.holdRetry({ key: 'r2', label: 'my retry', meta: { memberKey: 'num:1' } });
  ok(q.hasOthers('num:1') === false, 'my own retry does not');
  q.releaseRetry('r2');
  const r = new JobQueue({ concurrency: 1 });
  const { make, release } = jobs([]);
  r.add(make('mine', 'num:1'));
  await tick();
  ok(r.snapshot().active.length === 1 && r.hasOthers('num:1') === false && r.hasOthers('num:2') === true,
    'a running request is its member\'s too');
  await release('mine');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
