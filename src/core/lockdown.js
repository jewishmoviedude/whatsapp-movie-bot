import { HebrewCalendar, Location, Zmanim, CandleLightingEvent, HavdalahEvent, flags } from '@hebcal/core';
import log from '../util/logger.js';

const logger = log.scope('lockdown');

// Which city each end of the window is measured in - and why the default is
// a window that a careful reader will want to "fix". Please do not, without
// asking the operator first.
//
// Until 10 September 2026 the window locked at New York candle-lighting and
// unlocked at JERUSALEM havdalah. Commit a1255f2 moved both ends to New York,
// on the reasoning that this covered neither community: by the time New York
// lit candles Israel had been in Shabbos seven hours with the groups open, and
// the unlock landed around noon on Saturday in New York with seven hours of
// Shabbos still to run. It read as a window "bracketing" the two, but it was
// their intersection, not their union. That reasoning is accurate, and it is
// still exactly what the mixed window does.
//
// On 22 September 2026 the operator chose the mixed window again, on purpose:
// lock at candle-lighting in New York (candleMinutes before New York sunset),
// unlock at havdalah in Jerusalem (havdalahMinutes after Jerusalem sunset),
// with the Jerusalem end on the Israeli calendar - one day of yom tov (Rosh
// Hashana is two days there too, and the code gets that from hebcal). He was
// shown what that means before he confirmed it: the groups reopen on Saturday
// at about 11:30 AM-12:00 PM New York time, and for Shabbos + Sukkos 2026 the
// lock runs Fri 25 Sep 6:30 PM to Sat 26 Sep 11:51 AM New York (6:51 PM in
// Jerusalem), leaving New York's second day of yom tov open. He accepted that.
//
// So both facts stand: the mixed window really is the intersection, and it is
// the operator's explicit choice. Each end is a setting (lockdown.candleCity
// and lockdown.havdalahCity, on the Groups tab), so if it ever needs to change
// he can change it himself - and a future session that thinks it is wrong
// should raise it with him, not quietly move both ends back to New York.
//
// Jerusalem is built WITHOUT hebcal's Israel flag (and without the IL country
// code, which sets the flag too), and the Israeli calendar is asked for with
// `il: true` instead. hebcal treats 18 minutes as "not set" at an Israeli
// location and silently substitutes the local custom - 40 minutes before
// sunset in Jerusalem - so with the flag on, "18 min before sunset" on the
// panel would have meant 40 there, and 19 would have meant 19. The flag drives
// only that substitution; `il` is what picks the Israeli yom tov schedule. The
// minutes the panel shows are the minutes used, in either city.
export const CITIES = Object.freeze({
  'new-york': Object.freeze({
    key: 'new-york', name: 'New York', tz: 'America/New_York', il: false,
    location: new Location(40.7128, -74.0060, false, 'America/New_York', 'New York', 'US'),
  }),
  jerusalem: Object.freeze({
    key: 'jerusalem', name: 'Jerusalem', tz: 'Asia/Jerusalem', il: true,
    // Location.lookup('Jerusalem')'s own coordinates.
    location: new Location(31.76904, 35.21633, false, 'Asia/Jerusalem', 'Jerusalem'),
  }),
});
const NEW_YORK = CITIES['new-york'];

/** The operator's choice of 2026-09-22 - see above. Mirrored in schema.js. */
export const DEFAULT_CANDLE_CITY = 'new-york';
export const DEFAULT_HAVDALAH_CITY = 'jerusalem';

// Enough history to still recognise a window that began before the process
// started, and enough future to always have the next one - a Pesach block runs
// four days, and blocks can be a month apart.
const LOOK_BACK_DAYS = 5;
const LOOK_AHEAD_DAYS = 40;

// When the two ends are in different cities, both calendars are read a few
// days past the look-ahead so that a lock near the end still finds its
// havdalah instead of tripping the guard below.
const SPILL_DAYS = 4;

// The longest block that can be real. One city's longest run is about 73
// hours (Pesach 2027 in New York: Wednesday evening to Saturday night), and
// the two cities' evenings are about seven hours apart, so a Jerusalem-lock /
// New-York-unlock block over that Pesach is about 80 hours. A havdalah further
// away than this is not the end of this block - it is a missing one, and the
// next Shabbos's havdalah would otherwise keep the groups shut for a week.
const MAX_BLOCK_HOURS = 84;

