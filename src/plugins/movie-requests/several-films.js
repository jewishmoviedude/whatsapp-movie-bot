/**
 * One film per request: telling a request for several films from a single
 * film whose title happens to hold a number.
 *
 * On 2026-10-11 the operator went through History rows that had ended
 * "need-year - too many matches - needs a year": "the equalizer 1 & 2" and
 * "the extraction 1 & 2" (Matt Fisher), and "rocky 1 2 3 4 5 and 6" (JJ).
 * OMDb had found the words too broad, so each was answered 📅 and asked for a
 * year that would not have helped. The operator: "these dont need year, they
 * should get denied because they didnt ask for 1 movie at a time". So the
 * movie plugin asks this module first, before the library's "which one?" list
 * and before OMDb, and refuses such a request at no lookup cost (index.js,
 * _runRequest, step 0a).
 *
 * It is built around one rule: a wrong refusal is worse than a missed one. A
 * missed refusal falls back to what the bot did before, while a wrong one
 * denies a member their film. So every pattern here is narrow, anything
 * unsure is let through, and all of it is checked against every title in
 * library/clean-titles.json - typed as it is, with its year, and lowercased -
 * in test/one-film-per-request.test.mjs. "2 Fast 2 Furious", "Ocean's 11",
 * "Fahrenheit 9/11", "Christmas 9 to 5", "Harry Potter 7 part 2" and
 * "The Naked Gun 33 1/3" all pass untouched, and each of the guards below is
 * there for one of them.
 *
 * Everything here is pure: no WhatsApp, no lookups, no clock.
 */

/** "and", "&", "+", ",", "/" - two films side by side. */
const JOIN_WORDS = new Set(['and', '&', '+', ',', '/']);
/** "1-8", "1 to 8", "1 thru 6": every film from one to the other. */
const RANGE_WORDS = new Set(['-', '–', '—', 'to', 'thru', 'through', 'till', 'til', 'until']);
/**
 * The word a film's number is sometimes given with: "kill bill vol 1 and 2",
 * "the godfather part 1 and 2". Mapped to how the suggested request says it;
 * '' drops it, since "harry potter movies 2" is not how anyone names a film.
 * "movie" and "film" are not here: they are title words too ("Scary Movie 2
 * and 3" is Scary Movie 2 and Scary Movie 3).
 */
const MARKERS = new Map(Object.entries({
  part: 'part', parts: 'part', pt: 'pt', pts: 'pt',
  vol: 'vol', vols: 'vol', volume: 'volume', volumes: 'volume',
  chapter: 'chapter', chapters: 'chapter', ch: 'ch',
  movies: '', films: '',
}));
/**
 * Words that make the numbers seasons or episodes - "the office season 1 and
 * 2", "friends s03 e06, e08", "doctor who series 1-3" - which the TV section
 * answers (or, in a movie group, the "that is a series" reply). Not films.
 */
const TV_WORDS = /^(?:season|seasons|series|episode|episodes|ep|eps|s|e|s\d{1,2}(?:e\d{1,3})?|e\d{1,3})$/;
const ARTICLES = new Set(['the', 'a', 'an']);
/** The highest number read as a film's place in a series. Above it, "Apollo 13" and "1408" are titles. */
const MAX_FILM_NUMBER = 30;

const ROMAN = (() => {
  const out = new Map();
  const ones = ['', 'i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix'];
  const tens = ['', 'x', 'xx', 'xxx'];
  for (let n = 1; n <= MAX_FILM_NUMBER; n++) out.set(tens[Math.floor(n / 10)] + ones[n % 10], n);
  return out;
})();

/** How a whole series is asked for in words: "the matrix trilogy", "lord of the rings box set". */
const SERIES_WORDS = /^(.+?)\s+(?:trilogy|duology|dilogy|quadrilogy|tetralogy|pentalogy|hexalogy|franchise|box\s?set|movie\s+series|film\s+series|series\s+of\s+(?:movies|films))$/;
/**
 * "all the harry potter movies", "both kill bill films". Plural only: "All
 * the President's Men" is a title, and a member who types it with "movie"
 * after it must still get it. "Every" is not read at all, for "Every Day" and
 * "Every Which Way but Loose".
 */
