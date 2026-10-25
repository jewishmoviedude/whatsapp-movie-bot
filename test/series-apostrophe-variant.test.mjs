// Incident (hourly check 20261020T210001Z): "Friend's S01E11-E20" was answered
// "no series matching" although "Friends" (1994) is in the library. A title
// is also tried with its apostrophes removed, after the title as typed.
import { apostropheVariant } from '../src/plugins/tv-requests/jellyfin-tv.js';

let failed = 0;
function ok(name, cond) { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) failed++; }

ok("Friend's becomes Friends", apostropheVariant("Friend's") === 'Friends');
ok('a curly apostrophe is dropped too', apostropheVariant('Friend’s') === 'Friends');
ok('no apostrophe, no variant', apostropheVariant('Friends') === null);
ok('only an apostrophe, no variant', apostropheVariant("'") === null);
process.exit(failed ? 1 : 0);
