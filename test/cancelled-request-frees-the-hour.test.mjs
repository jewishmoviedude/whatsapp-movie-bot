/* A request an admin cancels frees the member's hour. Run: node test/cancelled-request-frees-the-hour.test.mjs

   The operator, 2026-10-23: "cancelled request should free the member's hour".
   Judgment at Nuremberg was queued at 17:10:14 UTC and cancelled at 17:10:22,
   and the member's next request at 17:10:54 was refused as inside the hour
   (the bot's reply then, and the discussions answer that blamed the
   cancellation, were both wrong). Only the clock of the cancelled film is freed:
   a later film queued meanwhile still holds it. */
import fs from 'node:fs';
import { cooldownKeys, releaseClock, readClock, insideCooldown } from '../src/core/request-cooldown.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const jid = '10000000000010@lid';
const keys = cooldownKeys(jid);
const mem = new Map();
const store = { get: (k, d = null) => (mem.has(k) ? mem.get(k) : d), set: (k, v) => { if (v == null) mem.delete(k); else mem.set(k, v); } };
const NOW = Date.now();
const cooldownMs = 3600_000;

console.log('=== a queued film holds the hour until it is freed ===');
{
  store.set(keys.clock, { at: NOW - 60_000, what: 'Judgment at Nuremberg (1961)' });
  ok(insideCooldown(store, keys, { cooldownMs, now: NOW }) !== null, 'inside the hour before the cancel');
  ok(releaseClock(store, keys, 'Judgment at Nuremberg (1961)') === true, 'the cancelled film frees the clock');
  ok(readClock(store, keys.clock) === null, 'and the clock is gone');
  ok(insideCooldown(store, keys, { cooldownMs, now: NOW }) === null, 'so the next request is not refused for the hour');
}

console.log('=== only the cancelled film frees it ===');
{
  store.set(keys.clock, { at: NOW - 60_000, what: 'Heat (1995)' });
  ok(releaseClock(store, keys, 'Judgment at Nuremberg (1961)') === false, 'a different film does not free it');
  ok(readClock(store, keys.clock)?.what === 'Heat (1995)', 'and the clock still holds the later film');
}

console.log('=== nothing to free ===');
{
  mem.clear();
  ok(releaseClock(store, keys, 'Heat (1995)') === false, 'no clock: nothing happens');
}

console.log('=== the cancel paths call it ===');
{
  const src = fs.readFileSync(new URL('../src/plugins/movie-requests/index.js', import.meta.url), 'utf8');
  const calls = (src.match(/this\._freeMemberHour\(ctx, /g) ?? []).length;
  ok(calls === 3, `the three admin-cancel paths free the hour (${calls} calls)`);
  ok(/if \(!skipped\) this\._freeMemberHour/.test(src), 'a skip does not, a cancel does');
  ok(/releaseClock\(ctx\.store, keys, what\)/.test(src), 'and it clears only the cancelled film\'s clock');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
