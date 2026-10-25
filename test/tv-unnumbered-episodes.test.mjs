/* A season's episodes Jellyfin could not number are still sent.
   Run: node test/tv-unnumbered-episodes.test.mjs

   2026-10-06: Ari (+1555***0178) asked for Frieren season 1 and was sent 3
   episodes, then asked again. 25 of the 28 files in the "Season 1" folder
   were named the way fansub groups name anime ("Erai-raws.Sousou.no.Frieren-
   25.720p..."), so Jellyfin gave them no season or episode number, and the
   bot asked for "?season=1", which filters on that number. The hourly check
   called it a content gap. Asked by the folder, every file comes back, and an
   unnumbered one is numbered from its file name. */
import { listEpisodes, episodeNumberFromName } from '../src/plugins/tv-requests/jellyfin-tv.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

console.log('=== the number in a file name ===');
for (const [name, n] of [
  ['Season 1/Erai-raws.Sousou.no.Frieren-25.720pMultiple.SubtitleED015959_720p.mp4', 25],
  ['Erai-raws.Sousou.no.Frieren.-.16.720pMultiple.Subtitle746004C5_720p.mp4', 16],
  ['SubsPlease..Sousou.no.Frieren-20.720p..-.75847840._720p.mp4', 20],
  ['Frieren - S01E26 - The Height of Magic.mkv', 26],
  ['[SubsPlease] 86 Eighty-Six - 05 (1080p).mkv', 5],
  ['Show.Name.E07.mkv', 7],
  ['Show 03v2.mkv', 3],
  ['Some Film 2023 1080p.mkv', null],
  ['no number here.mkv', null],
]) ok(episodeNumberFromName(name) === n, `${name} -> ${n}`);

// Jellyfin as it held Frieren: the Season 1 folder, 3 numbered, the rest not
// (episode 8 twice), and "?season=1" returning only the numbered three.
const SEASON1 = 'season-1-id';
const file = (n, numbered) => ({
  Id: `ep${n}${numbered ? 'n' : 'u'}`, SeriesName: "Frieren: Beyond Journey's End", SeasonId: SEASON1,
  ...(numbered ? { ParentIndexNumber: 1, IndexNumber: n } : {}),
  Name: numbered ? `Episode ${n}` : `Erai-raws.Sousou.no.Frieren-${String(n).padStart(2, '0')}.720pMultiple`,
  Path: numbered ? `/tv/Frieren/Season 1/Frieren - S01E${String(n).padStart(2, '0')}.mp4`
    : `/tv/Frieren/Season 1/Erai-raws.Sousou.no.Frieren-${String(n).padStart(2, '0')}.720pMultiple.SubtitleABC_720p.mp4`,
});
const FOLDER = [
  ...[5, 8, 26].map((n) => file(n, true)),
  ...[...Array(28).keys()].map((i) => i + 1).filter((n) => ![5, 26, 28].includes(n)).map((n) => file(n, false)),
];
const asked = [];
const jellyfin = (seasonsOk = true) => async (url) => {
  const u = new URL(url);
  asked.push(u.pathname + u.search);
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  if (u.pathname.endsWith('/Seasons')) {
    if (!seasonsOk) return { ok: false, status: 500, statusText: 'boom', json: async () => ({}) };
    return json({ Items: [{ Id: SEASON1, IndexNumber: 1, Name: 'Season 1', ChildCount: 28 }, { Id: 'season-2-id', IndexNumber: 2, ChildCount: 10 }] });
  }
  if (u.searchParams.get('seasonId') === SEASON1) return json({ Items: FOLDER });
  if (u.searchParams.get('season') === '1') return json({ Items: FOLDER.filter((e) => e.IndexNumber != null) });
  return json({ Items: [] });
};
const opts = { base: 'http://jf', token: 't', userId: 'u' };

console.log('=== the season, asked for by its folder ===');
{
  const eps = await listEpisodes('frieren', { ...opts, season: 1, fetchImpl: jellyfin() });
  const nums = eps.map((e) => e.episode).sort((a, b) => a - b);
  ok(asked.some((a) => a.includes('season=1')) && asked.some((a) => a.includes('seasonId=season-1-id')),
    'asked for season 1, it holds 28 and gave 3: the Season 1 folder is asked for too');
  ok(eps.length === 27, `27 episodes, not 3 (${eps.length})`);
  ok(nums.join() === [...Array(27).keys()].map((i) => i + 1).join(), 'numbered 1 to 27, every one');
  ok(eps.every((e) => e.season === 1), 'all in season 1');
  const eight = eps.filter((e) => e.episode === 8);
  ok(eight.length === 1 && eight[0].id === 'ep8n', 'episode 8, there twice: the copy Jellyfin numbered, once');
  ok(eps.find((e) => e.episode === 25)?.numberedFromName === true && !eps.find((e) => e.episode === 5).numberedFromName,
    'and what was numbered from a file name says so');
}

console.log('=== when the seasons cannot be listed, as before ===');
{
  asked.length = 0;
  const eps = await listEpisodes('frieren', { ...opts, season: 1, fetchImpl: jellyfin(false) });
  ok(asked.some((a) => a.includes('season=1')) && eps.length === 3, `asked by number, the three it numbered (${eps.length})`);
  ok(eps.every((e) => !e.numberedFromName), 'and nothing is guessed outside a season folder');
}

console.log('=== a season that came back whole costs nothing more ===');
{
  asked.length = 0;
  const whole = async (url) => {
    const u = new URL(url);
    asked.push(u.pathname + u.search);
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    if (u.pathname.endsWith('/Seasons')) return json({ Items: [{ Id: SEASON1, IndexNumber: 1, ChildCount: 2 }] });
    return json({ Items: [file(1, true), file(2, true)] });
  };
  const eps = await listEpisodes('show', { ...opts, season: 1, fetchImpl: whole });
  ok(eps.length === 2 && !asked.some((a) => a.includes('seasonId=')), 'two asked, two held: the folder is not fetched');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
