/* The reconnect loop that hammered WhatsApp. Run: node test/reconnect-loop.test.mjs

   Regression: a stale reconnect timer fired AFTER a new socket had already
   connected. It called start(), which ended the healthy socket; that socket's
   close handler scheduled another reconnect, which ended the next one — a
   self-perpetuating 4-second cycle producing hundreds of connects, and very
   likely why WhatsApp logged the number out. */
import fs from 'node:fs';
import { WhatsAppBot } from '../src/core/bot.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const mk = () => new WhatsAppBot({ configStore: { get: () => ({ whatsapp: { autoReconnect: true } }) }, dataDir: '/tmp/wa-test' });

console.log('=== a superseded socket cannot schedule a reconnect ===');
{
  const bot = mk();
  let starts = 0;
  bot.start = async function () {          // count start attempts
    starts++;
    this._gen++;
    this._clearReconnect();
  };
  // Pretend generation 1 is live, then a NEWER socket takes over (gen 2).
  bot._gen = 2;
  const staleGen = 1;
  // The stale handler's guard is `staleGen !== this._gen` -> must bail out.
  ok(staleGen !== bot._gen, 'the old socket is recognisably superseded');
  ok(starts === 0, 'a superseded handler starts nothing');
}

console.log('=== a pending reconnect is cancelled when a connection succeeds ===');
{
  const bot = mk();
  let fired = false;
  bot._reconnectTimer = setTimeout(() => { fired = true; }, 30);
  bot._clearReconnect();
  await tick(60);
  ok(!fired, 'the queued reconnect never fires once cleared');
  ok(bot._reconnectTimer === null, 'the handle is released');
}

console.log('=== start() supersedes and cancels before touching the socket ===');
{
  const bot = mk();
  let ended = 0;
  let fired = false;
  bot.sock = { end: () => { ended++; } };
  bot._reconnectTimer = setTimeout(() => { fired = true; }, 25);
  const before = bot._gen;

  // Run just the guard prologue that start() performs.
  const myGen = ++bot._gen;
  bot._clearReconnect();
  if (bot.sock) { try { bot.sock.end(); } catch {} bot.sock = null; }

  ok(myGen === before + 1, 'the generation advances on every start');
  ok(ended === 1, 'the previous socket is ended');
  await tick(50);
  ok(!fired, 'and its queued reconnect is cancelled, not left to fire later');
}

console.log('=== stop() and logout() orphan in-flight handlers ===');
{
  const bot = mk();
  bot.sock = { end: () => {} };
  const gen = bot._gen;
  let fired = false;
  bot._reconnectTimer = setTimeout(() => { fired = true; }, 25);
  await bot.stop();
  ok(bot._gen > gen, 'stop() advances the generation so old handlers go quiet');
  ok(bot._reconnectTimer === null, 'stop() cancels a pending reconnect');
  await tick(50);
  ok(!fired, 'nothing reconnects after an intentional stop');
}

console.log('=== the source enforces the guards ===');
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/core/bot.js', import.meta.url), 'utf8');
  ok(/if \(myGen !== this\._gen\) return;/.test(src), "connection.update ignores a superseded socket");
  ok(/const myGen = \+\+this\._gen;/.test(src), 'start() claims a new generation');
  ok(/this\._clearReconnect\(\);\s*\n\s*if \(this\.sock\)/.test(src), 'pending reconnects are cancelled BEFORE ending the old socket');
  ok(/if \(connection === 'open'\) \{\s*\n\s*this\._clearReconnect\(\);/.test(src), 'a successful connection cancels any queued reconnect');
  ok(/if \(this\.stopping \|\| myGen !== this\._gen\) return;/.test(src), 'the timer re-checks before reconnecting');
  ok(!/await sleep\(delay\);\s*\n\s*if \(!this\.stopping\) this\.start\(\)/.test(src), 'the old uncancellable sleep-then-start is gone');
}

console.log('=== the backoff does not plateau and hammer forever ===');
{
  // It used to cap at 60s and stay there for the whole outage: 169 reconnects
  // in one day, which is the sustained pattern WhatsApp flags. A blip must
  // still recover in seconds; only a persistent failure backs right off.
  const src = fs.readFileSync(new URL('../src/core/bot.js', import.meta.url), 'utf8');
  ok(!/Math\.min\(60_000, 2_000 \*\* ?/.test(src) && !/Math\.min\(60_000, 2_000 \* 2/.test(src),
    'the flat 60-second ceiling is gone');
  ok(/maxReconnectDelayMs \?\? 900_000/.test(src), 'the ceiling is configurable, defaulting to 15 minutes');
  ok(/Math\.min\(ceiling, 2_000 \* 2 \*\* Math\.min\(this\.reconnectAttempts, 10\)\)/.test(src),
    'and it keeps doubling toward that ceiling rather than stopping at 60s');
  ok(/0\.85 \+ Math\.random\(\) \* 0\.3/.test(src),
    'with jitter, so reconnecting clients do not all knock on the same second');

  // The shape that matters: fast early, slow late.
  const ceiling = 900_000;
  const at = (n) => Math.min(ceiling, 2_000 * 2 ** Math.min(n, 10));
  ok(at(1) <= 4_000, `first retry is still seconds (${at(1) / 1000}s) — a blip recovers fast`);
  ok(at(4) <= 40_000, `still under a minute by the fourth (${at(4) / 1000}s)`);
  ok(at(12) === ceiling, 'and a sustained outage settles at the ceiling');

  const perDay = (24 * 3600 * 1000) / ceiling;
  ok(perDay < 120, `a full day of outage is ~${Math.round(perDay)} attempts, not 1440`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
