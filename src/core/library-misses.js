/**
 * Everything the bot refused to send for ONE reason only: it could not find it
 * in the library.
 *
 * This is deliberately narrower than the wanted list next door. `wanted` is a
 * shopping list - films that resolved to something real which an admin could
 * go and add. This is a fault log. Every entry here is a request that passed
 * every other gate: it was not blocked on its rating, it is not still in
 * cinemas, it was not an unrecognisable title, nothing errored, the queue had
 * room. The library lookup came back empty, and that alone is why nobody got
 * their film.
 *
 * It exists because that answer is the one the bot gets WRONG most often, and
 * until now it was also the one it recorded least. A TV miss in particular
 * left nothing at all behind - no history row, no wanted entry, not even a log
 * line - so "the bot says you do not have Kitchen Nightmares and you plainly
 * do" was unanswerable after the fact. You could not tell which of the four
 * things that can go wrong had gone wrong, or even which group it was asked
 * in.
 *
 * So each entry carries what was typed, what it was understood as, what was
 * actually searched for, and what the lookup saw. That last part is the point:
 * `diagnostics` is what turns "not in library" from a verdict into evidence.
 */

import { phoneOut, phoneQuery, textHasPhone } from './members.js';

const KEY = 'library-misses';
const MAX = 500;

/**
 * The reasons that belong here. Anything else the bot does - a rating block, a
 * theatrical hold, an unrecognised title, a failure - is NOT a library miss
 * and must not be recorded, or the list stops answering the question it exists
 * to answer.
 */
export const MISS_REASONS = {
  'not-in-library': 'Not found in the library',
  'no-such-episode': 'Show found, that episode missing',
  'empty-season': 'Show found, that season empty',
};

/** Stable identity, so eleven people asking is one row with a count of 11. */
export function missKey({ kind = 'movie', title = '', year = null, season = null, episode = null } = {}) {
  const t = String(title).trim().toLowerCase();
  return [kind, t, year ?? '', season ?? '', episode ?? ''].join('|');
}

/**
 * Note that a request died at the library lookup.
 *
 * Wrapped whole in a try/catch: this is bookkeeping on an already-failing
 * path, and it must never be the thing that turns a wrong answer into a crash.
 */
export function recordMiss(store, {
  kind = 'movie',
  reason = 'not-in-library',
  request = '',
  title = '',
  year = null,
  season = null,
  episode = null,
  requester = null,
  groupJid = null,
  searched = [],
  diagnostics = [],
  detail = null,
} = {}) {
  try {
    if (!MISS_REASONS[reason]) return false;

    const list = store.get(KEY, []) ?? [];
    const key = missKey({ kind, title, year, season, episode });
    const now = Date.now();
    const found = list.find((m) => m.key === key);

    if (found) {
      // Missed again after it was marked answered: it is missing NOW, so the
      // row is open again. Left resolved, it stayed out of the daily mail, the
      // panel's "still missing" filter and listMisses for good, however many
      // times it was asked for after. Until 2026-09-29 the movie pipeline
      // marked a miss answered whenever the library returned anything, wrong
      // film or not, so Barefoot (2014) - asked for again once Barefoot Gen
      // (1983) was no longer sent for it - would have read "turned up later"
      // for ever. When it turned up is kept, since that is still evidence.
      if (found.resolved) {
        found.resolved = false;
        found.previouslyResolvedAt = found.resolvedAt ?? null;
        found.reopenedAt = now;
        delete found.resolvedAt;
      }
      found.count += 1;
      found.lastAt = now;
      found.reason = reason;
      found.detail = detail ?? found.detail;
      // The newest lookup is the interesting one - the library may have
      // changed since the first time somebody asked.
      if (diagnostics.length) found.diagnostics = diagnostics.slice(0, 8);
      if (searched.length) found.searched = [...new Set([...found.searched, ...searched])].slice(0, 8);
      // The same person, though one entry names them by the number as it
      // was written before 2026-10-01 ("+1 (555) 810-0180") and this one as
      // it is now (+15558100180).
      if (requester && !found.requesters.some((r) => phoneOut(r) === phoneOut(requester))) {
        found.requesters.push(requester);
        if (found.requesters.length > 20) found.requesters.shift();
      }
      // Move it to the front: a miss that just happened again is the one
      // somebody is standing there asking about.
      const i = list.indexOf(found);
      if (i > 0) { list.splice(i, 1); list.unshift(found); }
    } else {
      list.unshift({
        key,
        kind,
        reason,
        detail,
        request: String(request ?? ''),
        title: title || String(request ?? '') || '(unknown)',
        year: year ?? null,
        season: season ?? null,
        episode: episode ?? null,
        groupJid: groupJid ?? null,
        searched: [...new Set(searched)].slice(0, 8),
        diagnostics: diagnostics.slice(0, 8),
        count: 1,
        firstAt: now,
        lastAt: now,
        requesters: requester ? [requester] : [],
        resolved: false,
      });
      if (list.length > MAX) list.length = MAX;
    }

    store.set(KEY, list);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mark a miss as answered because the title has since turned up.
 *
 * Kept rather than deleted: a miss that later resolved is the most useful row
 * in the list, because it proves the bot was wrong at the time rather than the
 * library being short. Deleting it would erase exactly that evidence.
 */
export function resolveMiss(store, ident) {
  try {
    const key = missKey(ident);
    const list = store.get(KEY, []) ?? [];
    const found = list.find((m) => m.key === key && !m.resolved);
    if (!found) return false;
    found.resolved = true;
    found.resolvedAt = Date.now();
    store.set(KEY, list);
    return true;
  } catch {
    return false;
  }
}

/**
 * The list, newest first, optionally filtered.
 * @param {{kind?:string, reason?:string, q?:string, since?:number,
 *          includeResolved?:boolean, limit?:number}} opts
 */
export function listMisses(store, opts = {}) {
  const {
    kind = null, reason = null, q = null, since = 0,
    includeResolved = true, limit = 0,
  } = opts;
  const needle = String(q ?? '').trim().toLowerCase();
  // A pasted number finds its requester whichever way either side wrote it
  // (src/core/members.js phoneQuery).
  const digits = phoneQuery(needle);

  const out = (store.get(KEY, []) ?? [])
    .filter((m) => {
      if (kind && kind !== 'all' && m.kind !== kind) return false;
      if (reason && reason !== 'all' && m.reason !== reason) return false;
      if (!includeResolved && m.resolved) return false;
      if ((m.lastAt ?? 0) < since) return false;
      if (needle) {
        const hay = `${m.title} ${m.request} ${(m.requesters ?? []).join(' ')}`.toLowerCase();
        if (!hay.includes(needle) && !textHasPhone(hay, digits)) return false;
      }
      return true;
    })
    .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));

  return limit > 0 ? out.slice(0, limit) : out;
}

