// Incident: hourly check 20261025T110001Z. "fallout season S2E1-8" was answered
// "no series matching" because the word "season" stayed on the title.
import { trailingSeasonVariant } from '../src/plugins/tv-requests/jellyfin-tv.js';

let failed = 0;
const ok = (c, m) => { if (!c) { failed++; console.error('FAIL', m); } else console.log('ok', m); };

ok(trailingSeasonVariant('fallout season') === 'fallout', 'drops a trailing "season"');
ok(trailingSeasonVariant('The Boys Series') === 'The Boys', 'drops a trailing "series"');
ok(trailingSeasonVariant('fallout') === null, 'plain title unchanged');
ok(trailingSeasonVariant('season') === null, 'a lone word is kept');
process.exit(failed ? 1 : 0);
