/* A TV request is ONE item in the queue, however many episodes it holds.
   Run: node test/queue-requests.test.mjs

   Asked for by the operator: "if 1 episode that item should be counted as 1
   in the queue if season was requested entire season should be 1 item in the
   queue, don't need 50 episodes counting as individual queue items". Every
   episode was its own job, and the queue counted jobs: a 50-episode season
   took 50 of the 104 places on its own, the panel listed fifty rows, and
   anyone who asked for a film behind it was told they were 51st.

   The episodes are still separate jobs - that is what lets a movie overtake
   the rest of a season, and what the stage locks and the TV journal work
   with - but they share a group, and the queue counts, orders, shows, moves
   and cancels the group. */
import express from 'express';
import http from 'node:http';
import { JobQueue } from '../src/core/queue.js';
import { createApiRouter } from '../src/web/api.js';
import { runAdminCommand } from '../src/core/admin-commands.js';
import { buildDigest } from '../src/core/daily-digest.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const never = () => new Promise(() => {});
const tick = () => new Promise((r) => setTimeout(r, 10));

/** Queue a request's episodes the way the TV plugin does. */
function season(q, key, label, n, { onDiscard = null, run = never, overLimit = false } = {}) {
  const ids = [];
  for (let i = 1; i <= n; i++) {
    ids.push(q.add({
      kind: 'tv', group: key, groupLabel: label, groupMeta: { requester: 'David' },
      label: `${label.replace(/ season \d+$/, '')} E${i}`, meta: { position: `${i}/${n}` },
      run, ...(onDiscard ? { onDiscard: onDiscard(i) } : {}),
    }, { overLimit }));
  }
  return ids;
}
const movie = (q, label, opts) => q.add({ label, kind: 'movie', run: never }, opts);
const labels = (list) => list.map((e) => e.label).join(' | ');

console.log('=== a whole season is one item, and so is one episode ===');
{
  const q = new JobQueue({ concurrency: 1, maxLength: 5 });
  q.pause();
  season(q, 'ad5', 'American Dad! season 5', 50);
  season(q, 'boys', 'The Boys S01E02', 1);
  ok(q.pending.length === 51, 'still one job per episode underneath (51)');
  ok(q.waitingCount() === 2, `but two requests waiting (${q.waitingCount()})`);
  const s = q.snapshot();
  ok(s.pending.length === 2, `the panel gets two rows, not 51 (${s.pending.length})`);
  ok(s.pending[0].group === 'ad5' && s.pending[0].label === 'American Dad! season 5',
    'the row is the request, with its title');
  ok(/^[0-9a-f]{12}$/.test(s.pending[0].id) && q.describe(s.pending[0].id)?.label === 'American Dad! season 5',
    'and an id of the queue\'s own to act on - the caller\'s key is built from a WhatsApp message id and must never reach an onclick');
  ok(s.pending[0].jobs.total === 50 && s.pending[0].jobs.waiting === 50, 'and says how many episodes it holds');
  ok(s.counts.pending.tv === 2 && s.counts.pending.movie === 0, 'counts are in requests');
  ok(JSON.stringify(q.requestCounts()) === '{"active":0,"waiting":2}', 'and so is requestCounts, for the digest and the dashboard');
  ok(q.pendingLabels().join(' | ') === 'American Dad! season 5 | The Boys S01E02', 'pendingLabels names requests');
}

console.log('=== the length limit counts requests, and a season goes in whole ===');
{
  const q = new JobQueue({ concurrency: 1, maxLength: 3 });
  q.pause();
  movie(q, 'Inception (2010)');
  movie(q, 'Up (2009)');
  ok(q.hasRoom(1), 'two of three places taken: room for one more request');
  season(q, 'mentalist', 'The Mentalist season 1', 23);
  ok(q.pending.length === 25 && q.waitingCount() === 3,
    `a 23-episode season took ONE place and went in whole (${q.waitingCount()} waiting, ${q.pending.length} jobs)`);
  ok(!q.hasRoom(1), 'and now the queue is full');
  let err = null;
  try { movie(q, 'Heat (1995)'); } catch (e) { err = e; }
  ok(err?.code === 'QUEUE_FULL' && err.message === 'Queue is full (3 waiting)', `a fourth request is refused: "${err?.message}"`);
  err = null;
  try { season(q, 'other', 'Other season 1', 2); } catch (e) { err = e; }
  ok(err?.code === 'QUEUE_FULL', 'the first episode of a NEW request is refused like anything else');
  ok(!q.groups.has('other') && q.pending.length === 25, 'and leaves nothing behind');
  ok(!!movie(q, 'Heat (1995)', { overLimit: true }) && q.waitingCount() === 4, 'an admin\'s own add still goes past the limit');
}

