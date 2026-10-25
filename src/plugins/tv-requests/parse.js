/**
 * Turn a free-text TV request into { show, season, episode }.
 *
 * People write these a dozen ways - "The Boys S01E01", "the boys season 1
 * episode 1", "The Boys 1x01", or just "The Boys". Only EXPLICIT season
 * markers are recognised: a bare trailing number is left as part of the show
 * name, because "24", "9-1-1" and "Stranger Things 4" are titles, not seasons.
 * Guessing there would send the wrong thing, which is worse than asking.
 *
 * A run of episodes ("S01E01-E05") comes back as `episodeRange`, and several
 * seasons ("S01 S02", "seasons 1-3") as `seasons`. Both used to be misread:
 * a range queued only its first episode, two seasons only the first, and
 * "The Office seasons 1-3" had no season at all - the whole phrase became
 * the show name, which matched nothing, and the member got 📬.
 *
 * A list of episodes ("S01E06, E09", "S01E04-E07, E09") comes back as
 * `episodeList`, every episode it names, or as `episodeRange` when they run
 * on without a gap. The operator's rule (2026-10-12): "if it's a dash it's 4
 * through 10, comma then it'll only be those 2". A dash between two episode
 * numbers is always "through", and a comma, "&" or "and" is "only these". A
 * chain of dashes ("e03-e04-e05-e06-e07") is one run, from its first episode
 * to its last.
 *
 * A bare "e" after "season N" is an episode, as it is after "S01": "season 1
 * e1-10" is ten episodes of season 1, and "season 5 - episodes 3, 5" two of
 * season 5. Ari's "avatar:the last Airbender 2005 season 1 e1-10" (2026-10-07
 * 19:19 UTC) posted all twenty episodes of the season, and Marty's
 * "Americas Got Talent season 21 E14-23" the same day all twenty-three:
 * "season N" was read with "episode" or "ep" after it, never a bare "e".
 *
 * What a list cannot take is named, not dropped (`unread`): an episode of
 * another season ("S05E06, S06E01" - one request is one season) or a run
 * that goes backwards ("S01E07-E04, E09"), and the rest of the list after
 * it. They were left out without a word, as the rest of a list once was.
 *
 * Pure and side-effect free so every shape below is unit-tested.
 */

/** Between the two ends of a range: "-", an en or em dash, "to", "through", "thru". */
const TO = String.raw`\s*(?:-|–|—|to\b|through\b|thru\b)\s*`;
/**
 * The end of a range is a number that is not the start of a clock time: "24
 * S01E02 - 1:00 A.M." is one episode and its title, not episodes 2 to 1.
 */
const END = String.raw`(\d{1,3})\b(?!:)`;

/** S01E01-E05 / S01E01-05 / S1 E3-6 / S01E01 - S01E05 / S01E01 to E05 */
const RE_SxE_RANGE = new RegExp(
  String.raw`\bs\s*(\d{1,2})\s*[\s._-]*(?:e|ep|x)\s*(\d{1,3})${TO}(?:s\s*(\d{1,2})\s*[\s._-]*)?(?:e|ep|x)?\s*${END}`, 'i');
/** 1x01-1x05 / 1x01-05 */
const RE_NxN_RANGE = new RegExp(String.raw`\b(\d{1,2})\s*x\s*(\d{1,3})${TO}(?:(\d{1,2})\s*x\s*)?${END}`, 'i');
/** "season 1 episodes 3-6", "S1 episodes 3 to 6", "season 1 e1-10" */
const RE_WORDY_RANGE = new RegExp(
  String.raw`\b(?:season|series|s)\s*(\d{1,2})\s*(?:,|and|&)?\s*(?:episodes?|eps?|e)\s*(\d{1,3})${TO}(?:episodes?\s*|eps?\s*|e\s*)?${END}`, 'i');
/** "episodes 3-6" with no season given */
const RE_EPISODE_RANGE = new RegExp(String.raw`\b(?:episodes?|eps?)\s*(\d{1,3})${TO}(?:episodes?\s*|eps?\s*|e\s*)?${END}`, 'i');

