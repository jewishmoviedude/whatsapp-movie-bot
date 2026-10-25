/* TV: an episode on the bypass list is sent with no AI check, and the AI
   check only ever helps an episode its rating blocks through.
   Run: node test/tv-rating-override.test.mjs

   The case behind the list: Fullmetal Alchemist: Brotherhood (2009) is
   TV-14, but S01E14 "Those Who Lurk Underground", S01E19 "Death of the
   Undying" and S01E26 "Reunion" are each TV-MA in Jellyfin - for violence. A
   member got 61 of 64 episodes, and was refused E14 on its own twice on
   2026-09-28. The owner then added "full metal alchemist" to the list,
   meaning Brotherhood; the list matched titles strictly and by Film / TV
   then, so it covered nothing. "Why you making everything so complicated?
   You know what I want, get it done". So there is one list, no Film / TV
   choice: a title covers the show (and film) whose name, with case, spaces
   and punctuation ignored, is exactly it, narrowed by a year, a season or an
   episode; a link is exact. It covered every name that started with it too,
   until the operator was asked on 2026-09-29 whether "Heat" should also
   send "Heat and Dust" and chose "Exact title only": the owner's "full
   metal alchemist" now covers the 2003 series and not Brotherhood, and the
   entry on the live list, typed with Brotherhood's full name, sends it.

   What an entry does was decided by the operator on 2026-09-29. Gemini's
   model answered 503 all afternoon, Groq's gpt-oss-120b said The Last
   Samurai had nudity - IMDb says it has none - and a title listed by hand
   was held back: "Why ask Gemini if I already added it to rated R bypass
   manually in panel?" Asked what adding a title should do: "Send it, no AI
   check". Asked what the AI check is for: "The AI check is so the request
   can go through without getting denied if possible" - and whether it
   should still block what the rating lets through: "No, AI only helps".

   Pinned here, through the real TV plugin (Jellyfin, Gemini and Groq are a
   stubbed fetch):
    - a bypass-list title is sent without asking the AI - a TV season, a TV
      episode, a link, a series rated as a whole, the panel's manual queue -
      and no kept answer is consulted; the live list's entry, exactly as
      stored, sends Brotherhood's three TV-MA episodes, and the owner's
      older "full metal alchemist" no longer does;
    - a TV-MA episode not on the list is cleared by a sure "no nudity" and
      stays withheld, on its rating, on nudity or no answer - and nothing is
      asked where the operator does not let a clean answer clear it;
    - an episode its rating allows is sent and never asked about, and the
      TV-14 copy of an episode is sent whatever the check said of its TV-MA
      copy;
    - the day's incident replayed for an episode: listed, Gemini 503, Groq
      saying nudity - sent, zero AI calls;
    - the machinery the check keeps: at most maxChecks per message, stopping
      at the first check that cannot run, paced, never spent on episodes the
      cap or a full queue would cut; an answer kept per episode, and only
      for the episode it was about; only a "no nudity" that sends kept for
      months, every other answer a day;
    - History and the group name as sent on the list only the episodes that
      went into the queue: with the episode cap at 20, not FMA:B's E26;
    - what the panel is told an entry matches in the library, as
      information. */
import plugin from '../src/plugins/tv-requests/index.js';
import {
  parseEntry, parseTvTitle, addOverride, listOverrides, tvOverrideFor, isOverridden, describeOverride, tvScope, TV_KEY,
} from '../src/core/rating-overrides.js';
import {
  screenRated, describeScreen, LIMITS, resetPacing, CACHE_KEY, CACHE_TTL, describeLink, libraryMatches, resetLibraryNames,
} from '../src/plugins/tv-requests/override-check.js';
import { RATING_NOTICE_FEATURE } from '../src/plugins/tv-requests/withheld.js';
import { resetBreakers, resetModelCache } from '../src/core/ai-providers.js';
import { checkEpisodeNudity, episodeSubject, decide } from '../src/plugins/movie-requests/content-check.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

LIMITS.paceMs = 0;          // no two-second gaps in a test

const TVREQ = 'tvreq@g.us';
const NOTIFY = 'notify@g.us';
const POSTS = 'tvposts@g.us';

const FMA = 'Fullmetal Alchemist: Brotherhood';
const SERIES_ID = 'a1'.repeat(16);
const SEASON_ID = 'b2'.repeat(16);
const epId = (n) => `e${String(n).padStart(3, '0')}`.padEnd(32, 'c');
const MA = new Set([14, 19, 26]);
const TITLES = { 14: 'Those Who Lurk Underground', 19: 'Death of the Undying', 26: 'Reunion' };

function store(init = {}) {
  const d = { ...init };
  return { _d: d, get: (k, v) => (k in d ? d[k] : v), set: (k, v) => { d[k] = v; } };
}

/* ------------------------------------------------------------ network --- */

let verdicts = {};          // "S01E19" -> {nudity, confidence, basis} | 'fail' | 'overloaded'
let groqAnswer = 'rate';    // 'rate' (HTTP 429) or a verdict Groq gives
let aiCalls = [];           // every prompt Gemini or Groq was sent
let detailCalls = 0;
let seriesRating = 'TV-14';
let seriesName = FMA;
let episodeCount = 64;
let episodeRating = (n) => (MA.has(n) ? 'TV-MA' : 'TV-14');
let extraEpisodes = [];     // more library items, e.g. a second copy of one episode

const json = (v, status = 200) => ({
  ok: status < 400, status, statusText: status < 400 ? 'OK' : 'Too Many Requests', headers: new Headers(),
  json: async () => v, text: async () => JSON.stringify(v),
});

function episodesJson() {
  return {
    Items: Array.from({ length: episodeCount }, (_, k) => ({
      Id: epId(k + 1), SeriesName: seriesName, SeriesId: SERIES_ID, SeasonId: SEASON_ID,
      ParentIndexNumber: 1, IndexNumber: k + 1, Name: TITLES[k + 1] ?? `Episode ${k + 1}`,
      OfficialRating: episodeRating(k + 1),
      MediaSources: [{ Path: `/tv/fma/${k + 1}.mkv`, Size: 1000, Container: 'mkv' }],
    })).concat(extraEpisodes),
  };
}

function answerFor(prompt) {
  const code = prompt.match(/Episode: (S\d\dE\d\d)/)?.[1];
  const v = verdicts[code] ?? { nudity: false, confidence: 0.9, basis: 'violence, no nudity' };
  return v;
}

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('generativelanguage.googleapis.com')) {
    const prompt = JSON.parse(init.body).contents[0].parts[0].text;
    aiCalls.push({ provider: 'gemini', prompt });
    const v = answerFor(prompt);
    if (v === 'fail') return json({ error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } }, 429);
    if (v === 'overloaded') {
      return json({ error: { code: 503, message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary.', status: 'UNAVAILABLE' } }, 503);
    }
    return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(v) }] }, finishReason: 'STOP' }] });
  }
  if (u.includes('api.groq.com')) {
    const prompt = JSON.parse(init.body).messages.at(-1).content;
    aiCalls.push({ provider: 'groq', prompt });
    if (groqAnswer === 'rate') return json({ error: { message: 'Rate limit reached', type: 'tokens', code: 'rate_limit_exceeded' } }, 429);
    return json({ id: 'c1', object: 'chat.completion', model: 'openai/gpt-oss-120b',
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(groqAnswer) }, finish_reason: 'stop' }] });
  }
  const p = new URL(u);
  if (p.pathname.endsWith('/Seasons')) return json({ Items: [{ Id: SEASON_ID, IndexNumber: 1, ChildCount: episodeCount }] });
  if (p.pathname.endsWith('/Episodes')) return json(episodesJson());
  if (p.pathname === '/Items' && p.searchParams.get('Ids')) {
    detailCalls += 1;
    const ids = p.searchParams.get('Ids').split(',');
    if (ids.includes(SERIES_ID)) return json({ Items: [{ Id: SERIES_ID, Type: 'Series', Name: seriesName, ProductionYear: 2009 }] });
    if (ids.includes(SEASON_ID)) return json({ Items: [{ Id: SEASON_ID, Type: 'Season', Name: 'Season 1', IndexNumber: 1, SeriesName: seriesName }] });
    if (ids.includes('f'.repeat(32))) return json({ Items: [{ Id: 'f'.repeat(32), Type: 'Movie', Name: 'Some Film', ProductionYear: 2001 }] });
    return json({
      Items: ids.map((id) => {
        const n = Number(id.slice(1, 4));
        return {
          Id: id, Type: 'Episode', Name: TITLES[n] ?? `Episode ${n}`, SeriesName: seriesName, ParentIndexNumber: 1, IndexNumber: n,
          Overview: `What happens in episode ${n}.`, ProviderIds: { Imdb: `tt90000${n}`, Tvdb: `70${n}` }, PremiereDate: '2009-07-05T00:00:00Z',
        };
      }),
    });
  }
  if (p.pathname === '/Items' || p.pathname === '/Search/Hints') {
    return json({
      Items: [{ Id: SERIES_ID, Name: seriesName, ProductionYear: 2009, OfficialRating: seriesRating, RecursiveItemCount: episodeCount, ProviderIds: { Imdb: 'tt1355642' } }],
      SearchHints: [],
    });
  }
  return json({}, 404);
};

