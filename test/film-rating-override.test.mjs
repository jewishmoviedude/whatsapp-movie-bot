/* A film on the bypass list is sent with no AI check, and the AI check only
   ever helps a film its rating blocks through.
   Run: node test/film-rating-override.test.mjs

   The operator's decisions of 2026-09-29. That afternoon Gemini's model
   answered 503 for hours, the chain fell through to Groq, and Groq's
   gpt-oss-120b said The Last Samurai had nudity - IMDb says it has none -
   so the film, which the operator had put on the rating-override list by
   hand, was held back: "Why ask Gemini if I already added it to rated R
   bypass manually in panel?" Asked what adding a title should do: "Send it,
   no AI check". Asked what the AI check is for: "The AI check is so the
   request can go through without getting denied if possible". Asked whether
   it should still block an unrated or PG-13 film it says has nudity: "No, AI
   only helps".

   Until then a listed film its rating blocked went out only on a confirmed
   "no nudity", and nudity found by any provider blocked any film. Pinned
   here, through the real movie plugin (OMDb, Jellyfin, Gemini and Groq are a
   stubbed fetch):
    - a film its rating allows is sent whatever the AI would say, and the AI
      is not asked;
    - a bypass-list title is sent without asking the AI - a film by title,
      by its exact name however it is spaced and punctuated, by Jellyfin id
      asked for in free text (step 2 used to refuse that one before the
      library had named it), a panel Re-run, and Queue link - and History
      says "sent: on the bypass list (...)"; and only by its exact name: the
      owner's "full metal alchemist", which only starts the name of an FMA
      film, sent it until the operator chose "Exact title only" that evening
      (asked whether "Heat" should also send "Heat and Dust"), and now does
      not;
    - an R film not on the list is cleared by a sure "no nudity" and stays
      blocked, on its rating, on nudity or no answer;
    - The Last Samurai replayed: on the list, Gemini 503 and Groq saying
      nudity - sent, with no AI call at all.
   And, kept from the review of that morning: a listed film whose library
   copy carries another year is sent, not refused "rated R (library file)";
   a file that is a different film is refused as the wrong film, listed or
   not; and a queued listed film is resumed after a restart.

   And from the review of the change itself, the same evening: a
   year-narrowed entry ("Scarface 1932") does not send a same-titled film of
   another year the server holds, even where the AI check could clear it, and
   neither does an unrated one with blockUnrated on; a library copy of
   another year is judged on its own rating; a film the AI cleared is put
   back after a restart or a retry without asking again; a duplicate, a
   "which year?" and a full queue are answered before the AI is asked, so no
   check is spent on them; History says "sent: on the bypass list" only on a
   row that was queued; and an entry for "Heat" does not send "Heathers".
   And an unrated film blockUnrated blocks, or an unrated Queue link item, is
   asked about like a rated one and sent on a sure "no nudity" - which the
   panel's hint, the content check's header and docs/operations.md now say. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';
import { addOverride } from '../src/core/rating-overrides.js';
import { resetBreakers, resetModelCache } from '../src/core/ai-providers.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const REQ = 'movie-requests@g.us';
const POSTS = 'movie-posts@g.us';
const NOTIFY = 'movie-notify@g.us';

const FILMS = [
  { Id: 'a'.repeat(32), Name: 'Kill Me Three Times', ProductionYear: 2014, OfficialRating: 'R' },
  { Id: 'b'.repeat(32), Name: 'Paddington', ProductionYear: 2014, OfficialRating: 'PG' },
  // Rated R here to stand for any film on the list that its rating blocks.
  { Id: 'c'.repeat(32), Name: 'Fullmetal Alchemist: The Conqueror of Shamballa', ProductionYear: 2005, OfficialRating: 'R' },
  { Id: 'f'.repeat(32), Name: 'Nobody Rated This', ProductionYear: 2011, OfficialRating: '' },
].map((f) => ({ ...f, Type: 'Movie', MediaSources: [{ Path: `/nowhere/${f.Name}.mkv`, Size: 17, Container: 'mp4' }] }));
const OMDB = FILMS.map((f, i) => ({
  Title: f.Name, Year: String(f.ProductionYear), Rated: f.OfficialRating || 'Not Rated', imdbID: `tt${2000000 + i}`, Type: 'movie',
  Released: 'N/A', DVD: 'N/A', Response: 'True',
}));
// Library copies whose year is not the film's (step 4b). The Last Samurai is
// the 2003 film, held in Jellyfin as 2006; Scarface is only the 1983 film on
// the server, while OMDb also knows the 1932 one.
FILMS.push(...[
  { Id: 'd'.repeat(32), Name: 'The Last Samurai', ProductionYear: 2006, OfficialRating: 'R' },
  { Id: 'e'.repeat(32), Name: 'Scarface', ProductionYear: 1983, OfficialRating: 'R' },
].map((f) => ({ ...f, Type: 'Movie', MediaSources: [{ Path: `/nowhere/${f.Name}.mkv`, Size: 17, Container: 'mp4' }] })));
OMDB.push(...[
  { Title: 'The Last Samurai', Year: '2003', Rated: 'R', imdbID: 'tt0325710' },
  { Title: 'Scarface', Year: '1932', Rated: 'PG', imdbID: 'tt0023427' },
  { Title: 'Scarface', Year: '1983', Rated: 'R', imdbID: 'tt0086250' },
  // Known to OMDb, not on the server.
  { Title: 'Heat', Year: '1995', Rated: 'R', imdbID: 'tt0113277' },
].map((m) => ({ ...m, Type: 'movie', Released: 'N/A', DVD: 'N/A', Response: 'True' })));
// What OMDb makes of "The Last Samurai 2006" when that file is some other
// film: set for the cases that need it.
let impostor = null;
const IMPOSTOR = { Title: 'Samurai Rebellion', Year: '2006', Rated: 'R', imdbID: 'tt9999999', Type: 'movie', Released: 'N/A', DVD: 'N/A', Response: 'True' };
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// What Gemini said all afternoon on 2026-09-29, word for word.
const OVERLOADED = { error: { code: 503, message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary.', status: 'UNAVAILABLE' } };
let verdict = { nudity: false, confidence: 0.9, basis: 'violence only' };   // Gemini's answer, or 'fail' / 'overloaded'
let groqVerdict = { nudity: true, confidence: 0.9, basis: 'IMDb Parents Guide lists nudity' };
const calls = { gemini: 0, groq: 0, jellyfin: 0 };
const aiCalls = () => calls.gemini + calls.groq;
// What the last question to Gemini was about, for the cases that care which
// film was asked about.
let lastAsk = '';
// Set for the cases that need them: more films on the server (`extraFilms`),
// films taken off it (`hidden`, by id), and more films OMDb knows.
let extraFilms = [];
let hidden = new Set();
let extraOmdb = [];
// How many of the next Jellyfin film searches fail, as one that times out.
// The first search of a bare title is the "which one?" list's (step 0), and
// failing it is how a request still reaches the year question at step 4a.
let failSearches = 0;
const shelf = () => [...FILMS.filter((f) => !hidden.has(f.Id)), ...extraFilms];
const film = (Id, Name, ProductionYear, OfficialRating) => ({
  Id, Name, ProductionYear, OfficialRating, Type: 'Movie', MediaSources: [{ Path: `/nowhere/${Name}.mkv`, Size: 17, Container: 'mp4' }],
});
const omdb = (Title, Year, Rated, imdbID) => ({ Title, Year: String(Year), Rated, imdbID, Type: 'movie', Released: 'N/A', DVD: 'N/A', Response: 'True' });
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  if (u.hostname === 'generativelanguage.googleapis.com') {
    calls.gemini += 1;
    lastAsk = String(init?.body ?? '');
    if (verdict === 'fail') return json({ error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } }, 429);
    if (verdict === 'overloaded') return json(OVERLOADED, 503);
    return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(verdict) }] }, finishReason: 'STOP' }] });
  }
  if (u.hostname === 'api.groq.com') {
    calls.groq += 1;
    return json({
      id: 'chatcmpl-1', object: 'chat.completion', model: 'openai/gpt-oss-120b',
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(groqVerdict) }, finish_reason: 'stop' }],
    });
  }
  if (u.hostname === 'www.omdbapi.com') {
    const p = u.searchParams;
    const miss = json({ Response: 'False', Error: 'Movie not found!' });
    // A case's own films first, so a bare title can resolve to the one the
    // case needs: a year typed in the request is held to (typedYearOf), so
    // "a copy of another year" is asked for by title alone.
    const known = [...extraOmdb, ...OMDB];
    if (p.get('i')) return json(known.find((m) => m.imdbID === p.get('i')) ?? { Response: 'False' });
    const q = norm(p.get('t') ?? p.get('s'));
    if (impostor && q === 'the last samurai' && p.get('y') === '2006') return json(impostor);
    const hits = known.filter((m) => norm(m.Title) === q || norm(m.Title).includes(q));
    if (!hits.length) return miss;
    // OMDb's t= honours y= when it has that year; otherwise its best guess.
    const y = p.get('y');
    return p.get('s')
      ? json({ Response: 'True', Search: hits.map(({ Title, Year, imdbID, Type }) => ({ Title, Year, imdbID, Type })) })
      : json((y && hits.find((m) => m.Year === y)) || hits[0]);
  }
  if (u.hostname === 'jf.test') {
    calls.jellyfin += 1;
    if (u.pathname === '/Items') {
      const term = u.searchParams.get('searchTerm');
      if (!term || u.searchParams.get('IncludeItemTypes') === 'Series') return json({ Items: [] });
      if (failSearches > 0) { failSearches -= 1; throw new Error('Jellyfin did not answer in time'); }
      return json({ Items: shelf().filter((f) => norm(f.Name).includes(norm(term))) });
    }
    return json({ Items: [] });
  }
  return new Response('{}', { status: 404 });
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'film-override-test-'));

function config({ gemini = {}, ai = null, blockUnrated = false, announceRated = true } = {}) {
  const c = mergeDefaults({
    movieRequests: {
      requestGroups: [REQ], postsGroup: POSTS, notify: { group: NOTIFY },
      requirePrefix: true, prefix: '#request', cooldownSecondsPerUser: 0,
      blockedRatings: ['R', 'NC-17', 'X', 'TV-MA'], blockUnrated, replyOnBlock: true, announceRated, notifyRefusals: true,
    },
  }, DEFAULT_CONFIG);
  c.omdb.apiKey = 'test-key';
  c.gemini = { ...c.gemini, enabled: true, apiKey: 'GEMINI-KEY-123', model: 'gemini-test', contentCheck: true,
    minContentConfidence: 0.7, allowCleanRatedFilms: false, ...gemini };
  if (ai) c.ai = mergeDefaults(ai, DEFAULT_CONFIG.ai);
  c.library = mergeDefaults({
    provider: 'jellyfin',
    jellyfin: { baseUrl: 'http://jf.test', authMethod: 'apikey', apiKey: 'KEY', accessToken: 'TOK', userId: 'U1' },
  }, DEFAULT_CONFIG.library);
  Object.assign(c.media, { workDir: TMP });
  return c;
}

function store(data = {}) {
  return {
    get: (k, d = null) => (k in data ? data[k] : d),
    set: (k, v) => { data[k] = v; },
    push: (k, v) => { (data[k] ??= []).unshift(v); },
  };
}

function harness({ overrides = [], stored = null, gemini = {}, ai = null, blockUnrated = false, shared = null, full = false, announceRated = true } = {}) {
  const out = [];
  const jobs = [];
  // `stored`: the list exactly as state.json holds it. `shared`: the store of
  // an earlier harness, as the same state.json is after a restart.
  const s = shared ?? store(stored ? { 'rating-overrides': structuredClone(stored) } : {});
  for (const o of overrides) addOverride(s, o, { addedBy: 'owner' });
  const ctx = {
    config: config({ gemini, ai, blockUnrated, announceRated }),
    store: s,
    bot: {
      isConnected: () => true,
      react: async (m, emoji) => { out.push({ op: 'react', emoji }); return true; },
      sendText: async (jid, body) => { out.push({ op: 'text', jid, body }); return { key: { id: 'B' } }; },
      editText: async () => true,
      deleteMessage: async () => {}, archiveChat: async () => {},
      isGroupAdmin: () => false,
      groupMemberInfo: () => ({ isMember: false, mentionJid: null, mentionText: null }),
      groups: () => [], groupCache: new Map(), sameCommunity: () => false,
      groupMentionToken: (jid) => `@${jid.split('@')[0]}`,
      async _bulkPace() {}, on() {}, off() {},
    },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    configStore: { update() {} },
    queue: {
      maxLength: 50, pending: [], add: (j) => { jobs.push(j); return `job-${jobs.length}`; }, snapshot: () => ({ pending: [], active: [] }),
      // `full`: no room for another job, as JobQueue answers at its limit.
      hasRoom: () => !full, fullError: () => Object.assign(new Error('Queue is full'), { code: 'QUEUE_FULL' }),
    },
  };
  return { ctx, out, jobs, s };
}

moviePlugin._reactors = new Map();
let seq = 0;
// `who` is the member: since 2026-10-11 a member's own request asked again
// while it waits is "resent", not a duplicate (test/no-redo-reaction.test.mjs).
async function request(h, text, who = 'a') {
  const id = `M${++seq}`;
  const number = who === 'a' ? '15550000001' : '15550000002';
  await moviePlugin.onMessage({
    id, key: { id, remoteJid: REQ, participant: `${who}@lid`, fromMe: false }, text: `#request ${text}`, chatJid: REQ,
    isGroup: true, fromMe: false, messageType: 'conversation', senderJid: `${who}@lid`, senderNumber: number,
    senderNumberDisplay: `+${number}`, pushName: who, timestamp: Date.now(), raw: { key: { id } },
  }, h.ctx);
  await new Promise((r) => setTimeout(r, 20));
  return (h.s.get('history', []) ?? []).find((r) => r.id === id);
}
const reset = (v, g = { nudity: true, confidence: 0.9, basis: 'IMDb Parents Guide lists nudity' }) => {
  verdict = v; groqVerdict = g; calls.gemini = 0; calls.groq = 0; calls.jellyfin = 0; lastAsk = ''; resetBreakers(); resetModelCache();
};
// Back to the server and OMDb as FILMS and OMDB have them.
const restock = () => { extraFilms = []; hidden = new Set(); extraOmdb = []; };
const NUDE = { nudity: true, confidence: 0.95, basis: 'a sex scene' };
const CLEAN = { nudity: false, confidence: 0.9, basis: 'violence only' };
// The AI check could clear a rated film: the operator's switch, which is on
// on the live bot.
const CLEARS = { allowCleanRatedFilms: true };
const KILL_ME = 'sent: on the bypass list (rating override for "Kill Me Three Times" (2014) by owner)';

console.log('=== a film its rating allows is sent whatever the AI would say, and the AI is not asked ===');
{
  for (const [label, overrides] of [['not on the list', []], ['on the list too', ['Paddington 2014']]]) {
    reset(NUDE);
    const h = harness({ overrides, gemini: CLEARS });
    const row = await request(h, 'Paddington 2014');
    ok(h.jobs.length === 1 && row?.status === 'queued' && aiCalls() === 0 && !('contentCheck' in row) && !('override' in row),
      `a PG film the AI would call nude, ${label}: queued, nothing asked (${row?.status}, ${aiCalls()} calls)`);
  }
  // Nymphomaniac: Vol. I went out as "Not Rated", which is why the check was
  // written; the operator chose, knowing that, that blockUnrated decides
  // whether an unrated film is blocked, and a blocked one is asked about like
  // a rated one.
  reset(NUDE);
  const unrated = harness({ gemini: CLEARS });
  const u = await request(unrated, 'Nobody Rated This 2011');
  ok(unrated.jobs.length === 1 && u?.status === 'queued' && aiCalls() === 0,
    `an unrated film with blockUnrated off: sent, nothing asked (${u?.status}, ${aiCalls()} calls)`);
  reset(NUDE);
  const blockedUnrated = harness({ gemini: CLEARS, blockUnrated: true });
  const b = await request(blockedUnrated, 'Nobody Rated This 2011');
  ok(blockedUnrated.jobs.length === 0 && b?.status === 'blocked-rating' && aiCalls() === 1
    && b.detail === 'rated Not Rated — the AI check did not clear it (Gemini said nudity)',
  `with blockUnrated on it is asked about, and refused on its rating (${b?.detail})`);
}

console.log('=== an unrated film that blockUnrated blocks is asked about like a rated one, and a sure no-nudity sends it ===');
{
  // Found in review, 2026-09-29: the code asks the AI check about an unrated
  // film when blockUnrated is on, and about any unrated Queue link item, and
  // sends either on a sure "no nudity" - while the panel's Content check hint
  // said "unrated films go by Block films with no rating at all alone", the
  // content-check.js header that one "goes out or not on blockUnrated
  // alone", and docs/operations.md left the AI check out of Queue link. An
  // operator reading them would not expect an unrated film to go out on an
  // AI answer.
  reset(CLEAN);
  const h = harness({ gemini: CLEARS, blockUnrated: true });
  const row = await request(h, 'Nobody Rated This 2011');
  ok(h.jobs.length === 1 && row?.status === 'queued' && calls.gemini === 1,
    `blockUnrated on, a sure "no nudity": queued after one question (${row?.status}, ${calls.gemini} call)`);

  reset(CLEAN);
  const link = harness({ gemini: CLEARS });
  await moviePlugin.queueLibraryItem({ id: 'f'.repeat(32), title: 'Nobody Rated This', year: 2011, rated: '',
    localPath: '/nowhere/n.mkv', downloadUrl: 'http://jf.test/n', headers: {} }, link.ctx);
  ok(link.jobs.length === 1 && calls.gemini === 1, `an unrated item by Queue link: queued once the AI check clears it (${calls.gemini} call)`);

  // Read as prose: a comment's line breaks and leading asterisks taken out.
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\n\s*\*(?!\/)/g, ' ').replace(/\s+/g, ' ');
  const hint = read('src/web/public/index.html');
  ok(!/no rating at all<\/em> alone/.test(hint)
    && /unrated films are blocked or not as <em>Block films with no rating at all<\/em> says; when blocked, they are asked about like a rated film/.test(hint),
  'the panel\'s hint says a blocked unrated film is asked about like a rated one');
  const header = read('src/plugins/movie-requests/content-check.js');
  ok(!/on blockUnrated alone/.test(header) && /a blocked one is asked about like a rated one/.test(header),
    'so does the content check\'s header');
  ok(/unless it is on the list or the AI check clears it/.test(read('docs/operations.md')),
    'and docs/operations.md, for Queue link');
}

console.log('=== a bypass-list title is sent without asking the AI: a film by title ===');
{
  for (const [label, gemini] of [
    ['the AI would say nudity', CLEARS],
    ['the check cannot run', { ...CLEARS, apiKey: 'GEMINI-KEY-123' }],
    ['the check is switched off', { contentCheck: false }],
    ['clean rated films are not allowed', { allowCleanRatedFilms: false }],
  ]) {
    reset(label === 'the check cannot run' ? 'fail' : NUDE);
    const h = harness({ overrides: ['Kill Me Three Times 2014'], gemini });
    const row = await request(h, 'Kill Me Three Times 2014');
    ok(h.jobs.length === 1 && row?.status === 'queued' && aiCalls() === 0,
      `an R film on the list, ${label}: queued, nothing asked (${row?.status}, ${aiCalls()} calls)`);
    ok(row?.override === KILL_ME, `History says why: "${row?.override}"`);
  }

  reset(NUDE);
  const spelt = harness({ overrides: ['KILL-ME three times'] });
  const p = await request(spelt, 'Kill Me Three Times 2014');
  ok(spelt.jobs.length === 1 && aiCalls() === 0 && p?.override === 'sent: on the bypass list (rating override for "KILL-ME three times" by owner)',
    'case, spaces and punctuation ignored: sent');
  // "Exact title only" (2026-09-29): the start of the name was enough until then.
  const start = harness({ overrides: ['KILL-ME three'] });
  const st = await request(start, 'Kill Me Three Times 2014');
  ok(start.jobs.length === 0 && st?.status === 'blocked-rating' && st.detail === 'rated R' && !st.override,
    'the start of the name is not enough: refused on its rating');
  const later = harness({ overrides: ['Times'] });
  const not = await request(later, 'Kill Me Three Times 2014');
  ok(later.jobs.length === 0 && not?.status === 'blocked-rating' && not.detail === 'rated R', 'a later part of the name covers nothing');

  // The owner's entry, exactly as it was stored on the live bot. It sent
  // every "Fullmetal Alchemist: ..." film while an entry covered what a name
  // starts with; now the film is judged as any unlisted one: put to the AI
  // check, which says nudity here, and refused on its rating.
  const LIVE = [{ key: 't:full metal alchemist|', jellyfinId: null, title: 'full metal alchemist', year: null,
    addedBy: { username: 'superadmin', role: 'superadmin' }, note: '', addedAt: 1790636001601 }];
  reset(NUDE);
  const fma = harness({ stored: LIVE, gemini: CLEARS });
  const f = await request(fma, 'Fullmetal Alchemist The Conqueror of Shamballa 2005');
  ok(fma.jobs.length === 0 && f?.status === 'blocked-rating' && !f.override && aiCalls() === 1,
    `the owner's "full metal alchemist" no longer sends an R "Fullmetal Alchemist: ..." film: asked, and refused (${f?.status}, ${aiCalls()} call)`);
  reset(NUDE);
  const full = harness({ overrides: ['fullmetal alchemist the conqueror of shamballa'], gemini: CLEARS });
  const g = await request(full, 'Fullmetal Alchemist The Conqueror of Shamballa 2005');
  ok(full.jobs.length === 1 && aiCalls() === 0
    && g?.override === 'sent: on the bypass list (rating override for "fullmetal alchemist the conqueror of shamballa" by owner)',
    `an entry typed with the film's full name sends it, nothing asked (${g?.override})`);
}

console.log('=== a bypass-list title is sent without asking the AI: a film by Jellyfin id, asked for in free text ===');
{
  // Step 2 refused a film its letter blocked before the library had named it,
  // so an entry added by Jellyfin link - which matches the library's item and
  // nothing else - never applied to a request typed as text.
  reset(NUDE);
  const h = harness({ overrides: [`https://jf.test/web/#/details?id=${'a'.repeat(32)}`], gemini: CLEARS });
  const row = await request(h, 'Kill Me Three Times 2014');
  ok(h.jobs.length === 1 && row?.status === 'queued' && aiCalls() === 0,
    `Kill Me Three Times, listed by its Jellyfin link, asked for by name: queued, nothing asked (${row?.status}, ${aiCalls()})`);
  ok(row?.override === `sent: on the bypass list (rating override (Jellyfin item ${'a'.repeat(8)}… by owner))`, `"${row?.override}"`);

  reset(NUDE);
  const other = harness({ overrides: [`https://jf.test/web/#/details?id=${'c'.repeat(32)}`] });
  const r2 = await request(other, 'Kill Me Three Times 2014');
  ok(other.jobs.length === 0 && r2?.status === 'blocked-rating' && r2.detail === 'rated R' && aiCalls() === 0,
    `a link to another film does not cover it: refused on its rating, as before (${r2?.detail})`);
  ok(other.out.some((e) => e.op === 'text' && e.jid === REQ && e.body === 'Kill Me Three Times (2014) is rated R.'),
    'with the words a rated film always got');

  reset(NUDE);
  const away = harness({ overrides: [`https://jf.test/web/#/details?id=${'c'.repeat(32)}`] });
  const r3 = await request(away, 'Heat 1995');
  ok(away.jobs.length === 0 && r3?.status === 'blocked-rating' && r3.detail === 'rated R' && !(away.s.get('wanted', []) ?? []).length,
    `an R film not on the server is refused on its rating once the library has answered, not called missing (${r3?.status})`);

  reset(NUDE);
  const empty = harness();
  const r4 = await request(empty, 'Kill Me Three Times 2014');
  ok(empty.jobs.length === 0 && r4?.detail === 'rated R' && calls.jellyfin === 0,
    'with nothing on the list and the AI unable to clear it, it is refused before the library is asked, as before');
}

// The operator, 2026-10-21: "Turn off the bot responding in the group when
// something is rated R I believe the reaction is good enough", and "Rated R
// denies should not go in the queue group either". announceRated, off by
// default, is what the cases above turn on to keep their words tested.
console.log('=== by default a rated film gets the ⛔ alone: no reply, no notifications line ===');
{
  reset(NUDE);
  const h = harness({ announceRated: false });
  const r = await request(h, 'Kill Me Three Times 2014');
  ok(r?.status === 'blocked-rating' && h.jobs.length === 0, `refused on its rating (${r?.status})`);
  ok(!h.out.some((e) => e.op === 'text'), `no text anywhere: ${JSON.stringify(h.out.filter((e) => e.op === 'text'))}`);
  ok(h.out.some((e) => e.op === 'react' && e.emoji === h.ctx.config.movieRequests.reactions.rated), 'the rated reaction is given');
  ok(h.s.get('history', [])[0]?.status === 'blocked-rating', 'and History still has the row');
  ok(DEFAULT_CONFIG.movieRequests.announceRated === false, 'off by default');
}

console.log('=== a bypass-list title is sent without asking the AI: Re-run ===');
{
  reset(NUDE);
  const h = harness({ overrides: ['Kill Me Three Times 2014'], gemini: CLEARS });
  const r = await moviePlugin.requeue('Kill Me Three Times 2014', h.ctx);
  const row = h.s.get('history', [])[0];
  ok(r?.title === 'Kill Me Three Times' && h.jobs.length === 1 && aiCalls() === 0, `queued, nothing asked (${aiCalls()})`);
  ok(row?.override === KILL_ME, `History says why: "${row?.override}"`);

  reset(NUDE);
  const byLink = harness({ overrides: ['a'.repeat(32)] });
  await moviePlugin.requeue('Kill Me Three Times 2014', byLink.ctx);
  ok(byLink.jobs.length === 1 && aiCalls() === 0, 'an entry by Jellyfin link covers a Re-run by title too');

  reset(CLEAN);
  const none = harness();
  let err = null;
  try { await moviePlugin.requeue('Kill Me Three Times 2014', none.ctx); } catch (e) { err = e; }
  ok(err?.message === 'Kill Me Three Times is rated R (blocked)' && aiCalls() === 0, 'not on the list: refused on its rating, without a check');

  // With another film listed, the refusal waits for the library (a link
  // entry could cover its copy) - and is still the rating's, not "the queue
  // is full", when nothing covers it.
  reset(CLEAN);
  const full = harness({ overrides: ['Paddington 2014'] });
  full.ctx.queue.hasRoom = () => false;
  full.ctx.queue.fullError = () => new Error('Queue is full');
  err = null;
  try { await moviePlugin.requeue('Kill Me Three Times 2014', full.ctx); } catch (e) { err = e; }
  ok(err?.message === 'Kill Me Three Times is rated R (blocked)' && aiCalls() === 0,
    `a rated film nothing can send, into a full queue: refused on its rating (${err?.message})`);

  reset(NUDE);
  const twice = harness({ overrides: ['Kill Me Three Times 2014'] });
  await moviePlugin.requeue('Kill Me Three Times 2014', twice.ctx);
  err = null;
  try { await moviePlugin.requeue('Kill Me Three Times 2014', twice.ctx); } catch (e) { err = e; }
  ok(err?.code === 'DUPLICATE' && twice.jobs.length === 1, 'a Re-run of one already waiting is refused');
}

console.log('=== a bypass-list title is sent without asking the AI: queue-from-link ===');
{
  const item = { id: 'a'.repeat(32), title: 'Kill Me Three Times', year: 2014, rated: 'R', localPath: '/nowhere/k.mkv', downloadUrl: 'http://jf.test/x', headers: {} };
  reset('fail');
  const h = harness({ overrides: ['a'.repeat(32)], gemini: CLEARS });
  await moviePlugin.queueLibraryItem(item, h.ctx);
  const row = h.s.get('history', [])[0];
  ok(h.jobs.length === 1 && aiCalls() === 0 && row.override === `sent: on the bypass list (rating override (Jellyfin item ${'a'.repeat(8)}… by owner))`,
    `a listed R queued by link, with the check out of quota: queued, nothing asked ("${row.override}")`);

  reset(CLEAN);
  const none = harness();
  let err = null;
  try { await moviePlugin.queueLibraryItem(item, none.ctx); } catch (e) { err = e; }
  ok(/blocked list/.test(err?.message ?? '') && aiCalls() === 0, 'not on the list: refused on the rating, as before, without a check');

  const unrated = { ...item, id: 'f'.repeat(32), title: 'Nobody Rated This', year: 2011, rated: '' };
  reset(CLEAN);
  err = null;
  try { await moviePlugin.queueLibraryItem(unrated, harness().ctx); } catch (e) { err = e; }
  ok(/has no rating set in Jellyfin/.test(err?.message ?? ''), 'an item with no rating is refused, as before');
  const listed = harness({ overrides: ['f'.repeat(32)] });
  await moviePlugin.queueLibraryItem(unrated, listed.ctx);
  ok(listed.jobs.length === 1 && aiCalls() === 0, 'unless it is on the list: then it is queued, nothing asked');
}

console.log('=== an R film not on the list is cleared by a sure no-nudity and stays blocked on nudity or no answer ===');
{
  reset(CLEAN);
  const h = harness({ gemini: CLEARS });
  const row = await request(h, 'Kill Me Three Times 2014');
  ok(h.jobs.length === 1 && row?.status === 'queued' && calls.gemini === 1, `a sure "no nudity": queued after one question (${row?.status})`);
  ok(row?.contentCheck?.nudity === false && row.contentCheck.by === 'Gemini' && !('override' in row), 'History says who cleared it');

  for (const [label, v, detail] of [
    ['a sure "nudity"', NUDE, 'rated R — the AI check did not clear it (Gemini said nudity)'],
    ['"I do not know this film"', { nudity: null, confidence: 0, basis: 'unknown film' }, 'rated R — the AI check did not clear it (Gemini could not confirm no nudity)'],
    ['an unsure "no nudity"', { nudity: false, confidence: 0.3, basis: 'guess' }, 'rated R — the AI check did not clear it (Gemini could not confirm no nudity)'],
    ['no answer (quota)', 'fail', 'rated R — the AI check did not clear it (did not run: quota)'],
  ]) {
    reset(v);
    const b = harness({ gemini: CLEARS });
    const r = await request(b, 'Kill Me Three Times 2014');
    ok(b.jobs.length === 0 && r?.status === 'blocked-rating' && r.detail === detail, `${label}: refused on its rating - "${r?.detail}"`);
    const line = b.out.find((e) => e.op === 'text' && e.jid === NOTIFY)?.body;
    ok(line === "⛔ Kill Me Three Times (2014) — rated R, can't be posted"
      && b.out.some((e) => e.op === 'text' && e.jid === REQ && e.body === 'Kill Me Three Times (2014) is rated R.'),
    `  and the group is told what a rated film always got: "${line}"`);
  }
  reset('fail');
  const skipped = harness({ gemini: CLEARS });
  const s = await request(skipped, 'Kill Me Three Times 2014');
  ok(s?.contentCheckSkipped === 'quota', 'a check that could not run is marked on the row');

  reset(CLEAN);
  const off = harness({ gemini: { allowCleanRatedFilms: false } });
  const o = await request(off, 'Kill Me Three Times 2014');
  ok(off.jobs.length === 0 && o?.detail === 'rated R' && aiCalls() === 0 && calls.jellyfin === 0,
    'with "Also send rated films" off, nothing is asked and it is refused before the library, as before');
}

console.log('=== The Last Samurai, 2026-09-29: on the list, Gemini 503, Groq says nudity - sent, zero AI calls ===');
{
  // The live chain that afternoon: Gemini on a typed model answering 503,
  // Groq next with its "nudity", every provider allowed to clear.
  const ai = { order: ['gemini', 'groq'], gemini: { enabled: true, canClearRated: true },
    groq: { enabled: true, apiKey: 'gsk_TEST-groq-key-0000000000000000000000000000000000', model: 'openai/gpt-oss-120b', canClearRated: true } };
  reset('overloaded');
  const h = harness({ overrides: ['The Last Samurai (2003)'], gemini: CLEARS, ai });
  const row = await request(h, 'The Last Samurai');
  ok(h.jobs.length === 1 && row?.status === 'queued', `The Last Samurai is queued (${row?.status}: ${row?.detail ?? ''})`);
  ok(calls.gemini === 0 && calls.groq === 0, `with no AI call at all (Gemini ${calls.gemini}, Groq ${calls.groq})`);
  ok(row?.override === 'sent: on the bypass list (rating override for "The Last Samurai" (2003) by owner)', `"${row?.override}"`);
  ok(row?.year === 2003 && row?.rated === 'R', `as the film its 2006 copy really is (${row?.year}, ${row?.rated})`);

  // Not on the list, the same chain is asked and says what it said then:
  // refused on its rating, never on Groq's word.
  reset('overloaded');
  const off = harness({ gemini: CLEARS, ai });
  const r = await request(off, 'The Last Samurai');
  ok(off.jobs.length === 0 && r?.status === 'blocked-rating' && calls.gemini === 1 && calls.groq === 1
    && /Groq said nudity/.test(r.detail ?? ''), `off the list: Gemini, then Groq, asked; refused on its rating (${r?.detail})`);
}

console.log('=== a listed film whose library copy carries another year: sent, not refused on the file\'s rating ===');
{
  reset(NUDE);
  const h = harness({ overrides: ['The Last Samurai (2003)'] });
  const row = await request(h, 'The Last Samurai');
  ok(h.jobs.length === 1 && row?.status === 'queued' && aiCalls() === 0,
    `The Last Samurai (2003), held as 2006, is queued (${row?.status}: ${row?.detail ?? ''})`);
}

console.log('=== a library file its rating blocks, and no entry covers: refused as before ===');
{
  // Asked for by title alone, which OMDb resolves to the 1932 film. With
  // the year typed, the 1983 copy is not the film asked for at all (the
  // operator's "Dune 1984" verdict, 2026-09-29): see the case after these.
  reset(CLEAN);
  const h = harness();
  const row = await request(h, 'Scarface');
  ok(h.jobs.length === 0 && row?.status === 'blocked-rating' && row.detail === 'rated R (library file)' && aiCalls() === 0,
    `Scarface (1932, PG) whose only copy is the 1983 R film: refused on the file's rating, with no check (${row?.status}: ${row?.detail})`);

  const narrow = harness({ overrides: ['Scarface 1932'] });
  const r2 = await request(narrow, 'Scarface');
  ok(narrow.jobs.length === 0 && r2?.detail === 'rated R (library file)' && aiCalls() === 0,
    `an entry narrowed to 1932 does not cover the 1983 file found instead (${r2?.status}: ${r2?.detail})`);

  reset(NUDE);
  const wide = harness({ overrides: ['Scarface'] });
  const r3 = await request(wide, 'Scarface');
  ok(wide.jobs.length === 1 && r3?.year === 1983 && aiCalls() === 0,
    `an entry for every Scarface covers it, and it is sent (${r3?.status}, ${r3?.year})`);

  reset(CLEAN);
  const cleared = harness({ gemini: CLEARS });
  const r4 = await request(cleared, 'Scarface');
  ok(cleared.jobs.length === 1 && r4?.year === 1983 && calls.gemini === 1,
    `with the AI check able to clear it, the R file is asked about instead of refused, and sent when clean (${r4?.status})`);

  // "Scarface 1932" typed: the 1983 copy is another year's film, so the
  // request is answered "not in the library", listed or not, and nothing is
  // asked or sent.
  reset(CLEAN);
  const typed = harness({ overrides: ['Scarface'], gemini: CLEARS });
  const r5 = await request(typed, 'Scarface 1932');
  ok(typed.jobs.length === 0 && r5?.status === 'not-in-library'
    && r5.detail === 'not in library — closest in the library: "Scarface" (1983), a different year' && aiCalls() === 0,
  `with the year typed, the 1983 copy is not sent for it (${r5?.status}: ${r5?.detail})`);
}

console.log('=== a listed film whose library file is a different film: refused as the wrong film ===');
{
  reset(CLEAN);
  impostor = IMPOSTOR;
  const h = harness({ overrides: ['The Last Samurai (2003)'] });
  const row = await request(h, 'The Last Samurai');
  impostor = null;
  // Answered "not in the library", naming the file as the closest film, as
  // any request whose file turns out to be another film is (the Barefoot
  // fix, 2026-09-29).
  ok(h.jobs.length === 0 && row?.status === 'not-in-library'
    && row.detail === 'not in library — closest in the library: "Samurai Rebellion" (2006), a different film' && aiCalls() === 0,
  `the list never sends a film nobody asked for (${row?.status}: ${row?.detail})`);
}

console.log('=== a panel Re-run of a listed film with a drifted copy: the same ===');
{
  reset(NUDE);
  const h = harness({ overrides: ['The Last Samurai (2003)'] });
  const r = await moviePlugin.requeue('The Last Samurai', h.ctx);
  ok(r?.title === 'The Last Samurai' && h.jobs.length === 1 && aiCalls() === 0, 'queued, nothing asked');

  reset(CLEAN);
  const none = harness();
  let err = null;
  try { await moviePlugin.requeue('Scarface', none.ctx); } catch (e) { err = e; }
  ok(err?.message === 'Scarface (1983) is rated R (blocked)' && aiCalls() === 0, `not listed: refused on the file's rating (${err?.message})`);

  impostor = IMPOSTOR;
  const other = harness({ overrides: ['The Last Samurai (2003)'] });
  err = null;
  try { await moviePlugin.requeue('The Last Samurai', other.ctx); } catch (e) { err = e; }
  impostor = null;
  ok(/is actually "Samurai Rebellion" \(2006\) — refusing to send a different film/.test(err?.message ?? '') && other.jobs.length === 0,
    `a listed film whose file is another film: refused as that (${err?.message})`);
}

console.log('=== after a restart, a listed film is resumed, not dropped for its file\'s rating ===');
{
  reset(CLEAN);
  const before = harness({ overrides: ['The Last Samurai (2003)'] });
  await request(before, 'The Last Samurai');
  ok(before.s.get('pending', []).length === 1, 'the job is journalled');
  const after = harness({ shared: before.s });        // --- the process restarts ---
  await moviePlugin.recoverPending(after.ctx);
  ok(after.jobs.length === 1 && aiCalls() === 0, `and resumed, nothing asked (${after.jobs.length})`);

  // Taken off the list in the meantime: then it is not.
  const again = harness({ overrides: ['The Last Samurai (2003)'] });
  await request(again, 'The Last Samurai');
  again.s.set('rating-overrides', []);
  const gone = harness({ shared: again.s });
  await moviePlugin.recoverPending(gone.ctx);
  ok(gone.jobs.length === 0, 'unless the entry has been removed since');
}

console.log('=== a year-narrowed entry does not send a same-titled film of another year, even when the AI could clear it ===');
{
  // Review of 2026-09-29: once the AI check could take a rated library file
  // past step 4b, the entry step 2 found for the film asked for ("Scarface
  // 1932", PG) was handed on to the last step for the file the server held
  // (Scarface, 1983, R), and the R film nobody listed went out with no check,
  // History saying "sent: on the bypass list (... (1932) ...)".
  reset(NUDE);
  const h = harness({ overrides: ['Scarface 1932'], gemini: CLEARS });
  const row = await request(h, 'Scarface');
  ok(h.jobs.length === 0 && row?.status === 'blocked-rating' && /^rated R — the AI check did not clear it/.test(row.detail ?? ''),
    `a request: the 1983 file is refused on its rating, the AI saying nudity (${row?.status}: ${row?.detail})`);
  ok(calls.gemini === 1 && /Scarface/.test(lastAsk) && /1983/.test(lastAsk) && !/1932/.test(lastAsk),
    `  after one question, about Scarface (1983) (${calls.gemini})`);
  ok(!('override' in row), '  and no bypass note on the row');

  reset(CLEAN);
  const clean = harness({ overrides: ['Scarface 1932'], gemini: CLEARS });
  const c = await request(clean, 'Scarface');
  ok(clean.jobs.length === 1 && c?.status === 'queued' && c.year === 1983 && calls.gemini === 1
    && c.contentCheck?.nudity === false && !('override' in c),
  `  a sure "no nudity" sends it as cleared, not as bypassed (${c?.status}, ${c?.override ?? 'no override'})`);

  reset(NUDE);
  const rerun = harness({ overrides: ['Scarface 1932'], gemini: CLEARS });
  let err = null;
  try { await moviePlugin.requeue('Scarface', rerun.ctx); } catch (e) { err = e; }
  ok(/^Scarface is rated R \(blocked\) — the AI check did not clear it \(Gemini said nudity\)$/.test(err?.message ?? '')
    && rerun.jobs.length === 0 && calls.gemini === 1, `a Re-run: refused the same way (${err?.message})`);
  reset(CLEAN);
  const rerunClean = harness({ overrides: ['Scarface 1932'], gemini: CLEARS });
  await moviePlugin.requeue('Scarface', rerunClean.ctx);
  const rr = rerunClean.s.get('history', [])[0];
  ok(rerunClean.jobs.length === 1 && calls.gemini === 1 && rr?.contentCheck?.nudity === false && !('override' in rr),
    '  and queued as cleared, not as bypassed, on a sure "no nudity"');

  // The same without the AI at all: an unrated file, blockUnrated on, which
  // step 4b does not count as blocked. The entry for the 1990 film sent the
  // 2011 one, unrated and unlisted.
  extraOmdb = [omdb('Nobody Rated This', 1990, 'PG', 'tt0000990')];
  reset(NUDE);
  const unrated = harness({ overrides: ['Nobody Rated This 1990'], blockUnrated: true });
  const u = await request(unrated, 'Nobody Rated This');
  ok(unrated.jobs.length === 0 && u?.status === 'blocked-rating' && u.detail === 'rated Not Rated' && aiCalls() === 0 && !('override' in u),
    `blockUnrated on, the entry for 1990, only the unrated 2011 film on the server: refused (${u?.status}: ${u?.detail})`);
  err = null;
  try { await moviePlugin.requeue('Nobody Rated This', harness({ overrides: ['Nobody Rated This 1990'], blockUnrated: true }).ctx); } catch (e) { err = e; }
  ok(err?.message === 'Nobody Rated This is rated Not Rated (blocked)', `  a Re-run too (${err?.message})`);
  const none = harness({ blockUnrated: true });
  const n = await request(none, 'Nobody Rated This');
  ok(n?.status === 'blocked-rating' && none.jobs.length === 0, '  as it is with no entry at all');
  const wide = harness({ overrides: ['Nobody Rated This'], blockUnrated: true });
  const w = await request(wide, 'Nobody Rated This');
  ok(wide.jobs.length === 1 && aiCalls() === 0 && /^sent: on the bypass list/.test(w?.override ?? ''),
    '  while an entry that covers the 2011 film sends it, nothing asked');
  restock();
}

console.log('=== a library copy of another year is judged on its own rating, not the rating of the film asked for ===');
{
  // Scarface (1983, R) asked for, and the server holds only the 1932 film,
  // rated PG. The letter grade of the film asked for used to be carried to
  // the last step, which then put the PG film to the AI check.
  hidden = new Set(['e'.repeat(32)]);
  extraFilms = [film('9'.repeat(32), 'Scarface', 1932, 'PG')];
  // OMDb resolving the title alone to the 1983 film: a year typed would be
  // held to (typedYearOf), and "Scarface 1983" is then not in the library.
  extraOmdb = [omdb('Scarface', 1983, 'R', 'tt0086250')];
  reset(NUDE);
  const h = harness({ gemini: CLEARS });
  const row = await request(h, 'Scarface');
  ok(h.jobs.length === 1 && row?.status === 'queued' && row.year === 1932 && row.rated === 'PG' && aiCalls() === 0,
    `sent as the PG film it is, nothing asked (${row?.status}, ${row?.year}, ${aiCalls()} calls)`);
  reset(NUDE);
  const rerun = harness({ gemini: CLEARS });
  const r = await moviePlugin.requeue('Scarface', rerun.ctx);
  ok(r?.year === 1932 && rerun.jobs.length === 1 && aiCalls() === 0, `a Re-run too (${r?.year}, ${aiCalls()} calls)`);
  restock();
}

console.log('=== after a restart or a retry, a film the AI cleared is put back without asking again ===');
{
  // Review of 2026-09-29: an R film no entry covers reaches the queue through
  // the AI check; when its library copy carries another year (The Last
  // Samurai as 2006), the re-check at resume found it rated R and dropped it
  // at every restart and every retry - the rating refusing a film the AI had
  // already let through.
  reset(CLEAN);
  const before = harness({ gemini: CLEARS });
  const row = await request(before, 'The Last Samurai');
  const journalled = before.s.get('pending', [])[0];
  ok(row?.status === 'queued' && calls.gemini === 1 && journalled?.record?.aiCleared === 'rated, but no nudity',
    `cleared by the AI, queued and journalled with the clearance (${journalled?.record?.aiCleared})`);
  reset(NUDE);
  const after = harness({ shared: before.s, gemini: CLEARS });     // --- the process restarts ---
  await moviePlugin.recoverPending(after.ctx);
  ok(after.jobs.length === 1 && aiCalls() === 0, `resumed after a restart, nothing asked (${after.jobs.length} queued, ${aiCalls()} calls)`);

  // A transient failure's retry, in this process, goes through the same step.
  reset(NUDE);
  const retry = harness({ shared: before.s, gemini: CLEARS });
  const jobKey = retry.s.get('pending', [])[0]?.jobKey;
  await moviePlugin._retryNow(retry.ctx, jobKey, 1);
  const retried = (retry.s.get('history', []) ?? []).find((r) => r.id === row.id);
  ok(retry.jobs.length === 1 && aiCalls() === 0 && retried?.status !== 'failed',
    `retried, nothing asked (${retry.jobs.length} queued, row ${retried?.status})`);

  // A job with no clearance and no entry - journalled by a build before this
  // one - is still dropped on its file's rating.
  reset(CLEAN);
  const old = harness({ gemini: CLEARS });
  const o = await request(old, 'The Last Samurai');
  old.s.set('pending', old.s.get('pending', []).map((p) => {
    const { aiCleared, ...record } = p.record;
    return { ...p, record };
  }));
  const oldRestart = harness({ shared: old.s, gemini: CLEARS });
  await moviePlugin.recoverPending(oldRestart.ctx);
  ok(oldRestart.jobs.length === 0, 'a film with no clearance and no entry is still dropped after a restart');
  reset(CLEAN);
  const old2 = harness({ gemini: CLEARS });
  const o2 = await request(old2, 'The Last Samurai');
  old2.s.set('pending', old2.s.get('pending', []).map((p) => {
    const { aiCleared, ...record } = p.record;
    return { ...p, record };
  }));
  const oldRetry = harness({ shared: old2.s, gemini: CLEARS });
  await moviePlugin._retryNow(oldRetry.ctx, oldRetry.s.get('pending', [])[0]?.jobKey, 1);
  const failed = (oldRetry.s.get('history', []) ?? []).find((r) => r.id === o2?.id);
  ok(oldRetry.jobs.length === 0 && failed?.status === 'failed' && failed.detail === 'rated R (library file)',
    `and on a retry (${failed?.status}: ${failed?.detail})`);
  ok(o?.status === 'queued', '  (both had been queued on a clearance first)');
}

console.log('=== a second request for a cleared film is a duplicate, with no second AI call ===');
{
  // Review of 2026-09-29: the AI check came before the duplicate check, so a
  // second "#request Kill Me Three Times" while the first waited spent a
  // second check - and with Gemini overloaded it ended ⛔ "rated R" while the
  // first request's job went on to post the film.
  reset(CLEAN);
  const h = harness({ gemini: CLEARS });
  const first = await request(h, 'Kill Me Three Times 2014');
  ok(first?.status === 'queued' && calls.gemini === 1, 'the first is cleared and queued');
  reset(CLEAN);
  const second = await request(h, 'Kill Me Three Times 2014', 'b');
  ok(second?.status === 'duplicate' && aiCalls() === 0 && h.jobs.length === 1,
    `the second is answered as a duplicate, nothing asked (${second?.status}, ${aiCalls()} calls)`);
  reset('overloaded');
  // Its own member asking again goes the same way, before the check: resent.
  const third = await request(h, 'Kill Me Three Times 2014');
  ok(third?.status === 'resent' && aiCalls() === 0 && h.jobs.length === 1
    && h.out.filter((e) => e.op === 'react').at(-1)?.emoji !== h.ctx.config.movieRequests.reactions.rated,
  `with Gemini answering 503 too: asked again by its member, resent, not ⛔ rated R (${third?.status}: ${third?.detail})`);

  // A full queue refuses a film whatever the check says: no check is spent.
  reset(CLEAN);
  const full = harness({ gemini: CLEARS, full: true });
  const f = await request(full, 'Kill Me Three Times 2014');
  ok(f?.status === 'error' && f.detail === 'queue full' && aiCalls() === 0, `a full queue: refused before the check is asked (${f?.status}: ${f?.detail})`);
  // A film the check will not be asked about keeps the answer it always got.
  reset(CLEAN);
  const rated = harness({ overrides: ['Paddington 2014'], full: true });
  const r = await request(rated, 'Kill Me Three Times 2014');
  ok(r?.status === 'blocked-rating' && r.detail === 'rated R' && aiCalls() === 0,
    `a rated film nothing can send, into a full queue: refused on its rating, as before (${r?.detail})`);
}

console.log('=== a rated film held in several copies, asked for without a year, is asked which one with no AI call ===');
{
  // Review of 2026-09-29: the check was asked before "which year?", so an
  // ambiguous request spent one of Gemini's twenty a day on an answer that
  // sent nothing, and a rated copy the check did not clear was refused ⛔
  // where the Test tab said need-year.
  //
  // Since 2026-10-11 the question is the "which one?" list in every group
  // (it was beta001, Off in a config with no beta modes, as this one has),
  // and the list is made without asking the AI anything: only the film
  // picked is put to it. The year question at 4a is what is left when the
  // list's own search fails, and it is still asked before the check.
  extraFilms = [film('8'.repeat(32), 'Kill Me Three Times', 2016, 'R')];
  for (const v of [NUDE, CLEAN, 'overloaded']) {
    const said = typeof v === 'string' ? v : v.nudity ? 'nudity' : 'no nudity';
    reset(v);
    const h = harness({ gemini: CLEARS });
    const row = await request(h, 'Kill Me Three Times');
    ok(row?.status === 'pick-list' && row.pickList?.offered?.join() === '2014,2016' && aiCalls() === 0 && h.jobs.length === 0,
      `the AI would say ${said}: the list of both, nothing asked (${row?.status}, ${aiCalls()} calls)`);
    reset(v);
    const f = harness({ gemini: CLEARS });
    failSearches = 1;
    const fallback = await request(f, 'Kill Me Three Times');
    failSearches = 0;
    ok(fallback?.status === 'need-year' && fallback.detail === '2 copies: 2014, 2016' && aiCalls() === 0 && f.jobs.length === 0,
      `   and where the list could not search: need-year, nothing asked (${fallback?.status}, ${aiCalls()} calls)`);
  }
  restock();
}

console.log('=== History says "sent: on the bypass list" only on a row that was queued ===');
{
  // Review of 2026-09-29: the bypass note was put on the record at the last
  // gate, before "which year?" and before the queue could refuse it, so a
  // need-year row read "sent: on the bypass list (...)" with nothing sent.
  extraFilms = [film('8'.repeat(32), 'Kill Me Three Times', 2016, 'R')];
  reset(NUDE);
  const h = harness({ overrides: ['Kill Me Three Times'] });
  const row = await request(h, 'Kill Me Three Times');
  ok(row?.status === 'pick-list' && !('override' in row) && h.jobs.length === 0,
    `a listed film held in two years, asked for with no year: the "which one?" list, no note (${row?.status}, ${row?.override ?? 'none'})`);
  reset(NUDE);
  const unlisted = harness({ overrides: ['Kill Me Three Times'] });
  failSearches = 1;
  const fallback = await request(unlisted, 'Kill Me Three Times');
  failSearches = 0;
  ok(fallback?.status === 'need-year' && !('override' in fallback) && unlisted.jobs.length === 0,
    `and where the list could not search: need-year, no note (${fallback?.status}, ${fallback?.override ?? 'none'})`);
  restock();

  reset(NUDE);
  const dup = harness({ overrides: ['Kill Me Three Times 2014'] });
  const first = await request(dup, 'Kill Me Three Times 2014');
  const second = await request(dup, 'Kill Me Three Times 2014', 'b');
  ok(first?.override === KILL_ME && second?.status === 'duplicate' && !('override' in second),
    `a duplicate request for a listed film: a duplicate row with no "sent:" note (${second?.status}, ${second?.override ?? 'none'})`);

  reset(NUDE);
  const full = harness({ overrides: ['Kill Me Three Times 2014'] });
  full.ctx.queue.add = () => { throw Object.assign(new Error('Queue is full'), { code: 'QUEUE_FULL' }); };
  const f = await request(full, 'Kill Me Three Times 2014');
  ok(f?.status === 'error' && f.detail === 'queue full' && !('override' in f),
    `a listed film the queue has no room for: an error row with no note (${f?.status}, ${f?.override ?? 'none'})`);
}

console.log('=== an entry for Heat does not send Heathers without the AI check ===');
{
  // Review of 2026-09-29: an entry covered every name that started with its
  // letters, and since an entry sends what it covers with no check, "Heat"
  // would have sent "Heathers", a title nobody listed.
  extraFilms = [film('7'.repeat(32), 'Heathers', 1989, 'R')];
  extraOmdb = [omdb('Heathers', 1989, 'R', 'tt0097493')];
  reset(CLEAN);
  const h = harness({ overrides: ['Heat'] });
  const row = await request(h, 'Heathers 1989');
  ok(h.jobs.length === 0 && row?.status === 'blocked-rating' && row.detail === 'rated R' && aiCalls() === 0 && !('override' in row),
    `the check unable to clear it: refused on its rating (${row?.status}: ${row?.detail})`);
  reset(NUDE);
  const asked = harness({ overrides: ['Heat'], gemini: CLEARS });
  const a = await request(asked, 'Heathers 1989');
  ok(asked.jobs.length === 0 && a?.status === 'blocked-rating' && calls.gemini === 1,
    `the check able to clear it: asked, and refused on the AI's "nudity" (${a?.detail})`);
  reset(CLEAN);
  const clean = harness({ overrides: ['Heat'], gemini: CLEARS });
  const c = await request(clean, 'Heathers 1989');
  ok(clean.jobs.length === 1 && calls.gemini === 1 && c?.contentCheck?.nudity === false && !('override' in c),
    '  and sent as cleared, not on the entry, on a sure "no nudity"');
  restock();
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
