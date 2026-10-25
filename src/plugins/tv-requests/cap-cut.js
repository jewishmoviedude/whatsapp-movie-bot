/**
 * What tvRequests.maxEpisodesPerRequest left out of a TV request, and what
 * its member is told about it.
 *
 * 2026-10-12: the operator asked "why is the flash converting 23 episodes if
 * it's max 10 per request?". The TV request group's description promises 10
 * episodes at a time; the setting was 0, no limit, so The Flash season 2
 * queued all 23. With the limit set again, a season past it was queued in
 * part, and the member heard nothing about the rest: "The Boys season 1",
 * five episodes against a limit of two, reacted 🔍 🎬, the notifications
 * group read "The Boys season 1 — 2 episode(s) — added to the queue", and
 * the request group got no reply at all. Asked for "Arrow s1", a member would
 * believe all 23 episodes were coming. A whole season a multi-season message
 * could not fit was always named ("Season 2 wasn't added - one request is at
 * most 2 episodes"); the part of a season was not.
 *
 * So the request now says what it queued, what the limit left out, and the
 * exact message that asks for the next part (next-part.js, which the trim of
 * a request queued before the limit asks with too). The episodes are named
 * as the server holds them: a run asked for ("S01E05-E30") ends where the
 * season does, and episodes left out for another reason - waiting already
 * for another request, withheld on their rating - are not counted as cut.
 * History keeps it as the row's `cut` field, which the hourly check's scan
 * and re-run rules read (src/core/incident-scan.js, hourly-policy.js), so a
 * season sent in parts is never taken for missing episodes, a failure, or a
 * member asking again.
 *
 * Every part is worked out at once (`parts`), not just the next: the next
 * part fits under the limit, so it is cut by nothing and would say nothing
 * of the part after it. Arrow season 1 is three requests of 10, 10 and 3;
 * sent as told, "S01E11-E20" ended on a plain "all 10 episodes posted", and
 * E21-E23 were nowhere - asking for "season 1" again would have queued
 * episode 1 again. A request for a part a cut request named is told the
 * part after it when it finishes (index.js _partAfter).
 *
 * Pure and side-effect free; index.js decides what is queued.
 */
import { runsOf } from './parse.js';
import { listProse } from './withheld.js';
import { episodeOrder } from './naming.js';
import {
  numberOf, numbersOf, partsOf, partCode, sendFor,
} from './next-part.js';

/**
 * Runs as compactRuns (withheld.js) words them - "11–23", and a run of two
 * as both its numbers - read off the runs themselves, so a season numbered
 * to 1,100 (One Piece, in one season folder) is never counted out one by one.
 */
const runWords = (runs) => (Array.isArray(runs) ? runs : [])
  .flatMap(([a, b]) => (b - a >= 2 ? [`${a}–${b}`] : b > a ? [`${a}`, `${b}`] : [`${a}`]));
/** How many episode numbers the runs hold. */
const countOf = (runs) => (Array.isArray(runs) ? runs : []).reduce((n, [a, b]) => n + (b - a + 1), 0);
/** "E11–E14, E16–E23", from runs, for History and the log (as withheld.js names them). */
const codes = (runs) => runWords(runs).map((r) => `E${r.replace('–', '–E')}`).join(', ');
const many = (n, one, other) => (n === 1 ? one : other);

/**
 * What the limit left out of one request, or null when it left out nothing
 * - and then the request reads exactly as it always did.
 *
 *   season   the season the request is in
 *   limit    tvRequests.maxEpisodesPerRequest (not what a multi-season
 *            message had left of it: the next part is asked for on its own)
 *   queued   the episodes going into the queue
 *   left     the episodes the limit kept out of it: past the limit, and the
 *            rating-blocked ones the AI check was never asked about because
 *            they were past it (override-check.js `unreached`)
 *   coming   the episodes it asked for that are waiting already for another
 *            request: no part takes one in (next-part.js)
 *   only     the numbers a list named ("S01E06, E09"), or null
 *
 * An item left out whose episode went out as another copy of it (the
 * library holding a file twice) is not left out. Episodes waiting already
 * for another request, or withheld on their rating, are never in `left`: the
 * caller leaves them out before the limit is applied.
 *
 * @returns null, or the History row's `cut`:
 *   {
 *     limit:   10,
 *     count:   10,           episodes queued, by number - a second copy of
 *                            one is not another episode
 *     of:      23,           episodes it would have queued with no limit
 *     queued:  [[1, 10]],    the episode numbers queued, as runs
 *     left:    [[11, 23]],   the episode numbers left out, as runs
 *     unnumbered: 2,         left out with no number to name them by,
 *     queuedUnnumbered: 1,   and queued so; each omitted when none
 *     next:    { season: 1, from: 11, to: 20, last: false } or null:
 *              the next part to ask for, and whether it is all of the rest
 *     parts:   [[11, 20], [21, 23]]: every part the rest is asked for in,
 *              the first being `next`
 *   }
 * A request trimmed to the limit after it was queued (index.js trimQueued)
 * keeps the same field, with `trimmed: true`.
 */