function reset({ rating = 'TV-14', name = FMA, count = 64, per = (n) => (MA.has(n) ? 'TV-MA' : 'TV-14') } = {}) {
  verdicts = {}; groqAnswer = 'rate'; aiCalls = []; detailCalls = 0; extraEpisodes = [];
  seriesRating = rating; seriesName = name; episodeCount = count; episodeRating = per;
  resetBreakers(); resetModelCache(); resetPacing();
}

/* ------------------------------------------------------------ harness --- */

// The AI check could clear a rated episode: the operator's switch, which is
// on on the live bot.
const CLEARS = { allowCleanRatedFilms: true };
const NUDE = { nudity: true, confidence: 0.95, basis: 'nudity' };

function harness({
  overrides = [], stored = null, storedTv = null, feature = 'on', replyOnBlock = false, gemini = {}, ai = null, withOverrideStore = true,
  cap = 0, room = 500, tvStore = null,
} = {}) {
  const texts = [], reacted = [], jobs = [];
  const tv = tvStore ?? store();
  // `stored` and `storedTv`: the list exactly as state.json holds it, not as
  // addOverride writes it - a season entry is kept under TV_KEY.
  const ov = store({
    ...(stored ? { 'rating-overrides': structuredClone(stored) } : {}),
    ...(storedTv ? { [TV_KEY]: structuredClone(storedTv) } : {}),
  });
  for (const o of overrides) addOverride(ov, o.input, { addedBy: 'owner', ...(o.resolved ? { resolved: o.resolved } : {}) });
  const ctx = {
    config: {
      tvRequests: {
        enabled: true, requestGroups: [TVREQ], postsGroups: [POSTS], cooldownSecondsPerUser: 0,
        blockedRatings: ['TV-MA', 'R', 'NC-17', 'X'], maxEpisodesPerRequest: cap,
      },
      movieRequests: {
        requestGroups: [], replyOnBlock, announceRated: true,
        reactions: { researching: '🔍', added: '🎬', rated: '⛔', notInLibrary: '📬', failed: '⚠️', done: '✅' },
        notify: { group: NOTIFY },
      },
      beta: { groups: [], postsGroup: '', features: feature ? { [RATING_NOTICE_FEATURE]: feature } : {} },
      library: { jellyfin: { baseUrl: 'http://jf:8096', accessToken: 'TOK', userId: 'U1' } },
      gemini: { enabled: true, contentCheck: true, apiKey: 'GEMINI-KEY-123', model: 'gemini-test', minContentConfidence: 0.7, ...gemini },
      ...(ai ? { ai } : {}),
      media: { workDir: '/tmp/tv-rating-override' },
    },
    bot: {
      isConnected: () => true,
      react: async (m, e) => { reacted.push(e); },
      sendText: async (jid, body, opts = {}) => { texts.push({ jid, body, quoted: !!opts.quoted }); return { key: { id: 'X' } }; },
      isGroupAdmin: () => false,
      deleteMessage: async () => {},
      archiveChat: async () => {},
    },
    // `room` is places left for REQUESTS: a season takes one, however many
    // episodes it holds (src/core/queue.js hasRoom).
    queue: { maxLength: room, pending: [], add: (j) => { jobs.push(j); return `job-${jobs.length}`; }, hasRoom: (n = 1) => room >= n },
    store: tv,
    ...(withOverrideStore ? { overrideStore: ov } : {}),
    log: { info() {}, warn() {}, error() {}, debug() {} },
  };
  return { ctx, texts, reacted, jobs, tv, ov, history: () => tv.get('history', []) };
}

let seq = 0;
const mkMsg = (text) => ({
  id: `MSG${++seq}`, key: { id: `MSG${seq}` }, text, chatJid: TVREQ, isGroup: true, fromMe: false,
  messageType: 'conversation', senderJid: 'ari@lid', senderNumber: '15551112222',
  senderNumberDisplay: '+1 555 111 2222', pushName: 'Ari', timestamp: Date.now(),
});
const settle = () => new Promise((r) => setTimeout(r, 10));
const onNotify = (texts) => texts.filter((t) => t.jid === NOTIFY).map((t) => t.body);
const queued = (jobs) => jobs.map((j) => j.meta.episode);
const ask = async (h, text) => { await plugin.onMessage(mkMsg(text), h.ctx); await settle(); };
const codes = () => aiCalls.map((a) => a.prompt.match(/Episode: (S\d\dE\d\d)/)?.[1]);

/* ================================================================ entries */

console.log('=== entries: what an admin can type ===');
{
  const p = parseTvTitle('Fullmetal Alchemist: Brotherhood (2009) S01E14');
  ok(p.title === FMA && p.year === 2009 && p.season === 1 && p.episode === 14, 'show (year) S01E14');
  ok(parseTvTitle('Fullmetal Alchemist: Brotherhood season 1').season === 1
    && parseTvTitle('Fullmetal Alchemist: Brotherhood season 1').episode === null, '"season 1" is a season');
  ok(parseTvTitle('The Office 2x03').season === 2 && parseTvTitle('The Office 2x03').episode === 3, '2x03');
  ok(parseTvTitle('Show - season 2 episode 5').episode === 5, '"season 2 episode 5"');
  ok(parseTvTitle(FMA).season === null && parseTvTitle(FMA).episode === null, 'a bare name is every season');
  ok(parseTvTitle('24 S01').title === '24' && parseTvTitle('1883').title === '1883', 'shows named after numbers keep their name');
  ok(parseTvTitle('Stranger Things 4').title === 'Stranger Things 4' && parseTvTitle('Stranger Things 4').season === null,
    'a bare trailing number is NOT read as a season - it is part of the name');
  const vague = parseTvTitle('Fullmetal Alchemist episode 14');
  ok(vague.season === null && vague.episode === null && vague.title === 'Fullmetal Alchemist episode 14',
    'an episode with no season is not guessed at: it is read as a name, and saved');

  const series = parseEntry(FMA);
  const season = parseEntry(`${FMA} season 1`);
  const one = parseEntry(`${FMA} S01E14`);
  const link = parseEntry(`https://jf/web/index.html#!/details?id=${SERIES_ID}`, { resolved: { kind: 'tv', covers: `${FMA} (2009) — whole series` } });
  ok(!('kind' in series) && tvScope(series) === 'whole series', 'a title has no Film / TV kind');
  ok(tvScope(season) === 'season 1' && tvScope(one) === 'S01E14', 'a season entry and an episode entry');
  ok(new Set([series.key, season.key, one.key]).size === 3, 'each with its own key');
  ok(link.key === `jf:${SERIES_ID}` && link.jellyfinId === SERIES_ID && link.kind === 'tv', 'a link keeps the item id, and what it is');
  ok(parseEntry(SERIES_ID).key === link.key, 'one key per link, whatever it turns out to be');
  ok(describeOverride({ ...one, addedBy: 'owner' }) === `rating override for "${FMA}" S01E14 by owner`,
    `the log line says what it covers: "${describeOverride({ ...one, addedBy: 'owner' })}"`);
}

console.log('=== entries match by name, exactly; a year, season or episode narrows ===');
{
  const series = { id: SERIES_ID, name: FMA, year: 2009 };
  const ep = (n, extra = {}) => ({ id: epId(n), season: 1, episode: n, series: FMA, seasonId: SEASON_ID, seriesId: SERIES_ID, ...extra });
  const on = (input) => { const s = store(); addOverride(s, input); return s; };

  ok(!!tvOverrideFor(on(FMA), series, ep(14)), 'the show\'s name covers every episode');
  ok(!!tvOverrideFor(on('fullmetal alchemist brotherhood'), series, ep(14)), 'case and punctuation are ignored');
  ok(!!tvOverrideFor(on('full metal alchemist brother hood'), series, ep(14)), 'and spaces too');
  // "Exact title only" (2026-09-29): a name that only starts the show's
  // covers it no longer.
  ok(!tvOverrideFor(on('full metal alchemist'), series, ep(14)), '"full metal alchemist" does not cover "Fullmetal Alchemist: Brotherhood"');
  ok(!tvOverrideFor(on('Fullmetal Alchemist'), series, ep(14)), 'nor does the 2003 series\' name, which Brotherhood only starts with');
  ok(!!tvOverrideFor(on('full metal alchemist'), { id: 'x'.repeat(32), name: 'Fullmetal Alchemist', year: 2003 }, ep(1, { series: 'Fullmetal Alchemist' })),
    'it covers the 2003 series itself');
  ok(!!tvOverrideFor(on(`${FMA} 2009`), series, ep(14)), 'with the year');
  ok(!tvOverrideFor(on('full metal alchemist 2003'), series, ep(14)), 'a year narrows it: 2003 does not cover the 2009 show');
  ok(!!tvOverrideFor(on(`${FMA} season 1`), series, ep(19)), 'a season entry covers its season');
  ok(!tvOverrideFor(on(`${FMA} season 2`), series, ep(19)), 'and not another season');
  ok(!!tvOverrideFor(on('fullmetal alchemist: brotherhood S01E14'), series, ep(14)), 'an episode entry covers its episode');
  ok(!tvOverrideFor(on('full metal alchemist S01E14'), series, ep(14)), 'when it names the show: "full metal alchemist S01E14" is the 2003 series\'');
  ok(!tvOverrideFor(on(`${FMA} S01E14`), series, ep(19)), 'and nothing else');
  ok(!tvOverrideFor(on(`${FMA} S01E14`), series, ep(14, { season: null })), 'an episode with no season number is not assumed to be season 1');

  // The whole name, not any part of it, and nothing dropped.
  ok(!tvOverrideFor(on('Brotherhood'), series, ep(14)), 'a later part of the name does not match');
  ok(!tvOverrideFor(on('The Fullmetal Alchemist'), series, ep(14)), 'an added article is not dropped');
  ok(!tvOverrideFor(on('Fullmetal Alchemist Brotherhod'), series, ep(14)), 'a misspelling is not the name');

  ok(!!tvOverrideFor(on(SERIES_ID), series, ep(14)), 'a series link covers the series');
  ok(!!tvOverrideFor(on(`https://jf/Items/${SEASON_ID}/Download`), series, ep(26)), 'a season link covers the season');
  ok(!!tvOverrideFor(on(epId(14)), series, ep(14)), 'an episode link covers the episode');
  ok(!tvOverrideFor(on(epId(14)), series, ep(19)), 'and no other');
  ok(!tvOverrideFor(on('9'.repeat(32)), series, ep(14)), 'a link to anything else covers nothing');

  // One list: a title covers films and shows alike.
  const both = on('Fargo');
  ok(!!tvOverrideFor(both, { name: 'Fargo', year: 2014 }, { season: 1, episode: 1 }) && !!isOverridden(both, { title: 'Fargo', year: 1996 }),
    'one title covers the show Fargo and the film Fargo');
  const dup = on(FMA);
  let again = null;
  try { addOverride(dup, 'fullmetal alchemist: brotherhood'); } catch (e) { again = e; }
  ok(/already on the list/.test(again?.message ?? ''), 'the same title twice is refused');
}

