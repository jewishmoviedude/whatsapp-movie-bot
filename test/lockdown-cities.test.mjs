/* Which city each end of the Shabbos / yom tov lockdown is measured in.
   Run: node test/lockdown-cities.test.mjs

   On 2026-09-22 the operator chose to lock at candle-lighting in NEW YORK and
   unlock at havdalah in JERUSALEM, on the Israeli calendar, after being shown
   what it means: the groups reopen on Saturday late morning in New York, and
   this weekend (Shabbos + Sukkos) runs Fri 25 Sep 6:30 PM to Sat 26 Sep 11:51
   AM New York, leaving New York's second day of yom tov open. The same window
   had been removed on 2026-09-10 (a1255f2) as "the intersection, not the
   union" of the two communities - which it is, and he chose it anyway. So both
   ends became settings, and this file pins:

   - his window, to the minute, on the dates where it differs most from New
     York alone: this weekend, an ordinary Shabbos, Shmini Atzeres, Pesach and
     Shavuos 2027 (one day of yom tov in Jerusalem against two in New York,
     into Shabbos), Rosh Hashana and Yom Kippur 5788, and the weeks when only
     one country has changed its clocks;
   - that New York at both ends still computes exactly what origin/main did,
     for a year of days (test/fixtures/lockdown-ny-ny-origin-main.json);
   - the union (Jerusalem candle-lighting, New York havdalah), because it is
     the obvious alternative and must work if he picks it;
   - the pieces that failed while this was built: a lock that only started
     where New York's runs start never locked Shabbos in Pesach 2027 at all,
     and a Friday-to-Saturday-midday block stepped a day at a time from the
     lock never found its Saturday, so "Sukkos + Shabbos" read "Sukkos";
   - hebcal's silent swap of 18 minutes for Jerusalem's 40, which the bot
     does not follow: the minutes on the card are the minutes used;
   - the guard for a havdalah that never comes, the Shabbos-only fallback,
     validation on save, the scheduler's decision at instants inside and
     outside the new window, and the panel hint that shows both cities.

   And what review of the branch found, each with its test:
   - a manual unlock pressed BETWEEN windows recorded the next window as
     overridden, so next Friday never locked. Older than the cities, but the
     new window invites it: lock by hand for the rest of New York's Shabbos,
     unlock after its havdalah, and the following Shabbos was skipped;
   - the "If saved:" preview skipped an empty or negative minutes box and
     showed the saved minutes, while Save stored the box as 0 or -5 - and a
     havdalah of 0 is no havdalah at all to hebcal, so nothing would lock;
   - the New York note only ever described next week: once the groups
     reopened on Saturday midday, the card moved on, and while it was still
     Shabbos in New York nothing said so;
   - the preview assertion compared against the saved window at the real
     time, and failed every Saturday afternoon in New York;
   - the origin/main fixture only matched in UTC, because origin/main's labels
     read the local date, so that comparison now runs under the fixture's tz.

   All times are asserted as the wall clock reads in New York or Jerusalem.
   This box runs UTC, where a New York Saturday evening is already Sunday. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import { HebrewCalendar, HavdalahEvent, Location, Zmanim } from '@hebcal/core';
import log from '../src/util/logger.js';
import {
  lockBlocks, lockWindow, isWithin, decide, LockScheduler, windowSummary, lockdownCityProblem,
  DEFAULT_CANDLE_CITY, DEFAULT_HAVDALAH_CITY,
} from '../src/core/lockdown.js';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';
import { createApiRouter } from '../src/web/api.js';
import { JobQueue } from '../src/core/queue.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const NY = 'America/New_York';
const IL = 'Asia/Jerusalem';

/** "2026-09-25 18:30" - the wall clock in that zone. */
function wall(d, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
/** The instant a wall clock in that zone reads `s` ("2026-09-26 12:30"). */
function at(s, tz) {
  for (const off of [-5, -4, 2, 3]) {
    const d = new Date(`${s.replace(' ', 'T')}:00Z`);
    d.setUTCHours(d.getUTCHours() - off);
    if (wall(d, tz) === s) return d;
  }
  throw new Error(`no ${s} in ${tz}`);
}
const ny = (s) => at(s, NY);
const near = (d, s, tz, mins = 1) => !!d && Math.abs(d - at(s, tz)) <= mins * 60000;
const hours = (b) => (b.unlockAt - b.lockAt) / 3600000;

const base = { enabled: true, candleMinutes: 18, havdalahMinutes: 20, yomTov: true };
const OPERATOR = { ...base, candleCity: 'new-york', havdalahCity: 'jerusalem' };
const NYNY = { ...base, candleCity: 'new-york', havdalahCity: 'new-york' };
const UNION = { ...base, candleCity: 'jerusalem', havdalahCity: 'new-york' };
const JJ = { ...base, candleCity: 'jerusalem', havdalahCity: 'jerusalem' };

/** The block that locks on this New York date, as seen a few days before. */
function blockOn(cfg, nyDate) {
  const now = new Date(ny(`${nyDate} 00:00`)); now.setUTCDate(now.getUTCDate() - 3);
  return lockBlocks(now, cfg).find((b) => wall(b.lockAt, NY).startsWith(nyDate)) ?? null;
}
const lockedAt = (cfg, when) => isWithin(when, lockWindow(when, cfg));

// Computed here straight from the sun, not from the calendar the code reads:
// New York as the code has always defined it, Jerusalem as hebcal lists it.
const NY_LOC = new Location(40.7128, -74.0060, false, NY, 'New York', 'US');
const JLM_LOC = Location.lookup('Jerusalem');
const civil = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const candleIn = (loc, day, mins = 18) => new Zmanim(loc, civil(day), false).sunsetOffset(-mins, true);
const havdalahIn = (loc, day, mins = 20) => new Zmanim(loc, civil(day), false).sunsetOffset(mins, true);

console.log('=== the default is the operator\'s choice ===');
{
  ok(DEFAULT_CANDLE_CITY === 'new-york' && DEFAULT_HAVDALAH_CITY === 'jerusalem',
    'lockdown.js defaults: candle-lighting in New York, havdalah in Jerusalem');
  ok(DEFAULT_CONFIG.lockdown.candleCity === 'new-york' && DEFAULT_CONFIG.lockdown.havdalahCity === 'jerusalem',
    'and schema.js says the same');
  // The live config was saved before the cities existed and has neither key.
  const live = mergeDefaults({ lockdown: { enabled: true, candleMinutes: 18, havdalahMinutes: 20, yomTov: true, alwaysLocked: ['g@g.us'] } });
  ok(live.lockdown.candleCity === 'new-york' && live.lockdown.havdalahCity === 'jerusalem',
    'a config saved without the keys gets the operator\'s window');
  const now = new Date('2026-09-22T12:00:00Z');
  ok(JSON.stringify(lockBlocks(now, base)) === JSON.stringify(lockBlocks(now, OPERATOR)),
    'and lockBlocks() with no cities given computes the same window');
}

console.log('=== this weekend: Shabbos + Sukkos 2026 ===');
{
  const b = blockOn(OPERATOR, '2026-09-25');
  ok(!!b, 'there is a block');
  ok(near(b.lockAt, '2026-09-25 18:30', NY), `locks Fri 25 Sep 6:30 PM New York (${wall(b.lockAt, NY)})`);
  ok(near(b.unlockAt, '2026-09-26 11:51', NY), `unlocks Sat 26 Sep 11:51 AM New York (${wall(b.unlockAt, NY)})`);
  ok(wall(b.unlockAt, IL) === '2026-09-26 18:51', `which is 6:51 PM in Jerusalem (${wall(b.unlockAt, IL)})`);
  ok(+b.lockAt === +candleIn(NY_LOC, '2026-09-25'), 'exactly 18 minutes before New York sunset');
  ok(+b.unlockAt === +havdalahIn(JLM_LOC, '2026-09-26'), 'exactly 20 minutes after Jerusalem sunset');
  ok(b.label === 'Sukkos + Shabbos' && b.yomTov === true, `still says what it is: "${b.label}"`);
  ok(near(b.nyHolyUntil, '2026-09-27 19:05', NY), `and records that New York's yom tov runs on to Sun 7:05 PM (${b.nyHolyUntil && wall(b.nyHolyUntil, NY)})`);

  ok(!lockedAt(OPERATOR, ny('2026-09-25 18:29')), 'open at 6:29 PM Friday');
  ok(lockedAt(OPERATOR, ny('2026-09-25 18:31')), 'locked at 6:31 PM Friday');
  ok(lockedAt(OPERATOR, ny('2026-09-26 11:00')), 'locked at 11 AM Saturday');
  ok(!lockedAt(OPERATOR, ny('2026-09-26 12:30')), 'open at 12:30 PM Saturday');
  ok(!lockedAt(OPERATOR, ny('2026-09-27 12:00')), 'and New York\'s second day of Sukkos is open');
}

console.log('=== an ordinary Shabbos ===');
{
  const b = blockOn(OPERATOR, '2026-10-09');
  ok(near(b.lockAt, '2026-10-09 18:06', NY) && near(b.unlockAt, '2026-10-10 11:33', NY),
    `Fri 6:06 PM -> Sat 11:33 AM New York (${wall(b.lockAt, NY)} -> ${wall(b.unlockAt, NY)})`);
  ok(b.label === 'Shabbos' && b.yomTov === false, 'labelled Shabbos');
  ok(hours(b) > 17 && hours(b) < 18, `about 17h, the gap between the two cities (${hours(b).toFixed(1)}h)`);
  ok(near(b.nyHolyUntil, '2026-10-10 18:43', NY), 'reopening seven hours before New York\'s havdalah, and saying so');
}

console.log('=== Shmini Atzeres / Simchas Torah + Shabbos ===');
{
  const b = blockOn(OPERATOR, '2026-10-02');
  ok(near(b.lockAt, '2026-10-02 18:18', NY) && near(b.unlockAt, '2026-10-03 11:42', NY),
    `Fri 6:18 PM -> Sat 11:42 AM New York (${wall(b.lockAt, NY)} -> ${wall(b.unlockAt, NY)})`);
  ok(b.label === 'Shmini Atzeres + Shabbos', `"${b.label}"`);
  // One day in Israel, Shmini Atzeres and Simchas Torah together. New York's
  // Simchas Torah is the Sunday, and it is open.
  ok(!lockedAt(OPERATOR, ny('2026-10-04 12:00')), 'Simchas Torah in New York (Sunday) is open');
  ok(near(b.nyHolyUntil, '2026-10-04 18:53', NY), 'as the note says');
}

console.log('=== Pesach 2027: one day in Jerusalem, two in New York, into Shabbos ===');
{
  const blocks = lockBlocks(new Date('2027-04-18T12:00:00Z'), OPERATOR);
  const on = (d) => blocks.find((b) => wall(b.lockAt, NY).startsWith(d));
  const first = on('2027-04-21');
  ok(!!first && near(first.lockAt, '2027-04-21 19:23', NY), 'locks Wednesday at New York candle-lighting');
  ok(near(first.unlockAt, '2027-04-22 12:33', NY) && +first.unlockAt === +havdalahIn(JLM_LOC, '2027-04-22'),
    `and opens at Jerusalem's havdalah on Thursday (${wall(first.unlockAt, NY)} New York)`);
  ok(first.label === 'Pesach', `"${first.label}"`);
  // The case that failed first time round: in New York Wednesday night to
  // Saturday night is ONE run, so Friday's candle-lighting starts nothing
  // there. Shabbos starts a run of its own in Jerusalem, and must lock.
  const shabbos = on('2027-04-23');
  ok(!!shabbos, 'Shabbos inside New York\'s four-day run still gets its own lock');
  ok(shabbos && +shabbos.lockAt === +candleIn(NY_LOC, '2027-04-23'), 'at New York\'s Friday candle-lighting');
  ok(shabbos && near(shabbos.unlockAt, '2027-04-24 12:34', NY), `to Jerusalem's havdalah (${shabbos && wall(shabbos.unlockAt, NY)})`);
  ok(shabbos?.label === 'Shabbos', `labelled "${shabbos?.label}" - Saturday is chol hamoed`);
  ok(!lockedAt(OPERATOR, ny('2027-04-22 15:00')), 'Thursday afternoon (Pesach II in New York) is open');
  ok(!lockedAt(OPERATOR, ny('2027-04-23 15:00')), 'and so is Friday afternoon');
  ok(lockedAt(OPERATOR, ny('2027-04-24 09:00')), 'Shabbos morning is locked');

  const last = on('2027-04-27');
  ok(!!last && near(last.unlockAt, '2027-04-28 12:37', NY) && last.label === 'Pesach',
    'the last days: Tuesday night to Jerusalem\'s havdalah on Wednesday');
  ok(!lockedAt(OPERATOR, ny('2027-04-29 12:00')), 'and the eighth day, New York only, is open');
}

console.log('=== Shavuos 2027 ===');
{
  const b = blockOn(OPERATOR, '2027-06-10');
  ok(near(b.lockAt, '2027-06-10 20:08', NY) && near(b.unlockAt, '2027-06-12 13:05', NY),
    `Thu 8:08 PM -> Sat 1:05 PM New York as one block (${wall(b.lockAt, NY)} -> ${wall(b.unlockAt, NY)})`);
  ok(lockedAt(OPERATOR, ny('2027-06-11 12:00')), 'Friday - Shavuos in both places - is locked');
  ok(b.label === 'Shavuos + Shabbos', `"${b.label}"`);
}

console.log('=== Rosh Hashana and Yom Kippur 5788 ===');
{
  // Two days of Rosh Hashana in Israel too, so the unlock is Sunday.
  const rh = blockOn(OPERATOR, '2027-10-01');
  ok(near(rh.lockAt, '2027-10-01 18:20', NY) && near(rh.unlockAt, '2027-10-03 11:42', NY),
    `Fri 6:20 PM -> Sun 11:42 AM New York (${wall(rh.lockAt, NY)} -> ${wall(rh.unlockAt, NY)})`);
  ok(lockedAt(OPERATOR, ny('2027-10-03 10:00')), 'Sunday morning is locked - Israel keeps both days');
  ok(rh.label === 'Rosh Hashana + Shabbos', `"${rh.label}"`);
  const yk = blockOn(OPERATOR, '2027-10-10');
  ok(near(yk.lockAt, '2027-10-10 18:05', NY) && near(yk.unlockAt, '2027-10-11 11:32', NY),
    `Yom Kippur: Sun 6:05 PM -> Mon 11:32 AM New York (${wall(yk.lockAt, NY)} -> ${wall(yk.unlockAt, NY)})`);
  ok(yk.label === 'Yom Kippur' && yk.yomTov, 'labelled Yom Kippur');
  ok(!lockedAt(OPERATOR, ny('2027-10-11 12:00')), 'and Monday afternoon New York is open');
}

console.log('=== the weeks when only one country has changed its clocks ===');
{
  // Israel leaves summer time on 25 Oct 2026, the US on 1 Nov; the US starts
  // on 14 Mar 2027, Israel on 26 Mar. In between, New York is six hours
  // behind Jerusalem instead of seven. Each end must still be its own city's
  // sun - nothing may assume a fixed gap.
  for (const [fri, sat, gap, nyUnlock] of [
    ['2026-10-23', '2026-10-24', 7, '11:17'],
    ['2026-10-30', '2026-10-31', 6, '11:11'],
    ['2026-11-06', '2026-11-07', 7, '10:05'],
    ['2027-03-19', '2027-03-20', 6, '12:10'],
    ['2027-03-26', '2027-03-27', 7, '12:15'],
  ]) {
    const b = blockOn(OPERATOR, fri);
    const exact = +b.lockAt === +candleIn(NY_LOC, fri) && +b.unlockAt === +havdalahIn(JLM_LOC, sat);
    ok(exact && wall(b.unlockAt, NY) === `${sat} ${nyUnlock}`,
      `${sat}: New York candle-lighting to Jerusalem havdalah, ${wall(b.unlockAt, NY).slice(11)} New York = ${wall(b.unlockAt, IL).slice(11)} Jerusalem`);
    // How far behind Jerusalem's clock New York's reads at that instant.
    const clockGap = (at(wall(b.unlockAt, IL), NY) - b.unlockAt) / 3600000;
    ok(clockGap === gap, `  and the clocks are ${gap}h apart that week (${clockGap}h)`);
  }
}

console.log('=== New York at both ends is exactly what origin/main computed ===');
{
  const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/lockdown-ny-ny-origin-main.json', import.meta.url), 'utf8'));
  // origin/main names a same-city block from the LOCAL date of each instant,
  // so its labels depend on the process time zone: under New York's, 3 of
  // these days differ from the fixture, under Jerusalem's 39, with the
  // instants identical. The fixture was made in UTC, which is what the box
  // and the service run in, so the comparison runs there - whatever TZ the
  // test was started with - and the zone is put back afterwards.
  const tzWas = process.env.TZ;
  process.env.TZ = fx.tz ?? 'UTC';
  const hash = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
  const byKey = new Map(fx.blocks.map(([k, u, label, yt]) => [k, { u, label, yt }]));
  const cfg = { ...fx.cfg, candleCity: 'new-york', havdalahCity: 'new-york' };
  const days = Object.entries(fx.samples);
  let differ = 0, extra = 0, unknown = 0;
  for (const [day, [on, off]] of days) {
    const now = new Date(`${day}T12:00:00Z`);
    const yt = lockBlocks(now, { ...cfg, yomTov: true });
    if (hash(yt) !== on) differ++;
    if (hash(lockBlocks(now, { ...cfg, yomTov: false })) !== off) differ++;
    for (const b of yt) {
      if (Object.keys(b).join() !== 'lockAt,unlockAt,key,label,yomTov') extra++;
      const want = byKey.get(b.key);
      if (!want || want.u !== b.unlockAt.toISOString() || want.label !== b.label || want.yt !== b.yomTov) unknown++;
    }
  }
  if (tzWas === undefined) delete process.env.TZ; else process.env.TZ = tzWas;
  ok(days.length >= 365, `${days.length} days sampled, ${days[0][0]} to ${days.at(-1)[0]}`);
  ok(differ === 0, `the same blocks, yom tov on and off, byte for byte (${differ} differ)`);
  ok(extra === 0, 'with no new fields - no note, no fallback');
  ok(unknown === 0, `every block matches the table in the fixture (${unknown} do not)`);
  ok(fx.tz === 'UTC', `compared in the time zone the fixture was made in (${fx.tz})`);
}

console.log('=== the union: Jerusalem candle-lighting, New York havdalah ===');
{
  const b = blockOn(UNION, '2026-09-25');
  // Jerusalem's sunset less the card's 18 minutes. hebcal on its own would
  // have used Jerusalem's custom of 40 (5:52 PM there, 10:52 AM New York),
  // silently, because it treats 18 in Israel as "not set".
  ok(+b.lockAt === +candleIn(JLM_LOC, '2026-09-25'), `locks 18 minutes before Jerusalem sunset (${wall(b.lockAt, IL)} Jerusalem)`);
  ok(wall(b.lockAt, NY) === '2026-09-25 11:14', `Fri 11:14 AM New York (${wall(b.lockAt, NY)})`);
  ok(+b.lockAt !== +candleIn(JLM_LOC, '2026-09-25', 40), 'not hebcal\'s Jerusalem 40 minutes');
  ok(near(b.unlockAt, '2026-09-27 19:05', NY), `to the end of New York's run, Sun 7:05 PM (${wall(b.unlockAt, NY)})`);
  ok(b.label === 'Sukkos + Shabbos' && !b.nyHolyUntil, 'nothing opens early in New York');

  const pesach = blockOn(UNION, '2027-04-21');
  // Jerusalem's Wednesday and Friday locks both run to New York's Saturday
  // night: one block, about 80 hours, which the 84-hour guard must allow.
  ok(near(pesach.unlockAt, '2027-04-24 20:05', NY), `Pesach 2027: Wednesday to Saturday night as ONE block (${wall(pesach.unlockAt, NY)})`);
  ok(hours(pesach) > 79 && hours(pesach) < 84 && !pesach.fallback, `${hours(pesach).toFixed(1)}h, with no fallback`);
  ok(!blockOn(UNION, '2027-04-23'), 'Friday\'s lock is merged into it, not a second block');
  ok(pesach.label === 'Pesach + Shabbos', `"${pesach.label}"`);
}

/** Every block that is current or still to come at some point in the year. */
function year(cfg) {
  const seen = new Map();
  for (let t = Date.UTC(2026, 8, 20); t < Date.UTC(2027, 9, 1); t += 3 * 86400000) {
    const now = new Date(t);
    for (const b of lockBlocks(now, cfg)) if (b.unlockAt > now && !seen.has(b.key)) seen.set(b.key, b);
  }
  return [...seen.values()].sort((a, b) => a.lockAt - b.lockAt);
}

console.log('=== intersection and union, instant by instant ===');
{
  // The history in one assertion each. With the ends in different cities the
  // lock can only be narrower than either city alone (the operator's window)
  // or wider than both (the union) - never something else.
  const sets = { op: year(OPERATOR), nyny: year(NYNY), jj: year(JJ), union: year(UNION) };
  const inside = (list, t) => list.some((b) => t >= b.lockAt && t < b.unlockAt);
  let notSubset = 0, notUnion = 0, notOnlyUnion = 0, samples = 0;
  for (let t = Date.UTC(2026, 8, 23, 0, 7); t < Date.UTC(2027, 8, 23); t += 30 * 60000) {
    const d = new Date(t);
    const [op, a, j, u] = [inside(sets.op, d), inside(sets.nyny, d), inside(sets.jj, d), inside(sets.union, d)];
    samples++;
    if (op && !(a && j)) notSubset++;
    if ((a || j) && !u) notUnion++;
    if (u && !(a || j)) notOnlyUnion++;
  }
  ok(notSubset === 0, `New York candle-lighting to Jerusalem havdalah is locked only when BOTH cities are (${samples} half-hours, ${notSubset} not)`);
  ok(notUnion === 0 && notOnlyUnion === 0, `Jerusalem candle-lighting to New York havdalah is locked exactly when EITHER is (${notUnion + notOnlyUnion} not)`);
}

console.log('=== blocks never overlap or invert ===');
{
  let bad = [];
  let longest = 0;
  for (const [name, cfg] of Object.entries({ OPERATOR, NYNY, UNION, JJ })) {
    for (const yomTov of [true, false]) {
      for (let t = Date.UTC(2026, 8, 20); t < Date.UTC(2027, 9, 20); t += 3 * 86400000) {
        const blocks = lockBlocks(new Date(t), { ...cfg, yomTov });
        const keys = new Set(blocks.map((b) => b.key));
        if (keys.size !== blocks.length) bad.push(`${name} duplicate keys at ${new Date(t).toISOString()}`);
        blocks.forEach((b, i) => {
          longest = Math.max(longest, hours(b));
          if (!(b.lockAt < b.unlockAt)) bad.push(`${name} inverted ${b.key}`);
          if (i && b.lockAt < blocks[i - 1].unlockAt) bad.push(`${name} overlap ${blocks[i - 1].key} / ${b.key}`);
          if (b.fallback) bad.push(`${name} fell back at ${b.key}: ${b.fallback}`);
        });
      }
    }
  }
  ok(bad.length === 0, `four city pairs, yom tov on and off, every third day for 13 months${bad.length ? ` - ${bad.slice(0, 3).join('; ')}` : ''}`);
  ok(longest < 84, `the longest real block is ${longest.toFixed(1)}h, inside the 84h guard`);
}

console.log('=== yom tov off, and hebcal failing: Shabbos only, in the chosen cities ===');
{
  const off = { ...OPERATOR, yomTov: false };
  const b = blockOn(off, '2026-09-25');
  const sunset = (loc, day) => new Zmanim(loc, civil(day), false).sunset().getTime();
  ok(+b.lockAt === sunset(NY_LOC, '2026-09-25') - 18 * 60000, 'New York\'s Friday sunset less 18 minutes');
  ok(+b.unlockAt === sunset(JLM_LOC, '2026-09-26') + 20 * 60000, 'to Jerusalem\'s Saturday sunset plus 20');
  ok(b.label === 'Shabbos' && !b.yomTov && !!b.nyHolyUntil, 'labelled Shabbos, with the New York note');
  ok(!lockedAt(off, ny('2026-09-26 12:30')) && !lockedAt(off, ny('2026-09-27 12:00')), 'open Saturday afternoon and Sunday');

  const u = blockOn({ ...UNION, yomTov: false }, '2026-09-25');
  ok(+u.lockAt === sunset(JLM_LOC, '2026-09-25') - 18 * 60000 && +u.unlockAt === sunset(NY_LOC, '2026-09-26') + 20 * 60000,
    'the union: Jerusalem Friday to New York Saturday night');

  const real = HebrewCalendar.calendar;
  HebrewCalendar.calendar = () => { throw new Error('simulated hebcal failure'); };
  let fellBack;
  try { fellBack = lockBlocks(new Date('2026-09-22T12:00:00Z'), OPERATOR); } finally { HebrewCalendar.calendar = real; }
  ok(JSON.stringify(fellBack) === JSON.stringify(lockBlocks(new Date('2026-09-22T12:00:00Z'), off)),
    'when hebcal throws, the Shabbos-only window keeps both cities');
}

console.log('=== a havdalah that never comes: the guard ===');
{
  // If the unlock city's havdalah is missing, the first one after the lock is
  // next week's, and the groups would stay shut for a week. Past 84 hours the
  // block ends at the lock city's own havdalah instead, and says why.
  const warnings = [];
  const listen = (e) => { if (e.scope === 'lockdown' && e.level === 'warn') warnings.push(e.msg); };
  log.on('line', listen);
  const real = HebrewCalendar.calendar;
  const lost = havdalahIn(JLM_LOC, '2026-09-26');
  HebrewCalendar.calendar = (opts) => real.call(HebrewCalendar, opts)
    .filter((e) => !(e instanceof HavdalahEvent && +e.eventTime === +lost));
  let blocks;
  try { blocks = lockBlocks(new Date('2026-09-22T12:00:00Z'), OPERATOR); } finally { HebrewCalendar.calendar = real; log.off('line', listen); }
  const b = blocks.find((x) => wall(x.lockAt, NY).startsWith('2026-09-25'));
  ok(near(b.unlockAt, '2026-09-27 19:05', NY), `Sukkos with Jerusalem's havdalah missing ends at New York's own (${wall(b.unlockAt, NY)}), not a week later`);
  ok(/Jerusalem havdalah is \d+h after the lock - unlocking at New York's own havdalah instead/.test(b.fallback ?? ''), `and records why: "${b.fallback}"`);
  ok(warnings.some((w) => w.includes(b.key) && w.includes('unlocking at New York')), 'with a warning in the log');
  const next = blocks.find((x) => wall(x.lockAt, NY).startsWith('2026-10-02'));
  ok(near(next.unlockAt, '2026-10-03 11:42', NY) && !next.fallback, 'the next block is untouched');
  ok(windowSummary(new Date('2026-09-22T12:00:00Z'), OPERATOR, blocks).fallback === b.fallback, 'and the panel is told');
}

console.log('=== the scheduler: locked or not, right now ===');
{
  const locked = { locked: true, source: 'schedule' };
  const open = { locked: false };
  ok(decide(ny('2026-09-25 18:31'), OPERATOR, open) === 'lock', 'Fri 6:31 PM New York: lock');
  ok(decide(ny('2026-09-26 11:00'), OPERATOR, locked) === null, 'Sat 11:00 AM: stays locked');
  ok(decide(ny('2026-09-26 12:30'), OPERATOR, locked) === 'unlock', 'Sat 12:30 PM this week: unlock');
  ok(decide(ny('2026-09-26 12:30'), OPERATOR, open) === null, 'and then stays open');
  ok(decide(ny('2026-09-27 12:00'), OPERATOR, open) === null, 'Sunday (Sukkos II in New York): nothing to do');
  ok(decide(ny('2026-09-26 12:30'), NYNY, open) === 'lock', 'whereas New York at both ends would still be locked');

  // A manual unlock is remembered by the window's key; it must not change
  // while the window runs, or the schedule would re-lock over the admin.
  const k1 = lockWindow(ny('2026-09-25 18:31'), OPERATOR).key;
  const k2 = lockWindow(ny('2026-09-26 11:50'), OPERATOR).key;
  ok(k1 === k2 && decide(ny('2026-09-26 11:50'), OPERATOR, { locked: false, overriddenWindowKey: k1 }) === null,
    'an admin\'s manual unlock holds for the whole window');

  const sch = new LockScheduler({ getConfig: () => OPERATOR, getState: () => open, persist() {}, applyLock() {}, applyUnlock() {} });
  const mid = sch.status(ny('2026-09-26 11:00'));
  ok(mid.inWindow && mid.window.nyHolyUntil && wall(mid.window.nyHolyUntil, NY) === '2026-09-27 19:05',
    'status inside the window: locked, and New York\'s end is on it for the panel');
  ok(mid.window.candleCity === 'new-york' && mid.window.havdalahCity === 'jerusalem'
    && mid.window.cities.havdalah.tz === IL, 'with both cities named');
  const after = sch.status(ny('2026-09-26 12:30'));
  ok(!after.inWindow && near(after.nextLockAt, '2026-10-02 18:18', NY), 'after the unlock: next lock is Fri 2 Oct');
  ok(after.upcoming.every((u) => u.unlockAt > ny('2026-09-26 12:30')), '"Coming up" no longer lists windows that are over');
}

console.log('=== a manual unlock between windows does not cancel the next one ===');
{
  // Found in review: between windows lockWindow() is the NEXT window, and
  // manualUnlock() recorded its key as overridden, so decide() never locked
  // it. The new window invites exactly that: the groups reopen at Saturday
  // midday, the card says it is still Shabbos in New York, an admin locks by
  // hand and unlocks after New York's havdalah - and next Friday was skipped.
  // Driven through the scheduler with a stub bot and the same state handling
  // as src/index.js, a tick every five minutes.
  let state = { locked: false, source: null, overriddenWindowKey: null };
  const acts = [];
  const sch = new LockScheduler({
    getConfig: () => OPERATOR, getState: () => state, persist: (st) => { state = st; },
    applyLock: async (src) => { acts.push(`lock:${src}`); state = { ...state, locked: true, source: src }; },
    applyUnlock: async (src, key = null) => {
      acts.push(`unlock:${src}`);
      state = { ...state, locked: false, source: src, overriddenWindowKey: key ?? state.overriddenWindowKey ?? null };
    },
  });
  const tickAt = async (t) => {
    const action = decide(t, OPERATOR, state);
    if (action === 'lock') await sch.applyLock('schedule');
    else if (action === 'unlock') await sch.applyUnlock('schedule');
  };
  const run = async (from, to) => { for (let t = +ny(from); t <= +ny(to); t += 5 * 60000) await tickAt(new Date(t)); };

  await run('2026-10-09 17:00', '2026-10-10 12:30');
  ok(acts.join() === 'lock:schedule,unlock:schedule', `the schedule locks Fri 9 Oct and reopens Sat midday (${acts.join()})`);
  await sch.manualLock();
  ok(state.locked && state.source === 'manual', 'an admin locks by hand for the rest of New York\'s Shabbos');
  await run('2026-10-10 13:00', '2026-10-10 19:55');
  ok(state.locked, 'the schedule leaves a manual lock alone');
  await sch.manualUnlock(ny('2026-10-10 20:00'));
  const next = lockWindow(ny('2026-10-10 20:00'), OPERATOR);
  ok(!state.locked && state.overriddenWindowKey !== next.key,
    `and unlocks after New York's havdalah without overriding next Friday (${state.overriddenWindowKey})`);
  acts.length = 0;
  await run('2026-10-16 17:00', '2026-10-17 12:00');
  ok(acts[0] === 'lock:schedule' && acts.includes('unlock:schedule'),
    `Fri 16 Oct still locks at New York candle-lighting and reopens Saturday (${acts.join()})`);

  // Inside a window it is still an override for that window, and only that one.
  state = { locked: true, source: 'schedule', overriddenWindowKey: null };
  const inside = ny('2026-10-17 09:00');
  await sch.manualUnlock(inside);
  ok(state.overriddenWindowKey === lockWindow(inside, OPERATOR).key && decide(ny('2026-10-17 10:00'), OPERATOR, state) === null,
    'a manual unlock during a window keeps it open for the rest of that window');
  ok(decide(ny('2026-10-23 18:00'), OPERATOR, state) === 'lock', 'and the next Friday locks as usual');
}

console.log('=== while New York is still in Shabbos after the groups reopen, the card says so ===');
{
  // Found in review: the note was built from the next window only, so from
  // the Saturday midday unlock to New York's havdalah - the hours it is about
  // - the card described next week and nothing said it was Shabbos now.
  const at1230 = windowSummary(ny('2026-09-26 12:30'), OPERATOR);
  ok(!at1230.inWindow && near(at1230.lockAt, '2026-10-02 18:18', NY), 'Sat 26 Sep 12:30 PM: the next lock is next Friday');
  ok(at1230.reopened && near(at1230.reopened.unlockAt, '2026-09-26 11:51', NY)
    && near(at1230.reopened.nyHolyUntil, '2026-09-27 19:05', NY) && at1230.reopened.label === 'Sukkos + Shabbos',
    'and it reports the window that has just reopened, with New York\'s end');
  ok(windowSummary(ny('2026-09-27 12:00'), OPERATOR).reopened, 'still on Sunday, Sukkos II in New York');
  ok(windowSummary(ny('2026-09-27 19:10'), OPERATOR).reopened === null, 'gone once New York\'s yom tov is out');
  ok(windowSummary(ny('2026-09-26 11:00'), OPERATOR).reopened === null, 'not while a window is in progress');
  ok(windowSummary(ny('2026-09-25 12:00'), OPERATOR).reopened === null, 'nor before it');
  // Pesach 2027: open Thursday midday, then locked again on Friday evening.
  // Inside Friday's lock the Thursday opening is not "now" any more.
  ok(windowSummary(ny('2027-04-23 15:00'), OPERATOR).reopened?.label === 'Pesach', 'Fri 23 Apr 2027 afternoon: Pesach has reopened');
  ok(windowSummary(ny('2027-04-23 21:00'), OPERATOR).reopened === null, 'but not once Shabbos has locked again');
  ok(windowSummary(ny('2026-10-10 12:30'), NYNY).reopened === null
    && windowSummary(ny('2026-10-10 12:30'), UNION).reopened === null, 'and New York at the unlock end never has one');
  const sch = new LockScheduler({ getConfig: () => OPERATOR, getState: () => ({ locked: false }), persist() {}, applyLock() {}, applyUnlock() {} });
  ok(sch.status(ny('2026-10-10 13:00')).window.reopened?.nyHolyUntil, 'the status the card reads carries it');
}

console.log('=== an unknown city is refused on save, and survived if hand-edited ===');
{
  ok(lockdownCityProblem({ candleCity: 'new-york', havdalahCity: 'jerusalem' }) === null, 'the two cities are accepted');
  ok(lockdownCityProblem({ enabled: true }) === null && lockdownCityProblem(undefined) === null, 'a save without them is not checked');
  for (const bad of ['tel-aviv', 'Jerusalem', '', null, ['jerusalem'], 7, {}]) {
    ok(typeof lockdownCityProblem({ havdalahCity: bad }) === 'string', `refused: ${JSON.stringify(bad)}`);
  }
  ok(/New York or Jerusalem/.test(lockdownCityProblem({ candleCity: 'london' })), 'the refusal names the two that exist');
  let blocks;
  try { blocks = lockBlocks(new Date('2026-09-22T12:00:00Z'), { ...base, candleCity: 'london', havdalahCity: 'tel-aviv' }); } catch { blocks = null; }
  ok(JSON.stringify(blocks) === JSON.stringify(lockBlocks(new Date('2026-09-22T12:00:00Z'), OPERATOR)),
    'a hand-edited unknown city falls back to that end\'s default instead of throwing');
}

console.log('=== the settings API: validation on save, and the preview ===');
{
  const spaces = new Map();
  const stateStore = { namespace(name) {
    if (!spaces.has(name)) spaces.set(name, {});
    const sp = spaces.get(name);
    return { get: (k, d) => sp[k] ?? d, set: (k, v) => { sp[k] = v; }, push: (k, v) => { (sp[k] ??= []).unshift(v); } };
  } };
  let cfg = mergeDefaults({
    web: { adminPasswordHash: 'x', users: [{ username: 'admin', role: 'superadmin', passwordHash: 'x' }] },
    lockdown: { enabled: true, alwaysLocked: ['g@g.us'] },
  });
  const merge = (a, b) => {
    for (const [k, v] of Object.entries(b)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) merge(a[k] ??= {}, v); else a[k] = v;
    }
    return a;
  };
  const configStore = {
    get: () => cfg,
    update: (patch) => { cfg = merge(JSON.parse(JSON.stringify(cfg)), patch); return cfg; },
    redacted: () => JSON.parse(JSON.stringify(cfg)),
    onChange: () => {},
  };
  const lockScheduler = new LockScheduler({ getConfig: () => configStore.get().lockdown,
    getState: () => ({ locked: false }), persist() {}, applyLock() {}, applyUnlock() {} });
  const queue = new JobQueue({ concurrency: 1 });
  queue.pause();
  const server = await new Promise((resolve) => {
    const ex = express();
    ex.use(express.json());
    ex.use((req, _res, next) => { req.session = { user: { username: 'mommy', role: 'superadmin' } }; next(); });
    ex.use('/api', createApiRouter({
      configStore, bot: { groupCache: new Map(), groups: () => [], on: () => {}, state: 'connected' },
      queue, linkQueue: queue, pluginManager: { notifyConfigChange: async () => {}, plugins: new Map() },
      stateStore, fileLogger: { tail: () => [] }, alerts: {}, lockScheduler,
    }));
    const s = ex.listen(0, '127.0.0.1', () => resolve(s));
  });
  const call = (method, path, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: server.address().port, method, path,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
    (res) => { let buf = ''; res.on('data', (c) => { buf += c; }); res.on('end', () => resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null })); });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
  try {
    let r = await call('PUT', '/api/config', { lockdown: { havdalahCity: 'tel-aviv', candleMinutes: 30 } });
    ok(r.status === 400 && /Havdalah can be measured in New York or Jerusalem/.test(r.json.error) && /Nothing was saved/.test(r.json.error),
      `an unknown havdalah city is refused: "${r.json.error}"`);
    ok(cfg.lockdown.havdalahCity === 'jerusalem' && cfg.lockdown.candleMinutes === 18, 'and nothing in that save was stored');
    const refusals = stateStore.namespace('audit').get('events', []).filter((e) => /^refused:/.test(e.action));
    ok(refusals.length === 1, 'the refusal is in the audit log');
    r = await call('PUT', '/api/config', { lockdown: { candleCity: ['new-york'] } });
    ok(r.status === 400, 'a list where a city belongs is refused too');

    r = await call('GET', '/api/lockdown/status');
    ok(r.status === 200 && r.json.window?.havdalahCity === 'jerusalem', 'status reports the saved cities');

    // Compared with the same choice computed here, at the same moment - not
    // with the saved window, whose next unlock is next week's from Saturday
    // midday to New York's havdalah, which made this fail every Saturday
    // afternoon in New York. Computed either side of the request, so a block
    // boundary between the two cannot fail it either.
    const choice = { ...cfg.lockdown, candleCity: 'new-york', havdalahCity: 'new-york' };
    const before = JSON.parse(JSON.stringify(windowSummary(new Date(), choice)));
    r = await call('GET', '/api/lockdown/preview?candleCity=new-york&havdalahCity=new-york');
    const after = JSON.parse(JSON.stringify(windowSummary(new Date(), choice)));
    const same = (w) => w.lockAt === r.json.lockAt && w.unlockAt === r.json.unlockAt && w.havdalahCity === r.json.havdalahCity;
    ok(r.status === 200 && r.json.havdalahCity === 'new-york' && !r.json.nyHolyUntil && (same(before) || same(after)),
      'the preview shows a choice before it is saved');
    ok(cfg.lockdown.havdalahCity === 'jerusalem', 'and saves nothing');
    r = await call('GET', '/api/lockdown/preview?havdalahCity=haifa');
    ok(r.status === 400, 'an unknown city in a preview is refused');

    // Found in review: the preview skipped an empty or negative box and showed
    // the SAVED minutes, while Save stored `+box` - 0 for an emptied box. A
    // havdalah of 0 is no havdalah at all to hebcal, so that save would have
    // stopped every lock. Now both refuse the same things with the same words.
    for (const [patch, want] of [
      [{ havdalahMinutes: null }, /Havdalah minutes must be a whole number from 1 to 120, not empty/],
      [{ havdalahMinutes: 0 }, /Havdalah minutes .* not 0/],
      [{ candleMinutes: -5 }, /Candle-lighting minutes .* from 0 to 120, not -5/],
      [{ candleMinutes: 18.5 }, /not 18\.5/],
      [{ candleMinutes: '18' }, /not "18"/],
      [{ havdalahMinutes: 1800 }, /not 1800/],
    ]) {
      r = await call('PUT', '/api/config', { lockdown: { enabled: true, ...patch } });
      ok(r.status === 400 && want.test(r.json.error) && /Nothing was saved/.test(r.json.error),
        `Save refuses ${JSON.stringify(patch)}: "${r.json.error}"`);
    }
    ok(cfg.lockdown.candleMinutes === 18 && cfg.lockdown.havdalahMinutes === 20, 'and stored none of them');
    const wordsFor = async (q) => (await call('GET', `/api/lockdown/preview?${q}`)).json?.error;
    const saveWords = (await call('PUT', '/api/config', { lockdown: { havdalahMinutes: null } })).json.error;
    const previewWords = await wordsFor('havdalahMinutes=');
    ok(previewWords && saveWords.startsWith(previewWords),
      `an empty box is refused by the preview in the same words as by Save ("${previewWords}")`);
    ok(/not -5/.test(await wordsFor('candleMinutes=-5')) && /not "abc"/.test(await wordsFor('candleMinutes=abc')),
      'and so are -5 and text, rather than silently previewing the saved minutes');
    r = await call('GET', '/api/lockdown/preview?candleMinutes=0&havdalahMinutes=72');
    ok(r.status === 200, '0 minutes before sunset and 72 after are fine');
    r = await call('PUT', '/api/config', { lockdown: { candleMinutes: 22, havdalahMinutes: 42 } });
    ok(r.status === 200 && cfg.lockdown.candleMinutes === 22 && cfg.lockdown.havdalahMinutes === 42, 'and real minutes save');
    await call('PUT', '/api/config', { lockdown: { candleMinutes: 18, havdalahMinutes: 20 } });

    r = await call('PUT', '/api/config', { lockdown: { candleCity: 'jerusalem', havdalahCity: 'new-york' } });
    ok(r.status === 200 && cfg.lockdown.candleCity === 'jerusalem' && cfg.lockdown.havdalahCity === 'new-york', 'the two real cities save');
    r = await call('GET', '/api/lockdown/status');
    ok(r.json.window.candleCity === 'jerusalem' && r.json.window.cities.candle.name === 'Jerusalem',
      'and the schedule follows the saved setting');
  } finally {
    server.close();
  }
}

