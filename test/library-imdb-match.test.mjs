/* A film the library names otherwise is found by its IMDb id.
   Run: node test/library-imdb-match.test.mjs

   Incident: on 2026-10-06 Erin Lane asked for "Harry Potter the sorcerers
   stone". OMDb resolved it to "Harry Potter and the Sorcerer's Stone" (2001),
   tt0241527. The server holds it as "Harry Potter and the Philosopher's
   Stone", with that very IMDb id in its ProviderIds, and the lookup, which
   matched titles only, answered "not in the library" and put it on the wanted
   list. The word search that would have found it never ran either: the two
   longest words were "sorcerers" and "sorcerer", one word written two ways,
   and "potter" was never searched. "Avatar Aang: The Last Airbender" (2026)
   was on the list the same way, held as "The Legend of Aang: The Last
   Airbender" under its id.

   Jellyfin's /Items has an AnyProviderIdEquals filter, but the live server
   (Jellyfin 10.11.10, checked read-only on 2026-10-11) ignores it: asked for
   imdb.tt0290334 it answered with all 20,869 films, the first of them "1, 2,
   3, All Eyes On Me". Pinned here, against a stubbed Jellyfin that behaves
   like that one and one that honours the filter:
   - the film is found by its id, under the library's name, with the shape a
     title hit has (download URL, alternates, sameTitled, and its id);
   - without the id the lookup is what it was, and finds nothing;
   - a server that ignores the filter is asked once, and never yields a film
     that does not carry the id; one that honours it finds a film no title
     search could;
   - every safeguard still holds: a copy carrying the id but from far off the
     film's year is refused, a title match is still the first answer, and a
     year the member typed still rules out a same-titled copy;
   - the file re-check takes a copy with the vetted film's id as that film,
     without asking OMDb again;
   - through the movie plugin, "#request Harry Potter the sorcerers stone" is
     queued, and is not put on the wanted list.

   And on 2026-10-11 the other way round: "A Snapshot of Forever" is 2025 to
   OMDb and 2022 on the server, one IMDb id (tt14074586). Mia's "a snapshot
   of forever 2025" was refused at 12:40 as "from another year than the 2025
   asked for", a year typed being held against a same-titled copy. Pinned
   below: a copy with the film's title and IMDb id is not ruled out by its
   year a few years off - by the lookup, the word search or the file
   re-check - while one with another id, or with no id and years away, still
   is; and the request itself is queued.

   But only a few years off (SAME_ID_MAX_YEAR_GAP, three). The first cut let
   the id win at any distance, and review found (2026-10-11) that a "Total
   Recall" (1990), rated R, carrying the PG-13 2012 film's tt1386703, was then
   taken for the 2012 film by the lookup, and its file never looked up again,
   so "#request total recall" would have posted the R film to a main group.
   Main looked it up and refused it on its rating; pinned below that it does
   again, as the lookup, the file re-check and the recheck's notTheFilm. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import { findInLibrary, forgetProviderFilterSupport, normImdb } from '../src/plugins/movie-requests/library.js';
import { verifyFileRating, isRequestedFilm } from '../src/plugins/movie-requests/film-gate.js';
import { notTheFilm } from '../src/core/wanted-recheck.js';
import { idYearsAgree, SAME_ID_MAX_YEAR_GAP } from '../src/util/fuzzy.js';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';
import { wantedKey } from '../src/core/wanted.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/* ------------------------------ fixtures ------------------------------ */

