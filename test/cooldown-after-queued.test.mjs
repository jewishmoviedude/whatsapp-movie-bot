/* The cooldown starts only when a member's request puts something in the queue.
   Run: node test/cooldown-after-queued.test.mjs

   The incident, 2026-10-01. Ben Lewis (+15558190193) asked for "shaft 2019"
   at 19:24:14. Shaft (2019) is rated R, the AI check said nudity=true, and it
   was refused ⛔. He asked for something else at 19:25:35, and again at
   19:34:57 and 19:35:42, and every one got 🚫 - "ignoring
   100000000000003@lid: cooling down (3518s / 2955s / 2911s left)". The film
   cooldown on that box is an hour, and it had started when his first request
   arrived, refused or not. The operator: "if the 1st item is denied to rated
   r or not in library etc cooldown should not apply" ... "cooldown is only if
   the members first request actually puts an item in queue, otherwise why we
   cooling him down???"

   The rule since (src/core/request-cooldown.js):
   1. the clock starts only when a request queues something - a film, a TV
      request with at least one episode, a pick that queues its film; a
      refusal, "not in the library", a list, "which season?", a duplicate, a
      test or an error leaves it as it was;
   2. a request that arrives while the member's previous one is still being
      looked up waits for it (up to a minute), and is judged by what it came
      to;
   3. five answers without queueing in ten minutes meet the cooldown until the
      ten minutes pass - a backstop for the number's sake, since every one of
      them is a reaction and most a notifications line;
   and group admins are exempt from all of it. "Skip the cooldown while nobody
   else is waiting" still waives a running clock, never the backstop.

   From the review of that change (2026-10-01): the wait for a request in
   flight is as long as the section's own lookup can take - a minute was
   shorter than a real TV lookup (72 s that day), and two requests would
   both have queued - and a TV request lets its waiters go the moment its
   first episodes are queued; the bot's own failures (a full queue, a lookup
   that failed) count towards the backstop, since nothing else limited them
   once they no longer started the clock; a request that threw is not
   counted; requests held while paused count as answers to come, so one
   member cannot have more than five held; and stale cooldown entries are
   cleared from the store.

   These run the real plugins, with OMDb and Jellyfin answered by a stubbed
   fetch and a real queue that is paused, so nothing downloads. */
import './fixtures/roomy-disk.mjs';
import './fixtures/omdb-no-wait.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import tvPlugin from '../src/plugins/tv-requests/index.js';
import { JobQueue } from '../src/core/queue.js';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';
import { slimMessage } from '../src/core/request-pause.js';
import { MemberCooldown, COOLDOWN_LIMITS, cooldownKeys, readClock, sweepCooldownKeys } from '../src/core/request-cooldown.js';
import { RequestPause } from '../src/core/request-pause.js';
import { CHAIN_LIMITS } from '../src/core/ai-providers.js';
import { LIMITS as TV_AI_LIMITS } from '../src/plugins/tv-requests/override-check.js';
import { requestMemberKey } from '../src/core/members.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms));

/* ============================ the network ============================ */

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
let fid = 0;
const film = (Name, ProductionYear, OfficialRating) => ({
  Id: `jf${++fid}`, Name, ProductionYear, OfficialRating, Type: 'Movie',
  MediaSources: [{ Path: `/nowhere/${Name}.mkv`, Size: 17, Container: 'mp4' }],
});
// What the server holds. Shaft (2019) is there, and rated R, as Ben's was.
const LIBRARY = [
  film('Heat', 1995, 'PG-13'), film('Up', 2009, 'PG'), film('Inception', 2010, 'PG-13'), film('Cars', 2006, 'G'),
  film('Shaft', 2019, 'R'), film('Venom', 2005, 'PG-13'), film('Venom', 2018, 'PG-13'),
];
const OMDB = [
  ...LIBRARY.map((f, i) => ({ Title: f.Name, Year: String(f.ProductionYear), Rated: f.OfficialRating, imdbID: `tt${2000000 + i}` })),
  // Known to OMDb, not on the server.
  { Title: 'Barefoot', Year: '2014', Rated: 'PG-13', imdbID: 'tt2355844' },
  { Title: 'Paddington', Year: '2014', Rated: 'PG', imdbID: 'tt1109624' },
].map((m) => ({ ...m, Type: 'movie', Released: 'N/A', DVD: 'N/A', Response: 'True' }));

let omdbDown = false;
const holds = new Map();            // a word -> a promise its OMDb or Jellyfin answer waits for
const hold = (word) => {
  let release;
  holds.set(word, new Promise((r) => { release = r; }));
  return () => { holds.delete(word); release(); };
};
const waitFor = async (text) => {
  for (const [word, p] of holds) if (norm(text).includes(word)) await p;
};

// The Boys: seasons 1 to 3, two episodes each; season 3's are TV-MA.
const SERIES = { Items: [{ Id: 'SER1', Name: 'The Boys', ProductionYear: 2019 }] };
const SEASONS = { Items: [1, 2, 3].map((i) => ({ Id: `S${i}`, IndexNumber: i })) };
const episodesOf = (season) => ({
  Items: [1, 2].map((e) => ({
    Id: `S${season}E${e}`, SeriesName: 'The Boys', ParentIndexNumber: season, IndexNumber: e, Name: `Ep ${e}`,
    ...(season === 3 ? { OfficialRating: 'TV-MA' } : {}),
    MediaSources: [{ Path: `/s${season}e${e}.mkv`, Size: e }],
  })),
});

globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  const miss = () => json({ Response: 'False', Error: 'Movie not found!' });
  if (u.hostname === 'www.omdbapi.com') {
    if (omdbDown) return new Response('', { status: 503, statusText: 'Service Unavailable' });
    const p = u.searchParams;
    await waitFor(p.get('t') ?? p.get('s') ?? '');
    const y = p.get('y') ? Number(p.get('y')) : null;
    if (p.get('i')) return json(OMDB.find((m) => m.imdbID === p.get('i')) ?? miss());
    if (p.get('t')) {
      const hit = OMDB.find((m) => norm(m.Title) === norm(p.get('t')) && (!y || Number(m.Year) === y));
      return hit ? json(hit) : miss();
    }
    if (p.get('s')) {
      const hits = OMDB.filter((m) => norm(m.Title).includes(norm(p.get('s'))) && (!y || Number(m.Year) === y));
      return hits.length ? json({ Response: 'True', Search: hits.map(({ Title, Year, imdbID, Type }) => ({ Title, Year, imdbID, Type })) }) : miss();
    }
    return miss();
  }
  if (u.hostname === 'jf.test') {                       // the film library
    if (u.pathname === '/Items') {
      const term = u.searchParams.get('searchTerm');
      if (!term || u.searchParams.get('IncludeItemTypes') === 'Series') return json({ Items: [] });
      const limit = Number(u.searchParams.get('Limit')) || Infinity;
      return json({ Items: LIBRARY.filter((f) => norm(f.Name).includes(norm(term))).slice(0, limit) });
    }
    return json({ Items: [] });
  }
  if (u.hostname === 'jf') {                            // the TV library
    const s = String(url);
    if (s.includes('/Episodes')) {
      const season = Number(u.searchParams.get('season') ?? 1);
      await waitFor(`season ${season}`);
      return json(episodesOf(season));
    }
    if (s.includes('/Seasons')) return json(SEASONS);
    if (s.includes('/Items')) return json(SERIES);
    return new Response('{}', { status: 404 });
  }
  return new Response('{}', { status: 404, statusText: 'not stubbed' });
};

/* ============================ films ============================ */

const REQ = 'movie-requests@g.us';
const TESTING = 'testing@g.us';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cooldown-after-queued-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

const BENNY = { jid: '100000000000003@lid', number: '15558190193', name: 'Ben' };
const BOB = { jid: 'bob@lid', number: '15550000002', name: 'Bob' };
const ADMIN = { jid: 'admin@lid', number: '15550000009', name: 'Admin' };

function fakeStore() {
  const data = {};
  return {
    _data: data,
    get: (k, d = null) => (k in data ? data[k] : d),
    set: (k, v) => { data[k] = v; },
    delete: (k) => { delete data[k]; },
    push: (k, v) => { (data[k] ??= []).unshift(v); },
  };
}

function filmHarness({ movie = {}, beta = undefined, limits = null } = {}) {
  const config = mergeDefaults({
    movieRequests: {
      requestGroups: [REQ], postsGroup: 'posts@g.us', requirePrefix: true, prefix: '#request',
      cooldownSecondsPerUser: 3600, cooldownOnlyWhenOthersWait: false, replyOnBlock: false,
      requireYearWhenAmbiguous: false, ...movie,
    },
    ...(beta ? { beta } : {}),
  }, DEFAULT_CONFIG);
  config.omdb.apiKey = 'test-key';
  config.library = mergeDefaults({
    provider: 'jellyfin',
    jellyfin: { baseUrl: 'http://jf.test', authMethod: 'apikey', apiKey: 'KEY', accessToken: 'TOK', userId: 'U1' },
  }, DEFAULT_CONFIG.library);
  config.media.workDir = path.join(TMP, 'work');
  const store = fakeStore();
  const queue = new JobQueue({ concurrency: 1, maxLength: 50 });
  queue.pause();
  const out = [];
  const logs = [];
  const h = {
    store, queue, out, logs, paused: false, held: [],
    ctx: {
      config, store, queue, configStore: { update() {} },
      log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), debug() {} },
      bot: {
        isConnected: () => true,
        isGroupAdmin: (g, who) => who?.jid === ADMIN.jid,
        react: async (msg, emoji) => { out.push({ on: msg.id, emoji }); return true; },
        sendText: async (jid, body, opts) => { out.push({ text: body, jid, quoted: opts?.quoted?.id ?? null }); return { key: { id: `BOT${out.length}`, remoteJid: jid } }; },
        editText: async () => true,
        deleteMessage: async () => {}, archiveChat: async () => {},
        groupMemberInfo: () => ({ isMember: false }), groups: () => [], groupCache: new Map(),
        sameCommunity: () => false, groupMentionToken: (j) => `@${j}`,
        async _bulkPace() {}, on() {}, off() {},
      },
    },
  };
  // The request pause, as request-pause.js holds a request: journalled, ⏸️.
  h.ctx.requestPause = {
    isPaused: () => h.paused,
    holds: () => false,
    heldFrom: (plugin, jid) => h.held.filter((it) => it.plugin === plugin && it.kind !== 'pick' && it.msg?.senderJid === jid).length,
    hold: async (ctx, msg, { plugin, kind = 'request', text = null, extra = {} }) => {
      h.held.push({ id: msg.id, plugin, kind, at: Date.now(), msg: slimMessage(msg), ...(text != null ? { text } : {}), ...extra });
      await ctx.bot.react(msg, '⏸️');
    },
  };
  moviePlugin._reactors = new Map();
  moviePlugin._cooldown = new MemberCooldown({ section: 'films', limits: { ...COOLDOWN_LIMITS, ...(limits ?? {}) } });
  return h;
}

let seq = 0;
const mkMsg = (text, who = BENNY, chat = REQ) => {
  const id = `M${++seq}`;
  return {
    id, key: { id, remoteJid: chat, participant: who.jid, fromMe: false }, text, chatJid: chat,
    isGroup: true, fromMe: false, messageType: 'conversation', senderJid: who.jid, senderNumber: who.number,
    senderNumberDisplay: `+${who.number}`, pushName: who.name, timestamp: Date.now(),
  };
};
/** Send a request; resolves once the plugin is done with it. */
const ask = async (h, text, who = BENNY, chat = REQ) => {
  const m = mkMsg(text, who, chat);
  await moviePlugin.onMessage(m, h.ctx);
  await settle();
  return m;
};
// The reactions on a message, without the place-in-line numbers a queued
// film then shows (1️⃣, 2️⃣...): those say where it is, not what happened.
const PLACE = /^(?:\d\uFE0F?\u20E3|🔟|🔢)$/u;
const on = (h, m) => h.out.filter((e) => e.on === m.id && !PLACE.test(e.emoji ?? '')).map((e) => e.emoji).join(' ');
const waiting = (h) => h.queue.snapshot().pending.map((e) => e.label);
const clockOf = (h, who = BENNY, beta = false) => readClock(h.store, cooldownKeys(who.jid, { beta }).clock);

