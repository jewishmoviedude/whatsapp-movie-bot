/* Every number the bot shows is +<digits>: no spaces, dashes or brackets.
   Run: node test/phone-format.test.mjs

   The operator (2026-10-01): "EVERYWHERE ON THE BOT NUMBERS SHOULD BE
   FORMATTED +COUNTRYAREANUMBER NO SPACES NO DASHES NO PARENTHESIS. example
   +15558100180 +447700900428 etc I see in history and queue it's got
   parenthesis and stuff making it un pastable in the members tab".

   formatPhone wrote a US number as "+1 (555) 810-0180", a 10-digit one as
   "(555) 804-0187" with its country code gone, and every request's number
   went through it into History, the queue, the journals, the logs and the
   audit log. A TV job's number was bare digits. The Members tab matched a
   search against bare digits, so neither a pasted "+15558100180" nor the
   "+1 (555) 810-0180" History showed found a member with a name.

   Pinned here:
   - formatPhone gives +<digits> for any input with digits, and null for none;
   - the display normaliser (phoneOut), the free-text one (phonesInText) and
     the search one (phoneQuery), on the server, and the panel's copies of
     them, which must agree with the server's on every input;
   - what was stored in the old shape is shown as +digits without being
     rewritten: History rows, transfers, the audit log, a journalled TV
     request put back after a restart, a log line;
   - what is written from now on is +digits: History rows (both plugins), a
     TV job's queue number, the audit detail of a queue action;
   - a pasted number finds its member, entry or line in either form: the
     Members tab, the Groups tab, the global search, the member picker, the
     audit log, the not-in-library list and the live log;
   - a number pasted into Settings is stored as its digits, which is what
     everything matches on.

   The panel half runs the REAL app.js against the REAL index.html in
   linkedom, like the other panel suites; it is skipped, and says so, where
   linkedom (a devDependency) is not installed. */
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import {
  formatPhone, phoneOut, phonesInText, phoneQuery, textHasPhone,
} from '../src/core/members.js';
import { filterAudit } from '../src/core/audit-filter.js';
import { listMisses, recordMiss } from '../src/core/library-misses.js';
import { createApiRouter } from '../src/web/api.js';
import { JobQueue } from '../src/core/queue.js';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import tvPlugin from '../src/plugins/tv-requests/index.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const settle = () => new Promise((r) => setTimeout(r, 5));

const OLD = '+1 (555) 810-0180';
const E164 = '+15558100180';
const DIGITS = '15558100180';

console.log('=== formatPhone: +<digits>, whatever it is given ===');
{
  for (const [input, want, what] of [
    ['15558100180', '+15558100180', 'a US number'],
    ['447700900428', '+447700900428', 'a UK number'],
    ['6591234567', '+6591234567', 'ten digits keep their country code - no "(659) 123-4567"'],
    ['5558040187', '+5558040187', 'and no special case for ten digits at all'],
    ['972501234567', '+972501234567', 'an Israeli number'],
    [OLD, E164, 'the old "+1 (555) 810-0180" comes back as +15558100180'],
    ['(555) 804-0187', '+5558040187', 'and the old ten-digit form as its digits'],
    [E164, E164, 'an E.164 number is left as it is'],
    ['+44 7700 900428', '+447700900428', 'spaces go'],
    ['1-555-810-0180', '+15558100180', 'dashes go'],
    [15558100180, '+15558100180', 'a number that arrived as a number'],
  ]) ok(formatPhone(input) === want, `${what}: ${JSON.stringify(input)} -> ${formatPhone(input)}`);
  for (const junk of [null, undefined, '', '   ', 'abc', '+', '()-']) {
    ok(formatPhone(junk) === null, `nothing with no digits: ${JSON.stringify(junk)} -> null`);
  }
  ok(!/[ ()-]/.test(formatPhone('15558100180')), 'never a space, a dash or a bracket');
}

