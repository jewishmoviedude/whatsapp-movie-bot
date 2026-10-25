/* Falling back to another copy when a library entry's file is gone.
   Run: node test/library-fallback.test.mjs

   Real case: the library held Green Book twice. The bot picked the 747 MB
   entry, whose file no longer existed on disk, and the request failed with
   HTTP 404 — while a working 1.7 GB copy sat right there. */
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const src = fs.readFileSync(new URL('../src/plugins/movie-requests/index.js', import.meta.url), 'utf8');
const lib = fs.readFileSync(new URL('../src/plugins/movie-requests/library.js', import.meta.url), 'utf8');

console.log('=== the library surfaces alternate copies ===');
{
  ok(/primary\.alternates = ranked/.test(lib), 'find() attaches ranked alternates');
  ok(/c\.item\.Id !== match\.item\.Id/.test(lib), 'the chosen copy is not repeated in its own alternates');
  ok(/c\.score >= threshold/.test(lib), 'only copies that actually match the title are offered');
  ok(/const alternates = \(match\.alternates \?\? \[\]\)\.map/.test(lib), 'each alternate gets its own download URL');
  ok(/alternates,/.test(lib), 'and they are returned to the caller');
}

console.log('=== the download step tries them ===');
{
  const block = src.match(/const copies = \[hit[\s\S]*?if \(dlErr\) throw dlErr;/)[0];
  ok(/\[hit, \.\.\.\(hit\.alternates \?\? \[\]\)/.test(block), 'the primary is tried first, then the alternates');
  ok(/filter\(\(a\) => a\.downloadUrl\)/.test(block), 'only alternates with a usable URL are tried');
  ok(/if \(dlErr\) throw dlErr;/.test(block), 'if every copy fails, the error still surfaces');
  ok(/dlErr = null;\s*\n\s*break;/.test(block), 'the loop stops as soon as one copy works');
}

console.log('=== it only retries for the RIGHT failures ===');
{
  const block = src.match(/const copies = \[hit[\s\S]*?if \(dlErr\) throw dlErr;/)[0];
  ok(/HTTP 4\(0\[34\]\|10\)/.test(block), 'retries on 403/404/410 — a file that is gone');
  ok(/if \(!\/HTTP 4\(0\[34\]\|10\)\/\.test\(err\.message \?\? ''\)\) throw err;/.test(block),
    'any other error (network, disk) fails immediately instead of hammering every copy');
  ok(/err\.code === 'CANCELLED' \|\| job\.isCancelled\(\)/.test(block),
    'a cancellation stops at once and is never mistaken for a broken copy');
  ok(block.indexOf("CANCELLED") < block.indexOf('HTTP 4'), 'cancellation is checked before the retry decision');
}

console.log('=== the retry is visible in the log ===');
{
  ok(/retrying with another copy of/.test(src), 'says when it moves to another copy');
  ok(/is missing on the server/.test(src), 'and says why the previous one failed');
}

/* ---- the ranking logic itself, exercised directly ---- */
console.log('=== ranking picks real alternates only ===');
{
  const { similarity, normalizeTitle } = await import('../src/util/fuzzy.js');
  const items = [
    { Id: 'a', Name: 'Green Book' },
    { Id: 'b', Name: 'Green Book' },          // the second copy
    { Id: 'c', Name: 'The Green Mile' },      // a different film
  ];
  const chosen = items[0];
  const threshold = 0.72;
  const ranked = items
    .map((i) => ({ item: i, score: similarity(normalizeTitle('Green Book'), normalizeTitle(i.Name)) }))
    .filter((c) => c.item.Id !== chosen.Id && c.score >= threshold)
    .sort((a, b) => b.score - a.score);

  ok(ranked.length === 1, 'exactly one alternate is offered');
  ok(ranked[0].item.Id === 'b', 'the duplicate copy');
  ok(!ranked.some((r) => r.item.Id === 'c'), 'a different film is never offered as an alternate');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