console.log('=== a request stays in one piece ===');
{
  const q = new JobQueue({ concurrency: 1, maxLength: 50 });
  q.pause();
  season(q, 'a', 'A season 1', 2);
  movie(q, 'M (2000)');
  q.add({ kind: 'tv', group: 'a', label: 'A E3', run: never });   // a straggler for A
  ok(labels(q.pending) === 'A E1 | A E2 | A E3 | M (2000)', `a later episode joins its request, not the back (${labels(q.pending)})`);
}

console.log('=== the waiting order is the order things will start ===');
{
  const q = new JobQueue({ concurrency: 1, maxLength: 50 });
  q.pause();
  season(q, 'tv1', 'TV one season 1', 3);
  movie(q, 'M1');
  season(q, 'tv2', 'TV two season 2', 2);
  movie(q, 'M2');
  const s = q.snapshot();
  ok(labels(s.pending) === 'M1 | M2 | TV one season 1 | TV two season 2',
    `strict priority: every movie first, then TV in arrival order (${labels(s.pending)})`);
  ok(s.pending.map((e) => e.place).join() === '1,2,3,4', 'each row carries its place');

  q.strictMoviePriority = false;
  ok(labels(q.snapshot().pending) === 'TV one season 1 | M1 | TV two season 2 | M2',
    'with priority off, plain arrival order');
}

console.log('=== the order shown is the order that runs ===');
{
  const order = [];
  const q = new JobQueue({ concurrency: 1, maxLength: 50 });
  q.pause();
  const run = (label) => async () => { order.push(label); };
  q.add({ kind: 'tv', group: 's', groupLabel: 'S', label: 'S1', run: run('S1') });
  q.add({ kind: 'tv', group: 's', groupLabel: 'S', label: 'S2', run: run('S2') });
  q.add({ kind: 'movie', label: 'M', run: run('M') });
  const shown = labels(q.snapshot().pending);
  q.resume();
  for (let i = 0; i < 5; i++) await tick();
  ok(shown === 'M | S' && order.join() === 'M,S1,S2', `shown "${shown}", ran ${order.join(',')}`);
}

console.log('=== moving a request moves all of it ===');
{
  const q = new JobQueue({ concurrency: 1, maxLength: 50 });
  q.pause();
  season(q, 'a', 'A season 1', 3);
  season(q, 'b', 'B season 1', 2);
  const c = season(q, 'c', 'C season 1', 2);
  const rows = () => labels(q.snapshot().pending);
  ok(q.move('c', 'up') && rows() === 'A season 1 | C season 1 | B season 1', `up one place (${rows()})`);
  ok(labels(q.pending) === 'A E1 | A E2 | A E3 | C E1 | C E2 | B E1 | B E2', 'and every episode went with it, in order');
  ok(q.moveTop(c[1]) && rows() === 'C season 1 | A season 1 | B season 1', 'an episode id moves its whole request');
  ok(q.move('a', 'down') && rows() === 'C season 1 | B season 1 | A season 1', 'down one place');
  ok(labels(q.pending) === 'C E1 | C E2 | B E1 | B E2 | A E1 | A E2 | A E3', 'still contiguous after all that');
  ok(q.move('c', 'up') === false && q.move('a', 'down') === false, 'nothing past either end');
  ok(q.move('nope', 'up') === false && q.moveTop('nope') === false, 'an unknown id is a no-op');
}

