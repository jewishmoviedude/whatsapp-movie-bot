/* When the library's name and OMDb's name differ.
   Run: node test/title-mismatch.test.mjs

   Real case: "Guardians of the Galaxy Vol. 2 (2017)". OMDb canonicalises it
   with a colon, Jellyfin stores it without one, and Jellyfin's searchTerm is a
   single un-tokenised filter over the stored name - so the term has to appear
   as a literal contiguous run. Measured against the real server:

     searchTerm "Guardians of the Galaxy: Vol. 2"  ->  0 results
     searchTerm "Guardians"                        ->  14, including it

   One colon, and the requester was told a film sitting on the server was not
   in the library.

   Second real case from the same request: the admin worked around it by
   pasting the Jellyfin URL, and THAT failed too - queueLibraryItem trusted the
   Path Jellyfin reported without checking it existed on this machine. It is
   the media server's path, shared only when the same storage is mounted here.
   It was on the old box and is not on this one, so the job went straight to
   "using library file in place: /mnt/stor01/..." and died in ffprobe 80ms
   later. The escape hatch failed in exactly the case you reach for it. */
import fs from 'node:fs';
import { discoverTitle } from '../src/plugins/movie-requests/library.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

/** A Jellyfin whose searchTerm behaves like the real one: contiguous substring. */
function provider(titles) {
  const calls = [];
  return {
    calls,
    async rawSearch(term) {
      calls.push(term);
      const t = term.toLowerCase();
      return titles.filter((x) => x.title.toLowerCase().includes(t));
    },
  };
}

const SHELF = [
  { title: 'Guardians of the Galaxy', year: 2014 },
  { title: 'Guardians of the Galaxy Vol. 2', year: 2017 },
  { title: 'Guardians of the Galaxy Vol. 3', year: 2023 },
  { title: 'Legend of the Guardians: The Owls of Ga\'Hoole', year: 2010 },
  { title: 'Ice Guardians', year: 2016 },
];

console.log('=== the colon that hid a film ===');
{
  const p = provider(SHELF);
  // The exact phrase matches nothing, which is what the real server does.
  ok((await p.rawSearch('Guardians of the Galaxy: Vol. 2')).length === 0,
    'the full canonical title matches nothing, as on the real server');

  const got = await discoverTitle(p, 'Guardians of the Galaxy: Vol. 2', { threshold: 0.72 });
  ok(!!got, 'but a word search recovers it');
  ok(got.title === 'Guardians of the Galaxy Vol. 2', `and picks the right one of three: "${got?.title}"`);
  ok(got.year === 2017, 'with the right year');
}

console.log('=== it searches words, not the phrase ===');
{
  const p = provider(SHELF);
  await discoverTitle(p, 'Guardians of the Galaxy: Vol. 2', { threshold: 0.72 });
  ok(p.calls.every((c) => !c.includes(' ')), `single words only (${p.calls.slice(0, 3).join(', ')})`);
  ok(p.calls.some((c) => /guardians/i.test(c)), 'including the most selective word');
}

console.log('=== it does not invent a match ===');
{
  const p = provider(SHELF);
  ok(await discoverTitle(p, 'The Shawshank Redemption', { threshold: 0.72 }) === null,
    'a film that is not there stays not there');
  // Sharing one word is not a match.
  const q = provider([{ title: 'Ice Guardians', year: 2016 }]);
  ok(await discoverTitle(q, 'Guardians of the Galaxy: Vol. 2', { threshold: 0.72 }) === null,
    'a shared word alone is not enough');
}

console.log('=== it stops early on a strong hit ===');
{
  const p = provider(SHELF);
  await discoverTitle(p, 'Guardians of the Galaxy', { threshold: 0.72 });
  // An exact hit on the first word means there is no reason to keep widening.
  ok(p.calls.length <= 2, `stopped after ${p.calls.length} search(es) rather than trying every prefix`);
}

