/* A request that ends in a number is answered with the film that carries it.
   Run: node test/sequel-number-names-the-film.test.mjs

   Incident, 2026-10-11 11:21 UTC, the movie requests group: jake ingram
   typed "#request fast and furios 6". OMDb found nothing for the typo by `t=`
   or by search; the relaxed search never searches a one-character word, so it
   searched "fast and", "and furios" and "fast furios", and the best of what
   "fast and" listed was Fast and Furious (1939), 885 votes, rated Approved.
   The obscure-hit check of the same morning found no better-known film, so
   the request resolved to the 1939 film, and the library step sent him Fast &
   Furious (2009) - the fourth film of the series, which he had been sent on
   2026-10-09 (test/same-title-far-year-not-sent.test.mjs is that half). At
   15:15 he asked again as "fast and furios 6 2013" and got the right film.

   The 6 is part of what he asked for. The hourly check's 14dd1ed held the
   relaxed search to it; the direct hit, the search and the well-known film
   the obscure-hit check may prefer were not held to it, and neither was the
   library's research, which a request OMDb cannot resolve falls back on.

   Checked against live OMDb on 2026-10-11 (the answers below, trimmed to the
   fields the lookup reads; one marked "not asked live" is shaped as OMDb
   answers, for a query the day's call budget did not cover):
     "fast and furios 6"          nothing by t= or s=, and the relaxed
                                  search's results all lack the 6: no film.
                                  The library's research then finds Fast &
                                  Furious 6 (2013), live, at 0.94, which OMDb
                                  resolves by t= (the bot's log at 15:15).
     "fast and furious 6"         Fast & Furious 6 (2013), by the sub-query
                                  "fast furious"
     "fast & furious 6"           Fast & Furious 6 (2013), by t=
     "the fast and the furious 6" nothing by t= or s=, nor by any sub-query
                                  one word short: OMDb's search wants every
                                  word it is given, and "&" is not "and"
                                  ("fast and 6" found nothing). Only "fast
                                  furious", the request without its little
                                  words, lists it. Before the fix: no film,
                                  and the library's research answered it with
                                  The Fast and the Furious (2001), live, 0.91
                                  against Fast & Furious 6's 0.84.
   Pinned:
   - each of the four ends at Fast & Furious 6 (2013), tt1905041, through
     OMDb or, for the typo, through the library's research;
   - Fast and Furious (1939) is never the answer to "fast and furios 6", as
     the relaxed search found it, nor as a `t=` that answers with a film
     without the number, which is not kept even as a last resort;
   - a well-known film without the number is not preferred to an obscure
     numbered one, and a search's numbered film still wins;
   - the guards resolve as they did: "rocky 2", "toy story 3", "x2", "f9",
     "ocean's 11" (a title, not a sequel number), "apollo 13", "district 9",
     "1917", "2012" and "se7en".

   Review of the fix, the same day, found the rule taking away the right film
   where a title writes its number another way, or asks for the first film,
   and not holding a number typed as a word. Checked against the live
   library (Jellyfin, read-only) with the library's research, the fallback
   when OMDb finds nothing - as it did, live, for `t=` "jackass 3", "john
   wick 1", "zero dark 30" and "rocky 1", for `s=` "john wick 1" and "rocky
   1", and for every query of "fast and furious six" and "fast and furios
   six" but the sub-query "fast and furious":
     "friday the 13", "jackass 3", "step up 3", "zero dark 30"
                                  found Friday the 13th (1980), a Jackass 3
                                  (3D or 3.5, which score alike), Step Up 3D
                                  and Zero Dark Thirty before the rule, and
                                  nothing with it: "13th", "3D" and "Thirty"
                                  were not read as numbers;
     "john wick 1", "rocky 1", "ted 1", "the equalizer 1"
                                  nothing with the rule, which wanted a 1 in
                                  the title; before it, John Wick (2014), and
                                  Rocky II, Ted 2 and The Equalizer 2 - the
                                  wrong films. "Ted 1" was resolved to Ted 2
                                  on 2026-10-07. Now the first film, the bare
                                  title, as several-films.js has it;
     "fast and furios six"        Fast & Furious (2009), the incident's film,
                                  with and without the rule: "six" was not a
                                  number typed. Now Fast & Furious 6 (2013);
     "fast and furious six"       now Fast & Furious 6 (2013), by OMDb's
                                  search without the little words or the
                                  number ("fast furious"; "fast furious six"
                                  found nothing live), where the sub-query
                                  "fast and furious" gave The Fast and the
                                  Furious (2001) before;
     "the fast and the furious six"
                                  The Fast and the Furious (2001) before; now
                                  no film, from OMDb or the library, which
                                  leaves it to the AI title lookup. */
