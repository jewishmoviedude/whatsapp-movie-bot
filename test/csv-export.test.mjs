/* A CSV download on every card of the panel. Run: node test/csv-export.test.mjs

   Asked for on 2026-09-28: "please add options in every single part of the
   panel to easily download a csv export of data in each section, for example
   take a csv download of the queue if I want to share with someone quickly".

   What is pinned here, and why each can break quietly:

   - every card has the button - every tab, the Settings cards, the cards only
     shown when something is wrong, and a card that did not exist when the page
     loaded (the member page is built on click; the next card somebody adds is
     not in any list);
   - the button changes nothing else. A card's heading text is its identity:
     the saved collapse state, the search index, the Settings filter, the
     jump-nav chips and the fresh-install checklist all read it, so a "CSV"
     word in every heading would have renamed every card;
   - the file is correct CSV: RFC 4180 quoting, CRLF, a UTF-8 byte-order mark
     so Excel shows emoji and Hebrew, no cell a spreadsheet would run as a
     formula, and every time on the 24-hour clock;
   - the queue and the history export their data, not the page on screen: the
     history draws 40 rows at a time, and a TV season is one queue item with
     one place - from today's queue, which sends a job per episode, as well as
     from one that groups a request (the first version numbered today's
     queue a place per episode, the complaint in the same message);
   - a dedicated exporter that has the data for part of a card still exports
     the rest of it (the lockdown card once said only when it would lock, not
     that it was locked), and a date read off a card is YYYY-MM-DD HH:mm like
     every other, whatever order the browser writes it in;
   - a card's own script can hand the shared button its exporter, and a card
     with a CSV button of its own keeps one control, not two;
   - no secret ever lands in a file - not a saved key, not one typed and not
     saved, not one pasted inside a Jellyfin link - and nothing else is taken
     for one: the first sweep wrote "Basic Instinct" as "Basic ••••••••".

   It runs the REAL scripts index.html loads - app.js, csv-export.js and any
   other - together as the browser runs them, against the REAL index.html in
   linkedom. Fetch is stubbed and /auth/status is never answered, so the
   panel's own start-up loaders never run and every render here is one the
   test asked for. */
import fs from 'node:fs';
import { parseHTML } from 'linkedom';
import { DEFAULT_CONFIG, SECRET_PATHS, getPath, setPath } from '../src/config/schema.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const read = (f) => fs.readFileSync(new URL(`../src/web/public/${f}`, import.meta.url), 'utf8');
const html = read('index.html');
// Every script the page loads, in its order: a card another script adds (and
// that script's own buttons) is then on the page here as it is in a browser.
const SCRIPTS = [...html.matchAll(/<script src="\/([\w.-]+\.js)"/g)].map((m) => m[1]);
const SOURCES = new Map(SCRIPTS.map((f) => [f, read(f)]));
const storeSrc = fs.readFileSync(new URL('../src/config/store.js', import.meta.url), 'utf8');
const MASK = storeSrc.match(/export const MASK = '([^']+)'/)[1];

/* ------------------------------------------------------------------ fixtures */

// Distinctive, so a leak anywhere in any file is unmistakable.
const SECRETS = {
  omdb: 'omdbREALkey7f3a91', tmdb: 'tmdbREALkey0b8e44', gemini: 'AIzaREALgeminiKEY0123456789abcdefgh',
  share: 'shareREALkey9c9c77', jfPass: 'jfREALpassword', jfToken: 'jfREALtokenA1B2', jfKey: 'jfREALapikey33',
  plex: 'plexREALtoken55', httpAuth: 'httpREALauthHeader', smtp: 'smtpREALapppw', session: 'sessionREALsecret',
  groqSaved: 'gsk_REALsavedGroqKey0123456789', groqTyped: 'gsk_TYPEDgroqKey0123456789abcd',
  typedOmdb: 'omdbTYPEDnotSaved', typedGemini: 'AIzaTYPEDgeminiKey0123456789abcdefg',
  pwCur: 'curREALpassword', pwNew: 'newREALpassword1', naPass: 'adminREALpassword',
  linkKey: 'linkREALapikey8d8d', logKey: 'logREALapikey4e4e', bearer: 'bearerREALtoken6f6f6f',
  qr: 'data:image/png;base64,QRREALsessionlink', pairing: 'PAIRREAL1',
};

const T0 = new Date(2026, 8, 25, 16, 5, 9).getTime();     // 2026-09-25 16:05:09, local time
const MIN = 60000;

function storedConfig() {
  const c = structuredClone(DEFAULT_CONFIG);
  c.web.admins = [{ username: 'mommy', role: 'superadmin', passwordHash: 'scrypt$a', lastLogin: null }];
  c.web.sessionSecret = SECRETS.session;
  c.omdb.apiKey = SECRETS.omdb;
  c.movieRequests.theatrical.tmdbApiKey = SECRETS.tmdb;
  Object.assign(c.gemini, { enabled: true, apiKey: SECRETS.gemini, model: 'gemini-3.6-flash' });
  Object.assign(c.directLinks, { enabled: true, apiKey: SECRETS.share });
  Object.assign(c.library.jellyfin, {
    baseUrl: 'http://10.0.0.5:8096', authMethod: 'password', username: 'bot',
    password: SECRETS.jfPass, accessToken: SECRETS.jfToken, apiKey: SECRETS.jfKey, userId: 'u1', userName: 'bot',
  });
  c.library.plex.token = SECRETS.plex;
  c.library.http.authHeader = SECRETS.httpAuth;
  Object.assign(c.email, { enabled: true, user: 'owner@example.com', appPassword: SECRETS.smtp });
  return c;
}

/** What GET /config returns: the masking ConfigStore.redacted() does. */
function redact(cfg) {
  const out = structuredClone(cfg);
  for (const p of SECRET_PATHS) if (getPath(out, p)) setPath(out, p, MASK);
  out.web.admins = (out.web.admins ?? []).map(({ passwordHash, ...a }) => a);
  delete out.web.sessionSecret;
  return out;
}

const AI_VIEW = {
  order: ['gemini', 'groq', 'cerebras', 'mistral'],
  providers: [
    { id: 'gemini', label: 'Gemini', console: 'aistudio.google.com', enabled: true, apiKey: MASK,
      model: 'gemini-3.6-flash', canClearRated: true, status: { state: 'ok', at: T0 } },
    { id: 'groq', label: 'Groq', console: 'console.groq.com', enabled: true, apiKey: MASK, model: '',
      autoModel: 'llama-3.3-70b', canClearRated: false, status: null },
    { id: 'cerebras', label: 'Cerebras', console: 'cloud.cerebras.ai', enabled: false, apiKey: '', model: '',
      canClearRated: false, status: null },
    { id: 'mistral', label: 'Mistral', console: 'console.mistral.ai', enabled: false, apiKey: '', model: '',
      canClearRated: false, status: null },
  ],
};

const MIGRATION = { id: 'a1', label: 'Migration (2023)', kind: 'movie', state: 'running',
  meta: { requester: 'Dana', requesterNumber: '+1 (555) 123-4567', group: 'g1@g.us' },
  progress: { stage: 'convert', pct: 42, text: 'converting 42%' }, addedAt: T0 - 30 * MIN, startedAt: T0 - 20 * MIN };
const PADDINGTON = { id: 'p1', label: 'Paddington 2 (2017)', kind: 'movie', state: 'pending', meta: { requester: '=HYPERLINK("http://x")' }, addedAt: T0 - 5 * MIN };
const FINISHED = [
  { id: 'h1', label: 'Wonka (2023)', kind: 'movie', state: 'done', meta: { requester: 'Dana' }, addedAt: T0 - 90 * MIN, startedAt: T0 - 80 * MIN, finishedAt: T0 - 60 * MIN },
  { id: 'h2', label: 'Up (2009)', kind: 'movie', state: 'failed', meta: {}, error: 'ffmpeg exited 1, retrying', finishedAt: T0 - 70 * MIN },
];
const bluey = (n, state, extra = {}) => ({ id: `b${n}`, label: `Bluey S02E${String(n).padStart(2, '0')}`, kind: 'tv', state,
  meta: { kind: 'tv', series: 'Bluey', season: 2, episode: n, requester: 'Avi', requesterNumber: '15557654321', position: `${n}/10` },
  addedAt: T0 - 25 * MIN, ...extra });
const BLUEY_E3 = bluey(3, 'running', { progress: { stage: 'wait', pct: 100, text: 'waiting for the encoder' },
  waiting: { stage: 'convert', position: 2 }, startedAt: T0 - 10 * MIN });

/**
 * The queue as GET /queue sends it (src/core/queue.js, snapshot()): one item
 * per request, a TV request's episodes counted in `jobs`. Avi's Bluey season
 * 2 is under way (episode 3 in hand and in line for the encoder, 2 done, 7
 * waiting); an episode asked for alone; שרה's The Chosen season 3 not
 * started. The same shape from the real queue is checked below.
 */
function groupedQueue() {
  const counts = (total, running, waiting, done = 0) => ({ total, done, failed: 0, cancelled: 0, running, waiting });
  return {
    paused: false,
    strictMoviePriority: true,
    counts: { pending: { movie: 1, tv: 2 }, active: { movie: 1, tv: 1 } },
    active: [MIGRATION,
      { id: 'gb', group: 'tv-b', label: 'Bluey season 2', kind: 'tv', state: 'running',
        meta: { kind: 'tv', series: 'Bluey', season: 2, requester: 'Avi', requesterNumber: '15557654321' },
        progress: BLUEY_E3.progress, waiting: BLUEY_E3.waiting, line: { ...BLUEY_E3.waiting, label: BLUEY_E3.label },
        addedAt: T0 - 25 * MIN, startedAt: BLUEY_E3.startedAt,
        jobs: counts(10, 1, 7, 2), current: [BLUEY_E3], next: 'Bluey S02E04' }],
    pending: [
      { ...PADDINGTON, place: 1 },
      { id: 'gs', group: 'tv-s', label: 'Bluey S01E05', kind: 'tv', state: 'pending', place: 2, addedAt: T0 - 4 * MIN,
        meta: { kind: 'tv', series: 'Bluey', season: 1, requester: 'Dana' }, jobs: counts(1, 0, 1), current: [], next: 'Bluey S01E05' },
      { id: 'gc', group: 'tv-c', label: 'The Chosen season 3', kind: 'tv', state: 'pending', place: 3, addedAt: T0 - 2 * MIN,
        meta: { kind: 'tv', series: 'The Chosen', season: 3, requester: 'שרה' }, jobs: counts(8, 0, 8), current: [], next: 'The Chosen S03E01' },
    ],
    history: FINISHED,
  };
}

function historyRows(movies, tv) {
  const out = [];
  for (let i = 0; i < movies; i++) {
    out.push({ id: `m${i}`, kind: 'movie', at: T0 - i * MIN, requestedAt: T0 - i * MIN - 2000, requester: `Member ${i}`,
      requesterNumberDisplay: '+1 (555) 000-0000', request: `film ${i}`, title: `Film ${i}`, year: 2000 + (i % 25),
      status: i % 7 ? 'sent' : 'failed', rated: 'PG', timings: { queueWaitSec: 12, downloadSec: 95, convertSec: 300, uploadSec: 40, totalSec: 435, endToEndSec: 447 },
      contentCheck: { provider: 'gemini', by: 'Gemini', model: 'gemini-3.6-flash', nudity: false, confidence: 1, basis: 'family film' } });
  }
  for (let i = 0; i < tv; i++) {
    out.push({ id: `t${i}`, kind: 'tv', at: T0 - (i + 0.5) * MIN, requester: `Viewer ${i}`, requesterNumber: '15551112222',
      request: `show ${i} season 3`, title: `Show ${i}`, year: 2019, season: 3, episodes: 10, status: 'sent', detail: '10 episode(s) posted' });
  }
  return out.sort((a, b) => b.at - a.at);
}

const ROSTER = [
  { key: 'num:15551230001', id: '111@lid', number: '15551230001', name: 'Dana', groups: [{ jid: 'g1@g.us', subject: 'Movies', admin: 'admin' }, { jid: 'g2@g.us', subject: 'סרטים', admin: null }],
    groupCount: 2, adminCount: 1, msgCount: 40, firstSeen: T0 - 86400000, lastSeen: T0 },
  { key: 'lid:222@lid', id: '222@lid', number: null, name: null, groups: [{ jid: 'g1@g.us', subject: 'Movies', admin: null }],
    groupCount: 1, adminCount: 0, msgCount: 3, firstSeen: null, lastSeen: null },
];

/* ------------------------------------------------------------------ harness */

/**
 * The panel, with or without csv-export.js. `served` is the config GET /config
 * answers with; `routes` answers everything else, by path.
 */
