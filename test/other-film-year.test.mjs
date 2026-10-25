// Incident: Mia asked for "Barefoot 2014" (twice, 2026-09-29). The library
// held only Barefoot Gen (1983); the title matcher forgives a left-off
// subtitle (0.985), so the re-check adopted the 1983 film and posted it both
// times. A near-identical title with a year far apart is another film.
//
// The rule is differentFilm() in util/fuzzy.js. findInLibrary applies it to
// every candidate, so such a film is never a hit and the request is answered
// "not in the library" (the operator: "she clearly said 2014 in her message
// though so shouldve returned not in library") - pinned end to end in
// near-title-other-year.test.mjs. isOtherFilm(), the file re-check's test,
// applies the same rule as its last line of defence.
//
// The re-check (verifyFileRating) moved from the movie plugin into
// film-gate.js when the bypass-list work was merged the same day, so the
// second half pins that the file re-check still goes by isOtherFilm there and
// that step 4b (fileGate) still refuses the 1983 film as the wrong one.
import { isOtherFilm, verifyFileRating, fileGate } from '../src/plugins/movie-requests/film-gate.js';
import { differentFilm } from '../src/util/fuzzy.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

console.log('=== isOtherFilm, the file re-check ===');
ok(isOtherFilm({ title: 'Barefoot', year: 2014 }, { title: 'Barefoot Gen', year: 1983 }), 'prefix title with a 31-year gap is another film');
ok(!isOtherFilm({ title: 'Toy Story', year: 1995 }, { title: 'Toy Story', year: 1995 }), 'same film is not another');
ok(!isOtherFilm({ title: 'Dune', year: 2021 }, { title: 'Dune', year: 1984 }), 'identical title, different year keeps the old behaviour');
ok(!isOtherFilm({ title: 'Barefoot Gen', year: 1983 }, { title: 'Barefoot Gen', year: 1984 }), 'one year apart is the same film');
ok(isOtherFilm({ title: 'Joker', year: 2019 }, { title: 'Poker', year: 2019 }), 'different title is another film');

// OMDb, stubbed: the library's file looked up again by its own title and year.
const OMDB = {
  'barefoot gen|1983': { Title: 'Barefoot Gen', Year: '1983', Rated: 'Not Rated', imdbID: 'tt0085218' },
  'dune|1984': { Title: 'Dune', Year: '1984', Rated: 'PG-13', imdbID: 'tt0087182' },
};
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.hostname !== 'www.omdbapi.com') return new Response('{}', { status: 404 });
  const hit = OMDB[`${String(u.searchParams.get('t') ?? '').toLowerCase()}|${u.searchParams.get('y')}`];
  return json(hit ? { ...hit, Type: 'movie', Released: 'N/A', DVD: 'N/A', Response: 'True' }
    : { Response: 'False', Error: 'Movie not found!' });
};
const cfg = { blockedRatings: ['R', 'NC-17', 'X'] };
const wanted = { title: 'Barefoot', year: 2014, rated: 'PG-13' };
const file = { title: 'Barefoot Gen', year: 1983, id: 'j1' };

console.log('=== the file re-check, in film-gate.js, refuses Barefoot Gen for Barefoot 2014 ===');
{
  const rc = await verifyFileRating(file, wanted, cfg, { omdbKey: 'k' });
  ok(rc.rechecked && rc.mismatch === true && rc.found?.title === 'Barefoot Gen',
    `the 1983 file is reported as a different film (${JSON.stringify({ mismatch: rc.mismatch, found: rc.found?.title })})`);
  ok(rc.movie === wanted, 'and the film asked for is not swapped for it');
  const gate = await fileGate({ movie: wanted, hit: file, cfg, omdbKey: 'k' });
  ok(gate.refused === 'wrong-film', `step 4b refuses it as the wrong film (${gate.refused})`);
}

console.log('=== an identical title of another year is still adopted, as before ===');
{
  const asked = { title: 'Dune', year: 2021, rated: 'PG-13' };
  const rc = await verifyFileRating({ title: 'Dune', year: 1984, id: 'j2' }, asked, cfg, { omdbKey: 'k' });
  ok(rc.rechecked && !rc.mismatch && rc.movie?.year === 1984, `the 1984 Dune is judged as itself (${rc.movie?.year})`);
}

console.log('=== differentFilm, the rule the library lookup applies ===');
ok(differentFilm({ title: 'Barefoot', year: 2014 }, { title: 'Barefoot Gen', year: 1983 }),
  'Barefoot (2014) and Barefoot Gen (1983) are different films');
ok(differentFilm({ title: 'Barefoot', year: '2014' }, { title: 'Barefoot Gen', year: '1983' }),
  'years given as strings are compared as numbers');
ok(!differentFilm({ title: 'Mission: Impossible - Dead Reckoning', year: 2023 },
  { title: 'Mission: Impossible - Dead Reckoning Part One', year: 2023 }), 'a left-off subtitle in the same year is the same film');
ok(!differentFilm({ title: 'Mission: Impossible - Dead Reckoning', year: 2023 },
  { title: 'Mission: Impossible - Dead Reckoning Part One', year: 2022 }), 'and one year off still is');
ok(!differentFilm({ title: 'Dune', year: 2021 }, { title: 'Dune', year: 1984 }),
  'an identical title is left to the remake handling, as before');
ok(!differentFilm({ title: 'Beekeeper', year: 1991 }, { title: 'The Beekeeper', year: 2024 }),
  'identical once normalised (a leading article) counts as identical');
ok(!differentFilm({ title: 'Guardians of the Galaxy: Vol. 2', year: 2017 }, { title: 'Guardians of the Galaxy Vol. 2', year: 2014 }),
  'and so does punctuation');
ok(!differentFilm({ title: 'Barefoot', year: null }, { title: 'Barefoot Gen', year: 1983 }),
  'no year asked for: nothing to disagree about');
ok(!differentFilm({ title: 'Barefoot', year: 2014 }, { title: 'Barefoot Gen', year: null }),
  'no year on the library copy: nothing to disagree about');
ok(isOtherFilm({ title: 'Barefoot', year: 2014 }, { title: 'Barefoot Gen', year: 1983 })
  === differentFilm({ title: 'Barefoot', year: 2014 }, { title: 'Barefoot Gen', year: 1983 }),
  'the re-check and the lookup agree on the incident');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
