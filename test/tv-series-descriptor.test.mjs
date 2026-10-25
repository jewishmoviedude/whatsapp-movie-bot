// Incident: 2026-10-21, Benji asked for "Rafa (TV series 2026)" and "Rafa the
// Netflix mini series" in the TV group. The year was cut from inside the
// brackets, leaving "Rafa (TV series )", and both were answered "no series
// matching". A kind-of-thing descriptor is not part of the title.
import { stripSeriesDescriptor } from '../src/util/fuzzy.js';
let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log('FAIL', m); } };
ok(stripSeriesDescriptor('Rafa (TV series 2026)') === 'Rafa', 'bracketed descriptor with year');
ok(stripSeriesDescriptor('Rafa (2026 TV series)') === 'Rafa', 'year first');
ok(stripSeriesDescriptor('Rafa the Netflix mini series') === 'Rafa', 'trailing netflix mini series');
ok(stripSeriesDescriptor('Rafa tv show') === 'Rafa', 'trailing tv show');
ok(stripSeriesDescriptor('The Late Show') === 'The Late Show', 'a title ending in Show stays');
ok(stripSeriesDescriptor('Mini Series') === 'Mini Series', 'never returns empty');
ok(stripSeriesDescriptor('Friends season 3') === 'Friends season 3', 'plain request untouched');
if (fail) process.exit(1);
console.log('tv-series-descriptor: ok');
