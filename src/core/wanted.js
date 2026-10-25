/**
 * Films people asked for that are real, but are not on the server.
 *
 * A request that OMDb resolves happily and Jellyfin does not have is the most
 * useful signal the bot produces: somebody wants it, it definitely exists, and
 * an admin could add it. Until now that fact reached a reaction emoji and the
 * debug log and then evaporated, so nobody ever acted on it.
 *
 * Entries are deduplicated and counted, so "eleven people asked for Wicked"
 * is visible at a glance rather than being eleven separate lines.
 *
 * An entry can be marked resolved, and carries admins' notes. The operator,
 * 2026-10-11, looking at the Wanted card: "give me a mark as resolved so
 * other admins and you know as well as a box to add notes for you to review
 * on the hour". So an entry is no longer only deleted when its film turns up:
 * an admin marks it resolved (`resolved: { by, at }`), and the bot does too
 * when it finds the film on the server (wanted-recheck.js, and a request that
 * finds it), so the other admins see who settled it and when instead of
 * watching a line vanish. A resolved entry leaves the open list, is kept
 * RESOLVED_KEEP_MS to be seen, and is then pruned; asked for again while
 * still not on the server, it opens again by itself. A library copy an admin
 * reopened the bot's resolution over, or one a request's file check found to
 * be another film, is remembered on the entry (`rejected`), and the bot never
 * resolves the entry with it again (reopenWanted). The notes are what an
 * admin writes for the other admins and for the hourly check, which reads
 * every new one as an instruction about that film (incident-scan.js).
 */
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const KEY = 'wanted';
const MAX = 300;
/**
 * How many of the requesters' own wordings an entry keeps. The recheck
 * (wanted-recheck.js) searches the library with them as a request does with
 * what was typed; a handful covers every spelling anyone used.
 */
const MAX_REQUESTS = 5;
/** A resolved entry is shown this long after it was resolved, then pruned. */
export const RESOLVED_KEEP_MS = 30 * 86_400_000;
/** The most notes one entry keeps, and the longest one note may be. */
export const MAX_NOTES = 20;
export const MAX_NOTE_CHARS = 2000;
/** Who the bot is when it resolves an entry or writes a note itself. */
export const BOT = 'the bot';
/** How many library copies one entry remembers as not being its film. */
const MAX_REJECTED = 5;

/**
 * Told of every change to the list, so an open panel can show it: the panel
 * is push-only over SSE (server.js forwards these as the 'wanted' event), and
 * a second admin looking at the Wanted card would otherwise see a film
 * another admin resolved still open, and resolve it again. One listener per
 * open panel, so no limit.
 */
export const wantedEvents = new EventEmitter();
wantedEvents.setMaxListeners(0);

function changed(what, key = null) {
  // A listener that throws must not undo the change it is being told of.
  try { wantedEvents.emit('change', { what, key, at: Date.now() }); } catch { /* the panel will reload anyway */ }
}

/** Add `text` to `list` once, the newest last, keeping the last `max`. */
function remember(list, text, max) {
  const t = String(text ?? '').trim();
  if (!t) return list;
  const out = list.filter((x) => x !== t);
  out.push(t);
  return out.slice(-max);
}

/** Stable identity for a film: its imdb id when known, else title + year. */
export function wantedKey(movie = {}) {
  if (movie.imdbId) return String(movie.imdbId);
  const t = String(movie.title ?? '').trim().toLowerCase();
  return `${t}|${movie.year ?? ''}`;
}

const isOpen = (w) => !w?.resolved;
const resolvedAt = (w) => Number(w?.resolved?.at) || 0;
const expired = (w, now) => !!w?.resolved && resolvedAt(w) < now - RESOLVED_KEEP_MS;

/**
 * Keep the list at MAX, dropping resolved entries before open ones, the
 * oldest resolution first: a resolved entry is kept only to be seen, an open
 * one is a film somebody is still waiting for.
 */
function capList(list) {
  while (list.length > MAX) {
    let drop = -1;
    list.forEach((w, i) => { if (w?.resolved && (drop < 0 || resolvedAt(w) < resolvedAt(list[drop]))) drop = i; });
    list.splice(drop >= 0 ? drop : list.length - 1, 1);
  }
}

function newNote({ by, at, text, auto = false }) {
  return { id: crypto.randomBytes(6).toString('hex'), by: String(by), at, text, ...(auto ? { auto: true } : {}) };
}

