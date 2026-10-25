// Incident 20261001T000001Z: Aaron asked for "the rookie s02 e05-e08" and,
// hours later, "the rookie s02 e09-e19". The scanner called that a repeat
// request because an episode range parses with no single episode. Disjoint
// ranges are the next part of the season, not the same ask again.
import { requestChains } from '../src/core/incident-scan.js';

let failed = 0;
const ok = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) failed++; };
const row = (id, request, at) => ({ id, request, title: 'The Rookie', season: 2, requester: 'Aaron', requesterJid: 'a@s.whatsapp.net', at, receivedAt: at, status: 'sent' });
const chains = (rows) => requestChains({ 'tv-requests': { history: rows } }).filter((c) => c.plugin === 'tv');

ok(chains([row('1', 'the rookie s02 e05-e08', 1e12), row('2', 'the rookie s02 e09-e19', 1e12 + 3.5e7)]).length === 2, 'disjoint episode ranges are separate asks');
ok(chains([row('1', 'the rookie s02 e05-e08', 1e12), row('2', 'the rookie s02 e07-e10', 1e12 + 3.5e7)]).length === 1, 'overlapping ranges are a repeat');
// A list is the episodes it names (2026-10-12), not the span from its first
// to its last: "s02 e05, e08" and then "s02 e06, e07" ask for none twice.
ok(chains([row('1', 'the rookie s02 e05, e08', 1e12), row('2', 'the rookie s02 e06, e07', 1e12 + 3.5e7)]).length === 2, 'two lists that share no episode are separate asks');
ok(chains([row('1', 'the rookie s02 e05, e08', 1e12), row('2', 'the rookie s02 e08-e10', 1e12 + 3.5e7)]).length === 1, 'a run that takes in an episode of the list is a repeat');
process.exit(failed ? 1 : 0);
