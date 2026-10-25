/* Titles an admin has cleared of their rating - films and TV, one list.
   Run: node test/rating-overrides.test.mjs

   A rating is one letter for a whole film. It does not distinguish an R for
   violence from an R for nudity, and the groups only care about the second, so
   blocking the letter throws away a lot of perfectly sendable film. This list
   is how an admin says "not that one".

   A title covers the film or show of exactly that name, with case, spaces
   and punctuation ignored; a year, a season or an episode narrows it; a
   Jellyfin link is exact.

   Exact since 2026-09-29. An entry used to cover every name it was the
   start of: "Heat" covered "Heathers" until that morning's review, and
   "Heat and Dust" until that evening, which only put them to the AI check
   while an entry did that - and, once an entry meant "Send it, no AI
   check", sent them and every TV-MA episode of a show of that name, titles
   nobody listed. Asked whether "Heat" should also send "Heat and Dust", the
   operator chose "Exact title only". The owner's stored entry "full metal
   alchemist" therefore no longer covers "Fullmetal Alchemist: Brotherhood";
   the entry on the live list typed with the show's full name does.

   What an entry does changed on 2026-09-29. It used to put a rating-blocked
   title in front of the AI nudity check, which had to confirm no nudity;
   that afternoon Gemini answered 503, Groq called The Last Samurai nude, and
   the film the operator had listed by hand was held back: "Why ask Gemini if
   I already added it to rated R bypass manually in panel?" Asked what adding
   a title should do, the operator chose: "Send it, no AI check". Pinned
   here: a listed title its rating blocks is sent with no AI call, and the
   panel says so; what an entry matches is shown beside it, since that is
   what it sends. */
import fs from 'node:fs';
import {
  parseEntry, jellyfinIdFrom, parseTitleYear, addOverride, removeOverride,
  listOverrides, isOverridden, describeOverride, titleKey, nameKey, titleCovers, tvOverrideFor, entryCoversName, TV_KEY,
  bypassNote, BYPASS_NOTE, mayCoverFilms,
} from '../src/core/rating-overrides.js';
import { contentGate } from '../src/plugins/movie-requests/film-gate.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

function store(init = {}) {
  const d = { ...init };
  return { get: (k, v) => (k in d ? d[k] : v), set: (k, v) => { d[k] = v; } };
}

console.log('=== what an admin can type ===');
{
  ok(jellyfinIdFrom('https://jf.example-media.org/Items/af8e5e8d2cf68d8f9bda563f549f21b5/Download?api_key=x')
    === 'af8e5e8d2cf68d8f9bda563f549f21b5', 'a download link');
  ok(jellyfinIdFrom('https://jf/web/index.html#!/details?id=AF8E5E8D2CF68D8F9BDA563F549F21B5')
    === 'af8e5e8d2cf68d8f9bda563f549f21b5', 'a details link, case-insensitively');
  ok(jellyfinIdFrom('Guardians of the Galaxy') === null, 'a plain title is not an id');

  ok(parseTitleYear('Dune (2021)').year === 2021, 'year in brackets');
  ok(parseTitleYear('Dune 2021').title === 'Dune', 'year on the end, stripped from the title');
  ok(parseTitleYear('Blade Runner 2049').year === 2049, 'a title that ends in a number still parses');
  ok(parseTitleYear('Heat').year === null, 'no year is fine');
}

console.log('=== only input with nothing to match on is refused ===');
{
  for (const bad of ['', '   ', '!!!', '???']) {
    let threw = false;
    try { parseEntry(bad); } catch { threw = true; }
    ok(threw, `${JSON.stringify(bad)} is refused`);
  }
  // A one-character title is a real film ("M", "X"), so it is allowed - and
  // it stays itself. normalizeTitle folds Roman numerals, so it would have
  // turned X into "10" and quietly covered the 1979 comedy along with the
  // 2022 horror film. This list never uses it.
  ok(titleKey('X') === 'x' && titleKey('10') === '10', 'X and 10 are different films');
  ok(parseEntry('X 2022').key !== parseEntry('10 1979').key, 'and get different keys');
  // Never refused for what it matches, or does not.
  for (const odd of ['full metal alchemist', 'Fullmetal Alchemist episode 14', 'zzz no such title']) {
    let threw = null;
    try { parseEntry(odd); } catch (e) { threw = e; }
    ok(!threw, `"${odd}" is saved as typed`);
  }
  ok(parseEntry('Heat (1995)').key === 't:heat|1995', 'a plain title keeps the key every build gave it');
}

