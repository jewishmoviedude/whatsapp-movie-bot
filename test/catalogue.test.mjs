/* The clean-title catalogue. Run: node test/catalogue.test.mjs

   A list of what the bot may send, built by walking the whole library. Two
   things matter more than the walk itself: an unrated file must NOT count as
   clean (nobody has checked it, and this list decides what can go out), and
   the committed file must carry nothing but titles - it leaves the machine. */
import fs from 'node:fs';
import { isClean, scanLibrary, formatCatalogue } from '../src/core/catalogue.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const BLOCKED = ['R', 'NC-17', 'X', 'TV-MA'];

console.log('=== what counts as clean ===');
{
  for (const r of ['G', 'PG', 'PG-13', 'TV-G', 'TV-PG', 'TV-14']) {
    ok(isClean(r, BLOCKED), `${r} is allowed`);
  }
  for (const r of ['R', 'NC-17', 'X', 'TV-MA']) {
    ok(!isClean(r, BLOCKED), `${r} is not`);
  }
  ok(isClean('r', BLOCKED) === false, 'case does not let a blocked rating through');
  ok(isClean(' R ', BLOCKED) === false, 'nor does whitespace');
}

console.log('=== an UNRATED file is never assumed clean ===');
{
  // The cautious way round on purpose: unrated means nobody checked, and this
  // list is used to decide what may be sent.
  ok(!isClean(null, BLOCKED), 'a missing rating is not clean');
  ok(!isClean('', BLOCKED), 'nor is an empty one');
  ok(!isClean(undefined, BLOCKED), 'nor undefined');
}

console.log('=== the whole library is walked, page by page ===');
{
  const all = Array.from({ length: 450 }, (_, i) => ({
    Name: `Film ${String(i).padStart(3, '0')}`,
    ProductionYear: 2000 + (i % 20),
    OfficialRating: ['G', 'PG', 'PG-13', 'R', null][i % 5],
  }));
  const calls = [];
  const pager = async (start, limit) => {
    calls.push([start, limit]);
    return { items: all.slice(start, start + limit), total: all.length };
  };

  const res = await scanLibrary(pager, { blocked: BLOCKED });
  ok(res.scanned === 450, `every item was scanned (${res.scanned})`);
  ok(calls.length >= 3, `it paged rather than asking for everything at once (${calls.length} calls)`);
  ok(res.clean.length === 270, `only the clean ones are kept (${res.clean.length})`);
  ok(res.skipped.blocked === 90, `R-rated titles counted as blocked (${res.skipped.blocked})`);
  ok(res.skipped.unrated === 90, `unrated titles counted separately (${res.skipped.unrated})`);
  ok(res.clean.every((m) => !BLOCKED.includes(m.rated)), 'nothing blocked slipped into the list');
}

console.log('=== the list is sorted, so it can be read ===');
{
  const items = [
    { Name: 'Zulu', ProductionYear: 1964, OfficialRating: 'PG' },
    { Name: 'Amelie', ProductionYear: 2001, OfficialRating: 'PG-13' },
    { Name: 'Amelie', ProductionYear: 1990, OfficialRating: 'G' },
  ];
  const res = await scanLibrary(async () => ({ items, total: items.length }), { blocked: BLOCKED });
  ok(res.clean[0].title === 'Amelie' && res.clean[0].year === 1990, 'alphabetical, then by year');
  ok(res.clean[2].title === 'Zulu', 'and Z comes last');
}

console.log('=== a short page ends the walk ===');
{
  let calls = 0;
  const pager = async () => { calls += 1; return { items: [{ Name: 'One', OfficialRating: 'G' }], total: null }; };
  const res = await scanLibrary(pager, { blocked: BLOCKED });
  ok(calls === 1, 'a page smaller than the limit is taken as the last one');
  ok(res.clean.length === 1, 'and its contents are kept');
}

console.log('=== an empty library is not an error ===');
{
  const res = await scanLibrary(async () => ({ items: [], total: 0 }), { blocked: BLOCKED });
  ok(res.clean.length === 0, 'nothing is listed');
  ok(res.scanned === 0, 'and nothing was scanned');
}

console.log('=== the committed file carries titles and nothing else ===');
{
  const res = await scanLibrary(async () => ({
    items: [{ Name: 'Paddington', ProductionYear: 2014, OfficialRating: 'PG',
              Path: '/mnt/stor01/movies/Paddington (2014)/Paddington.mkv',
              Id: '4b67438052828bc5db5baab344406274' }],
    total: 1,
  }), { blocked: BLOCKED });

  const md = formatCatalogue(res, { blocked: BLOCKED });
  ok(/Paddington \(2014\) — PG/.test(md), 'the title, year and rating are there');

  // This file is committed, so anything server-shaped in it leaves the machine.
  ok(!/mnt|stor01|\.mkv/.test(md), 'no filesystem path');
  ok(!/4b674380/.test(md), 'no Jellyfin item id');
  // Look for real credentials, not the words - the header legitimately says
  // "no server address or token", which a naive word match trips over.
  ok(!/https?:\/\//.test(md), 'no URL');
  ok(!/api_?key\s*[=:]/i.test(md), 'no api key parameter');
  ok(!/\b[0-9a-f]{24,}\b/i.test(md), 'no long hex id or token');
  ok(!/Id|Path/.test(JSON.stringify(res.clean)), 'and the stored entries hold neither either');
}

console.log('=== the file explains its own exclusions ===');
{
  const res = await scanLibrary(async () => ({
    items: [
      { Name: 'Clean', OfficialRating: 'PG' },
      { Name: 'Blocked', OfficialRating: 'R' },
      { Name: 'Unknown', OfficialRating: null },
    ], total: 3,
  }), { blocked: BLOCKED });
  const md = formatCatalogue(res, { blocked: BLOCKED });
  ok(/Excluded: R, NC-17, X, TV-MA/.test(md), 'it names the excluded ratings');
  ok(/1 title\(s\)/.test(md), 'and how many that removed');
  ok(/Unrated and therefore not listed/.test(md), 'and says unrated files are left out');
  ok(/nobody has checked/.test(md), 'explaining why, so the omission is not mistaken for a bug');
}

console.log('=== the portal offers it without running it on every load ===');
{
  const api = fs.readFileSync(new URL('../src/web/api.js', import.meta.url), 'utf8');
  ok(/router\.get\('\/catalogue'/.test(api), 'reading the list is a plain GET');
  ok(/router\.post\('\/catalogue\/refresh'/.test(api), 'rebuilding it is a deliberate POST');
  ok(/if \(catalogueRun\)/.test(api), 'and two rebuilds cannot overlap');
  ok(/rebuilt the clean-title catalogue/.test(api), 'the rebuild is audited');
  ok(/library'\)/.test(api) && !/data', 'library/.test(api),
    'the file is written outside data/, which is gitignored for holding the session');

  const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
  ok(/id="btn-cat-refresh"/.test(html), 'there is a button');
  ok(/id="cat-search"/.test(html), 'and a filter, since the list is long');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
