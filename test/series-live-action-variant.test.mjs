// Incident (hourly check 20261025T040001Z): "one piece live action season one"
// was answered "no series matching" although "ONE PIECE" (2023) is in the
// library beside the 1999 anime. "live action" is a hint, not part of the name.
import { liveActionVariant, findSeries } from '../src/plugins/tv-requests/jellyfin-tv.js';
import { bestMatch } from '../src/util/fuzzy.js';

let failed = 0;
function ok(name, cond) { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) failed++; }

ok('strips live action', liveActionVariant('one piece live action') === 'one piece');
ok('strips the live-action', liveActionVariant('One Piece the live-action') === 'One Piece');
ok('plain title has none', liveActionVariant('one piece') === null);
ok('a title that is only the words has none', liveActionVariant('live action') === null);

const all = [
  { Id: 'a', Name: 'One Piece', ProductionYear: 1999, RecursiveItemCount: 1000 },
  { Id: 'b', Name: 'ONE PIECE', ProductionYear: 2023, RecursiveItemCount: 16 },
];
const fetchImpl = async (url) => {
  const u = decodeURIComponent(String(url));
  const items = /searchTerm=one[+ ]piece[+ ]live/.test(u) ? [] : (/searchTerm=/.test(u) ? all : []);
  return { ok: true, status: 200, json: async () => ({ Items: items, SearchHints: [] }) };
};
const found = await findSeries('one piece live action', { base: 'http://j', token: 't', fetchImpl, bestMatch });
ok('live action finds the 2023 show', found?.id === 'b');
process.exit(failed ? 1 : 0);
