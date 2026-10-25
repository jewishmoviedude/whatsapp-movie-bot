/**
 * Title matching helpers. Used to line up a user's sloppy request
 * ("jhon wick 4") with a real catalogue entry ("John Wick: Chapter 4").
 */

const ARTICLES = /^(the|a|an)\s+/i;
const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };

/** Strip punctuation, articles, and casing so "The Matrix!" == "matrix". */
export function normalizeTitle(s) {
  if (!s) return '';
  let t = String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')        // strip accents
    .replace(/&/g, ' and ')
    // A dotted acronym is one word: "S.W.A.T." is what the library calls it and
    // "swat" is what a member types. Read as punctuation it became four
    // one-letter words (2026-10-07 20:33Z, "swat exiles season 1" scored 0.79
    // against "S.W.A.T. Exiles" and was answered "not in the library").
    .replace(/(?<![a-z0-9])(?:[a-z]\.){2,}/g, (m) => m.replace(/\./g, ''))
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  t = t.replace(ARTICLES, '');
  // Fold roman numerals to digits so "part iii" matches "part 3"
  t = t.split(' ').map((w) => (ROMAN[w] ? String(ROMAN[w]) : w)).join(' ');
  return t.trim();
}

/**
 * Does `title` begin with the words of `typed`, whole words only?
 *
 * Both sides are normalised first (case, accents, punctuation, "&"/"and",
 * roman numerals, one leading article), so "hobbit" and "the hobbit" both
 * begin "The Hobbit: An Unexpected Journey". A title that merely begins with
 * the same LETTERS is not a match: "cars" begins "Cars 2" but not "Carson
 * City", which is a different word. A title equal to the typed words counts.
 * So does one whose words match only with the apostrophes left out, as a
 * member types them: "oceans" begins "Ocean's Eleven" (sameTitleWords).
 */
export function startsWithWords(title, typed) {
  const starts = (t, q) => !!q && (t === q || t.startsWith(`${q} `));
  return starts(normalizeTitle(title), normalizeTitle(typed))
    || starts(normalizeTitle(dropApostrophes(title)), normalizeTitle(dropApostrophes(typed)));
}

/**
 * Are `a` and `b` the same title, once normalised - with or without their
 * apostrophes? normalizeTitle reads an apostrophe as a space, so "Ocean's
 * Eleven" is "ocean s eleven", and "oceans eleven" as members type it was
 * never the same words. Read either way, it is.
 */
export function sameTitleWords(a, b) {
  const x = normalizeTitle(a);
  return (!!x && x === normalizeTitle(b))
    || (!!a && !!b && normalizeTitle(dropApostrophes(a)) === normalizeTitle(dropApostrophes(b)));
}

const dropApostrophes = (s) => String(s ?? '').replace(/['\u2018\u2019`]/g, '');

/**
 * Damerau-Levenshtein: like Levenshtein, but counts a transposition of two
 * adjacent characters as one edit rather than two. That matters here because
 * swapped letters ("matirx", "jhon") are by far the most common way people
 * mistype a title.
 */
function damerau(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const m = a.length, n = b.length;
  let prev2 = null;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);

  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1);
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
      }
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[n];
}

/** Edit distance expressed as a 0..1 similarity. */
function editRatio(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  return 1 - damerau(a, b) / Math.max(a.length, b.length);
}

/**
 * Word-by-word comparison. Each word of the request is matched against its
 * closest word in the candidate, so an omitted subtitle ("John Wick 4" vs
 * "John Wick: Chapter 4") costs far less than comparing the strings whole.
 * Longer words carry more weight, and a candidate much longer than the
 * request is penalised so one shared common word cannot carry a bad match.
 */
