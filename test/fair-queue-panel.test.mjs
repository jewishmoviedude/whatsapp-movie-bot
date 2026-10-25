/* The fair queue and the cooldown's "nobody else waiting" are options on the panel.
   Run: node test/fair-queue-panel.test.mjs

   The operator (2026-09-30): "I see the cooldown box. But the below should be
   OPTIONS for me to control and change in panel" - the below being "if queue
   is completely empty then obviously theres no issue with someone doing
   multiple requests" and "the additional items of the person who did
   multiple should get bumped to bottom of queue so the other person can get
   the 1 item they need". So three boxes: Settings -> Movies -> Request rules
   gets "Skip the cooldown while nobody else is waiting" under the cooldown,
   Settings -> TV gets its own next to the TV cooldown, and "Fair queue" goes
   under "Movies always before TV" (queue.fairShare). Each loads what is saved
   and saves what is ticked, through the real PUT /config and config store.
   The Queue card marks an extra request, and a film held behind the TV with
   the time its hold ends, on the 24-hour clock.

   The real app.js against the real index.html in linkedom; skipped, with a
   line saying so, where linkedom (a devDependency) is not installed. */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createServer } from '../src/web/server.js';
import { ConfigStore } from '../src/config/store.js';
import { JobQueue } from '../src/core/queue.js';
import { hashPassword } from '../src/util/crypto.js';
import { getPath } from '../src/config/schema.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

let parseHTML = null;
try { ({ parseHTML } = await import('linkedom')); } catch { /* production install */ }
if (!parseHTML) {
  console.log('=== the panel: skipped - linkedom (a devDependency) is not installed ===');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
}

const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fair-queue-panel-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

async function boot(name, settings) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const cs = new ConfigStore({ dataDir: dir, masterKey: 'test-master-key-0123456789abcdef' });
  cs.load();
  cs.update({
    web: { admins: [{ username: 'superadmin', role: 'superadmin', passwordHash: hashPassword('super-secret-1'), createdAt: 1, lastLogin: null }] },
    media: { workDir: path.join(dir, 'media') },
    ...settings,
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
        resolve({ status: res.statusCode, text: buf });
      });
    });
    r.on('error', reject);
    if (data !== null) r.write(data);
    r.end();
  });
  const signin = await call('POST', '/api/auth/login', { username: 'superadmin', password: 'super-secret-1' });
  if (signin.status !== 200) throw new Error(`sign-in failed: ${signin.status} ${signin.text}`);
  return { cs, call, close: () => server.close(), stored: (p) => getPath(cs.get(), p) };
}

/** The real panel, its /api/config calls going to the real server (see test/settings-group-pickers.test.mjs). */
function panel(srv) {
  const { document, window } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  if (!Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked')) {
    Object.defineProperty(window.HTMLInputElement.prototype, 'checked', {
      configurable: true,
      get() { return this.hasAttribute('checked'); },
      set(v) { if (v) this.setAttribute('checked', ''); else this.removeAttribute('checked'); },
    });
  }
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
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
  const puts = [];
  const inflight = new Set();
  const fetch = async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    const answer = (status, out) => ({ ok: status < 400, status, statusText: String(status), text: async () => JSON.stringify(out) });
    if (url === '/api/auth/status') return new Promise(() => {});
    if (url.startsWith('/api/config')) {
      if (method === 'PUT') puts.push({ url, body });
      const c = srv.call(method, url, body);
      inflight.add(c);
      const r = await c.finally(() => inflight.delete(c));
      return { ok: r.status < 400, status: r.status, statusText: String(r.status), text: async () => r.text };
    }
    if (url.startsWith('/api/wa/groups')) return new Promise(() => {});
    if (url === '/api/beta') return answer(200, { features: [], modes: ['off', 'beta', 'on'], mainGroups: {}, conflicts: [] });
    return answer(200, {});
  };
  function EventSource() { this.addEventListener = () => {}; this.close = () => {}; }
  const win = { document, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { reload() {}, href: '' }, navigator: {}, scrollTo() {}, addEventListener() {} };
  const names = ['loadConfig', 'loadTvSection', 'renderQueue'];
  // eslint-disable-next-line no-new-func
  const make = new Function('window', 'document', 'localStorage', 'fetch', 'EventSource',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'confirm', 'alert', 'prompt', 'navigator', 'location',
    `"use strict";\n${app}\n;return { ${names.join(', ')} };`);
  const h = make(win, document, win.localStorage, fetch, EventSource,
    (fn) => { Promise.resolve().then(fn); return 1; }, () => {}, () => {}, () => {}, () => true, () => {}, () => null,
    win.navigator, win.location);
  const $ = (id) => document.getElementById(id);
  const settle = async () => {
    for (let round = 0; round < 20; round++) {
      for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
      if (!inflight.size) break;
      await Promise.allSettled([...inflight]);
    }
  };
  // Ticked the way a person ticks it: the browser fires "change", and "Save
  // settings" sends only what was edited on the page (FORM_FIELDS in app.js,
  // since the save of 2026-10-12 that carried 22 settings nobody had touched).
  const tick = (id, on) => { $(id).checked = on; $(id).dispatchEvent(new window.Event('change', { bubbles: true })); };
  return { h, $, puts, settle, window, tick, click: async (id) => { $(id).dispatchEvent(new window.Event('click')); await settle(); } };
}