console.log('=== with strict priority, TV and movies do not swap ===');
{
  const q = new JobQueue({ concurrency: 1, maxLength: 50 });
  q.pause();
  movie(q, 'M1');
  season(q, 'tv', 'TV season 1', 2);
  const m2 = movie(q, 'M2');
  ok(labels(q.snapshot().pending) === 'M1 | M2 | TV season 1', 'movies first');
  ok(q.move('tv', 'up') === false, 'TV cannot be moved above a movie: it could never start before one');
  ok(q.move(m2, 'down') === false, 'nor a movie below TV');
  ok(q.move(m2, 'up') && labels(q.snapshot().pending) === 'M2 | M1 | TV season 1', 'movies still reorder among themselves');
  q.strictMoviePriority = false;
  ok(q.move('tv', 'up') === true, 'with priority off, anything can pass anything');
}

console.log('=== a request partly running is one running item ===');
{
  const gates = [];
  const run = () => new Promise((r) => gates.push(r));
  const q = new JobQueue({ concurrency: 1, maxLength: 2 });
  season(q, 'a', 'A season 1', 3, { run });
  await tick();
  let s = q.snapshot();
  ok(s.active.length === 1 && s.active[0].group === 'a' && s.active[0].label === 'A season 1',
    'the season is ONE running row');
  ok(q.isRunning(s.active[0].id) && q.stageLine(s.active[0].id) === null, 'its id works wherever its key does');
  ok(s.active[0].jobs.running === 1 && s.active[0].jobs.waiting === 2 && s.active[0].current[0].label === 'A E1',
    'showing the episode in hand and what is left');
  ok(s.pending.length === 0, 'its remaining episodes are not "waiting" rows');
  ok(q.waitingCount() === 0 && q.hasRoom(2), 'and do not take places in line');
  ok(q.isRunning('a') && q.describe('a').state === 'running', 'isRunning and describe agree');

  q.add({ label: 'M', kind: 'movie', run });    // arrives mid-season
  gates.shift()();                               // E1 finishes; M goes next
  await tick();
  s = q.snapshot();
  const a = s.active.find((e) => e.group === 'a');
  ok(s.active.length === 2 && a && a.current.length === 0 && a.jobs.done === 1,
    'between episodes, held behind the movie, it is still running - not back in the line');
  ok(s.pending.length === 0, 'so it never takes a place number again');
  gates.shift()(); await tick();                 // M finishes
  gates.shift()(); await tick();                 // E2
  gates.shift()(); await tick();                 // E3
  ok(!q.groups.has('a') && q.snapshot().active.length === 0, 'the request is forgotten once its last episode is done');
}

console.log('=== cancel stops the whole request; skip only the episode in hand ===');
{
  const discarded = [];
  const q = new JobQueue({ concurrency: 1, maxLength: 50 });
  q.pause();
  season(q, 'a', 'A season 1', 4, { onDiscard: (i) => (state) => discarded.push(`E${i}:${state}`) });
  movie(q, 'M');
  ok(q.describe('a')?.label === 'A season 1' && q.describe('a').jobs.total === 4, 'describe names the request for the audit log');
  ok(q.cancel('a') === true, 'cancel by request id');
  ok(labels(q.pending) === 'M', 'every waiting episode is gone');
  ok(discarded.join() === 'E1:cancelled,E2:cancelled,E3:cancelled,E4:cancelled',
    `and each one was told, so the plugin can close the request (${discarded.join()})`);
  ok(!q.groups.has('a') && q.cancel('a') === false, 'the request is forgotten; cancelling again is a 404');
}
{
  let aborted = 0;
  const run = (job) => new Promise((resolve) => { job.signal.addEventListener('abort', () => { aborted += 1; resolve(); }); });
  const discarded = [];
  const q = new JobQueue({ concurrency: 1, maxLength: 50 });
  season(q, 'a', 'A season 1', 3, { run, onDiscard: (i) => (state) => discarded.push(`E${i}:${state}`) });
  await tick();
  ok(q.skip('a') === true, 'skip on a running request');
  await tick();
  ok(aborted === 1 && discarded.length === 0, 'stops the episode in hand and nothing else');
  ok(q.snapshot().active[0]?.current[0]?.label === 'A E2', 'the next episode carries on');
  ok(q.history[0].state === 'cancelled' && q.history[0].group === 'a' && q.history[0].groupLabel === 'A season 1',
    'the finished row says which request it belonged to');
  ok(q.cancel('a') === true, 'cancel on the running request');
  await tick();
  ok(aborted === 2 && discarded.join() === 'E3:cancelled', `stops the running one and discards the rest (${discarded.join()})`);
  ok(q.snapshot().active.length === 0 && !q.groups.has('a'), 'nothing of it is left');
}

