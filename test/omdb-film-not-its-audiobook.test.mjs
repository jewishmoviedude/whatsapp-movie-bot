/* A request resolves to the film people watch, not an audiobook, a riff
   track or a short that happens to carry its exact title.
   Run: node test/omdb-film-not-its-audiobook.test.mjs

   Found 2026-10-11 against live OMDb, through lookupMovie:
     "star wars a new hope"            -> "Star Wars: A New Hope" (1994), an
                                          audiobook, 102 votes, by `t=`
     "star wars episode 4"             -> "Star Wars: Episode III - Revenge of
                                          the Sith (Legends: Novelizations -
                                          Book 4)" (2005), an audiobook, 13
                                          votes, by search
     "star wars episode iv a new hope" -> "Star Wars Episode IV: A New Hope"
                                          (2008), a RiffTrax track, no votes
     "a new hope"                      -> "A New Hope" (2021), a short, no votes
   Only "star wars" and "star wars 1977" reached Star Wars: Episode IV - A New
   Hope (1977, tt0076759, 1,592,146 votes), which the library holds as "Star
   Wars" (1977). So a member asking the natural way was told the film was not
   in the library, and it went on the Wanted list as a title nobody can add.
   The operator's library keeper had just opened a ticket asking the host to
   rename "Star Wars" (1977) to "Star Wars: Episode IV - A New Hope"; the bot
   must find the film without that.

   The review of the first fix, the same day, found three more on live OMDb
   and offline:
     "star wars 4"                       -> "Star Wars: Annual #4" (2020), a
                                            16-minute short, no votes
     "star wars iv"                      -> "Star Wars: Tantive IV" (2020), an
                                            8-minute fan short, no votes
     "star wars the empire strikes back" -> "Mynocks from Space: A Live Staged
                                            Reading of Star Wars - The Empire
                                            Strikes Back" (2025), 34 votes
   and a new film nobody had rated yet, whose plot called it "a pointed
   commentary on empire", was traded for Jurassic World: Fallen Kingdom
   (2018), which shares its name as a subtitle.

   OMDb is a stubbed fetch here, answering with the records live OMDb gave on
   2026-10-11 (trimmed to the fields the lookup reads). Pinned:
   - the four requests resolve to tt0076759, in a handful of calls;
   - "star wars" and "star wars 1977" are unchanged, and a well-known direct
     hit ("heat") still costs one call, as does a record without imdbVotes;
   - "can you keep a secret" resolves to Can You Keep a Secret? (2019), the
     film the library holds and sent for "can you keep a secret? 2019", not a
     1976 TV play nobody has rated;
   - over-correction: an exact title somebody has rated keeps the name against
     a famous film that only shares its subtitle; a famous film whose title
     only starts with, or contains, the typed words never replaces an obscure
     film called exactly that; a typed year holds; a film from this year with
     few votes is new, not obscure; and a failing OMDb on the second opinion
     keeps the hit rather than failing the request;
   - "star wars 4", "star wars iv" and "star wars the empire strikes back"
     reach the film, the last two by search alone in three calls;
   - a film from this year is not doubted for a plot that says "commentary"
     or "the making of", nor for writers who are its whole cast, and costs
     one call; one whose record says outright it is an audiobook or a stage
     reading still is. */
import { lookupMovie, obscureReason, titleFit, searchVariants } from '../src/plugins/movie-requests/omdb.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const film = (Title, Year, imdbID, more = {}) => ({
  Title, Year: String(Year), imdbID, Type: 'movie', Response: 'True',
  Rated: 'N/A', Runtime: 'N/A', Genre: 'N/A', Writer: 'N/A', Actors: 'N/A', Plot: 'N/A', imdbVotes: 'N/A',
  ...more,
});

