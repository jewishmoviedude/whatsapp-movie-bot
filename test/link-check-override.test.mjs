/* The Test tab's link check says what the bot would do with an item: sent -
   its rating allows it, or it is on the bypass list - blocked, or sent only
   if the AI check clears it.
   Run: node test/link-check-override.test.mjs

   Since the operator's decision of 2026-09-29 - a title on the list: "Send
   it, no AI check"; the AI check: "No, AI only helps" - a listed item is
   'send', whatever the check would say or whether it is on; 'check', painted
   amber, is an item its rating blocks that the AI check could clear.

   On 2026-09-29 the operator put "The Last Samurai" (2003), "Collateral"
   (2004) and "Fullmetal Alchemist: Brotherhood" season 1 on the rating
   override list and found the panel still saying the bot would block them.
   POST /test/jellyfin-url decided from the letter grade alone: it never
   looked at the list, judged a TV episode against the FILM ratings, ignored
   the series' rating an episode is withheld on, and called every item with
   no rating unsendable - "the bot will not send an unrated file" - on an
   install where unrated films are allowed (blockUnrated off).

   Pinned over real HTTP against the real router, with Jellyfin a stubbed
   fetch: a listed R film is 'send'; one not listed is 'blocked', or 'check'
   where the AI check may clear it; a listed one with the content check
   switched off is still 'send'; an episode is judged on the TV list and on
   its series' rating, and matched to a season entry as the TV plugin
   matches it; an unrated film with blockUnrated off is not called
   unsendable; and the panel paints 'check' amber.

   And from the review of that change. The link check only looks; Queue link
   on the Dashboard is what queues a pasted link, and it judged every item on
   the film rules. With the link check now on the TV rules, the two disagreed
   both ways: FMA:B S01E14 read amber here and was refused there with "add it
   under Rated-R override" - it was already on the list - and a TV-14 episode
   of a TV-MA series read blocked here and was queued there. Queue link now
   refuses a series, season or episode, and the link check says it will.
   Pinned over HTTP with the real movie plugin behind Queue link: neither
   route queues or promises what the other refuses. And a series Jellyfin
   would not give up - an HTTP 503, or none visible to the bot's account -
   was read as unrated, so that TV-14 pilot came back 'send', in green, with
   nothing logged; now it is not judged sendable, and the log says why. */
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import { createApiRouter } from '../src/web/api.js';
import { JobQueue } from '../src/core/queue.js';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';
import { addOverride } from '../src/core/rating-overrides.js';
import moviePlugin from '../src/plugins/movie-requests/index.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const FMA = 'Fullmetal Alchemist: Brotherhood';
const id = (c) => c.repeat(32);
const ITEMS = {
  [id('a')]: { Type: 'Movie', Name: 'The Last Samurai', ProductionYear: 2003, OfficialRating: 'R' },
  [id('b')]: { Type: 'Movie', Name: 'Heat', ProductionYear: 1995, OfficialRating: 'R' },
  [id('c')]: { Type: 'Movie', Name: 'Paddington', ProductionYear: 2014, OfficialRating: 'PG' },
  [id('d')]: { Type: 'Movie', Name: 'Nobody Rated This', ProductionYear: 2011 },
  [id('e')]: { Type: 'Series', Name: FMA, ProductionYear: 2009, OfficialRating: 'TV-14' },
  [id('f')]: { Type: 'Season', Name: 'Season 1', IndexNumber: 1, SeriesId: id('e'), SeriesName: FMA },
  // S01E14 and S02E03: TV-MA, for violence, in a TV-14 series.
  [id('1')]: {
    Type: 'Episode', Name: 'Those Who Lurk Underground', IndexNumber: 14, ParentIndexNumber: 1,
    SeriesId: id('e'), SeasonId: id('f'), SeriesName: FMA, OfficialRating: 'TV-MA',
  },
  [id('2')]: {
    Type: 'Episode', Name: 'Some Later Episode', IndexNumber: 3, ParentIndexNumber: 2,
    SeriesId: id('e'), SeasonId: id('9'), SeriesName: FMA, OfficialRating: 'TV-MA',
  },
  // A TV-14 episode of a TV-MA show: withheld on the series' rating.
  [id('3')]: { Type: 'Series', Name: 'Grim Show', ProductionYear: 2015, OfficialRating: 'TV-MA' },
  [id('4')]: {
    Type: 'Episode', Name: 'Pilot', IndexNumber: 1, ParentIndexNumber: 1,
    SeriesId: id('3'), SeasonId: id('5'), SeriesName: 'Grim Show', OfficialRating: 'TV-14',
  },
};

