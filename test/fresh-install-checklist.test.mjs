/* The fresh-install checklist at the top of the Settings tab.
   Run: node test/fresh-install-checklist.test.mjs

   Asked for directly: "add a checklist that links to all the settings needed
   for a fresh install of the bot on a new machine". The bot is rebuilt on new
   machines often, and what a new box needs is spread over seven settings groups
   and three other tabs. A checklist can mislead in a handful of quiet ways, and
   each one is pinned here:

   - a link to an element that is not there, or is on a different tab from the
     one it switches to, sends someone to nothing;
   - a secret reaches the page MASKED, so the mask must read as "set" - and no
     secret, masked or real, may ever be printed into the card;
   - a regular admin must not be sent to the super-admin's Admins tab;
   - the quiet faults must show as faults: a nudity check ticked while Gemini is
     off never runs (content-check.js returns before asking), which is the whole
     reason for the card, and must not read as merely "optional";
   - it must follow saves and the live WhatsApp state with no polling timer,
     because the panel is push-only.

   A review then found four more, each pinned below with its own story: the
   library row stayed red after a Jellyfin sign-in, because that route never
   hands the config back; the number was ticked from the numbers list while a
   pairing code had nowhere to go; lockdown was ticked with nothing
   always-locked, so havdalah would open the admin-only groups; and ffmpeg was
   ticked with no ffprobe, which every send needs first.

   Merged beside the per-admin sign-out timeouts and the sealed backup, two
   more: #f-idle became only the default, so the idle row must count the
   admins who have a time of their own (0 included) instead of promising
   "after 15 min" to everyone; and the footer must name the nightly sealed
   backup, which a machine set up by hand does not get unless it is asked for.

   And since 2026-09-22 the lockdown's two ends can be in different cities -
   New York candle-lighting and Jerusalem havdalah by the operator's choice -
   so its row names both, where it used to promise "New York times".

   And since 2026-09-28 it shows the hourly check. It was built, merged and
   installed nowhere: bootstrap.sh never set it up, and nothing on the page
   said so. The owner's rule is that every box runs it, so a box where it is
   not installed, has stopped, or runs without a Claude token is amber - read
   from the installer's record and the check's own runs, since the bot's
   process cannot look at the crontab.

   It runs the REAL app.js against the REAL index.html in linkedom. Fetch is
   stubbed, and /auth/status is never answered, so the panel's own start-up
   loaders never run and every render here is one the test asked for. */
import fs from 'node:fs';
import { parseHTML } from 'linkedom';
import { DEFAULT_CONFIG, SECRET_PATHS, getPath, setPath } from '../src/config/schema.js';
import { listAccounts, updateAccount } from '../src/core/accounts.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
const storeSrc = fs.readFileSync(new URL('../src/config/store.js', import.meta.url), 'utf8');
const MASK = storeSrc.match(/export const MASK = '([^']+)'/)[1];

/* ------------------------------------------------------------------ fixtures */

// Distinctive, so a leak into the card is unmistakable.
const SECRETS = {
  omdb: 'omdb-REAL-7f3a91', gemini: 'AIza-REAL-gem-55c2', tmdb: 'tmdb-REAL-0b8e',
  jfPass: 'jf-REAL-password', jfToken: 'jf-REAL-token-a1b2', share: 'share-REAL-key-9c9c',
  smtp: 'smtp-REAL-app-pw', session: 'session-REAL-secret',
};

/** What GET /config returns: the same masking as ConfigStore.redacted(). */
function redact(cfg) {
  const out = structuredClone(cfg);
  for (const p of SECRET_PATHS) if (getPath(out, p)) setPath(out, p, MASK);
  out.web.admins = (out.web.admins ?? []).map(({ passwordHash, ...a }) => a);
  delete out.web.sessionSecret;
  return out;
}

/** A brand-new install, as the panel sees it right after the first-run screen. */
function freshConfig() {
  const c = structuredClone(DEFAULT_CONFIG);
  // ConfigStore.load() fills these on first boot, and the first-run screen
  // creates the super-admin, before the panel can show anything at all.
  c.media.workDir = '/srv/whatsapp-bot/data/media';
  c.web.sessionSecret = SECRETS.session;
  c.web.admins = [{ username: 'superadmin', role: 'superadmin', passwordHash: 'scrypt$a', lastLogin: null }];
  return c;
}

/** Every checklist item done. Secrets hold real values until redact(). */
function fullConfig() {
  const c = freshConfig();
  c.web.admins.push({ username: 'david', role: 'admin', passwordHash: 'scrypt$b', lastLogin: null });
  c.whatsapp.accounts = [
    { id: 'default', label: 'Main', phoneNumber: '15551230000' },
    { id: 'spare', label: 'Spare', phoneNumber: '15551239999' },
  ];
  c.whatsapp.activeAccount = 'default';
  c.whatsapp.phoneNumber = '15551230000';
  c.whatsapp.failover.enabled = true;
  Object.assign(c.library.jellyfin, {
    baseUrl: 'http://10.0.0.5:8096', authMethod: 'password', username: 'bot',
    password: SECRETS.jfPass, accessToken: SECRETS.jfToken, userId: 'u1', userName: 'bot',
  });
  c.omdb.apiKey = SECRETS.omdb;
  c.movieRequests.requestGroups = ['111@g.us'];
  c.movieRequests.postsGroup = '222@g.us';
  c.movieRequests.notify.group = '333@g.us';
  c.movieRequests.theatrical.tmdbApiKey = SECRETS.tmdb;
  c.movieRequests.enforcement.enabled = true;
  c.movieRequests.rules = '*Group rules*';
  Object.assign(c.gemini, { enabled: true, apiKey: SECRETS.gemini, contentCheck: true });
  Object.assign(c.tvRequests, { enabled: true, requestGroups: ['444@g.us'], postsGroups: ['555@g.us'] });
  Object.assign(c.directLinks, { enabled: true, groups: ['666@g.us'], apiKey: SECRETS.share });
  c.lockdown.enabled = true;
  c.lockdown.alwaysLocked = ['222@g.us'];
  Object.assign(c.email, { enabled: true, user: 'owner@example.com', appPassword: SECRETS.smtp });
  return c;
}

const CONNECTED = { state: 'connected', me: { id: '15551230000:1@s.whatsapp.net', name: 'Bot' },
  account: { id: 'default', label: 'Main', phoneNumber: '15551230000', linked: true }, groupCount: 6 };
const NUMBERS = [
  { id: 'default', label: 'Main', phoneNumber: '15551230000', active: true, linked: true },
  { id: 'spare', label: 'Spare', phoneNumber: '15551239999', active: false, linked: true },
];

const freshCtx = (role = 'superadmin') => ({ config: redact(freshConfig()), role, status: null,
  accounts: null, admins: null, ffmpeg: null, update: null, hourly: null });
/** What /api/diagnostics says about deploy/auto-update.sh on a healthy box. */
const UPDATED = { installed: true, ranThisStart: true, result: 'up-to-date', reason: 'up to date with origin/main at 6649996',
  checkedAt: '2026-09-23T20:21:30.000Z', branch: 'origin/main', head: '6649996'.padEnd(40, '0'), from: null, to: null,
  commits: 0, trial: null, rejected: null };
/** What /api/diagnostics says about the hourly check on a box where it runs. */
const HOURLY_NOW = Date.parse('2026-09-28T18:10:00Z');
const HOURLY = { skipped: null,
  install: { at: Date.parse('2026-09-28T09:30:00Z'), event: 'install', cron: true, token: true, verify: 'ok' },
  status: { lastRunAt: Date.parse('2026-09-28T18:00:02Z'), overdue: false, lastFoundAt: null, runsToday: 9, claudeReady: 'ready', sudoReady: true },
  lastRun: { at: Date.parse('2026-09-28T18:00:02Z'), result: 'all-clear', found: 0, headline: 'all clear', claude: 'ready', alerts: 0 } };
const fullCtx = (role = 'superadmin') => {
  const config = redact(fullConfig());
  return { config, role, status: CONNECTED, accounts: NUMBERS, admins: config.web.admins,
    ffmpeg: { ffmpeg: true, ffprobe: true }, update: UPDATED, hourly: HOURLY };
};
/** A context built from the full one with the config edited first. */
const tweak = (fn, extra = {}) => {
  const raw = fullConfig();
  fn(raw);
  return { ...fullCtx(), config: redact(raw), ...extra };
};

/* ------------------------------------------------------------------ harness */