/*
 * A list of episodes: "S01E06, E09", "S01E06,E09", "S01 e06, e09", "S01E06,
 * 09", "S01E06 & E09", "S01E06 and E09", and runs within one, "S01E04-E07,
 * E09" or "S01E01-E03, E05-E06".
 *
 * Read as one episode, the rest of a list was dropped, or ("episodes 11+12"
 * after a season) the whole season was queued: a member asked four times
 * for Solo Leveling season 1 (2026-10-02) because each answer lacked the
 * episode they had just named. From then a list was read, but only as a
 * range, when its episodes ran on without a gap; any other list still kept
 * its first episode and dropped the rest without a word. "The Office s01
 * e06, e09" was S01E06 alone (2026-10-12), though the TV group's
 * description offers "e06, e09" as the way to ask for specific episodes.
 *
 * The list starts at an episode code, read as the single episode would be,
 * so whatever stands before it is the show's name, commas and ampersands
 * included: "Love, Death & Robots S01E01", "Law & Order S01E01, E03".
 */
/** What may stand before an episode number in a list: its code ("S01E", "1x"), or "episode", "ep", "e". */
const ITEM_MARK = String.raw`(?:s\s*(\d{1,2})\s*[\s._-]*(?:e|ep|x)|(\d{1,2})\s*x|episodes?|eps?|e)`;
/**
 * One more episode of a list, once its separator is taken off: "E09",
 * "S01E09", "ep 9", "09". [1] is its mark, [2] or [3] the season its code
 * names, [4] its number; LIST_TO's groups are the same.
 */
const LIST_ITEM = new RegExp(String.raw`^(${ITEM_MARK}\s*)?(\d{1,3})\b(?!:)`, 'i');
/** The far end of a run in a list, or the next link of a chain: "-E07", "-07", " to 7", " - S01E07". */
const LIST_TO = new RegExp(String.raw`^${TO}(${ITEM_MARK}\s*)?${END}`, 'i');
/**
 * What follows a bare number that is one more episode of a list though it
 * goes backwards ("S05E10, 9"): the end of the message - a "please" at most,
 * the words cleanRequestText takes off a show's name - or the next item. Not
 * another word: "S01E06 and 2 more" is one episode.
 */
const LIST_GOES_ON = new RegExp(String.raw`^(?:[^\p{L}\p{N}]*(?:(?:please|pls|plz|thanks|thank\s+you|ty)\b[^\p{L}\p{N}]*)*$`
  + String.raw`|${TO}|\s*(?:[,&+]|and\b))`, 'iu');
/**
 * A title after a run, not one more link of a chain: a spaced dash, a bare
 * number and a word, "S01E01-E02 - 3 Days Later". A chain is typed tight
 * ("03-04-05") or with its markers ("e03 -e04").
 */
const TITLE_NEXT = /^\s+[-–—]\s+\d{1,3}\s+[a-z]/i;
/** Between two episodes of a list: a comma, "&", "+" or "and" (", and" too). */
const LIST_SEP = /^\s*(?:,\s*(?:and\b|&)?|&|\+|and\b)\s*/i;
/**
 * Where a list can start: an episode with its season ("S01E06", "S01 e06",
 * "S01-e06", "season 1 episodes 6", "1x06"), or with none ("episodes 3, 5",
 * "Fullmetal alchemist E14, E16"), which the "which season?" question then
 * settles. `alone` reads "S01, E06" whatever follows it: the comma between
 * season and episode made the episode unreadable, and the whole of season 1
 * was queued for one episode of it. `range` is what a single run read from
 * here is called, as the range patterns below call theirs.
 */
const LIST_STARTS = [
  { re: /\bs\s*(\d{1,2})\s*[\s._-]*(?:e|ep|x)\s*(\d{1,3})\b/i, range: 'SxE-range' },
  { re: /\bs\s*(\d{1,2})\s*,\s*(?:episodes?|eps?|e)\s*(\d{1,3})\b(?!:)/i, alone: true, range: 'SxE-range' },
  { re: /\b(?:season|series|s)\s*(\d{1,2})\s*(?:,|and|&)?\s*(?:episodes?|eps?|e)\s*(\d{1,3})\b/i, range: 'wordy-range' },
  { re: /\b(\d{1,2})\s*x\s*(\d{1,3})\b/i, range: 'NxN-range' },
  { re: /\b(?:episodes?|eps?)\s*()(\d{1,3})\b/i, noSeason: true, range: 'episode-range' },
  { re: /\s+e\s*()(\d{1,3})\b/i, noSeason: true, range: 'episode-range' },
];
/**
 * A season named just before a list that names none: "Outer Banks season 5
 * - episodes 3, 5", "season 5, e6", "season 1 e1-10". The list is of that
 * season, and the show's name is what stands before it. A list after a
 * season used to be left to the season alone - the show would otherwise
 * have been "Outer Banks season 5" - and the whole season was queued, ten
 * episodes with the cap where two were asked for (found in review,
 * 2026-10-12). Only a season right before the list: "seasons 1-3 episodes
 * 2, 4" names no one season, and is left as it was.
 */