// How Jellyfin answers for Grim Show, the TV-MA series: normally, 'down'
// (HTTP 503), or 'hidden' (no such item, as for a library the bot's account
// cannot see).
let grimSeries = 'normal';
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.hostname !== 'jf.test') return new Response('{}', { status: 404 });
  const want = u.searchParams.get('Ids');
  if (want === id('3') && grimSeries === 'down') return new Response('Service Unavailable', { status: 503, statusText: 'Service Unavailable' });
  if (want === id('3') && grimSeries === 'hidden') return json({ Items: [] });
  if (u.pathname === '/Items' && want) {
    const it = ITEMS[want];
    return json({ Items: it ? [{ Id: want, ...it }] : [] });
  }
  return json({ Items: [] });
};

const CONFIG = mergeDefaults({
  web: { adminPasswordHash: 'x', users: [{ username: 'mommy', role: 'superadmin', passwordHash: 'x' }] },
  // TV-MA only on the TV list, so an episode judged on the film list - as it
  // used to be - would come out "allowed".
  movieRequests: { blockedRatings: ['R', 'NC-17', 'X'], blockUnrated: false },
  tvRequests: { blockedRatings: ['TV-MA'] },
}, DEFAULT_CONFIG);
CONFIG.library = mergeDefaults({
  provider: 'jellyfin',
  jellyfin: { baseUrl: 'http://jf.test', authMethod: 'apikey', apiKey: 'KEY', accessToken: 'TOK', userId: 'U1' },
}, DEFAULT_CONFIG.library);
// Rated films not let through on a clean answer, the default until 2026-10-12
// (live-settings-defaults): the cases where the AI check may clear one say so.
const GEMINI_ON = { ...CONFIG.gemini, enabled: true, contentCheck: true, allowCleanRatedFilms: false, apiKey: 'AIzaSyTEST-link-check-0000000000000000' };
CONFIG.gemini = { ...GEMINI_ON };

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
const stateStore = makeStateStore();
const list = stateStore.namespace('movie-requests');
addOverride(list, 'The Last Samurai (2003)', { addedBy: 'mommy' });
addOverride(list, 'Collateral (2004)', { addedBy: 'mommy' });
addOverride(list, `${FMA} season 1`, { addedBy: 'mommy' });

// The real movie plugin behind Queue link, queueing into a list.
CONFIG.movieRequests.postsGroup = 'movie-posts@g.us';
const queued = [];
const movieCtx = {
  config: CONFIG, store: list,
  bot: { isConnected: () => true, react: async () => true, sendText: async () => ({ key: { id: 'B' } }), async _bulkPace() {}, on() {}, off() {} },
  log: { info() {}, warn() {}, error() {}, debug() {} },
  configStore: { update() {} },
  queue: { maxLength: 50, pending: [], add: (j) => { queued.push(j); return `job-${queued.length}`; }, snapshot: () => ({ pending: [], active: [] }) },
};
const warned = [];
const queue = new JobQueue({ concurrency: 1 }); queue.pause();
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = { user: { username: 'mommy', role: 'superadmin' } }; next(); });
app.use('/api', createApiRouter({
  configStore: { get: () => CONFIG, update: () => CONFIG, redacted: () => ({}), onChange: () => {} },
  bot: { groupCache: new Map(), groups: () => [], on: () => {}, state: 'connected' },
  queue, linkQueue: queue,
  pluginManager: { plugins: new Map([['movie-requests', { plugin: moviePlugin, ctx: movieCtx }]]), notifyConfigChange: async () => {} },
  stateStore, fileLogger: { tail: () => [] }, alerts: {}, lockScheduler: {},
}));
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const port = server.address().port;

function check(itemId, route = '/api/test/jellyfin-url') {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ url: `https://jf.test/web/#/details?id=${itemId}` });
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: route,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
    (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(buf) }));
    });
    r.on('error', reject);
    r.write(data);
    r.end();
  });
}
const queueLink = (itemId) => check(itemId, '/api/queue/from-url');