let seq = 0;
const film = (Name, ProductionYear, Imdb, OfficialRating = 'PG') => {
  seq += 1;
  return {
    Id: String(seq).padStart(32, '0'), Name, ProductionYear, OfficialRating, Type: 'Movie',
    ProviderIds: Imdb ? { Imdb, Tmdb: String(1000 + seq) } : {},
    MediaSources: [{ Path: `/nowhere/${Name}.mkv`, Size: 17, Container: 'mp4' }],
  };
};
const ALL_EYES = film('1, 2, 3, All Eyes On Me', 2020, 'tt11724300', 'NR');
const PHILOSOPHER = film("Harry Potter and the Philosopher's Stone", 2001, 'tt0241527');
const PHILOSOPHER_COPY = film("Harry Potter and the Philosopher's Stone", 2001, 'tt0241527');
const CHAMBER = film('Harry Potter and the Chamber of Secrets', 2002, 'tt0295297');
const AANG = film('The Legend of Aang: The Last Airbender', 2026, 'tt18259538');
const DUNE_1984 = film('Dune', 1984, 'tt0087182', 'PG-13');
const DUNE_2021 = film('Dune', 2021, 'tt1160419', 'PG-13');
const STRANGER = film('Asdf Ghjk', 2015, 'tt7777777');
// A making-of mis-tagged with the film's id, ten years after it.
const MISTAGGED = film('Harry Potter: Wizarding Stones', 2011, 'tt0241527');
// As the live server holds it: 2022, where OMDb says 2025 (2026-10-11).
const SNAPSHOT = film('A Snapshot of Forever', 2022, 'tt14074586', null);
const SNAPSHOT_OTHER = film('A Snapshot of Forever', 2022, 'tt99999999', null);
const SNAPSHOT_NO_ID = film('A Snapshot of Forever', 2022, null, null);
// The 1990 film, rated R, tagged with the 2012 remake's id (the live server
// tags both rightly: tt0100802 and tt1386703, checked read-only 2026-10-11).
const RECALL_MISTAGGED = film('Total Recall', 1990, 'tt1386703', 'R');
// The top of a big library, sorted by name: what an ignored filter answers
// with, the first ten of twenty thousand.
const TOP = Array.from({ length: 12 }, (_, i) => film(`${i + 1}, ${i + 2}, ${i + 3}, Film Number ${i}`, 2000 + i, `tt90000${10 + i}`));

let LIB = [];
// Whether /Items honours AnyProviderIdEquals. The live 10.11.10 does not.
let HONOURS = false;
const jfCalls = [];
const omdbCalls = [];

const OMDB = [
  { Title: "Harry Potter and the Sorcerer's Stone", Year: '2001', Rated: 'PG', imdbID: 'tt0241527', Type: 'movie',
    Released: '16 Nov 2001', DVD: 'N/A', Response: 'True', aka: 'harry potter the sorcerers stone' },
  { Title: 'A Snapshot of Forever', Year: '2025', Rated: 'N/A', imdbID: 'tt14074586', Type: 'movie',
    Released: '20 Aug 2025', DVD: 'N/A', Response: 'True', aka: 'a snapshot of forever 2025' },
  { Title: 'Total Recall', Year: '2012', Rated: 'PG-13', imdbID: 'tt1386703', Type: 'movie',
    Released: '03 Aug 2012', DVD: 'N/A', Response: 'True' },
  { Title: 'Total Recall', Year: '1990', Rated: 'R', imdbID: 'tt0100802', Type: 'movie',
    Released: '01 Jun 1990', DVD: 'N/A', Response: 'True' },
];

globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  if (u.hostname === 'www.omdbapi.com') {
    const p = u.searchParams;
    omdbCalls.push(Object.fromEntries(p));
    const miss = json({ Response: 'False', Error: 'Movie not found!' });
    if (p.get('i')) return json(OMDB.find((m) => m.imdbID === p.get('i')) ?? { Response: 'False', Error: 'Incorrect IMDb ID.' });
    if (p.get('t')) {
      // With a year, as OMDb answers "Total Recall" for 1990 and for 2012.
      const q = norm(p.get('t'));
      const y = p.get('y');
      const hit = OMDB.find((m) => [m.Title, m.aka].some((t) => norm(t) === q) && (!y || m.Year === y));
      return hit ? json(hit) : miss;
    }
    const hits = OMDB.filter((m) => norm(m.Title).includes(norm(p.get('s'))));
    return hits.length ? json({ Response: 'True', Search: hits }) : miss;
  }
  if (u.hostname === 'jf.test') {
    jfCalls.push(u);
    if (u.pathname !== '/Items') return json({ Items: [], SearchHints: [], TotalRecordCount: 0 });
    const p = u.searchParams;
    const limit = Number(p.get('Limit') ?? 1000);
    if (p.get('IncludeItemTypes') === 'Series') return json({ Items: [], TotalRecordCount: 0 });
    let items;
    const any = p.get('AnyProviderIdEquals');
    if (any) {
      // Ignored, the whole library comes back from the top, as on 10.11.10.
      items = HONOURS ? LIB.filter((i) => `imdb.${i.ProviderIds?.Imdb}` === any.toLowerCase()) : [ALL_EYES, ...TOP, ...LIB];
    } else if (p.get('searchTerm')) {
      // Jellyfin's searchTerm: a contiguous run of the stored name.
      items = LIB.filter((i) => norm(i.Name).includes(norm(p.get('searchTerm'))));
    } else {
      items = [];
    }
    return json({ Items: items.slice(0, limit), TotalRecordCount: items.length });
  }
  return new Response('{}', { status: 404 });
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'library-imdb-match-'));
const JELLYFIN = { baseUrl: 'http://jf.test', authMethod: 'apikey', apiKey: 'KEY', userId: 'U1' };
const LIBRARY = mergeDefaults({ provider: 'jellyfin', jellyfin: JELLYFIN }, DEFAULT_CONFIG.library);
const anyCalls = () => jfCalls.filter((u) => u.searchParams.has('AnyProviderIdEquals')).length;
const searched = () => jfCalls.map((u) => u.searchParams.get('searchTerm')).filter(Boolean);

