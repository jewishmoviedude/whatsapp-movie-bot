/* The cooldown can step aside while nobody else is waiting, and every request knows whose it is.
   Run: node test/cooldown-nobody-waiting.test.mjs

   The operator's request (2026-09-30): "option in panel if queue is
   completely empty then obviously theres no issue with someone doing
   multiple requests", and, of that and the fair queue, "the below should be
   OPTIONS for me to control and change in panel". So
   movieRequests.cooldownOnlyWhenOthersWait and its TV twin, on by default (the operator: "By default on of course"):
   on, a member's request inside their cooldown is let through when no OTHER
   member has anything waiting or running in the queue (their own requests do
   not count - the first one, running at once, would otherwise always send
   the second into the cooldown), and the clock still starts again. Anything
   queued from the panel counts as somebody else's. A beta test is never let
   through by it.

   Found in review (2026-09-30), before it shipped: it let through requests
   that queue nothing as well. A member alone in an idle queue - the usual
   state - sent "#request The Boys" ten times and the bot sent twenty
   messages ("which season?" and a notifications line each), where the
   cooldown allowed two; ten films not found drew ten OMDb calls. And a
   "which season?" pass the option let past was left in place, and later got
   a second season through while another member waited. So the cooldown
   steps aside only when the member's request that started their clock
   queued something, and a pass is spent by the request the option lets
   through.

   2026-10-01: the operator's rule after Ben Lewis's three 🚫 ("cooldown is
   only if the members first request actually puts an item in queue",
   test/cooldown-after-queued.test.mjs). The clock now starts only when a
   request queues something, so the "did the request that started it queue
   anything?" condition holds of every running clock and is gone, and what
   stops the requests that queue nothing is the flood backstop - five answers
   in ten minutes - which the option never waives. The blocks below that
   relied on the clock starting at every request say so where they changed:
   offer() stops a request at its 🔍, before anything is queued, so a test
   that needs a queued request writes the clock its queueing would have
   started (queuedFilm).

   The fair queue (test/fair-queue.test.mjs) needs to know whose each request
   is: both plugins put `memberKey` - the sender's number, digits only, else
   their JID - on the jobs they queue and in their journals, so a request put
   back after a restart keeps its turn. These run the real plugins against the
   real queue. */
import './fixtures/roomy-disk.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import tvPlugin from '../src/plugins/tv-requests/index.js';
import { JobQueue } from '../src/core/queue.js';
import { requestMemberKey } from '../src/core/members.js';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const settle = () => new Promise((r) => setTimeout(r, 5));

console.log('=== whose a request is ===');
{
  ok(requestMemberKey({ senderNumber: '+1 (555) 111-2222', senderJid: 'x@lid' }) === 'num:15551112222',
    'the sender\'s number, digits only, when WhatsApp gave it');
  ok(requestMemberKey({ senderNumber: null, senderJid: 'abc@lid' }) === 'lid:abc@lid', 'else their JID');
  ok(requestMemberKey({}) === null, 'and nothing when there is neither');
}

/* ------------------------------------------------------------ films */

const GROUP = 'req@g.us';

function movieHarness({ onlyWhenOthersWait = false, cooldownSeconds = 30 } = {}) {
  const store = {};
  const seen = { reacted: [] };
  const queue = new JobQueue({ concurrency: 1 });
  queue.pause();
  const ctx = {
    store: { get: (k, d) => store[k] ?? d, set: (k, v) => { store[k] = v; } },
    log: { info() {}, warn() {}, debug() {}, error() {} },
    queue,
    config: {
      movieRequests: {
        requestGroups: [GROUP], requirePrefix: true, prefix: '#request',
        cooldownSecondsPerUser: cooldownSeconds, cooldownOnlyWhenOthersWait: onlyWhenOthersWait,
        replyOnBlock: false, reactions: { researching: '🔍', tooFast: '🚫' },
      },
    },
    bot: {
      isGroupAdmin: () => false,
      react: async (msg, e) => { seen.reacted.push({ from: msg.senderJid, emoji: e }); },
      sendText: async () => {},
      isConnected: () => true,
      deleteMessage: async () => {},
    },
  };
  return { ctx, seen, store, queue };
}

