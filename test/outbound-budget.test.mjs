/* A ceiling on how MUCH, not just how fast.
   Run: node test/outbound-budget.test.mjs

   Every other control here shapes the GAP between actions. None caps the TOTAL.
   At the 1.2-3.5s pacing floor, sustained, 1,000-3,000 actions an hour is
   reachable with nothing to stop it - and volume is the one thing WhatsApp has
   measurably punished this account for (26 rate-limits, escalating to 480s).

   The hard requirement, which most of these tests are about: slowing down must
   never turn into losing someone's film. */
import fs from 'node:fs';
import { OutboundBudget, SHED_AT } from '../src/core/outbound-budget.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

function clock(start = 1_000_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function budget(cfg = {}, c = clock()) {
  const warnings = [];
  const b = new OutboundBudget({
    getConfig: () => ({ perHour: 100, perDay: 1000, softAt: 0.7, maxStretch: 4, ...cfg }),
    now: c.now,
    log: { warn: (m) => warnings.push(m) },
  });
  return { b, c, warnings };
}

console.log('=== a quiet night is completely unaffected ===');
{
  const { b } = budget();
  for (let i = 0; i < 50; i += 1) b.record();
  ok(b.stretch() === 1, 'at 50% the pacing is untouched');
  ok(b.allows('low'), 'and even cosmetic work goes through');
  ok(b.snapshot().state === 'normal', 'the portal says "normal"');
}

console.log('=== back-pressure builds gradually, it does not slam on ===');
{
  const { b } = budget();
  for (let i = 0; i < 70; i += 1) b.record();
  ok(b.stretch() === 1, 'nothing happens right up to the soft threshold');

  const at = [];
  for (const target of [80, 90, 100]) {
    const { b: bb } = budget();
    for (let i = 0; i < target; i += 1) bb.record();
    at.push(bb.stretch());
  }
  ok(at[0] > 1 && at[0] < at[1] && at[1] < at[2], `it ramps: ${at.map((x) => x.toFixed(2)).join('x, ')}x`);
  ok(Math.abs(at[2] - 4) < 0.01, `and reaches maxStretch at 100% (${at[2]}x)`);
}

console.log('=== the stretch is CAPPED, so the queue still drains ===');
{
  // An unbounded stretch turns a busy night into a queue that never empties,
  // which reads as the bot being broken. Shedding is the answer to a real
  // overrun, not an ever-growing delay.
  const { b } = budget();
  for (let i = 0; i < 1000; i += 1) b.record();      // 10x over the hourly limit
  ok(b.stretch() === 4, `10x over, still capped at 4x (${b.stretch()}x)`);
}

console.log('=== CRITICAL work is never shed, at any utilisation ===');
{
  // This is the whole point. A person who asked for a film gets their film.
  const { b } = budget();
  for (let i = 0; i < 100_000; i += 1) b.record();
  ok(b.utilisation() > 100, `utilisation is absurd (${Math.round(b.utilisation())}x)`);
  ok(b.allows('critical'), 'a reply the requester is waiting on still goes');
  ok(b.allows('critical'), 'and again');
  ok(SHED_AT.critical === Infinity, 'there is no threshold at which it would');
  ok(b.snapshot().shedding.includes('critical') === false,
    'and the portal never reports it as being shed');
}

console.log('=== cosmetic work is shed first, and early ===');
{
  const { b } = budget();
  for (let i = 0; i < 76; i += 1) b.record();        // 76%
  ok(!b.allows('low'), 'a queue-position update is dropped at 76%');
  ok(b.allows('normal'), 'but a lifecycle reaction still goes');
  ok(b.allows('critical'), 'and a reply certainly does');
}

console.log('=== normal work is shed only in a real overrun ===');
{
  const { b } = budget();
  for (let i = 0; i < 99; i += 1) b.record();
  ok(b.allows('normal'), 'at 99% lifecycle reactions still go');
  b.record();
  ok(!b.allows('normal'), 'at 100% they stop');
  ok(b.allows('critical'), 'while the things people wait on continue');
}

console.log('=== the DAY window catches a slow grind ===');
{
  // 60 actions an hour never trips the hourly limit, but sustained for a day it
  // is 1,440 - well past a 1,000/day ceiling. The higher of the two governs.
  const c = clock();
  const { b } = budget({ perHour: 100, perDay: 1000 }, c);
  for (let h = 0; h < 20; h += 1) {
    for (let i = 0; i < 60; i += 1) b.record();
    c.advance(3_600_000);
  }
  ok(b.hour.count() <= 60, `no single hour looks busy (${b.hour.count()}/100)`);
  ok(b.day.count() > 1000, `but the day does (${b.day.count()}/1000)`);
  ok(b.utilisation() >= 1, 'so utilisation is driven by the day window');
  ok(!b.allows('low'), 'and cosmetic work is shed on that basis alone');
}

console.log('=== it recovers as the window rolls off ===');
{
  const c = clock();
  const { b } = budget({}, c);
  for (let i = 0; i < 100; i += 1) b.record();
  ok(!b.allows('normal'), 'saturated');
  c.advance(3_600_000 + 60_000);                     // an hour and a minute later
  ok(b.allows('normal'), 'an hour later it is clear again');
  ok(b.stretch() === 1, 'and the pacing is back to normal');
}

console.log('=== it can be switched off entirely ===');
{
  const { b } = budget({ enabled: false });
  for (let i = 0; i < 10_000; i += 1) b.record();
  ok(b.allows('low'), 'nothing is shed when disabled');
  ok(b.stretch() === 1, 'and nothing is slowed');
  ok(b.snapshot().state === 'off', 'the portal says so plainly');
}

console.log('=== the operator can tell a slowdown from a fault ===');
{
  const { b, warnings } = budget();
  for (let i = 0; i < 80; i += 1) b.record();
  const s = b.snapshot();
  ok(s.state === 'slowing', `state is legible: "${s.state}"`);
  ok(s.hour.used === 80 && s.hour.limit === 100, 'with the real numbers');
  ok(s.shedding.includes('low') && !s.shedding.includes('critical'),
    `and exactly what is affected: [${s.shedding.join(', ')}]`);

  for (let i = 0; i < 40; i += 1) b.allows('low');
  ok(warnings.length === 1, `it warns once, not per dropped action (${warnings.length})`);
  ok(/Nothing a person is waiting on/.test(warnings[0]),
    'and the warning says what is NOT affected, so it does not read as an outage');
  ok(b.snapshot().shedTotals.low > 0, 'the shed count is visible for later');
}

console.log('=== limits are read live, so the portal can change them ===');
{
  let perHour = 100;
  const b = new OutboundBudget({ getConfig: () => ({ perHour, perDay: 100000 }) });
  for (let i = 0; i < 90; i += 1) b.record();
  ok(!b.allows('low'), 'shedding at 90 of 100');
  perHour = 1000;                                     // operator raises it
  ok(b.allows('low'), 'raising the limit takes effect without a restart');
}

console.log('=== bad config cannot make it misbehave ===');
{
  const b = new OutboundBudget({ getConfig: () => ({ perHour: 0, perDay: 0 }) });
  b.record();
  ok(Number.isFinite(b.utilisation()), `a zero limit does not produce Infinity (${b.utilisation()})`);
  ok(b.allows('critical'), 'and critical work still passes');

  const d = new OutboundBudget({ getConfig: () => ({}) });
  ok(d.settings.perHour > 0 && d.settings.perDay > 0, 'missing config falls back to real defaults');
  ok(d.settings.perDay > d.settings.perHour, 'and the daily ceiling is above the hourly one');
}

console.log('=== a shed action must be reported as shed, not as sent ===');
{
  // The bug class this closes: any caller that records "I already showed them
  // this" BEFORE the send is admitted turns a dropped action into a permanent
  // lie. _updatePositions did exactly that - it set lastEmoji, then fired the
  // reaction; a shed reaction left the guard believing the requester had seen a
  // number they never saw, freezing their position for good.
  const src = fs.readFileSync(new URL('../src/core/bot.js', import.meta.url), 'utf8');
  const react = src.match(/async react\(msg, emoji[\s\S]*?\n  \}/)[0];
  ok(/return false;/.test(react), 'react reports a shed action as false');
  ok(/return true;/.test(react), 'and a real one as true — without this, no caller can tell');

  // Both pipelines send their place numbers through one helper now, so that
  // is where the record has to come from the answer.
  const place = fs.readFileSync(new URL('../src/media/place-reaction.js', import.meta.url), 'utf8');
  const upd = place.match(/export function showPlace\([\s\S]*?\n\}/)[0];
  ok(/if \(!sent\) return;[^\n]*\n\s*r\.lastEmoji = emoji;/.test(upd),
    'and the dedupe guard is set from the ANSWER, not from having asked');
  ok(upd.indexOf('r.lastEmoji = emoji') > upd.indexOf('bot.react('),
    'the record happens after the send, not before it');
  for (const name of ['movie-requests', 'tv-requests']) {
    const src = fs.readFileSync(new URL(`../src/plugins/${name}/index.js`, import.meta.url), 'utf8');
    const fn = src.match(/_updatePositions\(ctx\) \{[\s\S]*?\n  \},/)[0];
    ok(/showPlace\(ctx\.bot, r, /.test(fn) && !/lastEmoji = /.test(fn),
      `${name} sends its numbers through that helper and records nothing itself`);
  }
}

console.log('=== terminal reactions are never shed ===');
{
  // A terminal reaction is the last thing a requester will ever see about their
  // request. Dropping it leaves them with nothing, for ever - unlike a
  // lifecycle reaction, which the next stage replaces a minute later.
  const plugin = (await import('../src/plugins/movie-requests/index.js')).default;
  const cfg = {
    reactions: {
      rated: '⛔', notFound: '❓', notInLibrary: '📬', failed: '⚠️', done: '✅',
      tooFast: '🚫', cancelled: '❌', theaters: '🎪', needYear: '📅', skipped: '⏭️',
      researching: '🔍', added: '🎬', downloading: '⬇️', converting: '⚙️', sending: '⬆️',
      positions: ['1️⃣', '2️⃣', '3️⃣'], positionOverflow: '🔢',
    },
  };
  const k = (e) => plugin._reactionKind(cfg, e);

  for (const [emoji, name] of [['⛔', 'blocked on rating'], ['📬', 'not in library'],
    ['⚠️', 'failed'], ['✅', 'done'], ['🚫', 'throttled'], ['❌', 'cancelled'],
    ['❓', 'not found'], ['📅', 'which year?']]) {
    ok(k(emoji) === 'critical', `${name} is critical — it is the last word on that request`);
  }
  for (const [emoji, name] of [['🔍', 'researching'], ['⬇️', 'downloading'], ['⚙️', 'converting']]) {
    ok(k(emoji) === 'normal', `${name} is normal — the next stage replaces it`);
  }
  ok(k('2️⃣') === 'low', 'a queue position is low — its own next update supersedes it');
  ok(k('🔢') === 'low', 'and so is the overflow marker');
  ok(k('🤷') === 'normal', 'an unknown emoji falls back to normal, never to low');
}

console.log('=== the TV side is classified too ===');
{
  // The live bug this closes: only the movie pipeline classified its
  // reactions, so every TV reaction fell through to 'normal' and was shed at
  // full utilisation - including "which season?", whose absence deadlocks the
  // request for ever, because the bot then waits for an answer the requester
  // was never asked for.
  const { reactionKind, TERMINAL_KEYS } = await import('../src/media/reaction-class.js');
  ok(TERMINAL_KEYS.includes('needSeason'),
    '"which season?" is terminal — without it the request deadlocks permanently');
  ok(reactionKind({ needSeason: '📺' }, '📺') === 'critical', 'and is never shed');

  const tv = fs.readFileSync(new URL('../src/plugins/tv-requests/index.js', import.meta.url), 'utf8');
  ok(/import \{ reactionKind \}/.test(tv), 'the TV plugin classifies its reactions');
  const bare = [...tv.matchAll(/ctx\.bot\.react\([^)]*\)/g)].filter((m) => !/kind/.test(m[0]));
  ok(bare.length === 0, `no unclassified react remains on the TV side (${bare.length})`);

  const mv = fs.readFileSync(new URL('../src/plugins/movie-requests/index.js', import.meta.url), 'utf8');
  const bareMv = [...mv.matchAll(/ctx\.bot\.react\([^)]*\)/g)].filter((m) => !/kind/.test(m[0]));
  ok(bareMv.length === 0, `nor on the movie side (${bareMv.length})`);

  // One implementation, so the two pipelines cannot drift apart again.
  ok(/return reactionKind\(cfg\?\.reactions, emoji\);/.test(mv),
    'both sides delegate to the same classifier');
}

