/* A similar title from a year far from the one asked for is not in the library.
   Run: node test/near-title-other-year.test.mjs

   Incident, 2026-09-29: Mia asked "#request Barefoot 2014" at 11:40 and
   again at 15:05. OMDb resolved Barefoot (2014). The library has no Barefoot
   (2014), but it does hold Barefoot Gen (1983), and the title matcher forgives
   a subtitle the requester left off: "Barefoot" scored 0.985 against "Barefoot
   Gen", 0.885 after the year penalty, well over the 0.72 bar. findInLibrary
   took it, the file re-check compared titles only, and the 1983 anime was
   posted to the posts group at 11:45 and queued again at 15:05.

   The hourly check's b91afc8 turned that into a "wrong-film" refusal: ❓ and
   "We couldn't find Barefoot (2014) on the server. The closest file is
   Barefoot Gen (1983)... ask for that by name". The operator: "she clearly
   said 2014 in her message though so shouldve returned not in library and
   shown on my not in library list".

   It had also taken Barefoot off the wanted list and marked its earlier miss
   answered: both ran as soon as the library returned anything, before the
   re-check had said whether the file was the film requested.

   Review of the first fix found five more ways to the same wrong answer, all
   pinned here too: a franchise with a TV series starting with the same words
   ("Star Trek 2009", with Star Trek: The Next Generation in the TV library)
   was told "is a TV series" and kept off both lists; a file the re-check
   named as another film still got ❓ and a "closest file" reply and was
   recorded nowhere; a miss once marked answered stayed "turned up later" when
   missed again; Dune (2021) sent for "Dune 1984" took Dune (1984) off the
   wanted list; and a bare title, judged against the year OMDb resolved it to,
   lost the pointer to the film the server does hold.

   Asked about that last one, "Dune 1984" with only Dune (2021) on the
   server, the operator's answer was "Not in library": the typed year makes
   it a different film even though the title is identical. Identical titles
   had been left to the matcher, where a year is only a tiebreaker, so the one
   Dune on the server won whatever year was typed. A year the member typed
   now holds for them too (typedYearOf): a copy more than one year from it is
   not the film asked for.

   Pinned here, through the real movie plugin, the real findInLibrary and the
   real panel route (OMDb and Jellyfin are a stubbed fetch):
   - Barefoot 2014 with only Barefoot Gen 1983 in the library is not in the
     library: 📬, on the not-in-library list (naming Barefoot Gen as a
     different film) and on the wanted list, nothing queued, no "closest file"
     reply; twice is one row counted twice;
   - a real hit whose library title differs slightly but whose year matches
     (or is one off) is still sent, and so is a right film listed after a
     wrong one;
   - a TV series whose title only starts with the words typed, from a year
     far from the one typed, does not turn such a request into "is a TV
     series"; a series with the typed title still does;
   - a file the re-check names as another film is not in the library, the
     same answer and the same records as step 4 gives;
   - a wrong hit - refused at the re-check as another film, or on the file's
     rating - does not mark an earlier miss answered or clear the wanted list;
     a right one still does, and a film of the same title from another year
     answers its own entries, not the requested film's;
   - a miss once marked answered is open again when the film is missed again;
   - a bare title is judged against the film OMDb resolved it to (Barefoot,
     2014), so "barefoot" is not in the library either; since the member gave
     no year, the reply names the film the server does hold. That is where
     step 0 does not decide: since the "which one?" list left beta for every
     group (2026-10-11), the one film on the server starting with the word
     typed is sent by title and year (Barefoot Gen for "barefoot", Cars 3 for
     "cars"), beta001's rule as the operator approved it, and a library
     title OMDb does not know is looked up as typed instead;
   - Dune 1984 with only Dune 2021 on the server is not in the library: 📬,
     both lists, 'closest in the library: "Dune" (2021), a different year';
     Venom 2018 with all four Venoms held sends the 2018 one; a typed year one
     off from the library copy is still sent; a bare title is unchanged, and
     when it is sent a same-titled film from another year, that film's
     entries are the ones answered, not the requested film's;
   - a panel Re-run, the Test tab's dry run and a direct link answer the same
     way, and a Re-run does not go on to ask TV about a year-stamped film; a
     list offering Barefoot Gen does not take "barefoot 2014" as a pick of it.

   Review of that rule found four more, pinned at the end: a copy one year
   from OMDb's film but two from the year typed ("Sound of Metal 2020", held
   as 2018, OMDb 2019) was refused; a direct link for "1917" with OMDb down
   read the title as a typed year and refused 1917 (2019); a Re-run with a
   mistyped year ("Barefoot 2016") went on to ask TV; and "Fargo 1996" with
   only the Fargo series held was told "is a TV series", kept off both lists. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import moviePlugin, { isRequestedFilm, isOtherFilm } from '../src/plugins/movie-requests/index.js';
import directLinks from '../src/plugins/direct-links/index.js';
import { findInLibrary, closestNote } from '../src/plugins/movie-requests/library.js';
import { typedYearOf, whyOtherFilm } from '../src/util/fuzzy.js';
import { parsePick } from '../src/plugins/movie-requests/pick-list.js';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';
import { ConfigStore } from '../src/config/store.js';
import { createApiRouter } from '../src/web/api.js';
import { JobQueue } from '../src/core/queue.js';
import { hashPassword } from '../src/util/crypto.js';
import { wantedKey } from '../src/core/wanted.js';
import { missKey } from '../src/core/library-misses.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const REQ = 'movie-requests@g.us';
const POSTS = 'movie-posts@g.us';
const NOTIFY = 'movie-notify@g.us';
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/* ------------------------------ fixtures ------------------------------ */

let seqId = 0;
const film = (Name, ProductionYear, OfficialRating) => {
  seqId += 1;
  return {
    Id: String(seqId).padStart(32, '0'), Name, ProductionYear, OfficialRating, Type: 'Movie',
    MediaSources: [{ Path: `/nowhere/${Name}.mkv`, Size: 17, Container: 'mp4' }],
  };
};
const BAREFOOT_GEN = film('Barefoot Gen', 1983, 'PG-13');
const BAREFOOT = film('Barefoot', 2014, 'PG-13');
const DEAD_RECKONING = film('Mission: Impossible - Dead Reckoning Part One', 2023, 'PG-13');
const DEAD_RECKONING_EARLY = film('Mission: Impossible - Dead Reckoning Part One', 2022, 'PG-13');
const NIGHTWATCH_1994 = film('Nightwatch', 1994, 'R');
const THE_BEEKEEPER = film('The Beekeeper', 2024, 'R');
const INTO_DARKNESS = film('Star Trek Into Darkness', 2013, 'PG-13');
const BEYOND = film('Star Trek Beyond', 2016, 'PG-13');
const CARS_3 = film('Cars 3', 2017, 'G');
const DUNE_1984 = film('Dune', 1984, 'PG-13');
const DUNE_2021 = film('Dune', 2021, 'PG-13');
// Jellyfin's year a year either side of OMDb's, as a festival year against a
// release year often is.
const DUNE_2020 = film('Dune', 2020, 'PG-13');
const DUNE_2022 = film('Dune', 2022, 'PG-13');
const VENOMS = [film('Venom', 1981, 'R'), film('Venom', 2005, 'R'), film('Venom', 2011, 'PG'), film('Venom', 2018, 'PG-13')];
const [, , VENOM_2011, VENOM_2018] = VENOMS;
// Held under its festival year, a year before OMDb's; typed as 2020.
const SOUND_OF_METAL = film('Sound of Metal', 2018, 'R');
const NINETEEN17 = film('1917', 2019, 'R');

const series = (Name, ProductionYear) => {
  seqId += 1;
  return { Id: String(seqId).padStart(32, '0'), Name, ProductionYear, OfficialRating: 'TV-PG', Type: 'Series', RecursiveItemCount: 10 };
};
const TNG = series('Star Trek: The Next Generation', 1987);
const CONTESSA = series('Barefoot Contessa', 2002);
const OUTER_BANKS = series('Outer Banks', 2020);
const FARGO_SERIES = series('Fargo', 2014);

// What the library holds, films and TV series. Each scenario sets them.
let LIB = [];
let SERIES = [];

