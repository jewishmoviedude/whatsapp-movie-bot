/* A show typed with its spaces run together is still found.
   Run: node test/series-run-together-title.test.mjs

   Incident (hourly check 2026-10-13): "TheResident season3 episode14" was
   answered "no series matching" while "The Resident" (2018) is in the library. */
import { findSeries, spacedVariant } from '../src/plugins/tv-requests/jellyfin-tv.js';
import { bestMatch } from '../src/util/fuzzy.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const library = [{ Id: 'R', Name: 'The Resident', ProductionYear: 2018, RecursiveItemCount: 60 },
  { Id: 'X', Name: 'Resident Alien', ProductionYear: 2021, RecursiveItemCount: 30 }];
const fetchImpl = async (raw) => {
  const url = new URL(String(raw));
  const term = (url.searchParams.get('searchTerm') ?? '').toLowerCase();
  const Items = term ? library.filter((i) => i.Name.toLowerCase().includes(term)) : library;
  const body = url.pathname.endsWith('/Search/Hints') ? { SearchHints: [] } : { Items, TotalRecordCount: Items.length };
  return { ok: true, status: 200, json: async () => body };
};
const OPTS = { base: 'http://jf', token: 'T', userId: 'U', bestMatch, fetchImpl };

for (const typed of ['TheResident', 'theresident']) {
  const r = await findSeries(typed, OPTS);
  ok(r?.id === 'R' || r?.Id === 'R' || r?.name === 'The Resident', `"${typed}" finds The Resident (${JSON.stringify(r)?.slice(0, 80)})`);
}
ok(spacedVariant('TheResident') === 'The Resident', 'camel case is split');
ok(spacedVariant('The Resident') === null, 'a spaced title has no variant');
ok(await findSeries('Nothingatall', OPTS) === null, 'a show that is not there is still not found');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
