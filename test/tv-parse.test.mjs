/* TV request parsing + episode naming. Run: node test/tv-parse.test.mjs */
import { parseTvRequest, isSingleEpisode, describeRequest, pad, stripTrailingYear, seasonSpans, listCode, MAX_SEASON_SPAN, codeLeftIn } from '../src/plugins/tv-requests/parse.js';
import { episodeFileName, episodeLabel, episodeOrder, sanitizeSegment } from '../src/plugins/tv-requests/naming.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const p = (t) => parseTvRequest(t);

console.log('=== the format from the spec ===');
{
  const r = p('The Boys S01E01');
  ok(r.show === 'The Boys' && r.season === 1 && r.episode === 1, '"The Boys S01E01" -> show/season/episode');
}

console.log('=== every way people write it ===');
const shapes = [
  ['The Boys S01E01', 'The Boys', 1, 1],
  ['the boys s1e1', 'the boys', 1, 1],
  ['The Boys S01 E01', 'The Boys', 1, 1],
  ['The Boys S01.E01', 'The Boys', 1, 1],
  ['The Boys s02e10', 'The Boys', 2, 10],
  ['The Boys 1x01', 'The Boys', 1, 1],
  ['The Boys 2x05', 'The Boys', 2, 5],
  ['The Boys season 1 episode 1', 'The Boys', 1, 1],
  ['The Boys Season 2 Episode 5', 'The Boys', 2, 5],
  ['The Boys series 2 ep 3', 'The Boys', 2, 3],
  ['Breaking Bad S05E14 Ozymandias', 'Breaking Bad', 5, 14],
  ['The Office S09E23', 'The Office', 9, 23],
];
for (const [input, show, season, episode] of shapes) {
  const r = p(input);
  ok(r.show === show && r.season === season && r.episode === episode,
    `${JSON.stringify(input)} -> ${show} S${pad(season)}E${pad(episode)}`);
}

console.log('=== whole-season requests ===');
{
  for (const [input, show, season] of [
    ['The Boys season 2', 'The Boys', 2],
    ['The Boys S02', 'The Boys', 2],
    ['The Boys s3', 'The Boys', 3],
    ['Breaking Bad Season 5', 'Breaking Bad', 5],
  ]) {
    const r = p(input);
    ok(r.show === show && r.season === season && r.episode === null, `${JSON.stringify(input)} -> whole season ${season}`);
    ok(isSingleEpisode(r) === false, `  ...and is not a single episode`);
  }
}

console.log('=== show names containing numbers are NOT mangled ===');
{
  // The whole reason a bare trailing number is never read as a season.
  for (const title of ['24', '9-1-1', 'Stranger Things 4', 'Chicago PD', 'Brooklyn Nine-Nine', 'Star Trek Picard']) {
    const r = p(title);
    ok(r.show === title && r.season === null && r.episode === null, `${JSON.stringify(title)} stays intact as the show name`);
  }
  // ...but an explicit marker still works on those shows
  const r = p('9-1-1 S02E03');
  ok(r.show === '9-1-1' && r.season === 2 && r.episode === 3, '"9-1-1 S02E03" still parses correctly');
  const r2 = p('24 season 3');
  ok(r2.show === '24' && r2.season === 3, '"24 season 3" parses the season, keeps the title');
}

console.log('=== show only ===');
{
  const r = p('The Boys');
  ok(r.show === 'The Boys' && r.season === null && r.episode === null, 'bare show name -> no season/episode');
  ok(p('').show === '', 'empty input is safe');
  ok(p(null).show === '', 'null is safe');
}

console.log('=== a marker with no show is not a request ===');
{
  const r = p('S01E01');
  ok(r.season === null && r.show === 'S01E01', 'a bare "S01E01" is not treated as a parsed request');
}

console.log('=== "episode 5" with no season ===');
{
  const r = p('The Boys episode 5');
  ok(r.show === 'The Boys' && r.episode === 5 && r.season === null, 'episode without a season is captured and flagged');
  ok(r.matched === 'episode-only', 'flagged so the caller can confirm which season');
}