import { lookupMovie, keepsSequelNumber } from '../src/plugins/movie-requests/omdb.js';
import { researchLibrary } from '../src/plugins/movie-requests/library.js';
import { sequelNumber, carriesNumber, firstFilmWords } from '../src/util/fuzzy.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const film = (Title, Year, imdbID, more = {}) => ({
  Title, Year: String(Year), imdbID, Type: 'movie', Response: 'True',
  Rated: 'N/A', Runtime: 'N/A', Genre: 'N/A', Writer: 'N/A', Actors: 'N/A', Plot: 'N/A', imdbVotes: 'N/A',
  ...more,
});
const hit = (...rows) => rows.map(([Title, Year, imdbID]) => ({ Title, Year: String(Year), imdbID, Type: 'movie' }));

// The records live OMDb answered with on 2026-10-11.
const FF6 = film('Fast & Furious 6', 2013, 'tt1905041', {
  Rated: 'PG-13', Runtime: '130 min', Genre: 'Action, Thriller', Writer: 'Chris Morgan, Gary Scott Thompson',
  Actors: 'Vin Diesel, Paul Walker, Dwayne Johnson', imdbVotes: '445,319',
  Plot: 'Hobbs has Dominic and Brian reassemble their crew to take down a team of mercenaries, but Dominic unexpectedly gets sidetracked with facing his presumed deceased girlfriend, Letty.',
});
// As the bot's log of 11:21 describes it: 885 votes, rated Approved.
const FF_1939 = film('Fast and Furious', 1939, 'tt0031298', {
  Rated: 'Approved', Runtime: '73 min', Genre: 'Comedy, Mystery', Writer: 'Harry Kurnitz',
  Actors: 'Franchot Tone, Ann Sothern, Ruth Hussey', imdbVotes: '885',
});
const FF_2009 = film('Fast & Furious', 2009, 'tt1013752', {
  Rated: 'PG-13', Runtime: '107 min', Genre: 'Action, Crime, Thriller', Writer: 'Chris Morgan, Gary Scott Thompson',
  Actors: 'Vin Diesel, Paul Walker, Michelle Rodriguez', imdbVotes: '310,000',
});
const TFATF_2001 = film('The Fast and the Furious', 2001, 'tt0232500', {
  Rated: 'PG-13', Runtime: '106 min', Genre: 'Action, Crime, Thriller', Writer: 'Ken Li, Gary Scott Thompson, Erik Bergquist',
  Actors: 'Vin Diesel, Paul Walker, Michelle Rodriguez', imdbVotes: '420,000',
});
const OCEANS_11_YEAR_OLDS = film("Ocean's 11-Year-Olds", 2007, 'tt0994879', {
  Runtime: '5 min', Genre: 'Short, Action', Writer: 'Andy Signore',
  Actors: 'Charlie Trepany, Justin Marco, Ian Waschak, Carl McDowell', imdbVotes: '24',
  Plot: 'Three eleven year old boys attempt the caper of their lifetime - to heist a "Men\'s Magazine" from their local newsstand.',
});

const S_FAST_AND = hit(['The Fast and the Furious', 2001, 'tt0232500'], ['The Fast and the Furious: Tokyo Drift', 2006, 'tt0463985'],
  ['Fast and Furry-ous', 1949, 'tt0041349'], ['Tom and Jerry: The Fast and the Furry', 2005, 'tt0487176'],
  ['The Fast and the Furious', 1954, 'tt0046969'], ['Fast and Furious', 1939, 'tt0031298'],
  ['The Fast and the Fierce', 2017, 'tt6580394'], ['Fast and Loose', 1939, 'tt0031299'],
  ['Hard, Fast and Beautiful!', 1951, 'tt0043619'], ['Fast and Fierce: Death Race', 2020, 'tt11765324']);
const S_AND_FURIOUS = hit(['The Fast and the Furious', 2001, 'tt0232500'], ['The Fast and the Furious: Tokyo Drift', 2006, 'tt0463985'],
  ['The Fast and the Furious', 1954, 'tt0046969'], ['Fast and Furious', 1939, 'tt0031298'],
  ['Fast and the Furious: Tokyo Drift - The Japanese Way', 2006, 'tt0878117'],
  ['Tasmanian Devil: The Fast and Furious Life of Errol Flynn', 2007, 'tt1008725'],
  ['Jackie Chan: Fast, Funny and Furious', 2002, 'tt0454613'], ['Fate and Furious', 2021, 'tt28631559'],
  ['Fast and Furious', 1927, 'tt0017866'], ['The Fast and the Furious: Tokyo Drift - Deleted Scenes', 2006, 'tt29353735']);