function loadPanel({ answer = () => ({}) } = {}) {
  const { document, window } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);

  // linkedom gives <select> a value getter and no setter, and app.js runs in
  // strict mode here, where assigning to it throws. A browser selects the
  // matching option, so do that.
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

  // linkedom does no layout, so scrolling is recorded instead - which is
  // exactly what "the link targets the right element" needs to see. The panel
  // moves the page with window.scrollTo(), to wherever an element will show
  // (scrollToElement in app.js), so each element is given a place of its own
  // far down the page and a scroll is recorded as the element it went to.
  // With no bars and no screen here, that is its place less the 10 px the
  // panel keeps clear above it.
  const scrolled = [];
  const places = new Map();
  window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (!places.has(this)) places.set(this, 100000 + 100 * places.size);
    const top = places.get(this);
    return { top, bottom: top, height: 0, left: 0, right: 0, width: 0, x: 0, y: top };
  };
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() { scrolled.push(this); };
  const scrollTo = (opts) => {
    const y = typeof opts === 'object' ? opts?.top : opts;
    for (const [el, top] of places) if (top - 10 === y) { scrolled.push(el); return; }
  };

  // Fake timers, run in due order: switching tab schedules the jump-nav
  // restore at 30ms and the reveal waits 60ms, and the order is the point.
  let now = 0, seq = 0;
  const timers = new Map();
  const setTimeout = (fn, ms = 0) => { const id = ++seq; timers.set(id, { id, fn, at: now + (Number(ms) || 0) }); return id; };
  const clearTimeout = (id) => { timers.delete(id); };
  const flush = () => {
    for (let n = 0; timers.size && n < 500; n++) {
      const t = [...timers.values()].sort((a, b) => a.at - b.at || a.id - b.id)[0];
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
  // Recorded, not run: the Quick Connect poll is the only interval these
  // tests care about, and they fire it themselves.
  const intervals = [];
  const setInterval = (fn) => { intervals.push(fn); return intervals.length; };
  const requests = [];
  const fetch = async (url, opts = {}) => {
    requests.push(`${opts.method ?? 'GET'} ${url}`);
    if (url === '/api/auth/status') return new Promise(() => {});
    const body = answer(url, opts);
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body) };
  };
  const win = { document, localStorage, location: { reload() {}, href: '' }, navigator: {},
    scrollTo, addEventListener() {} };
  const exported = ['freshInstallChecklist', 'freshInstallSummary', 'renderFreshInstall', 'renderStatus', 'renderActivity'];
  // eslint-disable-next-line no-new-func
  const make = new Function('window', 'document', 'localStorage', 'fetch', 'EventSource',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'confirm', 'alert', 'prompt',
    'navigator', 'location', `"use strict";\n${app}\n;return { ${exported.join(', ')} };`);
  const h = make(win, document, localStorage, fetch, function EventSource() {},
    setTimeout, clearTimeout, setInterval, () => {}, () => true, () => {}, () => null,
    win.navigator, win.location);
  return { document, win, h, scrolled, flush, requests, intervals };
}

const settle = () => new Promise((r) => setImmediate(r));
/** Enough turns for a click's fetch, its follow-up fetches and their awaits. */
const settleAll = async () => { for (let i = 0; i < 12; i++) await settle(); };
const byId = (items) => Object.fromEntries(items.map((i) => [i.id, i]));

const panel = loadPanel();
const { h } = panel;
ok(typeof h.freshInstallChecklist === 'function', 'the real app.js loads in a real DOM and exposes the checklist');

/* ------------------------------------------------------------------ targets */

console.log('=== every link lands on a real element, on the tab it switches to ===');
{
  // Walk the checklist through every state that changes where an item points.
  const variants = [
    freshCtx(), freshCtx('admin'), fullCtx(), fullCtx('admin'),
    ...['password', 'quickconnect', 'apikey'].map((m) => tweak((c) => {
      Object.assign(c.library.jellyfin, { authMethod: m, accessToken: '', apiKey: '' });
    })),
    tweak((c) => { c.library.jellyfin.baseUrl = ''; }),
    tweak((c) => { c.library.provider = 'plex'; }),
    tweak((c) => { c.library.provider = 'plex'; c.library.plex.baseUrl = 'http://p:32400'; }),
    tweak((c) => { c.library.provider = 'plex'; Object.assign(c.library.plex, { baseUrl: 'http://p', token: 'x' }); }),
    tweak((c) => { c.library.provider = 'http'; }),
    tweak((c) => { c.library.provider = 'http'; c.library.http.searchUrl = 'https://h/find'; }),
    tweak((c) => { c.library.provider = 'local'; }),
    tweak((c) => { c.library.provider = 'local'; c.library.local.roots = ['/mnt/a']; }),
    tweak((c) => { c.email.user = ''; }),
    tweak((c) => { c.email.appPassword = ''; }),
    tweak((c) => { c.email.provider = 'custom'; c.email.host = ''; }),
    tweak((c) => { c.plugins.enabled = ['movie-requests']; }),
    tweak((c) => { c.tvRequests.requestGroups = []; }),
    tweak((c) => { c.tvRequests.postsGroups = []; }),
    tweak((c) => { c.directLinks.groups = []; }),
    tweak((c) => { c.directLinks.apiKey = ''; }),
    tweak((c) => { c.directLinks.apiKey = ''; c.directLinks.allowBotKeyFallback = false; }),
    tweak((c) => { c.gemini.enabled = false; }),
    tweak((c) => { c.gemini.apiKey = ''; }),
    tweak((c) => { c.movieRequests.theatrical.enabled = false; }),
    tweak((c) => { c.media.workDir = ''; }),
    tweak((c) => { c.media.maxOutputBytes = 3 * 1024 ** 3; }),
    tweak(() => {}, { accounts: [NUMBERS[0]] }),
    tweak(() => {}, { accounts: [NUMBERS[0], { ...NUMBERS[1], linked: false }] }),
    tweak((c) => { c.whatsapp.failover.enabled = false; }),
    tweak(() => {}, { accounts: null }),
    tweak(() => {}, { status: { state: 'stopped', account: { linked: true } } }),
    tweak((c) => { c.lockdown.alwaysLocked = []; }),
    tweak((c) => { c.lockdown.alwaysLocked = []; c.lockdown.alwaysLockedReviewed = true; }),
    tweak((c) => { c.gemini.apiKey = ''; c.ai.groq.apiKey = 'gsk-x'; c.ai.groq.enabled = false; }),
    tweak((c) => { c.gemini.apiKey = ''; c.ai.mistral.apiKey = 'ms-x'; }),
    tweak((c) => { c.gemini.allowCleanRatedFilms = false; }),
    tweak((c) => { c.ai.gemini.enabled = false; }),
  ];
  const seen = new Map();
  for (const ctx of variants) {
    for (const it of h.freshInstallChecklist(ctx)) seen.set(`${it.tab} ${it.target}`, it);
  }
  const { document } = panel;
  const problems = [];
  for (const it of seen.values()) {
    const el = document.querySelector(it.target);
    const tabBtn = document.querySelector(`.tab[data-tab="${it.tab}"]`);
    if (!tabBtn) { problems.push(`${it.id}: no tab "${it.tab}"`); continue; }
    if (!el) { problems.push(`${it.id}: ${it.target} is not in index.html`); continue; }
    if (el.closest('.panel')?.id !== `tab-${it.tab}`) {
      problems.push(`${it.id}: ${it.target} is on ${el.closest('.panel')?.id}, not tab-${it.tab}`);
    }
    // Settings shows one group at a time, and the link can only open a group
    // the target is actually inside.
    if (it.tab === 'settings' && !el.closest('.settings-group')) {
      problems.push(`${it.id}: ${it.target} is in no settings group, so it could be hidden`);
    }
    if (el.closest('#card-fresh-install')) problems.push(`${it.id}: points back at the checklist itself`);
  }
  ok(seen.size >= 40, `${seen.size} distinct destinations exercised`);
  ok(problems.length === 0, `every one resolves on its own tab${problems.length ? ` — ${problems.join('; ')}` : ''}`);

  const items = h.freshInstallChecklist(fullCtx());
  ok(new Set(items.map((i) => i.id)).size === items.length, 'item ids are unique');
  ok(items.every((i) => i.label && i.why && i.why.length < 140), 'every item has a label and a one-line why');
  ok(items.every((i) => ['done', 'missing', 'optional'].includes(i.status)), 'every status is one of done / missing / optional');
}

