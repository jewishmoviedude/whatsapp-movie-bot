/* Only one connection attempt at a time. Run: node test/start-gate.test.mjs

   The logs carry 168 "start() called while a socket already exists" warnings.
   The guard that logs them runs at the TOP of _start(), but _start() then
   awaits three times - loading Baileys, reading the auth state, fetching the
   protocol version over the network - before it assigns this.sock. Two callers
   arriving in that window both saw sock === null and both opened a socket.

   The generation counter orphans the loser's handlers. It cannot un-open its
   connection, and two live sockets on one account is what connectionReplaced
   is for. */
import fs from 'node:fs';
import { WhatsAppBot } from '../src/core/bot.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A bot whose _start() takes `ms` to "open a socket", like the real one. */
function bot({ ms = 60, fails = false } = {}) {
  const b = new WhatsAppBot({ configStore: { get: () => ({ whatsapp: {} }) }, dataDir: '/tmp' });
  b.opens = 0;
  b.live = 0;
  b.maxLive = 0;
  b._start = async () => {
    b.opens += 1;
    if (b.sock) { b.live -= 1; b.sock = null; }   // _start() ends the old socket first
    await sleep(ms);                       // the window where both used to slip through
    if (fails) throw new Error('connect failed');
    b.live += 1;                           // socket assigned
    b.maxLive = Math.max(b.maxLive, b.live);
    b.sock = { end() {} };
  };
  return b;
}

console.log('=== two callers arriving together open ONE socket ===');
{
  const b = bot();
  await Promise.all([b.start(), b.start()]);
  ok(b.maxLive === 1, `never two live at once (peak ${b.maxLive})`);
  ok(b.opens === 2, 'the second attempt still runs — it is serialised, not silently dropped');
}

console.log('=== four callers, the real shape ===');
{
  // reconnect loop + boot auto-connect + portal button + account switch
  const b = bot({ ms: 40 });
  await Promise.all([b.start(), b.start(), b.start(), b.start()]);
  ok(b.maxLive === 1, `still only one at a time (peak ${b.maxLive})`);
}

console.log('=== they are actually sequential, not merely counted ===');
{
  const b = new WhatsAppBot({ configStore: { get: () => ({ whatsapp: {} }) }, dataDir: '/tmp' });
  const span = [];
  b._start = async () => { span.push('in'); await sleep(50); span.push('out'); };
  await Promise.all([b.start(), b.start(), b.start()]);
  ok(span.join(',') === 'in,out,in,out,in,out',
    `each finishes before the next begins (${span.join(',')})`);
}

console.log('=== a failed start does not block the next one ===');
{
  const b = bot({ ms: 20, fails: true });
  let threw = 0;
  await Promise.all([b.start().catch(() => threw++), b.start().catch(() => threw++)]);
  ok(threw === 2, 'both callers see the failure');

  // The chain keeps a settled link by design; what matters is that a failure
  // does not latch it shut.
  b._start = async () => { b.opens += 1; };
  await b.start();
  ok(b.opens === 3, 'a later start still runs after two failures');

  const b2 = bot({ ms: 10 });
  b2._start = (async () => { throw new Error('boom'); });
  await b2.start().catch(() => {});
  let ran = false;
  b2._start = async () => { ran = true; };
  await b2.start();
  ok(ran, 'and after a rejection too');
}

console.log('=== a hung start cannot lock the operator out ===');
{
  // If the gate were unbounded, one start stuck on a network fetch would mean
  // the portal Connect button did nothing, forever.
  const b = new WhatsAppBot({ configStore: { get: () => ({ whatsapp: {} }) }, dataDir: '/tmp' });
  let second = false;
  b._start = async () => { await sleep(60_000); };      // never returns in this test
  b.start();
  const src = fs.readFileSync(new URL('../src/core/bot.js', import.meta.url), 'utf8');
  const gate = Number(src.match(/START_GATE_MS = (\d+)_000/)[1]);
  ok(gate > 0 && gate <= 60, `the wait is bounded at ${gate}s, not indefinite`);
  ok(/if \(prev\) await Promise\.race\(\[prev, sleep\(START_GATE_MS\)\]\)/.test(src),
    'the second caller races the previous link against a timeout');
}

console.log('=== the gate sits in front of every caller ===');
{
  const src = fs.readFileSync(new URL('../src/core/bot.js', import.meta.url), 'utf8');
  ok(/async start\(\) \{[\s\S]{0,600}?return this\._start\(\);/.test(src)
     && /^  async _start\(\) \{/m.test(src),
    'start() is the gate and _start() is the body, so all four callers inherit it');
  ok(/const prev = this\._starting;/.test(src),
    'and it chains onto the previous start rather than sharing one gate — '
    + 'several waiters on one promise all wake together, which is the same overlap again');
  // The four call sites must go through start(), never _start().
  const callers = ['src/index.js', 'src/web/api.js', 'src/core/failover.js']
    .map((f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')).join('\n');
  ok(!/\b(bot|this\.bot)\._start\(/.test(callers), 'no caller reaches past the gate into _start()');
  ok(/bot\.start\(\)/.test(callers), 'they all use start()');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
