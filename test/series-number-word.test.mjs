// Incident (hourly check 20261013T230001Z): "Brooklyn 99 season 5" was answered
// "couldn't find that title" although "Brooklyn Nine-Nine" is in the library.
// A doubled digit is also tried as its doubled number word.
import { numberWordVariant } from '../src/plugins/tv-requests/jellyfin-tv.js';

let failed = 0;
function ok(name, cond) { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) failed++; }

ok('Brooklyn 99 becomes Brooklyn nine-nine', numberWordVariant('Brooklyn 99') === 'Brooklyn nine-nine');
ok('22 becomes two-two', numberWordVariant('Apt 22') === 'Apt two-two');
ok('a title with no doubled digit has no variant', numberWordVariant('Friends') === null);
ok('a year is left alone', numberWordVariant('Show 1999') === null);
ok('12 and 100 are left alone', numberWordVariant('Area 12') === null && numberWordVariant('Show 100') === null);
process.exit(failed ? 1 : 0);