console.log('=== phoneOut: a value shown to a person ===');
{
  for (const [input, want, what] of [
    [OLD, E164, 'a number stored the old way'],
    [DIGITS, E164, 'bare digits (a TV job\'s number)'],
    [E164, E164, 'already E.164'],
    ['+447700900428', '+447700900428', 'a UK number'],
    [`${DIGITS}@s.whatsapp.net`, E164, 'a phone jid, a requester with no WhatsApp name'],
    [`${DIGITS}:12@s.whatsapp.net`, E164, 'a phone jid with its device'],
  ]) ok(phoneOut(input) === want, `${what}: ${JSON.stringify(input)} -> ${phoneOut(input)}`);
  for (const keep of ['Abby', 'manual (admin)', 'panel (mommy)', '10000000000007@lid', '2024', '12345',
    '+1 555', 'Dana +1 (555) 123-4567', '1234567890123456', '', '=HYPERLINK("x")']) {
    ok(phoneOut(keep) === keep, `anything that is not just a number is left alone: ${JSON.stringify(keep)}`);
  }
  ok(phoneOut(null) === null && phoneOut(undefined) === undefined, 'and nothing stays nothing');
}

console.log('=== phonesInText: the old form, inside a sentence ===');
{
  ok(phonesInText('request "heat" -> Heat (1995), rated R [from Abby +1 (555) 807-0190]')
    === 'request "heat" -> Heat (1995), rated R [from Abby +15558070190]', 'a log line\'s "[from …]"');
  ok(phonesInText('queued "F1" by hand for Abby +1 (555) 807-0190 (by mommy)')
    === 'queued "F1" by hand for Abby +15558070190 (by mommy)', 'an audit entry');
  ok(phonesInText('tv · pending · requested by +1 (555) 810-0180 · 8 episodes')
    === 'tv · pending · requested by +15558100180 · 8 episodes', 'an audit detail');
  ok(phonesInText('from (555) 804-0187:') === 'from +5558040187:', 'the old ten-digit form');
  for (const keep of ['Heat (1995) 2.36 GB', 'convert DONE — encode, 1.80 GB in 25m 52s', 'banned +15558100180 from all groups',
    'season (2024) 100-1000', '']) {
    ok(phonesInText(keep) === keep, `text with no old-form number is untouched: "${keep}"`);
  }
  ok(phonesInText(phonesInText(`by ${OLD}`)) === `by ${E164}`, 'running it twice changes nothing more');
  ok(phonesInText(null) === null, 'and null stays null');
}

console.log('=== phoneQuery: a search for a number is a search for its digits ===');
{
  ok(phoneQuery(E164) === DIGITS, `"${E164}" looks for ${DIGITS}`);
  ok(phoneQuery(OLD) === DIGITS, `"${OLD}" looks for ${DIGITS}`);
  ok(phoneQuery('+44 7700 900428') === '447700900428', 'spaces are ignored');
  ok(phoneQuery('732') === '732', 'three digits are enough to look');
  for (const not of ['Abby', 'heat 1995', '12', '+1', '', '()']) ok(phoneQuery(not) === null, `not a number search: "${not}"`);
  ok(textHasPhone(`requested by ${OLD}`, phoneQuery(E164)), 'a pasted +digits finds the old form');
  ok(textHasPhone(`banned ${E164}`, phoneQuery(OLD)), 'and the old form finds +digits');
  ok(textHasPhone(`ignoring ${DIGITS}@s.whatsapp.net`, phoneQuery(E164)), 'and the digits in a jid');
  ok(!textHasPhone('requested by +17325550000', phoneQuery(E164)), 'but not somebody else\'s number');
}