console.log('=== the checklist covers what a new machine needs ===');
{
  const ids = h.freshInstallChecklist(fullCtx()).map((i) => i.id);
  const need = ['superadmin', 'admins', 'wa-number', 'wa-linked', 'wa-spares', 'library', 'ffmpeg',
    'files', 'omdb', 'tmdb', 'gemini', 'content-check', 'request-groups', 'posts-group',
    'notify-group', 'blocked-ratings', 'tv', 'enforcement', 'group-rules', 'direct-links',
    'email', 'panel', 'idle', 'lockdown', 'plugins'];
  const missing = need.filter((id) => !ids.includes(id));
  ok(missing.length === 0, `all ${need.length} expected items are listed${missing.length ? ` — missing: ${missing.join(', ')}` : ''}`);
  const req = new Set(h.freshInstallChecklist(fullCtx()).filter((i) => i.required).map((i) => i.id));
  ok(['wa-number', 'wa-linked', 'library', 'omdb', 'request-groups', 'posts-group', 'email'].every((id) => req.has(id)),
    'the number, the link, the library, OMDb, the groups and email alerts are required');
  ok(['wa-spares', 'tmdb', 'gemini', 'content-check', 'tv', 'enforcement', 'group-rules', 'direct-links']
    .every((id) => !req.has(id)), 'spares, TMDB, Gemini, TV, enforcement, rules and direct links are optional');
}

/* ------------------------------------------------------------------ statuses */

console.log('=== a brand-new install ===');
{
  const items = byId(h.freshInstallChecklist(freshCtx()));
  const missing = ['wa-number', 'wa-linked', 'library', 'ffmpeg', 'omdb', 'request-groups', 'posts-group', 'email'];
  const bad = missing.filter((id) => items[id].status !== 'missing');
  ok(bad.length === 0, `the eight things nobody has set yet are marked missing${bad.length ? ` — not: ${bad.join(', ')}` : ''}`);
  const done = ['superadmin', 'files', 'blocked-ratings', 'panel', 'plugins'];
  ok(done.every((id) => items[id].status === 'done'),
    'what the defaults and first boot already cover is done (super-admin, files, ratings, panel, plugins)');
  // Since 2026-10-12 failover, TV, direct links, the lockdown, the film
  // lookup and the nudity check are on by default (the operator's live
  // settings), and each waits without a word until it is given what it
  // needs: a new install is not six faults it never made.
  ok(Object.values(items).filter((i) => !i.required).every((i) => i.status !== 'missing'),
    'no optional feature is flagged: what is on by default waits quietly to be set up');
  const waiting = ['wa-spares', 'tv', 'direct-links', 'lockdown', 'gemini', 'content-check'];
  ok(waiting.every((id) => items[id].status === 'optional'), 'each of those is "not set up", not done');
  ok(/waiting for a TV request group and a posts group/.test(items.tv.note)
    && /waiting for a group/.test(items['direct-links'].note)
    && /nothing is locked until a group is always-locked/.test(items.lockdown.note)
    && /waiting for an API key/.test(items.gemini.note) && /waiting for an API key/.test(items['content-check'].note)
    && /only one number is set up — failover is on/.test(items['wa-spares'].note),
  'and each says it is on and what it is waiting for');
  ok(items.lockdown.target === '#al-sync' && items.gemini.target === '#f-gemini-key' && items.tv.target === '#tv-request-groups',
    'each pointing at what it waits for');
  ok(items.library.target === '#f-jf-url', 'the library link starts at the server address');
  ok(items['wa-linked'].tab === 'dashboard' && items['wa-linked'].target === '#btn-start',
    'the link step points at Link / Connect on the Dashboard');
  ok(/connected/.test(items['request-groups'].note), 'the groups say they need WhatsApp connected before they can load');
  ok(items.ffmpeg.note === 'not checked yet', 'ffmpeg is not claimed either way before diagnostics answer');

  const sum = h.freshInstallSummary(Object.values(items));
  ok(sum.requiredTotal === 13 && sum.requiredDone === 5, `5 of 13 required done (${sum.requiredDone} of ${sum.requiredTotal})`);
  ok(sum.broken === 0, 'nothing is switched on but incomplete');
}

console.log('=== fully configured, with every secret masked ===');
{
  const ctx = fullCtx();
  ok(ctx.config.omdb.apiKey === MASK && ctx.config.library.jellyfin.accessToken === MASK,
    'the fixture really is masked the way GET /config masks it');
  const items = h.freshInstallChecklist(ctx);
  const notDone = items.filter((i) => i.status !== 'done').map((i) => i.id);
  ok(notDone.length === 0, `every item is done${notDone.length ? ` — not: ${notDone.join(', ')}` : ''}`);
  const sum = h.freshInstallSummary(items);
  ok(sum.requiredDone === sum.requiredTotal && sum.optionalDone === sum.optionalTotal, 'the summary agrees');
  const by = byId(items);
  ok(by.library.target === '#btn-test-lib' && /Test connection/.test(by.library.note),
    'a configured library points at Test connection');
  ok(by.email.target === '#btn-em-test' && /Send test email/.test(by.email.note),
    'configured email points at the test-email button');
  ok(by.omdb.target === '#btn-test-omdb', 'a saved OMDb key points at Test key');
}

console.log('=== the mask means "set"; an empty string means "not set" ===');
{
  const withMask = byId(h.freshInstallChecklist(tweak((c) => { c.omdb.apiKey = 'x'; })));
  ok(withMask.omdb.status === 'done', 'a masked OMDb key counts as set');
  const without = byId(h.freshInstallChecklist(tweak((c) => { c.omdb.apiKey = ''; })));
  ok(without.omdb.status === 'missing' && without.omdb.target === '#f-omdbkey', 'an empty one is missing, and links to the field');

  const apikey = byId(h.freshInstallChecklist(tweak((c) => {
    Object.assign(c.library.jellyfin, { authMethod: 'apikey', apiKey: '' });
  })));
  ok(apikey.library.status === 'missing' && apikey.library.target === '#f-jf-key',
    'the sign-in check follows the chosen method: an API-key login needs the API key, not an old token');
  const qc = byId(h.freshInstallChecklist(tweak((c) => {
    Object.assign(c.library.jellyfin, { authMethod: 'quickconnect', accessToken: '' });
  })));
  ok(qc.library.target === '#btn-jf-qc', 'and a Quick Connect install is sent to the Quick Connect button');
}

console.log('=== no secret is ever printed into the card ===');
{
  const { document, h: hh } = loadPanel();
  hh.renderFreshInstall(fullCtx());
  const masked = document.getElementById('card-fresh-install').innerHTML;
  ok(!masked.includes(MASK), 'the mask itself never appears');
  // The page is only ever handed masked values, but the card must not echo a
  // secret field even if it were handed a real one.
  hh.renderFreshInstall({ ...fullCtx(), config: fullConfig() });
  const unmasked = document.getElementById('card-fresh-install').innerHTML;
  const leaked = Object.values(SECRETS).filter((v) => unmasked.includes(v));
  ok(leaked.length === 0, `given real values, none is printed${leaked.length ? ` — leaked: ${leaked.join(', ')}` : ''}`);
  ok(!/scrypt\$/.test(unmasked), 'nor a password hash');
  ok(!/\/api\//.test(app.match(/===================== fresh-install checklist[\s\S]*?\nfunction refreshFreshInstall/)[0]),
    'and the checklist calls no endpoint of its own');
}

console.log('=== a regular admin is not sent to the Admins tab ===');
{
  const items = h.freshInstallChecklist(fullCtx('admin'));
  const ids = items.map((i) => i.id);
  ok(!ids.includes('superadmin') && !ids.includes('admins'), 'no admin-management items');
  ok(!ids.includes('idle'), 'and not the idle sign-out, which is the super-admin’s decision');
  ok(items.every((i) => i.tab !== 'admins'), 'no item switches to the Admins tab');
  const superIds = h.freshInstallChecklist(fullCtx()).map((i) => i.id);
  ok(superIds.length === ids.length + 3, 'everything else is the same list the super-admin sees');

  const { document, h: hh } = loadPanel();
  hh.renderFreshInstall(freshCtx('admin'));
  ok(!document.querySelector('#fic-list [data-goto="admins"]'), 'and the rendered card has no link there');
  ok(/of 12 required done/.test(document.getElementById('fic-summary').textContent),
    'their count leaves the super-admin step out');
}

