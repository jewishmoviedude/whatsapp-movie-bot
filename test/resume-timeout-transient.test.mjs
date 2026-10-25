// Incident: Taken (2008) on 2026-10-20 was resumed after a restart while
// Jellyfin was slow; "Jellyfin did not respond within 30s" was not counted
// as transient, so the film was failed for good instead of retried.
import { isTransient } from '../src/media/resume.js';
let bad = 0;
const ok = (c, n) => { console.log(`${c ? 'ok' : 'FAIL'} - ${n}`); if (!c) bad++; };
ok(isTransient(new Error('Jellyfin did not respond within 30s')), 'a Jellyfin timeout is transient');
ok(isTransient(new Error('Jellyfin library did not respond within 60s')), 'a library timeout is transient');
ok(!isTransient(new Error('Jellyfin said no')), 'other errors stay final');
process.exit(bad ? 1 : 0);
