/* The Queue card and Now running show a TV request as ONE row.
   Run: node test/queue-panel-requests.test.mjs

   Asked for by the operator: a season is one item in the queue, not fifty.
   The queue now sends a TV request as a single row (src/core/queue.js,
   _itemView) and this is the panel side: one row per request in Waiting and
   Now running, with the arrows and Cancel acting on the request and Skip on
   one episode in hand; the
   episode actually moving in Transfers; a run of one season's episodes in
   Recently finished as one line; and the Waiting list numbered in the order
   things will really start - the number each requester sees on their message.

   It runs the REAL app.js against the REAL index.html in linkedom, like the
   other panel suites. Fetch is stubbed, and /auth/status is never answered, so
   nothing renders unless the test asks it to. */
import fs from 'node:fs';
import { parseHTML } from 'linkedom';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');

function loadPanel() {
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
  const requests = [];
  const fetch = async (url, opts = {}) => {
    requests.push(`${opts.method ?? 'GET'} ${url}`);
    if (url === '/api/auth/status') return new Promise(() => {});
    return { ok: true, status: 200, statusText: 'OK', text: async () => '{}' };
  };
  const localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const win = { document, localStorage, location: { reload() {}, href: '' }, navigator: {}, scrollTo() {}, addEventListener() {} };
  const exported = ['renderQueue'];
  // eslint-disable-next-line no-new-func
  const make = new Function('window', 'document', 'localStorage', 'fetch', 'EventSource',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'confirm', 'alert', 'prompt',
    'navigator', 'location', `"use strict";\n${app}\n;return { ${exported.join(', ')} };`);
  const h = make(win, document, localStorage, fetch, function EventSource() {},
    () => 0, () => {}, () => 0, () => {}, () => true, () => {}, () => null, win.navigator, win.location);
  return { document, win, h, requests };
}
const settle = () => new Promise((r) => setImmediate(r));

/* What JobQueue.snapshot() sends: rows are requests. */
const FILM_RUNNING = {
  id: 'f00d00000001', label: 'Heat (1995)', kind: 'movie', state: 'running', startedAt: Date.now(),
  meta: { requester: 'Avi' }, progress: { stage: 'download', text: '41% of 3 GB', pct: 16 },
};
const ep = (id, label, stage, pct) => ({ id, label, kind: 'tv', state: 'running', startedAt: Date.now(),
  meta: {}, progress: { stage, text: `${stage}ing`, pct }, group: 'tv-3EB0-1', groupLabel: 'American Dad! season 5' });
const SEASON_RUNNING = {
  id: 'a1b2c3d4e5f6', group: 'tv-3EB0-1', label: 'American Dad! season 5', kind: 'tv', state: 'running',
  meta: { requester: 'David', requesterNumber: '+1 555' }, startedAt: Date.now(),
  progress: { stage: 'convert', text: '22% (4.1x)', pct: 51 },
  jobs: { total: 22, done: 3, failed: 0, cancelled: 0, running: 1, waiting: 18 },
  current: [ep('e4e4e4e4e4e4', 'American Dad! S05E04', 'convert', 51)],
  next: 'American Dad! S05E05',
};
const waitingRows = () => [
  { id: 'f00d00000002', label: 'Up (2009)', kind: 'movie', state: 'pending', meta: { requester: 'Cara' }, place: 1 },
  { id: 'b0b0b0b0b0b0', group: 'tv-ABC-2', label: 'The Boys season 1', kind: 'tv', state: 'pending', meta: { requester: 'Moshe' },
    jobs: { total: 8, done: 0, failed: 0, cancelled: 0, running: 0, waiting: 8 }, current: [], place: 2 },
  { id: 'c0c0c0c0c0c0', group: 'tv-DEF-3', label: 'Bluey S02E01', kind: 'tv', state: 'pending', meta: {},
    jobs: { total: 1, done: 0, failed: 0, cancelled: 0, running: 0, waiting: 1 }, current: [], place: 3 },
];
const snapshot = (over = {}) => ({
  paused: false, concurrency: 3, strictMoviePriority: true, maxLength: 104,
  counts: { pending: { movie: 1, tv: 2 }, active: { movie: 1, tv: 1 } },
  active: [FILM_RUNNING, SEASON_RUNNING], pending: waitingRows(),
  history: [
    { ...ep('x3', 'American Dad! S05E03', 'done', 100), state: 'done', finishedAt: Date.now() },
    { ...ep('x2', 'American Dad! S05E02', 'done', 100), state: 'done', finishedAt: Date.now() },
    { ...ep('x1', 'American Dad! S05E01', 'done', 100), state: 'done', finishedAt: Date.now() },
    { id: 'm9', label: 'Inception (2010)', kind: 'movie', state: 'done', finishedAt: Date.now() },
  ],
  ...over,
});