/* ------------------------------ the incident ------------------------------ */

console.log('=== the Sorcerer\'s Stone is found as the Philosopher\'s Stone, by its IMDb id ===');
{
  LIB = [ALL_EYES, CHAMBER, PHILOSOPHER, PHILOSOPHER_COPY, DUNE_2021];
  forgetProviderFilterSupport();
  jfCalls.length = 0;
  const hit = await findInLibrary("Harry Potter and the Sorcerer's Stone", 2001, LIBRARY, {
    alsoTry: ['Harry Potter the sorcerers stone'], imdbId: 'tt0241527',
  });
  ok(hit?.title === "Harry Potter and the Philosopher's Stone" && hit?.year === 2001,
    `found under the library's name (${hit?.title} ${hit?.year})`);
  ok(hit?.imdbId === 'tt0241527', 'and the hit carries its IMDb id');
  ok(hit?.access === 'download' && /\/Items\/0+\d+\/Download/.test(hit?.downloadUrl ?? ''), 'with a download URL, as any hit');
  ok(hit?.alternates?.length === 1 && hit.alternates[0].id !== hit.id && !!hit.alternates[0].downloadUrl,
    'its second copy is the alternate, with its own URL');
  ok(Array.isArray(hit?.sameTitled), 'and sameTitled is there for the "which year?" step');
  ok(hit?.id !== ALL_EYES.Id, 'never the first film of an unfiltered answer');
  ok(searched().includes('potter'), `"potter" was searched, not only "sorcerers" and "sorcerer" (${searched().join(', ')})`);
  ok(anyCalls() === 1, `the server was asked for the id once (${anyCalls()})`);

  jfCalls.length = 0;
  const again = await findInLibrary("Harry Potter and the Sorcerer's Stone", 2001, LIBRARY, { imdbId: 'TT0241527' });
  ok(again?.id === PHILOSOPHER.Id || again?.id === PHILOSOPHER_COPY.Id, 'found again, the id in any case');
  ok(anyCalls() === 0, 'and a server seen ignoring the filter is not asked again');
}

console.log('=== without the id, the lookup is what it was ===');
{
  LIB = [ALL_EYES, CHAMBER, PHILOSOPHER];
  const hit = await findInLibrary("Harry Potter and the Sorcerer's Stone", 2001, LIBRARY, {
    alsoTry: ['Harry Potter the sorcerers stone'],
  });
  ok(hit === null, 'not found by title alone, as on 2026-10-06');
}

console.log('=== a renamed film: Avatar Aang (2026) is held as The Legend of Aang ===');
{
  LIB = [ALL_EYES, AANG];
  const hit = await findInLibrary('Avatar Aang: The Last Airbender', 2026, LIBRARY, { imdbId: 'tt18259538' });
  ok(hit?.title === 'The Legend of Aang: The Last Airbender', `found (${hit?.title})`);
}

