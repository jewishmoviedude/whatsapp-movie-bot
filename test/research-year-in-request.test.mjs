/* Library research must not let a typed year drag a title's score down.
   Run: node test/research-year-in-request.test.mjs

   Incident 2026-09-29: Mia asked for "Mr 365 2018" and "Mr. 365. 2018".
   The library holds Mr. 365 (2018), but researchLibrary scored the whole
   request, year included, against "Mr. 365" (0.56, bar 0.78) and both were
   answered "not recognised". */
import { researchLibrary } from '../src/plugins/movie-requests/library.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const realFetch = globalThis.fetch;
let items = [{ Name: 'Mr. 365', ProductionYear: 2018 }];
globalThis.fetch = async () => new Response(JSON.stringify({ Items: items }), { status: 200 });
const cfg = { provider: 'jellyfin', jellyfin: { baseUrl: 'http://jf.test', authMethod: 'apikey', apiKey: 'k', userId: 'u' } };

try {
  let r = await researchLibrary('Mr 365 2018', cfg);
  ok(r?.title === 'Mr. 365', 'a typed year no longer hides the library film of that year');
  r = await researchLibrary('Mr. 365. 2018', cfg);
  ok(r?.title === 'Mr. 365', 'punctuation plus a year is found too');
  r = await researchLibrary('Mr 365 1975', cfg);
  ok(r === null, 'a year that contradicts the library film still counts against it');
} finally {
  globalThis.fetch = realFetch;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