const { document, win, h, requests } = loadPanel();
const $ = (id) => document.getElementById(id);
const rows = () => [...$('queue-list').querySelectorAll('.item')];
const btn = (row, dir) => row.querySelector(`[onclick*="'${dir}')"]`);

console.log('=== one row per request, counted as requests ===');
{
  h.renderQueue(snapshot());
  ok($('queue-count').textContent === '5', `the badge counts 5 requests, not 30 episodes (${$('queue-count').textContent})`);
  const titles = rows().map((r) => r.querySelector('.item-title').textContent);
  ok(titles.join(' | ') === '1. Up (2009) | 2. The Boys season 1 | 3. Bluey S02E01',
    `waiting, numbered in the order they start: ${titles.join(' | ')}`);
  ok(/8 episodes · from Moshe/.test(rows()[1].querySelector('.item-sub').textContent), 'a season says how many episodes it holds');
  ok(!/episode/.test(rows()[2].querySelector('.item-sub').textContent), 'a single episode does not');
  ok(rows().every((r) => !r.innerHTML.includes('tv-ABC-2') && !r.innerHTML.includes('tv-DEF-3')),
    'the buttons act on the queue\'s own id, never the request key built from a WhatsApp message id');
  ok(/moveJob\('b0b0b0b0b0b0','down'\)/.test(rows()[1].innerHTML) && /cancelJob\('b0b0b0b0b0b0'\)/.test(rows()[1].innerHTML),
    'and on the whole request');
}

console.log('=== with strict movie priority, the arrows never swap a film and a show ===');
{
  h.renderQueue(snapshot());
  const [film, season, single] = rows();
  const dis = (r, d) => btn(r, d).hasAttribute('disabled');
  ok(dis(film, 'up') && dis(film, 'down') && dis(film, 'top'), 'the only film: nothing to pass either way');
  ok(dis(season, 'up') && dis(season, 'top') && !dis(season, 'down'), 'the first show cannot go above the film, but can go down');
  ok(!dis(single, 'up') && !dis(single, 'top') && dis(single, 'down'), 'the last show can go up, to first of the shows');
  ok(btn(single, 'top').getAttribute('title') === 'Run next after the films', 'and ⤒ says where that really is');

  h.renderQueue(snapshot({ strictMoviePriority: false }));
  ok(!btn(rows()[1], 'up').hasAttribute('disabled') && btn(rows()[2], 'top').getAttribute('title') === 'Run next',
    'with priority off, anything can pass anything');
}

console.log('=== Now running: a season is one card, with the episode in hand ===');
{
  h.renderQueue(snapshot());
  const cards = [...document.querySelectorAll('#activity .act-job')];
  ok(cards.length === 2, `two cards: the film and the season (${cards.length})`);
  const season = cards.find((c) => /American Dad! season 5/.test(c.querySelector('.act-title').textContent));
  const line = season?.querySelector('[data-request-progress]')?.textContent ?? '';
  ok(line === '22 episodes · 3 done · American Dad! S05E04 converting', `it says where the season has got to: "${line}"`);
  const skip = season.querySelector('[onclick^="skipJob"]');
  ok(skip.textContent.trim() === 'Skip S05E04' && /the rest of the season carries on/.test(skip.getAttribute('title')),
    `Skip names the episode in hand, and says the rest carries on: "${skip.textContent.trim()}"`);
  ok(skip.getAttribute('onclick') === "skipJob('e4e4e4e4e4e4')", 'and is aimed at that episode, not the season');
  ok(/whole request/.test(season.querySelector('[onclick^="cancelJob"]').getAttribute('title')), 'Cancel is the whole request');
  const film = cards.find((c) => /Heat/.test(c.querySelector('.act-title').textContent));
  ok(film.querySelector('[onclick^="skipJob"]').textContent.trim() === 'Skip (3 waiting)' && !film.querySelector('[data-request-progress]'),
    'a film\'s card is as it always was, its waiting count in requests');

  const transfers = [...document.querySelectorAll('#transfer-live .dl-name')].map((e) => e.textContent);
  ok(transfers.join(' | ') === 'Heat (1995) | American Dad! S05E04', `Transfers shows the files actually moving: ${transfers.join(' | ')}`);
}