const SEASON_BEFORE = /\b(?:(?:seasons?|series)\s*|s)(\d{1,2})[\s,.:;&–—-]*$/i;

/** S01E01 / s1e1 / S01 E01 / S01xE01 */
const RE_SxE = /\bs\s*(\d{1,2})\s*[\s._-]*(?:e|ep|x)\s*(\d{1,3})\b/i;
/** 1x01 (no "s" prefix) */
const RE_NxN = /\b(\d{1,2})\s*x\s*(\d{1,3})\b/i;
/** "season 2 episode 5", "season 2 e5" (also "series 2", "seasons 1-3") */
const RE_WORDY = /\b(?:seasons?|series)\s*(\d{1,2})(?:\s*(?:,|and|&)?\s*(?:episodes?|eps?|part|e)\s*(\d{1,3}))?\b/i;
/** season only: "S02", "season 2" */
const RE_SEASON_ONLY = /\bs\s*(\d{1,2})\b(?!\s*[\s._-]*(?:e|ep|x)\s*\d)/i;
/** "episode 5" with no season given */
const RE_EPISODE_ONLY = /\b(?:episode|ep)\s*(\d{1,3})\b/i;
/**
 * A bare "E14" closing the request. Only at the very end, after a space: "Fullmetal
 * alchemist E14" was answered "no series matching", because the "E14" stayed in the
 * show name and dragged the title similarity under the threshold.
 */
const RE_TRAILING_E = /\s+e\s*(\d{1,3})$/i;

/*
 * More seasons after the first: "S01 S02", "S01 & S02", "season 1 and 2",
 * "season 1, 2 and 3", "S01-S03", "seasons 1 to 3". A bare number needs a
 * separator before it, so "The Boys season 2 2019" stays season 2 - and a
 * number is at most two digits, so a year is never read as a season.
 */
const SEASON_WORD = String.raw`(?:seasons?|series|s)`;
const MORE_LISTED = new RegExp(String.raw`^\s*(?:,|&|\+|and\b)\s*(?:${SEASON_WORD}\s*)?(\d{1,2})\b`, 'i');
const MORE_MARKED = new RegExp(String.raw`^\s*${SEASON_WORD}\s*(\d{1,2})\b`, 'i');
const MORE_RANGE = new RegExp(String.raw`^${TO}(?:${SEASON_WORD}\s*)?(\d{1,2})\b`, 'i');
/** What follows a season number that makes it an episode code: "S02E05". */
const EPISODE_NEXT = /^\s*[\s._-]*(?:e|ep|x)\s*\d/i;
/**
 * The widest run of seasons a range is read as. "seasons 1-99" was read as
 * ninety-nine seasons (found in review, 2026-09-29). No show
 * a member asks for runs longer than this (Saturday Night Live, at fifty
 * seasons, is the longest), so a wider range is a slip or a test, and is not
 * expanded: the request keeps the seasons read before it. How many of the
 * seasons asked for are queued from one message is a setting of its own
 * (tvRequests.maxSeasonsPerRequest); this only keeps the list sane.
 */
export const MAX_SEASON_SPAN = 50;

const clean = (v) => String(v ?? '')
  .replace(/\s+/g, ' ')
  .replace(/^[\s\-–—:,.]+|[\s\-–—:,.]+$/g, '')
  .trim();

/**
 * The seasons listed after the first, read from `rest` - the text right after
 * the first season's marker. Returns every season asked for, in order, first
 * included; a single season comes back as [first].
 */
