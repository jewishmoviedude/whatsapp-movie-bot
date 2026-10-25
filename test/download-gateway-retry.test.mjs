// Incident: 2026-10-02 08:45 UTC, Marvel's Daredevil S02E09 failed with
// "download failed: HTTP 502 Bad Gateway" after 8 seconds, and was not retried
// because the error did not look transient; episodes 8 and 10 either side of
// it downloaded fine. A gateway error from the library is worth another try;
// a 404 or 401 is not.
import { isTransient } from '../src/media/resume.js';

let failed = 0;
const ok = (name, cond) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) failed++; };

for (const c of [429, 502, 503, 504]) {
  ok(`HTTP ${c} on a download is retried`, isTransient(new Error(`download failed: HTTP ${c} Bad Gateway`)));
}
for (const c of [401, 403, 404, 500]) {
  ok(`HTTP ${c} on a download is not retried`, !isTransient(new Error(`download failed: HTTP ${c} Nope`)));
}
process.exit(failed ? 1 : 0);
