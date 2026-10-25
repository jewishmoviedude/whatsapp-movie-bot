/* The daily summary email. Run: node test/daily-digest.test.mjs

   dailySummary and dailySummaryHour have been settings since the start with
   no code behind them, so the switch did nothing at all. The reason to send
   it is the wanted list: films that resolved to a real title the server does
   not have. That is the only thing in a day's activity an admin can act on,
   and it used to end at a reaction emoji. */
import fs from 'node:fs';
import { DailyDigest, isDue, dayKey, buildDigest } from '../src/core/daily-digest.js';
import { recordWanted, listWanted, clearWanted, formatWanted } from '../src/core/wanted.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const at = (h, m = 0, day = 21) => new Date(2026, 7, day, h, m, 0).getTime();
// An account to send through. Email and the summary are on by default since
// 2026-10-12, and with no account the summary is never due (emailReady).
const ACCOUNT = { user: 'bot@b.c', appPassword: 'app-pw' };

console.log('=== when it is due ===');
{
  const cfg = { enabled: true, hour: 8 };
  ok(!isDue(cfg, { now: at(7, 59) }), 'not before the hour');
  ok(isDue(cfg, { now: at(8, 0) }), 'due on the hour');
  ok(isDue(cfg, { now: at(14, 0) }), 'still due later the same day if it has not gone');
  ok(!isDue(cfg, { now: at(9), lastSent: dayKey(at(9)) }), 'not twice in one day');
  ok(isDue(cfg, { now: at(9, 0, 22), lastSent: dayKey(at(9, 0, 21)) }), 'due again the next day');
  ok(!isDue({ enabled: false, hour: 8 }, { now: at(12) }), 'never when switched off');
}

console.log('=== a bot that was down at 8am still sends when it wakes ===');
{
  // Firing only in the exact minute would lose the whole day across a restart.
  const cfg = { enabled: true, hour: 8 };
  ok(isDue(cfg, { now: at(11, 37) }), 'a late first check still sends');
}

console.log('=== the digest leads with what an admin can act on ===');
{
  const store = { data: {}, get(k, d) { return this.data[k] ?? d; }, set(k, v) { this.data[k] = v; } };
  recordWanted(store, { title: 'Wicked', year: 2024, imdbId: 'tt1262426' }, { requester: 'Sara' });
  recordWanted(store, { title: 'Wicked', year: 2024, imdbId: 'tt1262426' }, { requester: 'Dan' });
  recordWanted(store, { title: 'Moana 2', year: 2024 }, { requester: 'Sara', reason: 'not-yet-theatrical' });

  const body = buildDigest({
    wanted: listWanted(store),
    history: [
      { at: Date.now(), status: 'sent' }, { at: Date.now(), status: 'sent' },
      { at: Date.now(), status: 'blocked' },
      { at: Date.now() - 5 * 86400000, status: 'sent' },   // last week - excluded
    ],
    queue: { active: 1, waiting: 4 },
  });

  ok(/Requests handled : 3/.test(body), 'only the last 24 hours are counted');
  ok(/Delivered {8}: 2/.test(body), 'delivered counted');
  ok(/Waiting now {6}: 4/.test(body), 'and the queue as it stands');
  ok(/WANTED/.test(body), 'the wanted list is a section of its own');
  ok(/2x {2}Wicked \(2024\)/.test(body), 'with a request count, so demand is visible at a glance');
  ok(body.indexOf('Wicked') < body.indexOf('Moana 2'), 'most-asked first');
  ok(/still in cinemas/.test(body), 'and cinema-only titles kept apart — nobody can add those yet');
}

console.log('=== an empty wanted list reads as good news ===');
{
  const body = buildDigest({ wanted: [], history: [] });
  ok(/does not already have/.test(body), `it says so plainly: "${formatWanted([])}"`);
}

