// Incident (hourly check 20261024T220001Z): "kungfu panda" was answered "no
// series matching" although "Kung Fu Panda: The Dragon Knight" is in the library.
import { compoundVariant, findSeries } from '../src/plugins/tv-requests/jellyfin-tv.js';
import { bestMatch } from '../src/util/fuzzy.js';

let failed = 0;
function ok(name, cond) { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) failed++; }

ok('kungfu panda becomes kung fu panda', compoundVariant('kungfu panda') === 'kung fu panda');
ok('Kungfu keeps its capital', compoundVariant('Kungfu Panda') === 'Kung fu Panda');
ok('a spaced title has no variant', compoundVariant('kung fu panda') === null);

const fetchImpl = async (url) => {
  const u = decodeURIComponent(String(url));
  const hit = /searchTerm=kung(\+|%20| )fu/.test(u);
  const items = hit ? [{ Id: 'k1', Name: 'Kung Fu Panda: The Dragon Knight', ProductionYear: 2022, RecursiveItemCount: 20 }] : [];
  return { ok: true, status: 200, json: async () => ({ Items: items, SearchHints: items.map((i) => ({ ...i, ItemId: i.Id })) }) };
};
const found = await findSeries('kungfu panda', { base: 'http://j', token: 't', fetchImpl, bestMatch });
ok('kungfu panda finds Kung Fu Panda', found?.id === 'k1');
process.exit(failed ? 1 : 0);
