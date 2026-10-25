/* Title-matching regression suite.  Run: node test/fuzzy.test.mjs */
import { similarity, bestMatch, normalizeTitle, extractYear, cleanRequestText } from '../src/util/fuzzy.js';
const T = 0.72;
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

console.log('=== normalization ===');
ok(normalizeTitle('The Matrix!') === 'matrix', 'article + punctuation');
ok(normalizeTitle('Rocky III') === 'rocky 3', 'roman numerals');
ok(normalizeTitle('Amélie') === 'amelie', 'accents');
ok(normalizeTitle('Fast & Furious') === 'fast and furious', 'ampersand');
ok(extractYear('Dune (2021)') === 2021, 'year extraction');
ok(cleanRequestText('Dune (2021) please 🙏') === 'Dune', 'noise stripping');

console.log('\n=== typos and omitted subtitles SHOULD match ===');
for (const [q, t] of [
  ['jhon wick 4','John Wick: Chapter 4'], ['the matirx','The Matrix'],
  ['spiderman no way home','Spider-Man: No Way Home'], ['toy story','Toy Story 3'],
  ['avengers endgame','Avengers: Endgame'], ['lion king','The Lion King'],
  ['jurasic park','Jurassic Park'], ['the incredables','The Incredibles'],
  ['back to the futrue','Back to the Future'],
  ['star wars a new hope','Star Wars: Episode IV - A New Hope'],
  ['despicable me','Despicable Me 2'], ['gardians of the galaxy','Guardians of the Galaxy'],
  ['harry poter','Harry Potter and the Goblet of Fire'],
  ['the shawshank redemtion','The Shawshank Redemption'],
  ['pirates of the caribean','Pirates of the Caribbean: The Curse of the Black Pearl'],
  ['the godfther','The Godfather'], ['inglorious basterds','Inglourious Basterds'],
  ['lord of the rings return of the king','The Lord of the Rings: The Return of the King'],
]) { const s = similarity(q, t); ok(s >= T, `"${q}" -> "${t}"  ${s.toFixed(2)}`); }

console.log('\n=== different films should NOT match ===');
for (const [q, t] of [
  ['inception','Interstellar'], ['the matrix','The Matador'], ['joker','Poker Face'],
  ['up','Us'], ['cars','Carrie'], ['dune','Dude Where Is My Car'],
  ['heat','Hearts'], ['alien','Alone'], ['saw','Salt'], ['coco','Cars'],
  ['brave','Grave'], ['the ring','The King'],
]) { const s = similarity(q, t); ok(s < T, `"${q}" vs "${t}"  ${s.toFixed(2)} rejected`); }

console.log('\n=== containment is one-way (the "dark night rises" bug) ===');
// A request may omit the end of a title, but a candidate must not omit a
// word the requester actually typed. "Dark Night" is a real film, and it
// used to beat "The Dark Knight Rises" on a request for the latter.
ok(similarity('the dark night rises', 'The Dark Knight Rises') >= T,
   '"the dark night rises" -> "The Dark Knight Rises" matches');
ok(similarity('the dark night rises', 'Dark Night') < T,
   '"the dark night rises" does NOT match "Dark Night"');
ok(similarity('the dark night rises', 'The Dark Knight') < T,
   '"the dark night rises" does NOT match "The Dark Knight"');
ok(similarity('toy story', 'Toy Story 3') >= T,
   'but omitting a sequel number still matches (containment the other way)');
ok(similarity('harry poter', 'Harry Potter and the Goblet of Fire') >= T,
   'and omitting a subtitle still matches');

console.log('\n=== ranking among real candidates ===');
const rank = (q, c, want) => {
  const m = bestMatch(q, c.map((x) => ({ title: x })), { threshold: 0 });
  ok(m.item.title === want, `"${q}" -> "${m.item.title}" (${m.score.toFixed(2)})`);
};
rank('frozen', ['Frozen Ground','Frozen','Frozen II'], 'Frozen');
rank('it', ['It Follows','It','It Chapter Two'], 'It');
rank('the matrix', ['The Matrix Reloaded','The Matrix','The Matador'], 'The Matrix');
rank('toy story 3', ['Toy Story','Toy Story 3','Toy Story 4'], 'Toy Story 3');
rank('jhon wick', ['John Wick: Chapter 4','John Wick','John Wick: Chapter 2'], 'John Wick');
rank('avatar way of water', ['Avatar','Avatar: The Way of Water'], 'Avatar: The Way of Water');

console.log('\n=== year disambiguates remakes ===');
const dunes = [{ title:'Dune', year:1984 }, { title:'Dune', year:2021 }];
ok(bestMatch('dune', dunes, { year:2021 }).item.year === 2021, 'picks 2021');
ok(bestMatch('dune', dunes, { year:1984 }).item.year === 1984, 'picks 1984');

console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
