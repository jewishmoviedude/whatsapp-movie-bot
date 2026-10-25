/* The hourly scan's "refused again" reads a list or a run by the episodes it names.
   Run: node test/scan-refused-again-reads-a-list-by-its-episodes.test.mjs

   Found in review, 2026-10-12, once a comma list became "only those
   episodes" (test/tv-comma-list-queues-only-those-episodes.test.mjs). A
   list has no single episode, and the scan (incident-scan.js asksForKept)
   read a request with none as asking for everything withheld: a season that
   went out with E5 withheld, then "S01E12, E14" with E14 withheld, was
   reported as the member asking again for what was refused - though neither
   E12 nor E14 had been asked for before - with "the refusal itself is the
   owner's rating policy working" for a remedy. And a refused list was the
   whole season kept back (keptBack), so S01E13 refused after "S01E12, E14"
   was "refused again" as well. A run ("S01E12-E14") was read the same way.

   Now each is the episodes it names: refused again only when the later
   request names an episode the earlier one kept back. A whole season still
   asks for every one. */
import { scan } from '../src/core/incident-scan.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const MIN = 60_000, HOUR = 60 * MIN;
const TV_REQ = '120363100000000002@g.us';
const at = (hhmm) => Date.parse(`2026-10-12T${hhmm}:00Z`);
const NOW = at('18:00');
const config = {
  movieRequests: { requestGroups: [], postsGroup: '', notify: { group: '' }, replyOnBlock: false, blockedRatings: ['R'] },
  tvRequests: { enabled: true, requestGroups: [TV_REQ], postsGroups: ['tvposts@g.us'], requirePrefix: true, prefix: '#request', blockedRatings: ['TV-MA'] },
  beta: { groups: [], postsGroup: '', features: {} },
  media: { workDir: '/home/bot/whatsapp-bot/data/media' },
};

let seq = 0;
const ELI = { requester: 'Eli', requesterJid: '900000000000001@lid', requesterNumber: '15550000001', requesterNumberDisplay: '+15550000001' };
const row = (hhmm, request, o = {}) => ({
  id: `AC${String(++seq).padStart(30, '0')}`, kind: 'tv', groupJid: TV_REQ, title: 'Arrow', year: 2012, season: 1, ...ELI,
  at: at(hhmm), requestedAt: at(hhmm), request, ...o,
});
const sent = (hhmm, request, episodes, withheld = null) => row(hhmm, request, {
  status: 'sent', episodes, detail: `${episodes} episode(s) posted${withheld ? ` · ${withheld}` : ''}`, ...(withheld ? { withheld } : {}),
});
const refused = (hhmm, request, withheld) => row(hhmm, request, {
  status: 'blocked-rating', episodes: 0, rated: 'TV-MA', detail: `all ${withheld}`, withheld,
});
const kindOf = (rows) => {
  const r = scan({
    now: NOW, config, names: {}, unit: { ActiveState: 'active', NRestarts: '0' },
    memory: { v: 1, lastScanAt: at('11:00'), seen: {}, configCheckedAt: at('11:00') },
    state: { 'tv-requests': { history: [...rows].reverse(), pending: [], 'library-misses': [] }, 'movie-requests': { history: [], pending: [] }, 'msg-index': { entries: [] }, audit: { events: [] } },
  });
  return r.incidents.filter((f) => f.kind === 'refused-again' || f.kind === 'repeat-request').map((f) => f.kind).join() || 'none';
};

console.log('=== a later list or run that names none of what was withheld is not "refused again" ===');
{
  const season = sent('12:00', '#request arrow season 1', 9, '1 withheld (TV-MA): E5');
  ok(kindOf([season, sent('13:00', '#request arrow S01E12, E14', 1, '1 withheld (TV-MA): E14')]) === 'repeat-request',
    `"S01E12, E14" after a season that lost E5: a repeat, not refused again (${kindOf([season, sent('13:00', '#request arrow S01E12, E14', 1, '1 withheld (TV-MA): E14')])})`);
  const run = [season, sent('13:00', '#request arrow S01E12-E14', 2, '1 withheld (TV-MA): E14')];
  ok(kindOf(run) === 'repeat-request', `nor "S01E12-E14" (${kindOf(run)})`);
}

console.log('=== ...and one that names a withheld episode still is ===');
{
  const season = sent('12:00', '#request arrow season 1', 9, '1 withheld (TV-MA): E5');
  const list = [season, sent('13:00', '#request arrow S01E05, E07', 1, '1 withheld (TV-MA): E5')];
  ok(kindOf(list) === 'refused-again', `"S01E05, E07" asks again for E5 (${kindOf(list)})`);
  const run = [season, sent('13:00', '#request arrow S01E04-E06', 2, '1 withheld (TV-MA): E5')];
  ok(kindOf(run) === 'refused-again', `so does "S01E04-E06" (${kindOf(run)})`);
  const again = [season, sent('14:00', '#request arrow season 1', 9, '1 withheld (TV-MA): E5')];
  ok(kindOf(again) === 'refused-again', `and the whole season again (${kindOf(again)})`);
}

console.log('=== a refused list kept back its episodes, not the season ===');
{
  // The season ran first and lost nothing; the list was refused whole; then
  // another episode was refused.
  const season = sent('11:30', '#request arrow season 1', 23);
  const list = refused('12:00', '#request arrow S01E12, E14', '2 withheld (TV-MA): E12, E14');
  const other = refused('12:30', '#request arrow S01E13', '1 withheld (TV-MA): E13');
  ok(kindOf([season, list, other]) === 'repeat-request', `S01E13 after "S01E12, E14" was refused: not refused again (${kindOf([season, list, other])})`);
  const same = refused('12:30', '#request arrow S01E14', '1 withheld (TV-MA): E14');
  ok(kindOf([season, list, same]) === 'refused-again', `S01E14 after it: refused again (${kindOf([season, list, same])})`);
  const runRefused = refused('12:00', '#request arrow S01E12-E14', '3 withheld (TV-MA): E12–E14');
  const later = refused('12:30', '#request arrow S01E15', '1 withheld (TV-MA): E15');
  ok(kindOf([season, runRefused, later]) === 'repeat-request', `S01E15 after "S01E12-E14" was refused: not refused again (${kindOf([season, runRefused, later])})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