const S_FAST_FURIOUS = hit(['The Fast and the Furious', 2001, 'tt0232500'], ['Fast & Furious 6', 2013, 'tt1905041'],
  ['Fast & Furious', 2009, 'tt1013752'], ['The Fast and the Furious: Tokyo Drift', 2006, 'tt0463985'],
  ['2 Fast 2 Furious', 2003, 'tt0322259'], ['Fast & Furious Presents: Hobbs & Shaw', 2019, 'tt6806448'],
  ['Turbo Charged Prelude to 2 Fast 2 Furious', 2003, 'tt2055789'], ['The Fast and the Furious', 1954, 'tt0046969'],
  ['Fast & Furious: Supercharged', 2015, 'tt3757982'], ['Fast and Furious', 1939, 'tt0031298']);
const S_FAST_AND_THE = hit(['The Fast and the Furious', 2001, 'tt0232500'], ['The Fast and the Furious: Tokyo Drift', 2006, 'tt0463985'],
  ['Tom and Jerry: The Fast and the Furry', 2005, 'tt0487176'], ['The Fast and the Furious', 1954, 'tt0046969'],
  ['The Fast and the Fierce', 2017, 'tt6580394'], ['Fast and the Furious: Tokyo Drift - The Japanese Way', 2006, 'tt0878117'],
  ['Tasmanian Devil: The Fast and Furious Life of Errol Flynn', 2007, 'tt1008725'], ['Fast Freddie, the Widow and Me', 2011, 'tt2147283'],
  ['The Little Cars 3 - Fast and Curious', 2007, 'tt6260372'], ['The Fast and the Furious: Tokyo Drift - Deleted Scenes', 2006, 'tt29353735']);
const S_AND_THE_FURIOUS = hit(['The Fast and the Furious', 2001, 'tt0232500'], ['The Fast and the Furious: Tokyo Drift', 2006, 'tt0463985'],
  ['The Fast and the Furious', 1954, 'tt0046969'], ['Fast and the Furious: Tokyo Drift - The Japanese Way', 2006, 'tt0878117'],
  ['Tasmanian Devil: The Fast and Furious Life of Errol Flynn', 2007, 'tt1008725'],
  ['The Fast and the Furious: Tokyo Drift - Deleted Scenes', 2006, 'tt29353735'],
  ['Fast and the Furious: Tokyo Drift Peek Performance', 2006, 'tt0843849'],
  ['Grandmaster Flash and the Furious Five: The Message', 1983, 'tt6273898'],
  ['The Fast and the Furious: Editing for the MPAA', 2002, 'tt0781022'],
  ['The Fast and the Furious: Visual Effects Montage', 2002, 'tt0781023']);
const S_FAST_THE_FURIOUS = hit(['The Fast and the Furious', 2001, 'tt0232500'], ['The Fast and the Furious: Tokyo Drift', 2006, 'tt0463985'],
  ['The Fast and the Furious', 1954, 'tt0046969'], ['Fast and the Furious: Tokyo Drift - The Japanese Way', 2006, 'tt0878117'],
  ['Tasmanian Devil: The Fast and Furious Life of Errol Flynn', 2007, 'tt1008725'],
  ['The Fast and the Furious: Tokyo Drift - Deleted Scenes', 2006, 'tt29353735'],
  ['Fast and the Furious: Tokyo Drift Peek Performance', 2006, 'tt0843849'],
  ['The Road to F9: Fast & Furious Fan Fest', 2020, 'tt11723710'], ['Anime: The Fast & The Furious', 2018, 'tt10709388'],
  ['The Fast and the Furious: Editing for the MPAA', 2002, 'tt0781022']);
const S_FAST_AND_FURIOUS = hit(['The Fast and the Furious', 2001, 'tt0232500'], ['The Fast and the Furious: Tokyo Drift', 2006, 'tt0463985'],
  ['The Fast and the Furious', 1954, 'tt0046969'], ['Fast and Furious', 1939, 'tt0031298'],
  ['Fast and the Furious: Tokyo Drift - The Japanese Way', 2006, 'tt0878117'],
  ['Tasmanian Devil: The Fast and Furious Life of Errol Flynn', 2007, 'tt1008725'],
  ['Jackie Chan: Fast, Funny and Furious', 2002, 'tt0454613'], ['Fast and Furious', 1927, 'tt0017866'],
  ['The Fast and the Furious: Tokyo Drift - Deleted Scenes', 2006, 'tt29353735'], ['Fast and Furious', 1924, 'tt0247334']);

