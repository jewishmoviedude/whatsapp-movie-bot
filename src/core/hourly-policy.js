/**
 * What the hourly check may do to the live bot on its own: when it restarts
 * it, and what it may re-run. Nothing else.
 *
 * This file is on the check's PROTECTED list (tools/hourly-debug.mjs): a fix
 * the research session writes may change what the scanner finds
 * (incident-scan.js), but not what the check then does about it. Before, the
 * three-hour limit on health restarts, the cap on restarting for one
 * interrupted film and the rules for a re-run lived in incident-scan.js and
 * admin-commands.js, which a fix could edit and have pushed to main and
 * restarted into by the same run - changing what later hours restart for, or
 * re-queue. The check asks restartAdvice itself, with the scanner's findings
 * as input, and the bot's `requeue` op asks rerunRefusal.
 *
 * What a TV row asked for is read with the TV plugin's own parser
 * (parse.js), the one every request is read with: the policy reads a row as
 * the bot read the request, and has no second reading of its own to drift.
 */
import { parseTvRequest, numbersOfRuns } from '../plugins/tv-requests/parse.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * A restart made for the bot's health that did not cure it is not tried
 * again every hour: that is the reconnect loop CLAUDE.md rule 2 exists to
 * prevent.
 */
export const HEALTH_RESTART_EVERY_MS = 3 * HOUR;

/**
 * Interrupted this many times, a film is not restarted for again: something
 * keeps breaking it, and another restart only costs the queue.
 */
export const MAX_INTERRUPTIONS = 2;

/**
 * Whether restarting would help, and whether anything says not to.
 *
 * A restart throws away every encode in progress, so it is advised only for
 * something a restart actually cures: a job that has stopped moving, a
 * connection that has not come back by itself, requests journalled to retry
 * "on the next start". Not for a crash loop (systemd is already restarting
 * it), not for a stopped unit (somebody stopped it), not for a logged-out
 * number (a restart is one more login attempt that cannot succeed), and not
 * while WhatsApp is stopped or another process holds the session - the
 * `blockers`, from the bot's state now, which a restart would overrule.
 */
export function restartAdvice({ incidents = [], notices = [], unit = null, mem = {}, now = Date.now(), blockers = [] } = {}) {
  const reasons = [];
  const blockedBy = [...blockers];
  const all = [...incidents, ...notices];
  const interrupted = all.filter((f) => f.request?.status === 'interrupted' && f.restartHelps);
  if (interrupted.length) reasons.push(`${interrupted.length} request(s) are journalled to retry on the next start`);
  for (const f of all) {
    if (f.kind === 'stuck-job' || (f.kind === 'bot-unhealthy' && f.restartHelps)) reasons.push(f.title);
  }
  for (const f of all) if (f.needsPerson) blockedBy.push(f.needsPerson);
  if (unit?.ActiveState === 'inactive' || unit?.ActiveState === 'failed') blockedBy.push('the service is not running, and was not started by this check');
  const healthOnly = reasons.length && !interrupted.length;
  if (healthOnly && mem.lastHealthRestartAt && now - mem.lastHealthRestartAt < HEALTH_RESTART_EVERY_MS) {
    blockedBy.push(`restarted for the bot's health ${Math.round((now - mem.lastHealthRestartAt) / MIN)} min ago; not again within ${Math.round(HEALTH_RESTART_EVERY_MS / HOUR)} hours`);
  }
  return { advised: reasons.length > 0 && blockedBy.length === 0, reasons: [...new Set(reasons)], blockedBy: [...new Set(blockedBy)] };
}

// The endings a re-run can fix. "interrupted" is not one: it is journalled
// and retried by the plugin itself on the next start. A TV "partial" is not
// either: re-running the request would post the episodes that did go out.
const RERUNNABLE = { movie: new Set(['failed', 'error', 'lost']), tv: new Set(['failed']) };
const RERUN_MAX_AGE_MS = 7 * 24 * 3600_000;
// What a re-post is for: a file that was sent, and that members could not
// open (see rerunRefusal's `repost`).
const REPOSTABLE = new Set(['sent', 'partial']);

/**
 * The episode numbers a TV History row is about, or null for "all of its
 * season": what it queued, when the episode limit cut it as it was made or
 * trimmed it after (its `cut`, tv-requests cap-cut.js) - else what its
 * request named: one episode, a run, a list ("S01E06, E09"), read as the
 * bot reads a request (parse.js).
 */
export function tvEpisodes(row) {
  if (row?.cut && Array.isArray(row.cut.queued)) return numbersOfRuns(row.cut.queued);
  const p = parseTvRequest(String(row?.request ?? ''));
  if (p.episodeList?.length) return [...p.episodeList];
  if (p.episodeRange) return numbersOfRuns([[p.episodeRange.from, p.episodeRange.to]]);
  if (p.episode != null) return [p.episode];
  return null;
}

/**
 * Whether two TV rows of one season are about any episode in common - a
 * whole season is about every one. Since 2026-10-12 a season past the
 * episode limit is asked for in parts, and its member is told to send the
 * next: "Arrow s1" queued E1-E10, then "Arrow S01E11-E20". Matched on the
 * season alone, the second part was the first "asked for again", so once
 * it was sent the first - failed, none of it posted - was "nothing to
 * re-run", and while either part was still journalled the other could not
 * be re-run at all (found in review).
 */
export function shareEpisodes(a, b) {
  return overlap(tvEpisodes(a), tvEpisodes(b));
}

