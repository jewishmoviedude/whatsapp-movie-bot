/* Lockdown reliability. Run: node test/lockdown-concurrency.test.mjs

   Real symptom: a pass paces ~1.2s per group, so 15 groups took ~20 seconds
   with nothing visible happening. Operators clicked again, and SIX overlapping
   passes each reported a different count (3, 2, 3, 0, 1, 2). The summary also
   said "5/9" whether the other four were deliberately skipped or had failed. */
import fs from 'node:fs';
import { WhatsAppBot } from '../src/core/bot.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

function mkBot({ groups = 4, alwaysLocked = [], failOn = [] } = {}) {
  const bot = new WhatsAppBot({
    configStore: { get: () => ({ whatsapp: {}, lockdown: { alwaysLocked, pacingMs: 0 } }) },
    dataDir: '/tmp',
  });
  bot.state = 'connected';
  bot.groupCache = new Map();
  for (let i = 1; i <= groups; i++) {
    bot.groupCache.set(`g${i}@g.us`, { jid: `g${i}@g.us`, subject: `Group ${i}`, memberIds: new Set(), memberNumbers: new Set() });
  }
  bot.applied = [];
  bot.setGroupLocked = async (jid, locked) => {
    if (failOn.includes(jid)) throw new Error('not-authorized');
    bot.applied.push({ jid, locked });
  };
  return bot;
}

console.log('=== only ONE pass runs at a time ===');
{
  const bot = mkBot({ groups: 3 });
  const a = bot.setAllGroupsLocked(true);
  const b = bot.setAllGroupsLocked(true);   // the impatient second click
  const c = bot.setAllGroupsLocked(true);   // and a third
  ok(bot.lockdownBusy === true, 'the bot reports a pass in flight');
  const [ra, rb, rc] = await Promise.all([a, b, c]);
  ok(ra === rb && rb === rc, 'every caller receives the SAME run, not competing ones');
  ok(bot.applied.length === 3, `each group was touched exactly once (${bot.applied.length}), not three times`);
  ok(bot.lockdownBusy === false, 'the flag clears when the pass finishes');
}

console.log('=== a later pass still works ===');
{
  const bot = mkBot({ groups: 2 });
  await bot.setAllGroupsLocked(true);
  ok(bot.lockdownBusy === false, 'not stuck busy after completing');
  await bot.setAllGroupsLocked(false);
  ok(bot.applied.length === 4, 'a subsequent pass runs normally');
  ok(bot.applied.slice(2).every((a) => a.locked === false), 'and unlocks this time');
}

console.log('=== the flag clears even when a pass throws ===');
{
  const bot = mkBot({ groups: 2 });
  bot.groups = () => { throw new Error('boom'); };
  let threw = null;
  try { await bot.setAllGroupsLocked(true); } catch (e) { threw = e; }
  ok(!!threw, 'the error surfaces');
  ok(bot.lockdownBusy === false, 'and does not leave lockdown permanently jammed');
}

console.log('=== skipped and failed are reported separately ===');
{
  const bot = mkBot({ groups: 5, alwaysLocked: ['g1@g.us', 'g2@g.us'], failOn: ['g3@g.us'] });
  const res = await bot.setAllGroupsLocked(false);   // unlock
  const s = res.summary;
  ok(s.total === 5, 'every group is accounted for');
  ok(s.skipped === 2, 'the two always-locked groups are counted as SKIPPED, not failures');
  ok(s.failed === 1, 'the one the bot cannot administer is counted as failed');
  ok(s.changed === 2, 'and two were actually unlocked');
  ok(s.changed + s.skipped + s.failed === s.total, 'the numbers add up — no group unexplained');

  const failure = res.find((r) => r.error);
  ok(/not an admin/i.test(failure.error), `the failure says why: "${failure.error}"`);
}

console.log('=== always-locked groups are never opened ===');
{
  const bot = mkBot({ groups: 3, alwaysLocked: ['g2@g.us'] });
  await bot.setAllGroupsLocked(false);
  ok(!bot.applied.some((a) => a.jid === 'g2@g.us'), 'the always-locked group was not touched on unlock');
  // ...but locking everything DOES include it
  bot.applied.length = 0;
  await bot.setAllGroupsLocked(true);
  ok(bot.applied.some((a) => a.jid === 'g2@g.us'), 'locking still covers it');
}

console.log('=== progress is reported while it runs ===');
{
  const bot = mkBot({ groups: 3 });
  const seen = [];
  await bot.setAllGroupsLocked(true, { onProgress: (p) => seen.push(p) });
  ok(seen.length === 3, 'one progress callback per group');
  ok(seen[2].done === 3 && seen[2].total === 3, 'it counts up to the total');
  // a throwing callback must not break the pass
  const bot2 = mkBot({ groups: 2 });
  await bot2.setAllGroupsLocked(true, { onProgress: () => { throw new Error('ui blew up'); } });
  ok(bot2.applied.length === 2, 'a broken progress handler never stops the lockdown');
}