function tokenScore(query, candidate) {
  const qt = query.split(' ').filter(Boolean);
  const ct = candidate.split(' ').filter(Boolean);
  if (!qt.length || !ct.length) return 0;

  let total = 0;
  let weight = 0;
  for (const t of qt) {
    let best = 0;
    let bestWord = null;
    for (const u of ct) {
      const r = editRatio(t, u);
      if (r > best) { best = r; bestWord = u; }
      if (best === 1) break;
    }
    // One edit can mean two very different things on a short word:
    // "jhon"/"john" is a typo, "joker"/"poker" is a different word. Edit
    // distance cannot tell them apart - both are one edit. What does is the
    // first letter: people mistype the middle of a word far more often than
    // its opening. So a shared initial buys leniency, and a different one
    // demands a near-exact match.
    const cutoff = bestWord && bestWord[0] === t[0] ? 0.6 : 0.85;
    if (best < cutoff) best = 0;
    const w = Math.max(2, t.length);
    total += best * w;
    weight += w;
  }

  let score = total / weight;

  // Extra words in the candidate are usually one of two things: a subtitle
  // the requester left off ("Harry Potter" -> "...and the Goblet of Fire"),
  // or coincidence. Subtitles come after the main title, so if the request
  // cleanly matches the candidate's opening words it is the former and
  // should barely be penalised at all.
  const extra = Math.max(0, ct.length - qt.length);
  if (extra > 0) {
    const isPrefix = qt.every((t, i) => ct[i] !== undefined && editRatio(t, ct[i]) >= 0.8);
    score -= isPrefix
      ? Math.min(0.06, extra * 0.015)
      : Math.min(0.25, extra * 0.05);
  }
  return Math.max(0, score);
}

/**
 * 0..1 similarity between two titles.
 * Takes the most generous of three views, because each catches a different
 * kind of sloppy request: whole-string typos, an omitted subtitle, and
 * word-level typos.
 */
export function similarity(a, b) {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;

  // Containment handles a subtitle the requester left off ("Toy Story" for
  // "Toy Story 3"). It is deliberately ONE-WAY: the request may be a prefix
  // of the real title, but not the other way round. A request of "the dark
  // night rises" must not score highly against a film called "Dark Night" -
  // there the candidate is missing a word the requester actually typed, and
  // that word is what distinguishes the two films.
  let containment = 0;
  if (x.length >= 5 && y.length >= 5 && y.includes(x)) {
    const ratio = x.length / y.length;
    containment = 0.85 + 0.15 * ratio;
  }

  // Whole-string comparison, held to the same first-letter rule as the
  // word-level one - otherwise single-word titles slip past it, and
  // "Brave"/"Grave" or "The Ring"/"The King" read as one another.
  let whole = editRatio(x, y);
  if (x[0] !== y[0] && whole < 0.85) whole = 0;

  return Math.max(whole, containment, tokenScore(x, y));
}

// Numbers written as words, as catalogue titles have them: "Ocean's Eleven",
// "Fast Five", "Dune: Part Two", "Shrek the Third". The place in the list is
// the value, from one.
const NUMBER_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const ORDINAL_WORDS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
  'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth',
  'nineteenth', 'twentieth'];
