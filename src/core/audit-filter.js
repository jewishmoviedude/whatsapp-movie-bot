/**
 * Bucket audit entries into the handful of things admins actually look for.
 *
 * The log is one flat stream of every mutating request, so "who reset a
 * password last week" means scrolling past hundreds of settings saves and
 * queue cancellations. These categories are what someone is usually after.
 */

import { phoneQuery, textHasPhone } from './members.js';

/** Ordered: the first pattern that matches wins, so put the specific ones first. */
const CATEGORIES = [
  { key: 'accounts', label: 'Admin accounts', match: /add admin|remove admin|reset password|changed own password|setup super-admin|sign-out timeout|admin accounts/i },
  { key: 'signin', label: 'Sign in / out', match: /^login$|^logout$|session/i },
  { key: 'numbers', label: 'WhatsApp numbers', match: /whatsapp number|switched whatsapp|failover/i },
  { key: 'moderation', label: 'Moderation', match: /banned|removed \+|promote|demote|across \d+ group|muted|unmuted|banned list/i },
  { key: 'lockdown', label: 'Lockdown', match: /lock(ed|down)|unlocked/i },
  { key: 'queue', label: 'Queue', match: /cancelled|skipped|moved "|cleared \d+ waiting|paused the queue|resumed the queue|queued "|bulk re-ran/i },
  { key: 'groups', label: 'Groups & descriptions', match: /description|rule set|catalogue|group/i },
  { key: 'settings', label: 'Settings', match: /changed settings|settings save|changed the failover|changed failover|cookies for yt-dlp/i },
  { key: 'other', label: 'Everything else', match: /.*/ },
];

export function auditCategories() {
  return CATEGORIES.map(({ key, label }) => ({ key, label }));
}

/** Which bucket one entry belongs to. */
export function categoryOf(entry) {
  const text = `${entry?.action ?? ''}`;
  return CATEGORIES.find((c) => c.match.test(text))?.key ?? 'other';
}

/**
 * Filter and page the audit log.
 * @param {{user?:string, category?:string, q?:string, limit?:number, offset?:number}} opts
 */
export function filterAudit(events = [], opts = {}) {
  const { user = null, category = null, q = null, limit = 200, offset = 0 } = opts;
  const needle = String(q ?? '').trim().toLowerCase();
  const who = String(user ?? '').trim().toLowerCase();
  // A pasted number - "+15558100180" or "+1 (555) 810-0180" - finds the
  // entries that name it in either form: the log kept the old "+1 (…)" one
  // until 2026-10-01, and has written +digits since (members.js phoneQuery).
  const digits = phoneQuery(needle);

  const matched = events.filter((e) => {
    if (who && String(e.user ?? '').toLowerCase() !== who) return false;
    if (category && category !== 'all' && categoryOf(e) !== category) return false;
    if (needle) {
      const hay = `${e.action ?? ''} ${e.detail ?? ''} ${e.user ?? ''}`.toLowerCase();
      if (!hay.includes(needle) && !textHasPhone(hay, digits)) return false;
    }
    return true;
  });

  return {
    total: matched.length,
    // Counts are over the FILTERED set for the chosen person, but over
    // everything when no person is chosen - otherwise the category tabs would
    // show numbers that change as you click them.
    events: matched.slice(offset, offset + limit),
  };
}

/** How many entries sit in each category, for the filter buttons. */
export function categoryCounts(events = [], { user = null } = {}) {
  const who = String(user ?? '').trim().toLowerCase();
  const out = { all: 0 };
  for (const c of CATEGORIES) out[c.key] = 0;
  for (const e of events) {
    if (who && String(e.user ?? '').toLowerCase() !== who) continue;
    out.all += 1;
    out[categoryOf(e)] += 1;
  }
  return out;
}

/** A one-line summary of what one admin has been doing. */
export function summariseAdmin(events = [], username) {
  const who = String(username ?? '').toLowerCase();
  const mine = events.filter((e) => String(e.user ?? '').toLowerCase() === who);
  if (!mine.length) return { total: 0, first: null, last: null, top: [] };

  const byCat = {};
  for (const e of mine) {
    const k = categoryOf(e);
    byCat[k] = (byCat[k] ?? 0) + 1;
  }
  const label = (k) => CATEGORIES.find((c) => c.key === k)?.label ?? k;
  const times = mine.map((e) => e.ts).filter(Boolean);
  return {
    total: mine.length,
    first: times.length ? Math.min(...times) : null,
    last: times.length ? Math.max(...times) : null,
    top: Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([k, n]) => ({ key: k, label: label(k), count: n })),
  };
}