// Keyed by what was asked: `t:<title>|<year>`, `s:<term>|<year>`, `i:<id>`.
// Anything not here is "Movie not found!", as each of these was live:
// t= and s= for "fast and furios 6", "fast and furious 6" and "the fast and
// the furious 6", and s= for "and furios", "fast furios" and "fast and 6".
const LIVE = {
  's:fast and|': S_FAST_AND,
  's:and furious|': S_AND_FURIOUS,
  's:fast furious|': S_FAST_FURIOUS,
  's:fast and the|': S_FAST_AND_THE,
  's:and the furious|': S_AND_THE_FURIOUS,
  's:fast the furious|': S_FAST_THE_FURIOUS,
  's:fast and furious|': S_FAST_AND_FURIOUS,
  't:fast & furious 6|': FF6,
  // What the library's research hands back to OMDb, as the bot's log of
  // 15:15 shows it resolved: `resolved "Fast & Furious 6 2013" -> Fast &
  // Furious 6 (2013) [direct]`.
  't:fast & furious 6|2013': FF6,
  "t:ocean's 11|": OCEANS_11_YEAR_OLDS,
};

// The guards. Asked live: `t=rocky 2` (nothing) and `t=ocean's 11` (above).
// Not asked live: the rest, which answer as OMDb does for a film called
// exactly that, and the two searches, shaped as OMDb's search answers.
const ROCKY_II = film('Rocky II', 1979, 'tt0079817', { Rated: 'PG', Runtime: '119 min', Genre: 'Drama, Sport', imdbVotes: '230,000' });
const TOY_STORY_3 = film('Toy Story 3', 2010, 'tt0435761', { Rated: 'G', Runtime: '103 min', Genre: 'Animation, Adventure, Comedy', imdbVotes: '930,000' });
const X2 = film('X2: X-Men United', 2003, 'tt0290334', { Rated: 'PG-13', Runtime: '134 min', Genre: 'Action, Adventure, Sci-Fi', imdbVotes: '580,000' });
const F9 = film('F9: The Fast Saga', 2021, 'tt5433138', { Rated: 'PG-13', Runtime: '143 min', Genre: 'Action, Adventure, Crime', imdbVotes: '160,000' });
const OCEANS_11 = film("Ocean's 11", 1960, 'tt0054135', { Rated: 'Approved', Runtime: '127 min', Genre: 'Comedy, Crime, Music', imdbVotes: '30,000' });
const APOLLO_13 = film('Apollo 13', 1995, 'tt0112384', { Rated: 'PG', Runtime: '140 min', Genre: 'Adventure, Drama, History', imdbVotes: '330,000' });
const DISTRICT_9 = film('District 9', 2009, 'tt1136608', { Rated: 'R', Runtime: '112 min', Genre: 'Action, Sci-Fi, Thriller', imdbVotes: '720,000' });
const SE7EN = film('Se7en', 1995, 'tt0114369', { Rated: 'R', Runtime: '127 min', Genre: 'Crime, Drama, Mystery', imdbVotes: '1,900,000' });
Object.assign(LIVE, {
  's:rocky 2|': hit(['Rocky II', 1979, 'tt0079817']),
  't:toy story 3|': TOY_STORY_3,
  't:x2|': X2,
  't:f9|': F9,
  "s:ocean's 11|": hit(["Ocean's 11", 1960, 'tt0054135'], ["Ocean's Eleven", 2001, 'tt0240772'],
    ["Ocean's Twelve", 2004, 'tt0349903'], ["Ocean's Thirteen", 2007, 'tt0496806'], ["Ocean's 8", 2018, 'tt5164214'],
    ["Ocean's 11-Year-Olds", 2007, 'tt0994879']),
  't:apollo 13|': APOLLO_13,
  't:district 9|': DISTRICT_9,
  't:se7en|': SE7EN,
});
for (const r of [FF6, FF_1939, FF_2009, TFATF_2001, OCEANS_11_YEAR_OLDS, ROCKY_II, TOY_STORY_3, X2, F9, OCEANS_11,
  APOLLO_13, DISTRICT_9, SE7EN]) LIVE[`i:${r.imdbID}`] = r;

