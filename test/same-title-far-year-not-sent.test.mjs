/* The library never answers a request with a film of the same title from a far different year that the member did not name, and History notes a film sent to a member twice.
   Run: node test/same-title-far-year-not-sent.test.mjs

   Incident, 2026-10-11 11:21 UTC, the movie requests group: jake ingram
   typed "#request fast and furios 6". OMDb resolved it to Fast and Furious
   (1939) (test/sequel-number-names-the-film.test.mjs is that half). The
   bot's log then reads:
     (library) the library calls "Fast and Furious" -> "Fast & Furious";
               searching again for that
     (movie-requests) library hit: Fast & Furious (2009) via download
     (movie-requests) sending Fast & Furious (2009) for Fast and Furious
               (1939), which is still not on the server - its wanted entry
               and not-in-library row stay open
   and Fast & Furious (2009), the fourth film of the series, was posted for
   him. The rule that refuses another film more than a year apart
   (differentFilm, whyOtherFilm) leaves an identical title alone, so that a
   bare "dune" is answered with the one Dune the server holds whichever Dune
   OMDb guessed; "Fast and Furious" and "Fast & Furious" are the same words
   once "&" is "and", so the 2009 film was let through for the 1939 one, 70
   years apart, on the strength of OMDb's guess alone. Asked live on
   2026-10-11, the code before this fix still answers findInLibrary("Fast and
   Furious", 1939) with Fast & Furious (2009), tt1013752.

   His History rows show he had been sent Fast & Furious (2009) on
   2026-10-09 at 03:42 UTC, for "fast and furios 2009" (asked for on
   2026-10-08), and nothing said it went to him a second time.

   Pinned, through the real findInLibrary and the real movie plugin (OMDb and
   Jellyfin are a stubbed fetch, with the live library's rows for the series):
   - findInLibrary for Fast and Furious (1939), with the words "fast and
     furios 6", finds nothing, and names Fast & Furious (2009) as the closest
     film, a different film; the same lookup for a bare "dune" still answers
     Dune (1984) with the Dune (2021) held, and a caller without the words
     gets what it always got;
   - "#request fast and furios 6" is queued as Fast & Furious 6 (2013);
   - "#request fast and furios", which OMDb really does resolve to the 1939
     film, is not in the library: 📬, naming Fast & Furious (2009), and
     nothing queued;
   - but "#request fast and furios 2009", his own request of 2026-10-08,
     which OMDb resolved to the 1939 film as well (its search in 2009 found
     nothing for the typo, live, and the relaxed search runs without the
     year), is still sent Fast & Furious (2009): the year he wrote names
     that copy. Review of the fix found it refused, and him told 📬 alone,
     because the year was dropped as far from OMDb's 1939 before the words
     were judged. "fast and furios 2013" is refused as another year;
   - "#request fast and furios six" and "fast and furious six" are sent Fast
     & Furious 6 (2013), and "the fast and the furious six" neither the
     first film nor the fourth (review: "six" was not read as the number);
   - a film the same member was sent before is still sent, and its History
     row says when and for what; another member's row, a beta row or another
     film does not count;
   - a film the library sends in place of the one the request was taken for
     (the bare "dune") says so on its row;
   - the panel's History row shows both notes, on the 24-hour clock. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import { findInLibrary, closestNote } from '../src/plugins/movie-requests/library.js';
import { whyOtherFilm } from '../src/util/fuzzy.js';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const REQ = 'movie-requests@g.us';
const POSTS = 'movie-posts@g.us';
const NOTIFY = 'movie-notify@g.us';
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/* ------------------------------ fixtures ------------------------------ */

