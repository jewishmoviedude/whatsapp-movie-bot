/* A list the panel draws a page at a time has a "Show all" button.
   Run: node test/long-lists-show-all.test.mjs

   The operator (2026-10-11), on the History tab: "also in that list on the
   panel I get 'Show 40 more (120 older)' just give me a button to show all".
   History drew 40 requests and offered 40 more at a press, so the oldest of
   160 took three presses; the Members roster, a hundred at a time, took more.
   Both now offer "Show all (N)" beside "Show N more", through one helper,
   pagerButtons().

   Pinned here:
   - Show all is offered beside Show N more, which stays, on History (movies
     and TV) and on Members; it is not offered when a page or less is left,
     where Show N more already shows the rest;
   - pressing it draws every row, in order, and leaves no button under them;
   - a list shown in full stays in full when it is drawn again (a History
     reload, a Members refresh or change of sort), with a request that came
     in since at the top, since neither ever reset how far it had been paged;
   - the Members search still narrows the list, and goes back to the first
     page as it always did; Show all then shows every match;
   - no list builds a "Show N more" button of its own without Show all.

   The first half reads app.js and runs pagerButtons() itself, so it runs on
   any box. The second runs the REAL app.js against the REAL index.html in
   linkedom, like the other panel suites; it is skipped, and says so, where
   linkedom (a devDependency) is not installed: npm install --include=dev. */
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');

/** The text of each button in an HTML string, and what pressing it calls. */
const buttonsIn = (s) => [...String(s).matchAll(/<button[^>]*onclick="([^"]*)"[^>]*>([^<]*)<\/button>/g)]
  .map((m) => ({ onclick: m[1], text: m[2] }));

console.log('=== pagerButtons(): Show all beside Show N more, while more than a page is left ===');
{
  const src = app.match(/\nfunction pagerButtons\([\s\S]*?\n}\n/)?.[0];
  ok(!!src, 'app.js has pagerButtons()');
  // Without it, every check below fails on its own line rather than the
  // suite stopping at a ReferenceError.
  // eslint-disable-next-line no-new-func
  const pagerButtons = src ? new Function(`${src}\nreturn pagerButtons;`)() : () => '';
  const hist = (shown, total) => buttonsIn(pagerButtons({ shown, total, page: 40, noun: 'older',
    more: "moreHistory('movies')", all: "allHistory('movies')" }));

  const first = hist(40, 160);
  ok(first.map((b) => b.text).join(' | ') === 'Show 40 more (120 older) | Show all (160)',
    `160 requests, 40 on screen: ${first.map((b) => b.text).join(' | ')}`);
  ok(first[0]?.onclick === "moreHistory('movies')" && first[1]?.onclick === "allHistory('movies')",
    'Show 40 more pages on, and Show all shows the lot');
  const near = hist(140, 160);
  ok(near.map((b) => b.text).join(' | ') === 'Show 20 more (20 older)',
    `with a page or less left, Show 20 more already shows the rest, so it is alone: ${near.map((b) => b.text).join(' | ')}`);
  ok(hist(40, 80).length === 1, 'exactly one page left is still a page or less');
  ok(hist(160, 160).length === 0 && hist(12, 12).length === 0, 'with everything on screen, no button at all');
}

