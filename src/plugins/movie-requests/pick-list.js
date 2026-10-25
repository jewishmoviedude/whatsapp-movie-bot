/**
 * "Which one?" - offering the versions of a title the server holds several of.
 *
 * On 2026-09-22 a bare "venom" was answered with 📅 because the server holds
 * Venom from 1981, 2005, 2011 and 2018. That answer went to the notifications
 * group, which about half of the requesters are not in, so what most of them
 * saw was a calendar emoji and nothing else; those who worked it out retyped
 * the request with a year 80 to 177 seconds later. Same-title remakes are
 * about 2.6% of the catalogue and never more than five sendable versions of
 * one title, so the question can be asked properly instead: one reply in the
 * request group, quoting the request, listing what we actually have, and
 * taking a single digit as the answer.
 *
 * Later the same day, in the beta group, "#request harry potter" got no list
 * at all. No film is called plain "Harry Potter", so there were no versions
 * of one title to offer; OMDb resolved the words to its best search hit,
 * "...the Deathly Hallows: Part 2", and the bot queued that for a member who
 * had not chosen it (an admin cancelled it). The operator's rule since then:
 * a bare title offers every sendable film whose title STARTS WITH the words
 * typed - the franchise - even when one film has exactly that title ("cars"
 * is Cars, Cars 2 and Cars 3). Up to nine, one digit to answer; more than
 * that gets one reply asking for another word or the year.
 *
 * It was staged as the beta feature 'movie-pick-list' (beta001), because it
 * posts text in a request group of several hundred people where the bot had
 * posted none. It is not a flag any more. The operator had moved it out of
 * beta, but the mode lived in config.json, and on 2026-10-10 the live one
 * held `beta.features: {}`: Heat, Insomnia, Casino Royale, The Girl Next Door
 * and Venom were each asked "which year?" instead of being listed. "We
 * already moved that the bot should respond listing all out of beta, so why
 * didn't it work for those?" (the operator, 2026-10-11). So every request
 * group gets the list, whatever config.json says; only the year question's
 * own switch (requireYearWhenAmbiguous) decides whether it is asked at all.
 *
 * Everything in this file is pure - no WhatsApp, no disk, no clock unless one
 * is passed in. The state (open lists, timers, the journal) lives in the
 * plugin, next to the request pipeline it feeds.
 */
import { isBlockedRating } from './theatrical.js';
import { isOverridden } from '../../core/rating-overrides.js';
import { normalizeTitle, cleanRequestText, extractYear, startsWithWords, sameTitleWords } from '../../util/fuzzy.js';

/**
 * WhatsApp refuses to edit a message older than this. An edit of an older one
 * is wasted outbound, so every edit here is skipped past it - which matters
 * after a restart, when a list can have expired long ago.
 */
export const EDIT_WINDOW_MS = 15 * 60_000;

/**
 * A member who keeps sending wrong numbers gets a ❓ for each of the first
 * few and silence after that. One reaction per message is the right answer to
 * a mistake; an unbounded run of them is the bot being drawn into a chat.
 */
export const MAX_INVALID_REACTIONS = 3;

/**
 * A pick the bot then refuses gives the list back to its owner, but only
 * with this much of it left. Reopened with seconds to go, it would expire
 * almost at once, and the expiry's 📅 would replace the ⛔ that says why the
 * pick failed before anyone had read it.
 */
export const REOPEN_MIN_MS = 60_000;

/**
 * A list's final reaction is retried this long apart, and this many times in
 * all, when WhatsApp is down at the moment it expires. History says it
 * expired from the first attempt on; only the reaction is waited for.
 */
export const CLOSE_RETRY_MS = 2 * 60_000;
export const MAX_CLOSE_ATTEMPTS = 3;

/**
 * Outcomes that are about the chosen VERSION, so another version on the
 * same list may still work. Anything else (OMDb or the library down, a full
 * queue) is about the moment, and the same number may be tried again.
 */
export const VERSION_REFUSALS = new Set([
  'blocked-rating', 'not-found', 'not-in-library', 'wrong-film',
  'is-a-series', 'not-yet-theatrical', 'need-year',
]);

const num = (v, dflt, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : dflt;
};

/**
 * How long a list may run. A list ("movies with series", beta001 while it was
 * in beta) offers the whole series, however many films that is - the
 * operator's rule - so a reply may be two digits. Twenty is not a
 * franchise's length but a ceiling on how much the bot will post into a
 * request group in one message; past it the member is asked for another word
 * or the year, as before.
 */
