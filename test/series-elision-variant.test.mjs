// Incident (hourly check 20261022T230001Z): "wild n out season 7" and "season
// 15" were answered "no series matching" although "Nick Cannon Presents: Wild
// 'N Out" (2005) is in the library; Jellyfin finds it only for "wild 'n out".
import { elisionVariant, findSeries } from '../src/plugins/tv-requests/jellyfin-tv.js';
import { bestMatch } from '../src/util/fuzzy.js';

let failed = 0;
function ok(name, cond) { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) failed++; }

ok("wild n out becomes wild 'n out", elisionVariant('wild n out') === "wild 'n out");
ok('a title without a lone n has no variant', elisionVariant('wild out') === null);
ok('a word merely containing n is left alone', elisionVariant('Ben 10') === null);

// A server that, like Jellyfin, matches only the apostrophe spelling.
const fetchImpl = async (url) => {
  const u = decodeURIComponent(String(url));
  const hit = u.includes("searchTerm=wild+'n+out");
  const items = hit ? [{ Id: 'x1', Name: "Nick Cannon Presents: Wild 'N Out", ProductionYear: 2005, RecursiveItemCount: 100 }] : [];
  return { ok: true, status: 200, json: async () => ({ Items: items, SearchHints: items.map((i) => ({ ...i, ItemId: i.Id })) }) };
};
const found = await findSeries('wild n out', { base: 'http://j', token: 't', fetchImpl, bestMatch });
ok("wild n out finds Wild 'N Out", found?.id === 'x1' || found?.name?.includes("Wild 'N Out"));
process.exit(failed ? 1 : 0);
