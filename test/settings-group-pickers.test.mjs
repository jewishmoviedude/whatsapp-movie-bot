/* A saved group stays saved until somebody chooses "none".
   Run: node test/settings-group-pickers.test.mjs

   On 2026-09-24 at 22:19 New York time a "Save settings" emptied the queue
   notifications group ("Request bot queue notifications") and switched off
   @-tagging the requester, 3 h 43 min after the active number had been
   switched, and from then on no queue notification reached anyone. The owner
   could not say whether that had been meant.

   Looking into it found that the Settings pickers could indeed save "no group"
   when nobody had chosen it:

   - the posts and notifications dropdowns, the request-group boxes, the tag
     tick box and the no-tag list were filled only when the group list arrived.
     Until then they held the page's defaults, and a Save in that window sent
     "— none —", nothing ticked, "do not tag" and an empty no-tag list;
   - the TV, direct-links and always-locked lists drew only the connected
     number's groups, so a saved group that number is not in had no box and
     the card's next Save dropped it; with no list loaded they sent nothing at
     all. The always-locked list was not even redrawn when the list came;
   - each group-list push redrew the dropdowns and the tag box from the saved
     config, throwing away whatever had been picked and not yet saved;
   - the Groups tab's "Don't tag" button changed the stored no-tag list but not
     the Settings box, so the next Save put the old list back.

   The 24 September save does not carry their fingerprint: it changed those two
   boxes and nothing else, which is what choosing "none" and unticking does
   (pinned below), where a save before the list came also empties the posts
   group and the no-tag list. Each of these is pinned here all the same,
   together with the server's half:
   PUT /config keeps a stored group a save would empty unless the save names it
   in ?clearGroups=, which the panel does only when a picker showed a saved
   group and somebody chose "none" or unticked the last box.

   The panel half runs the REAL app.js against the REAL index.html in linkedom,
   and its saves go to the REAL server and config store over HTTP. */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { parseHTML } from 'linkedom';
import { createServer } from '../src/web/server.js';
import { ConfigStore, GROUP_SETTINGS, holdGroupClears } from '../src/config/store.js';
import { JobQueue } from '../src/core/queue.js';
import { hashPassword } from '../src/util/crypto.js';
import { categoryOf } from '../src/core/audit-filter.js';
import { getPath } from '../src/config/schema.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'group-pickers-'));

// Example JIDs, so a stray one is recognisable.
const NOTIFY = '120363900000000015@g.us';
const POSTS = '120363900000000006@g.us';
const REQ = '120363900000000001@g.us';
const TV_REQ = '120363900000000003@g.us';
const TV_POSTS = '120363900000000008@g.us';
const BETA = '120363900000000013@g.us';
const OLD_NUMBER = [
  { jid: NOTIFY, subject: 'Request bot queue notifications', size: 40 },
  { jid: POSTS, subject: 'MOVIE POSTS ONLY', size: 783 },
  { jid: REQ, subject: 'MOVIE REQUESTS ONLY!', size: 800 },
  { jid: TV_REQ, subject: 'TV REQUESTS ONLY', size: 500 },
  { jid: TV_POSTS, subject: 'TV POSTS ONLY!', size: 500 },
  { jid: BETA, subject: 'Testing things', size: 30 },
];
// A number that is in none of the groups the notifications and TV posts use.
const NEW_NUMBER = OLD_NUMBER.filter((g) => g.jid !== NOTIFY && g.jid !== TV_POSTS);

/* ------------------------------------------------------------ the server */