console.log('=== Ben\'s case: refused as rated R, his next request is not cooled down ===');
{
  const h = filmHarness();
  const shaft = await ask(h, '#request shaft 2019');
  ok(on(h, shaft) === '🔍 ⛔', `"shaft 2019" is refused on its rating (${on(h, shaft)})`);
  ok(clockOf(h) === null, 'and his clock has not started');
  const next = await ask(h, '#request heat 1995');
  ok(on(h, next) === '🔍 🎬' && waiting(h).join() === 'Heat (1995)',
    `his next request, a minute later, is looked up and queued - not 🚫 (${on(h, next)}; ${waiting(h).join()})`);
  ok(clockOf(h)?.what === 'Heat (1995)', `the clock starts at the film that was queued (${clockOf(h)?.what})`);
  ok(!h.logs.some((l) => /cooling down/.test(l)), 'and nothing was refused for the cooldown');
}

console.log('=== not in the library, not found, or a year asked for: the next request runs ===');
{
  const h = filmHarness();
  const barefoot = await ask(h, '#request barefoot 2014');
  ok(on(h, barefoot) === '🔍 📬', `not in the library: 📬 (${on(h, barefoot)})`);
  const nothing = await ask(h, '#request zzqx nothing at all');
  ok(on(h, nothing) === '🔍 ❓', `not found: ❓ (${on(h, nothing)})`);
  ok(clockOf(h) === null, 'no clock after either');
  const next = await ask(h, '#request heat 1995');
  ok(on(h, next) === '🔍 🎬', `the next request runs and is queued (${on(h, next)})`);
}

console.log('=== a request that queued a film starts the clock: the next one gets 🚫 ===');
{
  const h = filmHarness();
  await ask(h, '#request heat 1995');
  const second = await ask(h, '#request up 2009');
  ok(on(h, second) === '🚫' && waiting(h).join() === 'Heat (1995)', `the second, inside the hour, gets 🚫 and nothing else (${on(h, second)})`);
  ok(h.logs.some((l) => new RegExp(`^ignoring ${BENNY.jid}: cooling down \\(\\d+s left\\) - their request "Heat \\(1995\\)" was queued`).test(l)),
    'and the log line says which queued request started the clock, in the form the hourly scan reads');
  // An hour later it has run out.
  h.store.set(cooldownKeys(BENNY.jid).clock, { at: Date.now() - 3_601_000, what: 'Heat (1995)' });
  const later = await ask(h, '#request up 2009');
  ok(on(h, later) === '🔍 🎬', `an hour on, the next is queued (${on(h, later)})`);
}

console.log('=== a clock from before the rule, a bare timestamp, is not honoured ===');
{
  // Written at every request's arrival before 2026-10-01 - Ben's, by his
  // refused Shaft - it cannot say whether its request queued anything.
  const h = filmHarness();
  h.store.set(cooldownKeys(BENNY.jid).clock, Date.now() - 60_000);
  const m = await ask(h, '#request heat 1995');
  ok(on(h, m) === '🔍 🎬', `the request runs (${on(h, m)})`);
}

console.log('=== while the first is still being looked up, the second waits for it ===');
{
  // It queues: the second meets the cooldown, after it.
  const h = filmHarness();
  const release = hold('heat');
  const first = mkMsg('#request heat 1995');
  const second = mkMsg('#request up 2009');
  const p1 = moviePlugin.onMessage(first, h.ctx);
  await settle();
  const p2 = moviePlugin.onMessage(second, h.ctx);
  await settle();
  ok(on(h, second) === '', `the second is neither refused nor looked up while the first is in flight (${on(h, second) || 'nothing yet'})`);
  ok(h.logs.some((l) => /asked again while "heat 1995" is still being looked up/.test(l)), 'and the log says it waits');
  release();
  await p1; await p2; await settle();
  ok(on(h, first) === '🔍 🎬', `the first is queued (${on(h, first)})`);
  ok(on(h, second) === '🚫' && waiting(h).join() === 'Heat (1995)', `so the second gets 🚫 - not run beside it (${on(h, second)})`);
}
{
  // It is refused: the second runs.
  const h = filmHarness();
  const release = hold('shaft');
  const first = mkMsg('#request shaft 2019');
  const second = mkMsg('#request heat 1995');
  const p1 = moviePlugin.onMessage(first, h.ctx);
  await settle();
  const p2 = moviePlugin.onMessage(second, h.ctx);
  await settle();
  ok(on(h, second) === '', 'the second waits');
  release();
  await p1; await p2; await settle();
  ok(on(h, first) === '🔍 ⛔' && on(h, second) === '🔍 🎬', `the first is refused, so the second runs and is queued (${on(h, first)} / ${on(h, second)})`);
}
{
  // Three at once: each waits for the one before it.
  const h = filmHarness();
  const release = hold('shaft');
  const msgs = ['#request shaft 2019', '#request heat 1995', '#request up 2009'].map((t) => mkMsg(t));
  const ps = [];
  for (const m of msgs) { ps.push(moviePlugin.onMessage(m, h.ctx)); await settle(); }
  release();
  await Promise.all(ps); await settle();
  ok(msgs.map((m) => on(h, m)).join(' | ') === '🔍 ⛔ | 🔍 🎬 | 🚫',
    `refused, then queued, then the cooldown - one at a time (${msgs.map((m) => on(h, m)).join(' | ')})`);
}
{
  // A lookup stuck past the wait: taken as not queued, and the next goes on.
  const h = filmHarness({ limits: { inFlightWaitMs: 120 } });
  const release = hold('heat');
  const first = mkMsg('#request heat 1995');
  const second = mkMsg('#request up 2009');
  const p1 = moviePlugin.onMessage(first, h.ctx);
  await settle();
  const t0 = Date.now();
  await moviePlugin.onMessage(second, h.ctx);
  const took = Date.now() - t0;
  ok(on(h, second) === '🔍 🎬' && took >= 90, `after the wait (${took} ms) the second runs, as if the first queued nothing (${on(h, second)})`);
  ok(h.logs.some((l) => /"heat 1995" has been looked up for over .* taken as not queued/.test(l)), 'with a log line saying so');
  release();
  await p1;
}