console.log('=== the live list\'s entry sends E14, E19 and E26 with no AI check; the owner\'s older one no longer does ===');
{
  // data/state.json on the live bot, movie-requests.rating-overrides, as the
  // owner added it on 2026-09-28, meaning Fullmetal Alchemist: Brotherhood.
  // It covered Brotherhood while an entry covered every name it was the
  // start of. Since "Exact title only" (2026-09-29) it is the 2003 series'
  // name and nothing longer, so Brotherhood's TV-MA episodes are judged as
  // any unlisted episode is: put to the AI check, and withheld on their
  // rating unless it clears them.
  const LIVE = [{ key: 't:full metal alchemist|', jellyfinId: null, title: 'full metal alchemist', year: null,
    addedBy: { username: 'superadmin', role: 'superadmin' }, note: '', addedAt: 1790636001601 }];
  const series = { id: SERIES_ID, name: FMA, year: 2009 };
  const live = store({ 'rating-overrides': structuredClone(LIVE) });
  ok([14, 19, 26].every((n) => !tvOverrideFor(live, series, { id: epId(n), season: 1, episode: n, series: FMA })),
    'the owner\'s "full metal alchemist" covers none of S01E14, S01E19 and S01E26');

  reset();
  verdicts.S01E19 = NUDE;
  const old = harness({ stored: LIVE, gemini: CLEARS });
  await ask(old, 'fullmetal alchemist brotherhood season 1');
  ok(old.jobs.length === 63 && aiCalls.length === 3 && !queued(old.jobs).includes(19),
    `on it alone, the three are asked about and E19, said nude, is withheld (${old.jobs.length} queued, ${aiCalls.length} calls)`);
  ok(!/bypass list/.test(old.history()[0].override ?? ''), `and History names no bypass entry: "${old.history()[0].override}"`);

  // The entry on the live list since 2026-09-29, typed with the show's full
  // name, as data/state.json holds it (movie-requests.rating-overrides-tv).
  const FULL = [{ key: 't:fullmetal alchemist brotherhood||1|', jellyfinId: null, title: FMA, year: null, season: 1, episode: null,
    addedBy: 'superadmin', note: '', addedAt: 1790697271873 }];
  reset();
  verdicts.S01E19 = NUDE;
  const h = harness({ storedTv: FULL, gemini: CLEARS });
  await ask(h, 'fullmetal alchemist brotherhood season 1');
  ok(h.jobs.length === 64 && aiCalls.length === 0, `with it, all 64 are queued, and nothing is asked (${h.jobs.length}, ${aiCalls.length} calls)`);
  ok(h.history()[0].override === `3 sent: on the bypass list (rating override for "${FMA}" season 1 by superadmin): E14, E19, E26`,
    `History says why: "${h.history()[0].override}"`);

  reset();
  const one = harness({ storedTv: FULL });
  await ask(one, 'fullmetal alchemist brotherhood S01E14');
  ok(one.jobs.length === 1 && aiCalls.length === 0, 'and S01E14 on its own, refused twice on 2026-09-28, is queued, nothing asked');
}

console.log('=== the episode check: the film check\'s question, about one episode ===');
{
  const text = episodeSubject(
    { season: 1, episode: 14, title: TITLES[14], rating: 'TV-MA' },
    { name: FMA, year: 2009, rating: 'TV-14', ids: { Imdb: 'tt1355642' } },
    { overview: 'Ed and Al go underground.', ids: { Imdb: 'tt1234567', Tvdb: '481220' }, premiere: '2009-07-05T00:00:00Z' },
  );
  for (const want of [`Series: ${FMA} (2009)`, `Episode: S01E14 "${TITLES[14]}"`, 'First aired: 2009-07-05',
    'the episode is rated TV-MA; the series is rated TV-14', 'Episode ids: IMDb tt1234567, TVDB 481220',
    'Series ids: IMDb tt1355642', 'Synopsis: Ed and Al go underground.']) {
    ok(text.includes(want), `the prompt carries ${JSON.stringify(want)}`);
  }
  reset();
  const v = await checkEpisodeNudity({ season: 1, episode: 14, title: TITLES[14] }, { name: FMA, year: 2009 },
    { enabled: true, contentCheck: true, apiKey: 'GEMINI-KEY-123', model: 'gemini-test' });
  ok(v?.nudity === false && v.provider === 'gemini', 'it asks the same providers as the film check');
  ok(/ONE episode of a TV series/.test(aiCalls[0]?.prompt) && /Answer about this episode, not the series/.test(aiCalls[0]?.prompt),
    'about the one episode, not the series');
  ok(await checkEpisodeNudity({ season: 1, episode: 14 }, { name: FMA }, { enabled: true, contentCheck: false, apiKey: 'k' }) === null,
    'switched off, it does not run');
}

/* ====================================================== the bypass list */

console.log('=== a bypass-list title is sent without asking the AI: a TV season ===');
{
  const LINE = `🎬 ${FMA} season 1 — 64 episode(s) added to the queue. Episodes 14, 19 and 26 are on the bypass list, `
    + 'so they were included despite the rating.';
  const DETAIL = `3 sent: on the bypass list (rating override for "${FMA}" by owner): E14, E19, E26`;
  for (const [label, gemini, v] of [
    ['the AI would say nudity', CLEARS, NUDE],
    ['every provider failing', CLEARS, 'fail'],
    ['the check switched off', { contentCheck: false }, NUDE],
    ['clean rated episodes not allowed', { allowCleanRatedFilms: false }, NUDE],
  ]) {
    reset();
    verdicts.S01E14 = verdicts.S01E19 = verdicts.S01E26 = v;
    const h = harness({ overrides: [{ input: FMA }], gemini });
    await ask(h, 'Fullmetal Alchemist Brotherhood season 1');
    ok(h.jobs.length === 64 && [14, 19, 26].every((n) => queued(h.jobs).includes(n)) && aiCalls.length === 0,
      `${label}: all 64 queued, E14, E19 and E26 among them, nothing asked (${h.jobs.length}, ${aiCalls.length} calls)`);
  }

  reset();
  const h = harness({ overrides: [{ input: FMA }], gemini: CLEARS });
  await ask(h, 'Fullmetal Alchemist Brotherhood season 1');
  const row = h.history()[0];
  ok(row.status === 'queued' && row.episodes === 64, 'History: queued, 64 episodes');
  ok(row.override === DETAIL, `History records the list: "${row.override}"`);
  ok(row.detail === `season 1 — 64 episode(s) · ${DETAIL}`, `in the detail too: "${row.detail}"`);
  ok(!('withheld' in row), 'and nothing is recorded as withheld');
  ok(onNotify(h.texts)[0] === LINE, `the requester is told: "${onNotify(h.texts)[0]}"`);
  ok(h.reacted.at(-1) === '🎬', 'accepted with 🎬');
  ok(h.tv.get('pending')[0].baseRow.override === DETAIL, 'the journal carries it, so the row survives a restart');
  ok(Object.keys(h.tv.get(CACHE_KEY, {})).length === 0, 'and no answer is kept: none was asked for');
}