export const MAX_PICK_OPTIONS = 20;

/**
 * The default maxOptions had before lists offered franchises. A saved 5 is
 * read as the new default, 9, because nobody chose it: ConfigStore.save()
 * writes the whole merged config back, defaults included, so every install
 * that saved any setting after the list shipped has `maxOptions: 5` in
 * config.json - the live one does - and the panel has no control for it.
 * Reading it this way is what lets the new default reach those installs
 * without a config migration writing to data/. The price is that a 5 set by
 * hand in config.json also means 9; every other value from 2 to 9 is
 * honoured as it stands.
 */
// And 9, the default after that, for the same reason: the live config.json
// holds `maxOptions: 9` because the defaults were saved, not because anyone
// chose nine, and a list offers the whole series.
const OLD_DEFAULT_MAX_OPTIONS = new Set([5, 9]);

/** The feature's settings with defaults, always in a usable shape. */
export function pickListSettings(cfg) {
  const p = cfg?.pickList ?? {};
  const maxOptions = OLD_DEFAULT_MAX_OPTIONS.has(Number(p.maxOptions)) ? MAX_PICK_OPTIONS : p.maxOptions;
  return {
    // Fractions are allowed only so a test can expire a list quickly; the
    // panel offers whole minutes.
    expiryMinutes: num(p.expiryMinutes, 10, 0.01, 60),
    maxOptions: Math.round(num(maxOptions, MAX_PICK_OPTIONS, 2, MAX_PICK_OPTIONS)),
    maxOpenPerGroup: Math.round(num(p.maxOpenPerGroup, 5, 1, 50)),
  };
}

/**
 * Words that say nothing about which film is meant. A bare title offers the
 * films that START with it only when it has at least one word of three
 * letters or more that is not one of these: "#request the" would otherwise
 * be answered with every film whose title begins "The". A title made only of
 * such words ("It", "Up", "Her") is still offered its same-title remakes,
 * exactly as before franchises were listed.
 */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'nor', 'but', 'with', 'from', 'into', 'onto', 'upon', 'over', 'about',
  'you', 'your', 'his', 'her', 'hers', 'him', 'she', 'they', 'them', 'their', 'our', 'its',
  'this', 'that', 'these', 'those', 'what', 'who', 'whom', 'how', 'why', 'when', 'where',
  'are', 'was', 'were', 'has', 'had', 'have', 'not', 'all', 'any', 'can', 'out', 'off', 'one',
  'part', 'chapter', 'episode', 'vol', 'volume', 'movie', 'movies', 'film', 'films', 'please',
]);

/** Does the typed title have a word worth matching the START of other titles on? */
export function hasSignificantWord(text) {
  return normalizeTitle(text).split(' ')
    .some((w) => (w.match(/[a-z]/g) ?? []).length >= 3 && !STOP_WORDS.has(w));
}

/** What a member types before a title, or '' when no prefix is required. */
export function requestPrefix(cfg) {
  return cfg?.requirePrefix ? String(cfg.prefix ?? '').trim() : '';
}

/** The copy-paste line for one version: "#request Venom 2018". */
export function requestLine(prefix, title, year) {
  return `${prefix ? `${prefix} ` : ''}${title} ${year}`;
}

