/* The rating-override list in the panel: one list, films and TV alike.
   Run: node test/rating-override-panel.test.mjs

   The owner asked for "a rating-override list" for TV, then added "full
   metal alchemist" meaning Fullmetal Alchemist: Brotherhood - and, told the
   entry would not match, said: "Why you making everything so complicated?
   You know what I want, get it done". So there is no Film / TV choice and no
   refusal: a title covers the film or show of exactly that name (case,
   spaces and punctuation ignored), a year, season or episode narrows it, and
   a pasted link covers exactly its item. What an entry matches in the
   library right now is shown beside it - and since 2026-09-29 that is what
   it sends, with no AI check, the operator's "Send it, no AI check". Adding
   and removing are audited under the admin's name.

   Exactly that name since the evening of 2026-09-29. A title covered every
   name that started with it, so the owner's entry was shown matching both
   FMA shows and the FMA film; asked whether "Heat" should also send "Heat
   and Dust", the operator chose "Exact title only". The card, the
   confirmation and the "matches now" line say so, and the owner's entry now
   matches the 2003 series alone.

   The live list's one entry was also listed as "added by [object Object]",
   because the whole session user had been stored as addedBy. Pinned here.

   An "Ask again" button, added earlier that day to forget the AI check's
   kept answers about what an entry covers, went with the operator's
   decision: a listed episode consults no kept answer, so there is nothing
   for it to forget. Pinned: the button and its route are gone.

   The API is exercised over real HTTP against the real router, with Jellyfin
   a stubbed fetch. The card code is taken from the real app.js and run
   against the real index.html in linkedom; that half is skipped, with a
   line saying so, where linkedom (a devDependency) is not installed. */
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import { createApiRouter } from '../src/web/api.js';
import { JobQueue } from '../src/core/queue.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const FMA = 'Fullmetal Alchemist: Brotherhood';
const SERIES_ID = 'a1'.repeat(16);
const FILM_ID = 'f'.repeat(32);
const KN_UK = 'c3'.repeat(16);
const KN_US = 'd4'.repeat(16);

// The library: two FMA shows and an FMA film, and two shows called "Kitchen
// Nightmares", as on the live server. Listed whole by type (listItemNames),
// and looked up by id for a pasted link.
const SERIES = [
  { Id: SERIES_ID, Name: FMA, ProductionYear: 2009, ProviderIds: { Tvdb: '85249' } },
  { Id: 'f3'.repeat(16), Name: 'Fullmetal Alchemist', ProductionYear: 2003 },
  { Id: KN_UK, Name: 'Kitchen Nightmares', ProductionYear: 2004 },
  { Id: KN_US, Name: 'Kitchen Nightmares', ProductionYear: 2007 },
  { Id: 'e7'.repeat(16), Name: 'Space: 1999', ProductionYear: 1975 },
  { Id: 'e8'.repeat(16), Name: 'שטיסל', ProductionYear: 2013 },
];
const MOVIES = [
  { Id: FILM_ID, Name: 'Some Film', ProductionYear: 2001 },
  { Id: 'f5'.repeat(16), Name: 'Fullmetal Alchemist: The Conqueror of Shamballa', ProductionYear: 2005 },
  { Id: 'f6'.repeat(16), Name: 'Blade Runner 2049', ProductionYear: 2017 },
  { Id: 'f7'.repeat(16), Name: 'Blade Runner', ProductionYear: 1982 },
];

globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.hostname !== 'jf.test') return new Response('{}', { status: 404 });
  if (u.pathname === '/Items' && u.searchParams.get('Ids')) {
    const id = u.searchParams.get('Ids');
    if (id === SERIES_ID) return json({ Items: [{ Id: SERIES_ID, Type: 'Series', Name: FMA, ProductionYear: 2009, ProviderIds: { Tvdb: '85249' } }] });
    if (id === FILM_ID) return json({ Items: [{ Id: FILM_ID, Type: 'Movie', Name: 'Some Film', ProductionYear: 2001 }] });
    return json({ Items: [] });
  }
  if (u.pathname === '/Items') {
    const term = String(u.searchParams.get('searchTerm') ?? '').toLowerCase();
    const pool = u.searchParams.get('IncludeItemTypes') === 'Movie' ? MOVIES : SERIES;
    return json({ Items: pool.filter((i) => i.Name.toLowerCase().includes(term)) });
  }
  return json({ Items: [], SearchHints: [] });
};

