/**
 * Words for the episodes a TV request loses to tvRequests.blockedRatings.
 *
 * An episode can carry a harder rating than its series, and the plugin filters
 * each one. Which episodes that drops is the owner's policy and is decided in
 * index.js; nothing here decides it. What was missing was saying so.
 *
 * Fullmetal Alchemist: Brotherhood (TV-14) season 1 has 64 episodes, and 14,
 * 19 and 26 are rated TV-MA. The requester was told "61 episode(s) - added to
 * the queue", History said "61 episode(s) posted", and the only trace of the
 * other three was an INFO line in the log. They reported the three as "did
 * not go through", asked for S01E14 on its own twice on 2026-09-28 and got a
 * bare ⛔ each time, then asked for the whole season again, which posted the
 * same 61 and left out the same three, still without a word.
 */
import { isEnabled } from '../../core/beta.js';

/**
 * The beta flag (src/core/beta.js) for everything a group member is TOLD about
 * a rating withhold: the "added" line naming the withheld episodes, the
 * "⛔ ... rated TV-MA, can't be posted" line and the replyOnBlock replies. Off
 * is the bot as it was - a bare "61 episode(s)" and a bare ⛔ - because group
 * text goes through the beta group first. History, the log and the panel's
 * manual queue are the owner's and name the withheld episodes whatever the mode.
 */
export const RATING_NOTICE_FEATURE = 'tv-rating-notice';

/**
 * Whether a request from this chat is told about its withheld episodes. Asked
 * once, at intake, with the chat the request came from (beta.js isEnabled).
 */
export const ratingNoticeOn = (config, chatJid) => isEnabled(config, RATING_NOTICE_FEATURE, chatJid);

const numberOf = (e) => (e?.episode != null && Number.isFinite(Number(e.episode)) ? Number(e.episode) : null);

/**
 * Which episode an item is, so two library items for one episode count once.
 * Jellyfin lists a second file of an episode (a re-rip in another folder, a
 * second version it did not merge) as an item of its own, with the same
 * season and number. An item with no number is only itself.
 */
const episodeKey = (e) => {
  const n = numberOf(e);
  return n == null ? null : `${e.season ?? ''}:${n}`;
};

/**
 * The episodes to name as withheld: those the rating filter took out, less
 * any that went out anyway as another copy of the same episode. Two items for
 * S01E14, one TV-14 and one TV-MA, send the TV-14 one; telling the requester
 * that E14 was both added and left out would be wrong. Which items are queued
 * is not changed by this - only what is said about them.
 */
export function withheldFrom(tooStrong, allowed) {
  const sent = new Set((allowed ?? []).map(episodeKey).filter(Boolean));
  return (tooStrong ?? []).filter((e) => {
    const k = episodeKey(e);
    return !(k && sent.has(k));
  });
}

/**
 * Consecutive episode numbers folded into ranges: [1, 2, 3, 5, 7, 8] becomes
 * ['1–3', '5', '7', '8']. Only a run of three or more is folded, because
 * "7–8" reads worse than "7 and 8" and saves nothing.
 */
export function compactRuns(numbers) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
    if (j - i >= 2) out.push(`${sorted[i]}–${sorted[j]}`);
    else for (let k = i; k <= j; k += 1) out.push(String(sorted[k]));
    i = j + 1;
  }
  return out;
}

/**
 * The episode numbers a History field names by their codes, as describeWithheld's
 * `detail` and a list's `absent` write them: "3 withheld (TV-MA): E14, E19,
 * E26", "1 not on the server: E30", "E1–E3". Read for the hourly check's
 * scan and for the episodes a member was sent (index.js _sentAlready); none
 * past a thousand in one run.
 */
export function numbersInCodes(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/\bE(\d+)(?:\s*[–-]\s*E?(\d+))?/g)) {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let n = a; n <= b && n - a < 1000; n++) out.push(n);
  }
  return out;
}

/** "a", "a and b", "a, b and c". */
export function listProse(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/**
 * Everything the requester, the panel and the log are told about the episodes
 * the rating filter withheld, or null when it withheld none - so a request
 * that lost nothing reads exactly as it always did.
 *
 *   count     3
 *   ratings   ['TV-MA']
 *   clauses   "Episodes 14, 19 and 26 are rated TV-MA"
 *   sentence  "Episodes 14, 19 and 26 are rated TV-MA, which can't be posted,
 *              so they were left out."
 *   detail    "3 withheld (TV-MA): E14, E19, E26"   (History and the log)
 *
 * A rating is shown as it is compared, upper-cased, and the episodes are
 * grouped under each rating in the order they first appear. `count` is
 * episodes, not library items (see episodeKey).
 */
export function describeWithheld(episodes) {
  // One entry per episode, not per library item: two TV-MA files of S01E14
  // are one withheld episode, not "2 withheld: E14" or "Episodes 14 are".
  const seen = new Set();
  const list = (episodes ?? []).filter(Boolean).filter((e) => {
    const k = episodeKey(e);
    if (k == null) return true;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!list.length) return null;

  const groups = new Map();
  for (const e of [...list].sort((a, b) => (numberOf(a) ?? Infinity) - (numberOf(b) ?? Infinity))) {
    const rating = String(e.rating ?? '').toUpperCase() || 'unrated';
    if (!groups.has(rating)) groups.set(rating, { numbers: [], others: [] });
    const n = numberOf(e);
    // An episode with no number (a special Jellyfin has not indexed) is named
    // by its title instead of being silently left off the list.
    if (n == null) groups.get(rating).others.push(e.title ? `"${e.title}"` : 'one without a number');
    else groups.get(rating).numbers.push(n);
  }

  const ratings = [...groups.keys()];
  const prose = [];
  const codes = [];
  for (const [rating, g] of groups) {
    const items = [...compactRuns(g.numbers), ...g.others];
    const many = g.numbers.length + g.others.length > 1;
    prose.push(`${many ? 'episodes' : 'episode'} ${listProse(items)} ${many ? 'are' : 'is'} rated ${rating}`);
    codes.push({ rating, text: [...compactRuns(g.numbers).map((r) => `E${r.replace('–', '–E')}`), ...g.others].join(', ') });
  }

  const clauses = listProse(prose).replace(/^e/, 'E');
  const count = list.length;
  return {
    count,
    ratings,
    clauses,
    sentence: `${clauses}, which can't be posted, so ${count === 1 ? 'it was' : 'they were'} left out.`,
    detail: codes.length === 1
      ? `${count} withheld (${codes[0].rating}): ${codes[0].text}`
      : `${count} withheld on rating — ${codes.map((c) => `${c.rating}: ${c.text}`).join('; ')}`,
  };
}
