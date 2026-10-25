/* The not-in-library fault log. Run: node test/library-misses.test.mjs

   A request that dies at the library lookup and nowhere else is the answer the
   bot gets wrong most often, and it used to be the one it recorded least - a
   TV miss left no history row, no wanted entry and not one log line, so
   "you say you do not have Kitchen Nightmares and you plainly do" could not be
   investigated at all after the fact. These pin the record that makes it
   answerable. */
import {
  recordMiss, resolveMiss, listMisses, missCounts, resetMisses, missKey, formatMisses, MISS_REASONS,
} from '../src/core/library-misses.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

/** The tiny slice of the state store these functions actually use. */
function fakeStore(initial = {}) {
  const data = { ...initial };
  return {
    get: (k, d) => (k in data ? data[k] : d),
    set: (k, v) => { data[k] = v; },
    _raw: data,
  };
}

console.log('=== only a genuine library miss is recorded ===');
{
  const s = fakeStore();
  ok(recordMiss(s, { reason: 'not-in-library', title: 'Dune', year: 2021 }) === true,
    'a plain miss is recorded');
  ok(recordMiss(s, { reason: 'empty-season', kind: 'tv', title: 'The Boys', season: 9 }) === true,
    'so is a season the server does not have');
  ok(recordMiss(s, { reason: 'no-such-episode', kind: 'tv', title: 'The Boys', season: 1, episode: 99 }) === true,
    'and an episode it does not have');

  // The list answers "what did we refuse ONLY because we could not find it".
  // Letting a rating block or a theatrical hold in would destroy that.
  ok(recordMiss(s, { reason: 'blocked-rating', title: 'Saw' }) === false, 'a rating block is NOT a library miss');
  ok(recordMiss(s, { reason: 'not-yet-theatrical', title: 'Wicked' }) === false, 'nor is a film still in cinemas');
  ok(recordMiss(s, { reason: 'not-found', title: 'asdfgh' }) === false, 'nor is a title nobody could resolve');
  ok(recordMiss(s, { reason: 'error', title: 'Dune' }) === false, 'nor is a failure');
  ok(listMisses(s).length === 3, 'so only the three real misses are on the list');
}

console.log('=== the same title asked twice is one row with a count ===');
{
  const s = fakeStore();
  recordMiss(s, { title: 'Dune', year: 2021, requester: 'Avi' });
  recordMiss(s, { title: 'Dune', year: 2021, requester: 'Sara' });
  recordMiss(s, { title: 'Dune', year: 2021, requester: 'Avi' });

  const list = listMisses(s);
  ok(list.length === 1, 'one row, not three');
  ok(list[0].count === 3, 'counted three times');
  ok(list[0].requesters.length === 2 && list[0].requesters.includes('Sara'),
    'each requester kept once, so "who asked" survives without duplicates');
}

console.log('=== a season and an episode of the same show are different misses ===');
{
  const s = fakeStore();
  recordMiss(s, { kind: 'tv', reason: 'empty-season', title: 'The Boys', season: 5 });
  recordMiss(s, { kind: 'tv', reason: 'empty-season', title: 'The Boys', season: 6 });
  recordMiss(s, { kind: 'tv', reason: 'no-such-episode', title: 'The Boys', season: 1, episode: 99 });
  ok(listMisses(s).length === 3, 'three distinct rows');

  // A film and a show sharing a name must not collapse into one another.
  const s2 = fakeStore();
  recordMiss(s2, { kind: 'movie', title: 'Fargo', year: 1996 });
  recordMiss(s2, { kind: 'tv', reason: 'empty-season', title: 'Fargo', season: 1 });
  ok(listMisses(s2).length === 2, 'the film Fargo and the show Fargo are separate');
  ok(missKey({ kind: 'movie', title: 'Dune' }) !== missKey({ kind: 'tv', title: 'Dune' }),
    'and the key itself distinguishes them');
}

console.log('=== the newest miss comes first ===');
{
  const s = fakeStore();
  recordMiss(s, { title: 'First' });
  recordMiss(s, { title: 'Second' });
  recordMiss(s, { title: 'First' });      // asked again - now the live one
  ok(listMisses(s)[0].title === 'First', 'a miss that just happened again is at the top');
}

console.log('=== a title that turns up later is KEPT, marked answered ===');
{
  const s = fakeStore();
  recordMiss(s, { title: 'Dune', year: 2021 });
  ok(resolveMiss(s, { kind: 'movie', title: 'Dune', year: 2021 }) === true, 'resolving it reports success');

  const list = listMisses(s);
  // Deleting it would erase the evidence that the bot was ever wrong, which is
  // the single most useful thing this list holds.
  ok(list.length === 1, 'the row is still there');
  ok(list[0].resolved === true && list[0].resolvedAt > 0, 'flagged as answered, with a time');
  ok(listMisses(s, { includeResolved: false }).length === 0, 'and hidden from the "still missing" view');
  ok(resolveMiss(s, { kind: 'movie', title: 'Nothing' }) === false, 'resolving an unknown title is a no-op');
}

