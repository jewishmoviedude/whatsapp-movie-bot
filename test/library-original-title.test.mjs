/* A film the library names in English is found by the title it was released under.
   Run: node test/library-original-title.test.mjs

   Incident 2026-10-01: AaronX asked for "Le Dîner de cons (1998)" and was told
   "not in the library" while Jellyfin held it as "The Dinner Game" (1998)
   [orig: Le Dîner de cons]. find() only scored Name, never OriginalTitle. */
import { createProvider } from '../src/plugins/movie-requests/library.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const mk = (items) => {
  const p = createProvider({ provider: 'jellyfin', jellyfin: { url: 'http://x', apiKey: 'k' } });
  p.searchItems = async () => items;
  return p;
};
const dinner = { Id: 'a', Name: 'The Dinner Game', OriginalTitle: 'Le Dîner de cons', ProductionYear: 1998 };

console.log('=== original title ===');
{
  const hit = await mk([dinner]).find('Le Dîner de Cons', 1998);
  ok(hit && hit.id === 'a', 'found by its original title');
  ok(hit && hit.title === 'The Dinner Game', 'and keeps the library name');
}
{
  const hit = await mk([{ ...dinner, ProductionYear: 2012 }]).find('Le Dîner de Cons', 1998, { film: { title: 'Le Dîner de Cons', year: 1998, typedYear: 1998 } });
  ok(!hit, 'a different year is still another film');
}
{
  const hit = await mk([{ Id: 'b', Name: 'Dinner Party', OriginalTitle: 'Dinner Party', ProductionYear: 2022 }]).find('Le Dîner de Cons', 1998);
  ok(!hit, 'an unrelated title is not matched');
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
