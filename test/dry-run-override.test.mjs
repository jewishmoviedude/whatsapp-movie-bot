/* The panel's dry run says what a request does with a title on the bypass
   list: sends it, with no AI check.
   Run: node test/dry-run-override.test.mjs

   On 2026-09-29 the operator put "The Last Samurai" (2003), "Collateral"
   (2004) and "Fullmetal Alchemist: Brotherhood" season 1 on the override
   list, then dry-ran The Last Samurai in the Test tab at 16:23 UTC and was
   told "Blocked: rating". The dry run kept its own copy of the rating step,
   which had never heard of the list: "Items I added to rated r bypass still
   showing as bot will block". The dry run now takes the live gate's own
   steps (movie-requests/film-gate.js), so the two cannot drift apart again.

   Later that day Gemini answered 503 for hours and Groq said The Last
   Samurai had nudity, and the operator decided what a listed title gets:
   "Send it, no AI check" - and that the AI check only ever helps: "No, AI
   only helps". Pinned over real HTTP against the real router, with OMDb,
   Jellyfin and Gemini a stubbed fetch: a listed R film is "would-send", with
   the reason "on the bypass list - sent without the AI check", and no AI
   call - whatever Gemini would say, with it overloaded, or with the check
   off; a film not on the list is cleared by a sure "no nudity" where the AI
   check may clear it, and otherwise refused on its rating, never on the
   AI's say; and with nothing that could send it, it is still refused at the
   rating step with no library lookup and no AI call.

   And from the review of the dry run: a request re-checks the rating of a
   library file that does not look like the film vetted (step 4b). With The
   Last Samurai held in Jellyfin as 2006, the real movie plugin handles the
   same request against the same stubs, and the dry run's verdict is the
   request's, for a listed film with a drifted copy and for one whose file is
   a different film.

   And from the review of the change that evening: an entry narrowed to a
   year ("Scarface 1932") does not send the same-titled film of another year
   the server holds, in the dry run or a request, even where the AI check
   could clear it, and neither does one for an unrated film with blockUnrated
   on; and the two agree on a rated title held in several copies, asked for
   with no year - need-year, with no AI question.

   And from the review of 2026-10-11, when the "which one?" list left beta
   for every group: a request now asks the library first (step 0) and
   answers a bare title with the list, or goes ahead with the one film it can
   send, while the dry run still had only step 4a's year question. It said
   "Ambiguous — needs a year" for Heat, the incident's own title, where
   members got the list, and for Frozen with the 2010 film R and the 2013 one
   PG, which a request queued. The dry run now takes step 0 through the
   request's own code (movie-requests/step-zero.js), and each case is run
   through both: a list ('pick-list', the same films offered), too many to
   list ('narrow'), the one sendable film (would-send, by title and year,
   looked up as typed when OMDb does not know the library's title), and the
   year question where no copy can be listed (need-year). */
import http from 'node:http';
import express from 'express';
import { createApiRouter } from '../src/web/api.js';
import { JobQueue } from '../src/core/queue.js';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';
import { addOverride, removeOverride, describeOverride } from '../src/core/rating-overrides.js';
import { BYPASS_NOTE } from '../src/core/rating-overrides.js';
import { resetBreakers, resetModelCache } from '../src/core/ai-providers.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import moviePlugin from '../src/plugins/movie-requests/index.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const FILMS = [
  { Id: 'a'.repeat(32), Name: 'The Last Samurai', ProductionYear: 2003, OfficialRating: 'R' },
  { Id: 'b'.repeat(32), Name: 'Collateral', ProductionYear: 2004, OfficialRating: 'R' },
  { Id: 'c'.repeat(32), Name: 'Heat', ProductionYear: 1995, OfficialRating: 'R' },
  { Id: 'd'.repeat(32), Name: 'Nobody Rated This', ProductionYear: 2011, OfficialRating: '' },
].map((f) => ({ ...f, Type: 'Movie', MediaSources: [{ Path: `/nowhere/${f.Name}.mkv`, Size: 17, Container: 'mp4' }] }));
const OMDB = FILMS.map((f, i) => ({
  Title: f.Name, Year: String(f.ProductionYear), Rated: f.OfficialRating || 'Not Rated', imdbID: `tt${3000000 + i}`,
  Type: 'movie', Released: 'N/A', DVD: 'N/A', Response: 'True',
}));
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// What Gemini said all afternoon, word for word, on every call to
// gemini-3.8-flash after 12:59 UTC.
const OVERLOADED = {
  error: {
    code: 503,
    message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary.',
    status: 'UNAVAILABLE',
  },
};

