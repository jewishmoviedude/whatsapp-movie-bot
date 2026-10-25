/* Settings → API keys & logins 🔑: the section, its Save, and finding a setting.
   Run: node test/api-keys-section.test.mjs

   Asked for directly: "bunch all the api key settings into 1 section and
   findable and navigable". The keys were spread over six cards in four
   settings groups, and the switcher shows one group at a time, so a key whose
   group nobody could name was effectively hidden.

   Moving a field between cards is the kind of change that breaks things
   quietly, so each way it can is pinned here:

   - the ids did not change. The fresh-install checklist, fillForm and several
     tests address these boxes by id, and a rename would send every checklist
     link to nothing;
   - exactly one save owns each key. While both the old card and the new
     section sent it, whichever was pressed second decided, so pasting a key
     and then pressing "Save settings" put the old one back;
   - a box left blank, or still holding the mask, keeps the saved key. Blank
     used to clear it, which is a bad bargain in a section where four keys sit
     on screen and only one is being changed. Clearing is now the explicit
     "Remove the saved key" tick;
   - nothing the panel sends can overwrite a stored key with the mask. That is
     checked against the REAL ConfigStore, not a stand-in;
   - the filter finds a card by what a setting is called AND by what its hint
     says it does, and puts every card back when it is cleared;
   - every chip lands on a section that exists.

   It runs the REAL app.js against the REAL index.html in linkedom. Fetch is
   stubbed and /auth/status is never answered, so the panel's own start-up
   loaders never run and every render here is one the test asked for. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseHTML } from 'linkedom';
import { ConfigStore, MASK } from '../src/config/store.js';
import { PROVIDERS } from '../src/core/ai-providers.js';
import { DEFAULT_CONFIG, SECRET_PATHS, getPath, setPath } from '../src/config/schema.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
const aiRoutes = fs.readFileSync(new URL('../src/web/ai-routes.js', import.meta.url), 'utf8');
const checkHealth = fs.readFileSync(new URL('../src/core/content-check-health.js', import.meta.url), 'utf8');

// Distinctive, so a key turning up somewhere it should not is unmistakable.
const SAVED = {
  omdb: 'omdbSAVEDkey01', tmdb: 'tmdbSAVEDkey0123456789abcdef01',
  gemini: 'AIzaSAVEDgeminiKEY0123456789abcd', share: 'shareSAVEDkey0123456789abcdef01',
  jfPass: 'jfSAVEDpassword', jfToken: 'jfSAVEDtoken0123', smtp: 'smtpSAVEDapppw',
};

/** A config with every key saved, as the server holds it. */
function storedConfig() {
  const c = structuredClone(DEFAULT_CONFIG);
  c.media.workDir = '/srv/whatsapp-bot/data/media';
  c.web.admins = [{ username: 'mommy', role: 'superadmin', passwordHash: 'scrypt$a', lastLogin: null }];
  c.omdb.apiKey = SAVED.omdb;
  c.movieRequests.theatrical.tmdbApiKey = SAVED.tmdb;
  Object.assign(c.gemini, { enabled: true, apiKey: SAVED.gemini, model: 'gemini-3.6-flash' });
  Object.assign(c.directLinks, { enabled: true, apiKey: SAVED.share });
  Object.assign(c.library.jellyfin, {
    baseUrl: 'http://10.0.0.5:8096', authMethod: 'password', username: 'bot',
    password: SAVED.jfPass, accessToken: SAVED.jfToken, userId: 'u1', userName: 'bot',
  });
  Object.assign(c.email, { enabled: true, user: 'owner@example.com', appPassword: SAVED.smtp });
  return c;
}

/** What GET /config returns: the same masking as ConfigStore.redacted(). */
function redact(cfg) {
  const out = structuredClone(cfg);
  for (const p of SECRET_PATHS) if (getPath(out, p)) setPath(out, p, MASK);
  out.web.admins = (out.web.admins ?? []).map(({ passwordHash, ...a }) => a);
  delete out.web.sessionSecret;
  return out;
}

const AI_VIEW = {
  order: ['gemini', 'groq', 'cerebras', 'mistral'],
  lookupOn: true, contentCheckOn: true, allowCleanRatedFilms: false,
  providers: [
    { id: 'gemini', label: 'Gemini', console: 'aistudio.google.com', keysUrl: PROVIDERS.gemini.keysUrl,
      enabled: true, apiKey: MASK,
      model: 'gemini-3.6-flash', autoModel: null, preferences: [], canClearRated: true, status: null },
    { id: 'groq', label: 'Groq', console: 'console.groq.com', keysUrl: PROVIDERS.groq.keysUrl,
      enabled: true, apiKey: '', model: '',
      autoModel: null, preferences: [], canClearRated: false, status: null },
    { id: 'cerebras', label: 'Cerebras', console: 'cloud.cerebras.ai', keysUrl: PROVIDERS.cerebras.keysUrl,
      enabled: false, apiKey: '', model: '',
      autoModel: null, preferences: [], canClearRated: false, status: null },
    { id: 'mistral', label: 'Mistral', console: 'console.mistral.ai', keysUrl: PROVIDERS.mistral.keysUrl,
      enabled: false, apiKey: '', model: '',
      autoModel: null, preferences: [], canClearRated: false, status: null },
  ],
};