/** Whether two lists of episode numbers share one; null is a whole season. */
function overlap(x, y) {
  if (!x || !y) return true;
  const had = new Set(x);
  return y.some((n) => had.has(n));
}

/**
 * A later request for the same film (or TV episodes) that was sent, or is on
 * its way - the row a re-run of `row` would duplicate - or null. The
 * scanner uses it too, so a finding never offers a re-run this refuses.
 */
export function askedAgain(plugin, row, history = []) {
  const same = (r) => (row.title
    ? String(r.title ?? '').toLowerCase() === String(row.title).toLowerCase() && (r.year ?? null) === (row.year ?? null)
      && (plugin !== 'tv' || ((r.season ?? null) === (row.season ?? null) && shareEpisodes(row, r)))
    : String(r.request ?? '').toLowerCase() === String(row.request ?? '').toLowerCase());
  return (Array.isArray(history) ? history : []).find((r) => r && r !== row && r.id !== row.id && (r.at ?? 0) > (row.at ?? 0) && same(r)
    && !r.beta && ['queued', 'checking', 'sent', 'partial'].includes(r.status)) ?? null;
}

/**
 * Why a history row must not be re-run from the box, or null if it may.
 *
 * The hourly check re-runs a request once, after fixing what broke it, so the
 * member gets their film without asking again. Everything here is a way that
 * could go wrong: a beta test sent to the main posts group (a re-run from the
 * box has no origin group, exactly like the panel's Re-run, which is why that
 * button is not offered on a beta row either), a request the member has
 * already asked for again, a second attempt at something that failed twice.
 */
//
// `repost` is the one exception to "only a failure": a request that was sent,
// but whose file WhatsApp would not open for the members - "This file was sent
// in an unusual format that may indicate it is dangerous, corrupted, or
// otherwise not supported on WhatsApp" (Daniel Sloss - Live Shows S01E01,
// 2026-10-12, A. Ito's #issue #group04). Once the cause is fixed in code the
// same request is sent again, prepared the new way; the operator, 2026-10-13,
// once A. Ito could open the re-post: "if anybody opens an #issue ticket and
// quotes that error you'll know what to do". Every other rule still holds.
export function rerunRefusal({ plugin, row, history = [], ledger = {}, now = Date.now(), journal = [], repost = false }) {
  if (!row) return 'no such request in the history';
  if (ledger[`${plugin}:${row.id}`]) {
    return `already re-run once, at ${new Date(ledger[`${plugin}:${row.id}`].at).toISOString()} - a second attempt is for a person to decide`;
  }
  if (row.beta) return 'a beta test is re-run by asking again in the beta group; from here it would go to the main posts group';
  // A re-run asks for the row's request by title, in the library; a film
  // queued from a public link (movie-requests queuePublicLink) was never
  // there, and its full link - the query can be a token - is not on the row.
  if (row.publicLink) return 'it was queued from a public link on the panel - an admin queues the link again from there';
  if (repost) {
    if (!REPOSTABLE.has(row.status)) return `a re-post is for a request that was sent, and this one ended "${row.status}"`;
  } else if (!RERUNNABLE[plugin]?.has(row.status)) {
    return `a request that ended "${row.status}" is not re-run from here`
      + (REPOSTABLE.has(row.status) ? ' (one members could not open is re-posted with "repost": true)' : '');
  }
  if (plugin === 'movie' && /posts group not set/i.test(String(row.detail ?? ''))) return 'no posts group is set - that is a setting to fix first';
  if (now - (row.at ?? 0) > RERUN_MAX_AGE_MS) return 'more than a week old - ask the member whether they still want it';
  const again = askedAgain(plugin, row, history);
  // A re-post's own request may be followed by a member's repeat that was
  // sent too - the same unopenable file - so only one still on its way bars it.
  if (again && !(repost && REPOSTABLE.has(again.status))) return `it was asked for again since, and that request is ${again.status}`;
  // Still journalled - waiting, running, retrying, or left for the next
  // start - by this request or another for the same thing, for the main
  // posts group: the pipeline has it, and a re-run would be a second copy.
  // A film resumed after a restart was marked "lost" while it sat queued
  // (movie-requests reconcileHistory), and a re-run queued it twice.
  const lc = (v) => String(v ?? '').toLowerCase();
  const held = (Array.isArray(journal) ? journal : []).find((p) => {
    if (!p) return false;
    if (plugin === 'tv') {
      if (p.baseRow?.id === row.id || p.msgId === row.id) return true;
      // Another request of the same season holds it only if it holds one of
      // its episodes: what is still journalled of it, else what it asked for.
      const left = (Array.isArray(p.episodes) ? p.episodes : []).flatMap((e) => {
        const n = Number(e?.episode);
        const end = Number(e?.episodeEnd);
        return Number.isFinite(n) ? numbersOfRuns([[n, Number.isFinite(end) && end > n ? end : n]]) : [];
      });
      return !p.route?.beta && !!row.title && lc(p.baseRow?.title) === lc(row.title)
        && (p.baseRow?.season ?? null) === (row.season ?? null)
        && overlap(tvEpisodes(row), left.length ? left : tvEpisodes(p.baseRow ?? {}));
    }
    if (p.record?.id === row.id || p.msgId === row.id) return true;
    return !p.record?.route?.beta && !!row.title && lc(p.movie?.title) === lc(row.title)
      && (p.movie?.year ?? null) === (row.year ?? null);
  });
  if (held) return 'it is still in the queue, or waiting to go back in - a re-run would queue it twice';
  return null;
}
