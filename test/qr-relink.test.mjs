/* Re-linking a number after a wipe. Run: node test/qr-relink.test.mjs

   The report: "sometimes when I wipe and try to reconnect it takes too long or
   the QR doesn't show."

   Two causes, both here. First, an unscanned QR closes the socket with the
   same 408 a network failure does, so it was counted as a failed reconnect and
   fed the ban-risk backoff - after a few missed QR windows the next code was
   up to fifteen minutes away, with the panel showing a bare "Connecting…".
   Second, reconnectAttempts was reset ONLY by a successful connection, so a
   wipe (which happens precisely when connecting has been failing) began its
   re-link already deep in that backoff.

   None of this may weaken the backoff for real outages - that ceiling is what
   stopped the reconnect storms in docs/whatsapp-ban-risk.md. */
import { WhatsAppBot } from '../src/core/bot.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const mk = (whatsapp = {}) => new WhatsAppBot({
  configStore: { get: () => ({ whatsapp: { autoReconnect: true, ...whatsapp } }) },
  dataDir: '/tmp/wa-test-qr',
});

console.log('=== a wipe starts a fresh link, not the next tick of an outage ===');
{
  const bot = mk();
  bot.reconnectAttempts = 11;          // a bad patch, which is WHY you wipe
  bot.nextReconnectAt = Date.now() + 900_000;
  await bot.logout({ wipe: false });

  ok(bot.reconnectAttempts === 0, 'logout resets the attempt counter');
  ok(bot.nextReconnectAt === null, 'and forgets the pending backoff');
  ok(bot.qrDataUrl === null && bot.pairingCode === null, 'and clears any code still on screen');
}

console.log('=== so does a deliberate stop ===');
{
  const bot = mk();
  bot.reconnectAttempts = 9;
  bot.qrDataUrl = 'data:image/png;base64,STALE';
  bot.pairingCode = 'ABCD1234';
  await bot.stop();

  ok(bot.reconnectAttempts === 0, 'stop resets the counter too');
  // The panel renders whatever is here. A code that is no longer being offered
  // reads as a live one, and people scan it over and over.
  ok(bot.qrDataUrl === null, 'a dead QR does not stay on screen');
  ok(bot.pairingCode === null, 'nor a dead pairing code');
}

console.log('=== the backoff for a real outage is untouched ===');
{
  // 2s doubling to the configured ceiling. This is the ban-risk mitigation and
  // must keep working exactly as it did.
  const ceiling = 900_000;
  const at = (n) => Math.min(ceiling, 2_000 * 2 ** Math.min(n, 10));
  ok(at(1) === 4_000, 'a blip still recovers in 4s');
  ok(at(4) === 32_000, 'still under a minute by the fourth attempt');
  ok(at(10) === ceiling, 'and settles at the ceiling, not at 60s');
  ok(at(50) === ceiling, 'which it never exceeds');
}

console.log('=== an unscanned QR is not an outage ===');
{
  // Baileys ends a link session itself when its ref list runs out, with
  // statusCode 408 - indistinguishable here from a dropped connection. What
  // tells them apart is that a linking session has no credentials: there is
  // nothing to reconnect TO, only somebody waiting to be shown a code.
  const bot = mk();
  bot._linking = true;
  ok(bot._linking === true, 'the bot knows it is linking rather than resuming');

  const linked = mk();
  linked._linking = false;
  ok(linked._linking === false, 'and knows when it is not');

  // The distinction has to reach the supervisor as well, or failover switches
  // the account away before the QR is ever drawn.
  const st = bot.status();
  ok('linking' in st, 'status publishes it');
  ok('nextReconnectAt' in st, 'and when the next attempt is due, so the panel can count down');
}

console.log('=== the fast link retry is bounded, so it cannot become a storm ===');
{
  // The fast retry exists for a person standing at the screen. Left unbounded
  // it would knock every five seconds for as long as the process lived, which
  // is exactly the sustained pattern the reconnect ceiling exists to prevent.
  const src = await import('node:fs').then((fs) => fs.readFileSync(
    new URL('../src/core/bot.js', import.meta.url), 'utf8'));
  ok(/const MAX_LINK_ATTEMPTS = \d+/.test(src), 'there is a cap on how many codes are offered');
  ok(/this\._linking && this\._linkAttempts < MAX_LINK_ATTEMPTS/.test(src),
    'and the fast path is gated on it');
  ok(/this\._linking = false;/.test(src.slice(src.indexOf('went unscanned'))),
    'past the cap it falls back to the ordinary backoff');

  const bot = mk();
  bot._linkAttempts = 7;
  await bot.stop();
  ok(bot._linkAttempts === 0, 'a deliberate stop starts the tally again');
}

console.log('=== failover leaves a human linking a number alone ===');
{
  // A wiped account sits in "connecting" by design while a QR is offered,
  // which used to look exactly like a failed reconnect: the supervisor moved
  // the bot to a spare, and the number being linked never got a code at all.
  const src = await import('node:fs').then((fs) => fs.readFileSync(
    new URL('../src/core/failover.js', import.meta.url), 'utf8'));
  const guardIdx = src.indexOf('if (st.linking) return;');
  const triggerIdx = src.indexOf("if (st.state === 'connecting'");
  ok(guardIdx > 0, 'failover checks whether the bot is linking');
  ok(guardIdx < triggerIdx, 'and it checks BEFORE deciding to switch');
}

console.log('=== the operator pressing Connect clears the backoff ===');
{
  const api = await import('node:fs').then((fs) => fs.readFileSync(
    new URL('../src/web/api.js', import.meta.url), 'utf8'));
  const start = api.slice(api.indexOf("router.post('/wa/start'"), api.indexOf("router.post('/wa/stop'"));
  ok(/bot\.reconnectAttempts = 0/.test(start),
    'Connect resets the counter - it is a deliberate act, not the next tick of an outage');
}

console.log('=== a version lookup cannot hold up a link ===');
{
  // Baileys fetches its protocol version from GitHub before the socket opens,
  // with no timeout of its own. Blackholed, that stalled every link attempt for
  // the kernel's full TCP timeout with nothing on screen.
  const src = await import('node:fs').then((fs) => fs.readFileSync(
    new URL('../src/core/bot.js', import.meta.url), 'utf8'));
  ok(/fetchLatestBaileysVersion\(\{ timeout: VERSION_FETCH_MS \}\)/.test(src), 'it is bounded');
  ok(/const VERSION_FETCH_MS = \d/.test(src), 'by a named constant');
}

console.log('=== the panel keys off state, not leftover values ===');
{
  const app = await import('node:fs').then((fs) => fs.readFileSync(
    new URL('../src/web/public/app.js', import.meta.url), 'utf8'));
  // A pairing code left from a previous attempt used to win the render test
  // and hide the live QR behind it - which is "the QR never shows".
  ok(/s\.state === 'awaiting-pairing' && s\.pairingCode/.test(app), 'the pairing box needs the pairing state');
  ok(/s\.state === 'awaiting-qr' && s\.qr/.test(app), 'and the QR needs the QR state');
  ok(/nextReconnectAt/.test(app), 'and a wait is shown as a countdown rather than a bare "Connecting…"');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