console.log('=== a bypass-list title is sent without asking the AI: a TV episode ===');
{
  // A kept "nudity" from the afternoon of 2026-09-29, a fallback's, which
  // would once have held E14 back until the next day.
  reset();
  verdicts.S01E14 = NUDE;
  const tv = store({ [CACHE_KEY]: { [epId(14)]: { at: Date.now(), subject: `${FMA} S01E14`,
    verdict: { nudity: true, confidence: 0.9, basis: 'x', provider: 'groq' } } } });
  const h = harness({ overrides: [{ input: `${FMA} S01E14` }], gemini: CLEARS, tvStore: tv });
  await ask(h, 'fullmetal alchemist brotherhood S01E14');
  ok(h.jobs.length === 1 && h.jobs[0].meta.episode === 14 && aiCalls.length === 0,
    'an episode entry: S01E14 is queued, nothing asked, and the kept "nudity" not consulted');
  ok(h.history()[0].override === `1 sent: on the bypass list (rating override for "${FMA}" S01E14 by owner): E14`, `"${h.history()[0].override}"`);

  // The same entry, a season asked for: E14 goes; E19 and E26 are not on
  // the list and stay withheld on their rating when the AI cannot clear them.
  reset();
  const season = harness({ overrides: [{ input: `${FMA} S01E14` }] });
  await ask(season, 'fullmetal alchemist brotherhood season 1');
  ok(season.jobs.length === 62 && queued(season.jobs).includes(14) && !queued(season.jobs).includes(19) && aiCalls.length === 0,
    'an episode entry covers only its episode: E14 goes, E19 and E26 do not, nothing asked');
  const row = season.history()[0];
  ok(row.withheld === '2 withheld (TV-MA): E19, E26', `E19 and E26 stay withheld on rating: "${row.withheld}"`);
  ok(onNotify(season.texts)[0] === `🎬 ${FMA} season 1 — 62 of 64 episodes added to the queue. Episodes 19 and 26 are rated TV-MA, which `
    + "can't be posted, so they were left out. Episode 14 is on the bypass list, so it was included despite the rating.",
  `"${onNotify(season.texts)[0]}"`);

  for (const [label, input, want] of [
    ['a season link', `https://jf/web/#/details?id=${SEASON_ID}`, 64], ['a series link', SERIES_ID, 64], ['an episode link', epId(19), 62],
  ]) {
    reset();
    const l = harness({ overrides: [{ input }] });
    await ask(l, 'fullmetal alchemist brotherhood season 1');
    ok(l.jobs.length === want && aiCalls.length === 0, `${label}: ${want} queued, nothing asked (${l.jobs.length})`);
  }
}

console.log('=== the day\'s incident, for an episode: listed, Gemini 503, Groq says nudity - sent, zero AI calls ===');
{
  const ai = { order: ['gemini', 'groq'], gemini: { enabled: true, canClearRated: true },
    groq: { enabled: true, apiKey: 'GROQ-KEY-123', model: 'openai/gpt-oss-120b', canClearRated: true } };
  reset();
  verdicts.S01E14 = 'overloaded';
  groqAnswer = { nudity: true, confidence: 0.9, basis: 'IMDb Parents Guide lists nudity' };
  const h = harness({ overrides: [{ input: FMA }], gemini: CLEARS, ai });
  await ask(h, 'fullmetal alchemist brotherhood S01E14');
  ok(h.jobs.length === 1 && aiCalls.length === 0, `listed: S01E14 is queued, and neither Gemini nor Groq is asked (${aiCalls.length})`);

  reset();
  verdicts.S01E14 = 'overloaded';
  groqAnswer = { nudity: true, confidence: 0.9, basis: 'IMDb Parents Guide lists nudity' };
  const off = harness({ gemini: CLEARS, ai });
  await ask(off, 'fullmetal alchemist brotherhood S01E14');
  ok(off.jobs.length === 0 && aiCalls.map((a) => a.provider).join() === 'gemini,groq' && off.history()[0].status === 'blocked-rating'
    && /1 not cleared by the AI check \(Groq said nudity\), withheld on its rating: E14/.test(off.history()[0].detail),
  `not listed: Gemini, then Groq, asked; refused on its rating, never on Groq's word (${off.history()[0].detail})`);
}

/* ============================================= the AI check, not listed */

console.log('=== a TV-MA episode not on the list is cleared by a sure no-nudity and stays withheld on nudity or no answer ===');
{
  reset();
  const h = harness({ gemini: CLEARS });
  await ask(h, 'fullmetal alchemist brotherhood season 1');
  ok(h.jobs.length === 64 && codes().join() === 'S01E14,S01E19,S01E26', `all clean: 64 queued, the three TV-MA episodes asked about (${codes().join()})`);
  ok(aiCalls.some((a) => a.prompt.includes('Synopsis: What happens in episode 19.')) && detailCalls === 1,
    'each fed its synopsis and ids, fetched once for the three');
  ok(h.history()[0].override === '3 sent: rated, but no nudity (Gemini): E14, E19, E26', `"${h.history()[0].override}"`);
  ok(onNotify(h.texts)[0] === `🎬 ${FMA} season 1 — 64 episode(s) added to the queue. Episodes 14, 19 and 26 are rated TV-MA, `
    + 'but the content check found no nudity, so they were included.', `"${onNotify(h.texts)[0]}"`);
  const cache = h.tv.get(CACHE_KEY);
  ok(Object.keys(cache).length === 3 && cache[epId(14)].verdict.nudity === false, 'each answer is kept per episode');
  aiCalls = [];
  const again = harness({ gemini: CLEARS, tvStore: store({ [CACHE_KEY]: cache }) });
  await ask(again, 'fullmetal alchemist brotherhood season 1');
  ok(again.jobs.length === 64 && aiCalls.length === 0, 'the same season again asks nothing new');

  reset();
  verdicts.S01E19 = NUDE;
  const n = harness({ gemini: CLEARS });
  await ask(n, 'fullmetal alchemist brotherhood season 1');
  ok(n.jobs.length === 63 && !queued(n.jobs).includes(19), 'E19 "nudity": 63 queued, E19 withheld on its rating');
  const row = n.history()[0];
  ok(row.withheld === '1 withheld (TV-MA): E19' && row.status === 'queued', `withheld on rating, as it always was: "${row.withheld}"`);
  ok(row.override === '2 sent: rated, but no nudity (Gemini): E14, E26 · 1 not cleared by the AI check (Gemini said nudity), withheld on its rating: E19',
    `History says what the check made of each: "${row.override}"`);
  ok(onNotify(n.texts)[0] === `🎬 ${FMA} season 1 — 63 of 64 episodes added to the queue. Episode 19 is rated TV-MA, which can't be posted, `
    + 'so it was left out. Episodes 14 and 26 are rated TV-MA, but the content check found no nudity, so they were included.',
  `the requester is told what the rating left out and what the check let in: "${onNotify(n.texts)[0]}"`);

  reset();
  verdicts.S01E26 = { nudity: null, confidence: 0, basis: 'unknown episode' };
  verdicts.S01E14 = { nudity: false, confidence: 0.4, basis: 'probably fine' };
  const unsure = harness({ gemini: CLEARS });
  await ask(unsure, 'fullmetal alchemist brotherhood season 1');
  ok(unsure.jobs.length === 62 && queued(unsure.jobs).includes(19), 'unsure and low-confidence answers clear nothing: 62, with E19');
  ok(/2 not cleared by the AI check \(Gemini could not confirm no nudity\), withheld on their rating: E14, E26/.test(unsure.history()[0].override),
    `"${unsure.history()[0].override}"`);

  reset();
  verdicts.S01E14 = verdicts.S01E19 = verdicts.S01E26 = 'fail';
  const ai = { order: ['gemini', 'groq'], groq: { enabled: true, apiKey: 'GROQ-KEY-123', model: 'llama-test', canClearRated: true } };
  const down = harness({ gemini: CLEARS, ai });
  await ask(down, 'fullmetal alchemist brotherhood season 1');
  ok(down.jobs.length === 61 && ![14, 19, 26].some((x) => queued(down.jobs).includes(x)), 'every provider failing: 61 queued, the three withheld on rating');
  ok(aiCalls.map((a) => a.provider).join() === 'gemini,groq',
    `the chain is walked once (Gemini, then Groq), not again for each episode (${aiCalls.map((a) => a.provider).join()})`);
  ok(down.history()[0].override === '3 not cleared by the AI check (did not run: all-failed), withheld on their rating: E14, E19, E26',
    `"${down.history()[0].override}"`);
  ok(Object.keys(down.tv.get(CACHE_KEY, {})).length === 0, 'a check that did not run is not remembered as an answer');
  reset();
  const back = harness({ gemini: CLEARS, ai });
  await ask(back, 'fullmetal alchemist brotherhood season 1');
  ok(back.jobs.length === 64, 'asking again once the check works sends all 64');

  reset();
  verdicts.S01E14 = NUDE;
  const one = harness({ gemini: CLEARS, replyOnBlock: true });
  await ask(one, 'fullmetal alchemist brotherhood S01E14');
  const r1 = one.history()[0];
  ok(one.jobs.length === 0 && one.reacted.at(-1) === '⛔' && r1.status === 'blocked-rating',
    `S01E14 on its own, "nudity": refused with ⛔, as blocked-rating - never blocked-content (${r1.status})`);
  ok(r1.detail === 'S01E14 rated TV-MA · 1 not cleared by the AI check (Gemini said nudity), withheld on its rating: E14', `"${r1.detail}"`);
  ok(onNotify(one.texts)[0] === `⛔ ${FMA} S01E14 — rated TV-MA, can't be posted`
    && one.texts.find((t) => t.jid === TVREQ)?.body === `${FMA} S01E14 is rated TV-MA.`, 'with the words a rated episode always got');

  reset();
  const off = harness({ gemini: { allowCleanRatedFilms: false } });
  await ask(off, 'fullmetal alchemist brotherhood season 1');
  ok(off.jobs.length === 61 && aiCalls.length === 0 && off.history()[0].withheld === '3 withheld (TV-MA): E14, E19, E26' && !('override' in off.history()[0]),
    'with clean rated episodes not allowed: 61, nothing asked, History as before');
}

