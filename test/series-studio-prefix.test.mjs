// Incident (hourly check 20261017T200001Z): "marvel Moon Knight season 1" was
// answered "no series matching" although "Moon Knight" (2022) is in the
// library. A studio or service typed before the title is also tried without it.
import { studioVariant } from '../src/plugins/tv-requests/jellyfin-tv.js';

let failed = 0;
function ok(name, cond) { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) failed++; }

ok('marvel Moon Knight loses marvel', studioVariant('marvel Moon Knight') === 'Moon Knight');
ok("Marvel's Daredevil loses Marvel's", studioVariant("Marvel's Daredevil") === 'Daredevil');
ok('Netflix prefix is dropped', studioVariant('Netflix Wednesday') === 'Wednesday');
ok('a title without a lead has no variant', studioVariant('Moon Knight') === null);
ok('the bare word has no variant', studioVariant('Marvel') === null);
ok('marvel: loki loses "marvel:"', studioVariant('marvel: loki') === 'loki');
ok('marvel - loki loses the dash', studioVariant('marvel - loki') === 'loki');
ok('a title ending in the lead word with a colon has no variant', studioVariant('Marvel:') === null);
process.exit(failed ? 1 : 0);