/**
 * Why a lockdown settings patch must not be saved, or null if it may.
 *
 * This checks the two city keys (lockdownMinutesProblem the minutes, and
 * lockdownSettingsProblem both). lockBlocks() does fall back to the
 * default for a city it does not know, but a typo that is saved silently is a
 * window nobody chose - so the save is refused with the reason instead.
 */
export function lockdownCityProblem(patch) {
  if (!patch || typeof patch !== 'object') return null;
  const allowed = Object.values(CITIES).map((c) => c.name).join(' or ');
  for (const [k, end] of [['candleCity', 'Candle-lighting'], ['havdalahCity', 'Havdalah']]) {
    if (!Object.hasOwn(patch, k)) continue;
    const v = patch[k];
    // typeof first: Object.hasOwn(CITIES, ['jerusalem']) is true, because the
    // list is turned into the string "jerusalem" on the way in.
    if (typeof v !== 'string' || !Object.hasOwn(CITIES, v)) {
      return `${end} can be measured in ${allowed} (${Object.keys(CITIES).map((c) => `"${c}"`).join(' or ')}), not ${JSON.stringify(v)}`;
    }
  }
  return null;
}

// The minutes on the card, as a save or a preview carries them.
//
// Checked since the card's "If saved:" preview was found to disagree with what
// Save stored: the preview skipped an empty or negative box and showed the
// saved minutes, while Save sent `+box`, so an emptied box was stored as 0 and
// -5 as -5. Neither is harmless. hebcal reads a havdalah of 0 as "no havdalah
// at all" (options.havdalahMins=0 suppresses it), which leaves every block
// without an end, so nothing would ever lock; and it truncates fractions and
// drops the sign, while the Shabbos-only path uses the number as given, so -5
// or 18.5 would mean one thing with yom tov on and another with it off. The
// ceiling is not a custom - the longest anyone keeps is 72 minutes - it is
// there so that one stray extra digit cannot move a lock by hours.
const MINUTES = Object.freeze({
  candleMinutes: { what: 'Candle-lighting', min: 0, max: 120 },
  havdalahMinutes: { what: 'Havdalah', min: 1, max: 120 },
});

/**
 * Why a lockdown settings patch's minutes must not be saved (or previewed), or
 * null if they may. Only keys present in the patch are checked.
 */
export function lockdownMinutesProblem(patch) {
  if (!patch || typeof patch !== 'object') return null;
  for (const [k, { what, min, max }] of Object.entries(MINUTES)) {
    if (!Object.hasOwn(patch, k)) continue;
    const v = patch[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      const shown = v === null || v === undefined || v === '' ? 'empty'
        : typeof v === 'number' && !Number.isFinite(v) ? String(v) : JSON.stringify(v);
      return `${what} minutes must be a whole number from ${min} to ${max}, not ${shown}`;
    }
  }
  return null;
}

/** Everything a lockdown settings patch can get wrong, or null. */
export function lockdownSettingsProblem(patch) {
  return lockdownCityProblem(patch) ?? lockdownMinutesProblem(patch);
}

// lockBlocks runs every minute from the scheduler, so a warning about the same
// thing is written once per process rather than 1,440 times a day.
const warned = new Set();
function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn(message);
}

function cityFor(key, fallback, end) {
  if (typeof key === 'string' && Object.hasOwn(CITIES, key)) return CITIES[key];
  warnOnce(`city:${end}:${key}`, `lockdown ${end} city ${JSON.stringify(key)} is not one of `
    + `${Object.keys(CITIES).join(', ')} - using ${CITIES[fallback].name}, the default`);
  return CITIES[fallback];
}

/** The two cities a lockdown config resolves to, as the panel should show them. */
export function lockCities(cfg = {}) {
  const pick = (c) => ({ key: c.key, name: c.name, tz: c.tz });
  return {
    candle: pick(cityFor(cfg.candleCity ?? DEFAULT_CANDLE_CITY, DEFAULT_CANDLE_CITY, 'candle-lighting')),
    havdalah: pick(cityFor(cfg.havdalahCity ?? DEFAULT_HAVDALAH_CITY, DEFAULT_HAVDALAH_CITY, 'havdalah')),
  };
}