let table = LIVE;
const calls = [];
let jellyfin = [];
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.hostname === 'jf.test') {
    // Jellyfin's searchTerm: a contiguous run of the stored name.
    const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const term = norm(u.searchParams.get('searchTerm'));
    const items = jellyfin.filter((i) => term && norm(i.Name).includes(term));
    return json({ Items: items, TotalRecordCount: items.length });
  }
  const p = u.searchParams;
  const key = p.get('i') ? `i:${p.get('i')}`
    : p.get('t') ? `t:${p.get('t').toLowerCase()}|${p.get('y') ?? ''}`
      : `s:${p.get('s').toLowerCase()}|${p.get('y') ?? ''}`;
  calls.push(key);
  let body = table[key] ?? { Response: 'False', Error: p.get('i') ? 'Incorrect IMDb ID.' : 'Movie not found!' };
  if (Array.isArray(body)) body = { Response: 'True', Search: body, totalResults: String(body.length) };
  return json(body);
};

async function ask(text, with_ = null) {
  table = with_ ? { ...LIVE, ...with_ } : LIVE;
  calls.length = 0;
  const found = await lookupMovie(text, { apiKey: 'test' });
  return { found, id: found?.movie?.imdbId ?? null, label: found ? `${found.movie.title} (${found.movie.year})` : 'no film', calls: [...calls] };
}

// The live library's rows for the series (Jellyfin, 2026-10-11), and the
// films the guards' research would meet.
let seqId = 0;
const row = (Name, ProductionYear, imdb) => {
  seqId += 1;
  return { Id: String(seqId).padStart(32, '0'), Name, ProductionYear, Type: 'Movie', ProviderIds: { Imdb: imdb } };
};
const LIBRARY = [
  row('The Fast and the Furious', 2001, 'tt0232500'), row('2 Fast 2 Furious', 2003, 'tt0322259'),
  row('The Fast and the Furious: Tokyo Drift', 2006, 'tt0463985'), row('Fast & Furious', 2009, 'tt1013752'),
  row('Fast Five', 2011, 'tt1596343'), row('Fast & Furious 6', 2013, 'tt1905041'), row('Furious 7', 2015, 'tt2820852'),
  row('The Fate of the Furious', 2017, 'tt4630562'), row('F9: The Fast Saga', 2021, 'tt5433138'),
  row('Rocky', 1976, 'tt0075148'), row('Rocky II', 1979, 'tt0079817'),
  // And the films review asked about, as the live library lists them
  // (Jellyfin, 2026-10-11), with the neighbours each search turns up.
  row('Rocky III', 1982, 'tt0084602'), row('Rocky Balboa', 2006, 'tt0479143'),
  row('Friday', 1995, 'tt0113118'), row('Friday the 13th', 1980, 'tt0080761'), row('Friday the 13th', 2009, 'tt0758746'),
  row('Friday the 13th Part 2', 1981, 'tt0082418'), row('Friday the 13th Part III', 1982, 'tt0083972'),
  row('Friday the 13th: The Final Chapter', 1984, 'tt0087298'),
  row('Jackass 2.5', 2007, 'tt1117523'), row('Jackass 3.5', 2011, 'tt1753968'), row('Jackass 3D', 2010, 'tt1116184'),
  row('Jackass Number Two', 2006, 'tt0493430'), row('Jackass: The Movie', 2002, 'tt0322802'),
  row('Step Up', 2006, 'tt0462590'), row('Step Up 2: The Streets', 2008, 'tt1023481'), row('Step Up 3D', 2010, 'tt1193631'),
  row('Zero Dark Thirty', 2012, 'tt1790885'),
  row('John Wick', 2014, 'tt2911666'), row('John Wick: Chapter 2', 2017, 'tt4425200'), row('John Wick: Chapter 4', 2023, 'tt10366206'),
  row('The Equalizer', 2014, 'tt0455944'), row('The Equalizer 2', 2018, 'tt3766354'), row('The Equalizer 3', 2023, 'tt17024450'),
  row('Ted', 2012, 'tt1637725'), row('Ted 2', 2015, 'tt2637276'), row('Ted K', 2021, 'tt8128276'),
];
const LIB_CFG = { provider: 'jellyfin', jellyfin: { baseUrl: 'http://jf.test', authMethod: 'apikey', apiKey: 'KEY', accessToken: 'TOK', userId: 'U1' } };
async function research(text) {
  jellyfin = LIBRARY;
  return researchLibrary(text, LIB_CFG);
}

