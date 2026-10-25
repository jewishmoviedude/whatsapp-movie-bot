/* Shabbos + yom tov lockdown window and scheduler decision.
   Run: node test/lockdown.test.mjs

   Two things this file learned the hard way.

   The window used to lock at NY candle-lighting and unlock at JERUSALEM
   havdalah. That was described as bracketing both communities and was actually
   their intersection: Israel spent the first seven hours of Shabbos with the
   groups open, and New York got unlocked at noon on Saturday with seven hours
   still to run. On 2026-09-10 both ends moved to New York.

   On 2026-09-22 the operator chose the mixed window again, deliberately and
   after seeing the times, so each end is now a setting and the default is New
   York candle-lighting with Jerusalem havdalah. That window, and every other
   combination, is tested in lockdown-cities.test.mjs. This file is about the
   calendar mechanics - runs that merge across yom tov and Shabbos, the
   four-day Pesach, what may never open a lock, the scheduler's decisions - so
   it pins New York at BOTH ends, where all of that is visible in one city.

   And these assertions must be made in NEW YORK time. This box runs UTC, so a
   Saturday-evening unlock in New York is Sunday by `getDate().getDay()` - the
   original test asserted `getDay() === 6` and passed only because the old
   Jerusalem unlock happened to land at NY midday. */
import { shabbosWindow, lockWindow, lockBlocks, isWithin, decide, LockScheduler } from '../src/core/lockdown.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ok   ' + m)) : (fail++, console.log('  FAIL ' + m)); };

// New York at both ends, explicitly: the default havdalah city is Jerusalem.
const cfg = { enabled: true, candleMinutes: 18, havdalahMinutes: 20, yomTov: true,
  candleCity: 'new-york', havdalahCity: 'new-york' };