console.log('=== quiet faults show as faults, not as "optional" ===');
{
  const cc = byId(h.freshInstallChecklist(tweak((c) => { c.gemini.enabled = false; })));
  ok(cc['content-check'].status === 'missing', 'nudity check ticked with Gemini off: flagged, because it never runs');
  ok(cc['content-check'].target === '#f-gemini-on', 'and the link goes to the box that fixes it');
  ok(/Use Gemini/.test(cc['content-check'].note), 'with a note that says why');

  // With a key on another provider and none on Gemini, the chain answers
  // from that provider. Review finding (2026-10-12): Groq, Cerebras and
  // OpenRouter are on and may clear rated films by default, and with only a
  // Groq key saved the real check cleared a film through Groq while these two
  // rows read "switched on with no API key, so it never runs" and "ticked,
  // but there is no Gemini key" - two red faults over a working setup.
  const gem = byId(h.freshInstallChecklist(tweak((c) => { c.gemini.apiKey = ''; c.ai.groq.apiKey = 'gsk-x'; })));
  ok(gem.gemini.status === 'done' && /no Gemini key — Groq answers it/.test(gem.gemini.note),
    `a Groq key alone runs the film lookup: done, and says who answers ("${gem.gemini.note}")`);
  ok(gem['content-check'].status === 'done' && /no Gemini key — Groq answers it/.test(gem['content-check'].note),
    `and the nudity check, Groq being allowed to clear by default ("${gem['content-check'].note}")`);
  const mistral = byId(h.freshInstallChecklist(tweak((c) => { c.gemini.apiKey = ''; c.ai.mistral.apiKey = 'ms-x'; })));
  ok(mistral.gemini.status === 'done' && /Mistral answers it/.test(mistral.gemini.note),
    'a Mistral key alone answers the lookup');
  ok(mistral['content-check'].status === 'missing' && /no other provider allowed to clear rated films/.test(mistral['content-check'].note)
    && mistral['content-check'].target === '#f-gemini-key',
  `but Mistral may not clear a rated film, so the check is never asked: flagged ("${mistral['content-check'].note}")`);
  const keyOff = byId(h.freshInstallChecklist(tweak((c) => { c.gemini.apiKey = ''; c.ai.groq.apiKey = 'gsk-x'; c.ai.groq.enabled = false; })));
  ok(keyOff.gemini.status === 'missing' && keyOff.gemini.target === '#ai-list' && /every AI provider with a key is switched off/.test(keyOff.gemini.note),
    'a key on a provider switched off answers nothing: flagged, pointing at the AI providers card');
  ok(keyOff['content-check'].status === 'missing', 'and so is the check');
  const strict = byId(h.freshInstallChecklist(tweak((c) => { c.gemini.allowCleanRatedFilms = false; })));
  ok(strict['content-check'].status === 'missing' && strict['content-check'].target === '#f-gemini-allowclean'
    && /nothing to clear/.test(strict['content-check'].note),
  'ticked with "Also send rated films" off, the check is never asked (aiCanClear): flagged, pointing at that box');
  const noAi = byId(h.freshInstallChecklist(tweak((c) => { c.gemini.apiKey = ''; })));
  ok(noAi.gemini.status === 'optional' && noAi.gemini.target === '#f-gemini-key' && /waiting for an API key/.test(noAi.gemini.note),
    'but with no AI key at all it is waiting for one, and points at the key');

  const tv = byId(h.freshInstallChecklist(tweak((c) => { c.plugins.enabled = ['movie-requests', 'direct-links']; })));
  ok(tv.tv.status === 'missing' && tv.tv.target === '#f-plugins', 'TV switched on without its plugin is flagged, and points at the plugin list');

  const dl = byId(h.freshInstallChecklist(tweak((c) => {
    c.directLinks.apiKey = ''; c.directLinks.allowBotKeyFallback = false;
  })));
  ok(dl['direct-links'].status === 'missing' && dl['direct-links'].target === '#f-dl-apikey',
    'direct links with no key to publish are flagged');
  const fallback = byId(h.freshInstallChecklist(tweak((c) => { c.directLinks.apiKey = ''; })));
  ok(fallback['direct-links'].status === 'done' && /own Jellyfin key/.test(fallback['direct-links'].note),
    'but falling back to the bot’s own key works, so it is done - with the advice to use a dedicated one');

  const fo = byId(h.freshInstallChecklist(tweak(() => {}, { accounts: [NUMBERS[0], { ...NUMBERS[1], linked: false }] })));
  ok(fo['wa-spares'].status === 'missing' && fo['wa-spares'].target === '#wa-accounts',
    'failover on with no LINKED spare is flagged - it has nothing it can move to');
  // With one number failover stands aside (failover.js, _hasSpare).
  const one = byId(h.freshInstallChecklist(tweak(() => {}, { accounts: [NUMBERS[0]] })));
  ok(one['wa-spares'].status === 'optional' && one['wa-spares'].target === '#acct-label',
    'on with one number it waits for a spare, and points at adding one');

  const tvHalf = byId(h.freshInstallChecklist(tweak((c) => { c.tvRequests.postsGroups = []; })));
  const tvNone = byId(h.freshInstallChecklist(tweak((c) => { c.tvRequests.postsGroups = []; c.tvRequests.requestGroups = []; })));
  ok(tvHalf.tv.status === 'missing' && tvNone.tv.status === 'optional',
    'TV with a request group and no posts group is half set up, and flagged; with neither it is waiting');
  const dlNone = byId(h.freshInstallChecklist(tweak((c) => { c.directLinks.groups = []; })));
  ok(dlNone['direct-links'].status === 'optional', 'direct links with no group ticked answer nothing, and wait');

  // Without the per-number list, "which number is in use" is worked out from
  // the config. An activeAccount naming a number that was since deleted means
  // the first number, as listAccounts() says - not "none", which counted the
  // number in use as its own spare.
  const stale = byId(h.freshInstallChecklist(tweak((c) => {
    c.whatsapp.activeAccount = 'deleted-number';
    c.whatsapp.failover.enabled = false;
  }, { accounts: null })));
  ok(/^1 spare\b/.test(stale['wa-spares'].note),
    `a stale activeAccount does not turn the number in use into a spare ("${stale['wa-spares'].note}")`);

  const big = byId(h.freshInstallChecklist(tweak((c) => { c.media.maxOutputBytes = 3 * 1024 ** 3; })));
  ok(big.files.status === 'missing' && /2 GB/.test(big.files.note), 'a size cap above WhatsApp’s 2 GB limit is flagged');

  const off = byId(h.freshInstallChecklist(tweak((c) => { c.tvRequests.enabled = false; c.lockdown.enabled = false; })));
  ok(off.tv.status === 'optional' && off.lockdown.status === 'optional', 'a feature that is simply off stays optional, not a fault');

  const { document, h: hh } = loadPanel();
  hh.renderFreshInstall(tweak((c) => { c.gemini.enabled = false; c.tvRequests.postsGroups = []; }));
  const sum = document.getElementById('fic-summary').textContent;
  ok(/2 optional features are switched on but incomplete/.test(sum.replace(/\s+/g, ' ')),
    `the summary counts them (content check, TV): "${sum.replace(/\s+/g, ' ').trim()}"`);
  ok(document.querySelector('[data-item="tv"]').classList.contains('fic-opt'),
    'and a broken optional item is styled apart from a missing required one');
}

console.log('=== the WhatsApp step is live state, not config ===');
{
  const at = (status) => byId(h.freshInstallChecklist({ ...fullCtx(), status }))['wa-linked'];
  ok(at(CONNECTED).status === 'done' && at(CONNECTED).target === '#card-conn', 'connected: done');
  ok(at({ state: 'awaiting-pairing', account: { linked: false } }).status === 'missing'
    && /pairing code/.test(at({ state: 'awaiting-pairing' }).note), 'waiting on a pairing code says so');
  ok(/linked, but not connected/.test(at({ state: 'stopped', account: { linked: true } }).note),
    'a linked number that is merely stopped is told apart from a never-linked one');
  ok(/not linked on this machine/.test(at({ state: 'stopped', account: { linked: false } }).note),
    'and a never-linked one says so');
  ok(/waiting for the live/.test(at(null).note), 'before the first push it claims nothing');
}

