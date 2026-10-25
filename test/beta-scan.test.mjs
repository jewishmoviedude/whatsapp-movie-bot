/* The hourly check reads the beta groups' conversations and reports each test that went wrong, with what the testers saw.
   Run: node test/beta-scan.test.mjs

   The operator, 2026-09-30: "the bot likes to edit it's messages on the test
   group but I need it all logged somewhere for you to check on the hourly
   debug so I don't have to manually report to you, hourly debug analyze the
   recent conversations in that group". The hourly check skipped every beta
   row, so these went unheard until the operator typed them up - the
   transcripts below are those cases, from the testing group that day (UTC):

   - 02:15 "$beta001 john wick": the server holds four John Wick films, all
     R-rated; the pick list listed none of them and the request fell through
     to a single film's "Test passed" at 02:17.
   - 00:08 "Mission Impossible": the pick list's search matched 0 films on
     the server, and the request went on to queue a real download of
     Mission: Impossible (1996).
   - a list of films crammed onto one line.

   Each rule gives its finding from a sample conversation, with the
   conversation attached, every edit included; a clean test gives none; the
   findings are labelled tests and reported under their own heading. */
import { betaFindings, listItems, passedFilm, askedFor } from '../src/core/beta-scan.js';
import { scan, headline } from '../src/core/incident-scan.js';
import { fallbackReport } from '../src/core/hourly-checks.js';
import { formatPickList, formatPicked } from '../src/plugins/movie-requests/pick-list.js';
import { shortenPlot } from '../src/plugins/movie-requests/omdb.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const G = '120363400000000001@g.us';
const DAY = '2026-09-30';
const at = (hms) => `${DAY}T${hms}.000Z`;
const TESTER = { name: 'Mommy', id: '1a2b3c4d' };
const OTHER = { name: 'Aaron', id: '99ffee00' };
const base = { group: G, groupName: 'Testing things' };
const tin = (hms, id, text, from = TESTER, test = { outcome: 'movie', code: 'beta001', typed: '$beta001' }) => ({ ...base, at: at(hms), type: 'in', id, from, text, test });
const out = (hms, id, text, replyTo, extra = {}) => ({ ...base, at: at(hms), type: 'out', id, replyTo, text, code: 'beta001', request: replyTo, ...extra });
const edit = (hms, of, text) => ({ ...base, at: at(hms), type: 'edit', of, text, code: 'beta001' });
const react = (hms, on, emoji) => ({ ...base, at: at(hms), type: 'react', on, emoji });
const note = (hms, ref, fields) => ({ ...base, at: at(hms), type: 'note', ref, ...fields });
const run = (events, hms = '03:00:00', since = at('00:00:00')) => betaFindings({ events, since: Date.parse(since), now: Date.parse(at(hms)), config: {} });
const rules = (fs) => fs.map((f) => f.rule).sort().join(',');