const omdb = (Title, Year, Rated, imdbID, extra = {}) => ({
  Title, Year: String(Year), Rated, imdbID, Type: 'movie', Released: '10 Oct 2014', DVD: 'N/A', Response: 'True', ...extra,
});
const OMDB = [
  omdb('Barefoot', 2014, 'PG-13', 'tt2355495'),
  omdb('Barefoot Gen', 1983, 'PG-13', 'tt0085218'),
  omdb('Mission: Impossible - Dead Reckoning', 2023, 'PG-13', 'tt9603212', { Released: '12 Jul 2023' }),
  omdb('Nightwatch', 1997, 'R', 'tt0119791', { Released: '17 Apr 1998' }),
  // The 1994 file's own metadata, as the re-check is staged to find it: under
  // a title that is not the one asked for, which is the shape of every
  // wrong-film refusal - the library's name for a file matched, and OMDb's
  // name for it did not.
  omdb('Nattevagten', 1994, 'R', 'tt0107653', { aka: 'Nightwatch', Released: '25 Feb 1994' }),
  // "beekeeper" resolves to the obscure 1991 film first (see verifyFileRating).
  omdb('Beekeeper', 1991, 'Not Rated', 'tt0101431', { Released: '01 Jan 1991' }),
  omdb('The Beekeeper', 2024, 'R', 'tt15314262', { Released: '12 Jan 2024' }),
  omdb('Star Trek', 2009, 'PG-13', 'tt0796366', { Released: '08 May 2009' }),
  omdb('Cars', 2006, 'G', 'tt0317219', { Released: '09 Jun 2006' }),
  omdb('Cars 3', 2017, 'G', 'tt3606752', { Released: '16 Jun 2017' }),
  // The obscure film "outer banks" resolves to, as it did on the real server.
  omdb('Outer Banks', 2012, 'Not Rated', 'tt2349340', { Released: '01 Jan 2012' }),
  // Listed first, so a bare "dune" is Dune (1984) to this OMDb.
  omdb('Dune', 1984, 'PG-13', 'tt0087182', { Released: '14 Dec 1984' }),
  omdb('Dune', 2021, 'PG-13', 'tt1160419', { Released: '22 Oct 2021' }),
  omdb('Venom', 1981, 'R', 'tt0083284', { Released: '29 Jan 1982' }),
  omdb('Venom', 2005, 'R', 'tt0402901', { Released: '16 Sep 2005' }),
  omdb('Venom', 2011, 'PG', 'tt1720163', { Released: '01 Jan 2011' }),
  omdb('Venom', 2018, 'PG-13', 'tt1270797', { Released: '05 Oct 2018' }),
  omdb('Sound of Metal', 2019, 'R', 'tt5363618', { Released: '04 Dec 2020' }),
  omdb('Fargo', 1996, 'R', 'tt0116282', { Released: '05 Apr 1996' }),
  omdb('1917', 2019, 'R', 'tt8579674', { Released: '10 Jan 2020' }),
];
// Set to make OMDb unreachable, as with no key, an outage or its daily limit.
let OMDB_DOWN = false;
// Set to have a title lookup ignore the year, as OMDb's `t=` does when it
// settles on the one film of that title for a mistyped year.
let OMDB_T_ANY_YEAR = false;

const omdbCalls = [];
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  if (u.hostname === 'www.omdbapi.com') {
    if (OMDB_DOWN) throw new Error('OMDb unreachable');
    const p = u.searchParams;
    omdbCalls.push(Object.fromEntries(p));
    const miss = json({ Response: 'False', Error: 'Movie not found!' });
    if (p.get('i')) return json(OMDB.find((m) => m.imdbID === p.get('i')) ?? { Response: 'False', Error: 'Incorrect IMDb ID.' });
    const y = p.get('y');
    const inYear = (m) => !y || m.Year === y;
    if (p.get('t')) {
      const q = norm(p.get('t')).replace(/^(the|a|an) /, '');
      const named = (m) => [m.Title, m.aka].filter(Boolean).some((t) => norm(t).replace(/^(the|a|an) /, '') === q);
      const hit = OMDB.find((m) => named(m) && (OMDB_T_ANY_YEAR || inYear(m)));
      return hit ? json(hit) : miss;
    }
    const q = norm(p.get('s'));
    const hits = OMDB.filter((m) => norm(m.Title).includes(q) && inYear(m));
    return hits.length
      ? json({ Response: 'True', Search: hits.map(({ Title, Year, imdbID, Type }) => ({ Title, Year, imdbID, Type })) })
      : miss;
  }
  if (u.hostname === 'jf.test') {
    if (u.pathname === '/Items') {
      const ids = u.searchParams.get('Ids');
      if (ids) {
        const item = [...LIB, ...SERIES].find((i) => i.Id === ids);
        return json({ Items: item ? [item] : [], TotalRecordCount: item ? 1 : 0 });
      }
      const term = u.searchParams.get('searchTerm');
      if (u.searchParams.get('IncludeItemTypes') === 'Series') {
        // With no term this is findSeries listing every series, its last resort.
        const items = SERIES.filter((i) => !term || norm(i.Name).includes(norm(term)))
          .slice(Number(u.searchParams.get('StartIndex') ?? 0));
        return json({ Items: items, TotalRecordCount: items.length });
      }
      if (!term) return json({ Items: [], TotalRecordCount: 0 });
      // Jellyfin's searchTerm: a contiguous run of the stored name.
      const items = LIB.filter((f) => norm(f.Name).includes(norm(term)));
      return json({ Items: items, TotalRecordCount: items.length });
    }
    return json({ Items: [], SearchHints: [], TotalRecordCount: 0 });
  }
  return new Response('{}', { status: 404 });
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'near-title-other-year-'));
const JELLYFIN = { baseUrl: 'http://jf.test', authMethod: 'apikey', apiKey: 'KEY', accessToken: 'TOK', userId: 'U1' };

// `askWhichOne` off is requireYearWhenAmbiguous off: no step 0, so a bare
// title goes to OMDb as it did before the "which one?" list, as it still does
// wherever step 0 cannot decide (its library search failed or timed out).
function config({ blockedRatings = ['R', 'NC-17', 'X', 'TV-MA'], askWhichOne = true } = {}) {
  const c = mergeDefaults({
    movieRequests: {
      requireYearWhenAmbiguous: askWhichOne,
      requestGroups: [REQ], postsGroup: POSTS, notify: { group: NOTIFY },
      requirePrefix: true, prefix: '#request', cooldownSecondsPerUser: 0,
      // On, so a "closest file" reply would be SEEN if one were sent: with it
      // off the bot sends no text at all and "no reply" would prove nothing.
      replyOnBlock: true,
      blockedRatings,
    },
  }, DEFAULT_CONFIG);
  c.omdb.apiKey = 'test-key';
  c.gemini = { ...c.gemini, enabled: false };
  c.library = mergeDefaults({ provider: 'jellyfin', jellyfin: JELLYFIN }, DEFAULT_CONFIG.library);
  Object.assign(c.media, { workDir: TMP });
  return c;
}

function store(data = {}) {
  return {
    data,
    get: (k, d = null) => (k in data ? data[k] : d),
    set: (k, v) => { data[k] = v; },
    push: (k, v) => { (data[k] ??= []).unshift(v); },
  };
}

function harness({ stored = {}, blockedRatings, askWhichOne } = {}) {
  const out = [];
  const jobs = [];
  const s = store(structuredClone(stored));
  const ctx = {
    config: config({ blockedRatings, askWhichOne }),
    store: s,
    bot: {
      isConnected: () => true,
      react: async (m, emoji) => { out.push({ op: 'react', emoji }); return true; },
      sendText: async (jid, body) => { out.push({ op: 'text', jid, body }); return { key: { id: 'B' } }; },
      editText: async () => true,
      deleteMessage: async () => {}, archiveChat: async () => {},
      isGroupAdmin: () => false,
      groupMemberInfo: () => ({ isMember: false, mentionJid: null, mentionText: null }),
      groups: () => [], groupCache: new Map(), sameCommunity: () => false,
      groupMentionToken: (jid) => `@${jid.split('@')[0]}`,
      async _bulkPace() {}, on() {}, off() {},
    },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    configStore: { update() {} },
    queue: { maxLength: 50, pending: [], add: (j) => { jobs.push(j); return `job-${jobs.length}`; }, snapshot: () => ({ pending: [], active: [] }) },
  };
  return { ctx, out, jobs, s };
}

