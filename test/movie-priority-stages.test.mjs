/* Movies beat TV at the STAGE gates, not just in the queue.
   Run: node test/movie-priority-stages.test.mjs

   The reported symptom: three TV episodes were running, a movie was requested,
   and the movie correctly jumped ahead of fifteen waiting episodes in the
   queue - then sat at 2% for three minutes showing "waiting for the download
   slot". The queue prioritised it and the semaphore immediately un-prioritised
   it: waiters were strict FIFO, so the movie joined the line behind the TV
   download and the whole "movies first" rule stopped at the queue boundary.

   The message was wrong too: it always said "another movie is downloading",
   whatever was actually holding the slot. */
import fs from 'node:fs';
import { Semaphore } from '../src/util/semaphore.js';
import { stageSems, STAGE_PRIORITY, waitReason } from '../src/media/stages.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

console.log('=== a movie overtakes waiting TV episodes ===');
{
  const sem = new Semaphore(1, 'download');
  const order = [];
  await sem.acquire(STAGE_PRIORITY.tv, 'ep1');          // holds the only slot

  const p1 = sem.acquire(STAGE_PRIORITY.tv).then(() => order.push('tv-2'));
  const p2 = sem.acquire(STAGE_PRIORITY.tv).then(() => order.push('tv-3'));
  const movie = sem.acquire(STAGE_PRIORITY.movie).then(() => order.push('MOVIE'));

  sem.release('ep1');                                    // one slot frees
  await movie;
  ok(order[0] === 'MOVIE',
    `the movie goes first even though two episodes were waiting before it (${order.join(' → ')})`);

  sem.release(); await p1;
  sem.release(); await p2;
  ok(order.join(',') === 'MOVIE,tv-2,tv-3',
    'and the episodes keep their own arrival order behind it');
}

console.log('=== movies do not overtake each other ===');
{
  // Priority orders kinds, not individuals: an later movie must not jump an
  // earlier one, or the queue position a requester was shown becomes a lie.
  const sem = new Semaphore(1, 'download');
  const order = [];
  await sem.acquire(STAGE_PRIORITY.movie, 'first');
  const a = sem.acquire(STAGE_PRIORITY.movie).then(() => order.push('movie-A'));
  const b = sem.acquire(STAGE_PRIORITY.movie).then(() => order.push('movie-B'));
  sem.release('first'); await a;
  sem.release(); await b;
  ok(order.join(',') === 'movie-A,movie-B', `arrival order is kept between equals (${order.join(' → ')})`);
}

console.log('=== a movie arriving later still beats TV already waiting ===');
{
  const sem = new Semaphore(1, 'convert');
  const order = [];
  await sem.acquire(STAGE_PRIORITY.tv, 'holder');
  const tvs = [1, 2, 3, 4, 5].map((n) =>
    sem.acquire(STAGE_PRIORITY.tv).then(() => order.push(`tv${n}`)));
  const movie = sem.acquire(STAGE_PRIORITY.movie).then(() => order.push('MOVIE'));

  sem.release('holder');
  await movie;
  ok(order[0] === 'MOVIE', 'five queued episodes do not delay it');
  for (const t of tvs) { sem.release(); await t; }
  ok(order.length === 6, 'and every episode still runs afterwards');
}

console.log('=== without a priority nothing changes ===');
{
  // Default priority keeps plain FIFO, so anything not passing one behaves
  // exactly as before.
  const sem = new Semaphore(1);
  const order = [];
  await sem.acquire();
  const a = sem.acquire().then(() => order.push('a'));
  const b = sem.acquire().then(() => order.push('b'));
  sem.release(); await a;
  sem.release(); await b;
  ok(order.join(',') === 'a,b', 'plain FIFO is preserved for un-prioritised callers');
}

console.log('=== growing the capacity still wakes waiters ===');
{
  const sem = new Semaphore(1, 'download');
  const order = [];
  await sem.acquire(STAGE_PRIORITY.tv, 'held');
  const t = sem.acquire(STAGE_PRIORITY.tv).then(() => order.push('tv'));
  const m = sem.acquire(STAGE_PRIORITY.movie).then(() => order.push('movie'));
  sem.setCapacity(3);                       // two more slots
  await Promise.all([t, m]);
  ok(order[0] === 'movie', `the resize hands slots out by priority too (${order.join(' → ')})`);
  ok(order.length === 2, 'and both waiters were woken, not just one');
}