// "Zero Dark Thirty", "13 Going on 30": a member types the digits.
const TENS_WORDS = { thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const LONG_ROMAN = { xi: 11, xii: 12, xiii: 13 };

/** A number written as a word - "six", "sixth", "thirty" - or null. */
function wordValue(w) {
  const word = NUMBER_WORDS.indexOf(w);
  if (word >= 0) return word + 1;
  const nth = ORDINAL_WORDS.indexOf(w);
  if (nth >= 0) return nth + 1;
  return TENS_WORDS[w] ?? null;
}

/**
 * The number one normalised word stands for, or null: "6", "vi" (normalizeTitle
 * has already made it "6"), "six", "sixth", "thirty", "13th", "3D", and a word
 * that ends in it, as "F9", "X2" and "Alien³" ("alien3" once normalised) do.
 *
 * "13th", "3D" and "thirty" were not read when the sequel-number rule first
 * went in, on the 2026-10-11 incident below, and review found the rule then
 * took away the very film asked for: "friday the 13" lost Friday the 13th
 * (1980), "jackass 3" Jackass 3D, "step up 3" Step Up 3D and "zero dark 30"
 * Zero Dark Thirty, each of which the library's research had found before.
 */
function numberValue(w) {
  if (/^\d{1,2}$/.test(w)) return Number(w);
  if (LONG_ROMAN[w]) return LONG_ROMAN[w];
  const word = wordValue(w);
  if (word !== null) return word;
  const suffixed = w.match(/^(\d{1,2})(?:st|nd|rd|th|d)$/);
  if (suffixed) return Number(suffixed[1]);
  const tail = w.match(/^[a-z]+(\d{1,2})$/);
  return tail ? Number(tail[1]) : null;
}

/**
 * "twenty two" as 22, or null. Read as two words it is 20 and 2, and once a
 * number typed as a word counts (sequelNumber), "catch twenty two" would hold
 * the request to a 2 that Catch-22 does not carry.
 */
function compoundValue(tens, unit) {
  const t = tens === 'twenty' ? 20 : TENS_WORDS[tens];
  const u = NUMBER_WORDS.indexOf(unit) + 1;
  return t && u >= 1 && u <= 9 ? t + u : null;
}

/** Every number the words of a normalised title carry (numberValue, compoundValue). */
function numbersIn(words) {
  const out = words.map(numberValue);
  for (let i = 1; i < words.length; i++) out.push(compoundValue(words[i - 1], words[i]));
  return out.filter((v) => v !== null);
}

/**
 * The number a request ends with, after at least one word of title - "fast
 * and furios 6", "rocky ii", "toy story 3" - or null.
 *
 * Incident, 2026-10-11 11:21 UTC: jake asked for "fast and furios 6". The
 * 6 is what says which film of the series he meant, and every step that
 * resolved the request let it go: OMDb found nothing for the typo, the
 * relaxed search never searches a one-character word, and the winner of its
 * sub-queries was Fast and Furious (1939), which has no 6 at all. The
 * library then sent him Fast & Furious (2009), the fourth film, which he had
 * asked for on 2026-10-08 and been sent early the next day. A film without
 * the number typed is not the film asked for (carriesNumber).
 *
 * Digits, or a roman numeral (normalizeTitle turns it into digits), one or
 * two of them: a year has been taken off by cleanRequestText, "Room 237"
 * names no sequel, and a title that is one word ("x2", "f9", "se7en", "1917")
 * has no number after a title.
 *
 * Or a number written as a word, from two: "fast and furios six" is the same
 * request, and review of the fix found it still sent Fast & Furious (2009),
 * the library's research finding no number in it to hold the film to (and
 * "fast and furious six" and "the fast and the furious six" The Fast and the
 * Furious (2001), the first film). A title that ends in its own number word
 * is held to that number, which it carries: "fast five", "ocean's eleven",
 * "the hateful eight". "One" and "first" are not read: the first film is
 * the bare title anyway (carriesNumber), and a title ending in "one" ("rogue
 * one", "ready player one") names its own film. Nor is "3d" ("avatar 3d"
 * asks for Avatar, in 3D).
 */
export function sequelNumber(text) {
  const words = normalizeTitle(cleanRequestText(text)).split(' ').filter(Boolean);
  if (words.length < 2) return null;
  const last = words[words.length - 1];
  if (/^\d{1,2}$/.test(last)) return Number(last);
  // "twenty two" alone is a title, as "1917" is.
  const both = compoundValue(words[words.length - 2], last);
  if (both !== null) return words.length >= 3 ? both : null;
  const word = wordValue(last);
  return word !== null && word >= 2 ? word : null;
}

/**
 * Does the title `title` carry the number `n` anywhere, in any of the ways a
 * catalogue writes one (numberValue)? "Fast & Furious 6", "Rocky II", "Fast
 * Five", "Ocean's Eleven", "X2: X-Men United", "John Wick: Chapter 4",
 * "Friday the 13th" and "Jackass 3D" all carry theirs; "Fast and Furious"
 * does not carry a 6.
 *
 * And 1 is carried by a title that carries no number at all, as filmRequest
 * in several-films.js has it ("film 1 with no part or vol is the bare
 * title"): members ask for "ted 1", "harry potter 1" and "the equalizer 1",
 * and review found "john wick 1" and "rocky 1" lost John Wick (2014) and
 * Rocky (1976) to the rule, which wanted a 1 in the title. A title that
 * carries another number is still another film: Rocky II is not "rocky 1".
 * A number that is part of the title itself does not count against it, when
 * `typed`, the request, has it before its 1: "fifty shades of grey 1" is
 * Fifty Shades of Grey, whose fifty was typed.
 */
export function carriesNumber(title, n, { typed = null } = {}) {
  if (n === null || n === undefined) return true;
  const numbers = numbersIn(normalizeTitle(title).split(' ').filter(Boolean));
  if (numbers.includes(n)) return true;
  if (n !== 1) return false;
  const own = typed ? numbersIn(normalizeTitle(cleanRequestText(typed)).split(' ').filter(Boolean).slice(0, -1)) : [];
  return numbers.every((v) => own.includes(v));
}

/**
 * The words of a request that ends in 1, without it - "rocky 1" is "rocky",
 * "the equalizer 1" is "equalizer" (normalised) - or null for any other
 * request. The first film is the bare title (carriesNumber), and scored
 * against the words with their 1, Rocky (1976) reads 0.71 for "rocky 1",
 * under every bar, while Ted 2 read 0.80 for "Ted 1" (one character apart),
 * which is the film the request of 2026-10-07 was resolved to.
 */
export function firstFilmWords(text) {
  if (sequelNumber(text) !== 1) return null;
  return normalizeTitle(cleanRequestText(text)).split(' ').filter(Boolean).slice(0, -1).join(' ');
}

/**
 * Is `found` a different film from `wanted`, by title and year alone?
 *
 * similarity() forgives a subtitle the requester left off, which is right for
 * "John Wick 4" and wrong for "Barefoot": on 2026-09-29 Mia asked for
 * Barefoot (2014), which the library does not have, and "Barefoot" scored
 * 0.985 against the Barefoot Gen (1983) it does have. The 1983 anime was
 * posted to the posts group and queued again when she asked a second time. The
 * operator: "she clearly said 2014 in her message though so shouldve returned
 * not in library". A forgiven subtitle is only believable when the years
 * agree, so a title that is not identical once normalised, with years more
 * than one apart, is another film.
 *
 * An identical title is left alone (a remake is decided where it always was),
 * and so is a missing year on either side: without two years there is nothing
 * to disagree about.
 */
export function differentFilm(wanted, found) {
  const a = normalizeTitle(wanted?.title);
  const b = normalizeTitle(found?.title);
  if (!a || !b || a === b) return false;
  return yearsApart(wanted?.year, found?.year);
}

/**
 * Are both years known and more than one apart? One apart is the same film:
 * Jellyfin, OMDb and the member disagree by a year often enough (a festival
 * year against a release year) that it has always been forgiven.
 */
export function yearsApart(a, b) {
  const x = Number(a) || null;
  const y = Number(b) || null;
  return !!x && !!y && Math.abs(x - y) > 1;
}

/**
 * How many years apart OMDb and the library may file one film, when the
 * library's copy carries the film's IMDb id, and still be taken as that film
 * on the strength of the id. "A Snapshot of Forever", tt14074586, is 2025 to
 * OMDb and 2022 on the server (2026-10-11): three years, a festival year
 * against a release year. Further apart than that, the id is likelier the
 * library's mistake than the year: a remake tagged with the other film's id
 * - "Total Recall" (1990), rated R, carrying the PG-13 2012 film's tt1386703,
 * found in review the same day - was taken as the film that was vetted, its
 * file never looked up again, and would have been posted to a main group.
 */
export const SAME_ID_MAX_YEAR_GAP = 3;

/**
 * Are two years close enough for one IMDb id to be one film
 * (SAME_ID_MAX_YEAR_GAP)? An unknown year does not object.
 */
export function idYearsAgree(a, b) {
  const x = Number(a) || null;
  const y = Number(b) || null;
  return !x || !y || Math.abs(x - y) <= SAME_ID_MAX_YEAR_GAP;
}

/**
 * The year the member typed in `text`, when it is the year of `film` - the
 * film the request resolved to - give or take one. Otherwise null.
 *
 * A typed year says which film was meant, whatever the library holds under
 * that title. On 2026-09-29, asked about "Dune 1984" with only Dune (2021) on
 * the server, the operator's answer was "Not in library": the identical title
 * does not make the 2021 film the one asked for. (The same day, of Barefoot
 * Gen sent for "Barefoot 2014": "she clearly said 2014 in her message
 * though".) findInLibrary refuses a copy more than a year from it.
 *
 * Only a year the member wrote counts. A bare "dune" is resolved by OMDb to
 * one Dune or the other; that year is OMDb's guess, and a server holding
 * either copy still answers it as it always has. And only a year that names
 * the film found: a number in the title ("2001: A Space Odyssey", "1917",
 * "Blade Runner 2049") is read as a year by extractYear, and a year OMDb knows
 * no film of that title in, where the request was resolved to another year
 * instead, names no film at all. The film found is then judged by its own
 * year, as before.
 */
export function typedYearOf(text, film) {
  const y = extractYear(text);
  if (!y || yearsApart(y, film?.year)) return null;
  return y;
}

/**
 * Why `found`, a film the library holds, cannot be `wanted`, the film asked
 * for - or null when it can be:
 *
 *   'film'  another title from another year (differentFilm): Barefoot Gen
 *           (1983) for Barefoot (2014);
 *   'year'  more than a year from the year the member typed (typedYearOf),
 *           however identical the title: Dune (2021) for "Dune 1984";
 *   'film'  too, the same title from a year far from the film's, when
 *           `typed`, the member's own words, are not that title: Fast &
 *           Furious (2009) for Fast and Furious (1939), which OMDb made of
 *           "fast and furios 6" - unless those words carry a year, which
 *           then decides alone: Fast & Furious (2009) is the film "fast and
 *           furios 2009" names, whatever OMDb made of it, and 'year' for
 *           "fast and furios 2013".
 *
 * The one rule findInLibrary, the file re-check and every caller of them
 * judge a library film by, so they cannot drift apart.
 */
export function whyOtherFilm(wanted, found, { typedYear = null, typed = null } = {}) {
  if (differentFilm(wanted, found)) return 'film';
  // Far from the typed year AND from the resolved film's year. typedYearOf
  // already forgives a typed year one off OMDb's, so judging the copy by the
  // typed year alone let the two leeways add up: "Sound of Metal 2020" (the
  // release year), which OMDb has as 2019, refused the server's 2018 copy
  // (the festival year) as "a different year" and listed it as wanted. With
  // no resolved year, the typed year alone decides.
  if (yearsApart(typedYear, found?.year)
    && (!Number(wanted?.year) || yearsApart(wanted.year, found?.year))) return 'year';
  // An identical title decades from the film asked for is left alone above:
  // a member who types a bare "dune" named no year, and the one Dune the
  // server holds answers them whichever Dune OMDb guessed. That leeway is for
  // the title the member typed, though, and on 2026-10-11 at 11:21 UTC it
  // was given to OMDb's guess instead. "fast and furios 6" resolved, through
  // the relaxed search, to Fast and Furious (1939); the library's Fast &
  // Furious (2009), 70 years on, was the same words once "&" is "and", so it
  // was a hit, and the fourth film of the series was posted for a member who
  // had asked for the sixth (and had been sent the fourth two days
  // before). When the words typed are not that title, the year OMDb found is
  // all that says which film was meant, and a copy far from it is another
  // film. The words are read as typed as well as cleaned, as a title that is
  // a year ("1917") is nothing once its "year" is taken off.
  if (typed && !Number(typedYear) && yearsApart(wanted?.year, found?.year)
    && !sameTitleWords(cleanRequestText(typed), found?.title) && !sameTitleWords(typed, found?.title)) {
    // Unless the member wrote a year, which says which film was meant better
    // than OMDb's guess does. typedYearOf drops a year far from OMDb's film
    // (it may be a number in the title, as in "1917"), and that drop was all
    // this clause saw: on 2026-10-08 at 21:53 UTC jake's "fast and furios 2009"
    // was resolved by the relaxed search, which searches without the year,
    // to Fast and Furious (1939), and the library's Fast & Furious (2009),
    // the year he wrote, was the film he was sent. Refused here, he would
    // have been told only 📬. A copy from the year written is the one
    // named; one far from it is from another year than asked for.
    const written = extractYear(typed);
    if (written) return yearsApart(written, found?.year) ? 'year' : null;
    return 'film';
  }
  return null;
}

/**
 * Pick the best candidate above `threshold`.
 * `getTitle`/`getYear` let this work over any shape of object.
 */
export function bestMatch(query, candidates, { threshold = 0.72, year = null, getTitle = (c) => c.title, getYear = (c) => c.year } = {}) {
  let best = null;
  for (const c of candidates) {
    let score = similarity(query, getTitle(c));
    // A matching year is a meaningful tiebreaker between remakes.
    if (year && getYear(c)) {
      const diff = Math.abs(Number(year) - Number(getYear(c)));
      if (diff === 0) score += 0.08;
      else if (diff > 1) score -= 0.10;
    }
    // Year agreement is a tiebreaker, not extra credit beyond a perfect
    // match - scores above 1.0 are meaningless and read as "108%" in the UI.
    score = Math.max(0, Math.min(1, score));
    if (!best || score > best.score) best = { item: c, score };
  }
  return best && best.score >= threshold ? best : null;
}

/** Extract a trailing/parenthesised 4-digit year from a request string. */
export function extractYear(s) {
  const m = String(s || '').match(/\b(19[0-9]{2}|20[0-9]{2})\b/);
  return m ? Number(m[1]) : null;
}

/**
 * Remove the year and common request noise, leaving the bare title.
 *
 * `keepMediaWords` leaves "movie" and "film" alone. They are noise in a
 * SEARCH term ("the new spiderman movie please"), which is all this used to
 * feed, but they are also title words - The Muppet Movie, Scary Movie, Date
 * Movie, G.I. Joe: The Movie - and once a bare title started listing every
 * film whose title STARTS WITH it (see pick-list.js), dropping them changed
 * which films count as the franchise. In review, "#request the muppet movie"
 * was matched as "the muppet" and queued The Muppet Christmas Carol: the
 * Deathly Hallows incident over again, a film the member never named. So the
 * list matches on the words as they were typed, and only the search is given
 * the shorter string, which can only ever find more.
 */
export function cleanRequestText(s, { keepMediaWords = false } = {}) {
  let t = String(s || '')
    .replace(/\((19[0-9]{2}|20[0-9]{2})\)/g, ' ')
    .replace(/\b(19[0-9]{2}|20[0-9]{2})\b/g, ' ')
    .replace(/\b(please|pls|plz|thanks|thank you|ty)\b/gi, ' ');
  if (!keepMediaWords) t = t.replace(/\b(movie|film)\b/gi, ' ');
  return t
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')  // emoji
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Drop words that say what KIND of thing a TV request is, never part of its
 * title: "Rafa (TV series 2026)" and "Rafa the Netflix mini series" (Benji,
 * 2026-10-21, both answered "no series matching"). cleanRequestText cut the
 * year from inside the brackets and left "Rafa (TV series )", which no title
 * matches. A bare trailing "show" or "series" stays: "The Late Show" is a title.
 */
export function stripSeriesDescriptor(s) {
  const orig = String(s || '');
  const net = '(?:(?:tv|television|netflix|hbo|hulu|disney\\+?|prime|amazon|apple\\s*tv\\+?)\\s+)?';
  const kind = `${net}(?:mini[\\s-]?series|limited\\s+series|tv\\s+series|tv\\s+show|series)`;
  const out = orig
    .replace(new RegExp(`\\(\\s*(?:(?:19|20)\\d{2}\\s*)?${kind}\\s*(?:(?:19|20)\\d{2})?\\s*\\)`, 'gi'), ' ')
    .replace(new RegExp(`\\s+(?:the\\s+)?(?:new\\s+)?(?:(?:netflix|hbo|hulu|disney\\+?|prime|amazon|apple\\s*tv\\+?)\\s+)?(?:mini[\\s-]?series|tv\\s+series|tv\\s+show)\\s*$`, 'i'), ' ')
    .replace(/\s+/g, ' ').trim();
  return out || orig;
}
