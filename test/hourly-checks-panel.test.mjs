/* The Logs tab's "Hourly checks" card. Run: node test/hourly-checks-panel.test.mjs

   The operator asked for the hourly check to "report back" on what it found
   and fixed. The email is one place; this card is the other, and the one
   that shows at a glance that the check is running at all - it runs from
   cron, where the bot cannot see it, so a card whose last run is hours old is
   the only sign that it stopped. Each run shows its time (24-hour, the
   operator's rule), what it found, what it fixed and pushed, how the restart
   went, and a link to the full report; the runs download as CSV, like every
   other part of the panel - through the "↓ CSV" button csv-export.js puts in
   the card's heading, which this card feeds with its runs. It had a
   "Download CSV" button of its own as well, and the two saved different
   files; test/csv-export.test.mjs checks the one button end to end.

   The card's own file, src/web/public/hourly-checks.js, is run against the
   real index.html in linkedom, with app.js's real helpers. The routes behind
   it are tested in hourly-checks.test.mjs, which needs no linkedom and so
   still runs on a production install. */
import fs from 'node:fs';
import { parseHTML } from 'linkedom';

// The card shows each run in the browser's own time zone, and the runs below
// are fixed instants in UTC, so the clock the checks expect is UTC's. The
// suite passed on bot-box2, whose clock was UTC, and failed on the same box
// moved to WSL (2026-09-29), which took Windows' zone, New York: 18:00 UTC
// was drawn as 14:00. Node reads TZ afresh, so this pins it for every
// formatting below, whatever zone the box is in.
process.env.TZ = 'UTC';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const card = fs.readFileSync(new URL('../src/web/public/hourly-checks.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');

// app.js's own helpers, lifted out and run, as clock-24h.test.mjs does.
const pick = (re) => app.match(re)?.[0] ?? '';
const helpers = [
  pick(/function esc\([\s\S]*?\n\}/), pick(/const CLOCK_24 = .*;/), pick(/const HM = .*;/),
  pick(/function fmtDateTime\([\s\S]*?\n\}/), pick(/function fmtClock\([\s\S]*?\n\}/),
].join('\n');

const AFTER = 'a'.repeat(40);
const T = (h, m = 0) => Date.parse(`2026-09-28T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:02Z`);
const RUNS = [
  {
    id: '20260928T180002Z', at: T(18), result: 'incidents', found: 2, notices: 1, headline: '1 failed request, 1 error in the log',
    summary: 'ffmpeg exit 228 is now retried; the Baileys rejection is caught.', claude: { outcome: 'finished' },
    commits: [{ sha: AFTER, subject: 'Treat ffmpeg exit 228 as retryable', url: `https://github.com/o/r/commit/${AFTER}` }], pushedTo: 'main',
    restart: { outcome: 'healthy', words: 'restarted, back and connected', detail: 'running aaaaaaa and connected' },
    reruns: ['Annie (1982) for Mia: queued'], userActions: ['Add "The Fantastic Four: First Steps" to the server'], emailed: true, hasReport: true,
  },
  { id: '20260928T170002Z', at: T(17), result: 'all-clear', found: 0, notices: 0, headline: 'all clear', restart: { outcome: 'not-needed', words: 'not needed' } },
  { id: '20260928T160002Z', at: T(16), result: 'all-clear', found: 0, notices: 0, headline: 'all clear', restart: { outcome: 'not-needed', words: 'not needed' } },
  {
    id: '20260928T150002Z', at: T(15), result: 'incidents', found: 1, headline: '1 health problem', summary: null,
    claude: { outcome: 'not-set-up', detail: 'no token' }, commits: [],
    restart: { outcome: 'needs-sudo', words: 'needed: no sudo to restart with', detail: 'no passwordless sudo' }, hasReport: true, emailed: false,
  },
];

function mount({ runs = RUNS, status = { lastRunAt: T(18), overdue: false, runsToday: 4, lastFoundAt: T(18), claudeReady: 'ready', sudoReady: true }, fail: failWith = null } = {}) {
  const win = parseHTML(html);
  const { document } = win;
  const $ = (id) => document.getElementById(id);
  const calls = [];
  // `fail` is a message every call fails with, or a function of the call
  // answering one (or nothing, to succeed).
  const api = async (method, url) => {
    calls.push(`${method} ${url}`);
    const why = typeof failWith === 'function' ? failWith(url, calls.length) : failWith;
    if (why) throw Object.assign(new Error(why), why === 'Signed out' ? { handled: true } : {});
    return { runs, status };
  };
  const window = { __hourlyChecks: null };
  // eslint-disable-next-line no-new-func
  new Function('document', 'window', '$', 'api', 'setInterval', `${helpers}\n${card}`)(document, window, $, api, () => 0);
  const click = async (el) => { el.dispatchEvent(new win.Event('click', { bubbles: true })); await new Promise((r) => setTimeout(r, 5)); };
  return { document, $, calls, hc: window.__hourlyChecks, exporters: window.panelCsvExporters ?? [], click, win };
}

console.log('=== the markup ===');
{
  const logsTab = html.slice(html.indexOf('id="tab-logs"'), html.indexOf('</section>', html.indexOf('id="tab-logs"')));
  ok(/id="card-hourly-checks"/.test(logsTab), 'the card is on the Logs tab');
  ok(/<h2>Hourly checks 🩺/.test(html), 'titled "Hourly checks 🩺"');
  ok(html.indexOf('<script src="/hourly-checks.js">') > html.indexOf('<script src="/app.js">'), 'its script loads after app.js, whose helpers it uses');
  const ids = new Set([...card.matchAll(/\$\('([\w-]+)'\)|getElementById\('([\w-]+)'\)/g)].map((m) => m[1] ?? m[2]));
  const missing = [...ids].filter((id) => !new RegExp(`id="${id}"`).test(html));
  ok(missing.length === 0, `every element it looks for is in index.html${missing.length ? ` - missing ${missing.join(', ')}` : ''}`);
  ok(/no research, no email, and no restart/.test(html), 'the card says an all-clear hour costs nothing');
  ok(!/toLocale(Time)?String|hour12/.test(card), 'times only through fmtDateTime and fmtClock - the 24-hour clock');
  const markup = html.slice(html.indexOf('id="card-hourly-checks"'), html.indexOf('</section>', html.indexOf('id="card-hourly-checks"')));
  ok(!/csv/i.test(markup.replace(/<p class="hint">[\s\S]*?<\/p>/g, '')), 'no CSV button of its own: the one csv-export.js puts in its heading is its only one');
  ok(!/new Blob|createObjectURL|download\s*=/.test(card), 'and it builds no file of its own');
}

console.log('=== loading, when the Logs tab is opened ===');
{
  const m = mount();
  ok(m.hc && m.calls.length === 0, 'nothing is fetched until it is looked at');
  await m.click(m.document.querySelector('.tab[data-tab="logs"]'));
  ok(m.calls[0] === 'GET /hourly-checks?limit=200', 'opening the Logs tab loads it');
  await m.click(m.document.querySelector('.tab[data-tab="settings"]'));
  ok(m.calls.length === 1, 'another tab does not');
  await m.click(m.$('btn-hc-refresh'));
  ok(m.calls.length === 2, 'Refresh reloads it');
}

console.log('=== what a run shows ===');
{
  const m = mount();
  await m.hc.load();
  const list = m.$('hc-list');
  const items = list.querySelectorAll('.item');
  ok(items.length === 3, `the two all-clear hours are one line between the two runs that found something (${items.length} lines)`);
  const first = items[0].textContent;
  ok(/18:00:02/.test(first) && !/PM|AM/.test(first), 'the time, on the 24-hour clock');
  ok(/1 failed request, 1 error in the log/.test(first) && /2 found/.test(first), 'what it found');
  ok(/ffmpeg exit 228 is now retried/.test(first), 'the model\'s summary');
  const link = items[0].querySelector(`a[href="https://github.com/o/r/commit/${AFTER}"]`);
  ok(link?.textContent === 'aaaaaaa' && /Pushed to main/.test(first), 'what it pushed, linked to the commit');
  ok(/restart: restarted, back and connected/.test(first), 'how the restart went');
  ok(items[0].querySelector('a[href="/api/hourly-checks/20260928T180002Z/report"]'), 'and a link to the full report');
  ok(/For you:.*Fantastic Four/.test(first) && /Re-run: Annie/.test(first), 'what the operator has to do, and what was re-run');
  ok(/16:00:02 to 17:00 — all clear, 2 runs/.test(items[1].textContent), `quiet hours: "${items[1].textContent.trim()}"`);
  ok(/restart: needed: no sudo/.test(items[2].textContent) && /research: not-set-up/.test(items[2].textContent), 'a run that could not restart or research says so');
  ok(/last run 18:00/.test(m.$('hc-pill').textContent) && /ok/.test(m.$('hc-pill').className), `the pill: "${m.$('hc-pill').textContent}"`);
  m.$('hc-all').setAttribute('checked', '');
  m.$('hc-all').checked = true;
  m.$('hc-all').dispatchEvent(new m.win.Event('change'));
  ok(m.$('hc-list').querySelectorAll('.item').length === 4, 'with "Show every all-clear hour" ticked, every hour has its line');
}

console.log('=== what an hour only noted ===');
{
  // The rating digest and the settings notes are never researched, so an
  // hour with nothing else is all clear - and folded away with the others,
  // "2 noted" and nothing more, until it kept its own line.
  const noted = { id: '20260928T190002Z', at: T(19), result: 'all-clear', found: 0, notices: 2, headline: 'all clear (2 noted)',
    noted: ['Rating policy at work: 2 requests refused - the owner\'s rules working, not a fault', 'No queue notifications group is set, so members see only reactions'],
    restart: { outcome: 'not-needed', words: 'not needed' } };
  const m = mount({ runs: [noted, ...RUNS] });
  await m.hc.load();
  const items = m.$('hc-list').querySelectorAll('.item');
  ok(items.length === 4 && /19:00:02 — all clear/.test(items[0].textContent), 'an all-clear hour that noted something keeps its own line');
  ok(/Noted: Rating policy at work: 2 requests refused.*No queue notifications group/.test(items[0].textContent), 'with what it noted');
  ok(/16:00:02 to 17:00 — all clear, 2 runs/.test(items[2].textContent), 'the hours that noted nothing are still one line');
  ok(!/Noted:/.test(items[1].textContent), 'a run that noted nothing by title shows no such line');
  const found = mount({ runs: [{ ...RUNS[0], noted: ['The disk is getting full: 8.0 GB free where the bot works'] }] });
  await found.hc.load();
  ok(/Noted: The disk is getting full/.test(found.$('hc-list').querySelector('.item').textContent), 'a run that found something lists what it noted as well');

  // The CSV was written before runs carried their titles, with only the
  // count: what the card lists under a run goes in the file too.
  const t = await m.exporters[0].run();
  const cell = (row, name) => t.rows[row][t.columns.indexOf(name)];
  ok(cell(0, 'Noted') === 2 && cell(0, 'What was noted') === `${noted.noted[0]}; ${noted.noted[1]}`,
    `the CSV has what it noted, by title, beside the count ("${cell(0, 'What was noted')}")`);
  ok(cell(1, 'What was noted') === '', 'and nothing for a run that noted nothing by title');
}

console.log('=== an alert, and a fix the check would not ship ===');
{
  // The research session has no credentials to push with and is told not
  // to; if main shows it did anyway, that is the first thing on the run.
  const alerted = {
    ...RUNS[0], id: '20260928T190002Z', at: T(19), commits: [],
    alerts: ['The research session pushed aaaaaaa to main by itself. Nothing was restarted into; review and revert it.'],
    refused: ['1 suite(s) fail with the fix that pass on main: queue.test.mjs'],
  };
  const m = mount({ runs: [alerted, ...RUNS] });
  await m.hc.load();
  const first = m.$('hc-list').querySelector('.item');
  ok(first.querySelector('.verdict.bad') && /pushed aaaaaaa to main by itself/.test(first.querySelector('.verdict.bad').textContent), 'the alert is shown on the run, in red');
  ok(/Not shipped: 1 suite\(s\) fail/.test(first.textContent), 'and a fix it refused, with why');
  ok(/alert/.test(m.$('hc-pill').textContent) && /bad/.test(m.$('hc-pill').className), `the pill says so too: "${m.$('hc-pill').textContent}"`);
  const t = await m.exporters[0].run();
  const alertCol = t.columns.indexOf('Alerts');
  const refusedCol = t.columns.indexOf('Not shipped');
  ok(/by itself/.test(t.rows[0][alertCol]) && /queue\.test\.mjs/.test(t.rows[0][refusedCol]), 'and both are in the CSV');
}

console.log('=== a check that is not running says so ===');
{
  const never = mount({ runs: [], status: { lastRunAt: null, overdue: true, runsToday: 0 } });
  await never.hc.load();
  ok(/not running yet/.test(never.$('hc-pill').textContent) && /install-hourly-debug\.sh/.test(never.$('hc-status').textContent), 'never ran: how to install it');
  const late = mount({ status: { lastRunAt: T(18), overdue: true, runsToday: 1 } });
  await late.hc.load();
  ok(/no run for 2 h\+/.test(late.$('hc-pill').textContent) && /bad/.test(late.$('hc-pill').className), 'nothing for two hours: flagged, since cron may have stopped');
  const broken = mount({ fail: 'Signed out' });
  await broken.hc.load();
  ok(/Signed out/.test(broken.$('hc-list').textContent), 'a failed load says why, instead of an empty list');
}

console.log('=== CSV: the runs, for the button in the card\'s heading ===');
{
  const runs = [
    ...RUNS,
    { id: '20260928T140002Z', at: T(14), finishedAt: T(14, 9), result: 'incidents', found: 1, headline: 'a "quoted", comma', summary: '=HYPERLINK("x")\nsecond line', restart: { outcome: 'healthy', words: 'restarted, back and connected' }, commits: [], hasReport: false },
  ];
  const m = mount({ runs });
  ok(m.exporters.length === 1 && m.exporters[0].sel === '#hc-list' && m.exporters[0].slug === 'hourly-checks',
    'the card registers one exporter for the shared button, named hourly-checks');
  ok(m.document.querySelector('#card-hourly-checks #hc-list'), 'found by #hc-list, which only this card has');
  const t = await m.exporters[0].run();
  ok(m.calls.at(-1) === 'GET /hourly-checks?limit=500', `every run the server keeps, asked for afresh (${m.calls.at(-1)})`);
  ok(t.columns.join(',') === 'Time,Finished,Result,Found,Noted,What was noted,Headline,Summary,Research,Research detail,Commits,Pushed to,Not shipped,Alerts,Restart,Restart detail,Re-runs,For you to do,Emailed,Report',
    'proper column names');
  ok(t.rows.length === 5 && t.rows.every((r) => r.length === t.columns.length), 'one row per run, the all-clear hours as well, every row full width');
  const col = (name) => t.columns.indexOf(name);
  const first = t.rows[0];
  ok(first[col('Time')] instanceof Date && first[col('Time')].getTime() === T(18),
    'the time is a Date, which the shared serializer writes YYYY-MM-DD HH:mm - not the locale\'s own format');
  ok(t.rows[4][col('Finished')] instanceof Date && first[col('Finished')] === '', 'and when it finished, where the run says');
  ok(first[col('Commits')] === 'aaaaaaa Treat ffmpeg exit 228 as retryable' && first[col('Report')] === '/api/hourly-checks/20260928T180002Z/report',
    'the commits, and the report\'s address');
  ok(first[col('Restart')] === 'restarted, back and connected' && first[col('Emailed')] === 'yes' && t.rows[3][col('Emailed')] === 'failed' && t.rows[1][col('Emailed')] === 'no',
    'how the restart went, and whether the email went');
  ok(t.rows[4][col('Summary')] === '=HYPERLINK("x")\nsecond line', 'text as it is: quoting and the formula guard are the serializer\'s, one place for every card');
  ok(t.note === '', 'and no note when the server answered');

  // The server cannot be read now, after the card loaded: what it has.
  const f = mount({ runs, fail: (url) => (url.includes('limit=500') ? 'data/hourly-debug is unreadable' : null) });
  await f.hc.load();
  const fb = await f.exporters[0].run();
  ok(fb.rows.length === 5 && /the runs the card had loaded - the server said: data\/hourly-debug is unreadable/.test(fb.note),
    `the runs the card had loaded, with a note ("${fb.note}")`);
  const none = mount({ fail: 'down' });
  let threw = null;
  try { await none.exporters[0].run(); } catch (err) { threw = err; }
  ok(threw?.message === 'down', 'with none loaded, the error goes to the shared button, which reads the card instead');
  const out = mount({ fail: (url, n) => (n > 1 ? 'Signed out' : null) });
  await out.hc.load();
  threw = null;
  try { await out.exporters[0].run(); } catch (err) { threw = err; }
  ok(threw?.handled === true, 'a lapsed session is not papered over with the loaded runs');
  const empty = mount({ runs: [] });
  ok((await empty.exporters[0].run()).rows.length === 0, 'no runs, no rows - the shared button says there is nothing to export');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