let gemini = { nudity: false, confidence: 0.95, basis: 'battle violence; no nudity shown' };   // or 'overloaded'
// The year Jellyfin gives The Last Samurai, and what OMDb makes of the file
// when it is looked up again: 2003 as it should be, or 2006 as a mislabelled
// copy (step 4b) - and then, for one case, some other film altogether.
let samuraiYear = 2003;
let impostor = null;
// More films on the server and in OMDb, for the cases that need them.
let extraFilms = [];
let extraOmdb = [];
const film = (Id, Name, ProductionYear, OfficialRating) => ({
  Id, Name, ProductionYear, OfficialRating, Type: 'Movie', MediaSources: [{ Path: `/nowhere/${Name}.mkv`, Size: 17, Container: 'mp4' }],
});
const omdb = (Title, Year, Rated, imdbID) => ({ Title, Year: String(Year), Rated, imdbID, Type: 'movie', Released: 'N/A', DVD: 'N/A', Response: 'True' });
const calls = { gemini: 0, jellyfin: 0, other: [] };
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  if (u.hostname === 'generativelanguage.googleapis.com') {
    calls.gemini += 1;
    if (gemini === 'overloaded') return json(OVERLOADED, 503);
    return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(gemini) }] }, finishReason: 'STOP' }] });
  }
  if (u.hostname === 'www.omdbapi.com') {
    const p = u.searchParams;
    const q = norm(p.get('t') ?? p.get('s'));
    if (impostor && q === 'the last samurai' && p.get('y') === '2006') return json(impostor);
    // A case's own films first, so a bare title can resolve to the one the
    // case needs: a year typed in the request is held to (typedYearOf).
    const hits = [...extraOmdb, ...OMDB].filter((m) => norm(m.Title) === q);
    if (!hits.length) return json({ Response: 'False', Error: 'Movie not found!' });
    // t= honours y= when OMDb has that year, as the real one does.
    const y = p.get('y');
    return p.get('s')
      ? json({ Response: 'True', Search: hits.map(({ Title, Year, imdbID, Type }) => ({ Title, Year, imdbID, Type })) })
      : json((y && hits.find((m) => m.Year === y)) || hits[0]);
  }
  if (u.hostname === 'jf.test') {
    calls.jellyfin += 1;
    const term = u.searchParams.get('searchTerm');
    if (u.pathname === '/Items' && term && u.searchParams.get('IncludeItemTypes') === 'Movie') {
      return json({ Items: [...FILMS, ...extraFilms].filter((f) => norm(f.Name).includes(norm(term)))
        .map((f) => (f.Name === 'The Last Samurai' ? { ...f, ProductionYear: samuraiYear } : f)) });
    }
    return json({ Items: [] });
  }
  calls.other.push(String(url));
  return new Response('{}', { status: 404 });
};

const CONFIG = mergeDefaults({
  web: { adminPasswordHash: 'x', users: [{ username: 'mommy', role: 'superadmin', passwordHash: 'x' }] },
  movieRequests: { blockedRatings: ['R', 'NC-17', 'X', 'TV-MA'] },
}, DEFAULT_CONFIG);
CONFIG.omdb.apiKey = 'omdb-key';
CONFIG.library = mergeDefaults({
  provider: 'jellyfin',
  jellyfin: { baseUrl: 'http://jf.test', authMethod: 'apikey', apiKey: 'KEY', accessToken: 'TOK', userId: 'U1' },
}, DEFAULT_CONFIG.library);
// A model typed in, so the 503 below is the whole of Gemini's answer; what
// Automatic does about one is test/gemini-overloaded-model.test.mjs.
const GEMINI_ON = {
  ...CONFIG.gemini, enabled: true, contentCheck: true, apiKey: 'AIzaSyTEST-dry-run-000000000000000000', model: 'gemini-3.8-flash',
  minContentConfidence: 0.7, allowCleanRatedFilms: false,
};
CONFIG.gemini = { ...GEMINI_ON };