console.log('=== a pick list shown starts no clock; a pick that queues its film does ===');
{
  // With no beta config: the list is in every group since it left beta
  // (beta001, 2026-10-11).
  const h = filmHarness({ movie: { requireYearWhenAmbiguous: true } });
  const venom = await ask(h, '#request venom');
  ok(h.out.some((e) => e.quoted === venom.id && /Search results/.test(e.text ?? '')), 'a bare "venom" is offered a list');
  ok(clockOf(h) === null, 'and starts no clock');
  const other = await ask(h, '#request heat 1995');
  ok(on(h, other) === '🔍 🎬', `a new request meanwhile is not cooled down (${on(h, other)})`);

  const p = filmHarness({ movie: { requireYearWhenAmbiguous: true } });
  await ask(p, '#request venom');
  const pick = await ask(p, '2');
  ok(waiting(p).join() === 'Venom (2018)' && !on(p, pick).includes('🚫'), `the pick goes through and queues its film (${waiting(p).join()})`);
  ok(clockOf(p)?.what === 'Venom (2018)', 'and that starts the clock');
  const after = await ask(p, '#request up 2009');
  ok(on(p, after) === '🚫', `so the next request gets 🚫 (${on(p, after)})`);
}

console.log('=== a duplicate starts no clock ===');
{
  const h = filmHarness();
  await ask(h, '#request heat 1995', BOB);
  const dup = await ask(h, '#request heat 1995');
  ok(on(h, dup) === '🔍 🤥' && waiting(h).length === 1, `Ben's Heat is already waiting: 🤥, not queued again (${on(h, dup)})`);
  ok(clockOf(h) === null, 'and his clock has not started');
  const next = await ask(h, '#request up 2009');
  ok(on(h, next) === '🔍 🎬', `his next request is queued (${on(h, next)})`);
}

console.log('=== a test never starts a clock, beta or main ===');
{
  const h = filmHarness({ beta: { groups: [TESTING], features: { 'movie-duplicate-notice': 'beta' } } });
  const t1 = await ask(h, '$beta004 #request heat 1995', BENNY, TESTING);
  ok(h.out.some((e) => e.quoted === t1.id && /Test passed/.test(e.text ?? '')), 'the test passes');
  ok(clockOf(h, BENNY, true) === null && clockOf(h) === null, 'and starts neither the beta clock nor the main one');
  const t2 = await ask(h, '$beta004 #request up 2009', BENNY, TESTING);
  ok(!on(h, t2).includes('🚫') && h.out.some((e) => e.quoted === t2.id && /Test passed/.test(e.text ?? '')),
    `the tester's next test runs too (${on(h, t2)})`);
  ok(!(h.store.get('cooldown-answers:100000000000003@lid') ?? []).length,
    'and the tests count towards the beta backstop only, never the main one');
}

console.log('=== a group admin is exempt from all of it ===');
{
  const h = filmHarness();
  await ask(h, '#request heat 1995', ADMIN);
  const second = await ask(h, '#request up 2009', ADMIN);
  ok(on(h, second) === '🔍 🎬', `an admin's second film is queued (${on(h, second)})`);
  const refused = [];
  for (let i = 0; i < 7; i += 1) refused.push(await ask(h, '#request barefoot 2014', ADMIN));
  ok(refused.every((m) => on(h, m) === '🔍 📬'), 'seven refusals in a row, and no 🚫: the backstop does not apply either');
  ok(!h.store.get(cooldownKeys(ADMIN.jid).clock) && !h.store.get(cooldownKeys(ADMIN.jid).answers), 'nothing is even counted');
}

console.log('=== the flood backstop: five answers without queueing in ten minutes, then 🚫 ===');
{
  const h = filmHarness();
  const five = [];
  for (const t of ['shaft 2019', 'barefoot 2014', 'zzqx nothing', 'shaft 2019', 'paddington 2014']) five.push(await ask(h, `#request ${t}`));
  ok(five.every((m) => !on(h, m).includes('🚫')), `none of the first five is refused for it (${five.map((m) => on(h, m)).join(' | ')})`);
  ok(h.logs.some((l) => /films: 100000000000003@lid has had 5 requests answered without queueing in 10 min - their next ones get 🚫/.test(l)),
    'the fifth trips it, with a log line');
  const sixth = await ask(h, '#request heat 1995');
  ok(on(h, sixth) === '🚫' && !waiting(h).length, `the sixth, a film that would queue, gets 🚫 (${on(h, sixth)})`);
  ok(h.logs.some((l) => /^ignoring 100000000000003@lid: cooling down \(\d+s left\) - 5 requests answered without queueing in the last 10 min \(the flood backstop\)/.test(l)),
    'logged as a cooldown refusal, naming the backstop');
  const seventh = await ask(h, '#request up 2009');
  ok(on(h, seventh) === '🚫', 'and so does the seventh: a 🚫 does not count, and the window has not passed');
  // Ten minutes on, the oldest has left the window.
  const key = cooldownKeys(BENNY.jid).answers;
  h.store.set(key, h.store.get(key).map((t, i) => (i === 0 ? t - 10 * 60_000 : t)));
  const later = await ask(h, '#request heat 1995');
  ok(on(h, later) === '🔍 🎬', `once the oldest is ten minutes old, the next runs (${on(h, later)})`);
}
{
  // The bot's own failures start no clock, but they do count. This block
  // first pinned the opposite - six failed lookups, six ⚠️, no 🚫 - and the
  // review of 2026-10-01 found that with the clock no longer started by them
  // nothing limited them at all: every one is a ⚠️ and an OMDb call, a full
  // queue a notifications line too, where the old clock allowed one.
  const h = filmHarness();
  omdbDown = true;
  const failed = [];
  for (let i = 0; i < 6; i += 1) failed.push(await ask(h, `#request heat 1995`));
  omdbDown = false;
  ok(failed.slice(0, 5).every((m) => on(h, m) === '🔍 ⚠️'), `five lookups that failed get ⚠️ (${failed.slice(0, 5).map((m) => on(h, m)).join(' | ')})`);
  ok(on(h, failed[5]) === '🚫', `the sixth meets the backstop (${on(h, failed[5])})`);
  ok(clockOf(h) === null, 'and none of them started the clock');
  const key = cooldownKeys(BENNY.jid).answers;
  h.store.set(key, h.store.get(key).map((t) => t - 10 * 60_000));
  const next = await ask(h, '#request heat 1995');
  ok(on(h, next) === '🔍 🎬', `once they are ten minutes old, the next is queued (${on(h, next)})`);
}
{
  // A request that threw is not an answer, whatever its record said by then:
  // here the queue throws after the row was marked 'queued'.
  const h = filmHarness();
  h.queue.add = () => { throw new Error('the queue fell over'); };
  let threw = null;
  try { await moviePlugin.onMessage(mkMsg('#request heat 1995'), h.ctx); } catch (err) { threw = err; }
  ok(threw?.message === 'the queue fell over', 'the request throws');
  ok(!h.store.get(cooldownKeys(BENNY.jid).answers) && clockOf(h) === null, 'and is neither counted nor starts the clock');
}

