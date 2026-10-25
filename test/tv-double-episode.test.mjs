// On 2026-10-10 Gil asked for "Marvels agents of S.H.I.E.L.D. S02 e22" and
// was told season 2 has no episode 22. The library holds it as one file,
// "S02E21-E22", which Jellyfin lists as episode 21 with IndexNumberEnd 22.
// A double-episode file now answers for every episode it holds.
import { resolveEpisodes } from '../src/plugins/tv-requests/jellyfin-tv.js';
import { bestMatch } from '../src/util/fuzzy.js';

let fails = 0;
const ok = (c, n) => { if (!c) { fails++; console.error('FAIL', n); } else console.log('ok', n); };

const SHOW = { Id: 'A', Name: "Marvel's Agents of S.H.I.E.L.D.", ProductionYear: 2013, Type: 'Series' };
const eps = [
  { Id: 'e20', Name: 'Scars', ParentIndexNumber: 2, IndexNumber: 20 },
  { Id: 'e21', Name: 'S.O.S. (1) / S.O.S. (2)', ParentIndexNumber: 2, IndexNumber: 21, IndexNumberEnd: 22 },
];
const fetchImpl = async (raw) => {
  const url = new URL(String(raw));
  const json = (b) => ({ ok: true, status: 200, json: async () => b });
  if (url.pathname.endsWith('/Items')) return json({ Items: [SHOW] });
  if (url.pathname.includes('/Seasons')) return json({ Items: [{ Id: 's2', IndexNumber: 2, ChildCount: 2 }] });
  if (url.pathname.includes('/Episodes')) return json({ Items: eps });
  return { ok: false, status: 404, statusText: 'x', json: async () => ({}) };
};
const opts = { base: 'http://jf:8096', token: 'T', userId: 'U', bestMatch, fetchImpl };
const ids = (r) => r.episodes.map((e) => e.id).join(',');

const r22 = await resolveEpisodes({ show: "Marvel's Agents of S.H.I.E.L.D.", season: 2, episode: 22 }, opts);
ok(!r22.error && ids(r22) === 'e21', 'episode 22 is served by the S02E21-E22 file');
const r21 = await resolveEpisodes({ show: "Marvel's Agents of S.H.I.E.L.D.", season: 2, episode: 21 }, opts);
ok(ids(r21) === 'e21', 'episode 21 still is');
const rr = await resolveEpisodes({ show: "Marvel's Agents of S.H.I.E.L.D.", season: 2, episodeRange: { from: 21, to: 22 } }, opts);
ok(ids(rr) === 'e21', 'a run 21-22 sends the file once');
const r23 = await resolveEpisodes({ show: "Marvel's Agents of S.H.I.E.L.D.", season: 2, episode: 23 }, opts);
ok(r23.error === 'no-such-episode' && r23.episodesInSeason.join(',') === '20,21,22', 'episode 23 is still absent, and 22 is listed as held');
// A list (2026-10-12) is served the same way, and names what is not held.
const rl = await resolveEpisodes({ show: "Marvel's Agents of S.H.I.E.L.D.", season: 2, episodeList: [20, 22, 25] }, opts);
ok(!rl.error && ids(rl) === 'e20,e21', `a list E20, E22, E25 sends E20 and the S02E21-E22 file (${ids(rl)})`);
ok(rl.missing?.join(',') === '25' && rl.episodesInSeason?.join(',') === '20,21,22', `and names E25 as not held (${rl.missing})`);
const rh = await resolveEpisodes({ show: "Marvel's Agents of S.H.I.E.L.D.", season: 2, episodeList: [20, 22] }, opts);
ok(!rh.missing, 'a list the season holds whole has nothing missing');
process.exit(fails ? 1 : 0);