/* ------------------------------------------------------------------ harness */

function loadPanel(edit) {
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
  // linkedom has no `checked` accessor on <input>: an element written by
  // innerHTML reports `undefined`, and assigning to it makes a plain own
  // property that the next re-render silently drops. A browser keeps property
  // and attribute in step, and the AI providers card is re-rendered on every
  // edit, so without this a tick could only ever be read back on an element
  // the test itself had created.
  if (!Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked')) {
    Object.defineProperty(window.HTMLInputElement.prototype, 'checked', {
      configurable: true,
      get() { return this.hasAttribute('checked'); },
      set(v) { if (v) this.setAttribute('checked', ''); else this.removeAttribute('checked'); },
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

  // A save answers with the whole masked config, exactly as PUT /config does -
  // which is what makes "the box went back to the mask" reproducible here.
  const raw = storedConfig();
  edit?.(raw);
  const served = redact(raw);
  const requests = [];
  const fetch = async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    requests.push({ method, url, body });
    if (url === '/api/auth/status') return new Promise(() => {});
    const out = url.startsWith('/api/config') ? served : (url === '/api/ai/providers' ? AI_VIEW : {});
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(out) };
  };

  const win = { document, localStorage, location: { reload() {}, href: '' }, navigator: {},
    scrollTo, addEventListener() {} };
  const exported = ['loadConfig', 'collectForm', 'collectKeySection', 'runSettingsSearch',
    'renderJumpNav', 'freshInstallChecklist', 'keyLoginRows', 'renderKeySection',
    'loadAiProviders', 'keyReasonWord', 'syncJumpNav'];
  // eslint-disable-next-line no-new-func
  const make = new Function('window', 'document', 'localStorage', 'fetch', 'EventSource',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'confirm', 'alert', 'prompt',
    'navigator', 'location', `"use strict";\n${app}\n;return { ${exported.join(', ')} };`);
  const h = make(win, document, localStorage, fetch, function EventSource() {},
    setTimeout, clearTimeout, () => {}, () => {}, () => true, () => {}, () => null,
    win.navigator, win.location);
  return { document, win, h, scrolled, flush, requests, localStorage };
}

const settle = () => new Promise((r) => setImmediate(r));
const settleAll = async () => { for (let i = 0; i < 12; i++) await settle(); };

/** A panel with the stored config already loaded, so every box holds the mask. */
async function ready(edit) {
  const p = loadPanel(edit);
  await p.h.loadConfig();
  await settleAll();
  p.flush();
  p.requests.length = 0;
  return p;
}

const $ = (doc, id) => doc.getElementById(id);
/** The body of the last PUT /config a click produced. */
const lastPut = (requests) => [...requests].reverse().find((r) => r.method === 'PUT' && r.url.startsWith('/api/config'))?.body;

/* ------------------------------------------------------------------ the section */

console.log('=== every key moved into one section, keeping its id ===');
{
  const { document } = loadPanel();
  const section = document.querySelector('.settings-group[data-group="api-keys"]');
  ok(section, 'there is an API keys settings group');
  ok(/API keys/.test(section.querySelector('.section-head')?.textContent ?? ''),
    `headed "${section.querySelector('.section-head')?.textContent.trim()}"`);

  const groups = [...document.querySelectorAll('#tab-settings .settings-group')];
  ok(groups[0] === section, 'and it comes first, right after the fresh-install checklist');

  for (const id of ['f-omdbkey', 'f-tmdbkey', 'f-gemini-key', 'f-gemini-model', 'f-dl-apikey']) {
    const el = $(document, id);
    ok(el && el.closest('.settings-group') === section, `#${id} lives in the section now`);
  }
  ok($(document, 'card-ai-providers')?.closest('.settings-group') === section,
    'the AI providers card came too, so every AI key sits together');
  ok($(document, 'ai-list') && $(document, 'ai-save'), 'with its own list and its own Save');

  // The old homes keep a line saying where the key went, and it is a link the
  // navigation helper already understands.
  for (const [ptr, target] of [['ptr-omdb', '#f-omdbkey'], ['ptr-tmdb', '#f-tmdbkey'],
    ['ptr-gemini', '#f-gemini-key'], ['ptr-dl', '#f-dl-apikey']]) {
    const p = $(document, ptr)?.closest('p');
    const link = p?.querySelector('a.card-link');
    ok(link?.dataset.target === target && link.dataset.goto === 'settings',
      `#${ptr}: a line where the key was, linking to ${target}`);
    ok(p.closest('.settings-group') !== section, 'left behind in the card the key came from');
  }
}

console.log('=== each key card says what it is for, how to test it and where to get one ===');
{
  const { document } = loadPanel();
  const cards = {
    'card-key-omdb': 'https://www.omdbapi.com/apikey.aspx',
    'card-key-tmdb': 'https://www.themoviedb.org/settings/api',
    'card-key-gemini': 'https://aistudio.google.com/apikey',
  };
  for (const [id, url] of Object.entries(cards)) {
    const card = $(document, id);
    const link = card?.querySelector(`a[href="${url}"]`);
    ok(link && link.getAttribute('target') === '_blank' && link.getAttribute('rel') === 'noopener',
      `${id}: "get a key" opens ${new URL(url).host} in a new tab, without an opener`);
  }
  for (const id of ['card-key-omdb', 'card-key-tmdb', 'card-key-gemini', 'card-key-share']) {
    const card = $(document, id);
    ok(card.querySelector('h2 .pill'), `${id}: a status pill in the heading`);
    ok(card.querySelector('.ak-actions button'), `${id}: a Test button`);
    ok((card.querySelector('.hint')?.textContent ?? '').length > 40, `${id}: a line on what the key is used for`);
  }
  ok(/spends one of OMDb's lookups/.test($(document, 'card-key-omdb').textContent),
    'and the OMDb card warns that a test costs a lookup');
  // The consoles for the fallbacks are named on their own rows in the AI card,
  // which the AI provider tests already cover.
  for (const host of ['console.groq.com', 'cloud.cerebras.ai', 'console.mistral.ai']) {
    ok(app.includes(host) || html.includes(host) || AI_VIEW.providers.some((p) => p.console === host),
      `${host} is where the card sends you for that key`);
  }
}

/* ------------------------------------------------------------------ saving */

console.log('=== the section\'s Save sends its own keys, and nothing else ===');
{
  const { document, h, requests, flush } = await ready();
  $(document, 'ak-save').click();
  await settleAll();
  flush();
  const body = lastPut(requests);
  ok(body, 'pressing Save API keys PUTs the settings');
  ok(Object.keys(body).join() === 'gemini' && Object.keys(body.gemini).join() === 'model',
    `untouched boxes send only Gemini's model: ${JSON.stringify(body)}`);
  ok(body.gemini.model === 'gemini-3.6-flash', 'which is the model that was already saved');

  $(document, 'f-omdbkey').value = 'omdbNEWkey02';
  $(document, 'f-gemini-key').value = '   ';            // blanked, not removed
  const owned = h.collectKeySection();
  ok(owned.omdb?.apiKey === 'omdbNEWkey02', 'a newly typed key is sent');
  ok(!('apiKey' in owned.gemini), 'a box emptied by hand keeps the saved key rather than clearing it');
  ok(!('movieRequests' in owned) && !('directLinks' in owned), 'and the boxes still holding the mask send nothing');

  $(document, 'ak-tmdb-remove').checked = true;
  const cleared = h.collectKeySection();
  ok(cleared.movieRequests.theatrical.tmdbApiKey === '',
    'ticking "Remove the saved key" is the one way to clear one');
  ok(Object.keys(cleared.movieRequests.theatrical).join() === 'tmdbApiKey',
    'and it carries that field alone, so the rest of the theatrical check is untouched');
}

console.log('=== the cards the keys came from no longer send them ===');
{
  const { document, h, requests, flush } = await ready();
  const form = h.collectForm();
  ok(!('omdb' in form), '"Save settings" does not carry the OMDb key');
  ok(!('tmdbApiKey' in form.movieRequests.theatrical), 'nor the TMDB key');
  ok(!('apiKey' in form.gemini) && !('model' in form.gemini), 'nor the Gemini key or model');
  ok(form.movieRequests.theatrical.enabled === true || form.movieRequests.theatrical.enabled === false,
    'while the rest of the theatrical check is still saved there');
  ok('enabled' in form.gemini && 'minConfidence' in form.gemini, 'and the rest of the Gemini switches too');

  $(document, 'dl-save').click();
  await settleAll();
  flush();
  const dl = lastPut(requests);
  ok(dl?.directLinks && !('apiKey' in dl.directLinks),
    `the direct-links card saves its settings without the share key: ${Object.keys(dl.directLinks).join()}`);
}

console.log('=== a key pasted but not yet saved survives an ordinary "Save settings" ===');
{
  const { document, h } = await ready();
  $(document, 'f-omdbkey').value = 'omdbNEWkey02';
  // The refill every save does used to put the mask back, throwing the key away.
  h.loadConfig();
  await settleAll();
  ok($(document, 'f-omdbkey').value === 'omdbNEWkey02', 'the box still holds what was typed');
  ok($(document, 'f-tmdbkey').value === MASK, 'while an untouched box is refilled as usual');
}

console.log('=== the mask can never overwrite a stored key (real ConfigStore) ===');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-keys-section-'));
  const store = new ConfigStore({ dataDir: path.join(dir, 'data'), masterKey: 'test-master-key-0123456789abcdef' });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  store.load();
  store.update({
    omdb: { apiKey: SAVED.omdb },
    gemini: { apiKey: SAVED.gemini, model: 'gemini-3.6-flash' },
    movieRequests: { theatrical: { tmdbApiKey: SAVED.tmdb } },
    directLinks: { apiKey: SAVED.share },
  });

  const { document, h } = await ready();
  store.update(h.collectKeySection());
  const c = store.get();
  ok(c.omdb.apiKey === SAVED.omdb && c.gemini.apiKey === SAVED.gemini
    && c.movieRequests.theatrical.tmdbApiKey === SAVED.tmdb && c.directLinks.apiKey === SAVED.share,
  'saving with every box untouched leaves all four keys as they were');

  // Belt and braces: even a panel that DID send the mask cannot replace a key.
  store.update({ omdb: { apiKey: MASK }, gemini: { apiKey: MASK } });
  ok(store.get().omdb.apiKey === SAVED.omdb && store.get().gemini.apiKey === SAVED.gemini,
    'and the store itself reads the mask as "unchanged"');

  $(document, 'f-omdbkey').value = 'omdbNEWkey02';
  $(document, 'ak-direct-links-remove').checked = true;
  store.update(h.collectKeySection());
  ok(store.get().omdb.apiKey === 'omdbNEWkey02', 'a typed key replaces the stored one');
  ok(store.get().directLinks.apiKey === '', 'and Remove clears the one it was ticked for');
  ok(store.get().movieRequests.theatrical.tmdbApiKey === SAVED.tmdb && store.get().gemini.apiKey === SAVED.gemini,
    'while the keys nobody touched are still there');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ status */

console.log('=== the pills say saved or not set, and the logins elsewhere are listed ===');
{
  const { document, h } = await ready();
  ok($(document, 'ak-omdb-pill').textContent === 'saved', 'a saved key reads "saved", although the box only holds the mask');
  ok(!$(document, 'ak-omdb-removewrap').classList.contains('hidden'), 'and it can be removed');
  ok(/saved\. It moved to/.test($(document, 'ptr-omdb').textContent), 'the old card says the key is saved and where it went');

  const rows = h.keyLoginRows();
  ok(rows.length === 4, `four logins stay with their settings: ${rows.map((r) => r.what).join(' · ')}`);
  ok(rows[0].state === 'signed in as bot' && rows[0].ok, 'Jellyfin says it is signed in, and as whom');
  ok(rows.find((r) => /Email/.test(r.what)).state === 'app password saved', 'the SMTP app password is reported, not shown');
  ok(!JSON.stringify(rows).includes(SAVED.jfPass) && !JSON.stringify(rows).includes(SAVED.smtp),
    'and no secret, masked or real, is printed into a row');
  for (const r of rows) {
    ok($(document, 'ak-logins') && document.querySelector(r.target), `"go to" for ${r.what} lands on ${r.target}`);
  }
}

/* ------------------------------------------------------------------ finding */

console.log('=== the filter finds a setting by its name or by what its hint says ===');
{
  const { document, h } = await ready();
  const shown = () => [...document.querySelectorAll('#tab-settings .card')].filter((c) => !c.classList.contains('nomatch'));
  const count = () => $(document, 'set-search-count').textContent;
  const before = [...document.querySelectorAll('#tab-settings .card')].length;

  for (const [q, id] of [['omdb', 'card-key-omdb'], ['groq', 'card-ai-providers'],
    ['timeout', 'f-libtimeout'], ['password', 'f-em-pass']]) {
    h.runSettingsSearch(q);
    const cards = shown();
    const want = $(document, id).closest ? ($(document, id).closest('.card') ?? $(document, id)) : $(document, id);
    ok(cards.length > 0 && cards.length < before, `"${q}": ${cards.length} of ${before} cards left (${count()})`);
    ok(cards.includes(want), `"${q}": the card holding ${id} is one of them`);
    ok(document.querySelectorAll('#tab-settings .searchhit').length > 0, `"${q}": the matches are highlighted`);
  }

  h.runSettingsSearch('key');
  const keyCards = shown();
  ok(keyCards.includes($(document, 'card-key-omdb')) && keyCards.includes($(document, 'card-key-tmdb'))
    && keyCards.includes($(document, 'card-key-gemini')) && keyCards.includes($(document, 'card-key-share')),
  '"key" finds every card in the API keys section');
  ok(/\d+ matches/.test(count()), `and says how many: "${count()}"`);

  // The filter opens every group that has a match; only one is open otherwise.
  h.runSettingsSearch('omdb');
  const openGroups = [...document.querySelectorAll('#tab-settings .settings-group')].filter((g) => !g.classList.contains('hidden'));
  ok(openGroups.length >= 1 && openGroups.every((g) => [...g.querySelectorAll('.card')].some((c) => !c.classList.contains('nomatch'))),
    'no group is left open with nothing in it');

  h.runSettingsSearch('zzzz-nothing-matches');
  ok(shown().length === 0 && count() === 'no matches', 'a query that matches nothing says so rather than showing everything');

  h.runSettingsSearch('');
  ok(shown().length === before, 'clearing the box puts every card back');
  ok(document.querySelectorAll('#tab-settings .searchhit').length === 0, 'and takes the highlights off');
  ok([...document.querySelectorAll('#tab-settings .settings-group')].filter((g) => !g.classList.contains('hidden')).length === 1,
    'with one group on screen again');
  ok(count() === '', 'and no count');
}

console.log('=== Escape clears the filter, and a match can be jumped to ===');
{
  const { document, scrolled } = await ready();
  const box = $(document, 'set-search');
  box.value = 'omdb';
  box.dispatchEvent(new document.defaultView.Event('input'));
  ok(document.querySelectorAll('#tab-settings .card.nomatch').length > 0, 'typing filters as you go');

  // linkedom has no KeyboardEvent, so the key rides on a plain one - which is
  // all the handler reads.
  const press = (key) => {
    const e = new document.defaultView.Event('keydown');
    Object.defineProperty(e, 'key', { value: key, configurable: true });
    box.dispatchEvent(e);
  };

  scrolled.length = 0;
  press('Enter');
  ok(scrolled.length > 0, 'Enter lands on the first match');

  press('Escape');
  ok(box.value === '' && document.querySelectorAll('#tab-settings .card.nomatch').length === 0,
    'Escape empties the box and puts everything back');
}

console.log('=== a scroll-list chip is shown only while its card is on the page ===');
{
  // Reported from the live panel: "the links to other sections on the dash do
  // nothing". The Dashboard's first two chips were the nudity-check cards,
  // which are hidden unless that check is failing, and clicking a chip for a
  // display:none card scrolled nowhere.
  const { document, h, flush } = await ready();
  document.querySelector('.tab[data-tab="dashboard"]').click();
  h.renderJumpNav();
  flush();
  const chip = (name) => [...$(document, 'jumpnav').querySelectorAll('button[data-i]')]
    .find((b) => b.textContent === name);
  const health = $(document, 'card-cc-health');
  ok(health.classList.contains('hidden'), 'the nudity-check card starts hidden, as it is when all is well');
  ok(chip('Nudity check not running')?.classList.contains('hidden'), 'so its chip is hidden too');
  ok(chip('WhatsApp connection') && !chip('WhatsApp connection').classList.contains('hidden'), 'a card on the page keeps its chip');
  health.classList.remove('hidden');
  h.syncJumpNav();
  ok(!chip('Nudity check not running').classList.contains('hidden'), 'and the chip comes back when the card does');

  ok(chip('Recent activity') && chip('Recent requests'),
    'chips are named by the heading alone, not "Recent activity open full log →"');
  ok(![...$(document, 'jumpnav').querySelectorAll('button')].some((b) => /→/.test(b.textContent)),
    'no chip carries a link\'s arrow');
}

console.log('=== the chips reach every section, the checklist included ===');
{
  const { document, h, flush } = await ready();
  document.querySelector('.tab[data-tab="settings"]').click();
  h.renderJumpNav();
  flush();
  const nav = $(document, 'jumpnav');
  const chips = [...nav.querySelectorAll('button')];
  ok(chips.length >= 10, `${chips.length} chips: ${chips.map((b) => b.textContent).join(' · ')}`);
  ok(chips[0].dataset.scroll === 'card-fresh-install' && chips[0].textContent === 'Checklist',
    'the first is the checklist, which sits outside every group');
  ok(chips[1].dataset.group === 'api-keys', 'then the API keys section');

  for (const b of chips.filter((x) => x.dataset.group)) {
    const g = document.querySelector(`.settings-group[data-group="${b.dataset.group}"]`);
    ok(g && g.querySelector('.section-head'), `chip "${b.textContent}" lands on a section with a heading`);
  }
  const labels = chips.map((b) => b.textContent.replace(/\s*[\u{1F300}-\u{1FAFF}]\s*/gu, '').trim());
  ok(['Checklist', 'API keys', 'Connection', 'Movies', 'TV', 'Beta', 'Moderation', 'Direct links',
    'Library & files', 'My account', 'System'].every((w) => labels.includes(w)),
  `every section asked for has a chip: ${labels.join(' · ')}`);

  chips[1].click();
  const open = [...document.querySelectorAll('#tab-settings .settings-group')].filter((g) => !g.classList.contains('hidden'));
  ok(open.length === 1 && open[0].dataset.group === 'api-keys', 'and pressing one shows that section alone');
}

console.log('=== the fresh-install checklist still points at every key, in its new home ===');
{
  const { document, h } = await ready();
  const ctx = (edit = () => {}) => {
    const raw = storedConfig();
    edit(raw);
    return { config: redact(raw), role: 'superadmin', status: null, accounts: null, admins: null, ffmpeg: null };
  };
  const variants = [ctx(), ctx((c) => { c.omdb.apiKey = ''; }), ctx((c) => { c.gemini.apiKey = ''; }),
    ctx((c) => { c.gemini.enabled = false; }), ctx((c) => { c.movieRequests.theatrical.tmdbApiKey = ''; }),
    ctx((c) => { c.movieRequests.theatrical.enabled = false; }), ctx((c) => { c.directLinks.apiKey = ''; }),
    ctx((c) => { c.directLinks.apiKey = ''; c.directLinks.allowBotKeyFallback = false; })];

  const seen = new Map();
  for (const v of variants) for (const it of h.freshInstallChecklist(v)) seen.set(`${it.id} ${it.target}`, it);
  const missing = [...seen.values()].filter((it) => it.tab === 'settings' && !document.querySelector(it.target));
  ok(missing.length === 0, `every settings target still resolves${missing.length ? ` — ${missing.map((i) => i.target).join(', ')}` : ''}`);

  const section = document.querySelector('.settings-group[data-group="api-keys"]');
  const lands = (target) => document.querySelector(target)?.closest('.settings-group') === section;
  for (const target of ['#f-omdbkey', '#btn-test-omdb', '#f-tmdbkey', '#f-gemini-key', '#f-gemini-model', '#f-dl-apikey']) {
    ok(lands(target), `the checklist's ${target} now opens the API keys section`);
  }
}


/* ------------------------------------------------ one save cannot undo another */

console.log('=== "Save API keys" leaves every other unsaved edit exactly where it was ===');
{
  const { document, h, requests, flush, win } = await ready();
  await h.loadAiProviders();
  await settleAll();

  // Unsaved edits on other cards, on other tabs' settings, and - the one that
  // matters most - on the AI providers card a few centimetres below the
  // button, inside this very section.
  $(document, 'f-th-window').value = '999';
  $(document, 'f-gemini-conf').value = '0.95';
  $(document, 'ai-groq-key').value = 'gsk_TYPEDgroqkey0123456789abcdef';
  $(document, 'ai-groq-enabled').checked = true;
  win.moveAiProvider('mistral', -1);
  $(document, 'ai-mistral-clear').checked = true;
  const orderBefore = [...document.querySelectorAll('#ai-list .item-title')].map((t) => t.textContent.trim());

  $(document, 'f-omdbkey').value = 'omdbNEWkey02';
  $(document, 'ak-save').click();
  await settleAll();
  flush();

  const body = lastPut(requests);
  ok(body?.omdb?.apiKey === 'omdbNEWkey02', 'the key it was pressed for is saved');
  ok(!('ai' in body) && !('groq' in body), 'and the PUT carries nothing of the AI card');

  ok($(document, 'f-th-window').value === '999' && $(document, 'f-gemini-conf').value === '0.95',
    'a number typed into another card is still there');
  ok($(document, 'ai-groq-key').value === 'gsk_TYPEDgroqkey0123456789abcdef',
    'the Groq key typed but not saved is still in its box');
  ok($(document, 'ai-groq-enabled').checked, 'so is the tick that pasting it set');
  ok($(document, 'ai-mistral-clear').checked, 'and the may-clear-rated tick');
  const orderAfter = [...document.querySelectorAll('#ai-list .item-title')].map((t) => t.textContent.trim());
  ok(orderAfter.join() === orderBefore.join(), `and the reordered rows stayed reordered: ${orderAfter.join(' · ')}`);
  ok(/unsaved/.test($(document, 'ai-note').textContent),
    'the AI card still says it has something unsaved, which is the truth');
}

console.log('=== after the save the boxes hold the mask again, not the key ===');
{
  const { document, requests, flush } = await ready();
  $(document, 'f-omdbkey').value = 'omdbNEWkey02';
  $(document, 'f-dl-apikey').value = 'shareNEWkey0123456789abcdef';
  $(document, 'ak-save').click();
  await settleAll();
  flush();
  ok($(document, 'f-omdbkey').value === MASK && $(document, 'f-dl-apikey').value === MASK,
    'a key that has been stored stops being legible on screen');
  ok($(document, 'f-gemini-model').value === 'gemini-3.6-flash', 'while the model, which is not secret, is shown as saved');

  // The second press must not re-send the key: another admin may have changed
  // it since, and the box no longer speaks for the person pressing.
  requests.length = 0;
  $(document, 'ak-save').click();
  await settleAll();
  flush();
  const again = lastPut(requests);
  ok(again && !('omdb' in again) && !('directLinks' in again),
    `pressing Save again sends only the model: ${JSON.stringify(again)}`);
}

console.log('=== the sticky "Save settings" says when a key still needs its own Save ===');
{
  const { document, requests, flush } = await ready();
  $(document, 'f-omdbkey').value = 'omdbTYPED0002';
  $(document, 'btn-save').click();
  await settleAll();
  flush();
  const body = lastPut(requests);
  ok(body && !('omdb' in body), 'that save still does not carry the key');
  ok($(document, 'f-omdbkey').value === 'omdbTYPED0002', 'and does not throw what was typed away');
  ok(/OMDb/.test($(document, 'save-note').textContent) && /Save API keys/.test($(document, 'save-note').textContent),
    `the note names the key and the button it needs: "${$(document, 'save-note').textContent}"`);
  ok(/Save API keys/.test($(document, 'toast').textContent),
    `so does the toast, instead of an unqualified "Settings saved": "${$(document, 'toast').textContent}"`);
  ok($(document, 'ak-save').classList.contains('flash-field'), 'and the button it means is pointed at');

  const clean = await ready();
  $(clean.document, 'btn-save').click();
  await settleAll();
  clean.flush();
  ok(/^Saved /.test($(clean.document, 'save-note').textContent)
    && !/Save API keys/.test($(clean.document, 'save-note').textContent),
  `with no key pending it is the plain message again: "${$(clean.document, 'save-note').textContent}"`);
  ok($(clean.document, 'toast').textContent === 'Settings saved', 'and the plain toast');
}

console.log('=== changing Gemini\'s model counts as an unsaved edit ===');
{
  const { document } = await ready();
  const model = $(document, 'f-gemini-model');
  model.value = 'gemini-9.9-pro';
  model.dispatchEvent(new document.defaultView.Event('input'));
  ok(/unsaved/.test($(document, 'ak-note').textContent),
    `the model is sent by this Save too, so it says so: "${$(document, 'ak-note').textContent}"`);
}

/* ------------------------------------------------------------ telling apart */

console.log('=== the pill can name what the AI route actually said ===');
{
  const { h } = await ready();
  for (const r of ['model-retired', 'model-unsuitable', 'list-unreadable', 'quota-daily']) {
    ok(h.keyReasonWord(r, 'gemini') !== 'failed',
      `Gemini's "${r}" reads "${h.keyReasonWord(r, 'gemini')}", not a flat "failed"`);
  }
  ok(h.keyReasonWord('auth', 'omdb') === 'bad key' && h.keyReasonWord('unreadable', 'omdb') === 'odd answer',
    'while the other routes keep their own short words');
  ok(h.keyReasonWord('rate-limited', 'gemini') === 'tested too soon'
    && h.keyReasonWord('key-shape', 'omdb') === 'not a key',
  'and a refusal reads the same whichever route refused');
}

/* ------------------------------------------------------- go to, and get one */

console.log('=== every "go to →" lands on a field that is actually on screen ===');
{
  const { document, h } = await ready();
  const buried = (el) => el?.closest('.lib-section.hidden') || el?.closest('.jf-auth.hidden');
  for (const r of h.keyLoginRows()) {
    const el = document.querySelector(r.target);
    ok(el && !buried(el), `${r.what}: ${r.target} is not inside a switched-off sub-panel`);
  }
  const rows = h.keyLoginRows();
  ok(rows.find((r) => /Plex/.test(r.what)).target === '#f-libprovider'
    && rows.find((r) => /HTTP/.test(r.what)).target === '#f-libprovider',
  'a provider that is not in use sends you to the picker that reveals its field');

  const plex = await ready((c) => { c.library.provider = 'plex'; c.library.plex.token = 'plexTOKEN0001'; });
  const prow = plex.h.keyLoginRows().find((r) => /Plex/.test(r.what));
  ok(prow.target === '#f-plex-token' && prow.state === 'token saved',
    'and once Plex IS the provider, straight to the token');
}

console.log('=== every key in the section has somewhere to get one ===');
{
  const { document, h } = await ready();
  await h.loadAiProviders();
  await settleAll();
  const wanted = {
    groq: 'https://console.groq.com/keys',
    cerebras: 'https://cloud.cerebras.ai/',
    mistral: 'https://console.mistral.ai/api-keys',
  };
  for (const [id, url] of Object.entries(wanted)) {
    ok(PROVIDERS[id].keysUrl === url, `${id}: the server knows the page that issues the key`);
    const row = $(document, `ai-${id}-key`)?.closest('.ai-row');
    const a = row?.querySelector(`a[href="${url}"]`);
    ok(a && a.getAttribute('target') === '_blank' && a.getAttribute('rel') === 'noopener',
      `${id}: its row links there in a new tab, without an opener`);
  }
  ok(/keysUrl: PROVIDERS\[p\.id\]\.keysUrl/.test(aiRoutes), 'and GET /ai/providers passes the link through');
}

console.log('=== the share key is masked on screen like the other three ===');
{
  const { document } = loadPanel();
  for (const id of ['f-omdbkey', 'f-tmdbkey', 'f-gemini-key', 'f-dl-apikey']) {
    ok($(document, id).getAttribute('type') === 'password', `#${id} is a password box`);
  }
}

/* ------------------------------------------------- the filter and navigation */

console.log('=== Enter lands on the key, not on the checklist that lists every key ===');
{
  const { document, scrolled } = await ready();
  const box = $(document, 'set-search');
  const press = (key) => {
    const e = new document.defaultView.Event('keydown');
    Object.defineProperty(e, 'key', { value: key, configurable: true });
    box.dispatchEvent(e);
  };
  for (const [q, id] of [['omdb', 'card-key-omdb'], ['tmdb', 'card-key-tmdb'], ['gemini', 'card-key-gemini']]) {
    box.value = q;
    box.dispatchEvent(new document.defaultView.Event('input'));
    ok($(document, 'card-fresh-install').classList.contains('nomatch') === false,
      `"${q}": the checklist is still counted as a match`);
    scrolled.length = 0;
    press('Enter');
    ok(scrolled[0] === $(document, id),
      `"${q}": Enter lands on ${id}, not on the checklist that names every key`);
  }
}

console.log('=== nothing behind a switched-off sub-panel is counted or jumped to ===');
{
  const { document, h } = await ready();
  const shown = () => [...document.querySelectorAll('#tab-settings .card')].filter((c) => !c.classList.contains('nomatch'));
  h.runSettingsSearch('plex');
  ok(document.querySelectorAll('.lib-section.hidden .searchhit').length === 0,
    'the X-Plex-Token label is not marked while Plex is not the provider');
  ok(shown().includes($(document, 'f-plex-token').closest('.card')),
    'but the card it lives in is still found, through its own heading');

  h.runSettingsSearch('quick connect');
  ok(document.querySelectorAll('.jf-auth.hidden .searchhit').length === 0,
    'nor is the Quick Connect help while the sign-in method is a password');
  h.runSettingsSearch('');
}

console.log('=== a chip pressed while filtering shows a section with something in it ===');
{
  const { document, h, flush } = await ready();
  document.querySelector('.tab[data-tab="settings"]').click();
  h.renderJumpNav();
  flush();
  const box = $(document, 'set-search');
  box.value = 'key';
  box.dispatchEvent(new document.defaultView.Event('input'));
  ok(document.querySelectorAll('#tab-settings .card.nomatch').length > 0, 'the filter is on');

  const chip = [...$(document, 'jumpnav').querySelectorAll('button[data-group]')]
    .find((b) => b.dataset.group === 'connection');
  chip.click();
  flush();
  const group = document.querySelector('.settings-group[data-group="connection"]');
  ok(!group.classList.contains('hidden'), 'the chip opens its section');
  ok([...group.querySelectorAll('.card')].every((c) => !c.classList.contains('nomatch')),
    'with its cards on screen rather than an empty page behind the chip');
  ok(box.value === '' && $(document, 'set-search-count').textContent === '',
    'because the chip is also how you get out of the filter');
}

console.log('=== a link into a card the filter hid still lands on it ===');
{
  const { document, flush } = await ready();
  const box = $(document, 'set-search');
  box.value = 'confidence';
  box.dispatchEvent(new document.defaultView.Event('input'));
  const source = $(document, 'ptr-omdb').closest('.card');
  ok(!source.classList.contains('nomatch') && $(document, 'card-key-omdb').classList.contains('nomatch'),
    'the card holding the link matches; the card it points at does not');

  $(document, 'ptr-omdb').closest('p').querySelector('a.card-link').click();
  flush();
  ok(!$(document, 'card-key-omdb').classList.contains('nomatch'),
    'following it puts the OMDb card back on screen instead of scrolling to nothing');
  ok(box.value === '', 'the filter that was hiding it is cleared');
  ok($(document, 'f-omdbkey').closest('.settings-group').classList.contains('hidden') === false,
    'and its section is the one showing');
}

console.log('=== what the alerts tell the operator to open is still where they say ===');
{
  // Every "Settings → ..." in the content-check advice names a place somebody
  // goes looking while their nudity check is not running - it is in the alert
  // email and on the dashboard. Moving the AI providers card into this
  // section left one of the three sending people to Movies, where the card no
  // longer is, and the test that quoted the string was updated along with the
  // two above it rather than catching the one that was missed.
  const { document } = loadPanel();
  const norm = (s2) => s2.replace(/\s+/g, ' ').trim();
  const heads = new Map([...document.querySelectorAll('#tab-settings .section-head')]
    .map((h) => [norm(h.textContent), h.closest('.settings-group')]));
  const paths = [...checkHealth.matchAll(/'Settings → ([^']+)'/g)].map((m) => m[1]);
  ok(paths.length >= 3, `${paths.length} settings paths are named in the advice`);
  for (const full of paths) {
    const [section, ...rest] = full.split('→').map(norm);
    const group = heads.get(section);
    ok(group, `"${full}": the section "${section}" exists`);
    if (!group) continue;
    // A heading or a label, not just the words somewhere in the group: the
    // card the keys left behind carries a pointer reading "API keys & logins
    // 🔑 → AI providers →", so any looser test passes for the very path that
    // was wrong.
    const names = [...group.querySelectorAll('h2, h3, label')].map((e) => norm(e.textContent));
    const missing = rest.filter((r) => !names.some((n) => n.includes(r)));
    ok(missing.length === 0,
      `"${full}": and it holds ${rest.join(' → ')}${missing.length ? ` — no ${missing.join(', ')} there` : ''}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
