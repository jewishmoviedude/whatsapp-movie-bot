/**
 * The next part of a TV request to ask for, and the one message that asks
 * for it: "#request Arrow S01E11-E20".
 *
 * Two things tell a member to send it, both of 2026-10-12. A request the
 * episode limit cuts as it is made (cap-cut.js: the operator's "why is the
 * flash converting 23 episodes if it's max 10 per request?"), and a request
 * queued before the limit was set, trimmed to it afterwards (trim-queued.js:
 * "fix the current queue that only 10 epsiodes max per req"). Each worked
 * the part out in its own way, and wrote the message in its own words: the
 * cut gave a part ten of the episodes left out, however many numbers it
 * spanned, and the trim ten numbers. Arrow season 1 with Bea's E15-E18
 * waiting already was told "S01E11-E23" by the cut - by the time Ari sent
 * it, Bea's four were posted, so they were queued and posted again, and the
 * thirteen numbers were cut a second time (found in review). The member's
 * reply, the finished notice and the trim's reply all ask for a part from
 * here now, in the same words.
 *
 * A part is one run of codes, as a member types it - "S01E11-E20", never a
 * comma list - which parse.js reads back as that season and that run:
 *
 *   - it spans at most the limit's worth of episode NUMBERS, so whatever the
 *     run takes in, it can never queue more than one request may, and is
 *     never cut again;
 *   - it stops short of any episode still coming - queued by this request,
 *     in hand, or waiting for another - so it never asks for one that will
 *     have been posted by the time it is sent;
 *   - for a list ("S01E06, E09, E12"), it never takes in a number the list
 *     did not name: a run is every episode between its ends;
 *   - a double-episode file (S02E21-E22, jellyfin-tv.js) is never split.
 *
 * Pure and side-effect free.
 */
import { pad, parseTvRequest } from './parse.js';
import { episodeOrder } from './naming.js';
import { plainText } from '../movie-requests/pick-list.js';

/** An item's episode number, or null for one the library never numbered. */
export const numberOf = (e) => (e?.episode != null && Number.isFinite(Number(e.episode)) ? Number(e.episode) : null);

/** The last episode an item holds: a double-episode file (S02E21-E22) answers for both (jellyfin-tv.js). */
export const lastOf = (e) => {
  const n = numberOf(e);
  const end = Number(e?.episodeEnd);
  return n != null && Number.isFinite(end) && end > n ? end : n;
};

/** Every episode number an item holds. */
export const numbersOf = (e) => {
  const n = numberOf(e);
  return n == null ? [] : Array.from({ length: lastOf(e) - n + 1 }, (_, i) => n + i);
};

/**
 * Every part the episodes `left` out of a request are asked for in, in
 * order, as { season, from, to } - the first is the next part. `coming` is
 * what will be posted without being asked for again (this request's
 * episodes, and those waiting for another request), `max` the limit, and
 * `only` the numbers a list named (null for a season or a run, which take in
 * every number between their ends). An episode with no number is in no
 * part; the caller says so in words.
 */
export function partsOf({ season, left = [], coming = [], max, only = null }) {
  const limit = Number(max);
  if (!(limit > 0)) return [];
  const soon = new Set(coming.flatMap(numbersOf));
  const named = Array.isArray(only) ? new Set(only.map(Number)) : null;
  const between = (a, b) => Array.from({ length: Math.max(0, b - a - 1) }, (_, i) => a + 1 + i);
  const parts = [];
  let part = null;
  for (const e of left.filter((x) => numberOf(x) != null).sort(episodeOrder)) {
    const from = numberOf(e);
    const to = lastOf(e);
    // Coming anyway, or a second copy of one already in the part.
    if (soon.has(from) || (part && to <= part.to)) continue;
    // The span is checked first, so the gap read below is never longer
    // than the limit.
    if (part && to - part.from + 1 <= limit
      && !between(part.to, from).some((n) => soon.has(n) || (named && !named.has(n)))) {
      part.to = to;
      continue;
    }
    if (part) parts.push(part);
    part = { season, from, to };
  }
  if (part) parts.push(part);
  return parts;
}

/** "S01E11-E20", or "S01E23" for one episode: a part as a member types it, with a plain hyphen. */
export function partCode(part) {
  if (!part || part.season == null || part.from == null) return null;
  return part.from === part.to
    ? `S${pad(part.season)}E${pad(part.from)}`
    : `S${pad(part.season)}E${pad(part.from)}-E${pad(part.to)}`;
}

/**
 * The message a member sends for a part, "#request Arrow S01E11-E20": `name`
 * the show as the library names it, as the "which season?" example has it,
 * and `prefix` the one the request group needs - none when requirePrefix is
 * off or for the panel's queue box, the test's code in front of it for a
 * test (beta.js suggestPrefix): copied without it, it would be ignored.
 * Read back as onMessage reads a request once the prefix is off, it must be
 * exactly that season and that run. A show parse.js would read otherwise
 * ("Show S02E01-E05") gets null, and the member is asked to ask again in
 * their own words rather than handed a message that would queue something
 * else.
 */
export function nextAsk(part, { name, prefix = '' } = {}) {
  const code = partCode(part);
  const show = plainText(name);
  if (!code || !show) return null;
  const back = parseTvRequest(`${show} ${code}`);
  const same = back.season === part.season && !back.episodeList?.length && (part.from === part.to
    ? back.episode === part.from && !back.episodeRange
    : back.episodeRange?.from === part.from && back.episodeRange?.to === part.to);
  if (!same || !back.show) return null;
  const p = String(prefix ?? '').trim();
  return `${p ? `${p} ` : ''}${show} ${code}`;
}

/**
 * "send *#request Arrow S01E11-E20* for the next part" - or "for the rest"
 * when it is all of it, or `what` ("for it") for a member whose own
 * episodes it is: how the member's reply, the trim's replies and the
 * finished notice all put the message.
 */
export function sendFor(ask, { last = false, what = null } = {}) {
  return `send *${ask}* for ${what ?? (last ? 'the rest' : 'the next part')}`;
}

/** sendFor as a sentence of its own: "Send *#request Arrow S01E11-E20* for the next part." */
export const sendSentence = (ask, o) => {
  const s = sendFor(ask, o);
  return `${s[0].toUpperCase()}${s.slice(1)}.`;
};

/**
 * The line a finished request adds to its notice in the notifications
 * group, for the member whose cooldown is long over by then: `next` is what
 * was journalled with the request ({ send, last }, index.js), or ''.
 */
export function nextNotice(next) {
  return next?.send ? sendSentence(next.send, { last: !!next.last }) : '';
}