// The records live OMDb answered with on 2026-10-11.
const ANH = film('Star Wars: Episode IV - A New Hope', 1977, 'tt0076759', {
  Rated: 'PG', Runtime: '121 min', Genre: 'Action, Adventure, Fantasy', Writer: 'George Lucas',
  Actors: 'Mark Hamill, Harrison Ford, Carrie Fisher', imdbVotes: '1,592,146',
  Plot: "A farmboy joins forces with various allies to save their galaxy from the evil Empire's planet-destroying battle station, while also rescuing the princess leading the rebellion against them.",
});
const AUDIOBOOK = film('Star Wars: A New Hope', 1994, 'tt30061561', {
  Genre: 'Action, Fantasy, Sci-Fi', Writer: 'George Lucas', Actors: 'Tony Roberts', imdbVotes: '102',
  Plot: "An audiobook of 'Star Wars: A New Hope' narrated by Tony Roberts.",
});
const NOVELIZATION = film('Star Wars: Episode III - Revenge of the Sith (Legends: Novelizations - Book 4)', 2005, 'tt29538532', {
  Runtime: '819 min', Genre: 'Action, Fantasy, Sci-Fi', Writer: 'Matthew Stover, George Lucas', Actors: 'Jonathan Davis', imdbVotes: '13',
  Plot: "An unabridged audiobook of 'Star Wars: Episode III - Revenge of the Sith' by Matthew Stover, narrated by Jonathan Davis, based on the story and screenplay by George Lucas.",
});
const RIFFTRAX = film('Star Wars Episode IV: A New Hope', 2008, 'tt33408092', {
  Writer: 'Bill Corbett, Kevin Murphy, Michael J. Nelson', Actors: 'Bill Corbett, Kevin Murphy, Michael J. Nelson',
});
const SHORT = film('A New Hope', 2021, 'tt15607912', {
  Genre: 'Short, Drama', Writer: 'Samantha Dennis-Serhan', Actors: 'Angel Dennis-Serhan, Teddy Dennis-Serhan, Summer Dodd',
  Plot: 'When a teenage girl is socially isolated by the restrictions of lockdown during a pandemic, she finds herself looking at her surroundings from a new perspective.',
});
const PRISON_DOC = film('A New Hope', 2009, 'tt1786383', {
  Runtime: '26 min', Genre: 'Documentary, Short', Writer: 'Lisa Cheater, Amy Kossover', Actors: 'Burl Cain',
  Plot: 'Angola Prison had the reputation of being the bloodiest, most violent prison in the country, until something changed to give the inmates A New Hope.',
});
const SECRET_1976 = film('Can You Keep a Secret', 1976, 'tt1670342', {
  Genre: 'Drama', Writer: 'Peter Whitbread', Actors: 'Michael Bryant, Mary Peach, Sheila Burrell, Peter Tuddenham',
});
const SECRET_2019 = film('Can You Keep a Secret?', 2019, 'tt8707922', {
  Rated: 'TV-MA', Runtime: '94 min', Genre: 'Comedy, Romance', Writer: 'Peter Hutchings, Sophie Kinsella',
  Actors: 'Alexandra Daddario, Tyler Hoechlin, Sunita Mani', imdbVotes: '23,546',
  Plot: "Thinking they're about to crash, Emma spills her secrets to a stranger on a plane.",
});
const HEAT = film('Heat', 1995, 'tt0113277', {
  Rated: 'R', Runtime: '170 min', Genre: 'Action, Crime, Drama', Writer: 'Michael Mann',
  Actors: 'Al Pacino, Robert De Niro, Val Kilmer', imdbVotes: '820,606',
  Plot: 'A group of high-end professional thieves start to feel the heat from the LAPD.',
});
// The review's three, as live OMDb answered them the same day.
const ANNUAL_4 = film('Star Wars: Annual #4', 2020, 'tt27237036', {
  Runtime: '16 min', Genre: 'Short, Adventure', Writer: 'Cullen Bunn', Actors: 'Myles Botten, Tiffany Witcher, Kevin Urban',
  Plot: 'War consumes the galaxy. The heroic Rebel Alliance has won a major victory against the evil Galactic Empire with the destruction of the dreaded Death Star superweapon.',
});
const TANTIVE_IV = film('Star Wars: Tantive IV', 2020, 'tt27675781', {
  Runtime: '8 min', Genre: 'Short, Comedy', Writer: 'Formalin', Actors: 'Kevin Urban, Arthur Kwadijk, Gilbert Santillanes',
  Plot: "Pursued by the Empire's sinister agents, Princess Leia races home aboard her starship, custodian of the stolen plans that can save her people and restore freedom to the galaxy..",
});
const READING = film('Mynocks from Space: A Live Staged Reading of Star Wars - The Empire Strikes Back', 2025, 'tt37146846', {
  Genre: 'Comedy', Writer: 'Leigh Brackett, Lawrence Kasdan, George Lucas', Actors: 'Aristotle Athari, Diedrich Bader, Peter Bonavita',
  imdbVotes: '34',
  Plot: 'Star Wars Minute and The George Lucas Talk Show are proud to return Dynasty Typewriter to stage their LIVE reading of the original screenplay with a radical cast including some of the galaxys hottest stars (...and maybe some surpr...',
});
const ESB = film('Star Wars: Episode V - The Empire Strikes Back', 1980, 'tt0080684', {
  Rated: 'PG', Runtime: '124 min', Genre: 'Adventure, Fantasy, Sci-Fi', Writer: 'Leigh Brackett, Lawrence Kasdan, George Lucas',
  Actors: 'Mark Hamill, Harrison Ford, Carrie Fisher', imdbVotes: '1,527,433',
  Plot: 'After the Empire overpowers the Rebel Alliance, Luke Skywalker begins training with Jedi Master Yoda, while Darth Vader and bounty hunter Boba Fett pursue his friends across the galaxy.',
});

