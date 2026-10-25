/* A bypass entry for the film asked for does not send a library file of another title.
   Run: node test/bypass-other-title-file.test.mjs

   Found in review of the operator's "Exact title only" (2026-09-29), with
   the real gates: an entry "Saw 2004", a request for Saw (2004, R), and a
   server that holds Saw II (2005) and not Saw. The fuzzy matcher forgives a
   sequel's number ("Saw" scores 0.985 against "Saw II"; so do "Scream"
   against "Scream 2" and "Collateral" against "Collateral Damage"), the
   library gives no penalty for one year, and the file re-check runs only
   when the file does not look like the film asked for. So fileGate handed
   step 2's entry on without looking the file up again, contentGate trusted
   it, and Saw II was posted as "Saw" - "sent: on the bypass list (rating
   override for "Saw" (2004) by op)" - with no AI check. The same gates run
   a panel Re-run, the hourly check's requeue and the Test tab's dry run.

   Pinned here, through fileGate and then contentGate as every film path
   calls them (OMDb and Gemini are a stubbed fetch):
    - the Saw II file is not sent on the entry for Saw: it is looked up
      again, judged as Saw II, and put to the AI check (or refused on its
      rating where the check cannot clear it);
    - when the file cannot be looked up again, nothing is handed on, and the
      list is matched on the file alone;
    - a request that found Saw itself is still sent on the entry;
    - an entry typed as OMDb words a title ("F1: The Movie") still sends the
      library's "F1" once OMDb says the file is that film;
    - an entry for the title asked for, with the file's year, does not
      cover the file of another title either. */
import './fixtures/omdb-no-wait.mjs';
import { ratingGate, fileGate, contentGate } from '../src/plugins/movie-requests/film-gate.js';
import { addOverride, sameTitle } from '../src/core/rating-overrides.js';
import { resetBreakers, resetModelCache } from '../src/core/ai-providers.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

function store(init = {}) {
  const d = { ...init };
  return { get: (k, v) => (k in d ? d[k] : v), set: (k, v) => { d[k] = v; } };
}
const listed = (...inputs) => { const s = store(); for (const i of inputs) addOverride(s, i, { addedBy: 'op' }); return s; };

// OMDb knows the films; Gemini answers `verdict`. Nothing leaves the process.
const OMDB = [
  { Title: 'Saw', Year: '2004', Rated: 'R', imdbID: 'tt0387564' },
  { Title: 'Saw II', Year: '2005', Rated: 'R', imdbID: 'tt0432348' },
  // Rated R here to stand for any film its rating blocks.
  { Title: 'F1: The Movie', Year: '2025', Rated: 'R', imdbID: 'tt16311594' },
].map((m) => ({ ...m, Type: 'movie', Released: 'N/A', DVD: 'N/A', Response: 'True' }));
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
let omdbDown = false;
let verdict = { nudity: false, confidence: 0.9, basis: 'gore, no nudity' };
const calls = { omdb: 0, gemini: 0 };
let asked = '';
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  if (u.hostname === 'www.omdbapi.com') {
    calls.omdb += 1;
    if (omdbDown) return json({ Error: 'down' }, 503);
    const q = norm(u.searchParams.get('t') ?? u.searchParams.get('s'));
    const y = u.searchParams.get('y');
    // "F1" is how Jellyfin names the film OMDb calls "F1: The Movie".
    const hits = OMDB.filter((m) => norm(m.Title) === q || (q === 'f1' && m.Title.startsWith('F1')));
    const hit = (y && hits.find((m) => m.Year === y)) || hits[0];
    if (u.searchParams.get('s')) {
      return json(hits.length ? { Response: 'True', Search: hits.map(({ Title, Year, imdbID, Type }) => ({ Title, Year, imdbID, Type })) }
        : { Response: 'False', Error: 'Movie not found!' });
    }
    return json(hit ?? { Response: 'False', Error: 'Movie not found!' });
  }
  if (u.hostname === 'generativelanguage.googleapis.com') {
    calls.gemini += 1;
    asked = String(init?.body ?? '');
    return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(verdict) }] }, finishReason: 'STOP' }] });
  }
  return new Response('{}', { status: 404 });
};

const cfg = { blockedRatings: ['R', 'NC-17', 'X'] };
// The check on, and allowed to clear a rated film: as on the live bot.
const CLEARS = { enabled: true, contentCheck: true, allowCleanRatedFilms: true, apiKey: 'GEMINI-KEY', model: 'gemini-test', minContentConfidence: 0.7 };
const OFF = { enabled: false };

/** Step 2, 4b and 4c of a request, as the movie plugin runs them. */
async function send(s, movie, hit, gemini, { omdbKey = 'k' } = {}) {
  calls.omdb = 0; calls.gemini = 0; asked = ''; resetBreakers(); resetModelCache();
  const letter = ratingGate(s, movie, cfg, { gemini, ai: null });
  const file = await fileGate({
    store: s, movie, hit, cfg, override: letter.override, aiMayClear: !!gemini.allowCleanRatedFilms, omdbKey,
  });
  if (file.refused) return { letter, file, gate: null };
  const swapped = file.movie !== movie;
  const gate = await contentGate({
    store: s, movie: file.movie, hit, override: file.override,
    ratedBlocked: !swapped && letter.blocked ? true : null, cfg, gemini, ai: null,
  });
  return { letter, file, gate };
}

