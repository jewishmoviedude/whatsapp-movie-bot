/* A bypass-list entry covers only its exact title.
   Run: node test/bypass-exact-title.test.mjs

   Since 2026-09-29 an entry on the bypass list sends what it covers with no
   AI check - the operator's "Send it, no AI check". Until that evening a
   title also covered every film and show whose name started with it, word
   for word, so an entry for "Heat" would have sent "Heat and Dust", and
   every TV-MA episode of a show of that name, unchecked. Asked whether
   "Heat" should also send "Heat and Dust", the operator chose "Exact title
   only".

   Pinned here, on every rule that reads the list - a film request
   (isOverridden, and contentGate, which sends it), a TV episode
   (tvOverrideFor) and the panel's "matches now" line (entryCoversName):
    - a title covers its exact name and nothing longer, with case, spaces
      and punctuation ignored;
    - a year narrows it, and a year in brackets on a library name ("Fruits
      Basket (2019)", as the live library has it) is that name's year, not
      part of the title;
    - a season or an episode narrows it, for TV;
    - a Jellyfin link is exact by id, a series link covering its twin
      library entry as before;
    - the owner's old entry "full metal alchemist" no longer covers
      "Fullmetal Alchemist: Brotherhood", and the entry on the live list,
      typed with the show's full name, still does. */
import {
  addOverride, listOverrides, isOverridden, tvOverrideFor, entryCoversName, TV_KEY,
} from '../src/core/rating-overrides.js';
import { contentGate } from '../src/plugins/movie-requests/film-gate.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

function store(init = {}) {
  const d = { ...init };
  return { get: (k, v) => (k in d ? d[k] : v), set: (k, v) => { d[k] = v; } };
}
const on = (...inputs) => { const s = store(); for (const i of inputs) addOverride(s, i); return s; };
const ep = (season, episode, extra = {}) => ({ season, episode, ...extra });

console.log('=== "Heat" sends Heat, and not Heat and Dust ===');
{
  const heat = on('Heat');
  const [e] = listOverrides(heat);
  ok(!!isOverridden(heat, { title: 'Heat', year: 1995 }), 'the film "Heat" is covered');
  ok(!isOverridden(heat, { title: 'Heat and Dust', year: 1983 }), 'the film "Heat and Dust" is not');
  ok(!tvOverrideFor(heat, { name: 'Heat and Dust', year: 1983 }, ep(1, 1)), 'nor a show called "Heat and Dust"');
  ok(!entryCoversName(e, { name: 'Heat and Dust', year: 1983, type: 'film' }), 'nor does the panel list it as a match');
  ok(!isOverridden(heat, { title: 'Heathers', year: 1988 }), 'and "Heathers" never was');
  const sent = await contentGate({
    store: heat, movie: { title: 'Heat', year: 1995, rated: 'R' }, cfg: { blockedRatings: ['R'] }, gemini: { enabled: false },
  });
  ok(!!sent.bypass && !sent.call.blocked, 'an R "Heat" is sent on the entry');
  const held = await contentGate({
    store: heat, movie: { title: 'Heat and Dust', year: 1983, rated: 'R' }, cfg: { blockedRatings: ['R'] }, gemini: { enabled: false },
  });
  ok(!held.bypass && held.call.blocked, 'an R "Heat and Dust" is refused on its rating');
}

console.log('=== case, spaces and punctuation are still ignored ===');
{
  const k = on('KILL-ME three times');
  ok(!!isOverridden(k, { title: 'Kill Me Three Times', year: 2014 }), '"KILL-ME three times" covers "Kill Me Three Times"');
  ok(!isOverridden(on('KILL-ME three'), { title: 'Kill Me Three Times', year: 2014 }), 'and "KILL-ME three" does not');
  ok(!!tvOverrideFor(on('full metal alchemist'), { name: 'Fullmetal Alchemist', year: 2003 }, ep(1, 1)),
    '"full metal alchemist" covers "Fullmetal Alchemist": only the spaces differ');
  ok(!!isOverridden(on('leon 1994'), { title: 'Léon', year: 1994 }), 'accents are folded');
  ok(!isOverridden(on('Thing'), { title: 'The Thing', year: 1982 }), 'no word is dropped: "Thing" is not "The Thing"');
}

