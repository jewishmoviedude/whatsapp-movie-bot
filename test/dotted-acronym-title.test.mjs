/* A dotted acronym is matched as the word a member types.
   Run: node test/dotted-acronym-title.test.mjs

   Incident 2026-10-07 20:33Z: "swat exiles season 1" was answered "no series
   matching swat exiles" although the library holds "S.W.A.T. Exiles" (2026).
   normalizeTitle turned the dots into spaces, so the title became four
   one-letter words and scored 0.79, under the 0.9 bar the word-search step
   needs. */
import { bestMatch, normalizeTitle } from '../src/util/fuzzy.js';

let fail = 0;
const ok = (c, m) => { c || fail++; console.log(`  ${c ? 'ok  ' : 'FAIL'} ${m}`); };

ok(normalizeTitle('S.W.A.T. Exiles') === 'swat exiles', 'S.W.A.T. normalises to swat');
ok(normalizeTitle('L.A. Confidential') === 'la confidential', 'L.A. normalises to la');
ok(normalizeTitle('Mr. Robot') === 'mr robot', 'a single abbreviation dot is still punctuation');
ok(normalizeTitle('Marvel.Agents.of.SHIELD') === 'marvel agents of shield', 'dots between whole words still split them');

const m = bestMatch('swat exiles', [{ t: 'S.W.A.T. Exiles', y: 2026 }],
  { threshold: 0.9, getTitle: (c) => c.t, getYear: (c) => c.y });
ok(!!m && m.score >= 0.9, 'swat exiles clears the fallback bar against S.W.A.T. Exiles');

if (fail) process.exit(1);