console.log('=== the WhatsApp number is judged by where a pairing code goes ===');
{
  // Review finding: the step took whichever of whatsapp.phoneNumber and the
  // numbers list had digits. Pairing reads only whatsapp.phoneNumber, and on a
  // new install the Edit the card itself advises filled in only the list, so
  // the step was ticked while Link / Connect failed with "Set your WhatsApp
  // phone number in Settings before linking".
  const NOT_SET = { state: 'error', lastError: 'Set your WhatsApp phone number in Settings before linking.',
    account: { id: 'default', label: 'Main', phoneNumber: '15551230000', linked: false } };
  // Pairing is chosen here: QR has been the default since 2026-10-06.
  const stale = freshConfig();
  stale.whatsapp.loginMethod = 'pairing';
  stale.whatsapp.accounts = [{ id: 'default', label: 'Main', phoneNumber: '15551230000' }];
  const withList = byId(h.freshInstallChecklist({ ...freshCtx(), config: redact(stale),
    accounts: listAccounts(stale, ''), status: NOT_SET }))['wa-number'];
  ok(withList.status === 'missing', 'digits in the numbers list alone do not tick it');
  ok(/pairing code has no number/.test(withList.note) && /Edit/.test(withList.note),
    `and the note says why, and what to press: "${withList.note}"`);
  const statusOnly = byId(h.freshInstallChecklist({ ...freshCtx(), config: redact(stale), status: NOT_SET }))['wa-number'];
  ok(statusOnly.status === 'missing', 'nor do the digits in the live status, before the numbers list has loaded');

  // The same path with accounts.js fixed: the Edit reaches the pairing number.
  const raw = freshConfig();
  raw.whatsapp.loginMethod = 'pairing';
  const { patch } = updateAccount(raw, 'default', { label: 'Main', phoneNumber: '+1 555 123 0000' });
  Object.assign(raw.whatsapp, patch.whatsapp);
  ok(raw.whatsapp.phoneNumber === '15551230000',
    'on a new install, Edit on the only number sets the pairing number too');
  const edited = byId(h.freshInstallChecklist({ ...freshCtx(), config: redact(raw),
    accounts: listAccounts(raw, '') }))['wa-number'];
  ok(edited.status === 'done' && /\+15551230000/.test(edited.note) && /pairing code goes/.test(edited.note),
    `so following the card's own advice ticks it: "${edited.note}"`);

  const other = byId(h.freshInstallChecklist(tweak(c => { c.whatsapp.loginMethod = 'pairing'; }, {
    accounts: [{ ...NUMBERS[0], phoneNumber: '15550009999' }, NUMBERS[1]] })))['wa-number'];
  ok(other.status === 'missing' && /\+15551230000/.test(other.note) && /\+15550009999/.test(other.note),
    'a pairing number that is not the number in use is flagged, naming both');
  const blank = byId(h.freshInstallChecklist(tweak(c => { c.whatsapp.loginMethod = 'pairing'; }, {
    accounts: [{ ...NUMBERS[0], active: false }, { ...NUMBERS[1], phoneNumber: '', active: true }] })))['wa-number'];
  ok(blank.status === 'missing' && /blank/.test(blank.note),
    'and so is switching to a number with no digits, which leaves the old pairing number behind');

  const qr = freshConfig();
  qr.whatsapp.loginMethod = 'qr';
  qr.whatsapp.accounts = [{ id: 'default', label: 'Main', phoneNumber: '15551230000' }];
  const byQr = byId(h.freshInstallChecklist({ ...freshCtx(), config: redact(qr), accounts: listAccounts(qr, '') }))['wa-number'];
  ok(byQr.status === 'done', 'a QR link sends no code, so the numbers list is enough there');
}

console.log('=== lockdown with nothing always-locked is not ticked, and says the schedule waits ===');
{
  // Review finding: havdalah opens every group except the always-locked ones
  // (_runLockdown in bot.js). Switched on with that list empty, the first
  // Motzei Shabbos would open the posts group and every other admin-only
  // group to all members - and the card showed a green tick. Since the
  // lockdown is on by default (2026-10-12) the schedule locks nothing until a
  // group is always-locked (scheduleHeld, lockdown-waits-for-always-locked in
  // live-settings-defaults), so there is no fault left to flag - but the row
  // must still not be ticked, and must say what it waits for.
  const empty = byId(h.freshInstallChecklist(tweak((c) => { c.lockdown.alwaysLocked = []; }))).lockdown;
  ok(empty.status === 'optional', 'switched on with no always-locked group: not done, waiting');
  ok(empty.tab === 'groups' && empty.target === '#al-sync', 'and the link goes to Sync from WhatsApp, which finds them');
  ok(/nothing is locked until/.test(empty.note) && /havdalah would open/.test(empty.note), `with a note that says why: "${empty.note}"`);
  const set = byId(h.freshInstallChecklist(fullCtx())).lockdown;
  ok(set.status === 'done' && /1 group always locked/.test(set.note), `with one kept locked it is done: "${set.note}"`);
  const off = byId(h.freshInstallChecklist(tweak((c) => { c.lockdown.enabled = false; c.lockdown.alwaysLocked = []; }))).lockdown;
  ok(off.status === 'optional', 'and switched off, an empty list is nobody’s problem');
  // A review of the hold found it stopped installs whose groups are all
  // normally open, with nothing to tick: saving the card as it is, or a
  // lockdown switched on before it was the default, is a list looked at.
  const chosen = byId(h.freshInstallChecklist(tweak((c) => { c.lockdown.alwaysLocked = []; c.lockdown.alwaysLockedReviewed = true; }))).lockdown;
  ok(chosen.status === 'done' && chosen.target === '#f-lock-enabled' && /no group always locked: havdalah opens every group/.test(chosen.note),
    `saved with nothing always-locked, it runs, and says what havdalah does: "${chosen.note}"`);
  ok(/or Save the card as it is/.test(empty.note), 'and the waiting note says that a Save of the card is the way to say so');
  ok(/candle-lighting in New York, havdalah in Jerusalem/.test(set.note) && !/New York times/.test(set.why),
    `it names the city each end is measured in: "${set.note}"`);
  const nyny = byId(h.freshInstallChecklist(tweak((c) => { c.lockdown.havdalahCity = 'new-york'; }))).lockdown;
  ok(/candle-lighting in New York, havdalah in New York/.test(nyny.note), 'following the saved setting');
}

console.log('=== ffprobe is checked as well as ffmpeg ===');
{
  // Review finding: every send starts by probing the file with ffprobe, so a
  // box with ffmpeg alone read "installed" and still failed every film.
  const at = (ffmpeg) => byId(h.freshInstallChecklist({ ...fullCtx(), ffmpeg })).ffmpeg;
  ok(at({ ffmpeg: true, ffprobe: false }).status === 'missing' && /^ffprobe missing/.test(at({ ffmpeg: true, ffprobe: false }).note),
    'ffmpeg without ffprobe: missing, and says which');
  ok(/^ffmpeg missing/.test(at({ ffmpeg: false, ffprobe: true }).note), 'ffprobe without ffmpeg: says which');
  ok(/^ffmpeg and ffprobe missing .* they are installed$/.test(at({ ffmpeg: false, ffprobe: false }).note), 'neither: says both');
  ok(at({ ffmpeg: true, ffprobe: true }).status === 'done', 'both: done');
  ok(at(null).status === 'missing' && at(null).note === 'not checked yet', 'not yet known: claims nothing');
}

console.log('=== the update row says whether this box is actually taking updates ===');
{
  // Every box pulls from GitHub before each start (deploy/auto-update.sh), but
  // only if its installed unit runs it. A box that silently stopped taking
  // updates looked exactly like one that was current; this row is the tell.
  const at = (update) => byId(h.freshInstallChecklist({ ...fullCtx(), update }))['auto-update'];
  const row = at(UPDATED);
  ok(row && !row.required && row.tab === 'dashboard' && row.target === '#diag', 'optional, and it points at Diagnostics');
  ok(row.status === 'done' && /up to date at start · on 6649996/.test(row.note), `a current box is done: "${row.note}"`);
  const upd = at({ ...UPDATED, result: 'updated', commits: 3, trial: UPDATED.head });
  ok(upd.status === 'done' && /updated at start, 3 commits/.test(upd.note) && /on trial/.test(upd.note), `an update is done, and says it is on trial: "${upd.note}"`);
  ok(at(null).status === 'optional' && at(null).note === 'not checked yet', 'before diagnostics answer it claims nothing');
  const never = at({ installed: false });
  ok(never.status === 'missing' && /never run on this machine/.test(never.note) && /re-render/.test(never.note),
    `never run: amber, and says how to fix it: "${never.note}"`);
  const stale = at({ ...UPDATED, ranThisStart: false });
  ok(stale.status === 'missing' && /did not run when the bot last started/.test(stale.note),
    'a status file left by an earlier start does not pass for this one — the unit predates the updater');
  for (const [result, word] of [['failed', 'update failed'], ['skipped', 'not updating'], ['rolled-back', 'rolled back']]) {
    const r = at({ ...UPDATED, result, reason: 'the reason' });
    ok(r.status === 'missing' && r.note === `${word}: the reason`, `${result}: amber, with the reason ("${r.note}")`);
  }
  const off = at({ ...UPDATED, result: 'off', reason: 'turned off on this box (AUTO_UPDATE=0)' });
  ok(off.status === 'optional' && /turned off/.test(off.note), 'turned off on purpose is a choice, not a fault');
  const long = at({ ...UPDATED, result: 'failed', reason: 'x'.repeat(400) });
  ok(long.note.length < 220, 'a long reason is cut short');
  ok(h.freshInstallSummary(h.freshInstallChecklist(freshCtx())).requiredTotal === 13, 'and it changes no required count');
}