console.log('=== "john wick": four held, none listed, then a single film\'s "Test passed" (02:17 UTC) ===');
const johnWick = [
  tin('02:15:02', 'JW', '$beta001 john wick'),
  react('02:15:03', 'JW', '🔍'),
  note('02:15:09', 'JW', {
    note: 'pick list: none, none of the 4 can be sent', event: 'pick-decision', feature: 'movie-pick-list', query: 'john wick',
    decision: 'none', why: 'none of the 4 can be sent', held: 4, sendable: 0,
    heldTitles: 'John Wick (2014), John Wick: Chapter 2 (2017), John Wick: Chapter 3 - Parabellum (2019), John Wick: Chapter 4 (2023)',
  }),
  note('02:17:10', 'JW', { note: 'test passed: John Wick (2014)', event: 'test-passed', film: { title: 'John Wick', year: 2014 } }),
  react('02:17:10', 'JW', '✅'),
  out('02:17:11', 'B-JW', '✅ Test passed ($beta001): the bot would send *John Wick* (2014), 1.9 GB on the server — nothing was downloaded.', 'JW'),
];
{
  const f = run(johnWick);
  ok(rules(f) === 'pick-none-sendable', `one finding: the list listed none of what the server holds (${rules(f)})`);
  const x = f[0];
  ok(/listed none of the 4 film\(s\) the server holds/.test(x.title) && /fell through to a single film's "Test passed" for John Wick \(2014\)/.test(x.title),
    'its title says what happened, and where the request went instead');
  ok(x.kind === 'beta-test' && x.beta === true && /^Beta test \$beta001 in Testing things:/.test(x.title), 'labelled a test, with its code and group');
  ok(/not a member's request/.test(x.request.detail) && x.request.requester === 'Mommy' && x.request.text === '$beta001 john wick', 'a tester, not a member at fault');
  ok(x.excerpt.length === johnWick.length, 'the whole conversation comes with it');
  ok(x.excerpt.some((l) => /on the server: John Wick \(2014\), John Wick: Chapter 2/.test(l)), 'including what the server held, which the group never saw');
  ok(x.excerpt.some((l) => /BOT \[B-JW replying to JW\]: ✅ Test passed/.test(l)), 'and the answer the tester got');
  ok(!x.rerunnable && !x.restartHelps, 'never re-run, never restarted for');
}

console.log('=== "Mission Impossible": 0 matched, then a real download (00:08 UTC) ===');
{
  const f = run([
    tin('00:08:01', 'MI', '$beta001 Mission Impossible'),
    react('00:08:02', 'MI', '🔍'),
    note('00:08:06', 'MI', { event: 'pick-decision', note: 'pick list: none, nothing on the server matches', query: 'Mission Impossible', decision: 'none', why: 'nothing on the server matches', held: 0, sendable: 0 }),
    react('00:08:20', 'MI', '🎬'),
    react('00:09:40', 'MI', '⬇️'),
  ]);
  ok(rules(f) === 'pick-empty,test-downloaded', `the empty list and the download (${rules(f)})`);
  const empty = f.find((x) => x.rule === 'pick-empty');
  ok(/matched no film on the server for "Mission Impossible", yet the request then went on to a real download/.test(empty.title), `the list's search missed what the request found (${empty.title})`);
  const dl = f.find((x) => x.rule === 'test-downloaded');
  ok(dl.severity === 'error' && /🎬, ⬇️/.test(dl.title), 'a test that downloads is an error, with the reactions that showed it');
}

console.log('=== the messy one-line list ===');
{
  const f = run([
    tin('01:10:00', 'SW', '$beta001 star wars'),
    out('01:10:05', 'B-SW', 'There are 12 films starting with "star wars": Star Wars (1977), The Empire Strikes Back (1980), Return of the Jedi (1983), '
      + 'The Phantom Menace (1999), Attack of the Clones (2002), Revenge of the Sith (2005), The Force Awakens (2015). Send $beta001 #request with a word or the year.', 'SW'),
  ]);
  ok(rules(f) === 'long-reply' && /a list of films with no line breaks/.test(f[0].title), `reported as unreadable on a phone (${f[0]?.title})`);
  const long = run([tin('01:10:00', 'L', '$beta001 x'), out('01:10:05', 'B-L', `${'A sentence of text. '.repeat(90)}`, 'L')]);
  ok(rules(long) === 'long-reply', 'and so is a reply that is simply too long');
}

console.log('=== a clean test gives nothing ===');
{
  const clean = [
    tin('01:00:00', 'V', '$beta001 venom'),
    react('01:00:01', 'V', '🔍'),
    note('01:00:05', 'V', { event: 'pick-decision', note: 'pick list: list, 4 sendable', query: 'venom', decision: 'list', why: '4 sendable', held: 4, sendable: 4 }),
    out('01:00:06', 'B-V', 'Search Results:\n1 Venom (1981) - A kidnapping goes wrong.\n2 Venom (2005) - A swamp killer.\n3 Venom (2011) - Snakes.\n4 Venom (2018) - A symbiote.\nReply with a number (1-4) to test it - nothing is downloaded. This list expires in 10 minutes.', 'V'),
    tin('01:01:00', 'V2', '2', TESTER, null),
    edit('01:01:03', 'B-V', '✔ 2 · Venom (2005) — test passed, nothing sent'),
    note('01:01:03', 'V2', { event: 'test-passed', note: 'test passed: Venom (2005)', film: { title: 'Venom', year: 2005 } }),
    react('01:01:03', 'V2', '✅'),
    out('01:01:04', 'B-V2', '✅ Test passed ($beta001): the bot would send *Venom* (2005) — nothing was downloaded.', 'V2'),
    tin('01:05:00', 'C', 'captain phillips', OTHER, null),
    note('01:05:00', 'C', { note: 'ignored: no test code' }),
  ];
  const f = run(clean);
  ok(f.length === 0, `no finding (${rules(f) || 'none'})`);
  ok(run([...clean, ...johnWick]).length === 1, 'and a clean test beside a bad one leaves only the bad one');
}

console.log('=== a coded test with no answer ===');
{
  const f = run([tin('02:20:00', 'H', '$beta001 heat'), tin('02:55:00', 'H2', '$beta001 ronin')], '03:00:00');
  ok(rules(f) === 'unanswered' && /"\$beta001 heat" from Mommy got no answer/.test(f[0].title), 'reported after ten minutes');
  ok(!f.some((x) => /ronin/.test(x.title)), 'one five minutes old is left for the next hour');
  const pickLeft = run([
    tin('02:00:00', 'P', '$beta001 venom'),
    out('02:00:05', 'B-P', 'Search Results:\n1 Venom (1981)\n2 Venom (2005)\nReply with a number (1-2) to test it', 'P'),
    tin('02:01:00', 'P2', '$beta001 2'),
  ]);
  ok(rules(pickLeft) === 'unanswered' && /"\$beta001 2"/.test(pickLeft[0].title), 'a number answering a list that nothing then happened to');
}

console.log('=== a "Test passed" for another film ===');
{
  const picked = run([
    tin('01:00:00', 'V', '$beta001 venom'),
    out('01:00:06', 'B-V', 'Search Results:\n1 Venom (1981)\n2 Venom (2005)\n3 Venom (2018)\nReply with a number (1-3) to test it', 'V'),
    tin('01:01:00', 'V2', '1', TESTER, null),
    out('01:01:04', 'B-V2', '✅ Test passed ($beta001): the bot would send *Venom* (2018) — nothing was downloaded.', 'V2'),
  ]);
  ok(rules(picked) === 'wrong-film' && /picked 1 · Venom \(1981\), and the test passed for Venom \(2018\)/.test(picked[0].title), 'not the film picked from the list');
  ok(picked[0].excerpt.some((l) => /1 Venom \(1981\)/.test(l)), 'with the list as the tester saw it');
  const named = run([
    tin('01:00:00', 'HP', '$beta001 #request harry potter'),
    out('01:00:04', 'B-HP', '✅ Test passed ($beta001): the bot would send *Fantastic Beasts and Where to Find Them* (2016) — nothing was downloaded.', 'HP'),
  ]);
  ok(rules(named) === 'wrong-film' && /"harry potter" was asked for/.test(named[0].title), 'not the film named');
  const year = run([
    tin('01:00:00', 'Y', '$beta001 venom 2011'),
    out('01:00:04', 'B-Y', '✅ Test passed ($beta001): the bot would send *Venom* (2005) — nothing was downloaded.', 'Y'),
  ]);
  ok(rules(year) === 'wrong-film', 'not the year named');
  const right = run([
    tin('01:00:00', 'R', '$beta001 the matrix reloaded'),
    out('01:00:04', 'B-R', '✅ Test passed ($beta001): the bot would send *The Matrix Reloaded* (2003) — nothing was downloaded.', 'R'),
  ]);
  ok(right.length === 0, 'the film named is no finding');
}

console.log('=== a bot error, a repeat, many edits, ❓ for a code ===');
{
  const err = run([
    tin('01:00:00', 'E', '$beta001 dune'),
    react('01:00:02', 'E', '⚠️'),
    out('01:00:03', 'B-E', '⚠️ Something went wrong looking that up. Try again in a minute.', 'E'),
    { ...base, at: at('01:00:09'), type: 'failed', action: 'edit', of: 'B-E', error: 'Connection Closed' },
  ]);
  ok(err.filter((x) => x.rule === 'bot-error').length === 3 && err.every((x) => x.severity === 'error'), 'the ⚠️ reaction, the ⚠️ reply and the failed edit');
  const rep = run([
    tin('01:00:00', 'C1', '$beta001 cars'),
    out('01:00:04', 'B-C1', '🔍 Search results for "cars"\n1. Cars (2006)', 'C1'),
    tin('01:03:00', 'C2', '$beta001 #request Cars'),
    out('01:03:04', 'B-C2', '✅ Test passed ($beta001): the bot would send *Cars* (2006) — nothing was downloaded.', 'C2'),
    tin('01:30:00', 'C3', '$beta001 cars'),
    tin('01:04:00', 'C4', '$beta001 cars', OTHER),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)));
  const r = rep.filter((x) => x.rule === 'repeat');
  ok(r.length === 1 && /Mommy asked for "Cars" again 3 min after the first time/.test(r[0].title), 'the same tester, the same request, three minutes apart');
  const passedTwice = run([
    tin('02:00:00', 'P1', '$beta001 cars'),
    out('02:00:04', 'B-P1', '✅ Test passed ($beta001): the bot would send *Cars* (2006) — nothing was downloaded.', 'P1'),
    tin('02:03:00', 'P2', '$beta001 cars'),
  ]);
  ok(!passedTwice.some((x) => x.rule === 'repeat'), 'a test that passed and is run again on purpose is not a repeat alarm');
  ok(r[0].excerpt.some((l) => /\[B-C1 replying to C1\]/.test(l)) && r[0].excerpt.some((l) => /\[C2\]/.test(l)), 'with the first answer and the second ask');
  const edits = run([
    tin('01:00:00', 'X', '$beta001 venom'),
    out('01:00:05', 'B-X', 'Search Results:\n1 Venom (1981)\n2 Venom (2005)', 'X'),
    edit('01:01:00', 'B-X', 'Search Results:\n~1 Venom (1981)~ — can\'t be sent\n2 Venom (2005)'),
    edit('01:02:00', 'B-X', 'Search Results:\n~1 Venom (1981)~ — can\'t be sent\n~2 Venom (2005)~ — can\'t be sent'),
    edit('01:03:00', 'B-X', 'replaced — see the newer list'),
    edit('01:04:00', 'B-X', 'expired — send $beta001 #request Venom 2005'),
  ]);
  ok(edits.some((x) => x.rule === 'many-edits' && /edited 4 times/.test(x.title)), 'a list edited four times');
  const m = edits.find((x) => x.rule === 'many-edits');
  ok(m.excerpt.filter((l) => /BOT edited \[B-X\]/.test(l)).length === 4, 'every version of it in the excerpt');
  ok(edits.some((x) => x.rule === 'pick-empty' && /every film struck through/.test(x.title)), 'and the version with every film struck through');
  const q = run([
    tin('01:00:00', 'Q', '$beta05: heat', TESTER, { outcome: 'unknown', code: 'beta005', typed: '$beta005' }),
    react('01:00:01', 'Q', '❓'),
    out('01:00:02', 'B-Q', '❓ $beta005 is not being tested right now. Running tests: $beta003', 'Q'),
  ]);
  ok(rules(q) === 'code-questioned' && /answered ❓/.test(q[0].title), '❓ for a code');
  // beta001 left beta for every group on 2026-10-11 and its code is retired;
  // testers' guides from before still name it, and its ❓ "has finished" is
  // the right answer, not a fault for the hourly check to undo.
  const retired = run([
    tin('01:00:00', 'R', '$beta001 heat', TESTER, { outcome: 'unknown', code: 'beta001', typed: '$beta001' }),
    react('01:00:01', 'R', '❓'),
    out('01:00:02', 'B-R', '❓ $beta001 has finished. To see how the main groups answer a request now, start it with $stamtest. '
      + 'Running tests: $beta003', 'R'),
  ]);
  ok(!retired.some((x) => x.rule === 'code-questioned'), 'but a retired code\'s ❓ is no finding');
}