console.log('=== clearing the waiting list leaves a running season alone ===');
{
  const discarded = [];
  const q = new JobQueue({ concurrency: 1, maxLength: 50 });
  season(q, 'run', 'Running season 1', 3);
  await tick();                                  // E1 starts
  season(q, 'wait', 'Waiting season 1', 2, { onDiscard: () => (s) => discarded.push(s) });
  movie(q, 'M');
  const n = q.clearPending();
  ok(n === 2, `two requests cleared, not three jobs (${n})`);
  ok(discarded.length === 2, 'the cleared episodes were told');
  ok(labels(q.pending) === 'Running E2 | Running E3',
    'the running season keeps its remaining episodes - cutting it short is Cancel');
}

console.log('=== a running request\'s place in a stage line ===');
{
  // Both episodes downloaded and in line for the encoder, E2 ahead of E1.
  const lines = { E1: { stage: 'convert', position: 2, of: 2 }, E2: { stage: 'convert', position: 1, of: 2 } };
  const promoted = [];
  const q = new JobQueue({ concurrency: 3, maxLength: 50, strictMoviePriority: false });
  const name = {};
  q.setStageWaits({
    where: (id) => lines[name[id]] ?? null,
    promote: (id, dir) => { promoted.push(`${name[id]}:${dir}`); return true; },
  });
  for (const ep of ['E1', 'E2']) {
    name[q.add({ kind: 'tv', group: 's', groupLabel: 'S', label: ep, run: never })] = ep;
  }
  await tick();
  ok(q.stageLine('s')?.stage === 'convert', 'the request says which slot it is waiting for');
  const row = q.snapshot().active[0];
  ok(row.waiting?.position === 1, 'the row shows the best-placed of its episodes');
  ok(q.moveRunning('s', 'top') === true, 'and can be moved up that line');
  ok(promoted.join() === 'E1:top,E2:top', `each episode in line, the one further back first, so their order holds (${promoted.join()})`);
}

console.log('=== skip stops ONE episode, even with two in hand ===');
{
  // bot-box runs at concurrency 3 with a slot kept for films, so a season has
  // two episodes in hand: one sending, the next downloading. Skip on the
  // season stopped both - a healthy download thrown away to get past the
  // one too big to send, and the requester told two were skipped.
  const stopped = [];
  const run = (job) => new Promise((resolve) => {
    job.signal.addEventListener('abort', () => { stopped.push(`${labelOf[job.id]}:${job.cancelReason()}`); resolve(); });
  });
  const labelOf = {};
  const q = new JobQueue({ concurrency: 3, maxLength: 50, reserveSlotForMovies: true });
  const ids = season(q, 's', 'Show season 1', 4, { run });
  ids.forEach((id, i) => { labelOf[id] = `E${i + 1}`; });
  await tick();
  const row = q.snapshot().active[0];
  ok(row.current.map((c) => c.label).join() === 'Show E1,Show E2', 'two episodes in hand');
  ok(q.skip(row.id) === true, 'skip on the season');
  await tick();
  ok(stopped.join() === 'E1:skipped', `stops the one furthest along, and only it (${stopped.join()})`);
  const now = q.snapshot().active[0].current.map((c) => c.label).join();
  ok(now === 'Show E2,Show E3', `E2 carries on downloading and E3 takes the free slot (${now})`);
  ok(q.skip(q.snapshot().active[0].current[1].id) === true, 'skip aimed at one episode, as the panel does');
  await tick();
  ok(stopped.join() === 'E1:skipped,E3:skipped', `stops that episode and no other (${stopped.join()})`);
  q.cancel(row.id);
  await tick();
}

