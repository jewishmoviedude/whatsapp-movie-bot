/* Year disambiguation. The rule: ask for a year only when the SERVER holds
   more than one film with exactly that title. Remakes count; sequels do not.
   Run: node test/ambiguity.test.mjs */
import { normalizeTitle, similarity } from '../src/util/fuzzy.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

// Mirrors sameTitledMatches(): exact normalized-title equality, deduped by year.
function sameTitled(query, items) {
  const wanted = normalizeTitle(query);
  const seen = new Map();
  for (const i of items) {
    if (normalizeTitle(i.title) !== wanted) continue;
    if (!seen.has(i.year)) seen.set(i.year, i);
  }
  return [...seen.values()].sort((a, b) => a.year - b.year);
}

console.log('=== remakes ARE ambiguous ===');
{
  const held = [{title:'Dune',year:1984},{title:'Dune',year:2021},{title:'Dune: Part Two',year:2024}];
  const r = sameTitled('Dune', held);
  ok(r.length === 2, `Dune -> ${r.length} copies (1984, 2021); "Dune: Part Two" excluded`);
}
{
  const held = [{title:'Frozen',year:2010},{title:'Frozen',year:2013}];
  ok(sameTitled('Frozen', held).length === 2, 'Frozen -> 2 (the horror one and the Disney one)');
}
{
  const held = [{title:'The Italian Job',year:1969},{title:'The Italian Job',year:2003}];
  ok(sameTitled('The Italian Job', held).length === 2, 'The Italian Job -> 2');
}

console.log('\n=== sequels are NOT ambiguous ===');
{
  const held = [{title:'Toy Story',year:1995},{title:'Toy Story 2',year:1999},
                {title:'Toy Story 3',year:2010},{title:'Toy Story 4',year:2019}];
  const r = sameTitled('Toy Story', held);
  ok(r.length === 1, `Toy Story -> ${r.length} copy; the sequels are different films`);
  // The trap: a fuzzy threshold would have swept these in.
  ok(similarity('Toy Story', 'Toy Story 2') > 0.9,
     'and they DO score >0.9 on similarity — which is exactly why exact matching is used');
}
{
  const held = [{title:'John Wick',year:2014},{title:'John Wick: Chapter 2',year:2017},
                {title:'John Wick: Chapter 4',year:2023}];
  ok(sameTitled('John Wick', held).length === 1, 'John Wick -> 1; chapters excluded');
}

console.log('\n=== single holdings never prompt ===');
for (const [q, held] of [
  ['Inception', [{title:'Inception',year:2010}]],
  ['The Martian', [{title:'The Martian',year:2015}]],
  ['Interstellar', [{title:'Interstellar',year:2014}]],
]) ok(sameTitled(q, held).length === 1, `${q} -> 1 copy, no prompt`);

console.log('\n=== an obscure same-titled film you do NOT own is irrelevant ===');
{
  // OMDb lists an "Inception" from 2014; if it is not on the server it must
  // not trigger a prompt. This is why the check reads the library, not OMDb.
  const held = [{title:'Inception',year:2010}];
  ok(sameTitled('Inception', held).length === 1, 'only what is actually held counts');
}

console.log('\n=== duplicate entries for one year collapse ===');
{
  const held = [{title:'Dune',year:2021},{title:'Dune',year:2021},{title:'Dune',year:1984}];
  ok(sameTitled('Dune', held).length === 2, 'the same year listed twice counts once');
}

console.log('\n=== title normalization still applies ===');
{
  const held = [{title:'The Lion King',year:1994},{title:'Lion King',year:2019}];
  ok(sameTitled('The Lion King', held).length === 2, 'a leading article does not split a match');
}

console.log(`\n${'='.repeat(50)}\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