moviePlugin._reactors = new Map();
let seq = 0;
async function request(h, text) {
  const id = `M${++seq}`;
  await moviePlugin.onMessage({
    id, key: { id, remoteJid: REQ, participant: 'mia@lid', fromMe: false }, text: `#request ${text}`, chatJid: REQ,
    isGroup: true, fromMe: false, messageType: 'conversation', senderJid: 'mia@lid', senderNumber: '15550000001',
    senderNumberDisplay: '+15550000001', pushName: 'Mia', timestamp: Date.now(), raw: { key: { id } },
  }, h.ctx);
  await new Promise((r) => setTimeout(r, 20));
  return (h.s.get('history', []) ?? []).find((r) => r.id === id);
}
const reactions = (h) => h.out.filter((o) => o.op === 'react').map((o) => o.emoji);
const texts = (h) => h.out.filter((o) => o.op === 'text').map((o) => o.body);
// What the requester sees: a quoted reply in the request group, not the
// notifications group's one-line summary.
const replies = (h) => h.out.filter((o) => o.op === 'text' && o.jid === REQ).map((o) => o.body);
const missOf = (h, title, year) => (h.s.get('library-misses', []) ?? []).find((m) => m.key === missKey({ kind: 'movie', title, year }));
// On the wanted list means open there. A film that arrives is marked resolved
// by the bot, and kept a while to be seen, rather than deleted (wanted.js,
// the operator's "mark as resolved", 2026-10-11): resolvedOf finds that.
const wantedOf = (h, movie) => (h.s.get('wanted', []) ?? []).find((w) => w.key === wantedKey(movie) && !w.resolved);
const resolvedOf = (h, movie) => (h.s.get('wanted', []) ?? []).find((w) => w.key === wantedKey(movie) && w.resolved);

/* ------------------------------ the incident ------------------------------ */

console.log('=== Barefoot 2014 with only Barefoot Gen 1983 in the library is not in the library ===');
{
  LIB = [BAREFOOT_GEN];
  const h = harness();
  const first = await request(h, 'Barefoot 2014');
  ok(first?.status === 'not-in-library', `answered not-in-library, not wrong-film (${first?.status})`);
  ok(reactions(h).at(-1) === '📬', `the last reaction is 📬 (${reactions(h).join(' ')})`);
  ok(!reactions(h).includes('❓'), 'no ❓');
  ok(h.jobs.length === 0, 'nothing queued');
  ok(!texts(h).some((t) => /closest file|Barefoot Gen/i.test(t)), `no "closest file" reply (${JSON.stringify(texts(h))})`);
  ok(first?.title === 'Barefoot' && first?.year === 2014, 'the History row names the film asked for');
  ok(/Barefoot Gen/.test(first?.detail ?? '') && /different film/.test(first?.detail ?? ''),
    `and its detail says what the library does hold: "${first?.detail}"`);

  const miss = missOf(h, 'Barefoot', 2014);
  ok(!!miss && miss.reason === 'not-in-library' && !miss.resolved, 'on the not-in-library list, open');
  ok(miss?.diagnostics?.[0] === 'closest in the library: "Barefoot Gen" (1983), a different film',
    `the near miss is the first thing it says: "${miss?.diagnostics?.[0]}"`);
  ok(miss?.request === 'Barefoot 2014', 'with what was typed');
  const wanted = wantedOf(h, { imdbId: 'tt2355495' });
  ok(!!wanted && wanted.title === 'Barefoot' && wanted.year === 2014 && wanted.reason === 'not-in-library',
    'and on the wanted list, as Barefoot (2014)');
  ok(!omdbCalls.some((c) => /barefoot gen/i.test(c.t ?? '')), 'the 1983 file was never even re-checked with OMDb');

  // 15:05, the second time she asked.
  const second = await request(h, 'Barefoot 2014');
  ok(second?.status === 'not-in-library' && h.jobs.length === 0, 'asked again: not in the library again, still nothing queued');
  ok(missOf(h, 'Barefoot', 2014)?.count === 2 && (h.s.get('library-misses', []) ?? []).length === 1,
    'one row on the list, asked twice');
  ok(wantedOf(h, { imdbId: 'tt2355495' })?.count === 2, 'one wanted entry, asked for twice');
}

console.log('=== a file the re-check names as another film is not in the library either ===');
{
  // The rest of the same verdict: the library's "Nightwatch" is the 1994 film,
  // which OMDb calls Nattevagten. This path used to answer ❓ with "We couldn't
  // find Nightwatch (1997) on the server. The closest file is..." and write
  // nothing on either list. Asked for with no year, the library's copy is
  // taken and the re-check (4b) is what finds out which film it is.
  LIB = [NIGHTWATCH_1994];
  const h = harness({ blockedRatings: ['NC-17', 'X'] });
  const row = await request(h, 'nightwatch');
  ok(row?.status === 'not-in-library', `answered not-in-library, not wrong-film (${row?.status})`);
  ok(reactions(h).at(-1) === '📬' && !reactions(h).includes('❓'), `📬, and no ❓ (${reactions(h).join(' ')})`);
  ok(h.jobs.length === 0, 'nothing queued');
  ok(replies(h).length === 1 && !/closest file/i.test(replies(h)[0])
    && /we do have "Nattevagten" \(1994\)/.test(replies(h)[0]),
  `no "closest file" reply; with no year typed, the one reply names the file (${JSON.stringify(replies(h))})`);
  const miss = missOf(h, 'Nightwatch', 1997);
  ok(!!miss && !miss.resolved && miss.reason === 'not-in-library', 'on the not-in-library list, open');
  ok(miss?.diagnostics?.[0] === 'closest in the library: "Nattevagten" (1994), a different film',
    `naming the file first: "${miss?.diagnostics?.[0]}"`);
  const wanted = wantedOf(h, { imdbId: 'tt0119791' });
  ok(!!wanted && wanted.title === 'Nightwatch' && wanted.year === 1997 && wanted.reason === 'not-in-library',
    'and on the wanted list, as Nightwatch (1997)');
  // The wanted list's recheck runs no file check: the copy refused here is
  // remembered, so it never resolves the entry with it (review, 2026-10-11).
  ok(wanted?.rejected?.length === 1 && wanted.rejected[0].id === NIGHTWATCH_1994.Id && wanted.rejected[0].why === 'another-film',
    `the library's copy is remembered on the entry as another film (${JSON.stringify(wanted?.rejected)})`);
  ok(/Nattevagten/.test(row?.detail ?? ''), `the History row says what the file is: "${row?.detail}"`);

  // With the year typed, the 1994 copy is three years from it: not the film
  // asked for, whatever it is called, so it never reaches the re-check.
  omdbCalls.length = 0;
  const t = harness({ blockedRatings: ['NC-17', 'X'] });
  const trow = await request(t, 'Nightwatch 1997');
  ok(trow?.status === 'not-in-library' && t.jobs.length === 0, `"Nightwatch 1997" is not in the library either (${trow?.status})`);
  ok(reactions(t).at(-1) === '📬' && !replies(t).length, `📬 alone: a year was typed (${JSON.stringify(replies(t))})`);
  ok(missOf(t, 'Nightwatch', 1997)?.diagnostics?.[0] === 'closest in the library: "Nightwatch" (1994), a different year',
    `naming the copy the server holds, as another year: "${missOf(t, 'Nightwatch', 1997)?.diagnostics?.[0]}"`);
  ok(!omdbCalls.some((c) => c.y === '1994'), 'and the 1994 file was never re-checked with OMDb');
}

console.log('=== a series that only starts with the words typed does not make a year-stamped film a series ===');
{
  // "Star Trek 2009": findInLibrary rightly refuses Into Darkness and Beyond.
  // The series check then searched "Star Trek" with no year and found The
  // Next Generation (1987) at 0.95, and the member was told it is a TV series.
  LIB = [INTO_DARKNESS, BEYOND];
  SERIES = [TNG];
  const h = harness();
  const row = await request(h, 'Star Trek 2009');
  ok(row?.status === 'not-in-library', `"Star Trek 2009" is not in the library, not is-a-series (${row?.status})`);
  ok(reactions(h).at(-1) === '📬', `📬 (${reactions(h).join(' ')})`);
  ok(!texts(h).some((t) => /TV series/.test(t)), `no "is a TV series" reply (${JSON.stringify(texts(h))})`);
  ok(h.jobs.length === 0, 'nothing queued');
  const miss = missOf(h, 'Star Trek', 2009);
  ok(!!miss && !miss.resolved, 'open on the not-in-library list');
  ok(/closest in the library: "Star Trek (Into Darkness|Beyond)"/.test(miss?.diagnostics?.[0] ?? ''),
    `naming the film the library holds: "${miss?.diagnostics?.[0]}"`);
  ok((miss?.diagnostics ?? []).some((d) => d === 'series "Star Trek: The Next Generation" (1987) is not the 2009 film asked for'),
    'and saying why the series was not the answer');
  ok(wantedOf(h, { imdbId: 'tt0796366' })?.reason === 'not-in-library', 'and on the wanted list as Star Trek (2009)');

  // Mia's own request, had the TV library held any series starting with
  // "Barefoot".
  LIB = [BAREFOOT_GEN];
  SERIES = [CONTESSA];
  const b = harness();
  const brow = await request(b, 'Barefoot 2014');
  ok(brow?.status === 'not-in-library' && reactions(b).at(-1) === '📬',
    `"Barefoot 2014" with Barefoot Contessa (2002) in TV is still not in the library (${brow?.status})`);
  ok(!!missOf(b, 'Barefoot', 2014) && !!wantedOf(b, { imdbId: 'tt2355495' }), 'and on both lists');

  // What the check exists for is untouched: a series with the title typed.
  LIB = [];
  SERIES = [OUTER_BANKS];
  const o = harness();
  const orow = await request(o, 'outer banks');
  ok(orow?.status === 'is-a-series', `"outer banks" is still pointed at the TV group (${orow?.status})`);
  ok(replies(o).some((t) => /Outer Banks\* is a TV series/.test(t)), 'with the series named');
  const o2 = harness();
  const orow2 = await request(o2, 'Outer Banks 2020');
  ok(orow2?.status === 'is-a-series', `and so is "Outer Banks 2020", the series' own title and year (${orow2?.status})`);
  ok(!missOf(o, 'Outer Banks', 2012) && !missOf(o2, 'Outer Banks', 2012), 'neither is on the not-in-library list');
  SERIES = [];
}