console.log('=== a movie PREEMPTS a running TV download ===');
{
  // Priority alone only decides who gets the slot NEXT. That still left a
  // movie sitting behind a whole episode, which is not the priority that was
  // asked for. The holder has to actually give the slot up.
  const sem = new Semaphore(1, 'download');
  let asked = false;
  await sem.acquire(STAGE_PRIORITY.tv, 'The Rookie S05E13', { onPreempt: () => { asked = true; } });

  const movie = sem.acquire(STAGE_PRIORITY.movie, 'F1 (2025)');
  ok(asked === true, 'the episode holding the slot was asked to yield');

  sem.release('The Rookie S05E13');       // the episode complies
  await movie;
  ok(sem.holders().includes('F1 (2025)'), 'and the movie now holds it');
}

console.log('=== a holder is only asked once ===');
{
  const sem = new Semaphore(1, 'download');
  let asks = 0;
  await sem.acquire(STAGE_PRIORITY.tv, 'ep', { onPreempt: () => { asks += 1; } });
  sem.acquire(STAGE_PRIORITY.movie, 'movie A');
  sem.acquire(STAGE_PRIORITY.movie, 'movie B');
  ok(asks === 1, `two waiting movies do not both nag it (${asks})`);
}

console.log('=== TV does not preempt TV, and nothing preempts a movie ===');
{
  const a = new Semaphore(1, 'download');
  let asked = false;
  await a.acquire(STAGE_PRIORITY.tv, 'ep1', { onPreempt: () => { asked = true; } });
  a.acquire(STAGE_PRIORITY.tv, 'ep2');
  ok(!asked, 'an episode does not shove another episode aside');

  const b = new Semaphore(1, 'download');
  let movieAsked = false;
  await b.acquire(STAGE_PRIORITY.movie, 'film', { onPreempt: () => { movieAsked = true; } });
  b.acquire(STAGE_PRIORITY.tv, 'ep');
  ok(!movieAsked, 'and an episode certainly does not shove a movie aside');
}

console.log('=== a holder that cannot yield keeps its slot ===');
{
  const sem = new Semaphore(1, 'download');
  await sem.acquire(STAGE_PRIORITY.tv, 'stubborn', { onPreempt: () => { throw new Error('cannot'); } });
  let threw = null;
  try { sem.acquire(STAGE_PRIORITY.movie, 'film'); } catch (e) { threw = e; }
  ok(!threw, 'a yield handler that throws does not take the semaphore down with it');
}

console.log('=== the TV pipeline actually registers a yield handler ===');
{
  const tv = fs.readFileSync(new URL('../src/plugins/tv-requests/index.js', import.meta.url), 'utf8');
  ok(/onPreempt: \(\) => yielded\.abort\(\)/.test(tv),
    'the download registers one — without it the machinery has nobody to ask, which is exactly what went wrong');
  ok(/AbortSignal\.any\(\[job\.signal, yielded\.signal\]/.test(tv),
    'and a yield stops the transfer, as a cancellation does');
  ok(/if \(!yielded\.signal\.aborted \|\| job\.isCancelled\(\)\) throw err;/.test(tv),
    'a real cancellation still propagates rather than being retried forever');
  ok(/gave the download slot to a movie — will restart/.test(tv), 'and the retry is visible in the log');
}

console.log('=== the wait message names what is really ahead ===');
{
  const sem = new Semaphore(1, 'download');
  await sem.acquire(STAGE_PRIORITY.tv, 'High Potential S02E03');
  const msg = waitReason(sem, 'download');
  ok(/High Potential S02E03/.test(msg), `it names the actual holder: "${msg}"`);
  ok(!/another movie/.test(msg),
    'and no longer claims a movie is downloading when a TV episode is');
  sem.release('High Potential S02E03');

  const idle = new Semaphore(1, 'download');
  ok(/nothing/.test(waitReason(idle, 'download')), 'an idle stage says so rather than inventing a holder');
}

console.log('=== both pipelines actually pass a priority ===');
{
  const movie = fs.readFileSync(new URL('../src/plugins/movie-requests/index.js', import.meta.url), 'utf8');
  const tv = fs.readFileSync(new URL('../src/plugins/tv-requests/index.js', import.meta.url), 'utf8');
  for (const stage of ['download', 'convert', 'upload']) {
    ok(new RegExp(`stageSems\\.${stage}\\.acquire\\(STAGE_PRIORITY\\.movie`).test(movie),
      `movies claim ${stage} at movie priority`);
    ok(new RegExp(`stageSems\\.${stage}\\.acquire\\(STAGE_PRIORITY\\.tv`).test(tv),
      `TV claims ${stage} at TV priority`);
  }
  // A bare acquire() would silently drop back to FIFO and reopen the bug.
  ok(!/stageSems\.\w+\.acquire\(\)/.test(movie + tv), 'no stage is claimed without a priority');
  ok(STAGE_PRIORITY.movie > STAGE_PRIORITY.tv, 'and movies genuinely outrank TV');
  ok(stageSems.download.capacity >= 1, 'the shared stages are still there');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
