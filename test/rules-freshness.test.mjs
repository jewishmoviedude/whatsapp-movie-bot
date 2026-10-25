/* The rules surfaces must not drift apart. Run: node test/rules-freshness.test.mjs

   Regression: edits to default-rules.txt silently never reached the live bot,
   because the plugin only seeds movieRequests.rules when it is EMPTY. The
   per-group commands were updated while `#rules` kept serving the old text,
   so the two contradicted each other for real users. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMasterRules, RULE_SETS, GROUP_RULE_SET } from '../tools/build-descriptions.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const master = buildMasterRules(RULE_SETS);

console.log('=== the bundled default matches the generator ===');
{
  const bundled = fs.readFileSync(path.join(root, 'src/plugins/movie-requests/default-rules.txt'), 'utf8').trim();
  ok(bundled === master.trim(),
    'default-rules.txt is exactly what buildMasterRules() produces (a fresh install and an existing one get the same text)');
}

console.log('=== every command in the index actually exists ===');
{
  const listed = [...master.matchAll(/^• \*(#[\w-]+)\*/gm)].map((m) => m[1]);
  const real = new Set(RULE_SETS.map((s) => s.command));
  const missing = listed.filter((c) => !real.has(c));
  ok(listed.length > 0, `the master rules index lists ${listed.length} commands`);
  ok(missing.length === 0, `no command is advertised that does not exist${missing.length ? `: ${missing.join(', ')}` : ''}`);

  const withText = RULE_SETS.filter((s) => (s.text || '').trim()).map((s) => s.command);
  const unlisted = withText.filter((c) => !listed.includes(c));
  ok(unlisted.length === 0, `every real command is advertised${unlisted.length ? ` — missing: ${unlisted.join(', ')}` : ''}`);
}

console.log('=== the reaction legend agrees with the code ===');
{
  const schema = fs.readFileSync(path.join(root, 'src/config/schema.js'), 'utf8');
  const block = schema.slice(schema.indexOf('reactions: {'), schema.indexOf('blockedRatings'));
  const emojiOf = (key) => block.match(new RegExp(`${key}:\\s*'([^']+)'`))?.[1] ?? null;

  // Terminal outcomes a requester can actually see must be documented.
  for (const key of ['rated', 'theaters', 'notFound', 'needYear', 'oneAtATime', 'notInLibrary', 'failed', 'skipped', 'cancelled']) {
    const e = emojiOf(key);
    ok(!!e, `schema defines a ${key} reaction`);
    if (e) ok(master.includes(e), `the master rules explain ${e} (${key})`);
  }
  // No redo reaction since 2026-10-11: 🔄 on Ethan Adams's "Iron Man 3
  // 2013" after a restart was read as "send it again". Nothing may promise it.
  ok(!emojiOf('redo') && !master.includes('🔄'), 'the schema has no redo reaction, and the master rules do not explain 🔄');
}

console.log('=== request examples match the configured prefix ===');
{
  const cfgPath = path.join(root, 'data/config.json');
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const mr = cfg.movieRequests ?? {};
    if (mr.requirePrefix) {
      const prefix = (mr.prefix ?? '').trim();
      ok(!!prefix, 'a prefix is configured when requirePrefix is on');
      ok(master.includes(prefix), `the master rules show the real prefix "${prefix}"`);
      const requests = RULE_SETS.find((s) => s.command === '#rules-requests');
      ok(requests && requests.text.includes(prefix), 'the movie-request rules show the real prefix');
    } else {
      ok(true, 'requirePrefix is off — no prefix to advertise');
    }
  } else { ok(true, 'no live config to compare against'); }
}

console.log('=== TV is documented, since the section exists ===');
{
  ok(/S01E01|season/i.test(master), 'the master rules explain how to request TV');
  ok(RULE_SETS.some((s) => s.command === '#rules-tvreq'), 'a TV request command exists');
  ok(RULE_SETS.some((s) => s.command === '#rules-tv'), 'a TV posts command exists');
  const tvreq = RULE_SETS.find((s) => s.command === '#rules-tvreq');
  ok(/S\d{2}E\d{2}|season/i.test(tvreq.text), 'the TV request rules show the episode format');
}