console.log('=== describeRequest ===');
ok(describeRequest(p('The Boys S01E01')) === 'The Boys S01E01', 'episode described');
ok(describeRequest(p('The Boys season 2')) === 'The Boys season 2', 'season described');
ok(describeRequest(p('The Boys')) === 'The Boys', 'show described');
ok(describeRequest(null) === '(nothing)', 'null is safe');

console.log('=== episodeFileName — the agreed format ===');
{
  ok(episodeFileName({ series: 'The Boys', season: 1, episode: 1, title: 'Pilot' }) === 'The Boys S01E01 Pilot.mp4',
    'exactly "The Boys S01E01 Pilot.mp4"');
  ok(episodeFileName({ series: 'The Boys', season: 10, episode: 100, title: 'X' }) === 'The Boys S10E100 X.mp4',
    'three-digit episodes are not truncated');
  ok(episodeFileName({ series: 'Breaking Bad', season: 5, episode: 14, title: 'Ozymandias' }) === 'Breaking Bad S05E14 Ozymandias.mp4',
    'zero-padded to two digits');
  ok(episodeFileName({ series: 'The Boys', season: 1, episode: 1 }) === 'The Boys S01E01.mp4',
    'no trailing space when the episode has no title');
}

console.log('=== filenames stay safe ===');
{
  const n = episodeFileName({ series: 'Law & Order: SVU', season: 1, episode: 2, title: 'What/Who?' });
  ok(!/[\\/:*?"<>|]/.test(n), `illegal characters removed: ${n}`);
  ok(n.endsWith('.mp4'), 'keeps the extension');
  ok(!/\s\s/.test(n), 'no double spaces left behind');

  const long = episodeFileName({ series: 'Show', season: 1, episode: 1, title: 'T'.repeat(400) });
  ok(long.length <= 150, `a very long title is trimmed (${long.length} chars)`);
  ok(long.startsWith('Show S01E01'), 'the show and episode code always survive trimming');
  ok(long.endsWith('.mp4'), 'still ends with the extension');

  ok(episodeFileName({}) === 'Unknown Show S00E00.mp4', 'missing metadata degrades predictably');
  ok(sanitizeSegment('a/b:c') === 'a b c', 'sanitizeSegment collapses separators');
}

console.log('=== episodes send in broadcast order ===');
{
  const eps = [
    { season: 1, episode: 10, title: 'j' }, { season: 1, episode: 2, title: 'b' },
    { season: 2, episode: 1, title: 'a' }, { season: 1, episode: 1, title: 'a' },
  ];
  const sorted = [...eps].sort(episodeOrder).map((e) => `S${pad(e.season)}E${pad(e.episode)}`);
  ok(sorted.join(',') === 'S01E01,S01E02,S01E10,S02E01', `natural order, not lexical: ${sorted.join(',')}`);
}

console.log('=== episodeLabel ===');
ok(episodeLabel({ series: 'The Boys', season: 1, episode: 1 }) === 'The Boys S01E01', 'label for reactions and logs');

console.log('=== a trailing year must not break matching (the 📅 trap) ===');
{
  // The movie legend told people to "add the year"; doing that to a TV request
  // dropped the title similarity under the match threshold, so the bot said
  // "not in the library" for a show it had.
  ok(stripTrailingYear('The Boys 2019').show === 'The Boys', '"The Boys 2019" -> "The Boys"');
  ok(stripTrailingYear('The Boys 2019').year === 2019, 'the year is captured, not lost');
  ok(stripTrailingYear('The Boys').show === 'The Boys', 'no year -> unchanged');
  // shows literally named after numbers must survive
  for (const t of ['24', '1883', '1923', '1899']) {
    ok(stripTrailingYear(t).show === t, `"${t}" is a show name, not a year`);
  }
  ok(stripTrailingYear('Stranger Things 4').show === 'Stranger Things 4', 'a season-looking number is left alone');
  ok(stripTrailingYear('').show === '', 'empty is safe');
  ok(stripTrailingYear(null).show === '', 'null is safe');
}

console.log('=== a bare trailing E14 is an episode (Fullmetal alchemist E14 incident) ===');
{
  // "Fullmetal alchemist E14" was answered "no series matching": the "E14" stayed
  // in the show name and pushed the title similarity under the threshold.
  const r = p('Fullmetal alchemist E14');
  ok(r.show === 'Fullmetal alchemist' && r.episode === 14 && r.season === null, '"Fullmetal alchemist E14" -> show + episode 14');
  ok(p('Fullmetal alchemist e 3').episode === 3, 'lowercase with a space');
  ok(p('The Boys S01E01').season === 1, 'S01E01 still wins');
  ok(p('E14').show === 'E14' && p('E14').episode === null, 'a lone "E14" is not a request with no show');
  ok(p('Wall-E').episode === null, '"Wall-E" is a title');
}

console.log('=== a run of episodes is one request for exactly those episodes ===');
{
  // An audit of the TV place-in-line code (2026-09-29) found that "The Office
  // S01E01-E05", "S01E01-05" and "S1 E3-6" were read as their first episode
  // alone: the single-episode pattern matched the first half and the rest was
  // taken for the episode's title. One episode was queued and nothing said
  // the other four were dropped.
  const range = (input, show, season, from, to) => {
    const r = p(input);
    ok(r.show === show && r.season === season && r.episode === null
      && r.episodeRange?.from === from && r.episodeRange?.to === to,
    `${JSON.stringify(input)} -> ${show}, season ${season}, episodes ${from} to ${to} (got ${JSON.stringify({ show: r.show, season: r.season, episode: r.episode, range: r.episodeRange })})`);
  };
  range('The Office S01E01-E05', 'The Office', 1, 1, 5);
  range('The Office S01E01-05', 'The Office', 1, 1, 5);
  range('The Office S1 E3-6', 'The Office', 1, 3, 6);
  range('The Office S01E01 - S01E05', 'The Office', 1, 1, 5);
  range('The Office S01E01 to E05', 'The Office', 1, 1, 5);
  range('The Office S02E03–E07', 'The Office', 2, 3, 7);
  range('The Office 1x01-1x05', 'The Office', 1, 1, 5);
  range('The Office 1x01-05', 'The Office', 1, 1, 5);
  range('The Office season 1 episodes 3-6', 'The Office', 1, 3, 6);
  range('The Office S1 episodes 3 to 6', 'The Office', 1, 3, 6);
  range('The Office episodes 3-5', 'The Office', null, 3, 5);
  ok(isSingleEpisode(p('The Office S01E01-E05')) === false, 'a range is not a single episode');
  ok(describeRequest(p('The Office S01E01-05')) === 'The Office S01E01–E05', `described by its codes (${describeRequest(p('The Office S01E01-05'))})`);
  ok(describeRequest(p('The Office episodes 3-5')) === 'The Office episodes 3–5', 'and without a season');
}

console.log('=== ...but what only looks like a range is left alone ===');
{
  const one = (input, show, season, episode) => {
    const r = p(input);
    ok(r.show === show && r.season === season && r.episode === episode && !r.episodeRange,
      `${JSON.stringify(input)} -> one episode, S${pad(season)}E${pad(episode)} (got ${JSON.stringify({ show: r.show, season: r.season, episode: r.episode, range: r.episodeRange })})`);
  };
  one('24 S01E02 - 1:00 A.M.', '24', 1, 2);                  // a title that starts with a clock time
  one('Lost S01E05 - 3 Days Later', 'Lost', 1, 5);           // a title that starts with a smaller number
  one('The Office S01E20-S02E03', 'The Office', 1, 20);     // across two seasons: not read as a range
  one('Breaking Bad S05E14 Ozymandias', 'Breaking Bad', 5, 14);
  one('The Office S01E01', 'The Office', 1, 1);
}

console.log('=== several seasons are each asked for ===');
{
  // The same audit: "The Office S01 S02", "season 1 and 2" and "S01-S03" queued
  // season 1 only, and "The Office seasons 1-3" had no season at all - the
  // whole phrase became the show name, matched nothing, and the member got 📬.
  const many = (input, show, seasons) => {
    const r = p(input);
    ok(r.show === show && JSON.stringify(r.seasons) === JSON.stringify(seasons) && r.season === seasons[0] && r.episode === null,
      `${JSON.stringify(input)} -> ${show}, seasons ${seasons.join(', ')} (got ${JSON.stringify({ show: r.show, season: r.season, seasons: r.seasons })})`);
  };
  many('The Office S01 S02', 'The Office', [1, 2]);
  many('The Office season 1 and 2', 'The Office', [1, 2]);
  many('The Office S01-S03', 'The Office', [1, 2, 3]);
  many('The Office seasons 1-3', 'The Office', [1, 2, 3]);
  many('The Office seasons 1 to 3', 'The Office', [1, 2, 3]);
  many('The Office season 1, 2 and 3', 'The Office', [1, 2, 3]);
  many('The Office S01 & S02', 'The Office', [1, 2]);
  many('The Office season 1 and season 2', 'The Office', [1, 2]);
  many('The Office S1-3', 'The Office', [1, 2, 3]);
  many('The Office S03-S01', 'The Office', [1, 2, 3]);
  ok(!p('The Office seasons 2 and 2').seasons && p('The Office seasons 2 and 2').season === 2,
    'the same season twice is one season, not a list');
  ok(describeRequest(p('The Office seasons 1-3')) === 'The Office seasons 1, 2 and 3', 'described as a list');
}

console.log('=== a range wider than any show is not expanded ===');
{
  // Found in review (2026-09-29): "seasons 1-99" was read as ninety-nine
  // seasons, a lookup each. How many seasons one message queues is a setting
  // (tvRequests.maxSeasonsPerRequest, test/tv-multi-season); this keeps the
  // list itself sane.
  const wide = p('The Simpsons seasons 1-99');
  ok(wide.show === 'The Simpsons' && wide.season === 1 && !wide.seasons,
    `"seasons 1-99" is not ninety-nine seasons: the season before the range stands alone (${JSON.stringify({ season: wide.season, seasons: wide.seasons })})`);
  const snl = p(`Saturday Night Live seasons 1-${MAX_SEASON_SPAN}`);
  ok(snl.seasons?.length === MAX_SEASON_SPAN, `a range as long as the longest show (${MAX_SEASON_SPAN} seasons) still is (${snl.seasons?.length})`);
  const simpsons = p('The Simpsons S1-S35');
  ok(simpsons.seasons?.length === 35 && simpsons.seasons[34] === 35, 'and "S1-S35" is thirty-five');
}

console.log('=== a long list of seasons is written by its runs ===');
{
  ok(seasonSpans([4, 5, 6, 7, 8, 30, 29, 28]) === '4–8 and 28–30', `runs of three or more by their ends (${seasonSpans([4, 5, 6, 7, 8, 30, 29, 28])})`);
  ok(seasonSpans([1, 2]) === '1 and 2' && seasonSpans([3]) === '3' && seasonSpans([1, 2, 4]) === '1, 2 and 4',
    `and anything shorter as a list (${seasonSpans([1, 2, 4])})`);
}

console.log('=== ...but one season stays one season ===');
{
  const r = p('The Boys season 2 2019');
  ok(r.season === 2 && !r.seasons, 'a year after the season is not a second season');
  ok(p('24 season 3').season === 3 && !p('24 season 3').seasons, '"24 season 3" is one season');
  ok(p('Stranger Things 4').season === null, 'a title with a number in it has no season');
  const e = p('The Boys season 2, episode 5');
  ok(e.season === 2 && e.episode === 5 && !e.seasons, '"season 2, episode 5" is one episode, not two seasons');
  const e2 = p('The Boys season 2 and episode 5');
  ok(e2.season === 2 && e2.episode === 5 && !e2.seasons, '"season 2 and episode 5" too');
  ok(!p('The Boys S02').seasons && !p('The Boys season 2').seasons, 'and a single season carries no list');
}

// Incident 2026-10-01: "TheResidentSeason3" came back "no series matching",
// though The Resident is in the library; the request had no spaces.
console.log('=== a request typed with no spaces ===');
{
  const r = p('TheResidentSeason3');
  ok(r.show === 'The Resident' && r.season === 3, '"TheResidentSeason3" -> The Resident, season 3');
  ok(p('SpongeBob').show === 'SpongeBob', 'one camel-case word is left alone');
  ok(p('The Resident Season 3').show === 'The Resident', 'spaced requests are unchanged');
}

// The operator, 2026-10-12: "if it's a dash it's 4 through 10, comma then
// it'll only be those 2, comprendo?". "The Office s01 e06, e09" was S01E06
// alone: a list with a gap in it kept its first episode and dropped the rest.
const list = (input, show, season, episodes) => {
  const r = p(input);
  ok(r.show === show && r.season === season && r.episode === null && !r.episodeRange
    && JSON.stringify(r.episodeList) === JSON.stringify(episodes),
  `${JSON.stringify(input)} -> ${show}, season ${season}, episodes ${episodes.join(', ')} (got ${JSON.stringify({ show: r.show, season: r.season, episode: r.episode, range: r.episodeRange, list: r.episodeList })})`);
};
console.log('=== a comma list is those episodes, and only those ===');
{
  list('The Office s01 e06, e09', 'The Office', 1, [6, 9]);
  list('The Office S01E06, E09', 'The Office', 1, [6, 9]);
  list('The Office S01E06,E09', 'The Office', 1, [6, 9]);
  list('The Office S01 E06, E09', 'The Office', 1, [6, 9]);
  list('THE OFFICE S01 E06, E09', 'THE OFFICE', 1, [6, 9]);
  list('The Office S01E06, 09', 'The Office', 1, [6, 9]);
  list('The Office S01E06 & E09', 'The Office', 1, [6, 9]);
  list('The Office S01E06 and E09', 'The Office', 1, [6, 9]);
  list('The Office S01E06, S01E09', 'The Office', 1, [6, 9]);
  list('The Office S01-e06, e09', 'The Office', 1, [6, 9]);       // the TV group's description
  list('The Office S01, E06, E09', 'The Office', 1, [6, 9]);
  list('The Office 1x06, 1x09', 'The Office', 1, [6, 9]);
  list('The Office season 1 episode 3 and 5', 'The Office', 1, [3, 5]);
  list('The Office S01E02, E05, and E09', 'The Office', 1, [2, 5, 9]);
  list('The Office S01E09, E06', 'The Office', 1, [6, 9]);
  // With no separator but a space, each episode needs its marker ("s1 e11
  // e12" was already a run), and a gap was dropped all the same.
  list('The Office s01 e06 e09', 'The Office', 1, [6, 9]);
  // A dash between two episode numbers is "through", inside a list too.
  list('The Office S01E04-E07, E09', 'The Office', 1, [4, 5, 6, 7, 9]);
  list('The Office S01E01-E03, E05-E06', 'The Office', 1, [1, 2, 3, 5, 6]);
  list('The Office S01E01, E03-E05', 'The Office', 1, [1, 3, 4, 5]);
  list('The Office S01E04 to E07 and E09', 'The Office', 1, [4, 5, 6, 7, 9]);
  // With no season, "which season?" settles it.
  list('The Office episodes 3, 5', 'The Office', null, [3, 5]);
  list('Fullmetal alchemist E14, E16', 'Fullmetal alchemist', null, [14, 16]);
  ok(isSingleEpisode(p('The Office S01E06, E09')) === false, 'a list is not a single episode');
}

console.log('=== ...a dash is still "through", and a list with no gap a run ===');
{
  const r = p('Outer Banks S05E04-E10');
  ok(r.season === 5 && r.episodeRange?.from === 4 && r.episodeRange?.to === 10 && !r.episodeList, '"Outer Banks S05E04-E10" is E04 through E10');
  const run = p('The Office S01E04-E07, E08');
  ok(run.episodeRange?.from === 4 && run.episodeRange?.to === 8 && !run.episodeList, `"S01E04-E07, E08" has no gap: E04 to E08 (${JSON.stringify(run.episodeRange)})`);
  const one = p('The Office S01, E06');
  ok(one.season === 1 && one.episode === 6, `"S01, E06" is S01E06, not the whole of season 1 (${JSON.stringify({ season: one.season, episode: one.episode })})`);
  const oneRun = p('The Office S01, E04-E07');
  ok(oneRun.episodeRange?.from === 4 && oneRun.episodeRange?.to === 7, '"S01, E04-E07" is E04 to E07');
}

// "#request drake and josh S01 e03-e04-e05-e06-e07" (2026-10-12 21:32 UTC)
// queued "Drake & Josh S01E03–E04 — 2 episode(s)": a run ended at its first
// dash. Every dash is "through", so a chain of them is one run, first to last.
console.log('=== a chain of dashes is one run, from its first episode to its last ===');
{
  const run = (input, show, season, from, to) => {
    const r = p(input);
    ok(r.show === show && r.season === season && r.episode === null && !r.episodeList
      && r.episodeRange?.from === from && r.episodeRange?.to === to,
    `${JSON.stringify(input)} -> ${show}, season ${season}, E${pad(from)} through E${pad(to)} (got ${JSON.stringify({ show: r.show, season: r.season, range: r.episodeRange, list: r.episodeList })})`);
  };
  run('drake and josh S01 e03-e04-e05-e06-e07', 'drake and josh', 1, 3, 7);
  run('drake and josh S01 e03 -e04-e05-e06-e07', 'drake and josh', 1, 3, 7);
  run('The Office S01-e04-e07', 'The Office', 1, 4, 7);            // the TV group's own example
  run('The Office S01E03-04-05', 'The Office', 1, 3, 5);
  run('The Office S01E03-04-05 please', 'The Office', 1, 3, 5);
  run('The Office S01 e03 - e04 - e05', 'The Office', 1, 3, 5);
  run('The Office season 1 episodes 3-4-5', 'The Office', 1, 3, 5);
  run('The Office 1x03-1x04-1x05', 'The Office', 1, 3, 5);
  run('The Office S01, e03-e04-e05', 'The Office', 1, 3, 5);
  run('The Office episodes 3-4-5', 'The Office', null, 3, 5);
  // Mixed with commas, each chain is a run of the list.
  list('The Office e01-e02-e03, e05', 'The Office', null, [1, 2, 3, 5]);
  list('The Office S01E01-E02-E03, E05-E06-E07', 'The Office', 1, [1, 2, 3, 5, 6, 7]);
  list('The Office S01E01-E03, E05', 'The Office', 1, [1, 2, 3, 5]);
  // A chain goes forwards, in one season, and stops short of a title.
  run('The Office S01E03-E05-E04', 'The Office', 1, 3, 5);
  run('The Office S01E03-E04-S02E05', 'The Office', 1, 3, 4);
  run('Lost S01E01-E02 - 3 Days Later', 'Lost', 1, 1, 2);
  run('24 S01E01-E02 - 1:00 A.M.', '24', 1, 1, 2);
}

console.log('=== ...without misreading titles, years or seasons ===');
{
  const lr = p('Love, Death & Robots S01E01');
  ok(lr.show === 'Love, Death & Robots' && lr.season === 1 && lr.episode === 1, `"Love, Death & Robots S01E01" is one episode of that show (${lr.show})`);
  const lr2 = p('Love, Death & Robots S01E01 & E03');
  ok(lr2.show === 'Love, Death & Robots' && lr2.episodeList?.join() === '1,3', `and "... S01E01 & E03" two of it (${lr2.show}: ${lr2.episodeList})`);
  const lo = p('Law & Order S01E01, E03');
  ok(lo.show === 'Law & Order' && lo.season === 1 && lo.episodeList?.join() === '1,3', `"Law & Order S01E01, E03" -> Law & Order, E01 and E03 (${lo.show}: ${lo.episodeList})`);
  const y = p('The Office 2005 S01E06, E09');
  ok(y.show === 'The Office 2005' && y.episodeList?.join() === '6,9', 'a year before the list stays with the show');
  const y2 = p('The Office S01E06, E09 2005');
  ok(y2.episodeList?.join() === '6,9', 'and one after it is not an episode');
  const s = p('The Office season 1, 2');
  ok(JSON.stringify(s.seasons) === '[1,2]' && !s.episodeList, '"season 1, 2" is still two seasons');
  const s2 = p('The Office S01, S02');
  ok(JSON.stringify(s2.seasons) === '[1,2]' && !s2.episodeList, '"S01, S02" too');
  const e = p('The Boys season 2, episode 5');
  ok(e.season === 2 && e.episode === 5 && !e.episodeList, '"season 2, episode 5" is still one episode');
  const one = (input, show, season, episode) => {
    const r = p(input);
    ok(r.show === show && r.season === season && r.episode === episode && !r.episodeList && !r.episodeRange,
      `${JSON.stringify(input)} -> one episode, S${pad(season)}E${pad(episode)} (got ${JSON.stringify({ show: r.show, season: r.season, episode: r.episode, list: r.episodeList })})`);
  };
  one('The Office S01E06, E06', 'The Office', 1, 6);              // the same episode twice
  one('The Office S01E06, S02E09', 'The Office', 1, 6);           // one request is one season
  one('The Office S01E06 and 2 more', 'The Office', 1, 6);        // words, not an episode 2
  one('Lost S01E05 3 Days Later', 'Lost', 1, 5);                  // a title after a space
  one('24 S01E02, 1:00 A.M.', '24', 1, 2);                        // a clock time
}

console.log('=== a list is named compactly ===');
{
  ok(describeRequest(p('The Office S01E04-E07, E09')) === 'The Office S01E04–E07, E09', `"${describeRequest(p('The Office S01E04-E07, E09'))}"`);
  ok(describeRequest(p('The Office S01E06, E09')) === 'The Office S01E06, E09', 'two episodes by their codes');
  ok(describeRequest(p('The Office episodes 3, 5')) === 'The Office episodes 3 and 5', 'and without a season');
  ok(listCode(1, [1, 2, 3, 5, 6]) === 'S01E01–E03, E05, E06', `a run of three or more by its ends, as withheld episodes are (${listCode(1, [1, 2, 3, 5, 6])})`);
  ok(listCode(null, [30]) === 'E30', 'one episode, no season');
}

console.log('=== the letter O typed for a zero is not read as one (the operator, 2026-10-19: an improper request) ===');
{
  const r = p("Georgie & Mandy's First Marriage SO1E11-E20");
  ok(r.season == null && codeLeftIn(r.show) != null, `SO1E11-E20 is not read as a code, and is left for ✍️ (${JSON.stringify(r.show)})`);
  ok(codeLeftIn(p('the American so1eo1').show) === 'so1eo1', '"so1eo1" is left for ✍️');
  ok(p('Soe Show S01E02').show === 'Soe Show', 'a word starting with So is left alone');
}

console.log('=== a season typed as a word (Chad powers season two, 2026-10-18) ===');
{
  const a = p('Chad powers season two');
  ok(a.show === 'Chad powers' && a.season === 2, '"season two" is season 2 of the show');
  const b = p('Chad Powers second season');
  ok(b.show === 'Chad Powers' && b.season === 2, '"second season" is season 2');
  const c = p('The Boys series three episode 4');
  ok(c.show === 'The Boys' && c.season === 3 && c.episode === 4, '"series three episode 4" reads both');
  ok(p('Ten Percent').show === 'Ten Percent', 'a number word without a season word is left alone');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