const SAW = { title: 'Saw', year: 2004, rated: 'R', imdbId: 'tt0387564' };
const SAW_II_FILE = { id: '2'.repeat(32), title: 'Saw II', year: 2005 };
const SAW_FILE = { id: '1'.repeat(32), title: 'Saw', year: 2004 };

console.log('=== "Saw" and "Saw II" are not the same title to the list ===');
{
  ok(!sameTitle('Saw', 'Saw II') && !sameTitle('Scream', 'Scream 2'), 'a sequel\'s number makes another title');
  ok(sameTitle('KILL-ME three times', 'Kill Me Three Times') && sameTitle('Fruits Basket', 'Fruits Basket (2019)'),
    'while case, spaces, punctuation and a year in brackets do not');
}

console.log('=== the entry "Saw 2004" does not send the Saw II the server holds ===');
{
  const s = listed('Saw 2004');
  const { letter, file, gate } = await send(s, SAW, SAW_II_FILE, CLEARS);
  ok(!!letter.override, 'step 2 finds the entry for the film asked for');
  ok(file.rc.rechecked === true && file.movie.title === 'Saw II' && calls.omdb === 1,
    `the file is looked up again, although it looks like Saw (${file.movie.title}, ${calls.omdb} OMDb call)`);
  ok(file.override === null, 'and the entry for Saw is not handed on past it');
  ok(gate && !gate.bypass && gate.checked && calls.gemini === 1 && /Saw II/.test(asked),
    `it is not sent on the list: the AI is asked about Saw II (${gate?.call?.reason})`);

  verdict = { nudity: true, confidence: 0.9, basis: 'a sex scene' };
  const nude = await send(s, SAW, SAW_II_FILE, CLEARS);
  ok(nude.gate && !nude.gate.bypass && nude.gate.call.blocked, '"nudity": refused on its rating, not sent on the entry');
  verdict = { nudity: false, confidence: 0.9, basis: 'gore, no nudity' };

  const noAi = await send(s, SAW, SAW_II_FILE, OFF);
  ok(noAi.file.refused === 'blocked-rating' && calls.gemini === 0,
    `with no AI check that could clear it, the R file is refused on its rating (${noAi.file.refused})`);
}

console.log('=== the file cannot be looked up again: nothing is handed on, and the list is matched on the file ===');
{
  const s = listed('Saw 2004');
  omdbDown = true;
  try {
    const { file, gate } = await send(s, SAW, SAW_II_FILE, CLEARS);
    ok(!file.rc.rechecked && file.override === null, 'the re-check could not run, and the entry is not handed on');
    ok(gate && !gate.bypass && gate.checked, `contentGate does not find the entry for Saw again: the AI is asked (${gate?.call?.reason})`);
    const off = await send(s, SAW, SAW_II_FILE, OFF);
    ok(off.gate && !off.gate.bypass && off.gate.call.blocked && calls.gemini === 0, 'and with no AI check, it is refused on its rating');
    const noKey = await send(s, SAW, SAW_II_FILE, OFF, { omdbKey: '' });
    ok(noKey.gate && !noKey.gate.bypass && noKey.gate.call.blocked, 'the same with no OMDb key at all');
  } finally { omdbDown = false; }
}

console.log('=== the control: a request that found Saw itself is sent on the entry ===');
{
  const s = listed('Saw 2004');
  const { file, gate } = await send(s, SAW, SAW_FILE, CLEARS);
  ok(!file.rc.rechecked && calls.omdb === 0 && !!file.override, 'the file is the film asked for: not looked up again, the entry handed on');
  ok(gate?.bypass === true && calls.gemini === 0 && gate.call.reason === 'sent: on the bypass list (rating override for "Saw" (2004) by op)',
    `sent on the list, with no AI check (${gate?.call?.reason})`);
  const other = await send(listed('Saw'), SAW, { ...SAW_FILE, year: 2005 }, CLEARS);
  ok(other.gate?.bypass === true && calls.omdb === 0, 'and "Saw" with no year covers the same title a year off, as ever');
}

console.log('=== an entry typed as OMDb words a title still sends the library\'s copy ===');
{
  const s = listed('F1: The Movie');
  const f1 = { title: 'F1: The Movie', year: 2025, rated: 'R' };
  const { file, gate } = await send(s, f1, { id: 'f'.repeat(32), title: 'F1', year: 2025 }, CLEARS);
  ok(file.rc.rechecked === true && !!file.override, 'the file "F1" is looked up again, and OMDb says it is F1: The Movie');
  ok(gate?.bypass === true && calls.gemini === 0, `sent on the list, with no AI check (${gate?.call?.reason})`);
}

console.log('=== with nothing handed on, the name asked for does not lend the file its entry ===');
{
  // An entry for Saw with the year of the file the server holds: step 2
  // (Saw, 2004) does not find it, and the file is not called Saw.
  const s = listed('Saw 2005');
  const { letter, gate } = await send(s, SAW, SAW_II_FILE, OFF);
  ok(!letter.override && gate && !gate.bypass && gate.call.blocked,
    `"Saw 2005" does not send Saw II (2005) on the name Saw (${gate?.call?.reason})`);
  const link = listed(SAW_II_FILE.id);
  const byId = await send(link, SAW, SAW_II_FILE, OFF);
  ok(byId.gate?.bypass === true, 'while a link to the Saw II file itself sends it, as a link always did');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