/**
 * The versions a member may be offered, oldest first.
 *
 * "Sendable" is decided from the LIBRARY's rating, the same field the panel's
 * queue-from-a-link path trusts, with the operator's blocked list and the
 * existing unrated policy (`blockUnrated`) applied exactly as the request
 * pipeline applies them. The rule the operator set is that a list never
 * offers something the bot would then refuse: the example that started this
 * was John Wick, every version of which is R or TV-MA.
 *
 * Two things are stricter than the letter of that, because the request a
 * pick turns into is gated on OMDb's rating, which a list is decided without:
 *
 * - A copy with NO rating in Jellyfin is not offered, whatever blockUnrated
 *   says. queueLibraryItem refuses such a file outright ("Jellyfin leaves
 *   OfficialRating empty on plenty of files"), and here it said nothing at
 *   all about a film OMDb may well rate R: in review, Scarface 1983 with an
 *   empty library rating was listed, picked, and answered ⛔. An explicit
 *   "Not Rated" is a rating and follows blockUnrated as before.
 * - A copy its rating blocks is offered when the bypass list covers it - by
 *   the title and year, or by a Jellyfin link to that very copy. A link
 *   counts only when EVERY blocked copy of the film is linked, because a pick
 *   is sent by title and year and can land on any copy: a version cleared by
 *   one copy's link was listed as "Venom (1981) · R" and then ⛔.
 *
 * And a film its rating blocks is offered when the AI check could clear it
 * (`aiClears`, from aiCanClear). On 2026-09-30 at 02:17 UTC "$beta001 john
 * wick" found four John Wick films, all R, listed none of them, and fell
 * through to a single-film request that the AI check cleared ("nudity=false
 * by Groq -> cleared") and passed - the list alone still judged by the
 * rating, against the operator's rule that the AI only helps a rated film
 * through (content-check.js). Such a film is listed without the AI being
 * asked: Gemini allows twenty checks a day, and a list of four would spend
 * four on films nobody picked. The one film picked meets the same gates as
 * any request (contentGate), and if the check does not clear it, it is
 * refused ⛔ on its rating, struck through on the list, and the list stays
 * open for another pick (VERSION_REFUSALS). Such items carry `via: 'ai'`,
 * and those the bypass list sends `via: 'bypass'`.
 *
 * A film is offered only when every copy of it is a sendable FILM, because
 * the pipeline picks a copy by title and year and could land on any of them.
 * A version with no year cannot be asked for by year, so it is left off.
 *
 * `title` keeps only that exact title (the remakes of one film); `startsWith`
 * keeps every title that is it or begins with it, whole words (a franchise -
 * see startsWithWords). One entry per title and year, oldest first, then by
 * title.
 */
export function listableVersions(versions, cfg, { store = null, title = null, startsWith = null, aiClears = false } = {}) {
  const wanted = title ? normalizeTitle(title) : null;
  const blocked = cfg?.blockedRatings ?? [];
  const blockUnrated = cfg?.blockUnrated === true;
  const out = [];
  const seen = new Set();
  for (const v of versions ?? []) {
    const year = Number(v?.year) || null;
    const key = `${normalizeTitle(v?.title)}|${year}`;
    if (!year || seen.has(key)) continue;
    const types = Array.isArray(v.types) ? v.types : [v.type ?? null];
    if (types.some((t) => t && t !== 'Movie')) continue;
    if (wanted && !sameTitleWords(v.title, title)) continue;
    if (startsWith && !startsWithWords(v.title, startsWith)) continue;
    const ratings = Array.isArray(v.ratings) && v.ratings.length ? v.ratings : [v.rated ?? null];
    if (ratings.some((r) => !String(r ?? '').trim())) continue;
    // Each copy's id beside its rating; a version from before ids were
    // carried is one copy, whose id is the version's.
    const ids = Array.isArray(v.ids) ? v.ids : (ratings.length === 1 ? [v.id ?? null] : []);
    const blockedCopies = ratings.map((r, i) => ({ r, id: ids[i] ?? null }))
      .filter(({ r }) => isBlockedRating(r, blocked, { blockUnrated }));
    let via = null;
    if (blockedCopies.length) {
      const byTitle = store && isOverridden(store, { title: v.title, year });
      const byLink = store && blockedCopies.every(({ id }) => id && isOverridden(store, {}, { id }));
      if (byTitle || byLink) via = 'bypass';
      else if (aiClears) via = 'ai';
      else continue;
    }
    seen.add(key);
    out.push({ id: v.id ?? null, title: v.title, year, rated: v.rated ?? null, ...(via ? { via } : {}) });
  }
  return out.sort((a, b) => (a.year - b.year) || String(a.title).localeCompare(String(b.title)));
}

/** Do all these films carry one title (remakes), rather than a franchise's several? */
export function oneTitle(items) {
  return items.length > 0 && items.every((v) => normalizeTitle(v.title) === normalizeTitle(items[0].title));
}

/**
 * How a set of films reads in a log line or a History detail: the years for
 * the remakes of one title, as it always did ("2005, 2011, 2018"), and
 * "Title (Year)" once the titles differ.
 */
export function offeredLabels(items) {
  return oneTitle(items) ? items.map((v) => v.year) : items.map((v) => `${v.title} (${v.year})`);
}