// The live library's rows for the series (Jellyfin 10.11, 2026-10-11), with
// the IMDb ids it carries, and a Dune for the bare-title case.
let seqId = 0;
const row = (Name, ProductionYear, OfficialRating, imdb) => {
  seqId += 1;
  return {
    Id: String(seqId).padStart(32, '0'), Name, ProductionYear, OfficialRating, Type: 'Movie',
    ProviderIds: { Imdb: imdb }, MediaSources: [{ Path: `/nowhere/${Name}.mkv`, Size: 17, Container: 'mp4' }],
  };
};
const SERIES_ROWS = [
  row('The Fast and the Furious', 2001, 'PG-13', 'tt0232500'), row('2 Fast 2 Furious', 2003, 'PG-13', 'tt0322259'),
  row('The Fast and the Furious: Tokyo Drift', 2006, 'PG-13', 'tt0463985'), row('Fast & Furious', 2009, 'PG-13', 'tt1013752'),
  row('Fast Five', 2011, 'PG-13', 'tt1596343'), row('Fast & Furious 6', 2013, 'PG-13', 'tt1905041'),
  row('Furious 7', 2015, 'PG-13', 'tt2820852'), row('The Fate of the Furious', 2017, 'PG-13', 'tt4630562'),
];
const [, , , FF_2009_ROW, , FF6_ROW] = SERIES_ROWS;
const DUNE_2021_ROW = row('Dune', 2021, 'PG-13', 'tt1160419');
let LIB = [];

const omdb = (Title, Year, Rated, imdbID, extra = {}) => ({
  Title, Year: String(Year), Rated, imdbID, Type: 'movie', Released: 'N/A', DVD: 'N/A', Response: 'True', ...extra,
});
const FF6 = omdb('Fast & Furious 6', 2013, 'PG-13', 'tt1905041', { Released: '24 May 2013', Runtime: '130 min', imdbVotes: '445,319' });
// As the bot's log of 11:21 describes it: 885 votes, rated Approved.
const FF_1939 = omdb('Fast and Furious', 1939, 'Approved', 'tt0031298', { Released: '27 Oct 1939', Runtime: '73 min', imdbVotes: '885' });
const FF_2009 = omdb('Fast & Furious', 2009, 'PG-13', 'tt1013752', { Released: '03 Apr 2009', Runtime: '107 min', imdbVotes: '310,000' });
const DUNE_1984 = omdb('Dune', 1984, 'PG-13', 'tt0087182', { Released: '14 Dec 1984', imdbVotes: '190,000' });
const DUNE_2021 = omdb('Dune', 2021, 'PG-13', 'tt1160419', { Released: '22 Oct 2021', imdbVotes: '960,000' });
const hit = (...rows) => rows.map(([Title, Year, imdbID]) => ({ Title, Year: String(Year), imdbID, Type: 'movie' }));
// What live OMDb answered on 2026-10-11 (sequel-number-names-the-film has
// the rest); anything else is "Movie not found!", as `t=` and `s=` for "fast
// and furios 6" and the sub-queries "and furios" and "fast furios" were, and
// as `t=` and `s=` for "fast and furios" in 2009 were, and every query of
// "fast and furious six" and "fast and furios six" but "fast and furious".
const OMDB = {
  's:fast and furious|': hit(['The Fast and the Furious', 2001, 'tt0232500'], ['The Fast and the Furious: Tokyo Drift', 2006, 'tt0463985'],
    ['The Fast and the Furious', 1954, 'tt0046969'], ['Fast and Furious', 1939, 'tt0031298'],
    ['Fast and the Furious: Tokyo Drift - The Japanese Way', 2006, 'tt0878117'],
    ['Tasmanian Devil: The Fast and Furious Life of Errol Flynn', 2007, 'tt1008725'],
    ['Jackie Chan: Fast, Funny and Furious', 2002, 'tt0454613'], ['Fast and Furious', 1927, 'tt0017866'],
    ['The Fast and the Furious: Tokyo Drift - Deleted Scenes', 2006, 'tt29353735'], ['Fast and Furious', 1924, 'tt0247334']),
  's:fast furious|': hit(['The Fast and the Furious', 2001, 'tt0232500'], ['Fast & Furious 6', 2013, 'tt1905041'],
    ['Fast & Furious', 2009, 'tt1013752'], ['The Fast and the Furious: Tokyo Drift', 2006, 'tt0463985'],
    ['2 Fast 2 Furious', 2003, 'tt0322259'], ['Fast & Furious Presents: Hobbs & Shaw', 2019, 'tt6806448'],
    ['Turbo Charged Prelude to 2 Fast 2 Furious', 2003, 'tt2055789'], ['The Fast and the Furious', 1954, 'tt0046969'],
    ['Fast & Furious: Supercharged', 2015, 'tt3757982'], ['Fast and Furious', 1939, 'tt0031298']),
  's:fast and|': hit(['The Fast and the Furious', 2001, 'tt0232500'], ['The Fast and the Furious: Tokyo Drift', 2006, 'tt0463985'],
    ['Fast and Furry-ous', 1949, 'tt0041349'], ['Tom and Jerry: The Fast and the Furry', 2005, 'tt0487176'],
    ['The Fast and the Furious', 1954, 'tt0046969'], ['Fast and Furious', 1939, 'tt0031298'],
    ['The Fast and the Fierce', 2017, 'tt6580394'], ['Fast and Loose', 1939, 'tt0031299'],
    ['Hard, Fast and Beautiful!', 1951, 'tt0043619'], ['Fast and Fierce: Death Race', 2020, 'tt11765324']),
  't:fast & furious 6|2013': FF6,
  't:fast & furious|2009': FF_2009,
  // Listed first, so a bare "dune" is Dune (1984) to this OMDb.
  't:dune|': DUNE_1984,
  't:dune|2021': DUNE_2021,
};
for (const r of [FF6, FF_1939, FF_2009, DUNE_1984, DUNE_2021]) OMDB[`i:${r.imdbID}`] = r;

globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.hostname === 'www.omdbapi.com') {
    const p = u.searchParams;
    const key = p.get('i') ? `i:${p.get('i')}`
      : p.get('t') ? `t:${p.get('t').toLowerCase()}|${p.get('y') ?? ''}`
        : `s:${p.get('s').toLowerCase()}|${p.get('y') ?? ''}`;
    let body = OMDB[key] ?? { Response: 'False', Error: p.get('i') ? 'Incorrect IMDb ID.' : 'Movie not found!' };
    if (Array.isArray(body)) body = { Response: 'True', Search: body, totalResults: String(body.length) };
    return json(body);
  }
  if (u.hostname === 'jf.test') {
    if (u.pathname === '/Items') {
      const ids = u.searchParams.get('Ids');
      if (ids) return json({ Items: LIB.filter((i) => i.Id === ids), TotalRecordCount: 1 });
      // Measured live: the server ignores AnyProviderIdEquals and answers
      // with every film; findInLibrary keeps only those carrying the id.
      if (u.searchParams.get('AnyProviderIdEquals')) return json({ Items: LIB, TotalRecordCount: LIB.length });
      const term = u.searchParams.get('searchTerm');
      if (u.searchParams.get('IncludeItemTypes') === 'Series' || !term) return json({ Items: [], TotalRecordCount: 0 });
      // Jellyfin's searchTerm: a contiguous run of the stored name, so "Fast
      // and Furious" finds nothing called "Fast & Furious".
      const items = LIB.filter((f) => norm(f.Name).includes(norm(term)));
      return json({ Items: items, TotalRecordCount: items.length });
    }
    return json({ Items: [], SearchHints: [], TotalRecordCount: 0 });
  }
  return new Response('{}', { status: 404 });
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'same-title-far-year-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const JELLYFIN = { baseUrl: 'http://jf.test', authMethod: 'apikey', apiKey: 'KEY', accessToken: 'TOK', userId: 'U1' };
const LIB_CFG = mergeDefaults({ provider: 'jellyfin', jellyfin: JELLYFIN }, DEFAULT_CONFIG.library);

// `askWhichOne` off is requireYearWhenAmbiguous off: no step 0, so a bare
// title goes to OMDb, as it does wherever step 0 cannot decide.
function config({ askWhichOne = true } = {}) {
  const c = mergeDefaults({
    movieRequests: {
      requireYearWhenAmbiguous: askWhichOne,
      requestGroups: [REQ], postsGroup: POSTS, notify: { group: NOTIFY },
      requirePrefix: true, prefix: '#request', cooldownSecondsPerUser: 0,
      replyOnBlock: true, blockedRatings: ['R', 'NC-17', 'X', 'TV-MA'],
    },
  }, DEFAULT_CONFIG);
  c.omdb.apiKey = 'test-key';
  c.gemini = { ...c.gemini, enabled: false };
  c.library = LIB_CFG;
  Object.assign(c.media, { workDir: TMP });
  return c;
}