/**
 * Every locked block in the range, in order.
 *
 * A "block" is one continuous stretch with no permitted posting: it opens at
 * candle-lighting and closes at havdalah. Crucially that is NOT one block per
 * day. Yom tov runs two days in the diaspora, and when it falls next to Shabbos
 * the whole run is continuous - there is no havdalah in the middle of it. In
 * New York, in the coming year, almost every yom tov does exactly that:
 *
 *   Rosh Hashana 2026   Fri 11 Sep -> Sun 13 Sep    3 days
 *   Sukkos I-II         Fri 25 Sep -> Sun 27 Sep    3 days
 *   Shmini Atzeres/ST   Fri  2 Oct -> Sun  4 Oct    3 days
 *   Pesach I-II         Wed 21 Apr -> Sat 24 Apr    4 days  (yom tov into Shabbos)
 *   Shavuos             Thu 10 Jun -> Sat 12 Jun    3 days
 *
 * Rather than work that out here, we read it off the calendar: hebcal emits a
 * candle-lighting for each night but only ONE havdalah, at the end of the whole
 * run. So in one city a block is "from the first candle-lighting until the next
 * havdalah", and the merging falls out for free - including the four-day
 * Pesach case, which no amount of "find the Friday" logic would ever have got
 * right. With both ends in the same city that is all there is to it, and New
 * York at both ends gives exactly what it always has.
 *
 * With the ends in different cities (see the top of this file), each end comes
 * from its own city's calendar - Jerusalem's the Israeli one, with one day of
 * yom tov except Rosh Hashana - and mixedBlocks() pairs them up.
 *
 * Only CandleLightingEvent and HavdalahEvent count. Chanukah candles and fast
 * start/end times are also timed events on this calendar, and they must never
 * open a lock.
 */
export function lockBlocks(now = new Date(), {
  candleMinutes = 18, havdalahMinutes = 20, yomTov = true,
  candleCity = DEFAULT_CANDLE_CITY, havdalahCity = DEFAULT_HAVDALAH_CITY,
} = {}) {
  const candle = cityFor(candleCity, DEFAULT_CANDLE_CITY, 'candle-lighting');
  const havdalah = cityFor(havdalahCity, DEFAULT_HAVDALAH_CITY, 'havdalah');
  const mins = { candleMinutes, havdalahMinutes };

  // With yom tov off, compute Shabbos directly rather than filtering it out of
  // the calendar. Filtering looks equivalent and is not: when yom tov falls
  // beside Shabbos the two are ONE block, so dropping the yom tov blocks drops
  // those Shabbosos with them - Shabbos 12 Sep and 26 Sep 2026 would simply
  // never lock, which is worse than not having the feature.
  if (!yomTov) return shabbosOnlyBlocks(now, mins, candle, havdalah);

  const start = new Date(now); start.setDate(start.getDate() - LOOK_BACK_DAYS);
  const end = new Date(now); end.setDate(end.getDate() + LOOK_AHEAD_DAYS);

  if (candle === havdalah) {
    let cal;
    try {
      cal = readCalendar(candle, start, end, mins);
    } catch (err) {
      logger.warn(`hebcal failed (${err.message}) - falling back to Shabbos only`);
      return shabbosOnlyBlocks(now, mins, candle, havdalah);
    }
    const blocks = runsOf(cal).map((r) => ({
      lockAt: r.lockAt,
      unlockAt: r.unlockAt,
      key: r.lockAt.toISOString(),
      label: describeBlock(r.names, r.lockAt, r.unlockAt),
      yomTov: r.names.length > 0,
    }));
    // New York at both ends never opens early in New York, so it carries no
    // note at all - and its output stays byte-for-byte what it was.
    if (candle !== NEW_YORK) noteNewYorkStillHoly(blocks, () => readCalendar(NEW_YORK, start, spill(end), mins));
    return blocks;
  }

  let cCal, hCal;
  try {
    cCal = readCalendar(candle, start, spill(end), mins);
    hCal = readCalendar(havdalah, start, spill(end), mins);
  } catch (err) {
    logger.warn(`hebcal failed (${err.message}) - falling back to Shabbos only`);
    return shabbosOnlyBlocks(now, mins, candle, havdalah);
  }
  const blocks = mixedBlocks(cCal, hCal, end);
  noteNewYorkStillHoly(blocks, () => (candle === NEW_YORK ? cCal
    : havdalah === NEW_YORK ? hCal : readCalendar(NEW_YORK, start, spill(end), mins)));
  return blocks;
}