console.log('=== the requester\'s own spelling can outscore OMDb\'s ===');
{
  // Real case, 2026-09-28: OMDb resolved "the fantastic 4: first steps 2025"
  // to "The Fantastic Four: First Steps", which Jellyfin holds as "The
  // Fantastic 4: First Steps" - scored only 0.85 against wantTitle, under
  // this function's 0.9 bar, so the film was reported not in the library
  // three times while it sat there under the requester's own spelling.
  const shelf = [{ title: 'The Fantastic 4: First Steps', year: 2025 }];
  const p = provider(shelf);
  const missed = await discoverTitle(p, 'The Fantastic Four: First Steps', { threshold: 0.9 });
  ok(missed === null, 'wantTitle alone still misses it, as it did on 2026-09-28');

  const got = await discoverTitle(p, 'The Fantastic Four: First Steps', {
    threshold: 0.9,
    alsoTry: ['the fantastic 4: first steps 2025'],
  });
  ok(!!got, 'but scoring the requester\'s own text (year stripped) finds it');
  ok(got?.title === 'The Fantastic 4: First Steps', `and it is the right title: "${got?.title}"`);

  // alsoTry must still lose "movie"/"film" only as a SEARCH word, not as a
  // MATCH word - dropping it here would repeat the Deathly Hallows incident:
  // "the muppet movie" scoring as "the muppet" and matching a different film.
  const muppets = provider([
    { title: 'The Muppet Movie', year: 1979 },
    { title: 'The Muppet Christmas Carol', year: 1992 },
  ]);
  const wrong = await discoverTitle(muppets, 'The Muppets', {
    threshold: 0.9,
    alsoTry: ['the muppet movie'],
  });
  ok(wrong?.title !== 'The Muppet Christmas Carol',
    'the typed text is still matched as a title, not thinned into a bare search word');
}

console.log('=== findInLibrary reaches for it only after the direct attempts ===');
{
  const lib = fs.readFileSync(new URL('../src/plugins/movie-requests/library.js', import.meta.url), 'utf8');
  const body = lib.slice(lib.indexOf('export async function findInLibrary'));
  const direct = body.indexOf('for (const t of attempts)');
  const fallback = body.indexOf('discoverTitle(provider');
  ok(direct > 0 && fallback > direct, 'the cheap exact attempts run first');
  ok(/searching again for that/.test(body), 'and the recovered name is re-searched to get a full match');
  // A title that already resolves must not pay for the fallback.
  ok(/if \(!match\) \{[\s\S]{0,400}discoverTitle/.test(body), 'the fallback is gated on a miss');
}

console.log('=== a path Jellyfin reports is not a path that exists HERE ===');
{
  const src = fs.readFileSync(new URL('../src/plugins/movie-requests/index.js', import.meta.url), 'utf8');
  ok(/function readableHere\(p\)/.test(src), 'there is a readability check');
  ok(/fs\.accessSync\(p, fs\.constants\.R_OK\)/.test(src),
    'and it tests readability, not just existence - a mount can be present but unreadable');
  ok(/access: readableHere\(item\.localPath\) \? 'local' : 'download'/.test(src),
    'the queue-from-a-link path uses it');
  ok(!/access: item\.localPath \? 'local' : 'download'/.test(src),
    'and no longer trusts the reported path blindly');
  ok(/is not readable on this server - downloading instead/.test(src),
    'the fallback says why, instead of silently changing behaviour');
}

console.log('=== readableHere itself ===');
{
  const { pathToFileURL } = await import('node:url');
  void pathToFileURL;
  // Exercised through the real filesystem rather than a stub: the whole bug
  // was a check that was never made against a real disk.
  const src = fs.readFileSync(new URL('../src/plugins/movie-requests/index.js', import.meta.url), 'utf8');
  const fn = new Function('fs', `${src.match(/function readableHere\(p\)[\s\S]*?\n\}/)[0]}; return readableHere;`)(fs);
  ok(fn(null) === false, 'null is not readable');
  ok(fn('/mnt/stor01/definitely/not/here.mkv') === false, 'a missing mount is not readable');
  ok(fn(new URL('../package.json', import.meta.url).pathname) === true, 'a real file is');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