console.log('=== an episode its rating allows is sent and never asked about ===');
{
  reset({ per: () => 'TV-14' });
  verdicts.S01E05 = NUDE;
  const clean = harness({ overrides: [{ input: FMA }], gemini: CLEARS });
  await ask(clean, 'fullmetal alchemist brotherhood season 1');
  ok(clean.jobs.length === 64 && aiCalls.length === 0, 'a season with nothing rating-blocked: 64, and nothing asked');
  ok(onNotify(clean.texts)[0] === `🎬 ${FMA} season 1 — 64 episode(s) — added to the queue`, 'and says what it always said');

  // The library can hold an episode twice (withheld.js): E19 here as the
  // TV-MA item and again as a TV-14 one. The check's "nudity" about the
  // TV-MA copy used to keep the TV-14 copy out too; the AI only helps now,
  // so the TV-14 copy goes on its rating, and nothing is said about E19.
  reset();
  extraEpisodes = [{
    Id: 'e019'.padEnd(32, 'd'), SeriesName: FMA, SeriesId: SERIES_ID, SeasonId: SEASON_ID,
    ParentIndexNumber: 1, IndexNumber: 19, Name: TITLES[19], OfficialRating: 'TV-14',
    MediaSources: [{ Path: '/tv/fma/19-remux.mkv', Size: 1000, Container: 'mkv' }],
  }];
  verdicts.S01E19 = NUDE;
  const twin = harness({ gemini: CLEARS });
  await ask(twin, 'fullmetal alchemist brotherhood season 1');
  ok(twin.jobs.filter((j) => j.meta.episode === 19).length === 1 && twin.jobs.length === 64,
    `the TV-14 copy of E19 goes, the TV-MA copy does not: 64 (${twin.jobs.length})`);
  ok(!('withheld' in twin.history()[0]) && !/E19/.test(twin.history()[0].override ?? ''), 'and E19 is not called withheld: it went out');
}

console.log('=== the flag Off: group text exactly as before, History still records ===');
{
  reset();
  verdicts.S01E19 = NUDE;
  const h = harness({ feature: 'off', replyOnBlock: true, gemini: CLEARS });
  await ask(h, 'fullmetal alchemist brotherhood season 1');
  ok(h.jobs.length === 63, 'the check still works - the flag is only about words');
  const lines = onNotify(h.texts);
  // The bare line, naming the 63 it queued (since 2026-10-12,
  // test/tv-range-named-by-what-was-queued.test.mjs).
  ok(lines.length === 1 && lines[0] === `🎬 ${FMA} S01E01–E18, E20–E64 — 63 of season 1 — added to the queue`,
    `the bare line, with no sentence: "${lines[0]}"`);
  ok(!h.texts.some((t) => t.jid === TVREQ), 'no reply in the request group');
  ok(/1 not cleared by the AI check \(Gemini said nudity\)/.test(h.history()[0].override), 'History has it');

  reset();
  const listed = harness({ overrides: [{ input: FMA }], feature: 'off' });
  await ask(listed, 'fullmetal alchemist brotherhood season 1');
  ok(onNotify(listed.texts)[0] === `🎬 ${FMA} season 1 — 64 episode(s) — added to the queue` && /on the bypass list/.test(listed.history()[0].override),
    'a listed season: the old line, and the list in History');
}

console.log('=== a series rated as a whole ===');
{
  reset({ rating: 'TV-MA', name: 'The Boys', count: 3, per: () => 'TV-MA' });
  const none = harness();
  await ask(none, 'The Boys season 1');
  ok(none.jobs.length === 0 && none.history()[0].detail === 'rated TV-MA' && aiCalls.length === 0, 'no entry, nothing to clear it: refused on the series rating, as before');

  reset({ rating: 'TV-MA', name: 'The Boys', count: 3, per: () => null });
  const listed = harness({ overrides: [{ input: 'The Boys season 1' }], gemini: CLEARS });
  await ask(listed, 'The Boys season 1');
  ok(listed.jobs.length === 3 && aiCalls.length === 0, 'with an entry, every episode goes, nothing asked');

  reset({ rating: 'TV-MA', name: 'The Boys', count: 3, per: () => null });
  verdicts.S01E02 = { nudity: true, confidence: 0.99, basis: 'explicit' };
  const cleared = harness({ gemini: CLEARS });
  await ask(cleared, 'The Boys season 1');
  ok(aiCalls.length === 3 && cleared.jobs.length === 2 && !queued(cleared.jobs).includes(2),
    'not listed, the AI check able to clear: each episode asked about, the clean ones go, E02 stays withheld on its rating');

  reset({ rating: 'TV-MA', name: 'The Boys', count: 3, per: () => null });
  verdicts.S01E01 = verdicts.S01E02 = verdicts.S01E03 = NUDE;
  const allNo = harness({ gemini: CLEARS });
  await ask(allNo, 'The Boys season 1');
  ok(allNo.jobs.length === 0 && /^rated TV-MA · 3 not cleared by the AI check \(Gemini said nudity\)/.test(allNo.history()[0].detail),
    `none cleared: refused as the series it is, with what the check said on the row (${allNo.history()[0].detail})`);
}

console.log('=== the panel\'s manual queue follows the same rule ===');
{
  reset();
  verdicts.S01E14 = NUDE;
  const h = harness({ overrides: [{ input: FMA }], gemini: CLEARS });
  const r = await plugin.requeue('Fullmetal Alchemist Brotherhood season 1', h.ctx);
  ok(r.queued === 64 && aiCalls.length === 0 && /on the bypass list, so they were included despite the rating/.test(r.withheldNote),
    `listed: 64 queued, nothing asked, and the note says why: "${r.withheldNote}"`);
  ok(/^3 sent: on the bypass list/.test(h.history()[0].override), 'with the History row');

  reset();
  verdicts.S01E14 = NUDE;
  let err = null;
  try { await plugin.requeue('Fullmetal Alchemist Brotherhood S01E14', harness({ gemini: CLEARS }).ctx); } catch (e) { err = e; }
  ok(err?.message === `${FMA} S01E14 is rated TV-MA (blocked) — 1 not cleared by the AI check (Gemini said nudity), withheld on its rating: E14`,
    `not listed, "nudity": refused on its rating, with what the check said: "${err?.message}"`);
}

/* ================================================= pacing and the cache */

console.log('=== pacing: one request never walks every episode into a quota wall ===');
{
  const found = {
    series: { id: SERIES_ID, name: FMA, year: 2009, rating: 'TV-14' },
    episodes: [1, 2, 3, 4].map((n) => ({ id: epId(n), season: 1, episode: n, series: FMA, rating: 'TV-MA', seriesId: SERIES_ID })),
  };
  // A key: with none for any provider the check is not asked at all, since it
  // is on by default (2026-10-12, aiCanClear) - the stubbed check stands in.
  const g = { enabled: true, contentCheck: true, allowCleanRatedFilms: true, apiKey: 'k' };
  let calls = 0;
  const clean = async (ep, s, cfg, { onResult }) => { calls += 1; const v = { nudity: false, confidence: 0.9, basis: 'ok', provider: 'gemini' }; onResult?.({ ok: true, verdict: v }); return v; };
  const s = await screenRated({ found, blocked: ['TV-MA'], cache: store(), gemini: g, check: clean, maxChecks: 2, paceMs: 0 });
  ok(calls === 2 && s.cleared.length === 2, 'at most maxChecks are asked in one request');
  ok(s.notCleared.length === 2 && s.notCleared.every((x) => x.failure.reason === 'too-many'), 'the rest stay withheld, unasked');
  ok(describeScreen(s, s.allowed).detail.includes('2 not cleared by the AI check (did not run: too-many), withheld on their rating: E3, E4'),
    'and History says why');

  calls = 0;
  const failing = async (ep, series, cfg, { onResult }) => { calls += 1; onResult?.({ ok: false, failure: { reason: 'quota-daily' } }); return null; };
  const f = await screenRated({ found, blocked: ['TV-MA'], cache: store(), gemini: g, check: failing, paceMs: 0 });
  ok(calls === 1 && f.notCleared.length === 4 && f.notCleared.every((x) => x.failure.reason === 'quota-daily'),
    'the first check that cannot run stops the rest from being asked');

  ok(await screenRated({ found, blocked: ['TV-MA'], cache: store(), gemini: { ...g, allowCleanRatedFilms: false }, check: clean }) === null,
    'with nothing on the list and nothing the AI could clear, nothing is screened at all');

  // Paced, one at a time across requests.
  resetPacing();
  calls = 0;
  const slept = [];
  let clock = 1_000_000;
  const paced = await screenRated({
    found, blocked: ['TV-MA'], cache: store(), gemini: g, check: clean,
    paceMs: 2000, now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; },
  });
  resetPacing();
  ok(paced.cleared.length === 4 && slept.length === 3 && slept.every((ms) => ms === 2000), `a gap between checks (${slept.join(', ')})`);

  // A kept answer is judged by the provider's trust as it is NOW.
  const kept = store({ [CACHE_KEY]: { [epId(1)]: { at: 1, subject: `${FMA} S01E01`, verdict: { nudity: false, confidence: 0.95, basis: 'ok', provider: 'groq', canClearRated: true } } } });
  const one1 = { ...found, episodes: found.episodes.slice(0, 1) };
  calls = 0;
  const untrusted = await screenRated({ found: one1, blocked: ['TV-MA'], cache: kept, gemini: g, check: clean, paceMs: 0, now: () => 2,
    ai: { groq: { enabled: true, apiKey: 'k', canClearRated: false } } });
  ok(calls === 0 && untrusted.notCleared.length === 1,
    'a kept "no nudity" from a provider the operator has since stopped trusting no longer clears an episode');
  const trusted = await screenRated({ found: one1, blocked: ['TV-MA'], cache: kept, gemini: g, check: clean, paceMs: 0, now: () => 2,
    ai: { groq: { enabled: true, apiKey: 'k', canClearRated: true } } });
  ok(trusted.cleared.length === 1, 'and still does while it is trusted');
}