/** Add the bot's note to `w`, unless it has MAX_NOTES already: a note an admin wrote is never pushed out for one. */
function botNote(w, text, at) {
  w.notes = Array.isArray(w.notes) ? w.notes : [];
  if (w.notes.length < MAX_NOTES) w.notes.push(newNote({ by: BOT, at, text, auto: true }));
}

const copyName = (c) => `"${c?.title ?? '?'}"${c?.year ? ` (${c.year})` : ''}`;

/**
 * Are two library copies ({ id, title, year, imdbId }) the same one? By the
 * library's item id when both have it; otherwise - a copy remembered before
 * ids were kept - by title and year, and never when they carry two IMDb ids.
 */
export function sameCopy(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id) return String(a.id) === String(b.id);
  const imdb = (c) => String(c.imdbId ?? '').trim().toLowerCase() || null;
  if (imdb(a) && imdb(b) && imdb(a) !== imdb(b)) return false;
  const t = (c) => String(c.title ?? '').trim().toLowerCase();
  return !!t(a) && t(a) === t(b) && (Number(a.year) || null) === (Number(b.year) || null);
}

/**
 * Remember on `w` that this library copy is not its film, so the recheck
 * (wanted-recheck.js) never resolves it with that copy again. `why` is
 * 'reopened' (an admin reopened the bot's resolution with it) or
 * 'another-film' (a request found it and the file check said it was
 * another film).
 */
function rejectCopy(w, copy, { by, at, why }) {
  if (!copy || (!copy.id && !copy.title)) return;
  const kept = (Array.isArray(w.rejected) ? w.rejected : []).filter((r) => !sameCopy(r, copy));
  kept.push({
    id: copy.id ?? null, title: copy.title ?? null, year: copy.year ?? null, imdbId: copy.imdbId ?? null,
    by: String(by ?? '?'), at, why,
  });
  w.rejected = kept.slice(-MAX_REJECTED);
}

/**
 * The copy on `w`'s rejected list that `copy` is, or null: a library copy an
 * admin reopened the entry over, or one a request's file check found to be
 * another film.
 */
export function rejectedCopy(w, copy) {
  return (Array.isArray(w?.rejected) ? w.rejected : []).find((r) => sameCopy(r, copy)) ?? null;
}

/**
 * Note that someone asked for a film the library does not have.
 * @param reason 'not-in-library' or 'not-yet-theatrical' - the second cannot be
 *               added yet, so the email keeps them apart.
 * @param request what the member typed. Kept (the last few, as `requests`) so
 *               the recheck can search the library with their words as well
 *               as OMDb's title: the library often names a film as they do,
 *               not as OMDb does ("X2", asked for as "X2 2003", which OMDb
 *               calls "X2: X-Men United").
 *
 * @param refused the library's copy ({ id, title, year, imdbId }) when the
 *               request found one and its file check said it was another
 *               film. Remembered on the entry (rejectCopy), or the recheck,
 *               which runs no file check, would find that copy every six
 *               hours and resolve the film with it - and the next request
 *               would open it again (found in review, 2026-10-11).
 *
 * A film resolved on the list and asked for again is open again: it is only
 * recorded here when the request's lookup did not find it, so whatever
 * settled it - an admin, or the bot finding a copy - did not put it on the
 * server for this member. A note on the entry says so, by the bot.
 */
export function recordWanted(store, movie, {
  requester = null, reason = 'not-in-library', request = null, refused = null, now = Date.now(),
} = {}) {
  try {
    const list = store.get(KEY, []);
    const key = wantedKey(movie);
    const found = list.find((w) => w.key === key);

    if (found) {
      if (found.resolved) {
        const was = found.resolved;
        delete found.resolved;
        // At the cap the entry still opens; the count and the date say it was asked again.
        botNote(found, `asked again after it was resolved by ${was.by}`
          + `${refused ? `; the request found ${copyName(refused)} on the server, and its file is another film` : ''}`, now);
      }
      if (refused) rejectCopy(found, refused, { by: BOT, at: now, why: 'another-film' });
      found.count += 1;
      found.lastAt = now;
      found.reason = reason;
      // Keep who asked, deduplicated - useful for telling them once it lands.
      if (requester && !found.requesters.includes(requester)) {
        found.requesters.push(requester);
        if (found.requesters.length > 20) found.requesters.shift();
      }
      if (request) found.requests = remember(found.requests ?? [], request, MAX_REQUESTS);
    } else {
      const entry = {
        key,
        title: movie.title ?? '(unknown)',
        year: movie.year ?? null,
        imdbId: movie.imdbId ?? null,
        rated: movie.rated ?? null,
        reason,
        count: 1,
        firstAt: now,
        lastAt: now,
        requesters: requester ? [requester] : [],
        requests: remember([], request, MAX_REQUESTS),
      };
      if (refused) rejectCopy(entry, refused, { by: BOT, at: now, why: 'another-film' });
      list.unshift(entry);
    }
    const kept = list.filter((w) => !expired(w, now));
    capList(kept);
    store.set(KEY, kept);
    changed('asked', key);
    return true;
  } catch {
    return false;      // never let bookkeeping break a request
  }
}