let n = 0;
function filmMsg(who, text) {
  n += 1;
  return {
    id: `m${n}`, chatJid: GROUP, senderJid: `${who}@lid`, senderNumber: { avi: '15550000001', bob: '15550000002' }[who] ?? null,
    pushName: who, text, timestamp: Date.now(), isGroup: true, fromMe: false, key: { id: `m${n}`, remoteJid: GROUP },
  };
}

/** Only the cooldown gate: stopped at the lookup's first reaction, as test/burst-requests.test.mjs does. */
async function offer(ctx, msg) {
  let accepted = false;
  const bot = ctx.bot;
  const patched = { ...ctx, bot: { ...bot, react: async (m, e) => {
    if (e === '🔍') { accepted = true; throw new Error('stop here'); }
    return bot.react(m, e);
  } } };
  try { await moviePlugin.onMessage(msg, patched); } catch { /* stopped deliberately */ }
  return accepted;
}

/** A film of `who`'s in the queue, as a request from the group puts it there. */
const queueFilm = (queue, who, label = 'a film') => queue.add({
  label, meta: { requester: who, memberKey: requestMemberKey(filmMsg(who, '')) }, run: async () => {},
});

/** The film queued, as the request offer() stopped at its 🔍 would have: in the queue, and the clock started. */
const queuedFilm = (h, who, label = 'a film') => {
  queueFilm(h.queue, who, label);
  h.store[`cooldown:${who}@lid`] = { at: Date.now(), what: label };
};

console.log('=== films: off, the cooldown holds even in an empty queue (as always) ===');
{
  const h = movieHarness();
  ok(await offer(h.ctx, filmMsg('avi', '#request One')), 'the first request goes through');
  queuedFilm(h, 'avi', 'One');                       // it was found and queued
  ok(!(await offer(h.ctx, filmMsg('avi', '#request Two'))), 'the second, inside the cooldown, does not');
  ok(h.seen.reacted.filter((r) => r.emoji === '🚫').length === 1, 'and gets 🚫');
}

console.log('=== films: on, a member alone in the queue is let through once their request is queued ===');
{
  const h = movieHarness({ onlyWhenOthersWait: true });
  ok(await offer(h.ctx, filmMsg('avi', '#request One')), 'the first request goes through');
  queuedFilm(h, 'avi', 'One');
  ok(await offer(h.ctx, filmMsg('avi', '#request Two')), 'the second, inside the cooldown, with only their own film in the queue: through');
  queuedFilm(h, 'avi', 'Two');
  ok(h.store['cooldown:avi@lid'].what === 'Two', 'and once it queues, the clock starts again');
  ok(await offer(h.ctx, filmMsg('avi', '#request Three')), 'and the third, the same way');
  ok(!h.seen.reacted.some((r) => r.emoji === '🚫'), 'nobody got 🚫');
}

console.log('=== films: a request that queued nothing starts no clock, with the option on or off ===');
{
  // Until 2026-10-01 it did, and with the option on a request that queued
  // nothing was followed by the cooldown all the same (the review of
  // 2026-09-30). Now neither starts it; the real plugin's ten films not
  // found, below, are stopped by the backstop instead.
  for (const on of [false, true]) {
    const h = movieHarness({ onlyWhenOthersWait: on });
    ok(await offer(h.ctx, filmMsg('avi', '#request Nothing 1')) && await offer(h.ctx, filmMsg('avi', '#request Nothing 2')),
      `option ${on ? 'on' : 'off'}: two requests that queue nothing are both looked up`);
    ok(h.store['cooldown:avi@lid'] === undefined, 'and no clock has started');
  }
}