console.log('=== the audit log and the not-in-library list find a pasted number ===');
{
  const events = [
    { ts: 3, user: 'mommy', action: 'cancelled "Heat (1995)"', detail: `pending · requested by ${OLD}` },
    { ts: 2, user: 'mommy', action: `banned ${E164} from all groups (2 affected)`, detail: null },
    { ts: 1, user: 'mommy', action: 'changed settings', detail: 'omdb.apiKey changed' },
  ];
  for (const q of [E164, OLD, DIGITS]) {
    const hits = filterAudit(events, { q }).events.map((e) => e.ts);
    ok(hits.join() === '3,2', `audit search "${q}" finds both entries, the old form and the new (${hits.join()})`);
  }
  ok(filterAudit(events, { q: 'settings' }).events.length === 1, 'a word search is what it always was');

  const store = (() => { const m = new Map(); return { get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, v) }; })();
  store.set('library-misses', [
    { key: 'a', kind: 'tv', title: 'Bluey', request: 'bluey s9', requesters: [OLD], lastAt: 2 },
    { key: 'b', kind: 'tv', title: 'Loki', request: 'loki s3', requesters: ['Dana'], lastAt: 1 },
  ]);
  for (const q of [E164, OLD]) {
    const hits = listMisses(store, { q }).map((m) => m.key);
    ok(hits.join() === 'a', `not-in-library search "${q}" finds the requester stored as "${OLD}" (${hits.join()})`);
  }

  // The same member asking again after the change is not listed twice.
  const again = (() => { const m = new Map(); return { get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, v) }; })();
  recordMiss(again, { kind: 'tv', title: 'Bluey', season: 9, request: 'bluey s9', requester: OLD });
  recordMiss(again, { kind: 'tv', title: 'Bluey', season: 9, request: 'bluey s9', requester: E164 });
  ok(again.get('library-misses')[0].requesters.length === 1, 'one member, under the old form and the new, is one requester');
}

console.log('=== History rows are written as +digits, whatever the record held ===');
{
  const data = {};
  const ctx = { store: { get: (k, d) => data[k] ?? d, set: (k, v) => { data[k] = v; } }, log: { debug() {} } };
  moviePlugin.upsertHistory(ctx, { id: 'm1', status: 'sent', requesterNumber: '15558070190', requesterNumberDisplay: '+1 (555) 807-0190' });
  ok(data.history[0].requesterNumberDisplay === '+15558070190',
    `a film resumed from an old journal: ${data.history[0].requesterNumberDisplay}`);
  ok(data.history[0].requesterNumber === '15558070190', 'the digits it is matched on are untouched');

  const tvData = {};
  const tvCtx = { store: { get: (k, d) => tvData[k] ?? d, set: (k, v) => { tvData[k] = v; } }, log: { debug() {} } };
  tvPlugin._history(tvCtx, { id: 't1', kind: 'tv', requesterNumber: DIGITS, requesterNumberDisplay: OLD });
  ok(tvData.history[0].requesterNumberDisplay === E164, `a TV row from a note written before the change: ${tvData.history[0].requesterNumberDisplay}`);
}

/* ------------------------------------------------- the TV plugin, live and resumed */

const TVREQ = 'tvreq@g.us';
const SERIES = { Items: [{ Id: 'SER1', Name: 'The Boys', ProductionYear: 2019 }] };
const SEASONS = { Items: [{ Id: 'S1', IndexNumber: 1 }] };
const EPISODES = { Items: [1, 2].map((n) => ({
  Id: `E${n}`, SeriesName: 'The Boys', ParentIndexNumber: 1, IndexNumber: n, Name: `Ep ${n}`,
  MediaSources: [{ Path: `/s1e${n}.mkv`, Size: n }],
})) };
globalThis.fetch = async (url) => {
  const u = String(url);
  for (const [k, v] of Object.entries({ '/Items': SERIES, '/Seasons': SEASONS, '/Episodes': EPISODES })) {
    if (u.includes(k)) return { ok: true, status: 200, json: async () => v };
  }
  return { ok: false, status: 404, statusText: 'NF', json: async () => ({}) };
};

async function tvSetUp(store = new Map()) {
  await tvPlugin.teardown();
  const queue = new JobQueue({ concurrency: 1, maxLength: 104 });
  const add = queue.add.bind(queue);
  queue.add = (job, o) => add({ ...job, run: () => new Promise(() => {}) }, o);
  queue.pause();
  const ctx = {
    config: {
      tvRequests: { enabled: true, requestGroups: [TVREQ], postsGroups: ['tvposts@g.us'], cooldownSecondsPerUser: 0, blockedRatings: [] },
      movieRequests: {
        reactions: { researching: '🔍', added: '🎬', failed: '⚠️', cancelled: '❌', done: '✅', duplicate: '🤥', positions: ['1️⃣', '2️⃣'], positionOverflow: '🔢' },
        notify: {},
      },
      library: { jellyfin: { baseUrl: 'http://jf:8096', accessToken: 'TOK', userId: 'U1' } },
      media: { workDir: '/tmp/phone-format-test' },
      beta: { groups: [], postsGroup: '', features: {} },
    },
    bot: {
      isConnected: () => true, isGroupAdmin: () => false, deleteMessage: async () => {}, archiveChat: async () => {},
      sendText: async () => ({ key: { id: 'n' } }), react: async () => true,
    },
    queue,
    store: { get: (k, d) => (store.has(k) ? structuredClone(store.get(k)) : d), set: (k, v) => store.set(k, structuredClone(v)) },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  };
  await tvPlugin.setup(ctx);
  return { ctx, queue };
}

