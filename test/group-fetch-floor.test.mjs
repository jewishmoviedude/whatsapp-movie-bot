/* The group list is the one call WhatsApp actually punished us for.
   Run: node test/group-fetch-floor.test.mjs

   `groupFetchAllParticipating()` pulls every group's full participant list.
   The logs show 26 rate-limits against it, with escalating 30s -> 480s
   penalties - more than every other WhatsApp complaint combined.

   Two holes let it through: every bulk admin operation forced a fetch when it
   finished (so five bans in a row meant five full fetches), and a forced fetch
   arriving while one was already running was silently DROPPED, leaving the
   cache wrong until the five-minute expiry. */
import fs from 'node:fs';
import { WhatsAppBot } from '../src/core/bot.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

function bot({ latency = 0 } = {}) {
  const b = new WhatsAppBot({ configStore: { get: () => ({ whatsapp: {} }) }, dataDir: '/tmp' });
  b.fetches = 0;
  b.sock = {
    groupFetchAllParticipating: async () => {
      b.fetches += 1;
      if (latency) await new Promise((r) => setTimeout(r, latency));
      return { 'g1@g.us': { subject: 'One', participants: [] } };
    },
  };
  b._requireSock = () => b.sock;
  return b;
}

console.log('=== an ordinary read is cached ===');
{
  const b = bot();
  await b.refreshGroups();
  await b.refreshGroups();
  await b.refreshGroups();
  ok(b.fetches === 1, `three reads, one fetch (${b.fetches})`);
  ok(b.groups().length === 1, 'and the cache is populated');
}

console.log('=== a bulk run cannot force a fetch per operation ===');
{
  // This is the reported shape: ban five people, each finishing with
  // refreshGroups({ force: true }).
  const b = bot();
  await b.refreshGroups({ force: true });          // the first is allowed
  ok(b.fetches === 1, 'the first forced refresh goes through');

  for (let i = 0; i < 5; i++) await b.refreshGroups({ force: true });
  ok(b.fetches === 1, `five more in quick succession add nothing (${b.fetches} total)`);
  ok(b._groupTimer, 'they are collapsed into one pending run, not dropped');
}

console.log('=== a suppressed force is delayed, never discarded ===');
{
  // Dropping it is not acceptable: the caller just CHANGED the membership, so
  // the cache is known to be wrong.
  const b = bot();
  b._lastGroupFetch = Date.now();                  // pretend one just happened
  await b.refreshGroups({ force: true });
  ok(b.fetches === 0, 'the immediate fetch is suppressed');

  const t = b._groupTimer;
  ok(!!t, 'but a refresh is scheduled');
  clearTimeout(t);

  // and when it fires it must actually force, or it would hit the 5-min cache
  // and quietly do nothing at all.
  const src = fs.readFileSync(new URL('../src/core/bot.js', import.meta.url), 'utf8');
  ok(/scheduleGroupRefresh\(GROUP_FORCE_FLOOR_MS - since \+ \d+, 0, \{ force: true \}\)/.test(src),
    'the scheduled retry carries force, otherwise the cache would stay stale');
  ok(/this\.refreshGroups\(\{ force \}\)/.test(src), 'and the scheduler passes it through');
}

console.log('=== concurrent callers share one fetch ===');
{
  const b = bot({ latency: 60 });
  await Promise.all([
    b.refreshGroups({ force: true }),
    b.refreshGroups({ force: true }),
    b.refreshGroups({ force: true }),
    b.refreshGroups(),
  ]);
  ok(b.fetches === 1, `four concurrent callers, one fetch (${b.fetches})`);
}

console.log('=== a caller arriving mid-fetch gets the result, not the stale list ===');
{
  // The old code returned this.groups() immediately when busy - the caller saw
  // the list from BEFORE the fetch it was waiting on.
  const b = bot({ latency: 50 });
  const first = b.refreshGroups({ force: true });
  const second = b.refreshGroups({ force: true });
  const [, groups] = await Promise.all([first, second]);
  ok(groups.length === 1, 'the second caller waits and sees the fetched data');
}

console.log('=== the floor expires ===');
{
  const b = bot();
  await b.refreshGroups({ force: true });
  b._lastGroupFetch = Date.now() - 61_000;         // past the 1-min floor
  await b.refreshGroups({ force: true });
  ok(b.fetches === 2, 'a forced refresh a minute later is allowed through');
}

console.log('=== the event path still does not force ===');
{
  // groups.update fires in bursts; forcing there caused a permanent
  // refresh -> rate-limit -> back off -> refresh cycle.
  const src = fs.readFileSync(new URL('../src/core/bot.js', import.meta.url), 'utf8');
  ok(/scheduleGroupRefresh\(delay = 10_000, attempt = 0, \{ force = false \} = \{\}\)/.test(src),
    'force is opt-in, so the event path is unforced by default');
  const floor = Number(src.match(/GROUP_FORCE_FLOOR_MS = (\d+)_000/)[1]);
  ok(floor >= 60, `the forced floor is at least a minute (${floor}s)`);
  ok(!/_groupBusy/.test(src), 'the old drop-if-busy flag is gone');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