/**
 * Drop a film from the list altogether. What the server has is resolved
 * (resolveWanted), not dropped; this is for an entry that never belonged
 * on the list - a season of a show asked for as a film (wanted-recheck.js).
 */
export function clearWanted(store, movie) {
  try {
    const key = wantedKey(movie);
    const list = store.get(KEY, []);
    const next = list.filter((w) => w.key !== key);
    if (next.length !== list.length) {
      store.set(KEY, next);
      changed('cleared', key);
    }
    return list.length - next.length;
  } catch {
    return 0;
  }
}

/** The entry with this key, resolved or open, or null. */
export function findWanted(store, key) {
  const k = String(key ?? '');
  return (store.get(KEY, []) ?? []).find((w) => w?.key === k) ?? null;
}

/**
 * Mark an open entry resolved. `by` is the admin's username, or for the bot
 * BOT and how it knows ('the bot (found on the server as "X2")'), with `auto`
 * set so the hourly check can tell an admin's word from the bot's own. `as`
 * is the library's copy, when the bot found one. Returns the entry, or null
 * when there is no open entry with that key.
 */
export function resolveWanted(store, key, { by, at = Date.now(), auto = false, as = null } = {}) {
  try {
    const list = store.get(KEY, []) ?? [];
    const w = list.find((x) => x?.key === String(key ?? '') && !x.resolved);
    if (!w) return null;
    w.resolved ={ by: String(by ?? '?'), at, ...(auto ? { auto: true } : {}), ...(as ? { as } : {}) };
    store.set(KEY, list.filter((x) => !expired(x, at)));
    changed('resolved', w.key);
    return w;
  } catch {
    return null;
  }
}

/**
 * Open a resolved entry again, `by` an admin. Returns the entry, or null when
 * there is no resolved entry with that key.
 *
 * When the bot had resolved it with a copy it found on the server (`as`),
 * the admin has said that copy is not the film - a wrong cut, a broken file,
 * a bad match - and it is remembered (rejectCopy). Forgotten, the next
 * recheck found the same copy and resolved the entry again without a word,
 * and the Wanted card's own Refresh starts a recheck, so an admin could not
 * keep it open (found in review, 2026-10-11). The bot's note on the entry
 * tells the other admins. A copy the server gets later is still found.
 */
export function reopenWanted(store, key, { by = 'an admin', at = Date.now() } = {}) {
  const list = store.get(KEY, []) ?? [];
  const w = list.find((x) => x?.key === String(key ?? '') && x.resolved);
  if (!w) return null;
  const was = w.resolved;
  delete w.resolved;
  if (was.auto && was.as) {
    rejectCopy(w, was.as, { by, at, why: 'reopened' });
    botNote(w, `reopened by ${by} after the bot found it on the server as ${copyName(was.as)} - `
      + 'the bot will not mark it resolved with that copy again', at);
  }
  store.set(KEY, list);
  changed('reopened', w.key);
  return w;
}

/**
 * Add a note to an entry. Returns { note, entry }, or { error, status } with
 * what the panel shows: an empty or over-long note, no such entry, or an
 * entry that has MAX_NOTES already. A full entry refuses rather than
 * dropping its oldest note: a note is something an admin meant somebody to
 * read, and losing one without a word is worse than being asked to delete
 * one first.
 */
