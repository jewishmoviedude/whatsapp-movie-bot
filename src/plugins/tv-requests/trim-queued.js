/**
 * Queued TV requests kept to an episode limit after the fact: which of a
 * request's episodes stay, which are taken off, and what its member is told.
 *
 * The operator, 2026-10-12: "fix the current queue that only 10 epsiodes max
 * per req", and then "I'm saying because in the queue is "11. Arrow season 1
 * / waiting extra / 23 episodes" so I wanted you to manually adjust the queue
 * that no more than 10 epsidodes per request". tvRequests.maxEpisodesPerRequest
 * had been 0, no limit, until 20:22 UTC that evening, and the limit applies as
 * a request is made, so the requests queued before it held up to 148 episodes
 * (Hunter x Hunter season 1), 23 (Arrow season 1) and 16 (Malcolm in the
 * Middle season 1). The one tool was the panel's Cancel, which ends a request
 * whole: The Flash season 2, cancelled at 20:24 UTC with 14 episodes posted,
 * ended on ❌ "An admin cancelled it — it isn't coming".
 *
 * Every episode a request has posted, has failed, has in hand (running, or
 * waiting for its retry) or has waiting counts towards the limit, in episode
 * order. What is in hand is never stopped; the waiting episodes past the
 * limit are taken off. The member is told which episodes are still coming,
 * and the exact message that asks for the next part - next-part.js, which a
 * request the limit cuts as it is made asks with too, in the same words.
 *
 * An episode the member was sent already, by an earlier request of theirs
 * for the same season, is taken off as well and keeps no place under the
 * limit. Hunter x Hunter season 1 was Ari's, and his "hunter x hunter s1
 * e1-10" had been posted on 2026-10-08: kept to its first ten, the season
 * would have posted E1-E10 to him again and taken off E11-E148, the ones he
 * did not have (found in review). It keeps E11-E20 instead.
 *
 * Pure and side-effect free; index.js (trimQueued) does the trimming.
 */
import { episodeOrder } from './naming.js';
import { compactRuns, listProse } from './withheld.js';
import {
  numberOf, numbersOf, sendFor, sendSentence,
} from './next-part.js';

const many = (n, one, other) => (n === 1 ? one : other);

/**
 * Which waiting episodes a request keeps under `max`, and which go.
 *
 *   done     episodes it has posted or failed (the journal's tally)
 *   inHand   episodes running or waiting for their retry: kept, whatever
 *            `max` says, and counted first
 *   waiting  episodes still to start, in the queue or not in it yet
 *   had      episode numbers its member was sent already by an earlier
 *            request (index.js _sentAlready): a waiting one of those is
 *            taken off, and takes no place
 *
 * The waiting ones fill what room `max` leaves, in episode order; the rest
 * are `off` - `past` the ones past the limit, `sent` the ones the member had.
 * A request at or under `max` loses nothing, not even what its member had:
 * the limit is all the trim keeps to. One that has done more than `max`
 * already keeps nothing waiting, and ends with what it has in hand.
 */
export function trimPlan({ done = 0, inHand = [], waiting = [], max, had = null }) {
  const room = Math.max(0, Number(max) - Number(done || 0) - inHand.length);
  const order = [...waiting].sort(episodeOrder);
  if (order.length <= room) return { keep: order, off: [], past: [], sent: [] };
  const known = new Set(had ?? []);
  const isHad = (e) => numbersOf(e).length > 0 && numbersOf(e).every((n) => known.has(n));
  const sent = order.filter(isHad);
  const rest = order.filter((e) => !isHad(e));
  const keep = rest.slice(0, room);
  const past = rest.slice(room);
  return { keep, off: [...sent, ...past].sort(episodeOrder), past, sent };
}

/** "11–23", "22 and 23", "1–8 and 2 more": episodes by number, as the member reads them. */
export function episodeWords(eps) {
  const numbers = eps.flatMap(numbersOf);
  const unnumbered = eps.filter((e) => numberOf(e) == null).length;
  return listProse([...compactRuns(numbers), ...(unnumbered ? [`${unnumbered} more`] : [])]);
}

/** "E11–E23", "E22, E23": episodes by code, for History, the log and the admin's answer. */
export function episodeCodes(eps) {
  const numbers = eps.flatMap(numbersOf);
  const unnumbered = eps.filter((e) => numberOf(e) == null).length;
  return [
    ...compactRuns(numbers).map((r) => `E${r.replace('–', '–E')}`),
    ...(unnumbered ? [`${unnumbered} without a number`] : []),
  ].join(', ');
}