console.log('=== the scan hands them on, as tests, under their own heading ===');
{
  const now = Date.parse(at('03:00:00'));
  const r = scan({ now, memory: null, betaEvents: johnWick });
  const beta = r.incidents.filter((f) => f.kind === 'beta-test');
  ok(beta.length === 1 && beta[0].ref, 'a beta finding is an incident, researched like any other');
  ok(/1 beta test to look at/.test(headline(r.incidents)), `the headline counts it as a test (${headline(r.incidents)})`);
  const again = scan({ now: now + 3600_000, memory: r.memory, betaEvents: johnWick });
  ok(!again.incidents.some((f) => f.kind === 'beta-test'), 'handled once: the next hour does not report it again');
  const report = fallbackReport({ id: 'x', scanResult: r, claude: { outcome: 'off' } });
  const found = report.split('## Beta tests')[0];
  ok(/## Beta tests in the testing group \(1\)/.test(report), 'the report has a heading of its own for the tests');
  ok(!/john wick/i.test(found), 'and does not list the test among the members\' incidents');
  ok(/```[\s\S]*Mommy \(#1a2b3c4d\) \[JW\]: \$beta001 john wick[\s\S]*BOT \[B-JW replying to JW\]: ✅ Test passed[\s\S]*```/.test(report),
    'with the conversation as the tester saw it');
  console.log('\n--- the report section, as emailed ---\n' + report.slice(report.indexOf('## Beta tests')).split('## Restart')[0]);
}

console.log('=== the paragraphed layout of 2026-09-30: read, and not flagged ===');
{
  // The operator, 2026-09-30, of beta001's replies: "the response from bot is
  // in messy format, message needs to be neater paragraphed". The list and the
  // "Test passed" were laid out as paragraphs (pick-list.js formatPickList,
  // _testPassed, _testPassedWords); the scan reads that layout, and a long list
  // of nine films with their plots is the layout asked for, not a wall.
  // As long as a plot gets (omdb.js shortenPlot, 120 characters).
  const plot = shortenPlot('A retired hit-man is drawn back into the underworld he left behind, and finds that it has not forgotten him, nor forgiven him, either');
  const nine = Array.from({ length: 9 }, (_, i) => ({ title: i ? `John Wick: Chapter ${i + 1}` : 'John Wick', year: 2014 + i, plot }));
  const list = formatPickList(nine, { test: true, query: 'john wick', moreStartWith: 4 });
  ok(list.length > 1500, `the real nine-film list runs past 1,500 characters (${list.length})`);
  const items = listItems(list);
  ok(items.length === 9 && items[0].title === 'John Wick' && items[0].year === 2014 && items[8].n === 9,
    `its films are read, one per block (${items.map((i) => i.n).join()})`);
  const struck = formatPickList(nine.slice(0, 3), { test: true, query: 'john wick', refused: [0] });
  ok(listItems(struck).map((i) => `${i.n}${i.refused ? 'x' : ''}`).join() === '1x,2,3', 'a struck-through film is read as refused');
  const passed = `✅ *Test passed* ($beta001)\n\nThe bot would send *John Wick: Chapter 2* (2015), 1.9 GB.\nNothing was downloaded.`;
  ok(passedFilm(passed)?.title === 'John Wick: Chapter 2' && passedFilm(passed).year === 2015, 'the new "Test passed" names its film');
  const tvOne = passedFilm('✅ *Test passed* ($beta003)\n\nThe bot would queue 10 episodes of *The Office* season 1.\nNothing was downloaded.');
  ok(tvOne?.tv && tvOne.title === 'The Office', `and the new TV one its show (${tvOne?.title})`);

  const convo = [
    tin('01:00:00', 'W', '$beta001 john wick'),
    react('01:00:01', 'W', '🔍'),
    note('01:00:05', 'W', { event: 'pick-decision', note: 'pick list: list, 9 sendable', query: 'john wick', decision: 'list', why: '9 sendable', held: 9, sendable: 9 }),
    out('01:00:06', 'B-W', list, 'W'),
    tin('01:01:00', 'W2', '2', TESTER, null),
    edit('01:01:03', 'B-W', formatPicked(2, nine[1], null, { test: true })),
    note('01:01:03', 'W2', { event: 'test-passed', note: 'test passed: John Wick: Chapter 2 (2015)', film: { title: 'John Wick: Chapter 2', year: 2015 } }),
    react('01:01:03', 'W2', '✅'),
    out('01:01:04', 'B-W2', passed, 'W2'),
  ];
  const clean = run(convo);
  ok(clean.length === 0, `a clean test in the new layout gives nothing - no long-reply for the list (${rules(clean) || 'none'})`);
  const wrong = run([...convo.slice(0, 8), out('01:01:04', 'B-W2', passed.replace('Chapter 2* (2015)', 'Chapter 3* (2016)'), 'W2')]);
  ok(rules(wrong) === 'wrong-film' && /picked 2 · John Wick: Chapter 2 \(2015\), and the test passed for John Wick: Chapter 3 \(2016\)/.test(wrong[0]?.title ?? ''),
    `a pick read against the new list still catches the wrong film (${wrong[0]?.title ?? rules(wrong)})`);
  const wall = run([tin('01:00:00', 'L', '$beta001 dune'), out('01:00:04', 'B-L', `${'word '.repeat(340)}\n\n${'more '.repeat(20)}`, 'L')]);
  ok(rules(wall) === 'long-reply', 'a long reply whose paragraph is itself a wall is still flagged');
}

console.log('=== the helpers ===');
{
  ok(askedFor('$beta001: #request-movie harry potter') === 'harry potter', 'what was asked, without the code or the prefix');
  ok(listItems('Search Results:\n~1 Venom (1981)~ — can\'t be sent\n2 Venom (2005) - plot').map((i) => `${i.n}${i.refused ? 'x' : ''}`).join() === '1x,2', 'a list read line by line');
  ok(passedFilm('✅ Test passed ($beta003): the bot would queue 10 episode(s) of The Office S01 — nothing was downloaded.')?.tv, 'a TV "Test passed" read too');
}

console.log('=== an admin posts the Drive links document into the test group (2026-10-23 19:16 UTC) ===');
{
  // The scan called the .docx "a test went on to a real download"; it is the
  // operator's own post-drive-links, not a film.
  const doc = out('19:16:31', 'CA3B19', 'Google Drive links - everything posted so far (test, for review).', undefined, { document: 'Google Drive Links.docx', code: undefined });
  ok(run([doc]).length === 0, 'a .docx sent to the test group is no download');
  const film = out('19:16:31', 'FILM1', 'x', undefined, { document: 'Heat (1995).mp4', code: undefined });
  ok(rules(run([film])) === 'test-downloaded', 'a film file still is');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
