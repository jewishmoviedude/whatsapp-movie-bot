/* Rating-bypass regression: the library can fuzzy-match a different film than
   the metadata resolved, so the rating MUST be re-checked against the file
   actually being sent. Pins the "beekeeper" -> The Beekeeper (2024, R) hole.
   Run: node test/rating-bypass.test.mjs */
import fs from 'node:fs';
import { isBlockedRating } from '../src/plugins/movie-requests/theatrical.js';

let pass=0,fail=0;
const ok=(c,m)=>{c?(pass++,console.log(`  ok   ${m}`)):(fail++,console.log(`  FAIL ${m}`));};

// The guard condition, mirrored: re-check fires when the library year differs
// from the vetted year by more than 1.
function shouldRecheck(hitYear, movieYear) {
  return !!(hitYear && movieYear && Math.abs(hitYear - movieYear) > 1);
}

console.log('=== the exact production case ===');
ok(shouldRecheck(2024, 1991), '"beekeeper" 1991 vs library 2024 triggers a re-check');
ok(isBlockedRating('R', ['R','NC-17','X','TV-MA']), 'the 2024 file (R) is blocked on re-check');

console.log('=== same-film matches do NOT trigger a wasteful re-check ===');
ok(!shouldRecheck(2024, 2024), 'exact year: no re-check');
ok(!shouldRecheck(2024, 2023), 'one year off (edition/region): no re-check');
ok(!shouldRecheck(null, 1991), 'unknown library year: no re-check');
ok(!shouldRecheck(2024, null), 'unknown metadata year: no re-check');

console.log('=== remakes across years DO trigger a re-check ===');
ok(shouldRecheck(2019, 1994), 'Lion King 1994 vs 2019 re-checks');
ok(shouldRecheck(1984, 2021), 'Dune 2021 vs 1984 re-checks');

console.log('=== the guard is wired into all three code paths ===');
// Since 2026-09-29 the helper lives in film-gate.js, with fileGate() - the
// step 4b a request, a panel Re-run and the panel's dry run all take.
const src = fs.readFileSync(new URL('../src/plugins/movie-requests/index.js', import.meta.url), 'utf8');
const gate = fs.readFileSync(new URL('../src/plugins/movie-requests/film-gate.js', import.meta.url), 'utf8');
ok(/export async function verifyFileRating\(/.test(gate) && /export async function fileGate\([\s\S]*?await verifyFileRating\(/.test(gate),
   'helper defined in film-gate.js, and fileGate() calls it');
ok((src.match(/fileGate\(\{/g) || []).length >= 2 && (src.match(/verifyFileRating\(/g) || []).length >= 1,
   'called in main and requeue (fileGate), and recovery (verifyFileRating)');
const mainIdx = src.indexOf('4b. Verify the rating against the ACTUAL file');
ok(mainIdx > 0 && src.indexOf('fileGate({', mainIdx) > mainIdx, 'main flow calls it after the library hit');
ok(/not resuming[^\n]*rated/.test(src), 'recovery blocks a resumed job whose file is rated');
ok(/is rated \$\{rc\.rated\} \(blocked\)/.test(src), 'requeue throws on a blocked library file');

console.log(`\n${'='.repeat(50)}\n  ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