console.log('=== a server that honours AnyProviderIdEquals finds what no title search can ===');
{
  LIB = [ALL_EYES, STRANGER];
  forgetProviderFilterSupport();
  HONOURS = false;
  ok(await findInLibrary('Qwerty Uiop', 2015, LIBRARY, { imdbId: 'tt7777777' }) === null,
    'ignoring it, nothing shares a word with the title: not found');
  forgetProviderFilterSupport();
  HONOURS = true;
  jfCalls.length = 0;
  const hit = await findInLibrary('Qwerty Uiop', 2015, LIBRARY, { imdbId: 'tt7777777' });
  ok(hit?.title === 'Asdf Ghjk' && hit?.imdbId === 'tt7777777', `honouring it, found under its library name (${hit?.title})`);
  ok(anyCalls() === 1, 'asked once');
  HONOURS = false;
  forgetProviderFilterSupport();
}

console.log('=== the safeguards still hold ===');
{
  LIB = [ALL_EYES, MISTAGGED];
  for (const honours of [false, true]) {
    forgetProviderFilterSupport();
    HONOURS = honours;
    jfCalls.length = 0;
    const hit = await findInLibrary("Harry Potter and the Sorcerer's Stone", 2001, LIBRARY, { imdbId: 'tt0241527' });
    ok(hit === null && searched().some((t) => MISTAGGED.Name.toLowerCase().includes(t.toLowerCase())),
      `a copy carrying the id, ten years from the film, is found and refused as another film (${honours ? 'filter honoured' : 'filter ignored'})`);
  }
  HONOURS = false;
  forgetProviderFilterSupport();

  LIB = [DUNE_1984, DUNE_2021];
  const dune = await findInLibrary('Dune: Part One', 2021, LIBRARY, { imdbId: 'tt1160419' });
  ok(dune?.id === DUNE_2021.Id, `"Dune: Part One" is the library's Dune (2021) (${dune?.year})`);

  LIB = [DUNE_2021];
  const typed = await findInLibrary('Dune', 1984, LIBRARY, { imdbId: 'tt0087182', typedYear: 1984, alsoTry: ['Dune 1984'] });
  ok(typed === null, '"Dune 1984" with only Dune (2021) is still not in the library');

  ok(normImdb(' TT0241527 ') === 'tt0241527' && normImdb('241527') === null && normImdb(null) === null,
    'an IMDb id is read in any case, and nothing else is taken for one');
}

console.log('=== the file re-check takes a copy with the vetted film\'s id as that film ===');
{
  const movie = { title: "Harry Potter and the Sorcerer's Stone", year: 2001, imdbId: 'tt0241527', rated: 'PG' };
  omdbCalls.length = 0;
  const same = await verifyFileRating({ title: "Harry Potter and the Philosopher's Stone", year: 2001, imdbId: 'tt0241527' },
    movie, { blockedRatings: ['R'] }, { omdbKey: 'k' });
  ok(same.mismatch === false && same.blocked === false && !same.rechecked && omdbCalls.length === 0,
    'no mismatch, and OMDb is not asked again');
  const noId = await verifyFileRating({ title: "Harry Potter and the Philosopher's Stone", year: 2001 },
    movie, { blockedRatings: ['R'] }, { omdbKey: 'k' });
  ok(omdbCalls.length > 0 && noId.mismatch === false, 'without the id it is looked up again, as before');
  omdbCalls.length = 0;
  await verifyFileRating({ title: "Harry Potter and the Philosopher's Stone", year: 2011, imdbId: 'tt0241527' },
    movie, { blockedRatings: ['R'] }, { omdbKey: 'k' });
  ok(omdbCalls.length > 0, 'a copy with the id but ten years off is still looked up again');
}

