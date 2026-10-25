/* A film the library's search cannot find by its own name is still found.
   Run: node test/library-own-name-unsearchable.test.mjs

   Incident: the live Jellyfin holds tt0076759 as "Star Wars: Episode IV - A
   New Hope" (1977), and its searchTerm "Star Wars: Episode IV - A New Hope"
   answers nothing - the colon, as for "Guardians of the Galaxy: Vol. 2"
   before it. A member asked for it on 2026-09-15 and was told it was not in
   the library, and it sat on the wanted list. On 2026-10-11 the wanted
   list's recheck, run read-only against the live library, showed why: the
   word search found the film under "star", by its IMDb id - "the library
   holds tt0076759 as "Star Wars: Episode IV - A New Hope"" - and then
   searched again for that name, found nothing, and gave up.

   Pinned here (findInLibrary, src/plugins/movie-requests/library.js): when the
   search for the name the word search found answers nothing, the shelf that
   word found is searched again and the library's own name picks the film off
   it, with or without the IMDb id; it is never another Star Wars film; a
   title the server finds by name costs no second search; and the wanted
   list's recheck resolves the entry as the bot. */
import { findInLibrary, forgetProviderFilterSupport } from '../src/plugins/movie-requests/library.js';
import { recheckWanted } from '../src/core/wanted-recheck.js';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const LIBRARY = mergeDefaults({ provider: 'jellyfin', jellyfin: { baseUrl: 'http://jf.test', authMethod: 'apikey', apiKey: 'KEY', userId: 'U1' } }, DEFAULT_CONFIG.library);

let n = 0;
const film = (Name, ProductionYear, imdb, OfficialRating = 'PG') => ({
  Id: String(++n).padStart(32, '0'), Name, ProductionYear, OfficialRating, Type: 'Movie', ProviderIds: imdb ? { Imdb: imdb } : {},
});
// The Star Wars shelf of the live library, 2026-10-11, and a few neighbours.
const LIB = [
  film('Star Wars: Episode II - Attack of the Clones', 2002, 'tt0121765'),
  film('Star Wars: Episode III - Revenge of the Sith', 2005, 'tt0121766', 'PG-13'),
  film('Star Wars: The Clone Wars', 2008, 'tt1185834'),
  film('Star Wars Clone Wars vol 1 (2003)', 2003, null),
  film('Star Wars: Episode IV - A New Hope', 1977, 'tt0076759'),
  film('Lone Star', 1996, 'tt0116905', 'R'),
  film('Stardust', 2007, 'tt0486655', 'PG-13'),
];

// Jellyfin's searchTerm as the live server answers it: a contiguous piece of
// the name, case aside - and nothing at all for a term with a colon in it.
// AnyProviderIdEquals is ignored: the whole library comes back.
const searches = [];
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const term = u.searchParams.get('searchTerm');
  let items = [];
  if (u.pathname === '/Items' && u.searchParams.get('IncludeItemTypes') === 'Movie') {
    if (term !== null) {
      searches.push(term);
      items = term.includes(':') ? [] : LIB.filter((i) => i.Name.toLowerCase().includes(term.toLowerCase()));
      items = items.slice(0, Number(u.searchParams.get('Limit')) || 25);
    } else if (u.searchParams.has('AnyProviderIdEquals')) {
      items = LIB;
    }
  }
  return new Response(JSON.stringify({ Items: items, TotalRecordCount: items.length }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

console.log('=== the server cannot find it by its own name ===');
{
  forgetProviderFilterSupport();
  searches.length = 0;
  const hit = await findInLibrary('Star Wars: Episode IV - A New Hope', 1977, LIBRARY, { imdbId: 'tt0076759' });
  ok(hit?.title === 'Star Wars: Episode IV - A New Hope' && hit.year === 1977 && hit.imdbId === 'tt0076759',
    `found, as the library holds it (${hit?.title} ${hit?.year})`);
  ok(searches.includes('Star Wars: Episode IV - A New Hope') && searches.filter((s) => !s.includes(':')).length >= 2,
    `after the search by its name answered nothing, from the shelf a word found (${searches.join(' | ')})`);

  forgetProviderFilterSupport();
  const noId = await findInLibrary('Star Wars: Episode IV - A New Hope', 1977, LIBRARY, {});
  ok(noId?.title === 'Star Wars: Episode IV - A New Hope' && noId.year === 1977, 'without the IMDb id too, by the title alone');

  forgetProviderFilterSupport();
  const typed = await findInLibrary('Star Wars: Episode IV - A New Hope', 1977, LIBRARY, {
    imdbId: 'tt0076759', alsoTry: ['star wars episode iv a new hope'],
  });
  ok(typed?.year === 1977 && typed.title === 'Star Wars: Episode IV - A New Hope', 'and for a member who typed the whole title');
}

console.log('=== never another Star Wars film ===');
{
  forgetProviderFilterSupport();
  const v = await findInLibrary('Star Wars: Episode V - The Empire Strikes Back', 1980, LIBRARY, { imdbId: 'tt0080684' });
  ok(v === null, `Episode V, which the library lacks, is not found as another episode (${v?.title ?? 'null'})`);
  forgetProviderFilterSupport();
  const ii = await findInLibrary('Star Wars: Episode II - Attack of the Clones', 2002, LIBRARY, { imdbId: 'tt0121765' });
  ok(ii?.title === 'Star Wars: Episode II - Attack of the Clones' && ii.year === 2002, 'and Episode II is Episode II');
}

console.log('=== a title found by its name is searched once ===');
{
  forgetProviderFilterSupport();
  searches.length = 0;
  const hit = await findInLibrary('Stardust', 2007, LIBRARY, { imdbId: 'tt0486655' });
  ok(hit?.title === 'Stardust' && searches.length === 1, `one search (${searches.join(' | ')})`);
}

console.log('=== the wanted list\'s recheck resolves it ===');
{
  forgetProviderFilterSupport();
  const data = {
    wanted: [{ key: 'tt0076759', title: 'Star Wars: Episode IV - A New Hope', year: 1977, imdbId: 'tt0076759', rated: 'PG', reason: 'not-in-library',
      count: 1, firstAt: Date.parse('2026-09-15T12:00:00Z'), lastAt: Date.parse('2026-09-15T12:00:00Z'), requesters: ['A member'] }],
  };
  const store = { get: (k, d = null) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; } };
  const r = await recheckWanted(store, { libraryCfg: LIBRARY, paceMs: 0, log: quiet });
  ok(r.found.length === 1 && data.wanted[0].resolved?.by === 'the bot (found on the server as "Star Wars: Episode IV - A New Hope")',
    `marked resolved by the bot (${data.wanted[0].resolved?.by ?? 'still open'})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
