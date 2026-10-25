/* Bulk work must stay slower than a machine. Run: node test/pacing.test.mjs

   Repetition is what WhatsApp rate-limits. Every loop that repeats an action
   across groups, members or messages goes through one central pacing policy —
   deliberately quicker than a person doing it by hand, nowhere near machine
   speed. This test exists so a future change cannot quietly reintroduce a fast
   loop: message revokes were once at 400ms, roughly ten times faster than a
   human could long-press, delete and confirm. */
import fs from 'node:fs';
import { WhatsAppBot } from '../src/core/bot.js';
import { broadcastFile } from '../src/media/broadcast.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const src = fs.readFileSync(new URL('../src/core/bot.js', import.meta.url), 'utf8');
const schema = fs.readFileSync(new URL('../src/config/schema.js', import.meta.url), 'utf8');

console.log('=== the policy exists and is deliberately slow ===');
{
  for (const [key, floor] of [['bulkPacingMs', 3000], ['revokePacingMs', 2000], ['broadcastPacingMs', 5000]]) {
    const m = schema.match(new RegExp(`${key}: (\\d+)`));
    ok(!!m, `${key} is configured`);
    if (m) ok(Number(m[1]) >= floor, `${key} = ${m[1]}ms, at or above the ${floor}ms floor`);
  }
}