console.log('=== a season between episodes, held behind the films ===');
{
  const idle = { ...SEASON_RUNNING, progress: null, current: [], jobs: { ...SEASON_RUNNING.jobs, running: 0, waiting: 19 } };
  h.renderQueue(snapshot({ active: [FILM_RUNNING, idle] }));
  const card = [...document.querySelectorAll('#activity .act-job')].find((c) => /American Dad/.test(c.textContent));
  ok(/waiting — films go first/.test(card.querySelector('.act-title').textContent), `says why nothing is moving: "${card.querySelector('.act-title').textContent}"`);
  ok(/next: American Dad! S05E05/.test(card.querySelector('.act-detail').textContent), 'and which episode is next');
  ok(!card.querySelector('[onclick^="skipJob"]') && !!card.querySelector('[onclick^="cancelJob"]'),
    'nothing in hand to skip, but it can still be cancelled');
}

console.log('=== Recently finished: a run of one season is one line ===');
{
  h.renderQueue(snapshot());
  const recent = [...$('queue-recent').querySelectorAll('.item-title')].map((e) => e.textContent);
  ok(recent.join(' | ') === 'American Dad! season 5 — 3 episodes | Inception (2010)', `${recent.join(' | ')}`);
}

console.log('=== Skip on a season waits for the episode, not the season ===');
{
  h.renderQueue(snapshot());
  requests.length = 0;
  const done = win.skipJob('e4e4e4e4e4e4');
  const skipBtn = () => [...document.querySelectorAll('#activity .act-job')]
    .find((c) => /American Dad/.test(c.textContent)).querySelector('.btn.warn');
  ok(skipBtn().textContent === 'Skipping…' && skipBtn().hasAttribute('disabled'), 'it shows Skipping… at once');
  await done; await settle();
  ok(requests.includes('POST /api/queue/e4e4e4e4e4e4/skip'), 'and posts the skip for that episode');
  h.renderQueue(snapshot());
  ok(skipBtn().textContent === 'Skipping…', 'still Skipping… while that episode is in hand');
  const nextEp = { ...SEASON_RUNNING, current: [ep('e5e5e5e5e5e5', 'American Dad! S05E05', 'download', 3)] };
  h.renderQueue(snapshot({ active: [FILM_RUNNING, nextEp] }));
  ok(skipBtn().textContent === 'Skip S05E05', 'and back to Skip once the season has moved on to the next one');
}

console.log('=== two episodes in hand: a Skip for each, and each stops only its own ===');
{
  // With two TV slots a season has one episode sending and the next
  // downloading. One Skip on the card stopped both - a healthy download
  // thrown away to get past the one stuck sending.
  const two = {
    ...SEASON_RUNNING,
    current: [ep('e4e4e4e4e4e4', 'American Dad! S05E04', 'upload', 93), ep('e5e5e5e5e5e5', 'American Dad! S05E05', 'download', 12)],
    jobs: { ...SEASON_RUNNING.jobs, running: 2, waiting: 17 },
  };
  h.renderQueue(snapshot({ active: [FILM_RUNNING, two] }));
  const card = () => [...document.querySelectorAll('#activity .act-job')].find((c) => /American Dad/.test(c.textContent));
  const skips = () => [...card().querySelectorAll('.btn.warn')];
  ok(skips().map((b) => `${b.textContent}=${b.getAttribute('onclick')}`).join(' | ')
    === "Skip S05E04=skipJob('e4e4e4e4e4e4') | Skip S05E05=skipJob('e5e5e5e5e5e5')",
  `one Skip per episode in hand, each aimed at its own: ${skips().map((b) => b.textContent).join(' | ')}`);
  requests.length = 0;
  await win.skipJob('e4e4e4e4e4e4'); await settle();
  ok(requests.includes('POST /api/queue/e4e4e4e4e4e4/skip') && !requests.some((r) => /e5e5e5e5e5e5|a1b2c3d4e5f6\/skip/.test(r)),
    `only the one stuck sending is skipped (${requests.filter((r) => /skip/.test(r)).join()})`);
  h.renderQueue(snapshot({ active: [FILM_RUNNING, two] }));
  ok(skips().map((b) => b.textContent).join(' | ') === 'Skipping… | Skip S05E05', 'and only its button says Skipping…');
  h.renderQueue(snapshot({ active: [FILM_RUNNING, { ...two, current: [two.current[1]] }] }));
  ok(skips().map((b) => b.textContent).join(' | ') === 'Skip S05E05', 'the download carries on once it has gone');
}