console.log('=== films: on, but somebody else is waiting: the cooldown holds ===');
{
  const h = movieHarness({ onlyWhenOthersWait: true });
  ok(await offer(h.ctx, filmMsg('avi', '#request One')), 'the first request goes through');
  queuedFilm(h, 'avi', 'One');
  queueFilm(h.queue, 'bob', 'Bob\'s film');
  ok(!(await offer(h.ctx, filmMsg('avi', '#request Two'))), 'another member\'s film waiting: the second is refused');
  ok(h.seen.reacted.filter((r) => r.emoji === '🚫').length === 1, 'with 🚫');

  const p = movieHarness({ onlyWhenOthersWait: true });
  await offer(p.ctx, filmMsg('avi', '#request One'));
  queuedFilm(p, 'avi', 'One');
  p.queue.add({ label: 'panel film', meta: { requester: 'manual (admin)' }, run: async () => {} });
  ok(!(await offer(p.ctx, filmMsg('avi', '#request Two'))), 'a job queued from the panel counts as somebody else\'s');

  const t = movieHarness({ onlyWhenOthersWait: true });
  await offer(t.ctx, filmMsg('avi', '#request One'));
  queuedFilm(t, 'avi', 'One');
  t.queue.add({ kind: 'tv', group: 'bobs', groupMeta: { memberKey: requestMemberKey(filmMsg('bob', '')) }, label: 'E1', run: async () => {} });
  ok(!(await offer(t.ctx, filmMsg('avi', '#request Two'))), 'so does another member\'s TV request: films and TV share the queue');
}

console.log('=== films: never for a beta test, and never with a queue that cannot say ===');
{
  const { ctx, queue } = movieHarness({ onlyWhenOthersWait: true });
  const cfg = ctx.config.movieRequests;
  queueFilm(queue, 'avi', 'One');
  ok(moviePlugin._cooldownWaived(ctx, cfg, filmMsg('avi', ''), false) === true, 'nobody else waiting: let through');
  ok(moviePlugin._cooldownWaived(ctx, cfg, filmMsg('avi', ''), true) === false, 'a beta test: never');
  ok(moviePlugin._cooldownWaived({ ...ctx, queue: {} }, cfg, filmMsg('avi', ''), false) === false,
    'a queue that cannot say counts as busy');
  ok(moviePlugin._cooldownWaived(ctx, { ...cfg, cooldownOnlyWhenOthersWait: false }, filmMsg('avi', ''), false) === false,
    'with the option off: never');
}