/**
 * What a bare title leads to, from the library alone - before OMDb or
 * Gemini is asked anything:
 *
 *   { kind: 'none' }                   carry on exactly as before
 *   { kind: 'only', item }             one film can be sent: go ahead with it
 *   { kind: 'list', items }            2..maxOptions: offer them
 *   { kind: 'narrow', items, atLeast } more than that: ask for another word
 *                                      or the year
 *
 * each with `why` for the log, and `versions`: every film that matched,
 * sendable or not.
 *
 * `found` is what libraryVersions returned. A title with a significant word
 * is matched as the start of other titles (the franchise); one without is
 * matched exactly, which is all the list did before, so "#request the" never
 * lists and "It" still offers its remakes.
 *
 * A title held once, under exactly the words typed, with nothing else
 * starting with them, is 'none': there is nothing to ask and nothing to
 * correct, and the request runs as it always has - unless `searchTerm` says
 * the pipeline will look up something shorter than what was matched, when
 * "as it always has" is a different film. A single sendable film
 * reached any other way - the only Harry Potter on a server, or the one
 * Frozen that is not R - is 'only', and is asked for by title and year;
 * unless a film with exactly the typed title is held and cannot be sent,
 * when a different title is not gone ahead with unasked. That is beta001's
 * rule as the operator approved it, and it went to every group with the
 * list on 2026-10-11 ("paddington" sends Paddington 2, and a bare
 * "barefoot" Barefoot Gen, where the server holds nothing else starting
 * with the word). When OMDb does not know the library's title, the request
 * is looked up by the words typed instead (lookupHeldFilm in step-zero.js).
 *
 * When the search came back full, films it did not see may start with the
 * same words, so it never lists or picks one: it asks to narrow down when it
 * can already see more than one, and otherwise leaves the request alone.
 */
export function decidePickList(query, found, cfg, {
  store = null, maxOptions = MAX_PICK_OPTIONS, searchTerm = null, aiClears = false,
} = {}) {
  const franchise = hasSignificantWord(query);
  const wanted = normalizeTitle(query);
  const versions = (found?.versions ?? []).filter((v) => (franchise
    ? startsWithWords(v.title, query) : sameTitleWords(v.title, query)));
  const items = listableVersions(versions, cfg, franchise ? { store, startsWith: query, aiClears } : { store, title: query, aiClears });
  // The search filling up only matters to a franchise: remakes of one title
  // are matched exactly, as they were before the limit was raised.
  const full = franchise && !!found?.full;
  const out = (o) => ({ ...o, items, versions });
  // The films called EXACTLY what was typed, which is what this list offered
  // before franchises were added. When too many titles start with the words -
  // "cinderella" starts 13 on this server, "batman" 22 - answering "add a word"
  // throws away the remakes the member most likely meant. So the exact ones are
  // listed, with a line saying other titles start with it too.
  const exact = items.filter((it) => sameTitleWords(it.title, query));
  // Only when those remakes are a real share of what matched. Cinderella is 5
  // of 13 and Godzilla 3 of 12, which is what the member meant; Batman is 3 of
  // 22 (1966, 1989 and The Batman), where offering only those hides Batman
  // Begins and the rest, so "add a word" with an example serves them better.
  const remakesAreThePoint = exact.length >= 2 && exact.length <= maxOptions
    && exact.length * 4 >= items.length;
  const tooMany = (why) => (remakesAreThePoint
    ? { ...out({ kind: 'list', why: `${why}; listing the ${exact.length} called exactly that` }),
        items: exact, moreStartWith: items.length - exact.length }
    : null);
  if (!items.length) {
    return out({ kind: 'none', why: versions.length ? `none of the ${versions.length} can be sent` : 'nothing on the server matches' });
  }
  if (full && items.length > 1) {
    return tooMany('the search came back full')
      ?? out({ kind: 'narrow', atLeast: true, why: `the search came back full, with at least ${items.length} sendable` });
  }
  if (full) return out({ kind: 'none', why: 'the search came back full, so one match may not be the only one' });
  if (items.length === 1) {
    const onlyIsExact = sameTitleWords(items[0].title, query);
    // Standing aside is only safe while the ordinary pipeline would look up
    // the same words this matched on. It strips "movie" and "film"
    // (cleanRequestText), so "#request the garfield movie" is looked up as
    // "the garfield" and lands on Garfield (2004) - not the film held under
    // exactly the name typed. When the two differ, the film is asked for by
    // title and year like any other single match.
    const sameWords = !searchTerm || normalizeTitle(searchTerm) === wanted;
    if (versions.length === 1 && onlyIsExact && sameWords) {
      return out({ kind: 'none', why: 'held once, under exactly that title' });
    }
    // "alien" with Alien (R) held and Alien Xmas the one film starting with
    // it that could be sent: a list may offer another title - it is a
    // question - but going ahead without asking would queue a film nobody
    // chose, which is what happened with the Deathly Hallows. The request
    // carries on to the refusal of the film that was named.
    if (!onlyIsExact && versions.some((v) => sameTitleWords(v.title, query))) {
      return out({ kind: 'none', why: 'the film called exactly that cannot be sent, and another title was not asked for' });
    }
    return out({ kind: 'only', item: items[0],
      why: versions.length > 1 ? `only one of ${versions.length} can be sent` : 'the only film that starts with it' });
  }
  if (items.length > maxOptions) {
    return tooMany(`${items.length} sendable is more than a list offers (${maxOptions})`)
      ?? out({ kind: 'narrow', atLeast: false, why: `${items.length} sendable is more than a list offers (${maxOptions})` });
  }
  return out({ kind: 'list', why: `${items.length} sendable` });
}

