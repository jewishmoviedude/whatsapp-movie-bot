import { readLibraryNews } from './library-news.js';

/**
 * Every ticket that has been opened, in one list for the panel's Tickets tab:
 * a member's #issue (numbered since 2026-10-22, issue-tickets.js) and a ticket
 * the discussions agent opened for the admins (discussion-tools.js). Both draw
 * their numbers from one counter, so a number names one ticket.
 *
 * The operator, 2026-10-23: "make a section in panel kinda like a ticketing
 * system, for all the issue tickets that get opened". A ticket is open until an
 * admin resolves it; that, and the note they leave, is kept in the state file.
 */
export const STATUS_NS = 'tickets';

const digits = (n) => String(n ?? '').replace(/\D/g, '');

export function listTickets({ dataDir, stateStore }) {
  const status = stateStore.namespace(STATUS_NS).get('status', {}) ?? {};
  const byNumber = new Map();

  // A member's #issue. An edit of one is another row with the same number: the
  // ticket is dated by the first, and says what the last one says.
  for (const r of readLibraryNews(dataDir)) {
    if (r.kind !== 'issue' || r.ticket == null) continue;
    const text = String(r.text ?? '').replace(/^\s*#issues?\b/i, '').replace(/\s+/g, ' ').trim();
    const prev = byNumber.get(r.ticket);
    byNumber.set(r.ticket, {
      n: r.ticket,
      source: 'member',
      at: prev?.at ?? r.at,
      who: r.name ?? (r.sender ? `+${digits(r.sender)}` : 'a member'),
      number: r.sender ? digits(r.sender) : null,
      group: r.refGroupName ?? r.groupName ?? null,
      text: text || '(no words after #issue)',
      keeper: r.keeper === true || prev?.keeper === true,
      replyTo: r.replyTo?.text ? String(r.replyTo.text).slice(0, 300) : (prev?.replyTo ?? null),
    });
  }

  // A ticket the agent opened.
  for (const t of stateStore.namespace('agent-tickets').get('list', []) ?? []) {
    if (!t || t.n == null || byNumber.has(t.n)) continue;
    byNumber.set(t.n, {
      n: t.n,
      source: 'agent',
      at: t.at,
      who: t.who ?? 'a member',
      number: null,
      group: t.group ?? null,
      text: String(t.summary ?? ''),
      question: t.question ?? null,
      keeper: false,
      replyTo: null,
    });
  }

  return [...byNumber.values()]
    .map((t) => {
      const s = status[t.n];
      return {
        ...t,
        status: s?.status === 'resolved' ? 'resolved' : 'open',
        resolvedAt: s?.status === 'resolved' ? s.at : null,
        resolvedBy: s?.status === 'resolved' ? s.by : null,
        note: s?.note ?? null,
      };
    })
    .sort((a, b) => b.n - a.n);
}

/** Resolve or reopen a ticket. Returns the recorded state, or null for a number no ticket has. */
export function setTicketStatus({ dataDir, stateStore, now = () => Date.now() }, n, { status, by = null, note = null }) {
  const num = Number(n);
  if (!Number.isInteger(num) || num < 1) return null;
  if (status !== 'resolved' && status !== 'open') return null;
  if (!listTickets({ dataDir, stateStore }).some((t) => t.n === num)) return null;
  const ns = stateStore.namespace(STATUS_NS);
  const all = ns.get('status', {}) ?? {};
  all[num] = { status, at: now(), by, note: note ? String(note).slice(0, 500) : null };
  ns.set('status', all);
  return all[num];
}
