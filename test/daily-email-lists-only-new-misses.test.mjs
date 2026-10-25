// The operator, 2026-10-13: "the daily email summary shouldnt include old
// bugs". Its "NOT IN THE LIBRARY" section listed every open row every day,
// so American Dad!'s refusals from September - the empty-folder bug, fixed in
// the code since - still headed the mail weeks later. It now lists the misses
// asked for since the last summary (or in the last 24 hours, without one),
// and counts the older open ones in one line pointing at the panel.
import { buildDigest } from '../src/core/daily-digest.js';
import { formatMisses } from '../src/core/library-misses.js';

let fails = 0;
const ok = (c, n) => { if (!c) { fails++; console.error('FAIL', n); } else console.log('ok', n); };

const DAY = 86_400_000;
const now = Date.UTC(2026, 9, 14, 0, 5);
const miss = (title, at, extra = {}) => ({ key: title, kind: 'tv', reason: 'empty-season', title, request: title, count: 1, firstAt: at, lastAt: at, requesters: [], resolved: false, ...extra });
const misses = [
  miss('Tonight Show', now - 3 * 3_600_000),
  miss('American Dad!', now - 34 * DAY),
  miss('Old but asked again', now - 40 * DAY, { lastAt: now - 3_600_000 }),
  miss('Fixed one', now - 2 * 3_600_000, { resolved: true }),
];

const body = buildDigest({ misses, now, lastSummaryAt: now - DAY });
const section = body.slice(body.indexOf('NOT IN THE LIBRARY'));
ok(/Tonight Show/.test(section), 'a miss from today is listed');
ok(/Old but asked again/.test(section), 'an old row asked for again today is listed');
ok(!/American Dad!/.test(section), 'a miss from September is not');
ok(/1 older one\(s\).*still open in the panel/.test(section), `the older ones are one line (${section.split('\n').find((l) => /older/.test(l))})`);
ok(!/Fixed one/.test(section), 'a resolved row is not listed');

const quiet = buildDigest({ misses: [misses[1]], now, lastSummaryAt: null });
ok(/Nothing new was refused/.test(quiet) && /1 older one/.test(quiet), 'nothing new: says so, and still counts the old ones');
ok(!/American Dad!/.test(quiet), 'without a last summary, the last 24 hours are the window');

ok(/American Dad!/.test(formatMisses(misses, { now })), 'without `since` (the panel and its export) every open row is still listed');

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