export function addWantedNote(store, key, { by, text, at = Date.now(), auto = false } = {}) {
  const body = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!body) return { error: 'A note needs some text', status: 400 };
  if (body.length > MAX_NOTE_CHARS) {
    return { error: `A note is at most ${MAX_NOTE_CHARS} characters; this one is ${body.length}`, status: 400 };
  }
  const list = store.get(KEY, []) ?? [];
  const w = list.find((x) => x?.key === String(key ?? ''));
  if (!w) return { error: 'That film is not on the wanted list', status: 404 };
  w.notes = Array.isArray(w.notes) ? w.notes : [];
  if (w.notes.length >= MAX_NOTES) {
    return { error: `This film has ${MAX_NOTES} notes, the most one keeps - delete one first`, status: 409 };
  }
  const note = newNote({ by, at, text: body, auto });
  w.notes.push(note);
  store.set(KEY, list);
  changed('note', w.key);
  return { note, entry: w };
}

/**
 * Delete a note. An admin may delete their own; the super-admin any, the
 * bot's included. Returns { note, entry }, or { error, status }.
 */
export function deleteWantedNote(store, key, noteId, { by, superAdmin = false } = {}) {
  const list = store.get(KEY, []) ?? [];
  const w = list.find((x) => x?.key === String(key ?? ''));
  if (!w) return { error: 'That film is not on the wanted list', status: 404 };
  const i = (w.notes ?? []).findIndex((n) => n?.id === String(noteId ?? ''));
  if (i < 0) return { error: 'That note is not on this film any more', status: 404 };
  const note = w.notes[i];
  const own = String(note.by ?? '').trim().toLowerCase() === String(by ?? '').trim().toLowerCase();
  if (!own && !superAdmin) return { error: `Only ${note.by} or the super-admin can delete this note`, status: 403 };
  w.notes.splice(i, 1);
  store.set(KEY, list);
  changed('note-deleted', w.key);
  return { note, entry: w };
}

/** The most re-run outcomes one entry keeps (wanted-arrival.js). */
export const MAX_RERUNS = 20;

/**
 * Where the movie plugin's store keeps when arrival re-runs began on this
 * box: { at, handled } (beginArrivals). The sealed backup carries it with
 * the rest of state.json, so a rebuilt box does not begin again.
 */
export const ARRIVALS_BEGAN_KEY = 'arrival-reruns-began';
/** How an arrival is settled for an entry resolved before re-runs began: an admin's to re-run, by hand. */
export const LEFT_FOR_ADMIN = 'left for an admin';

/**
 * Record, once, that arrival re-runs begin on this box (wanted-arrival.js):
 * every entry resolved at this moment is marked handled - an `arrival`
 * settled as LEFT_FOR_ADMIN - and is never re-run by itself; "Re-run
 * requests" on its Wanted card re-runs it. The eight films the recheck
 * resolved on the morning of 2026-10-11 are such entries, and the operator
 * chooses which of those to re-run.
 *
 * Recorded rather than worked out from times: "resolved before re-runs
 * began" as a comparison of the resolution's time with a start time is
 * ambiguous for one resolved in the same moment, or by a clock that moved,
 * and says nothing about an entry that was not looked at. Called by
 * src/index.js at start, before the recheck's first run, and again (a no-op
 * by then) by the recheck before it resolves anything (wanted-recheck.js,
 * markFound) and by every pass, so whichever comes first records it and a
 * find of the recheck is never swept up as an older one.
 *
 * Returns { at, handled, fresh }: `fresh` when this call recorded it.
 */
export function beginArrivals(store, { now = Date.now() } = {}) {
  const was = store.get(ARRIVALS_BEGAN_KEY, null);
  if (was && Number.isFinite(Number(was.at))) return { at: Number(was.at), handled: Number(was.handled) || 0, fresh: false };
  const list = store.get(KEY, []) ?? [];
  let handled = 0;
  for (const w of list) {
    // An arrival already settled was handled by whatever settled it.
    if (!w?.resolved || w.arrival?.settled) continue;
    w.arrival = {
      ...(w.arrival ?? {}), at: Number(w.resolved.at) || null,
      settled: {
        at: now, outcome: LEFT_FOR_ADMIN,
        detail: `resolved by ${w.resolved.by ?? '?'} before arrival re-runs began - "Re-run requests" on its Wanted card re-runs them`,
      },
    };
    handled += 1;
  }
  if (handled) store.set(KEY, list);
  store.set(ARRIVALS_BEGAN_KEY, { at: now, handled });
  // On the disk at once: a restart in the store's debounce must not begin
  // again, with what the recheck has resolved since among "before".
  try { store.flush?.(); } catch { /* the next save writes it */ }
  if (handled) changed('arrivals-began');
  return { at: now, handled, fresh: true };
}

