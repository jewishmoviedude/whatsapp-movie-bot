// "avatar the last airbender season 3" was answered "we don't have season 3"
// (BATMAN, 2026-09-27), and Ari raised it as #issue #04 on 2026-10-11: the
// library holds the 2024 live action "Avatar the Last Airbender" (two
// seasons) and the 2005 cartoon "Avatar: The Last Airbender" (three), and a
// request with no year matched the live action. The operator, 2026-10-13:
// "Avatar: The Last Airbender is on server". A season or episode the picked
// show lacks is now taken from another show of the same title that has it -
// never to replace one the picked show has, and never against a year the
// request named.
//
// The same day, checking the operator's "american dad s15 is on server":
// American Dad!'s "Season 16" folder holds a second copy of season 15, which
// Jellyfin numbers S15 too, so the season resolved to every episode twice.
// One copy of each episode is sent, the one in its own season's folder.
import { resolveEpisodes, oneCopyEach } from '../src/plugins/tv-requests/jellyfin-tv.js';
import { bestMatch } from '../src/util/fuzzy.js';

let fails = 0;
const ok = (c, n) => { if (!c) { fails++; console.error('FAIL', n); } else console.log('ok', n); };

const LIVE = { Id: 'live', Name: 'Avatar the Last Airbender', ProductionYear: 2024, Type: 'Series', RecursiveItemCount: 16, ProviderIds: { Tmdb: '82452', Tvdb: '385925' } };
const TOON = { Id: 'toon', Name: 'Avatar: The Last Airbender', ProductionYear: 2005, Type: 'Series', RecursiveItemCount: 61, ProviderIds: { Tmdb: '246', Tvdb: '74852' } };
const SEASONS = { live: [1, 2], toon: [1, 2, 3] };
const ep = (show, s, n) => ({ Id: `${show}-${s}-${n}`, Name: `${show} ${s}x${n}`, ParentIndexNumber: s, IndexNumber: n, SeriesName: show === 'live' ? LIVE.Name : TOON.Name });

const searched = [];
const fetchImpl = async (raw) => {
  const url = new URL(String(raw));
  const json = (b) => ({ ok: true, status: 200, json: async () => b });
  if (url.pathname.endsWith('/Items')) {
    // Jellyfin's searchTerm: one LIKE over the stored name - the colon in
    // the cartoon's name keeps "Avatar the Last Airbender" from finding it.
    const term = String(url.searchParams.get('searchTerm') ?? '').toLowerCase();
    searched.push(term);
    return json({ Items: [LIVE, TOON].filter((i) => i.Name.toLowerCase().includes(term)) });
  }
  const m = url.pathname.match(/\/Shows\/([^/]+)\/(Seasons|Episodes)/);
  if (m && m[2] === 'Seasons') return json({ Items: SEASONS[m[1]].map((n) => ({ Id: `${m[1]}-s${n}`, IndexNumber: n, ChildCount: 3 })) });
  if (m && m[2] === 'Episodes') {
    const season = Number(url.searchParams.get('season'));
    return json({ Items: SEASONS[m[1]].includes(season) ? [1, 2, 3].map((n) => ep(m[1], season, n)) : [] });
  }
  return { ok: false, status: 404, statusText: 'x', json: async () => ({}) };
};
const opts = { base: 'http://jf:8096', token: 'T', userId: 'U', bestMatch, fetchImpl };
const who = (r) => [r.error ?? 'ok', r.series?.id, r.episodes.map((e) => e.id).join(',')].join(' ');

const s3 = await resolveEpisodes({ show: 'avatar the last airbender', season: 3 }, opts);
ok(!s3.error && s3.series.id === 'toon' && s3.episodes.length === 3, `season 3 comes from the 2005 cartoon (${who(s3)})`);
ok(searched.includes('airbender'), 'the title\'s longest word is searched, since the full phrase misses the colon');

const e5 = await resolveEpisodes({ show: 'avatar the last airbender', season: 3, episode: 2 }, opts);
ok(!e5.error && e5.series.id === 'toon' && e5.episodes[0].id === 'toon-3-2', `an episode of season 3 too (${who(e5)})`);

const s1 = await resolveEpisodes({ show: 'avatar the last airbender', season: 1 }, opts);
ok(!s1.error && s1.series.id === 'live', `a season the picked show has is not taken from the other (${who(s1)})`);

const y = await resolveEpisodes({ show: 'avatar the last airbender 2024', season: 3 }, opts);
ok(y.error === 'empty-season' && y.series.id === 'live', `a year the other show does not fit keeps the answer "no season 3" (${who(y)})`);

const s4 = await resolveEpisodes({ show: 'avatar the last airbender', season: 4 }, opts);
ok(s4.error === 'empty-season', `a season neither has is still missing (${who(s4)})`);

// American Dad! season 15, held twice.
const copy = (id, n, dir) => ({ id, season: 15, episode: n, localPath: `/tv/American Dad! (2005)/${dir}/American.Dad.S15E${String(n).padStart(2, '0')}.mp4` });
const both = [copy('a1', 1, 'Season 16'), copy('b1', 1, 'Season 15'), copy('a2', 2, 'Season 16'), copy('b2', 2, 'Season 15'), copy('c3', 3, 'Season 16')];
const one = oneCopyEach(both);
ok(one.map((e) => e.id).join(',') === 'b1,b2,c3', `one copy each, the one in its own season's folder (${one.map((e) => e.id)})`);
const dbl = oneCopyEach([{ id: 'x', season: 2, episode: 21, episodeEnd: 22 }, { id: 'y', season: 2, episode: 21 }]);
ok(dbl.length === 2, 'a double-episode file is not taken for a copy of its first episode');
ok(oneCopyEach([{ id: 'u', season: 1, episode: null }, { id: 'v', season: 1, episode: null }]).length === 2, 'unnumbered episodes are never merged');

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
