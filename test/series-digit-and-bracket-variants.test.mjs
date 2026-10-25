// Incident (hourly check 20261018T050001Z): "two broke girls season 5" was
// answered "no series matching" although "2 Broke Girls" (2011) is in the
// library, and "friren: beyond journey's end (In English) s1" likewise. A
// leading number word is also tried as a digit, a trailing bracket without it.
import { digitVariant, bracketVariant } from '../src/plugins/tv-requests/jellyfin-tv.js';

let failed = 0;
function ok(name, cond) { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) failed++; }

ok('two broke girls becomes 2 broke girls', digitVariant('two broke girls') === '2 broke girls');
ok('Three Body Problem becomes 3 Body Problem', digitVariant('Three Body Problem') === '3 Body Problem');
ok('a title without a number word has no variant', digitVariant('broke girls') === null);
ok('a lone number word has no variant', digitVariant('two') === null);
ok('(In English) is dropped', bracketVariant("friren: beyond journey's end (In English)") === "friren: beyond journey's end");
ok('no bracket, no variant', bracketVariant('friren') === null);
ok('only a bracket, no variant', bracketVariant('(In English)') === null);
process.exit(failed ? 1 : 0);