export function capCut({ season, limit, queued = [], left = [], coming = [], only = null }) {
  const max = Number(limit);
  if (!(max > 0) || !left.length) return null;
  const got = new Set(queued.flatMap(numbersOf));
  const seen = new Set();
  const out = [...left].sort(episodeOrder).filter((e) => {
    const n = numberOf(e);
    if (n == null) return true;
    if (got.has(n) || seen.has(n)) return false;
    seen.add(n);
    return true;
  });
  if (!out.length) return null;
  const numbered = out.filter((e) => numberOf(e) != null);
  const spans = partsOf({ season, left: numbered, coming: [...queued, ...coming], max, only });
  const unnumbered = out.length - numbered.length;
  const queuedUnnumbered = queued.filter((e) => numberOf(e) == null).length;
  const leftRuns = runsOf(numbered.flatMap(numbersOf));
  // Counted in episodes, as the member's reply names them: Arrow season 1
  // with E03 held twice was "10 of 24 episodes" in the notifications group
  // and History while the member read "episodes 1–9 were added; 10–23
  // weren't" (found in review).
  const count = got.size + queuedUnnumbered;
  return {
    limit: max,
    count,
    of: count + countOf(leftRuns) + unnumbered,
    queued: runsOf([...got]),
    left: leftRuns,
    ...(unnumbered ? { unnumbered } : {}),
    ...(queuedUnnumbered ? { queuedUnnumbered } : {}),
    next: spans.length ? { ...spans[0], last: spans.length === 1 && !unnumbered } : null,
    parts: spans.map((p) => [p.from, p.to]),
  };
}

/**
 * The part after `range` ({ from, to }), if `cut` named it as one of its
 * parts: a part ({ season, from, to, last }) for next-part.js nextAsk, or
 * null - also when it is the last part, or not one of them.
 */
export function partAfter(cut, range, season) {
  const parts = Array.isArray(cut?.parts) ? cut.parts : [];
  const i = parts.findIndex((p) => Array.isArray(p) && Number(p[0]) === range?.from && Number(p[1]) === range?.to);
  if (i < 0 || i + 1 >= parts.length) return null;
  const [from, to] = parts[i + 1].map(Number);
  return { season, from, to, last: i + 2 === parts.length && !cut.unnumbered };
}

/** "S01E11-E20": the next part's code, as a member types it. */
export const nextCode = (cut) => partCode(cut?.next);

/**
 * History's and the log's words for it, after what was queued, which the
 * request's name counts ("S01E01–E10 — 10 of season 1", index.js
 * queuedName): "one request is at most 10; not queued: E11–E23 (next:
 * S01E11-E20)" - "taken off the queue" for one trimmed to the limit, with
 * the episodes its member had already ("and E1–E10, sent to them
 * already"). The panel's answer names the next part by what to type into
 * its queue box (`ask`, nextAsk's message): "(next: Arrow S01E11-E20)".
 */
export function cutDetail(cut, { ask = null } = {}) {
  if (!cut) return '';
  const left = [
    codes(cut.left), cut.unnumbered ? `${cut.unnumbered} without a number` : '',
    countOf(cut.sentAlready) ? `and ${codes(cut.sentAlready)}, sent to them already` : '',
  ].filter(Boolean).join(', ');
  const next = ask ?? nextCode(cut);
  return `one request is at most ${cut.limit}; ${cut.trimmed ? 'taken off the queue' : 'not queued'}: ${left}`
    + (next ? ` (next: ${next})` : '');
}

/** "one request is at most 10 episodes". */
export function cutLimit(cut) {
  return `one request is at most ${cut.limit} ${many(cut.limit, 'episode', 'episodes')}`;
}

/**
 * What the member is told, in the request group: what was added, what the
 * limit left out, and what to send for the next part. `lead` is what the
 * request is called - "*Arrow* season 1" on its own, "Season 1" as one line
 * of a message that asked for several - and `ask` is nextAsk's message.
 * `lines` false puts it on one line, as each line of that message is.
 *
 *   ⚠️ *Arrow* season 1 — one request is at most 10 episodes: episodes
 *   1–10 were added; 11–23 weren't.
 *   Once these are posted, send *#request Arrow S01E11-E20* for the next part.
 */
export function cutReply(cut, { lead, ask = null, lines = true } = {}) {
  // Named by number, and an episode the library never numbered counted
  // instead (tv-unnumbered-episodes): "episodes 1–8 and 2 more", "11, 12
  // and 2 more", as the trim names them (trim-queued.js episodeWords).
  const named = (runs, more) => listProse([...runWords(runs), ...(more ? [`${more} more`] : [])]);
  const got = countOf(cut.queued) + (cut.queuedUnnumbered ?? 0);
  const restCount = countOf(cut.left) + (cut.unnumbered ?? 0);
  const added = countOf(cut.queued)
    ? `${many(got, 'episode', 'episodes')} ${named(cut.queued, cut.queuedUnnumbered)} ${many(got, 'was', 'were')} added`
    : `${cut.count} ${many(cut.count, 'episode was', 'episodes were')} added`;
  const rest = named(cut.left, cut.unnumbered);
  const first = `⚠️ ${lead} — ${cutLimit(cut)}: ${added}; ${rest} ${many(restCount, "wasn't", "weren't")}.`;
  const posted = many(cut.count, 'once it is posted', 'once these are posted');
  const then = ask
    ? `${posted[0].toUpperCase()}${posted.slice(1)}, ${sendFor(ask, { last: !!cut.next?.last })}.`
    : `Ask for ${many(restCount, 'it', 'them')} again ${posted}.`;
  return `${first}${lines ? '\n' : ' '}${then}`;
}