const hit = (...rows) => rows.map(([Title, Year, imdbID]) => ({ Title, Year: String(Year), imdbID, Type: 'movie' }));
const SEARCH_ANH = ['Star Wars: Episode IV - A New Hope', 1977, 'tt0076759'];
const SEARCH_DELETED = ['Star Wars: Episode IV: A New Hope - Deleted Scenes', 2011, 'tt8933914'];
const SEARCH_COMMENTARY = ['Star Wars: Episode IV - A New Hope - Audio Commentary with Screenwriter/director George Lucas, Sound Designer Ben Burtt, Visual Effects Artist Dennis Muren, and Actor Carrie Fisher', 2004, 'tt32640028'];
const SEARCH_RIFF = ['Star Wars Episode IV: A New Hope', 2008, 'tt33408092'];
const SEARCH_AUDIOBOOK = ['Star Wars: A New Hope', 1994, 'tt30061561'];

// Keyed by what was asked: `t:<title>|<year>`, `s:<term>|<year>`, `i:<id>`.
const LIVE = {
  't:star wars a new hope|': AUDIOBOOK,
  's:star wars a new hope|': hit(SEARCH_ANH, SEARCH_DELETED, SEARCH_AUDIOBOOK,
    ['Maclunkey Treasure Island: A Live Staged Reading of Star Wars - A New Hope', 2025, 'tt36328088'],
    ["The Ultimate 'Star Wars: A New Hope' Recap Cartoon", 2020, 'tt13550692'], SEARCH_COMMENTARY, SEARCH_RIFF),
  's:star wars episode 4|': hit([NOVELIZATION.Title, 2005, NOVELIZATION.imdbID]),
  's:star wars episode iv|': hit(SEARCH_ANH, SEARCH_DELETED, ['Star Wars: Episode IV - A Toy Story', 2015, 'tt4502192'],
    ['Star Wars Episode IV in 120 Seconds', 2015, 'tt6169450'], ['Star Wars: Episode IV.V - The Unknown Discovery', 2005, 'tt1996389'],
    SEARCH_COMMENTARY, SEARCH_RIFF),
  't:star wars episode iv a new hope|': RIFFTRAX,
  's:star wars episode iv a new hope|': hit(SEARCH_ANH, SEARCH_DELETED, SEARCH_COMMENTARY, SEARCH_RIFF),
  't:a new hope|': SHORT,
  's:a new hope|': hit(SEARCH_ANH, SEARCH_DELETED, ['A Christmas in New Hope', 2024, 'tt15307512'], SEARCH_AUDIOBOOK,
    ['Maclunkey Treasure Island: A Live Staged Reading of Star Wars - A New Hope', 2025, 'tt36328088'],
    ["The Ultimate 'Star Wars: A New Hope' Recap Cartoon", 2020, 'tt13550692'],
    ['Killer Bikini Vampire Girls 3: A New Hope', 2007, 'tt1123389'], ['A Bright New Hope for Mankind', 1993, 'tt1405364'],
    ['Sounds of a New Hope', 2008, 'tt1496459'], ['A New Hope', 2009, 'tt1786383']),
  't:star wars|': ANH,
  's:star wars|': hit(SEARCH_ANH, ['Star Wars: Episode V - The Empire Strikes Back', 1980, 'tt0080684'],
    ['Star Wars: Episode VI - Return of the Jedi', 1983, 'tt0086190'], ['Rogue One: A Star Wars Story', 2016, 'tt3748528']),
  't:star wars|1977': ANH,
  's:star wars|1977': hit(SEARCH_ANH, ["The Making of 'Star Wars'", 1977, 'tt0295414']),
  't:can you keep a secret|': SECRET_1976,
  's:can you keep a secret|': hit(['Can You Keep a Secret?', 2019, 'tt8707922'], ['Can You Keep a Secret', 2004, 'tt1571974'],
    ['Can You Keep a Secret', 1976, 'tt1670342'], ['Can You Keep a Secret: CKS', 2016, 'tt5649284']),
  't:heat|': HEAT,
  // `t=` found nothing for "star wars 4" or "star wars iv".
  's:star wars 4|': hit([NOVELIZATION.Title, 2005, NOVELIZATION.imdbID], ['Star Wars Forces of Destiny: Volume 4', 2018, 'tt8488114'],
    ['Lego Star Wars: Christmas Special 4', 2011, 'tt6077682'],
    ['The Making of The Star Wars Stop-Motion Theater part 4: The Iceman', 1998, 'tt9689608'], [ANNUAL_4.Title, 2020, ANNUAL_4.imdbID]),
  's:star wars iv|': hit(SEARCH_ANH, SEARCH_DELETED, ['Star Wars: Episode IV - A Toy Story', 2015, 'tt4502192'],
    ['Star Wars Episode IV in 120 Seconds', 2015, 'tt6169450'], ['Star Wars: Episode IV.V - The Unknown Discovery', 2005, 'tt1996389'],
    [TANTIVE_IV.Title, 2020, TANTIVE_IV.imdbID], SEARCH_COMMENTARY, SEARCH_RIFF),
  't:star wars the empire strikes back|': READING,
  's:star wars the empire strikes back|': hit([ESB.Title, 1980, ESB.imdbID],
    ['Star Wars: Episode V - The Empire Strikes Back: Deleted Scenes', 1980, 'tt8924990'], [READING.Title, 2025, READING.imdbID],
    ['Star Wars Episode V: The Empire Strikes Back (1980) Featuring Chris Millehan', 2018, 'tt17977512'],
    ['Star Wars: Episode V - The Empire Strikes Back (1980)', 1980, 'tt24732794'],
    ['Star Wars Episode V: The Empire Strikes Back', 2009, 'tt33408415']),
};
for (const r of [ANH, AUDIOBOOK, NOVELIZATION, RIFFTRAX, SHORT, PRISON_DOC, SECRET_1976, SECRET_2019, HEAT,
  ANNUAL_4, TANTIVE_IV, READING, ESB]) LIVE[`i:${r.imdbID}`] = r;