console.log('=== adding and removing ===');
{
  const s = store();
  const e = addOverride(s, 'Kill Me Three Times (2014)', { addedBy: 'superadmin', note: 'R for violence' });
  ok(listOverrides(s).length === 1, 'stored');
  ok(e.addedBy === 'superadmin' && e.note === 'R for violence', 'who added it and why is kept');

  let dup = false;
  try { addOverride(s, 'kill me three times 2014'); } catch { dup = true; }
  ok(dup, 'the same film twice is refused, however it is capitalised');

  ok(removeOverride(s, e.key) === true, 'removable');
  ok(listOverrides(s).length === 0, 'and gone');
  ok(removeOverride(s, 'nope') === false, 'removing something absent is a no-op');
}

console.log('=== a title covers only the film or show of exactly that name ===');
{
  ok(nameKey('Fullmetal Alchemist: Brotherhood') === 'fullmetalalchemistbrotherhood' && nameKey('full metal alchemist') === 'fullmetalalchemist',
    'case, spaces and punctuation are ignored');
  ok(titleCovers('full metal alchemist', 'Fullmetal Alchemist'), '"full metal alchemist" covers "Fullmetal Alchemist": the same letters');
  ok(!titleCovers('full metal alchemist', 'Fullmetal Alchemist: Brotherhood'),
    'and not "Fullmetal Alchemist: Brotherhood", a longer title ("Exact title only")');
  ok(titleCovers('Fullmetal Alchemist Brotherhood', 'Fullmetal Alchemist: Brotherhood'), 'which an entry typed with its full name covers');
  ok(!titleCovers('Brotherhood', 'Fullmetal Alchemist: Brotherhood'), 'nor does any part of a name cover it');

  const s = store();
  addOverride(s, 'Dune 2021');
  ok(!!isOverridden(s, { title: 'Dune', year: 2021 }), 'matches the film it names');
  ok(!!isOverridden(s, { title: 'dune', year: 2021 }), 'case does not matter');
  // The year narrows it.
  ok(!isOverridden(s, { title: 'Dune', year: 1984 }), 'with a year, NOT the 1984 one');
  ok(!isOverridden(s, { title: 'Dune: Part Two', year: 2024 }), 'nor a 2024 film whose name starts with it');
  ok(!isOverridden(s, { title: 'Heat', year: 1995 }), 'nor an unrelated one');
  const any = store();
  addOverride(any, 'Dune');
  ok(!!isOverridden(any, { title: 'Dune', year: 1984 }) && !!isOverridden(any, { title: 'Dune', year: 2021 }),
    'without a year: every film called "Dune", whatever its year');
  ok(!isOverridden(any, { title: 'Dune: Part Two', year: 2024 }), 'and not "Dune: Part Two", which only starts with it');

  // The operator's question and answer, 2026-09-29: should "Heat" also send
  // "Heat and Dust"? "Exact title only". An entry sends what it covers with
  // no AI check, so a name it only starts would be sent unchecked.
  console.log('--- an entry for Heat sends Heat, and neither Heat and Dust nor Heathers ---');
  const heat = store();
  addOverride(heat, 'Heat');
  ok(!!isOverridden(heat, { title: 'Heat', year: 1995 }) && !!isOverridden(heat, { title: 'HEAT', year: 1986 }),
    'it covers the film "Heat", of any year');
  ok(!isOverridden(heat, { title: 'Heat and Dust', year: 1983 }), '"Heat" does not cover the film "Heat and Dust"');
  ok(!tvOverrideFor(heat, { name: 'Heat and Dust', year: 1983 }, { season: 1, episode: 1 }), 'nor a show called "Heat and Dust"');
  ok(!entryCoversName(listOverrides(heat)[0], { name: 'Heat and Dust', year: 1983 }), 'and the panel does not list it as a match');
  ok(!isOverridden(heat, { title: 'Heathers', year: 1988 }), 'nor "Heathers", which it never covered at the end of a word');
  ok(!tvOverrideFor(heat, { name: 'Heathers', year: 2018 }, { season: 1, episode: 1 }), 'nor the show "Heathers"');
  ok(!entryCoversName(listOverrides(heat)[0], { name: 'Heathers', year: 1988 }), 'nor lists that as a match');
  for (const title of ['Heathers', 'Heat and Dust']) {
    const gated = await contentGate({
      store: heat, movie: { title, year: 1988, rated: 'R' }, cfg: { blockedRatings: ['R'] },
      gemini: { enabled: false },
    });
    ok(!gated.bypass && gated.call.blocked, `so an R "${title}" is not sent on the entry: its rating decides`);
  }
  ok(titleCovers('KILL-ME three times', 'Kill Me Three Times') && !titleCovers('KILL-ME three', 'Kill Me Three Times'),
    'spaces and punctuation still ignored ("KILL-ME three times" is "Kill Me Three Times"), and a shorter entry covers nothing longer');
  ok(titleCovers('Full Metal Alchemist', 'Fullmetal Alchemist') && !titleCovers('Fullmetal', 'Full Metal Alchemist'),
    'where the spaces fall does not matter; missing words do');

  // A library name can carry its year in brackets - the live library names
  // a show "Fruits Basket (2019)" - and that year is not part of the title
  // an admin types. While an entry covered what a name starts with, "Fruits
  // Basket" covered it; the exact title must still.
  console.log('--- a year in brackets on a library name is its year, not its title ---');
  const fb = store();
  addOverride(fb, 'Fruits Basket');
  ok(!!tvOverrideFor(fb, { name: 'Fruits Basket (2019)', year: 2019 }, { season: 1, episode: 1 }), '"Fruits Basket" covers the show "Fruits Basket (2019)"');
  ok(!!entryCoversName(listOverrides(fb)[0], { name: 'Fruits Basket (2019)', year: 2019, type: 'tv' }), 'and the panel lists it');
  ok(!tvOverrideFor(fb, { name: 'Fruits Basket: Prelude (2022)', year: 2022 }, { season: 1, episode: 1 }), 'but not a longer name with a year');
  const fb19 = store();
  addOverride(fb19, 'Fruits Basket 2019');
  ok(!!tvOverrideFor(fb19, { name: 'Fruits Basket (2019)', year: 2019 }, { season: 1, episode: 1 }), '"Fruits Basket 2019" covers it too');
  const fb01 = store();
  addOverride(fb01, 'Fruits Basket 2001');
  ok(!tvOverrideFor(fb01, { name: 'Fruits Basket (2019)' }, { season: 1, episode: 1 }),
    'and "Fruits Basket 2001" does not, even with no other year known: the brackets say 2019');
  ok(!!tvOverrideFor(fb01, { name: 'Fruits Basket', year: 2001 }, { season: 1, episode: 1 }), 'it covers the 2001 show');

  const x = store();
  addOverride(x, 'X 2022');
  ok(!!isOverridden(x, { title: 'X', year: 2022 }), 'an override for X covers X');
  ok(!isOverridden(x, { title: '10', year: 1979 }), 'and NOT the film 10 - no Roman numerals are folded');
  // Articles are not dropped: "The" is part of the exact title.
  const th = store();
  addOverride(th, 'Thing');
  ok(!isOverridden(th, { title: 'The Thing' }), '"Thing" does not cover "The Thing"');
  const the = store();
  addOverride(the, 'The Thing');
  ok(!isOverridden(the, { title: 'Thing' }), 'nor "The Thing" "Thing"');

  // A season or an episode is a show's: it covers no film.
  const sea = store();
  addOverride(sea, 'Fargo season 2');
  ok(!isOverridden(sea, { title: 'Fargo', year: 1996 }), '"Fargo season 2" does not cover the film Fargo');
  ok(!!tvOverrideFor(sea, { name: 'Fargo', year: 2014 }, { season: 2, episode: 3 }), 'it covers the show\'s season 2');
  ok(!tvOverrideFor(sea, { name: 'Fargo', year: 2014 }, { season: 1, episode: 3 }), 'and no other season');
}