console.log('=== classification survives the operator editing emoji ===');
{
  // Keyed by config KEY, not by the literal emoji, so changing an emoji in the
  // portal cannot silently reclassify it as droppable.
  const plugin = (await import('../src/plugins/movie-requests/index.js')).default;
  const custom = { reactions: { done: '🎉', positions: ['A', 'B'] } };
  ok(plugin._reactionKind(custom, '🎉') === 'critical', 'a re-emojied "done" is still critical');
  ok(plugin._reactionKind(custom, 'B') === 'low', 'and a re-emojied position is still low');
}

console.log('=== connects are counted, because they cannot be slowed ===');
{
  // 6,136 socket opens in twelve days, 935 in the worst hour - the largest
  // traffic source in the logs and the one tied to all six logouts. It cannot
  // be gated at _requireSock() (it happens before a socket exists) and must not
  // be blocked, so it is counted: a reconnect storm visibly spends the budget
  // and the message side slows in response.
  const src = fs.readFileSync(new URL('../src/core/bot.js', import.meta.url), 'utf8');
  ok(/const CONNECT_COST = \d+;/.test(src), 'a connect has an explicit cost');
  ok(/this\.budget\.record\(CONNECT_COST\);/.test(src), 'and is charged for it');
  const cost = Number(src.match(/const CONNECT_COST = (\d+);/)[1]);
  ok(cost > 1, `weighted above a single message (${cost}x)`);
  // It must never be able to REFUSE a reconnect - that turns a rate problem
  // into an outage.
  const startBody = src.slice(src.indexOf('async _start()'), src.indexOf('this.sock.ev.on'));
  ok(!/budget\.allows\(/.test(startBody), 'and connecting is never refused on budget grounds');
}

console.log('=== the shipped limits, against the traffic actually measured ===');
{
  // A ceiling set too high does nothing; too low and it brakes on an ordinary
  // night and teaches the operator to switch it off. These are the real figures
  // from 18 Aug - 1 Sep, one unit = one message-equivalent, a socket open = 5.
  const { DEFAULT_CONFIG } = await import('../src/config/schema.js');
  const cfg = DEFAULT_CONFIG.whatsapp.budget;

  const run = (units, window) => {
    const c = clock();
    const b = new OutboundBudget({ getConfig: () => cfg, now: c.now });
    // Spread the load across the window so the ring is exercised rather than
    // every unit landing in one bucket.
    const steps = window === 'hour' ? 60 : 96;
    const per = Math.floor(units / steps);
    for (let i = 0; i < steps; i += 1) { b.record(per); c.advance((window === 'hour' ? 3_600_000 : 86_400_000) / steps); }
    return b;
  };

  const busyHour = run(132, 'hour');
  ok(busyHour.stretch() === 1, `an ordinary busy hour (132 units) is untouched (${busyHour.stretch()}x)`);
  ok(busyHour.allows('low'), 'and even queue positions go through');

  const stormHour = run(4675, 'hour');          // 935 socket opens, 20 Aug
  ok(stormHour.stretch() > 1, 'the worst hour on record does trigger back-pressure');
  ok(!stormHour.allows('low'), 'and sheds queue positions');
  ok(!stormHour.allows('normal'), 'and lifecycle reactions');
  ok(stormHour.allows('critical'), 'while films, replies and terminal reactions still go');

  const ordinaryDay = run(2900, 'day');
  ok(ordinaryDay.stretch() === 1, `an ordinary day (2,900 units) is untouched (${ordinaryDay.stretch()}x)`);

  const worstDay = run(5599, 'day');            // 20 Aug
  ok(worstDay.utilisation() <= 0.75,
    `the worst day on record sits at the soft threshold, not past it (${Math.round(worstDay.utilisation() * 100)}%)`);

  // The sizing rule, so a future edit cannot quietly make it inert or hostile.
  ok(cfg.perHour > 132 * 3, 'the hourly ceiling is well clear of ordinary traffic');
  ok(cfg.perHour < 4675, 'but below the reconnect storm it exists to catch');
  ok(cfg.perDay > 5599, 'the daily ceiling is above the worst day ever seen');
  ok(cfg.perDay < 5599 * 2, 'but not so far above it that it could never bind');
}

console.log('=== EVERY call that reaches WhatsApp is counted ===');
{
  // A volume ceiling that cannot see half the traffic is decoration. Eleven
  // methods reached WhatsApp with no gate and no meter - setGroupDescription,
  // setGroupLocked, the participant updates, both chatModify paths, presence,
  // the history fetch - which is to say most of the bulk group administration
  // WhatsApp punishes hardest. This test walks the file and fails if a new one
  // appears.
  const src = fs.readFileSync(new URL('../src/core/bot.js', import.meta.url), 'utf8');

  const OUTBOUND = ['sendMessage', 'chatModify', 'groupFetchAllParticipating', 'groupMetadata',
    'groupUpdateDescription', 'groupUpdateSubject', 'groupParticipantsUpdate', 'groupSettingUpdate',
    'fetchMessageHistory', 'groupGetInviteInfo', 'groupInviteCode', 'sendPresenceUpdate'];

  const gaps = [];
  let seen = 0;
  for (const m of src.matchAll(/sock\??\.\??\.?(\w+)\(/g)) {
    if (!OUTBOUND.includes(m[1])) continue;
    seen += 1;
    // Look back for the accounting that precedes it, within its own method.
    const window = src.slice(Math.max(0, m.index - 1400), m.index);
    const counted = /budget\.record\(/.test(window) || /_gate\(/.test(window) || /_bulkPace\(/.test(window);
    if (!counted) gaps.push(`${src.slice(0, m.index).split('\n').length}: ${m[1]}`);
  }
  ok(seen >= 15, `found the outbound calls to audit (${seen})`);
  ok(gaps.length === 0, `every one is gated or metered${gaps.length ? ` — MISSING: ${gaps.join(', ')}` : ''}`);
}

console.log('=== the expensive calls cost more than a reaction ===');
{
  const src = fs.readFileSync(new URL('../src/core/bot.js', import.meta.url), 'utf8');
  const connect = Number(src.match(/const CONNECT_COST = (\d+);/)[1]);
  const fetch = Number(src.match(/const GROUP_FETCH_COST = (\d+);/)[1]);
  ok(connect > 1 && fetch > 1, `a connect costs ${connect} and a group fetch ${fetch}, not 1`);
  ok(/this\.budget\.record\(GROUP_FETCH_COST\)/.test(src), 'and the group fetch is charged its weight');
  ok(connect >= fetch, 'the connect - the traffic tied to all six logouts - is the dearest');
}

console.log('=== presence is sheddable, and visible to the ceiling ===');
{
  // It bypasses _requireSock entirely (this.sock?.), so without an explicit
  // gate the budget could not see it at all.
  const src = fs.readFileSync(new URL('../src/core/bot.js', import.meta.url), 'utf8');
  const pres = src.match(/async sendPresence\([\s\S]*?\n  \}/)[0];
  ok(/this\.budget\.allows\('low'\)/.test(pres), 'a typing indicator is shed first');
  ok(/this\.budget\.record\(\)/.test(pres), 'and counted when it is not');
  ok(pres.indexOf('allows') < pres.indexOf('sendPresenceUpdate'), 'checked before it is sent');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