function moreSeasons(first, rest) {
  const out = [first];
  let tail = rest;
  for (;;) {
    let m = tail.match(MORE_RANGE);
    if (m) {
      const to = Number(m[1]);
      if (EPISODE_NEXT.test(tail.slice(m[0].length))) break;
      // "S03-S01" is still seasons 1 to 3, whichever way round it was typed.
      const from = out[out.length - 1];
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      if (hi - lo >= MAX_SEASON_SPAN) break;
      for (let n = lo; n <= hi; n++) out.push(n);
      tail = tail.slice(m[0].length);
      continue;
    }
    m = tail.match(MORE_LISTED) ?? tail.match(MORE_MARKED);
    if (!m || EPISODE_NEXT.test(tail.slice(m[0].length))) break;
    out.push(Number(m[1]));
    tail = tail.slice(m[0].length);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * The runs of episodes a list names, from its first episode on: [[4, 7],
 * [9, 9]] for "E04-E07, E09". `season` is the list's, or null for one that
 * named none. An episode written with another season's code ends the list,
 * as a run into another season ends a range: one request is one season.
 * `chained` is set when a run went on past its first dash. `unread` is what
 * the list named from an episode it could not take to its end, or null
 * (unreadFrom).
 */
function listRuns(season, first, tail) {
  const fits = (s) => s == null || (season != null && Number(s) === season);
  const runs = [];
  let chained = false;
  let from = first;
  let rest = tail;
  // Where the list ended at an episode it could not take, if it did: one
  // written as an episode, never a title or a word.
  let stop = null;
  for (;;) {
    // A run that goes backwards or into another season is not one, as a
    // range is not ("S01E05 - 3 Days Later" is a title), and the list ends
    // at the episode before it. Its far end, written as an episode ("-E04",
    // "-S02E05"), is named (unreadFrom).
    const r = rest.match(LIST_TO);
    const run = !!r && Number(r[4]) > from && fits(r[2] ?? r[3]);
    let to = run ? Number(r[4]) : from;
    if (run) {
      rest = rest.slice(r[0].length);
      // "drake and josh S01 e03-e04-e05-e06-e07" (2026-10-12 21:32 UTC)
      // queued E03 and E04: a run ended at its first dash, and the rest of
      // the chain was dropped. Every dash is "through", so a chain is one
      // run from its first episode to its last, as far as it goes forwards
      // in the same season, and short of a title (TITLE_NEXT).
      for (let c; !TITLE_NEXT.test(rest) && (c = rest.match(LIST_TO)) && Number(c[4]) > to && fits(c[2] ?? c[3]);) {
        to = Number(c[4]);
        rest = rest.slice(c[0].length);
        chained = true;
      }
    }
    runs.push([from, to]);
    if (r && !run) {
      if (r[1]) stop = rest;
      break;
    }
    const sep = rest.match(LIST_SEP);
    const gap = sep ?? rest.match(/^\s+/);
    if (!gap) {
      // A chain stopped at a link it could not take: "S01E03-E04-S02E05".
      if (rest.match(LIST_TO)?.[1]) stop = rest;
      break;
    }
    const m = rest.slice(gap[0].length).match(LIST_ITEM);
    if (!m) break;
    if (!fits(m[2] ?? m[3])) {
      stop = rest;
      break;
    }
    const n = Number(m[4]);
    const high = Math.max(...runs.map(([, end]) => end));
    // A space alone takes only an episode with its marker, further on ("s1
    // e11 e12"); one further back is named, not taken, and a bare number
    // after a space is a title ("S01E05 3 Days Later"). After a comma, "&"
    // or "and" a bare number is taken going backwards too, where the list
    // goes on or ends with it: "Outer Banks S05E10, 9" was E10 alone, E09
    // dropped without a word (found in review, 2026-10-12), and "S01E06 and
    // 2 more" is still one episode.
    if (!sep) {
      if (!m[1]) break;
      if (n <= high) {
        stop = rest;
        break;
      }
    } else if (!m[1] && n <= high && !LIST_GOES_ON.test(rest.slice(gap[0].length + m[0].length))) break;
    from = n;
    rest = rest.slice(gap[0].length + m[0].length);
  }
  return { runs, chained, unread: stop == null ? null : unreadFrom(season, runs, stop) };
}

/**
 * The episodes a list names from where it stopped, at one it could not take
 * (listRuns), to its end, as codes for its member to ask for on their own:
 * ["S06E01"] for "S05E06, S06E01", ["S01E04", "E09"] for "S01E07-E04, E09".
 * Read as the list is, but in any season and either direction, and leaving
 * out what the list took after all: the far end of "S01E03-E05-E04" is in
 * its run. Null when nothing is left to name.
 *
 * "Outer Banks S05E06, S06E01" queued S05E06, and "S01E07-E04, E09" S01E07,
 * and nothing was said of the rest (found in review, 2026-10-12): what a
 * list named was dropped without a word, as the rest of a list was before
 * lists were read.
 */
function unreadFrom(season, runs, text) {
  const took = new Set(runEpisodes(runs));
  const pieces = [];
  let current = season;
  let rest = text;
  for (let i = 0; i < 100; i++) {
    const t = rest.match(LIST_TO);
    if (t && (t[1] || pieces.length)) {
      const own = t[2] ?? t[3];
      const n = Number(t[4]);
      const last = pieces[pieces.length - 1];
      // "S06E01-E03": a run of the other season's episodes, named as one.
      if (last && own == null && n > last.to) last.to = n;
      else pieces.push({ season: own != null ? Number(own) : current, from: n, to: n });
      if (own != null) current = Number(own);
      rest = rest.slice(t[0].length);
      continue;
    }
    const sep = rest.match(LIST_SEP);
    const gap = sep ?? rest.match(/^\s+/);
    if (!gap) break;
    const m = rest.slice(gap[0].length).match(LIST_ITEM);
    if (!m || (!m[1] && (!sep || !LIST_GOES_ON.test(rest.slice(gap[0].length + m[0].length))))) break;
    const own = m[2] ?? m[3];
    if (own != null) current = Number(own);
    pieces.push({ season: current, from: Number(m[4]), to: Number(m[4]) });
    rest = rest.slice(gap[0].length + m[0].length);
  }
  const left = pieces.filter((p) => p.season !== season
    || Array.from({ length: p.to - p.from + 1 }, (_, k) => p.from + k).some((n) => !took.has(n)));
  if (!left.length) return null;
  // Each by its code, its season written where it changes.
  return left.map((p, k) => rangeCode(k && left[k - 1].season === p.season ? null : p.season, p.from, p.to));
}

/** Every episode the runs hold, once each, in order. */
function runEpisodes(runs) {
  const out = new Set();
  for (const [from, to] of runs) for (let n = from; n <= to; n++) out.add(n);
  return [...out].sort((a, b) => a - b);
}

/** Does this text name a season already ("The Office season 1 -")? */
const namesSeason = (text) => [RE_SxE, RE_NxN, RE_WORDY, RE_SEASON_ONLY].some((re) => re.test(text));

/**
 * A list of episodes in `raw` (LIST_STARTS), or null when there is none: one
 * episode, or one run of a single dash, is left to the patterns that always
 * read those. A chain of dashes is read here, since they stop at its first,
 * and so is one episode or run the patterns could not read whole: after a
 * season named before it (SEASON_BEFORE), or with episodes after it the list
 * could not take (`unread`, which the patterns would drop without a word).
 */
function readList(raw) {
  for (const start of LIST_STARTS) {
    const m = raw.match(start.re);
    if (!m) continue;
    let show = clean(raw.slice(0, m.index));
    if (!show) continue;
    let season = start.noSeason ? null : Number(m[1]);
    // "Outer Banks season 5 - episodes 3, 5" is not a show called "Outer
    // Banks season 5", nor all of season 5: it is E03 and E05 of it
    // (SEASON_BEFORE). A list with no season of its own after one anywhere
    // else is left to the season, as it was before lists were read.
    const before = start.noSeason ? raw.slice(0, m.index).match(SEASON_BEFORE) : null;
    if (before) {
      show = clean(raw.slice(0, before.index));
      season = Number(before[1]);
    }
    if (!show || (start.noSeason && namesSeason(show))) continue;
    const { runs, chained, unread } = listRuns(season, Number(m[2]), raw.slice(m.index + m[0].length));
    const episodes = runEpisodes(runs);
    const more = unread ? { unread } : {};
    if ((start.alone || chained || before || unread) && (runs.length === 1 || episodes.length === 1)) {
      const from = episodes[0];
      const to = episodes[episodes.length - 1];
      return from === to
        ? { show, season, episode: from, raw, matched: 'SxE', ...more }
        : { show, season, episode: null, episodeRange: { from, to }, raw, matched: start.range, ...more };
    }
    // "S01E06, E06" is one episode, read below as it always was.
    if (runs.length < 2 || episodes.length < 2) continue;
    // Listed one after another, they are a run: "S01E11, E12" is E11-E12.
    if (episodes.every((n, i) => i === 0 || n === episodes[i - 1] + 1)) {
      return { show, season, episode: null,
        episodeRange: { from: episodes[0], to: episodes[episodes.length - 1] }, raw, matched: 'episode-list', ...more };
    }
    return { show, season, episode: null, episodeList: episodes, raw, matched: 'episode-list', ...more };
  }
  return null;
}

/**
 * The piece of a request's show name that is a season or episode code the
 * parser could not read, or null. The operator, 2026-10-19, after "SO1E11"
 * (the letter O for the zero) was answered "not in the library": "when
 * someone makes an improper request bot should react with a new emoji for
 * "request not written properly"". A code the parser reads is never left in
 * the show name, so what is left there - "sO8", "s1e", "se01ep05", "s1e5e6",
 * "8th season", "1x", a code with no show before it - is the request written
 * wrong, not a show the server lacks. Only a code with a digit in it counts,
 * so "S.W.A.T.", "Soe" or "Hunting Season" never do.
 */
const CODE_LEFT = [
  /\bs\s*e?\s*[0-9o]*\d[0-9o]*\s*[._-]?\s*(?:e|ep)(?:\s*[0-9o]+)*(?:\s*e\s*[0-9o]+)*(?![a-z])/i,
  /\bs\s*[0-9o]*\d[0-9o]*\b/i,
  /\b\d{1,2}\s*x\s*$/i,
  /\b\d{1,2}(?:st|nd|rd|th)\s+(?:season|series)\b/i,
];
export function codeLeftIn(show) {
  const text = String(show ?? '').trim();
  for (const re of CODE_LEFT) {
    const m = text.match(re);
    if (m) return m[0].trim();
  }
  return null;
}

/**
 * "Chad powers season two" (Jude Shaw, 2026-10-18) was searched whole as
 * a show name and answered "not in the library", though Chad Powers is on the
 * server: the season was a word. "season two" / "series three" is read as
 * "season 2" / "series 3", and "second season" the same, before any code is
 * looked for. Only words one to ten, and only next to the season word.
 */
const SEASON_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
const NUM_WORD = Object.keys(SEASON_WORDS).join('|');
function seasonWordToDigit(text) {
  return text
    .replace(new RegExp(String.raw`\b(seasons?|series)\s+(${NUM_WORD})\b`, 'gi'), (m, w, n) => `${w} ${SEASON_WORDS[n.toLowerCase()]}`)
    .replace(new RegExp(String.raw`\b(${NUM_WORD})\s+(season|series)\b`, 'gi'), (m, n, w) => `${w} ${SEASON_WORDS[n.toLowerCase()]}`);
}

/**
 * @returns {{ show: string, season: number|null, episode: number|null,
 *             episodeRange?: { from: number, to: number },
 *             episodeList?: number[],
 *             seasons?: number[], unread?: string[],
 *             raw: string, matched: string|null }}
 *
 * `episodeRange` is set for a run of episodes, with `episode` null - a range
 * is not one episode - and `season` the season it is in (null when none was
 * given). `episodeList` is the same for a list with a gap in it: every
 * episode it names, in order, and none between them. `seasons` is set only
 * when more than one season was asked for; `season` is then the first of
 * them, so a caller that knows only `season` still sees a season request.
 * `unread` is set when the request named episodes it could not take with
 * the rest, by their codes ("S06E01"), for the member to be told to ask for
 * them on their own (unreadFrom).
 */
export function parseTvRequest(text) {
  const raw = spaceGluedWords(seasonWordToDigit(String(text ?? '').trim()));
  if (!raw) return { show: '', season: null, episode: null, raw, matched: null };

  // A list of episodes, tried first, since a range or a single episode would
  // match its first item and drop the rest. Only a list is answered here.
  const list = readList(raw);
  if (list) return list;

  // A run of episodes, tried before a single one, which would otherwise match
  // its first half and drop the rest.
  const ranges = [
    { name: 'SxE-range', re: RE_SxE_RANGE, season: 1, from: 2, toSeason: 3, to: 4 },
    { name: 'NxN-range', re: RE_NxN_RANGE, season: 1, from: 2, toSeason: 3, to: 4 },
    { name: 'wordy-range', re: RE_WORDY_RANGE, season: 1, from: 2, to: 3 },
    { name: 'episode-range', re: RE_EPISODE_RANGE, season: null, from: 1, to: 2 },
  ];
  for (const c of ranges) {
    const m = raw.match(c.re);
    if (!m) continue;
    const season = c.season != null ? Number(m[c.season]) : null;
    const from = Number(m[c.from]);
    const to = Number(m[c.to]);
    // "S01E20-S02E03" crosses a season, and a range that runs backwards is
    // most likely an episode title that starts with a number ("S01E05 - 3
    // Days Later"). Neither is read as a range; the single episode below
    // still matches the first half.
    if (c.toSeason && m[c.toSeason] != null && Number(m[c.toSeason]) !== season) continue;
    if (!(to > from)) continue;
    const show = clean(raw.slice(0, m.index));
    if (!show) continue;
    return { show, season, episode: null, episodeRange: { from, to }, raw, matched: c.name };
  }

  const tryEach = [
    { name: 'SxE', re: RE_SxE, season: 1, episode: 2 },
    { name: 'wordy', re: RE_WORDY, season: 1, episode: 2 },
    { name: 'NxN', re: RE_NxN, season: 1, episode: 2 },
    { name: 'season-only', re: RE_SEASON_ONLY, season: 1, episode: null },
  ];

  for (const c of tryEach) {
    const m = raw.match(c.re);
    if (!m) continue;
    const season = m[c.season] != null ? Number(m[c.season]) : null;
    const episode = c.episode != null && m[c.episode] != null ? Number(m[c.episode]) : null;
    if (season != null && !Number.isFinite(season)) continue;

    // Everything before the marker is the show; anything after is the episode
    // title people sometimes append ("Breaking Bad S05E14 Ozymandias").
    const show = clean(raw.slice(0, m.index));
    if (!show) continue;                       // a marker with no show name is not a request
    if (episode == null && season != null) {
      const seasons = moreSeasons(season, raw.slice(m.index + m[0].length));
      if (seasons.length > 1) return { show, season: seasons[0], episode: null, seasons, raw, matched: 'seasons' };
    }
    return { show, season, episode, raw, matched: c.name };
  }

  // "Show episode 5" with no season at all - treat as season 1, which is what
  // people mean, but flag it so the caller can confirm if it matters.
  const epOnly = raw.match(RE_EPISODE_ONLY);
  if (epOnly) {
    const show = clean(raw.slice(0, epOnly.index));
    if (show) return { show, season: null, episode: Number(epOnly[1]), raw, matched: 'episode-only' };
  }

  const trailE = raw.match(RE_TRAILING_E);
  if (trailE) {
    const show = clean(raw.slice(0, trailE.index));
    if (show) return { show, season: null, episode: Number(trailE[1]), raw, matched: 'episode-only' };
  }

  return { show: clean(raw), season: null, episode: null, raw, matched: null };
}

/**
 * "TheResidentSeason3" -> "The Resident Season3". A member typed a request
 * with no spaces (2026-10-01) and was told the series was not in the library,
 * though "The Resident" is: neither the season marker nor the title could be
 * read from one glued word. Only text with no whitespace at all and at least
 * two lower-to-upper joins is split, so a single brand-style word such as
 * "McDonalds" or "SpongeBob" is left alone.
 */
function spaceGluedWords(text) {
  if (/\s/.test(text)) return text;
  const joins = text.match(/[a-z](?=[A-Z])/g);
  if (!joins || joins.length < 2) return text;
  return text.replace(/([a-z])(?=[A-Z])/g, '$1 ');
}

/**
 * Strip a trailing release year from a show name.
 *
 * People are told "add the year" by the movie legend, so they send
 * "The Boys 2019". Left in, the title similarity against "The Boys" drops to
 * ~0.50 - under the match threshold - and the bot wrongly answers "not in the
 * library" for a show it has. Only strips when something else remains, so the
 * shows literally named after numbers ("24", "1883", "1923") are untouched.
 */
export function stripTrailingYear(show) {
  const t = String(show ?? '').trim();
  const m = t.match(/^(.*\S)\s+((?:19|20)\d{2})$/);
  if (!m) return { show: t, year: null };
  return { show: m[1].trim(), year: Number(m[2]) };
}

/** True when the request names one specific episode rather than a whole season. */
export function isSingleEpisode(parsed) {
  return !!parsed && parsed.episode != null;
}

/** "S01E03–E06": a run of episodes of one season, by its codes. */
export function rangeCode(season, from, to) {
  const s = season != null ? `S${pad(season)}` : '';
  return from === to ? `${s}E${pad(from)}` : `${s}E${pad(from)}–E${pad(to)}`;
}

/** "1, 2 and 3". */
export function seasonList(seasons) {
  const l = (seasons ?? []).map(String);
  return l.length > 1 ? `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}` : (l[0] ?? '');
}

/**
 * Numbers in order, once each, as [first, last] spans: a run of three or more
 * is one span, and anything shorter a span per number - "7–8" reads worse
 * than "7 and 8" and saves nothing (withheld.js's compactRuns).
 */
function spans(numbers) {
  const s = [...new Set(numbers ?? [])].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < s.length;) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    if (j - i >= 2) out.push([s[i], s[j]]);
    else for (let k = i; k <= j; k++) out.push([s[k], s[k]]);
    i = j + 1;
  }
  return out;
}