console.log('=== the three boxes are where the operator looks, and say what they do ===');
{
  const body = html;
  const near = (a, b, within = 800) => { const i = body.indexOf(a); const j = body.indexOf(b); return i >= 0 && j > i && j - i < within; };
  ok(near('id="f-cooldown"', 'id="f-cooldown-others"'), 'the film box sits right under "Per-user cooldown (s)"');
  ok(near('id="f-tv-cooldown"', 'id="f-tv-cooldown-others"'), 'the TV box right under the TV cooldown');
  ok(near('id="f-queue-priority"', 'id="f-queue-fair"'), '"Fair queue" right under "Movies always before TV"');
  const fairHint = body.slice(body.indexOf('id="f-queue-fair"'), body.indexOf('</label>', body.indexOf('id="f-queue-fair"')));
  ok(/first request goes before anyone's second/.test(fairHint) && /waits behind the TV until the film cooldown/.test(fairHint),
    'its hint explains the turns and the TV rule in plain words');
}

console.log('=== on by default: all three ticked, and a save keeps them on ===');
{
  // The operator, 2026-09-30: "By default on of course but yeh should be options".
  const srv = await boot('defaults', {});
  const p = panel(srv);
  await p.h.loadConfig();
  p.h.loadTvSection();
  await p.settle();
  ok(p.$('f-cooldown-others').checked && p.$('f-tv-cooldown-others').checked && p.$('f-queue-fair').checked,
    'all three boxes start ticked');
  await p.click('btn-save');
  await p.click('tv-save');
  ok(srv.stored('movieRequests.cooldownOnlyWhenOthersWait') === true && srv.stored('tvRequests.cooldownOnlyWhenOthersWait') === true
    && srv.stored('queue.fairShare') === true, 'saving leaves all three on');
  srv.close();
}

console.log('=== the limits: 10 episodes, 1 season, an hour for films and TV by default; an empty box keeps the default ===');
{
  // The operator, 2026-10-12: "in repo by default 1 season max 10 espidoes
  // and 1 hour cooldown for both movies and shows" (request-rule-defaults).
  const srv = await boot('tv-limits', {});
  const p = panel(srv);
  await p.h.loadConfig();
  p.h.loadTvSection();
  await p.settle();
  ok(p.$('f-tv-maxeps').value == 10 && p.$('f-tv-maxseasons').value == 1 && p.$('f-tv-cooldown').value == 3600
    && p.$('f-cooldown').value == 3600,
    `a new install shows 10, 1, 3600 and 3600 for films (${p.$('f-tv-maxeps').value}, ${p.$('f-tv-maxseasons').value}, ${p.$('f-tv-cooldown').value}, ${p.$('f-cooldown').value})`);
  await p.click('tv-save');
  await p.click('btn-save');
  ok(srv.stored('tvRequests.maxEpisodesPerRequest') === 10 && srv.stored('tvRequests.maxSeasonsPerRequest') === 1
    && srv.stored('tvRequests.cooldownSecondsPerUser') === 3600 && srv.stored('movieRequests.cooldownSecondsPerUser') === 3600,
    'and saving keeps them');
  // +'' is 0, no limit: an emptied box would have lifted the cap.
  p.$('f-tv-maxeps').value = '';
  p.$('f-tv-maxseasons').value = '';
  await p.click('tv-save');
  ok(srv.stored('tvRequests.maxEpisodesPerRequest') === 10 && srv.stored('tvRequests.maxSeasonsPerRequest') === 1,
    'an emptied episodes or seasons box saves the default, not "no limit"');
  p.$('f-tv-maxeps').value = '0';
  await p.click('tv-save');
  ok(srv.stored('tvRequests.maxEpisodesPerRequest') === 0, 'a 0 typed in is still "no limit"');
  srv.close();
}

