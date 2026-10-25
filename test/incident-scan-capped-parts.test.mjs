// Incident 20261003T210001Z: Shawn asked for "the mentalist season 4", got ten
// episodes (the per-request cap), then "s04 e11-e24" (ten more) and "e21-e24".
// The scanner called that three asks for one season; it was the season in parts.
import { requestChains } from '../src/core/incident-scan.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const NOW = Date.parse('2026-10-03T21:00:00Z');
const MIN = 60_000;

const row = (id, request, at, episodes) => ({
  id, request, title: 'The Mentalist', season: 4, episodes, status: 'sent',
  requesterNumber: '+2773***3002', requester: 'Shawn', requestedAt: at, at,
});
const chains = requestChains({ 'tv-requests': { history: [
  row('A', 'The mentalist season 4', NOW - 90 * MIN, 10),
  row('B', 'The mentalist S04-e11-e24', NOW - 70 * MIN, 10),
  row('C', 'The mentalist S04-e21-e24', NOW - 10 * MIN, 4),
] } });
ok(chains.length === 3 && chains.every((c) => c.rows.length === 1),
  'a season sent in capped parts is the next part each time, not a repeat');
const again = requestChains({ 'tv-requests': { history: [
  row('A', 'The mentalist season 4', NOW - 90 * MIN, 10),
  row('B', 'The mentalist S04-e05-e08', NOW - 70 * MIN, 4),
] } });
ok(again.length === 1 && again[0].rows.length === 2, 'episodes already sent, asked for again, is still a repeat');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