console.log('=== the owner\'s entry, exactly as it is stored, covers only the title it names ===');
{
  // data/state.json on the live bot, movie-requests.rating-overrides, as the
  // owner added it on 2026-09-28 - before TV, so no kind, and addedBy the
  // whole session user. It was meant to cover "Fullmetal Alchemist:
  // Brotherhood", and did while an entry covered every name it was the start
  // of. Since "Exact title only" (2026-09-29) it covers the 2003 series and
  // nothing longer: Brotherhood, and the FMA films, need an entry of their
  // own, typed with the full name - as the live list's does.
  const live = store({ 'rating-overrides': [{ key: 't:full metal alchemist|', jellyfinId: null, title: 'full metal alchemist', year: null,
    addedBy: { username: 'superadmin', role: 'superadmin' }, note: '', addedAt: 1790636001601 }] });
  const [e] = listOverrides(live);
  ok(e.key === 't:full metal alchemist|' && e.addedBy === 'superadmin' && !('kind' in e), 'read as a title entry, added by "superadmin"');
  ok(!!tvOverrideFor(live, { name: 'Fullmetal Alchemist', year: 2003 }, { season: 1, episode: 1 }), 'it covers the 2003 series, whose name it is');
  ok(!tvOverrideFor(live, { name: 'Fullmetal Alchemist: Brotherhood', year: 2009 }, { season: 1, episode: 14 }),
    'and no longer Brotherhood\'s episodes: "Fullmetal Alchemist: Brotherhood" is a longer title');
  ok(!isOverridden(live, { title: 'Fullmetal Alchemist: The Conqueror of Shamballa', year: 2005 }), 'nor the FMA films');
  ok(!isOverridden(live, { title: 'Alchemist', year: 2020 }), 'nor a name it is only part of');

  // The entry on the live list since 2026-09-29, typed with the show's full
  // name and narrowed to a season, as data/state.json holds it.
  const full = store({ [TV_KEY]: [{ key: 't:fullmetal alchemist brotherhood||1|', jellyfinId: null, title: 'Fullmetal Alchemist: Brotherhood',
    year: null, season: 1, episode: null, addedBy: 'superadmin', note: '', addedAt: 1790697271873 }] });
  for (const episode of [14, 19, 26]) {
    ok(!!tvOverrideFor(full, { name: 'Fullmetal Alchemist: Brotherhood', year: 2009 }, { season: 1, episode }),
      `"Fullmetal Alchemist: Brotherhood season 1" covers S01E${episode}`);
  }
  ok(!tvOverrideFor(full, { name: 'Fullmetal Alchemist', year: 2003 }, { season: 1, episode: 14 }), 'and not the 2003 series');
}

