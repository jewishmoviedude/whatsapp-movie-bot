/* A rolling counter that cannot leak. Run: node test/rate-window.test.mjs

   The obvious version - push a timestamp per event and filter on read - is a
   slow leak in a process that runs for weeks and emits thousands of actions an
   hour. This one holds a fixed ring of buckets, so memory is constant however
   many events go through it.

   The clock is injected, so an hour-long window is tested in milliseconds. */
import { RateWindow } from '../src/util/rate-window.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

/** A clock you can wind forward by hand. */
function clock(start = 1_000_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; }, set: (v) => { t = v; } };
}

const HOUR = 3_600_000;

console.log('=== it counts ===');
{
  const c = clock();
  const w = new RateWindow({ windowMs: HOUR, buckets: 60, now: c.now });
  ok(w.count() === 0, 'empty to begin with');
  w.add();
  w.add(4);
  ok(w.count() === 5, `add(1) and add(4) make 5 (${w.count()})`);
}

console.log('=== events age out of the window ===');
{
  const c = clock();
  const w = new RateWindow({ windowMs: HOUR, buckets: 60, now: c.now });
  w.add(10);
  c.advance(30 * 60_000);                 // half an hour later
  ok(w.count() === 10, 'still counted at 30 minutes');
  w.add(5);
  ok(w.count() === 15, 'and the newer ones join it');

  c.advance(31 * 60_000);                 // the first batch is now 61 min old
  ok(w.count() === 5, `the old batch has fallen out (${w.count()})`);

  c.advance(HOUR);
  ok(w.count() === 0, 'and eventually everything does');
}

console.log('=== the ring cannot inherit a previous lap ===');
{
  // The subtle failure: slot N is reused every `buckets` steps. If a stale slot
  // is added to rather than reset, a quiet hour inherits the busy one before it.
  const c = clock();
  const w = new RateWindow({ windowMs: 60_000, buckets: 60, now: c.now });   // 1s buckets
  w.add(100);
  c.advance(60_000);                      // exactly one full lap
  ok(w.count() === 0, 'a full lap later the window is empty');
  w.add(1);
  ok(w.count() === 1, `the reused slot starts from zero, not 101 (${w.count()})`);
}

console.log('=== memory is fixed, however many events ===');
{
  const c = clock();
  const w = new RateWindow({ windowMs: HOUR, buckets: 60, now: c.now });
  for (let i = 0; i < 50_000; i += 1) {
    w.add();
    if (i % 100 === 0) c.advance(1000);
  }
  ok(w._counts.length === 60 && w._stamps.length === 60,
    'still exactly 60 buckets after 50,000 events');
  ok(w.count() <= 50_000 && w.count() > 0, `and the count is sane (${w.count()})`);
}

console.log('=== a long silence does not strand old counts ===');
{
  const c = clock();
  const w = new RateWindow({ windowMs: HOUR, buckets: 60, now: c.now });
  w.add(999);
  c.advance(30 * 24 * HOUR);              // a month of nothing
  ok(w.count() === 0, 'a month later it reads zero, not 999');
}

console.log('=== fractionOf ===');
{
  const c = clock();
  const w = new RateWindow({ windowMs: HOUR, buckets: 60, now: c.now });
  w.add(50);
  ok(w.fractionOf(100) === 0.5, 'half of 100 is 0.5');
  ok(w.fractionOf(0) === 0, 'a zero limit reads 0 rather than dividing by zero');
  ok(w.fractionOf(-5) === 0, 'and so does a negative one');
  w.add(100);
  ok(w.fractionOf(100) === 1.5, 'it goes above 1 rather than clamping — the caller decides');
}

console.log('=== reset, and bad construction ===');
{
  const c = clock();
  const w = new RateWindow({ windowMs: HOUR, buckets: 60, now: c.now });
  w.add(10);
  w.reset();
  ok(w.count() === 0, 'reset empties it');

  let threw = false;
  try { new RateWindow({ windowMs: 0 }); } catch { threw = true; }
  ok(threw, 'a zero window is rejected rather than dividing by zero later');

  const one = new RateWindow({ windowMs: 1000, buckets: 1, now: c.now });
  one.add(3);
  ok(one.count() === 3, 'a single bucket still works');
}

console.log('=== a day-long window works the same ===');
{
  const c = clock();
  const day = new RateWindow({ windowMs: 24 * HOUR, buckets: 24, now: c.now });  // hourly buckets
  // 24 adds spanning 23 hours: every one is inside a 24-hour window. Advancing
  // AFTER the last add would push the first out, which is correct but makes a
  // confusing assertion - the window holds `buckets` buckets ending at now.
  for (let h = 0; h < 24; h += 1) { if (h) c.advance(HOUR); day.add(100); }
  ok(day.count() === 2400, `24 hourly batches of 100 is 2,400 (${day.count()})`);
  c.advance(HOUR);
  ok(day.count() === 2300, `an hour later the oldest rolls off (${day.count()})`);
  c.advance(22 * HOUR);
  ok(day.count() === 100, `and they keep rolling off one at a time (${day.count()})`);
}

console.log('=== it survives a restart ===');
{
  // Without this the budget resets to zero on every start, and a crash loop -
  // exactly when a volume ceiling matters most - would evade it entirely.
  const c = clock();
  const a = new RateWindow({ windowMs: HOUR, buckets: 60, now: c.now });
  a.add(42);

  const b = new RateWindow({ windowMs: HOUR, buckets: 60, now: c.now });
  ok(b.restore(JSON.parse(JSON.stringify(a.toJSON()))), 'a saved window is restored');
  ok(b.count() === 42, `with its count intact (${b.count()})`);

  // and it must still AGE correctly - the process may have been down for hours
  c.advance(HOUR + 60_000);
  ok(b.count() === 0, 'a window restored after a long outage ages out rather than counting stale events');
}

console.log('=== a restore that does not fit is refused, not half-applied ===');
{
  const c = clock();
  const w = new RateWindow({ windowMs: HOUR, buckets: 60, now: c.now });
  w.add(5);
  ok(!w.restore(null), 'null is refused');
  ok(!w.restore({ v: 99 }), 'a future version is refused');
  ok(!w.restore({ v: 1, bucketMs: 1, counts: [], stamps: [] }),
    'a different bucket size is refused — old indices would be meaningless');
  ok(!w.restore({ v: 1, bucketMs: HOUR / 60, counts: [1], stamps: [1] }),
    'a wrong length is refused');
  ok(w.count() === 5, 'and none of those disturbed the live count');

  const junk = new RateWindow({ windowMs: HOUR, buckets: 2, now: c.now });
  ok(junk.restore({ v: 1, bucketMs: HOUR / 2, counts: ['x', -5], stamps: [null, 'y'] }),
    'a structurally valid but garbage payload is accepted');
  ok(junk.count() === 0, 'with the garbage coerced to zero rather than NaN');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
