/* Strict movie priority: no TV runs until the movie side is completely clear.
   Run: node test/queue-priority.test.mjs */
import { JobQueue } from '../src/core/queue.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const tick = () => new Promise((r) => setTimeout(r, 15));

/** A job that finishes only when we release it, so ordering is deterministic. */
function gated(order, label, kind) {
  let release;
  const done = new Promise((r) => { release = r; });
  return {
    job: { label, kind, run: async () => { order.push(label); await done; } },
    release: () => release(),
  };
}

console.log('=== a waiting movie always beats a waiting TV episode ===');
{
  // Paused first, so both are genuinely WAITING when the scheduler chooses -
  // otherwise the TV job simply starts before the movie is even submitted.
  const order = [];
  const q = new JobQueue({ concurrency: 1 });
  q.pause();
  const tv = gated(order, 'tv1', 'tv');
  const mv = gated(order, 'movie1', 'movie');
  q.add(tv.job);          // TV queued FIRST
  q.add(mv.job);          // movie queued second
  q.resume();
  await tick();
  ok(order[0] === 'movie1', 'the movie ran first despite being queued second');
  mv.release(); await tick();
  ok(order[1] === 'tv1', 'the TV episode ran once the movie finished');
  tv.release(); await tick();
}

console.log('=== TV waits for a RUNNING movie, not just pending ones ===');
{
  const order = [];
  const q = new JobQueue({ concurrency: 2 });   // room to run both at once
  const mv = gated(order, 'movie1', 'movie');
  const tv = gated(order, 'tv1', 'tv');
  q.add(mv.job);
  await tick();
  q.add(tv.job);
  await tick();
  ok(order.length === 1 && order[0] === 'movie1', 'TV held back while a movie is still running, even with a free slot');
  mv.release(); await tick();
  ok(order.includes('tv1'), 'TV starts only after the movie finishes');
  tv.release(); await tick();
}

console.log('=== a movie queued mid-season jumps ahead of remaining episodes ===');
{
  const order = [];
  const q = new JobQueue({ concurrency: 1 });
  const e1 = gated(order, 'ep1', 'tv');
  const e2 = gated(order, 'ep2', 'tv');
  q.add(e1.job); q.add(e2.job);
  await tick();
  ok(order[0] === 'ep1', 'first episode started (no movies about)');
  const mv = gated(order, 'movie1', 'movie');
  q.add(mv.job);                       // a movie arrives while ep1 runs
  e1.release(); await tick();
  ok(order[1] === 'movie1', 'the movie overtakes the remaining episodes');
  mv.release(); await tick();
  ok(order[2] === 'ep2', 'the season resumes afterwards');
  e2.release(); await tick();
}

console.log('=== several movies all drain before any TV ===');
{
  const order = [];
  const q = new JobQueue({ concurrency: 1 });
  q.pause();
  const tv = gated(order, 'tv1', 'tv');
  q.add(tv.job);
  const movies = ['m1', 'm2', 'm3'].map((l) => gated(order, l, 'movie'));
  for (const m of movies) q.add(m.job);
  q.resume();
  await tick();
  for (const m of movies) { m.release(); await tick(); }
  ok(order.slice(0, 3).join(',') === 'm1,m2,m3', 'every movie ran first, in order');
  ok(order[3] === 'tv1', 'TV last');
  tv.release(); await tick();
}

console.log('=== episodes keep their own order among themselves ===');
{
  const order = [];
  const q = new JobQueue({ concurrency: 1 });
  const eps = ['e1', 'e2', 'e3'].map((l) => gated(order, l, 'tv'));
  for (const e of eps) q.add(e.job);
  await tick();
  for (const e of eps) { e.release(); await tick(); }
  ok(order.join(',') === 'e1,e2,e3', 'FIFO within the TV queue — broadcast order preserved');
}

console.log('=== priority can be switched off ===');
{
  const order = [];
  const q = new JobQueue({ concurrency: 1, strictMoviePriority: false });
  const tv = gated(order, 'tv1', 'tv');
  const mv = gated(order, 'movie1', 'movie');
  q.add(tv.job); q.add(mv.job);
  await tick();
  ok(order[0] === 'tv1', 'plain arrival order when the admin disables priority');
  tv.release(); await tick();
  mv.release(); await tick();
}

console.log('=== jobs default to movie when no kind is given ===');
{
  const q = new JobQueue({ concurrency: 1 });
  q.pause();
  q.add({ label: 'legacy', run: async () => {} });
  ok(q.snapshot().pending[0].kind === 'movie', 'an existing movie job with no kind still behaves as a movie');
}

console.log('=== counts + snapshot expose the split ===');
{
  const q = new JobQueue({ concurrency: 1 });
  q.pause();
  q.add({ label: 'm', kind: 'movie', run: async () => {} });
  q.add({ label: 't1', kind: 'tv', run: async () => {} });
  q.add({ label: 't2', kind: 'tv', run: async () => {} });
  const s = q.snapshot();
  ok(s.counts.pending.movie === 1 && s.counts.pending.tv === 2, 'counts split by kind');
  ok(s.strictMoviePriority === true, 'snapshot reports the priority setting');
  ok(s.pending.filter((e) => e.kind === 'tv').length === 2, 'each entry carries its kind');
}

console.log('=== a movie never kills a TV episode that is already running ===');
{
  const order = [];
  const q = new JobQueue({ concurrency: 1 });
  const tv = gated(order, 'tv1', 'tv');
  q.add(tv.job);
  await tick();
  ok(order[0] === 'tv1', 'TV started — nothing else was waiting');
  const mv = gated(order, 'movie1', 'movie');
  q.add(mv.job);
  await tick();
  ok(order.length === 1, 'the running episode is left alone rather than discarded mid-download');
  tv.release(); await tick();
  ok(order[1] === 'movie1', 'the movie runs next, as soon as the slot frees');
  mv.release(); await tick();
}

console.log('=== with strict movie priority off, a film retried goes before a running season\'s next episode ===');
{
  // The film was asked for first, lost its upload, and was put back "at the
  // front" - of the waiting line, behind the running season's remaining
  // episodes, which strict-off takes in order: E01 … E20, FILM, E21, E22
  // (review scenario n-film-retry-strict-off).
  const order = [];
  const q = new JobQueue({ concurrency: 1, strictMoviePriority: false });
  const gates = new Map();
  const job = (label, extra = {}) => ({ label, run: async () => { order.push(label); await new Promise((r) => gates.set(label, r)); }, ...extra });
  q.add(job('E01', { kind: 'tv', group: 'season', groupLabel: 'Season' }));
  for (let i = 2; i <= 4; i++) q.add(job(`E0${i}`, { kind: 'tv', group: 'season' }));
  await tick();
  ok(order.join() === 'E01', 'the season is running');
  q.add(job('FILM', { kind: 'movie', retry: 'failed' }));
  q.add(job('LATER', { kind: 'movie' }));
  gates.get('E01')(); await tick();
  ok(order.join() === 'E01,FILM', `the retried film goes next (${order.join()})`);
  gates.get('FILM')(); await tick();
  ok(order.join() === 'E01,FILM,E02', `then the season carries on, ahead of what is waiting (${order.join()})`);
  for (const l of ['E02', 'E03', 'E04']) { gates.get(l)?.(); await tick(); }
  gates.get('LATER')?.(); await tick();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
