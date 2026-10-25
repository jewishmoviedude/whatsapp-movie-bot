/* A resumed encode's time left is the time its remaining pieces take, not seconds.
   Run: node test/conversion-eta.test.mjs

   A segmented encode (media/segmented.js) reports progress as a share of
   the whole film, pieces made before a restart included, and the panel's
   time left was that share over the time since this process began the
   conversion: a film resumed with 8 of its 10 pieces made showed "piece 9
   of 10 · 3.4x · 13s left" a minute in, with two pieces - some three
   minutes - still to make. Found in review of the resume work (2026-09-29,
   The Parent Trap). The time left is now worked out from the share of what
   was left when the run began (runPct), over the time since it began. */
import { conversionClock } from '../src/media/ffmpeg.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

console.log('=== 8 of 10 pieces made before the restart, a minute into the ninth ===');
{
  let now = 0;
  const clock = conversionClock(() => now);
  now = 1_000;
  clock(80, { runPct: 0 });                  // the ninth piece begins
  now = 61_000;
  const { eta, elapsed } = clock(82, { runPct: 10 });
  const old = Math.round((elapsed / 82) * (100 - 82));
  ok(eta === 540, `ten per cent of the rest in a minute: nine minutes left (${eta}s), not ${old}s`);
}

console.log('=== a one-pass encode, which has no run of its own, reads as it always did ===');
{
  let now = 0;
  const clock = conversionClock(() => now);
  now = 60_000;
  const { eta } = clock(50);
  ok(eta === 60, `half done in a minute: a minute left (${eta}s)`);
  ok(clock(0).eta === null, 'and nothing is said before it has begun');
}

console.log('=== the sound pass, before any piece, says nothing rather than something wrong ===');
{
  let now = 0;
  const clock = conversionClock(() => now);
  now = 5_000;
  ok(clock(0, { runPct: null }).eta === null && clock(0).eta === null, 'no time left is shown');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