function makeStateStore() {
  const spaces = new Map();
  return {
    namespace(name) {
      if (!spaces.has(name)) spaces.set(name, { data: {} });
      const sp = spaces.get(name);
      return {
        get: (k, d) => sp.data[k] ?? d,
        set: (k, v) => { sp.data[k] = v; },
        push: (k, v) => { (sp.data[k] ??= []).unshift(v); },
      };
    },
  };
}

const stateStore = makeStateStore();
// The operator's entries, as typed.
const list = stateStore.namespace('movie-requests');
addOverride(list, 'The Last Samurai (2003)', { addedBy: 'mommy' });
addOverride(list, 'Collateral (2004)', { addedBy: 'mommy' });
addOverride(list, 'Fullmetal Alchemist: Brotherhood season 1', { addedBy: 'mommy' });
addOverride(list, 'Nobody Rated This', { addedBy: 'mommy' });

const queue = new JobQueue({ concurrency: 1 }); queue.pause();
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = { user: { username: 'mommy', role: 'superadmin' } }; next(); });
app.use('/api', createApiRouter({
  configStore: { get: () => CONFIG, update: () => CONFIG, redacted: () => ({}), onChange: () => {} },
  bot: { groupCache: new Map(), groups: () => [], on: () => {}, state: 'connected' },
  queue, linkQueue: queue,
  pluginManager: { plugins: new Map(), notifyConfigChange: async () => {} },
  stateStore, fileLogger: { tail: () => [] }, alerts: {}, lockScheduler: {},
}));
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const port = server.address().port;

function dryRun(text) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ text });
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/test/request',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
    (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve(JSON.parse(buf)));
    });
    r.on('error', reject);
    r.write(data);
    r.end();
  });
}

function reset(verdict) {
  gemini = verdict;
  calls.gemini = 0; calls.jellyfin = 0; calls.other = [];
  CONFIG.gemini = { ...GEMINI_ON };
  CONFIG.movieRequests.blockUnrated = false;
  resetBreakers();
  resetModelCache();
}
const step = (r, name) => r.steps.find((s) => s.step === name);

const LAST_SAMURAI = 'rating override for "The Last Samurai" (2003) by mommy';

console.log('=== a bypass-list title is sent without asking the AI: the dry run ===');
{
  for (const [label, verdict, over] of [
    ['the AI would say nudity', { nudity: true, confidence: 0.95, basis: 'a brief topless scene' }, { allowCleanRatedFilms: true }],
    ['Gemini overloaded (HTTP 503, 2026-09-29)', 'overloaded', { allowCleanRatedFilms: true }],
    ['the content check switched off', { nudity: false, confidence: 0.95, basis: 'x' }, { contentCheck: false }],
  ]) {
    reset(verdict);
    CONFIG.gemini = { ...GEMINI_ON, ...over };
    const r = await dryRun('The Last Samurai');
    ok(r.verdict === 'would-send' && r.reason === BYPASS_NOTE, `${label}: would-send, "${r.reason}" (${r.verdict})`);
    ok(calls.gemini === 0, `  and no AI call (${calls.gemini})`);
    const rating = step(r, 'rating');
    ok(rating?.ok === true && rating.detail === `rated R — on the bypass list (${LAST_SAMURAI}), so it is sent without the AI check`,
      `  the rating step says the list is why: "${rating?.detail}"`);
    ok(step(r, 'library')?.ok === true, '  it goes on to the library, as a request does');
    const content = step(r, 'content');
    ok(content?.ok === true && content.detail === `${BYPASS_NOTE} (${LAST_SAMURAI})`, `  and the content step says so: "${content?.detail}"`);
  }

  reset({ nudity: true, confidence: 0.9, basis: 'x' });
  const c = await dryRun('Collateral');
  ok(c.verdict === 'would-send' && c.reason === BYPASS_NOTE && calls.gemini === 0, 'Collateral, the other film on the list, too');
}