console.log('=== A Snapshot of Forever: the same IMDb id, three years apart, is the film ===');
{
  const ask = (lib) => {
    LIB = lib;
    forgetProviderFilterSupport();
    return findInLibrary('A Snapshot of Forever', 2025, LIBRARY, { alsoTry: ['a snapshot of forever 2025'], imdbId: 'tt14074586', typedYear: 2025 });
  };
  const hit = await ask([ALL_EYES, SNAPSHOT]);
  ok(hit?.id === SNAPSHOT.Id && hit.year === 2022, `"a snapshot of forever 2025" finds the 2022 copy carrying tt14074586 (${hit?.title} ${hit?.year})`);
  ok(await ask([ALL_EYES, SNAPSHOT_OTHER]) === null, 'a copy carrying another IMDb id is still another film');
  ok(await ask([ALL_EYES, SNAPSHOT_NO_ID]) === null, 'and one with no id, three years from the year typed, still is not the film');
  omdbCalls.length = 0;
  const movie = { title: 'A Snapshot of Forever', year: 2025, imdbId: 'tt14074586', rated: 'N/A' };
  const same = await verifyFileRating({ title: 'A Snapshot of Forever', year: 2022, imdbId: 'tt14074586' }, movie, { blockedRatings: ['R'] }, { omdbKey: 'k' });
  ok(same.mismatch === false && !same.rechecked && omdbCalls.length === 0, 'the file re-check takes it as the film without asking OMDb about "2022"');
  await verifyFileRating({ title: 'A Snapshot of Forever', year: 2022 }, movie, { blockedRatings: ['R'] }, { omdbKey: 'k' });
  ok(omdbCalls.length > 0, 'a file with no id three years off is looked up again, as before');
}

console.log('=== Total Recall: a remake tagged with the film\'s id, decades off, is not the film, and its rating is looked at ===');
{
  ok(SAME_ID_MAX_YEAR_GAP === 3 && idYearsAgree(2025, 2022) && !idYearsAgree(2025, 2021) && idYearsAgree(null, 1990),
    'one id is one film three years apart (Snapshot), not four, and an unknown year does not object');
  LIB = [ALL_EYES, RECALL_MISTAGGED];
  forgetProviderFilterSupport();
  const typed = await findInLibrary('Total Recall', 2012, LIBRARY, { alsoTry: ['total recall 2012'], imdbId: 'tt1386703', typedYear: 2012 });
  ok(typed === null, '"total recall 2012" does not take the 1990 copy carrying the 2012 film\'s id, as on main');
  const movie = { title: 'Total Recall', year: 2012, imdbId: 'tt1386703', rated: 'PG-13' };
  const file = { title: 'Total Recall', year: 1990, imdbId: 'tt1386703' };
  omdbCalls.length = 0;
  const rc = await verifyFileRating(file, movie, { blockedRatings: ['R'] }, { omdbKey: 'k' });
  ok(rc.rechecked === true && rc.blocked === true && rc.rated === 'R' && omdbCalls.length > 0,
    `the file re-check looks the 1990 file up again and finds it rated R (${JSON.stringify({ rechecked: rc.rechecked, blocked: rc.blocked, rated: rc.rated })})`);
  ok(!isRequestedFilm(movie, movie, file), 'nor is it taken for the film asked for when the re-check cannot name it');
  ok(notTheFilm({ year: 2012, imdbId: 'tt1386703' }, file) === 'it is from 1990, not 2012',
    'and the wanted recheck does not resolve the 2012 film with it');
}

/* ------------------------------ through the plugin ------------------------------ */