console.log('=== a bypass-list title is sent without asking the AI: the link check ===');
{
  const r = await check(id('a'));
  ok(r.verdict === 'send' && r.wouldSend === true, `The Last Samurai: send (${r.verdict})`);
  ok(r.why === 'Rated R, which is on the blocked list. It is on the bypass list (rating override for "The Last Samurai" (2003) by mommy), so it is sent without the AI check.',
    `and says why: "${r.why}"`);

  CONFIG.gemini = { ...GEMINI_ON, contentCheck: false };
  const off = await check(id('a'));
  CONFIG.gemini = { ...GEMINI_ON };
  ok(off.verdict === 'send', `with the content check switched off, still send - the list needs no check (${off.verdict})`);

  const heat = await check(id('b'));
  ok(heat.verdict === 'blocked' && heat.why === 'Rated R, which is on the blocked list.', `a film not on the list is blocked: "${heat.why}"`);

  const pg = await check(id('c'));
  ok(pg.verdict === 'send' && pg.wouldSend === true && pg.why === 'Rated PG, which is allowed.', 'a PG film is sent, as before');
}

console.log('=== a film its rating blocks, not on the list, where the AI check may clear it: "check" ===');
{
  CONFIG.gemini = { ...GEMINI_ON, allowCleanRatedFilms: true };
  const heat = await check(id('b'));
  CONFIG.gemini = { ...GEMINI_ON };
  ok(heat.verdict === 'check' && heat.wouldSend === false
    && heat.why === 'Rated R, which is on the blocked list. It is sent only if the AI check finds no nudity in it.',
  `amber, and says what it waits on: "${heat.why}"`);
}

console.log('=== an unrated film is not called unsendable where unrated films are allowed ===');
{
  const r = await check(id('d'));
  ok(r.verdict === 'send' && r.wouldSend === true, `blockUnrated off: sent (${r.verdict})`);
  ok(!/will not send/.test(r.why) && /unrated films are not blocked/.test(r.why), `"${r.why}"`);
  ok(/Queue link on the Dashboard refuses an item with no rating/.test(r.why),
    'and it says Queue link, which refuses an unrated item whatever the setting, would not take it');

  CONFIG.movieRequests.blockUnrated = true;
  const b = await check(id('d'));
  CONFIG.movieRequests.blockUnrated = false;
  ok(b.verdict === 'blocked' && /unrated films are blocked/.test(b.why), `blockUnrated on: blocked: "${b.why}"`);
}