console.log('=== ticked and saved, they reach the config; saved, they load ticked ===');
{
  const srv = await boot('tick', {});
  const p = panel(srv);
  await p.h.loadConfig();
  p.h.loadTvSection();
  await p.settle();
  p.tick('f-cooldown-others', true);
  await p.click('btn-save');
  const moviePut = p.puts[p.puts.length - 1].body;
  ok(moviePut.movieRequests.cooldownOnlyWhenOthersWait === true, 'Save settings sends the film box');
  ok(srv.stored('movieRequests.cooldownOnlyWhenOthersWait') === true, 'and the config has it');
  p.$('f-tv-cooldown-others').checked = true;
  p.$('f-queue-fair').checked = true;
  await p.click('tv-save');
  const tvPut = p.puts[p.puts.length - 1].body;
  ok(tvPut.tvRequests.cooldownOnlyWhenOthersWait === true && tvPut.queue.fairShare === true && tvPut.queue.strictMoviePriority === true,
    'Save TV settings sends the TV box and the fair queue, with movies-first as it was');
  ok(srv.stored('tvRequests.cooldownOnlyWhenOthersWait') === true && srv.stored('queue.fairShare') === true
    && srv.stored('queue.strictMoviePriority') === true, 'and the config has them');
  ok(srv.stored('movieRequests.cooldownOnlyWhenOthersWait') === true, 'the TV save left the film box alone');

  const again = panel(srv);
  await again.h.loadConfig();
  again.h.loadTvSection();
  await again.settle();
  ok(again.$('f-cooldown-others').checked && again.$('f-tv-cooldown-others').checked && again.$('f-queue-fair').checked,
    'a fresh panel loads all three ticked');
  again.$('f-queue-fair').checked = false;
  await again.click('tv-save');
  ok(srv.stored('queue.fairShare') === false && srv.stored('tvRequests.cooldownOnlyWhenOthersWait') === true,
    'unticking the fair queue turns it off, and only it');
  srv.close();
}

console.log('=== the Queue card marks an extra request, and a held film with when it goes ===');
{
  const srv = await boot('card', {});
  const p = panel(srv);
  await p.h.loadConfig();
  await p.settle();
  const until = new Date(2026, 8, 30, 21, 5, 0).getTime();
  const q = {
    paused: false, concurrency: 1, strictMoviePriority: true, fairShare: true, maxLength: 50,
    counts: { pending: { movie: 2, tv: 1 }, active: { movie: 0, tv: 0 }, retrying: 0 },
    active: [], retrying: [], history: [],
    pending: [
      { id: 'b1', label: 'Up (2009)', kind: 'movie', meta: { requester: 'Bob' }, state: 'pending', place: 1 },
      { id: 't1', label: 'Loki season 1', kind: 'tv', group: 'g', meta: {}, jobs: { total: 6 }, state: 'pending', place: 2 },
      { id: 'a2', label: 'Dune (2021)', kind: 'movie', meta: { requester: 'Avi' }, state: 'pending', place: 3, fair: { extra: true, rank: 2, heldUntil: until } },
    ],
  };
  p.h.renderQueue(q);
  const rows = [...p.$('queue-list').querySelectorAll('.item')];
  ok(rows.length === 3, 'three waiting rows');
  ok(!rows[0].querySelector('.tag.extra'), 'a first request has no tag');
  const tag = rows[2].querySelector('.tag.extra')?.textContent ?? '';
  ok(/^extra · after TV until 21:05$/.test(tag), `the held film says so, on the 24-hour clock ("${tag}")`);
  const up = rows[2].querySelector('button[title="Move up"]');
  const top = [...rows[2].querySelectorAll('button')].find((b) => /next/.test(b.textContent));
  ok(up.hasAttribute('disabled'), 'it cannot be moved up past the TV (it waits behind it until the hold ends)');
  ok(top.getAttribute('title') === 'Run next after the TV', `its ⤒ says where it would go (${top.getAttribute('title')})`);
  q.pending[2] = { ...q.pending[2], fair: { extra: true, rank: 2 } };
  p.h.renderQueue(q);
  const plain = [...p.$('queue-list').querySelectorAll('.item')][2].querySelector('.tag.extra')?.textContent ?? '';
  ok(plain === 'extra', `once the hold is over, just "extra" ("${plain}")`);
  srv.close();
}

console.log('=== unticked and saved, they are off, and load unticked ===');
{
  // On by default, so turning them off is the change an operator makes.
  const srv = await boot('untick', {});
  const p = panel(srv);
  await p.h.loadConfig();
  p.h.loadTvSection();
  await p.settle();
  p.tick('f-cooldown-others', false);
  await p.click('btn-save');
  p.$('f-tv-cooldown-others').checked = false;
  p.$('f-queue-fair').checked = false;
  await p.click('tv-save');
  ok(srv.stored('movieRequests.cooldownOnlyWhenOthersWait') === false && srv.stored('tvRequests.cooldownOnlyWhenOthersWait') === false
    && srv.stored('queue.fairShare') === false, 'unticked and saved: all three off in the config');
  const again = panel(srv);
  await again.h.loadConfig();
  again.h.loadTvSection();
  await again.settle();
  ok(!again.$('f-cooldown-others').checked && !again.$('f-tv-cooldown-others').checked && !again.$('f-queue-fair').checked,
    'and they load unticked');
  srv.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