console.log('=== skip on a running season with nothing in hand is a no-op, not a cancel ===');
{
  // Between episodes - here held while a film goes first - there is nothing
  // to skip. It used to fall through to cancel and throw the rest of the
  // season away: a click on a card drawn while an episode was in hand can
  // land just after it finished.
  const gates = [];
  const run = () => new Promise((r) => gates.push(r));
  const discarded = [];
  const q = new JobQueue({ concurrency: 1, maxLength: 50 });
  season(q, 's', 'Show season 1', 5, { run, onDiscard: (i) => (state) => discarded.push(`E${i}:${state}`) });
  await tick();
  const id = q.snapshot().active[0].id;
  movie(q, 'Film');
  gates.shift()();                                  // E1 finishes; the film goes next
  await tick();
  ok(q.snapshot().active.find((r) => r.id === id)?.current.length === 0, 'the season is running with nothing in hand');
  ok(q.skip(id) === false, 'skip answers false: nothing to skip');
  ok(discarded.length === 0 && q.pending.length === 4, `and nothing was thrown away (${discarded.join() || 'none'}, ${q.pending.length} left)`);
  ok(q.cancel(id) === true && discarded.length === 4, 'Cancel is still what stops the rest of it');
}
{
  const discarded = [];
  const q = new JobQueue({ concurrency: 1, maxLength: 50 });
  q.pause();
  season(q, 'w', 'Waiting season 1', 2, { onDiscard: () => (state) => discarded.push(state) });
  ok(q.skip('w') === true && discarded.join() === 'skipped,skipped', 'a request that never started is skipped whole, as before');
}

console.log('=== ⤒ next puts a request where ▲ would, behind a running season ===');
{
  // ⤒ put the moved request at the head of `pending`, ahead of the running
  // season's remaining episodes. The Waiting list looked the same either way,
  // but the running season then stopped half way with nothing in hand while
  // the moved request ran every episode it had.
  const started = [];
  const gates = [];
  const run = (label) => () => { started.push(label); return new Promise((r) => gates.push(r)); };
  for (const how of ['up', 'top']) {
    started.length = 0; gates.length = 0;
    const q = new JobQueue({ concurrency: 1, maxLength: 50 });
    for (const ep of ['S1', 'S2', 'S3']) q.add({ kind: 'tv', group: 's', groupLabel: 'S', label: ep, run: run(ep) });
    await tick();                                   // S1 starts
    q.add({ kind: 'tv', group: 't', groupLabel: 'T', label: 'T1', run: run('T1') });
    const u = q.add({ kind: 'tv', group: 'u', groupLabel: 'U', label: 'U1', run: run('U1') });
    ok(how === 'up' ? q.move(u, 'up') : q.moveTop(u), `${how === 'up' ? '▲' : '⤒ next'} on U`);
    ok(labels(q.snapshot().pending) === 'U | T', `the Waiting list: U, then T (${labels(q.snapshot().pending)})`);
    for (let i = 0; i < 5; i++) { gates.shift()?.(); await tick(); }
    ok(started.join() === 'S1,S2,S3,U1,T1', `the running season finishes first, then U, then T (${started.join()})`);
  }
}

console.log('=== a pipelining season keeps its place in a stage line ===');
{
  // E1 converting, E2 downloaded and 2nd in line for the encoder behind
  // another request: the season's card must still offer ▲ / ⤒ for E2. The
  // line was read from the episode shown on the card, which is E1, so it
  // had none.
  const lines = { E2: { stage: 'convert', position: 2, of: 2 } };
  const q = new JobQueue({ concurrency: 3, maxLength: 50, strictMoviePriority: false });
  const name = {};
  const promoted = [];
  q.setStageWaits({ where: (id) => lines[name[id]] ?? null, promote: (id, dir) => { promoted.push(`${name[id]}:${dir}`); return true; } });
  for (const ep of ['E1', 'E2']) {
    name[q.add({ kind: 'tv', group: 's', groupLabel: 'Show season 1', label: `Show S01E0${ep[1]}`, run: never })] = ep;
  }
  await tick();
  const row = q.snapshot().active[0];
  ok(!row.waiting && row.current[0].label === 'Show S01E01', 'the card leads with the episode that is working');
  ok(row.line?.stage === 'convert' && row.line.position === 2 && row.line.label === 'Show S01E02',
    `and says where the other one stands in line, and which it is (${JSON.stringify(row.line)})`);
  ok(q.moveRunning(row.id, 'top') === true && promoted.join() === 'E2:top', 'moving the card moves that episode up');
}