/* ------------------------------------------------------------ the API --- */

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

const CONFIG = {
  web: { adminPasswordHash: 'x', users: [{ username: 'mommy', role: 'superadmin', passwordHash: 'x' }] },
  movieRequests: { requestGroups: [], reactions: {}, maxQueueLength: 50 },
  library: { provider: 'jellyfin', jellyfin: { baseUrl: 'http://jf.test', accessToken: 'TOK', userId: 'U1' } },
  media: { concurrency: 1 }, omdb: {}, whatsapp: { accounts: [], failover: {} },
  tvRequests: {}, directLinks: {}, queue: {}, lockdown: {},
};

async function boot() {
  const stateStore = makeStateStore();
  // The entry the live list really held.
  stateStore.namespace('movie-requests').set('rating-overrides', [{
    key: 't:full metal alchemist|', jellyfinId: null, title: 'full metal alchemist', year: null,
    addedBy: { username: 'superadmin', role: 'superadmin' }, note: '', addedAt: 1790636001601,
  }]);
  const queue = new JobQueue({ concurrency: 1 }); queue.pause();
  const linkQueue = new JobQueue({ concurrency: 1 }); linkQueue.pause();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: { username: 'mommy', role: 'superadmin' } }; next(); });
  app.use('/api', createApiRouter({
    configStore: { get: () => CONFIG, update: () => CONFIG, redacted: () => ({}), onChange: () => {} },
    bot: { groupCache: new Map(), groups: () => [], on: () => {}, state: 'connected' },
    queue, linkQueue,
    pluginManager: { plugins: new Map(), notifyConfigChange: async () => {} },
    stateStore, fileLogger: { tail: () => [] }, alerts: {}, lockScheduler: {},
  }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return {
    server, port: server.address().port,
    events: () => stateStore.namespace('audit').get('events', []),
    // Every entry where every build reads the list; one narrowed to a season
    // or an episode apart (rating-overrides.js TV_KEY).
    storedMain: () => stateStore.namespace('movie-requests').get('rating-overrides', []),
    storedTv: () => stateStore.namespace('movie-requests').get('rating-overrides-tv', []),
    stored: () => [
      ...stateStore.namespace('movie-requests').get('rating-overrides', []),
      ...stateStore.namespace('movie-requests').get('rating-overrides-tv', []),
    ],
  };
}

function req(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
    (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const t = await boot();

console.log('=== the API: one list, nothing to choose, nothing refused ===');
{
  const list0 = await req(t.port, 'GET', '/api/rating-overrides');
  ok(list0.body.overrides[0].key === 't:full metal alchemist|' && list0.body.overrides[0].addedBy === 'superadmin'
    && !('kind' in list0.body.overrides[0]), 'the live entry is listed as a title, added by "superadmin" rather than [object Object]');

  const m0 = (await req(t.port, 'GET', '/api/rating-overrides/matches')).body;
  const live = m0.matches?.['t:full metal alchemist|'];
  ok(m0.checked === true && live?.count === 1, `it matches one show right now, not the three it once did (${live?.count})`);
  ok(live?.items.map((i) => `${i.type}:${i.name}`).join() === 'tv:Fullmetal Alchemist',
    `the show of exactly that name, not Brotherhood or the film: ${live?.items.map((i) => i.name).join(' | ')}`);

  const film = await req(t.port, 'POST', '/api/rating-overrides', { input: 'Kill Me Three Times (2014)', note: 'R for violence' });
  ok(film.status === 200 && film.body.entry.addedBy === 'mommy' && !('kind' in film.body.entry), 'a title, added by the admin\'s name');
  ok(t.events()[0].action === 'rating override added: "Kill Me Three Times" (2014)' && t.events()[0].user === 'mommy'
    && t.events()[0].detail === 'R for violence', `audited with the note: "${t.events()[0].action}"`);
  ok(film.body.matches?.count === 0, 'what it matches is sent back: nothing on the server yet, and saved all the same');

  const series = await req(t.port, 'POST', '/api/rating-overrides', { input: `https://jf.test/web/#/details?id=${SERIES_ID}` });
  ok(series.status === 200 && series.body.entry.kind === 'tv' && series.body.entry.key === `jf:${SERIES_ID}`, 'a series link, found to be TV');
  ok(series.body.entry.covers === `${FMA} (2009) — whole series`, `which says what it covers: "${series.body.entry.covers}"`);
  ok(t.events()[0].action === `rating override added: ${FMA} (2009) — whole series`, `audited as it: "${t.events()[0].action}"`);

  const filmLink = await req(t.port, 'POST', '/api/rating-overrides', { input: FILM_ID, kind: 'tv' });
  ok(filmLink.status === 200 && filmLink.body.entry.kind === 'film', 'a film\'s link is a film entry, whatever the old form sent');

  const ep = await req(t.port, 'POST', '/api/rating-overrides', { input: `${FMA} S01E14`, note: 'TV-MA for violence' });
  ok(ep.status === 200 && ep.body.entry.season === 1 && ep.body.entry.episode === 14, 'one episode, by title');
  ok(t.events()[0].action === `rating override added: "${FMA}" S01E14`, `audited with the episode: "${t.events()[0].action}"`);
  ok(t.storedTv().some((e) => e.key === ep.body.entry.key) && !t.storedMain().some((e) => e.key === ep.body.entry.key),
    'kept apart, where an older build cannot read it as the film of that name');

  const both = await req(t.port, 'POST', '/api/rating-overrides', { input: 'Kitchen Nightmares' });
  ok(both.status === 200 && both.body.matches?.count === 2, `a name two shows share is saved, and shown to match both (${both.body.matches?.count})`);
  const vague = await req(t.port, 'POST', '/api/rating-overrides', { input: `${FMA} episode 14` });
  ok(vague.status === 200 && vague.body.matches?.count === 0, 'an episode with no season is saved as the name it is, which matches nothing, and says so');
  const again = await req(t.port, 'POST', '/api/rating-overrides', { input: 'FULL-METAL ALCHEMIST' });
  ok(again.status === 400 && /already on the list/.test(again.body.error), 'the same title twice is refused, however it is typed');
  const empty = await req(t.port, 'POST', '/api/rating-overrides', { input: '!!!' });
  ok(empty.status === 400, 'and input with nothing to match on');

  const list = (await req(t.port, 'GET', '/api/rating-overrides')).body.overrides;
  ok(list.length === 7, `the list holds them all (${list.length})`);

  const before = t.events().length;
  const del = await req(t.port, 'DELETE', `/api/rating-overrides/${encodeURIComponent(`jf:${SERIES_ID}`)}`);
  ok(del.status === 200 && !t.stored().some((e) => e.key === `jf:${SERIES_ID}`), 'a link entry is removed');
  ok(t.events().length === before + 1 && t.events()[0].action === `rating override removed: ${FMA} (2009) — whole series`,
    `and the removal names it: "${t.events()[0].action}"`);
  const delFilm = await req(t.port, 'DELETE', `/api/rating-overrides/${encodeURIComponent('t:kill me three times|2014')}`);
  ok(delFilm.status === 200 && t.events()[0].action === 'rating override removed: "Kill Me Three Times" (2014)',
    `a title's removal names the title rather than its key: "${t.events()[0].action}"`);
  ok(t.stored().every((e) => typeof e.addedBy !== 'object' || e.addedBy === null),
    'saving the list rewrote the old entry\'s addedBy as a name');
}

console.log('=== names the admin types exactly as the library has them ===');
{
  // "Blade Runner 2049" was saved as "Blade Runner" from 2049 and shown to
  // match nothing; a Hebrew or Cyrillic name was refused outright, with a
  // message saying it had no letters. Each is saved, and matches its item.
  const br = await req(t.port, 'POST', '/api/rating-overrides', { input: 'Blade Runner 2049' });
  ok(br.status === 200 && br.body.matches?.count === 1 && br.body.matches.items[0].name === 'Blade Runner 2049'
    && br.body.matches.items[0].year === 2017, `"Blade Runner 2049" matches the 2017 film, and not Blade Runner (1982): ${JSON.stringify(br.body.matches?.items)}`);
  const sp = await req(t.port, 'POST', '/api/rating-overrides', { input: 'Space: 1999' });
  ok(sp.status === 200 && sp.body.matches?.count === 1 && sp.body.matches.items[0].name === 'Space: 1999', '"Space: 1999" matches the show');
  const he = await req(t.port, 'POST', '/api/rating-overrides', { input: 'שטיסל' });
  ok(he.status === 200 && he.body.entry?.title === 'שטיסל' && he.body.matches?.count === 1 && he.body.matches.items[0].type === 'tv',
    `a Hebrew name is saved and matches the show: ${he.status} ${JSON.stringify(he.body.matches ?? he.body.error)}`);
  const ru = await req(t.port, 'POST', '/api/rating-overrides', { input: 'Шерлок' });
  ok(ru.status === 200 && ru.body.matches?.count === 0, 'a Cyrillic name nothing has yet is saved, and shown to match nothing');
  const del = await req(t.port, 'DELETE', `/api/rating-overrides/${encodeURIComponent(he.body.entry.key)}`);
  ok(del.status === 200 && !t.stored().some((e) => e.title === 'שטיסל'), 'and removed by its key');

  // A film library that is not Jellyfin: films are not listed, so the add's
  // answer says so rather than "matches nothing".
  CONFIG.library.provider = 'plex';
  const plex = await req(t.port, 'POST', '/api/rating-overrides', { input: 'Kill Me Three Times' });
  CONFIG.library.provider = 'jellyfin';
  ok(plex.status === 200 && plex.body.matches?.films === false && plex.body.matches.count === 0,
    'with a Plex film library, the answer says films were not listed');
}
console.log('=== "Ask again" is gone: a listed episode consults no kept answer ===');
{
  const api = fs.readFileSync(new URL('../src/web/api.js', import.meta.url), 'utf8');
  ok(!/forget-checks|forgetKept/.test(api), 'the forget-checks route is gone');
}
t.server.close();

/* ----------------------------------------------------------- the card --- */

let parseHTML = null;
try { ({ parseHTML } = await import('linkedom')); } catch { /* production install */ }

if (!parseHTML) {
  console.log('=== the card: skipped - linkedom (a devDependency) is not installed ===');
} else {
  console.log('=== the card: one box, what each entry covers and matches, add and remove ===');
  const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
  const start = app.indexOf('/* ----------------------- rated-R override');
  const end = app.indexOf('/* --------------------- not in the library');
  ok(start > 0 && end > start, 'the card code is one block in app.js');
  const block = app.slice(start, end);

  const win = parseHTML(html);
  const { document } = win;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const calls = [];
  const confirms = [];
  const listed = [
    { key: 't:full metal alchemist|', title: 'full metal alchemist', year: null, addedBy: { username: 'superadmin' }, addedAt: 1790636001601 },
    { kind: 'tv', key: `jf:${SERIES_ID}`, jellyfinId: SERIES_ID, covers: `${FMA} (2009) — whole series`, addedBy: 'mommy', addedAt: 1790700000000 },
    { key: 't:fullmetal alchemist brotherhood|2009|1|14', title: FMA, year: 2009, season: 1, episode: 14, addedBy: 'mommy', addedAt: 1790700000000 },
    { key: 't:zzz|', title: 'zzz', year: null, addedBy: 'mommy', addedAt: 1790700000000 },
    { key: `jf:${'9'.repeat(32)}`, jellyfinId: '9'.repeat(32), addedBy: 'mommy', addedAt: 1790700000000 },
  ];
  const matches = {
    checked: true, films: true,
    matches: {
      't:full metal alchemist|': { count: 1, items: [{ name: 'Fullmetal Alchemist', year: 2003, type: 'tv' }] },
      [`jf:${SERIES_ID}`]: { count: 1, items: [{ name: `${FMA} (2009) — whole series`, year: null, type: 'tv' }] },
      't:zzz|': { count: 0, items: [] },
    },
  };
  let answerFilms = true;
  const api = async (method, url, body) => {
    calls.push({ method, url, body });
    if (method === 'GET' && url === '/rating-overrides/matches') return matches;
    if (method === 'GET') return { overrides: listed };
    if (method === 'POST' && !answerFilms) return { ok: true, entry: {}, matches: { films: false, count: 0, items: [] } };
    if (method === 'POST') return { ok: true, entry: {}, matches: { count: 1, films: true, items: [{ name: FMA, year: 2009, type: 'tv' }] } };
    return { ok: true };
  };
  const winObj = {};
  // eslint-disable-next-line no-new-func
  new Function('$', 'esc', 'api', 'document', 'confirm', 'toast', 'fmtDateTime', 'window', `
    ${block}
    window.loadOverrides = loadOverrides;
  `)($, esc, api, document, (m) => { confirms.push(m); return true; }, () => {}, () => '2026-09-28 12:00', winObj);
  const settle = () => new Promise((r) => setTimeout(r, 10));

  ok(!$('ro-kind'), 'no Film / TV choice: one box');
  ok(/films and TV/.test(html) && /This sends a film or an episode the rating would otherwise block/.test(html), 'the heading says films and TV; the warning stays');
  ok(/Everything an entry covers is sent, with no AI nudity check/.test(html) && !/confirm there is no nudity/.test(html),
    'and says an entry sends with no AI check - no longer that the check must confirm no nudity');
  ok(/covers films and TV alike/.test(html) && /named\s+<em>exactly<\/em> that/.test(html) && !/<em>starts with<\/em>/.test(html)
    && /<code>full metal alchemist<\/code> covers <em>Fullmetal Alchemist<\/em>/.test(html)
    && /not <em>Fullmetal Alchemist:\s+Brotherhood<\/em>, which needs an entry of its own/.test(html)
    && /<code>Heat<\/code>\s+covers <em>Heat<\/em> and not <em>Heat and Dust<\/em>/.test(html),
  'it says a title matches exactly, with the owner\'s example and the operator\'s question');
  ok(/covers the show and film of exactly that name/.test(html) && !/starts with it as whole words/.test(html), 'as does the TV card\'s pointer to the list');
  ok(/TV rating overrides[\s\S]{0,200}same list as films/.test(html) && !/📺 TV<\/b> chosen/.test(html), 'the TV card points to the one list');

  await winObj.loadOverrides();
  await settle();
  const rows = [...document.querySelectorAll('#ro-list .item')];
  ok(rows.length === 5, 'every entry is listed');
  ok(/full metal alchemist/.test(rows[0].querySelector('.item-title').textContent) && /by title/.test(rows[0].textContent), 'the old entry reads as a title');
  ok(/added by superadmin/.test(rows[0].textContent) && !/object Object/.test(rows[0].textContent), 'added by superadmin, not [object Object]');
  ok(/Covers: every film and show named exactly “full metal alchemist”/.test(rows[0].textContent), 'it says what a title covers: that exact name');
  const shown = (row) => row.querySelector('.ro-matches');
  ok(!shown(rows[0]).classList.contains('hidden')
    && shown(rows[0]).textContent === 'Matches now: 📺 Fullmetal Alchemist (2003)',
  `and what it matches in the library now: "${shown(rows[0]).textContent}"`);
  ok(/📺/.test(rows[1].querySelector('.item-title').textContent) && /by link · TV/.test(rows[1].textContent), 'a link says it is TV');
  ok(/Covers: Fullmetal Alchemist: Brotherhood \(2009\) — whole series/.test(rows[1].textContent), 'and what it covers');
  ok(/S01E14/.test(rows[2].querySelector('.item-title').textContent)
    && /only S01E14 of each show \(no films\)/.test(rows[2].textContent), 'an episode entry says it is that episode only');
  ok(shown(rows[3]).textContent === 'Matches nothing in the library right now.', 'a title that matches nothing says so, and stays');
  ok(shown(rows[4]).classList.contains('hidden') && !/Covers:/.test(rows[4].textContent),
    'a link nothing was learnt about shows no guess');
  ok(/Covers: every film and show named exactly “Fullmetal Alchemist: Brotherhood”, from 2009, or named “Fullmetal Alchemist: Brotherhood 2009”/
    .test(rows[2].textContent), 'a year on an entry is shown both ways, as it is matched');

  // Adding one: no kind, and the answer says what it matches.
  $('ro-input').value = 'full metal alchemist brotherhood';
  $('ro-add').dispatchEvent(new win.Event('click'));
  await settle();
  const post = calls.find((c) => c.method === 'POST');
  ok(post?.url === '/rating-overrides' && post.body.input === 'full metal alchemist brotherhood' && !('kind' in post.body), 'it is sent as typed, no kind');
  ok(/covers only the film or show of exactly that name/.test(confirms[0]) && /"Heat" covers "Heat", not "Heat and Dust"/.test(confirms[0])
    && !/starts with/.test(confirms[0]) && /sent whatever its rating, with no AI nudity check/.test(confirms[0]),
  'the confirmation says a title matches exactly, and that everything it covers is sent with no AI check');
  ok(/added — Matches now: 📺 Fullmetal Alchemist: Brotherhood \(2009\)/.test($('ro-note-msg').textContent),
    `and the answer says what it matches: "${$('ro-note-msg').textContent}"`);

  // With a film library that is not Jellyfin, no film was looked at: an
  // entry for an R film, which requests match all the same, must not read
  // "matches nothing" - an admin would delete a working entry over it.
  answerFilms = false;
  $('ro-input').value = 'Kill Me Three Times';
  $('ro-add').dispatchEvent(new win.Event('click'));
  await settle();
  ok($('ro-note-msg').textContent === 'added — Matches no show in the library right now (films not listed: the film library is not Jellyfin).',
    `films not listed: it does not say it matches nothing: "${$('ro-note-msg').textContent}"`);
  matches.films = false;
  await winObj.loadOverrides();
  await settle();
  const plexRows = [...document.querySelectorAll('#ro-list .item')];
  ok(shown(plexRows[3]).textContent === 'Matches no show in the library right now (films not listed: the film library is not Jellyfin).',
    `and nor does the list: "${shown(plexRows[3]).textContent}"`);
  ok(/^Matches now: .*\(films not listed: the film library is not Jellyfin\)$/.test(shown(plexRows[0]).textContent),
    'an entry that matches shows does say films were not listed, as before');
  matches.films = true;

  ok(!/Ask again/.test(rows[2].textContent) && !winObj.forgetOverrideChecks, 'no entry has "Ask again" any more');

  // Removing one.
  await winObj.removeOverride(`jf:${SERIES_ID}`);
  const del = calls.find((c) => c.method === 'DELETE');
  ok(del?.url === `/rating-overrides/${encodeURIComponent(`jf:${SERIES_ID}`)}`, 'Remove deletes that entry by its key');

  // History names the list on a film row ("sent: on the bypass list (...)");
  // a TV row has it in its detail.
  ok(/x\.override && x\.kind !== 'tv' \? `<br><span class="muted">\$\{esc\(x\.override\)\}<\/span>`/.test(app),
    'a film\'s History row shows what the list did, in its own words');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
