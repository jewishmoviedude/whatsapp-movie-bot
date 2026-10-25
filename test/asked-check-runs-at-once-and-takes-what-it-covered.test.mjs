/* The check, asked for at once, runs only when the request is due, and every
   run takes the asks its scan covered - no more.
   Run: node test/asked-check-runs-at-once-and-takes-what-it-covered.test.mjs

   The operator, 2026-10-12: "Needless to say #issue tickets submitted by
   head admin 5558100180 get top priority" and "Meaning it should activate bot
   to send yo a notification to check right away". The bot writes
   data/check-now.json for a library keeper's #issue (check-now.js); cron's
   tick runs `tools/hourly-debug.mjs run --asked` every minute while it is
   there. What must hold:
   - with no request, or one not yet due, or another run going, such a run
     does nothing at all: no question to the bot, no row, no memory, no line;
   - a run takes the asks whose rows its scan read (the scan reads news up to
     its start): one written after that stays for the next tick, so none is
     ever lost;
   - and it reads a waiting ask's row however old: a keeper's #issue that
     reached the bot more than a day late was taken by a run that never read
     it, and dropped without a word (found in review, 2026-10-12);
   - only an ask the check itself finds behind a keeper's #issue row starts a
     run: a file of anything else - which the research session could once
     make the check write - is dropped with one line, and no run (the same
     review), so nothing can start a run every minute for ever;
   - the dossier and the panel's row say whose #issue it ran for, masked like
     everything else, the row's headline starting "asked: Head Admin's
     #issue"; the email's subject is the same as every hour's;
   - an hourly run takes what it covered too, and a dry run takes nothing. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { settings, hourlyRun } from '../tools/hourly-debug.mjs';
import { readRuns, readReport, readMemory } from '../src/core/hourly-checks.js';
import { askForCheck, checkNowFile, readCheckNow } from '../src/core/check-now.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'asked-check-'));
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

const DISCUSSIONS = '120363900000000002@g.us';
const HEAD = '15558100180';
const MIN = 60_000;
const T0 = Date.parse('2026-10-12T14:23:00Z');
const SUBJECT = /^WhatsApp Bot — hourly check \d\d-\d\d-\d{4}, \d\d:\d\d E[DS]T$/;

/** A box: the bot's data, a checkout with .env, no Claude token (no research), stubs for everything outside. */
function box() {
  const dir = fs.mkdtempSync(path.join(ROOT, 'box-'));
  const app = path.join(dir, 'app'), data = path.join(app, 'data');
  fs.mkdirSync(path.join(data, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(app, '.env'), 'MASTER_KEY=test-master-key-0123456789\n');
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
    movieRequests: { requestGroups: [], requirePrefix: true, prefix: '#request' },
    tvRequests: { enabled: true, requestGroups: [] },
    web: { sessionSecret: 's' }, media: { workDir: path.join(dir, 'media') },
    email: { enabled: true, provider: 'gmail', user: 'owner@example.com', appPassword: 'app-password-xyz' },
    libraryNews: { senders: [HEAD], groups: [DISCUSSIONS] },
  }));
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ 'movie-requests': { history: [] }, 'tv-requests': { history: [] } }));
  const s = settings({ HOME: dir, HOURLY_DEBUG_APP_DIR: app, HOURLY_DEBUG_STATE_DIR: path.join(dir, 'state'), HOURLY_DEBUG_CLAUDE_BIN: path.join(dir, 'no-claude') });
  const w = { asked: [], mails: [], out: [] };
  const deps = (now, extra = {}) => ({
    now: () => now,
    out: (l) => w.out.push(String(l)),
    exec: async (cmd, args = []) => ({ code: cmd === 'sudo' ? 1 : 0, stdout: '', stderr: '' }),
    gitExec: async () => ({ code: 0, stdout: '' }),
    ask: async (_d, c) => { w.asked.push(c.op); return null; },
    mail: async (cfg, m) => { w.mails.push(m); },
    ...extra,
  });
  return { dir, app, data, s, w, deps };
}