const ALL_THE = /^(?:all|both)\s+(?:of\s+)?(?:the\s+)?(?:\d{1,2}\s+)?(.+?)\s+(?:movies|films|parts|volumes|chapters|sequels)$/;
/** "harry potter all", "kill bill both", "john wick all 4 movies". */
const X_ALL = /^(.+?)\s+(?:all|both)(?:\s+(?:of\s+them|(?:the\s+)?(?:movies|films|parts|volumes)|\d{1,2}(?:\s+(?:movies|films|parts|volumes))?))?$/;
/**
 * The words a title ends in before a closing "all" or "both" - "One Show
 * Fits All", "Free for All", "Winner Takes All", "Kill Them All", "Love
 * Conquers All", "Once and for All". With one of these in front, "all" is
 * part of the title, not a request for a series.
 *
 * "em" is here for "Kill 'Em All" (2017), its sequel "Kill 'Em All 2" (2024)
 * and "Bless 'Em All" (1949). A review of this module found all three refused
 * ☝️ as "a whole series", typed with the apostrophe or without, with their
 * year or not, and from the panel's Re-run and a pasted TMDB link too; none
 * of them is in library/clean-titles.json, which is why the catalogue check
 * had not caught it. "my", "his", "our" and the like are here for "gave it
 * my all". A contraction is read as part of the title as well ("that's all",
 * "kill'em all", "don't all"): see allBelongsToTitle.
 */
const NOT_BEFORE_ALL = new Set([
  'for', 'fits', 'fit', 'takes', 'take', 'took', 'it', 'them', 'em', 'us', 'you', 'ya', 'y', 'we', 'they', 'me',
  'him', 'her', 'he', 'she', 'thee', 'thou', 'ye', 'yall', 'my', 'your', 'his', 'our', 'their', 'its',
  'everyone', 'everybody', 'at', 'above', 'after', 'over', 'against', 'beyond', 'with', 'from', 'by',
  'in', 'on', 'of', 'to', 'and', 'or', 'once', 'conquers', 'conquer', 'beats', 'beat', 'saves', 'save',
  'kills', 'kill', 'killed', 'rules', 'rule', 'risk', 'risks', 'lose', 'loses', 'lost', 'win', 'wins',
  'won', 'have', 'has', 'had', 'know', 'knows', 'see', 'sees', 'end', 'ends', 'is', 'are', 'was',
  'were', 'be', 'been', 'love', 'loves', 'heals', 'heal', 'gets', 'get', 'got', 'give', 'gives', 'gave',
  'make', 'makes', 'made', 'means', 'mean', 'do', 'does', 'did', 'play', 'plays', 'hold', 'holds',
  'want', 'wants', 'need', 'needs', 'eat', 'eats', 'hate', 'hates', 'not', 'no', 'almost', 'free',
  'that', 'this', 'these', 'those', 'one',
]);
/** The words whose "'s" is "is" or "us", not a possessive: "that's all", "it's all", "let's all". */
const CONTRACTED_S = new Set([
  'that', 'it', 'he', 'she', 'what', 'there', 'here', 'who', 'where', 'how', 'when', 'why', 'let',
  'this', 'one', 'everyone', 'everybody', 'nobody', 'somebody', 'someone',
]);

/**
 * Is the word before a closing "all" or "both" one that makes it part of the
 * title? One of NOT_BEFORE_ALL ("em" among them: the tokenizer sets the
 * apostrophe of "kill 'em" apart), or a contraction ("that's", "kill'em",
 * "don't", "y'all"). A possessive is not: "five nights at freddy's both" and
 * "ocean's all" ask for a whole series, and are refused as before.
 */