console.log('=== a film not on the list, where the AI check may clear it: cleared, or refused on its rating ===');
{
  reset({ nudity: false, confidence: 0.95, basis: 'violence and language' });
  CONFIG.gemini = { ...GEMINI_ON, allowCleanRatedFilms: true };
  const r = await dryRun('Heat');
  ok(step(r, 'rating')?.ok === true && /^rated R — blocked unless a bypass-list entry covers the library's copy, or the AI check clears it/.test(step(r, 'rating').detail),
    `the rating step says what could still send it: "${step(r, 'rating')?.detail}"`);
  ok(r.verdict === 'would-send' && !r.reason && calls.gemini === 1, `a sure "no nudity" clears it (${r.verdict}, ${calls.gemini} call)`);
  ok(/^no nudity \(confidence 0\.95\) — violence and language — answered by Gemini \(gemini-3\.8-flash\)\. Cleared: rated R, but no nudity$/.test(step(r, 'content')?.detail ?? ''),
    `and says who cleared it: "${step(r, 'content')?.detail}"`);

  reset({ nudity: true, confidence: 0.9, basis: 'a sex scene' });
  CONFIG.gemini = { ...GEMINI_ON, allowCleanRatedFilms: true };
  const n = await dryRun('Heat');
  ok(n.verdict === 'blocked-rating' && n.reason === 'rated R — the AI check did not clear it (Gemini said nudity)',
    `"nudity": refused on its rating, never on the AI's say (${n.verdict}: ${n.reason})`);

  reset('overloaded');
  CONFIG.gemini = { ...GEMINI_ON, allowCleanRatedFilms: true };
  const o = await dryRun('Heat');
  const content = step(o, 'content');
  ok(o.verdict === 'blocked-rating' && /did not run/.test(o.reason) && /503/.test(content?.detail ?? '')
    && !content?.detail.includes(GEMINI_ON.apiKey), `no answer: refused on its rating, and says why: "${content?.detail}"`);
}

console.log('=== a film not on the list that nothing can send: refused on its rating, with no AI call ===');
{
  reset({ nudity: false, confidence: 0.95, basis: 'x' });
  const r = await dryRun('Heat');
  ok(r.verdict === 'blocked-rating' && calls.gemini === 0, `blocked-rating, nothing asked (${r.verdict})`);
  ok(step(r, 'library')?.ok === true && /so the rating decides: rated R is blocked$/.test(step(r, 'content')?.detail ?? ''),
    `with film entries on the list, it is settled after the library lookup, as a request settles it: "${step(r, 'content')?.detail}"`);

  // With nothing on the list that could cover a film, as before: at the
  // rating step, with no library lookup past step 0's one search, which a
  // request makes too, before OMDb (it finds the one Heat, R, and nothing to
  // list).
  const kept = list.get('rating-overrides', []);
  list.set('rating-overrides', kept.filter((e) => e.season != null));
  reset({ nudity: false, confidence: 0.95, basis: 'x' });
  const bare = await dryRun('Heat');
  list.set('rating-overrides', kept);
  ok(bare.verdict === 'blocked-rating' && bare.steps.at(-1).step === 'rating' && bare.steps.at(-1).detail === 'rated R - blocked'
    && !step(bare, 'library') && calls.jellyfin === 1 && calls.gemini === 0,
  `no film entries: refused at the rating step, no lookup but step 0's search (${calls.jellyfin}), no AI call ("${bare.steps.at(-1).detail}")`);
}

console.log('=== an unrated film with blockUnrated on is decided where a request decides it ===');
{
  // A request lets an unrated film past step 2 and judges it at the content
  // step (contentGate, blockUnrated). The dry run used to stop it at the
  // rating step, so a listed one read as refused there too.
  reset({ nudity: true, confidence: 0.95, basis: 'x' });
  CONFIG.movieRequests.blockUnrated = true;
  const r = await dryRun('Nobody Rated This');
  ok(step(r, 'rating')?.ok === true && /unrated films are blocked/.test(step(r, 'rating').detail),
    `the rating step says unrated films are blocked, and passes it on: "${step(r, 'rating')?.detail}"`);
  ok(r.verdict === 'would-send' && r.reason === BYPASS_NOTE && calls.gemini === 0, `on the list, it would be sent, nothing asked (${r.verdict})`);

  list.set('rating-overrides', list.get('rating-overrides', []).filter((e) => e.title !== 'Nobody Rated This'));
  reset({ nudity: false, confidence: 0.95, basis: 'nothing shown' });
  CONFIG.movieRequests.blockUnrated = true;
  const off = await dryRun('Nobody Rated This');
  ok(off.verdict === 'blocked-rating' && calls.gemini === 0, `not on the list, it stays blocked on its (missing) rating (${off.verdict})`);
  CONFIG.movieRequests.blockUnrated = false;
}

