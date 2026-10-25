/* "Save settings" saves what was edited, and the server refuses a save that breaks the bot.
   Run: node test/settings-save-sends-only-what-was-edited.test.mjs

   On 2026-10-12 at 21:00:29 UTC one "Save settings" by the super-admin, from
   the LAN, changed 22 settings. The operator had changed the film cooldown
   (30 → 3600) and ticked the text reply; the save also made ten groups film
   request groups - every group but "02 MOVIE REQUESTS ONLY!", "$ Head Admins",
   "05 Direct download links", "06 MOVIE DISCUSSIONS" and "08 Google Drive
   Links", so both posts groups, the TV request group and the queue
   notifications group among them - emptied the posts and notifications
   groups (naming both in ?clearGroups=, as a deliberate "none"), and switched
   off @-tagging, the prefix, "which one?", the theatrical check, Gemini, the
   nudity check, its "send clean rated films", deleting the local copy and the
   email alerts. The audit row named twelve and then "and 10 more". At 21:32
   the film plugin answered "Drake & Josh is a TV series, not a film" in the
   TV request group. The settings were restored by hand at 21:59; at 22:10
   a page that had not read the settings since the 21:00 save was saved
   again with its Groups card put right, and put the theatrical check, Gemini
   and email back off - "changed 9 settings", exactly the restored ones that
   card does not hold. The operator, the same evening: "I did not turn those
   off, I turned those on".

   The panel sent its whole form, ten cards, with every save. What the page
   showed at 21:00 is not what the saved config said, and no code in the panel
   turns those boxes that way (every card's own save, the group-list pushes,
   tab switches and a second loadConfig were all driven against it); at 22:10
   it was a page that had not re-read the config since the hand restore.
   Either way the save sent everything the page showed. Pinned here:

   - each half of that, reproduced: the page's whole form IS the recorded
     save (the 21:00 row's twelve named changes, in order; the 22:10 row word
     for word), and the save now sends only the controls edited on the page -
     the cooldown and the reply at 21:00, the Groups card at 22:10;
   - the lost update itself: page A loads, the settings change on the box and
     from page B, page A saves something else, and both changes survive; a
     page still running the panel from before this change, which sends the
     whole form, is refused and told to reload;
   - film group pickers nobody touched follow the saved config on a redraw,
     rather than keeping what they show as somebody's choice;
   - PUT /config refuses, whole and with a reason the panel shows, a film
     request group that is a posts group (film or TV), the TV request group or
     the notifications group, and a film plugin left with request groups and
     no posts group;
   - a save changing settings in three sections or more, or ten settings or
     more, is made only when the sender confirms that exact list - the panel
     asks; a page from before it could ask is told to reload;
   - the audit row and the log line name every change.

   The panel half runs the REAL app.js against the REAL index.html in
   linkedom, saving through the REAL server and config store; it is skipped,
   with a line saying so, where linkedom (a devDependency) is not installed. */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createServer } from '../src/web/server.js';
import { ConfigStore, previewPatch, filmGroupClashes, sweepingChange } from '../src/config/store.js';
import { JobQueue } from '../src/core/queue.js';
import { hashPassword } from '../src/util/crypto.js';
import { getPath, SECRET_PATHS } from '../src/config/schema.js';
import { changedPaths, describeChange, describeConfigChange } from '../src/util/diff.js';
import { categoryOf } from '../src/core/audit-filter.js';
import log from '../src/util/logger.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

let parseHTML = null;
try { ({ parseHTML } = await import('linkedom')); } catch { /* production install */ }

const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'save-clobber-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

/* --------------------------------------------- the box, as it was that day */

// The fifteen groups of the live number, by their real JIDs and names
// (data/backups/descriptions-latest.json), so a stray one is recognisable.
const G = {
  HEADS: '120363900000000012@g.us', ADMINS: '120363900000000005@g.us', POSTS: '120363900000000006@g.us',
  REQ: '120363900000000001@g.us', TV_POSTS: '120363900000000008@g.us', TV_REQ: '120363900000000003@g.us',
  DL: '120363900000000011@g.us', DISC: '120363900000000002@g.us', RECENT: '120363900000000007@g.us',
  GDRIVE: '120363900000000004@g.us', NOTIFY: '120363900000000015@g.us', SYS1: '120363900000000010@g.us',
  SYS2: '120363900000000009@g.us', RANDOM: '120363900000000014@g.us', TESTING: '120363900000000013@g.us',
};
const GROUPS = [
  [G.HEADS, '$ Head Admins'], [G.ADMINS, '$ movie system Admins'], [G.POSTS, '01 MOVIE POSTS ONLY'],
  [G.REQ, '02 MOVIE REQUESTS ONLY! NO CHATTING WHATSOEVER!'], [G.TV_POSTS, '03 TV POSTS ONLY!'],
  [G.TV_REQ, '04 TV REQUESTS ONLY! NO CHATTING WHATSOEVER!'], [G.DL, '05 Direct download links for peeps without a filter'],
  [G.DISC, '06 MOVIE DISCUSSIONS'], [G.RECENT, '07 RECENTLY RELEASED MOVIES REQUESTS & UNOFFICIAL MOVIES'],
  [G.GDRIVE, '08 Google Drive Links'], [G.NOTIFY, '09 Request bot queue notifications'],
  [G.SYS1, 'MOVIE SYSTEM'], [G.SYS2, 'MOVIE SYSTEM'], [G.RANDOM, 'Random Chatting'], [G.TESTING, 'Testing things'],
].map(([jid, subject], i) => ({ jid, subject, size: 100 + i, private: subject.startsWith('$') }));
// The ten film request groups the 21:00 save made.
const BAD_TEN = [G.ADMINS, G.POSTS, G.TV_POSTS, G.TV_REQ, G.RECENT, G.NOTIFY, G.SYS1, G.SYS2, G.RANDOM, G.TESTING];

