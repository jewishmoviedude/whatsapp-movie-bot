/* "Mission Impossible" lists every Mission: Impossible film on the server.
   Run: node test/pick-list-punctuation.test.mjs

   2026-09-30, 00:08 UTC, the testing group (beta001, the "which one?" list):

     pick list: "Mission Impossible" matches 0 film(s) on the server;
     sendable: none -> none, nothing on the server matches

   and the ordinary pipeline then found and queued Mission: Impossible (1996)
   - the library holds seven, every one with a colon in its name. The list's
   search sent Jellyfin the words as typed, and Jellyfin's searchTerm is a
   literal, un-tokenised filter over the stored name: "mission impossible"
   is not in "Mission: Impossible". The words were always matched with the
   punctuation folded away (startsWithWords); only the server's filter
   needed it literal. The pipeline found the film because it also searches
   OMDb's own title, colon and all.

   Now, when the typed words find no title starting with them, the list
   searches their first word on its own, and the same matching picks the
   titles off it. An apostrophe the member left out ("oceans eleven" for
   Ocean's Eleven) is matched as well. The Jellyfin stand-in here filters
   literally, as the real server does. */
import { libraryVersions } from '../src/plugins/movie-requests/library.js';
import { decidePickList } from '../src/plugins/movie-requests/pick-list.js';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

let n = 0;
const film = (Name, ProductionYear, OfficialRating = 'PG-13') => ({ Id: `id${++n}`, Name, ProductionYear, OfficialRating, Type: 'Movie' });
const MISSIONS = [
  film('Mission: Impossible', 1996),
  film('Mission: Impossible II', 2000),
  film('Mission: Impossible III', 2006),
  film('Mission: Impossible - Ghost Protocol', 2011),
  film('Mission: Impossible - Rogue Nation', 2015),
  film('Mission: Impossible - Fallout', 2018),
  film('Mission: Impossible - Dead Reckoning Part One', 2023),
];
const LIBRARY = [
  ...MISSIONS,
  film('The Mission', 1986),
  film('Missionary Man', 2007, 'R'),
  film('Ocean’s Eleven', 2001),
  film('Ocean\'s Twelve', 2004),
  film('Spider-Man', 2002),
  film('Spider-Man: Homecoming', 2017),
];

const searches = [];
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.hostname !== 'jf.test' || u.pathname !== '/Items') return new Response('{}', { status: 404 });
  const term = u.searchParams.get('searchTerm') ?? '';
  searches.push(term);
  // As the real server filters: the term, literally, anywhere in the name.
  const limit = Number(u.searchParams.get('Limit')) || Infinity;
  const Items = LIBRARY.filter((f) => f.Name.toLowerCase().includes(term.toLowerCase())).slice(0, limit);
  return new Response(JSON.stringify({ Items }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const library = mergeDefaults({
  provider: 'jellyfin',
  jellyfin: { baseUrl: 'http://jf.test', authMethod: 'apikey', apiKey: 'KEY', accessToken: 'TOK', userId: 'U1' },
}, DEFAULT_CONFIG.library);
const cfg = DEFAULT_CONFIG.movieRequests;
const offer = async (typed) => {
  searches.length = 0;
  const found = await libraryVersions(typed, library);
  return { found, decision: decidePickList(typed, found, cfg, {}) };
};
const titles = (items) => items.map((i) => `${i.title} (${i.year})`);

console.log('=== the stand-in filters as Jellyfin does ===');
{
  const found = await libraryVersions('mission: impossible', library);
  ok(found.versions.length === 7, 'the name with its colon finds all seven');
}

console.log('=== "Mission Impossible" lists every Mission: Impossible film on the server ===');
{
  const { found, decision } = await offer('Mission Impossible');
  ok(searches[0] === 'Mission Impossible' && searches.length === 2 && searches[1] === 'mission',
    `the words as typed find nothing, so their first word is searched (${searches.join(' | ')})`);
  ok(found.versions.length === 7 && titles(found.versions).join(', ') === MISSIONS.map((f) => `${f.Name} (${f.ProductionYear})`).join(', '),
    `every Mission: Impossible film, and nothing else (${titles(found.versions).join(', ')})`);
  ok(decision.kind === 'list' && decision.items.length === 7,
    `offered as a list of seven (${decision.kind}: ${decision.why})`);
  ok(!titles(decision.items).some((t) => /^The Mission|Missionary/.test(t)), 'The Mission and Missionary Man are not on it');
}

console.log('=== the same for a hyphen, and for an apostrophe left out ===');
{
  const spider = await offer('spider man');
  ok(titles(spider.found.versions).join(', ') === 'Spider-Man (2002), Spider-Man: Homecoming (2017)',
    `"spider man": ${titles(spider.found.versions).join(', ')}`);
  const oceans = await offer('oceans');
  ok(titles(oceans.found.versions).join(', ') === 'Ocean’s Eleven (2001), Ocean\'s Twelve (2004)',
    `"oceans": ${titles(oceans.found.versions).join(', ')} (searched ${searches.join(' | ')})`);
  ok(oceans.decision.kind === 'list', `and offered as a list (${oceans.decision.kind}: ${oceans.decision.why})`);
}

console.log('=== a title the typed words find is searched once, as before ===');
{
  const { found } = await offer('Mission: Impossible');
  ok(searches.length === 1 && found.versions.length === 7, `one search (${searches.join(' | ')})`);
  const none = await offer('Barefoot');
  ok(none.found.versions.length === 0 && none.decision.kind === 'none', 'and a title nothing starts with is still nothing');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