console.log('=== the API and portal guard against double-clicks ===');
{
  const api = fs.readFileSync(new URL('../src/web/api.js', import.meta.url), 'utf8');
  ok(/if \(bot\.lockdownBusy\)/.test(api), 'the route refuses while a pass is running');
  ok(/status\(409\)/.test(api), 'with a 409 rather than starting another');
  ok(/summary,/.test(api) && /failures:/.test(api), 'and returns the real breakdown');

  const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  ok(/btns\.forEach\(\(b\) => \{ b\.disabled = true; \}\)/.test(app), 'the buttons disable during the pass');
  ok(/finally \{\s*\n\s*btns\.forEach\(\(b\) => \{ b\.disabled = false; \}\)/.test(app), 'and re-enable even on failure');
  ok(/about \$\{eta\}/.test(app), 'it says roughly how long it will take');
  ok(/always-locked \(skipped\)/.test(app), 'the result distinguishes skips from failures');
}

console.log('=== pacing: one group at a time, deliberately slow ===');
{
  const schema = fs.readFileSync(new URL('../src/config/schema.js', import.meta.url), 'utf8');
  ok(/pacingMs: 5000/.test(schema), 'defaults to 5 seconds between groups');

  const src = fs.readFileSync(new URL('../src/core/bot.js', import.meta.url), 'utf8');
  ok(/Number\(this\.config\.lockdown\?\.pacingMs \?\? this\._bulkDelay\('bulk'\)\)/.test(src),
    'read from config, so it can be tuned — falling back to the shared bulk pace, never to zero');
  ok(/if \(i < groups\.length - 1\) await sleep\(pace\)/.test(src), 'no pointless wait after the final group');
  ok(!/await sleep\(1200\)/.test(src), 'the old 1.2s burst pacing is gone');
}
{
  // measured, not just asserted from source
  const bot = new WhatsAppBot({
    configStore: { get: () => ({ whatsapp: {}, lockdown: { alwaysLocked: [], pacingMs: 120 } }) },
    dataDir: '/tmp',
  });
  bot.state = 'connected';
  bot.groupCache = new Map([
    ['a@g.us', { jid: 'a@g.us', subject: 'A' }],
    ['b@g.us', { jid: 'b@g.us', subject: 'B' }],
    ['c@g.us', { jid: 'c@g.us', subject: 'C' }],
  ]);
  const at = [];
  bot.setGroupLocked = async () => { at.push(Date.now()); };
  const t0 = Date.now();
  await bot.setAllGroupsLocked(true);
  const total = Date.now() - t0;
  ok(at.length === 3, 'every group was touched');
  ok(total >= 240, `waited between groups (${total}ms for 3 groups at 120ms)`);
  ok(total < 600, 'and did not wait after the last one');
  const gaps = at.slice(1).map((t, i) => t - at[i]);
  ok(gaps.every((g) => g >= 100), `the gaps are real: ${gaps.join('ms, ')}ms`);
}

console.log('=== the portal quotes the real duration ===');
{
  const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  ok(/CONFIG\?\.lockdown\?\.pacingMs \?\? 5000/.test(app), 'the estimate uses the configured pacing');
  ok(/one at a time/.test(app), 'and says it runs one at a time');
  ok(/rate-limit/.test(app), 'explaining that the slowness is deliberate');
}

console.log('=== groups named "$…" are left out of the lockdown, as they are out of the member tools ===');
{
  // The operator, 2026-09-29: "groups with a name starting with the $
  // shouldn't be part of the lockdown logic just like it isn't part of the
  // members logic". The live box holds "$ Head Admins" and "$ movie system
  // Admins", which every Shabbos pass locked and opened with the rest.
  const bot = mkBot({ groups: 2 });
  bot.groupCache.set('p1@g.us', { jid: 'p1@g.us', subject: '$ Head Admins', memberIds: new Set(), memberNumbers: new Set() });
  bot.groupCache.set('p2@g.us', { jid: 'p2@g.us', subject: '  $ movie system Admins', memberIds: new Set(), memberNumbers: new Set() });
  const locked = await bot.setAllGroupsLocked(true);
  ok(!bot.applied.some((a) => a.jid.startsWith('p')) && bot.applied.length === 2, `locking touches only the two ordinary groups (${bot.applied.map((a) => a.jid).join(', ')})`);
  ok(locked.summary.private === 2 && locked.summary.changed === 2 && locked.summary.failed === 0,
    `and reports the two private ones as left alone (${JSON.stringify(locked.summary)})`);
  bot.applied = [];
  const opened = await bot.setAllGroupsLocked(false);
  ok(!bot.applied.some((a) => a.jid.startsWith('p')) && opened.filter((r) => r.skipped === 'private ($)').length === 2,
    'and unlocking never opens them either');

  let read = [];
  bot.groupDetails = async (jid) => { read.push(jid); return { locked: false, botIsAdmin: true }; };
  bot._bulkPace = async () => {};
  const synced = await bot.syncAlwaysLocked();
  ok(read.length === 2 && !read.some((j) => j.startsWith('p')) && synced.length === 2,
    `the always-locked sync does not read them (${read.join(', ')})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