function loadPanel({ withCsv = true, served = redact(storedConfig()), routes = {}, early = null } = {}) {
  const { document, window } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);

  // linkedom gives <select> a value getter and no setter, reads an <option>
  // with no value attribute as '' where a browser reads its text, and has no
  // `checked` accessor on <input>. A browser does all three, so this does.
  const optValue = (o) => o.getAttribute('value') ?? o.textContent;
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
    configurable: true,
    get() {
      const opts = [...this.querySelectorAll('option')];
      const o = opts.find((x) => x.hasAttribute('selected')) ?? opts[0];
      return o ? optValue(o) : '';
    },
    set(v) {
      for (const o of this.querySelectorAll('option')) {
        if (optValue(o) === String(v)) o.setAttribute('selected', ''); else o.removeAttribute('selected');
      }
    },
  });
  if (!Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked')) {
    Object.defineProperty(window.HTMLInputElement.prototype, 'checked', {
      configurable: true,
      get() { return this.hasAttribute('checked'); },
      set(v) { if (v) this.setAttribute('checked', ''); else this.removeAttribute('checked'); },
    });
  }
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};

  // The download: what was put in the Blob, the link clicked, what was revoked.
  const downloads = [];
  const revoked = [];
  const blobs = new Map();
  class Blob {
    constructor(parts, opts = {}) { this.text = parts.join(''); this.type = opts.type; }
  }
  const URL = {
    createObjectURL(b) { const u = `blob:panel/${blobs.size + 1}`; blobs.set(u, b); return u; },
    revokeObjectURL(u) { revoked.push(u); },
  };
  const click = window.HTMLElement.prototype.click;
  window.HTMLElement.prototype.click = function clickRecorded() {
    if (this.tagName === 'A' && this.hasAttribute('download')) {
      const href = this.getAttribute('href');
      downloads.push({ href, filename: this.getAttribute('download'), blob: blobs.get(href), inPage: this.isConnected });
    }
    return click?.call(this);
  };

  let now = 0, seq = 0;
  const timers = new Map();
  const setTimeout = (fn, ms = 0) => { const id = ++seq; timers.set(id, { id, fn, at: now + (Number(ms) || 0) }); return id; };
  const clearTimeout = (id) => { timers.delete(id); };
  const flush = (until = Infinity) => {
    for (let n = 0; timers.size && n < 500; n++) {
      const t = [...timers.values()].sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (t.at > until) break;
      timers.delete(t.id);
      now = t.at;
      t.fn();
    }
  };

  const kept = new Map();
  const localStorage = {
    getItem: (k) => (kept.has(k) ? kept.get(k) : null),
    setItem: (k, v) => { kept.set(k, String(v)); },
    removeItem: (k) => { kept.delete(k); },
  };

  const requests = [];
  const fetch = async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    requests.push({ method, url });
    if (url === '/api/auth/status') return new Promise(() => {});
    const path = url.replace(/^\/api/, '').split('?')[0];
    let out = {};
    let status = 200;
    try {
      const r = path === '/config' ? served : routes[path] ?? Object.entries(routes).find(([k]) => k.endsWith('*') && path.startsWith(k.slice(0, -1)))?.[1];
      out = typeof r === 'function' ? await r(url) : r ?? {};
    } catch (err) {
      status = err.status ?? 500;
      out = { error: err.message };
    }
    return { ok: status < 400, status, statusText: 'x', text: async () => JSON.stringify(out) };
  };

  const win = {
    document, localStorage, location: { reload() {}, href: '' }, navigator: {}, scrollTo() {},
    addEventListener() {}, MutationObserver: window.MutationObserver, Blob, URL,
    // An exporter a card's script registered before csv-export.js loaded.
    ...(early ? { panelCsvExporters: early } : {}),
  };
  const exported = ['loadConfig', 'renderQueue', 'renderStatus', 'loadHistory', 'loadLogs', 'loadMembersRoster',
    'loadCatalogue', 'loadAiProviders', 'loadGroups', 'buildSearchIndex', 'jumpChipName', 'setupCollapsibles',
    'renderJumpNav', 'runSettingsSearch', 'cardId', 'freshInstallChecklist', 'loadLockdown', 'loadOverrides',
    'renderContentHealth'];
  const source = SCRIPTS.filter((f) => withCsv || f !== 'csv-export.js').map((f) => SOURCES.get(f)).join('\n;\n');
  // eslint-disable-next-line no-new-func
  const make = new Function('window', 'document', 'localStorage', 'fetch', 'EventSource',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'confirm', 'alert', 'prompt',
    'navigator', 'location', `"use strict";\n${source}\n;return { ${exported.join(', ')} };`);
  const h = make(win, document, localStorage, fetch, function EventSource() {},
    setTimeout, clearTimeout, () => {}, () => {}, () => true, () => {}, () => null,
    win.navigator, win.location);
  // Every toast the panel shows, read off the element toast() writes to.
  const toastEl = document.getElementById('toast');
  const readToast = () => toastEl?.textContent ?? '';
  return { document, window, win, h, csv: win.panelCsv, flush, requests, downloads, revoked, readToast };
}

const settle = () => new Promise((r) => setImmediate(r));
const settleAll = async () => { for (let i = 0; i < 12; i++) await settle(); };

/** Parse CSV strictly by RFC 4180: a bare LF, a bare CR or a stray quote is an error. */
function parseCsv(text) {
  const s = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const rows = [];
  let row = [], cell = '', quoted = false, wasQuoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c;
    } else if (c === '"') {
      if (cell !== '' || wasQuoted) throw new Error(`stray quote at ${i}`);
      quoted = true; wasQuoted = true;
    } else if (c === ',') { row.push(cell); cell = ''; wasQuoted = false; }
    else if (c === '\r') {
      if (s[i + 1] !== '\n') throw new Error(`bare CR at ${i}`);
      row.push(cell); rows.push(row); row = []; cell = ''; wasQuoted = false; i++;
    } else if (c === '\n') throw new Error(`bare LF at ${i}`);
    else cell += c;
  }
  if (quoted) throw new Error('unterminated quote');
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** A CSV as objects keyed by its header. */
const records = (text) => { const [head, ...rows] = parseCsv(text); return rows.map((r) => Object.fromEntries(head.map((k, i) => [k, r[i]]))); };
const cardOf = (doc, sel) => doc.querySelector(sel)?.closest('.card');
const ownButtons = (card) => [...card.querySelectorAll('.csv-btn')].filter((b) => b.closest('.card') === card);

/* ================================================================== serializer */