/** The settings as they stood before 21:00 (data/config.json, restored, and the audit log). */
const BEFORE_2100 = {
  whatsapp: { autoReconnect: true, markOnline: true },
  plugins: { enabled: ['movie-requests', 'tv-requests', 'direct-links'] },
  movieRequests: {
    requestGroups: [G.REQ], postsGroup: G.POSTS, notify: { group: G.NOTIFY, tagRequester: true, noTag: [] },
    requirePrefix: true, prefix: '#request', requireYearWhenAmbiguous: true, replyOnBlock: false,
    maxQueueLength: 50, cooldownSecondsPerUser: 30, cooldownOnlyWhenOthersWait: true, blockUnrated: false,
    blockedRatings: ['R', 'NC-17', 'X', 'TV-MA'], rulesCommand: 'yourmom',
    theatrical: { enabled: true, useHomeReleaseDate: true, windowDays: 90 },
  },
  tvRequests: { enabled: true, requestGroups: [G.TV_REQ], postsGroups: [G.TV_POSTS], cooldownSecondsPerUser: 3600 },
  libraryNews: { senders: ['15558100180'], groups: [G.DISC] },
  directLinks: { enabled: true, groups: [G.DL] },
  lockdown: { alwaysLocked: [G.POSTS, G.TV_POSTS, G.NOTIFY, G.SYS1, G.SYS2, G.RANDOM, G.TESTING] },
  gemini: { enabled: true, contentCheck: true, allowCleanRatedFilms: true },
  media: { deleteAfterSend: true },
  email: { enabled: true, to: 'status@example.com', onError: true, onFailover: true, onContentCheck: true,
    dailySummary: true, dailySummaryHour: 0 },
  web: { idleTimeoutMinutes: 0 },
};

/** As the 21:00 save and the three after it left them (data/config.json.before-restore-20261012). */
const AFTER_2100 = {
  movieRequests: {
    requestGroups: BAD_TEN, postsGroup: '', notify: { group: '', tagRequester: false },
    replyOnBlock: true, cooldownSecondsPerUser: 3600, maxQueueLength: 0,
    theatrical: { enabled: false, useHomeReleaseDate: false },
  },
  gemini: { enabled: false, contentCheck: false, allowCleanRatedFilms: false },
  media: { deleteAfterSend: false },
  email: { enabled: false, onError: false, onFailover: false, onContentCheck: false, dailySummary: false },
};

/** What was restored by hand at 21:59: the thirteen settings anyone knew had changed. */
const HAND_RESTORE = {
  movieRequests: {
    requestGroups: [G.REQ], postsGroup: G.POSTS, notify: { group: G.NOTIFY, tagRequester: true },
    theatrical: { enabled: true, useHomeReleaseDate: true },
  },
  gemini: { enabled: true, contentCheck: true },
  email: { enabled: true, onError: true, onFailover: true, onContentCheck: true, dailySummary: true },
};

// The 21:00 audit row, as written: its twelve named changes, in its order.
const ROW_2100 = [
  'movieRequests.requestGroups: [1 item] → [10 items]',
  'movieRequests.postsGroup: "120363900000000006@g.us" → (empty)',
  'movieRequests.notify.group: "120363900000000015@g.us" → (empty)',
  'movieRequests.notify.tagRequester: true → false',
  'movieRequests.requirePrefix: true → false',
  'movieRequests.requireYearWhenAmbiguous: true → false',
  'movieRequests.theatrical.enabled: true → false',
  'movieRequests.theatrical.useHomeReleaseDate: true → false',
  'movieRequests.replyOnBlock: false → true',
  'movieRequests.cooldownSecondsPerUser: 30 → 3600',
  'gemini.enabled: true → false',
  'gemini.contentCheck: true → false',
];
// The 22:10 audit row, word for word.
const ROW_2210 = 'changed 9 settings — movieRequests.theatrical.enabled: true → false; '
  + 'movieRequests.theatrical.useHomeReleaseDate: true → false; gemini.enabled: true → false; '
  + 'gemini.contentCheck: true → false; email.enabled: true → false; email.onError: true → false; '
  + 'email.onFailover: true → false; email.onContentCheck: true → false; email.dailySummary: true → false';

/* ------------------------------------------------------------ the server */