console.log('=== a bare title the server holds one film starting with: that film, by title and year (step 0) ===');
{
  // Step 0 asks the library first. The one film on the server starting with
  // the word typed is gone ahead with, by its title and year: beta001's rule,
  // the operator's "On for everyone", which reached every group when the
  // list left beta (2026-10-11). On 2026-09-22 "harry potter" otherwise
  // became whatever OMDb ranked first. The operator's "Not in library" for
  // Mia was for "Barefoot 2014", with the year typed ("she clearly said
  // 2014 in her message"); a bare word names no year, and step 0 never runs
  // for a request with one (pinned at the top of this file).
  LIB = [BAREFOOT_GEN];
  const h = harness();
  const row = await request(h, 'barefoot');
  ok(row?.status === 'queued' && h.jobs.length === 1 && row?.title === 'Barefoot Gen' && row?.year === 1983,
    `"barefoot" with only Barefoot Gen held: Barefoot Gen (1983) is sent (${row?.status} ${row?.title} ${row?.year})`);
  ok(row?.request === 'Barefoot Gen 1983' && row?.typed === 'barefoot', 'asked for by title and year, with what was typed kept beside it');
  ok(!missOf(h, 'Barefoot', 2014) && !wantedOf(h, { imdbId: 'tt2355495' }), 'and Barefoot (2014), which nobody named, is on neither list');

  LIB = [CARS_3];
  const c = harness();
  const crow = await request(c, 'cars');
  ok(crow?.status === 'queued' && c.jobs.length === 1 && crow?.title === 'Cars 3', `"cars" with only Cars 3 held: Cars 3 is sent (${crow?.status} ${crow?.title})`);
}

console.log('=== where step 0 does not decide, a bare title is judged against the film OMDb resolved it to, and told what the server holds ===');
{
  // No step 0 (the question switched off here; on a live box, a library
  // search that failed or timed out): OMDb resolves "barefoot" to Barefoot
  // (2014), and that is the film the library is asked for. Barefoot Gen is
  // another film as surely as it was for "Barefoot 2014"; but the member
  // never said which film they meant, so the answer names the one the
  // server has.
  LIB = [BAREFOOT_GEN];
  const h = harness({ askWhichOne: false });
  const row = await request(h, 'barefoot');
  ok(row?.status === 'not-in-library' && row?.title === 'Barefoot' && row?.year === 2014,
    `"barefoot" is Barefoot (2014), not in the library (${row?.status} ${row?.title} ${row?.year})`);
  ok(reactions(h).at(-1) === '📬' && !reactions(h).includes('❓'), `📬 (${reactions(h).join(' ')})`);
  ok(h.jobs.length === 0, 'nothing queued');
  ok(replies(h).length === 1
    && replies(h)[0] === '📬 *Barefoot* (2014) isn\'t on the server — we do have "Barefoot Gen" (1983); ask for it by name if that\'s the one.',
    `the reply names the film the server does hold: ${JSON.stringify(replies(h))}`);
  const miss = missOf(h, 'Barefoot', 2014);
  ok(!!miss && !miss.resolved && miss.request === 'barefoot', 'on the not-in-library list as Barefoot (2014), as typed');
  ok(miss?.diagnostics?.[0] === 'closest in the library: "Barefoot Gen" (1983), a different film', 'naming Barefoot Gen');
  ok(wantedOf(h, { imdbId: 'tt2355495' })?.reason === 'not-in-library', 'and on the wanted list');

  // Found in review: "cars" with only Cars 3 on the server. Before b91afc8 it
  // was sent Cars 3; it must not now be a bare 📬 with nothing to go on.
  LIB = [CARS_3];
  const c = harness({ askWhichOne: false });
  const crow = await request(c, 'cars');
  ok(crow?.status === 'not-in-library' && c.jobs.length === 0, `"cars" is Cars (2006), not in the library (${crow?.status})`);
  ok(replies(c).length === 1 && /we do have "Cars 3" \(2017\)/.test(replies(c)[0]),
    `the reply names Cars 3: ${JSON.stringify(replies(c))}`);
  ok(!!missOf(c, 'Cars', 2006) && wantedOf(c, { imdbId: 'tt0317219' })?.title === 'Cars', 'and it is on both lists as Cars (2006)');
}

console.log('=== findInLibrary itself ===');
{
  LIB = [BAREFOOT_GEN];
  let other = null;
  const none = await findInLibrary('Barefoot', 2014, config().library, { alsoTry: ['Barefoot 2014'], onOtherFilm: (o) => { other = o; } });
  ok(none === null, 'no hit for Barefoot (2014)');
  ok(other?.title === 'Barefoot Gen' && other?.year === 1983, `and it says which film it refused: ${JSON.stringify(other)}`);

  // The right film listed AFTER the wrong one is still the one chosen.
  LIB = [BAREFOOT_GEN, BAREFOOT];
  other = null;
  const hit = await findInLibrary('Barefoot', 2014, config().library, { onOtherFilm: (o) => { other = o; } });
  ok(hit?.title === 'Barefoot' && hit?.year === 2014, `the 2014 film is found when both are there (${hit?.title} ${hit?.year})`);
  ok(!(hit?.alternates ?? []).some((a) => a.title === 'Barefoot Gen'), 'and Barefoot Gen is never a spare copy of it');
  ok(other === null, 'nothing is reported refused when the film was found');

  // findInLibrary with no year at all - a direct link whose metadata lookup
  // failed - has nothing to disagree with. A request never reaches it that
  // way: the year it is given is OMDb's, typed or not (see "a bare title").
  LIB = [BAREFOOT_GEN];
  const noYear = await findInLibrary('Barefoot', null, config().library);
  ok(noYear?.title === 'Barefoot Gen', 'given no year at all, the matcher decides as it always did');
  const itself = await findInLibrary('Barefoot Gen', 1983, config().library);
  ok(itself?.title === 'Barefoot Gen', 'Barefoot Gen asked for by name is found');

  // The identical title, with a year typed and without one.
  LIB = [DUNE_2021];
  other = null;
  const typed = await findInLibrary('Dune', 1984, config().library, {
    alsoTry: ['Dune 1984'], typedYear: 1984, onOtherFilm: (o) => { other = o; },
  });
  ok(typed === null, 'no hit for Dune (1984) typed as "Dune 1984", with only Dune (2021) held');
  ok(other?.title === 'Dune' && other?.year === 2021 && other?.reason === 'year',
    `and it says it refused Dune (2021) as another year: ${JSON.stringify(other)}`);
  const bare = await findInLibrary('Dune', 1984, config().library);
  ok(bare?.year === 2021, 'given only OMDb\'s year for a bare title, the one Dune held is the hit, as before');
}

/* ------------------------- what must keep working ------------------------- */

