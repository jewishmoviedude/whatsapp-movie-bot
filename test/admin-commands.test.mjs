/* Local admin command channel: backup + apply descriptions. Run: node test/admin-commands.test.mjs */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runAdminCommand, backupOriginalDescriptions } from '../src/core/admin-commands.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'admincmd-'));

// A stub bot with an in-memory description store.
function makeBot(initial) {
  const store = new Map(Object.entries(initial));
  return {
    groupDescriptionsSnapshot() {
      return [...store.entries()].map(([jid, v]) => ({ jid, subject: v.subject, desc: v.desc }))
        .sort((a, b) => a.subject.localeCompare(b.subject));
    },
    async applyDescriptions(plan) {
      const results = [];
      for (const { jid, desc } of plan) {
        if (!store.has(jid)) { results.push({ jid, ok: false, error: 'unknown group' }); continue; }
        store.get(jid).desc = String(desc ?? '');
        results.push({ jid, subject: store.get(jid).subject, ok: true });
      }
      return results;
    },
    _store: store,
  };
}

console.log('=== dump-descriptions ===');
{
  const bot = makeBot({ 'a@g.us': { subject: 'Alpha', desc: 'first' }, 'b@g.us': { subject: 'Bravo', desc: 'second' } });
  const r = await runAdminCommand({ op: 'dump-descriptions' }, { bot, dataDir: tmp });
  ok(r.ok && r.count === 2, 'dumps all groups');
  ok(r.groups[0].subject === 'Alpha', 'sorted by subject');
}

console.log('=== backup is write-once per group (preserves originals) ===');
{
  const bot = makeBot({ 'a@g.us': { subject: 'Alpha', desc: 'ORIGINAL-A' } });
  const dir = fs.mkdtempSync(path.join(tmp, 'b1-'));
  backupOriginalDescriptions(bot, dir);
  // Now the description changes; a second backup must NOT overwrite the original.
  bot._store.get('a@g.us').desc = 'EDITED-A';
  const r2 = backupOriginalDescriptions(bot, dir);
  const orig = JSON.parse(fs.readFileSync(path.join(dir, 'backups', 'original-descriptions.json'), 'utf8'));
  ok(orig['a@g.us'].desc === 'ORIGINAL-A', 'original description preserved after an edit');
  ok(r2.newlyBackedUp === 0, 'no new backups on second pass for known group');
  // A brand-new group added later IS captured.
  bot._store.set('c@g.us', { subject: 'Charlie', desc: 'ORIGINAL-C' });
  const r3 = backupOriginalDescriptions(bot, dir);
  ok(r3.newlyBackedUp === 1, 'a newly-seen group is backed up');
  const orig2 = JSON.parse(fs.readFileSync(path.join(dir, 'backups', 'original-descriptions.json'), 'utf8'));
  ok(orig2['c@g.us'].desc === 'ORIGINAL-C', 'new group original recorded');
  ok(fs.existsSync(path.join(dir, 'backups', 'descriptions-latest.json')), 'latest snapshot written');
}

console.log('=== apply-descriptions backs up before editing ===');
{
  const bot = makeBot({ 'a@g.us': { subject: 'Alpha', desc: 'ORIGINAL-A' } });
  const dir = fs.mkdtempSync(path.join(tmp, 'b2-'));
  const r = await runAdminCommand({ op: 'apply-descriptions', plan: [{ jid: 'a@g.us', desc: 'NEW-A' }] }, { bot, dataDir: dir });
  ok(r.ok && r.results[0].ok, 'apply reports success');
  ok(bot._store.get('a@g.us').desc === 'NEW-A', 'description actually changed');
  const orig = JSON.parse(fs.readFileSync(path.join(dir, 'backups', 'original-descriptions.json'), 'utf8'));
  ok(orig['a@g.us'].desc === 'ORIGINAL-A', 'original captured by apply before overwrite');
}

console.log('=== apply-descriptions validates input ===');
{
  const bot = makeBot({});
  let threw = false;
  try { await runAdminCommand({ op: 'apply-descriptions', plan: 'nope' }, { bot, dataDir: tmp }); } catch { threw = true; }
  ok(threw, 'non-array plan rejected');
}

console.log('=== set-rule-sets writes config ===');
{
  let saved = null;
  const configStore = {
    _c: { movieRequests: { rules: 'old', requestGroups: ['keep@g.us'] } },
    update(patch) { // shallow-ish merge sufficient for the test
      this._c.movieRequests = { ...this._c.movieRequests, ...patch.movieRequests };
      saved = patch;
    },
    get() { return this._c; },
  };
  const r = await runAdminCommand({
    op: 'set-rule-sets',
    ruleSets: [{ command: '#rules-movies', text: 'm' }],
    groupRuleSet: { 'g@g.us': '#rules-movies' },
  }, { bot: makeBot({}), dataDir: tmp, configStore });
  ok(r.ok && r.ruleSets.length === 1, 'rule sets returned');
  ok(configStore.get().movieRequests.requestGroups[0] === 'keep@g.us', 'other movieRequests keys preserved');
  ok(configStore.get().movieRequests.groupRuleSet['g@g.us'] === '#rules-movies', 'group assignment saved');
}

console.log('=== unknown op ===');
{
  let threw = false;
  try { await runAdminCommand({ op: 'frobnicate' }, { bot: makeBot({}), dataDir: tmp }); } catch { threw = true; }
  ok(threw, 'unknown op throws');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
