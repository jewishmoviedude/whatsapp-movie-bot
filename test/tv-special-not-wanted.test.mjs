/* A season of a show asked for in the movie group is never a wanted film.
   Run: node test/tv-special-not-wanted.test.mjs

   Incident: on 2026-09-14 Gary asked the movie group for "2 broke girls
   season 2". OMDb's title lookup, which asks for type=movie, answered with
   "2 Broke Girls: Season 2 - 2 Broke Girls at PaleyFest 2013" (tt8259160), a
   29-minute extra it files as a movie (Genre: Short). The library had no such
   film. The "is it a series?" check then searched Jellyfin for the whole of
   "2 broke girls season 2", matched nothing in 8,527 series, and missed 2
   Broke Girls (2011), which the TV library holds. So the extra went on the
   wanted list as a film a member wanted, and was still there on 2026-10-11.

   Pinned here, through the real movie plugin (OMDb and Jellyfin a stubbed
   fetch):
   - with the show on the server, the request is pointed at the TV group as
     the series it names, searched by the show's name, and nothing goes on the
     wanted list;
   - with the show not on the server, it is answered 📬 as before, on the
     not-in-library list with why, and still not on the wanted list;
   - a film whose own title has the words in it (Open Season 2) and a
     possessive the TV parser reads as a season ("ocean's 11") are films, and
     go on the wanted list as any film the server lacks, with what was typed;
   - tvShapeOf: OMDb's series and episode types are shows; "episode 4" alone
     and a bare number are not. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import moviePlugin, { tvShapeOf } from '../src/plugins/movie-requests/index.js';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';
import { wantedKey } from '../src/core/wanted.js';
import { missKey } from '../src/core/library-misses.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const REQ = 'movie-requests@g.us';
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const omdb = (Title, Year, imdbID, extra = {}) => ({
  Title, Year: String(Year), Rated: 'PG', imdbID, Type: 'movie', Released: '01 Jan 2000', DVD: '01 Jan 2001', Response: 'True', ...extra,
});
const PALEYFEST = omdb('2 Broke Girls: Season 2 - 2 Broke Girls at PaleyFest 2013', 2013, 'tt8259160',
  { Rated: 'N/A', Genre: 'Short', Runtime: '29 min', aka: '2 broke girls season 2', Released: 'N/A', DVD: 'N/A' });
const OMDB = [
  PALEYFEST,
  omdb('Open Season 2', 2008, 'tt1107828'),
  omdb("Ocean's Eleven", 2001, 'tt0240772', { aka: "ocean's 11", Rated: 'PG-13' }),
];

let SERIES = [];
const seriesSearched = [];
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  if (u.hostname === 'www.omdbapi.com') {
    const p = u.searchParams;
    const miss = json({ Response: 'False', Error: 'Movie not found!' });
    if (p.get('i')) return json(OMDB.find((m) => m.imdbID === p.get('i')) ?? { Response: 'False', Error: 'Incorrect IMDb ID.' });
    if (p.get('t')) {
      const q = norm(p.get('t'));
      const hit = OMDB.find((m) => [m.Title, m.aka].filter(Boolean).some((t) => norm(t) === q));
      return hit ? json(hit) : miss;
    }
    const hits = OMDB.filter((m) => norm(m.Title).includes(norm(p.get('s'))));
    return hits.length ? json({ Response: 'True', Search: hits }) : miss;
  }
  if (u.hostname === 'jf.test') {
    const p = u.searchParams;
    const term = p.get('searchTerm');
    if (u.pathname === '/Items' && p.get('IncludeItemTypes') === 'Series') {
      if (term) seriesSearched.push(term);
      const items = SERIES.filter((i) => !term || norm(i.Name).includes(norm(term)));
      return json({ Items: items, TotalRecordCount: items.length });
    }
    if (u.pathname === '/Items' && p.get('Ids')) {
      const item = SERIES.find((i) => i.Id === p.get('Ids'));
      return json({ Items: item ? [item] : [], TotalRecordCount: item ? 1 : 0 });
    }
    // No films at all: whatever is asked for is not on the server.
    return json({ Items: [], SearchHints: [], TotalRecordCount: 0 });
  }
  return new Response('{}', { status: 404 });
};

const BROKE_GIRLS = { Id: 'S1'.padStart(32, '0'), Name: '2 Broke Girls', ProductionYear: 2011, OfficialRating: 'TV-14', Type: 'Series', RecursiveItemCount: 138 };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-special-not-wanted-'));

function harness() {
  const c = mergeDefaults({
    movieRequests: {
      requestGroups: [REQ], postsGroup: 'movie-posts@g.us', notify: { group: 'movie-notify@g.us' },
      requirePrefix: true, prefix: '#request', cooldownSecondsPerUser: 0, replyOnBlock: true,
    },
  }, DEFAULT_CONFIG);
  c.omdb.apiKey = 'test-key';
  c.gemini = { ...c.gemini, enabled: false };
  c.library = mergeDefaults({ provider: 'jellyfin', jellyfin: { baseUrl: 'http://jf.test', authMethod: 'apikey', apiKey: 'KEY', userId: 'U1' } }, DEFAULT_CONFIG.library);
  Object.assign(c.media, { workDir: TMP });
  const data = {};
  const out = [];
  const jobs = [];
  const ctx = {
    config: c,
    store: { get: (k, d = null) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; }, push: (k, v) => { (data[k] ??= []).unshift(v); } },
    bot: {
      isConnected: () => true,
      react: async (m, emoji) => { out.push({ op: 'react', emoji }); return true; },
      sendText: async (jid, body) => { out.push({ op: 'text', jid, body }); return { key: { id: 'B' } }; },
      editText: async () => true, deleteMessage: async () => {}, archiveChat: async () => {}, isGroupAdmin: () => false,
      groupMemberInfo: () => ({ isMember: false, mentionJid: null, mentionText: null }),
      groups: () => [], groupCache: new Map(), sameCommunity: () => false, groupMentionToken: (jid) => `@${jid.split('@')[0]}`,
      async _bulkPace() {}, on() {}, off() {},
    },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    configStore: { update() {} },
    queue: { maxLength: 50, pending: [], add: (j) => { jobs.push(j); return `job-${jobs.length}`; }, snapshot: () => ({ pending: [], active: [] }) },
  };
  return { ctx, data, out, jobs };
}

moviePlugin._reactors = new Map();
let seq = 0;
async function request(h, text) {
  const id = `G${++seq}`;
  await moviePlugin.onMessage({
    id, key: { id, remoteJid: REQ, participant: 'gavi@lid', fromMe: false }, text: `#request ${text}`, chatJid: REQ,
    isGroup: true, fromMe: false, messageType: 'conversation', senderJid: 'gavi@lid', senderNumber: '15550000003',
    senderNumberDisplay: '+15550000003', pushName: 'Gary', timestamp: Date.now(), raw: { key: { id } },
  }, h.ctx);
  await new Promise((r) => setTimeout(r, 20));
  return (h.data.history ?? []).find((r) => r.id === id);
}
const replies = (h) => h.out.filter((o) => o.op === 'text' && o.jid === REQ).map((o) => o.body);
const wanted = (h) => h.data.wanted ?? [];

console.log('=== "2 broke girls season 2" with the show on the server: pointed at the TV group ===');
{
  SERIES = [BROKE_GIRLS];
  seriesSearched.length = 0;
  const h = harness();
  const row = await request(h, '2 broke girls season 2');
  ok(row?.status === 'is-a-series', `answered as a series (${row?.status}: ${row?.detail})`);
  ok(replies(h).some((t) => /2 Broke Girls\* is a TV series, not a film/.test(t)), `the reply names the show (${JSON.stringify(replies(h))})`);
  ok(seriesSearched[0] === '2 broke girls', `the series was searched by the show's name, not the whole request (${seriesSearched.join(' | ')})`);
  ok(wanted(h).length === 0, 'nothing on the wanted list');
  ok(h.jobs.length === 0, 'nothing queued');
}

console.log('=== the same with the show not on the server: 📬, but still not a wanted film ===');
{
  SERIES = [];
  const h = harness();
  const row = await request(h, '2 broke girls season 2');
  ok(row?.status === 'not-in-library', `not in the library, as before (${row?.status})`);
  ok(wanted(h).length === 0, `the PaleyFest extra is not put on the wanted list (${wanted(h).map((w) => w.title).join(', ')})`);
  ok(!wanted(h).some((w) => w.key === wantedKey({ imdbId: 'tt8259160' })), 'tt8259160 in particular');
  const miss = (h.data['library-misses'] ?? []).find((m) => m.key === missKey({ kind: 'movie', title: PALEYFEST.Title, year: 2013 }));
  ok(!!miss && miss.request === '2 broke girls season 2', 'the not-in-library list keeps the request, as a fault to look at');
  ok(miss?.diagnostics?.some((d) => /asked as a show \("2 broke girls"\): it names season 2/.test(d)),
    `and says it was asked as a show (${JSON.stringify(miss?.diagnostics)})`);
}

console.log('=== films with the words in them are still films ===');
{
  SERIES = [BROKE_GIRLS];
  const h = harness();
  const open = await request(h, 'open season 2');
  ok(open?.status === 'not-in-library' && open?.title === 'Open Season 2', `Open Season 2 is a film the server lacks (${open?.status})`);
  const w = wanted(h).find((x) => x.key === wantedKey({ imdbId: 'tt1107828' }));
  ok(!!w, 'and goes on the wanted list');
  ok(JSON.stringify(w?.requests) === JSON.stringify(['open season 2']), `with what was typed (${JSON.stringify(w?.requests)})`);
  const ocean = await request(h, "ocean's 11");
  ok(ocean?.status === 'not-in-library' && !!wanted(h).find((x) => x.key === wantedKey({ imdbId: 'tt0240772' })),
    `"ocean's 11" is Ocean's Eleven, on the wanted list, not season 11 of "ocean'" (${ocean?.status})`);
  await request(h, 'Open Season 2 2008');
  const again = wanted(h).find((x) => x.key === wantedKey({ imdbId: 'tt1107828' }));
  ok(again?.count === 2 && again?.requests?.join(' | ') === 'open season 2 | Open Season 2 2008',
    `asked again another way: counted, and both wordings kept (${again?.requests?.join(' | ')})`);
}

console.log('=== tvShapeOf ===');
{
  const paley = { title: PALEYFEST.Title, type: 'movie' };
  ok(tvShapeOf('2 broke girls season 2', paley)?.show === '2 broke girls', 'a season named: the show it names');
  ok(tvShapeOf('the boys s02e03', { title: 'The Boys', type: 'movie' })?.show === 'the boys', 'S02E03 too');
  ok(tvShapeOf('Fargo season 2 2015', { title: 'Fargo', type: 'movie' })?.show === 'Fargo', 'with a year after it');
  ok(tvShapeOf('Some Show', { title: 'Some Show: Pilot', type: 'episode' })?.why === 'OMDb files it as an episode', 'an OMDb episode is a show');
  ok(!!tvShapeOf('Some Show', { title: 'Some Show', type: 'series' }), 'and so is an OMDb series');
  ok(tvShapeOf('Star Wars Episode 4', { title: 'Star Wars: Episode IV - A New Hope', type: 'movie' }) === null, '"episode 4" alone is not a season');
  ok(tvShapeOf('Toy Story 3', { title: 'Toy Story 3', type: 'movie' }) === null, 'nor a bare number');
  ok(tvShapeOf('Open Season 2', { title: 'Open Season 2', type: 'movie' }) === null, 'nor the film\'s own title');
  ok(tvShapeOf('Ocean’s 8', { title: "Ocean's 8", type: 'movie' }) === null, 'nor a possessive, with either apostrophe');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