const spill = (d) => { const n = new Date(d); n.setDate(n.getDate() + SPILL_DAYS); return n; };

/** One city's calendar: its candle-lightings and havdalahs, and its yom tov days by date. */
function readCalendar(city, start, end, { candleMinutes, havdalahMinutes }) {
  const events = HebrewCalendar.calendar({
    start, end,
    location: city.location,
    candlelighting: true,
    candleLightingMins: candleMinutes,
    havdalahMins: havdalahMinutes,
    il: city.il,              // New York: two days of yom tov. Jerusalem: one, but two of Rosh Hashana.
    sedrot: false, omer: false, noMinorFast: true, noSpecialShabbat: true,
    noModern: true, noRoshChodesh: true,
  });

  // Holiday names, so the panel can say WHY the groups are locked. All-day
  // events, keyed by date.
  const chagByDay = new Map();
  for (const e of events) {
    if (e.eventTime) continue;
    if (!(e.getFlags() & flags.CHAG)) continue;
    chagByDay.set(dayKey(e.getDate().greg()), e.getDesc());
  }

  const timed = events
    .filter((e) => e.eventTime && (e instanceof CandleLightingEvent || e instanceof HavdalahEvent))
    .sort((a, b) => a.eventTime - b.eventTime);
  return { city, chagByDay, timed };
}

/** Continuous runs in one city: first candle-lighting to the next havdalah. */
function runsOf({ chagByDay, timed }) {
  const runs = [];
  let open = null;
  for (const e of timed) {
    if (e instanceof CandleLightingEvent) {
      // Mid-block lightings are the second night of yom tov, not a new block.
      if (!open) open = { lockAt: e.eventTime, first: e, names: [] };
      const name = chagByDay.get(dayKey(nextDay(e.eventTime)));
      if (name && !open.names.includes(name)) open.names.push(name);
    } else if (open) {
      runs.push({ ...open, unlockAt: e.eventTime });
      open = null;
    }
  }
  return runs;
}

/**
 * Blocks with the lock measured in one city and the unlock in another.
 *
 * A lock starts on every evening that begins a run in EITHER city, at the
 * candle city's candle-lighting that evening. Starting only where the candle
 * city's runs start is not enough: in New York, Pesach 2027 is one run from
 * Wednesday night to Saturday night, while in Jerusalem yom tov ends on
 * Thursday night and Shabbos is a run of its own. With the unlock at
 * Jerusalem's havdalah on Thursday, New York's run has no other start, and
 * Shabbos 24 April would never have locked at all. Later lightings inside a
 * run in both cities (the second night of yom tov) are still not starts,
 * which is what leaves New York's second day open.
 *
 * Each lock unlocks at the havdalah city's first havdalah after it. Two locks
 * that reach the same havdalah are one block - with the lock in Jerusalem and
 * the unlock in New York, Pesach 2027's Wednesday and Friday locks both run to
 * New York's Saturday night - and blocks are merged rather than ever allowed
 * to overlap.
 */
