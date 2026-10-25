/**
 * The 'mark-extras' admin command: the requests already waiting that were
 * asked for inside their member's cooldown, made the extras they are.
 *
 * The operator, 2026-10-12, looking at the panel's queue: "I'm saying because
 * in the queue is "11. Arrow season 1 / waiting extra / 23 episodes" so I
 * wanted you to manually adjust the queue that ... if any user did a request
 * within the 3600 seconds/1 hour cooldown period it should go to bottom as
 * extra". From then on the plugins mark such a request as they queue it
 * (src/core/queue.js, "inside the cooldown"). What was waiting already was
 * queued before that, under a cooldown of 30 seconds, and several of those
 * stood among the first requests once the member's earlier one had gone:
 * Eli Miller's Better Call Saul S01E07-E09, asked for a minute and a half
 * after his season 2; Ari's Hunter x Hunter season 1, a minute after his
 * Arrow season 1; shua's Marvel's Daredevil S02E05-E09, a minute after his
 * Daredevil: Born Again S02E05-E08. This finds them, once.
 *
 * What it goes by is the plugins' History, since those requests were queued
 * before anything recorded their member's clock against them: for each
 * request waiting (not running), the member's previous request of the same
 * kind that put something in the queue, by when each was asked for. If that
 * was less than the kind's cooldown (cooldownSecondsPerUser, as configured
 * now) before it, the request is inside the cooldown, and becomes an extra -
 * rank 2 at least, as one queued inside it is - marked in the queue and in
 * its plugin's journal, so a restart keeps it.
 *
 * Never a request the cooldown does not hold: one queued from the panel, a
 * retry or one with no member (the fair order never moves those), a group
 * admin's, or one of a kind whose cooldown is 0. Nothing at all with
 * queue.fairShare off. Without `apply` it changes nothing and says what it
 * would do; with it, the panel and every place-in-line reaction are told at
 * once (markInsideCooldown). Run again, it finds them extras already and
 * changes nothing. An admin's moves stand: see markInsideCooldown.
 */
import { requestMemberKey, phoneOut } from './members.js';

const KINDS = {
  tv: { namespace: 'tv-requests', section: 'tvRequests', what: 'TV' },
  movie: { namespace: 'movie-requests', section: 'movieRequests', what: 'film' },
};

/**
 * History statuses a TV request ends on once it has put something in the
 * queue - waiting, running, or ended any way after it was queued. Not a
 * refusal (blocked-rating, not in the library...), a duplicate, a test, or
 * the member's own waiting request sent again ('resent'): those queue
 * nothing.
 */
const QUEUED = new Set(['queued', 'working', 'sent', 'partial', 'failed', 'cancelled', 'skipped', 'interrupted']);

/** When a History row's request was asked for: the member's message, else when the bot took it. */
const askedAt = (row) => Number(row?.requestedAt) || Number(row?.at) || 0;

/** Whose a History row is, as the queue keys a member (requestMemberKey). */
const memberOf = (row) => requestMemberKey({ senderNumber: row?.requesterNumber ?? null, senderJid: row?.requesterJid ?? null });

/** Queued from the panel - typed in, or assigned to a member - which never starts a member's clock. */
const fromPanel = (row) => !!row?.assignedBy || /^(manual|panel)\b/i.test(String(row?.requester ?? '').trim());

/**
 * Whether a History row's request put something in the queue, which is
 * when the member's clock starts (request-cooldown.js, rule 1), and so what
 * a request is judged against.
 *
 * Judged by its status alone, three kinds of row disagreed with the clock
 * (found in review, 2026-10-12). A member's own waiting request sent again
 * ('resent') queues nothing and starts no clock, but stood for the earlier
 * request at the resend's time - an hour's cooldown read from a resend a
 * minute ago where the clock ran from the request two hours before. A TV
 * row "season 2 not added — the bot restarted part-way through the request"
 * (tv-requests _recoverSeasonBatches) is 'failed' with nothing queued, and a
 * request that followed another's and was posted with it - "posted, with an
 * earlier request for it", TV and film alike - is 'sent' with nothing of its
 * own queued; both counted. And a queued film a restart dropped ('lost',
 * movie-requests reconcileHistory) did start the clock, and did not count.
 *
 * So a TV row counts when its episodes went in (`episodes` > 0, which those
 * TV rows have at 0), and a film's when the film did (`enqueuedAt`, stamped
 * as it is queued and kept by a 'lost' row) - not one the queue then
 * refused as full ('error').
 */