console.log('=== held while requests are paused ===');
{
  // Two held: on resume the first queues, and the second, run as if it had
  // just arrived, meets the cooldown it started.
  const h = filmHarness();
  h.paused = true;
  const a = await ask(h, '#request heat 1995');
  const b = await ask(h, '#request up 2009');
  ok(on(h, a) === '⏸️' && on(h, b) === '⏸️', `both are held, neither refused: nothing has queued (${on(h, a)} / ${on(h, b)})`);
  h.paused = false;
  for (const item of h.held.splice(0)) await moviePlugin.replayHeld(item, h.ctx);
  await settle();
  ok(on(h, a) === '⏸️ 🔍 🎬' && on(h, b) === '⏸️ 🚫', `on resume: the first queued, the second 🚫 (${on(h, a)} / ${on(h, b)})`);
  ok(waiting(h).join() === 'Heat (1995)', 'only one film queued');
}
{
  // The first held is refused: the second runs.
  const h = filmHarness();
  h.paused = true;
  const a = await ask(h, '#request shaft 2019');
  const b = await ask(h, '#request up 2009');
  h.paused = false;
  for (const item of h.held.splice(0)) await moviePlugin.replayHeld(item, h.ctx);
  await settle();
  ok(on(h, a) === '⏸️ 🔍 ⛔' && on(h, b) === '⏸️ 🔍 🎬', `refused, then queued (${on(h, a)} / ${on(h, b)})`);
}
{
  // A clock already running when the request arrives: 🚫 then, as live.
  const h = filmHarness();
  await ask(h, '#request heat 1995');
  h.paused = true;
  const b = await ask(h, '#request up 2009');
  ok(on(h, b) === '🚫' && !h.held.length, `refused as it arrives, not held (${on(h, b)})`);
}

console.log('=== held while paused: at most five of one member\'s, counting their recent answers ===');
{
  // Found in review (2026-10-01): held requests are answered on resume, and
  // nothing limited how many one member could have held - eight held were
  // eight ⏸️ and then five lookups and three 🚫 in the replay, where the old
  // clock held one and refused the rest as they came.
  const h = filmHarness();
  h.paused = true;
  const sent = [];
  for (let i = 0; i < 8; i += 1) sent.push(await ask(h, `#request ${i % 2 ? 'barefoot 2014' : 'shaft 2019'}`));
  ok(sent.slice(0, 5).every((m) => on(h, m) === '⏸️') && h.held.length === 5, `the first five are held (${sent.map((m) => on(h, m)).join(' | ')})`);
  ok(sent.slice(5).every((m) => on(h, m) === '🚫'), 'the rest get 🚫 as they arrive');
  ok(h.logs.some((l) => /cooling down .* 0 requests answered without queueing in the last 10 min and 5 held while requests are paused \(the flood backstop\)/.test(l)),
    'and the log says the held ones are why');
  h.paused = false;
  for (const item of h.held.splice(0)) await moviePlugin.replayHeld(item, h.ctx);
  await settle();
  ok(sent.slice(0, 5).every((m) => /^⏸️ 🔍 (⛔|📬)$/.test(on(h, m))), `on resume the five are each answered, and none 🚫 (${sent.slice(0, 5).map((m) => on(h, m)).join(' | ')})`);
  ok(h.out.filter((e) => e.emoji === '🚫').length === 3, 'so three 🚫 in all, not five 🚫 and eight holds');
}
{
  // Answers just given count too: three refusals, then paused - two held.
  const h = filmHarness();
  for (let i = 0; i < 3; i += 1) await ask(h, '#request barefoot 2014');
  h.paused = true;
  const sent = [];
  for (let i = 0; i < 3; i += 1) sent.push(await ask(h, '#request heat 1995'));
  ok(sent.map((m) => on(h, m)).join(' | ') === '⏸️ | ⏸️ | 🚫', `three answered, so two held and the third 🚫 (${sent.map((m) => on(h, m)).join(' | ')})`);
  // Someone else's held requests are theirs.
  const bob = await ask(h, '#request up 2009', BOB);
  ok(on(h, bob) === '⏸️', 'another member is held as ever');
}
{
  // The panel's own pause counts the same way (RequestPause.heldFrom).
  const rp = new RequestPause({ store: fakeStore(), queueStore: fakeStore() });
  const bot = { react: async () => true };
  await rp.hold({ bot, log: { info() {}, warn() {} } }, mkMsg('#request heat 1995'), { plugin: 'movie-requests' });
  await rp.hold({ bot, log: { info() {}, warn() {} } }, mkMsg('#request up 2009'), { plugin: 'movie-requests' });
  await rp.hold({ bot, log: { info() {}, warn() {} } }, mkMsg('The Boys season 1', BENNY, 'tvreq@g.us'), { plugin: 'tv-requests' });
  await rp.hold({ bot, log: { info() {}, warn() {} } }, mkMsg('2'), { plugin: 'movie-requests', kind: 'pick' });
  await rp.hold({ bot, log: { info() {}, warn() {} } }, mkMsg('#request cars 2006', BOB), { plugin: 'movie-requests' });
  ok(rp.heldFrom('movie-requests', BENNY.jid) === 2 && rp.heldFrom('tv-requests', BENNY.jid) === 1
    && rp.heldFrom('movie-requests', BOB.jid) === 1,
    'heldFrom counts one member\'s held requests in one section, picks aside');
}

console.log('=== "skip the cooldown while nobody else is waiting" still works ===');
{
  const h = filmHarness({ movie: { cooldownOnlyWhenOthersWait: true } });
  await ask(h, '#request heat 1995');
  const second = await ask(h, '#request up 2009');
  ok(on(h, second) === '🔍 🎬', `with only his own film waiting, the second is let through and queued (${on(h, second)})`);
  ok(clockOf(h)?.what === 'Up (2009)', 'and the clock starts again at it');
  await ask(h, '#request inception 2010', BOB);
  const third = await ask(h, '#request cars 2006');
  ok(on(h, third) === '🚫', `once somebody else is waiting, the clock holds (${on(h, third)})`);
}
{
  // It never waives the backstop: requests that queue nothing leave the
  // queue as empty as it was.
  const h = filmHarness({ movie: { cooldownOnlyWhenOthersWait: true } });
  for (let i = 0; i < 5; i += 1) await ask(h, '#request barefoot 2014');
  const sixth = await ask(h, '#request heat 1995');
  ok(on(h, sixth) === '🚫' && h.queue.hasOthers(requestMemberKey(mkMsg('', BENNY))) === false,
    `an empty queue, and still 🚫 after five refusals (${on(h, sixth)})`);
}