console.log('=== a listed film whose library copy carries another year: the dry run says what a request does ===');
{
  // The live plugin, on the same config, list and stubs as the dry run.
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dry-run-live-'));
  const REQ = 'movie-requests@g.us';
  Object.assign(CONFIG.movieRequests, {
    requestGroups: [REQ], postsGroup: 'movie-posts@g.us', notify: { group: 'movie-notify@g.us' },
    requirePrefix: true, prefix: '#request', cooldownSecondsPerUser: 0,
  });
  CONFIG.media = { ...CONFIG.media, workDir: TMP };
  moviePlugin._reactors = new Map();
  let seq = 0;
  const live = async (text) => {
    const jobs = [];
    const ctx = {
      config: CONFIG, store: list,
      bot: {
        isConnected: () => true, react: async () => true,
        sendText: async () => ({ key: { id: 'B' } }), editText: async () => true,
        deleteMessage: async () => {}, archiveChat: async () => {}, isGroupAdmin: () => false,
        groupMemberInfo: () => ({ isMember: false, mentionJid: null, mentionText: null }),
        groups: () => [], groupCache: new Map(), sameCommunity: () => false,
        groupMentionToken: (jid) => `@${jid.split('@')[0]}`, async _bulkPace() {}, on() {}, off() {},
      },
      log: { info() {}, warn() {}, error() {}, debug() {} },
      configStore: { update() {} },
      queue: { maxLength: 50, pending: [], add: (j) => { jobs.push(j); return `job-${jobs.length}`; }, snapshot: () => ({ pending: [], active: [] }) },
    };
    const id = `D${++seq}`;
    await moviePlugin.onMessage({
      id, key: { id, remoteJid: REQ, participant: 'a@lid', fromMe: false }, text: `#request ${text}`, chatJid: REQ,
      isGroup: true, fromMe: false, messageType: 'conversation', senderJid: 'a@lid', senderNumber: '15550000001',
      senderNumberDisplay: '+15550000001', pushName: 'a', timestamp: Date.now(), raw: { key: { id } },
    }, ctx);
    await new Promise((r) => setTimeout(r, 20));
    const row = (list.get('history', []) ?? []).find((r) => r.id === id);
    // The pending job is not this test's business; the next request must not
    // be refused as a duplicate of it.
    list.set('pending', []);
    return { row, jobs };
  };
  // What each request outcome is called in the dry run.
  const asDryRun = (row) => ({ queued: 'would-send' }[row?.status] ?? row?.status);

  samuraiYear = 2006;
  for (const [label, verdict] of [
    ['the AI would say clean', { nudity: false, confidence: 0.95, basis: 'battle violence; no nudity shown' }],
    ['the AI would say nudity', { nudity: true, confidence: 0.95, basis: 'a topless scene' }],
  ]) {
    reset(verdict);
    const r = await dryRun('The Last Samurai');
    reset(verdict);
    const { row, jobs } = await live('The Last Samurai');
    ok(r.verdict === 'would-send' && asDryRun(row) === 'would-send' && calls.gemini === 0,
      `${label}: the dry run says ${r.verdict}, the request ends ${row?.status}, nothing asked (${row?.detail ?? ''}${jobs.length ? ', queued' : ''})`);
    const file = step(r, 'library file');
    ok(file?.ok === true && file.detail === `the server's file, The Last Samurai (2006), looked up again: The Last Samurai (2003), rated R — on the bypass list (${LAST_SAMURAI}), so it is sent without the AI check`,
      `and the dry run shows the step: "${file?.detail}"`);
  }

  reset({ nudity: false, confidence: 0.95, basis: 'x' });
  impostor = { Title: 'Samurai Rebellion', Year: '2006', Rated: 'R', imdbID: 'tt9999999', Type: 'movie', Released: 'N/A', DVD: 'N/A', Response: 'True' };
  const r = await dryRun('The Last Samurai');
  const { row } = await live('The Last Samurai');
  impostor = null;
  // Both answer it "not in the library", naming the file as the closest
  // film (the Barefoot fix, 2026-09-29).
  ok(r.verdict === 'not-in-library' && row?.status === 'not-in-library' && r.reason === row.detail,
    `a listed film whose file is a different film: ${r.verdict} in the dry run, ${row?.status} in a request (${row?.detail})`);
  ok(step(r, 'library file')?.ok === false && /is "Samurai Rebellion" \(2006\), which isn't the same film/.test(step(r, 'library file').detail)
    && calls.gemini === 0, `with nothing asked: "${step(r, 'library file')?.detail}"`);

  // Unlisted, the request refuses the file on its rating at step 4b; the dry
  // run stops at the rating step before it, having the same rating to go on.
  samuraiYear = 2003;

  console.log('=== a year-narrowed entry does not send a same-titled film of another year, even when the AI could clear it ===');
  // Review of 2026-09-29: the dry run handed the entry for the film asked
  // for ("Scarface 1932", PG) on to the last step for the file the server
  // held (Scarface, 1983, R), and said would-send - as a request sent it.
  // Asked for by title alone, which OMDb resolves to the 1932 film: a year
  // typed is held to, and "Scarface 1932" is not in the library at all.
  extraFilms = [film('e'.repeat(32), 'Scarface', 1983, 'R')];
  extraOmdb = [omdb('Scarface', 1932, 'PG', 'tt0023427'), omdb('Scarface', 1983, 'R', 'tt0086250'),
    omdb('Nobody Rated This', 1990, 'PG', 'tt0000990')];
  const scarface = addOverride(list, 'Scarface 1932', { addedBy: 'mommy' });
  for (const [label, verdict, want] of [
    ['the AI saying nudity', { nudity: true, confidence: 0.95, basis: 'a sex scene' }, 'blocked-rating'],
    ['a sure "no nudity"', { nudity: false, confidence: 0.95, basis: 'violence only' }, 'would-send'],
  ]) {
    reset(verdict);
    CONFIG.gemini = { ...GEMINI_ON, allowCleanRatedFilms: true };
    const r = await dryRun('Scarface');
    ok(r.verdict === want && r.reason !== BYPASS_NOTE && calls.gemini === 1 && step(r, 'content')?.detail !== `${BYPASS_NOTE} (${describeOverride(scarface)})`,
      `the dry run, ${label}: ${want}, after one AI question, not on the bypass list (${r.verdict}: ${r.reason ?? ''})`);
    reset(verdict);
    CONFIG.gemini = { ...GEMINI_ON, allowCleanRatedFilms: true };
    const { row } = await live('Scarface');
    ok(asDryRun(row) === want && !('override' in row) && calls.gemini === 1, `  and a request agrees (${row?.status})`);
  }
  removeOverride(list, scarface.key);

  // With no AI at all: an unrated file, blockUnrated on.
  const nobody = addOverride(list, 'Nobody Rated This 1990', { addedBy: 'mommy' });
  reset({ nudity: true, confidence: 0.95, basis: 'x' });
  CONFIG.movieRequests.blockUnrated = true;
  const u = await dryRun('Nobody Rated This');
  ok(u.verdict === 'blocked-rating' && calls.gemini === 0,
    `an entry for the 1990 film, only the unrated 2011 one on the server, blockUnrated on: ${u.verdict}, nothing asked`);
  CONFIG.movieRequests.blockUnrated = false;
  removeOverride(list, nobody.key);
  extraFilms = []; extraOmdb = [];

  console.log('=== the dry run and a request agree on an ambiguous rated title ===');
  // Review of 2026-09-29: a request asked the AI check before "which year?",
  // so it spent a check and, on "nudity", ended ⛔ rated R, where the dry run
  // said need-year.
  extraFilms = [film('7'.repeat(32), 'Kill Me Three Times', 2014, 'R'), film('8'.repeat(32), 'Kill Me Three Times', 2016, 'R')];
  extraOmdb = [omdb('Kill Me Three Times', 2014, 'R', 'tt2393845')];
  reset({ nudity: true, confidence: 0.95, basis: 'a sex scene' });
  CONFIG.gemini = { ...GEMINI_ON, allowCleanRatedFilms: true };
  const amb = await dryRun('Kill Me Three Times');
  const dryCalls = calls.gemini;
  reset({ nudity: true, confidence: 0.95, basis: 'a sex scene' });
  CONFIG.gemini = { ...GEMINI_ON, allowCleanRatedFilms: true };
  const { row: ambRow } = await live('Kill Me Three Times');
  // Since the "which one?" list left beta for every group (2026-10-11) the
  // question is the list, in both, and neither spends a check on it.
  ok(amb.verdict === 'pick-list' && ambRow?.status === 'pick-list'
    && amb.offered?.map((v) => v.year).join() === '2014,2016' && ambRow.pickList?.offered?.join() === '2014,2016'
    && dryCalls === 0 && calls.gemini === 0,
  `both answer with the list, the same two films, nothing asked of the AI (dry run ${amb.verdict}, request ${ambRow?.status}; ${dryCalls} + ${calls.gemini} calls)`);
  extraFilms = []; extraOmdb = [];

  console.log('=== step 0: the dry run and a request agree on a bare title the library answers ===');
  // Heat, the incident's own title, held as 1995 and 2013, both R. Where the
  // AI check may clear them, both can be listed.
  extraFilms = [film('9'.repeat(32), 'Heat', 2013, 'R')];
  extraOmdb = [omdb('Heat', 2013, 'R', 'tt2190367')];
  reset({ nudity: false, confidence: 0.95, basis: 'x' });
  CONFIG.gemini = { ...GEMINI_ON, allowCleanRatedFilms: true };
  const heat = await dryRun('Heat');
  reset({ nudity: false, confidence: 0.95, basis: 'x' });
  CONFIG.gemini = { ...GEMINI_ON, allowCleanRatedFilms: true };
  const { row: heatRow } = await live('Heat');
  ok(heat.verdict === 'pick-list' && heatRow?.status === 'pick-list'
    && heat.offered?.map((v) => `${v.title} ${v.year}`).join() === 'Heat 1995,Heat 2013' && heatRow.pickList?.offered?.join() === '1995,2013',
  `"Heat": the list in both, not "which year?" (dry run ${heat.verdict}, request ${heatRow?.status})`);
  ok(step(heat, 'which one')?.ok === false && /^2 films on the server are called "Heat" and can be sent — the requester is answered with a numbered list to pick from: Heat \(1995\), Heat \(2013\)$/.test(step(heat, 'which one').detail)
    && !step(heat, 'lookup'), `and the dry run says so, before any OMDb lookup: "${step(heat, 'which one')?.detail}"`);

  // Where neither copy can be sent (no AI check to clear them, and the
  // bypass list covers neither), step 0 has nothing to list, and a request
  // goes on to step 4a's "which year?" - so does the dry run.
  reset({ nudity: false, confidence: 0.95, basis: 'x' });
  const heatNone = await dryRun('Heat');
  reset({ nudity: false, confidence: 0.95, basis: 'x' });
  const { row: heatNoneRow } = await live('Heat');
  ok(heatNone.verdict === 'need-year' && heatNoneRow?.status === 'need-year' && !step(heatNone, 'which one'),
    `nothing sendable to list: need-year in both, as before (dry run ${heatNone.verdict}, request ${heatNoneRow?.status})`);

  // Frozen, the 2010 film R and the 2013 one PG, with no AI check to clear
  // the R one: one film can be sent, and a request goes ahead with it. The
  // dry run said "Ambiguous — needs a year" (review of 2026-10-11).
  extraFilms = [film('1'.repeat(32), 'Frozen', 2010, 'R'), film('2'.repeat(32), 'Frozen', 2013, 'PG')];
  extraOmdb = [omdb('Frozen', 2010, 'R', 'tt1323045'), omdb('Frozen', 2013, 'PG', 'tt2294629')];
  reset({ nudity: false, confidence: 0.95, basis: 'x' });
  const frozen = await dryRun('Frozen');
  reset({ nudity: false, confidence: 0.95, basis: 'x' });
  const { row: frozenRow, jobs: frozenJobs } = await live('Frozen');
  ok(frozen.verdict === 'would-send' && asDryRun(frozenRow) === 'would-send' && frozenJobs[0]?.label === 'Frozen (2013)',
    `Frozen: the dry run says ${frozen.verdict}, and a request queues ${frozenJobs[0]?.label ?? frozenRow?.status}`);
  ok(step(frozen, 'which one')?.ok === true && /^Frozen \(2013\) is the one film on the server of these that can be sent — a request goes ahead with it, by title and year$/.test(step(frozen, 'which one').detail)
    && /^Frozen \(2013\)/.test(step(frozen, 'lookup')?.detail ?? '') && /^found: Frozen \(2013\)/.test(step(frozen, 'library')?.detail ?? ''),
  `the dry run names the film it goes ahead with, and looks that one up: "${step(frozen, 'which one')?.detail}"`);

  // More sendable films start with the words than a list offers: one reply
  // asking for another word or the year, in both.
  extraFilms = [film('3'.repeat(32), 'Paddington', 2014, 'PG'), film('4'.repeat(32), 'Paddington 2', 2017, 'PG'),
    film('5'.repeat(32), 'Paddington in Peru', 2024, 'PG')];
  extraOmdb = [];
  CONFIG.movieRequests.pickList = { ...CONFIG.movieRequests.pickList, maxOptions: 2 };
  reset({ nudity: false, confidence: 0.95, basis: 'x' });
  const many = await dryRun('Paddington');
  const { row: manyRow } = await live('Paddington');
  CONFIG.movieRequests.pickList = { ...CONFIG.movieRequests.pickList, maxOptions: 20 };
  ok(many.verdict === 'narrow' && manyRow?.status === 'need-year' && !!manyRow?.pickNarrow
    && step(many, 'which one')?.detail === '3 films start with "Paddington" — add a word or the year, e.g. #request Paddington 2',
  `too many to list: "add a word or the year" in both (dry run ${many.verdict}: "${step(many, 'which one')?.detail}", request ${manyRow?.status})`);

  // The one film starting with the words, held under a title OMDb does not
  // know: a request looks it up as typed (lookupHeldFilm), and the dry run
  // does the same rather than end in "No matching film".
  extraFilms = [film('6'.repeat(32), 'Mission: Impossible - Dead Reckoning Part One', 2023, 'PG-13')];
  extraOmdb = [omdb('Mission: Impossible - Dead Reckoning', 2023, 'PG-13', 'tt9603212')];
  reset({ nudity: false, confidence: 0.95, basis: 'x' });
  const mi = await dryRun('Mission: Impossible - Dead Reckoning');
  const { row: miRow, jobs: miJobs } = await live('Mission: Impossible - Dead Reckoning');
  ok(mi.verdict === 'would-send' && asDryRun(miRow) === 'would-send' && miJobs.length === 1,
    `a library title OMDb does not know: ${mi.verdict} in the dry run, ${miRow?.status} in a request`);
  ok(mi.steps.filter((x) => x.step === 'which one').map((x) => x.detail).join(' | ')
    === 'Mission: Impossible - Dead Reckoning Part One (2023) is the one film on the server that starts with "Mission: Impossible - Dead Reckoning" — a request goes ahead with it, by title and year'
    + ' | OMDb does not know "Mission: Impossible - Dead Reckoning Part One 2023", the library\'s title — looked up as typed, "Mission: Impossible - Dead Reckoning", as a request is',
  `and says so: ${JSON.stringify(mi.steps.filter((x) => x.step === 'which one').map((x) => x.detail))}`);
  extraFilms = []; extraOmdb = [];
  fs.rmSync(TMP, { recursive: true, force: true });
}

server.close();

console.log('=== the panel names each verdict ===');
{
  const fs = await import('node:fs');
  const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  const map = app.slice(app.indexOf('async function runTest()'), app.indexOf('/* ----------------------------- history'));
  for (const v of ['would-send', 'blocked-rating', 'wrong-film']) {
    ok(new RegExp(`'${v}': \\['(good|bad)', `).test(map), `"${v}" has a label, not a bare code`);
  }
  // Step 0's two answers (2026-10-11).
  ok(/'pick-list': \['warn', /.test(map) && /\bnarrow: \['bad', /.test(map), '"pick-list" and "narrow" have labels too');
  ok(!/'blocked-content'|'blocked-override'/.test(map), 'and no verdict the AI decided is left: it never refuses anything');
  ok(/r\.reason \? `Would send — \$\{r\.reason\}`/.test(map), 'a would-send with a reason (the bypass list) shows it');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
