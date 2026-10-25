import fs from 'node:fs';
import path from 'node:path';

/**
 * Every #issue gets a ticket number of its own, in the order they came, so the
 * hourly report and the operator can say "ticket 7" rather than quote a member.
 *
 * The operator, 2026-10-22: "start giving each issue it's own ticket number".
 * It starts from now: the #issue rows already in the news file keep no number,
 * since numbering them after the fact would change what the report said about
 * them.
 *
 * The counter is a file of its own, not the news file: that one is pruned after
 * 90 days, and a pruned counter would hand out a number already used.
 */
export const ticketFile = (dataDir) => path.join(dataDir, 'issue-tickets.json');

/** The next ticket number, recorded so the next call gets the one after. */
export function nextTicket(dataDir) {
  const file = ticketFile(dataDir);
  let next = 1;
  try {
    const n = Number(JSON.parse(fs.readFileSync(file, 'utf8')).next);
    if (Number.isInteger(n) && n >= 1) next = n;
  } catch { /* first ticket, or an unreadable file: start from 1 */ }
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ next: next + 1 }));
  fs.renameSync(tmp, file);
  return next;
}

/** How a ticket number is written: 0001, 0002, 0003 (the operator, 2026-10-25). */
export const ticketLabel = (n) => String(n).padStart(4, '0');
