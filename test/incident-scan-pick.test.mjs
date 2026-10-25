/* A member's answer to a "which one?" list is not an unanswered request.
   Run: node test/incident-scan-pick.test.mjs

   2026-10-13 17:58: "#request Dumb and dumber (1994)" picked film 1 from the
   list and was queued, yet the hourly scan reported it as unanswered. */

import { scan, parseLog } from '../src/core/incident-scan.js';
import { messageShape } from '../src/core/message-index.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const MOVIE_REQ = '120363900000000001@g.us';
const CONFIG = { movieRequests: { requestGroups: [MOVIE_REQ], requirePrefix: true, prefix: '#request', notify: { group: 'n@g.us' } } };
const NAMES = { [MOVIE_REQ]: 'MOVIE REQUESTS ONLY!' };
const iso = (ts) => new Date(ts).toISOString();
const L = (ts, level, scope, msg) => `${iso(ts)} [${level.toUpperCase().padEnd(5)}] (${scope}) ${msg}`;
const log = (...lines) => parseLog(lines.join('\n'));
const stateWith = ({ index = [] } = {}) => ({
  'movie-requests': { history: [], pending: [] },
  'tv-requests': { history: [], pending: [], 'library-misses': [] },
  'msg-index': { entries: index },
});


const t0 = Date.parse('2026-10-13T17:58:21Z');
const index = [{ k: 'num:27783025098', p: '27783025098', g: MOVIE_REQ, i: 'PICKREPLY', t: t0,
  ...messageShape({ messageType: 'conversation', text: '#request Dumb and dumber (1994)' }) }];
const lines = log(L(t0 + 1, 'info', 'movie-requests', '🔢 +27783025098 picked 1 ("#request Dumb and dumber (1994)", title-year) from A/B for "Dumb and dumber" -> A, 30s after the list'));
const r = scan({ now: t0 + 3600_000, config: CONFIG, names: NAMES, state: stateWith({ index }), lines, memory: { v: 1, lastScanAt: t0 - 600_000, seen: {} } });
ok(![...r.incidents, ...r.notices].some((f) => f.kind === 'no-reaction'), 'the pick line answers the pick reply');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