let table = LIVE;
const calls = [];
globalThis.fetch = async (url) => {
  const p = new URL(String(url)).searchParams;
  const key = p.get('i') ? `i:${p.get('i')}`
    : p.get('t') ? `t:${p.get('t').toLowerCase()}|${p.get('y') ?? ''}`
      : `s:${p.get('s').toLowerCase()}|${p.get('y') ?? ''}`;
  calls.push(key);
  let body = table[key] ?? { Response: 'False', Error: p.get('i') ? 'Incorrect IMDb ID.' : 'Movie not found!' };
  if (typeof body === 'function') body = body();
  if (Array.isArray(body)) body = { Response: 'True', Search: body, totalResults: String(body.length) };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};

async function ask(text, with_ = null) {
  table = with_ ? { ...LIVE, ...with_ } : LIVE;
  calls.length = 0;
  const found = await lookupMovie(text, { apiKey: 'test' });
  return { found, id: found?.movie?.imdbId ?? null, method: found?.method, calls: [...calls] };
}

console.log('=== the four requests of 2026-10-11 reach the film ===');
for (const [text, budget] of [
  ['star wars a new hope', 3],
  ['star wars episode 4', 5],
  ['star wars episode iv a new hope', 3],
  ['a new hope', 4],
]) {
  const r = await ask(text);
  ok(r.id === 'tt0076759', `"${text}" -> ${r.found?.movie?.title} (${r.found?.movie?.year})`);
  ok(r.found?.movie?.rated === 'PG', `  with the film's own rating (PG), from its own record`);
  ok(r.calls.length <= budget, `  in ${r.calls.length} OMDb calls (at most ${budget}): ${r.calls.join(', ')}`);
}

