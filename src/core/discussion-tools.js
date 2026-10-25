import log from '../util/logger.js';
import { ticketLabel } from './issue-tickets.js';

const logger = log.scope('discussion-tools');

/**
 * What the discussions group's agent can look at and do (discussion-answers.js
 * TOOL_SPECS): search the library, read the request records, and open a ticket
 * for the admins. Each tool returns plain data the model reads back, capped, and
 * never a member's number: the answer goes into the group.
 *
 * The operator, 2026-10-23: "it should attempt to answer everything, do research
 * if needed ... being that bot has access to jellyfin it can figure out if
 * there's issues in the server itself and then create a ticket for an admin to
 * review and arrange to get resolved".
 */

const HISTORY_DAYS = 30;
const MAX_ROWS = 10;

/**
 * @param stateStore   the state file's namespaces (movie and TV history, tickets)
 * @param getConfig    () => the whole config (the library, the notifications group)
 * @param createProvider (libraryCfg) => a library provider with rawSearch(term, opts)
 * @param nextTicket  () => the next ticket number (issue-tickets.js)
 * @param notify      async (text) => posts to the notifications group
 * @param now         () => ms
 */
export function createDiscussionTools({ stateStore, getConfig, createProvider, nextTicket, notify, now = () => Date.now() }) {
  const tickets = () => stateStore.namespace('agent-tickets');

  async function searchLibrary({ term }) {
    const t = String(term ?? '').trim().slice(0, 120);
    if (!t) return { error: 'no search words given' };
    let provider;
    try { provider = createProvider(getConfig().library ?? {}); } catch (err) { return { error: `the library is not set up: ${err.message}` }; }
    if (!provider?.configured || typeof provider.rawSearch !== 'function') return { error: 'the library is not reachable from here' };
    try {
      const rows = (await provider.rawSearch(t, { limit: 8 })) ?? [];
      const matches = rows.slice(0, 8).map((r) => ({
        name: String(r.title ?? r.name ?? r.Name ?? '').slice(0, 120),
        year: r.year ?? r.ProductionYear ?? null,
        type: String(r.type ?? r.Type ?? '').slice(0, 30) || null,
      })).filter((m) => m.name);
      return matches.length ? { matches, count: matches.length } : { matches: [], note: `nothing on the server matches "${t}"` };
    } catch (err) {
      logger.warn(`library search for "${t}" failed: ${err.message}`);
      return { error: `the library did not answer: ${String(err.message).slice(0, 160)}` };
    }
  }

  function searchRequests({ term }) {
    const t = String(term ?? '').trim().toLowerCase().slice(0, 120);
    if (!t) return { error: 'no search words given' };
    const since = now() - HISTORY_DAYS * 24 * 3600_000;
    const rows = [];
    for (const ns of ['movie-requests', 'tv-requests']) {
      for (const r of stateStore.namespace(ns).get('history', []) ?? []) {
        if (!r || (r.at ?? 0) < since) continue;
        const hay = [r.request, r.title, r.requester, r.requesterNumber, r.requesterNumberDisplay, r.detail, r.status]
          .map((v) => String(v ?? '').toLowerCase()).join(' | ');
        if (!hay.includes(t)) continue;
        rows.push({
          at: new Date(r.at).toISOString(),
          kind: ns === 'tv-requests' ? 'TV' : 'film',
          requester: r.requester ?? 'a member',
          request: String(r.request ?? '').slice(0, 120),
          title: r.title ? `${r.title}${r.year ? ` (${r.year})` : ''}` : null,
          status: r.status ?? null,
          detail: String(r.detail ?? '').slice(0, 200) || null,
        });
      }
    }
    rows.sort((a, b) => (a.at < b.at ? 1 : -1));
    return rows.length
      ? { rows: rows.slice(0, MAX_ROWS), count: rows.length }
      : { rows: [], note: `no request of the last ${HISTORY_DAYS} days matches "${t}"` };
  }

  /** A ticket for the admins: numbered, kept, and posted to the notifications group. */
  async function openTicket({ summary }, ctx) {
    const text = String(summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 600);
    if (text.length < 10) return { error: 'the summary is too short to act on' };
    const n = nextTicket();
    const entry = { n, at: now(), summary: text, group: ctx?.group ?? null, who: ctx?.who ?? null, question: ctx?.question ?? null };
    const list = tickets().get('list', []) ?? [];
    list.unshift(entry);
    tickets().set('list', list.slice(0, 200));
    try {
      await notify(`🎫 Ticket #${ticketLabel(n)} for the admins${ctx?.who ? ` (from ${ctx.who}${ctx.where ? ` in "${ctx.where}"` : ''})` : ''}: ${text}`);
    } catch (err) {
      logger.warn(`ticket #${ticketLabel(n)} was kept but not posted: ${err.message}`);
    }
    logger.info(`🎫 ticket #${ticketLabel(n)} opened by the discussions agent: ${text.slice(0, 120)}`);
    return { ticket: n, note: 'the admins have it; tell the member the ticket number' };
  }

  /** The tool runner for one question: `ctx` says where it came from. */
  function forMessage(ctx) {
    return async (name, args) => {
      switch (name) {
        case 'search_library': return searchLibrary(args ?? {});
        case 'search_requests': return searchRequests(args ?? {});
        case 'open_ticket': return openTicket(args ?? {}, ctx);
        default: return { error: `there is no tool called ${name}` };
      }
    };
  }

  return { forMessage, searchLibrary, searchRequests, openTicket, tickets };
}
