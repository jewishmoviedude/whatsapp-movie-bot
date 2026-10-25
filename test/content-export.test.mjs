/* Descriptions and rules, versioned in the repo.
   Run: node test/content-export.test.mjs

   Two things this locks down. The "PM the bot for the rules" route is gone -
   it needed a wa.me link with a hard-coded phone number in fifteen group
   descriptions, so every number switch made all fifteen wrong at once. And
   everything that gets posted to a group now has a file in content/, where it
   can be read and diffed before it goes out. */
import fs from 'node:fs';
import path from 'node:path';
import { rulesReplyFor } from '../src/plugins/movie-requests/rules.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const root = new URL('..', import.meta.url).pathname;
const content = path.join(root, 'content');

console.log('=== the folder exists and covers everything ===');
{
  const descs = fs.readdirSync(path.join(content, 'descriptions'));
  const rules = fs.readdirSync(path.join(content, 'rules'));
  const plan = JSON.parse(fs.readFileSync(path.join(root, 'data/descriptions-plan.json'), 'utf8'));

  ok(descs.length === plan.plan.length,
    `one file per group (${descs.length} files, ${plan.plan.length} groups)`);
  ok(rules.length === plan.ruleSets.length + 1,
    `one file per rule set plus the combined master (${rules.length})`);
  ok(rules.includes('_master.txt'), 'the combined text is there too');
  ok(fs.existsSync(path.join(content, 'README.md')), 'and an index explaining the folder');
}

console.log('=== two groups with the same name do not overwrite each other ===');
{
  // Two groups are both called "MOVIE SYSTEM". A plain slug silently produced
  // 14 files for 15 groups, losing one.
  const descs = fs.readdirSync(path.join(content, 'descriptions'));
  const systems = descs.filter((f) => f.startsWith('movie-system'));
  ok(systems.length === 2, `both survive with distinct names: ${systems.join(', ')}`);
  ok(new Set(descs).size === descs.length, 'and no filename appears twice');
}

console.log('=== no wa.me link survives in anything posted to a group ===');
{
  for (const dir of ['descriptions', 'rules']) {
    const files = fs.readdirSync(path.join(content, dir));
    const offenders = files.filter((f) =>
      /wa\.me/.test(fs.readFileSync(path.join(content, dir, f), 'utf8')));
    ok(offenders.length === 0, `${dir}/: no wa.me links${offenders.length ? ` — ${offenders.join(', ')}` : ''}`);
  }
  // The generator must not be able to reintroduce one.
  const gen = fs.readFileSync(path.join(root, 'tools/build-descriptions.mjs'), 'utf8');
  // An actual URL, not the words - the README template legitimately explains
  // why the link was removed.
  const live = gen.split('\n').filter((l) => /https?:\/\/wa\.me\//.test(l));
  ok(live.length === 0, `the generator has no live wa.me URL${live.length ? `: ${live[0].trim()}` : ''}`);
}

console.log('=== the rules are still reachable, in the group ===');
{
  const cfg = {
    rulesCommand: '#rules',
    rules: 'MASTER',
    ruleSets: [{ command: '#rules-tv', label: 'TV', text: 'TV RULES' }],
    groupRuleSet: { 'tv@g.us': '#rules-tv' },
  };
  ok(rulesReplyFor(cfg, { text: '#rules-tv', isGroup: true, chatJid: 'x@g.us' })?.text === 'TV RULES',
    'a set command works in a group');
  ok(rulesReplyFor(cfg, { text: '#rules', isGroup: true, chatJid: 'tv@g.us' })?.text === 'TV RULES',
    'and a bare #rules serves that group\'s set');
}

console.log('=== but a DM gets nothing ===');
{
  const cfg = { rulesCommand: '#rules', rules: 'MASTER', ruleSets: [{ command: '#rules-tv', text: 'TV RULES' }] };
  ok(rulesReplyFor(cfg, { text: '#rules', isGroup: false }) === null, 'the master command is not answered in a DM');
  ok(rulesReplyFor(cfg, { text: '#rules-tv', isGroup: false }) === null, 'nor a specific set');

  // isGroup missing entirely (an odd message) must not be treated as a DM and
  // silently swallowed - only an explicit false disables it.
  ok(rulesReplyFor(cfg, { text: '#rules-tv', chatJid: 'x@g.us' })?.text === 'TV RULES',
    'a message with no isGroup flag still works, rather than failing closed by accident');
}

console.log('=== the unreachable PM housekeeping is gone ===');
{
  const idx = fs.readFileSync(path.join(root, 'src/plugins/movie-requests/index.js'), 'utf8');
  ok(!/deleteChatAfterRules/.test(idx), 'no dead branch for tidying a PM that never arrives');
  const schema = fs.readFileSync(path.join(root, 'src/config/schema.js'), 'utf8');
  ok(!/deleteChatAfterRules/.test(schema),
    'and the setting is gone from the schema too, rather than left as a switch that controls nothing');
}

console.log('=== the files say not to edit them by hand ===');
{
  const readme = fs.readFileSync(path.join(content, 'README.md'), 'utf8');
  ok(/Edit the generator, not/.test(readme),
    'the index warns that a hand edit is overwritten on the next run');
  ok(/build-descriptions/.test(readme), 'and names the generator to edit instead');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