function harness({ history = [], askWhichOne } = {}) {
  const out = [];
  const jobs = [];
  const data = { history: structuredClone(history) };
  const s = {
    get: (k, d = null) => (k in data ? data[k] : d),
    set: (k, v) => { data[k] = v; },
    push: (k, v) => { (data[k] ??= []).unshift(v); },
  };
  const lines = [];
  const ctx = {
    config: config({ askWhichOne }),
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
    log: { info: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l), debug() {} },
    configStore: { update() {} },
    queue: { maxLength: 50, pending: [], add: (j) => { jobs.push(j); return `job-${jobs.length}`; }, snapshot: () => ({ pending: [], active: [] }) },
  };
  return { ctx, out, jobs, s, lines };
}

moviePlugin._reactors = new Map();
const JAKE = { jid: '148700000000001@lid', number: '15550000668', name: 'jake ingram' };
const OTHER = { jid: '148700000000002@lid', number: '15550000777', name: 'someone else' };
let seq = 0;
async function request(h, text, who = JAKE) {
  const id = `M${++seq}`;
  await moviePlugin.onMessage({
    id, key: { id, remoteJid: REQ, participant: who.jid, fromMe: false }, text: `#request ${text}`, chatJid: REQ,
    isGroup: true, fromMe: false, messageType: 'conversation', senderJid: who.jid, senderNumber: who.number,
    senderNumberDisplay: `+${who.number}`, pushName: who.name, timestamp: Date.now(), raw: { key: { id } },
  }, h.ctx);
  await new Promise((r) => setTimeout(r, 20));
  return (h.s.get('history', []) ?? []).find((r) => r.id === id);
}
const replies = (h) => h.out.filter((o) => o.op === 'text' && o.jid === REQ).map((o) => o.body);

// His row of 2026-10-08, sent 2026-10-09 at 03:42 UTC, as History keeps it.
const SENT_0810 = {
  id: 'ACF7D451E6BC3C5DB252387963A4E4C7', at: 1791496399671, requestedAt: 1791496399000,
  requester: JAKE.name, requesterJid: JAKE.jid, requesterNumber: JAKE.number, requesterNumberDisplay: `+${JAKE.number}`,
  groupJid: REQ, request: 'fast and furios 2009', status: 'sent', title: 'Fast & Furious', year: 2009, rated: 'PG-13',
  detail: 'encode, 1.66 GB', finishedAt: 1791517340103,
};

/* ------------------------------ the library step ------------------------------ */

console.log('=== the incident\'s library lookup: Fast and Furious (1939) for "fast and furios 6" ===');
{
  LIB = SERIES_ROWS;
  let other = null;
  const found = await findInLibrary('Fast and Furious', 1939, LIB_CFG, {
    alsoTry: ['fast and furios 6'], typed: 'fast and furios 6', imdbId: 'tt0031298', onOtherFilm: (o) => { other = o; },
  });
  ok(found === null, `nothing is a hit - not Fast & Furious (2009), 70 years on (${found ? `${found.title} ${found.year}` : 'nothing'})`);
  ok(other?.title === 'Fast & Furious' && other?.year === 2009 && other?.reason === 'film',
    `the closest film there is named, as a different film: ${other ? closestNote(other) : 'none'}`);
  ok(whyOtherFilm({ title: 'Fast and Furious', year: 1939 }, { title: 'Fast & Furious', year: 2009 }, { typed: 'fast and furios 6' }) === 'film',
    'whyOtherFilm: the same title 70 years on is another film when the words typed were not that title');

  // A caller without the member's words (a job resumed after a restart, the
  // wanted list's recheck) gets what it always got.
  const old = await findInLibrary('Fast and Furious', 1939, LIB_CFG, { alsoTry: ['fast and furios 6'], imdbId: 'tt0031298' });
  ok(old?.title === 'Fast & Furious' && old?.year === 2009, `without the words typed, the lookup is what it was (${old?.title} ${old?.year})`);

  // The film the request now resolves to is found.
  const right = await findInLibrary('Fast & Furious 6', 2013, LIB_CFG, {
    alsoTry: ['fast and furios 6'], typed: 'fast and furios 6', imdbId: 'tt1905041',
  });
  ok(right?.id === FF6_ROW.Id, `Fast & Furious 6 (2013) is found for it (${right?.title} ${right?.year})`);

  // A bare title still has the leeway it was given for: the member named no
  // year, and the words typed are the title the server holds.
  LIB = [DUNE_2021_ROW];
  const dune = await findInLibrary('Dune', 1984, LIB_CFG, { alsoTry: ['dune'], typed: 'dune', imdbId: 'tt0087182' });
  ok(dune?.id === DUNE_2021_ROW.Id, `a bare "dune" is still answered with the Dune (2021) held (${dune?.title} ${dune?.year})`);
  ok(whyOtherFilm({ title: 'Dune', year: 1984 }, { title: 'Dune', year: 2021 }, { typed: 'the dune movie please' }) === null,
    '  however it is typed, "the", "movie" and "please" aside');
  ok(whyOtherFilm({ title: '1917', year: 2019 }, { title: '1917', year: 1917 }, { typed: '1917' }) === null,
    '  and a title that is a year is still its own title');
  ok(whyOtherFilm({ title: 'Dune', year: 1984 }, { title: 'Dune', year: 2021 }, { typed: 'dune 1984', typedYear: 1984 }) === 'year',
    'a typed year still decides on its own ("Dune 1984")');
}