console.log('=== a job with no group behaves exactly as before ===');
{
  const q = new JobQueue({ concurrency: 1, maxLength: 50 });
  q.pause();
  const id = movie(q, 'Up (2009)');
  const row = q.snapshot().pending[0];
  ok(row.id === id && row.label === 'Up (2009)' && !('group' in row) && !('jobs' in row), 'its row is the job, as it always was');
  ok(q.describe(id).label === 'Up (2009)', 'describe too');
}

console.log('=== "is it safe to restart?" still says no while any of a season is left ===');
{
  // The queue-status op is what an operator (or Claude) asks before a
  // restart. A season between two episodes, held behind a film, has nothing
  // running this minute - it must still read as busy.
  const gates = [];
  const run = () => new Promise((r) => gates.push(r));
  const q = new JobQueue({ concurrency: 1, maxLength: 50 });
  season(q, 'a', 'Loki season 1', 2, { run });
  await tick();
  let st = await runAdminCommand({ op: 'queue-status' }, { queue: q, linkQueue: new JobQueue() });
  ok(st.busy && !st.safeToRestart && st.media.active === 1 && st.media.waiting === 0, 'one season running: busy, one request');
  ok(st.media.running[0] === 'Loki season 1 (Loki E1)', `named with the episode in hand: "${st.media.running[0]}"`);
  q.add({ label: 'Heat (1995)', kind: 'movie', run });
  gates.shift()();                                 // E1 done; the film goes next, E2 waits behind it
  await tick();
  gates.shift()();                                 // the film is done too...
  q.pause();                                       // ...and nothing may start E2
  await tick();
  st = await runAdminCommand({ op: 'queue-status' }, { queue: q, linkQueue: new JobQueue() });
  ok(q.active.size === 0 && q.pending.length === 1, 'nothing is running this minute, one episode is left');
  ok(st.busy && !st.safeToRestart && st.media.active === 1, 'and it is still not safe to restart');
  const digest = buildDigest({ queue: q.requestCounts() });
  ok(/Waiting now {6}: 0/.test(digest) && /Running now {6}: 1/.test(digest), 'the digest counts it as the one request running');
  q.cancel('a');
}