/** Counts for the filter buttons, over the unfiltered list. */
export function missCounts(store) {
  const list = store.get(KEY, []) ?? [];
  const out = { all: list.length, movie: 0, tv: 0, resolved: 0, asked: 0 };
  for (const r of Object.keys(MISS_REASONS)) out[r] = 0;
  for (const m of list) {
    out[m.kind] = (out[m.kind] ?? 0) + 1;
    out[m.reason] = (out[m.reason] ?? 0) + 1;
    if (m.resolved) out.resolved += 1;
    out.asked += m.count ?? 1;
  }
  return out;
}

export function resetMisses(store) {
  store.set(KEY, []);
}

/**
 * Plain text for the daily email.
 *
 * With `since`, only the misses asked for since then are listed, and the
 * older ones still open are one line pointing at the panel. The operator,
 * 2026-10-13: "the daily email summary shouldnt include old bugs" - every
 * open row was listed every day, so American Dad!'s refusals from September,
 * long since fixed in the code, headed the mail weeks later.
 */
export function formatMisses(list, { now = Date.now(), limit = 20, since = null } = {}) {
  const allOpen = list.filter((m) => !m.resolved);
  const windowed = Number.isFinite(since);
  const open = windowed ? allOpen.filter((m) => (m.lastAt ?? m.firstAt ?? 0) >= since) : allOpen;
  const older = allOpen.length - open.length;
  const olderLine = older ? `${older} older one(s), not asked for again since, are still open in the panel (Not in library).` : '';
  if (!open.length) {
    const none = windowed ? 'Nothing new was refused purely for not being in the library.' : 'Nothing was refused purely for not being in the library.';
    return olderLine ? `${none}\n${olderLine}` : none;
  }

  const age = (ts) => {
    const d = Math.floor((now - ts) / 86_400_000);
    return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
  };
  const line = (m) => {
    const what = m.kind === 'tv'
      ? `${m.title}${m.season != null ? ` S${String(m.season).padStart(2, '0')}` : ''}`
        + `${m.episode != null ? `E${String(m.episode).padStart(2, '0')}` : ''}`
      : `${m.title}${m.year ? ` (${m.year})` : ''}`;
    return `  ${m.count}x  [${m.kind}] ${what}  — asked as "${m.request}", first ${age(m.firstAt)}`
      + (m.reason !== 'not-in-library' ? `\n         ${MISS_REASONS[m.reason]}` : '')
      + (m.diagnostics?.length ? `\n         ${m.diagnostics[0]}` : '');
  };

  const shown = open.slice(0, limit);
  const out = [
    `${open.length} request(s) answered "not in the library" and nothing else${windowed ? ', asked for since the last summary' : ''}:`,
    '',
    ...shown.map(line),
  ];
  if (open.length > shown.length) out.push('', `  … and ${open.length - shown.length} more in the panel.`);
  if (olderLine) out.push('', olderLine);
  return out.join('\n');
}