console.log('=== a real hit whose library title differs slightly but whose year matches is still sent ===');
{
  LIB = [DEAD_RECKONING];
  const h = harness();
  const row = await request(h, 'Mission: Impossible - Dead Reckoning 2023');
  ok(row?.status === 'queued' && h.jobs.length === 1, `"...Dead Reckoning" (2023) finds "...Dead Reckoning Part One" (2023) (${row?.status})`);

  // Jellyfin a year off OMDb, as a festival year against a release year is.
  LIB = [DEAD_RECKONING_EARLY];
  const off = harness();
  const row2 = await request(off, 'Mission: Impossible - Dead Reckoning 2023');
  ok(row2?.status === 'queued' && off.jobs.length === 1, `and so does the library's 2022 copy, one year off (${row2?.status})`);

  // The requester gave no year and OMDb's year matches the library's copy.
  LIB = [DEAD_RECKONING];
  const bare = harness();
  const row3 = await request(bare, 'Mission: Impossible - Dead Reckoning');
  ok(row3?.status === 'queued' && bare.jobs.length === 1, `no year typed: unchanged, queued (${row3?.status})`);
  // Step 0 goes ahead with "...Part One", the one film starting with the
  // words, and asks OMDb for it by the library's title, which this OMDb
  // does not know. The words typed are then looked up instead
  // (lookupHeldFilm): without that, restoring beta001's rule to every group
  // ended this request ❓ for a film the server holds (review, 2026-10-11).
  ok(row3?.request === 'Mission: Impossible - Dead Reckoning' && !('typed' in row3),
    `   looked up as typed once OMDb did not know the library's title (request "${row3?.request}")`);

  // The film itself, next to the one it must not be confused with.
  LIB = [BAREFOOT_GEN, BAREFOOT];
  const both = harness();
  const row4 = await request(both, 'Barefoot 2014');
  ok(row4?.status === 'queued' && both.jobs.length === 1 && row4?.title === 'Barefoot' && row4?.year === 2014,
    `Barefoot 2014 is sent when the server has it, Barefoot Gen beside it (${row4?.status})`);
}

/* ------------------- the wanted list and the miss list ------------------- */

console.log('=== a wrong hit does not mark an earlier miss answered or clear the wanted list ===');
{
  const earlier = (title, year, imdbId) => ({
    'library-misses': [{
      key: missKey({ kind: 'movie', title, year }), kind: 'movie', reason: 'not-in-library', detail: null,
      request: `${title} ${year}`, title, year, season: null, episode: null, groupJid: REQ, searched: [title],
      diagnostics: [], count: 1, firstAt: 1, lastAt: 1, requesters: ['Mia'], resolved: false,
    }],
    wanted: [{
      key: wantedKey({ imdbId, title, year }), title, year, imdbId, rated: null, reason: 'not-in-library',
      count: 1, firstAt: 1, lastAt: 1, requesters: ['Mia'],
    }],
  });

  // Refused at the re-check as another film: Nightwatch (1997) asked for, the
  // library's "Nightwatch" is the 1994 film, and OMDb names that file
  // something else. R is allowed here so the request reaches the re-check,
  // and no year is typed, which would have refused the file before it.
  LIB = [NIGHTWATCH_1994];
  const h = harness({ stored: earlier('Nightwatch', 1997, 'tt0119791'), blockedRatings: ['NC-17', 'X'] });
  const row = await request(h, 'nightwatch');
  ok(row?.status === 'not-in-library' && h.jobs.length === 0, `the 1994 file is refused as another film (${row?.status})`);
  ok(missOf(h, 'Nightwatch', 1997)?.resolved === false && missOf(h, 'Nightwatch', 1997)?.count === 2,
    'the earlier miss is still open, and counted again');
  ok(wantedOf(h, { imdbId: 'tt0119791' })?.count === 2, 'and Nightwatch (1997) is still on the wanted list, asked for again');

  // Refused at the re-check on the file's rating: "beekeeper" is the 1991
  // film to OMDb, the library's is The Beekeeper (2024, R).
  LIB = [THE_BEEKEEPER];
  const b = harness({ stored: earlier('Beekeeper', 1991, 'tt0101431') });
  const brow = await request(b, 'beekeeper');
  ok(brow?.status === 'blocked-rating' && b.jobs.length === 0, `The Beekeeper (2024, R) is refused on its rating (${brow?.status})`);
  ok(missOf(b, 'Beekeeper', 1991)?.resolved === false, 'the earlier miss for Beekeeper (1991) is still open');
  ok(!!wantedOf(b, { imdbId: 'tt0101431' }), 'and it is still on the wanted list');

  // The right film arriving still answers both, as it always did.
  LIB = [BAREFOOT_GEN, BAREFOOT];
  const r = harness({ stored: earlier('Barefoot', 2014, 'tt2355495') });
  const rrow = await request(r, 'Barefoot 2014');
  ok(rrow?.status === 'queued', `Barefoot (2014), once on the server, is queued (${rrow?.status})`);
  ok(missOf(r, 'Barefoot', 2014)?.resolved === true, 'its earlier miss is marked answered');
  ok(!wantedOf(r, { imdbId: 'tt2355495' }), 'and it is off the wanted list');
  const done = resolvedOf(r, { imdbId: 'tt2355495' });
  ok(done?.resolved?.by === 'the bot (found on the server as "Barefoot" when it was asked for again)' && done.resolved.auto === true,
    `marked resolved by the bot, saying how, so the admins see it (${done?.resolved?.by})`);
}

console.log('=== a miss marked answered is open again when the film is missed again ===');
{
  // A row the old code resolved - it marked a miss answered whenever the
  // library returned anything, Barefoot Gen included - stayed "turned up
  // later", out of the daily mail and the "still missing" view, however many
  // times the film was asked for after.
  LIB = [BAREFOOT_GEN];
  const h = harness({ stored: { 'library-misses': [{
    key: missKey({ kind: 'movie', title: 'Barefoot', year: 2014 }), kind: 'movie', reason: 'not-in-library', detail: null,
    request: 'Barefoot 2014', title: 'Barefoot', year: 2014, season: null, episode: null, groupJid: REQ, searched: ['Barefoot'],
    diagnostics: [], count: 1, firstAt: 1, lastAt: 1, requesters: ['Mia'], resolved: true, resolvedAt: 5,
  }] } });
  const row = await request(h, 'Barefoot 2014');
  const miss = missOf(h, 'Barefoot', 2014);
  ok(row?.status === 'not-in-library', `not in the library (${row?.status})`);
  ok(miss?.resolved === false && miss?.count === 2, 'the row is open again, asked twice');
  ok(miss?.previouslyResolvedAt === 5, 'and remembers when it was marked answered');
}

/* ------------------ a typed year, under the identical title ------------------ */

// Earlier requests for both Dunes, as the lists hold them before each case.
const duneLists = () => ({
  'library-misses': [{
    key: missKey({ kind: 'movie', title: 'Dune', year: 1984 }), kind: 'movie', reason: 'not-in-library', detail: null,
    request: 'Dune 1984', title: 'Dune', year: 1984, season: null, episode: null, groupJid: REQ, searched: ['Dune'],
    diagnostics: [], count: 1, firstAt: 1, lastAt: 1, requesters: ['Mia'], resolved: false,
  }],
  wanted: [
    { key: 'tt0087182', title: 'Dune', year: 1984, imdbId: 'tt0087182', rated: null, reason: 'not-in-library',
      count: 1, firstAt: 1, lastAt: 1, requesters: ['Mia'] },
    { key: 'tt1160419', title: 'Dune', year: 2021, imdbId: 'tt1160419', rated: null, reason: 'not-in-library',
      count: 1, firstAt: 1, lastAt: 1, requesters: ['Avi'] },
  ],
});

