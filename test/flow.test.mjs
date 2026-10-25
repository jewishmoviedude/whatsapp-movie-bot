/* Request-flow ordering.
 *
 * These are STRUCTURAL assertions over the plugin source, not behavioural
 * ones - they pin the ordering invariant rather than execute the pipeline.
 * Running the real flow would need live OMDb, Jellyfin and WhatsApp, which
 * the other suites deliberately avoid. The invariant is worth pinning on its
 * own because it is easy to reintroduce a gate by accident, and doing so
 * would silently stop the bot sending films it actually has.
 *
 * Run: node test/flow.test.mjs
 */
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const src = fs.readFileSync(new URL('../src/plugins/movie-requests/index.js', import.meta.url), 'utf8');

const iRating  = src.indexOf('Rating gate');
const iLibrary = src.indexOf('Do we actually have it?');
const iWhy     = src.indexOf('Not here - say why');
const iQueue   = src.indexOf('Queue the heavy work');

console.log('=== flow ordering ===');
ok(iRating > 0, 'rating gate present');
ok(iLibrary > iRating, 'library lookup comes after the rating gate');
ok(iWhy > iLibrary, 'the "why is it missing" branch comes after the lookup');
ok(iQueue > iWhy, 'queueing comes last');

console.log('\n=== the release window must never block a send ===');
const missBranch = src.slice(iWhy, iQueue);
const afterHit   = src.slice(iQueue);
ok(!/isTheatricalOnly/.test(afterHit), 'nothing re-checks the release window once the file is found');
ok(/isTheatricalOnly/.test(missBranch), 'the release-window check lives inside the not-found branch');
ok((src.match(/await isTheatricalOnly\(/g) || []).length === 1, 'it is called exactly once in the flow');

console.log('\n=== reactions map to the right outcomes ===');
ok(/reactions\.rated/.test(src.slice(iRating, iLibrary)), 'blocked rating -> rated emoji');
ok(/reactions\.theaters/.test(missBranch), 'missing + in cinemas -> theaters emoji');
ok(/reactions\.notInLibrary/.test(missBranch), 'missing otherwise -> not-in-library emoji');
ok(/reactions\.added/.test(afterHit), 'found -> added emoji');

console.log('\n=== theatrical status is advisory only ===');
ok(!/blocked-theatrical/.test(src), 'the old blocking status is gone');
ok(/not-yet-theatrical/.test(src), 'replaced by the advisory status');

console.log(`\n${'='.repeat(50)}\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