console.log('=== the number a request ends with ===');
{
  for (const [text, n] of [['fast and furios 6', 6], ['fast and furios 6 2013', 6], ['the fast and the furious 6', 6],
    ['rocky ii', 2], ['toy story 3', 3], ["ocean's 11", 11], ['apollo 13', 13], ['district 9', 9]]) {
    ok(sequelNumber(text) === n, `"${text}" ends in ${n} (${sequelNumber(text)})`);
  }
  for (const text of ['x2', 'f9', '1917', '2012', 'se7en', 'fast and furious', 'room 237']) {
    ok(sequelNumber(text) === null, `"${text}" ends in no number after a title`);
  }
  ok(carriesNumber('Fast & Furious 6', 6) && !carriesNumber('Fast and Furious', 6) && !carriesNumber('Fast & Furious', 6),
    'Fast & Furious 6 carries a 6; Fast and Furious (1939) and Fast & Furious (2009) do not');
  ok(carriesNumber('Rocky II', 2) && carriesNumber('Fast Five', 5) && carriesNumber("Ocean's Eleven", 11)
    && carriesNumber('X2: X-Men United', 2) && carriesNumber('F9: The Fast Saga', 9) && carriesNumber('Alien³', 3)
    && carriesNumber('John Wick: Chapter 4', 4) && carriesNumber('Shrek the Third', 3),
  'a number as a numeral, a word, an ordinal or the end of a word all count');
  ok(keepsSequelNumber('fast and furios 6', S_FAST_AND).length === 0, 'nothing "fast and" lists carries a 6');
}

console.log('=== the four ways of asking for Fast & Furious 6 reach it ===');
{
  const typo = await ask('fast and furios 6');
  ok(typo.found === null, `"fast and furios 6": no film from OMDb, not Fast and Furious (1939) (${typo.label})`);
  ok(!typo.calls.includes('i:tt0031298'), '  and the 1939 film is not even fetched');
  const fromLibrary = await research('fast and furios 6');
  ok(fromLibrary?.title === 'Fast & Furious 6' && fromLibrary?.year === 2013,
    `  the library's research recovers Fast & Furious 6 (2013) (${fromLibrary?.title} ${fromLibrary?.year})`);
  const relooked = await ask(`${fromLibrary?.title} ${fromLibrary?.year}`);
  ok(relooked.id === 'tt1905041', `  and OMDb resolves what it recovered: ${relooked.label}`);

  const spelled = await ask('fast and furious 6');
  ok(spelled.id === 'tt1905041', `"fast and furious 6" -> ${spelled.label}`);
  const amp = await ask('fast & furious 6');
  ok(amp.id === 'tt1905041' && amp.calls.length === 1, `"fast & furious 6" -> ${amp.label}, by t= alone (${amp.calls.length} call)`);
  const long = await ask('the fast and the furious 6');
  ok(long.id === 'tt1905041', `"the fast and the furious 6" -> ${long.label}`);
  ok(long.calls.includes('s:fast furious|'), '  through the search without the little words, "fast furious"');
  ok(long.calls.length <= 8, `  in ${long.calls.length} OMDb calls: ${long.calls.join(', ')}`);
  const longFromLibrary = await research('the fast and the furious 6');
  ok(longFromLibrary?.title === 'Fast & Furious 6',
    `  and the library's research answers it with Fast & Furious 6, not The Fast and the Furious (2001) (${longFromLibrary?.title})`);
}