console.log('=== over HTTP: the panel acts on the request, and the audit log names it ===');
{
  const events = [];
  const stateStore = { namespace: (n) => ({
    get: (k, d) => (n === 'audit' && k === 'events' ? events : d),
    set: () => {},
    push: (k, v) => { if (n === 'audit') events.unshift(v); },
  }) };
  const cfg = {
    web: { adminPasswordHash: 'x', users: [{ username: 'mommy', role: 'superadmin', passwordHash: 'x' }] },
    movieRequests: { requestGroups: [], maxQueueLength: 50, reactions: {} }, media: { concurrency: 1 },
    whatsapp: { accounts: [], failover: { enabled: false, order: [] } }, tvRequests: {}, directLinks: {}, queue: {}, lockdown: {},
  };
  let aborted = 0;
  const run = (job) => new Promise((resolve) => { job.signal.addEventListener('abort', () => { aborted += 1; resolve(); }); });
  const q = new JobQueue({ concurrency: 1, maxLength: 50 });
  const inLine = new Set();
  q.setStageWaits({ where: (id) => (inLine.has(id) ? { stage: 'convert', position: 2, of: 2 } : null), promote: () => true });
  const [first] = season(q, 'tv-A', 'American Dad! season 5', 3, { run });
  inLine.add(first);
  await tick();
  q.pause();
  season(q, 'tv-B', 'The Boys season 1', 8);
  season(q, 'tv-C', 'Bluey season 2', 2);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: { username: 'mommy', role: 'superadmin' } }; next(); });
  app.use('/api', createApiRouter({
    configStore: { get: () => cfg, update: () => cfg, redacted: () => ({}), onChange: () => {} },
    bot: { groupCache: new Map(), groups: () => [], on: () => {}, state: 'connected' },
    queue: q, linkQueue: new JobQueue({ concurrency: 1 }),
    pluginManager: { plugins: new Map(), notifyConfigChange: async () => {} },
    stateStore, fileLogger: { tail: () => [] }, alerts: {}, lockScheduler: {},
  }));
  const server = await new Promise((r) => { const sv = app.listen(0, () => r(sv)); });
  const call = (method, path, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const r = http.request({ host: '127.0.0.1', port: server.address().port, method, path,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf || '{}') }));
    });
    r.on('error', reject);
    r.end(data);
  });
  const row = (label) => [...q.snapshot().pending, ...q.snapshot().active].find((e) => e.label === label);

  const got = await call('GET', '/api/queue');
  ok(got.body.pending.length === 2 && got.body.active.length === 1, 'GET /queue: two waiting requests, one running - not thirteen rows');

  const r1 = await call('POST', `/api/queue/${row('Bluey season 2').id}/move`, { dir: 'up' });
  ok(r1.status === 200 && labels(q.snapshot().pending) === 'Bluey season 2 | The Boys season 1', 'move "up" moves the request');
  ok(/moved "Bluey season 2" sooner/.test(events[0]?.action ?? '') && /2 episodes/.test(events[0]?.detail ?? ''),
    `the audit log names the request: "${events[0]?.action}" (${events[0]?.detail})`);

  const r2 = await call('POST', `/api/queue/${row('American Dad! season 5').id}/move`, { dir: 'top' });
  ok(r2.status === 200 && /moved "American Dad! season 5" to next in line to convert/.test(events[0]?.action ?? ''),
    `a running season's arrows move its episode up the stage line: "${events[0]?.action}"`);

  const inHand = row('American Dad! season 5').current[0];
  const r3 = await call('POST', `/api/queue/${inHand.id}/skip`);
  await tick();
  ok(r3.status === 200 && aborted === 1 && row('American Dad! season 5'), 'Skip, aimed at the episode in hand, stops it; the season stays');
  ok(/skipped "American Dad! E1"/.test(events[0]?.action ?? '') && /episode 1\/3/.test(events[0]?.detail ?? ''),
    `and the audit log names that episode: "${events[0]?.action}" (${events[0]?.detail})`);
  const r3b = await call('POST', `/api/queue/${row('American Dad! season 5').id}/skip`);
  ok(r3b.status === 404 && q.pending.filter((e) => e.group === 'tv-A').length === 2,
    'with nothing in hand (paused between episodes), Skip on the season is a 404, and the rest of it stays');

  const r4 = await call('DELETE', `/api/queue/${row('The Boys season 1').id}`);
  ok(r4.status === 200 && !row('The Boys season 1') && q.pending.every((e) => e.group !== 'tv-B'),
    'Cancel takes the whole waiting request out, all eight episodes');
  ok(/cancelled "The Boys season 1"/.test(events[0]?.action ?? '') && /8 episodes/.test(events[0]?.detail ?? ''),
    `and says which: "${events[0]?.action}" (${events[0]?.detail})`);

  const r5 = await call('POST', '/api/queue/clear');
  ok(r5.body.cleared === 1 && /cleared 1 waiting job\(s\)/.test(events[0]?.action ?? '') && /Bluey season 2/.test(events[0]?.detail ?? ''),
    `Clear waiting counts requests (${r5.body.cleared}) and names them`);
  ok(row('American Dad! season 5') && q.pending.some((e) => e.group === 'tv-A'), 'and leaves the running season its remaining episodes');
  q.cancel('tv-A');
  await tick();
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