console.log('=== the hourly check: installed, with a token, and running ===');
{
  const at = (hourly) => byId(h.freshInstallChecklist({ ...fullCtx(), hourly }))['hourly-check'];
  const row = at(HOURLY);
  ok(row && !row.required && row.tab === 'logs' && row.target === '#card-hourly-checks',
    'optional, like the updater, and it points at the Hourly checks card on the Logs tab');
  ok(row.status === 'done' && /on the hour/.test(row.note) && /all clear/.test(row.note), `a box where it runs is done: "${row.note}"`);
  ok(/\b18:00\b/.test(row.note) || /\d\d:\d\d/.test(row.note), 'with the time of the last run, on the 24-hour clock');
  ok(at(null).status === 'optional' && at(null).note === 'not checked yet', 'before diagnostics answer it claims nothing');

  const never = at({ ...HOURLY, install: null, lastRun: null, status: { ...HOURLY.status, lastRunAt: null, overdue: true } });
  ok(never.status === 'missing' && /not installed on this machine/.test(never.note) && /routines\.mjs --fix/.test(never.note),
    `never installed: amber, with the command that installs it ("${never.note}")`);

  const fresh = at({ ...HOURLY, lastRun: null, status: { ...HOURLY.status, lastRunAt: null, overdue: true } });
  ok(fresh.status === 'done' && /installed .*first run at the top of the hour/.test(fresh.note) && /tested/.test(fresh.note),
    `installed with a tested token, no run yet: done, and says when the first is ("${fresh.note}")`);
  const freshNoToken = at({ ...HOURLY, install: { ...HOURLY.install, token: false, verify: 'not-run' }, lastRun: null,
    status: { ...HOURLY.status, lastRunAt: null, overdue: true } });
  ok(freshNoToken.status === 'missing' && /no Claude token/.test(freshNoToken.note) && /--set-token/.test(freshNoToken.note),
    'installed without a token: amber, and says how to add one (never by echoing it into a file)');
  const failedToken = at({ ...HOURLY, install: { ...HOURLY.install, verify: 'failed' }, lastRun: null,
    status: { ...HOURLY.status, lastRunAt: null, overdue: true } });
  ok(failedToken.status === 'missing' && /failed its test/.test(failedToken.note), 'a token that failed its test is amber');

  const noToken = at({ ...HOURLY, lastRun: { ...HOURLY.lastRun, claude: 'no token - run `claude setup-token` and put it in ~/.config/whatsapp-bot/hourly-debug.env' } });
  ok(noToken.status === 'missing' && /no Claude token/.test(noToken.note), `running without a token: amber ("${noToken.note}")`);
  const later = at({ ...HOURLY, install: { ...HOURLY.install, at: HOURLY.lastRun.at + 60_000, event: 'token', token: true },
    lastRun: { ...HOURLY.lastRun, claude: 'no token - run `claude setup-token`' } });
  ok(later.status === 'done', 'a token saved after that run counts: the newer of the two says');

  const sandbox = at({ ...HOURLY, lastRun: { ...HOURLY.lastRun, claude: 'not run: no sandbox - this kernel has no Landlock' } });
  ok(sandbox.status === 'missing' && /research did not run: not run: no sandbox/.test(sandbox.note), 'no sandbox: amber, with why');
  const off = at({ ...HOURLY, lastRun: { ...HOURLY.lastRun, claude: 'off' } });
  ok(off.status === 'done' && /research turned off/.test(off.note), 'research turned off on purpose is a choice, not a fault');

  const stopped = at({ ...HOURLY, status: { ...HOURLY.status, overdue: true } });
  ok(stopped.status === 'missing' && /nothing since/.test(stopped.note) && /--status/.test(stopped.note),
    `a check that stopped running is amber ("${stopped.note}")`);
  const removed = at({ ...HOURLY, install: { ...HOURLY.install, at: HOURLY.lastRun.at + 60_000, event: 'remove', cron: false } });
  ok(removed.status === 'missing' && /taken out of cron/.test(removed.note), 'taken out of cron is amber');
  const found = at({ ...HOURLY, lastRun: { ...HOURLY.lastRun, result: 'incidents', found: 2 } });
  ok(found.status === 'done' && /2 findings/.test(found.note), 'a run with findings is still a running check');
  const alert = at({ ...HOURLY, lastRun: { ...HOURLY.lastRun, result: 'incidents', found: 1, alerts: 1 } });
  ok(/alert/.test(alert.note), 'an alert on the last run is named');
  const skipped = at({ ...HOURLY, skipped: 'runs a second number, checked on bot-box' });
  ok(skipped.status === 'optional' && /does without it: runs a second number/.test(skipped.note),
    'a box told to do without it (routines.mjs --skip) is not flagged, and says why');
  ok(h.freshInstallSummary(h.freshInstallChecklist(freshCtx())).requiredTotal === 13, 'and it changes no required count');
  ok(!/hour12|toLocaleTimeString/.test(app.match(/function describeHourlyCheck[\s\S]*?\n}\n/)[0]),
    'its times go through the panel\'s 24-hour formatter');
}

console.log('=== Now running: a job in line for a slot shows its place, and can be moved up ===');
{
  // Asked for from the live panel: Guardians of the Galaxy and Ready Player
  // One were both downloaded and waiting for the one encoder, with arrows for
  // the Queue card's waiting jobs but none here. (Unrelated to the checklist;
  // it lives here because this suite already loads the real panel in a DOM.)
  const { document, win, h: hh, requests } = loadPanel();
  const job = (id, label, waiting, text) => ({ id, label, kind: 'movie', state: 'running', startedAt: Date.now(),
    meta: { requester: 'bulk re-run (admin)' }, progress: { stage: waiting ? 'wait' : 'convert', text, pct: waiting ? 40 : 51 },
    ...(waiting ? { waiting } : {}) });
  hh.renderActivity({ paused: false, pending: [], history: [], active: [
    job('ava', 'Avengers: Age of Ultron (2015)', null, '22% (4.28x)'),
    job('gotg', 'Guardians of the Galaxy (2014)', { stage: 'convert', position: 2, of: 2 }, 'waiting to convert — another file is encoding'),
    job('rpo', 'Ready Player One (2018)', { stage: 'convert', position: 1, of: 2 }, 'waiting to convert — another file is encoding'),
  ] });
  const cards = [...document.querySelectorAll('#activity .act-job')];
  const titles = cards.map((c) => c.querySelector('.act-title').textContent.split(' (')[0]);
  ok(titles.join(' | ') === 'Avengers: Age of Ultron | Ready Player One | Guardians of the Galaxy',
    `the encoding one first, then the line in the order it will go: ${titles.join(' | ')}`);
  const place = (c) => c.querySelector('[data-line-place]')?.textContent;
  ok(!place(cards[0]) && !cards[0].querySelector('[onclick*="moveJob"]'), 'the one encoding has no place in line and no arrows');
  ok(place(cards[1]) === 'next to convert' && place(cards[2]) === '2nd in line to convert', 'each says where it stands');
  const btns = (c) => [...c.querySelectorAll('[onclick*="moveJob"]')];
  ok(btns(cards[2]).length === 2 && btns(cards[2]).every((b) => !b.hasAttribute('disabled'))
    && /moveJob\('gotg','up'\)/.test(btns(cards[2])[0].getAttribute('onclick'))
    && /moveJob\('gotg','top'\)/.test(btns(cards[2])[1].getAttribute('onclick')),
    'the second in line gets ▲ and ⤒ next');
  ok(btns(cards[1]).length === 2 && btns(cards[1]).every((b) => b.hasAttribute('disabled')), 'the next one gets them too, disabled');
  const steps = (c) => [...c.querySelectorAll('.stage')].map((e) => e.className.replace('stage ', '')).join(',');
  ok(steps(cards[1]) === 'step-done,step-todo,step-todo',
    `waiting to convert, Download shows done rather than every step grey (${steps(cards[1])})`);
  requests.length = 0;
  await win.moveJob('gotg', 'top');
  ok(requests.includes('POST /api/queue/gotg/move'), 'and ⤒ next posts the same move the Queue card uses');
}

