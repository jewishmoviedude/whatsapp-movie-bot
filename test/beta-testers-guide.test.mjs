/* Beta features are numbered, and the panel downloads a guide for the testers.
   Run: node test/beta-testers-guide.test.mjs

   The operator named the first beta feature "beta001" by hand, in its label,
   and asked for every feature to be numbered the same way - beta002, beta003
   - and for a set of instructions to download and share in the test groups,
   saying what is being tested. Members had been handed the operator's own
   description, which is written for the panel, not for somebody asking for a
   film.

   beta001 itself, the "which one?" list, left beta for every group on
   2026-10-11 (test/pick-list.test.mjs says why), so its number joins the
   retired ones and the guide never offers it again. */
import { FEATURES, RETIRED_CODES, describeFeatures, testersGuide, featureTitle } from '../src/core/beta.js';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const cfg = (features = {}) => mergeDefaults({ beta: { features } }, DEFAULT_CONFIG);

console.log('=== every feature has its own number, never reused ===');
{
  const codes = FEATURES.map((f) => f.code);
  ok(codes.every((c) => /^beta\d{3}$/.test(c ?? '')), `each is betaNNN (${codes.join(', ')})`);
  ok(new Set([...codes, ...RETIRED_CODES]).size === codes.length + RETIRED_CODES.length, 'no two features, live or retired, share a number');
  ok(RETIRED_CODES.includes('beta001') && !FEATURES.some((f) => f.code === 'beta001' || f.key === 'movie-pick-list'),
    'the operator\'s beta001, the "which one?" list, is retired now that every group has it: neither its number nor its key is reused');
  ok(codes.join() === 'beta003,beta004,beta005', 'the rest were numbered in the order they were added');
  // beta002, TV place in line, was taken off beta for good on the operator's
  // word (2026-09-29); its number stays retired, never handed out again.
  ok(RETIRED_CODES.includes('beta002') && !codes.includes('beta002'), 'beta002 is retired, not reused');
  ok(FEATURES.every((f) => !/beta\d{3}/.test(f.label)), 'the number is not typed into a label as well, so it cannot be shown twice');
  ok(FEATURES.every((f) => typeof f.howTo === 'string' && f.howTo.length > 40), 'each has instructions written for testers');
}

console.log('=== the panel shows the number ===');
{
  const d = describeFeatures(cfg());
  ok(d[0].label === 'beta003 — TV episodes withheld on rating' && d[0].code === 'beta003', `"${d[0].label}"`);
  ok(d[1].label === 'beta004 — Film asked for twice', `"${d[1].label}"`);
  ok(!d.some((f) => f.code === 'beta001'), 'and the retired beta001 is not on the card to switch Off again');
  ok(featureTitle({ key: 'x', label: 'No number' }) === 'No number', 'a feature with no number is shown by its label alone');
}

console.log('=== the guide covers what is on Beta ===');
{
  // 'movie-pick-list' is what a config.json from before 2026-10-11 can
  // still hold: a key that has left the registry is no feature.
  const g = testersGuide(cfg({ 'movie-pick-list': 'beta', 'movie-duplicate-notice': 'beta', 'tv-duplicate-notice': 'on', 'tv-rating-notice': 'off' }));
  ok(g.ok && g.filename === 'beta-testers-guide.txt', 'a text file named for the whole guide');
  ok(g.text.includes('*beta004 — Film asked for twice*') && g.text.includes('already waiting in the real queue'),
    'the Beta feature, with its tester instructions');
  ok(!g.text.includes('beta005') && !g.text.includes('beta003'), 'not what is On everywhere or Off');
  ok(!g.text.includes('beta001') && !g.text.includes('Movies with series'), 'nor the retired "which one?" list, whatever config.json says of it');
  ok(!g.text.includes('Off: the "— added to the queue" line'), 'and not the operator\'s own notes');
  ok(g.text.includes('say the number (for example beta004)'), 'testers are asked to name the number when they report');
  const none = testersGuide(cfg());
  ok(!none.ok && /no feature is on Beta/.test(none.error), 'with nothing on Beta, it says so instead of an empty guide');
}

console.log('=== or one feature by its number ===');
{
  const g = testersGuide(cfg(), { code: 'beta003' });
  ok(g.ok && g.filename === 'beta003-testers-guide.txt' && g.text.includes('*beta003 — TV episodes withheld on rating*'),
    'one feature, whatever its mode, in a file named for it');
  ok(!testersGuide(cfg(), { code: 'beta999' }).ok, 'a number no feature has is refused');
  ok(!testersGuide(cfg(), { code: 'beta001' }).ok, 'and so is a retired one');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
