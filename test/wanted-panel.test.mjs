/* The History tab's Wanted card: Mark resolved, Reopen, and notes.
   Run: node test/wanted-panel.test.mjs

   Needs the dev dependencies (linkedom, a devDependency, stubs the DOM), so
   on a production install - `npm install --omit=dev` - it fails with the
   other panel suites; test/wanted-panel-static.test.mjs checks the same card
   without a DOM and runs everywhere.

   The operator, 2026-10-11, looking at the Wanted list: "give me a mark as
   resolved so other admins and you know as well as a box to add notes for
   you to review on the hour". The card's own file, src/web/public/wanted.js,
   is run here against the real index.html with app.js's real helpers:
   - open films are listed with Mark resolved and a notes box with Save;
     resolved ones under a "Resolved" section, newest first, saying who
     resolved each and when, on the 24-hour clock, with Reopen;
   - each note shows its author and time; Delete only on the admin's own
     notes, on every note for the super-admin;
   - each button calls its route with the key URL-encoded, then reloads;
   - a push from the server (another admin's change) reloads the card, and
     a note being typed survives it;
   - Refresh asks the server to recheck the library first, then reloads. */
import fs from 'node:fs';
import { parseHTML } from 'linkedom';

// Times below are fixed instants in UTC; pinned, so the 24-hour clock the
// checks expect is UTC's on any box (hourly-checks-panel.test.mjs, 2026-09-29).
process.env.TZ = 'UTC';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const card = fs.readFileSync(new URL('../src/web/public/wanted.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');

// app.js's own helpers, lifted out and run, as clock-24h.test.mjs does.
const pick = (re) => app.match(re)?.[0] ?? '';
const helpers = [
  pick(/function esc\([\s\S]*?\n\}/), pick(/const CLOCK_24 = .*;/), pick(/const HM = .*;/),
  pick(/function fmtDateTime\([\s\S]*?\n\}/), pick(/function fmtClock\([\s\S]*?\n\}/),
  pick(/const PHONE_SHAPED = .*;/), pick(/const PHONE_JID = .*;/), pick(/function phoneOut\([\s\S]*?\n\}/),
].join('\n');

const T = (h, m = 0) => Date.parse(`2026-10-11T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
const LIST = () => ({
  wanted: [
    {
      key: 'tt1262426', title: 'Wicked', year: 2024, imdbId: 'tt1262426', reason: 'not-in-library', count: 3, requesters: ['+15551230001', 'Sara'],
      notes: [
        { id: 'n1', by: 'bob', at: T(13, 5), text: 'Ordered the Blu-ray' },
        { id: 'n2', by: 'alice', at: T(14, 30), text: 'Head Admin says next week' },
      ],
    },
    { key: 'barefoot|2014', title: 'Barefoot', year: 2014, imdbId: null, reason: 'not-in-library', count: 1, requesters: ['Avi'] },
  ],
  resolved: [
    { key: 'tt0087182', title: 'Dune', year: 1984, imdbId: 'tt0087182', count: 2, requesters: ['Mia'], resolved: { by: 'mommy', at: T(16, 45) } },
    { key: 'tt0290334', title: 'X2: X-Men United', year: 2003, imdbId: 'tt0290334', count: 2, requesters: ['Mia'],
      resolved: { by: 'the bot (found on the server as "X2")', at: T(9, 2), auto: true } },
  ],
});

function mount({ user = { username: 'bob', role: 'admin' }, list = LIST, failWith = null, confirmed = true } = {}) {
  const win = parseHTML(html);
  const { document } = win;
  const $ = (id) => document.getElementById(id);
  const calls = [];
  const toasts = [];
  // Timers the test runs by hand, clearTimeout honoured: the card's push
  // reload is debounced with them.
  const timers = new Map();
  let seq = 0;
  const api = async (method, url, body) => {
    calls.push({ method, url, body });
    const why = typeof failWith === 'function' ? failWith(method, url) : null;
    if (why) throw Object.assign(new Error(why.message), { status: why.status });
    if (method === 'GET' && url === '/wanted') return list();
    if (url === '/wanted/recheck') return { ok: true, found: [{ title: 'Wicked' }], notFilms: [], checked: 2 };
    if (/\/rerun$/.test(url)) return { ok: true, run: [{ requester: 'Mia', number: '+15550000001' }], skipped: [{ requester: 'Ethan', why: 'had it queued or sent since' }] };
    return { ok: true };
  };
  const window = {};
  // eslint-disable-next-line no-new-func
  new Function('document', 'window', '$', 'api', 'toast', 'confirm', 'setTimeout', 'clearTimeout', 'CURRENT_USER', `${helpers}\n${card}`)(
    document, window, $, api, (m, bad) => toasts.push(`${bad ? 'BAD ' : ''}${m}`), () => confirmed,
    (fn) => { timers.set(++seq, fn); return seq; }, (id) => { timers.delete(id); }, user,
  );
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const click = async (el) => { el.dispatchEvent(new win.Event('click', { bubbles: true })); await tick(); await tick(); };
  const entry = (key) => [...document.querySelectorAll('.wanted-entry')].find((e) => e.getAttribute('data-key') === key);
  const runTimers = async () => {
    for (const [id, fn] of [...timers]) { timers.delete(id); fn(); }
    await tick(); await tick();
  };
  return { document, $, calls, toasts, w: window.__wanted, click, entry, runTimers, win, tick };
}

console.log('=== the markup ===');
{
  const historyTab = html.slice(html.indexOf('id="tab-history"'), html.indexOf('</section>', html.indexOf('id="tab-history"')));
  ok(/id="card-wanted"/.test(historyTab) && /id="wanted-list"/.test(historyTab), 'the card is on the History tab');
  ok(/<details id="wanted-resolved-box"[^>]*class="[^"]*hidden/.test(html), 'its Resolved section is collapsed, and hidden until there is one');
  ok(html.indexOf('<script src="/wanted.js">') > html.indexOf('<script src="/app.js">'), 'its script loads after app.js, whose helpers it uses');
  const ids = new Set([...card.matchAll(/\$\('([\w-]+)'\)|getElementById\('([\w-]+)'\)/g)].map((m) => m[1] ?? m[2]));
  const missing = [...ids].filter((id) => !new RegExp(`id="${id}"`).test(html));
  ok(missing.length === 0, `every element it looks for is in index.html${missing.length ? ` - missing ${missing.join(', ')}` : ''}`);
}

console.log('=== what it shows ===');
{
  const m = mount();
  ok(m.w && m.calls.length === 0, 'nothing is fetched while the app is not open');
  await m.w.load();
  ok(m.calls[0]?.method === 'GET' && m.calls[0].url === '/wanted', 'it loads GET /wanted');
  const open = m.$('wanted-list').querySelectorAll('.wanted-entry');
  ok(open.length === 2, `the two open films (${open.length})`);
  ok(/2 title\(s\) people asked for · 2 resolved in the last 30 days/.test(m.$('wanted-status').textContent), `the status line: ${m.$('wanted-status').textContent}`);
  const wicked = m.entry('tt1262426');
  ok(wicked.querySelector('[data-wanted="resolve"]')?.textContent === 'Mark resolved' && !wicked.querySelector('[data-wanted="reopen"]'),
    'an open film has Mark resolved');
  ok(!!wicked.querySelector('textarea.wanted-note-box[maxlength="2000"]') && wicked.querySelector('[data-wanted="note"]')?.textContent === 'Save',
    'and a notes box with Save');
  const notes = wicked.querySelectorAll('.wanted-note');
  ok(notes.length === 2 && /bob · .*13:05:00/.test(notes[0].textContent) && /Ordered the Blu-ray/.test(notes[0].textContent),
    `each note with who wrote it and when (${notes[0]?.textContent.replace(/\s+/g, ' ').trim()})`);
  ok(!/AM|PM/.test(m.$('card-wanted').innerHTML), 'every time on the 24-hour clock');
  ok(!!notes[0].querySelector('[data-wanted="del-note"]') && !notes[1].querySelector('[data-wanted="del-note"]'),
    'bob may delete his own note, not alice\'s');

  const box = m.$('wanted-resolved-box');
  ok(!box.classList.contains('hidden') && box.tagName === 'DETAILS' && !box.hasAttribute('open'), 'the Resolved section shows, collapsed');
  ok(m.$('wanted-resolved-count').textContent === '2', 'counting two');
  const resolved = m.$('wanted-resolved').querySelectorAll('.wanted-entry');
  ok([...resolved].map((e) => e.getAttribute('data-key')).join() === 'tt0087182,tt0290334', 'newest first, as the server orders them');
  ok(/Resolved by mommy · .*16:45:00/.test(resolved[0].textContent), `who resolved it and when (${resolved[0].querySelector('.wanted-resolved-by')?.textContent})`);
  ok(/Resolved by the bot \(found on the server as "X2"\)/.test(resolved[1].textContent), 'the bot\'s own, saying what it found');
  ok(resolved[0].querySelector('[data-wanted="reopen"]')?.textContent === 'Reopen' && !resolved[0].querySelector('[data-wanted="resolve"]'),
    'a resolved film has Reopen');

  const sup = mount({ user: { username: 'alice', role: 'superadmin' } });
  await sup.w.load();
  ok(sup.entry('tt1262426').querySelectorAll('[data-wanted="del-note"]').length === 2, 'the super-admin may delete every note');

  const empty = mount({ list: () => ({ wanted: [], resolved: [] }) });
  await empty.w.load();
  ok(/Everything asked for is on the server/.test(empty.$('wanted-list').textContent) && empty.$('wanted-resolved-box').classList.contains('hidden'),
    'nothing at all: says so, and no Resolved section');
}

console.log('=== the buttons ===');
{
  const m = mount();
  await m.w.load();
  await m.click(m.entry('barefoot|2014').querySelector('[data-wanted="resolve"]'));
  ok(m.calls[1]?.method === 'POST' && m.calls[1].url === '/wanted/barefoot%7C2014/resolve', `Mark resolved posts the key URL-encoded (${m.calls[1]?.url})`);
  ok(m.calls[2]?.url === '/wanted' && m.toasts.includes('Marked resolved'), 'then reloads, and says so');

  await m.click(m.entry('tt0087182').querySelector('[data-wanted="reopen"]'));
  ok(m.calls.at(-2)?.url === '/wanted/tt0087182/reopen' && m.calls.at(-1)?.url === '/wanted', 'Reopen posts and reloads');

  const box = m.entry('tt1262426').querySelector('.wanted-note-box');
  const n = m.calls.length;
  await m.click(m.entry('tt1262426').querySelector('[data-wanted="note"]'));
  ok(m.calls.length === n && m.toasts.at(-1) === 'BAD Write the note first', 'Save with nothing typed sends nothing');
  box.value = 'Please check the second drive';
  box.dispatchEvent(new m.win.Event('input', { bubbles: true }));
  await m.click(m.entry('tt1262426').querySelector('[data-wanted="note"]'));
  const post = m.calls.find((c) => c.url === '/wanted/tt1262426/notes');
  ok(post?.method === 'POST' && post.body?.text === 'Please check the second drive', 'Save posts the note');
  ok(m.entry('tt1262426').querySelector('.wanted-note-box').value === '', 'and the box is empty again after the reload');

  await m.click(m.entry('tt1262426').querySelector('.wanted-note [data-wanted="del-note"]'));
  ok(m.calls.some((c) => c.method === 'DELETE' && c.url === '/wanted/tt1262426/notes/n1'), 'Delete deletes that note');
  const no = mount({ confirmed: false });
  await no.w.load();
  await no.click(no.entry('tt1262426').querySelector('[data-wanted="del-note"]'));
  ok(!no.calls.some((c) => c.method === 'DELETE'), 'unless the admin thinks better of it');

  const gone = mount({ failWith: (method, url) => (method === 'POST' && /resolve$/.test(url) ? { message: 'That film is not on the wanted list any more', status: 404 } : null) });
  await gone.w.load();
  await gone.click(gone.entry('tt1262426').querySelector('[data-wanted="resolve"]'));
  ok(gone.toasts.includes('BAD That film is not on the wanted list any more') && gone.calls.at(-1)?.url === '/wanted',
    'a film another admin cleared: the reason, and the list as it is now');
}

console.log('=== another admin\'s change, pushed, reloads it - and keeps a note being typed ===');
{
  const m = mount();
  await m.w.load();
  const box = m.entry('tt1262426').querySelector('.wanted-note-box');
  box.value = 'half a thought';
  box.dispatchEvent(new m.win.Event('input', { bubbles: true }));
  const before = m.calls.length;
  m.w.changed();
  m.w.changed();
  m.w.changed();
  await m.runTimers();
  ok(m.calls.length === before + 1 && m.calls.at(-1).url === '/wanted', 'three pushes at once are one reload');
  ok(m.entry('tt1262426').querySelector('.wanted-note-box').value === 'half a thought', 'the half-written note is still there');
  await m.click(m.document.querySelector('.tab[data-tab="history"]'));
  ok(m.calls.at(-1).url === '/wanted' && m.calls.length === before + 2, 'opening the History tab reloads it too');
}

console.log('=== Refresh rechecks the library first ===');
{
  const m = mount();
  await m.w.load();
  await m.click(m.$('btn-wanted-refresh'));
  const urls = m.calls.map((c) => `${c.method} ${c.url}`);
  ok(urls.slice(-2).join(' -> ') === 'POST /wanted/recheck -> GET /wanted', `POST /wanted/recheck, then the list (${urls.slice(-2).join(' -> ')})`);
  ok(m.toasts.includes('1 on the server now - marked resolved'), 'and says what it found');
  const down = mount({ failWith: (method, url) => (url === '/wanted/recheck' ? { message: 'The library is not configured', status: 409 } : null) });
  await down.click(down.$('btn-wanted-refresh'));
  ok(down.toasts.includes('BAD The library check did not run: The library is not configured') && down.calls.at(-1).url === '/wanted',
    'a recheck that cannot run says why, and the list still reloads');
}

// The operator, 2026-10-11: once a film is available, queue it for whoever
// asked and react on their message - what says it is available being the
// bot's own recheck finding it in the library (src/core/wanted-arrival.js).
// The card shows the switch, the recheck's find and each re-run, and re-runs
// a resolved film by hand.
console.log('=== Re-run requests, the arrival switch, and what each re-run came to ===');
{
  const withArrivals = () => {
    const l = LIST();
    l.settings = { rerunOnArrival: false };
    Object.assign(l.resolved[1], {
      arrival: { at: T(9, 2), as: { id: 'X2ID', title: 'X2', year: 2003, imdbId: 'tt0290334' }, settled: { at: T(9, 31), outcome: 're-run' } },
      reruns: [
        { at: T(9, 31), requester: 'Mia', ran: true, outcome: 'queued', trigger: 'arrival' },
        { at: T(9, 31), requester: 'Ethan', ran: false, outcome: 'skipped', why: 'had it queued or sent since', trigger: 'arrival' },
      ],
    });
    return l;
  };
  const m = mount({ list: withArrivals });
  await m.w.load();
  ok(m.$('wanted-rerun-on-arrival')?.checked === false, 'the switch shows the saved setting');
  const x2 = m.entry('tt0290334');
  ok(x2.querySelector('[data-wanted="rerun"]')?.textContent === 'Re-run requests', 'a resolved film has Re-run requests');
  ok(!m.entry('tt1262426').querySelector('[data-wanted="rerun"]'), 'an open one has none: it is not on the server yet');
  ok(/^Found on the server by the recheck · .*09:02:00 · re-run/.test(x2.querySelector('.wanted-arrival')?.textContent ?? ''),
    `when the recheck found it, on the 24-hour clock (${x2.querySelector('.wanted-arrival')?.textContent})`);
  ok(!/Discord|request bot|announced/i.test(m.$('card-wanted').innerHTML), 'and nothing on the card speaks of Discord posts');
  const lines = [...x2.querySelectorAll('.wanted-rerun')].map((e) => e.textContent);
  ok(/Mia: re-run: queued/.test(lines[0] ?? '') && /Ethan: not re-run - had it queued or sent since/.test(lines[1] ?? ''),
    `and what each re-run came to (${lines.join(' | ')})`);
  ok(!/AM|PM/.test(m.$('card-wanted').innerHTML), 'every time on the 24-hour clock');

  await m.click(x2.querySelector('[data-wanted="rerun"]'));
  const urls = m.calls.map((c) => `${c.method} ${c.url}`);
  ok(urls.slice(-2).join(' -> ') === 'POST /wanted/tt0290334/rerun -> GET /wanted', `Re-run requests posts, then reloads (${urls.slice(-2).join(' -> ')})`);
  ok(m.toasts.at(-1) === 'Re-running 1 request(s) - not: Ethan (had it queued or sent since)', `and says who, and who not (${m.toasts.at(-1)})`);
  const no = mount({ list: withArrivals, confirmed: false });
  await no.w.load();
  await no.click(no.entry('tt0290334').querySelector('[data-wanted="rerun"]'));
  ok(!no.calls.some((c) => /\/rerun$/.test(c.url)), 'unless the admin thinks better of it');

  const sw = m.$('wanted-rerun-on-arrival');
  sw.checked = true;
  sw.dispatchEvent(new m.win.Event('change', { bubbles: true }));
  await m.tick(); await m.tick();
  const set = m.calls.find((c) => c.url === '/wanted/settings');
  ok(set?.method === 'POST' && set.body?.rerunOnArrival === true, 'switching it posts the setting');
  const refused = mount({ list: withArrivals, failWith: (method, url) => (url === '/wanted/settings' ? { message: 'not allowed', status: 403 } : null) });
  await refused.w.load();
  refused.$('wanted-rerun-on-arrival').checked = true;
  refused.$('wanted-rerun-on-arrival').dispatchEvent(new refused.win.Event('change', { bubbles: true }));
  await refused.tick(); await refused.tick();
  ok(refused.$('wanted-rerun-on-arrival').checked === false && refused.toasts.includes('BAD not allowed'), 'a refused save puts the switch back, and says why');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