console.log('=== films: the real plugin, ten films not found in an idle queue ===');
{
  // The review's count: with the option on, ten not-found requests from one
  // member drew twenty reactions and ten OMDb calls. Before 2026-10-01 the
  // cooldown allowed one lookup and 🚫 for the rest; now a not-found starts
  // no clock, and the flood backstop allows five, then 🚫 - the same with the
  // option on as off, which never waives it.
  const realFetch = globalThis.fetch;
  let omdb = 0;
  globalThis.fetch = async (url) => {
    if (new URL(String(url)).hostname.includes('omdbapi')) {
      omdb += 1;
      return new Response(JSON.stringify({ Response: 'False', Error: 'Movie not found!' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  };
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cooldown-films-'));
  process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
  fs.mkdirSync(path.join(TMP, 'lib'));
  const counts = {};
  for (const on of [false, true]) {
    const config = mergeDefaults({
      // The request rules this was written against, the defaults until
      // 2026-10-12 (request-rule-defaults): no prefix needed, react only.
      movieRequests: {
        requestGroups: [GROUP], postsGroup: 'posts@g.us', cooldownSecondsPerUser: 30, cooldownOnlyWhenOthersWait: on, blockedRatings: [],
        requirePrefix: false, replyOnBlock: false, maxQueueLength: 50,
      },
      omdb: { apiKey: 'test-key' },
      library: { provider: 'local', local: { roots: [path.join(TMP, 'lib')], extensions: ['.mp4'] } },
      media: { workDir: path.join(TMP, 'work') },
    }, DEFAULT_CONFIG);
    const data = {};
    const store = { get: (k, d = null) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; }, push: (k, v) => { (data[k] ??= []).unshift(v); } };
    const queue = new JobQueue({ concurrency: 1 });
    queue.pause();
    const reacts = [];
    const sent = [];
    const ctx = {
      config, store, queue, log: { info() {}, warn() {}, error() {}, debug() {} }, configStore: { update() {} },
      bot: {
        isConnected: () => true, react: async (m, e) => { reacts.push(e); return true; },
        sendText: async (to, b) => { sent.push(to); return { key: { id: 'x' } }; },
        deleteMessage: async () => {}, isGroupAdmin: () => false, groupMemberInfo: () => ({ isMember: false }),
        groups: () => [], on() {}, off() {},
      },
    };
    moviePlugin._reactors = new Map();
    omdb = 0;
    for (let i = 0; i < 10; i += 1) await moviePlugin.onMessage(filmMsg('avi', `Zzqx Nothing ${i}`), ctx);
    counts[on] = { omdb, reacts: reacts.length, blocked: reacts.filter((e) => e === '🚫').length, sent: sent.length };
  }
  ok(counts.true.blocked === 5 && counts.true.omdb === counts.false.omdb,
    `on: 5 x 🚫 and as many OMDb calls as with it off (${JSON.stringify(counts.true)} vs ${JSON.stringify(counts.false)})`);
  ok(counts.true.reacts === counts.false.reacts && counts.true.sent === counts.false.sent,
    'and exactly as many reactions and messages as with it off');
  globalThis.fetch = realFetch;
}

/* ------------------------------------------------ films: whose, journalled */

console.log('=== films: a request from the group carries its member, into the journal and the queue ===');
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'member-key-'));
  process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
  const LIB = path.join(TMP, 'lib');
  fs.mkdirSync(LIB);
  fs.writeFileSync(path.join(LIB, 'Heat (1995).mp4'), 'not really a film');
  fs.writeFileSync(path.join(LIB, 'Dune (2021).mp4'), 'not really a film');
  fs.writeFileSync(path.join(LIB, 'Up (2009).mp4'), 'not really a film');
  const FILMS = {
    heat: { Title: 'Heat', Year: '1995', Rated: 'PG', imdbID: 'tt0113277' },
    dune: { Title: 'Dune', Year: '2021', Rated: 'PG-13', imdbID: 'tt1160419' },
    up: { Title: 'Up', Year: '2009', Rated: 'PG', imdbID: 'tt1049413' },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.hostname.includes('omdbapi')) {
      const q = String(u.searchParams.get('t') ?? u.searchParams.get('s') ?? '').toLowerCase();
      const f = Object.entries(FILMS).find(([k]) => q.includes(k))?.[1];
      const body = f ? { Response: 'True', Type: 'movie', ...f } : { Response: 'False', Error: 'Movie not found!' };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  };
  const config = mergeDefaults({
    // No prefix needed and react only, as above (request-rule-defaults).
    movieRequests: {
      requestGroups: [GROUP], postsGroup: 'posts@g.us', cooldownSecondsPerUser: 0, blockedRatings: [],
      requirePrefix: false, replyOnBlock: false,
    },
    omdb: { apiKey: 'test-key' },
    library: { provider: 'local', local: { roots: [LIB], extensions: ['.mp4'] } },
    media: { workDir: path.join(TMP, 'work') },
  }, DEFAULT_CONFIG);
  const data = {};
  const store = { get: (k, d = null) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; }, push: (k, v) => { (data[k] ??= []).unshift(v); } };
  const added = [];
  const queue = {
    maxLength: 50, pending: [], active: new Map(), on() {}, off() {},
    add(j) { added.push(j); this.pending.push({ id: `job-${added.length}`, kind: 'movie', meta: j.meta }); return `job-${added.length}`; },
    snapshot() { return { pending: [], active: [] }; },
  };
  const ctx = {
    config, store, queue, log: { info() {}, warn() {}, error() {}, debug() {} }, configStore: { update() {} },
    bot: {
      isConnected: () => true, react: async () => true, sendText: async () => ({ key: { id: 'x' } }),
      deleteMessage: async () => {}, isGroupAdmin: () => false, groupMemberInfo: () => ({ isMember: false }),
      groups: () => [], on() {}, off() {},
    },
  };
  moviePlugin._reactors = new Map();
  await moviePlugin.onMessage(filmMsg('avi', 'heat 1995'), ctx);
  ok(added.length === 1 && added[0].meta.memberKey === 'num:15550000001', `the queued job says whose it is (${added[0]?.meta.memberKey})`);
  const journalled = data.pending?.[0];
  ok(journalled?.meta?.memberKey === 'num:15550000001', 'and so does its journal entry');

  // A restart: Avi's two films and Bob's one come back from the journal into
  // a fair queue, and Bob's still goes ahead of Avi's second.
  await moviePlugin.onMessage(filmMsg('avi', 'dune 2021'), ctx);
  await moviePlugin.onMessage(filmMsg('bob', 'up 2009'), ctx);
  ok(data.pending.map((p) => p.meta.memberKey).join() === 'num:15550000001,num:15550000001,num:15550000002',
    'three films journalled, each with its member');
  const fair = new JobQueue({ concurrency: 1, fairShare: true });
  fair.pause();
  await moviePlugin.recoverPending({ ...ctx, queue: fair });
  const back = fair.snapshot().pending;
  ok(back.map((e) => e.label).join() === 'Heat (1995),Up (2009),Dune (2021)',
    `after the restart the fair order is the same: Bob's film ahead of Avi's second (${back.map((e) => e.label).join()})`);
  ok(back.every((e) => e.meta.memberKey), 'every film resumed still says whose it is');
  globalThis.fetch = realFetch;
}