/* ------------------------------ the request ------------------------------ */

console.log('=== "#request fast and furios 6" is sent Fast & Furious 6 (2013) ===');
{
  LIB = SERIES_ROWS;
  const h = harness();
  const r = await request(h, 'fast and furios 6');
  ok(r?.status === 'queued' && r?.title === 'Fast & Furious 6' && r?.year === 2013,
    `queued as ${r?.title} (${r?.year}) (${r?.status}${r?.detail ? `: ${r.detail}` : ''})`);
  ok(h.jobs.length === 1 && h.jobs[0].label === 'Fast & Furious 6 (2013)', `one job, ${h.jobs[0]?.label}`);
  ok(!h.lines.some((l) => /Fast and Furious \(1939\)|Fast & Furious \(2009\)/.test(l)), 'neither the 1939 film nor the 2009 one is ever in play');
}

console.log('=== a request OMDb really resolves to the 1939 film is not sent the 2009 one ===');
{
  // "fast and furios" with no number: the relaxed search's "fast and" lists
  // Fast and Furious (1939), which wins on the words, and nothing better
  // known answers them as well - OMDb's guess, as at 11:21.
  LIB = SERIES_ROWS;
  const h = harness();
  const r = await request(h, 'fast and furios');
  ok(h.lines.some((l) => /request "fast and furios" -> Fast and Furious \(1939\)/.test(l)), 'OMDb takes it for Fast and Furious (1939)');
  ok(r?.status === 'not-in-library', `which the server does not have: ${r?.status} (${r?.detail})`);
  ok(h.jobs.length === 0, 'nothing is queued - Fast & Furious (2009) is not posted for it');
  ok(/Fast & Furious" \(2009\), a different film/.test(r?.detail ?? ''), `the row names the film the server does hold: ${r?.detail}`);
  ok(replies(h).some((t) => t.includes('we do have "Fast & Furious" (2009)')),
    `and the member is told, to ask for it by name: ${JSON.stringify(replies(h))}`);
}

console.log('=== a year the member wrote names the copy, whatever namesake OMDb guessed ===');
{
  // His own request of 2026-10-08 at 21:53 UTC. `t=` and `s=` in 2009 found
  // nothing for the typo, live; the relaxed search, which searches without
  // the year, took the 1939 film from "fast and"; and the library's Fast &
  // Furious (2009) was the film sent, the one he had named.
  LIB = SERIES_ROWS;
  const h = harness();
  const r = await request(h, 'fast and furios 2009');
  ok(h.lines.some((l) => /request "fast and furios 2009" -> Fast and Furious \(1939\)/.test(l)), 'OMDb takes it for Fast and Furious (1939)');
  ok(r?.status === 'queued' && h.jobs.length === 1 && h.jobs[0].label === 'Fast & Furious (2009)',
    `and Fast & Furious (2009), the year he wrote, is sent (${r?.status}${r?.detail ? `: ${r.detail}` : ''}; ${h.jobs[0]?.label ?? 'no job'})`);
  ok(whyOtherFilm({ title: 'Fast and Furious', year: 1939 }, { title: 'Fast & Furious', year: 2009 }, { typed: 'fast and furios 2009' }) === null
    && whyOtherFilm({ title: 'Fast and Furious', year: 1939 }, { title: 'Fast & Furious', year: 2009 }, { typed: 'fast and furios 2010' }) === null,
  'whyOtherFilm: a copy from the year written, or one off it, is the film named');
  ok(whyOtherFilm({ title: 'Fast and Furious', year: 1939 }, { title: 'Fast & Furious', year: 2009 }, { typed: 'fast and furios 2013' }) === 'year',
    '  and one far from it is from another year than asked for');

  let other = null;
  const found = await findInLibrary('Fast and Furious', 1939, LIB_CFG, {
    alsoTry: ['fast and furios 2009'], typed: 'fast and furios 2009', imdbId: 'tt0031298', onOtherFilm: (o) => { other = o; },
  });
  ok(found?.id === FF_2009_ROW.Id && !other, `findInLibrary takes it, with the words typed (${found?.title} ${found?.year})`);

  // The library's log goes to stdout; it is read here for the year it names.
  const printed = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { printed.push(String(chunk)); return write(chunk, ...rest); };
  const far = harness();
  let f;
  try { f = await request(far, 'fast and furios 2013'); } finally { process.stdout.write = write; }
  ok(f?.status === 'not-in-library' && far.jobs.length === 0, `"fast and furios 2013", OMDb's 1939 film too, is not sent the 2009 one (${f?.status})`);
  ok(/"Fast & Furious" \(2009\), a different year/.test(f?.detail ?? ''), `  the row says why: ${f?.detail}`);
  ok(printed.some((l) => /from another year than the 2013 asked for/.test(l)) && !printed.some((l) => /null is the year|the null asked/.test(l)),
    '  and the log names the year he wrote');
  ok(!replies(far).some((t) => t.includes('we do have')), '  a year typed gets 📬 alone, as always');
}

console.log('=== a sequel number typed as a word is held to as well ===');
{
  // Review of the fix, 2026-10-11: "six" was not read as the number, and
  // "fast and furios six" was answered with Fast & Furious (2009) again, by
  // the library's research; "fast and furious six" with The Fast and the
  // Furious (2001), from OMDb's sub-query "fast and furious".
  LIB = SERIES_ROWS;
  for (const text of ['fast and furios six', 'fast and furious six']) {
    const h = harness({ history: [SENT_0810] });
    const r = await request(h, text);
    ok(r?.status === 'queued' && r?.title === 'Fast & Furious 6' && r?.year === 2013 && h.jobs.length === 1,
      `"${text}" is sent Fast & Furious 6 (2013) (${r?.status}: ${r?.title} ${r?.year})`);
    ok(!r?.sentBefore, '  which he had not been sent');
  }
  const h = harness({ history: [SENT_0810] });
  const r = await request(h, 'the fast and the furious six');
  ok(!h.jobs.some((j) => /Fast and the Furious \(2001\)|Fast & Furious \(2009\)/.test(j.label)),
    `"the fast and the furious six" is sent neither the first film nor the fourth (${r?.status}${r?.title ? `: ${r.title} ${r.year}` : ''})`);
}

/* ------------------------------ History notes ------------------------------ */

console.log('=== a film the member was sent before is noted on its History row ===');
{
  LIB = SERIES_ROWS;
  const h = harness({ history: [SENT_0810] });
  const r = await request(h, 'fast & furious 2009');
  ok(r?.status === 'queued' && h.jobs.length === 1, `still sent: he may have lost it (${r?.status})`);
  ok(r?.sentBefore?.id === SENT_0810.id && r?.sentBefore?.at === SENT_0810.finishedAt && r?.sentBefore?.request === 'fast and furios 2009',
    `the row says when and for what: ${JSON.stringify(r?.sentBefore)}`);
  ok(h.lines.some((l) => /Fast & Furious \(2009\) was sent to jake ingram before, at 2026-10-09T03:42:20\.103Z, for "fast and furios 2009"/.test(l)),
    'and the log says so');

  const other = harness({ history: [SENT_0810] });
  const o = await request(other, 'fast & furious 2009', OTHER);
  ok(o?.status === 'queued' && !o?.sentBefore, 'another member asking for it is not noted');
  const film6 = harness({ history: [SENT_0810] });
  const f = await request(film6, 'fast and furios 6');
  ok(f?.status === 'queued' && !f?.sentBefore, 'nor is another film of the series for him');
  const beta = harness({ history: [{ ...SENT_0810, beta: true }] });
  const b = await request(beta, 'fast & furious 2009');
  ok(b?.status === 'queued' && !b?.sentBefore, 'nor a row from a beta group, where nothing is sent');
  const failed = harness({ history: [{ ...SENT_0810, status: 'failed' }] });
  const x = await request(failed, 'fast & furious 2009');
  ok(x?.status === 'queued' && !x?.sentBefore, 'nor a request of his that never reached him');
  const byJid = harness({ history: [{ ...SENT_0810, requesterNumber: null, requesterNumberDisplay: null }] });
  const j = await request(byJid, 'fast & furious 2009', { ...JAKE, number: null });
  ok(!!j?.sentBefore, 'a member WhatsApp gave no number for is known by their JID');
}

console.log('=== a film sent in place of the one the request was taken for is noted ===');
{
  // A bare "dune" with no step 0: OMDb takes it for Dune (1984), and the one
  // Dune held, 2021, is sent, as a bare title always was.
  LIB = [DUNE_2021_ROW];
  const h = harness({ askWhichOne: false });
  const r = await request(h, 'dune');
  ok(r?.status === 'queued' && r?.year === 2021, `"dune" is sent Dune (2021) (${r?.status} ${r?.year})`);
  ok(r?.sentFor?.title === 'Dune' && r?.sentFor?.year === 1984 && r?.sentFor?.file?.year === 2021,
    `its row says it went for Dune (1984): ${JSON.stringify(r?.sentFor)}`);
  LIB = SERIES_ROWS;
  const same = harness();
  ok(!(await request(same, 'fast and furios 6'))?.sentFor, 'a film sent as the one asked for carries no such note');
}

/* ------------------------------ the panel ------------------------------ */

console.log('=== the panel\'s History row shows both notes ===');
{
  const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  const fn = (name) => app.match(new RegExp(`\\nfunction ${name}\\([\\s\\S]*?\\n}\\n`))?.[0] ?? '';
  const clock = app.match(/\nconst CLOCK_24 = .*\n/)?.[0] ?? '';
  ok(!!fn('historyNotes') && !!fn('esc') && !!fn('fmtDateTime') && !!clock, 'app.js has historyNotes(), esc(), fmtDateTime() and CLOCK_24');
  // eslint-disable-next-line no-new-func
  const historyNotes = new Function(`${clock}${fn('esc')}${fn('fmtDateTime')}${fn('historyNotes')}\nreturn historyNotes;`)();
  const html = historyNotes({
    title: 'Fast & Furious', year: 2009, request: 'fast & furious 2009',
    sentBefore: { id: SENT_0810.id, at: SENT_0810.finishedAt, request: 'fast and furios 2009' },
  });
  const when = new Date(SENT_0810.finishedAt).toLocaleString(undefined, { hourCycle: 'h23' });
  ok(html.includes(`Already sent to this member on ${when}, for "fast and furios 2009"`), `the repeat: ${html.replace(/<[^>]+>/g, '')}`);
  ok(!/\b24:\d\d/.test(html) && !/[AP]M\b/.test(html), 'on the 24-hour clock');
  const instead = historyNotes({ sentFor: { title: 'Dune', year: 1984, file: { title: 'Dune', year: 2021 } } });
  ok(instead.includes("The library's Dune (2021) was sent for Dune (1984), which is not on the server."),
    `the stand-in: ${instead.replace(/<[^>]+>/g, '')}`);
  ok(historyNotes({ title: 'Heat', year: 1995 }) === '', 'a row with neither says nothing more');
  ok(historyNotes({ sentFor: { title: '<b>x</b>', year: 1 } }).includes('&lt;b&gt;'), 'and what it shows is escaped');
  ok(/\$\{historyNotes\(x\)\}/.test(fn('historyRow')), 'historyRow() shows them under the row\'s detail');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
