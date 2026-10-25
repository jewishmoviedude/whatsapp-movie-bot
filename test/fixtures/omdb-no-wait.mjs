/* OMDb's failures of the moment are tried again without the real wait.

   Since 2026-10-12 an OMDb call that meets HTTP 5xx, 429, 403 or a network
   error waits and tries again, 5, 30 and 90 seconds after the first try
   ("First daughter 2004" got ⚠️ for an outage of under 90 seconds:
   src/plugins/movie-requests/omdb.js). A suite whose stubbed OMDb is down to
   see what a request does then would wait those 90 seconds for real. Its
   tries are still made, on a clock that does not wait; what the retries
   themselves do is test/omdb-outage-tried-again-before-failing.test.mjs.
   Imported first by the suites that take OMDb down. */
import { setOmdbClock } from '../../src/plugins/movie-requests/omdb.js';

setOmdbClock({ sleep: async () => {} });