async function boot(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const cs = new ConfigStore({ dataDir: dir, masterKey: 'test-master-key-0123456789abcdef' });
  cs.load();
  cs.update({
    web: { admins: [{ username: 'superadmin', role: 'superadmin', passwordHash: hashPassword('super-secret-1'), createdAt: 1, lastLogin: null }] },
    media: { workDir: path.join(dir, 'media') },
    movieRequests: { requestGroups: [REQ], postsGroup: POSTS, notify: { group: NOTIFY, tagRequester: true, noTag: ['15558080185'] } },
    tvRequests: { enabled: true, requestGroups: [TV_REQ], postsGroups: [TV_POSTS] },
    directLinks: { enabled: true, groups: [REQ] },
    lockdown: { alwaysLocked: [TV_POSTS] },
  });
  const sp = new Map();
  const stateStore = { namespace(n) {
    if (!sp.has(n)) sp.set(n, {});
    const d = sp.get(n);
    return { get: (k, v) => d[k] ?? v, set: (k, v) => { d[k] = v; }, push: (k, v) => { (d[k] ??= []).unshift(v); } };
  } };
  const bot = Object.assign(new EventEmitter(), {
    dataDir: cs.dataDir, groupCache: new Map(), groups: () => [], state: 'connected',
    status: () => ({ state: 'connected' }), isConnected: () => true,
  });
  const server = await new Promise((r) => {
    const s = createServer({
      configStore: cs, bot,
      queue: new JobQueue({ concurrency: 1 }), linkQueue: new JobQueue({ concurrency: 1 }),
      pluginManager: { plugins: new Map(), notifyConfigChange: async () => {} },
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
  };
}

/* ------------------------------------------------------------- the panel */

/**
 * The real panel. /api/config goes to the real server; the group list is
 * answered only when the test says so, the way WhatsApp can keep it back.
 */
function panel(srv) {
  const { document, window } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  // linkedom's <select> has no value setter, and reports undefined rather than
  // the first option when none is marked. A browser does neither.
  // An option without a value attribute has its text as its value.
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
  let groups = null;
  // The calls to the real server still under way. settle() used to wait a
  // fixed 40 turns of the event loop, which on bot-box2 outlasted the HTTP
  // round trip and the config store's write; on the same box moved to WSL
  // (2026-09-29) it did not, and seven checks read the store before the save
  // had reached it. Waiting for the calls themselves is the same on any box.
  const inflight = new Set();
  const fetch = async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    const answer = (status, out) => ({ ok: status < 400, status, statusText: String(status), text: async () => JSON.stringify(out) });
    if (url === '/api/auth/status') return new Promise(() => {});
    if (url.startsWith('/api/config')) {
      if (method === 'PUT') puts.push({ url, body });
      const call = srv.call(method, url, body);
      inflight.add(call);
      const r = await call.finally(() => inflight.delete(call));
      return { ok: r.status < 400, status: r.status, statusText: String(r.status), text: async () => r.text };
    }
    if (url.startsWith('/api/wa/groups')) return groups ? answer(200, { groups }) : new Promise(() => {});
    if (url === '/api/lockdown/status') return answer(200, { locked: false, enabled: false, upcoming: [] });
    if (url === '/api/beta') return answer(200, { features: [], modes: ['off', 'beta', 'on'], mainGroups: {}, conflicts: [] });
    if (url === '/api/notify/no-tag') {
      const now = new Set(srv.stored('movieRequests.notify.noTag'));
      if (body.muted) now.add(body.number); else now.delete(body.number);
      srv.cs.update({ movieRequests: { notify: { noTag: [...now] } } });
      return answer(200, { noTag: [...now] });
    }
    return answer(200, {});
  };
  const listeners = {};
  function EventSource() { this.addEventListener = (n, fn) => { listeners[n] = fn; }; this.close = () => {}; }
  const win = { document, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { reload() {}, href: '' }, navigator: {}, scrollTo() {}, addEventListener() {} };
  const names = ['loadConfig', 'loadGroups', 'connectEvents', 'loadTvSection', 'loadDirectLinks', 'loadLockdown', 'loadBetaSection', 'collectForm'];
  // eslint-disable-next-line no-new-func
  const make = new Function('window', 'document', 'localStorage', 'fetch', 'EventSource',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'confirm', 'alert', 'prompt', 'navigator', 'location',
    `"use strict";\n${app}\n;return { ${names.join(', ')} };`);
  const h = make(win, document, win.localStorage, fetch, EventSource,
    (fn) => { Promise.resolve().then(fn); return 1; }, () => {}, () => {}, () => {}, () => true, () => {}, () => null,
    win.navigator, win.location);
  const $ = (id) => document.getElementById(id);
  const turns = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)); };
  const settle = async () => {
    await turns();
    // What the page does with an answer can start another call: wait again.
    for (let round = 0; inflight.size && round < 20; round++) {
      await Promise.allSettled([...inflight]);
      await turns();
    }
  };
  return {
    document, window, win, h, $, puts, settle, srvCall: srv.call,
    setGroups: (g) => { groups = g; },
    push: async (g) => { groups = g; listeners.groups({ data: JSON.stringify(g) }); await settle(); },
    click: async (id) => { $(id).dispatchEvent(new window.Event('click')); await settle(); },
    lastPut: () => puts[puts.length - 1],
    shown: (id) => [...$(id).querySelectorAll('option')].find((o) => o.hasAttribute('selected')),
    ticked: (id) => [...$(id).querySelectorAll('input[type=checkbox]')].filter((i) => i.checked).map((i) => i.value),
    // Edited the way a person edits: the browser fires "change" (and "input"
    // for typing). "Save settings" sends only what was edited on the page
    // since the save of 2026-10-12
    // (test/settings-save-sends-only-what-was-edited.test.mjs).
    untickAll: (id) => {
      for (const i of $(id).querySelectorAll('input[type=checkbox]')) {
        i.checked = false;
        i.dispatchEvent(new window.Event('change', { bubbles: true }));
      }
    },
    set: (id, prop, v) => {
      $(id)[prop] = v;
      $(id).dispatchEvent(new window.Event(prop === 'checked' || $(id).tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    },
  };
}

/** A panel as it stands after sign-in: the config is in, the group list is not. */
async function openPanel(name, { groups = null } = {}) {
  const srv = await boot(name);
  const p = panel(srv);
  await p.h.loadConfig();
  p.h.loadTvSection();
  p.h.loadDirectLinks();
  await p.h.loadLockdown();
  if (groups) { p.setGroups(groups); await p.h.loadGroups(); }
  p.h.connectEvents();
  await p.settle();
  return { srv, p };
}

console.log('=== "Save settings" before the group list arrives keeps every saved group ===');
{
  const { srv, p } = await openPanel('before-list');
  ok(p.$('f-notifygroup').value === NOTIFY, 'the notifications dropdown shows the saved group as soon as the config is in');
  ok(/^\(saved: 120363900000000015@g\.us — group list not loaded\)$/.test(p.shown('f-notifygroup')?.textContent),
    `labelled for what it is: "${p.shown('f-notifygroup')?.textContent}"`);
  ok(p.$('f-postsgroup').value === POSTS, 'and so does the posts dropdown');
  ok(p.$('f-notifytag').checked === true, 'the tag box is ticked as saved - it used to sit unticked until the list came');
  ok(p.$('f-notify-notag').value === '+15558080185', 'and the no-tag list is filled, the number as +digits (2026-10-01)');
  ok(p.ticked('group-checks').join() === REQ, 'the saved request group has a ticked box');

  const whole = p.h.collectForm();
  ok(whole.movieRequests.notify.group === NOTIFY && whole.movieRequests.postsGroup === POSTS
    && whole.movieRequests.notify.tagRequester === true, 'read whole, the form holds the saved groups and tagging on, not "— none —"');
  await p.click('btn-save');
  const put = p.lastPut();
  ok(put && !put.url.includes('clearGroups'), `the save names nothing as cleared: ${put?.url}`);
  ok(!put.body.movieRequests, 'and sends no group setting at all: nobody edited one on this page');
  ok(srv.stored('movieRequests.notify.group') === NOTIFY && srv.stored('movieRequests.postsGroup') === POSTS
    && srv.stored('movieRequests.notify.tagRequester') === true && srv.stored('movieRequests.notify.noTag').join() === '15558080185',
  'nothing about the notifications changed on the server');

  for (const [card, save] of [['TV', 'tv-save'], ['direct links', 'dl-save'], ['lockdown', 'lock-save']]) {
    await p.click(save);
    ok(!p.lastPut().url.includes('clearGroups'), `the ${card} card's save names nothing as cleared`);
  }
  ok(srv.stored('tvRequests.requestGroups').join() === TV_REQ && srv.stored('tvRequests.postsGroups').join() === TV_POSTS,
    'the TV card, saved before the list came, keeps its request and posts groups');
  ok(srv.stored('directLinks.groups').join() === REQ, 'the direct-links card keeps its group');
  ok(srv.stored('lockdown.alwaysLocked').join() === TV_POSTS, 'and the lockdown card keeps its always-locked group');
  srv.close();
}

console.log('=== a number whose list lacks the saved group still shows it, by its last known name ===');
{
  const { srv, p } = await openPanel('other-number', { groups: OLD_NUMBER });
  ok(p.shown('f-notifygroup')?.textContent === 'Request bot queue notifications', 'named from the list while the number is in it');
  await p.push(NEW_NUMBER);                       // what a switch to another number pushes
  ok(p.$('f-notifygroup').value === NOTIFY, 'after the switch the saved group is still the selected one');
  ok(p.shown('f-notifygroup')?.textContent === '(saved: Request bot queue notifications — not in this number\'s groups)',
    `and says why it is not in the list: "${p.shown('f-notifygroup')?.textContent}"`);
  ok([...p.$('f-notifygroup').options].filter((o) => o.value === NOTIFY).length === 1, 'offered once, not once per redraw');
  const tvPosts = p.$('tv-posts-groups');
  ok(p.ticked('tv-posts-groups').join() === TV_POSTS && /saved: TV POSTS ONLY! — not in this number's groups/.test(tvPosts.textContent),
    'the TV posts list keeps its saved group as a ticked row, named');
  ok(tvPosts.textContent.includes(TV_POSTS), 'with its JID, so two such rows can be told apart');
  ok(p.ticked('always-locked').join() === TV_POSTS, 'and so does the always-locked list');

  await p.click('btn-save');
  await p.click('tv-save');
  await p.click('lock-save');
  ok(srv.stored('movieRequests.notify.group') === NOTIFY, 'saving on the new number keeps the notifications group');
  ok(srv.stored('tvRequests.postsGroups').join() === TV_POSTS, 'the TV posts group');
  ok(srv.stored('lockdown.alwaysLocked').join() === TV_POSTS, 'and the always-locked group');
  srv.close();
}

console.log('=== the always-locked list is drawn when the group list arrives after the lockdown status ===');
{
  const { srv, p } = await openPanel('late-list');
  await p.push(OLD_NUMBER);
  ok(p.$('always-locked').querySelectorAll('input.al-g').length === OLD_NUMBER.length,
    'every group gets a box - it used to keep "No groups loaded" until a reload');
  ok(p.ticked('always-locked').join() === TV_POSTS, 'with the saved one ticked');
  srv.close();
}

console.log('=== only an explicit "none" empties a group, and it reaches the server ===');
{
  const { srv, p } = await openPanel('explicit-none', { groups: OLD_NUMBER });
  p.set('f-notifygroup', 'value', '');
  p.set('f-notifytag', 'checked', false);
  await p.click('btn-save');
  ok(/[?&]clearGroups=movieRequests\.notify\.group$/.test(decodeURIComponent(p.lastPut().url)),
    `the save names the group it empties: ${decodeURIComponent(p.lastPut().url)}`);
  ok(srv.stored('movieRequests.notify.group') === '' && srv.stored('movieRequests.notify.tagRequester') === false,
    'and the server empties it, and switches tagging off');
  ok(srv.stored('movieRequests.postsGroup') === POSTS, 'the posts group, untouched, stays');
  ok(p.$('f-notifygroup').value === '', 'the dropdown shows "none" afterwards');
  ok(!srv.audit().some((e) => /kept/.test(e.action)), 'nothing was held back');
  const row = srv.audit().find((e) => e.action === 'changed settings');
  ok(row?.detail === 'changed 2 settings — movieRequests.notify.group: "120363900000000015@g.us" → (empty); '
    + 'movieRequests.notify.tagRequester: true → false',
  `the audit row reads exactly as the 2026-09-24 one does: ${row?.detail}`);

  p.untickAll('tv-posts-groups');
  await p.click('tv-save');
  ok(decodeURIComponent(p.lastPut().url).endsWith('clearGroups=tvRequests.postsGroups'),
    'unticking every TV posts box names that list');
  ok(srv.stored('tvRequests.postsGroups').length === 0 && srv.stored('tvRequests.requestGroups').join() === TV_REQ,
    'and empties it, and only it');

  p.untickAll('dl-groups');
  await p.click('dl-save');
  ok(srv.stored('directLinks.groups').length === 0, 'the direct-links list empties the same way');
  p.untickAll('always-locked');
  await p.click('lock-save');
  ok(srv.stored('lockdown.alwaysLocked').length === 0, 'and the always-locked list');
  p.untickAll('group-checks');
  await p.click('btn-save');
  ok(srv.stored('movieRequests.requestGroups').length === 0, 'and the movie request groups, as before');
  srv.close();
}

console.log('=== a choice not yet saved survives a group-list push ===');
{
  const { srv, p } = await openPanel('push-keeps-choice', { groups: OLD_NUMBER });
  p.set('f-notifygroup', 'value', '');
  p.set('f-postsgroup', 'value', TV_POSTS);
  p.set('f-notifytag', 'checked', false);
  p.set('f-notify-notag', 'value', '15551234567');
  for (const i of p.$('tv-request-groups').querySelectorAll('input')) {
    i.checked = i.value === BETA;
    i.dispatchEvent(new p.window.Event('change', { bubbles: true }));
  }
  await p.push(OLD_NUMBER);
  ok(p.$('f-notifygroup').value === '', '"none", picked and not saved, is still picked');
  ok(p.$('f-postsgroup').value === TV_POSTS, 'so is another posts group');
  ok(p.$('f-notifytag').checked === false && p.$('f-notify-notag').value === '15551234567',
    'the tag box and the no-tag list are left alone - they are not group lists');
  ok(p.ticked('tv-request-groups').join() === BETA, 'and the TV ticks too');
  await p.push(NEW_NUMBER);
  ok(p.$('f-postsgroup').value === TV_POSTS && /^\(chosen: TV POSTS ONLY! — not in this number's groups\)$/.test(p.shown('f-postsgroup')?.textContent),
    `a choice the new number cannot see is kept, and labelled as a choice: "${p.shown('f-postsgroup')?.textContent}"`);
  srv.close();
}

console.log('=== a push after a save elsewhere shows the new saved value ===');
{
  const { srv, p } = await openPanel('saved-elsewhere', { groups: OLD_NUMBER });
  // Another admin, or another tab, empties it. This page is not told until it
  // next reads the config; its redraws must not paint "none" over its own copy.
  srv.cs.update({ movieRequests: { notify: { group: '' } } });
  await p.push(OLD_NUMBER);
  ok(p.$('f-notifygroup').value === NOTIFY, 'the page still shows what it last read as saved');
  await p.h.loadConfig();
  ok(p.$('f-notifygroup').value === '', 'and follows the config once it reads it again');
  srv.close();
}

console.log('=== a stale page cannot empty a group it never showed ===');
{
  const { srv, p } = await openPanel('stale-page', { groups: OLD_NUMBER });
  srv.cs.update({ movieRequests: { notify: { group: '' } } });
  await p.h.loadConfig();                         // this page now shows "none" as saved
  srv.cs.update({ movieRequests: { notify: { group: NOTIFY } } });   // set again elsewhere
  await p.click('btn-save');
  ok(!p.lastPut().url.includes('clearGroups'), 'the page names nothing as cleared - nobody chose "none" here');
  ok(p.lastPut().body.movieRequests?.notify?.group === undefined,
    'and, since 2026-10-12, does not send its "none" at all: nobody edited the dropdown on this page');
  ok(srv.stored('movieRequests.notify.group') === NOTIFY, 'so the server keeps the group set elsewhere');
  ok(p.$('f-notifygroup').value === NOTIFY, 'and the page, given the saved config back, now shows it');

  // A page from before that change still sends it; the server keeps the
  // group, and says so in the audit log.
  srv.cs.update({ movieRequests: { notify: { group: NOTIFY } } });
  await p.srvCall('PUT', '/api/config', { movieRequests: { notify: { group: '' } } });
  ok(srv.stored('movieRequests.notify.group') === NOTIFY, 'an old page\'s whole-form "none" is still kept');
  const row = srv.audit().find((e) => /kept/.test(e.action));
  ok(row && /movieRequests\.notify\.group \("120363900000000015@g\.us"\)/.test(row.detail),
    `the audit log says which group was kept: "${row?.action}" — ${row?.detail}`);
  ok(categoryOf(row) === 'settings', 'filed under Settings');
  srv.close();
}

console.log('=== the Groups tab\'s tag mute is not undone by the next "Save settings" ===');
{
  const { srv, p } = await openPanel('no-tag', { groups: OLD_NUMBER });
  p.set('f-notify-notag', 'value', '15558080185\n15550000001');          // typed, not saved
  await p.win.gaTag('15559998888', true);
  await p.settle();
  ok(p.$('f-notify-notag').value.split('\n').join() === '+15558080185,+15550000001,+15559998888',
    'the Settings box gains the muted number and keeps what was typed there, every number as +digits');
  await p.win.gaTag('15558080185', false);
  await p.settle();
  ok(!p.$('f-notify-notag').value.includes('15558080185'), 'and loses one that is tagged again');
  await p.click('btn-save');
  ok(srv.stored('movieRequests.notify.noTag').join() === '15550000001,15559998888', 'so the save stores both changes');
  srv.close();
}

console.log('=== the beta card: its saved posts group is labelled the same way, and emptying it is named ===');
{
  const srv = await boot('beta');
  srv.cs.update({ beta: { groups: [BETA], postsGroup: TV_REQ } });
  const p = panel(srv);
  await p.h.loadConfig();
  p.setGroups(NEW_NUMBER.filter((g) => g.jid !== TV_REQ));
  await p.h.loadGroups();
  await p.h.loadBetaSection();
  await p.settle();
  ok(p.$('beta-posts').value === TV_REQ && /^\(saved: .* — not in this number's groups\)$/.test(p.shown('beta-posts')?.textContent),
    `the saved beta posts group stays selected: "${p.shown('beta-posts')?.textContent}"`);
  p.set('beta-posts', 'value', '');
  p.untickAll('beta-groups');
  await p.click('beta-save');
  ok(/clearGroups=beta\.groups,beta\.postsGroup$/.test(decodeURIComponent(p.lastPut().url)),
    `emptying both is named: ${decodeURIComponent(p.lastPut().url)}`);
  ok(srv.stored('beta.groups').length === 0 && srv.stored('beta.postsGroup') === '', 'and done');
  srv.close();
}

/* ---------------------------------------------------------- the server */

console.log('=== holdGroupClears ===');
{
  const current = {
    movieRequests: { requestGroups: [REQ], postsGroup: POSTS, notify: { group: NOTIFY } },
    tvRequests: { requestGroups: [TV_REQ], postsGroups: [] }, beta: { groups: [], postsGroup: '' },
    directLinks: { groups: [REQ] }, lockdown: { alwaysLocked: [TV_POSTS] },
  };
  const patch = {
    movieRequests: { requestGroups: [], postsGroup: '', notify: { group: ' ', tagRequester: false }, cooldownSecondsPerUser: 5 },
    tvRequests: { requestGroups: [''], postsGroups: [] }, beta: { postsGroup: null },
    directLinks: { groups: [REQ] }, lockdown: { alwaysLocked: [] },
  };
  const held = holdGroupClears(current, patch, ['lockdown.alwaysLocked']);
  ok(held.map((x) => x.path).join() === 'movieRequests.requestGroups,movieRequests.postsGroup,movieRequests.notify.group,tvRequests.requestGroups',
    `every stored group the patch would empty is held: ${held.map((x) => x.path).join(', ')}`);
  ok(!('postsGroup' in patch.movieRequests) && !('group' in patch.movieRequests.notify) && !('requestGroups' in patch.tvRequests),
    'and taken out of the patch');
  ok(patch.movieRequests.notify.tagRequester === false && patch.movieRequests.cooldownSecondsPerUser === 5,
    'the rest of the patch is left as it was');
  ok(Array.isArray(patch.lockdown.alwaysLocked) && !patch.lockdown.alwaysLocked.length, 'a named clear goes through');
  ok(Array.isArray(patch.tvRequests.postsGroups) && patch.beta.postsGroup === null,
    'emptying what is already empty is nothing to hold');
  ok(held[1].was === POSTS, 'each held one says what it was');
  ok(GROUP_SETTINGS.every((p) => p.split('.').length >= 2), 'every group setting is a path into a section');
}

console.log('=== PUT /config from a panel that predates ?clearGroups= ===');
{
  const srv = await boot('old-panel');
  // What the old panel sent from a Save pressed before its group list arrived.
  const r = await srv.call('PUT', '/api/config', { movieRequests: {
    requestGroups: [], postsGroup: '', notify: { group: '', tagRequester: false, noTag: [] }, cooldownSecondsPerUser: 60,
  } });
  ok(r.status === 200, 'the save is answered, not refused');
  ok(srv.stored('movieRequests.postsGroup') === POSTS && srv.stored('movieRequests.notify.group') === NOTIFY
    && srv.stored('movieRequests.requestGroups').join() === REQ, 'every stored group is kept');
  ok(srv.stored('movieRequests.cooldownSecondsPerUser') === 60, 'the rest of the save is applied');
  const kept = srv.audit().find((e) => /kept/.test(e.action));
  ok(kept?.action === 'settings save kept 3 settings it would have emptied', `and audited: "${kept?.action}"`);
  const deliberate = await srv.call('PUT', '/api/config?allowEmptyGroups=1', { movieRequests: { requestGroups: [] } });
  ok(deliberate.status === 200 && srv.stored('movieRequests.requestGroups').length === 0,
    'its ?allowEmptyGroups=1 still empties the request groups on purpose');
  srv.close();
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
