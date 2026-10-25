// Incident: Zoe asked for "The hunger games: Ballad of songbirds and snakes"
// (2026-10-22). OMDb resolved it to an event listing, "... Songbirds and Snakes
// - The IMAX Live World Premiere Red Carpet, Lionsgate" (tt36110019), and the
// library's real film, "... Songbirds & Snakes" (2023), was refused as a
// different film: "not in the library". A library title plus a " - " tail in
// the same year is the same film; a different year or head is not.
import { isOtherFilm } from '../src/plugins/movie-requests/film-gate.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const lib = { title: 'The Hunger Games: The Ballad of Songbirds & Snakes', year: 2023, imdbId: 'tt10366206' };
const ev = (t, y = 2023) => ({ title: t, year: y, imdbId: 'tt36110019' });
ok(!isOtherFilm(ev('The Hunger Games: The Ballad of Songbirds and Snakes - The IMAX Live World Premiere Red Carpet, Lionsgate'), lib), 'event listing is the library film');
ok(isOtherFilm(ev('The Hunger Games: The Ballad of Songbirds and Snakes - The IMAX Live World Premiere Red Carpet, Lionsgate', 1990), lib), 'another year stays another film');
ok(isOtherFilm(ev('The Hunger Games - Something Else'), lib), 'a different head stays another film');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
