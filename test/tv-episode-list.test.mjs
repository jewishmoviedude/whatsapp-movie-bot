// A member asked for "Solo leveling s1 e11,e12" and "s1 episodes 11+12"
// (2026-10-02). The first queued only E11, the second the whole season again
// (10 episodes re-posted), so Aaron asked four times for season 1. Episodes
// listed one after another, when consecutive, are read as a range.
import { parseTvRequest } from '../src/plugins/tv-requests/parse.js';

let fails = 0;
const ok = (c, n) => { if (!c) { fails++; console.error('FAIL', n); } else console.log('ok', n); };
const range = (t) => { const p = parseTvRequest(t); return p.episodeRange ? `${p.show}|${p.season}|${p.episodeRange.from}-${p.episodeRange.to}` : null; };

for (const t of ['Solo leveling s1 e11,e12', 'Solo leveling s1 episodes 11+12', 'Solo leveling S01E11 & E12',
  'Solo leveling s1 e11 e12', 'Solo leveling season 1 episode 11 and 12', 'Solo leveling s1 e11, e12, e13']) {
  ok(range(t)?.startsWith('Solo leveling|1|11-1'), `${t} is a range`);
}
ok(range('Solo leveling s1 e11,e12') === 'Solo leveling|1|11-12', 'e11,e12 is 11-12');
// A gap kept the first episode and dropped the rest until 2026-10-12 ("if
// it's a dash it's 4 through 10, comma then it'll only be those 2"): now it
// is those episodes, and only those (test/tv-comma-list-queues-only-those-episodes).
ok(parseTvRequest('friends s03 e06, e08').episodeList?.join() === '6,8' && parseTvRequest('friends s03 e06, e08').season === 3,
  'a gap is a list of exactly those episodes');
ok(parseTvRequest('24 S01E02 3 Days Later').episode === 2 && !parseTvRequest('24 S01E02 3 Days Later').episodeRange, 'a title number is not an episode');
ok(parseTvRequest('Solo leveling s1').matched === 'season-only', 'plain season unchanged');
process.exit(fails ? 1 : 0);