async function boot(name, ...settings) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const cs = new ConfigStore({ dataDir: dir, masterKey: 'test-master-key-0123456789abcdef' });
  cs.load();
  cs.update({
    web: { admins: [{ username: 'superadmin', role: 'superadmin', passwordHash: hashPassword('super-secret-1'), createdAt: 1, lastLogin: null }] },
    media: { workDir: path.join(dir, 'media') },
  });
  for (const s of settings) cs.update(JSON.parse(JSON.stringify(s)));
  const sp = new Map();
  const stateStore = { namespace(n) {
    if (!sp.has(n)) sp.set(n, {});
    const d = sp.get(n);
    return { get: (k, v) => d[k] ?? v, set: (k, v) => { d[k] = v; }, push: (k, v) => { (d[k] ??= []).unshift(v); } };
  } };
  const bot = Object.assign(new EventEmitter(), {
    dataDir: cs.dataDir, groupCache: new Map(), groups: () => GROUPS, state: 'connected',
    status: () => ({ state: 'connected' }), isConnected: () => true,
  });
  const server = await new Promise((r) => {
    const s = createServer({
      configStore: cs, bot,
      queue: new JobQueue({ concurrency: 1 }), linkQueue: new JobQueue({ concurrency: 1 }),
      pluginManager: { plugins: new Map(), notifyConfigChange: async () => {}, list: () => [] },
      stateStore, fileLogger: { tail: () => [] }, alerts: {}, lockScheduler: {}, failover: null,
    }).listen(0, '127.0.0.1', () => r(s));
  });
  const port = server.address().port;
  let cookie = '';
  const call = (method, p, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = cookie ? { cookie } : {};
    if (data !== null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.headers['set-cookie']) cookie = res.headers['set-cookie'].map((x) => x.split(';')[0]).join('; ');
        resolve({ status: res.statusCode, text: buf, json: (() => { try { return JSON.parse(buf); } catch { return null; } })() });
      });
    });
    r.on('error', reject);
    if (data !== null) r.write(data);
    r.end();
  });
  const signin = await call('POST', '/api/auth/login', { username: 'superadmin', password: 'super-secret-1' });
  if (signin.status !== 200) throw new Error(`sign-in failed: ${signin.status} ${signin.text}`);
  return {
    cs, call, close: () => server.close(),
    audit: () => stateStore.namespace('audit').get('events', []),
    stored: (p) => getPath(cs.get(), p),
    snapshot: () => JSON.stringify(cs.get()),
  };
}

/** What a body would change on this server, in the audit log's words. */
const wouldChange = (srv, body) => changedPaths(srv.cs.get(), previewPatch(srv.cs.get(), body), SECRET_PATHS).map(describeChange);

/* ------------------------------------------------------------- the panel */

/** The real panel, its config calls going to the real server. */
function panel(srv) {
  const { document, window } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  // linkedom's <select> has no value setter and its tick boxes no `checked`;
  // a browser has both (see test/settings-group-pickers.test.mjs).
  const optionValue = (o) => o.getAttribute('value') ?? o.textContent;
  const sv = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value');
  if (!sv.set) {
    Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
      configurable: true,
      get() {
        const opts = [...this.querySelectorAll('option')];
        const o = opts.filter((x) => x.hasAttribute('selected')).pop() ?? opts[0];
        return o ? optionValue(o) : '';
      },
      set(v) {
        for (const o of this.querySelectorAll('option')) {
          if (optionValue(o) === String(v)) o.setAttribute('selected', ''); else o.removeAttribute('selected');
        }
      },
    });
  }
  if (!Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked')) {
    Object.defineProperty(window.HTMLInputElement.prototype, 'checked', {
      configurable: true,
      get() { return this.hasAttribute('checked'); },
      set(v) { if (v) this.setAttribute('checked', ''); else this.removeAttribute('checked'); },
    });
  }
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};

  const puts = [];
  const asked = [];
  let answer = true;
  const inflight = new Set();
  const fetch = async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    const reply = (status, out) => ({ ok: status < 400, status, statusText: String(status), text: async () => JSON.stringify(out) });
    if (url === '/api/auth/status') return new Promise(() => {});
    if (url.startsWith('/api/config')) {
      if (method === 'PUT') puts.push({ url, body });
      const c = srv.call(method, url, body);
      inflight.add(c);
      const r = await c.finally(() => inflight.delete(c));
      return { ok: r.status < 400, status: r.status, statusText: String(r.status), text: async () => r.text };
    }
    if (url.startsWith('/api/wa/groups')) return reply(200, { groups: GROUPS });
    if (url === '/api/lockdown/status') return reply(200, { locked: false, enabled: false, upcoming: [] });
    if (url === '/api/beta') return reply(200, { features: [], modes: ['off', 'beta', 'on'], mainGroups: {}, conflicts: [] });
    return reply(200, {});
  };
  const listeners = {};
  function EventSource() { this.addEventListener = (n, fn) => { listeners[n] = fn; }; this.close = () => {}; }
  const win = { document, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { reload() {}, href: '' }, navigator: {}, scrollTo() {}, addEventListener() {} };
  const names = ['loadConfig', 'loadGroups', 'connectEvents', 'loadTvSection', 'loadDirectLinks', 'loadLockdown',
    'collectForm', 'FORM_FIELDS'];
  // eslint-disable-next-line no-new-func
  const make = new Function('window', 'document', 'localStorage', 'fetch', 'EventSource',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'confirm', 'alert', 'prompt', 'navigator', 'location',
    `"use strict";\n${app}\n;return { ${names.join(', ')} };`);
  const h = make(win, document, win.localStorage, fetch, EventSource,
    (fn) => { Promise.resolve().then(fn); return 1; }, () => {}, () => {}, () => {},
    (text) => { asked.push(text); return answer; }, () => {}, () => null, win.navigator, win.location);
  const $ = (id) => document.getElementById(id);
  const turns = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)); };
  const settle = async () => {
    await turns();
    for (let round = 0; inflight.size && round < 20; round++) {
      await Promise.allSettled([...inflight]);
      await turns();
    }
  };
  const fire = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true }));
  return {
    document, window, h, $, puts, asked, settle,
    answer: (a) => { answer = a; },
    push: async () => { listeners.groups({ data: JSON.stringify(GROUPS) }); await settle(); },
    click: async (id) => { $(id).dispatchEvent(new window.Event('click')); await settle(); },
    lastPut: () => puts[puts.length - 1],
    ticked: (id) => [...$(id).querySelectorAll('input[type=checkbox]')].filter((i) => i.checked).map((i) => i.value),
    toast: () => $('toast').textContent,
    // A person's edit: the browser fires "input" for typing and "change" for
    // a tick or a choice, which is what marks a control edited (FORM_FIELDS).
    type: (id, v) => { $(id).value = v; fire($(id), 'input'); },
    tick: (id, on) => { $(id).checked = on; fire($(id), 'change'); },
    choose: (id, v) => { $(id).value = v; fire($(id), 'change'); },
    tickGroups: (id, jids) => {
      for (const i of $(id).querySelectorAll('input[type=checkbox]')) {
        if (i.checked !== jids.includes(i.value)) { i.checked = jids.includes(i.value); fire(i, 'change'); }
      }
    },
    // The page's controls changed with no edit at all - no event. Nothing in
    // the panel's code does this; it stands for however the 21:00 page came
    // to show what it showed.
    quietly: (id, prop, v) => { $(id)[prop] = v; },
    quietGroups: (id, jids) => { for (const i of $(id).querySelectorAll('input[type=checkbox]')) i.checked = jids.includes(i.value); },
  };
}