function mixedBlocks(cCal, hCal, cutoff) {
  const candle = cCal.city;
  const havdalah = hCal.city;
  const lightingOn = new Map();
  for (const e of cCal.timed) if (e instanceof CandleLightingEvent) lightingOn.set(dayKey(e.getDate().greg()), e);
  // Candidates are taken up to the normal look-ahead; the spill beyond it is
  // only there so the last of them can find their havdalah.
  const last = new Date(cutoff); last.setDate(last.getDate() + 1);

  const starts = new Map();
  const addStart = (lockAt, why = null) => {
    if (lockAt < last && !starts.has(+lockAt)) starts.set(+lockAt, { lockAt, why });
  };
  for (const r of runsOf(cCal)) {
    if (beginsOnOrdinaryDay(r.first, cCal)) addStart(r.lockAt);
  }
  for (const r of runsOf(hCal)) {
    if (!beginsOnOrdinaryDay(r.first, hCal)) continue;
    const e = lightingOn.get(dayKey(r.first.getDate().greg()));
    if (e) { addStart(e.eventTime); continue; }
    // Never seen: every evening that starts a run in one of these two cities
    // has a candle-lighting in the other. If it happens, locking at the other
    // city's own lighting is late, but better than not locking at all.
    const why = `no ${candle.name} candle-lighting that evening - locked at ${havdalah.name}'s instead`;
    warnOnce(`nolight:${r.lockAt.toISOString()}`, `lockdown block ${r.lockAt.toISOString()}: ${why}`);
    addStart(r.lockAt, why);
  }

  const hEnds = hCal.timed.filter((e) => e instanceof HavdalahEvent).map((e) => e.eventTime);
  const cEnds = cCal.timed.filter((e) => e instanceof HavdalahEvent).map((e) => e.eventTime);

  const spans = [];
  for (const s of [...starts.values()].sort((a, b) => a.lockAt - b.lockAt)) {
    let unlockAt = hEnds.find((t) => t > s.lockAt);
    let fallback = s.why;
    if (!unlockAt || unlockAt - s.lockAt > MAX_BLOCK_HOURS * 3600000) {
      const why = unlockAt
        ? `the next ${havdalah.name} havdalah is ${Math.round((unlockAt - s.lockAt) / 3600000)}h after the lock`
        : `no ${havdalah.name} havdalah after the lock`;
      unlockAt = cEnds.find((t) => t > s.lockAt);
      if (!unlockAt) {
        warnOnce(`noend:${s.lockAt.toISOString()}`, `lockdown block ${s.lockAt.toISOString()}: ${why}, `
          + `and no ${candle.name} havdalah either - left out`);
        continue;
      }
      fallback = `${why} - unlocking at ${candle.name}'s own havdalah instead`;
      warnOnce(`fallback:${s.lockAt.toISOString()}`, `lockdown block ${s.lockAt.toISOString()}: ${fallback}`);
    }
    const prev = spans.at(-1);
    if (prev && s.lockAt < prev.unlockAt) {
      if (unlockAt > prev.unlockAt) prev.unlockAt = unlockAt;
      prev.fallback ??= fallback;
      continue;
    }
    spans.push({ lockAt: s.lockAt, unlockAt, fallback });
  }

  // Name each block from the lightings inside it, in both cities, by the day
  // each one lights for - the event's own date, not the UTC date of the
  // instant, which for a summer evening in New York is already tomorrow.
  const lit = [...cCal.timed.map((e) => [e, cCal]), ...hCal.timed.map((e) => [e, hCal])]
    .filter(([e]) => e instanceof CandleLightingEvent)
    .sort(([a], [b]) => a.eventTime - b.eventTime);
  return spans.map(({ lockAt, unlockAt, fallback }) => {
    const names = [];
    let shabbos = false;
    for (const [e, cal] of lit) {
      if (e.eventTime < lockAt || e.eventTime >= unlockAt) continue;
      const day = nextDay(e.getDate().greg());
      if (day.getDay() === 6) shabbos = true;
      const name = cal.chagByDay.get(dayKey(day));
      if (name && !names.includes(name)) names.push(name);
    }
    const block = {
      lockAt, unlockAt,
      key: lockAt.toISOString(),
      label: describeBlock(names, lockAt, unlockAt, shabbos),
      yomTov: names.length > 0,
    };
    if (fallback) block.fallback = fallback;
    return block;
  });
}

/**
 * A run starts on an ordinary evening. A lighting on Shabbos or yom tov itself
 * is the second night of something already running, and only looks like a
 * start when the calendar was cut off in the middle of that run.
 */
function beginsOnOrdinaryDay(e, cal) {
  const day = e.getDate().greg();
  return day.getDay() !== 6 && !cal.chagByDay.has(dayKey(day));
}

/**
 * Mark each block that opens the groups while it is still Shabbos or yom tov
 * in New York, with when New York's ends. The operator accepted this; the
 * panel shows it so the consequence is never a surprise. Informational only.
 */