console.log('=== every rule set is routed to at least one group ===');
{
  const routed = new Set(Object.values(GROUP_RULE_SET));
  const orphans = RULE_SETS.map((s) => s.command).filter((c) => !routed.has(c));
  ok(orphans.length === 0, `no command is defined but unused${orphans.length ? `: ${orphans.join(', ')}` : ''}`);

  const known = new Set(RULE_SETS.map((s) => s.command));
  const bogus = Object.entries(GROUP_RULE_SET).filter(([, c]) => !known.has(c));
  ok(bogus.length === 0, `no group points at a command that does not exist${bogus.length ? `: ${bogus.map(([g, c]) => `${g}->${c}`).join(', ')}` : ''}`);
}

console.log('=== nothing is served empty ===');
{
  for (const s of RULE_SETS) {
    ok((s.text || '').trim().length > 50, `${s.command} has real content (${s.text.length} chars)`);
    ok(!!(s.label || '').trim(), `${s.command} has a label for the index`);
  }
  ok(master.length > 500 && master.length < 4096, `the master rules are a sane length (${master.length} chars)`);
}

console.log('=== the TV request group is told what its reactions mean, within the description cap ===');
{
  // The operator's TV legend (2026-09-29) replaced one that had no line for
  // the place numbers, 🤥 or 🚫. test/tv-legend.test.mjs checks each of its
  // emoji against the TV plugin; this checks it is what the TV request
  // group is given, and that its description still fits: WhatsApp refuses a
  // group description over 2048 characters.
  const { DESCRIPTIONS } = await import('../tools/build-descriptions.mjs');
  const { TV_LEGEND } = await import('../tools/legends.mjs');
  const tvreq = RULE_SETS.find((s) => s.command === '#rules-tvreq');
  ok(tvreq?.text.includes(TV_LEGEND), '#rules-tvreq carries the TV legend');
  const tvDesc = Object.entries(GROUP_RULE_SET).filter(([, c]) => c === '#rules-tvreq').map(([jid]) => DESCRIPTIONS[jid]);
  // The description is the operator's own text (content/manual/), not the
  // generated one, so it is checked against that file rather than the legend.
  const manualTv = fs.readFileSync(path.join(root, 'content/manual/tv-requests-only-no-chatting-whatsoever.txt'), 'utf8').replace(/\n+$/, '');
  ok(tvDesc.length > 0 && tvDesc.every((d) => d === manualTv), 'and the TV request group\'s description is the operator\'s text');
  for (const [jid, desc] of Object.entries(DESCRIPTIONS ?? {})) {
    const n = [...String(desc)].length;
    ok(n <= 2048, `${jid}: its description is ${n} of 2048 characters`);
  }
}

console.log('=== no link is ever wrapped in brackets ===');
{
  // WhatsApp pulls a trailing ")" into the URL, which pre-fills "#rules)".
  const { DESCRIPTIONS } = await import('../tools/build-descriptions.mjs');
  const bad = [];
  for (const [jid, desc] of Object.entries(DESCRIPTIONS ?? {})) {
    for (const m of String(desc).matchAll(/https?:\/\/\S*[)\]}]/g)) bad.push(`${jid}: ${m[0]}`);
  }
  ok(bad.length === 0, `no group description ends a link with a bracket${bad.length ? ` — ${bad.slice(0, 3).join(', ')}` : ''}`);

  const inRules = [];
  for (const s of RULE_SETS) {
    for (const m of String(s.text).matchAll(/https?:\/\/\S*[)\]}]/g)) inRules.push(`${s.command}: ${m[0]}`);
  }
  for (const m of String(master).matchAll(/https?:\/\/\S*[)\]}]/g)) inRules.push(`master: ${m[0]}`);
  ok(inRules.length === 0, `no rules text ends a link with a bracket${inRules.length ? ` — ${inRules.join(', ')}` : ''}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
