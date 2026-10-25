/* A spare copy of a film is that film: never its sequel, whose IMDb id differs.
   Run: node test/library-alternate-same-film.test.mjs

   Found in review, 2026-10-11. findInLibrary hands back, with the copy it
   chose, every other copy that could stand in for it (`alternates`), and the
   download falls back to the next one with no further check when the
   chosen copy's file is gone (HTTP 403/404/410). A copy qualified on its
   title and year alone: 0.72 alike, and a year either side. A sequel
   qualifies on both - "Kill Bill: Vol. 2" (2004) scores 0.97 against "Kill
   Bill: Vol. 1" (2003) - and the search the lookup now makes for a title the
   server cannot find by its own name (the shelf one word found, "kill",
   which brings back every film with it in its name) put Vol. 2 among the
   candidates. So Vol. 2 was Vol. 1's spare copy, and would have been posted
   under Vol. 1's name. Atlas Shrugged: Part II was Part I's the same way; the
   live library holds that pair, Che: Part One and Two, and The Dark Knight
   Returns, Part 1 and Part 2.

   Pinned here (JellyfinProvider.find in src/plugins/movie-requests/library.js,
   through findInLibrary, against a server that, like the live one, finds
   nothing for a term with a colon in it): a copy carrying another IMDb id
   than the chosen one is never an alternate, whether or not the film asked
   for came with its id; a second copy carrying the same id still is; and a
   copy with no id is judged by its title and year, as before. */
import { findInLibrary, forgetProviderFilterSupport } from '../src/plugins/movie-requests/library.js';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const LIBRARY = mergeDefaults({ provider: 'jellyfin', jellyfin: { baseUrl: 'http://jf.test', authMethod: 'apikey', apiKey: 'KEY', userId: 'U1' } }, DEFAULT_CONFIG.library);

let n = 0;
const film = (Name, ProductionYear, imdb, OfficialRating = 'R') => ({
  Id: String(++n).padStart(32, '0'), Name, ProductionYear, OfficialRating, Type: 'Movie', ProviderIds: imdb ? { Imdb: imdb } : {},
  MediaSources: [{ Path: `/nowhere/${Name} ${n}.mkv`, Size: 17, Container: 'mkv' }],
});
const KB1 = film('Kill Bill: Vol. 1', 2003, 'tt0266697');
const KB2 = film('Kill Bill: Vol. 2', 2004, 'tt0378194');
const ATLAS1 = film('Atlas Shrugged: Part I', 2011, 'tt0480239', 'PG-13');
const ATLAS2 = film('Atlas Shrugged: Part II', 2012, 'tt1985017', 'PG-13');
let LIB = [];

// Jellyfin's searchTerm as the live server answers it (2026-10-11): a
// contiguous piece of the name, case aside, and nothing at all for a term
// with a colon in it. AnyProviderIdEquals is ignored: the whole library.
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const term = u.searchParams.get('searchTerm');
  let items = [];
  if (u.pathname === '/Items' && u.searchParams.get('IncludeItemTypes') === 'Movie') {
    if (term !== null) items = term.includes(':') ? [] : LIB.filter((i) => i.Name.toLowerCase().includes(term.toLowerCase()));
    else if (u.searchParams.has('AnyProviderIdEquals')) items = LIB;
  }
  return new Response(JSON.stringify({ Items: items, TotalRecordCount: items.length }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const spares = (hit) => (hit?.alternates ?? []).map((a) => `${a.title} (${a.year})${a.imdbId ? ` ${a.imdbId}` : ''}`);

console.log('=== a sequel is never a spare copy ===');
{
  LIB = [KB1, KB2];
  forgetProviderFilterSupport();
  const hit = await findInLibrary('Kill Bill: Vol. 1', 2003, LIBRARY, { imdbId: 'tt0266697', alsoTry: ['kill bill vol 1'] });
  ok(hit?.title === 'Kill Bill: Vol. 1' && hit.year === 2003, `Kill Bill: Vol. 1 is found, from the shelf "kill" found (${hit?.title})`);
  ok(!(hit?.alternates ?? []).some((a) => a.imdbId === 'tt0378194'), `and Vol. 2 is not its spare copy (${JSON.stringify(spares(hit))})`);

  forgetProviderFilterSupport();
  const noId = await findInLibrary('Kill Bill: Vol. 1', 2003, LIBRARY, { alsoTry: ['kill bill vol 1'] });
  ok(noId?.title === 'Kill Bill: Vol. 1' && !spares(noId).length,
    `nor when the film asked for came without its id: the chosen copy's own id decides (${JSON.stringify(spares(noId))})`);

  LIB = [ATLAS1, ATLAS2];
  forgetProviderFilterSupport();
  const atlas = await findInLibrary('Atlas Shrugged: Part I', 2011, LIBRARY, { imdbId: 'tt0480239', alsoTry: ['atlas shrugged part 1'] });
  ok(atlas?.title === 'Atlas Shrugged: Part I' && !spares(atlas).length,
    `Atlas Shrugged: Part II is not Part I's spare copy either (${JSON.stringify(spares(atlas))})`);
}

console.log('=== a real second copy still is ===');
{
  const KB1_AGAIN = film('Kill Bill: Vol. 1', 2003, 'tt0266697');
  const KB1_NO_ID = film('Kill Bill: Vol. 1', 2003, null);
  LIB = [KB1, KB2, KB1_AGAIN, KB1_NO_ID];
  forgetProviderFilterSupport();
  const hit = await findInLibrary('Kill Bill: Vol. 1', 2003, LIBRARY, { imdbId: 'tt0266697', alsoTry: ['kill bill vol 1'] });
  const ids = (hit?.alternates ?? []).map((a) => a.id);
  ok(ids.includes(KB1_AGAIN.Id), 'a second copy carrying the same IMDb id is a spare copy');
  ok(ids.includes(KB1_NO_ID.Id), 'a copy with no IMDb id, of the same title and year, is one, as before');
  ok(!ids.includes(KB2.Id), 'and Vol. 2 is still not');
  ok(hit?.alternates?.every((a) => a.downloadUrl), 'every spare copy can be downloaded');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