/* ============================ TV ============================ */

const TVREQ = 'tvreq@g.us';

async function tvHarness({ tv = {}, limits = null, beta = undefined } = {}) {
  await tvPlugin.teardown();
  const out = [];
  const logs = [];
  const data = new Map();
  const queue = new JobQueue({ concurrency: 1, maxLength: 50 });
  queue.pause();
  const h = { out, logs, queue, paused: false, held: [] };
  h.store = {
    get: (k, d) => (data.has(k) ? structuredClone(data.get(k)) : d),
    set: (k, v) => data.set(k, structuredClone(v)),
    delete: (k) => data.delete(k),
  };
  h.ctx = {
    config: {
      tvRequests: {
        enabled: true, requestGroups: [TVREQ], postsGroups: ['tvposts@g.us'], cooldownSecondsPerUser: 900,
        cooldownOnlyWhenOthersWait: false, blockedRatings: ['TV-MA'], reactions: { needSeason: '📺' }, ...tv,
      },
      movieRequests: {
        reactions: {
          researching: '🔍', added: '🎬', duplicate: '🤥', notInLibrary: '📬', failed: '⚠️', done: '✅', rated: '⛔',
          tooFast: '🚫', positions: ['1️⃣', '2️⃣', '3️⃣'], positionOverflow: '🔢',
        },
        notify: { group: 'notify@g.us' },
      },
      library: { jellyfin: { baseUrl: 'http://jf:8096', accessToken: 'TOK', userId: 'U1' } },
      media: { workDir: path.join(TMP, 'tv-work') },
      ...(beta ? { beta } : {}),
    },
    bot: {
      isConnected: () => true, isGroupAdmin: (g, who) => who?.jid === ADMIN.jid,
      deleteMessage: async () => {}, archiveChat: async () => {},
      sendText: async (jid, text, opts) => { out.push({ jid, text, quoted: opts?.quoted?.id ?? null }); return { key: { id: 'T' } }; },
      react: async (msg, emoji) => { out.push({ on: msg.id, emoji }); return true; },
      async _bulkPace() {},
    },
    queue,
    store: h.store,
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), debug() {} },
  };
  h.ctx.requestPause = {
    isPaused: () => h.paused,
    heldFrom: (plugin, jid) => h.held.filter((it) => it.plugin === plugin && it.msg?.senderJid === jid).length,
    hold: async (ctx, msg, { plugin, text = null, extra = {} }) => {
      h.held.push({ id: msg.id, plugin, kind: 'request', msg: slimMessage(msg), ...(text != null ? { text } : {}), ...extra });
      await ctx.bot.react(msg, '⏸️');
    },
  };
  await tvPlugin.setup(h.ctx);
  tvPlugin._cooldown = new MemberCooldown({ section: 'TV', limits: { ...COOLDOWN_LIMITS, ...(limits ?? {}) } });
  return h;
}
const tvMsg = (text, who = BENNY, chat = TVREQ) => mkMsg(text, who, chat);
const tvAsk = async (h, text, who = BENNY, chat = TVREQ) => {
  const m = tvMsg(text, who, chat);
  await tvPlugin.onMessage(m, h.ctx);
  await settle();
  return m;
};
const seasons = (h) => h.queue.snapshot().pending.filter((e) => e.kind === 'tv').map((e) => e.label);
const tvClock = (h, who = BENNY, beta = false) => readClock(h.store, cooldownKeys(who.jid, { beta }).clock);

console.log('=== TV: a season with episodes queued starts the clock ===');
{
  const h = await tvHarness();
  const s1 = await tvAsk(h, 'The Boys season 1');
  ok(on(h, s1).startsWith('🔍 🎬') && seasons(h).join() === 'The Boys season 1', `queued (${on(h, s1)})`);
  ok(tvClock(h)?.what === 'The Boys season 1', 'and the clock starts');
  const s2 = await tvAsk(h, 'The Boys season 2');
  ok(on(h, s2) === '🚫', `the next request gets 🚫 (${on(h, s2)})`);
  await tvPlugin.teardown();
}

console.log('=== TV: every episode withheld on its rating starts no clock ===');
{
  const h = await tvHarness();
  const s3 = await tvAsk(h, 'The Boys season 3');
  ok(on(h, s3) === '🔍 ⛔' && !seasons(h).length, `season 3 is all TV-MA: ⛔, nothing queued (${on(h, s3)})`);
  ok(tvClock(h) === null, 'and no clock');
  const s1 = await tvAsk(h, 'The Boys season 1');
  ok(on(h, s1).startsWith('🔍 🎬'), `the next request runs and is queued (${on(h, s1)})`);
  await tvPlugin.teardown();
}

console.log('=== TV: "which season?" starts no clock ===');
{
  const h = await tvHarness();
  const show = await tvAsk(h, 'The Boys');
  ok(on(h, show) === '🔍 📺', `asked which season (${on(h, show)})`);
  ok(tvClock(h) === null, 'no clock');
  const other = await tvAsk(h, 'Frasier season 1');
  ok(on(h, other) === '🔍 📬', `another show straight after is looked up, not refused (${on(h, other)})`);
  const answer = await tvAsk(h, 'The Boys season 2');
  ok(on(h, answer).startsWith('🔍 🎬'), `and the season after that is queued (${on(h, answer)})`);
  await tvPlugin.teardown();
}

console.log('=== TV: a duplicate starts no clock ===');
{
  const h = await tvHarness();
  await tvAsk(h, 'The Boys season 1', BOB);
  const dup = await tvAsk(h, 'The Boys season 1');
  ok(on(h, dup).startsWith('🔍 🤥') && tvClock(h) === null, `already waiting: 🤥, and no clock (${on(h, dup)})`);
  const next = await tvAsk(h, 'The Boys season 2');
  ok(on(h, next).startsWith('🔍 🎬'), `the member's next request is queued (${on(h, next)})`);
  await tvPlugin.teardown();
}

