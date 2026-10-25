/* A file whose episode Jellyfin read as its resolution is numbered from its name.
   Run: node test/tv-resolution-as-episode.test.mjs

   2026-10-18: Ari asked for "Code Geass: Lelouch of the rebellion s1 e1" and was
   told season 1 has no episode 1. Thirteen files in the folder were named
   "gotei-cg-e01-720p_720p.mp4" and Jellyfin gave every one IndexNumber 720, so
   the bot saw episodes 14-25 and thirteen copies of "720". */
import { listEpisodes, explicitEpisodeFromName } from '../src/plugins/tv-requests/jellyfin-tv.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

ok(explicitEpisodeFromName('/a/Season 1/gotei-cg-e01-720p_720p.mp4') === 1, 'gotei-cg-e01-720p -> 1');
ok(explicitEpisodeFromName('Show.S01E14.720p.mp4') === 14, 'S01E14 -> 14');
ok(explicitEpisodeFromName('Show 720p.mp4') === null, 'a bare resolution is no episode');

const items = [
  ...[1, 2, 13].map((n) => ({ Id: `g${n}`, ParentIndexNumber: 1, IndexNumber: 720, Name: `gotei-cg-e${String(n).padStart(2, '0')}`, Path: `/a/Season 1/gotei-cg-e${String(n).padStart(2, '0')}-720p_720p.mp4` })),
  { Id: 'r14', ParentIndexNumber: 1, IndexNumber: 14, Name: 'Geass vs. Geass', Path: '/a/Season 1/Code.Geass.S01E14.720p.mp4' },
  { Id: 'real720', ParentIndexNumber: 1, IndexNumber: 720, Name: 'Odd', Path: '/a/Season 1/Odd 720p.mp4' },
];
const fetchImpl = async (url) => {
  const u = new URL(url);
  const json = (b) => ({ ok: true, status: 200, json: async () => b });
  if (u.pathname.endsWith('/Seasons')) return json({ Items: [{ Id: 's1', IndexNumber: 1, ChildCount: items.length }] });
  return json({ Items: items });
};
const eps = await listEpisodes('cg', { base: 'http://jf', token: 't', season: 1, fetchImpl });
const nums = eps.map((e) => e.episode).sort((a, b) => a - b);
ok(JSON.stringify(nums) === JSON.stringify([1, 2, 13, 14, 720]), `renumbered from the file names: ${nums}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