console.log('=== a kept answer: only a "no nudity" that sends is kept for months, every other a day ===');
{
  // 2026-09-29: Gemini out (503 all afternoon), Groq answering. A "nudity"
  // - Groq's false one about The Last Samurai, or anybody's - used to be
  // kept for months and to hold an episode back until then. It holds back
  // nothing the rating did not now, and is only a reason not to ask again
  // the same day.
  const found = {
    series: { id: SERIES_ID, name: FMA, year: 2009, rating: 'TV-14' },
    episodes: [{ id: epId(14), season: 1, episode: 14, series: FMA, rating: 'TV-MA', seriesId: SERIES_ID }],
  };
  const g = { enabled: true, contentCheck: true, allowCleanRatedFilms: true };
  const ai = { order: ['gemini', 'groq'], groq: { enabled: true, apiKey: 'k', canClearRated: false } };
  const asked = [];
  const answer = (provider, nudity) => async (ep, s, cfg, { onResult }) => {
    asked.push(provider);
    const v = { nudity, confidence: 0.95, basis: 'x', provider };
    onResult?.({ ok: true, verdict: v });
    return v;
  };
  const noSleep = async () => {};
  const run = (cache, check, at) => screenRated({ found, blocked: ['TV-MA'], cache, gemini: g, ai, check, paceMs: 0, sleep: noSleep, now: () => at });
  const t = 50_000_000;
  resetPacing();

  // A kept answer an untrusted provider gave (from before only trusted ones
  // were asked): a day, then Gemini is asked, and its "no nudity" clears it.
  const c1 = store({ [CACHE_KEY]: { [epId(14)]: { at: t, subject: `${FMA} S01E14`, verdict: { nudity: false, confidence: 0.95, basis: 'x', provider: 'groq' } } } });
  const day0 = await run(c1, answer('gemini', false), t + CACHE_TTL.unsure - 1);
  ok(asked.length === 0 && day0.notCleared.length === 1, 'an untrusted provider\'s kept "no nudity": not cleared, not asked again the same day');
  const day2 = await run(c1, answer('gemini', false), t + 2 * CACHE_TTL.unsure);
  ok(asked.join() === 'gemini' && day2.cleared.length === 1, `two days later Gemini is asked, and its answer clears it (${asked.join()})`);

  for (const [who, cacheVerdict] of [['Gemini', 'gemini'], ['a fallback', 'groq']]) {
    asked.length = 0;
    const c = store({ [CACHE_KEY]: { [epId(14)]: { at: t, subject: `${FMA} S01E14`, verdict: { nudity: true, confidence: 0.95, basis: 'x', provider: cacheVerdict } } } });
    const same = await run(c, answer('gemini', false), t + 60 * 60 * 1000);
    const next = await run(c, answer('gemini', false), t + 25 * 60 * 60 * 1000);
    ok(same.notCleared.length === 1 && asked.join() === 'gemini' && next.cleared.length === 1,
      `${who}'s "nudity" is kept a day, not months: asked again the next day, and cleared (${asked.join()})`);
  }

  asked.length = 0;
  const c3 = store();
  await run(c3, answer('gemini', false), t);
  await run(c3, answer('gemini', true), t + 30 * CACHE_TTL.unsure);
  ok(asked.join() === 'gemini', 'Gemini\'s "no nudity", which sent the episode, is kept for months');

  // "I do not know this episode" is kept a day, and asked again after.
  asked.length = 0;
  const c4 = store();
  const unsure = async (ep, s, cfg, { onResult }) => { asked.push('gemini'); const v = { nudity: null, confidence: 0, basis: 'unknown episode', provider: 'gemini' }; onResult?.({ ok: true, verdict: v }); return v; };
  await run(c4, unsure, t);
  await run(c4, unsure, t + CACHE_TTL.unsure - 1);
  ok(asked.length === 1, '"I do not know this episode" is not asked again the same day');
  await run(c4, unsure, t + CACHE_TTL.unsure + 1);
  ok(asked.length === 2, 'but is asked again the next day, when another provider may know it');
  resetPacing();
}

console.log('=== a kept answer is used only for the episode it was given about ===');
{
  // Jellyfin's item id comes from the file path, so it survives a metadata
  // fix or a change of episode order (TVDB vs TMDB vs absolute, common for
  // anime). An answer about S01E14 was reused for the same file once it was
  // numbered S01E19 - which has nudity.
  reset();
  verdicts.S01E19 = NUDE;
  const tv = store({
    [CACHE_KEY]: {
      [epId(19)]: { at: Date.now() - 3600e3, subject: `${FMA} S01E14`, verdict: { nudity: false, confidence: 0.9, basis: 'x', provider: 'gemini', canClearRated: true } },
    },
  });
  const h = harness({ gemini: CLEARS, tvStore: tv });
  await ask(h, 'fullmetal alchemist brotherhood S01E19');
  ok(aiCalls.length === 1, `the old answer is not reused - the check is asked (${aiCalls.length})`);
  ok(h.jobs.length === 0 && h.history()[0]?.status === 'blocked-rating', 'and E19 is not cleared: refused on its rating');
  ok(tv.get(CACHE_KEY)[epId(19)].subject === `${FMA} S01E19` && tv.get(CACHE_KEY)[epId(19)].verdict.nudity === true,
    'the new answer is kept under the right episode');

  aiCalls = [];
  const again = harness({ gemini: CLEARS, tvStore: tv });
  await ask(again, 'fullmetal alchemist brotherhood S01E19');
  ok(aiCalls.length === 0 && again.jobs.length === 0, 'an answer about the same episode is still reused, that day');
}