console.log('=== TV: a request in flight is waited for ===');
{
  const h = await tvHarness();
  const release = hold('season 1');
  const first = tvMsg('The Boys season 1');
  const second = tvMsg('The Boys season 2');
  const p1 = tvPlugin.onMessage(first, h.ctx);
  await settle();
  const p2 = tvPlugin.onMessage(second, h.ctx);
  await settle();
  ok(on(h, second) === '', 'the second waits while the first is looked up');
  release();
  await p1; await p2; await settle();
  ok(on(h, first).startsWith('🔍 🎬') && on(h, second) === '🚫', `the first queued, so the second gets 🚫 (${on(h, first)} / ${on(h, second)})`);
  ok(seasons(h).join() === 'The Boys season 1', 'one season queued, not two');
  await tvPlugin.teardown();
}

console.log('=== TV: the backstop, and the one answer to "which season?" past it ===');
{
  const h = await tvHarness();
  const five = [];
  for (let i = 0; i < 5; i += 1) five.push(await tvAsk(h, 'The Boys'));
  ok(five.every((m) => on(h, m) === '🔍 📺'), 'five "The Boys" in a row are each asked which season');
  ok(h.out.filter((e) => /which season\?/.test(e.text ?? '')).length === 5, 'five questions - and no more:');
  const sixth = await tvAsk(h, 'The Boys');
  ok(on(h, sixth) === '🚫', `the sixth gets 🚫 (${on(h, sixth)})`);
  ok(h.out.filter((e) => /which season\?/.test(e.text ?? '')).length === 5, 'and draws no sixth question');
  const answer = await tvAsk(h, 'The Boys season 1');
  ok(on(h, answer).startsWith('🔍 🎬') && seasons(h).join() === 'The Boys season 1',
    `the answer the bot asked for still goes through, once (${on(h, answer)})`);
  const more = await tvAsk(h, 'The Boys season 2');
  ok(on(h, more) === '🚫', `and the next does not (${on(h, more)})`);
  await tvPlugin.teardown();
}

console.log('=== TV: held while paused, judged again on resume ===');
{
  const h = await tvHarness();
  h.paused = true;
  const a = await tvAsk(h, 'The Boys season 1');
  const b = await tvAsk(h, 'The Boys season 2');
  ok(on(h, a) === '⏸️' && on(h, b) === '⏸️', 'both held');
  h.paused = false;
  for (const item of h.held.splice(0)) await tvPlugin.replayHeld(item, h.ctx);
  await settle();
  ok(on(h, a).startsWith('⏸️ 🔍 🎬') && on(h, b) === '⏸️ 🚫', `the first queued, the second 🚫 (${on(h, a)} / ${on(h, b)})`);
  await tvPlugin.teardown();
}

console.log('=== TV: a group admin is exempt ===');
{
  const h = await tvHarness();
  await tvAsk(h, 'The Boys season 1', ADMIN);
  const second = await tvAsk(h, 'The Boys season 2', ADMIN);
  ok(on(h, second).startsWith('🔍 🎬'), `queued (${on(h, second)})`);
  for (let i = 0; i < 6; i += 1) await tvAsk(h, 'The Boys', ADMIN);
  ok(!h.out.some((e) => e.emoji === '🚫'), 'and six "which season?" draw no 🚫');
  await tvPlugin.teardown();
}

console.log('=== TV: "skip the cooldown while nobody else is waiting" ===');
{
  const h = await tvHarness({ tv: { cooldownOnlyWhenOthersWait: true } });
  await tvAsk(h, 'The Boys season 1');
  const s2 = await tvAsk(h, 'The Boys season 2');
  ok(on(h, s2).startsWith('🔍 🎬'), `only his own season waiting: through (${on(h, s2)})`);
  h.queue.add({ label: 'Bob\'s film', meta: { memberKey: requestMemberKey(tvMsg('', BOB)) }, run: async () => {} });
  ok(h.queue.hasOthers(requestMemberKey(tvMsg('', BENNY))), 'Bob has something in the queue now');
  const s3 = await tvAsk(h, 'The Boys season 1');
  ok(on(h, s3) === '🚫', `so the clock holds (${on(h, s3)})`);
  await tvPlugin.teardown();
}

console.log('=== TV: a message of several seasons lets the next request go once its first season is queued ===');
{
  // Found in review (2026-10-01): a message of several seasons settles only
  // once its last season has been looked up, AI checks and all, which can be
  // minutes after the first was queued. The clock starts at the first.
  const h = await tvHarness();
  const release = hold('season 2');
  const both = tvMsg('The Boys seasons 1-2');
  const p1 = tvPlugin.onMessage(both, h.ctx);
  for (let i = 0; i < 20 && !seasons(h).length; i += 1) await settle();
  ok(seasons(h).join() === 'The Boys season 1', `season 1 is queued while season 2 is still being looked up (${seasons(h).join()})`);
  ok(tvClock(h)?.what === 'The Boys seasons 1-2', 'and the clock has started already');
  const next = await tvAsk(h, 'The Boys season 3');
  ok(on(h, next) === '🚫', `so the member's next request gets 🚫 at once, not after the whole message (${on(h, next) || 'nothing yet'})`);
  release();
  await p1; await settle();
  ok(seasons(h).join() === 'The Boys season 1,The Boys season 2', 'and the message goes on to queue season 2');
  await tvPlugin.teardown();
}

console.log('=== TV and films: the wait for a request in flight covers the section\'s slowest lookup ===');
{
  // Found in review (2026-10-01): a minute, and "vinland saga season 1" took
  // 72 s that day. A second request let go at a minute finds no clock yet,
  // runs beside the first, and both queue.
  const saved = tvPlugin._cooldown;
  tvPlugin._cooldown = undefined;
  const tvWait = tvPlugin._cool().limits.inFlightWaitMs;
  tvPlugin._cooldown = saved;
  ok(tvWait > TV_AI_LIMITS.budgetMs && tvWait > 72_000, `TV waits ${tvWait / 1000} s: longer than its AI checks' budget (${TV_AI_LIMITS.budgetMs / 1000} s)`);
  const savedFilm = moviePlugin._cooldown;
  moviePlugin._cooldown = undefined;
  const filmWait = moviePlugin._cool().limits.inFlightWaitMs;
  moviePlugin._cooldown = savedFilm;
  ok(filmWait >= CHAIN_LIMITS.totalMs + DEFAULT_CONFIG.library.searchTimeoutMs,
    `films wait ${filmWait / 1000} s: the AI chain's ceiling and the library search's together`);
  ok(tvPlugin._cool().limits.floodAnswers === 5 && moviePlugin._cool().limits.floodWindowMs === 10 * 60_000, 'the backstop is the same in both');
}

