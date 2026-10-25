/* "die hard 3" is Die Hard: With a Vengeance, not a Bruce Willis interview.
   Run: node test/omdb-numbered-sequel-with-its-own-title.test.mjs

   Incident 2026-10-18, 00:54Z: "die hard 3" resolved to "Die Hard 3: Bruce
   Willis Interview" (1995), a short, and the member was answered "not in the
   library" although the library holds Die Hard: With a Vengeance (1995). The
   typed number is held as a hard constraint, so a film without a 3 in its
   title could never replace the short. Pinned: the doubted hit gives way to
   the third well-known film of the franchise by year; nothing changes when the
   first film is not among the results. OMDb is stubbed. */
import { lookupMovie } from '../src/plugins/movie-requests/omdb.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const film = (Title, Year, imdbID, more = {}) => ({
  Title, Year: String(Year), imdbID, Type: 'movie', Response: 'True', Rated: 'R', Runtime: '120 min',
  Genre: 'Action', Writer: 'A', Actors: 'B', Plot: 'x', imdbVotes: '500,000', ...more,
});
const INTERVIEW = film('Die Hard 3: Bruce Willis Interview', 1995, 'tt0000003', { Genre: 'Short, Talk-Show', Runtime: '5 min', imdbVotes: '9' });
const DH1 = film('Die Hard', 1988, 'tt0095016');
const DH2 = film('Die Hard 2', 1990, 'tt0099423');
const DH3 = film('Die Hard: With a Vengeance', 1995, 'tt0112864');
const DH4 = film('Live Free or Die Hard', 2007, 'tt0337978');
const row = (f) => ({ Title: f.Title, Year: f.Year, imdbID: f.imdbID, Type: 'movie' });

const mk = (search) => {
  const table = { 't:die hard 3|': INTERVIEW, 's:die hard 3|': [row(INTERVIEW)], 's:die hard|': search };
  for (const f of [INTERVIEW, DH1, DH2, DH3, DH4]) table[`i:${f.imdbID}`] = f;
  return table;
};
let table;
globalThis.fetch = async (url) => {
  const p = new URL(String(url)).searchParams;
  const key = p.get('i') ? `i:${p.get('i')}` : p.get('t') ? `t:${p.get('t').toLowerCase()}|${p.get('y') ?? ''}` : `s:${p.get('s').toLowerCase()}|${p.get('y') ?? ''}`;
  let body = table[key] ?? { Response: 'False', Error: p.get('i') ? 'Incorrect IMDb ID.' : 'Movie not found!' };
  if (Array.isArray(body)) body = { Response: 'True', Search: body, totalResults: String(body.length) };
  return new Response(JSON.stringify(body), { status: 200 });
};

table = mk([row(DH1), row(DH3), row(DH2), row(DH4), row(INTERVIEW)]);
let f = await lookupMovie('die hard 3', { apiKey: 'test' });
ok(f?.movie?.imdbId === 'tt0112864', `"die hard 3" -> ${f?.movie?.title} (${f?.movie?.year})`);

table = mk([row(DH3), row(DH2), row(DH4), row(INTERVIEW)]);
f = await lookupMovie('die hard 3', { apiKey: 'test' });
ok(f?.movie?.imdbId !== 'tt0112864', 'without the first film among the results the count is not trusted');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
