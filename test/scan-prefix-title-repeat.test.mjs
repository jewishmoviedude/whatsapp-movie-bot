/* Run: node test/scan-prefix-title-repeat.test.mjs

   Hourly check 20261009T110002Z reported Jacob Shoshan as having asked for
   "Casino Royale (2006)" twice in 3 minutes. The first request was "Casino"
   (1995), refused on rating; the second was "Casino Royale", which held two
   versions and asked for a year. Different films: the scanner's "answer
   repeats the question's words" rule matched "casino" as a prefix of
   "casino royale" because the later row was a question. */
import { scan } from '../src/core/incident-scan.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const NOW = Date.parse('2026-10-09T11:00:00Z');
const MIN = 60_000;
const G = '120363900000000001@g.us';
const row = (o) => ({ requester: 'Jacob', requesterJid: '100000000000917@lid', requesterNumber: '18455550199', groupJid: G, ...o });
const state = (movie) => ({ 'movie-requests': { history: movie, pending: [] }, 'tv-requests': { history: [], pending: [], 'library-misses': [] }, 'msg-index': { entries: [] } });
const config = { movieRequests: { requestGroups: [G], requirePrefix: true, prefix: '#request', notify: { group: G } } };

console.log('=== a longer title that starts with an earlier one is another film ===');
{
  const a = row({ id: 'A1', at: NOW - 21 * MIN, status: 'blocked-rating', request: 'Casino', title: 'Casino', year: 1995, detail: 'rated R' });
  const b = row({ id: 'B1', at: NOW - 18 * MIN, status: 'need-year', request: 'Casino Royale', title: 'Casino Royale', year: 2006, detail: '2 copies: 1967, 2006' });
  const r = scan({ now: NOW, config, names: { [G]: 'REQ' }, unit: { ActiveState: 'active', NRestarts: '0' }, state: state([a, b]) });
  ok(!r.incidents.some((f) => f.kind === 'repeat-request' || f.kind === 'refused-again'), 'Casino then Casino Royale is no repeat');
}

console.log('=== the answer to a year question is still not a repeat ===');
{
  const q = row({ id: 'Q1', at: NOW - 20 * MIN, status: 'need-year', request: 'newsies', title: 'Newsies', year: 1992, detail: '2 copies' });
  const s = row({ id: 'Q2', at: NOW - 19 * MIN, status: 'sent', request: 'newsies 1992', title: 'Newsies', year: 1992 });
  const r = scan({ now: NOW, config, names: { [G]: 'REQ' }, unit: { ActiveState: 'active', NRestarts: '0' }, state: state([q, s]) });
  ok(!r.incidents.some((f) => f.kind === 'repeat-request'), 'newsies, then newsies 1992');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