/**
 * What a trimmed request's finished History row says beyond what it always
 * did: the episodes it held once trimmed - the request's notifier counts
 * them (episodeTrimmed) - in place of the ones it was queued with, which the
 * row's `baseRow` still says, and the `cut` the trim gave it. The hourly
 * check reads a 'sent' row's `episodes` as what it posted (incident-scan.js
 * sameShowPart): left at 23, Arrow's next part, "S01E11-E20", would read as
 * season 1 asked for again. Nothing for a request never trimmed, whose row
 * reads as it always did.
 */
export function trimmedRow(notifier) {
  return notifier?.trimmed ? { episodes: notifier.total, ...(notifier.cut ? { cut: notifier.cut } : {}) } : {};
}

/** How many episodes a list names, a double-episode file counted twice, as the member reads them. */
const countOf = (eps) => eps.reduce((n, e) => n + Math.max(1, numbersOf(e).length), 0);

/**
 * What the member is told, in the request group, quoted to their request:
 * which episodes are still coming, that one request is at most `max`
 * episodes now, what was taken off, and the message to send for the next
 * part. `lead` is the request as it was asked for, "*Arrow* season 1";
 * `coming` is what it has in hand and kept; `posted` and `failed` are
 * counts; `off` the episodes past the limit and `sent` the ones its member
 * had already (trimPlan); `ask` is nextAsk's message, and `last` whether it
 * is all the rest. `owner` false words the episodes the member had for a
 * member following the request, who did not have them.
 *
 *   ⚠️ *Arrow* season 1 — one request is at most 10 episodes now, so
 *   episodes 4–10 are still coming (3 are posted already) and 11–23 were
 *   taken off the queue.
 *   Once these are posted, send *#request Arrow S01E11-E20* for the next part.
 */
export function trimReply({
  lead, max, posted = 0, failed = 0, coming = [], off = [], sent = [], ask = null, last = false, owner = true,
}) {
  const before = [
    posted ? `${posted} ${many(posted, 'is', 'are')} posted already` : '',
    failed ? `${failed} failed` : '',
  ].filter(Boolean).join(', ');
  const aside = before ? ` (${before})` : '';
  const offCount = countOf(off);
  const gone = offCount ? `${episodeWords(off)} ${many(offCount, 'was', 'were')} taken off the queue` : '';
  const n = countOf(coming);
  const said = n
    ? `${many(n, 'episode', 'episodes')} ${episodeWords(coming)} ${many(n, 'is', 'are')} still coming${aside}${gone ? ` and ${gone}` : ''}`
    : offCount ? `${many(offCount, 'episode', 'episodes')} ${gone}${aside}` : `nothing more of it is coming${aside}`;
  const first = `⚠️ ${lead} — one request is at most ${max} ${many(Number(max), 'episode', 'episodes')} now, so ${said}.`;
  const had = countOf(sent);
  const also = had
    ? ` ${many(had, 'Episode', 'Episodes')} ${episodeWords(sent)} ${many(had, 'was', 'were')} taken off too, as `
      + `${many(had, 'it was', 'they were')} ${owner ? 'sent to you already' : 'sent already to the member who asked first'}.`
    : '';
  const once = n ? many(n, 'once it is posted', 'once these are posted') : '';
  const then = ask
    ? (once ? `${once[0].toUpperCase()}${once.slice(1)}, ${sendFor(ask, { last })}.` : sendSentence(ask, { last }))
    : offCount ? `Ask for ${many(offCount, 'it', 'them')} again${once ? ` ${once}` : ''}.` : '';
  return `${first}${also}${then ? `\n${then}` : ''}`;
}

/**
 * What a member following a trimmed request is told when every episode
 * they asked for was taken off it (index.js _trimAudience): it is not
 * coming, and the message that asks for it on its own. A follower used to
 * end on the request's ✅, "posted, with an earlier request for it", for an
 * episode that never was (found in review).
 *
 *   ⚠️ *Arrow* S01E15 was taken off the queue: it was coming with an
 *   earlier request, and one request is at most 10 episodes now.
 *   Send *#request Arrow S01E15* for it.
 */
export function trimFollowerReply({ lead, max, count = 1, ask = null, last = true }) {
  const first = `⚠️ ${lead} ${many(count, 'was', 'were')} taken off the queue: ${many(count, 'it was', 'they were')} coming `
    + `with an earlier request, and one request is at most ${max} ${many(Number(max), 'episode', 'episodes')} now.`;
  const then = ask
    ? sendSentence(ask, { last, what: last ? many(count, 'it', 'them') : null })
    : `Ask for ${many(count, 'it', 'them')} again.`;
  return `${first}\n${then}`;
}