console.log('=== checks are not spent on episodes the cap or a full queue would cut ===');
{
  // Gemini's free tier is about 20 checks a day. An episode past
  // maxEpisodesPerRequest, or a request refused as "the queue is full", used
  // to spend its checks first.
  reset();
  const capped = harness({ gemini: CLEARS, cap: 20 });
  await ask(capped, 'fullmetal alchemist brotherhood season 1');
  ok(capped.jobs.length === 20 && queued(capped.jobs).includes(14) && queued(capped.jobs).includes(19), '20 queued, with E14 and E19');
  ok(codes().join() === 'S01E14,S01E19', `only the episodes within the first 20 are checked - not E26 (${codes().join()})`);
  // E26, past the cap and never asked about, was left out by the limit as
  // much as E21-E25 were: the member is told so, and asked for again it is
  // checked (tv-requests cap-cut.js, `unreached`). Called neither, it was
  // nowhere in "21–25 and 27–64 weren't" (found in review, 2026-10-12).
  const cutRow = capped.history()[0];
  ok(JSON.stringify(cutRow?.cut?.left) === '[[21,64]]'
    && capped.texts.some((t) => t.jid === TVREQ && /episodes 1–20 were added; 21–64 weren't/.test(t.body)),
  `the cut reply counts E26 among what the limit left out (${JSON.stringify(cutRow?.cut?.left)})`);

  reset();
  const full = harness({ gemini: CLEARS, room: 0 });
  await ask(full, 'fullmetal alchemist brotherhood season 1');
  ok(full.jobs.length === 0 && aiCalls.length === 0, `a full queue: nothing is checked (${aiCalls.length})`);
  ok(/the queue is full right now\. Nothing was added/.test(onNotify(full.texts)[0] ?? ''), 'and the requester is told the queue is full');

  reset();
  const one = harness({ gemini: CLEARS, room: 0 });
  await ask(one, 'fullmetal alchemist brotherhood S01E14');
  ok(one.jobs.length === 0 && aiCalls.length === 0, 'one episode asked for into a full queue: not checked');
  ok(/the queue is full right now/.test(onNotify(one.texts)[0] ?? '') && !one.history().some((r) => /^blocked/.test(r.status)),
    'told the queue is full, not refused on its rating');

  // The queue counts requests, and a season goes in whole or not at all, so
  // one place left is room for all of it: every episode is checked.
  reset();
  const part = harness({ gemini: CLEARS, room: 1 });
  await ask(part, 'fullmetal alchemist brotherhood season 1');
  ok(part.jobs.length === 64 && codes().join() === 'S01E14,S01E19,S01E26', `one place left: the season goes in whole, all three checked (${codes().join()})`);
  ok(!onNotify(part.texts).some((l) => /queue is full/i.test(l)), `and nobody is told to ask again for the rest (${onNotify(part.texts).join(' / ')})`);

  reset();
  let err = null;
  const r = await plugin.requeue('Fullmetal Alchemist Brotherhood season 1', harness({ gemini: CLEARS, cap: 20 }).ctx).catch((e) => { err = e; });
  ok(!err && r.queued === 20 && codes().join() === 'S01E14,S01E19', `the panel's manual queue honours the cap the same way (${codes().join()})`);

  // A listed episode spends no check, so it counts against the cap like any
  // episode that goes out anyway.
  reset();
  const listedCap = harness({ overrides: [{ input: `${FMA} S01E14` }], gemini: CLEARS, cap: 20 });
  await ask(listedCap, 'fullmetal alchemist brotherhood season 1');
  ok(listedCap.jobs.length === 20 && codes().join() === 'S01E19', `a listed E14 takes its place, and only E19 is checked (${codes().join()})`);
}

console.log('=== with the episode cap at 20, History and the group name as sent on the list only the listed episodes queued ===');
{
  // Found in review, 2026-09-29: every episode the list covers was named as
  // sent, whether or not the cap let it into the queue. With
  // maxEpisodesPerRequest at 20 and the live list's entry, FMA:B season 1
  // queued E1-E20, and History read "3 sent: on the bypass list (...): E14,
  // E19, E26" and the group "Episodes 14, 19 and 26 are on the bypass list,
  // so they were included despite the rating" - E26 was neither sent nor
  // included.
  const FULL = [{ key: 't:fullmetal alchemist brotherhood||1|', jellyfinId: null, title: FMA, year: null, season: 1, episode: null,
    addedBy: 'superadmin', note: '', addedAt: 1790697271873 }];
  reset();
  const h = harness({ storedTv: FULL, gemini: CLEARS, cap: 20 });
  await ask(h, 'fullmetal alchemist brotherhood season 1');
  ok(h.jobs.length === 20 && queued(h.jobs).includes(14) && queued(h.jobs).includes(19) && !queued(h.jobs).includes(26),
    `E1-E20 are queued, E14 and E19 among them, and not E26 (${h.jobs.length})`);
  const row = h.history()[0];
  ok(row.override === `2 sent: on the bypass list (rating override for "${FMA}" season 1 by superadmin): E14, E19`,
    `History names E14 and E19 as sent on the list, and not E26: "${row.override}"`);
  ok(!/26/.test(row.detail), `nor does the row's detail: "${row.detail}"`);
  const line = onNotify(h.texts).find((l) => /added to the queue/.test(l)) ?? '';
  ok(/Episodes 14 and 19 are on the bypass list, so they were included despite the rating\./.test(line) && !/26/.test(line),
    `the group is told E14 and E19 were included, and nothing of E26: "${line}"`);

  // The panel's manual queue says the same.
  reset();
  const p = harness({ storedTv: FULL, gemini: CLEARS, cap: 20 });
  const r = await plugin.requeue('Fullmetal Alchemist Brotherhood season 1', p.ctx);
  ok(r.queued === 20 && /Episodes 14 and 19 are on the bypass list/.test(r.withheldNote ?? '') && !/26/.test(r.withheldNote ?? ''),
    `the panel is told E14 and E19, not E26: "${r.withheldNote}"`);
  ok(/: E14, E19$/.test(p.history()[0].override ?? ''), `and its History row: "${p.history()[0].override}"`);

  // Without the cap all three go, and all three are named, as before.
  reset();
  const all = harness({ storedTv: FULL, gemini: CLEARS });
  await ask(all, 'fullmetal alchemist brotherhood season 1');
  ok(all.jobs.length === 64 && /: E14, E19, E26$/.test(all.history()[0].override ?? ''), 'with no cap, E14, E19 and E26 are all sent and named');
}

/* ======================================== what the panel is told */

console.log('=== a pasted link is looked up to say what it is; nothing is refused ===');
{
  reset();
  const jf = { base: 'http://jf:8096', token: 'TOK', userId: 'U1' };
  const series = await describeLink(SERIES_ID, jf);
  ok(series?.kind === 'tv' && series.covers === `${FMA} (2009) — whole series`, `a series link: "${series?.covers}"`);
  ok((await describeLink(`https://jf/Items/${SEASON_ID}/Download`, jf))?.covers === `${FMA} — Season 1`, 'a season link');
  ok((await describeLink(epId(14), jf))?.covers === `${FMA} S01E14 "${TITLES[14]}"`, 'an episode link');
  const film = await describeLink('f'.repeat(32), jf);
  ok(film?.kind === 'film' && film.covers === 'Some Film (2001) — film', `a film's link is a film entry: "${film?.covers}"`);
  const empty = async () => new Response(JSON.stringify({ Items: [] }), { status: 200 });
  ok(await describeLink('9'.repeat(32), { ...jf, fetchImpl: empty }) === null, 'an id nothing has: null - the entry is saved as typed');
  ok(await describeLink('full metal alchemist', jf) === null, 'a title is not looked up at all');
  ok(await describeLink(SERIES_ID, {}) === null, 'with Jellyfin not configured, saved as typed');
}

console.log('=== what each entry matches in the library right now, as information ===');
{
  const LIB = {
    Series: [
      { Id: SERIES_ID, Name: FMA, ProductionYear: 2009 },
      { Id: 'f3'.repeat(16), Name: 'Fullmetal Alchemist', ProductionYear: 2003 },
      { Id: 'c3'.repeat(16), Name: 'Kitchen Nightmares', ProductionYear: 2004 },
      { Id: 'd4'.repeat(16), Name: 'Kitchen Nightmares', ProductionYear: 2007 },
      { Id: 'fb'.repeat(16), Name: 'Fruits Basket (2019)', ProductionYear: 2019 },
    ],
    Movie: [
      { Id: 'f5'.repeat(16), Name: 'Fullmetal Alchemist: The Conqueror of Shamballa', ProductionYear: 2005 },
      { Id: 'f6'.repeat(16), Name: 'Fullmetal Alchemist', ProductionYear: 2017 },
      { Id: 'f'.repeat(32), Name: 'Some Film', ProductionYear: 2001 },
    ],
  };
  let listings = 0;
  const fake = async (url) => {
    const u = new URL(String(url));
    const j = (v) => new Response(JSON.stringify(v), { status: 200 });
    if (u.searchParams.get('Ids')) {
      const id = u.searchParams.get('Ids');
      if (id === SERIES_ID) return j({ Items: [{ Id: SERIES_ID, Type: 'Series', Name: FMA, ProductionYear: 2009 }] });
      return j({ Items: [] });
    }
    listings += 1;
    return j({ Items: LIB[u.searchParams.get('IncludeItemTypes')] ?? [] });
  };
  resetLibraryNames();
  const jf = { base: 'http://jf-lib:8096', token: 'TOK', userId: 'U1', fetchImpl: fake };
  const s = store({ 'rating-overrides': [{ key: 't:full metal alchemist|', jellyfinId: null, title: 'full metal alchemist', year: null,
    addedBy: { username: 'superadmin', role: 'superadmin' }, note: '', addedAt: 1790636001601 }] });
  addOverride(s, 'Fullmetal Alchemist: Brotherhood season 1');
  addOverride(s, 'Fruits Basket');
  addOverride(s, 'Kitchen Nightmares');
  addOverride(s, 'Kitchen Nightmares (2007)');
  addOverride(s, 'Some Film season 2');
  addOverride(s, 'zzz nothing by this name');
  addOverride(s, SERIES_ID);
  addOverride(s, '9'.repeat(32));
  const m = await libraryMatches(listOverrides(s), jf);
  const names = (key) => (m.matches[key]?.items ?? []).map((i) => `${i.type}:${i.name}${i.year ? ` (${i.year})` : ''}`).join(' | ');
  // Exact title only (2026-09-29): the show and the film called that, and
  // neither Brotherhood nor The Conqueror of Shamballa, which only start
  // with it.
  ok(m.checked === true && m.matches['t:full metal alchemist|'].count === 2, `the owner's entry: ${names('t:full metal alchemist|')}`);
  ok(names('t:full metal alchemist|') === 'tv:Fullmetal Alchemist (2003) | film:Fullmetal Alchemist (2017)',
    'the show and the film of that exact name, by the rule the requests use');
  ok(names('t:fullmetal alchemist brotherhood||1|') === `tv:${FMA} (2009)`, 'Brotherhood is matched by the entry that names it in full');
  ok(m.matches['t:fruits basket|'].count === 1 && m.matches['t:fruits basket|'].items[0].name === 'Fruits Basket (2019)',
    `and a name with its year in brackets by the title without it: ${names('t:fruits basket|')}`);
  ok(m.matches['t:kitchen nightmares|'].count === 2, 'a name two shows share covers both - saved, and shown');
  ok(m.matches['t:kitchen nightmares|2007'].count === 1 && /2007/.test(names('t:kitchen nightmares|2007')), 'with a year, the one');
  ok(m.matches['t:some film||2|'].count === 0, 'a season entry lists no film');
  ok(m.matches['t:zzz nothing by this name|'].count === 0, 'a title matching nothing is saved all the same, and says so');
  ok(m.matches[`jf:${SERIES_ID}`].count === 1 && m.matches[`jf:${'9'.repeat(32)}`].count === 0, 'a link: its item, or nothing');
  const before = listings;
  await libraryMatches(listOverrides(s), jf);
  ok(listings === before, 'the library\'s names are listed once, not on every look');
  resetLibraryNames();
  const noFilms = await libraryMatches(listOverrides(s), { ...jf, films: false });
  ok(noFilms.films === false && noFilms.matches['t:full metal alchemist|'].count === 1, 'films are not listed where Jellyfin does not hold them');
  resetLibraryNames();
  const down = await libraryMatches(listOverrides(s), { ...jf, fetchImpl: async () => new Response('x', { status: 500 }) });
  ok(down.checked === false && /could not be listed/.test(down.reason), `a library that cannot be listed: "${down.reason}"`);
  ok((await libraryMatches(listOverrides(s), {})).checked === false, 'nor with Jellyfin not configured');
  resetLibraryNames();
}

console.log('=== a series link covers the show\'s other library entry ===');
{
  // A show split over two folders - Blue Exorcist is 14 + 73 episodes on the
  // live server - has its seasons in two series items, and resolveEpisodes
  // takes the season from whichever holds it. A link to one of them, shown
  // as "whole series", covered only the seasons in that one.
  const A = 'aa'.repeat(16), B = 'bb'.repeat(16), OTHER = 'cc'.repeat(16);
  const fake = async (url) => {
    const u = new URL(String(url));
    const j = (v) => new Response(JSON.stringify(v), { status: 200 });
    if (u.searchParams.get('Ids') === A) {
      return j({ Items: [{ Id: A, Type: 'Series', Name: 'Blue Exorcist', ProductionYear: 2011, ProviderIds: { Tvdb: '248035' } }] });
    }
    if (u.pathname === '/Items' && u.searchParams.get('searchTerm')) {
      return j({ Items: [
        { Id: A, Name: 'Blue Exorcist', ProductionYear: 2011, RecursiveItemCount: 14, ProviderIds: { Tvdb: '248035' } },
        { Id: B, Name: 'Blue Exorcist', ProductionYear: 2011, RecursiveItemCount: 73, ProviderIds: { Tvdb: '248035' } },
        { Id: OTHER, Name: 'Blue Exorcist', ProductionYear: 2011, RecursiveItemCount: 5, ProviderIds: { Tvdb: '999999' } },
      ] });
    }
    return j({ Items: [] });
  };
  const jf = { base: 'http://jf:8096', token: 'TOK', userId: 'U1', fetchImpl: fake };
  const resolved = await describeLink(`https://jf/web/#/details?id=${A}`, jf);
  ok(resolved?.twinIds?.join() === B, `the same show's other entry is recorded with the link (${resolved?.twinIds})`);
  ok(resolved?.covers === 'Blue Exorcist (2011) — whole series (in 2 library entries)', `and the list says so: "${resolved?.covers}"`);
  const s = store();
  addOverride(s, A, { resolved });
  const epIn = (sid) => ({ id: 'e'.repeat(32), season: 2, episode: 3, seriesId: sid, seasonId: 'd'.repeat(32), series: 'Blue Exorcist' });
  ok(!!tvOverrideFor(s, { id: B, name: 'Blue Exorcist', year: 2011 }, epIn(B)), 'an episode held in the other entry is covered');
  ok(!!tvOverrideFor(s, { id: A, name: 'Blue Exorcist', year: 2011 }, epIn(A)), 'as is one in the linked entry');
  ok(!tvOverrideFor(s, { id: OTHER, name: 'Blue Exorcist', year: 2011 }, epIn(OTHER)),
    'a different show with the same name and year (other provider ids) is not - a link is exact');
  const other = '7'.repeat(32);
  ok(!tvOverrideFor(s, { id: other, name: 'Blue Exorcist', year: 2011 }, { ...epIn(other), id: B, seasonId: B }),
    'a twin id is only ever compared with the series\' id, never an episode\'s or a season\'s');
}

console.log('=== one list: a title covers films and shows alike, and nothing is refused ===');
{
  // The stricter list asked Film or TV, refused a name two shows share
  // ("Kitchen Nightmares", 2004 and 2007), refused a show's name added as a
  // film, and refused a name no show had exactly - "full metal alchemist".
  // Each is now saved, and covers what its name covers - which the panel
  // shows beside it, since an entry sends what it covers.
  const s = store();
  for (const input of ['Kitchen Nightmares', 'full metal alchemist', FMA.toUpperCase(), 'Kitchen Nightmares (2007) season 3']) {
    let err = null;
    try { addOverride(s, input); } catch (e) { err = e; }
    ok(!err, `"${input}" is saved`);
  }
  const ep = (sid, name, year) => [{ id: sid, name, year }, { id: 'e'.repeat(32), season: 1, episode: 1, seriesId: sid, series: name }];
  const kn = store(); addOverride(kn, 'Kitchen Nightmares');
  ok(!!tvOverrideFor(kn, ...ep('c3'.repeat(16), 'Kitchen Nightmares', 2004)) && !!tvOverrideFor(kn, ...ep('d4'.repeat(16), 'Kitchen Nightmares', 2007)),
    'a name two shows share covers both');
  ok(!tvOverrideFor(kn, ...ep('d5'.repeat(16), "Kitchen Nightmares USA", 2007)), 'and not a show whose name only starts with it ("Exact title only")');
  const us = store(); addOverride(us, 'Kitchen Nightmares (2007)');
  ok(!!tvOverrideFor(us, ...ep('d4'.repeat(16), 'Kitchen Nightmares', 2007)) && !tvOverrideFor(us, ...ep('c3'.repeat(16), 'Kitchen Nightmares', 2004)),
    'a year says which');
  const f = store(); addOverride(f, FMA);
  ok(!!isOverridden(f, { title: FMA, year: 2009 }) && !!tvOverrideFor(f, ...ep(SERIES_ID, FMA, 2009)), 'a show\'s name covers a film of that name too');
}


console.log('=== an emptied confidence box never makes a bare "no nudity" a confirmation ===');
{
  // The panel saves Settings -> content-check confidence as +value, so an
  // emptied box is 0, and parseVerdict reads a reply with no confidence as 0.
  // At a bar of 0, {"nudity": false} - "no idea, probably not" - would count
  // as sure and send a TV-MA episode or an R film. (The live bar is 0.7;
  // this is the box being cleared.)
  const bare = { nudity: false, confidence: 0, basis: '', provider: 'gemini' };
  ok(decide(bare, true, { allowCleanRatedFilms: true, minConfidence: 0 }).blocked === true, 'a rated title is not cleared by it');
  ok(decide(bare, true, { allowCleanRatedFilms: true, minConfidence: Number('') }).blocked === true, 'nor with the box emptied');
  ok(decide({ ...bare, confidence: 0.9 }, true, { allowCleanRatedFilms: true, minConfidence: 0 }).blocked === false,
    'a confident "no nudity" still clears it');

  const found = {
    series: { id: SERIES_ID, name: FMA, year: 2009, rating: 'TV-14' },
    episodes: [{ id: epId(14), season: 1, episode: 14, series: FMA, rating: 'TV-MA', seriesId: SERIES_ID }],
  };
  let asked = 0;
  const shrug = async (ep, s2, cfg, { onResult }) => { asked += 1; const v = { ...bare }; onResult?.({ ok: true, verdict: v }); return v; };
  const cache = store();
  resetPacing();
  const t = 90_000_000;
  // A key, as above: with none anywhere the check is not asked (aiCanClear).
  const g = { enabled: true, contentCheck: true, allowCleanRatedFilms: true, apiKey: 'k' };
  const s1 = await screenRated({ found, blocked: ['TV-MA'], cache, gemini: g,
    check: shrug, minConfidence: 0, paceMs: 0, sleep: async () => {}, now: () => t });
  ok(s1.notCleared.length === 1 && !s1.allowed.length, 'an episode is not cleared by it');
  await screenRated({ found, blocked: ['TV-MA'], cache, gemini: g,
    check: shrug, minConfidence: 0, paceMs: 0, sleep: async () => {}, now: () => t + 2 * CACHE_TTL.unsure });
  ok(asked === 2, 'and the answer is kept a day, not months, so it is asked again');
  resetPacing();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