/** The last version on the list that can still be picked - what a list suggests typing. */
function lastOpen(items, refused = []) {
  for (let i = items.length - 1; i >= 0; i -= 1) if (!refused.includes(i)) return items[i];
  return items[items.length - 1];
}

/**
 * The one message a member sees. The operator set the wording for beta001 on
 * 2026-09-22 ("Search Results:", then "1 Title (Year) - plot" a line each),
 * and on 2026-09-30, reading those lists in the testing group, asked for it
 * laid out properly: "the response from bot is in messy format, message needs
 * to be neater paragraphed". So it is WhatsApp paragraphs now, with a blank
 * line between each:
 *
 *   🔍 *Search results for "john wick"*
 *
 *   *1.* John Wick (2014)
 *   _An ex-hit-man comes out of retirement to track down…_
 *
 *   *2.* John Wick: Chapter 2 (2017)
 *
 *   Reply with a number (1–2), or react with it, to get it. This list expires in 10 minutes.
 *
 * `query` is the words the member typed, with the prefix and any test code
 * already gone; a list journalled before it was kept has none, and its header
 * then says only "Search results". The year stays: remakes share a title
 * (Venom is four films), and it is the year that tells them apart. The plot
 * is OMDb's, shortened (see listPlots in omdb.js), in italics on its own
 * line, and a film OMDb had none for is listed without one. `refused` holds
 * the indexes of versions the bot turned down after they were picked; the
 * list is edited to strike those through and stays open for the rest (see
 * REOPEN_MIN_MS). `prefix` is accepted and unused: a list no longer spells
 * out a request line to copy, though one sent is still taken as a pick.
 *
 * Nothing a member answers with is read off this text - parsePick works from
 * the journalled items - so the asterisks and the dash in "1–3" cannot change
 * what a reply of "3" or "$beta004 3" means.
 */