/**
 * "1, 2 and 4–30": seasonList, with a run of three or more written as its
 * ends. The seasons one message could not have ("seasons 4 to 30 weren't
 * added") were otherwise named one by one, twenty-seven of them in a line.
 */
export function seasonSpans(seasons) {
  return seasonList(spans(seasons).map(([a, b]) => (a === b ? String(a) : `${a}–${b}`)));
}

/**
 * "S01E04–E07, E09": a list of episodes of one season by its codes, as
 * compact as rangeCode is for a run - for the queue, the notifications
 * group, History and the replies. Without a season, "E04–E07, E09".
 */
export function listCode(season, episodes) {
  const s = season != null ? `S${pad(season)}` : '';
  return s + spans(episodes).map(([a, b]) => (a === b ? `E${pad(a)}` : `E${pad(a)}–E${pad(b)}`)).join(', ');
}

/**
 * [[1, 10], [12, 12]]: episode numbers in order, once each, as runs of
 * consecutive numbers - the shape History keeps them in, as a request the
 * episode limit cut (its row's `cut`, next-part.js and cap-cut.js).
 */
export function runsOf(numbers) {
  const s = [...new Set(numbers ?? [])].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const out = [];
  for (const n of s) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}

/**
 * The numbers back out of runsOf's runs, read defensively: they come back
 * from History, where a row can be anything an older version wrote. A run
 * that is not two numbers is skipped, and none is read past a thousand
 * episodes (One Piece holds 1,100 in one season folder).
 */