console.log('=== a film without the number is not the film asked for, however it is found ===');
{
  // As the relaxed search found it at 11:21, before 14dd1ed: a search that
  // lists the 1939 film among others.
  const r = await ask('fast and furios 6', { 's:fast and furios 6|': S_FAST_AND });
  ok(r.found === null, `a search listing only unnumbered films answers nothing (${r.label})`);
  // A `t=` that answers with the film without the number.
  const t = await ask('fast and furios 6', { 't:fast and furios 6|': FF_1939 });
  ok(t.found === null, `a t= hit without the 6 is not taken, nor kept as a last resort (${t.label})`);
  const famous = await ask('the fast and the furious 6', { 't:the fast and the furious 6|': TFATF_2001 });
  ok(famous.id === 'tt1905041', `nor is a famous one: "the fast and the furious 6" -> ${famous.label}, not The Fast and the Furious (2001)`);
  // The obscure-hit check: an obscure numbered hit is not traded for a
  // famous film without the number. The short is made up; its shape is
  // Ocean's 11-Year-Olds'.
  const OBSCURE_6 = film('Fast and Furious 6', 2016, 'tt9999996', { Genre: 'Short', Runtime: '9 min', imdbVotes: '12' });
  const kept = await ask('fast and furious 6', {
    't:fast and furious 6|': OBSCURE_6, 'i:tt9999996': OBSCURE_6,
    's:fast and furious 6|': hit(['Fast and Furious', 1939, 'tt0031298'], ['The Fast and the Furious', 2001, 'tt0232500']),
  });
  ok(kept.id === 'tt9999996', `an obscure "Fast and Furious 6" is not traded for an unnumbered famous film (${kept.label})`);
  // Their records are looked at since 2026-10-18 (franchiseSequel counts the
  // franchise's rated films for "die hard 3"), but with the 1939 film's votes
  // unknown the count is refused and the hit stands: no film is traded for.
  ok(kept.found?.method !== 'franchise-number', '  and the franchise count, which needs rated films, does not replace it');
  const better = await ask('fast and furious 6', {
    't:fast and furious 6|': OBSCURE_6, 'i:tt9999996': OBSCURE_6,
    's:fast and furious 6|': hit(['The Fast and the Furious', 2001, 'tt0232500'], ['Fast & Furious 6', 2013, 'tt1905041']),
  });
  ok(better.id === 'tt1905041', `while the numbered famous film still wins (${better.label})`);
}

console.log('=== the guards resolve as before ===');
{
  // Each film, by the same OMDb calls as the code before this fix made for
  // the same answers. "x2" and "f9" carry more title than was typed, are
  // checked by search, and fall back to the direct hit; "ocean's 11" is
  // answered live by `t=` with a 5-minute short, Ocean's 11-Year-Olds (2007,
  // 24 votes), and the obscure-hit check takes the well-known Ocean's 11
  // (1960) from the search. "11" is that title's own number, and every
  // Ocean's film named 11 carries it, "Eleven" included.
  for (const [text, id, want] of [
    ['rocky 2', 'tt0079817', ['t:rocky 2|', 's:rocky 2|', 'i:tt0079817']],
    ['toy story 3', 'tt0435761', ['t:toy story 3|']],
    ['x2', 'tt0290334', ['t:x2|', 's:x2|']],
    ['f9', 'tt5433138', ['t:f9|', 's:f9|']],
    ["ocean's 11", 'tt0054135', ["t:ocean's 11|", "s:ocean's 11|", 'i:tt0054135']],
    ['apollo 13', 'tt0112384', ['t:apollo 13|']],
    ['district 9', 'tt1136608', ['t:district 9|']],
    ['se7en', 'tt0114369', ['t:se7en|']],
  ]) {
    const r = await ask(text);
    ok(r.id === id && r.calls.join() === want.join(), `"${text}" -> ${r.label}, by ${r.calls.join(', ')}`);
  }
  const rockyLib = await research('rocky 2');
  ok(rockyLib?.title === 'Rocky II', `the library's research gives Rocky II for "rocky 2", not Rocky (${rockyLib?.title})`);
  for (const text of ['1917', '2012']) {
    const r = await ask(text);
    ok(r.found === null && r.calls.length === 0,
      `"${text}" is all year to OMDb's lookup, as before: no call and no film`);
  }
}

console.log('=== a title that writes its number another way still carries it ===');
{
  ok(carriesNumber('Friday the 13th', 13) && carriesNumber('Jackass 3D', 3) && carriesNumber('Step Up 3D', 3)
    && carriesNumber('Zero Dark Thirty', 30) && carriesNumber('Jackass 3.5', 3) && carriesNumber('Catch-22', 22)
    && carriesNumber('Friday the Thirteenth', 13), '"13th", "3D", "Thirty", "3.5", "Catch-22" and "Thirteenth" are read');
  ok(sequelNumber('catch twenty two') === 22 && carriesNumber('Catch-22', sequelNumber('catch twenty two')),
    '"catch twenty two" is 22, which Catch-22 carries, not 2');
  ok(sequelNumber('twenty two') === null, '"twenty two" alone is a title, not a number after one');
  for (const [text, want] of [['friday the 13', ['Friday the 13th']], ['jackass 3', ['Jackass 3D', 'Jackass 3.5']],
    ['step up 3', ['Step Up 3D']], ['zero dark 30', ['Zero Dark Thirty']]]) {
    const r = await research(text);
    ok(want.includes(r?.title), `the library's research finds "${text}" again: ${r?.title} (${r?.year}) @ ${r?.score?.toFixed(2)}`);
  }
}