console.log('=== a year narrows it, and a year in brackets on a library name is its year ===');
{
  const heat = on('Heat 1995');
  ok(!!isOverridden(heat, { title: 'Heat', year: 1995 }) && !isOverridden(heat, { title: 'Heat', year: 1986 }), '"Heat 1995" covers the 1995 Heat only');
  ok(!!isOverridden(on('Blade Runner 2049'), { title: 'Blade Runner 2049', year: 2017 }), 'a name ending in a year-like number still covers itself');
  const fb = on('Fruits Basket');
  ok(!!tvOverrideFor(fb, { name: 'Fruits Basket (2019)', year: 2019 }, ep(1, 1)), '"Fruits Basket" covers the library\'s "Fruits Basket (2019)"');
  ok(!tvOverrideFor(on('Fruits Basket 2001'), { name: 'Fruits Basket (2019)', year: 2019 }, ep(1, 1)), '"Fruits Basket 2001" does not');
  ok(!tvOverrideFor(fb, { name: 'Fruits Basket: Prelude (2022)', year: 2022 }, ep(1, 1)), 'nor does a longer name with a year become its start');
}

console.log('=== a season or an episode narrows it ===');
{
  const s = on('Fullmetal Alchemist: Brotherhood S01E14');
  const bh = { name: 'Fullmetal Alchemist: Brotherhood', year: 2009 };
  ok(!!tvOverrideFor(s, bh, ep(1, 14)) && !tvOverrideFor(s, bh, ep(1, 19)), 'an episode entry covers that episode');
  ok(!isOverridden(s, { title: 'Fullmetal Alchemist: Brotherhood', year: 2009 }), 'and no film');
  ok(!tvOverrideFor(on('Fullmetal Alchemist S01E14'), bh, ep(1, 14)), 'and only of the show it names');
}

console.log('=== a Jellyfin link is exact by id, and a series link covers its twin entry ===');
{
  const A = 'aa'.repeat(16), B = 'bb'.repeat(16), OTHER = 'cc'.repeat(16);
  const s = store();
  addOverride(s, A, { resolved: { kind: 'tv', covers: 'Blue Exorcist (2011) — whole series', twinIds: [B] } });
  const epIn = (sid) => ({ id: 'e'.repeat(32), season: 2, episode: 3, seriesId: sid, series: 'Blue Exorcist' });
  ok(!!tvOverrideFor(s, { id: A, name: 'Blue Exorcist', year: 2011 }, epIn(A)), 'the linked series');
  ok(!!tvOverrideFor(s, { id: B, name: 'Blue Exorcist', year: 2011 }, epIn(B)), 'its twin library entry');
  ok(!tvOverrideFor(s, { id: OTHER, name: 'Blue Exorcist', year: 2011 }, epIn(OTHER)), 'and not another show of the same name');
  const film = store();
  addOverride(film, 'f'.repeat(32));
  ok(!!isOverridden(film, { title: 'Anything' }, { id: 'f'.repeat(32), title: 'Some Film' }), 'a film link covers the library item it names');
}

console.log('=== the owner\'s entries, exactly as stored ===');
{
  // The owner's entry of 2026-09-28, meant for Brotherhood, and the entry on
  // the live list (data/state.json) on 2026-09-29, typed in full.
  const old = store({ 'rating-overrides': [{ key: 't:full metal alchemist|', jellyfinId: null, title: 'full metal alchemist', year: null,
    addedBy: { username: 'superadmin', role: 'superadmin' }, note: '', addedAt: 1790636001601 }] });
  const live = store({ [TV_KEY]: [{ key: 't:fullmetal alchemist brotherhood||1|', jellyfinId: null, title: 'Fullmetal Alchemist: Brotherhood',
    year: null, season: 1, episode: null, addedBy: 'superadmin', note: '', addedAt: 1790697271873 }] });
  const bh = { name: 'Fullmetal Alchemist: Brotherhood', year: 2009 };
  ok(!tvOverrideFor(old, bh, ep(1, 14)), '"full metal alchemist" no longer covers Brotherhood\'s S01E14');
  ok([14, 19, 26].every((n) => !!tvOverrideFor(live, bh, ep(1, n))), '"Fullmetal Alchemist: Brotherhood season 1" covers S01E14, S01E19 and S01E26');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