console.log('=== an entry added by link still matches a free-text request ===');
{
  // The admin pastes a Jellyfin URL; the request arrives as words. If those did
  // not join up the list would look broken - "I added it and it still blocked".
  const s = store();
  const id = 'af8e5e8d2cf68d8f9bda563f549f21b5';
  addOverride(s, `https://jf/Items/${id}/Download?api_key=secret`);

  ok(!!isOverridden(s, { title: 'Whatever' }, { id, title: 'Some Film' }),
    'matched on the library hit id');
  ok(!isOverridden(s, { title: 'Some Film' }, { id: 'deadbeef'.repeat(4), title: 'Some Film' }),
    'a different item is not matched');
}

console.log('=== a title override matches the LIBRARY name too ===');
{
  // OMDb and the library disagree constantly - that is the Guardians bug. An
  // override keyed to one spelling must still fire on the other.
  const s = store();
  addOverride(s, 'Guardians of the Galaxy Vol. 2');
  ok(!!isOverridden(s, { title: 'Guardians of the Galaxy: Vol. 2' }, { title: 'Guardians of the Galaxy Vol. 2' }),
    'matches via the library title when the requested one differs');
}

console.log('=== an entry sends what it covers, with no AI check ===');
{
  // contentGate() is the last step of every film path - a request, a panel
  // Re-run, Queue link, the dry run. Given an entry, it sends a title its
  // rating blocks and asks no provider, whatever the switches say.
  const realFetch = globalThis.fetch;
  let asked = 0;
  globalThis.fetch = async () => { asked += 1; throw new Error('no AI call was expected'); };
  const s = store();
  addOverride(s, 'Kill Me Three Times 2014', { addedBy: 'owner' });
  const gemini = { enabled: true, contentCheck: true, allowCleanRatedFilms: true, apiKey: 'k' };
  try {
    const g = await contentGate({ store: s, movie: { title: 'Kill Me Three Times', year: 2014, rated: 'R' }, cfg: { blockedRatings: ['R'] }, gemini });
    ok(g.bypass === true && g.call.blocked === false && asked === 0, 'a listed R film is sent, and no provider is asked');
    ok(g.call.reason === 'sent: on the bypass list (rating override for "Kill Me Three Times" (2014) by owner)', `in History's words: "${g.call.reason}"`);
    const off = await contentGate({ store: s, movie: { title: 'Kill Me Three Times', year: 2014, rated: 'R' }, cfg: { blockedRatings: ['R'] },
      gemini: { enabled: false } });
    ok(off.call.blocked === false && off.bypass, 'the check switched off changes nothing for a listed film');
    const pg = await contentGate({ store: s, movie: { title: 'Kill Me Three Times', year: 2014, rated: 'PG' }, cfg: { blockedRatings: ['R'] }, gemini });
    ok(pg.call.blocked === false && !pg.bypass && pg.call.reason === 'allowed' && asked === 0,
      'a film its rating allows is simply allowed - the list is not why it goes out, and nothing is asked');
    const none = await contentGate({ store: store(), movie: { title: 'Kill Me Three Times', year: 2014, rated: 'R' }, cfg: { blockedRatings: ['R'] },
      gemini: { ...gemini, allowCleanRatedFilms: false } });
    ok(none.call.blocked === true && none.call.reason === 'blocked by rating' && asked === 0,
      'without an entry, and with nothing the AI could clear, the rating refuses it and nothing is asked');
  } finally {
    globalThis.fetch = realFetch;
  }
  ok(bypassNote({ title: 'The Last Samurai', year: 2003, addedBy: 'mommy' })
    === 'sent: on the bypass list (rating override for "The Last Samurai" (2003) by mommy)', 'bypassNote names the entry');
  ok(BYPASS_NOTE === 'on the bypass list - sent without the AI check', 'and the Test tab has its own words for it');

  // An entry that could cover a film once the library has named it: a link
  // that is not a show's, or a title not narrowed to a season or episode.
  const tvOnly = store();
  addOverride(tvOnly, 'Fargo season 2');
  addOverride(tvOnly, 'a1'.repeat(16), { resolved: { kind: 'tv', covers: 'Fargo — whole series' } });
  ok(mayCoverFilms(tvOnly) === false && mayCoverFilms(store()) === false, 'a season entry and a show\'s link cover no film');
  addOverride(tvOnly, 'b2'.repeat(16));
  ok(mayCoverFilms(tvOnly) === true, 'a link of unknown kind may');
}