/* --------------------------------------------------------------- TV */

const TVREQ = 'tvreq@g.us';
const SERIES = { Items: [{ Id: 'SER1', Name: 'The Boys', ProductionYear: 2019 }] };
const SEASONS = { Items: [1, 2, 3, 4].map((i) => ({ Id: `S${i}`, IndexNumber: i })) };
const episodesOf = (season) => ({
  Items: [1, 2].map((e) => ({
    Id: `S${season}E${e}`, SeriesName: 'The Boys', ParentIndexNumber: season, IndexNumber: e,
    Name: `Ep ${e}`, MediaSources: [{ Path: `/s${season}e${e}.mkv`, Size: e }],
  })),
});

async function tvHarness({ onlyWhenOthersWait = false } = {}) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    const season = Number(new URL(u).searchParams.get('season') ?? 1);
    for (const [k, v] of Object.entries({ '/Items': SERIES, '/Seasons': SEASONS, '/Episodes': episodesOf(season) })) {
      if (u.includes(k)) return { ok: true, status: 200, json: async () => v };
    }
    return { ok: false, status: 404, statusText: 'NF', json: async () => ({}) };
  };
  await tvPlugin.teardown();
  const reacted = [];
  const sent = [];
  const store = new Map();
  const queue = new JobQueue({ concurrency: 1, maxLength: 50 });
  queue.pause();
  const ctx = {
    config: {
      tvRequests: {
        enabled: true, requestGroups: [TVREQ], postsGroups: ['tvposts@g.us'], cooldownSecondsPerUser: 900,
        cooldownOnlyWhenOthersWait: onlyWhenOthersWait, blockedRatings: [], reactions: { needSeason: '📺' },
      },
      movieRequests: {
        reactions: { researching: '🔍', added: '🎬', duplicate: '🤥', failed: '⚠️', done: '✅', tooFast: '🚫', positions: ['1️⃣', '2️⃣', '3️⃣'] },
        notify: { group: 'notify@g.us' },
      },
      library: { jellyfin: { baseUrl: 'http://jf:8096', accessToken: 'TOK', userId: 'U1' } },
      media: { workDir: '/tmp/cooldown-nobody-waiting-test' },
    },
    bot: {
      isConnected: () => true, isGroupAdmin: () => false, deleteMessage: async () => {}, archiveChat: async () => {},
      sendText: async (to) => { sent.push(to); return { key: { id: 'T' } }; },
      react: async (msg, emoji) => { reacted.push({ id: msg.id, emoji }); return true; },
    },
    queue,
    store: { get: (k, d) => (store.has(k) ? structuredClone(store.get(k)) : d), set: (k, v) => store.set(k, structuredClone(v)) },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  };
  await tvPlugin.setup(ctx);
  const ask = async (text, who) => {
    n += 1;
    const id = `t${n}`;
    const msg = {
      id, key: { id, remoteJid: TVREQ }, text, chatJid: TVREQ, isGroup: true, fromMe: false, messageType: 'conversation',
      senderJid: `${who}@lid`, senderNumber: { avi: '15550000001', bob: '15550000002' }[who],
      senderNumberDisplay: null, pushName: who, timestamp: Date.now(),
    };
    await tvPlugin.onMessage(msg, ctx);
    await settle();
    return reacted.filter((r) => r.id === id).map((r) => r.emoji).join(' ');
  };
  const seasons = () => queue.snapshot().pending.map((e) => e.label);
  return { ctx, queue, store, ask, seasons, sent, reacted };
}