/** A panel as it stands after sign-in, the group list in. */
async function openPanel(srv) {
  const p = panel(srv);
  await p.h.loadConfig();
  p.h.loadTvSection();
  p.h.loadDirectLinks();
  await p.h.loadLockdown();
  await p.h.loadGroups();
  p.h.connectEvents();
  await p.settle();
  return p;
}

if (parseHTML) {
  console.log('=== every setting the form reads has a line in FORM_FIELDS, so an edit to it can be saved ===');
  {
    const srv = await boot('fields', BEFORE_2100);
    const p = await openPanel(srv);
    const leaves = [];
    const walk = (o, at) => {
      for (const [k, v] of Object.entries(o)) {
        const here = at ? `${at}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, here); else leaves.push(here);
      }
    };
    walk(p.h.collectForm(), '');
    const mapped = new Set(Object.values(p.h.FORM_FIELDS));
    ok(leaves.every((l) => mapped.has(l)), `every setting collectForm() reads is listed: missing ${leaves.filter((l) => !mapped.has(l)).join(', ') || 'none'}`);
    // The sign-out timeout is read for the super-admin only (idleField), and
    // this page is signed in as nobody in particular.
    ok([...mapped].every((m) => leaves.includes(m) || m === 'web.idleTimeoutMinutes'),
      `and the list names nothing the form does not read: ${[...mapped].filter((m) => !leaves.includes(m)).join(', ')}`);
    ok(Object.keys(p.h.FORM_FIELDS).every((id) => p.$(id)), 'every control it lists is on the page');
    srv.close();
  }

  console.log('=== 22:10: a page open since 21:00, its Groups card put right, sends that card alone ===');
  {
    const srv = await boot('2210', BEFORE_2100, AFTER_2100);
    const p = await openPanel(srv);
    ok(p.ticked('group-checks').length === 10 && p.$('f-postsgroup').value === '' && !p.$('f-th-enabled').checked,
      'the page shows the settings as the 21:00 save left them');
    // The hand restore, which the open page is never told about.
    srv.cs.update(JSON.parse(JSON.stringify(HAND_RESTORE)));
    // The operator puts the Groups card right on that page.
    p.tickGroups('group-checks', [G.REQ]);
    p.choose('f-postsgroup', G.POSTS);
    p.choose('f-notifygroup', G.NOTIFY);
    p.tick('f-notifytag', true);

    const whole = p.h.collectForm();
    ok(describeConfigChange(srv.cs.get(), previewPatch(srv.cs.get(), whole), SECRET_PATHS) === ROW_2210,
      'the whole form that page holds is the 22:10 save, word for word: theatrical, Gemini and email back off');

    const before = srv.snapshot();
    await p.click('btn-save');
    const put = p.lastPut();
    ok(JSON.stringify(Object.keys(put.body)) === '["movieRequests"]'
      && JSON.stringify(Object.keys(put.body.movieRequests).sort()) === '["notify","postsGroup","requestGroups"]'
      && JSON.stringify(Object.keys(put.body.movieRequests.notify).sort()) === '["group","tagRequester"]',
    `the save sends the four settings edited on the Groups card and nothing else: ${JSON.stringify(put.body)}`);
    ok(!put.url.includes('clearGroups'), 'and empties nothing');
    ok(srv.snapshot() === before, 'so the hand restore stands: nothing on the server changed');
    ok(srv.stored('movieRequests.theatrical.enabled') === true && srv.stored('gemini.enabled') === true
      && srv.stored('email.enabled') === true, 'the theatrical check, Gemini and email stay on');
    ok(!srv.audit().some((e) => e.action === 'changed settings'), 'and there is no change to audit');
    ok(p.$('f-th-enabled').checked && p.$('f-gemini-on').checked && p.$('f-em-enabled').checked,
      'the refill after the save brings the stale cards on the page back in step with the server');
    srv.close();
  }

  console.log('=== a lost update: page A loads, the settings change elsewhere, page A saves something else ===');
  {
    // The 22:10 sequence with nothing of the incident's own in it: what page A
    // showed when it loaded is no longer what is saved, and A is never told.
    const srv = await boot('lost-update', BEFORE_2100);
    const a = await openPanel(srv);
    // Elsewhere, twice: on the box itself (the 21:59 restore was config.json
    // edited by hand), and from another page, B, saving one of its own.
    srv.cs.update({ movieRequests: { theatrical: { enabled: false } }, email: { dailySummary: false } });
    const b = await openPanel(srv);
    b.tick('f-requireyear', false);
    await b.click('btn-save');
    ok(srv.stored('movieRequests.requireYearWhenAmbiguous') === false, 'page B\'s save went in');
    ok(a.$('f-th-enabled').checked && a.$('f-em-daily').checked && a.$('f-requireyear').checked,
      'page A still shows all three as it loaded them');

    a.type('f-maxqueue', '0');
    await a.click('btn-save');
    ok(JSON.stringify(a.lastPut().body) === '{"movieRequests":{"maxQueueLength":0}}', `page A sends its own edit alone: ${JSON.stringify(a.lastPut().body)}`);
    ok(srv.stored('movieRequests.maxQueueLength') === 0, 'which is saved');
    ok(srv.stored('movieRequests.theatrical.enabled') === false && srv.stored('email.dailySummary') === false,
      'the change made on the box survives');
    ok(srv.stored('movieRequests.requireYearWhenAmbiguous') === false, 'and so does page B\'s');
    ok(!a.$('f-th-enabled').checked && !a.$('f-em-daily').checked && !a.$('f-requireyear').checked,
      'page A, refilled from the answer, now shows them');

    // The same page as the panel before this change would have sent it: the
    // whole form, without ?edited=1. Refused, and nothing in it saved.
    const c = await openPanel(srv);
    srv.cs.update({ gemini: { enabled: false } });
    c.type('f-cooldown', '45');
    const before = srv.snapshot();
    const old = await srv.call('PUT', '/api/config', c.h.collectForm());
    ok(old.status === 409 && /^This page was loaded before Save settings changed on 2026-10-12/.test(old.json?.error)
      && /Reload the page/.test(old.json.error), `a page still sending the whole form is told to reload: ${old.json?.error}`);
    ok(srv.snapshot() === before && srv.stored('gemini.enabled') === false, 'and Gemini, switched off elsewhere, stays off');
    const row = srv.audit()[0];
    ok(row.action === 'refused: a settings save of the whole form, from a page loaded before 2026-10-12'
      && categoryOf(row) === 'settings' && /gemini\.enabled: false → true/.test(row.detail),
    `audited under Settings with what it would have put back: ${row.detail}`);
    const unchanged = await srv.call('PUT', '/api/config', (await openPanel(srv)).h.collectForm());
    ok(unchanged.status === 200, 'a whole form that would change nothing is let through: it harms nothing');
    srv.close();
  }

  console.log('=== 21:00: the cooldown and the text reply edited, those two sent ===');
  {
    const srv = await boot('2100', BEFORE_2100);
    const p = await openPanel(srv);
    // The page as the 21:00 save shows it was. The panel does not do this to
    // itself; here it is done with no edit event, as nobody edited them.
    for (const id of ['f-notifytag', 'f-requireprefix', 'f-requireyear', 'f-th-enabled', 'f-th-usedvd', 'f-gemini-on',
      'f-gemini-content', 'f-gemini-allowclean', 'f-deleteafter', 'f-em-enabled', 'f-em-onerror', 'f-em-onfailover',
      'f-em-oncontent', 'f-em-daily']) p.quietly(id, 'checked', false);
    p.quietGroups('group-checks', BAD_TEN);
    p.quietly('f-postsgroup', 'value', '');
    p.quietly('f-notifygroup', 'value', '');
    // What the operator did.
    p.type('f-cooldown', '3600');
    p.tick('f-replyonblock', true);

    const whole = wouldChange(srv, p.h.collectForm());
    ok(JSON.stringify(whole.slice(0, 12)) === JSON.stringify(ROW_2100),
      `the whole form that page holds is the 21:00 save: its twelve named changes, in the row's order\n${whole.slice(0, 12).join('\n')}`);
    ok(['email.enabled: true → false', 'email.dailySummary: true → false', 'gemini.allowCleanRatedFilms: true → false',
      'media.deleteAfterSend: true → false'].every((c) => whole.includes(c)),
    `and among the rest the email alerts, "send clean rated films" and "delete the local copy" (${whole.length} in all)`);

    await p.click('btn-save');
    const put = p.lastPut();
    ok(JSON.stringify(Object.keys(put.body)) === '["movieRequests"]' && Object.keys(put.body.movieRequests).length === 2
      && put.body.movieRequests.cooldownSecondsPerUser === 3600 && put.body.movieRequests.replyOnBlock === true,
    `the save sends the two settings edited: ${JSON.stringify(put.body)}`);
    ok(!put.url.includes('clearGroups'), 'and names no group as emptied: nobody chose "none" on this page');
    const row = srv.audit().find((e) => e.action === 'changed settings');
    ok(row?.detail === 'changed 2 settings — movieRequests.replyOnBlock: false → true; movieRequests.cooldownSecondsPerUser: 30 → 3600',
      `the audit row: ${row?.detail}`);
    ok(srv.stored('movieRequests.requestGroups').join() === G.REQ && srv.stored('movieRequests.postsGroup') === G.POSTS
      && srv.stored('movieRequests.notify.group') === G.NOTIFY && srv.stored('gemini.enabled') === true
      && srv.stored('email.dailySummary') === true && srv.stored('media.deleteAfterSend') === true,
    'the groups, Gemini, email and the rest are as they were');
    ok(p.ticked('group-checks').join() === G.REQ && p.$('f-postsgroup').value === G.POSTS && p.$('f-notifygroup').value === G.NOTIFY
      && p.$('f-notifytag').checked && p.$('f-em-enabled').checked,
    'and the page, refilled, shows what is saved: the pickers too, since nobody chose what they showed');
    srv.close();
  }

  console.log('=== a Save pressed before the settings have arrived sends the edit, not the empty page ===');
  {
    // Ruled out as the 21:00 save by its shape, which kept every text box:
    // the whole form read before loadConfig() answers is the page's empty
    // defaults, and on main it saved some sixty settings - the port 0, the
    // prefix blank and no plugins at all among them.
    const srv = await boot('before-config', BEFORE_2100);
    const p = panel(srv);
    const before = srv.snapshot();
    p.type('f-cooldown', '3600');
    await p.click('btn-save');
    ok(JSON.stringify(p.lastPut().body) === '{"movieRequests":{"cooldownSecondsPerUser":3600}}',
      `only the cooldown is sent: ${JSON.stringify(p.lastPut().body)}`);
    ok(srv.stored('web.port') !== 0 && srv.stored('plugins.enabled').length === 3 && srv.stored('movieRequests.prefix') === '#request',
      'and nothing else on the server moved');
    ok(srv.snapshot() !== before && srv.stored('movieRequests.cooldownSecondsPerUser') === 3600, 'but the cooldown did');
    srv.close();
  }

  console.log('=== a film group picker nobody touched follows the saved config on a redraw ===');
  {
    const srv = await boot('follow', BEFORE_2100);
    const p = await openPanel(srv);
    p.quietGroups('group-checks', BAD_TEN);
    p.quietly('f-postsgroup', 'value', '');
    await p.push();
    ok(p.ticked('group-checks').join() === G.REQ && p.$('f-postsgroup').value === G.POSTS,
      'a group-list push draws them from the config again - they are nobody\'s choice');
    p.tickGroups('group-checks', [G.REQ, G.RECENT]);
    p.choose('f-notifygroup', '');
    await p.push();
    ok(p.ticked('group-checks').sort().join() === [G.REQ, G.RECENT].sort().join(), 'a tick somebody made survives the push');
    ok(p.$('f-notifygroup').value === '', 'and so does a "none" somebody chose');
    srv.close();
  }

  console.log('=== the panel shows the server\'s refusal, and nothing is saved ===');
  {
    const srv = await boot('panel-refusals', BEFORE_2100);
    const p = await openPanel(srv);
    const before = srv.snapshot();
    p.tickGroups('group-checks', [G.REQ, G.TV_POSTS]);
    await p.click('btn-save');
    ok(/"03 TV POSTS ONLY!" is a TV posts group, so it cannot also be a film request group/.test(p.toast())
      && /Nothing was saved\.$/.test(p.toast()), `ticking the TV posts group as a film request group is refused: "${p.toast()}"`);
    ok(srv.snapshot() === before, 'and nothing was saved');

    p.tickGroups('group-checks', [G.REQ]);
    p.choose('f-postsgroup', '');
    await p.click('btn-save');
    ok(/clearGroups=movieRequests\.postsGroup/.test(decodeURIComponent(p.lastPut().url)), 'choosing "none" for the posts group is named as meant');
    ok(/no posts group/.test(p.toast()) && /Nothing was saved\.$/.test(p.toast()), `and refused all the same: "${p.toast()}"`);
    ok(srv.stored('movieRequests.postsGroup') === G.POSTS, 'the posts group stays');

    p.tickGroups('group-checks', []);
    await p.click('btn-save');
    ok(srv.stored('movieRequests.postsGroup') === '' && srv.stored('movieRequests.requestGroups').length === 0,
      'with the request groups unticked in the same save, "none" goes through: nothing is left taking requests');
    srv.close();
  }

  console.log('=== three sections at once: the panel asks, with the list, and Cancel saves nothing ===');
  {
    const srv = await boot('panel-sweep', BEFORE_2100);
    const p = await openPanel(srv);
    p.tick('f-th-enabled', false);
    p.tick('f-gemini-on', false);
    p.tick('f-em-daily', false);
    const before = srv.snapshot();
    p.answer(false);
    await p.click('btn-save');
    ok(p.asked.length === 1 && /3 settings at once/.test(p.asked[0])
      && ['movieRequests.theatrical.enabled: true → false', 'gemini.enabled: true → false', 'email.dailySummary: true → false']
        .every((c) => p.asked[0].includes(c)), `the panel asks, listing each change:\n${p.asked[0]}`);
    ok(srv.snapshot() === before && /Nothing was saved\.$/.test(p.toast()), `Cancel saves nothing, and says so: "${p.toast()}"`);
    p.answer(true);
    await p.click('btn-save');
    ok(p.asked.length === 2 && /[?&]confirm=[0-9a-f]{16}$/.test(p.lastPut().url), `OK sends it again with the list confirmed: ${p.lastPut().url}`);
    ok(srv.stored('movieRequests.theatrical.enabled') === false && srv.stored('gemini.enabled') === false
      && srv.stored('email.dailySummary') === false, 'and the three are saved');
    ok(p.toast() === 'Settings saved', 'Settings saved');

    p.tick('f-th-enabled', true);
    await p.click('btn-save');
    ok(p.asked.length === 2 && srv.stored('movieRequests.theatrical.enabled') === true, 'one setting is simply saved, unasked');
    srv.close();
  }
} else {
  console.log('=== the panel: skipped - linkedom (a devDependency) is not installed ===');
}

/* ---------------------------------------------------------- the server */

console.log('=== PUT /config: no film request group may be a posts group, the TV request group or the notifications group ===');
{
  const srv = await boot('clashes', BEFORE_2100);
  for (const [jid, as, extra] of [
    [G.POSTS, 'the film posts group'], [G.TV_POSTS, 'a TV posts group'], [G.TV_REQ, 'the TV request group'],
    [G.NOTIFY, 'the queue notifications group'], [G.RECENT, 'the film posts group', { postsGroups: [G.RECENT] }],
  ]) {
    const before = srv.snapshot();
    const r = await srv.call('PUT', '/api/config', { movieRequests: { requestGroups: [G.REQ, jid], ...extra } });
    const name = GROUPS.find((g) => g.jid === jid).subject;
    ok(r.status === 400 && r.json?.error?.startsWith(`"${name}" is ${as}, so it cannot also be a film request group`)
      && r.json.error.endsWith('Nothing was saved.'), `"${name}" as ${as}: ${r.status} ${r.json?.error}`);
    ok(srv.snapshot() === before, '  and nothing is saved');
  }
  const row = srv.audit().find((e) => /^refused: make/.test(e.action));
  ok(row?.action === 'refused: make the film posts group a film request group' && categoryOf(row) === 'groups'
    && /It would have changed 2 settings — movieRequests\.requestGroups: \[1 item\] → \[2 items\]; movieRequests\.postsGroups/.test(row.detail),
  `audited with what it would have changed: "${row?.action}" — ${row?.detail}`);

  const tv = await srv.call('PUT', '/api/config', { tvRequests: { requestGroups: [G.REQ] } });
  ok(tv.status === 400 && /"02 MOVIE REQUESTS ONLY! NO CHATTING WHATSOEVER!" is the TV request group/.test(tv.json?.error),
    'from the other side too: making the film request group the TV request group');

  // A clash the config already holds - put there by hand - does not stop a
  // save of something else, nor one that takes it away.
  srv.cs.update({ movieRequests: { requestGroups: [G.REQ, G.NOTIFY] } });
  const other = await srv.call('PUT', '/api/config', { movieRequests: { cooldownSecondsPerUser: 60 } });
  ok(other.status === 200 && srv.stored('movieRequests.cooldownSecondsPerUser') === 60, 'a clash already saved does not block an unrelated save');
  const fix = await srv.call('PUT', '/api/config', { movieRequests: { requestGroups: [G.REQ] } });
  ok(fix.status === 200 && filmGroupClashes(srv.cs.get()).length === 0, 'nor the save that undoes it');
  srv.close();
}

console.log('=== PUT /config: the film plugin keeps a posts group while it takes requests ===');
{
  const srv = await boot('posts', BEFORE_2100);
  const before = srv.snapshot();
  const r = await srv.call('PUT', '/api/config?clearGroups=movieRequests.postsGroup', { movieRequests: { postsGroup: '' } });
  ok(r.status === 400 && /^The film request groups would have no posts group/.test(r.json?.error) && srv.snapshot() === before,
    `emptying it, even named as meant, is refused: ${r.json?.error}`);
  const extra = await srv.call('PUT', '/api/config?clearGroups=movieRequests.postsGroup',
    { movieRequests: { postsGroup: '', postsGroups: [G.TESTING] } });
  ok(extra.status === 200 && srv.stored('movieRequests.postsGroup') === '', 'with another posts group in postsGroups it is fine');
  srv.cs.update({ movieRequests: { postsGroup: G.POSTS, postsGroups: [] }, plugins: { enabled: ['tv-requests'] } });
  const off = await srv.call('PUT', '/api/config?clearGroups=movieRequests.postsGroup', { movieRequests: { postsGroup: '' } });
  ok(off.status === 200, 'and so is it with the film plugin switched off');
  srv.close();
}

console.log('=== PUT /config: the 21:00 save, as a page from before this change still sends it, is refused whole ===');
{
  const srv = await boot('2100-body', BEFORE_2100);
  // What collectForm() read off the 21:00 page: everything as it was, but
  // the boxes and pickers the save changed, and the operator's two edits.
  const body = JSON.parse(JSON.stringify({ ...BEFORE_2100, ...{
    movieRequests: { ...BEFORE_2100.movieRequests, requestGroups: BAD_TEN, postsGroup: '',
      notify: { group: '', tagRequester: false, noTag: [] }, requirePrefix: false, requireYearWhenAmbiguous: false,
      replyOnBlock: true, cooldownSecondsPerUser: 3600, theatrical: { enabled: false, useHomeReleaseDate: false, windowDays: 90 } },
    gemini: { enabled: false, contentCheck: false, allowCleanRatedFilms: false },
    media: { deleteAfterSend: false },
    email: { ...BEFORE_2100.email, enabled: false, onError: false, onFailover: false, onContentCheck: false, dailySummary: false },
  } }));
  delete body.web;
  // Nor the lockdown card's: collectForm() never sends it, and a save that
  // carries alwaysLocked marks the card reviewed (live-settings-defaults), a
  // change the 21:00 page never made.
  delete body.lockdown;
  const before = srv.snapshot();
  const r = await srv.call('PUT', '/api/config?clearGroups=movieRequests.postsGroup,movieRequests.notify.group', body);
  // The same save empties the posts and notifications groups, so in what it
  // would leave those two are no longer either; emptying the posts group is
  // postsGroupEmptied's half, and is refused on its own below.
  ok(r.status === 400 && r.json?.error?.startsWith('"03 TV POSTS ONLY!" is a TV posts group and '
    + '"04 TV REQUESTS ONLY! NO CHATTING WHATSOEVER!" is the TV request group, so neither can also be a film request group'),
  `refused, naming every group it would have broken: ${r.json?.error}`);
  ok(srv.snapshot() === before, 'nothing of it was saved');
  const row = srv.audit()[0];
  ok(/It would have changed 19 settings — /.test(row?.detail) && ROW_2100.every((c) => row.detail.includes(c)),
    'the refusal\'s audit row names every setting it would have changed');

  // Each of the other two guards stops it on its own as well.
  const keepGroups = { ...body, movieRequests: { ...body.movieRequests, requestGroups: [G.REQ] } };
  const noPosts = await srv.call('PUT', '/api/config?clearGroups=movieRequests.postsGroup,movieRequests.notify.group', keepGroups);
  ok(noPosts.status === 400 && /^The film request groups would have no posts group/.test(noPosts.json?.error),
    'with its request groups left alone, emptying the posts group is refused');
  const keepPosts = { ...keepGroups, movieRequests: { ...keepGroups.movieRequests, postsGroup: G.POSTS } };
  const held = await srv.call('PUT', '/api/config?clearGroups=movieRequests.notify.group', keepPosts);
  ok(held.status === 409 && /^This save would change 17 settings across 4 sections \(movieRequests, gemini, media, email\)/.test(held.json?.error),
    `and with the posts group left too, the rest is held for confirming: ${held.json?.error}`);
  ok(srv.snapshot() === before, 'nothing of any of them was saved');
  srv.close();
}

console.log('=== PUT /config: many settings across sections at once only with that list confirmed ===');
{
  const srv = await boot('sweep', BEFORE_2100);
  const body22 = {
    movieRequests: { theatrical: { enabled: false, useHomeReleaseDate: false } },
    gemini: { enabled: false, contentCheck: false },
    email: { enabled: false, onError: false, onFailover: false, onContentCheck: false, dailySummary: false },
  };
  const before = srv.snapshot();
  const r = await srv.call('PUT', '/api/config', body22);
  ok(r.status === 409 && /^This save would change 9 settings across 3 sections \(movieRequests, gemini, email\) at once/.test(r.json?.error)
    && /reload the page/.test(r.json.error) && /Nothing was saved\.$/.test(r.json.error),
  `the 22:10 save is held: ${r.json?.error}`);
  ok(srv.snapshot() === before, 'nothing was saved');
  ok(/^[0-9a-f]{16}$/.test(r.json.confirm) && r.json.changes.length === 9, 'the answer carries the list and its fingerprint');
  const row = srv.audit()[0];
  ok(row.action === 'refused: a settings save changing 9 settings in 3 sections at once' && categoryOf(row) === 'settings'
    && ROW_2210.split(' — ')[1].split('; ').every((c) => row.detail.includes(c)),
  `audited under Settings, with every change listed: "${row.action}"`);
  const wrong = await srv.call('PUT', '/api/config?confirm=0123456789abcdef', body22);
  ok(wrong.status === 409 && srv.snapshot() === before, 'another list\'s fingerprint confirms nothing');
  const lines = [];
  const listen = (e) => { if (e.scope === 'api') lines.push(e.msg); };
  log.on('line', listen);
  const yes = await srv.call('PUT', `/api/config?confirm=${r.json.confirm}`, body22);
  log.off('line', listen);
  ok(yes.status === 200 && srv.stored('gemini.enabled') === false, 'that list\'s fingerprint saves it');
  const done = srv.audit().find((e) => e.action === 'changed settings');
  ok(done?.detail === ROW_2210, `the audit row names all nine: ${done?.detail}`);
  ok(lines.some((l) => l === `configuration updated — ${ROW_2210}`), 'and so does the log line, the same words');

  ok(sweepingChange([{ path: 'omdb.apiKey', secret: true }, { path: 'gemini.apiKey', secret: true },
    { path: 'directLinks.apiKey', secret: true }]) === null, 'keys pasted into three cards at once are not held: a key is sent only when typed');
  const single = await srv.call('PUT', '/api/config', { movieRequests: { cooldownSecondsPerUser: 45, replyOnBlock: true } });
  ok(single.status === 200, 'an ordinary save goes through unasked');
  const reactions = Object.fromEntries(['researching', 'added', 'downloading', 'converting', 'sending', 'done', 'rated',
    'theaters', 'notFound', 'needYear'].map((k) => [k, 'x']));
  const many = await srv.call('PUT', '/api/config', { movieRequests: { reactions } });
  ok(many.status === 409 && many.json.changes.length === 10, 'ten changes in one section are held too');
  srv.close();
}

console.log('=== the audit row and the log line name every change, however many ===');
{
  const before = { a: Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`s${i}`, i])) };
  const after = { a: Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`s${i}`, i + 1])) };
  const s = describeConfigChange(before, after, []);
  ok(/^changed 22 settings — /.test(s) && Array.from({ length: 22 }, (_, i) => `a.s${i}: ${i} → ${i + 1}`).every((c) => s.includes(c)),
    'twenty-two changes, twenty-two named');
  ok(!/more/.test(s), 'and no "and 10 more"');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