console.log('=== TV is judged on the TV list and the series\' rating, and matched as the TV plugin matches ===');
{
  const e14 = await check(id('1'));
  ok(e14.verdict === 'send', `FMA:B S01E14, TV-MA, is covered by the season 1 entry, so it is sent (${e14.verdict}: "${e14.why}")`);
  ok(/on the bypass list \(rating override for "Fullmetal Alchemist: Brotherhood" season 1 by mommy\), so it is sent without the AI check/.test(e14.why),
    'and names that entry');

  const s2 = await check(id('2'));
  ok(s2.verdict === 'blocked' && /^Rated TV-MA, which is on the blocked list\. Queue link on the Dashboard does not queue TV/.test(s2.why),
    `S02E03, TV-MA, is blocked on the TV list - the film list lacks TV-MA - and the season 1 entry does not cover it: "${s2.why}"`);

  const series = await check(id('e'));
  ok(series.verdict === 'send' && /Rated TV-14, which is allowed\./.test(series.why), `the TV-14 series itself: send ("${series.why}")`);

  const grim = await check(id('4'));
  ok(grim.verdict === 'blocked' && /^The series is rated TV-MA, which is on the blocked list\./.test(grim.why),
    `a TV-14 episode of a TV-MA series is withheld on the series' rating: "${grim.why}"`);

  const season = await check(id('f'));
  ok(season.verdict === 'send' && /^The series is rated TV-14, which is allowed; this season has no rating of its own\./.test(season.why)
    && /decided one by one/.test(season.why),
    `a season with no rating of its own, in a TV-14 series: send, episode by episode ("${season.why}")`);
}
console.log('=== a series Jellyfin will not give up is not read as unrated ===');
{
  // The warning is caught where the log file gets it, the logger's sink.
  const log = (await import('../src/util/logger.js')).default;
  const lines = [];
  log.setSink({ write: (e) => lines.push(e) });
  for (const [how, cause] of [['down', /Jellyfin HTTP 503/], ['hidden', /cannot see the series/]]) {
    grimSeries = how;
    lines.length = 0;
    const r = await check(id('4'));
    ok(r.verdict !== 'send' && r.wouldSend === false,
      `the TV-14 pilot of a TV-MA series, its series ${how === 'down' ? 'answering 503' : 'not visible'}: not "send" (${r.verdict})`);
    ok(/^Could not read the series' rating \(/.test(r.why) && cause.test(r.why), `and says why: "${r.why}"`);
    const warn = lines.find((e) => e.level === 'warn' && /^link check: could not read the series of episode/.test(e.msg));
    ok(!!warn && warn.msg.includes(id('4')) && cause.test(warn.msg), `and it is logged: "${warn?.msg}"`);
  }
  log.setSink(null);
  grimSeries = 'normal';
  const back = await check(id('4'));
  ok(back.verdict === 'blocked' && /^The series is rated TV-MA/.test(back.why), 'with the series readable again, it is blocked on its rating as before');
}

console.log('=== the link check and Queue link agree: neither queues or promises what the other refuses ===');
{
  // FMA:B S01E14 (TV-MA, covered by the season 1 entry, "send"), the TV-14 pilot of a
  // TV-MA series, the TV-14 series itself, and a season.
  for (const [what, itemId] of [['S01E14', id('1')], ['a TV-14 episode of a TV-MA series', id('4')], ['a series', id('e')], ['a season', id('f')]]) {
    const before = queued.length;
    const look = await check(itemId);
    const q = await queueLink(itemId);
    ok(q.status === 400 && q.ok === false && /^This is a TV (episode|series|season)\. Queue link only takes films/.test(q.error) && queued.length === before,
      `${what}: Queue link queues nothing, and says it is TV ("${q.error}")`);
    ok(!/Rated-R override/.test(q.error), 'rather than pointing at a list it may already be on');
    ok(/Queue link on the Dashboard does not queue TV/.test(look.why),
      `and the link check (${look.verdict}) says Queue link will not take it`);
  }

  // Films: the link check's word is Queue link's deed.
  const before = queued.length;
  const pg = await check(id('c'));
  const pgq = await queueLink(id('c'));
  ok(pg.verdict === 'send' && pgq.ok === true && queued.length === before + 1, 'a PG film: "send", and Queue link queues it');
  const heat = await check(id('b'));
  const heatq = await queueLink(id('b'));
  ok(heat.verdict === 'blocked' && heatq.ok === false && queued.length === before + 1, 'an R film not on the list: "blocked", and Queue link refuses it');
  const listed = await check(id('a'));
  const listedq = await queueLink(id('a'));
  ok(listed.verdict === 'send' && listedq.ok === true && queued.length === before + 2,
    'an R film on the bypass list: "send", and Queue link queues it');

  // And the plugin refuses a show itself, whoever calls it.
  let err = null;
  try { await moviePlugin.queueLibraryItem({ id: id('1'), type: 'Episode', title: 'Those Who Lurk Underground', rated: 'TV-MA' }, movieCtx); } catch (e) { err = e; }
  ok(/^This is a TV episode\./.test(err?.message ?? '') && queued.length === before + 2, `queueLibraryItem refuses it too ("${err?.message}")`);
}

server.close();

console.log('=== the panel paints "check" amber ===');
{
  const src = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  const start = src.indexOf("$('btn-jf-check')");
  const end = src.indexOf('/* And this one actually queues it');
  ok(start > 0 && end > start, 'the link check handler is one block in app.js');
  const els = {};
  const $ = (k) => (els[k] ??= { value: '', innerHTML: '', textContent: '', addEventListener(_ev, fn) { this.handler = fn; } });
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let answer = null;
  const api = async () => answer;
  // eslint-disable-next-line no-new-func
  new Function('$', 'api', 'esc', src.slice(start, end))($, api, esc);
  const paint = async (r) => {
    answer = { title: 'T', year: 2003, rated: 'R', onDisk: false, ...r };
    $('jf-url').value = 'x';
    await els['btn-jf-check'].handler();
    return els['jf-result'].innerHTML;
  };
  ok(/class="verdict warn"/.test(await paint({ verdict: 'check', wouldSend: false, why: 'w' })), 'check: amber');
  ok(/class="verdict good"/.test(await paint({ verdict: 'send', wouldSend: true, why: 'w' })), 'send: green');
  ok(/class="verdict bad"/.test(await paint({ verdict: 'blocked', wouldSend: false, why: 'w' })), 'blocked: red');
  const css = fs.readFileSync(new URL('../src/web/public/style.css', import.meta.url), 'utf8');
  ok(/\.verdict\.warn \{[^}]*var\(--warn\)/.test(css), 'and the stylesheet has the amber');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