function noteNewYorkStillHoly(blocks, nyCalendar) {
  let runs;
  try {
    runs = runsOf(nyCalendar());
  } catch (err) {
    warnOnce(`nycal:${err.message}`, `could not read the New York calendar for the panel note (${err.message})`);
    return;
  }
  for (const b of blocks) {
    const r = runs.find((x) => x.lockAt <= b.unlockAt && b.unlockAt < x.unlockAt);
    if (r) b.nyHolyUntil = r.unlockAt;
  }
}

const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const nextDay = (d) => { const n = new Date(d); n.setDate(n.getDate() + 1); return n; };

// hebcal transliterates Sephardi; this community says it the Ashkenazi way, and
// a label is only useful if it reads like the thing people call it.
const SAY_IT = {
  Sukkot: 'Sukkos',
  'Shmini Atzeret': 'Shmini Atzeres',
  'Simchat Torah': 'Simchas Torah',
  Shavuot: 'Shavuos',
  'Rosh Hashana': 'Rosh Hashana',
  'Yom Kippur': 'Yom Kippur',
  Pesach: 'Pesach',
};

/**
 * "Shabbos", "Rosh Hashana + Shabbos", "Shmini Atzeres / Simchas Torah".
 *
 * `shabbos` is passed for blocks whose ends are in different cities: those can
 * run from Friday evening to Saturday midday in New York, and stepping a day at
 * a time from the lock never lands on a Saturday. Same-city blocks keep the
 * original test, so their labels are unchanged.
 */
function describeBlock(names, lockAt, unlockAt, shabbos) {
  // A block spanning a Saturday includes Shabbos, whatever else it is.
  let hasShabbos = !!shabbos;
  if (shabbos === undefined) {
    for (let d = new Date(lockAt); d <= unlockAt; d.setDate(d.getDate() + 1)) {
      if (d.getDay() === 6) { hasShabbos = true; break; }
    }
  }
  // "Pesach I" / "Pesach II" both read as Pesach; collapse to the festival.
  const festivals = [...new Set(names.map((n) => {
    const bare = n
      .replace(/\s+(I{1,3}|IV|VI{0,3}|VIII)$/, '')
      .replace(/\s+\d{4}$/, '')
      .replace(/\s+\(CH''M\)$/, '')
      .trim();
    return SAY_IT[bare] ?? bare;
  }))];

  if (!festivals.length) return 'Shabbos';
  // Shmini Atzeres and Simchas Torah are one run of two days, not two events
  // that happen to collide - a slash reads better than an ampersand there.
  const yt = festivals.join(' / ');
  return hasShabbos ? `${yt} + Shabbos` : yt;
}

/**
 * Shabbos alone, for when yom tov is switched off or hebcal is unavailable:
 * the candle city's Friday sunset less candleMinutes, to the havdalah city's
 * Saturday sunset plus havdalahMinutes.
 */
function shabbosOnlyBlocks(now, { candleMinutes, havdalahMinutes }, candle = NEW_YORK, havdalah = NEW_YORK) {
  const out = [];
  for (let add = -LOOK_BACK_DAYS; add <= LOOK_AHEAD_DAYS; add++) {
    const day = new Date(now);
    day.setDate(day.getDate() + add);
    if (day.getDay() !== 5) continue;                   // Fridays only
    const sat = new Date(day); sat.setDate(sat.getDate() + 1);
    const lockAt = new Date(new Zmanim(candle.location, day, false).sunset().getTime() - candleMinutes * 60000);
    const unlockAt = new Date(new Zmanim(havdalah.location, sat, false).sunset().getTime() + havdalahMinutes * 60000);
    const block = { lockAt, unlockAt, key: lockAt.toISOString(), label: 'Shabbos', yomTov: false };
    // Same note as the calendar path. New York at both ends never needs it,
    // and leaving the key off keeps that output exactly as it was.
    if (candle !== NEW_YORK || havdalah !== NEW_YORK) {
      const nyEnd = new Date(new Zmanim(NEW_YORK.location, sat, false).sunset().getTime() + havdalahMinutes * 60000);
      if (unlockAt < nyEnd) block.nyHolyUntil = nyEnd;
    }
    out.push(block);
  }
  return out;
}

/**
 * The lock window in progress or next upcoming, relative to `now`.
 * Returns { lockAt, unlockAt, key, label, yomTov } or null - plus nyHolyUntil
 * when it opens during Shabbos or yom tov in New York, and fallback when the
 * guard in mixedBlocks() had to step in.
 */