/** "arrival re-runs begin on this box: ...", for the log, from beginArrivals' answer. */
export function describeArrivalsBegan(b) {
  return 'arrival re-runs begin on this box: '
    + (b?.handled
      ? `${b.handled} film${b.handled === 1 ? '' : 's'} resolved on the wanted list before now ${b.handled === 1 ? 'is' : 'are'} `
        + 'left for an admin ("Re-run requests" on the Wanted card), never re-run by themselves'
      : 'no film on the wanted list was resolved before now');
}

/**
 * Note on an entry that the wanted recheck has just found its film on the
 * server and resolved it with copy `as` (wanted-recheck.js, markFound), so
 * the arrival re-runs re-run its requests (wanted-arrival.js). Kept as
 * `arrival` { at, as } - `at` the resolution's own time, which is how a pass
 * tells that the resolution it was recorded with still stands - until it is
 * settled. Returns the entry, or null when there is none with that key.
 */
export function noteArrival(store, key, { at = Date.now(), as = null } = {}) {
  const list = store.get(KEY, []) ?? [];
  const w = list.find((x) => x?.key === String(key ?? ''));
  if (!w) return null;
  w.arrival = { at, ...(as ? { as } : {}) };
  store.set(KEY, list);
  changed('arrival', w.key);
  return w;
}

/**
 * Settle an entry's arrival: `outcome` says how ('re-run', LEFT_FOR_ADMIN,
 * 'switched off', 'reopened'), `detail` why. A settled arrival is looked at
 * no more. Returns the entry, or null.
 */
export function settleArrival(store, key, { outcome, detail = null, now = Date.now() } = {}) {
  const list = store.get(KEY, []) ?? [];
  const w = list.find((x) => x?.key === String(key ?? ''));
  if (!w?.arrival) return null;
  w.arrival = { ...w.arrival, settled: { at: now, outcome: String(outcome ?? '?'), ...(detail ? { detail: String(detail) } : {}) } };
  store.set(KEY, list);
  changed('arrival-settled', w.key);
  return w;
}

/**
 * Keep what one re-run of a member's request came to on its entry
 * (`reruns`, the newest last): the Wanted card shows it, and the hourly
 * check's report says from it who was queued and who still needs telling.
 * `result` is { at, rowId, requester, outcome, detail, trigger, by }.
 *
 * A request's row is said once: what a later pass decides for the same
 * History row replaces what an earlier one said of it while it was not run
 * - skipped, or waiting after a batch stopped part-way - so a member re-run
 * at the second pass is not also listed as still waiting, and a skip met at
 * every pass does not crowd the other members out of the last MAX_RERUNS.
 * A row that ran is in the ledger and never comes back.
 */
export function recordRerun(store, key, result) {
  const list = store.get(KEY, []) ?? [];
  const w = list.find((x) => x?.key === String(key ?? ''));
  if (!w) return null;
  const id = result?.rowId ?? null;
  const kept = (Array.isArray(w.reruns) ? w.reruns : []).filter((x) => !(id && x?.rowId === id && !x.ran));
  w.reruns = [...kept, { ...result }].slice(-MAX_RERUNS);
  store.set(KEY, list);
  changed('rerun', w.key);
  return w;
}

/**
 * An admin's "Re-run requests" (wanted-arrival.js, rerun), kept on its entry
 * as `rerunPending` { by, at } until every request has been handed over. A
 * batch stopped part-way - WhatsApp gone, requests paused, the Shabbos
 * lockdown starting - is finished by the next pass, as an arrival the
 * recheck found is; without it the rest were dropped without a word (found
 * in review, 2026-10-11: Dune's second requester left "not in the library"
 * for good, while the audit said both had been re-run). Returns the entry,
 * or null.
 */
export function markRerunPending(store, key, { by, at = Date.now() } = {}) {
  const list = store.get(KEY, []) ?? [];
  const w = list.find((x) => x?.key === String(key ?? ''));
  if (!w) return null;
  w.rerunPending = { by: by ?? null, at };
  store.set(KEY, list);
  changed('rerun-pending', w.key);
  return w;
}

