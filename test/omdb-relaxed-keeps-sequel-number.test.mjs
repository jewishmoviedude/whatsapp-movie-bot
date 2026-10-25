// Incident 2026-10-11 11:21Z: "fast and furios 6" (a typo plus a sequel
// number) was searched without its 6, resolved to Fast and Furious (1939),
// and the library's Fast & Furious (2009) was sent although the library holds
// Fast & Furious 6. A relaxed-search candidate must carry the typed number.
import { keepsSequelNumber } from '../src/plugins/movie-requests/omdb.js';

let failed = 0;
const ok = (c, n) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++; };
const r = (Title) => ({ Title });

const pool = [r('Fast and Furious'), r('Fast & Furious'), r('Furious 6')];
ok(keepsSequelNumber('fast and furios 6', pool).map((x) => x.Title).join() === 'Furious 6',
  'only the numbered film survives a request ending in 6');
ok(keepsSequelNumber('rocky iv', [r('Rocky'), r('Rocky 4')]).length === 1, 'roman numeral matches the digit title');
ok(keepsSequelNumber('the dark night rises', pool).length === 3, 'no trailing number: untouched');
ok(keepsSequelNumber('fast and furios 6', [r('Fast and Furious')]).length === 0, 'nothing numbered: honest miss');
ok(keepsSequelNumber("ocean's 11", [r("Ocean's Eleven")]).length === 1, 'a spelled-out number counts');
process.exit(failed ? 1 : 0);