console.log('=== every list drawn a page at a time offers it ===');
{
  const showMore = [...app.matchAll(/Show \$\{[^`]*?\} more/g)];
  ok(showMore.length === 1, `one "Show N more" button in app.js, the helper's (${showMore.length} found)`);
  const body = (name) => app.match(new RegExp(`\\nfunction ${name}\\([\\s\\S]*?\\n}\\n`))?.[0] ?? '';
  ok(/pagerButtons\(\{[\s\S]*?all: `allHistory\('\$\{which\}'\)`/.test(body('renderHistPane')),
    'History, movies and TV, draws its buttons with pagerButtons and Show all');
  ok(/pagerButtons\(\{[\s\S]*?all: 'allRoster\(\)'/.test(body('renderRoster')),
    'and so does the Members roster');
  ok(/window\.allHistory = \(which\) => \{ histShown\[which\] = Infinity;/.test(app)
    && /window\.allRoster = \(\) => \{ ROSTER_SHOWN = Infinity;/.test(app),
  'Show all is everything, not the rows there are now, so a reload cannot fold it back to a page');
  ok(/window\.moreHistory = /.test(app) && /window\.moreRoster = /.test(app), 'Show N more is still there');
  for (const id of ['hist-more-movies', 'hist-more-tv', 'mr-more']) {
    ok(new RegExp(`id="${id}" class="row gap`).test(html), `#${id} spaces its two buttons apart`);
  }
}

let parseHTML = null;
try { ({ parseHTML } = await import('linkedom')); } catch { /* a production install */ }

if (!parseHTML) {
  console.log('=== the panel: SKIPPED - linkedom is not installed (npm install --include=dev) ===');
} else {
  const T0 = new Date(2026, 9, 11, 20, 16, 53).getTime();
  const MIN = 60000;
  const historyRows = (movies, tv) => [
    ...Array.from({ length: movies }, (_, i) => ({ id: `m${i}`, kind: 'movie', at: T0 - i * MIN, requester: `Member ${i}`,
      request: `film ${i}`, title: `Film ${i}`, year: 2000 + (i % 25), status: 'sent' })),
    ...Array.from({ length: tv }, (_, i) => ({ id: `t${i}`, kind: 'tv', at: T0 - (i + 0.5) * MIN, requester: `Viewer ${i}`,
      request: `show ${i} season 3`, title: `Show ${i}`, season: 3, episodes: 10, status: 'sent' })),
  ].sort((a, b) => b.at - a.at);
  const rosterOf = (n) => Array.from({ length: n }, (_, i) => ({
    key: `num:1555000${String(i).padStart(4, '0')}`, id: `${i}@lid`, number: `1555000${String(i).padStart(4, '0')}`,
    name: `Member ${i}`, groups: [{ jid: 'g1@g.us', subject: 'Movies', admin: null }],
    groupCount: 1, adminCount: 0, msgCount: n - i, firstSeen: T0 - 86400000, lastSeen: T0 - i * MIN,
  }));

  function loadPanel(routes) {
    const { document, window } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
    const selectValue = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value');
    if (!selectValue.set) {
      Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
        configurable: true,
        get: selectValue.get,
        set(v) {
          for (const o of this.querySelectorAll('option')) {
            if (o.value === String(v)) o.setAttribute('selected', ''); else o.removeAttribute('selected');
          }
        },
      });
    }
    const fetch = async (url) => {
      if (url === '/api/auth/status') return new Promise(() => {});
      const path = url.replace(/^\/api/, '').split('?')[0];
      const out = typeof routes[path] === 'function' ? routes[path]() : routes[path] ?? {};
      return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(out) };
    };
    const localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    const win = { document, localStorage, location: { reload() {}, href: '' }, navigator: {}, scrollTo() {}, addEventListener() {} };
    const exported = ['loadHistory', 'loadMembersRoster', 'renderRoster'];
    // eslint-disable-next-line no-new-func
    const make = new Function('window', 'document', 'localStorage', 'fetch', 'EventSource',
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'confirm', 'alert', 'prompt',
      'navigator', 'location', `"use strict";\n${app}\n;return { ${exported.join(', ')} };`);
    const h = make(win, document, localStorage, fetch, function EventSource() {},
      () => 0, () => {}, () => 0, () => {}, () => true, () => {}, () => null, win.navigator, win.location);
    return { document, window, win, h };
  }
  const tick = () => new Promise((r) => setImmediate(r));

  /** The buttons under a list, as drawn, and a press of one: its onclick, run as the browser would. */
  const buttons = (doc, id) => [...doc.getElementById(id).querySelectorAll('button')]
    .map((b) => ({ text: b.textContent, onclick: b.getAttribute('onclick') }));
  const press = (p, id, text) => {
    const b = buttons(p.document, id).find((x) => x.text.startsWith(text));
    if (!b) return false;
    const [, fn, arg] = b.onclick.match(/^(\w+)\((?:'([^']*)')?\)$/) ?? [];
    p.win[fn](arg);
    return true;
  };

  console.log('=== History: Show all draws every request, and stays drawn ===');
  {
    let served = historyRows(160, 50);
    const p = loadPanel({ '/history': () => served });
    const titles = (id) => [...p.document.querySelectorAll(`#${id} .item .item-title`)].map((e) => e.textContent.replace(/\s*\(\d{4}\)$/, '').trim());
    await p.h.loadHistory();
    await tick();
    ok(titles('history-list').length === 40, `Movies draws a page first (${titles('history-list').length} rows)`);
    ok(buttons(p.document, 'hist-more-movies').map((b) => b.text).join(' | ') === 'Show 40 more (120 older) | Show all (160)',
      `the operator's line, with Show all beside it: ${buttons(p.document, 'hist-more-movies').map((b) => b.text).join(' | ')}`);
    ok(buttons(p.document, 'hist-more-tv').map((b) => b.text).join(' | ') === 'Show 10 more (10 older)',
      `TV, ten short of a page from the end, has Show 10 more alone: ${buttons(p.document, 'hist-more-tv').map((b) => b.text).join(' | ')}`);

    ok(press(p, 'hist-more-movies', 'Show all'), 'Show all can be pressed');
    const all = titles('history-list');
    ok(all.length === 160, `every movie request is on screen (${all.length})`);
    ok(all.every((t, i) => t === `Film ${i}`), 'newest first, none missing or repeated');
    ok(buttons(p.document, 'hist-more-movies').length === 0, 'and nothing left to show, so no button');
    ok(titles('history-tv').length === 40, 'the TV pane is left as it was');

    served = [{ id: 'new', kind: 'movie', at: T0 + MIN, request: 'heat 1995', title: 'Heat', year: 1995, status: 'sent' }, ...served];
    await p.h.loadHistory();
    await tick();
    const after = titles('history-list');
    ok(after.length === 161 && after[0] === 'Heat' && after[160] === 'Film 159',
      `a reload keeps it in full, the new request at the top (${after.length} rows, first ${after[0]})`);
    ok(buttons(p.document, 'hist-more-movies').length === 0, 'with no "Show 1 more" under it');
  }

  console.log('=== History: Show 40 more still pages, and Show all follows it ===');
  {
    const p = loadPanel({ '/history': historyRows(160, 0) });
    await p.h.loadHistory();
    await tick();
    ok(press(p, 'hist-more-movies', 'Show 40 more'), 'Show 40 more can be pressed');
    ok(p.document.querySelectorAll('#history-list .item').length === 80, 'and draws 40 more');
    ok(buttons(p.document, 'hist-more-movies').map((b) => b.text).join(' | ') === 'Show 40 more (80 older) | Show all (160)',
      `Show all is still beside it: ${buttons(p.document, 'hist-more-movies').map((b) => b.text).join(' | ')}`);
    press(p, 'hist-more-movies', 'Show all');
    ok(p.document.querySelectorAll('#history-list .item').length === 160, 'and from there draws the rest');
  }

  console.log('=== Members: Show all, through a refresh, a sort and a search ===');
  {
    let roster = rosterOf(250);
    const p = loadPanel({ '/members': () => ({ members: roster }) });
    const names = () => [...p.document.querySelectorAll('#mr-list .member-row .item-title')].map((e) => e.textContent.trim());
    await p.h.loadMembersRoster();
    await tick();
    ok(names().length === 100, `a hundred first (${names().length})`);
    ok(buttons(p.document, 'mr-more').map((b) => b.text).join(' | ') === 'Show 100 more (150 hidden) | Show all (250)',
      `Show all beside Show 100 more: ${buttons(p.document, 'mr-more').map((b) => b.text).join(' | ')}`);

    ok(press(p, 'mr-more', 'Show all'), 'Show all can be pressed');
    ok(names().length === 250 && names().every((n, i) => n === `Member ${i}`), `every member, most active first (${names().length})`);
    ok(buttons(p.document, 'mr-more').length === 0, 'and no button under them');

    roster = rosterOf(260);
    await p.h.loadMembersRoster();
    await tick();
    ok(names().length === 260, `Refresh keeps everyone on screen, ten who joined since included (${names().length})`);
    p.document.getElementById('mr-sort').value = 'recent';
    p.document.getElementById('mr-sort').dispatchEvent(new p.window.Event('change'));
    ok(names().length === 260, `and so does a change of sort (${names().length})`);

    const filter = p.document.getElementById('mr-filter');
    filter.value = 'member 1';
    filter.dispatchEvent(new p.window.Event('input'));
    const hits = rosterOf(260).filter((m) => m.name.toLowerCase().includes('member 1')).length;
    ok(names().length === 100 && names().every((n) => n.toLowerCase().includes('member 1')),
      `a search narrows the list, and starts from the first page as it always has (${names().length} of ${hits} matches)`);
    ok(buttons(p.document, 'mr-more').map((b) => b.text).join(' | ') === `Show ${hits - 100} more (${hits - 100} hidden)`,
      `the rest of the matches are a page or less away: ${buttons(p.document, 'mr-more').map((b) => b.text).join(' | ')}`);
    filter.value = 'member';
    filter.dispatchEvent(new p.window.Event('input'));
    ok(buttons(p.document, 'mr-more').some((b) => b.text === 'Show all (260)'), 'a search matching more than a page offers Show all');
    press(p, 'mr-more', 'Show all');
    ok(names().length === 260 && names().every((n) => n.startsWith('Member')), 'which shows every match');
    filter.value = 'member 25';
    filter.dispatchEvent(new p.window.Event('input'));
    // Sorted by Recently active, which in this roster is Member 0 first.
    ok(names().join(' | ') === ['Member 25', ...Array.from({ length: 10 }, (_, i) => `Member 25${i}`)].join(' | '),
      `and a narrower search after it finds exactly its matches: ${names().join(' | ')}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