console.log('=== what already worked is unchanged ===');
for (const text of ['star wars', 'star wars 1977']) {
  const r = await ask(text);
  ok(r.id === 'tt0076759' && r.method === 'search', `"${text}" -> tt0076759 by search, as before (${r.calls.length} calls)`);
}
{
  const r = await ask('heat');
  ok(r.id === 'tt0113277' && r.method === 'direct' && r.calls.length === 1,
    'a well-known direct hit ("heat", 820,606 votes) is taken after one call');
  const bare = await ask('heat', { 't:heat|': { ...HEAT, imdbVotes: undefined } });
  ok(bare.method === 'direct' && bare.calls.length === 1,
    'a record that does not report its votes at all is taken as it comes, after one call');
}

console.log('=== an obscure exact title gives way to the film the library holds ===');
{
  const r = await ask('can you keep a secret');
  ok(r.id === 'tt8707922', `"can you keep a secret" -> ${r.found?.movie?.title} (${r.found?.movie?.year}), not the unrated 1976 TV play`);
  ok(r.calls.length === 3, `  in ${r.calls.length} calls: ${r.calls.join(', ')}`);
}

console.log('=== no over-correction ===');
{
  // The short with a real audience: a subtitle-only match no longer outranks it.
  const r = await ask('a new hope', { 't:a new hope|': { ...SHORT, imdbVotes: '400' } });
  ok(r.id === 'tt15607912' && r.method === 'direct',
    'an exact title 400 people have rated keeps "a new hope" - Star Wars only shares its subtitle');
  ok(!r.calls.includes('i:tt0076759'), '  and Star Wars, which could not outrank it, is not even fetched');
}
{
  const DUNE_OBSCURE = film('Dune', 1957, 'tt9000001', { Genre: 'Drama' });
  const r = await ask('dune', {
    't:dune|': DUNE_OBSCURE,
    's:dune|': hit(['Dune: Part Two', 2024, 'tt15239678'], ['Dune', 1957, 'tt9000001']),
    'i:tt15239678': film('Dune: Part Two', 2024, 'tt15239678', { Rated: 'PG-13', Runtime: '166 min', imdbVotes: '700,000' }),
  });
  ok(r.id === 'tt9000001', 'a famous film whose title only STARTS with the typed words ("Dune: Part Two") does not replace a film called exactly "Dune"');
  ok(!r.calls.includes('i:tt15239678'), '  and is not fetched');
}
{
  const HOPE = film('Hope', 1999, 'tt9000002', { Genre: 'Short' });
  const r = await ask('hope', { 't:hope|': HOPE, 's:hope|': hit(SEARCH_ANH, ['Hope', 1999, 'tt9000002']) });
  ok(r.id === 'tt9000002', 'a famous film that merely contains the typed word ("hope") is never taken');
}
{
  const r = await ask('star wars a new hope 1994', {
    't:star wars a new hope|1994': AUDIOBOOK,
    's:star wars a new hope|1994': hit(SEARCH_AUDIOBOOK),
  });
  ok(r.id === 'tt30061561', 'a typed year holds: "star wars a new hope 1994" is not moved to the 1977 film');
  ok(r.calls.every((c) => !c.startsWith('s:') || c.endsWith('|1994')), '  every search it made was in 1994');
}
{
  const thisYear = new Date().getUTCFullYear();
  const NEW = film('Brand New Picture', thisYear, 'tt9000003', { Rated: 'PG-13', Runtime: '101 min', Genre: 'Drama', imdbVotes: '240' });
  const r = await ask('brand new picture', { 't:brand new picture|': NEW });
  ok(r.id === 'tt9000003' && r.calls.length === 1, `a film from ${thisYear} with 240 votes is new, not obscure: one call`);
}
{
  const limit = { Response: 'False', Error: 'Request limit reached!' };
  const r = await ask('a new hope', { 's:a new hope|': limit });
  ok(r.id === 'tt15607912' && r.method === 'direct', 'OMDb failing on the search keeps the hit, as before, instead of failing the request');
  const broad = await ask('a new hope', { 's:a new hope|': { Response: 'False', Error: 'Too many results.' } });
  ok(broad.id === 'tt15607912', 'and so does "Too many results." on a request without a year');
  const late = await ask('a new hope', { 'i:tt1786383': limit });
  ok(late.id === 'tt0076759', 'a failure fetching a second candidate keeps the well-known film already found');
}