export function numbersOfRuns(runs) {
  const out = [];
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!Array.isArray(run)) continue;
    const a = Number(run[0]);
    const b = Number(run[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    for (let n = a; n <= b && n - a < 1000; n++) out.push(n);
  }
  return out;
}

/** Human summary of what was asked for, for logs and notifications. */
export function describeRequest(parsed) {
  if (!parsed?.show) return '(nothing)';
  if (parsed.seasons?.length > 1) return `${parsed.show} seasons ${seasonList(parsed.seasons)}`;
  if (parsed.episodeRange) {
    const { from, to } = parsed.episodeRange;
    return parsed.season != null
      ? `${parsed.show} ${rangeCode(parsed.season, from, to)}`
      : `${parsed.show} episodes ${from}–${to}`;
  }
  if (parsed.episodeList?.length) {
    return parsed.season != null
      ? `${parsed.show} ${listCode(parsed.season, parsed.episodeList)}`
      : `${parsed.show} episodes ${seasonSpans(parsed.episodeList)}`;
  }
  if (parsed.season != null && parsed.episode != null) {
    return `${parsed.show} S${pad(parsed.season)}E${pad(parsed.episode)}`;
  }
  if (parsed.season != null) return `${parsed.show} season ${parsed.season}`;
  if (parsed.episode != null) return `${parsed.show} episode ${parsed.episode}`;
  return parsed.show;
}

export function pad(n) {
  const v = Number(n);
  return Number.isFinite(v) ? String(v).padStart(2, '0') : '00';
}