console.log('=== Dune 1984 with only Dune 2021 on the server is not in the library ===');
{
  // The operator, 2026-09-29: "Not in library" - the typed year makes it a
  // different film even though the title is identical. It used to be sent
  // Dune (2021), the one Dune the server holds.
  LIB = [DUNE_2021];
  omdbCalls.length = 0;
  const h = harness({ stored: duneLists() });
  const row = await request(h, 'Dune 1984');
  ok(row?.status === 'not-in-library' && row?.title === 'Dune' && row?.year === 1984,
    `not in the library, as Dune (1984) (${row?.status} ${row?.title} ${row?.year})`);
  ok(h.jobs.length === 0, 'nothing queued: Dune (2021) is not sent');
  ok(reactions(h).at(-1) === '📬' && !reactions(h).includes('❓'), `📬 (${reactions(h).join(' ')})`);
  ok(!replies(h).length, `no reply: the year typed already said which Dune (${JSON.stringify(replies(h))})`);
  ok(!omdbCalls.some((c) => c.y === '2021'), 'the 2021 file was never re-checked with OMDb');
  ok(row?.detail === 'not in library — closest in the library: "Dune" (2021), a different year',
    `the History row names the copy the server has: "${row?.detail}"`);

  const miss = missOf(h, 'Dune', 1984);
  ok(miss?.resolved === false && miss?.count === 2 && (h.s.get('library-misses', []) ?? []).length === 1,
    'its miss is still open, counted again, one row');
  ok(miss?.diagnostics?.[0] === 'closest in the library: "Dune" (2021), a different year',
    `and says what the server holds: "${miss?.diagnostics?.[0]}"`);
  ok(miss?.request === 'Dune 1984', 'with what was typed');
  ok(wantedOf(h, { imdbId: 'tt0087182' })?.count === 2, 'Dune (1984) is still on the wanted list, asked for again');
  ok(wantedOf(h, { imdbId: 'tt1160419' })?.count === 1, 'and Dune (2021)\'s own entry is left as it was: nothing arrived');

  // Asked for with no earlier record, it goes on both lists as any film the
  // server does not have.
  const fresh = harness();
  await request(fresh, 'Dune 1984');
  ok(!!missOf(fresh, 'Dune', 1984) && wantedOf(fresh, { imdbId: 'tt0087182' })?.reason === 'not-in-library',
    'a first request is on the not-in-library list and the wanted list');

  // Once the server holds it, the 1984 film is the one sent.
  LIB = [DUNE_2021, DUNE_1984];
  const both = harness({ stored: duneLists() });
  const brow = await request(both, 'Dune 1984');
  ok(brow?.status === 'queued' && both.jobs.length === 1 && both.jobs[0].label === 'Dune (1984)',
    `with both held, "Dune 1984" queues Dune (1984) (${brow?.status} ${both.jobs[0]?.label})`);
  ok(missOf(both, 'Dune', 1984)?.resolved === true && !wantedOf(both, { imdbId: 'tt0087182' }),
    'and answers its own miss and wanted entry');
  ok(wantedOf(both, { imdbId: 'tt1160419' })?.count === 1, 'not Dune (2021)\'s');
}

console.log('=== Venom 2018 with all four Venoms held sends the 2018 one ===');
{
  LIB = [...VENOMS];
  const h = harness();
  const row = await request(h, 'Venom 2018');
  ok(row?.status === 'queued' && h.jobs.length === 1 && h.jobs[0].label === 'Venom (2018)',
    `"Venom 2018" queues Venom (2018) (${row?.status} ${h.jobs[0]?.label})`);
  const hit = await findInLibrary('Venom', 2018, config().library, { typedYear: 2018 });
  ok(hit?.id === VENOM_2018.Id && !(hit?.alternates ?? []).length, 'the 2018 copy, and no other Venom as a spare copy of it');
  ok((hit?.sameTitled ?? []).map((c) => c.year).join() === '1981,2005,2011,2018',
    'the four versions are still what the library reports holding');

  const y2011 = harness();
  const row11 = await request(y2011, 'Venom 2011');
  ok(row11?.status === 'queued' && y2011.jobs[0]?.label === 'Venom (2011)', `"Venom 2011" queues Venom (2011) (${row11?.status})`);

  // A year whose film the rating gate refuses stays refused: the R-rated 2005
  // film is not swapped for the PG-13 Venom beside it.
  const y2005 = harness();
  const row05 = await request(y2005, 'Venom 2005');
  ok(row05?.status === 'blocked-rating' && y2005.jobs.length === 0, `"Venom 2005" is refused on its own rating (${row05?.status})`);

  // A year the server does not hold is not in the library, with three other
  // Venoms right there.
  LIB = VENOMS.filter((f) => f !== VENOM_2011);
  const gone = harness();
  const growl = await request(gone, 'Venom 2011');
  ok(growl?.status === 'not-in-library' && gone.jobs.length === 0,
    `"Venom 2011" with 2011 gone is not in the library, and no other Venom is sent (${growl?.status})`);
  ok(/^closest in the library: "Venom" \((1981|2005|2018)\), a different year$/.test(missOf(gone, 'Venom', 2011)?.diagnostics?.[0] ?? ''),
    `naming a Venom the server does hold: "${missOf(gone, 'Venom', 2011)?.diagnostics?.[0]}"`);
}

console.log('=== a typed year one off from the library copy is still sent ===');
{
  // Jellyfin and OMDb disagree by a year often enough - a festival year
  // against a release year - that one apart has always been the same film.
  for (const copy of [DUNE_2020, DUNE_2022]) {
    LIB = [copy];
    const h = harness({ stored: duneLists() });
    const row = await request(h, 'Dune 2021');
    ok(row?.status === 'queued' && h.jobs.length === 1,
      `"Dune 2021" with the library's copy as ${copy.ProductionYear} is sent (${row?.status})`);
    ok(!wantedOf(h, { imdbId: 'tt1160419' }) && wantedOf(h, { imdbId: 'tt0087182' })?.count === 1,
      'and it is Dune (2021) that is off the wanted list, not Dune (1984)');
  }
  // As for a similar title, the other rule (see "a real hit whose library
  // title differs slightly" above), and for a copy of the year typed.
  LIB = [DUNE_2021];
  const exact = harness();
  ok((await request(exact, 'Dune 2021'))?.status === 'queued' && exact.jobs[0]?.label === 'Dune (2021)', '"Dune 2021" is sent Dune (2021)');
}

console.log('=== a bare title is unchanged ===');
{
  // No year typed: OMDb resolves "dune" to Dune (1984), and that year is its
  // guess, not the member's. With one Dune on the server, that one is sent,
  // as it always was.
  LIB = [DUNE_2021];
  const h = harness({ stored: duneLists() });
  const row = await request(h, 'dune');
  ok(row?.status === 'queued' && h.jobs.length === 1 && row?.year === 2021,
    `"dune" is still sent Dune (2021) (${row?.status} ${row?.year})`);
  // A same-titled film from another year answers its own entries, not the
  // requested film's: the server still has no Dune (1984).
  ok(!!wantedOf(h, { imdbId: 'tt0087182' }), 'Dune (1984) is still on the wanted list');
  ok(missOf(h, 'Dune', 1984)?.resolved === false, 'and its miss is still open');
  ok(!wantedOf(h, { imdbId: 'tt1160419' }), 'Dune (2021), which is on the server, is off the wanted list');

  // With both on the server, the member is asked which one. Since 2026-10-11
  // that is the "which one?" list in every group, not "which year?" (the
  // list left beta; test/pick-list.test.mjs).
  LIB = [DUNE_1984, DUNE_2021];
  const both = harness();
  const brow = await request(both, 'dune');
  ok(brow?.status === 'pick-list' && brow.pickList?.offered?.join() === '1984,2021' && both.jobs.length === 0,
    `"dune" with both held is asked which one, with the list (${brow?.status})`);

  const requested = { title: 'Dune', year: 1984, imdbId: 'tt0087182' };
  ok(isRequestedFilm(requested, requested, { title: 'Dune', year: 1984 }) === true, 'a file of the requested year is the requested film');
  ok(isRequestedFilm(requested, requested, { title: 'Dune', year: 2021 }) === false,
    'a file 4b could not name, from a year far off, is not');
  ok(isRequestedFilm(requested, { title: 'Dune', year: 2021, imdbId: 'tt1160419' }) === false, 'nor is another film of that title');
  ok(isRequestedFilm(requested, { title: 'Dune', year: 1985, imdbId: 'tt0087182' }) === true, 'the same IMDb id is');
  ok(isRequestedFilm({ title: 'Mission: Impossible - Dead Reckoning', year: 2023 },
    { title: 'Mission: Impossible - Dead Reckoning Part One', year: 2022 }) === true,
  'and so is a film the library names a little differently, a year off');
}

console.log('=== the typed year and the rule, as functions ===');
{
  ok(typedYearOf('Dune 1984', { year: 1984 }) === 1984, '"Dune 1984" typed 1984');
  ok(typedYearOf('dune', { year: 2021 }) === null, 'a bare "dune" typed no year, whatever OMDb resolved');
  ok(typedYearOf('Dune 2021', { year: 2020 }) === 2021, 'a year one off OMDb\'s is still the one typed');
  ok(typedYearOf('2001 a space odyssey', { year: 1968 }) === null
    && typedYearOf('Blade Runner 2049', { year: 2017 }) === null && typedYearOf('1917', { year: 2019 }) === null,
  'a number in the title is not a typed year: it is not the year of the film found');
  ok(typedYearOf('guardians of the galaxy 2010', { year: 2014 }) === null,
    'nor is a year OMDb knows no film of that title in, where it resolved another year');

  ok(whyOtherFilm({ title: 'Dune', year: 1984 }, { title: 'Dune', year: 2021 }, { typedYear: 1984 }) === 'year',
    'Dune (2021) for "Dune 1984" is another year');
  ok(whyOtherFilm({ title: 'Dune', year: 1984 }, { title: 'Dune', year: 2021 }) === null,
    'and with no year typed, the identical title is left to the matcher');
  ok(whyOtherFilm({ title: 'Barefoot', year: 2014 }, { title: 'Barefoot Gen', year: 1983 }, { typedYear: 2014 }) === 'film',
    'Barefoot Gen for "Barefoot 2014" is another film');
  ok(whyOtherFilm({ title: 'Dune', year: 2021 }, { title: 'Dune', year: 2022 }, { typedYear: 2021 }) === null
    && whyOtherFilm({ title: 'Dune', year: 2021 }, { title: 'Dune', year: null }, { typedYear: 2021 }) === null,
  'one year off, or no year to disagree with, is not refused');
  ok(closestNote({ title: 'Dune', year: 2021, reason: 'year' }) === 'closest in the library: "Dune" (2021), a different year'
    && closestNote({ title: 'Barefoot Gen', year: 1983 }) === 'closest in the library: "Barefoot Gen" (1983), a different film',
  'the note says which');

  // The file re-check (4b) judges the file's own metadata by the same rule.
  ok(isOtherFilm({ title: 'Dune', year: 1984 }, { title: 'Dune', year: 2021 }, { typedYear: 1984 }) === true,
    'the re-check refuses a file OMDb names as Dune (2021) for "Dune 1984"');
  ok(isOtherFilm({ title: 'Dune', year: 1984 }, { title: 'Dune', year: 2021 }) === false,
    'and, for a bare title, takes it as before');
}