const row = (id, at, text) => ({ kind: 'issue', keeper: true, at, id, group: DISCUSSIONS, groupName: '06 MOVIE DISCUSSIONS', sender: HEAD, name: 'Head Admin', text });
const news = (data, rows) => fs.appendFileSync(path.join(data, 'library-news.jsonl'), rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
const quiet = (b, r) => r.skipped && r.quiet && b.w.out.length === 0 && b.w.asked.length === 0
  && !fs.existsSync(path.join(b.data, 'hourly-debug', 'runs.json')) && readMemory(b.data) == null;

console.log('=== asked, with nothing to do: nothing at all ===');
{
  const b = box();
  const r = await hourlyRun(b.s, { asked: true, ...b.deps(T0) });
  ok(quiet(b, r), 'no request: no question to the bot, no row, no memory, no line');

  const m = row('W1', T0 - MIN, '#issue the encode on X2 is green');
  news(b.data, [m]);
  askForCheck(b.data, m, { now: T0 - MIN });
  const before = fs.readFileSync(checkNowFile(b.data), 'utf8');
  const r2 = await hourlyRun(b.s, { asked: true, ...b.deps(T0) });
  ok(quiet(b, r2) && fs.readFileSync(checkNowFile(b.data), 'utf8') === before,
    'a request not yet due (a ticket may still be being written): the same, and the request is left as it was');

  fs.mkdirSync(path.join(b.data, 'hourly-debug'), { recursive: true });
  fs.writeFileSync(path.join(b.data, 'hourly-debug', '.lock'), String(process.ppid));
  const r3 = await hourlyRun(b.s, { asked: true, ...b.deps(T0 + 5 * MIN) });
  ok(r3.skipped && r3.quiet && b.w.out.length === 0 && b.w.asked.length === 0 && fs.existsSync(checkNowFile(b.data)),
    'due, but another run holds the lock: nothing, and the request stays for a later minute');
}

console.log('=== asked and due: a run, for her #issue, taking only what it covered ===');
{
  const b = box();
  // M1 and M5: read by the scan. M2: sent after the run began. M3: its row
  // reached the news file after the scan had read it - the bot wrote row
  // and ask while the run was asking about sudo. M4: no row stands behind
  // it, so it is no keeper's #issue the bot recorded.
  const m1 = row('M1', T0 - 12 * MIN, '#issue #group01 the encode on X2 is green from the first minute');
  const m5 = row('M5', T0 - 9 * MIN, '#issue and the one on X3 too');
  const m2 = row('M2', T0 + 30_000, '#issue and Loki s2e3 has no sound');
  const m3 = row('M3', T0 - MIN, '#issue also the subtitles on Dune');
  const m4 = row('M4', T0 - 30 * MIN, '#issue Frieren e12 is missing');
  news(b.data, [m1, m5, m2]);
  askForCheck(b.data, m4, { now: m4.at });
  askForCheck(b.data, m1, { now: m1.at });
  askForCheck(b.data, m5, { now: m5.at });
  askForCheck(b.data, m2, { now: m2.at });
  const midRun = async (cmd, args = []) => {
    if (cmd === 'sudo') { news(b.data, [m3]); askForCheck(b.data, m3, { now: T0 + 5000 }); }
    return { code: cmd === 'sudo' ? 1 : 0, stdout: '', stderr: '' };
  };
  const r = await hourlyRun(b.s, { asked: true, ...b.deps(T0, { exec: midRun }) });
  const left = readCheckNow(b.data);
  ok(!r.skipped && r.row?.result === 'incidents', 'it runs');
  ok(left?.asked.map((a) => a.id).sort().join() === 'M2,M3',
    `it takes the asks its scan covered, and leaves the rest for the next tick (left: ${left?.asked.map((a) => a.id)})`);
  ok(b.w.out.some((l) => /dropped 1 request\(s\) for a check at once naming no library keeper's #issue in library-news\.jsonl - no run for it/.test(l)),
    'the ask no row stands behind is dropped, and said so');
  const runs = readRuns(b.data);
  const rowSaid = runs[0];
  ok(rowSaid.trigger === 'asked' && rowSaid.asked?.length === 2 && rowSaid.asked.every((a) => a.who === 'Head Admin'),
    'the panel\'s row says it was asked for, and by whom');
  ok(/^asked: Head Admin's 2 #issues - 2 issues members reported/.test(rowSaid.headline), `its headline starts with her #issue: "${rowSaid.headline}"`);
  const dossier = JSON.parse(fs.readFileSync(path.join(b.data, 'hourly-debug', 'runs', r.id, 'dossier.json'), 'utf8'));
  ok(dossier.trigger === 'asked' && dossier.asked.map((a) => a.text).join('|').includes('the encode on X2 is green')
    && dossier.asked.every((a) => a.who === 'Head Admin' && a.group === '06 MOVIE DISCUSSIONS' && /^2026-10-12T\d\d:\d\d/.test(a.at)),
  'the dossier carries `trigger` and `asked`: who, when, where and what');
  ok(dossier.incidents[0]?.priority === true && /^TOP PRIORITY: Head Admin/.test(dossier.incidents[0].title), 'and her #issue is I1, TOP PRIORITY');
  const all = JSON.stringify(dossier) + JSON.stringify(runs) + readReport(b.data, r.id);
  ok(!all.includes(HEAD), 'her full number is nowhere in the dossier, the row or the report');
  ok(/Started at once, outside the hour, for Head Admin's 2 #issues, written 10-12-2026, 10:11 EDT; 10-12-2026, 10:14 EDT - top priority/.test(readReport(b.data, r.id)),
    'the report says the run was started for her, and when she wrote');
  ok(b.w.mails.length === 1 && SUBJECT.test(b.w.mails[0].subject), `the email's subject is the hour's, unchanged: "${b.w.mails[0]?.subject}"`);
  ok(b.w.out.some((l) => /asked for at once - Head Admin's 2 #issues/.test(l)), 'cron.log gets a line when it does run');

  // The next tick: M2 and M3 are due, and their rows are there now.
  b.w.out.length = 0;
  const r2 = await hourlyRun(b.s, { asked: true, ...b.deps(T0 + 3 * MIN) });
  ok(!r2.skipped && !fs.existsSync(checkNowFile(b.data)), 'the next tick takes the rest, and the request is gone');
  b.w.out.length = 0;
  b.w.asked.length = 0;
  const r3 = await hourlyRun(b.s, { asked: true, ...b.deps(T0 + 4 * MIN) });
  ok(r3.skipped && r3.quiet && b.w.out.length === 0 && b.w.asked.length === 0, 'and the one after does nothing again');
}

console.log('=== her #issue reached the bot more than a day late: read, reported first, then taken ===');
{
  // The phone (or the bot) was offline for a day: WhatsApp delivers her
  // #issue on reconnect with its own time, 25 hours ago, and the bot asks a
  // minute before the run. A run reads a day of news; it once took this ask
  // without reading its row, so her ticket was all clear and gone.
  const late = row('L1', T0 - 25 * 60 * MIN, '#issue Dune has no sound');
  const older = row('L0', T0 - 30 * 60 * MIN, '#issue an old one, never asked for');
  const chat = { ...row('C0', T0 - 26 * 60 * MIN, 'an old chat line'), kind: 'chat', keeper: undefined, sender: '15550001111', name: 'Someone' };
  for (const firstRun of [false, true]) {
    const b = box();
    // A box the check has run on before, as the live one: the hour's run,
    // before the late rows arrived.
    if (!firstRun) await hourlyRun(b.s, b.deps(T0 - 2 * 60 * MIN));
    news(b.data, [older, late, chat]);
    askForCheck(b.data, late, { now: T0 - MIN });
    const r = await hourlyRun(b.s, { asked: true, ...b.deps(T0) });
    const first = r.result?.incidents?.[0];
    const on = firstRun ? 'on the check\'s first run on a box' : 'on a box it has run on before';
    ok(!r.skipped && first?.priority === true && /^TOP PRIORITY: Head Admin.*Dune has no sound/.test(first.title),
      `${on}: it runs, and her late #issue is I1, TOP PRIORITY (${first?.title})`);
    ok(!fs.existsSync(checkNowFile(b.data)) && readRuns(b.data)[0].asked?.length === 1, `${on}: and only then is the ask taken`);
    ok(!r.result.incidents.some((f) => /an old one/.test(f.title)) && !JSON.stringify(r.result.notices).includes('old chat line'),
      `${on}: the news is read further back only for the waiting ask's own row - not an older #issue, not old chat`);
  }
}

console.log('=== a request file the bot did not write starts no run ===');
{
  const b = box();
  const quietButSaid = (r, re) => r.skipped && r.quiet && b.w.asked.length === 0 && !fs.existsSync(path.join(b.data, 'hourly-debug', 'runs.json'))
    && b.w.out.length === 1 && re.test(b.w.out[0]);
  // What the research session once had the check write there through a
  // link: its own report.
  fs.writeFileSync(checkNowFile(b.data), '# Hourly check\n\nwhatever the session wrote\n');
  const r1 = await hourlyRun(b.s, { asked: true, ...b.deps(T0) });
  ok(quietButSaid(r1, /check-now\.json did not parse - removed, no run/) && !fs.existsSync(checkNowFile(b.data)),
    `a file that does not parse: removed, one line, no run, no question to the bot (${b.w.out[0]})`);

  b.w.out.length = 0;
  fs.writeFileSync(checkNowFile(b.data), '{"v":1,"asked":[]}\n');
  const r2 = await hourlyRun(b.s, { asked: true, ...b.deps(T0) });
  ok(quietButSaid(r2, /held no ask - removed, no run/) && !fs.existsSync(checkNowFile(b.data)), 'a file with no ask: the same');

  // Asks that look like the bot's, but no keeper's #issue stands behind
  // them: another member's #issue, a row that is not there, a time that is
  // not the row's - and one dated far ahead, which must not wait there for
  // ever, starting node every minute.
  const stranger = { ...row('S1', T0 - 20 * MIN, '#issue a stranger\'s'), keeper: undefined, sender: '15550002222', name: 'Stranger' };
  const mom = row('K1', T0 - 20 * MIN, '#issue a real one of hers');
  news(b.data, [stranger, mom]);
  for (const a of [stranger, row('N1', T0 - 20 * MIN, '#issue no such row'), { ...mom, at: mom.at - MIN }, row('F1', T0 + 400 * 24 * 60 * MIN, '#issue far ahead')]) {
    askForCheck(b.data, a, { now: T0 - 20 * MIN });
  }
  b.w.out.length = 0;
  const r3 = await hourlyRun(b.s, { asked: true, ...b.deps(T0) });
  ok(quietButSaid(r3, /dropped 4 request\(s\) for a check at once naming no library keeper's #issue/) && !fs.existsSync(checkNowFile(b.data)),
    `asks no keeper's #issue stands behind: all four dropped, one line, no run (${b.w.out[0]})`);

  // One of hers among them: a run, for hers alone.
  askForCheck(b.data, row('N2', T0 - 20 * MIN, '#issue no such row either'), { now: T0 - 20 * MIN });
  askForCheck(b.data, mom, { now: T0 - 20 * MIN });
  b.w.out.length = 0;
  const r4 = await hourlyRun(b.s, { asked: true, ...b.deps(T0) });
  ok(!r4.skipped && readRuns(b.data)[0].asked?.length === 1 && /a real one of hers/.test(readRuns(b.data)[0].asked[0].text),
    'with one of hers there as well, the others are dropped and the run is for hers');
}

console.log('=== asked for an #issue already researched: all clear, and said so ===');
{
  const b = box();
  const m = row('A1', T0 - 20 * MIN, '#issue the encode on X2 is green');
  news(b.data, [m]);
  await hourlyRun(b.s, b.deps(T0 - 15 * MIN));
  askForCheck(b.data, m, { now: T0 - 10 * MIN });
  const r = await hourlyRun(b.s, { asked: true, ...b.deps(T0) });
  const last = readRuns(b.data)[0];
  ok(r.allClear && last.trigger === 'asked' && /^asked: Head Admin's #issue - all clear/.test(last.headline) && last.asked?.[0]?.who === 'Head Admin',
    `an all-clear row, saying whose #issue it ran for: "${last.headline}"`);
  ok(!fs.existsSync(checkNowFile(b.data)), 'and the request is taken');
}

console.log('=== on the hour: it takes what it covered too ===');
{
  const b = box();
  const m = row('H1', T0 - 40_000, '#issue the encode on X2 is green');
  news(b.data, [m]);
  askForCheck(b.data, m, { now: T0 - 40_000 });
  const r = await hourlyRun(b.s, b.deps(T0));
  const last = readRuns(b.data)[0];
  ok(!fs.existsSync(checkNowFile(b.data)) && last.trigger === 'hourly' && last.asked?.length === 1,
    'the hour\'s run takes the ask it covered, though not yet due, so no second run follows for it');
  ok(/^asked: Head Admin's #issue - /.test(last.headline) && r.result.incidents[0]?.priority, `and says so: "${last.headline}"`);
}

console.log('=== a dry run takes nothing ===');
{
  const b = box();
  const m = row('D1', T0 - 5 * MIN, '#issue the encode on X2 is green');
  news(b.data, [m]);
  askForCheck(b.data, m, { now: T0 - 5 * MIN });
  const before = fs.readFileSync(checkNowFile(b.data), 'utf8');
  const r = await hourlyRun(b.s, { dryRun: true, ...b.deps(T0) });
  ok(r.dryRun && fs.readFileSync(checkNowFile(b.data), 'utf8') === before, 'the request is left as it was');
  ok(b.w.out.join('\n').includes('take the request for a check at once, the asks this scan covered: Head Admin\'s #issue'),
    'and the dry run says a run would take it');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
