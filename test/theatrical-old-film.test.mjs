// The Cutting Edge 3: Chasing the Dream (2008) was answered "still in
// theaters" on 2026-10-19 (Head Admin's #issue): TMDB held a theatrical date
// and no US home release, which was taken as "theatrical only" however old.
import { checkTmdb } from '../src/plugins/movie-requests/theatrical.js';

let fail = 0;
const ok = (c, n) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) fail++; };

const realFetch = globalThis.fetch;
const serve = (date) => {
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => String(url).includes('/find/')
      ? { movie_results: [{ id: 1 }] }
      : { results: [{ iso_3166_1: 'US', release_dates: [{ type: 3, release_date: date }] }] },
  });
};
try {
  serve('2008-03-01T00:00:00.000Z');
  ok((await checkTmdb({ imdbId: 'tt1' }, 'k', undefined, 180)) === null, 'a 2008 theatrical date with no home release is not "still in theaters"');
  serve(new Date(Date.now() - 20 * 86400000).toISOString());
  ok((await checkTmdb({ imdbId: 'tt1' }, 'k', undefined, 180))?.theatricalOnly === true, 'a film out 20 days is still in theaters');
} finally { globalThis.fetch = realFetch; }
process.exit(fail ? 1 : 0);