/* ------------------------ the other ways in ------------------------ */

console.log('=== Re-run from the panel ===');
{
  LIB = [BAREFOOT_GEN];
  const h = harness();
  let err = null;
  try { await moviePlugin.requeue('Barefoot 2014', h.ctx); } catch (e) { err = e; }
  ok(err?.code === 'NOT_IN_LIBRARY', `refused as not in the library (${err?.code}: ${err?.message})`);
  ok(err?.message === 'Barefoot (2014) is not in the library — closest in the library: "Barefoot Gen" (1983), a different film',
    'naming the film it is not');
  ok(h.jobs.length === 0 && !(h.s.get('history', []) ?? []).length, 'nothing queued, no History row');

  LIB = [BAREFOOT_GEN, BAREFOOT];
  const ok2 = harness();
  const r = await moviePlugin.requeue('Barefoot 2014', ok2.ctx);
  ok(r?.title === 'Barefoot' && r?.year === 2014 && ok2.jobs.length === 1, 'and re-run once it is there, it is queued');

  // The identical title from another year, re-run by title with the year.
  LIB = [DUNE_2021];
  const d = harness();
  let derr = null;
  try { await moviePlugin.requeue('Dune 1984', d.ctx); } catch (e) { derr = e; }
  ok(derr?.code === 'NOT_IN_LIBRARY' && derr?.typedYear === 1984,
    `"Dune 1984" re-run with only Dune (2021) held is not in the library (${derr?.code}: ${derr?.message})`);
  ok(derr?.message === 'Dune (1984) is not in the library — closest in the library: "Dune" (2021), a different year',
    'naming the copy the server holds as another year');
  ok(d.jobs.length === 0 && !(d.s.get('history', []) ?? []).length, 'nothing queued, no History row');

  const bare = harness();
  const br = await moviePlugin.requeue('dune', bare.ctx);
  ok(br?.year === 2021 && bare.jobs.length === 1, `a bare "dune" re-run still queues the Dune held (${br?.title} ${br?.year})`);

  LIB = [...VENOMS];
  const v = harness();
  const vr = await moviePlugin.requeue('Venom 2018', v.ctx);
  ok(vr?.year === 2018 && v.jobs[0]?.label === 'Venom (2018)', `"Venom 2018" re-run with four Venoms held queues the 2018 one (${vr?.year})`);
}

/** The real panel API, as the Test tab and the Re-run box reach it. */
async function panel({ plugins = new Map(), tv = false } = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, 'cfg-'));
  const configStore = new ConfigStore({ dataDir: dir, masterKey: 'near-title-other-year-test-key' });
  configStore.load();
  configStore.update({
    web: { admins: [{ username: 'owner', role: 'superadmin', passwordHash: hashPassword('x-password-1') }] },
    omdb: { apiKey: 'test-key' },
    gemini: { enabled: false },
    library: { provider: 'jellyfin', jellyfin: JELLYFIN },
    ...(tv ? { tvRequests: { enabled: true } } : {}),
  });
  const spaces = new Map();
  const stateStore = {
    namespace(name) {
      if (!spaces.has(name)) spaces.set(name, {});
      const d = spaces.get(name);
      return { get: (k, v) => d[k] ?? v, set: (k, v) => { d[k] = v; }, push: (k, v) => { (d[k] ??= []).unshift(v); } };
    },
  };
  const queue = new JobQueue({ concurrency: 1 });
  queue.pause();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: { username: 'owner', role: 'superadmin' } }; next(); });
  app.use('/api', createApiRouter({
    configStore,
    bot: { groupCache: new Map(), groups: () => [], on: () => {}, state: 'connected' },
    queue, linkQueue: queue,
    pluginManager: { plugins, notifyConfigChange: async () => {}, list: () => [] },
    stateStore, fileLogger: { tail: () => [] }, alerts: {}, lockScheduler: {},
  }));
  const server = await new Promise((r) => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); });
  const post = (route, body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const rq = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: `/api${route}`,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    });
    rq.on('error', reject);
    rq.end(data);
  });
  return { post, close: () => server.close() };
}

console.log('=== the Test tab\'s dry run ===');
{
  LIB = [BAREFOOT_GEN];
  const p = await panel();
  const r = await p.post('/test/request', { text: 'Barefoot 2014' });
  ok(r?.verdict === 'not-in-library', `"Barefoot 2014" reports not-in-library (${r?.verdict})`);
  const lib = (r?.steps ?? []).find((st) => st.step === 'library');
  ok(lib?.ok === false && /Barefoot Gen.*1983.*different film/.test(lib?.detail ?? ''),
    `and the library step names what it refused: "${lib?.detail}"`);

  LIB = [BAREFOOT_GEN, BAREFOOT];
  const r2 = await p.post('/test/request', { text: 'Barefoot 2014' });
  ok(r2?.verdict === 'would-send', `with Barefoot (2014) on the server it would send (${r2?.verdict})`);

  LIB = [DUNE_2021];
  const d = await p.post('/test/request', { text: 'Dune 1984' });
  const dlib = (d?.steps ?? []).find((st) => st.step === 'library');
  ok(d?.verdict === 'not-in-library', `"Dune 1984" with only Dune (2021) held reports not-in-library (${d?.verdict})`);
  ok(dlib?.ok === false && dlib?.detail === 'not in your library — closest in the library: "Dune" (2021), a different year',
    `and the library step names the copy as another year: "${dlib?.detail}"`);
  const bare = await p.post('/test/request', { text: 'dune' });
  ok(bare?.verdict === 'would-send', `a bare "dune" would still send the Dune held (${bare?.verdict})`);
  LIB = [...VENOMS];
  const v = await p.post('/test/request', { text: 'Venom 2018' });
  const vlib = (v?.steps ?? []).find((st) => st.step === 'library');
  ok(v?.verdict === 'would-send' && /^found: Venom \(2018\)/.test(vlib?.detail ?? ''),
    `"Venom 2018" with four Venoms held would send the 2018 one: "${vlib?.detail}"`);
  p.close();
}

console.log('=== a Re-run of a year-stamped film does not go on to ask TV ===');
{
  // In review, "Star Trek 2009" re-run from the panel came back "Star Trek
  // (2009) is not in the library ... · TV: Which season of Star Trek: The Next
  // Generation?" - the film-taken-for-a-show answer api.js's comment exists
  // to prevent. A group request says "not in the library"; so does this.
  const h = harness();
  const tvAsked = [];
  const tvPlugin = { requeue: async (q) => { tvAsked.push(q); throw new Error(`Which season of ${q}?`); } };
  const p = await panel({
    tv: true,
    plugins: new Map([
      ['movie-requests', { plugin: moviePlugin, ctx: h.ctx }],
      ['tv-requests', { plugin: tvPlugin, ctx: {} }],
    ]),
  });
  LIB = [INTO_DARKNESS, BEYOND];
  const r = await p.post('/requeue', { text: 'Star Trek 2009' });
  ok(r?.ok === false && /^Star Trek \(2009\) is not in the library — closest in the library: "Star Trek (Into Darkness|Beyond)"/.test(r?.error ?? '')
    && !/TV:/.test(r?.error ?? ''), `answered not in the library, naming the film held: "${r?.error}"`);
  ok(tvAsked.length === 0, 'and TV was never asked');

  LIB = [DUNE_2021];
  const d = await p.post('/requeue', { text: 'Dune 1984' });
  ok(d?.ok === false && d?.error === 'Dune (1984) is not in the library — closest in the library: "Dune" (2021), a different year',
    `"Dune 1984" is answered not in the library, as another year: "${d?.error}"`);
  ok(tvAsked.length === 0, 'and TV was not asked about it either');

  // A title with no near-namesake refused, or no year, still tries TV: a bare
  // show name reads like a film title, which is what the fallback is for.
  LIB = [];
  const r2 = await p.post('/requeue', { text: 'outer banks' });
  ok(tvAsked.includes('outer banks') && /TV: Which season of outer banks\?/.test(r2?.error ?? ''),
    `"outer banks" still goes on to TV: "${r2?.error}"`);
  ok(h.jobs.length === 0, 'nothing queued');
  p.close();
}