console.log('=== the panel says which city each end is in ===');
{
  const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
  const start = app.indexOf('/* ------------------------- lockdown cities');
  const end = app.indexOf('/* ----------------------- end lockdown cities');
  ok(start > 0 && end > start, 'the hint code is where the test expects it');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // eslint-disable-next-line no-new-func
  // The panel's 24-hour clock helpers, which the lifted code calls.
  const clock = [/const CLOCK_24 = .*;/, /const HM = .*;/, /function fmtDateTime\([\s\S]*?\n\}/, /function fmtClock\([\s\S]*?\n\}/]
    .map((re) => app.match(re)[0]).join('\n');
  const { lockWindowHint } = new Function('esc', `${clock}\n${app.slice(start, end)}\nreturn { lockWindowHint };`)(esc);
  const text = (h) => h.replace(/<[^>]+>/g, '');
  const json = (v) => JSON.parse(JSON.stringify(v));   // what the browser gets

  const w = json(windowSummary(new Date('2026-09-22T12:00:00Z'), OPERATOR));
  const hint = text(lockWindowHint(w));
  ok(hint.includes('Fri, Sep 25, 18:30 New York') && hint.includes('Sat, Sep 26, 01:30 Jerusalem'),
    `the next lock, in both cities: "${hint.split('→')[0].trim()}"`);
  ok(hint.includes('Sat, Sep 26, 11:51 New York') && hint.includes('Sat, Sep 26, 18:51 Jerusalem'), 'and the unlock');
  ok(/still Shabbos \/ yom tov in New York, which ends there Sun, Sep 27, 19:05/.test(hint),
    'with a note that New York is still in yom tov when the groups open');
  const nyny = text(lockWindowHint(json(windowSummary(new Date('2026-09-22T12:00:00Z'), NYNY))));
  ok(!/still Shabbos/.test(nyny) && nyny.includes('Sun, Sep 27, 19:05 New York'), 'New York at both ends: no note');
  ok(text(lockWindowHint(w, { unsaved: true })).startsWith('If saved:'), 'an unsaved choice is marked as such');

  // Saturday 12:30 PM New York this week: open, and still Sukkos there.
  const sat = text(lockWindowHint(json(windowSummary(ny('2026-09-26 12:30'), OPERATOR))));
  ok(/^ⓘ The groups reopened Sat, Sep 26, 11:51 New York while it is still Shabbos \/ yom tov there, until Sun, Sep 27, 19:05\./.test(sat),
    `while it is happening, the hint says so first: "${sat.split('.')[0]}."`);
  ok(sat.includes('Next lock Fri, Oct 2, 18:18 New York'), 'and then gives next week\'s times');
  ok(!/reopened/.test(text(lockWindowHint(json(windowSummary(ny('2026-09-26 12:30'), OPERATOR)), { unsaved: true }))),
    'but not for a choice that is not saved - that past never happened');
  ok(!/reopened/.test(text(lockWindowHint(json(windowSummary(ny('2026-09-27 19:10'), OPERATOR))))), 'and not after New York\'s havdalah');

  const sel = (id) => (html.match(new RegExp(`<select id="${id}">([\\s\\S]*?)</select>`))?.[1] ?? '');
  const opts = (id) => [...sel(id).matchAll(/value="([^"]+)"/g)].map((m) => m[1]).join();
  ok(opts('f-lock-candle-city') === 'new-york,jerusalem' && opts('f-lock-havdalah-city') === 'new-york,jerusalem',
    'two pickers on the card, each offering New York and Jerusalem');
  const why = app.match(/id: 'lockdown'[\s\S]*?why: '([^']*)'/)?.[1] ?? '';
  ok(!/both measured in New York/.test(html) && why && !/New York/.test(why),
    `nothing still claims both ends are New York: "${why}"`);
  ok(/candleCity: \$\('f-lock-candle-city'\)\.value/.test(app) && /havdalahCity: \$\('f-lock-havdalah-city'\)\.value/.test(app),
    'the form reads both pickers');
  // Save and the preview read the card through ONE function, so "If saved:"
  // is computed from exactly what Save would send - see the header.
  const saveHandler = app.slice(app.indexOf("$('lock-save')?.addEventListener"), app.indexOf('function renderMxGroups'));
  const preview = app.slice(app.indexOf('async function previewLockWindow'), app.indexOf("for (const id of ['f-lock-candle-city'"));
  ok(/\.\.\.lockFormValues\(\)/.test(saveHandler) && !/f-lock-candle'\)\.value/.test(saveHandler),
    'Save sends lockFormValues(), not its own reading of the boxes');
  ok(/const want = lockFormValues\(\)/.test(preview), 'and the preview asks about the same values');
  ok(!/\+\$\('f-lock-(candle|havdalah)'\)\.value/.test(app), 'no `+box` left to turn an empty box into 0');
  // Rosh Hashana is two days in Jerusalem as well, and the card said "one".
  const cardHint = html.match(/<p class="hint">Each end follows[\s\S]*?<\/p>/)?.[0] ?? '';
  ok(/Rosh Hashana, which is two there too/.test(cardHint), 'the card does not claim Jerusalem keeps one day of Rosh Hashana');
}

console.log('\n' + '='.repeat(46) + '\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
