/* A year in brackets on a title does not make it another film.
   Run: node test/title-bracketed-year.test.mjs

   Incident, 2026-10-04 17:26 UTC: a member asked for "avengers: endgame
   encore". OMDb's relaxed search resolved it to an entry titled "Avengers:
   Endgame (2019)". The library holds "Avengers: Endgame", similarity was 0.79
   (under the 0.9 file gate), and the file was refused as "a different film",
   so the request was answered "not in the library" though the server has it. */
import { isOtherFilm } from '../src/plugins/movie-requests/film-gate.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

ok(!isOtherFilm({ title: 'Avengers: Endgame (2019)', year: 2019 }, { title: 'Avengers: Endgame', year: 2019 }),
  'the library file is not refused as another film');
ok(isOtherFilm({ title: 'Barefoot (2014)', year: 2014 }, { title: 'Barefoot Gen', year: 1983 }), 'a different film is still refused'); // unchanged rule
ok(isOtherFilm({ title: 'Blade Runner 2049', year: 2017 }, { title: 'Blade Runner', year: 1982 }), 'an unbracketed number is part of the title');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