console.log('=== a direct link ===');
{
  LIB = [BAREFOOT_GEN];
  const h = harness();
  const replies = [];
  await directLinks._movie({
    parsed: { kind: 'movie', query: 'Barefoot 2014', title: 'Barefoot', year: 2014 },
    ctx: h.ctx, reply: async (t) => { replies.push(t); },
    base: 'http://jf.test', apiKey: 'SHARE', restricted: [], cfg: { linkType: 'web' },
  });
  ok(replies.length === 1 && /isn't on the server/.test(replies[0]) && !/Barefoot Gen/.test(replies[0]),
    `no link to Barefoot Gen for "Barefoot 2014": ${JSON.stringify(replies)}`);

  const link = async (query) => {
    const said = [];
    const year = Number(query.match(/\b(19|20)\d{2}\b/)?.[0]) || null;
    await directLinks._movie({
      parsed: { kind: 'movie', query, title: query.replace(/\s*\b(19|20)\d{2}\b/, ''), year },
      ctx: h.ctx, reply: async (t) => { said.push(t); },
      base: 'http://jf.test', apiKey: 'SHARE', restricted: [], cfg: { linkType: 'web' },
    });
    return said;
  };
  LIB = [DUNE_2021];
  const d = await link('Dune 1984');
  ok(d.length === 1 && d[0] === '📬 *Dune (1984)* isn\'t on the server.', `no link to Dune (2021) for "Dune 1984": ${JSON.stringify(d)}`);
  const bare = await link('dune');
  ok(bare.length === 1 && bare[0].includes(DUNE_2021.Id), `a bare "dune" still gets the link to the Dune held: ${JSON.stringify(bare)}`);
  LIB = [...VENOMS];
  const v = await link('Venom 2018');
  ok(v.length === 1 && v[0].includes(VENOM_2018.Id), `"Venom 2018" gets the 2018 one's link: ${JSON.stringify(v)}`);
}

console.log('=== a list offering Barefoot Gen does not take "barefoot 2014" as a pick of it ===');
{
  const list = { request: 'barefoot', title: 'barefoot', items: [{ title: 'Barefoot Gen', year: 1983 }, { title: 'Barefoot Gen 2', year: 1986 }] };
  ok(parsePick('#request barefoot 2014', list, '#request') === null, 'a year no listed film has is a fresh request, not a pick');
  ok(parsePick('#request barefoot 1983', list, '#request')?.index === 0, 'the listed film\'s own year still picks it');
}

/* ---------------- review of the typed-year rule (2026-09-29) ---------------- */

console.log('=== a copy a year from the resolved film is sent, however far from the year typed ===');
{
  // Typed with the release year (2020), known to OMDb by 2019, held by the
  // server under its festival year (2018). Each leeway alone forgives one
  // year; the typed-year rule added them up and answered "not in the library"
  // for a film the server holds.
  ok(whyOtherFilm({ title: 'Sound of Metal', year: 2019 }, { title: 'Sound of Metal', year: 2018 }, { typedYear: 2020 }) === null,
    'Sound of Metal (2018) is the film for "Sound of Metal 2020", which OMDb has as 2019');
  ok(whyOtherFilm({ title: 'Dune', year: 1984 }, { title: 'Dune', year: 2021 }, { typedYear: 1984 }) === 'year',
    'Dune (2021) is still another year for "Dune 1984"');
  LIB = [SOUND_OF_METAL];
  const h = harness({ blockedRatings: ['NC-17', 'X'] });
  const row = await request(h, 'Sound of Metal 2020');
  ok(row?.status === 'queued' && h.jobs.length === 1, `"Sound of Metal 2020" is sent the 2018 copy (${row?.status}: ${row?.detail})`);
  ok(!missOf(h, 'Sound of Metal', 2019) && !wantedOf(h, { imdbId: 'tt5363618' }), 'and is on neither list');
}

console.log('=== a direct link without OMDb does not read a number title as a typed year ===');
{
  // "1917" parses as the title 1917 and the year 1917. Without OMDb to say it
  // is the 2019 film, that year was compared with itself, taken as typed, and
  // 1917 (2019) refused as two years from it.
  LIB = [NINETEEN17];
  const h = harness();
  const said = [];
  OMDB_DOWN = true;
  try {
    await directLinks._movie({
      parsed: { kind: 'movie', query: '1917', title: '1917', year: 1917 },
      ctx: h.ctx, reply: async (t) => { said.push(t); },
      base: 'http://jf.test', apiKey: 'SHARE', restricted: [], cfg: { linkType: 'web' },
    });
  } finally { OMDB_DOWN = false; }
  ok(said.length === 1 && said[0].includes(NINETEEN17.Id), `"1917" with OMDb down still gets the link to 1917 (2019): ${JSON.stringify(said)}`);
}

console.log('=== a Re-run with a mistyped year does not go on to ask TV ===');
{
  // "Barefoot 2016" is resolved to Barefoot (2014). A year two off OMDb's is
  // no typedYearOf, so the error carried none, and api.js asked TV with the
  // typed text - where Barefoot Contessa answers - though the group request
  // says "not in the library".
  const h = harness();
  const tvAsked = [];
  const tvPlugin = { requeue: async (q) => { tvAsked.push(q); throw new Error(`Which season of ${q}?`); } };
  const p = await panel({
    tv: true,
    plugins: new Map([
      ['movie-requests', { plugin: moviePlugin, ctx: h.ctx }],
      ['tv-requests', { plugin: tvPlugin, ctx: {} }],
    ]),
  });
  LIB = [BAREFOOT_GEN];
  OMDB_T_ANY_YEAR = true;
  let err = null;
  try { await moviePlugin.requeue('Barefoot 2016', h.ctx); } catch (e) { err = e; }
  ok(err?.code === 'NOT_IN_LIBRARY' && err?.typedYear === 2016 && !!err?.otherFilm,
    `refused as not in the library, carrying the year as written (${err?.code} ${err?.typedYear}: ${err?.message})`);
  const r = await p.post('/requeue', { text: 'Barefoot 2016' });
  ok(r?.ok === false && /is not in the library/.test(r?.error ?? '') && !/TV:/.test(r?.error ?? ''),
    `the panel answers not in the library: "${r?.error}"`);
  OMDB_T_ANY_YEAR = false;
  ok(tvAsked.length === 0, 'and TV was never asked');
  p.close();
}

console.log('=== a series under the identical title from another year is not the film typed ===');
{
  // "Fargo 1996" with only the Fargo series (2014) on the server was told "is
  // a TV series, not a film", recorded is-a-series, and never reached the
  // not-in-library list: the operator's Dune 1984 rule, skipped here.
  LIB = [];
  SERIES = [FARGO_SERIES];
  const h = harness({ blockedRatings: ['NC-17', 'X'] });
  const row = await request(h, 'Fargo 1996');
  ok(row?.status === 'not-in-library', `"Fargo 1996" is not in the library, not is-a-series (${row?.status})`);
  ok(!replies(h).some((t) => /TV series/.test(t)), `no "TV series" reply (${JSON.stringify(replies(h))})`);
  const miss = missOf(h, 'Fargo', 1996);
  ok(!!miss && !miss.resolved && (miss.diagnostics ?? []).some((d) => d === 'series "Fargo" (2014) is not the 1996 film asked for'),
    `on the not-in-library list, saying why the series was not it: ${JSON.stringify(miss?.diagnostics)}`);
  ok(wantedOf(h, { imdbId: 'tt0116282' })?.reason === 'not-in-library', 'and on the wanted list');

  // A series from the year typed is still pointed at the TV group.
  SERIES = [OUTER_BANKS];
  const o = harness();
  ok((await request(o, 'Outer Banks 2020'))?.status === 'is-a-series', '"Outer Banks 2020" is still the series');
  SERIES = [];
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
