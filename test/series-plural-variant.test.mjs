// Incident (hourly check 20261021T040001Z): "legends of kora S01" was answered
// "no series matching" although "The Legend of Korra" (2012) is in the library.
// A plural before "of" is also tried without its "s", after the title as typed.
import { pluralVariant } from '../src/plugins/tv-requests/jellyfin-tv.js';

let failed = 0;
function ok(name, cond) { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) failed++; }

ok('legends of kora becomes legend of kora', pluralVariant('legends of kora') === 'legend of kora');
ok('case is kept', pluralVariant('The Legends of Korra') === 'The Legend of Korra');
ok('no plural before of, no variant', pluralVariant('legend of kora') === null);
ok('a plural elsewhere is left alone', pluralVariant('friends') === null);
process.exit(failed ? 1 : 0);