console.log('=== the serializer: RFC 4180, CRLF, a byte-order mark ===');
{
  const { csv: c } = loadPanel();
  ok(c && typeof c.toCsv === 'function', 'csv-export.js exposes its serializer as window.panelCsv');
  ok(c.csvCell('plain') === 'plain', 'a plain field is written as it is');
  ok(c.csvCell('a,b') === '"a,b"', 'a comma is quoted');
  ok(c.csvCell('say "hi"') === '"say ""hi"""', 'a quote is doubled inside quotes');
  ok(c.csvCell('two\nlines') === '"two\nlines"', 'a line break is quoted');
  ok(c.csvCell('cr\rhere') === '"cr\rhere"', 'a carriage return is quoted');
  ok(c.csvCell(null) === '' && c.csvCell(undefined) === '', 'nothing is an empty field');
  ok(c.csvCell(true) === 'yes' && c.csvCell(false) === 'no', 'a tick box is yes or no');
  ok(c.csvCell(0) === '0' && c.csvCell(1932735283) === '1932735283', 'numbers are numbers');
  ok(c.csvCell(NaN) === '' && c.csvCell(Infinity) === '', 'and not-a-number is blank, not "NaN"');

  const text = c.toCsv(['Title', 'Note'], [['שלום 🎬', 'a,b'], ['Line', 'one\r\ntwo']]);
  ok(text.charCodeAt(0) === 0xfeff, 'the file starts with a UTF-8 byte-order mark, so Excel reads emoji and Hebrew');
  ok(!/[^\r]\n/.test(text.replace(/"[^"]*"/g, '')), 'every record ends CRLF - no bare LF between records');
  ok(text.endsWith('\r\n'), 'and the last record does too');
  const back = parseCsv(text);
  ok(JSON.stringify(back) === JSON.stringify([['Title', 'Note'], ['שלום 🎬', 'a,b'], ['Line', 'one\r\ntwo']]),
    'a strict RFC 4180 reader gets back exactly what went in, Hebrew, emoji and embedded CRLF included');
}

console.log('=== no cell a spreadsheet would run as a formula ===');
{
  const { csv: c } = loadPanel();
  for (const [raw, want] of [
    ['=1+1', "'=1+1"], ['+SUM(A1:A9)', "'+SUM(A1:A9)"], ['-2+3', "'-2+3"], ['@cmd', "'@cmd"],
    ['\tx', "'\tx"], ['=HYPERLINK("http://x")', '"\'=HYPERLINK(""http://x"")"'],
  ]) ok(c.csvCell(raw) === want, `${JSON.stringify(raw)} -> ${JSON.stringify(c.csvCell(raw))}`);
  ok(c.csvCell('\rx') === '"\'\rx"', 'a leading carriage return is neutralised and quoted');
  ok(c.csvCell(-5) === '-5', 'the number -5 is not mangled');
  ok(c.csvCell('-5') === '-5' && c.csvCell('+15551234567') === '+15551234567' && c.csvCell('-0.25') === '-0.25' && c.csvCell('1e5') === '1e5',
    'nor is a plain number that arrived as text ("-5", "+15551234567")');
  ok(c.csvCell('-5 apples') === "'-5 apples", 'but text that merely starts with a minus is');
  ok(c.csvCell('a=b') === 'a=b', 'an = in the middle is harmless and left alone');
}

console.log('=== every time on the 24-hour clock, as YYYY-MM-DD HH:mm ===');
{
  const { csv: c } = loadPanel();
  const d = (h, m, s = 0) => new Date(2026, 8, 25, h, m, s).getTime();
  ok(c.csvWhen(d(16, 5)) === '2026-09-25 16:05', `the afternoon: "${c.csvWhen(d(16, 5))}"`);
  ok(c.csvWhen(d(0, 5)) === '2026-09-25 00:05', `five past midnight is 00:05, never 12:05 AM or 24:05 ("${c.csvWhen(d(0, 5))}")`);
  ok(c.csvWhen(d(9, 7, 3), { seconds: true }) === '2026-09-25 09:07:03', 'seconds where a log needs them');
  ok(c.csvWhen(new Date(d(23, 59))) === '2026-09-25 23:59', 'a Date as well as a timestamp');
  ok(c.csvWhen(null) === '' && c.csvWhen(0) === '' && c.csvWhen('') === '', 'no time is blank, not 1970');
  ok(c.csvCell(new Date(d(16, 5))) === '2026-09-25 16:05', 'a Date in a cell is written the same way');
  const utc = Date.UTC(2026, 8, 25, 22, 30);
  ok(c.csvWhenIn(utc, 'America/New_York') === '2026-09-25 18:30', `New York time for the lockdown card: "${c.csvWhenIn(utc, 'America/New_York')}"`);
  ok(c.csvWhenIn(utc, 'Asia/Jerusalem') === '2026-09-26 01:30', `and Jerusalem, past midnight: "${c.csvWhenIn(utc, 'Asia/Jerusalem')}"`);
}

console.log('=== the file is named for the section and the minute ===');
{
  const { csv: c } = loadPanel();
  ok(c.csvFilename('queue', new Date(2026, 8, 25, 9, 7)) === 'queue-2026-09-25-0907.csv', 'queue-2026-09-25-0907.csv');
  ok(c.csvFilename('Now running', new Date(2026, 8, 25, 0, 0)) === 'now-running-2026-09-25-0000.csv', 'midnight is 0000');
  ok(c.csvSlug('WhatsApp numbers 📱') === 'whatsapp-numbers', 'emoji dropped from the name');
  ok(c.csvSlug('API keys & logins') === 'api-keys-and-logins', '& spelled out');
  ok(c.csvSlug('Café — déjà vu') === 'cafe-deja-vu', 'accents folded');
  ok(c.csvSlug('קבוצה') === 'section', 'a name with no Latin letters still makes a file name');
}

console.log('=== anything shaped like a credential is masked in any cell ===');
{
  const { csv: c } = loadPanel();
  const link = `http://jf:8096/Items/abc/Download?api_key=${SECRETS.linkKey}&x=1`;
  ok(!c.csvCell(link).includes(SECRETS.linkKey) && c.csvCell(link).includes(`api_key=${MASK}&x=1`), 'the api_key in a pasted Jellyfin link');
  ok(!c.csvCell(`Authorization: Bearer ${SECRETS.bearer}`).includes(SECRETS.bearer), 'a bearer token');
  ok(!c.csvCell(`key ${SECRETS.gemini} failed`).includes(SECRETS.gemini), 'a Google API key quoted in a message');
  ok(!c.csvCell(`groq ${SECRETS.groqTyped}`).includes(SECRETS.groqTyped), 'a Groq key');
  ok(c.csvCell('The Keys of the Kingdom (1944)') === 'The Keys of the Kingdom (1944)', 'while an ordinary title is untouched');
  // By the context a credential comes in: a header named as one, a token
  // that looks random, a provider key standing as a word of its own.
  for (const [what, text, secret] of [
    ['a Basic header with no digit in it', 'Authorization: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
    ['a Bearer header', 'authorization=Bearer abc.def', 'abc.def'],
    ['an Emby token header', 'X-Emby-Token: 0f3a9c77aa', '0f3a9c77aa'],
    ['Jellyfin\'s own header', 'MediaBrowser Client="bot", Token="tok9c9c9c"', 'tok9c9c9c'],
    ['a bare Basic token with padding', 'sent Basic Ym90OmhlbGxv=', 'Ym90OmhlbGxv='],
    ['a provider key after =', `key=sk-${'a1'.repeat(12)}`, `sk-${'a1'.repeat(12)}`],
    ['a key in brackets', `(${SECRETS.groqSaved})`, SECRETS.groqSaved],
  ]) ok(!c.csvCell(text).includes(secret), `${what} is masked: ${JSON.stringify(c.csvCell(text))}`);
}

console.log('=== ...and only that: titles and file names come through whole ===');
{
  // The first sweep masked "Basic" or "Bearer" before any long word, and
  // "sk-" inside any word: "Basic Instinct" was written "Basic ••••••••" in
  // History, Wanted and the queue, and "Mask-of-Zorro-1998-1080p-BluRay.mkv"
  // as "Ma••••••••.mkv".
  const { csv: c } = loadPanel();
  for (const title of ['Basic Instinct (1992)', 'basic instinct', 'BASIC INSTINCT 2', 'Basic Training 2017', 'The Basic Training',
    'The Bearer Bonds Heist', 'Bearer of Bad News', 'Mask-of-Zorro-1998-1080p-BluRay.mkv', 'Whisk-and-Chill-Baking-Show-S01E01.mkv',
    'Desk-Set-1957-remastered-edition.mp4', 'Risk-and-Reward-2019-extended-cut.mkv', 'Authorization header (optional)']) {
    ok(c.csvCell(title) === title, `"${title}" is written as it is (${JSON.stringify(c.csvCell(title))})`);
  }
  const p = loadPanel({ routes: {
    '/history': [{ id: 'x', kind: 'movie', at: T0, title: 'Basic Instinct', year: 1992, request: 'basic instinct',
      typed: 'basic instinct 1992', requester: 'Dana', status: 'blocked-rating', rated: 'R' }],
    '/wanted': { wanted: [{ title: 'Basic Instinct', year: 1992, count: 3, requesters: ['Avi'] }] },
    '/queue': { active: [{ id: 'a', label: 'Mask-of-Zorro-1998-1080p-BluRay.mkv', kind: 'movie', meta: { requester: 'Dana' }, progress: { stage: 'download', pct: 3 } }], pending: [], history: [] },
  } });
  await p.h.loadHistory();
  const h = records((await p.csv.csvFor(cardOf(p.document, '#history-list'))).text)[0];
  ok(h.Title === 'Basic Instinct' && h['Asked as'] === 'basic instinct 1992' && h['Looked up as'] === 'basic instinct',
    `the History file names the film (${h.Title} / ${h['Asked as']} / ${h['Looked up as']})`);
  const w = records((await p.csv.csvFor(cardOf(p.document, '#wanted-list'))).text)[0];
  ok(w.Title === 'Basic Instinct', `and so does Wanted (${w.Title})`);
  const q = records((await p.csv.csvFor(cardOf(p.document, '#queue-list'))).text)[0];
  ok(q.Title === 'Mask-of-Zorro-1998-1080p-BluRay.mkv', `and the queue its file (${q.Title})`);
}

console.log('=== the queue file lists a job waiting for its retry ===');
{
  // It is in no queue while it waits (src/core/queue.js holdRetry), and was
  // missing from the Queue card and its file alike.
  const p = loadPanel({ routes: {
    '/queue': { active: [], pending: [], history: [], retrying: [{ id: 'r1', label: 'Spaceballs (1987)', kind: 'movie', state: 'retrying',
      meta: { requester: 'Dana' }, attempt: 2, max: 3, waitingFor: 'connection', since: T0 }] },
  } });
  const [r] = records((await p.csv.csvFor(cardOf(p.document, '#queue-list'))).text);
  ok(r?.Title === 'Spaceballs (1987)' && r.Status === 'retrying' && r.Detail === 'attempt 2 of 3 · waiting for WhatsApp to reconnect' && r.Requester === 'Dana',
    `one row, saying so (${JSON.stringify(r)})`);
}

/* ================================================================== the button */

console.log('=== every card, on every tab, has one CSV button in its heading ===');
{
  const { document } = loadPanel();
  const cards = [...document.querySelectorAll('.card')];
  ok(cards.length >= 50, `${cards.length} cards on the page`);
  const missing = cards.filter((c) => ownButtons(c).length !== 1);
  ok(missing.length === 0, `every one has exactly one${missing.length ? ` - not: ${missing.map((c) => c.querySelector('h2')?.textContent.trim()).join(', ')}` : ''}`);
  const offHead = cards.filter((c) => ownButtons(c)[0]?.parentElement !== c.querySelector(':scope > h2'));
  ok(offHead.length === 0, 'and it sits in the card\'s own <h2>');
  // And it is the card's only CSV control. A card's script with data of its
  // own registers an exporter for this button (the hook in csv-export.js)
  // rather than adding a second one - the Hourly checks card once had both.
  const words = (el) => `${String(el.id ?? '').replace(/[-_]/g, ' ')} ${el.textContent} ${el.getAttribute('title') ?? ''}`;
  const second = cards.filter((c) => [...c.querySelectorAll('button, a[download]')]
    .some((el) => el.closest('.card') === c && !el.classList.contains('csv-btn') && /\bcsv\b/i.test(words(el))));
  ok(second.length === 0, `no card has a CSV button of its own beside it${second.length ? ` - ${second.map((c) => c.id || c.querySelector('h2')?.textContent.trim()).join(', ')}` : ''}`);
  for (const tab of ['dashboard', 'settings', 'groups', 'members', 'admins', 'test', 'history', 'logs']) {
    const inTab = [...document.querySelectorAll(`#tab-${tab} .card`)];
    ok(inTab.length > 0 && inTab.every((c) => ownButtons(c).length === 1), `the ${tab} tab: ${inTab.length} card(s), all with the button`);
  }
  for (const id of ['card-cc-health', 'card-cc-fallback', 'ga-detail', 'card-fresh-install', 'card-key-omdb', 'card-ai-providers', 'card-admins']) {
    ok(ownButtons(document.getElementById(id)).length === 1, `#${id}, shown only some of the time or on a restricted tab, has it too`);
  }
  const btn = ownButtons(cardOf(document, '#queue-list'))[0];
  ok(btn.getAttribute('type') === 'button', 'it is type=button, so it can never submit a form');
  ok(!btn.id, 'it has no id - the search indexes button[id] as an action, and "CSV" x60 would flood it');
  ok(btn.textContent === '', 'and no text of its own: style.css draws "CSV"');
  ok(/download/i.test(btn.getAttribute('aria-label') ?? '') && /csv/i.test(btn.getAttribute('aria-label') ?? ''), 'a screen reader hears "Download as CSV"');
  const css = read('style.css');
  ok(/\.csv-btn::after\s*\{\s*content:\s*'[^']*CSV'/.test(css), 'style.css gives it its "CSV" label');
  ok(/\.csv-btn\.csv-push\s*\{\s*margin-left:\s*auto/.test(css), 'and pushes it to the right of the heading');
  ok(SCRIPTS.includes('csv-export.js') && SCRIPTS.indexOf('csv-export.js') > SCRIPTS.indexOf('app.js'),
    `index.html loads csv-export.js after app.js, whose names it reads (${SCRIPTS.join(', ')})`);
}

console.log('=== the button renames nothing: headings, search, chips, collapse memory ===');
{
  const plain = loadPanel({ withCsv: false });
  const withCsv = loadPanel();
  const heads = (d) => [...d.querySelectorAll('.card')].map((c) => c.querySelector('h2')?.textContent ?? '');
  ok(JSON.stringify(heads(plain.document)) === JSON.stringify(heads(withCsv.document)), 'every card heading reads exactly as it did');
  const ids = (p) => [...p.document.querySelectorAll('.card')].map((c) => p.h.cardId(c));
  ok(JSON.stringify(ids(plain)) === JSON.stringify(ids(withCsv)), 'so the saved collapse state (cardId) still finds every folded card');
  const index = (p) => JSON.stringify(p.h.buildSearchIndex().map((e) => [e.kind, e.what, e.sub ?? '', e.tab]));
  ok(index(plain) === index(withCsv), `the search index is identical (${plain.h.buildSearchIndex().length} entries)`);
  ok(!withCsv.h.buildSearchIndex().some((e) => e.el?.classList?.contains('csv-btn') || (/csv/i.test(e.what) && !e.el?.id)),
    'and none of its entries is a CSV button of ours');
  const chips = (p) => [...p.document.querySelectorAll('.card')].map((c, i) => p.h.jumpChipName(c, i));
  ok(JSON.stringify(chips(plain)) === JSON.stringify(chips(withCsv)), 'every jump-nav chip keeps its name');
  const find = (p, q) => { p.h.runSettingsSearch(q); return p.document.getElementById('set-search-count').textContent; };
  for (const q of ['omdb', 'key', 'timeout', 'groups']) {
    ok(find(plain, q) === find(withCsv, q), `the Settings filter finds the same for "${q}" (${find(withCsv, q)})`);
  }
  ok(find(withCsv, 'csv') === 'no matches', 'and "csv" does not match every card on the tab');
}

console.log('=== pressing it downloads; it does not fold the card ===');
{
  const p = loadPanel({ routes: { '/queue': groupedQueue() } });
  p.h.setupCollapsibles();
  const card = cardOf(p.document, '#queue-list');
  const btn = ownButtons(card)[0];
  btn.click();
  await settleAll();
  ok(!card.classList.contains('collapsed'), 'the heading\'s collapse-on-click ignores the button');
  ok(p.downloads.length === 1, 'one file was downloaded');
  const dl = p.downloads[0];
  ok(/^queue-\d{4}-\d{2}-\d{2}-\d{4}\.csv$/.test(dl?.filename ?? ''), `named "${dl?.filename}"`);
  ok(dl?.blob?.type === 'text/csv;charset=utf-8', 'as text/csv in UTF-8');
  ok(dl?.blob?.text.charCodeAt(0) === 0xfeff, 'with the byte-order mark in the bytes saved');
  ok(dl?.inPage === true && !p.document.querySelector('a[download]'), 'through a temporary link that is gone afterwards (a phone needs it in the page to click it)');
  ok(p.revoked.length === 0, 'the object URL is not revoked the instant it is clicked - iOS Safari loses the download');
  p.flush();
  ok(p.revoked.includes(dl?.href), 'but it is revoked afterwards');
  ok(/queue-.*\.csv — 7 rows/.test(p.readToast()), `and a toast says what was saved: "${p.readToast()}"`);
  ok(!btn.hasAttribute('aria-busy'), 'the button is ready again');

  const h2 = card.querySelector('h2');
  h2.click();
  ok(card.classList.contains('collapsed'), 'while a click on the heading itself still folds the card');
  // style.css hides everything in a folded card but its <h2> (.card.collapsed > *:not(h2)).
  ok(btn.parentElement === h2, 'and the button is in the <h2>, which stays on screen when folded');
}

console.log('=== a card that appears later gets the button too ===');
{
  const p = loadPanel();
  const grid = p.document.querySelector('#tab-dashboard .grid');
  grid.insertAdjacentHTML('beforeend', '<div class="card" id="card-later"><h2>Hourly debug <span class="pill ok">ok</span></h2><div class="kv"><span class="k">last run</span><span class="v">16:00</span></div></div>');
  await settleAll();
  p.flush();
  ok(ownButtons(p.document.getElementById('card-later')).length === 1, 'a card added to a tab after load has one within a tick');

  // The member page is a card the Members tab builds on click, headed by an <h3>.
  p.document.getElementById('mr-detail').innerHTML = '<div class="card"><div class="row gap"><div><h3>Dana</h3><div class="muted small">+15551230001</div></div><button class="btn tiny">✕ close</button></div><h4>Admin in 1 group</h4><div class="item-sub">• Movies</div></div>';
  await settleAll();
  p.flush();
  const inner = p.document.querySelector('#mr-detail .card');
  ok(ownButtons(inner).length === 1 && ownButtons(inner)[0].parentElement.tagName === 'H3', 'the member page gets one in its <h3>');
  ok(ownButtons(cardOf(p.document, '#mr-list')).length === 1, 'and the All members card around it still has only its own');
  p.csv.injectAll();
  p.csv.injectAll();
  ok([...p.document.querySelectorAll('.card')].every((c) => ownButtons(c).length === 1), 'injecting again never adds a second');
}

/* ================================================================== exporters */

console.log('=== the queue: one row per request, a TV season with its counts ===');
{
  // Asked for on 2026-09-28: "if season was requested entire season should be
  // 1 item in the queue, don't need 50 episodes counting as individual queue
  // items". The queue sends a request as one item; the file is one row per
  // request, and a season's episode counts are columns of their own, which a
  // spreadsheet can add up - they were words in a Detail cell.
  const p = loadPanel({ routes: { '/queue': groupedQueue() } });
  const out = await p.csv.csvFor(cardOf(p.document, '#queue-list'), new Date(2026, 8, 25, 16, 5));
  ok(out.filename === 'queue-2026-09-25-1605.csv', `file "${out.filename}"`);
  const [head] = parseCsv(out.text);
  for (const c of ['Place', 'Episodes', 'Done', 'Running', 'Waiting', 'Failed', 'Skipped or cancelled', 'Current episode', 'Stage']) {
    ok(head.includes(c), `a "${c}" column`);
  }
  const rows = records(out.text);
  ok(rows.length === 7, `7 rows - 2 running, 3 waiting, 2 recently finished (${rows.length}: ${rows.map((r) => r.Title).join(' | ')})`);
  ok(rows.map((r) => r.Status).join(',') === 'running,running,waiting,waiting,waiting,done,failed', 'running first, then waiting, then finished');
  ok(rows.slice(2, 5).map((r) => r.Place).join(',') === '1,2,3', 'waiting items carry their place in line: 1, 2, 3');
  const movie = rows[0];
  ok(movie.Title === 'Migration (2023)' && movie.Kind === 'Movie', 'the title and kind');
  ok(movie.Requester === 'Dana' && movie['Requester number'] === '+15551234567', `the requester, number as +15551234567 ("${movie['Requester number']}")`);
  ok(movie.Stage === 'converting' && movie['Progress %'] === '42', 'the stage and progress');
  ok(movie.Episodes === '' && movie.Done === '' && movie['Current episode'] === '', 'a film has no episode counts');
  ok(movie.Added === '2026-09-25 15:35' && movie.Started === '2026-09-25 15:45', 'added and started, 24-hour');
  const season = rows[1];
  ok(season.Title === 'Bluey season 2' && season.Kind === 'TV' && season.Series === 'Bluey' && season.Season === '2',
    `the season under way is ONE running row (${season.Title})`);
  ok(season.Episodes === '10' && season.Done === '2' && season.Running === '1' && season.Waiting === '7' && season.Failed === '0'
    && season['Skipped or cancelled'] === '0', `with its counts: 10 = 2 done + 1 running + 7 waiting (${['Episodes', 'Done', 'Running', 'Waiting'].map((k) => season[k]).join('/')})`);
  ok(season['Current episode'] === '3' && season.Stage === 'waiting for a slot', `the episode in hand and its stage (${season['Current episode']}, ${season.Stage})`);
  ok(season.Detail === 'S02E03 number 2 in line to convert', `where it is: "${season.Detail}"`);
  ok(season.Requester === 'Avi' && season['Requester number'] === '+15557654321', 'and who asked');
  ok(!rows.some((r) => /^Bluey S02E/.test(r.Title)), 'no row for any single episode of it');
  const single = rows[3];
  ok(single.Title === 'Bluey S01E05' && single.Episodes === '1' && single.Waiting === '1' && single.Place === '2', 'an episode asked for alone is one item, place 2');
  const chosen = rows[4];
  ok(chosen.Title === 'The Chosen season 3' && chosen.Episodes === '8' && chosen.Waiting === '8' && chosen.Place === '3',
    'a whole season not yet started is ONE row counting 8 episodes, in place 3 - not 8 rows');
  ok(chosen.Requester === 'שרה', 'a Hebrew name comes through intact');
  ok(rows[2].Requester === `'=HYPERLINK("http://x")`, 'a requester name that looks like a formula is neutralised');
  ok(rows[6].Status === 'failed' && rows[6].Error === 'ffmpeg exited 1, retrying', 'a failed job keeps its error');

  const nowRunning = records((await p.csv.csvFor(cardOf(p.document, '#activity'))).text);
  ok(nowRunning.length === 2 && nowRunning.every((r) => r.Status === 'running') && nowRunning[1].Title === 'Bluey season 2',
    'Now running exports the two running items, the season as one');

  // The server cannot be reached: what the page last heard over the event stream.
  const q = loadPanel({ routes: { '/queue': () => { throw Object.assign(new Error('bot is restarting'), { status: 503 }); } } });
  q.h.renderQueue(groupedQueue());
  const fb = await q.csv.csvFor(cardOf(q.document, '#queue-list'));
  ok(records(fb.text).length === 7 && /bot is restarting/.test(fb.note), 'without the server, the queue the page holds - and the toast says so');

  // A season between two episodes, held while a film goes first: running,
  // with nothing in hand, and the file says why and what comes next.
  const held = groupedQueue();
  Object.assign(held.active[1], { current: [], progress: null, waiting: undefined, line: undefined,
    jobs: { total: 10, done: 3, failed: 0, cancelled: 0, running: 0, waiting: 7 }, next: 'Bluey S02E04' });
  const h = loadPanel({ routes: { '/queue': held } });
  const between = records((await h.csv.csvFor(cardOf(h.document, '#queue-list'))).text)[1];
  ok(between.Stage === 'between episodes' && between['Current episode'] === '' && between['Progress %'] === ''
    && between.Detail === 'waiting - films go first · next: Bluey S02E04', `a season between episodes: "${between.Stage}", "${between.Detail}"`);

  // Waiting for room on the disk (src/media/disk-space.js, from the
  // pipeline work) is stage 'wait' as well, and no slot freeing ends it:
  // the file names the disk, with the numbers, not "waiting for a slot".
  const full = groupedQueue();
  const filmWait = 'waiting for disk space — it needs 9.5 GB, 3.0 GB is free';
  const epWait = 'waiting for disk space — it needs 1.9 GB, 1.0 GB is free';
  full.active[0] = { ...MIGRATION, progress: { stage: 'wait', pct: 2, text: filmWait } };
  const e3 = { ...BLUEY_E3, progress: { stage: 'wait', pct: 92, text: epWait }, waiting: undefined };
  Object.assign(full.active[1], { progress: e3.progress, waiting: undefined, line: undefined, current: [e3] });
  const fq = loadPanel({ routes: { '/queue': full, '/transfers': [] } });
  const fr = records((await fq.csv.csvFor(cardOf(fq.document, '#queue-list'))).text);
  ok(fr[0].Stage === 'waiting for disk space' && fr[0].Detail === filmWait, `a film waiting for room: "${fr[0].Stage}", "${fr[0].Detail}"`);
  ok(fr[1].Stage === 'waiting for disk space' && fr[1].Detail === `S02E03 ${epWait}`, `a season's episode waiting for room: "${fr[1].Stage}", "${fr[1].Detail}"`);
  ok(rows[1].Stage === 'waiting for a slot', 'while one in line for the encoder is still waiting for a slot');
  fq.h.renderQueue(full);
  const ft = records((await fq.csv.csvFor(cardOf(fq.document, '#transfer-history'))).text).filter((r) => r.State === 'in progress');
  ok(ft.length === 2 && ft.every((r) => r['What was done'] === 'waiting for disk space'), `and in Transfers (${ft.map((r) => r['What was done']).join(', ')})`);

  // The recently finished list goes back a fixed number of jobs, so it can
  // hold only the end of a season: the row says how many are not in it.
  const tail = (n, state) => ({ id: `z${n}`, label: `Loki S01E0${n}`, kind: 'tv', state, group: 'tv-z', groupLabel: 'Loki season 1',
    meta: { kind: 'tv', series: 'Loki', season: 1, episode: n, requester: 'Dana', position: `${n}/6` }, finishedAt: T0 - n * MIN });
  const cut = loadPanel({ routes: { '/queue': { active: [], pending: [], history: [tail(6, 'done'), tail(5, 'done')] } } });
  const loki = records((await cut.csv.csvFor(cardOf(cut.document, '#queue-list'))).text);
  ok(loki.length === 1 && loki[0].Episodes === '6' && loki[0].Done === '2' && /4 more finished before/.test(loki[0].Detail),
    `a season whose first episodes the list no longer holds: 6 episodes, 2 of them in it ("${loki[0]?.Detail}")`);
}

console.log('=== the queue, from the real queue\'s snapshot ===');
{
  // Not a hand-built fixture: src/core/queue.js itself, driven the way the
  // TV and movie plugins drive it, and its snapshot sent through JSON as
  // GET /queue sends it. A season with two episodes in hand, one failed and
  // retried; a film that arrived mid-season; films and seasons waiting, one
  // resumed after a restart; and a finished season and episode behind them.
  const { JobQueue } = await import('../src/core/queue.js');
  // The failures below are on purpose; the queue need not log each one.
  const { default: log } = await import('../src/util/logger.js');
  log.level = Infinity;
  const queue = new JobQueue({ concurrency: 3, maxLength: 50, strictMoviePriority: true, reserveSlotForMovies: true });
  const lines = new Map();
  queue.setStageWaits({ where: (id) => lines.get(id) ?? null, promote: () => false });
  const running = new Map();
  const run = (label) => (ctx) => new Promise((resolve, reject) => running.set(label, { ctx, resolve, reject }));
  const two = (n) => String(n).padStart(2, '0');
  const AVI = { name: 'Avi', number: '15557654321' };
  const DANA = { name: 'Dana', number: '15551230001' };
  const tvRequest = (key, series, season, eps, who, extra = {}, opts = {}) => eps.map((e, i) => queue.add({
    kind: 'tv', group: key, groupLabel: eps.length === 1 ? `${series} S${two(season)}E${two(e)}` : `${series} season ${season}`,
    groupMeta: { kind: 'tv', series, season, requester: who.name, requesterNumber: who.number, ...extra },
    label: `${series} S${two(season)}E${two(e)}`,
    meta: { kind: 'tv', series, season, episode: e, requester: who.name, requesterNumber: who.number, position: `${i + 1}/${eps.length}`, ...extra },
    run: run(`${series} S${two(season)}E${two(e)}`),
  }, opts));
  const retry = (key, series, season, e, of, who) => queue.add({
    kind: 'tv', group: key, groupLabel: `${series} season ${season}`, retry: 'failed',
    groupMeta: { kind: 'tv', series, season, requester: who.name, requesterNumber: who.number },
    label: `${series} S${two(season)}E${two(e)}`,
    meta: { kind: 'tv', series, season, episode: e, requester: who.name, requesterNumber: who.number, retry: 1, position: `${e}/${of}` },
    run: run(`${series} S${two(season)}E${two(e)} retry`),
  }, { overLimit: true });
  const film = (title, who) => queue.add({ kind: 'movie', label: title, meta: { requester: who.name, requesterNumber: who.number }, run: run(title) });
  const end = async (label, how = 'done') => {
    const r = running.get(label);
    if (how === 'done') r.resolve(); else r.reject(new Error(how));
    running.delete(label);
    await settleAll();
  };

  film('Wonka (2023)', DANA); await settleAll(); await end('Wonka (2023)');
  film('Up (2009)', DANA); await settleAll(); await end('Up (2009)', 'ffmpeg exited 1');
  // Loki season 2: E1 sent, E2 failed and was retried and sent, E3 skipped.
  const [, , lokiE3] = tvRequest('tv-loki', 'Loki', 2, [1, 2, 3], DANA);
  await settleAll();
  await end('Loki S02E01');
  await end('Loki S02E02', 'upload lost');
  retry('tv-loki', 'Loki', 2, 2, 3, DANA);
  await settleAll();
  await end('Loki S02E02 retry');
  queue.cancel(lokiE3, 'skipped');
  await end('Loki S02E03', 'skipped');
  tvRequest('tv-friends', 'Friends', 1, [1], DANA); await settleAll(); await end('Friends S01E01');

  // Bluey season 2, under way: E1 sent, E2 failed and waiting on its retry, E3 and E4 in hand.
  tvRequest('tv-bluey', 'Bluey', 2, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], AVI);
  await settleAll();
  await end('Bluey S02E01');
  await end('Bluey S02E02', 'upload lost');
  retry('tv-bluey', 'Bluey', 2, 2, 10, AVI);
  await settleAll();
  running.get('Bluey S02E03').ctx.progress({ stage: 'convert', text: 'converting 42%' }, 42);
  running.get('Bluey S02E04').ctx.progress({ stage: 'download', text: 'downloading 10%' }, 10);
  // A film mid-season takes the slot kept for films, and waits for the encoder.
  const migration = film('Migration (2023)', { name: 'Dana', number: '+1 (555) 123-4567' });
  await settleAll();
  lines.set(migration, { stage: 'convert', position: 1, of: 1 });
  running.get('Migration (2023)').ctx.progress({ stage: 'wait', text: 'waiting for the encoder' }, 100);
  film('Paddington 2 (2017)', { name: '=HYPERLINK("http://x")', number: null });
  tvRequest('tv-single', 'Bluey', 1, [5], DANA);
  tvRequest('tv-chosen', 'The Chosen', 3, [1, 2, 3, 4, 5, 6, 7, 8], { name: 'שרה', number: '972501234567' }, { beta: true });
  tvRequest('tv-st', 'Stranger Things', 2, [8, 9], AVI, { resumed: true }, { overLimit: true });
  await settleAll();

  const snap = JSON.parse(JSON.stringify(queue.snapshot()));
  ok(snap.active.length === 2 && snap.pending.length === 4, `the queue holds 2 running and 4 waiting requests (${snap.active.length}, ${snap.pending.length})`);
  const p = loadPanel({ routes: { '/queue': snap, '/transfers': [] } });
  const rows = records((await p.csv.csvFor(cardOf(p.document, '#queue-list'))).text);
  const titles = rows.map((r) => `${r.Status}:${r.Title}${r.Place ? `@${r.Place}` : ''}`);
  ok(titles.join(' | ') === ['running:Bluey season 2', 'running:Migration (2023)', 'waiting:Paddington 2 (2017)@1',
    'waiting:Bluey S01E05@2', 'waiting:The Chosen season 3@3', 'waiting:Stranger Things season 2@4',
    'done:Friends S01E01', 'partial:Loki season 2', 'failed:Up (2009)', 'done:Wonka (2023)'].join(' | '),
  `one row per request, films one each, in the queue's order: ${titles.join(' | ')}`);
  ok(!rows.some((r) => /S0\dE\d\d$/.test(r.Title) && r.Episodes !== '1'), 'no row is one episode of a longer request');
  const bluey2 = rows[0];
  ok(bluey2.Episodes === '10' && bluey2.Done === '1' && bluey2.Running === '2' && bluey2.Waiting === '7' && bluey2.Failed === '0',
    `the running season: 10 episodes, 1 done, 2 in hand, 7 waiting (its retried E2 among them), none failed (${['Episodes', 'Done', 'Running', 'Waiting', 'Failed'].map((k) => bluey2[k]).join('/')})`);
  ok(bluey2['Current episode'] === '3, 4' && bluey2.Stage === 'converting' && bluey2['Progress %'] === '42',
    `the episodes in hand, and the stage of the one furthest along (${bluey2['Current episode']}, ${bluey2.Stage}, ${bluey2['Progress %']}%)`);
  ok(/S02E03 converting/.test(bluey2.Detail) && /S02E04 downloading/.test(bluey2.Detail), `each in hand, doing what: "${bluey2.Detail}"`);
  ok(bluey2.Requester === 'Avi' && bluey2['Requester number'] === '+15557654321' && bluey2.Place === '', 'who asked; running, so no place');
  const mig = rows[1];
  ok(mig.Stage === 'waiting for a slot' && /next to convert/.test(mig.Detail) && mig['Requester number'] === '+15551234567',
    `the film in line for the encoder: "${mig.Stage}", "${mig.Detail}"`);
  ok(rows[2].Requester === `'=HYPERLINK("http://x")`, 'a formula-shaped name is neutralised');
  ok(rows[4].Episodes === '8' && rows[4].Waiting === '8' && /beta test/.test(rows[4].Detail) && rows[4].Requester === 'שרה', 'a beta request of 8, not started');
  ok(rows[5].Episodes === '2' && /resumed after a restart/.test(rows[5].Detail), 'a request resumed after a restart says so');
  const loki2 = rows[7];
  ok(loki2.Episodes === '3' && loki2.Done === '2' && loki2.Failed === '0' && loki2['Skipped or cancelled'] === '1',
    `a finished season: 3 episodes, 2 sent - the one that failed and was retried counts once, as sent - 1 skipped (${['Episodes', 'Done', 'Failed', 'Skipped or cancelled'].map((k) => loki2[k]).join('/')})`);
  ok(rows[8].Error === 'ffmpeg exited 1' && rows[6].Episodes === '1' && rows[6].Done === '1', 'a failed film keeps its error; a lone episode is one of one');
  const adds = rows.filter((r) => r.Kind === 'TV').every((r) => ['Done', 'Running', 'Waiting', 'Failed', 'Skipped or cancelled']
    .reduce((a, k) => a + Number(r[k]), 0) === Number(r.Episodes));
  ok(adds, 'on every TV row the counts add up to its episodes');
  ok(rows.every((r) => !r.Added || /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(r.Added)), 'every time YYYY-MM-DD HH:mm');

  p.h.renderQueue(snap);
  const transfers = records((await p.csv.csvFor(cardOf(p.document, '#transfer-history'))).text).filter((r) => r.State === 'in progress');
  ok(transfers.map((r) => r.Title).join(' | ') === 'Bluey S02E03 | Bluey S02E04 | Migration (2023)',
    `Transfers, a row per file: the season's two episodes in hand, then the film (${transfers.map((r) => r.Title).join(' | ')})`);
  for (const r of running.values()) r.resolve();
  await settleAll();
}

console.log('=== the history: ALL of it, not the page on screen ===');
{
  const all = historyRows(95, 30);
  const p = loadPanel({ routes: { '/history': all } });
  await p.h.loadHistory();
  const shown = p.document.querySelectorAll('#history-list .item').length;
  ok(shown === 40, `the Movies pane draws ${shown} rows (HIST_PAGE)`);
  const out = await p.csv.csvFor(cardOf(p.document, '#history-list'));
  const rows = records(out.text);
  ok(rows.length === 125, `the file has all 125 requests, movies and TV together (${rows.length})`);
  ok(/^history-/.test(out.filename), `named ${out.filename}`);
  const tv = rows.find((r) => r.Kind === 'TV');
  ok(tv && tv.Season === '3' && tv.Episodes === '10' && tv.Detail === '10 episode(s) posted', 'a TV request: its season and episode count, one row');
  const m = rows.find((r) => r.Title === 'Film 0');
  ok(m.Time === '2026-09-25 16:05' && m['Requester number'] === '+15550000000', 'the time on the 24-hour clock; the number as +digits');
  ok(m['Nudity check'] === 'no nudity' && /Gemini/.test(m['Checked by']) && m['Download (s)'] === '95', 'the nudity check and the timings');
  ok(rows.filter((r) => r.Kind === 'Movie').length === 95, 'every movie, however far the pane was paged');

  const dash = records((await p.csv.csvFor(cardOf(p.document, '#dash-history'))).text);
  ok(dash.length === 125, 'the Dashboard\'s Recent requests mirror exports the same full list, not its six');

  // Asked for afresh at export time, so a request that came in since the tab
  // was loaded is in the file; if the server cannot answer, what was loaded.
  let answers = 0;
  const later = [{ id: 'new', kind: 'movie', at: T0 + MIN, request: 'wonka', title: 'Wonka', year: 2023, status: 'queued' }, ...all];
  const q = loadPanel({ routes: { '/history': () => {
    answers += 1;
    if (answers === 1) return all;
    if (answers === 2) return later;
    throw Object.assign(new Error('the bot is restarting'), { status: 503 });
  } } });
  await q.h.loadHistory();
  const fresh = records((await q.csv.csvFor(cardOf(q.document, '#history-list'))).text);
  ok(fresh.length === 126 && fresh[0].Title === 'Wonka', 'fetched fresh: the request made since the tab loaded is in it');
  const stale = await q.csv.csvFor(cardOf(q.document, '#history-list'));
  ok(records(stale.text).length === 125 && /bot is restarting/.test(stale.note), 'and with the server away, the 125 the page loaded, saying so');
}

console.log('=== the member list: every member, not its 100-row pages ===');
{
  const many = [...ROSTER, ...Array.from({ length: 150 }, (_, i) => ({ key: `num:1555999${String(i).padStart(4, '0')}`, id: `${i}@lid`,
    number: `1555999${String(i).padStart(4, '0')}`, name: `M${i}`, groups: [{ jid: 'g1@g.us', subject: 'Movies', admin: null }],
    groupCount: 1, adminCount: 0, msgCount: i, firstSeen: T0, lastSeen: T0 }))];
  const p = loadPanel({ routes: { '/members': { members: many } } });
  await p.h.loadMembersRoster();
  ok(p.document.querySelectorAll('#mr-list .item').length === 100, 'the list draws 100');
  const rows = records((await p.csv.csvFor(cardOf(p.document, '#mr-list'))).text);
  ok(rows.length === 152, `the file has all 152 (${rows.length})`);
  const dana = rows.find((r) => r.Name === 'Dana');
  ok(dana['Admin in'] === 'Movies' && dana['Member of'] === 'Movies; סרטים' && dana.Number === '+15551230001', 'with where each one is an admin, and every group');
  p.document.getElementById('mr-filter').value = 'dana';
  ok(records((await p.csv.csvFor(cardOf(p.document, '#mr-list'))).text).length === 1, 'a search typed into the box narrows the file too');
}

console.log('=== the log: the lines shown, with seconds ===');
{
  const lines = [
    { ts: T0, level: 'info', scope: 'queue', msg: 'queued Migration (2023)' },
    { ts: T0 + 1000, level: 'error', scope: 'jellyfin', msg: `GET /Items?api_key=${SECRETS.logKey} failed` },
    { ts: T0 + 2000, level: 'debug', scope: 'ai', msg: `Authorization: Bearer ${SECRETS.bearer}` },
  ];
  const p = loadPanel({ routes: { '/logs': lines } });
  await p.h.loadLogs();
  let rows = records((await p.csv.csvFor(cardOf(p.document, '#log-out'))).text);
  ok(rows.length === 3 && rows[0].Time === '2026-09-25 16:05:09' && rows[0].Scope === 'queue', 'every line, with its time to the second');
  p.document.getElementById('log-level').value = 'error';
  rows = records((await p.csv.csvFor(cardOf(p.document, '#log-out'))).text);
  ok(rows.length === 1 && rows[0].Level === 'error', 'the level filter on the card applies to the file');
  ok(!rows[0].Message.includes(SECRETS.logKey) && rows[0].Message.includes(MASK), 'and a key in a logged URL is masked');
  const dash = records((await p.csv.csvFor(cardOf(p.document, '#dash-log'))).text);
  ok(dash.length === 3, 'the Dashboard mirror exports every line the page holds');
}

console.log('=== settings cards: setting name and value ===');
{
  const p = loadPanel();
  await p.h.loadConfig();
  await settleAll();
  const panelCard = [...p.document.querySelectorAll('#tab-settings .card')].find((c) => c.querySelector('h2')?.textContent.trim() === 'Control panel');
  const out = await p.csv.csvFor(panelCard);
  const [head] = parseCsv(out.text);
  ok(head[0] === 'Setting' && head[1] === 'Value', `columns: ${head.join(', ')}`);
  const rows = records(out.text);
  const get = (name) => rows.find((r) => r.Setting.startsWith(name))?.Value;
  ok(get('Port') === String(DEFAULT_CONFIG.web.port), `Port = ${get('Port')}`);
  ok(get('Log level') === DEFAULT_CONFIG.logging.level, `Log level = ${get('Log level')}`);
  ok(/^control-panel-/.test(out.filename), `named ${out.filename}`);

  const files = records((await p.csv.csvFor(cardOf(p.document, '#f-strategy'))).text);
  ok(files.find((r) => r.Setting === 'Strategy')?.Value === 'Auto — copy when it fits, re-encode when it doesn\'t',
    'a dropdown is written as what it says, not its internal value');

  const tvCard = cardOf(p.document, '#f-tv-enabled');
  const tvRows = records((await p.csv.csvFor(tvCard)).text);
  ok(tvRows.some((r) => r.Setting === 'Enable the TV section' && /^(yes|no)$/.test(r.Value)), 'a tick box is yes or no');

  const reactions = records((await p.csv.csvFor(cardOf(p.document, '#r-researching'))).text);
  const researching = reactions.find((r) => r.Setting === 'Researching');
  ok(researching && researching.Value === DEFAULT_CONFIG.movieRequests.reactions.researching && researching.Part === 'Reactions — live lifecycle',
    `an emoji setting, under its sub-heading: ${researching?.Part} / ${researching?.Setting} = ${researching?.Value}`);

  const idle = records((await p.csv.csvFor(cardOf(p.document, '#my-idle'))).text);
  ok(idle.length >= 1, 'a card with no fields (Sign-out timeout) still exports what it says');
}

console.log('=== the other data cards export their data ===');
{
  const status = { enabled: true, locked: false, label: 'Shabbos',
    upcoming: [{ lockAt: '2026-10-02T22:21:00.000Z', unlockAt: '2026-10-03T16:45:00.000Z', label: 'Shabbos', yomTov: false, nyHolyUntil: '2026-10-03T23:30:00.000Z' }] };
  const p = loadPanel({ routes: {
    '/lockdown/status': status,
    '/audit': (url) => {
      const off = Number(new URL(url, 'http://x').searchParams.get('offset')) || 0;
      const total = 2300;
      const events = Array.from({ length: Math.max(0, Math.min(1000, total - off)) }, (_, i) => ({ ts: T0 - (off + i) * MIN, user: 'mommy', role: 'superadmin', action: `did ${off + i}`, detail: null }));
      return { events, total, counts: {}, categories: [] };
    },
    '/library-misses': { misses: [{ kind: 'tv', title: 'American Dad!', season: 5, request: 'american dad season 5', reason: 'empty-season', count: 3, requesters: ['Avi', 'Dana'],
      firstAt: T0 - 86400000, lastAt: T0, diagnostics: ['search found 2 entries', 'picked the empty one'] }], counts: { all: 1 }, reasons: { 'empty-season': 'Show found, that season empty' } },
    '/wanted': {
      wanted: [{ title: 'The Fantastic Four: First Steps', year: 2025, imdbId: 'tt10676052', rated: 'PG-13', reason: 'not-in-library', count: 2, firstAt: T0 - MIN, lastAt: T0, requesters: ['Jed'],
        notes: [{ id: 'n1', by: 'mommy', at: T0, text: 'Ordered, due Friday' }, { id: 'n2', by: 'avi', at: T0 + MIN, text: 'Head Admin has it' }] }],
      // Marked resolved on the card (the operator, 2026-10-11): the CSV says by whom and when.
      resolved: [{ title: 'Dune', year: 1984, imdbId: 'tt0087182', rated: 'PG-13', reason: 'not-in-library', count: 1, firstAt: T0 - MIN, lastAt: T0 - MIN,
        requesters: ['Avi'], resolved: { by: 'mommy', at: T0 } }],
    },
    '/transfers': [{ at: T0, title: 'Migration', year: 2023, file: 'Migration (2023).mp4', bytes: 1756122264, action: 'encode', access: 'download', downloadSec: 95, convertSec: 1231, uploadSec: 409, totalSec: 3353, avgBytesPerSec: 20627413, requester: '😄' }],
    '/banned': ['15551234567'],
    '/admins': { admins: [{ username: 'mommy', role: 'superadmin', lastLogin: T0, idleTimeoutMinutes: null }, { username: 'avi', role: 'admin', lastLogin: null, idleTimeoutMinutes: 0 }], defaultIdleMinutes: 15 },
    '/group-activity': [{ ts: T0, action: 'add', targets: [{ number: '15551230001' }], groupName: 'Movies', actorNumber: '15550000001' }],
    '/logs/files': [{ name: 'debug-2026-09-25.log', size: 2048, gzipped: false, mtime: T0 }],
    '/wa/accounts': { accounts: [{ id: 'default', label: 'Main', phoneNumber: '15551230000', active: true, linked: true }] },
  } });
  const rowsOf = async (sel) => records((await p.csv.csvFor(cardOf(p.document, sel))).text);

  const sched = (await rowsOf('#lock-status')).filter((r) => r.Part === 'Schedule');
  ok(sched.length === 1 && sched[0]['Lock (New York)'] === '2026-10-02 18:21' && sched[0]['Unlock (Jerusalem)'] === '2026-10-03 19:45',
    `the lockdown schedule, in New York and Jerusalem time (${sched[0]?.['Lock (New York)']} → ${sched[0]?.['Unlock (Jerusalem)']})`);
  ok(/still Shabbos or yom tov in New York, until 2026-10-03 19:30/.test(sched[0]?.Detail), 'with the note that it reopens during Shabbos in New York');

  const audit = await rowsOf('#audit-list');
  ok(audit.length === 2300, `the audit log: all 2300 matching entries, paged 1000 at a time (${audit.length}), not the 300 drawn`);
  ok(p.requests.filter((r) => r.url.startsWith('/api/audit')).length === 3, 'in three requests');

  const miss = await rowsOf('#miss-list');
  ok(miss[0].Why === 'Show found, that season empty' && miss[0]['What the lookup did'] === 'search found 2 entries | picked the empty one' && miss[0]['Times asked'] === '3',
    'not in the library: why, how often, and what the lookup did');
  const wanted = await rowsOf('#wanted-list');
  ok(wanted[0].Title === 'The Fantastic Four: First Steps' && wanted[0].Why === 'not in the library', 'wanted');
  ok(wanted[0].Resolved === 'no' && wanted[0]['Resolved by'] === '' && wanted[0].Notes === 'mommy 2026-09-25 16:05: Ordered, due Friday | avi 2026-09-25 16:06: Head Admin has it',
    `an open film: not resolved, its notes with who and when (${wanted[0].Notes})`);
  ok(wanted.length === 2 && wanted[1].Title === 'Dune' && wanted[1].Resolved === 'yes' && wanted[1]['Resolved by'] === 'mommy'
    && wanted[1]['Resolved at'] === '2026-09-25 16:05', 'a resolved one too, with who resolved it and when');
  const tr = await rowsOf('#transfer-history');
  ok(tr[0]['Size (bytes)'] === '1756122264' && tr[0].Size === '1.6 GB' && tr[0]['Convert (s)'] === '1231', 'transfers, in bytes and in words');
  const banned = await rowsOf('#banned-list');
  ok(banned[0].Number === '+15551234567', 'banned numbers');
  const admins = await rowsOf('#admins-list');
  ok(admins[0]['Sign-out after'] === 'default (15 min)' && admins[1]['Sign-out after'] === 'never' && admins[1]['Last signed in'] === 'never', 'admins and their sign-out times');
  ok(!Object.keys(admins[0]).some((k) => /pass|hash/i.test(k)), 'and no password column of any kind');
  const act = await rowsOf('#ga-activity');
  ok(act[0]['What happened'] === 'joined/added' && act[0].Who === '+15551230001' && act[0].By === '+15550000001', 'group activity');
  const files = await rowsOf('#logfiles');
  ok(files[0].File === 'debug-2026-09-25.log' && files[0]['Last written'] === '2026-09-25 16:05', 'saved log files');
  const nums = await rowsOf('#wa-accounts');
  ok(nums[0].Name === 'Main' && nums[0]['In use'] === 'yes', 'WhatsApp numbers');
  const guide = await rowsOf('#reaction-guide');
  ok(guide.length === 0 || guide.every((r) => r.Meaning), 'the reactions guide (empty until the config loads)');
}

console.log('=== the lockdown card: whether it is locked and why, its settings, the always-locked groups ===');
{
  // The first version wrote the schedule alone: a file sent to ask "why is
  // the group still locked?" never said that it was, or that it was locked
  // by hand, or which groups stay locked whatever happens.
  const cfg = storedConfig();
  cfg.lockdown = { ...cfg.lockdown, enabled: true, candleMinutes: 18, havdalahMinutes: 50, yomTov: true,
    candleCity: 'new-york', havdalahCity: 'jerusalem', alwaysLocked: ['g2@g.us'] };
  const p = loadPanel({ served: redact(cfg), routes: {
    '/wa/groups': [{ jid: 'g1@g.us', subject: 'Movies', size: 240 }, { jid: 'g2@g.us', subject: 'Announcements', size: 12 }],
    '/lockdown/status': { enabled: true, locked: true, source: 'manual', label: null, inWindow: false,
      nextLockAt: '2026-10-02T22:21:00.000Z', nextUnlockAt: '2026-10-03T16:45:00.000Z',
      upcoming: [{ lockAt: '2026-10-02T22:21:00.000Z', unlockAt: '2026-10-03T16:45:00.000Z', label: 'Shabbos', yomTov: false, nyHolyUntil: null }] },
  } });
  await p.h.loadConfig();
  await p.h.loadGroups();
  await p.h.loadLockdown();
  await settleAll();
  ok(/LOCKED/.test(p.document.querySelector('#lock-status .status-title')?.textContent ?? ''), 'the card says the groups are locked');
  const out = await p.csv.csvFor(cardOf(p.document, '#lock-status'));
  ok(/^group-lockdown-/.test(out.filename), `named ${out.filename}`);
  const rows = records(out.text);
  const find = (part, item) => rows.find((r) => r.Part.startsWith(part) && r.Item.startsWith(item));
  ok(find('Status', 'Groups')?.Value === 'locked' && find('Status', 'Groups')?.Detail === 'by hand', 'the file says they are locked, and by hand');
  ok(find('Status', 'Automatic lockdown')?.Value === 'on', 'and that automatic lockdown is on');
  ok(find('Automatic Shabbos', 'Havdalah (min after sunset)')?.Value === '50' && find('Automatic Shabbos', 'Havdalah (unlock) in')?.Value === 'Jerusalem',
    'the automatic-lockdown settings, as the card has them');
  ok(find('Automatic Shabbos', 'Include yom tov')?.Value === 'yes', 'yom tov included');
  ok(find('Always-locked groups', 'Announcements')?.Value === 'yes' && find('Always-locked groups', 'Movies')?.Value === 'no',
    'which groups are always locked');
  ok(rows.filter((r) => r.Part === 'Schedule').length === 1, 'and the schedule, once - not again as the card\'s own sentence about it');
  ok(!rows.some((r) => r.Part === 'Status' && /Sat|Fri|Sun/.test(r.Detail)), 'the status comes from the data, not the card\'s locale sentence');

  // Locked by the schedule, and opened by hand in the middle of a window.
  for (const [st, value, detail] of [[{ locked: true, source: 'schedule' }, 'locked', 'by the schedule'], [{ locked: false, source: 'manual' }, 'open', 'by hand']]) {
    const q = loadPanel({ served: redact(cfg), routes: { '/wa/groups': [], '/lockdown/status': { enabled: true, inWindow: true, upcoming: [], ...st } } });
    await q.h.loadConfig();
    await q.h.loadLockdown();
    await settleAll();
    const state = records((await q.csv.csvFor(cardOf(q.document, '#lock-status'))).text).find((r) => r.Part === 'Status' && r.Item === 'Groups');
    ok(state?.Value === value && state?.Detail === detail, `${value}, ${detail}: "${state?.Value}", "${state?.Detail}"`);
  }
}

console.log('=== an open group: whether it is admins-only, its description, then its members ===');
{
  const p = loadPanel({ routes: {
    '/wa/groups': [{ jid: 'g1@g.us', subject: 'Movies', size: 240 }],
    '/groups/*': { desc: 'Rules: one film per message', botIsAdmin: true, locked: true, alwaysLocked: true, members: [
      { id: '111@lid', number: '15551230001', admin: 'superadmin' }, { id: '222@lid', number: '15551230002', admin: null }] },
  } });
  await p.h.loadConfig();
  await p.h.loadGroups();
  await p.win.gaOpen('g1@g.us', 'Movies');
  await settleAll();
  const out = await p.csv.csvFor(p.document.getElementById('ga-detail'));
  ok(/^group-movies-/.test(out.filename), `named for the group: ${out.filename}`);
  const rows = records(out.text);
  const about = (item) => rows.find((r) => r.Part === 'Group' && r.Item === item);
  ok(about('Posting')?.Value === 'admins only' && /always-locked/.test(about('Posting')?.Detail), `posting: "${about('Posting')?.Value}", "${about('Posting')?.Detail}"`);
  ok(about('Description')?.Value === 'Rules: one film per message', 'the description');
  ok(/bot is an admin/.test(about('Bot')?.Value ?? ''), `whether the bot can edit it: "${about('Bot')?.Value}"`);
  const members = rows.filter((r) => r.Part === 'Member');
  ok(members.length === 2 && members[0].Role === 'owner' && members[1].Number === '+15551230002', 'and its members');
}

console.log('=== dates read off a card are written YYYY-MM-DD HH:mm, like the rest ===');
{
  // A card with no exporter of its own is read off the page, where the panel
  // wrote its dates with fmtDateTime in the browser's own format, "9/25/2026,
  // 16:05:09" - while the dedicated exporters write "2026-09-25 16:05". A
  // Rated-R override and a content-check warning came out in the first.
  const p = loadPanel({ routes: { '/rating-overrides': { overrides: [
    { key: 'k1', title: 'Deadpool', year: 2016, jellyfinId: 'abc', addedBy: 'mommy', addedAt: T0, note: 'family ok' }] } } });
  await p.h.loadConfig();
  await p.h.loadOverrides();
  await settleAll();
  const shown = new Date(T0).toLocaleString(undefined, { hourCycle: 'h23' });
  ok(p.document.getElementById('ro-list').textContent.includes(shown), `the card shows the override's date the browser's way ("${shown}")`);
  // Request rules is a Settings card, so its rows are Setting / Value.
  const ro = records((await p.csv.csvFor(cardOf(p.document, '#ro-list'))).text).find((r) => /Deadpool/.test(r.Setting));
  ok(ro?.Detail === 'added by mommy · 2026-09-25 16:05 · family ok', `the file has it as 2026-09-25 16:05 ("${ro?.Detail}")`);
  // A title entry carries what it covers and what it matches in the library
  // right now (one list, films and TV alike); both reach the file. Since the
  // operator's "Exact title only" (2026-09-29) it covers that exact name, and
  // the library answers with the one show of that name.
  const pt = loadPanel({ routes: {
    '/rating-overrides': { overrides: [{ key: 't:full metal alchemist|', title: 'full metal alchemist', year: null, addedBy: 'superadmin', addedAt: T0 }] },
    '/rating-overrides/matches': { checked: true, films: true, matches: { 't:full metal alchemist|': { count: 1, items: [
      { name: 'Fullmetal Alchemist', year: 2003, type: 'tv' }] } } },
  } });
  await pt.h.loadConfig();
  await pt.h.loadOverrides();
  await settleAll();
  const fma = records((await pt.csv.csvFor(cardOf(pt.document, '#ro-list'))).text).find((r) => /full metal alchemist/.test(r.Setting));
  ok(fma?.Value === 'by title'
    && fma.Detail === 'Covers: every film and show named exactly “full metal alchemist” | added by superadmin · 2026-09-25 16:05'
      + ' | Matches now: 📺 Fullmetal Alchemist (2003)',
  `a title entry's row has its coverage and its matches ("${fma?.Detail}")`);
  p.h.renderContentHealth({ enabled: true, degraded: true,
    incident: { headline: 'Gemini: bad key', count: 3, since: T0, titles: [{ title: 'Up', year: 2009 }] } });
  const cc = (await p.csv.csvFor(p.document.getElementById('card-cc-health'))).text;
  ok(/3 failed check\(s\) since 2026-09-25 16:05\./.test(cc) && !cc.includes(shown), 'and so is the content-check warning\'s');
  ok(p.csv.isoPanelDates('episode 3/10, 42%, 16:05, 2026') === 'episode 3/10, 42%, 16:05, 2026', 'text that is not a date is left alone');
  const typed = `No requests on ${new Date(2026, 11, 25).toLocaleDateString()} - see you after`;
  p.document.getElementById('f-rules').value = typed;
  const rules = records((await p.csv.csvFor(cardOf(p.document, '#f-rules'))).text).find((r) => r.Setting === 'Rules text');
  ok(rules?.Value === typed, `what a box holds is written as typed, dates and all ("${rules?.Value}")`);

  // Whatever order the browser writes a date in, learned from fmtDateTime
  // itself rather than assumed: the owner's phone need not be en-US.
  const real = { ls: Date.prototype.toLocaleString, lds: Date.prototype.toLocaleDateString, lts: Date.prototype.toLocaleTimeString };
  for (const locale of ['de-DE', 'en-GB', 'he-IL', 'ja-JP', 'fr-CA', 'ar-EG']) {
    Date.prototype.toLocaleString = function toLocaleString(l, o) { return real.ls.call(this, l ?? locale, o); };
    Date.prototype.toLocaleDateString = function toLocaleDateString(l, o) { return real.lds.call(this, l ?? locale, o); };
    Date.prototype.toLocaleTimeString = function toLocaleTimeString(l, o) { return real.lts.call(this, l ?? locale, o); };
    try {
      const q = loadPanel();
      const at = new Date(T0).toLocaleString(undefined, { hourCycle: 'h23' });
      const day = new Date(2026, 0, 5).toLocaleDateString();      // 5 January: day and month tell apart
      const clock = new Date(T0).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      const out = q.csv.isoPanelDates(`at ${at}; ${day}; today ${clock}`, new Date(T0 + 30 * MIN));
      if (locale === 'ar-EG') ok(out === `at ${at}; ${day}; today ${clock}`, `${locale}: digits other than 0-9 are left as they are ("${out}")`);
      else ok(out === 'at 2026-09-25 16:05; 2026-01-05; 2026-09-25 16:05', `${locale}: "${at}", "${day}" and "today ${clock}" -> "${out}"`);
    } finally {
      Date.prototype.toLocaleString = real.ls;
      Date.prototype.toLocaleDateString = real.lds;
      Date.prototype.toLocaleTimeString = real.lts;
    }
  }

  // The other ways a moment reaches a card, each of which names one exactly.
  const c = p.csv;
  const utc = Date.UTC(2026, 8, 25, 20, 5, 9);
  ok(c.isoPanelDates('at 2026-09-25T20:05:09.123Z.') === `at ${c.csvWhen(utc)}.`, `an ISO time from the server, in the browser's time ("${c.csvWhen(utc)}")`);
  ok(c.isoPanelDates('at 2026-09-25T23:05:09+03:00') === `at ${c.csvWhen(utc)}` && c.isoPanelDates('at 2026-09-25T23:05+0300') === `at ${c.csvWhen(utc)}`,
    'with an offset, however it is written');
  ok(c.isoPanelDates('saved 2026-09-25T16:05:09') === 'saved 2026-09-25 16:05', 'without a zone it is local already, and loses only its seconds');
  ok(c.isoPanelDates('2026-09-25 16:05:09 [warn] retry') === '2026-09-25 16:05 [warn] retry', 'as does one written with a space');
  for (const same of ['2026-09-25 16:05', 'on 2026-09-25', 'run 20260928T180002Z', 'backup-2026-09-25T16-05-09.tar', 'at 2026-13-40T25:99:00Z']) {
    ok(c.isoPanelDates(same) === same, `left as it is: "${same}"`);
  }
  const monday = new Date(2026, 8, 28, 0, 10);           // a Monday, ten past midnight
  ok(c.isoPanelDates('last seen today 23:30', monday) === 'last seen 2026-09-27 23:30',
    'fmtWhen\'s "today 23:30", read at 00:10, is the day before: the last 23:30 before now');
  ok(c.isoPanelDates('last seen today 00:05', monday) === 'last seen 2026-09-28 00:05', 'and "today 00:05" is today');
  for (const vague of ['last seen yesterday', 'first seen 3 days ago']) {
    ok(c.isoPanelDates(vague, monday) === vague, `"${vague}" names no minute, and is left as it is`);
  }
  ok(c.isoPanelDates('next lock Fri, Oct 2, 18:21 · unlock Sat, Oct 3, 19:31 (New York time)', monday)
    === 'next lock 2026-10-02 18:21 · unlock 2026-10-03 19:31 (New York time)',
  'the lockdown card\'s New York times, which have no year: the one whose Oct 2 is a Friday');
  ok(c.isoPanelDates('Fri, Jan 1, 18:00', new Date(2026, 11, 28)) === '2027-01-01 18:00', 'across the new year too');
  ok(c.isoPanelDates('Mon, Oct 2, 18:21', monday) === 'Mon, Oct 2, 18:21', 'and one that fits no year near now is left alone');

  // On the page: a card with no exporter of its own showing an ISO time, and
  // the lockdown card read off the page when its exporter cannot reach the
  // scheduler - its times as lockTimeIn() draws them, New York's.
  const g = loadPanel();
  g.document.getElementById('tab-logs').insertAdjacentHTML('beforeend', '<div class="card" id="card-iso"><h2>Backups</h2>'
    + '<div class="list"><div class="item"><span class="item-title">Nightly backup</span><div class="item-sub">written 2026-09-25T20:05:09Z</div></div></div></div>');
  const iso = records((await g.csv.csvFor(g.document.getElementById('card-iso'))).text);
  ok(iso[0]?.Detail === `written ${g.csv.csvWhen(utc)}`, `a card read off the page: "${iso[0]?.Detail}"`);
  const lockAt = Date.now() + 2 * 86400000;
  const unlockAt = lockAt + 25 * 3600000;
  let down = false;
  const lk = loadPanel({ routes: { '/lockdown/status': () => {
    if (down) throw Object.assign(new Error('the scheduler is not running'), { status: 503 });
    return { enabled: true, locked: false, source: 'schedule', inWindow: false, label: 'Shabbos',
      nextLockAt: new Date(lockAt).toISOString(), nextUnlockAt: new Date(unlockAt).toISOString(), upcoming: [] };
  } } });
  await lk.h.loadConfig();
  await lk.h.loadLockdown();
  await settleAll();
  down = true;
  const lockFile = await lk.csv.csvFor(cardOf(lk.document, '#lock-status'));
  const NY = 'America/New_York';
  ok(/the scheduler is not running/.test(lockFile.note) && lockFile.text.includes(`next lock ${lk.csv.csvWhenIn(lockAt, NY)}`)
    && lockFile.text.includes(`unlock ${lk.csv.csvWhenIn(unlockAt, NY)} (New York time)`),
  `read off the page, the lockdown card's New York times are YYYY-MM-DD HH:mm (${lk.csv.csvWhenIn(lockAt, NY)})`);
  ok(!/\b(Sun|Mon|Tue|Wed|Thu|Fri|Sat), [A-Z][a-z]{2} \d/.test(lockFile.text), 'with none left the way lockTimeIn writes them');
}

console.log('=== the Hourly checks card: one CSV control, fed by the card\'s own script ===');
{
  // The Hourly checks card (hourly-checks.js, from the hourly-debug branch)
  // was written with a "Download CSV" button of its own. Merged, the card
  // had that and the one in its heading, saving different files - the first
  // with the browser's date format, lower-case headings and no secret sweep,
  // the second read off a screen that folds a quiet night into one line. The
  // card's script now registers its runs with the shared button instead.
  const at = (h, m = 0) => Date.parse(`2026-09-28T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:02Z`);
  const SHA = 'a'.repeat(40);
  const RUNS = [
    { id: '20260928T180002Z', at: at(18), finishedAt: at(18, 7), result: 'incidents', found: 2, notices: 1, headline: '1 failed request',
      summary: '=HYPERLINK("x") ffmpeg exit 228 is now retried', claude: { outcome: 'finished', detail: null },
      commits: [{ sha: SHA, subject: 'Treat ffmpeg exit 228 as retryable', url: null }], pushedTo: 'main',
      restart: { outcome: 'healthy', words: 'restarted, back and connected', detail: 'running aaaaaaa' },
      refused: [], alerts: [], reruns: ['Annie (1982) for Mia: queued'], userActions: ['Add "Up" to the server'], emailed: true, hasReport: true },
    { id: '20260928T170002Z', at: at(17), result: 'all-clear', found: 0, notices: 0, headline: 'all clear', restart: { outcome: 'not-needed', words: 'not needed' }, emailed: null },
    { id: '20260928T160002Z', at: at(16), result: 'all-clear', found: 0, notices: 0, headline: 'all clear', restart: { outcome: 'not-needed', words: 'not needed' }, emailed: null },
  ];
  let failing = false;
  const asked = [];
  const p = loadPanel({ routes: { '/hourly-checks': (url) => {
    asked.push(url);
    if (failing) throw Object.assign(new Error('data/hourly-debug is unreadable'), { status: 500 });
    return { runs: RUNS, status: { lastRunAt: at(18), overdue: false, runsToday: 3 } };
  } } });
  const card = p.document.getElementById('card-hourly-checks');
  const csvControls = [...card.querySelectorAll('button, a[download]')].filter((el) => el.closest('.card') === card
    && (el.classList.contains('csv-btn') || /csv/i.test(`${el.id} ${el.textContent}`)));
  ok(csvControls.length === 1 && csvControls[0].classList.contains('csv-btn') && csvControls[0].parentElement.tagName === 'H2',
    `exactly one CSV control, the one in its heading (${csvControls.map((b) => b.id || b.className).join(', ')})`);
  ok(p.csv.exporterFor(card)?.slug === 'hourly-checks', 'and it runs the exporter the card\'s own script registered, not the generic one');

  csvControls[0].click();
  await settleAll();
  ok(p.downloads.length === 1 && /^hourly-checks-\d{4}-\d{2}-\d{2}-\d{4}\.csv$/.test(p.downloads[0].filename),
    `one file, named the house way (${p.downloads[0]?.filename})`);
  ok(asked.some((u) => /limit=500/.test(u)), 'every run the server keeps, not the 200 the card draws from');
  const text = p.downloads[0]?.blob?.text ?? '';
  const [head] = parseCsv(text);
  ok(head.join(',') === 'Time,Finished,Result,Found,Noted,What was noted,Headline,Summary,Research,Research detail,Commits,Pushed to,Not shipped,Alerts,Restart,Restart detail,Re-runs,For you to do,Emailed,Report',
    `proper column names: ${head.join(', ')}`);
  const rows = records(text);
  ok(rows.length === 3, `a row per run, the all-clear hours included - the card folds them into one line (${rows.length})`);
  ok(rows[0].Time === p.csv.csvWhen(at(18)) && rows[0].Finished === p.csv.csvWhen(at(18, 7)) && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(rows[0].Time),
    `times YYYY-MM-DD HH:mm, like every other file (${rows[0].Time})`);
  ok(rows[0].Found === '2' && rows[0].Commits === 'aaaaaaa Treat ffmpeg exit 228 as retryable' && rows[0].Restart === 'restarted, back and connected'
    && rows[0].Report === '/api/hourly-checks/20260928T180002Z/report' && rows[0].Emailed === 'yes',
  'what it found, pushed and restarted, and where the report is');
  ok(rows[0].Summary.startsWith("'="), 'through the shared serializer: a formula-shaped summary is neutralised');
  ok(rows[1].Result === 'all-clear' && rows[1].Emailed === 'no' && rows[1].Report === '', 'a quiet hour: no email, no report');

  // The server cannot be read: the runs the card already has, and the toast says so.
  await p.win.__hourlyChecks.load();
  failing = true;
  const fb = await p.csv.csvFor(card);
  ok(records(fb.text).length === 3 && /the runs the card had loaded/.test(fb.note), `falls back to the loaded runs ("${fb.note}")`);
  const none = loadPanel({ routes: { '/hourly-checks': () => { throw Object.assign(new Error('down'), { status: 500 }); } } });
  const bare = await none.csv.csvFor(none.document.getElementById('card-hourly-checks'));
  ok(/what the card shows - down/.test(bare.note), 'with nothing loaded either, it reads the card, as any exporter that fails does');
}

console.log('=== the hook: a card\'s own script hands the shared button its data ===');
{
  const card = '<div class="card" id="card-own"><h2>Later card <span class="pill">ok</span></h2>'
    + '<div id="own-list" class="list"><div class="item"><span class="item-title">18:00 all clear</span></div></div></div>';
  const p = loadPanel();
  p.document.getElementById('tab-logs').insertAdjacentHTML('beforeend', card);
  await settleAll();
  p.flush();
  const shared = ownButtons(p.document.getElementById('card-own'))[0];
  const registered = p.win.panelCsvExporters.push({ sel: '#own-list', slug: 'later-card',
    run: async () => ({ columns: ['Time', 'Result'], rows: [[new Date(T0), 'all clear'], [new Date(T0 + 3600000), '=found 1']] }) });
  ok(registered >= 2, 'window.panelCsvExporters.push() registers an exporter after load');
  shared.click();
  await settleAll();
  ok(p.downloads.length === 1 && /^later-card-\d{4}-\d{2}-\d{2}-\d{4}\.csv$/.test(p.downloads[0].filename),
    `the heading's button uses it, and names the file the house way (${p.downloads[0]?.filename})`);
  const rows = records(p.downloads[0]?.blob?.text ?? '');
  ok(rows.length === 2 && rows[0].Time === '2026-09-25 16:05' && rows[1].Result === "'=found 1", 'through the same serializer: a Date is YYYY-MM-DD HH:mm, formulas neutralised');

  // Pushed before csv-export.js loaded - a script earlier on the page, as hourly-checks.js is.
  const e = loadPanel({ early: [{ sel: '#queue-list', slug: 'my-queue', run: () => ({ columns: ['X'], rows: [['1']] }) }, { sel: '#x' }] });
  const out = await e.csv.csvFor(cardOf(e.document, '#queue-list'));
  ok(/^my-queue-/.test(out.filename) && records(out.text)[0]?.X === '1', 'one pushed before csv-export.js loaded is picked up, and wins over the built-in one');
  ok(typeof e.win.panelCsvExporters.push === 'function', 'and the same push() works from then on');
}

console.log('=== and the cards built from the page\'s own state ===');
{
  const groups = [{ jid: 'g1@g.us', subject: 'Movies', size: 240 }, { jid: 'g2@g.us', subject: 'סרטים', size: 12 }, { jid: 'g3@g.us', subject: '$admins', size: 4, private: true }];
  const p = loadPanel({ routes: {
    '/wa/groups': groups,
    '/groups/*': { desc: '', botIsAdmin: true, locked: false, members: [
      { id: '111@lid', number: '15551230001', admin: 'superadmin' }, { id: '222@lid', number: '15551230002', admin: null }, { id: '333@lid', number: null, admin: 'admin' }] },
    '/members': { members: ROSTER },
    '/members/*': { ...ROSTER[0], perGroup: { 'g1@g.us': { count: 30, lastSeen: T0 } }, banned: false, noTag: true,
      timeline: [{ ts: T0 - 86400000, action: 'joined', groupName: 'Movies', by: '+15550000001' }] },
    '/catalogue': { clean: [{ title: 'Paddington 2', year: 2017, rated: 'PG' }, { title: 'Up', year: 2009, rated: 'PG' }], at: T0, scanned: 2 },
    '/ai/providers': structuredClone(AI_VIEW),
  } });
  await p.h.loadConfig();
  await p.h.loadGroups();
  await p.h.loadCatalogue();
  await p.h.loadMembersRoster();
  await settleAll();
  const rowsOf = async (el) => records((await p.csv.csvFor(el)).text);

  const fic = await rowsOf(p.document.getElementById('card-fresh-install'));
  const want = p.h.freshInstallChecklist({ config: JSON.parse(JSON.stringify(redact(storedConfig()))), role: null });
  ok(fic.length === want.length && fic.every((r) => r.Step && r.Where && /required|optional/.test(r.Needed)), `the fresh-install checklist: all ${fic.length} steps, each with where it lives`);
  const logins = await rowsOf(p.document.getElementById('card-key-logins'));
  ok(logins.length === 4 && logins[0].State === 'signed in as bot' && logins[0]['Set up'] === 'yes', 'the logins kept with their settings, by state only');
  const guide = await rowsOf(p.document.getElementById('card-reactions'));
  ok(guide.length >= 10 && guide.some((r) => r.Reaction === DEFAULT_CONFIG.movieRequests.reactions.done && /posted/.test(r.Meaning)), 'what the reactions mean, emoji and all');
  const cat = await rowsOf(cardOf(p.document, '#cat-list'));
  ok(cat.length === 2 && cat[0].Title === 'Paddington 2' && cat[0].Rating === 'PG', 'the clean-title catalogue');
  p.document.getElementById('cat-search').value = 'up';
  ok((await rowsOf(cardOf(p.document, '#cat-list'))).length === 1, 'filtered as the box is');
  const gl = await rowsOf(cardOf(p.document, '#ga-list'));
  ok(gl.length === 3 && gl[1].Group === 'סרטים' && gl[1].Members === '12' && gl[2].Private === 'yes', 'the groups, Hebrew names intact, the private one marked');

  await p.win.gaOpen('g1@g.us', 'Movies');
  await settleAll();
  const members = (await rowsOf(p.document.getElementById('ga-detail'))).filter((r) => r.Part === 'Member');
  ok(members.length === 3 && members[0].Group === 'Movies' && members[0].Role === 'owner' && members[2].Role === 'admin' && members[1].Number === '+15551230002',
    'an open group: its members and their roles');

  await p.win.openMember('num:15551230001');
  await settleAll();
  p.flush();
  const inner = p.document.querySelector('#mr-detail .card');
  ok(inner && ownButtons(inner).length === 1, 'the member page, built on click, has its button');
  const one = await p.csv.csvFor(inner);
  const mrows = records(one.text);
  ok(/^member-/.test(one.filename) && mrows.some((r) => r.Item === 'Never tagged' && r.Value === 'yes')
    && mrows.some((r) => r.Part === 'Group' && r.Item === 'Movies' && /30 messages/.test(r.Detail))
    && mrows.some((r) => r.Part === 'Joined / left' && r.Value === 'joined'), 'and exports that member: the facts, each group, each join and leave');
  ok(p.requests.some((r) => r.url === '/api/members/num%3A15551230001/detail'), 'asked for by the key the page opened it with');

  const files = await allFiles(p);
  const fellBack = files.filter((f) => /what the card shows/.test(f.note ?? ''));
  ok(fellBack.length === 0, `no card's own exporter failed and fell back${fellBack.length ? ` - ${fellBack.map((f) => `${f.slug}: ${f.note}`).join('; ')}` : ''}`);
}

console.log('=== an exporter that cannot reach the server falls back to the card ===');
{
  const p = loadPanel({ routes: { '/wanted': () => { throw Object.assign(new Error('WhatsApp is not connected'), { status: 503 }); } } });
  p.document.getElementById('wanted-list').innerHTML = '<div class="item compact"><div class="item-top"><span class="item-title">Dune (2021)</span><span class="tag">2x asked</span></div></div>';
  const card = cardOf(p.document, '#wanted-list');
  const out = await p.csv.exportCard(card, ownButtons(card)[0]);
  ok(out && records(out.text).some((r) => r.Item === 'Dune (2021)' && r.Value === '2x asked'), 'the rows on screen are exported instead');
  ok(/WhatsApp is not connected/.test(p.readToast()), `and the toast says why: "${p.readToast()}"`);
  ok(p.downloads.length === 1, 'still a download, not a dead button');

  // A lapsed session is the sign-in screen's business, not a fallback.
  const s = loadPanel({ routes: { '/wanted': () => { throw Object.assign(new Error('expired'), { status: 401 }); } } });
  const card2 = cardOf(s.document, '#wanted-list');
  const r2 = await s.csv.exportCard(card2, ownButtons(card2)[0]);
  ok(r2 === null && s.downloads.length === 0, 'a lapsed session downloads nothing');

  const e = loadPanel({ routes: { '/queue': { active: [], pending: [], history: [] } } });
  const card3 = cardOf(e.document, '#queue-list');
  await e.csv.exportCard(card3, ownButtons(card3)[0]);
  ok(e.downloads.length === 0 && /Nothing to export in Queue/.test(e.readToast()), `an empty queue says so rather than saving an empty file ("${e.readToast()}")`);
}

/* ================================================================== secrets */

/** Fill every box a secret could be typed into, and everything else that could carry one. */
async function everythingSecret(p) {
  await p.h.loadConfig();
  await settleAll();
  const set = (id, v) => { const el = p.document.getElementById(id); if (el) el.value = v; };
  set('f-omdbkey', SECRETS.typedOmdb);                      // typed, not saved
  set('f-gemini-key', SECRETS.typedGemini);
  set('f-pw-cur', SECRETS.pwCur); set('f-pw-new', SECRETS.pwNew); set('f-pw-new2', SECRETS.pwNew);
  set('na-pass', SECRETS.naPass);
  set('f-em-pass', SECRETS.smtp);
  set('f-jf-password', SECRETS.jfPass);
  set('f-jf-key', SECRETS.jfKey);
  set('f-plex-token', SECRETS.plex);
  set('f-http-auth', `Bearer ${SECRETS.httpAuth}`);
  set('jf-url', `https://jf.example/Items/1/Download?api_key=${SECRETS.linkKey}`);
  set('q-jf-url', `https://jf.example/Items/2/Download?api_key=${SECRETS.linkKey}`);
  await p.h.loadAiProviders();
  const groq = p.document.getElementById('ai-groq-key');
  if (groq) groq.value = SECRETS.groqTyped;
  p.h.renderStatus({ state: 'awaiting-qr', qr: SECRETS.qr, pairingCode: SECRETS.pairing, account: { label: 'Main', phoneNumber: '15551230000', linked: false } });
  // A pairing code on screen too, as the connection card draws one.
  p.h.renderStatus({ state: 'awaiting-pairing', qr: SECRETS.qr, pairingCode: SECRETS.pairing, account: { label: 'Main', phoneNumber: '15551230000', linked: false } });
  await settleAll();
}

async function allFiles(p) {
  const out = [];
  for (const card of p.document.querySelectorAll('.card')) {
    try {
      out.push({ card, ...(await p.csv.csvFor(card)) });
    } catch (err) {
      out.push({ card, error: err });
    }
  }
  return out;
}

const leaks = (text) => Object.entries(SECRETS).filter(([, v]) => text.includes(v)).map(([k]) => k);

console.log('=== no secret, saved or typed, lands in any file ===');
{
  const logs = [{ ts: T0, level: 'warn', scope: 'jf', msg: `retry /Items?api_key=${SECRETS.logKey}` }, { ts: T0, level: 'debug', scope: 'ai', msg: `Bearer ${SECRETS.bearer}` }];
  const p = loadPanel({ routes: { '/ai/providers': structuredClone(AI_VIEW), '/logs': logs, '/queue': groupedQueue() } });
  await everythingSecret(p);
  await p.h.loadLogs();
  ok(p.document.getElementById('f-omdbkey').value === SECRETS.typedOmdb, 'a key is typed into the OMDb box and not saved');
  ok(p.document.querySelector('#link-area .pair-code')?.textContent === SECRETS.pairing, 'a pairing code is on screen');

  const files = await allFiles(p);
  const errors = files.filter((f) => f.error);
  ok(errors.length === 0, `every one of ${files.length} cards exported${errors.length ? ` - failed: ${errors.map((f) => f.error.message).join('; ')}` : ''}`);
  const bad = files.filter((f) => f.text && leaks(f.text).length);
  ok(bad.length === 0, `no secret in any of them${bad.length ? ` - ${bad.map((f) => `${f.filename}: ${leaks(f.text).join(', ')}`).join('; ')}` : ''}`);

  const byName = (re) => files.find((f) => re.test(f.filename));
  const omdb = records(byName(/^omdb-/).text);
  ok(omdb.some((r) => /OMDb API key/.test(r.Setting) && r.Value === MASK), 'the OMDb box is written as the mask, the typed key nowhere');
  ok(omdb.some((r) => r.Setting === 'Status' && r.Value === 'saved'), 'next to the card\'s own "saved" pill');
  const pw = records(byName(/^password-/).text);
  ok(pw.length === 3 && pw.every((r) => r.Value === MASK), 'the three password-change boxes: masks only');
  const email = records(byName(/^email-alerts-/).text);
  ok(email.find((r) => r.Setting === 'App password')?.Value === MASK && email.find((r) => r.Setting === 'Email address')?.Value === 'owner@example.com',
    'Email alerts: the app password masked, the address (not a secret) kept');
  const ai = records(byName(/^ai-providers-/).text);
  ok(ai.find((r) => r.Provider === 'Groq')?.['API key'] === MASK && ai.find((r) => r.Provider === 'Cerebras')?.['API key'] === '',
    'AI providers: a saved key is the mask, none is blank - and the key typed into the Groq row is not read at all');
  const conn = byName(/^whatsapp-connection-/);
  ok(conn && !conn.text.includes(SECRETS.pairing) && !conn.text.includes('QRREAL'), 'the connection card leaves the pairing code and QR out');
  // And so does the fallback that reads the card off the screen, which is
  // what that card gets if its own exporter ever fails.
  const connCard = p.document.getElementById('card-conn');
  const onScreen = p.csv.toCsv(...Object.values(p.csv.genericTable(connCard)));
  ok(/Waiting for pairing/.test(onScreen) && !onScreen.includes(SECRETS.pairing), 'read off the page, the card still has no pairing code in it');
  const test = records(byName(/^check-a-jellyfin-link-/).text);
  ok(test.some((r) => r.Value.includes(`api_key=${MASK}`)), 'a Jellyfin link typed into the Test tab keeps its shape, key masked');
}

console.log('=== even a box holding a plaintext secret is written as the mask ===');
{
  // As if the server had sent the config unmasked: every key box holds the
  // real key. Nothing about the export may depend on the server having masked it.
  const p = loadPanel({ served: storedConfig(), routes: { '/ai/providers': structuredClone(AI_VIEW) } });
  await p.h.loadConfig();
  await settleAll();
  ok(p.document.getElementById('f-tmdbkey').value === SECRETS.tmdb, 'the TMDB box holds the real key');
  const files = await allFiles(p);
  const bad = files.filter((f) => f.text && leaks(f.text).length);
  ok(bad.length === 0, `still nothing leaks${bad.length ? ` - ${bad.map((f) => `${f.filename}: ${leaks(f.text).join(', ')}`).join('; ')}` : ''}`);
}

console.log('=== the files carry personal data, and the README says so ===');
{
  // The owner shares these files on purpose, numbers and all, so the numbers
  // stay in (the queue test above checks one); what has to stay true is the
  // warning that goes with them.
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const note = readme.slice(readme.indexOf('**↓ CSV**'), readme.indexOf('**Do not port-forward'));
  ok(note.length > 0 && /personal data/i.test(note), 'the README\'s note on the CSV files says they contain personal data');
  ok(/phone numbers/i.test(note) && /names/i.test(note), 'names and phone numbers, in so many words');
  ok(/on purpose|deliberately/i.test(note), 'and that they are kept on purpose');
  ok(/personal data/i.test(read('csv-export.js').slice(0, 3000)), 'as does the head of csv-export.js, for whoever changes it next');
}

console.log('=== what counts as a secret box ===');
{
  const p = loadPanel();
  const el = (markup) => { const box = p.document.createElement('div'); box.innerHTML = markup; return box.firstElementChild; };
  ok(p.csv.isSecretField(el('<input type="password">')), 'a password box');
  ok(p.csv.isSecretField(el('<input id="f-new-token">')), 'a text box whose id says token');
  ok(p.csv.isSecretField(el('<input id="f-x">'), 'Webhook API key'), 'a text box labelled "API key"');
  ok(p.csv.isSecretField(el('<input id="f-x">'), 'Auth header'), 'a text box labelled "Auth header"');
  ok(!p.csv.isSecretField(el('<select id="f-jf-method"></select>'), 'Sign in with API key'), 'not a dropdown whose choice is "API key"');
  ok(!p.csv.isSecretField(el('<input type="checkbox" id="ak-omdb-remove">'), 'Remove the saved key'), 'not a tick box');
  ok(!p.csv.isSecretField(el('<input id="f-gemini-model">'), 'Model'), 'not the Gemini model name');
  ok(!p.csv.isSecretField(el('<input id="f-em-user">'), 'Email address'), 'not an email address');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