console.log('=== the idle row reads the per-admin timeouts, not only the default ===');
{
  // Found integrating the per-admin timeouts: #f-idle is now the default, and
  // the Admins tab can give any account its own, "never" (0) included. The row
  // said "after 15 min idle" regardless. The Admins list reports each account's
  // value as the guard applies it (null for the default); the raw config copy
  // may be hand-edited, so it is judged by the guard's own rule.
  const idleOf = (ctx) => byId(h.freshInstallChecklist(ctx)).idle;
  const plain = idleOf(fullCtx());
  ok(plain.status === 'done' && plain.note === 'after 15 min idle by default', `nobody has their own: "${plain.note}"`);
  const withOwn = (admins) => ({ ...fullCtx(), admins });
  const mixed = idleOf(withOwn([
    { username: 'superadmin', role: 'superadmin', idleTimeoutMinutes: null },
    { username: 'david', role: 'admin', idleTimeoutMinutes: 0 },
    { username: 'mark', role: 'admin', idleTimeoutMinutes: 60 },
  ]));
  ok(/by default · own time for 2 admins \(1 never signed out\)$/.test(mixed.note),
    `two with their own, one of them never: "${mixed.note}"`);
  ok(mixed.status === 'done' && mixed.target === '#f-idle', 'still done, and still lands on #f-idle');
  const raw = idleOf({ ...tweak((c) => {
    c.web.admins[1].idleTimeoutMinutes = '0';
    c.web.admins.push({ username: 'yanky', role: 'admin', passwordHash: 'scrypt$c', idleTimeoutMinutes: 30 });
  }), admins: null });
  ok(/own time for 1 admin$/.test(raw.note), `from the config copy, a "0" string is not "never": "${raw.note}"`);
  const off = idleOf(tweak((c) => { c.web.idleTimeoutMinutes = 0; }));
  ok(off.status === 'optional' && /^off by default/.test(off.note), `the default switched off: "${off.note}"`);
  ok(/Admins tab/.test(plain.why), 'and the why says where a per-admin time is set');
}

console.log('=== the footer names the sealed backup and how to schedule it ===');
{
  const foot = html.match(/<p class="hint fic-foot">([\s\S]*?)<\/p>/)[1];
  ok(/restoring the sealed settings backup/.test(foot) && /tools\/bootstrap\.sh/.test(foot),
    'restoring the sealed backup is bootstrap.sh\'s job');
  ok(/node tools\/backup-secrets\.mjs --set-passphrase --install-cron/.test(foot),
    'and a machine set up by hand is told the command that schedules the nightly one');
  const cli = fs.readFileSync(new URL('../tools/backup-secrets.mjs', import.meta.url), 'utf8');
  ok(/'--set-passphrase', '--install-cron'/.test(cli), 'which are flags the backup tool really takes');
}

/* ------------------------------------------------------------------ clicks */

console.log('=== clicking a row switches tab, opens the group and lands on the field ===');
{
  const { document, h: hh, scrolled, flush } = loadPanel();
  hh.renderFreshInstall(freshCtx());
  const settings = document.getElementById('tab-settings');
  const click = (id) => {
    scrolled.length = 0;
    document.querySelector(`[data-item="${id}"] a.card-link`).click();
    flush();
  };
  const activePanel = () => document.querySelector('.panel.active')?.id;
  const shownGroup = () => [...settings.querySelectorAll('.settings-group')]
    .filter((g) => !g.classList.contains('hidden')).map((g) => g.dataset.group);

  // Start somewhere else, so the switch is real.
  document.querySelector('.tab[data-tab="logs"]').click();
  flush();
  ok(activePanel() === 'tab-logs', 'starting from the Logs tab');

  const omdbCard = document.getElementById('f-omdbkey').closest('.card');
  omdbCard.classList.add('collapsed');
  click('omdb');
  ok(activePanel() === 'tab-settings', 'OMDb: the Settings tab is showing');
  ok(shownGroup().join() === 'api-keys', `only the API keys group is on screen (${shownGroup().join()})`);
  ok(scrolled.includes(document.getElementById('f-omdbkey')), 'the page scrolled to the OMDb key field');
  ok(document.getElementById('f-omdbkey').classList.contains('flash-field'), 'and the field is highlighted');
  ok(!omdbCard.classList.contains('collapsed') && omdbCard.classList.contains('flash'),
    'its card was un-collapsed and flashed');

  // Email is on by default (2026-10-12), so a new install's first gap is the address.
  click('email');
  ok(shownGroup().join() === 'system' && scrolled.includes(document.getElementById('f-em-user')),
    'email: the System group, at the address box');

  click('idle');
  ok(shownGroup().join() === 'system' && document.getElementById('f-idle').classList.contains('flash-field'),
    'idle sign-out: lands on #f-idle');

  click('wa-number');
  ok(shownGroup().join() === 'connection' && scrolled.includes(document.getElementById('wa-accounts')),
    'the number: the Connection group, at the numbers list');

  click('wa-linked');
  ok(activePanel() === 'tab-dashboard' && scrolled.includes(document.getElementById('btn-start')),
    'linking: the Dashboard, at Link / Connect');

  click('admins');
  ok(activePanel() === 'tab-admins' && scrolled.includes(document.getElementById('na-user')),
    'other admins: the Admins tab, at the add-an-admin field');

  // On by default (2026-10-12), so a new install is sent to what it waits for.
  click('lockdown');
  ok(activePanel() === 'tab-groups' && document.getElementById('al-sync').classList.contains('flash-field'),
    'lockdown: the Groups tab, at Sync from WhatsApp');

  click('library');
  ok(activePanel() === 'tab-settings' && shownGroup().join() === 'library-amp-files'
    && scrolled.includes(document.getElementById('f-jf-url')), 'the library: Library & files, at the server address');

  const link = document.querySelector('[data-item="omdb"] a.card-link');
  // Since every key moved into one section, the OMDb row has to name THAT
  // section, not the card the key used to live in. The label is read off the
  // page, so it cannot drift from where the link actually lands.
  ok(/Settings › API keys/.test(link.textContent), `the link names where it goes: "${link.textContent.trim()}"`);

  const foot = document.querySelector('#card-fresh-install .fic-foot a');
  ok(foot?.getAttribute('href') === 'https://github.com/jewishmoviedude/whatsapp-movie-bot/blob/main/docs/server-setup.md'
    && foot.getAttribute('target') === '_blank' && foot.getAttribute('rel') === 'noopener',
    'the footer links the server setup doc in a new tab, without an opener');
  ok(/tools\/bootstrap\.sh/.test(document.querySelector('#card-fresh-install .fic-foot').textContent),
    'and says the server side is tools/bootstrap.sh');

  hh.renderFreshInstall(fullCtx());
  const test = document.querySelector('#fic-summary a.card-link');
  ok(test?.dataset.goto === 'test' && document.querySelector(test.dataset.target),
    'once every required step is done, it points at a dry run in the Test tab');
}

console.log('=== the search box still lands the same way after sharing the reveal ===');
{
  ok(/revealInPage\(hit\.card, hit\.el\)/.test(app), 'gotoHit uses the shared reveal');
  ok((app.match(/classList\.add\('flash-field'\)/g) ?? []).length === 1,
    'there is one copy of the highlight, not two drifting apart');
}

/* ------------------------------------------------------------------ recompute */

console.log('=== it follows a save and the live WhatsApp push, with no polling ===');
{
  const config = redact(freshConfig());
  const { document, h: hh, flush, requests } = loadPanel({
    answer: (url, opts) => (url.startsWith('/api/config') ? config : {}),
  });
  flush();
  ok(/Loading/.test(document.getElementById('fic-list').textContent), 'before any config arrives it says Loading');

  // A save button that PUTs its own slice - not the main Save - proves the
  // refresh hangs off the config round-trip itself, not off one handler.
  document.getElementById('enf-save').click();
  await settle(); await settle();
  flush();
  ok(requests.includes('PUT /api/config'), 'the enforcement save went out');
  const row = () => document.querySelector('[data-item="wa-linked"]');
  ok(row() && row().classList.contains('fic-missing'), 'the checklist rendered from the saved config');

  hh.renderStatus(CONNECTED);
  flush();
  ok(row().classList.contains('fic-done'), 'a pushed "connected" status ticks the WhatsApp step');
  hh.renderStatus({ state: 'stopped', account: { linked: true } });
  flush();
  ok(row().classList.contains('fic-missing') && /not connected/.test(row().textContent),
    'and a drop un-ticks it');

  const section = app.match(/===================== fresh-install checklist[\s\S]*?\nfunction refreshFreshInstall[\s\S]*?\n\}/)[0];
  ok(!/setInterval/.test(section), 'no polling timer in the checklist');
  ok(/url === '\/config' \|\| url\.startsWith\('\/config\?'\)\) refreshFreshInstall\(\)/.test(app),
    'every /config round-trip, including ?allowEmptyGroups=1, refreshes it');
  ok(/FRESH\.accounts = /.test(app) && /FRESH\.admins = /.test(app) && /FRESH\.ffmpeg = /.test(app) && /FRESH\.update = /.test(app),
    'and so do the numbers list, the admins list and diagnostics the page already loads');
}