console.log('=== the request path wires it that way round ===');
{
  const src = fs.readFileSync(new URL('../src/plugins/movie-requests/index.js', import.meta.url), 'utf8');
  // The steps live in film-gate.js since 2026-09-29, shared with the panel's
  // dry run, whose own copy of the rating step ignored the list.
  const gate = fs.readFileSync(new URL('../src/plugins/movie-requests/film-gate.js', import.meta.url), 'utf8');
  ok(/const letter = ratingGate\(ctx\.store, movie, cfg, \{ gemini: ctx\.config\.gemini, ai: ctx\.config\.ai \}\);\s*const ratingOverride = letter\.override;/.test(src)
    && /const override = store \? isOverridden\(store, movie\) : null;/.test(gate), 'the gate consults the list');
  // A letter-blocked film waits for the library when an entry by link could
  // cover the library's item - step 2 used to refuse it before then.
  ok(/mayCoverFilms\(store\)/.test(gate) && /if \(letter\.deferred\) return refuseOnLetter\(\);/.test(src),
    'a refusal that the library\'s answer could change waits for it, and happens then if nothing changes it');
  ok(/if \(entry\) return \{ step: 'bypass', entry \};\s*const g = gemini \?\? \{\};\s*return \{ step: aiCanClear/.test(gate)
    && /if \(plan\.step === 'bypass'\) \{\s*return \{[\s\S]{0,120}bypass: true/.test(gate)
    && gate.indexOf('bypass: true') < gate.indexOf('await checkNudity('),
    'an entry sends the title before any AI call is made');
  ok(/Add it under Settings → Rated-R override/.test(src),
    'and a blocked link tells the admin where the list lives');
}

console.log('=== the panel warns, loudly ===');
{
  const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../src/web/public/style.css', import.meta.url), 'utf8');

  ok(/Rated-R override/.test(html), 'the section exists');
  ok(/Everything an entry covers is sent, with no AI nudity check/.test(html), 'it says an entry sends, with no AI check');
  ok(/recorded in the audit log/i.test(html), 'and that it is attributed');
  ok(/\.ro-warn\s*\{/.test(css) && /var\(--danger\)/.test(css.slice(css.indexOf('.ro-warn'))),
    'styled as a danger banner rather than a hint');
  ok(/confirm\(/.test(app.slice(app.indexOf("$('ro-add')"))), 'adding one asks first');
}

console.log('=== describeOverride ===');
{
  ok(/Kill Me/.test(describeOverride({ title: 'Kill Me Three Times', year: 2014, addedBy: 'a' })), 'names the film');
  ok(/by a/.test(describeOverride({ title: 'X', addedBy: 'a' })), 'and who allowed it');
  ok(describeOverride(null) === '', 'null is harmless');
}

console.log('=== kept where a build from before this one reads no more into it than this one does ===');
{
  // Every box follows main and a bad commit is taken back out, so a rollback
  // to a build from before TV is routine. That build reads every entry under
  // 'rating-overrides' as a film entry and knows nothing of seasons. This is
  // origin/main's isOverridden title match, as it reads the stored list:
  const oldBuildClears = (st, movie) => (st.get('rating-overrides', []) ?? []).some((e) => e.title
    && titleKey(e.title) === titleKey(movie.title) && (e.year == null || Number(e.year) === movie.year));

  const s = store();
  addOverride(s, 'Heat (1995)', { now: 1 });
  addOverride(s, 'Fargo', { now: 2 });
  addOverride(s, 'Fargo season 2', { now: 3 });
  addOverride(s, 'f'.repeat(32), { now: 4, resolved: { kind: 'tv', covers: 'Some Show (2010) — whole series' } });
  ok((s.get('rating-overrides') ?? []).map((e) => e.key).join() === `jf:${'f'.repeat(32)},t:fargo|,t:heat|1995`,
    'titles and links are kept where every build reads the list');
  ok((s.get(TV_KEY) ?? []).map((e) => e.key).join() === 't:fargo||2|', 'an entry narrowed to a season is kept apart');
  const seasonOnly = store();
  addOverride(seasonOnly, 'Fargo season 2');
  ok(!oldBuildClears(seasonOnly, { title: 'Fargo', year: 1996 }) && !isOverridden(seasonOnly, { title: 'Fargo', year: 1996 }),
    'so after a rollback "Fargo season 2" cannot clear the film Fargo, any more than it does here');
  ok(oldBuildClears(s, { title: 'Fargo', year: 1996 }) && !!isOverridden(s, { title: 'Fargo', year: 1996 }),
    'while a plain "Fargo" covers the film there as it does here - a title is films and TV alike');
  ok(listOverrides(s).map((e) => e.key).join() === `jf:${'f'.repeat(32)},t:fargo||2|,t:fargo|,t:heat|1995`,
    'the panel lists them as one list, newest first');
  let dup = null;
  try { addOverride(s, 'fargo'); } catch (e) { dup = e; }
  ok(/already on the list/.test(dup?.message ?? ''), 'the same title twice is refused, however it is typed');
  dup = null;
  try { addOverride(s, `https://jf/web/#/details?id=${'F'.repeat(32)}`); } catch (e) { dup = e; }
  ok(/already on the list/.test(dup?.message ?? ''), 'and the same link');
  ok(removeOverride(s, 't:fargo||2|') && s.get(TV_KEY).length === 0 && s.get('rating-overrides').length === 3,
    'removing the season entry touches only it');
  ok(removeOverride(s, 't:heat|1995') && s.get('rating-overrides').length === 2, 'removing a title touches only it');

  // An earlier build of this list kept TV entries apart, with a kind. They
  // are read as the title and link entries they are, and put where they
  // belong by the next save.
  const m = store({
    'rating-overrides': [{ key: 't:heat|1995', title: 'Heat', year: 1995, addedAt: 4 }],
    [TV_KEY]: [
      { kind: 'tv', key: 'tv:t:fargo|||', title: 'Fargo', year: null, season: null, episode: null, addedAt: 5 },
      { kind: 'tv', key: `tv:jf:${'e'.repeat(32)}`, jellyfinId: 'e'.repeat(32), title: null, covers: 'X — whole series', addedAt: 6 },
    ],
  });
  ok(!!isOverridden(m, { title: 'Fargo', year: 1996 }) && !('kind' in listOverrides(m).find((e) => e.key === 'tv:t:fargo|||')),
    'an old TV title entry is a title entry: it covers the film too');
  ok(!!tvOverrideFor(m, { id: 'e'.repeat(32), name: 'X' }, { season: 1, episode: 1 }), 'an old TV link still covers its show');
  addOverride(m, 'Ronin (1998)');
  ok(m.get('rating-overrides').some((e) => e.key === 'tv:t:fargo|||') && !m.get(TV_KEY).length,
    'and each is moved to where it belongs by the next save');
}

console.log('=== a name that ends in a year-like number covers itself ===');
{
  // "Blade Runner 2049" was saved as "Blade Runner" from 2049, and so
  // covered nothing: the film is from 2017, and the panel said "Matches
  // nothing". The entry cannot tell a year from the end of a name, so it is
  // read both ways; the second reading of "Dune 2021" is a name nothing has.
  const br = store();
  addOverride(br, 'Blade Runner 2049');
  ok(!!isOverridden(br, { title: 'Blade Runner 2049', year: 2017 }), 'the film Blade Runner 2049 (2017), typed as the library names it');
  ok(!isOverridden(br, { title: 'Blade Runner', year: 1982 }), 'and not Blade Runner (1982): the number is not its year either');
  ok(!!entryCoversName(listOverrides(br)[0], { name: 'Blade Runner 2049', year: 2017, type: 'film' }),
    'the panel\'s "matches now" line says so, by the same rule');
  const space = store();
  addOverride(space, 'Space: 1999');
  ok(!!tvOverrideFor(space, { name: 'Space: 1999', year: 1975 }, { season: 1, episode: 1 }), 'the series Space: 1999 (1975)');
  const sea = store();
  addOverride(sea, 'Space: 1999 season 2');
  ok(!!tvOverrideFor(sea, { name: 'Space: 1999', year: 1975 }, { season: 2, episode: 1 })
    && !tvOverrideFor(sea, { name: 'Space: 1999', year: 1975 }, { season: 1, episode: 1 }), 'and narrowed to a season, only that season');
  for (const [typed, name, year] of [['Class of 1984', 'Class of 1984', 1982], ['Death Race 2000', 'Death Race 2000', 1975], ['Airport 1975', 'Airport 1975', 1974]]) {
    const st = store();
    addOverride(st, typed);
    ok(!!isOverridden(st, { title: name, year }), `"${typed}" covers ${name} (${year})`);
  }
  // The year still narrows, where it is one.
  const dune = store();
  addOverride(dune, 'Dune 2021');
  ok(!!isOverridden(dune, { title: 'Dune', year: 2021 }) && !isOverridden(dune, { title: 'Dune', year: 1984 }),
    '"Dune 2021" still covers the 2021 Dune and not the 1984 one');
  const paren = store();
  addOverride(paren, 'Blade Runner 2049 (2017)');
  ok(!!isOverridden(paren, { title: 'Blade Runner 2049', year: 2017 }), 'and a year in brackets on a name ending in a number works as before');
  ok(parseEntry('Blade Runner 2049').key === 't:blade runner|2049', 'the key every build gave it is kept');
}

console.log('=== a name in any script is a name ===');
{
  // titleKey kept a-z and 0-9 only, so a Hebrew, Cyrillic or Japanese name
  // came out empty: the panel refused it, falsely, with "has no letters or
  // numbers", and nothing the library names that way could be covered.
  for (const [typed, library] of [['שטיסל', 'שטיסל'], ['Шерлок', 'Шерлок'], ['進撃の巨人', '進撃の巨人 The Final Season'], ['קופה ראשית 2', 'קופה ראשית']]) {
    let entry = null, err = null;
    try { entry = parseEntry(typed); } catch (e) { err = e; }
    ok(!err && entry?.title, `"${typed}" is saved (${err?.message ?? entry.key})`);
  }
  const heb = store();
  addOverride(heb, 'שטיסל');
  ok(!!tvOverrideFor(heb, { name: 'שטיסל', year: 2013 }, { season: 1, episode: 1 }), 'and covers the show the library names that way');
  ok(!!isOverridden(heb, { title: 'שטיסל' }), 'or a film of that name');
  ok(!isOverridden(heb, { title: 'Шерлок' }) && !isOverridden(heb, { title: 'Heat', year: 1995 }),
    'and nothing else: an empty name matched everything with no a-z in it');
  const ru = store();
  addOverride(ru, 'шерлок');
  ok(!!tvOverrideFor(ru, { name: 'Шерлок', year: 2010 }, { season: 1, episode: 1 }), 'case is folded in Cyrillic too');
  let dup = null;
  try { addOverride(heb, 'שְׁטִיסֶל'); } catch (e) { dup = e; }
  ok(/already on the list/.test(dup?.message ?? ''), 'with its vowel points it is the same entry');
  ok(titleKey('Léon') === 'leon' && titleKey('Amélie & Co.') === 'amelie and co', 'accented Latin folds as it always did');
  for (const bad of ['!!!', '🎬🎬', '—']) {
    let threw = null;
    try { parseEntry(bad); } catch (e) { threw = e; }
    ok(/no letters or numbers/.test(threw?.message ?? ''), `${JSON.stringify(bad)} really has none, and is refused`);
  }

  // A build from before this one folds "שטיסל" to nothing, and in its match
  // nothing equals every other name with no a-z in it: kept under
  // 'rating-overrides', a rollback would cover every such film. It is kept
  // apart, as a season entry is; an a-z name stays where every build reads it.
  const oldBuildClears = (st, movie) => (st.get('rating-overrides', []) ?? []).some((e) => {
    const k = (x) => String(x ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
    return e.title && k(e.title) === k(movie.title) && (e.year == null || Number(e.year) === movie.year);
  });
  const mixed = store();
  addOverride(mixed, 'שטיסל', { now: 1 });
  addOverride(mixed, 'Léon', { now: 2 });
  ok(!oldBuildClears(mixed, { title: 'Шерлок', year: 2010 }) && !(mixed.get('rating-overrides') ?? []).some((e) => e.title === 'שטיסל'),
    'a name in another script is not where an old build would read it as nothing');
  ok((mixed.get(TV_KEY) ?? []).some((e) => e.title === 'שטיסל') && (mixed.get('rating-overrides') ?? []).some((e) => e.title === 'Léon'),
    'it is kept apart; "Léon" stays where every build reads it');
  ok(listOverrides(mixed).length === 2 && !!isOverridden(mixed, { title: 'שטיסל' }) && !!isOverridden(mixed, { title: 'Leon', year: 1994 }),
    'and this build reads both, as one list');
  ok(removeOverride(mixed, parseEntry('שטיסל').key) && listOverrides(mixed).length === 1, 'and removes it by its key');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