console.log('=== a TV request\'s number in the queue is +digits ===');
{
  const { ctx, queue } = await tvSetUp();
  // As bot.js builds a message now: senderNumberDisplay = formatPhone(senderNumber).
  const msg = { id: 'tv1', key: { id: 'tv1', remoteJid: TVREQ }, text: 'The Boys season 1', chatJid: TVREQ, isGroup: true,
    fromMe: false, messageType: 'conversation', senderJid: '555@lid', senderNumber: DIGITS,
    senderNumberDisplay: formatPhone(DIGITS), timestamp: Date.now() };
  await tvPlugin.onMessage(msg, ctx);
  await settle();
  const row = queue.snapshot().pending.find((e) => e.kind === 'tv');
  ok(row?.meta?.requesterNumber === E164, `the queue's number is +digits, not bare digits: ${row?.meta?.requesterNumber}`);
  ok(row?.meta?.requester === E164, `and the requester, a member with no WhatsApp name, too: ${row?.meta?.requester}`);
  ok(row?.meta?.memberKey === `num:${DIGITS}`, 'the key the fair order matches on is still the bare digits');
  await tvPlugin.teardown();
}

console.log('=== a TV request journalled before the change comes back as +digits ===');
{
  const store = new Map();
  store.set('pending', [{
    reqKey: 'tv-old-1', label: 'The Boys season 1 — 2 episode(s)',
    msgId: 'old1', msgKey: { id: 'old1', remoteJid: TVREQ }, chatJid: TVREQ,
    requester: OLD, requesterNumber: DIGITS, memberKey: `num:${DIGITS}`, baseRow: { id: 'old1', kind: 'tv', status: 'queued' },
    episodes: EPISODES.Items.map((e) => ({ id: e.Id, series: 'The Boys', season: 1, episode: e.IndexNumber, title: e.Name })),
  }]);
  const { queue } = await tvSetUp(store);
  await settle();
  const row = [...queue.snapshot().pending, ...queue.snapshot().active].find((e) => e.group === 'tv-old-1');
  ok(row?.meta?.requester === E164 && row?.meta?.requesterNumber === E164,
    `"${OLD}" and "${DIGITS}" from the journal are shown as ${row?.meta?.requester} and ${row?.meta?.requesterNumber}`);
  ok(store.get('pending')?.[0]?.requester === OLD, 'the journal itself is not rewritten');
  await tvPlugin.teardown();
}

/* ------------------------------------------------------------------- the API */