const hours = (a, b) => (b - a) / 3600000;
/** Weekday as seen in New York, which is the only place these times mean anything. */
const nyDay = (d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][
  new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' })).getDay()];

console.log('=== an ordinary Shabbos ===');
{
  const win = lockWindow(new Date('2026-08-19T12:00:00Z'), cfg);
  ok(nyDay(win.lockAt) === 'Fri', 'locks Friday in New York');
  ok(nyDay(win.unlockAt) === 'Sat', 'unlocks Saturday in New York');
  // Candle-lighting Friday to nightfall Saturday is about 25 hours. The old
  // 17-hour figure was the NY-to-Jerusalem gap, which covered neither.
  ok(hours(win.lockAt, win.unlockAt) > 24 && hours(win.lockAt, win.unlockAt) < 26,
    `~25h, covering all of Shabbos where the members are (${hours(win.lockAt, win.unlockAt).toFixed(1)}h)`);
  ok(win.label === 'Shabbos', 'labelled Shabbos');
  ok(win.yomTov === false, 'and not flagged as yom tov');

  const mid = new Date('2026-08-21T23:40:00Z');
  ok(isWithin(mid, lockWindow(mid, cfg)), 'Friday night is inside');
  // Saturday lunchtime in New York is the moment the old window opened up.
  const satNoon = new Date('2026-08-22T16:00:00Z');
  ok(isWithin(satNoon, lockWindow(satNoon, cfg)), 'and so is Saturday lunchtime, which used to unlock');
}

console.log('=== yom tov, and the runs that merge with Shabbos ===');
{
  const blocks = lockBlocks(new Date('2026-09-09T12:00:00Z'), cfg);
  const find = (label) => blocks.find((b) => b.label.startsWith(label));

  // Erev Rosh Hashana 2026 is a Friday, so RH day 1 IS Shabbos and day 2 is
  // Sunday. There is no havdalah until Sunday night: one three-day lock.
  const rh = find('Rosh Hashana');
  ok(!!rh, 'Rosh Hashana is a window');
  ok(nyDay(rh.lockAt) === 'Fri' && nyDay(rh.unlockAt) === 'Sun', 'Friday evening through Sunday night');
  ok(hours(rh.lockAt, rh.unlockAt) > 47 && hours(rh.lockAt, rh.unlockAt) < 50,
    `one continuous block, not two (${hours(rh.lockAt, rh.unlockAt).toFixed(1)}h)`);
  ok(rh.label === 'Rosh Hashana + Shabbos', `says what it is: "${rh.label}"`);
  ok(rh.yomTov === true, 'flagged as yom tov');

  // Yom Kippur is one day and stands alone.
  const yk = find('Yom Kippur');
  ok(!!yk && hours(yk.lockAt, yk.unlockAt) < 26, 'Yom Kippur is a single day');
  ok(nyDay(yk.lockAt) === 'Sun' && nyDay(yk.unlockAt) === 'Mon', 'Sunday evening to Monday night 2026');

  ok(!!find('Sukkos'), 'first days of Sukkos');
  ok(!!find('Shmini Atzeres'), 'Shmini Atzeres / Simchas Torah');
  // The intermediate days are not locked - chol hamoed is a working week.
  const cholHamoed = new Date('2026-09-29T18:00:00Z');
  ok(!isWithin(cholHamoed, lockWindow(cholHamoed, cfg)), 'chol hamoed is NOT locked');
}

console.log('=== the four-day Pesach block ===');
{
  // 2027: yom tov Thursday and Friday, running straight into Shabbos. Nothing
  // opens in between, and no "find the Friday" logic would ever get this right.
  const blocks = lockBlocks(new Date('2027-04-18T12:00:00Z'), cfg);
  const pesach = blocks.find((b) => b.label.startsWith('Pesach'));
  ok(!!pesach, 'Pesach is a window');
  ok(nyDay(pesach.lockAt) === 'Wed', 'locks Wednesday evening');
  ok(nyDay(pesach.unlockAt) === 'Sat', 'and does not open until Saturday night');
  ok(hours(pesach.lockAt, pesach.unlockAt) > 70 && hours(pesach.lockAt, pesach.unlockAt) < 76,
    `~72h as one lock (${hours(pesach.lockAt, pesach.unlockAt).toFixed(1)}h)`);
  // Thursday and Friday of that block must be inside it, not free days.
  for (const [when, label] of [['2027-04-22T18:00:00Z', 'Thursday'], ['2027-04-23T18:00:00Z', 'Friday']]) {
    const t = new Date(when);
    ok(isWithin(t, lockWindow(t, cfg)), `${label} of Pesach stays locked`);
  }
}

console.log('=== Shavuos ===');
{
  const b = lockBlocks(new Date('2027-06-08T12:00:00Z'), cfg).find((x) => x.label.startsWith('Shavuos'));
  ok(!!b, 'Shavuos is a window');
  ok(nyDay(b.lockAt) === 'Thu' && nyDay(b.unlockAt) === 'Sat', 'Thursday evening to Saturday night 2027');
}

console.log('=== nothing else opens a lock ===');
{
  // Chanukah candles and fast start/end times are also timed events on this
  // calendar. If they were treated as candle-lighting the groups would shut
  // for eight nights in December.
  const chanukah = new Date('2026-12-06T23:00:00Z');
  const win = lockWindow(chanukah, cfg);
  ok(!isWithin(chanukah, win), 'Chanukah does not lock anything');
  const tishaBav = new Date('2027-08-12T20:00:00Z');
  ok(!isWithin(tishaBav, lockWindow(tishaBav, cfg)), 'nor does a fast day');
}

console.log('=== yom tov switched off still locks every Shabbos ===');
{
  // The trap: with yom tov beside Shabbos the two are ONE block, so filtering
  // out the yom tov blocks would drop those Shabbosos with them. Shabbos 12
  // and 26 September 2026 would simply never lock.
  const off = { ...cfg, yomTov: false };
  const blocks = lockBlocks(new Date('2026-09-09T12:00:00Z'), off);
  ok(blocks.every((b) => !b.yomTov), 'no yom tov windows');
  ok(blocks.every((b) => b.label === 'Shabbos'), 'all labelled Shabbos');
  for (const when of ['2026-09-12T02:00:00Z', '2026-09-26T02:00:00Z']) {
    const t = new Date(when);
    ok(isWithin(t, lockWindow(t, off)), `Shabbos beside yom tov still locks (${when.slice(0, 10)})`);
  }
  // And yom tov itself is left alone.
  const rhSunday = new Date('2026-09-13T18:00:00Z');
  ok(!isWithin(rhSunday, lockWindow(rhSunday, off)), 'but the yom tov day itself is not locked');
}

console.log('=== decide ===');
{
  const mid = new Date('2026-08-21T23:40:00Z');
  ok(decide(mid, cfg, { locked: false }) === 'lock', 'in-window unlocked -> lock');
  ok(decide(mid, cfg, { locked: true, source: 'schedule' }) === null, 'already locked -> nothing');
  ok(decide(mid, cfg, { locked: false, overriddenWindowKey: lockWindow(mid, cfg).key }) === null,
    'overridden window -> no re-lock');
  const wd = new Date('2026-08-19T12:00:00Z');
  ok(decide(wd, cfg, { locked: true, source: 'schedule' }) === 'unlock', 'weekday schedule-lock -> unlock');
  ok(decide(wd, cfg, { locked: true, source: 'manual' }) === null, 'weekday manual-lock -> leave');
  ok(decide(mid, { ...cfg, enabled: false }, { locked: false }) === null, 'disabled -> never acts');

  // An override is keyed on the window, so it must not leak into the next one.
  const rhKey = lockWindow(new Date('2026-09-11T23:00:00Z'), cfg).key;
  const nextShabbos = new Date('2026-09-18T23:00:00Z');
  ok(decide(nextShabbos, cfg, { locked: false, overriddenWindowKey: rhKey }) === 'lock',
    'unlocking Rosh Hashana does not also unlock the Shabbos after it');
}

console.log('=== the old name still works ===');
{
  // The scheduler and other callers import shabbosWindow; it is no longer only
  // Shabbos, but renaming it everywhere buys nothing.
  const t = new Date('2026-08-21T23:40:00Z');
  ok(shabbosWindow(t, cfg)?.key === lockWindow(t, cfg)?.key, 'shabbosWindow is lockWindow');
}

console.log('=== scheduler applies + persists ===');
{
  let state = { locked: false, source: null, overriddenWindowKey: null };
  const acts = [];
  const sch = new LockScheduler({
    getConfig: () => cfg, getState: () => state, persist: (s) => { state = s; },
    applyLock: async (src) => { acts.push('lock:' + src); state = { ...state, locked: true, source: src }; },
    applyUnlock: async (src, key) => { acts.push('unlock:' + src); state = { ...state, locked: false, source: src, overriddenWindowKey: key ?? state.overriddenWindowKey }; },
  });
  await sch.manualLock();
  ok(state.locked && state.source === 'manual', 'manualLock locks with manual source');
  // At a fixed instant inside a window. This used to run at the real time and
  // pass between windows too, because the NEXT window's key was recorded then -
  // which cancelled next week's lock (see lockdown-cities.test.mjs).
  const inWindow = new Date('2026-08-21T23:40:00Z');
  await sch.manualUnlock(inWindow);
  ok(!state.locked && state.overriddenWindowKey === lockWindow(inWindow, cfg).key,
    'manualUnlock inside a window records that window as overridden');
  const between = new Date('2026-08-19T12:00:00Z');
  await sch.manualLock();
  await sch.manualUnlock(between);
  ok(!state.locked && state.overriddenWindowKey === lockWindow(inWindow, cfg).key,
    'and between windows records nothing new, so the next window is not overridden');

  const st = sch.status();
  ok(Array.isArray(st.upcoming) && st.upcoming.length > 0, 'status lists the upcoming windows');
  ok(typeof st.label === 'string' || st.label === null, 'and names the current one');
}

console.log('\n' + '='.repeat(46) + '\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
