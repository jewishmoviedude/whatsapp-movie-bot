/* OMDb hands back companion pieces for slightly-off queries.
   Run: node test/omdb-padded-title.test.mjs

   Real case: "The Hobbit: The battle Of Five Armies" - one word short of the
   real title - resolved to the making-of documentary "…- New Zealand: Home of
   Middle-Earth - Part 3". That is not in the library, so the requester was
   told the film was missing, when in fact the server has it and it is simply
   rated R. The wrong reaction sent them chasing the wrong problem.

   Similarity cannot catch this alone: the impostor opens with the asked title
   verbatim and scored 0.940 against the real film's 0.950. */
import fs from 'node:fs';
import { looksPadded } from '../src/plugins/movie-requests/omdb.js';
import { similarity } from '../src/util/fuzzy.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

console.log('=== the case that was reported ===');
{
  const asked = 'The Hobbit: The battle Of Five Armies';
  const doc = 'The Hobbit: The Battle of Five Armies - New Zealand: Home of Middle-Earth - Part 3';
  const film = 'The Hobbit: The Battle of the Five Armies';

  ok(looksPadded(asked, doc), 'the documentary is flagged for verification');
  ok(!looksPadded(asked, film), 'the actual film is not');

  // The reason a plain threshold was never going to work.
  ok(similarity(asked, doc) > 0.9 && similarity(asked, film) > 0.9,
    `both score above any sane threshold (${similarity(asked, doc).toFixed(2)} vs ${similarity(asked, film).toFixed(2)})`);
  ok(similarity(asked, doc) < similarity(asked, film),
    'and the gap between them is one hundredth — far too fine to gate on');
}

console.log('=== ordinary titles are left alone ===');
{
  for (const [asked, got] of [
    ['Toy Story', 'Toy Story'],
    ['Toy Story', 'Toy Story 3'],
    ['Wonder', 'Wonder Woman'],
    ['Frozen', 'Frozen II'],
    ['Predator', 'Predator: Badlands'],
    ['The Batman', 'The Batman'],
    ['Dune', 'Dune: Part Two'],
  ]) {
    ok(!looksPadded(asked, got), `"${asked}" → "${got}" is treated as genuine`);
  }
}

console.log('=== companion pieces are caught ===');
{
  for (const [asked, got] of [
    ['The Batman', 'The Batman Unmasked: The Psychology of the Dark Knight'],
    ['Inception', 'Inception: The Cobol Job'],
    ['Titanic', 'Titanic: The Complete Story - The Legend of the Unsinkable Ship'],
  ]) {
    ok(looksPadded(asked, got), `"${asked}" → "${got.slice(0, 40)}…" is verified first`);
  }
}

console.log('=== nonsense input does not throw ===');
{
  ok(looksPadded('', 'anything') === false, 'an empty query is not padded');
  ok(looksPadded('something', '') === false, 'an empty result is not padded');
  ok(looksPadded(null, undefined) === false, 'null and undefined are safe');
}

console.log('=== a padded hit is verified, not discarded ===');
{
  const src = fs.readFileSync(new URL('../src/plugins/movie-requests/omdb.js', import.meta.url), 'utf8');
  ok(/if \(!looksPadded\(title, direct\.title\)\)/.test(src),
    'a clean direct hit still returns immediately — the common path is unchanged');
  ok(/falling back to the direct hit/.test(src),
    'and a padded one is still used when search finds nothing better');
  ok(/method: 'direct-padded'/.test(src),
    'flagged in the result, so the fallback is visible rather than silent');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