function queuedSomething(row, kind) {
  if (!row) return false;
  // A beta test queues nothing; a request re-run because its film arrived
  // neither waits for the member's clock nor starts it (rerunArrived).
  if (row.beta || row.test || row.rerun || fromPanel(row)) return false;
  if (kind === 'movie') return Number(row.enqueuedAt) > 0 && row.status !== 'error';
  // The TV plugin's row for a request the queue took nothing of (_runSeason).
  if (row.status === 'failed' && /^the queue was full/i.test(String(row.detail ?? ''))) return false;
  return QUEUED.has(row.status) && Number(row.episodes) > 0;
}

/** "1m 4s", "2h 5m": a gap, for a person to read. */
function span(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 60)}h`;
}

const iso = (t) => (t > 0 ? new Date(t).toISOString() : null);

/**
 * A waiting request's journal entry and History row. TV journals a request
 * by its key, which is the queue group's (_journalAdd), with its row as
 * `baseRow`; a film by its jobKey, which its job's meta carries, with its
 * record. The row in History is the newer of the two when both are there.
 */
function rowOf(kind, req, store) {
  const history = store.get('history', []) ?? [];
  const journal = store.get('pending', []) ?? [];
  const entry = kind === 'tv'
    ? journal.find((r) => r?.reqKey === req.key)
    : journal.find((p) => p?.jobKey != null && p.jobKey === req.meta?.jobKey);
  const own = kind === 'tv' ? entry?.baseRow : entry?.record;
  if (!own) return { entry: entry ?? null, row: null, history };
  return { entry, row: history.find((h) => h?.id === own.id) ?? own, history };
}

/** The member's latest request of the kind before `row` that put something in the queue, or null. */
function previousOf(kind, history, row, member) {
  const at = askedAt(row);
  let best = null;
  for (const h of history) {
    if (!h || h.id === row.id || !queuedSomething(h, kind) || memberOf(h) !== member) continue;
    const t = askedAt(h);
    if (!(t > 0 && t < at)) continue;
    if (!best || t > askedAt(best)) best = h;
  }
  return best;
}

/** Write the mark on the request's journal entry, where a restart reads it back (TV _groupOf, the film's meta). */
function persist(kind, store, entry, mark) {
  const journal = store.get('pending', []) ?? [];
  const mine = kind === 'tv'
    ? journal.find((r) => r?.reqKey === entry.reqKey)
    : journal.find((p) => p?.jobKey === entry.jobKey);
  if (!mine) return false;
  if (kind === 'tv') mine.insideCooldown = mark;
  else mine.meta = { ...(mine.meta ?? {}), insideCooldown: mark };
  store.set('pending', journal);
  return true;
}

/**
 * Run the command. `config` is the live config, `pluginManager` the loaded
 * plugins (their stores hold History and the journals), `bot` answers who is
 * a group admin. Returns { applied, fairShare, marked, requests } with, for
 * each waiting request in the order it will start: its kind, label and
 * member, the previous request it was judged against and the gap, whether it
 * is an extra by the cooldown (`extra`) and why or why not, its rank (and,
 * applied, its place) before and after, and `changed`.
 */
export function markExtras({ queue, pluginManager = null, config = {}, bot = null, apply = false, now = Date.now() } = {}) {
  if (typeof queue?.fairLine !== 'function' || typeof queue?.markInsideCooldown !== 'function') {
    throw new Error('this queue has no fair order to mark');
  }
  if (!queue.fairShare) {
    return {
      applied: false, fairShare: false, marked: 0, requests: [],
      note: 'queue.fairShare is off: the waiting line runs in arrival order and nothing is an extra, so nothing was marked',
    };
  }
  const line = queue.fairLine();
  // A request a restart left and that is not back yet is not in the line to
  // be marked, and its plugin may hold its journal entry in hand.
  if (apply && line.comingBack) {
    throw new Error(`${line.comingBack} request(s) left by the restart are still being put back into the queue - `
      + 'run it again once they are');
  }

  const requests = [];
  const todo = [];
  for (const req of line.requests) {
    const kind = req.kind === 'tv' ? 'tv' : 'movie';
    const k = KINDS[kind];
    const r = { kind, label: req.label, place: { before: req.place }, rank: { before: req.rank, after: req.rank }, extra: false, changed: false };
    requests.push(r);
    if (!req.member) { r.why = 'queued from the panel, a retry, or no member: the fair order never moves it'; continue; }
    const store = pluginManager?.plugins?.get(k.namespace)?.ctx?.store ?? null;
    if (!store) { r.why = `the ${k.what} plugin is not loaded`; continue; }
    const { entry, row, history } = rowOf(kind, req, store);
    if (!row) { r.why = 'not in its plugin\'s journal, so there is no History row to go by'; continue; }
    r.member = { name: row.requester ?? null, number: phoneOut(row.requesterNumberDisplay ?? row.requesterNumber ?? null) };
    r.requestedAt = iso(askedAt(row));
    if (req.insideCooldown) {
      r.extra = true;
      r.already = true;
      r.why = 'an extra by its cooldown already';
      continue;
    }
    const cooldownMs = (Number(config?.[k.section]?.cooldownSecondsPerUser) || 0) * 1000;
    if (!(cooldownMs > 0)) { r.why = `the ${k.what} cooldown is 0`; continue; }
    if (bot?.isGroupAdmin?.(row.groupJid, { jid: row.requesterJid ?? null, number: row.requesterNumber ?? null })) {
      r.why = 'a group admin\'s: the cooldown never holds them';
      continue;
    }
    const prev = previousOf(kind, history, row, req.member);
    if (!prev) { r.why = `no earlier ${k.what} request of theirs that queued something`; continue; }
    const gapMs = askedAt(row) - askedAt(prev);
    r.previous = {
      request: prev.typed ?? prev.request ?? prev.title ?? null, title: prev.title ?? null,
      status: prev.status, requestedAt: iso(askedAt(prev)),
    };
    r.gap = span(gapMs);
    r.gapSeconds = Math.round(gapMs / 1000);
    if (!(gapMs < cooldownMs)) {
      r.why = `asked for ${span(gapMs)} after it: past the ${span(cooldownMs)} ${k.what} cooldown`;
      continue;
    }
    r.extra = true;
    r.why = `asked for ${span(gapMs)} after it: inside the ${span(cooldownMs)} ${k.what} cooldown`;
    // What an admin's move made of it stands (markInsideCooldown).
    if (req.moved) r.moved = true;
    r.rank.after = req.moved ? req.rank : Math.max(2, req.rank);
    const mark = {
      what: String(r.previous.request ?? '').slice(0, 80) || null, at: askedAt(prev), gapMs,
      by: 'mark-extras', markedAt: now,
    };
    todo.push({ req, r, kind, store, entry, mark });
  }

  if (!apply) {
    return { applied: false, fairShare: true, marked: 0, wouldMark: todo.length, requests };
  }
  // The journal first: if anything stops part-way, a restart still makes
  // them extras.
  for (const t of todo) t.persisted = persist(t.kind, t.store, t.entry, t.mark);
  const done = queue.markInsideCooldown(todo.map((t) => ({ key: t.req.key, mark: t.mark })));
  done.forEach((d, i) => {
    const { r, persisted } = todo[i];
    if (!d) { r.why += ' - but it is no longer waiting, so it was left'; r.rank.after = r.rank.before; return; }
    r.rank.after = d.after;
    r.changed = !d.already;
    if (!persisted) r.why += ' - its journal entry was gone, so a restart would not keep it';
  });
  const places = new Map(queue.fairLine().requests.map((x) => [x.key, x.place]));
  line.requests.forEach((req, i) => { requests[i].place.after = places.get(req.key) ?? null; });
  return { applied: true, fairShare: true, marked: todo.filter((t) => t.r.changed).length, requests };
}
