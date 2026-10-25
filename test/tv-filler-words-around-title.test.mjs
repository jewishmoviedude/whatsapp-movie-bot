// Incident: hourly check 20261025T130001Z. "all Ted episodes" was answered
// "no series matching" because the words around the title stayed on the name.
import { fillerVariant } from '../src/plugins/tv-requests/jellyfin-tv.js';

let failed = 0;
const ok = (c, m) => { if (!c) { failed++; console.error('FAIL', m); } else console.log('ok', m); };

ok(fillerVariant('all Ted episodes') === 'Ted', 'drops "all" and "episodes"');
ok(fillerVariant('all of Ted') === 'Ted', 'drops "all of"');
ok(fillerVariant('every Ted episode') === 'Ted', 'drops "every" and "episode"');
ok(fillerVariant('ted all seasons') === 'ted', 'drops trailing "all seasons"');
ok(fillerVariant('Ted') === null, 'plain title unchanged');
ok(fillerVariant('episodes') === null, 'a lone word is kept');
process.exit(failed ? 1 : 0);
