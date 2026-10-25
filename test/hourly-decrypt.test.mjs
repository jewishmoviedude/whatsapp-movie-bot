/* The hourly check reports messages this number could not decrypt.
   Run: node test/hourly-decrypt.test.mjs

   The operator, 2026-10-08: "add decrypt failures to the hourly check
   report". A message that cannot be decrypted is dropped before any plugin
   sees it: no reaction, no reply, no History row, so nothing else the check
   reads shows it. That day's flood (one failure every 6 seconds from 15:54 to
   22:17 UTC) was the bot's own phone, which costs no member anything, so it
   is listed as a notice; a member's is an incident, researched and emailed. */
import { scan, parseLog, headline } from '../src/core/incident-scan.js';
import { DecryptWatch } from '../src/core/decrypt-watch.js';
import log from '../src/util/logger.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const MIN = 60_000, HOUR = 60 * MIN;
const NOW = Date.parse('2026-10-08T23:00:00Z');
const TV_REQ = '120363100000000002@g.us';
const NAMES = { [TV_REQ]: 'TV REQUESTS ONLY!' };
const UNIT = { ActiveState: 'active', NRestarts: '0' };
const STATE = {
  'movie-requests': { history: [], pending: [] },
  'tv-requests': { history: [], pending: [], 'library-misses': [] },
  'msg-index': { entries: [] },
  audit: { events: [] },
};
const config = () => ({
  movieRequests: { requestGroups: [], requirePrefix: true, prefix: '#request', notify: {} },
  tvRequests: { enabled: true, requestGroups: [TV_REQ], postsGroups: [], requirePrefix: true, prefix: '#request' },
  beta: { groups: [], features: {} },
  media: {},
});
const run = (lines, o = {}) => scan({
  now: NOW, config: config(), names: NAMES, unit: UNIT, state: STATE,
  memory: { v: 1, lastScanAt: NOW - HOUR, seen: {}, configCheckedAt: NOW - HOUR }, lines, ...o,
});

// The lines exactly as the bot writes them: DecryptWatch through the logger,
// into the debug file's format (FileLogger appends " | {json}").
function botLines(failures, step = 6_000, start = NOW - 50 * MIN) {
  const out = [];
  const sink = { write: (e) => { if (e.scope === 'decrypt') out.push(`${e.ts} [${e.level.toUpperCase().padEnd(5)}] (${e.scope}) ${e.msg} | ${JSON.stringify(e.extra)}`); } };
  log.setSink(sink);
  let t = start;
  const w = new DecryptWatch({ now: () => t, everyMs: 10 * MIN, describe: ({ chat, sender }) => ({ chat, sender }) });
  const realNow = Date.prototype.toISOString;
  // The logger stamps lines with the real clock; give it the watch's.
  Date.prototype.toISOString = function () { return realNow.call(new Date(t)); };
  try {
    for (const f of failures) { w.record(f); t += step; }
    w.flush();   // the bot's timer, before the check reads the log
  } finally {
    Date.prototype.toISOString = realNow;
    log.setSink(null);
  }
  return parseLog(out.join('\n'));
}

const SELF = { chat: '10000000000008@lid', sender: '10000000000008@lid', fromMe: true, error: 'Over 2000 messages into the future!' };
const MEMBER = { chat: TV_REQ, sender: '10000000000009@lid', senderPn: '15558160178@s.whatsapp.net', error: 'Bad MAC' };

console.log('=== the bot\'s own phone: listed, never an incident ===');
{
  const lines = botLines(Array(480).fill(SELF));
  ok(lines.length >= 2 && lines.every((l) => l.extra), `the bot logged it with its detail (${lines.length} lines for 480 failures)`);
  const r = run(lines);
  const n = r.notices.find((f) => f.kind === 'decrypt-failure');
  ok(!r.incidents.some((f) => f.kind === 'decrypt-failure'), 'not an incident: no research, no restart');
  ok(n && /own phone/.test(n.title) && /never a member's request/.test(n.title), `a notice that says what it costs: ${n?.title}`);
  ok(/^480 messages/.test(n?.title ?? ''), `every one counted (${n?.title.match(/^\d+/)?.[0]})`);
  ok(headline(r.incidents) === 'all clear', 'and the hour can still be all clear');
}

console.log('=== a member: an incident, named, with what to do ===');
{
  const lines = botLines(Array(12).fill(MEMBER), 3 * MIN);
  const r = run(lines);
  const f = r.incidents.find((x) => x.kind === 'decrypt-failure');
  ok(!!f && f.severity === 'error', 'an incident');
  ok(/\+1555\*\*\*0178/.test(f?.title ?? '') && !/15558160178/.test(f?.title ?? ''), `the member by their masked number: ${f?.title}`);
  ok(/"TV REQUESTS ONLY!"/.test(f?.title ?? ''), 'and the group by its name');
  ok(/never reached the bot/.test(f?.title ?? ''), 'saying a request in them was lost');
  ok(/re-send/.test(f?.remedy ?? '') && f.restartHelps === false, 'what to do, and that a restart does not help');
  ok(f?.count === 12, `all 12 counted, across the watch's hourly lines (${f?.count})`);
  ok(/member whose messages could not be read/.test(headline(r.incidents)), `the headline names it: ${headline(r.incidents)}`);
  ok(!r.restart?.now && !(r.restart?.reasons ?? []).length, 'no restart advised for it');
}

console.log('=== a member WhatsApp gives no number for ===');
{
  const r = run(botLines([{ ...MEMBER, senderPn: null }]));
  const f = r.incidents.find((x) => x.kind === 'decrypt-failure');
  ok(/a member WhatsApp shows only as 10000000000009/.test(f?.title ?? ''), `named by what there is: ${f?.title}`);
}

console.log('=== each failure is reported once ===');
{
  const lines = botLines(Array(3).fill(MEMBER), MIN);
  const first = run(lines);
  ok(first.incidents.some((f) => f.kind === 'decrypt-failure'), 'this hour');
  const next = scan({ now: NOW + HOUR, config: config(), names: NAMES, unit: UNIT, state: STATE, memory: first.memory, lines });
  ok(!next.incidents.some((f) => f.kind === 'decrypt-failure'), 'not again the next hour, with nothing new');
  const old = run(lines, { memory: { v: 1, lastScanAt: NOW - 10 * MIN, seen: {}, configCheckedAt: NOW } });
  ok(!old.incidents.some((f) => f.kind === 'decrypt-failure'), 'and not from before the window');
}

console.log('=== other lines in the scope are not findings ===');
{
  const r = run(parseLog(`${new Date(NOW - 5 * MIN).toISOString()} [WARN ] (decrypt) something without detail`));
  ok(![...r.incidents, ...r.notices].some((f) => f.kind === 'decrypt-failure'), 'a line without the detail is passed over');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