function makeStateStore() {
  const spaces = new Map();
  return {
    namespace(name) {
      if (!spaces.has(name)) spaces.set(name, { data: {} });
      const sp = spaces.get(name);
      return {
        get: (k, d) => sp.data[k] ?? d,
        set: (k, v) => { sp.data[k] = v; },
        push: (k, v) => { (sp.data[k] ??= []).unshift(v); },
      };
    },
  };
}
function makeConfigStore() {
  let cfg = {
    web: { adminPasswordHash: 'x' }, bannedNumbers: [],
    movieRequests: { requestGroups: [], notify: { noTag: [] }, reactions: {} },
    media: {}, omdb: {}, whatsapp: { accounts: [] }, tvRequests: {}, directLinks: {}, queue: {}, lockdown: {},
  };
  return {
    get: () => cfg,
    update: (patch) => {
      const merge = (a, b) => {
        for (const [k, v] of Object.entries(b)) {
          if (v && typeof v === 'object' && !Array.isArray(v)) merge(a[k] ??= {}, v);
          else a[k] = v;
        }
        return a;
      };
      cfg = merge(JSON.parse(JSON.stringify(cfg)), patch);
      return cfg;
    },
    redacted: () => ({ ok: true }),
    onChange: () => {},
  };
}
function call(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {};
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch { /* not json */ } resolve({ status: res.statusCode, json }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

console.log('=== the API sends stored numbers as +digits, and leaves them stored ===');
{
  const stateStore = makeStateStore();
  const configStore = makeConfigStore();
  const queue = new JobQueue({ concurrency: 1 });
  queue.pause();
  const movies = stateStore.namespace('movie-requests');
  const tv = stateStore.namespace('tv-requests');
  movies.set('history', [{ id: 'h1', kind: 'movie', at: 3, requester: 'Abby', requesterNumber: '15558070190', requesterNumberDisplay: '+1 (555) 807-0190' }]);
  tv.set('history', [
    { id: 'h2', kind: 'tv', at: 2, requester: null, requesterNumber: DIGITS, requesterNumberDisplay: OLD },
    { id: 'h3', kind: 'tv', at: 1, requester: '15550001111@s.whatsapp.net', requesterNumber: '15550001111' },
  ]);
  movies.set('transfers', [{ at: 1, title: 'Heat', requester: 'Abby', requesterNumber: '+1 (555) 807-0190' }]);
  tv.set('library-misses', [{ key: 'k', kind: 'tv', title: 'Bluey', request: 'bluey', requesters: [OLD, 'Dana'], lastAt: 1 }]);
  movies.set('wanted', [{ title: 'Heat', count: 1, lastAt: 1, requesters: [`${DIGITS}@s.whatsapp.net`, 'Dana', 'x@lid'] }]);
  stateStore.namespace('audit').set('events', [
    { ts: 1, user: 'mommy', action: 'queued "F1" by hand for Abby +1 (555) 807-0190', detail: `requested by ${OLD}` },
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: { username: 'mommy', role: 'superadmin' } }; next(); });
  app.use('/api', createApiRouter({
    configStore, bot: { dataDir: '/tmp', groups: () => [], on: () => {} }, queue, linkQueue: new JobQueue({ concurrency: 1 }),
    pluginManager: { plugins: new Map(), notifyConfigChange: async () => {} },
    stateStore, fileLogger: { tail: () => [] }, alerts: {}, lockScheduler: {}, failover: null,
  }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const port = server.address().port;

  const hist = (await call(port, 'GET', '/api/history')).json;
  const byId = Object.fromEntries((hist ?? []).map((r) => [r.id, r]));
  ok(byId.h1?.requesterNumberDisplay === '+15558070190', `History: "+1 (555) 807-0190" is sent as ${byId.h1?.requesterNumberDisplay}`);
  ok(byId.h2?.requesterNumberDisplay === E164, `a TV row too: ${byId.h2?.requesterNumberDisplay}`);
  ok(byId.h3?.requester === '+15550001111' && byId.h3?.requesterNumberDisplay === '+15550001111',
    `a requester kept as a jid, with no display number, is shown as +digits: ${byId.h3?.requester} · ${byId.h3?.requesterNumberDisplay}`);
  ok(byId.h1?.requester === 'Abby' && byId.h1?.requesterNumber === '15558070190', 'names and the stored digits are untouched');
  ok(movies.get('history')[0].requesterNumberDisplay === '+1 (555) 807-0190', 'and nothing stored is rewritten');

  const tr = (await call(port, 'GET', '/api/transfers')).json;
  ok(tr?.[0]?.requesterNumber === '+15558070190' && tr[0].requester === 'Abby', `Transfers: ${tr?.[0]?.requesterNumber}`);

  const misses = (await call(port, 'GET', '/api/library-misses')).json;
  ok(misses?.misses?.[0]?.requesters?.join() === `${E164},Dana`, `Not in library: ${misses?.misses?.[0]?.requesters?.join()}`);
  for (const q of [E164, OLD]) {
    const found = (await call(port, 'GET', `/api/library-misses?q=${encodeURIComponent(q)}`)).json;
    ok(found?.misses?.length === 1, `and searching it for "${q}" finds the row`);
  }

  const wanted = (await call(port, 'GET', '/api/wanted')).json;
  ok(wanted?.wanted?.[0]?.requesters?.join() === `${E164},Dana,x@lid`, `Wanted: a phone jid is +digits, a @lid is left (${wanted?.wanted?.[0]?.requesters?.join()})`);

  const audit = (await call(port, 'GET', '/api/audit')).json;
  ok(audit?.[0]?.action === 'queued "F1" by hand for Abby +15558070190' && audit[0].detail === `requested by ${E164}`,
    `the audit log shows an old entry as +digits: "${audit?.[0]?.action}" — ${audit?.[0]?.detail}`);
  const searched = (await call(port, 'GET', `/api/audit?q=${encodeURIComponent(E164)}`)).json;
  ok(searched?.events?.length === 1 && searched.events[0].detail === `requested by ${E164}`, 'a pasted +digits finds it, shown the same way');

  // A queue action's audit detail names the requester as +digits.
  const id = queue.add({ kind: 'tv', label: 'Bluey S01E01', meta: { kind: 'tv', requester: OLD, requesterNumber: DIGITS }, run: async () => {} });
  await call(port, 'DELETE', `/api/queue/${id}`);
  const ev = stateStore.namespace('audit').get('events', [])[0];
  ok(/requested by \+15558100180/.test(ev?.detail ?? ''), `a cancel's audit detail: "${ev?.detail}"`);

  // Numbers pasted into Settings are stored as their digits.
  await call(port, 'PUT', '/api/config', { movieRequests: { notify: { noTag: [E164, OLD, ' +44 7700 900428 ', ''] } }, bannedNumbers: [OLD] });
  ok(configStore.get().movieRequests.notify.noTag.join() === `${DIGITS},447700900428`,
    `"Never @-tag" keeps digits, once each: ${configStore.get().movieRequests.notify.noTag.join()}`);
  ok(configStore.get().bannedNumbers.join() === DIGITS, `and so does the banned list: ${configStore.get().bannedNumbers.join()}`);
  server.close();
}

/* ------------------------------------------------------------------ the panel */

let parseHTML = null;
try { ({ parseHTML } = await import('linkedom')); } catch { /* a production install */ }

if (!parseHTML) {
  console.log('=== the panel: SKIPPED - linkedom is not installed (npm install --include=dev) ===');
} else {
  const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  const csvJs = fs.readFileSync(new URL('../src/web/public/csv-export.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');

  const ROSTER = [
    { key: `num:${DIGITS}`, id: '111@lid', number: DIGITS, name: 'Abby', groups: [{ jid: 'g1@g.us', subject: 'Movies', admin: null }],
      groupCount: 1, adminCount: 0, msgCount: 4, firstSeen: 1, lastSeen: 2 },
    { key: 'num:447700900428', id: '222@lid', number: '447700900428', name: 'Dan', groups: [{ jid: 'g1@g.us', subject: 'Movies', admin: null }],
      groupCount: 1, adminCount: 0, msgCount: 1, firstSeen: 1, lastSeen: 2 },
  ];
  const routes = { '/members': { members: ROSTER } };

  function loadPanel() {
    const { document, window } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
    window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
    const fetch = async (url) => {
      if (url === '/api/auth/status') return new Promise(() => {});
      const path = url.replace(/^\/api/, '').split('?')[0];
      const out = typeof routes[path] === 'function' ? routes[path]() : routes[path] ?? {};
      return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(out) };
    };
    const localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    const win = { document, localStorage, location: { reload() {}, href: '' }, navigator: {}, scrollTo() {}, addEventListener() {},
      MutationObserver: window.MutationObserver };
    const exported = ['phoneOut', 'phonesInText', 'phoneQuery', 'renderQueue', 'loadHistory', 'logLine', 'loadMembersRoster',
      'renderRoster', 'renderMembers', 'runSearch', 'renderLog'];
    // eslint-disable-next-line no-new-func
    const make = new Function('window', 'document', 'localStorage', 'fetch', 'EventSource',
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'confirm', 'alert', 'prompt',
      'navigator', 'location', `"use strict";\n${app}\n;\n${csvJs}\n;return { ${exported.join(', ')}, setLog: (l) => { logLines = l; } };`);
    const h = make(win, document, localStorage, fetch, function EventSource() {},
      () => 0, () => {}, () => 0, () => {}, () => true, () => {}, () => null, win.navigator, win.location);
    return { document, win, h };
  }
  const tick = () => new Promise((r) => setImmediate(r));
  const { document, win, h } = loadPanel();
  const $ = (id) => document.getElementById(id);

  console.log('=== the panel\'s helpers follow the server\'s rules exactly ===');
  {
    const inputs = [OLD, DIGITS, E164, '+447700900428', '(555) 804-0187', `${DIGITS}@s.whatsapp.net`, `${DIGITS}:3@s.whatsapp.net`,
      '10000000000007@lid', 'Abby', 'manual (admin)', '2024', '+1 555', '1234567890123456', '', null, undefined,
      'Heat (1995)', `[from Abby ${OLD}]`, `requested by ${OLD} and (555) 804-0187`, '732', '+1', 'heat 1995'];
    const differ = (fn) => inputs.filter((v) => h[fn](v) !== { phoneOut, phonesInText, phoneQuery }[fn](v));
    for (const fn of ['phoneOut', 'phonesInText', 'phoneQuery']) {
      ok(differ(fn).length === 0, `${fn}: the panel and the server agree on every input${differ(fn).length ? ` (not on ${JSON.stringify(differ(fn))})` : ''}`);
    }
  }

  console.log('=== History: a row stored as "+1 (555) 807-0190" shows +15558070190 ===');
  {
    // As GET /history sent it before the server normalised it, so the
    // panel's own rule is what is tested here.
    routes['/history'] = [
      { id: 'h1', kind: 'movie', at: 3, title: 'Heat', request: 'heat', status: 'sent', requester: 'Abby', requesterNumber: '15558070190', requesterNumberDisplay: '+1 (555) 807-0190' },
      { id: 'h2', kind: 'tv', at: 2, title: 'Bluey', request: 'bluey', status: 'sent', requester: null, requesterNumber: DIGITS, requesterNumberDisplay: OLD },
    ];
    await h.loadHistory();
    await tick();
    const movieRow = $('history-list').textContent;
    const tvRow = $('history-tv').textContent;
    ok(movieRow.includes('Abby · +15558070190'), `the film's row reads "Abby · +15558070190"`);
    ok(!/\(555\)|807-0190/.test(movieRow), 'with no brackets or dashes left in it');
    ok(tvRow.includes(E164) && !tvRow.includes('(732)'), 'and the TV row the same');
  }

  console.log('=== the queue: +digits, and a number not shown twice ===');
  {
    h.renderQueue({
      paused: false, concurrency: 1, strictMoviePriority: true, maxLength: 104,
      counts: { pending: { movie: 1, tv: 1 }, active: { movie: 1, tv: 0 } },
      active: [{ id: 'a1', label: 'Heat (1995)', kind: 'movie', state: 'running', startedAt: Date.now(),
        meta: { requester: 'Abby', requesterNumber: '+1 (555) 807-0190' }, progress: { stage: 'download', text: '1%', pct: 1 } }],
      pending: [
        { id: 'p1', label: 'Up (2009)', kind: 'movie', state: 'pending', place: 1, meta: { requester: 'Dan', requesterNumber: '+447700900428' } },
        { id: 'p2', group: 'tv-1', label: 'Bluey season 1', kind: 'tv', state: 'pending', place: 2, meta: { requester: OLD, requesterNumber: DIGITS },
          jobs: { total: 2, done: 0, failed: 0, cancelled: 0, running: 0, waiting: 2 }, current: [] },
      ],
      retrying: [], history: [],
    });
    const running = document.querySelector('#activity .act-job .act-meta:not([data-request-progress])')?.textContent ?? '';
    ok(running.includes('requested by Abby · +15558070190'), `Now running: "${running.trim()}"`);
    const subs = [...$('queue-list').querySelectorAll('.item-sub')].map((e) => e.textContent.trim());
    ok(subs[0] === 'from Dan · +447700900428', `a waiting film: "${subs[0]}"`);
    ok(subs[1] === `2 episodes · from ${E164}`, `a TV request named by its number shows it once, as +digits: "${subs[1]}"`);
    ok(!/[()]/.test(subs.join(' ')) && !/\b15558100180\b/.test(subs.join(' ').replace(E164, '')), 'no brackets, and no bare digits');
  }

  console.log('=== the Members tab finds a pasted number, either way it was copied ===');
  {
    await h.loadMembersRoster();
    await tick();
    const names = () => [...$('mr-list').querySelectorAll('.member-row')].map((r) => r.textContent);
    for (const q of [E164, OLD, DIGITS, '+1 555 810 0180']) {
      $('mr-filter').value = q;
      h.renderRoster();
      const found = names();
      ok(found.length === 1 && found[0].includes('Abby'), `"${q}" finds Abby, who has a name (${found.length} found)`);
    }
    $('mr-filter').value = '+447700900428';
    h.renderRoster();
    ok(names().length === 1 && names()[0].includes('Dan'), 'and a UK number finds Dan');
    $('mr-filter').value = 'abby';
    h.renderRoster();
    ok(names().length === 1, 'a name search is what it always was');
    $('mr-filter').value = '';
  }

  console.log('=== the Groups tab, the global search and the member picker ===');
  {
    h.renderMembers([{ id: `${DIGITS}@s.whatsapp.net`, number: DIGITS, admin: null }, { id: '9@lid', number: '15550001111', admin: null }]);
    $('ga-member-filter').value = OLD;
    h.renderMembers([{ id: `${DIGITS}@s.whatsapp.net`, number: DIGITS, admin: null }, { id: '9@lid', number: '15550001111', admin: null }]);
    const shown = [...$('ga-members').querySelectorAll('.item-title')].map((e) => e.textContent.trim());
    ok(shown.length === 1 && shown[0].startsWith(E164), `a group's member list filtered by "${OLD}": ${shown.join(' | ')}`);
    $('ga-member-filter').value = '';

    h.runSearch(E164);
    const hits = $('gsearch-results').textContent;
    ok(hits.includes('Abby'), 'the search box at the top finds a named member by a pasted +digits');
    h.runSearch(OLD);
    ok($('gsearch-results').textContent.includes('Abby'), 'and by the old form');
    h.runSearch('');

    for (const pasted of [E164, OLD]) {
      $('q-member').value = pasted;
      let key = null, err = null;
      try { key = await win.memberKeyFrom('q-member'); } catch (e) { err = e; }
      ok(key === `num:${DIGITS}`, `the "for member" picker takes a pasted "${pasted}" as Abby (${key ?? err?.message})`);
    }
    $('q-member').value = '732';
    let refused = null;
    try { await win.memberKeyFrom('q-member'); } catch (e) { refused = e; }
    ok(/is not a member/.test(refused?.message ?? ''), 'but a few digits pick nobody');
    $('q-member').value = '';
  }

  console.log('=== the log viewer shows and finds old lines as +digits ===');
  {
    const line = { ts: Date.now(), level: 'info', scope: 'movie-requests', msg: `request "heat" -> Heat (1995), rated R [from Abby ${OLD}]` };
    const out = h.logLine(line);
    ok(out.includes(`[from Abby ${E164}]`) && !out.includes('(732)'), 'a line logged the old way reads +15558100180');

    const now = { ts: Date.now(), level: 'info', scope: 'movie-requests', msg: `🔔 notify [queued] tagged ${E164}: Up (2009) — added to the queue` };
    const other = { ts: Date.now(), level: 'info', scope: 'bot', msg: 'group cache refreshed: 15 groups' };
    h.setLog([line, now, other]);
    for (const q of [E164, OLD]) {
      $('log-filter').value = q;
      h.renderLog();
      ok($('log-count').textContent.startsWith('2 of 3'), `the filter "${q}" finds the old line and the new one (${$('log-count').textContent})`);
    }
    $('log-filter').value = '';

    // Logs → debug log files → View: a file from before the change reads
    // +digits too, as the live log does.
    routes['/logs/file/debug-2026-09-30.log'] = `05:00:00 [info] (movie-requests) request "heat" -> Heat (1995), rated R [from Abby ${OLD}]`;
    await win.viewLogFile('debug-2026-09-30.log');
    const viewed = $('logfile-view').textContent;
    ok(viewed.includes(`[from Abby ${E164}]`) && !viewed.includes('(732)'), `a log file viewed on the panel reads +15558100180 ("${viewed.slice(-40)}")`);
    ok(viewed.includes('Heat (1995)'), 'and the rest of the line, brackets and all, is as it was written');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