console.log('=== a failed send is retried, not skipped ===');
{
  // Marking the day done on a failure would silently lose it until tomorrow.
  const sent = [];
  const state = (() => {
    const sp = {};
    return { namespace(n) { sp[n] ??= {}; const d = sp[n];
      return { get: (k, v) => d[k] ?? v, set: (k, v) => { d[k] = v; }, push() {} }; } };
  })();
  let ok1 = false;
  const alerts = { notify: async (m) => { sent.push(m); return { sent: ok1, why: 'smtp down' }; } };
  const d = new DailyDigest({
    configStore: { get: () => ({ email: { enabled: true, dailySummary: true, dailySummaryHour: 8, ...ACCOUNT } }) },
    stateStore: state, alerts,
  });

  const first = await d.tick(at(9));
  ok(first === false, 'the send failed');
  ok(state.namespace('digest').get('lastSent', null) === null, 'so the day is NOT marked done');

  ok1 = true;
  // Not on the very next check, though: an account that cannot send was
  // logged into every minute of the day (live-settings-defaults).
  ok(await d.tick(at(9, 5)) === false && sent.length === 1, 'five minutes on it waits (DIGEST_RETRY_MS)');
  const second = await d.tick(at(9, 30));
  ok(second === true, 'half an hour on it retries and succeeds');
  ok(state.namespace('digest').get('lastSent') === dayKey(at(9, 30)), 'and only then is the day marked');

  const third = await d.tick(at(10));
  ok(third === false, 'and it does not send again that day');
  ok(sent.length === 2, `exactly two attempts were made (${sent.length})`);
}

console.log('=== it is not gated by the error-alert quiet period ===');
{
  const sent = [];
  const state = (() => { const sp = {}; return { namespace(n) { sp[n] ??= {}; const d = sp[n];
    return { get: (k, v) => d[k] ?? v, set: (k, v) => { d[k] = v; }, push() {} }; } }; })();
  const alerts = { notify: async (m) => { sent.push(m); return { sent: true }; } };
  const d = new DailyDigest({
    configStore: { get: () => ({ email: { enabled: true, dailySummary: true, dailySummaryHour: 8, ...ACCOUNT } }) },
    stateStore: state, alerts,
  });
  await d.tick(at(9));
  ok(sent[0].throttleMinutes === 0,
    'a once-a-day email needs no second gate — a busy error hour must not eat it');
  ok(sent[0].kind === 'daily-digest', 'and it has its own kind');
}

console.log('=== the wanted list stops asking once the film arrives ===');
{
  const store = { data: {}, get(k, d) { return this.data[k] ?? d; }, set(k, v) { this.data[k] = v; } };
  recordWanted(store, { title: 'Paddington', year: 2014, imdbId: 'tt1109624' }, { requester: 'A' });
  ok(listWanted(store).length === 1, 'it is on the list');
  ok(clearWanted(store, { title: 'Paddington', year: 2014, imdbId: 'tt1109624' }) === 1, 'and removable');
  ok(listWanted(store).length === 0, 'so the email stops asking for something already there');
}

console.log('=== bookkeeping never breaks a request ===');
{
  const broken = { get() { throw new Error('disk gone'); }, set() {} };
  ok(recordWanted(broken, { title: 'X' }) === false, 'a failed write is reported, not thrown');
  ok(clearWanted(broken, { title: 'X' }) === 0, 'and neither is a failed clear');
}

console.log('=== the switch is wired to something now ===');
{
  const index = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  ok(/new DailyDigest\(/.test(index) && /digest\.start\(\)/.test(index), 'the digest is started at boot');

  const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  ok(/dailySummary: \$\('f-em-daily'\)\.checked/.test(app), 'the checkbox saves');
  ok(/\$\('f-em-daily'\)\.checked = !!em\.dailySummary/.test(app), 'and loads — a save-only field would silently switch it off');
  ok(/dailySummaryHour: \+\$\('f-em-dailyhour'\)\.value/.test(app), 'the hour saves too');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