console.log('=== a season working on one episode can still move the next up its line ===');
{
  // E4 converting, E5 downloaded and 2nd in line for the encoder. The card
  // leads with E4, and the ▲ / ⤒ were read from it alone, so they vanished
  // just when E5 needed moving up.
  const piped = {
    ...SEASON_RUNNING,
    current: [ep('e4e4e4e4e4e4', 'American Dad! S05E04', 'convert', 51),
      { ...ep('e5e5e5e5e5e5', 'American Dad! S05E05', 'wait', 0), waiting: { stage: 'convert', position: 2, of: 2 } }],
    line: { stage: 'convert', position: 2, of: 2, label: 'American Dad! S05E05' },
  };
  h.renderQueue(snapshot({ active: [FILM_RUNNING, piped] }));
  const card = [...document.querySelectorAll('#activity .act-job')].find((c) => /American Dad/.test(c.textContent));
  const moves = [...card.querySelectorAll('[onclick^="moveJob"]')];
  ok(moves.map((b) => b.getAttribute('onclick')).join(' | ') === "moveJob('a1b2c3d4e5f6','up') | moveJob('a1b2c3d4e5f6','top')",
    `▲ and ⤒ are there, on the season (${moves.map((b) => b.textContent).join(' ')})`);
  ok(moves.every((b) => !b.hasAttribute('disabled')), 'and usable: it is 2nd, not next');
  ok(card.querySelector('[data-line-place]')?.textContent === 'S05E05 2nd in line to convert',
    `the place says which episode is waiting (${card.querySelector('[data-line-place]')?.textContent})`);
}

console.log('=== a job waiting for its retry is listed, with a Cancel ===');
{
  // In no queue between a failed send and its retry, it used to appear only
  // as "failed" under Recently finished - and then be posted anyway.
  const retrying = [{ id: 'r3r3r3r3r3r3', label: 'Spaceballs (1987)', kind: 'movie', state: 'retrying', meta: { requester: 'Dana' },
    attempt: 1, max: 3, waitingFor: 'room', since: Date.now() }];
  h.renderQueue(snapshot({ retrying }));
  ok($('queue-count').textContent === '6', `the badge counts it (${$('queue-count').textContent})`);
  const first = rows()[0];
  ok(first.querySelector('.item-title').textContent === 'Spaceballs (1987)' && first.querySelector('.tag').textContent === 'retrying',
    'listed first, as retrying');
  ok(/attempt 1 of 3 · waiting for disk space · from Dana/.test(first.querySelector('.item-sub').textContent),
    `saying what it waits for (${first.querySelector('.item-sub').textContent})`);
  ok(/cancelJob\('r3r3r3r3r3r3'\)/.test(first.innerHTML), 'with a Cancel on the queue\'s id for it');
  h.renderQueue(snapshot({ pending: [], retrying }));
  ok(rows().length === 1 && !$('queue-list').textContent.includes('Nothing waiting'), 'and with nothing else waiting, not "Nothing waiting."');
}

console.log('=== Clear waiting asks first, and says who will see ❌ ===');
{
  // Each request it clears that came from a group shows ❌ on its message,
  // films and TV alike: one click is a reaction per waiting request.
  const q = snapshot();
  q.pending.push({ id: 'd0d0d0d0d0d0', label: 'Heat (1995)', kind: 'movie', state: 'pending', meta: { requester: 'manual (admin)' }, place: 4 });
  const ask = win.clearWaitingPrompt(q);
  ok(ask === 'Clear 4 waiting request(s)?\n\nUp to 3 requester(s) will see ❌ on their message in the group.',
    `it counts the requests, and the ones from a group (${JSON.stringify(ask)})`);
  ok(win.clearWaitingPrompt(snapshot({ pending: [] })) === null, 'and asks nothing when nothing is waiting');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