console.log('=== the review\'s three reach the film ===');
{
  const four = await ask('star wars 4');
  ok(four.id === 'tt0076759', `"star wars 4" -> ${four.found?.movie?.title} (${four.found?.movie?.year}), not the 16-minute Annual #4`);
  ok(four.calls.length <= 5 && four.calls.includes('s:star wars iv|'),
    `  by searching "star wars iv" as well, in ${four.calls.length} calls (at most 5): ${four.calls.join(', ')}`);
  const iv = await ask('star wars iv');
  ok(iv.id === 'tt0076759' && iv.method === 'search', `"star wars iv" -> ${iv.found?.movie?.title}, search's own choice over the fan short Tantive IV`);
  ok(iv.calls.length === 3 && !iv.calls.includes(`i:${TANTIVE_IV.imdbID}`), `  in 3 calls, Tantive IV never fetched: ${iv.calls.join(', ')}`);
  const esb = await ask('star wars the empire strikes back');
  ok(esb.id === 'tt0080684' && esb.method === 'search',
    `"star wars the empire strikes back" -> ${esb.found?.movie?.title} (${esb.found?.movie?.year}), not the 2025 stage reading`);
  ok(esb.calls.length === 3 && !esb.calls.includes(`i:${READING.imdbID}`), `  in 3 calls: ${esb.calls.join(', ')}`);
  const limit = await ask('star wars 4', { 's:star wars iv|': { Response: 'False', Error: 'Request limit reached!' } });
  ok(limit.id === ANNUAL_4.imdbID, 'OMDb failing on the second search for "star wars 4" keeps what it found before, not an error');
}

console.log('=== a new film is not a suspect for what only hints ===');
{
  const thisYear = new Date().getUTCFullYear();
  const JW = film('Jurassic World: Fallen Kingdom', 2018, 'tt4881806', { Rated: 'PG-13', Runtime: '128 min', imdbVotes: '360,000' });
  const fallen = (Plot) => film('Fallen Kingdom', thisYear, 'tt9000004', { Rated: 'R', Runtime: '112 min', Genre: 'Drama, War', Plot });
  const search = { 's:fallen kingdom|': hit([JW.Title, 2018, JW.imdbID], ['Fallen Kingdom', thisYear, 'tt9000004']), 'i:tt4881806': JW };
  for (const plot of ['A bleak war drama and a pointed commentary on empire.', 'Old rivalries flare during the making of a war film.']) {
    const r = await ask('fallen kingdom', { ...search, 't:fallen kingdom|': fallen(plot) });
    ok(r.id === 'tt9000004' && r.calls.length === 1,
      `a ${thisYear} film nobody has rated yet keeps its exact title, after one call, with the plot "${plot}"`);
  }
  const SPECIAL = film('Live at the Hall', thisYear, 'tt9000005', { Rated: 'TV-MA', Runtime: '62 min', Genre: 'Comedy', Writer: 'Jane Doe', Actors: 'Jane Doe' });
  const special = await ask('live at the hall', { 't:live at the hall|': SPECIAL });
  ok(special.id === 'tt9000005' && special.calls.length === 1, `a ${thisYear} stand-up special whose writer is its star is taken after one call`);

  const now = new Date(Date.UTC(2026, 9, 11));
  ok(/reading/.test(obscureReason({ title: READING.Title, year: 2025, raw: READING }, { now }) ?? ''),
    'a 2025 stage reading is still doubted in 2026: its title says outright what it is');
  const freshBook = { ...AUDIOBOOK, Year: '2026' };
  ok(/audiobook/.test(obscureReason({ title: freshBook.Title, year: 2026, raw: freshBook }, { now }) ?? ''),
    'and so is an audiobook from this year, by its plot');
  ok(obscureReason({ title: 'Fallen Kingdom', year: 2026, raw: fallen('A pointed commentary on empire.') }, { now }) === null,
    '"commentary" in a plot is no marker');
}

