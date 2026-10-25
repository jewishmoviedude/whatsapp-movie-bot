/* The scan puts a library keeper's #issue first, as TOP PRIORITY, and never
   in the overflow. Run: node test/keeper-issue-scanned-first-as-top-priority.test.mjs

   The operator, 2026-10-12: "Needless to say #issue tickets submitted by
   head admin 5558100180 get top priority" and "Meaning it should activate bot
   to send yo a notification to check right away". Head Admin looks after the
   Jellyfin library. Her #issue was one error among many, sorted by time: in
   a busy hour, after forty other findings it would have been cut into the
   overflow the research session never reads. Now it is `priority`, its title
   says TOP PRIORITY, it sorts before everything, and the session is told to
   research and fix it first, and to the end. */
import fs from 'node:fs';
import { scan, headline, DEFAULTS } from '../src/core/incident-scan.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const DISCUSSIONS = '120363900000000002@g.us';
const HEAD = '15558100180';
const MIN = 60_000, HOUR = 60 * MIN;
const NOW = Date.parse('2026-10-12T15:00:00Z');
const config = {
  movieRequests: { requestGroups: [], notify: {} }, tvRequests: { requestGroups: [] }, beta: { groups: [], features: {} }, media: {},
  libraryNews: { senders: [HEAD], groups: [DISCUSSIONS] },
};
const state = {
  'movie-requests': { history: [], pending: [] }, 'tv-requests': { history: [], pending: [], 'library-misses': [] },
  'msg-index': { entries: [] }, audit: { events: [] },
};
const memory = { v: 1, lastScanAt: NOW - HOUR, seen: {}, configCheckedAt: NOW };
const issue = (o) => ({ kind: 'issue', group: DISCUSSIONS, groupName: '06 MOVIE DISCUSSIONS', ...o });
const run = (news, o = {}) => scan({ now: NOW, config, names: {}, unit: { ActiveState: 'active', NRestarts: '0' }, state, memory, news, ...o });

// More members' #issues than the dossier holds, every one before hers.
const others = Array.from({ length: DEFAULTS.maxIncidents + 5 }, (_, i) => issue({
  at: NOW - 50 * MIN + i * 1000, id: `M${i}`, sender: `1856843${String(1000 + i)}`, name: `Member ${i}`, text: `#issue episode ${i} will not play`,
}));
const hers = issue({ at: NOW - 2 * MIN, id: 'MOM1', sender: HEAD, name: 'Head Admin', keeper: true, text: '#issue #group01 the encode on X2 is green' });

console.log('=== her #issue is first, whatever else the hour found ===');
{
  const r = run([...others, hers]);
  const first = r.incidents[0];
  ok(r.incidents.length === DEFAULTS.maxIncidents && r.overflow === others.length + 1 - DEFAULTS.maxIncidents,
    `more findings than the dossier holds (${others.length + 1}; ${r.overflow} in the overflow)`);
  ok(first?.report?.text === hers.text && first.ref === 'I1', 'hers is I1, though it is the newest of them all');
  ok(first?.priority === true && first.severity === 'error' && first.kind === 'member-issue', 'marked priority, an error, a member-issue');
  ok(/^TOP PRIORITY: Head Admin \(\+1555\*\*\*0180\), who looks after the library, reported an issue: "the encode on X2 is green"$/.test(first?.title ?? ''),
    `the title says TOP PRIORITY: ${first?.title}`);
  ok(/research this first, before anything else in the dossier, and to the end/.test(first?.remedy ?? '') && /first in the report/.test(first?.remedy ?? ''),
    'the remedy: research it first and to the end, and put it first in the report');
  ok(!JSON.stringify(first).includes(HEAD), 'her full number appears nowhere in it');
  ok(r.incidents.filter((f) => f.priority).length === 1, 'and nobody else\'s #issue is priority');
  const nobody = run([...others]);
  ok(nobody.incidents[0].report.text === others[0].text, 'without hers, the oldest error leads, as before');
  const mixed = headline([{ kind: 'request-failed' }, { kind: 'request-failed' }, { kind: 'member-issue', priority: true }]);
  ok(mixed === '1 issue a member reported, 2 failed requests', `the headline names it first, though other kinds outnumber it: ${mixed}`);
  ok(headline([{ kind: 'request-failed' }, { kind: 'request-failed' }, { kind: 'member-issue' }]) === '2 failed requests, 1 issue a member reported',
    'and without it, the most first, as before');
}

console.log('=== a row from before keeper: true, by the watched number ===');
{
  const { keeper, ...unmarked } = hers;
  void keeper;
  const r = run([...others.slice(0, 3), unmarked]);
  ok(r.incidents[0]?.priority === true && /^TOP PRIORITY:/.test(r.incidents[0].title), 'her number in libraryNews.senders makes it priority');
  const r2 = run([...others.slice(0, 3), unmarked], { config: { ...config, libraryNews: { senders: [], groups: [DISCUSSIONS] } } });
  ok(!r2.incidents.some((f) => f.priority), 'with nobody watched, it is an #issue like anybody\'s');
}

console.log('=== one that reached the bot late is still found, once ===');
{
  // Delivered after a reconnect, or written in the moment a run was reading:
  // older than this run's look-back, but never reported.
  const late = { ...hers, id: 'MOM2', at: NOW - 3 * HOUR };
  const lateOther = { ...others[0], id: 'M-late', at: NOW - 3 * HOUR };
  const r = run([late, lateOther]);
  ok(r.incidents.some((f) => f.priority && f.fp === 'issue:MOM2'), 'her late #issue is found, by its fingerprint');
  ok(!r.incidents.some((f) => f.fp === 'issue:M-late'), 'another member\'s, that old, is left as before');
  const again = run([late], { memory: r.memory, now: NOW + HOUR });
  ok(!again.incidents.some((f) => f.fp === 'issue:MOM2'), 'and reported once');
}

console.log('=== the research session is told ===');
{
  const prompt = fs.readFileSync(new URL('../deploy/hourly-debug/prompt.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  ok(/`priority` true/.test(prompt) && /Head Admin \(\+1 555-810-0180\), who looks after the Jellyfin library/.test(prompt),
    'what priority means: an #issue from Head Admin, who looks after the library');
  ok(prompt.includes('2026-10-12: "Needless to say #issue tickets submitted by head admin 5558100180 get top priority" and '
    + '"Meaning it should activate bot to send yo a notification to check right away"'), 'the operator\'s two sentences, with the date');
  ok(/Research and fix it first, before anything else in the dossier, and to the end; put it first in the report/.test(prompt),
    'first, to the end, and first in the report');
  ok(/started for it outside the hour/.test(prompt) && /`trigger` is then `asked`/.test(prompt) && /`asked` says whose #issue and when/.test(prompt),
    'and that the run may have been started for it, outside the hour');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