console.log('=== a Jellyfin sign-in, Quick Connect or Unlink moves the library row without a reload ===');
{
  // Review finding: those three routes store the token on the server and hand
  // back only a name, so the page's config kept the old token. The card said
  // "the bot has not signed in", the admin signed in, the toast said "Signed in
  // as bot" - and the row stayed red until a reload. After Unlink it kept
  // saying "signed in".
  const raw = freshConfig();
  Object.assign(raw.library.jellyfin, { baseUrl: 'http://10.0.0.5:8096', username: 'bot' });
  const signIn = (token, userId, userName) => Object.assign(raw.library.jellyfin, { accessToken: token, userId, userName });
  const { document, flush, requests, intervals } = loadPanel({
    answer: (url) => {
      if (url.startsWith('/api/config')) return redact(raw);
      if (url === '/api/jellyfin/link/password') { signIn(SECRETS.jfToken, 'u1', 'bot'); return { ok: true, userName: 'bot', userId: 'u1' }; }
      if (url === '/api/jellyfin/status') {
        return { authMethod: 'password', linked: !!raw.library.jellyfin.accessToken, userName: raw.library.jellyfin.userName || null };
      }
      if (url === '/api/jellyfin/unlink') { signIn('', '', ''); return { ok: true }; }
      if (url === '/api/jellyfin/quickconnect/start') return { ok: true, id: 'q1', code: '123456' };
      if (url.startsWith('/api/jellyfin/quickconnect/poll')) { signIn('qc-REAL-token', 'u2', 'qc'); return { ok: true, authenticated: true, userName: 'qc' }; }
      return {};
    },
  });
  const row = () => document.querySelector('[data-item="library"]');
  document.getElementById('enf-save').click();       // any /config round-trip loads the page's copy
  await settleAll(); flush();
  ok(row().classList.contains('fic-missing') && /not signed in/.test(row().textContent)
    && row().querySelector('a.card-link').dataset.target === '#btn-jf-login',
  'before: server set, not signed in, and the row points at Sign in');

  document.getElementById('f-libprovider').value = 'jellyfin';
  document.getElementById('f-jf-url').value = 'http://10.0.0.5:8096';
  document.getElementById('btn-jf-login').click();
  await settleAll(); flush();
  ok(requests.lastIndexOf('GET /api/config') > requests.indexOf('POST /api/jellyfin/link/password'),
    'the sign-in is followed by a re-read of the config');
  ok(row().classList.contains('fic-done') && /signed in as bot/.test(row().textContent),
    `after signing in the row is done: "${row().querySelector('.fic-note')?.textContent}"`);
  ok(document.getElementById('f-jf-user').value === 'u1',
    'and the hidden user id is brought in step, so the next Save does not blank it');
  ok(!document.getElementById('card-fresh-install').innerHTML.includes(SECRETS.jfToken), 'the token is not printed');

  const unlink = document.getElementById('btn-jf-unlink');
  ok(!!unlink, 'the Jellyfin status offers Unlink');
  unlink?.click();
  await settleAll(); flush();
  ok(row().classList.contains('fic-missing') && /not signed in/.test(row().textContent),
    'after Unlink the row is back to not signed in');
  ok(document.getElementById('f-jf-user').value === '', 'and the hidden user id is cleared with it');

  const before = intervals.length;
  document.getElementById('btn-jf-qc').click();
  await settleAll();
  ok(intervals.length === before + 1, 'Quick Connect starts polling for approval');
  intervals[before]?.();
  await settleAll(); flush();
  ok(row().classList.contains('fic-done') && /signed in as qc/.test(row().textContent),
    'and once it is approved the row is done');
}

console.log('=== switching number re-reads the pairing number, and says it switched ===');
{
  // Review finding: after a switch the page's whatsapp.phoneNumber was stale,
  // so the card named the old number. Found on the way: the handler then
  // called loadStatus?.(), a function that never existed - `?.` does not save
  // an undeclared name, so it threw, and "switched" was replaced on screen by
  // "loadStatus is not defined".
  const raw = fullConfig();
  let accounts = NUMBERS;
  const { document, win, flush, requests } = loadPanel({
    answer: (url) => {
      if (url.startsWith('/api/config')) return redact(raw);
      if (url === '/api/wa/accounts/spare/activate') {
        Object.assign(raw.whatsapp, { activeAccount: 'spare', phoneNumber: '15551239999' });
        accounts = NUMBERS.map((a) => ({ ...a, active: a.id === 'spare' }));
        return { ok: true, linked: true };
      }
      if (url === '/api/wa/accounts') return { accounts };
      return {};
    },
  });
  document.getElementById('enf-save').click();
  await settleAll(); flush();
  await win.switchAccount('spare', { skipConfirm: true });
  await settleAll(); flush();
  const note = document.getElementById('acct-note').textContent;
  ok(/switched/.test(note) && !/not defined/.test(note), `the switch reports itself: "${note}"`);
  ok(requests.lastIndexOf('GET /api/config') > requests.indexOf('POST /api/wa/accounts/spare/activate'),
    'and the config is re-read after it');
  const wa = document.querySelector('[data-item="wa-number"]');
  ok(wa.classList.contains('fic-done') && /\+15551239999/.test(wa.textContent),
    `the card names the number now in use: "${wa.querySelector('.fic-note')?.textContent}"`);
  const chosen = document.querySelector('#f-phone option[selected]');
  ok(chosen?.value === '15551239999', 'and so does the Connection dropdown');
}

console.log('=== diagnostics feed both tools to the card, and show both ===');
{
  const { document, flush } = loadPanel({
    answer: (url) => (url.startsWith('/api/config') ? redact(fullConfig())
      : url === '/api/diagnostics' ? { ffmpeg: { ffmpeg: true, ffprobe: false }, node: 'v20', uptimeSec: 1,
        memory: { rssHuman: '1 MB' }, disk: { freeHuman: '1 GB' }, maxOutput: '1.9 GB', workDir: '/w', plugins: [] }
        : {}),
  });
  document.getElementById('enf-save').click();
  await settleAll(); flush();
  document.getElementById('btn-diag').click();
  await settleAll(); flush();
  const ff = document.querySelector('[data-item="ffmpeg"]');
  ok(ff.classList.contains('fic-missing') && /ffprobe missing/.test(ff.textContent),
    'a box with ffmpeg but no ffprobe is flagged');
  ok(/ffprobe\s*MISSING/.test(document.getElementById('diag').textContent),
    'and the diagnostics card the row links to says so too');
  ok(/code\s*unknown/.test(document.getElementById('diag').textContent) && /updates\s*not checked yet/.test(document.getElementById('diag').textContent),
    'a server too old to report the code or its updates shows "unknown", not an error');
}

console.log('=== diagnostics show the running commit and the last update ===');
{
  const { document, flush } = loadPanel({
    answer: (url) => (url.startsWith('/api/config') ? redact(fullConfig())
      : url === '/api/diagnostics' ? { ffmpeg: { ffmpeg: true, ffprobe: true }, node: 'v20', uptimeSec: 1,
        memory: { rssHuman: '1 MB' }, disk: { freeHuman: '1 GB' }, maxOutput: '1.9 GB', workDir: '/w', plugins: [],
        code: { commit: 'abcdef1'.padEnd(40, '0') },
        autoUpdate: { ...UPDATED, result: 'failed', reason: 'could not fetch origin/main after 4 attempts' },
        hourlyCheck: { ...HOURLY, install: null, lastRun: null, status: { ...HOURLY.status, lastRunAt: null, overdue: true } } }
        : {}),
  });
  document.getElementById('enf-save').click();
  await settleAll(); flush();
  document.getElementById('btn-diag').click();
  await settleAll(); flush();
  const diag = document.getElementById('diag').textContent;
  ok(/code\s*abcdef1/.test(diag), 'the commit it is running');
  ok(/updates\s*update failed: could not fetch/.test(diag), 'and why the last update did not happen');
  const row = document.querySelector('[data-item="auto-update"]');
  ok(row?.classList.contains('fic-missing'), 'the checklist row turns amber from the same answer');
  ok(/hourly check\s*not installed on this machine/.test(diag), 'the hourly check has a line of its own');
  ok(document.querySelector('[data-item="hourly-check"]')?.classList.contains('fic-missing'),
    'and its checklist row turns amber from the same answer');
}

console.log('=== markup and styles ===');
{
  const settings = html.match(/<section class="panel" id="tab-settings">([\s\S]*?)<\/section>/)[1];
  const before = settings.split('id="card-fresh-install"')[0];
  // `before` ends with this card's own opening tag, so exactly one card tag.
  ok((before.match(/<div class="card"/g) ?? []).length === 1, 'the card is the first thing in the Settings tab');
  ok(!/class="settings-group/.test(before),
    'and comes before every settings group, so it is inside none and shows whichever is selected');
  const css = fs.readFileSync(new URL('../src/web/public/style.css', import.meta.url), 'utf8');
  ok(/\.fic-done \.fic-mark/.test(css) && /\.fic-missing \.fic-mark/.test(css) && /\.fic-optional \.fic-mark/.test(css),
    'each of the three marks is styled');
  ok(/\.fic-item \{[^}]*flex-wrap: wrap/.test(css), 'rows wrap, so a phone does not scroll sideways');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