export function formatPickList(items, { minutes = 10, refused = [], moreStartWith = 0, test = false, query = '' } = {}) {
  const words = plainText(query).replace(/"/g, '');
  const blocks = [words ? `🔍 *Search results for "${words}"*` : '🔍 *Search results*'];
  items.forEach((v, i) => {
    const film = `${plainText(v.title)} (${v.year})`;
    // A refused film is struck through whole, number and all, and loses its
    // plot: it is no longer on offer, and the short line says so. The number
    // is not bolded inside the strike, because WhatsApp's apps render nested
    // markers unevenly.
    if (refused.includes(i)) {
      blocks.push(`~${i + 1}. ${film}~ — can't be sent`);
      return;
    }
    const plot = plainText(v.plot);
    blocks.push(`*${i + 1}.* ${film}${plot ? `\n_${plot}_` : ''}`);
  });
  // Only the films called exactly that are listed when many titles start with
  // the words; say so, or a member looking for "A Cinderella Story" would read
  // the list as all we hold.
  if (moreStartWith > 0) {
    blocks.push(`${moreStartWith} other film${moreStartWith === 1 ? '' : 's'} start with that too — send its full name for one of those.`);
  }
  // A test in the beta group downloads nothing (beta.js), so its list must
  // not say a number gets one, any more than its ✔ edit may.
  //
  // A number can also be given by reacting to the list with it (the
  // operator, 2026-10-01: "for beta001 users should be able to react with a
  // number emoji instead of replying"). The keycaps stop at 🔟, so a longer
  // list says reacting covers only its first ten.
  const span = `(1–${items.length})`;
  const get = test ? 'test it' : 'get it';
  const how = items.length <= MAX_REACTION_PICK
    ? `Reply with a number ${span}, or react with it, to ${get}.`
    : `Reply with a number ${span} to ${get}, or react 1️⃣–🔟 for one of the first ten.`;
  blocks.push(`${how}${test ? ' Nothing is downloaded.' : ''} This list expires in ${formatMinutes(minutes)}.`);
  return blocks.join('\n\n');
}

/**
 * The highest number a reaction can give. WhatsApp's keycap emoji run from
 * 0️⃣ to 9️⃣, then 🔟; there is no keycap for 11, so a pick past ten is typed.
 */
export const MAX_REACTION_PICK = 10;

/**
 * The number a keycap reaction stands for: 0 to 9 for 0️⃣..9️⃣, 10 for 🔟,
 * null for any other emoji.
 *
 * A keycap is the digit, the variation selector U+FE0F, then U+20E3. Some
 * keyboards and older phones send it without the selector ("1⃣"), and it
 * means the same, so both are read. #️⃣ and *️⃣ are keycaps too, and not
 * numbers. 0️⃣ is returned as 0 and not null, because a member who reacts
 * with it is answering the list just as one who types "0" is, and is told
 * the same thing (❓, not on the list).
 */
export function keycapNumber(emoji) {
  const s = String(emoji ?? '').trim();
  if (s === '🔟') return 10;
  const m = /^([0-9])️?⃣$/u.exec(s);
  return m ? Number(m[1]) : null;
}

/**
 * The ids of a list's own messages, which a reaction must be on to count as
 * a pick: the message the list was posted as, and any other message that
 * carries it - a list sent in parts, or the one answer a $stamtest is given
 * (onStamAnswered), which is where a tester sees a list that test opened.
 */
export function listMessageIds(list) {
  const ids = [list?.listKey?.id, ...(Array.isArray(list?.listIds) ? list.listIds : [])];
  return [...new Set(ids.filter((id) => typeof id === 'string' && id))];
}

/**
 * Text that goes between WhatsApp's formatting markers. A plot or a title
 * carrying its own * _ ~ or ` would close the italics early or open a stray
 * bold, so those characters are taken out (an underscore joining two words
 * becomes a space), and the ends trimmed, since WhatsApp does not format
 * "_ text_".
 */
export function plainText(s) {
  return String(s ?? '').replace(/(\w)_(?=\w)/g, '$1 ').replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim();
}

function formatMinutes(m) {
  if (m >= 1) {
    const r = Math.round(m);
    return `${r} minute${r === 1 ? '' : 's'}`;
  }
  const s = Math.max(1, Math.round(m * 60));
  return `${s} second${s === 1 ? '' : 's'}`;
}

/**
 * The list, edited once the chosen version has been QUEUED.
 *
 * `sent` is the film the request actually queued. It is normally the listed
 * one, possibly with OMDb's year a year off Jellyfin's, and then the list's
 * own words are kept. When the request settled on something else - the file
 * re-check adopting the file's own metadata under another name - the edit
 * names what is really coming, without the number, instead of promising the
 * one that is not.
 *
 * It no longer settles on another year's copy. That once happened when the
 * listed file had left the library: the pipeline adopted the 2005 Venom for
 * a pick of 2011, as it then did for "#request Venom 2011". Since 2026-09-29
 * the year asked for holds (typedYearOf in util/fuzzy.js), and such a pick is
 * not in the library.
 */
export function formatPicked(n, item, sent = null, { test = false } = {}) {
  const same = !sent?.title || (normalizeTitle(sent.title) === normalizeTitle(item.title)
    && (!sent.year || Math.abs(sent.year - item.year) <= 1));
  // A test in the beta group sends nothing (beta.js), so its list must not
  // promise the film is coming.
  const end = test ? 'test passed, nothing sent' : 'on its way';
  return same
    ? `✔ ${n} · ${item.title} (${item.year}) — ${end}`
    : `✔ ${sent.title}${sent.year ? ` (${sent.year})` : ''} — ${end}`;
}

/**
 * The list, edited when the chosen version was NOT queued and the list could
 * not be reopened. No ✔: next to a ⛔, ⚠️ or ❓ on the request, a check mark
 * read as success. The reaction on the request says what happened.
 */
export function formatPickFailed(n, item, status) {
  const why = VERSION_REFUSALS.has(status) ? "can't be sent" : "didn't go through; see the reaction on the request";
  return `${n} · ${item.title} (${item.year}) — ${why}`;
}

/** The list, edited once it has run out. */
export function formatExpired(items, { prefix = '', refused = [] } = {}) {
  const last = lastOpen(items, refused);
  return `expired — send ${requestLine(prefix, last.title, last.year)}`;
}

/** The list, edited when the same member asked again and got a newer one. */
export function formatReplaced() {
  return 'replaced — see the newer list';
}

/**
 * The notifications-group line for "add a year".
 *
 * It used to read "📅 Venom (2018) — more than one match; add a year (e.g.
 * Dune 2021)": the year in brackets looked like the film we had picked, and
 * the example was a different film altogether. It now lists the years the
 * server holds that could actually be sent, with a line that can be copied
 * and sent as it is.
 */
export function needYearNote(title, years, prefix = '') {
  if (!years.length) return `📅 ${title} — more than one version on the server; send it again with the year`;
  return `📅 ${title} — we have ${years.join(', ')}. Send ${requestLine(prefix, title, years[years.length - 1])}`;
}

/**
 * The one reply for a bare title that more films start with than a list
 * can offer: '22 films start with "Batman" — add a word or the year, e.g.
 * #request Batman Begins'. It names the count so the member knows why there
 * is no list, and gives an example that narrows it when sent as it is.
 *
 * The example is the shortest title on the server that says more than what
 * was typed (newest first on a tie) - the easiest to type, and usually the
 * best known. When every match carries the typed title (a dozen Hamlets) no
 * longer title exists, and the example is that title with its latest year.
 * `atLeast` says the search came back full and there may be more.
 */
export function narrowDownText(typed, items, { prefix = '', atLeast = false } = {}) {
  const longer = items.filter((v) => !sameTitleWords(v.title, typed))
    .sort((a, b) => (normalizeTitle(a.title).length - normalizeTitle(b.title).length) || (b.year - a.year))[0];
  const last = items[items.length - 1];
  const example = longer ? `${prefix ? `${prefix} ` : ''}${longer.title}` : requestLine(prefix, last.title, last.year);
  return `${atLeast ? 'At least ' : ''}${items.length} films start with "${typed}" — add a word or the year, e.g. ${example}`;
}

/**
 * Is this message the owner answering their list?
 *
 *   { index, form }   a pick: form is 'digit', 'prefixed' or 'title-year'
 *   { invalid: true } a single digit that is not on the list - the list stays
 *                     open and the member is told
 *   null              not an answer at all; handle it like any other message
 *
 * A bare single digit is the only unprefixed message the bot ever acts on.
 * "#request N" counts only while N is on the list: past that it is a title,
 * and there are films called 21 and 1984.
 *
 * A list now runs to nine, so "#request 9" from the member whose nine-item
 * list is open is a pick, not the 2009 film "9". Nothing is lost by that: a
 * one-character title has never been looked up at all (the request handler
 * ignores anything shorter than two characters), so "#request 9" did not
 * find the film before either, and "#request 9 2009" still does. With no
 * list open, or a shorter one, "#request 9" is handled exactly as before.
 *
 * A title and a year are taken as the pick they name, because the list
 * itself tells the member to send one ("#request Venom 2018"), and as a fresh
 * request it would open the question again rather than answer it - and, when
 * written, meet the 30-second cooldown the original request then started
 * (since 2026-10-01 a list no longer starts it). That is either a listed film's own title, or - for a franchise -
 * the words the member first typed with a year only one listed film has
 * ("#request harry potter 2004"), which is what "add the year" invites.
 */
export function parsePick(text, list, prefix = '') {
  const t = String(text ?? '').trim();
  const n = list?.items?.length ?? 0;
  if (!t || !n) return null;
  // One or two digits, since a whole series can run past nine. Never more:
  // "2014" is somebody sending a year, not picking the 2014th film.
  if (/^\d{1,2}$/.test(t)) {
    const d = Number(t);
    return d >= 1 && d <= n ? { index: d - 1, form: 'digit' } : { invalid: true, form: 'digit' };
  }
  let rest = t;
  if (prefix) {
    if (!t.toLowerCase().startsWith(prefix.toLowerCase())) return null;
    rest = t.slice(prefix.length).trim();
  }
  if (/^\d+$/.test(rest)) {
    if (!prefix) return null;
    const d = Number(rest);
    return d >= 1 && d <= n ? { index: d - 1, form: 'prefixed' } : null;
  }
  const year = extractYear(rest);
  if (year) {
    // "movie" and "film" are kept here for the same reason the list matches
    // on them (see cleanRequestText): without them the list's own suggestion
    // for a film called Scary Movie 2 came back as "scary 2", matched no
    // listed title, and was run as a fresh request - straight into the
    // 30-second cooldown the original request had then just started.
    const typed = normalizeTitle(cleanRequestText(rest, { keepMediaWords: true }));
    const asked = normalizeTitle(cleanRequestText(list.request ?? list.title, { keepMediaWords: true }));
    const named = list.items.findIndex((v) => v.year === year && normalizeTitle(v.title) === typed);
    if (named >= 0) return { index: named, form: 'title-year' };
    const inYear = typed && typed === asked ? list.items.filter((v) => v.year === year) : [];
    if (inYear.length === 1) return { index: list.items.indexOf(inYear[0]), form: 'title-year' };
  }
  return null;
}

/**
 * Does this message look like an answer to `list` - a bare digit (on the list
 * or not), or "#request N" with N on it? The list's suggestion typed back
 * ("#request Venom 2018") is not counted: that is a full request.
 *
 * Used for the numbers that are NOT a live pick: someone else's, and the
 * owner's after their pick was taken. Neither is acted on, and neither is
 * handed to moderation - the list invited exactly these messages.
 */
export function answersList(text, list, prefix = '') {
  const p = parsePick(text, list, prefix);
  return !!p && (p.form === 'digit' || p.form === 'prefixed');
}

/** Bare JID: no ":device" suffix, which the same person's messages vary in. */
const bareJid = (j) => (typeof j === 'string' && j.includes('@') ? j.replace(/:\d+(?=@)/, '') : null);
const digitsOf = (who) => {
  const n = String(who?.number ?? '').replace(/[^0-9]/g, '');
  if (n.length >= 7) return n;
  const j = bareJid(who?.jid);
  return j && j.endsWith('@s.whatsapp.net') ? j.split('@')[0] : null;
};

/**
 * Same person? Matched the way the bot matches members everywhere else
 * (isGroupAdmin, groupMemberInfo): the JID first, then the phone number, so a
 * sender seen once as an opaque @lid and once as a phone JID is still one
 * person when WhatsApp told us their number.
 */
export function sameSender(a, b) {
  const ja = bareJid(a?.jid);
  const jb = bareJid(b?.jid);
  if (ja && jb && ja === jb) return true;
  const da = digitsOf(a);
  const db = digitsOf(b);
  return !!da && da === db;
}

const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/**
 * Counters for the operator, read straight off the history rows - every row
 * that showed a list carries its `pickList` record, and every row answered
 * with "add a word or the year" its `pickNarrow` - so there is no second
 * store to drift from what History says.
 *
 * `narrowed` is counted apart from `shown`: it is a reply, not a list, and
 * how often it happens is what says whether nine is the right size.
 */
export function summarisePickLists(rows = [], { since = 0 } = {}) {
  const shown = rows.filter((r) => r?.pickList?.shownAt && r.pickList.shownAt >= since);
  const narrowed = rows.filter((r) => r?.pickNarrow?.at && r.pickNarrow.at >= since);
  const outcome = (o) => shown.filter((r) => r.pickList.outcome === o).length;
  const pickMs = shown.map((r) => r.pickList.pickMs).filter((x) => Number.isFinite(x));
  const med = median(pickMs);
  return {
    shown: shown.length,
    picked: outcome('picked'),
    expired: outcome('expired'),
    replaced: outcome('replaced'),
    open: shown.filter((r) => !r.pickList.outcome).length,
    invalid: shown.reduce((n, r) => n + (r.pickList.invalid ?? 0), 0),
    narrowed: narrowed.length,
    units: shown.reduce((n, r) => n + (r.pickList.units ?? 0), 0)
      + narrowed.reduce((n, r) => n + (r.pickNarrow.units ?? 0), 0),
    medianPickSec: med == null ? null : Math.round(med / 1000),
  };
}

/** One line for the daily digest, or null when no list was shown and nothing was too broad for one. */
export function pickListLine(rows, opts) {
  const s = summarisePickLists(rows, opts);
  if (!s.shown && !s.narrowed) return null;
  return `  Pick lists       : ${s.shown} shown, ${s.picked} picked, ${s.expired} expired`
    + `${s.replaced ? `, ${s.replaced} replaced` : ''}`
    + `, ${s.invalid} wrong number${s.invalid === 1 ? '' : 's'}`
    + `${s.medianPickSec != null ? `, median ${s.medianPickSec}s to pick` : ''}`
    + `${s.narrowed ? `, ${s.narrowed} too broad for a list` : ''}`
    + ` (${s.units} outbound: lists, replies, reactions, edits)`;
}