console.log('=== the pieces ===');
{
  ok(/audiobook/.test(obscureReason({ title: AUDIOBOOK.Title, year: 1994, raw: AUDIOBOOK }) ?? ''), 'the audiobook is flagged by its plot');
  ok(!!obscureReason({ title: NOVELIZATION.Title, year: 2005, raw: NOVELIZATION }), 'the novelization is flagged');
  ok(/riff/.test(obscureReason({ title: RIFFTRAX.Title, year: 2008, raw: RIFFTRAX }) ?? ''), 'the RiffTrax track is flagged: its writers are its cast');
  ok(obscureReason({ title: SHORT.Title, year: 2021, raw: SHORT }) === 'a short', 'the 2021 short is flagged as a short');
  ok(/unrated/.test(obscureReason({ title: SECRET_1976.Title, year: 1976, raw: SECRET_1976 }) ?? ''), 'the 1976 TV play is flagged: unrated, no runtime, no votes');
  ok(obscureReason({ title: ANH.Title, year: 1977, raw: ANH }) === null, 'the film itself is not');
  ok(obscureReason({ title: 'Barefoot', year: 2014, raw: { imdbVotes: '29,322', Rated: 'PG-13' } }) === null, 'nor is Barefoot (2014), 29,322 votes');

  const anh = titleFit('star wars a new hope', ANH.Title);
  ok(anh.names && anh.fit === 1, '"star wars a new hope" names the film once "Episode IV" is left out');
  const sub = titleFit('a new hope', ANH.Title);
  ok(sub.names && sub.fit === 0.95, '"a new hope" names it by its whole subtitle, at 0.95');
  const two = titleFit('the godfather', 'The Godfather Part II');
  ok(!two.names && two.fit < 1, 'numbering at the end is not dropped: "The Godfather Part II" is not "the godfather"');
  ok(!titleFit('hope', ANH.Title).names, 'one word of a subtitle is not the subtitle');
  ok(!titleFit('dune', 'Dune: Part Two').names, '"Dune: Part Two" does not name "dune"');
  for (const typed of ['star wars 4', 'star wars iv', 'star wars episode 4', 'star wars episode iv']) {
    const f = titleFit(typed, ANH.Title);
    ok(f.names && f.fit === 1, `"${typed}" names the film by its name and number`);
  }
  ok(!titleFit('star wars 5', ANH.Title).names, 'another number does not');
  const bare = titleFit('star wars', ANH.Title);
  ok(!bare.names && bare.fit < 1, '"star wars" alone is not read as Episode IV, or any one episode');
  ok(!titleFit('star wars 4', 'Star Wars: Episode IV.V - The Unknown Discovery').names, '"Episode IV.V" is not numbered IV');
  ok(!titleFit('star wars 4', 'Star Wars Episode IV in 120 Seconds').names, 'nor is "Episode IV in 120 Seconds"');
  ok(titleFit('john wick 4', 'John Wick: Chapter 4').names, 'numbering at the end reads by name and number too: "John Wick: Chapter 4"');
  ok(!titleFit('the godfather', 'The Godfather Part II').names && titleFit('the godfather 2', 'The Godfather Part II').names,
    '"The Godfather Part II" is "the godfather 2", never "the godfather"');

  ok(searchVariants('star wars episode 4', NOVELIZATION.Title)[0] === 'star wars episode iv', '"episode 4" is searched again as "episode iv"');
  ok(searchVariants('star wars episode iv a new hope', '')[0] === 'star wars episode 4 a new hope', 'and "episode iv" as "episode 4"');
  ok(searchVariants('rocky iv', '')[0] === 'rocky 4', 'a closing numeral is swapped');
  ok(searchVariants('malcolm x', '').length === 0, 'but not a lone letter: "Malcolm X" is not "Malcolm 10"');
  ok(searchVariants('star wars a new hope', AUDIOBOOK.Title).includes('A New Hope'), "the obscure hit's subtitle is searched alone");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