console.log('=== TV: a full queue counts towards the backstop, for one season or several ===');
{
  // Found in review (2026-10-01): uncounted, ten "The Boys season 1" into a
  // full queue drew ten ⚠️, ten notifications lines and twenty Jellyfin
  // calls, where the old clock allowed one. And a message of several seasons
  // turned away by it counted where one season did not.
  const h = await tvHarness();
  h.queue.hasRoom = () => false;
  const key = cooldownKeys(BENNY.jid).answers;
  const one = await tvAsk(h, 'The Boys season 1');
  ok(on(h, one) === '🔍 ⚠️' && (h.store.get(key) ?? []).length === 1, `one season, queue full: ⚠️, counted (${on(h, one)})`);
  const two = await tvAsk(h, 'The Boys seasons 1-2');
  ok(/^🔍 .*⚠️$/.test(on(h, two)) && (h.store.get(key) ?? []).length === 2, `two seasons, queue full: ⚠️, counted once, the same (${on(h, two)})`);
  const more = [];
  for (let i = 0; i < 4; i += 1) more.push(await tvAsk(h, 'The Boys season 1'));
  ok(more.slice(0, 3).every((m) => on(h, m) === '🔍 ⚠️') && on(h, more[3]) === '🚫',
    `three more ⚠️, then 🚫 (${more.map((m) => on(h, m)).join(' | ')})`);
  ok(h.out.filter((e) => /queue is full/.test(e.text ?? '')).length === 5, 'five notifications lines in all, not one per message');
  ok(tvClock(h) === null, 'and no clock');
  await tvPlugin.teardown();
}

console.log('=== TV: held while paused, at most five ===');
{
  const h = await tvHarness();
  h.paused = true;
  const sent = [];
  for (let i = 0; i < 6; i += 1) sent.push(await tvAsk(h, 'The Boys'));
  ok(h.held.length === 5 && on(h, sent[5]) === '🚫', `five held, the sixth 🚫 (${sent.map((m) => on(h, m)).join(' | ')})`);
  await tvPlugin.teardown();
}

/* ============================ the module ============================ */

console.log('=== the backstop counts, and trips at the sixth and not before ===');
{
  const cool = new MemberCooldown({ section: 'test' });
  const s = fakeStore();
  const keys = cooldownKeys('x@lid');
  const logs = [];
  for (let i = 1; i <= 5; i += 1) {
    ok(cool.refusal(s, keys, { cooldownMs: 30_000 }) === null, `request ${i}: not refused`);
    cool.begin(keys, `r${i}`).settle(s, { counts: true, log: { warn: (m) => logs.push(m) }, who: 'x@lid' });
  }
  const sixth = cool.refusal(s, keys, { cooldownMs: 30_000 });
  ok(sixth?.why === 'flood' && sixth.count === 5 && sixth.leftMs > 9 * 60_000, `request 6: refused for the backstop (${JSON.stringify(sixth)})`);
  ok(logs.length === 1 && /has had 5 requests/.test(logs[0]), 'tripping it was logged once');
  // Not counted: a queued request starts the clock, and counts nothing.
  const t = new MemberCooldown({ section: 'test' });
  const s2 = fakeStore();
  t.begin(keys, 'q').settle(s2, { queued: true, what: 'Q' });
  ok(readClock(s2, keys.clock)?.what === 'Q' && !s2.get(keys.answers), 'queued: the clock, not a count');
  t.begin(keys, 'e').settle(s2, { counts: false });
  ok(!s2.get(keys.answers), 'an answer that does not count leaves nothing');
  ok(cooldownKeys('x@lid', { beta: true }).clock === 'cooldown:beta:x@lid', 'a beta request has keys of its own');
}

console.log('=== queued() starts the clock and lets the waiters go before the request settles ===');
{
  const cool = new MemberCooldown({ section: 'test' });
  const s = fakeStore();
  const keys = cooldownKeys('y@lid');
  const first = cool.begin(keys, 'seasons 1-3');
  let judged = null;
  const waiter = cool.turn(keys, { what: 'next', judge: () => { judged = cool.refusal(s, keys, { cooldownMs: 60_000 }); return judged ? { go: false } : { go: true }; } });
  await settle();
  ok(judged === null, 'the next waits while the first is in flight');
  ok(first.queued(s, { what: 'S1' }) === 'clock' && readClock(s, keys.clock)?.what === 'S1', 'queued(): the clock starts');
  const verdict = await waiter;
  ok(verdict.go === false && judged?.why === 'clock', 'and the waiter is judged by it at once');
  ok(first.settle(s, { counts: true }) === null && !s.get(keys.answers), 'the later settle records nothing more');
}

console.log('=== stale entries are cleared: old bare-number clocks, answers out of the window ===');
{
  const now = Date.now();
  const data = {
    'cooldown:old@lid': now - 60_000,                                   // before 2026-10-01
    'cooldown:new@lid': { at: now - 60_000, what: 'Heat (1995)' },
    'cooldown-answers:gone@lid': [now - 11 * 60_000, now - 20 * 60_000],
    'cooldown-answers:live@lid': [now - 60_000],
    'cooldown-pass:x@lid': { until: now + 1000 },
    pending: [],
  };
  const s = { ...fakeStore(), all: () => ({ ...data }), get: (k, d = null) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; }, delete: (k) => { delete data[k]; } };
  ok(sweepCooldownKeys(s, { now }) === 2, 'two cleared at start-up');
  ok(!('cooldown:old@lid' in data) && !('cooldown-answers:gone@lid' in data), 'the old clock and the stale answers');
  ok('cooldown:new@lid' in data && 'cooldown-answers:live@lid' in data && 'cooldown-pass:x@lid' in data && 'pending' in data, 'and nothing else');
  // And as a member's own are read.
  const cool = new MemberCooldown({ section: 'test' });
  const m = fakeStore();
  const keys = cooldownKeys('z@lid');
  m.set(keys.clock, now - 1000);
  m.set(keys.answers, [now - 11 * 60_000]);
  ok(cool.refusal(m, keys, { cooldownMs: 60_000 }) === null, 'neither refuses');
  ok(m.get(keys.clock) === null && m.get(keys.answers) === null, 'and both are gone once read');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