console.log('=== TV: off, the cooldown holds even when only the member is waiting (as always) ===');
{
  const { ask, seasons } = await tvHarness();
  await ask('The Boys season 1', 'avi');
  const said = await ask('The Boys season 2', 'avi');
  ok(seasons().join() === 'The Boys season 1', `only the first season is queued (${seasons().join()})`);
  ok(/🚫/.test(said), `the second gets 🚫 (${said})`);
}

console.log('=== TV: on, a member alone in the queue is let through; somebody else waiting stops it ===');
{
  const { ask, seasons, queue, store } = await tvHarness({ onlyWhenOthersWait: true });
  await ask('The Boys season 1', 'avi');
  const said = await ask('The Boys season 2', 'avi');
  ok(seasons().join() === 'The Boys season 1,The Boys season 2', `with only their own season waiting, the second goes in (${seasons().join()})`);
  ok(!/🚫/.test(said), `with no 🚫 (${said})`);
  ok(store.get('cooldown:avi@lid')?.at > 0, 'and the clock is running');
  const journal = store.get('pending');
  ok(journal.length === 2 && journal.every((r) => r.memberKey === 'num:15550000001'), 'each season is journalled with its member');
  ok([...queue.groups.values()].every((g) => g.meta.memberKey === 'num:15550000001' && g.fair.member === 'num:15550000001'),
    'and queued as theirs');
  ok(queue.snapshot().pending.map((e) => e.meta.memberKey).join() === 'num:15550000001,num:15550000001', 'the panel sees whose too');

  await ask('The Boys season 3', 'bob');
  ok(seasons().includes('The Boys season 3'), 'Bob\'s season is waiting');
  const third = await ask('The Boys season 4', 'avi');
  ok(!seasons().includes('The Boys season 4') && /🚫/.test(third),
    `once somebody else has something in the queue, the cooldown holds again (${third})`);
}

console.log('=== TV: on, ten "which season?" requests from one member stay throttled ===');
{
  // The review's case: "#request The Boys" ten times, nothing else in the
  // queue. Before 2026-10-01 the first was asked "which season?" (a quoted
  // reply and a notifications line) and the clock it started gave the other
  // nine 🚫. The question starts no clock now, so the flood backstop stops
  // it: five questions, then 🚫 - the same with the option on as off.
  const counts = {};
  for (const on of [false, true]) {
    const { ask, sent, reacted, seasons } = await tvHarness({ onlyWhenOthersWait: on });
    for (let i = 0; i < 10; i += 1) await ask('The Boys', 'avi');
    counts[on] = { sent: sent.length, blocked: reacted.filter((r) => r.emoji === '🚫').length, queued: seasons().length };
  }
  ok(counts.true.sent === 10 && counts.true.blocked === 5 && counts.true.queued === 0,
    `on: ten messages and five 🚫, as off (${JSON.stringify(counts.true)} vs ${JSON.stringify(counts.false)})`);
  ok(counts.true.sent === counts.false.sent && counts.true.blocked === counts.false.blocked, 'exactly as with the option off');
}