console.log('=== "#request Harry Potter the sorcerers stone" is queued, not listed as wanted ===');
{
  LIB = [ALL_EYES, CHAMBER, PHILOSOPHER];
  forgetProviderFilterSupport();
  const REQ = 'movie-requests@g.us';
  const c = mergeDefaults({
    movieRequests: {
      requestGroups: [REQ], postsGroup: 'movie-posts@g.us', notify: { group: 'movie-notify@g.us' },
      requirePrefix: true, prefix: '#request', cooldownSecondsPerUser: 0, replyOnBlock: true,
      blockedRatings: ['R', 'NC-17', 'X', 'TV-MA'],
    },
  }, DEFAULT_CONFIG);
  c.omdb.apiKey = 'test-key';
  c.gemini = { ...c.gemini, enabled: false };
  c.library = LIBRARY;
  Object.assign(c.media, { workDir: TMP });
  const data = {};
  const jobs = [];
  const ctx = {
    config: c,
    store: { get: (k, d = null) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; }, push: (k, v) => { (data[k] ??= []).unshift(v); } },
    bot: {
      isConnected: () => true, react: async () => true, sendText: async () => ({ key: { id: 'B' } }), editText: async () => true,
      deleteMessage: async () => {}, archiveChat: async () => {}, isGroupAdmin: () => false,
      groupMemberInfo: () => ({ isMember: false, mentionJid: null, mentionText: null }),
      groups: () => [], groupCache: new Map(), sameCommunity: () => false, groupMentionToken: (jid) => `@${jid.split('@')[0]}`,
      async _bulkPace() {}, on() {}, off() {},
    },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    configStore: { update() {} },
    queue: { maxLength: 50, pending: [], add: (j) => { jobs.push(j); return `job-${jobs.length}`; }, snapshot: () => ({ pending: [], active: [] }) },
  };
  moviePlugin._reactors = new Map();
  await moviePlugin.onMessage({
    id: 'HP1', key: { id: 'HP1', remoteJid: REQ, participant: 'esther@lid', fromMe: false },
    text: '#request Harry Potter the sorcerers stone', chatJid: REQ, isGroup: true, fromMe: false,
    messageType: 'conversation', senderJid: 'esther@lid', senderNumber: '15550000002', senderNumberDisplay: '+15550000002',
    pushName: 'Erin Lane', timestamp: Date.now(), raw: { key: { id: 'HP1' } },
  }, ctx);
  await new Promise((r) => setTimeout(r, 20));
  const row = (data.history ?? []).find((r) => r.id === 'HP1');
  ok(row?.status === 'queued' && jobs.length === 1, `queued (${row?.status}, ${jobs.length} job(s))`);
  ok(!(data.wanted ?? []).some((w) => w.key === wantedKey({ imdbId: 'tt0241527' })), 'and not on the wanted list');
  ok(!(data['library-misses'] ?? []).length, 'nor on the not-in-library list');

  console.log('=== "#request a snapshot of forever 2025" is queued, the server\'s copy being 2022 ===');
  LIB = [ALL_EYES, SNAPSHOT];
  forgetProviderFilterSupport();
  data.history = [];
  jobs.length = 0;
  await moviePlugin.onMessage({
    id: 'SNAP1', key: { id: 'SNAP1', remoteJid: REQ, participant: 'mia@lid', fromMe: false },
    text: '#request a snapshot of forever 2025', chatJid: REQ, isGroup: true, fromMe: false,
    messageType: 'conversation', senderJid: 'mia@lid', senderNumber: '15550000001', senderNumberDisplay: '+15550000001',
    pushName: 'Mia ', timestamp: Date.now(), raw: { key: { id: 'SNAP1' } },
  }, ctx);
  await new Promise((r) => setTimeout(r, 20));
  const snap = (data.history ?? []).find((r) => r.id === 'SNAP1');
  ok(snap?.status === 'queued' && jobs.length === 1, `queued, not "not in the library" (${snap?.status}${snap?.detail ? `: ${snap.detail}` : ''})`);
  ok(snap?.imdbId === 'tt14074586', 'and its row carries the film\'s IMDb id');
  ok(!(data.wanted ?? []).some((w) => w.key === 'tt14074586' && !w.resolved), 'and it is not left open on the wanted list');

  console.log('=== "#request total recall", with only an R 1990 copy carrying the 2012 film\'s id: refused on its rating ===');
  const ask = async (id, text) => {
    await moviePlugin.onMessage({
      id, key: { id, remoteJid: REQ, participant: 'dov@lid', fromMe: false },
      text, chatJid: REQ, isGroup: true, fromMe: false,
      messageType: 'conversation', senderJid: 'dov@lid', senderNumber: '15550000005', senderNumberDisplay: '+15550000005',
      pushName: 'Dan Smith', timestamp: Date.now(), raw: { key: { id } },
    }, ctx);
    await new Promise((r) => setTimeout(r, 20));
    return (data.history ?? []).find((r) => r.id === id);
  };
  LIB = [ALL_EYES, RECALL_MISTAGGED];
  forgetProviderFilterSupport();
  jobs.length = 0;
  const bare = await ask('TR1', '#request total recall');
  ok(bare?.status === 'blocked-rating' && !jobs.length,
    `a bare "total recall" is refused on the file's own rating, R, and nothing is queued (${bare?.status}${bare?.detail ? `: ${bare.detail}` : ''})`);
  const typedReq = await ask('TR2', '#request total recall 2012');
  ok(typedReq?.status === 'not-in-library' && !jobs.length,
    `"total recall 2012" is not in the library: the 1990 copy is another year's film (${typedReq?.status})`);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