console.log('=== a request ending in 1 is the first film, the bare title ===');
{
  ok(carriesNumber('John Wick', 1) && carriesNumber('Rocky', 1) && carriesNumber("Harry Potter and the Sorcerer's Stone", 1)
    && carriesNumber('Kill Bill: Vol. 1', 1), 'a title with no number, or with a 1, is film 1');
  ok(!carriesNumber('Rocky II', 1) && !carriesNumber('John Wick: Chapter 2', 1) && !carriesNumber('Ted 2', 1),
    'a title with another number is not');
  ok(carriesNumber('Fifty Shades of Grey', 1, { typed: 'fifty shades of grey 1' })
    && keepsSequelNumber('fifty shades of grey 1', hit(['Fifty Shades of Grey', 2015, 'tt2322441'])).length === 1,
  'unless the member typed that number as part of the title: "fifty shades of grey 1"');
  ok(!carriesNumber('Fifty Shades of Grey', 1), '  which a title alone does not show');
  ok(firstFilmWords('the equalizer 1') === 'equalizer' && firstFilmWords('rocky i') === 'rocky'
    && firstFilmWords('rocky 2') === null && firstFilmWords('rocky') === null, 'the words of a request for film 1, without the 1');
  // "Ted 1", 2026-10-07: resolved to Ted 2, one character from what was typed.
  ok(keepsSequelNumber('ted 1', hit(['Ted 2', 2015, 'tt2637276'], ['Ted', 2012, 'tt1637725'])).map((r) => r.Title).join() === 'Ted',
    'OMDb\'s Ted 2 is not kept for "ted 1"; Ted is');
  for (const [text, title, year] of [['john wick 1', 'John Wick', 2014], ['rocky 1', 'Rocky', 1976], ['ted 1', 'Ted', 2012],
    ['the equalizer 1', 'The Equalizer', 2014]]) {
    const r = await research(text);
    ok(r?.title === title && r?.year === year, `the library's research answers "${text}" with ${title} (${year}): ${r?.title} (${r?.year})`);
  }
  // Live, `t=` and `s=` both found nothing for "rocky 1", and its relaxed
  // search has one word ("1" is never searched), so it is the research's.
  const rocky = await ask('rocky 1');
  ok(rocky.found === null && rocky.calls.join() === 't:rocky 1|,s:rocky 1|', `"rocky 1" is left to the library by OMDb (${rocky.calls.join(', ')})`);
  ok((await research('rocky 2'))?.title === 'Rocky II', '"rocky 2" is still Rocky II');
}

console.log('=== a sequel number typed as a word holds like digits ===');
{
  for (const [text, n] of [['fast and furios six', 6], ['fast and furious six', 6], ['the fast and the furious six', 6],
    ['fast five', 5], ["ocean's eleven", 11], ['the hateful eight', 8], ['shrek the third', 3]]) {
    ok(sequelNumber(text) === n, `"${text}" ends in ${n} (${sequelNumber(text)})`);
  }
  ok(carriesNumber('Fast Five', 5) && carriesNumber("Ocean's Eleven", 11) && carriesNumber('The Hateful Eight', 8),
    '  and a title that ends in its own number word carries it');
  for (const text of ['rogue one', 'ready player one', 'avatar 3d', 'six']) {
    ok(sequelNumber(text) === null, `"${text}" is not read as a number typed`);
  }

  const typo = await ask('fast and furios six');
  ok(typo.found === null, `"fast and furios six": no film from OMDb (${typo.label})`);
  const typoLib = await research('fast and furios six');
  ok(typoLib?.title === 'Fast & Furious 6' && typoLib?.year === 2013,
    `  and the library's research gives Fast & Furious 6 (2013), not Fast & Furious (2009): ${typoLib?.title} (${typoLib?.year})`);

  const spelled = await ask('fast and furious six');
  ok(spelled.id === 'tt1905041', `"fast and furious six" -> ${spelled.label}`);
  ok(spelled.calls[2] === 's:fast furious|',
    `  searched first without the little words and the number, which the result is still held to: ${spelled.calls.join(', ')}`);

  const long = await ask('the fast and the furious six');
  ok(long.id !== 'tt0232500', `"the fast and the furious six" is not The Fast and the Furious (2001): ${long.label}`);
  const longLib = await research('the fast and the furious six');
  ok(!longLib || longLib.title === 'Fast & Furious 6', `  nor is the library's answer to it: ${longLib?.title ?? 'nothing'}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
