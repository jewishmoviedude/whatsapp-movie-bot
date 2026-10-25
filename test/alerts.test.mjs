/* Event emails and their throttling. Run: node test/alerts.test.mjs

   The throttle exists because a failing loop can log thousands of errors a
   minute and the point of an alert is to tell you once. But throttling by a
   single clock has a nasty failure mode: being told "the bot is DOWN" gets
   suppressed because it also failed back twice an hour ago. So the quiet
   period is per KIND. */
import { AlertWatcher } from '../src/core/alerts.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

function watcher(email = {}) {
  // An account to send through: email switched on with none counts as off
  // since it is on by default (2026-10-12, emailReady in util/mailer.js).
  const cfg = { email: { enabled: true, to: 'a@b.c', user: 'bot@b.c', appPassword: 'app-pw', ...email } };
  const w = new AlertWatcher({
    configStore: { get: () => cfg },
    fileLogger: { today: () => 'LOG-CONTENTS' },
  });
  w.delivered = [];
  w._deliver = async (c, payload) => { w.delivered.push(payload); };   // never sends
  return w;
}

console.log('=== an event email carries the message and the log ===');
{
  const w = watcher();
  const r = await w.notify({ kind: 'failover', label: 'Bot switched number', note: 'because reasons' });
  ok(r.sent === true, 'it reports success');
  ok(w.delivered.length === 1, 'one message delivered');
  ok(w.delivered[0].label === 'Bot switched number', 'with the subject given');
  ok(w.delivered[0].note === 'because reasons', 'and the body');
  ok(w.delivered[0].logText === 'LOG-CONTENTS', 'the day\'s log is attached, as with the debug alerts');
}

console.log('=== the same kind is throttled ===');
{
  const w = watcher();
  await w.notify({ kind: 'failover', label: 'first', note: '', throttleMinutes: 15 });
  const second = await w.notify({ kind: 'failover', label: 'second', note: '', throttleMinutes: 15 });
  ok(second.sent === false && second.why === 'throttled', 'a repeat within the quiet period is held back');
  ok(w.delivered.length === 1, 'and nothing extra is sent');
}

console.log('=== but a DIFFERENT kind is never suppressed by it ===');
{
  const w = watcher();
  await w.notify({ kind: 'failback', label: 'went home', note: '', throttleMinutes: 60 });
  await w.notify({ kind: 'failback', label: 'went home again', note: '', throttleMinutes: 60 });
  const down = await w.notify({ kind: 'failover-stuck', label: 'BOT IS DOWN', note: '', throttleMinutes: 60 });
  ok(down.sent === true, 'the important one still gets through');
  ok(w.delivered.map((d) => d.label).includes('BOT IS DOWN'),
    'being told the bot is down is not lost behind routine notices');
  ok(w.delivered.length === 2, 'while the routine repeat was still suppressed');
}

console.log('=== the quiet period does expire ===');
{
  const w = watcher();
  await w.notify({ kind: 'k', label: 'one', note: '', throttleMinutes: 15 });
  w.lastByKind.set('k', Date.now() - 16 * 60_000);
  const again = await w.notify({ kind: 'k', label: 'two', note: '', throttleMinutes: 15 });
  ok(again.sent === true, 'after the quiet period the next one sends');
  ok(w.delivered.length === 2, 'both delivered');

  // zero means no throttling at all
  const w2 = watcher();
  await w2.notify({ kind: 'k', label: 'a', note: '', throttleMinutes: 0 });
  await w2.notify({ kind: 'k', label: 'b', note: '', throttleMinutes: 0 });
  ok(w2.delivered.length === 2, 'a zero quiet period sends every time');
}

console.log('=== email switched off sends nothing ===');
{
  const w = watcher({ enabled: false });
  const r = await w.notify({ kind: 'failover', label: 'x', note: '' });
  ok(r.sent === false && /off/.test(r.why), 'it says why rather than failing silently');
  ok(w.delivered.length === 0, 'and nothing is delivered');
}

console.log('=== a broken mailer never throws at the caller ===');
{
  const w = watcher();
  w._deliver = async () => { throw new Error('smtp refused'); };
  let threw = null;
  let r = null;
  try { r = await w.notify({ kind: 'failover', label: 'x', note: '' }); } catch (e) { threw = e; }
  ok(!threw, 'notify resolves rather than rejecting');
  ok(r.sent === false && /smtp refused/.test(r.why), 'and reports the reason');
}

console.log('=== a failed send does not burn the quiet period ===');
{
  // If a transient SMTP failure consumed the throttle slot, the next real
  // event would be silently swallowed for the whole quiet period.
  const w = watcher();
  w._deliver = async () => { throw new Error('temporary'); };
  await w.notify({ kind: 'failover', label: 'lost', note: '', throttleMinutes: 15 });

  w._deliver = async (c, p) => { w.delivered.push(p); };
  const next = await w.notify({ kind: 'failover', label: 'this one matters', note: '', throttleMinutes: 15 });
  ok(next.sent === true, 'the next attempt is allowed through');
  ok(w.delivered.some((d) => d.label === 'this one matters'), 'and actually delivered');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