export function lockWindow(now = new Date(), cfg = {}) {
  const blocks = lockBlocks(now, cfg);
  for (const b of blocks) {
    if (now.getTime() < b.unlockAt.getTime()) return b;
  }
  return null;
}

/**
 * Kept under its old name because that is what it has always been called from
 * the scheduler and the tests, and because most of these windows still are
 * Shabbos. It is no longer only Shabbos.
 */
export const shabbosWindow = lockWindow;

/** Is `now` inside the given window? */
export function isWithin(now, win) {
  return !!win && now.getTime() >= win.lockAt.getTime() && now.getTime() < win.unlockAt.getTime();
}

/**
 * What the panel needs to show a config's next window: when it locks and
 * unlocks, in which cities, and whether that opens the groups while New York
 * is still in Shabbos or yom tov. Used for the saved settings (status) and
 * for the ones on screen before they are saved (GET /lockdown/preview).
 *
 * `reopened` is the window that has just ended while New York is still in
 * Shabbos or yom tov - Saturday midday to New York's havdalah, with the
 * default cities. Without it the card moved straight on to next week's block
 * the moment the groups opened, and during the hours the New York note is
 * about, nothing on the card said it was still Shabbos there: only next
 * week's note showed. It is null while a window is in progress.
 */
export function windowSummary(now = new Date(), cfg = {}, blocks = lockBlocks(now, cfg)) {
  const win = blocks.find((b) => now.getTime() < b.unlockAt.getTime()) ?? null;
  const cities = lockCities(cfg);
  const inWindow = isWithin(now, win);
  const ended = inWindow ? null : blocks.findLast((b) => b.unlockAt.getTime() <= now.getTime());
  const reopened = ended?.nyHolyUntil && now.getTime() < ended.nyHolyUntil.getTime()
    ? { unlockAt: ended.unlockAt, nyHolyUntil: ended.nyHolyUntil, label: ended.label, yomTov: ended.yomTov }
    : null;
  return {
    candleCity: cities.candle.key,
    havdalahCity: cities.havdalah.key,
    cities,
    lockAt: win?.lockAt ?? null,
    unlockAt: win?.unlockAt ?? null,
    inWindow,
    label: win?.label ?? null,
    yomTov: win?.yomTov ?? false,
    nyHolyUntil: win?.nyHolyUntil ?? null,
    fallback: win?.fallback ?? null,
    reopened,
  };
}

/**
 * Pure decision: given the current lock state and time, what should happen?
 * Returns 'lock' | 'unlock' | null. Respects a per-window manual override so
 * the schedule never fights an admin who deliberately unlocked this one.
 */
export function decide(now, cfg, state) {
  if (!cfg.enabled) return null;
  const win = lockWindow(now, cfg);
  const inWindow = isWithin(now, win);

  if (inWindow) {
    if (state.overriddenWindowKey === win.key) return null;   // admin unlocked this one
    if (!state.locked) return 'lock';
    return null;
  }
  // Outside any window: undo only schedule-driven locks, leave manual ones.
  if (state.locked && state.source === 'schedule') return 'unlock';
  return null;
}

/**
 * Why the schedule must not lock the groups now, or null if it may.
 *
 * Havdalah opens every group but the always-locked ones (_runLockdown in
 * bot.js), so a schedule that locked with that list empty would open the
 * posts group, and every other group that is admins-only for good, to all
 * its members on the first Motzei Shabbos. The lockdown is on by default
 * since the operator's live settings became the defaults (2026-10-12:
 * "please set these in the repo coding as default"), so on a new install it
 * is on before anybody has looked at that list, and there the schedule waits
 * - locking nothing, and so opening nothing - until somebody has: a group is
 * ticked as always-locked (Groups -> Sync from WhatsApp finds them), or the
 * lockdown card is saved as it is, which says that none of this install's
 * groups is admins-only for good (alwaysLockedReviewed, set by PUT /config).
 *
 * Only that is held. It first held every install with nothing always-locked,
 * and a review found what that broke: an install that had switched the
 * lockdown on itself, before it was the default, with groups that are all
 * normally open - and so nothing to tick - was no longer locked over Shabbos,
 * with only an info line and a note on the card to say so, and no way back
 * but ticking a group that would then stay shut for good. Such a config.json
 * counts as looked at when it is loaded (keepSavedChoices in
 * src/config/store.js), and it locks and opens every group as it always did.
 * Only the lock waits: a lock the schedule already made is still undone at
 * havdalah, and a lock or unlock by hand is the admin's own call.
 */
