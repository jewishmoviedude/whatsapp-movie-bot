/* A film typed as one short token is still searched for.
   Run: node test/discover-short-title.test.mjs

   Real case, 2026-10-07: "X2 2003" resolved on OMDb to "X2: X-Men United".
   discoverTitle searched only words longer than two letters ("united", "men"),
   so the library's "X2 (2003)" was never looked up and the member was told it
   was not in the library.

   And the same member at 09:59, after that fix: "X2: X-Men United 2003", the
   full title typed. The fix only searched a typed title that was one token,
   so "X2" was again never looked up, the full title scored 0.23 against the
   library's "X2", and the answer was again "not in the library". The part
   before a colon is a name the library may use on its own - but only for a
   film of the same year, never Dune (2021) for "Dune: Part Two". */
import { discoverTitle } from '../src/plugins/movie-requests/library.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const SHELF = [
  { title: 'X2', year: 2003 }, { title: 'F/X2', year: 1991 },
  { title: 'Men in Black II', year: 2002 }, { title: 'United 93', year: 2006 },
  { title: 'Dune', year: 2021 }, { title: 'Alien', year: 1979 }, { title: 'Borat', year: 2006 },
];
const p = {
  async rawSearch(term) { return SHELF.filter((x) => x.title.toLowerCase().includes(term.toLowerCase())); },
};

const got = await discoverTitle(p, 'X2: X-Men United', { alsoTry: ['X2 2003'], year: 2003 });
ok(got?.title === 'X2' && got.year === 2003, `finds the library's "X2" (${got?.title})`);

const full = await discoverTitle(p, 'X2: X-Men United', { alsoTry: ['X2: X-Men United 2003'], year: 2003 });
ok(full?.title === 'X2' && full.year === 2003, `the full title typed still finds the library's "X2" (${full?.title})`);

const omdbOnly = await discoverTitle(p, 'X2: X-Men United', { year: 2003 });
ok(omdbOnly?.title === 'X2', `so does OMDb's title alone, with nothing typed to go on (${omdbOnly?.title})`);

const borat = await discoverTitle(p, 'Borat: Cultural Learnings of America for Make Benefit Glorious Nation of Kazakhstan', { year: 2006 });
ok(borat?.title === 'Borat', `a long subtitle the library left off: "Borat" (${borat?.title})`);

const dune = await discoverTitle(p, 'Dune: Part Two', { alsoTry: ['dune part two'], year: 2024 });
ok(dune === null, `the part before the colon from another year is another film: not Dune (2021) for Dune: Part Two (${dune?.title})`);

const alien = await discoverTitle(p, 'Alien: Romulus', { year: 2024 });
ok(alien === null, `nor Alien (1979) for Alien: Romulus (${alien?.title})`);

const none = await discoverTitle(p, 'Zzz: Something', { alsoTry: ['Zz'], year: 2003 });
ok(none === null, 'a short token that matches nothing stays not-found');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