console.log('=== TV: on, the "which season?" pass is still one answer ===');
{
  // The review's sequence: asked "which season?", Avi answers while the
  // queue is empty; Bob queues a season; Avi's next season must meet the
  // cooldown.
  const { ask, seasons, store } = await tvHarness({ onlyWhenOthersWait: true });
  ok(/📺/.test(await ask('The Boys', 'avi')), 'Avi is asked which season');
  ok(store.get('cooldown-pass:avi@lid')?.until > Date.now(), 'and holds a pass for one answer');
  await ask('The Boys season 1', 'avi');
  ok(seasons().join() === 'The Boys season 1', `the answer is queued (${seasons().join()})`);
  ok(!store.get('cooldown-pass:avi@lid'), 'and the pass is spent');
  await ask('The Boys season 3', 'bob');
  const said = await ask('The Boys season 2', 'avi');
  ok(/🚫/.test(said) && !seasons().includes('The Boys season 2'),
    `with Bob waiting, Avi's next season meets the cooldown (${said}; ${seasons().join()})`);

  // A pass still held when the option lets a request through is spent by it.
  const h = await tvHarness({ onlyWhenOthersWait: true });
  await h.ask('The Boys season 1', 'avi');
  h.store.set('cooldown-pass:avi@lid', { series: 'SER1', name: 'The Boys', until: Date.now() + 900_000 });
  await h.ask('The Boys season 2', 'avi');
  ok(h.seasons().join() === 'The Boys season 1,The Boys season 2', `the option lets the second season through (${h.seasons().join()})`);
  ok(!h.store.get('cooldown-pass:avi@lid'), 'and the pass it passed over is spent');
  await h.ask('The Boys season 3', 'bob');
  const later = await h.ask('The Boys season 4', 'avi');
  ok(/🚫/.test(later) && !h.seasons().includes('The Boys season 4'), `so it cannot let a later season through while Bob waits (${later})`);
}

console.log('=== TV: a request put back after a restart is still its member\'s ===');
{
  const store = {};
  const queued = [];
  const ctx = {
    store: { get: (k, d) => (k in store ? store[k] : d), set: (k, v) => { store[k] = v; } },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    config: { tvRequests: {}, movieRequests: { reactions: { redo: '🔄', done: '✅' } } },
    queue: { maxLength: 500, pending: [], add(j) { this.pending.push(j); queued.push(j); return 'id'; } },
    bot: { isConnected: () => true, react: async () => {}, on() {}, off() {} },
  };
  const ep = (e) => ({ id: `id-${e}`, series: 'The Boys', season: 1, episode: e, title: `Ep ${e}`, size: 1 });
  store.pending = [
    { reqKey: 'r1', label: 'The Boys season 1', msgId: 'm1', msgKey: { id: 'm1' }, chatJid: TVREQ, memberKey: 'num:15550000001', episodes: [ep(1), ep(2)] },
    { reqKey: 'r2', label: 'Old request', msgId: 'm2', msgKey: { id: 'm2' }, chatJid: TVREQ, episodes: [ep(3)] },
  ];
  await tvPlugin.teardown();
  await tvPlugin.recoverPending(ctx);
  const mine = queued.filter((j) => j.group === 'r1');
  ok(mine.length === 2 && mine.every((j) => j.groupMeta.memberKey === 'num:15550000001' && j.meta.memberKey === 'num:15550000001'),
    'both episodes go back in as the member\'s, on the request and on each episode');
  const old = queued.find((j) => j.group === 'r2');
  ok(old && !('memberKey' in old.groupMeta) && !('memberKey' in old.meta),
    'one journalled before members were recorded goes back with none (the fair order never moves it)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