function allBelongsToTitle(word) {
  if (NOT_BEFORE_ALL.has(word)) return true;
  if (!/['’]/.test(word)) return false;
  const possessive = /^(.+)['’]s$/.exec(word);
  return !possessive || CONTRACTED_S.has(possessive[1]);
}

/** Lower-cased, with what never changes the answer taken off: emoji, a year, "please", brackets. */
function clean(text) {
  let s = String(text ?? '').toLowerCase().normalize('NFKC')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ')
    .replace(/\(\s*(?:19|20)\d{2}\s*\)/g, ' ')
    .replace(/[()[\]{}"“”]/g, ' ')
    // "vol.1", "pt. 2", "#2": the dot and the hash say nothing.
    .replace(/\b(vol|vols|pt|pts|ch|ep|no)\.\s*/g, '$1 ')
    .replace(/#(?=\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (let before = ''; before !== s;) {
    before = s;
    s = s.replace(/[\s,.!?:;]*\b(?:please|pls|plz|thanks|thank you|thx|ty)$/, '')
      .replace(/[\s,.!?:;]+$/, '')
      // A year after the films ("rocky 1-6 1976") says when, not which.
      .replace(/\s(?:19|20)\d{2}$/, '')
      .trim();
  }
  return s;
}

/**
 * The request in tokens. `sp` says whether a space came before the token, so
 * that words() can put the title back as it was typed: "kill 'em all", not
 * "kill' em all".
 */
function tokenize(s) {
  return [...s.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|[&+,/]|[-–—]|\S/gu)].map(({ 0: t, index }) => {
    const sp = index > 0 && /\s/.test(s[index - 1]);
    if (JOIN_WORDS.has(t)) return { t, sp, type: 'join' };
    if (RANGE_WORDS.has(t)) return { t, sp, type: 'range' };
    if (MARKERS.has(t)) return { t, sp, type: 'marker' };
    if (/^\d{1,2}$/.test(t) && Number(t) >= 1 && Number(t) <= MAX_FILM_NUMBER) return { t, sp, type: 'num', n: Number(t) };
    if (ROMAN.has(t)) return { t, sp, type: 'roman', n: ROMAN.get(t) };
    if (/^\p{L}/u.test(t) || /^\d/.test(t)) return { t, sp, type: 'word' };
    return { t, sp, type: 'break' };
  });
}

const isNumber = (tok) => tok?.type === 'num' || tok?.type === 'roman';

/** Is there a word in these tokens that names something - not an article, a joiner, a number or punctuation? */
function namesSomething(tokens) {
  return tokens.some((k) => k.type === 'word' && (k.t.match(/\p{L}/gu) ?? []).length >= 2 && !ARTICLES.has(k.t));
}

/**
 * The films a request's trailing numbers name, read from the end:
 * "rocky 1 2 3 4 5 and 6", "harry potter 1-8", "toy story 1, 2 and 3",
 * "kill bill vol 1 and vol 2", "rocky ii and iii". Null when there is one
 * film, or when the numbers belong to the title.
 */
function trailingRun(tokens) {
  const items = [];   // from the end: { n, t, roman, marker, at }
  const seps = [];    // seps[k] is between items[k + 1] and items[k]: 'join' | 'range' | 'bare' | 'slash'
  let i = tokens.length - 1;
  const readItem = () => {
    if (!isNumber(tokens[i])) return null;
    const item = { n: tokens[i].n, t: tokens[i].t, roman: tokens[i].type === 'roman', marker: null, at: i };
    i -= 1;
    if (tokens[i]?.type === 'marker') { item.marker = tokens[i].t; item.at = i; i -= 1; }
    return item;
  };
  const first = readItem();
  if (!first) return null;
  items.push(first);
  for (;;) {
    const save = i;
    let sep = null;
    if (tokens[i]?.type === 'range') { sep = 'range'; i -= 1; } else if (tokens[i]?.type === 'join') {
      sep = tokens[i].t === '/' ? 'slash' : 'join';
      i -= 1;
      // ", and" / ", &": a comma before the last joiner is one joiner.
      while (tokens[i]?.type === 'join' && tokens[i].t !== '/') { sep = 'join'; i -= 1; }
    } else if (isNumber(tokens[i])) sep = 'bare';
    if (!sep) break;
    const next = readItem();
    const last = items[items.length - 1];
    // Numbers side by side with nothing between them are films only when
    // both are plain digits: "saw 1 2 3", but not "rocky ii iii" or
    // "harry potter 7 part 2", where "part 2" is one film's name.
    const bareOk = sep !== 'bare' || (next && !next.roman && !next.marker && !last.roman && !last.marker);
    if (!next || !bareOk) { i = save; break; }
    seps.push(sep);
    items.push(next);
  }
  if (items.length < 2) return null;
  items.reverse();
  seps.reverse();
  // "the naked gun 33 1/3": slashed numbers with a number in front are a
  // fraction. ("8 1/2" is caught below: 1 does not follow 8.)
  const stemEnd = items[0].at;
  if (seps.includes('slash') && /^\d/.test(tokens[stemEnd - 1]?.t ?? '')) return null;
  const films = [];
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    const sep = k ? seps[k - 1] : null;
    const prev = films[films.length - 1];
    if (prev && it.n <= prev.n) return null;   // "christmas 9 to 5", "20/20", "naked gun 2 1/2"
    // A slash joins films only one after the other: "rocky 2/3" is two,
    // "Fahrenheit 9/11" is a date.
    if (sep === 'slash' && it.n !== prev.n + 1) return null;
    if (sep === 'range') {
      for (let n = prev.n + 1; n < it.n; n++) films.push({ n, t: it.roman ? romanOf(n) : String(n), roman: it.roman, marker: null });
    }
    films.push({ n: it.n, t: it.t, roman: it.roman, marker: it.marker });
  }
  const stem = tokens.slice(0, stemEnd);
  if (!namesSomething(stem)) return null;
  if (stem.some((k) => TV_WORDS.test(k.t))) return null;
  // "from 1 to 10" counts; it does not ask for ten films.
  if (seps.includes('range') && ['from', 'between'].includes(stem[stem.length - 1]?.t)) return null;
  // One marker said once covers the rest: "kill bill vol 1 and 2".
  const marker = films.find((f) => f.marker)?.marker ?? null;
  return { stem, films, marker };
}

function romanOf(n) {
  for (const [r, v] of ROMAN) if (v === n) return r;
  return String(n);
}

/**
 * Tokens back to words, as the member typed them (lower-cased), spaced as
 * they were typed. Joining every token with a space and then gluing each
 * apostrophe to the word before it told "kill 'em all 1 & 2" to send "kill'
 * em all", as the review that found "Kill 'Em All" refused showed; spaced as
 * typed, "the 'burbs", "airport '77", "3:10 to yuma", "a.i." and "x-men" come
 * back whole too.
 */
function words(tokens) {
  // "'the equalizer' 1 & 2": a title the member put in single quotes is
  // suggested without them. An opening quote is glued to the word after it,
  // a closing one to the word before it; "'85" has no closing one, and
  // keeps its apostrophe.
  const quote = (k) => k?.type === 'break' && /^['‘’]$/.test(k.t);
  let said = tokens;
  if (quote(said[0]) && said[1] && !said[1].sp) {
    const close = said.findIndex((k, i) => i > 1 && quote(k) && !k.sp && (!said[i + 1] || said[i + 1].sp));
    if (close > 0) said = said.filter((_, i) => i !== 0 && i !== close);
  }
  return said.map((k, i) => `${i && k.sp && !/^[,.!?:;]$/.test(k.t) ? ' ' : ''}${k.t}`).join('').trim();
}

/** The request for one film of the series: "the equalizer", "the equalizer 2", "kill bill vol 2". */
function filmRequest(stem, film, marker) {
  const say = marker != null ? MARKERS.get(marker) : '';
  // Film 1 with no "part" or "vol" is the bare title: "The Equalizer", "Rocky".
  if (film.n === 1 && !say) return stem;
  return `${stem} ${say ? `${say} ` : ''}${film.t}`;
}

/**
 * "the equalizer 1 and the equalizer 2", "rocky, rocky 2 and rocky 3": the
 * same title said again with each film's number. "New York, New York" says
 * one title twice with no number, and is a film.
 */
function sameTitleTwice(tokens) {
  const parts = [[]];
  for (const k of tokens) {
    if (k.type === 'join' && k.t !== '/') { if (parts[parts.length - 1].length) parts.push([]); } else parts[parts.length - 1].push(k);
  }
  if (parts.length < 2 || parts.some((p) => !p.length)) return null;
  const read = parts.map((p) => {
    let end = p.length;
    let film = { n: 1, t: null };
    let marker = null;
    if (isNumber(p[end - 1])) { film = { n: p[end - 1].n, t: p[end - 1].t }; end -= 1; }
    if (film.t && p[end - 1]?.type === 'marker') { marker = p[end - 1].t; end -= 1; }
    const stem = p.slice(0, end);
    const key = stem.filter((k, i) => k.type === 'word' && !(i === 0 && ARTICLES.has(k.t))).map((k) => k.t).join(' ');
    return { stem, key, film, marker };
  });
  if (!read[0].key || !namesSomething(read[0].stem) || read.some((r) => r.key !== read[0].key)) return null;
  if (read[0].stem.some((k) => TV_WORDS.test(k.t))) return null;
  const ns = read.map((r) => r.film.n);
  if (new Set(ns).size !== ns.length) return null;
  const stem = words(read[0].stem);
  return read.map((r) => filmRequest(stem, r.film, r.marker));
}

/**
 * Does this request ask for several films at once?
 *
 * `text` is the request after the group's prefix ("#request") has been taken
 * off. Returns null for a request for one film - and for anything this cannot
 * be sure of - or what was asked for:
 *
 *   { count, requests, how }
 *
 * `count` is how many films the request names, or null when it asks for a
 * whole series in words ("all the harry potter movies"). `requests` is what
 * to send instead, each a request for one film without the prefix: the first
 * two films ("the equalizer", "the equalizer 2"), or for a series in words
 * the series' title alone. `how` is 'numbers', 'same-title' or 'series'.
 */
export function severalFilms(text) {
  const s = clean(text);
  if (!s) return null;

  // A whole series asked for in words.
  const series = SERIES_WORDS.exec(s) ?? ALL_THE.exec(s);
  if (series && namesSomething(tokenize(series[1]))) return { count: null, requests: [words(tokenize(series[1]))], how: 'series' };
  const all = X_ALL.exec(s);
  if (all) {
    const stem = tokenize(all[1]);
    const before = stem[stem.length - 1]?.t ?? '';
    if (namesSomething(stem) && !allBelongsToTitle(before) && stem[stem.length - 1]?.type === 'word') {
      return { count: null, requests: [words(stem)], how: 'series' };
    }
  }

  // Numbers after the title. "harry potter 1-8 movies", "rocky 1-6 all":
  // the word after the numbers is read past.
  const tokens = tokenize(s);
  let tail = tokens;
  while (tail.length && ['movies', 'films', 'all', 'both', 'together', 'parts'].includes(tail[tail.length - 1].t)
    && isNumber(tail[tail.length - 2])) tail = tail.slice(0, -1);
  const run = trailingRun(tail);
  if (run) {
    const stem = words(run.stem);
    return {
      count: run.films.length,
      requests: run.films.slice(0, 2).map((f) => filmRequest(stem, f, f.marker ?? run.marker)),
      how: 'numbers',
    };
  }

  const twice = sameTitleTwice(tokens);
  if (twice) return { count: twice.length, requests: twice.slice(0, 2), how: 'same-title' };
  return null;
}

/** A request line, with the group's prefix in front: "#request the equalizer". */
const line = (prefix, request) => `"${prefix ? `${prefix} ` : ''}${request}"`;

/** What to send instead: '"#request the equalizer", then "#request the equalizer 2"', and "and so on" past two. */
function sendInstead(found, prefix) {
  const [a, b] = found?.requests ?? [];
  if (!b) return `Send each film you want in a message of its own, e.g. ${line(prefix, a)}`;
  return `Send each on its own: ${line(prefix, a)}, then ${line(prefix, b)}${found.count > 2 ? ', and so on' : ''}`;
}

/**
 * The notifications-group line for a request refused for asking for several
 * films, in the operator's words: '☝️ "the equalizer 1 & 2" — one film per
 * request. Send each on its own: "#request the equalizer", then "#request
 * the equalizer 2"'. `prefix` is the one to suggest, a test's code included
 * (beta.js suggestPrefix): a tester who copies a suggestion without it is
 * ignored by the beta group.
 */
export function oneFilmNote(typed, found, prefix = '', emoji = '☝️') {
  const count = found?.count > 2 ? `${found.count} films; ` : '';
  return `${emoji ? `${emoji} ` : ''}"${String(typed ?? '').trim()}" — ${count}one film per request. ${sendInstead(found, prefix)}`;
}

/** The quoted reply in the request group, where replies on a refusal are on (replyOnBlock). */
export function oneFilmReply(found, prefix = '') {
  return `One film per request. ${sendInstead(found, prefix)}.`;
}

/** History's detail: "6 films in one request - told to send each on its own". */
export function oneFilmDetail(found) {
  const said = !found ? 'several films' : found.how === 'series' ? 'a whole series' : `${found.count} films`;
  return `${said} in one request - told to send each on its own`;
}