console.log('=== every bulk site uses the shared pacing ===');
{
  ok(/_bulkDelay\(kind = 'bulk'\)/.test(src), 'a single helper decides the delay');
  ok((src.match(/_bulkPace\(/g) ?? []).length >= 5, 'and every bulk loop calls it');

  // No loop may carry its own hand-picked short sleep again.
  const bad = [...src.matchAll(/await sleep\((\d+)\)/g)]
    .map((m) => Number(m[1]))
    .filter((ms) => ms > 0 && ms < 3000);
  const allowed = [3000];      // the one-off pause before requesting a pairing code
  const offenders = bad.filter((ms) => !allowed.includes(ms));
  ok(offenders.length === 0,
    `no hand-picked sub-3s sleep remains${offenders.length ? ` — found ${offenders.join('ms, ')}ms` : ''}`);
}

console.log('=== the delays resolve as configured ===');
{
  const mk = (whatsapp) => {
    const b = new WhatsAppBot({ configStore: { get: () => ({ whatsapp }) }, dataDir: '/tmp' });
    return b;
  };
  const b = mk({ bulkPacingMs: 4000, revokePacingMs: 2500, broadcastPacingMs: 8000 });
  // _bulkDelay is the BASE; _bulkPace multiplies it by the budget stretch, so
  // bulk work slows with the volume it is responsible for.

  ok(b._bulkDelay('bulk') === 4000, 'bulk delay read from config');
  ok(b._bulkDelay('revoke') === 2500, 'revoke delay read from config');
  ok(b._bulkDelay('broadcast') === 8000, 'broadcast delay read from config');
  ok(b._bulkDelay('nonsense') === 4000, 'an unknown kind falls back to the bulk pace, never to zero');

  const d = mk({});
  ok(d._bulkDelay('bulk') >= 3000, 'a missing config still paces (never instant)');
  ok(d._bulkDelay('revoke') >= 2000, 'including revokes');

  const zero = mk({ bulkPacingMs: 0 });
  ok(zero._bulkDelay('bulk') === 0, 'an operator may deliberately set 0');
  const neg = mk({ bulkPacingMs: -5 });
  ok(neg._bulkDelay('bulk') === 0, 'a negative value cannot become a negative wait');
}

console.log('=== the waits are real, not just configured ===');
{
  const b = new WhatsAppBot({
    configStore: { get: () => ({ whatsapp: { bulkPacingMs: 150, revokePacingMs: 150 } }) },
    dataDir: '/tmp',
  });
  const t0 = Date.now();
  await b._bulkPace();
  const took = Date.now() - t0;
  ok(took >= 140, `_bulkPace actually waits (${took}ms)`);

  const b0 = new WhatsAppBot({ configStore: { get: () => ({ whatsapp: { bulkPacingMs: 0 } }) }, dataDir: '/tmp' });
  const t1 = Date.now();
  await b0._bulkPace();
  ok(Date.now() - t1 < 50, 'and returns immediately when pacing is off');
}

console.log('=== lockdown stays one at a time ===');
{
  ok(/lockdown\?\.pacingMs \?\? this\._bulkDelay\('bulk'\)/.test(src),
    'lockdown has its own setting but falls back to the shared pace');
  const m = schema.match(/pacingMs: (\d+)/);
  ok(m && Number(m[1]) >= 5000, `lockdown paces at ${m?.[1]}ms — the slowest, since it touches every group`);
}

console.log('=== broadcasting the same file to several groups ===');
{
  const at = [];
  await broadcastFile(['a@g.us', 'b@g.us', 'c@g.us'], async () => { at.push(Date.now()); }, { paceMs: 120 });
  ok(at.length === 3, 'every group received it');
  const gaps = at.slice(1).map((t, i) => t - at[i]);
  ok(gaps.every((g) => g >= 100), `it waits between groups: ${gaps.join('ms, ')}ms`);

  const t0 = Date.now();
  await broadcastFile(['only@g.us'], async () => {}, { paceMs: 5000 });
  ok(Date.now() - t0 < 200, 'but never waits after the final group');

  const plugin = fs.readFileSync(new URL('../src/plugins/tv-requests/index.js', import.meta.url), 'utf8');
  ok(/paceMs: ctx\.config\.whatsapp\?\.broadcastPacingMs/.test(plugin), 'the TV sender passes the configured pace');
}

console.log('=== posting into every group is paced on every path ===');
{
  const admin = fs.readFileSync(new URL('../src/core/admin-commands.js', import.meta.url), 'utf8');
  // There is more than one `case 'post-descriptions'` in this file - the audit
  // summariser has one too. Pick the block that actually posts, not the one
  // that describes it, or this asserts against the wrong code.
  const blocks = [...admin.matchAll(/case 'post-descriptions': \{[\s\S]*?\n    \}/g)].map((m) => m[0]);
  const block = blocks.find((b) => /bot\.sendText/.test(b));
  ok(!!block, `found the executing post-descriptions block (of ${blocks.length} candidates)`);
  ok(/await bot\._bulkPace\('broadcast'\)/.test(block),
    'post-and-pin uses the shared pace, not its own number');
  ok(!/continue;/.test(block),
    'no early continue can skip the wait — a failed pin must not speed up the next group');
  const stray = [...admin.matchAll(/setTimeout\(r?e?s?o?l?v?e?, (\d+)\)/g)].map((m) => Number(m[1]));
  ok(stray.length === 0, `no hand-rolled waits left in admin commands${stray.length ? `: ${stray.join(', ')}` : ''}`);
}

console.log('=== a failing bulk run does not become a fast bulk run ===');
{
  const revoke = src.match(/for \(const t of targets\) \{[\s\S]*?\n    \}/)[0];
  const catchAt = revoke.indexOf('catch (err)');
  const paceAt = revoke.indexOf("_bulkPace('revoke')");
  ok(paceAt > catchAt,
    'revokes pace after the catch, so a run of failures still waits between attempts');
}

console.log('=== "is it safe to restart" is answered by the process, not the log ===');
{
  const admin = fs.readFileSync(new URL('../src/core/admin-commands.js', import.meta.url), 'utf8');
  const block = admin.match(/case 'queue-status': \{[\s\S]*?\n    \}/)[0];
  ok(/const media = snap\(queue\)/.test(block) && /const links = snap\(linkQueue\)/.test(block),
    'BOTH queues are reported - the media queue and the separate links queue');
  ok(/media\.active \+ media\.waiting \+ media\.retrying \+ links\.active \+ links\.waiting \+ links\.retrying > 0/.test(block),
    'busy means anything running, waiting, or waiting for its retry on either one');
  ok(/safeToRestart: !busy/.test(block), 'and it says plainly whether a restart is safe');
  ok(/running: \[/.test(block), 'naming what is in flight, so a refusal can be explained');

  const index = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  // The plugins follow the queues since the hourly check's `requeue` op, and
  // the request pause since its pause-requests and resume-requests ops.
  ok(/runAdminCommand\(cmd, \{ bot, dataDir: DATA_DIR, stateStore, configStore, queue, linkQueue(, pluginManager(, requestPause)?)? \}\)/.test(index),
    'both queues are actually handed to the command runner');
}

console.log('=== _pace SERIALISES, it does not merely delay ===');
{
  // The old version read _lastActionAt, awaited, and only then wrote it. Two
  // concurrent callers therefore read the same timestamp, waited the same
  // amount, and fired together - so every caller running in parallel bypassed
  // the pacing completely. Most of them run in parallel: three queue jobs each
  // reacting and notifying, plus enforcement.
  const b = new WhatsAppBot({
    configStore: { get: () => ({ whatsapp: { minActionDelayMs: 60, maxActionDelayMs: 60 } }) },
    dataDir: '/tmp',
  });
  const at = [];
  const t0 = Date.now();
  await Promise.all([1, 2, 3, 4, 5].map(async () => { await b._pace(); at.push(Date.now() - t0); }));
  at.sort((x, y) => x - y);

  const gaps = at.slice(1).map((t, i) => t - at[i]);
  ok(gaps.every((g) => g >= 45), `five concurrent callers are spaced out, not simultaneous (${gaps.join('ms, ')}ms)`);
  ok(at[at.length - 1] >= 200, `the last one waits for the others (${at[at.length - 1]}ms)`);

  const src = fs.readFileSync(new URL('../src/core/bot.js', import.meta.url), 'utf8');
  // The mechanism is now a waiting list drained one at a time rather than a
  // promise chain, because slots also have to be handed out by priority. The
  // serialisation property it exists for is asserted behaviourally above.
  ok(/this\._paceWaiting\.push\(\{/.test(src) && /_drainPace\(\)/.test(src),
    'callers queue for a slot rather than racing for one');
  ok(/if \(this\._pacing\) return;/.test(src),
    'and exactly one drain runs at a time, so two slots are never handed out at once');
}

console.log('=== a film does not queue behind a season of reactions ===');
{
  // Presidential priority is enforced when jobs are PICKED (queue.js) and was
  // being quietly undone at the wire: _pace was strict arrival order. Fine at
  // the 1.2-3.5s base pace, but the budget can stretch a slot to 14s, so a
  // delivery arriving behind twenty queued reactions would wait minutes.
  const b = new WhatsAppBot({
    configStore: { get: () => ({ whatsapp: { minActionDelayMs: 40, maxActionDelayMs: 40, budget: { enabled: false } } }) },
    dataDir: '/tmp',
  });
  const order = [];
  const waits = [];
  for (let i = 0; i < 6; i += 1) waits.push(b._pace('low').then(() => order.push('low')));
  await new Promise((r) => setTimeout(r, 5));
  waits.push(b._pace('critical').then(() => order.push('FILM')));
  await Promise.all(waits);

  const at = order.indexOf('FILM');
  ok(at >= 0 && at <= 2,
    `the film is released early despite arriving last (position ${at + 1} of ${order.length})`);
  ok(order.length === 7, 'and every low action still runs');
}

console.log('=== an action already committed to its slot is not preempted ===');
{
  // The film above lands third, not first: one action was released immediately
  // and a second was already mid-wait when it arrived. Yanking a caller that
  // has already been given the slot would break the serialisation that stops
  // concurrent callers bunching.
  const b = new WhatsAppBot({
    configStore: { get: () => ({ whatsapp: { minActionDelayMs: 50, maxActionDelayMs: 50, budget: { enabled: false } } }) },
    dataDir: '/tmp',
  });
  const at = [];
  const t0 = Date.now();
  const all = [1, 2, 3, 4].map(() => b._pace('normal').then(() => at.push(Date.now() - t0)));
  all.push(b._pace('critical').then(() => at.push(Date.now() - t0)));
  await Promise.all(all);
  at.sort((x, y) => x - y);
  const gaps = at.slice(1).map((t, i) => t - at[i]);
  ok(gaps.every((g) => g >= 40), `slots stay serialised regardless of priority (${gaps.join('ms, ')}ms)`);
}

console.log('=== low-priority work is late, never abandoned ===');
{
  // Priority without aging starves. A queue-position update behind a steady
  // stream of deliveries must eventually go out.
  const src = fs.readFileSync(new URL('../src/core/bot.js', import.meta.url), 'utf8');
  ok(/const PACE_AGE_MS = /.test(src), 'waiting raises standing over time');
  const cap = Number(src.match(/const PACE_AGE_CAP = ([\d.]+);/)[1]);
  const ranks = src.match(/const PACE_RANK = \{ critical: (\d+), normal: (\d+), low: (\d+) \}/);
  const [, crit, norm, low] = ranks.map(Number);
  ok(crit > norm && norm > low, `the three classes are ordered (${low} < ${norm} < ${crit})`);
  ok(low + cap < crit,
    `but ageing can never lift low past critical (${low} + ${cap} < ${crit}) — a waiting person always wins`);
  ok(low + cap > norm, 'while an old low action does eventually outrank a fresh normal one');
}

console.log('=== priority is actually plumbed from the gate ===');
{
  const src = fs.readFileSync(new URL('../src/core/bot.js', import.meta.url), 'utf8');
  const gate = src.match(/async _gate\(kind = 'normal'\) \{[\s\S]*?\n  \}/)[0];
  ok(/await this\._pace\(kind\);/.test(gate),
    'the gate passes its class to the pacer — without this the ordering is dead code');
  ok(gate.indexOf('allows(') < gate.indexOf('_pace('),
    'and admission is decided BEFORE joining the queue, so a shed action costs no slot');
}

console.log('=== every path that sends to WhatsApp is paced ===');
{
  const src = fs.readFileSync(new URL('../src/core/bot.js', import.meta.url), 'utf8');
  // Enforcement deletes went straight to the socket. revokePacingMs only ever
  // covered the BULK ban-wipe loop, never the path that runs day to day.
  const del = src.match(/async deleteMessage\(msg\)[\s\S]*?\n  \}/)[0];
  // _gate() is _pace() plus the volume budget, so this is strictly stronger
  // than the direct _pace() call it replaced.
  ok(/await this\._gate\('critical'\);/.test(del), 'deleteMessage goes through the gate');
  ok(del.indexOf('_gate(') < del.indexOf('sock.sendMessage'), 'before it sends, not after');
  ok(/await this\._pace\(kind\);/.test(src.match(/async _gate\([\s\S]*?\n  \}/)[0]),
    'and the gate paces, at the caller\'s priority');

  // Nothing may reach the socket without passing a gate.
  const sends = [...src.matchAll(/sock\.sendMessage\(/g)].length;
  const paced = (src.match(/await this\._gate\(/g) ?? []).length
    + (src.match(/this\._gate\(/g) ?? []).length
    + (src.match(/await this\._bulkPace\(/g) ?? []).length;
  ok(paced >= sends, `${paced} gate/pace calls cover ${sends} send sites`);

  // Every outbound action must also be COUNTED, or the volume ceiling is blind.
  ok(/this\.budget\.record\(\)/.test(src.match(/async _gate\([\s\S]*?\n  \}/)[0]),
    'the gate counts the action against the budget');
  ok(/this\.budget\.record\(\)/.test(src.match(/async _bulkPace\([\s\S]*?\n  \}/)[0]),
    'and so does bulk work, which is otherwise invisible to it');
}

console.log('=== bulk work slows with the budget it fills ===');
{
  // The inversion this avoids: bulk group operations are the volume that
  // actually earns rate-limits. Counting them against the budget but never
  // slowing them would mean they fill the hour and queue-position reactions
  // pay for it - throttling exactly the wrong traffic.
  const b = new WhatsAppBot({
    configStore: { get: () => ({ whatsapp: { bulkPacingMs: 100, budget: { perHour: 10, softAt: 0, maxStretch: 4 } } }) },
    dataDir: '/tmp',
  });
  const t0 = Date.now();
  await b._bulkPace();
  const quick = Date.now() - t0;

  for (let i = 0; i < 20; i += 1) b.budget.record();   // well over the limit
  const t1 = Date.now();
  await b._bulkPace();
  const slow = Date.now() - t1;
  ok(slow > quick * 1.5, `a saturated budget slows bulk work (${quick}ms -> ${slow}ms)`);

  const src = fs.readFileSync(new URL('../src/core/bot.js', import.meta.url), 'utf8');
  const bulk = src.match(/async _bulkPace\([\s\S]*?\n  \}/)[0];
  ok(/this\.budget\.record\(\)/.test(bulk), 'bulk work is counted');
  ok(/this\.budget\?\.stretch\?\.\(\) \?\? 1/.test(bulk), 'and slowed by the same budget');
}

console.log('=== bulk pacing is slower than machine speed, faster than a person ===');
{
  // Sanity on the numbers themselves: a human doing these by hand is far
  // slower, and anything under a second is machine-gun territory.
  const nums = ['bulkPacingMs', 'revokePacingMs', 'broadcastPacingMs']
    .map((k) => Number(schema.match(new RegExp(`${k}: (\\d+)`))[1]));
  ok(nums.every((n) => n >= 2000), 'nothing is under two seconds');
  ok(nums.every((n) => n <= 30000), 'and nothing is so slow it would never finish');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