/** The admin's re-run is over: every request handed over, or the entry reopened. Returns the entry, or null. */
export function clearRerunPending(store, key) {
  const list = store.get(KEY, []) ?? [];
  const w = list.find((x) => x?.key === String(key ?? ''));
  if (!w?.rerunPending) return null;
  delete w.rerunPending;
  store.set(KEY, list);
  changed('rerun-done', w.key);
  return w;
}

/** Drop what was resolved more than RESOLVED_KEEP_MS ago. Returns how many went. */
export function pruneWanted(store, { now = Date.now() } = {}) {
  try {
    const list = store.get(KEY, []) ?? [];
    const kept = list.filter((w) => !expired(w, now));
    if (kept.length === list.length) return 0;
    store.set(KEY, kept);
    changed('pruned');
    return list.length - kept.length;
  } catch {
    return 0;
  }
}

/** Most-requested first, then most recent. */
const byDemand = (a, b) => (b.count - a.count) || ((b.lastAt ?? 0) - (a.lastAt ?? 0));

/** The open list - what is still wanted - most-requested first, then most recent. */
export function listWanted(store, { since = 0 } = {}) {
  const list = store.get(KEY, []) ?? [];
  return list
    .filter((w) => isOpen(w) && (w.lastAt ?? 0) >= since)
    .sort(byDemand);
}

/** What was resolved in the last RESOLVED_KEEP_MS (and since `since`), the newest resolution first. */
export function listResolvedWanted(store, { since = 0, now = Date.now() } = {}) {
  const list = store.get(KEY, []) ?? [];
  return list
    .filter((w) => w?.resolved && !expired(w, now) && resolvedAt(w) >= since)
    .sort((a, b) => resolvedAt(b) - resolvedAt(a));
}

/** Every entry, open and resolved, short of what has been resolved too long to keep. */
export function allWanted(store, { now = Date.now() } = {}) {
  return (store.get(KEY, []) ?? []).filter((w) => !expired(w, now));
}

export function resetWanted(store) {
  store.set(KEY, []);
  changed('reset');
}

/**
 * The wanted list as plain text for the daily email: the open entries only,
 * and how many were resolved since `since` (the last summary, or a day back
 * when there was none), with who resolved each. `list` may hold resolved
 * entries; they are never listed as wanted.
 */
export function formatWanted(list, { now = Date.now(), since = null } = {}) {
  const open = list.filter(isOpen).sort(byDemand);
  const from = Number.isFinite(since) && since > 0 ? since : now - 86_400_000;
  const resolved = list.filter((w) => w?.resolved && resolvedAt(w) >= from && resolvedAt(w) <= now)
    .sort((a, b) => resolvedAt(b) - resolvedAt(a));

  const addable = open.filter((w) => w.reason !== 'not-yet-theatrical');
  const theatres = open.filter((w) => w.reason === 'not-yet-theatrical');
  const age = (ts) => {
    const d = Math.floor((now - ts) / 86_400_000);
    return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
  };
  const label = (w) => `${w.title}${w.year ? ` (${w.year})` : ''}`;
  const line = (w) => `  ${w.count}x  ${label(w)}`
    + `${w.imdbId ? `  ${w.imdbId}` : ''}`
    + `  — first asked ${age(w.firstAt)}`;

  const out = [];
  if (!open.length) out.push('Nothing was requested that the server does not already have.');
  if (addable.length) {
    out.push(`${addable.length} film(s) people asked for that are not on the server:`, '');
    out.push(...addable.map(line));
  }
  if (theatres.length) {
    out.push('', `${theatres.length} still in cinemas - not addable yet:`, '');
    out.push(...theatres.map(line));
  }
  if (resolved.length) {
    const byBot = resolved.filter((w) => w.resolved.auto).length;
    const split = [resolved.length - byBot && `${resolved.length - byBot} by an admin`, byBot && `${byBot} found on the server by the bot`]
      .filter(Boolean).join(', ');
    out.push('', `${resolved.length} resolved ${Number.isFinite(since) && since > 0 ? 'since the last summary' : 'in the last 24 hours'}`
      + ` (${split}):`, '');
    out.push(...resolved.map((w) => `  ${label(w)} - ${w.resolved.by}`));
  }
  return out.join('\n');
}
