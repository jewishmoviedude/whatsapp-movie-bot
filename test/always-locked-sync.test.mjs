/* Syncing the always-locked list from WhatsApp.
   Run: node test/always-locked-sync.test.mjs

   The list was maintained entirely by hand and nothing ever checked it against
   reality. A group made admins-only in WhatsApp stayed unticked, so the
   schedule opened it at havdalah; a group opened in WhatsApp stayed ticked, so
   every bulk unlock kept skipping it. Sync reads the real setting.

   It reads one group at a time through _bulkPace. That looks like more traffic
   than a single groupFetchAllParticipating and is the safer choice: the bulk
   call is the one WhatsApp has actually rate-limited this number for, 26 times,
   with escalating penalties. */
import { WhatsAppBot } from '../src/core/bot.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

function mk(groups, meta, lockdown = {}) {
  const bot = new WhatsAppBot({
    configStore: { get: () => ({ whatsapp: {}, lockdown: { pacingMs: 0, alwaysLocked: [], ...lockdown } }) },
    dataDir: '/tmp/wa-test-al',
  });
  for (const g of groups) bot.groupCache.set(g.jid, g);
  // Stand in for the real per-group metadata read.
  bot.groupDetails = async (jid) => {
    const m = meta[jid];
    if (m instanceof Error) throw m;
    return { jid, subject: groups.find((g) => g.jid === jid)?.subject ?? '', locked: !!m.locked, botIsAdmin: true };
  };
  bot._bulkPace = async () => {};        // no real waiting in a unit test
  return bot;
}

const GROUPS = [
  { jid: 'a@g.us', subject: 'MOVIE POSTS ONLY', size: 100 },
  { jid: 'b@g.us', subject: 'movie requests', size: 80 },
  { jid: 'c@g.us', subject: 'TV POSTS ONLY', size: 60 },
];

console.log('=== it reports what each group really is ===');
{
  const bot = mk(GROUPS, {
    'a@g.us': { locked: true }, 'b@g.us': { locked: false }, 'c@g.us': { locked: true },
  });
  const out = await bot.syncAlwaysLocked();
  ok(out.length === 3, 'every group is reported');
  ok(out.filter((g) => g.locked).length === 2, 'two are admins-only');
  ok(out.find((g) => g.jid === 'b@g.us').locked === false, 'and the open one is not');
}

console.log('=== a group it cannot read is NOT assumed to be open ===');
{
  // Treating an error as "unlocked" would propose removing the group from the
  // list, and the next havdalah would then open a group meant to stay shut.
  const bot = mk(GROUPS, {
    'a@g.us': { locked: true },
    'b@g.us': new Error('not-authorized'),
    'c@g.us': { locked: false },
  });
  const out = await bot.syncAlwaysLocked();
  const b = out.find((g) => g.jid === 'b@g.us');
  ok(!!b.error, 'the failure is recorded');
  ok(b.locked === undefined, 'and it is not reported as locked or unlocked');
  ok(out.filter((g) => !g.error).length === 2, 'the other two still read fine');
}

console.log('=== one read per group, and it is paced ===');
{
  let reads = 0, paces = 0;
  const bot = mk(GROUPS, { 'a@g.us': { locked: true }, 'b@g.us': { locked: false }, 'c@g.us': { locked: false } });
  const inner = bot.groupDetails;
  bot.groupDetails = async (jid) => { reads++; return inner(jid); };
  bot._bulkPace = async () => { paces++; };
  await bot.syncAlwaysLocked();
  ok(reads === 3, 'exactly one metadata read per group');
  // No point waiting after the last one; that is just dead time.
  ok(paces === 2, `paced between groups but not after the last (${paces})`);
}

console.log('=== progress is reported as it goes ===');
{
  // A pass over fifteen groups takes long enough that silence reads as a hang.
  const seen = [];
  const bot = mk(GROUPS, { 'a@g.us': { locked: true }, 'b@g.us': { locked: false }, 'c@g.us': { locked: false } });
  await bot.syncAlwaysLocked((p) => seen.push(p));
  ok(seen.length === 3, 'one progress call per group');
  ok(seen[2].done === 3 && seen[2].total === 3, 'counting up to the total');
}

console.log('=== the diff the portal shows ===');
{
  // Mirrors POST /lockdown/sync-always: added, removed, and left alone.
  const current = new Set(['b@g.us', 'c@g.us']);   // b is stale, c is right
  const bot = mk(GROUPS, {
    'a@g.us': { locked: true },                     // newly admins-only -> add
    'b@g.us': { locked: false },                    // opened in WhatsApp  -> remove
    'c@g.us': { locked: true },                     // already correct     -> no change
  }, { alwaysLocked: [...current] });

  const scanned = await bot.syncAlwaysLocked();
  const readable = scanned.filter((g) => !g.error);
  const add = readable.filter((g) => g.locked && !current.has(g.jid));
  const remove = readable.filter((g) => !g.locked && current.has(g.jid));
  const proposed = readable.filter((g) => g.locked).map((g) => g.jid);

  ok(add.length === 1 && add[0].jid === 'a@g.us', 'proposes adding the newly-locked group');
  ok(remove.length === 1 && remove[0].jid === 'b@g.us', 'proposes removing the one now open');
  ok(proposed.length === 2 && proposed.includes('a@g.us') && proposed.includes('c@g.us'),
    'and the proposed list is exactly what is admins-only');
}

console.log('=== sync never writes anything ===');
{
  // The list decides which groups the schedule refuses to open at havdalah.
  // Getting it wrong seals a group for good or opens one on Shabbos, so the
  // admin confirms; syncAlwaysLocked only reports.
  let wrote = false;
  const bot = mk(GROUPS, { 'a@g.us': { locked: true }, 'b@g.us': { locked: false }, 'c@g.us': { locked: false } });
  bot.setGroupLocked = async () => { wrote = true; };
  bot.configStore.update = () => { wrote = true; };
  await bot.syncAlwaysLocked();
  ok(!wrote, 'no group setting changed and no config written');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