export function scheduleHeld(cfg = {}) {
  if (!cfg?.enabled) return null;
  if ((cfg.alwaysLocked ?? []).length) return null;
  return cfg.alwaysLockedReviewed === true ? null : 'no-always-locked';
}

/**
 * Drives lock/unlock on a timer. `applyLock`/`applyUnlock` do the WhatsApp work;
 * `persist` saves state so a restart resumes correctly.
 */
export class LockScheduler {
  constructor({ getConfig, getState, persist, applyLock, applyUnlock }) {
    this.getConfig = getConfig;
    this.getState = getState;
    this.persist = persist;
    this.applyLock = applyLock;
    this.applyUnlock = applyUnlock;
    this.timer = null;
    this.busy = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((e) => logger.warn(`tick: ${e.message}`)), 60_000);
    this.timer.unref?.();
    this.tick().catch(() => {});
  }
  stop() { clearInterval(this.timer); this.timer = null; }

  status(now = new Date()) {
    const cfg = this.getConfig();
    const blocks = lockBlocks(now, cfg);
    const win = windowSummary(now, cfg, blocks);
    const st = this.getState();
    return {
      enabled: !!cfg.enabled,
      // Why the schedule is waiting rather than locking (scheduleHeld).
      held: scheduleHeld(cfg),
      locked: !!st.locked,
      source: st.source ?? null,
      nextLockAt: win.lockAt,
      nextUnlockAt: win.unlockAt,
      inWindow: win.inWindow,
      // What this window is FOR, and the few after it. A four-day Pesach lock
      // looks like a bug unless the panel says what it is.
      label: win.label,
      // Which city each end is measured in, and whether this window opens the
      // groups while New York is still in Shabbos or yom tov.
      window: win,
      // In progress or still to come. The look-back used to put last week's
      // Shabbos at the top of "Coming up".
      upcoming: blocks.filter((b) => now.getTime() < b.unlockAt.getTime()).slice(0, 6).map((b) => ({
        lockAt: b.lockAt, unlockAt: b.unlockAt, label: b.label, yomTov: b.yomTov,
        nyHolyUntil: b.nyHolyUntil ?? null,
      })),
    };
  }

  async tick(now = new Date()) {
    if (this.busy) return;
    const cfg = this.getConfig();
    const state = this.getState();
    const action = decide(now, cfg, state);
    if (!action) return;
    if (action === 'lock' && scheduleHeld(cfg)) {
      // Said once a window, not on every minute's tick.
      const key = lockWindow(now, cfg)?.key ?? null;
      if (this._heldFor !== key) {
        this._heldFor = key;
        logger.info('not locking the groups for this window: no group is always-locked, so havdalah would open'
          + ' every admin-only group - Groups -> Sync from WhatsApp finds them, or Save the lockdown card'
          + ' if none of the groups is admins-only for good');
      }
      return;
    }
    this.busy = true;
    try {
      if (action === 'lock') { await this.applyLock('schedule'); }
      else { await this.applyUnlock('schedule'); }
    } finally { this.busy = false; }
  }

  /** Admin actions from the portal. */
  // Both return the per-group results so the caller can report what actually
  // happened rather than a bare success.
  async manualLock() {
    return this.applyLock('manual');
  }

  async manualUnlock(now = new Date()) {
    // Remember which window was overridden so the scheduler won't re-lock it -
    // but only when one is in progress. Between windows lockWindow() returns
    // the NEXT one, and recording that silently cancelled next week's lock.
    // It predates the cities, and they made it likely: with the groups
    // reopening at Saturday midday in New York, an admin who locks by hand for
    // the rest of New York's Shabbos and unlocks after its havdalah is doing
    // exactly what the card's note invites, and that unlock skipped the
    // following Friday. With nothing recorded, applyUnlock keeps whatever key
    // was there, which can only name a window that is over.
    const win = lockWindow(now, this.getConfig());
    return this.applyUnlock('manual', isWithin(now, win) ? win.key : null);
  }
}