// 2026-09-29: until then the movie pipeline marked a miss answered whenever
// the library returned anything, the wrong film included (Barefoot Gen for
// "Barefoot 2014"). A row resolved that way stayed resolved when the film was
// missed again, so it never reached the daily mail or the "still missing"
// view, and the panel called it "turned up later".
console.log('=== a miss that was marked answered and is missed again is open again ===');
{
  const s = fakeStore();
  recordMiss(s, { title: 'Barefoot', year: 2014, request: 'Barefoot 2014', requester: 'Mia' });
  resolveMiss(s, { kind: 'movie', title: 'Barefoot', year: 2014 });
  const resolvedAt = listMisses(s)[0].resolvedAt;
  ok(listMisses(s, { includeResolved: false }).length === 0, 'answered, it is out of the "still missing" view');

  recordMiss(s, {
    title: 'Barefoot', year: 2014, request: 'Barefoot 2014', requester: 'Mia',
    diagnostics: ['closest in the library: "Barefoot Gen" (1983), a different film'],
  });
  const m = listMisses(s)[0];
  ok(m.resolved === false, 'missed again, it is open');
  ok(m.count === 2 && listMisses(s).length === 1, 'still one row, asked twice');
  ok(listMisses(s, { includeResolved: false }).length === 1, 'and back in the "still missing" view');
  ok(/1 request\(s\)/.test(formatMisses(listMisses(s))) && /Barefoot \(2014\)/.test(formatMisses(listMisses(s))),
    'and in the daily mail');
  ok(m.previouslyResolvedAt === resolvedAt && m.reopenedAt >= resolvedAt && !('resolvedAt' in m),
    'when it once turned up is kept, as previouslyResolvedAt');
  ok(missCounts(s).resolved === 0, 'the count of rows that turned up no longer includes it');
  ok(resolveMiss(s, { kind: 'movie', title: 'Barefoot', year: 2014 }) === true,
    'and it can be answered again when it really does turn up');
}

console.log('=== the diagnostics survive, because they are the point ===');
{
  const s = fakeStore();
  recordMiss(s, {
    kind: 'tv', title: 'Kitchen Nightmares', request: 'kitchen nightmares please',
    searched: ['kitchen nightmares'],
    diagnostics: ['"Kitchen Nightmares" is on the server but INVISIBLE to the bot\'s Jellyfin user'],
  });
  const m = listMisses(s)[0];
  ok(m.diagnostics.length === 1 && /INVISIBLE/.test(m.diagnostics[0]),
    'what the lookup actually did is recorded');
  ok(m.request === 'kitchen nightmares please' && m.title === 'Kitchen Nightmares',
    'what was TYPED is kept next to what it was understood as');

  // A second attempt reflects the library as it is NOW, not as it was.
  recordMiss(s, {
    kind: 'tv', title: 'Kitchen Nightmares', request: 'kitchen nightmares',
    diagnostics: ['no series matched "kitchen nightmares" in a library of 412'],
  });
  ok(/library of 412/.test(listMisses(s)[0].diagnostics[0]), 'the newest lookup replaces the old one');
}

console.log('=== filtering and counting ===');
{
  const s = fakeStore();
  recordMiss(s, { kind: 'movie', title: 'Dune', year: 2021, requester: 'Avi' });
  recordMiss(s, { kind: 'movie', title: 'Dune', year: 2021 });
  recordMiss(s, { kind: 'tv', reason: 'empty-season', title: 'The Boys', season: 5 });
  resolveMiss(s, { kind: 'movie', title: 'Dune', year: 2021 });

  ok(listMisses(s, { kind: 'tv' }).length === 1, 'filter by kind');
  ok(listMisses(s, { reason: 'empty-season' }).length === 1, 'filter by reason');
  ok(listMisses(s, { q: 'boys' }).length === 1, 'search matches the title');
  ok(listMisses(s, { q: 'AVI' }).length === 1, 'and the requester, case-insensitively');

  const c = missCounts(s);
  ok(c.all === 2, 'two rows');
  ok(c.asked === 3, 'asked three times between them');
  ok(c.movie === 1 && c.tv === 1, 'counted per kind');
  ok(c.resolved === 1, 'and one has since turned up');
}

console.log('=== bookkeeping never breaks a request ===');
{
  // This runs on an already-failing path. A store that throws must not turn a
  // wrong answer into a crashed handler.
  const broken = { get: () => { throw new Error('disk gone'); }, set: () => {} };
  ok(recordMiss(broken, { title: 'Dune' }) === false, 'a throwing store returns false rather than throwing');
  ok(resolveMiss(broken, { title: 'Dune' }) === false, 'and so does resolving');
}

console.log('=== the list is bounded ===');
{
  const s = fakeStore();
  for (let i = 0; i < 600; i++) recordMiss(s, { title: `Film ${i}` });
  ok(listMisses(s).length === 500, 'capped at 500, so it cannot grow without limit');
}

console.log('=== the email text ===');
{
  ok(/Nothing was refused/.test(formatMisses([])), 'says so when there is nothing');

  const now = Date.now();
  const body = formatMisses([
    { kind: 'movie', title: 'Dune', year: 2021, request: 'dune', count: 2, firstAt: now, reason: 'not-in-library', diagnostics: [] },
    { kind: 'tv', title: 'The Boys', season: 5, request: 'the boys season 5', count: 1, firstAt: now, reason: 'empty-season', diagnostics: [] },
    { kind: 'movie', title: 'Gone', request: 'gone', count: 1, firstAt: now, reason: 'not-in-library', resolved: true, diagnostics: [] },
  ], { now });

  ok(/2 request\(s\)/.test(body), 'counts only what is still missing');
  ok(!/Gone/.test(body), 'a title that turned up is not chased again');
  ok(/Dune \(2021\)/.test(body) && /The Boys S05/.test(body), 'films and shows are both readable');
  ok(/asked as "dune"/.test(body), 'and it shows what was actually typed');
}

console.log('=== the reasons are the ones the UI knows about ===');
{
  ok(Object.keys(MISS_REASONS).length === 3, 'exactly three');
  for (const k of ['not-in-library', 'no-such-episode', 'empty-season']) {
    ok(typeof MISS_REASONS[k] === 'string', `${k} has a label`);
  }
}

console.log('=== reset ===');
{
  const s = fakeStore();
  recordMiss(s, { title: 'Dune' });
  resetMisses(s);
  ok(listMisses(s).length === 0, 'clears the list');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
