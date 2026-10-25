/* A request that queued part of what it asked for is named by the episodes
   that went into the queue, and a dash is read as every episode between its
   ends.
   Run: node test/tv-range-named-by-what-was-queued.test.mjs

   At 17:19 EDT on 2026-10-11 Aiden asked for "Outer Banks S05E04-E10". The
   bot read it as the run it is and looked up all seven episodes, E04 to E10.
   Outer Banks is TV-MA, so each was put to the AI check (Gemini answered
   HTTP 401 and Groq stood in), which could confirm no nudity for E08 and E09
   only: those two were queued, and E04-E07 and E10 were withheld on their
   rating, as the operator's rule has it ("No, AI only helps"). Every line
   about the request still named it "Outer Banks S05E04–E10 — 2 episode(s)":
   the "added" line, the queue, the journal, History, and - after a restart
   at 07:16 UTC had resumed it from the journal - at 20:26 UTC the next day
   "✅ Outer Banks S05E04–E10 — 2 episode(s) — all 2 episodes posted!". The
   operator read that as E04 and E10, the dash taken for a comma: "if it's a
   dash it's 4 through 10, comma then it'll only be those 2, comprendo?"

   The dash was read right, and is pinned here as it is read. What was wrong
   is the name: the span asked for, beside a count of what was queued. A
   request that queued part of what it asked for - episodes withheld on
   their rating, waiting already from another request, past the episode
   limit, or in a run, missing from the library - is now named by the
   episodes queued, written as the operator reads codes, and what they are
   part of: "Outer Banks S05E08–E09 — 2 of E04–E10", "S05E04, E10" with a
   gap, "2 of season 5" for a season. That is the "added" line, the queue,
   the journal (so a restart keeps it), History, the panel's manual queue and
   the finished notice. A request that queued all it asked for keeps today's
   words exactly, and a journal entry written before this still loads and
   finishes under the name it was given.

   Pinned through the real TV plugin and the real queue; Jellyfin and Gemini
   are a stubbed fetch. */
import plugin from '../src/plugins/tv-requests/index.js';
import { parseTvRequest } from '../src/plugins/tv-requests/parse.js';
import { LIMITS, resetPacing } from '../src/plugins/tv-requests/override-check.js';
import { RATING_NOTICE_FEATURE } from '../src/plugins/tv-requests/withheld.js';
import { resetBreakers, resetModelCache } from '../src/core/ai-providers.js';
import { JobQueue } from '../src/core/queue.js';
import { runAdminCommand } from '../src/core/admin-commands.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

LIMITS.paceMs = 0;          // no two-second gaps between AI checks in a test

const TVREQ = 'tvreq@g.us';
const NOTIFY = 'notify@g.us';
const POSTS = 'tvposts@g.us';

const SHOW = 'Outer Banks';
const SERIES_ID = 'a1'.repeat(16);
const SEASON_ID = 'b2'.repeat(16);
const SEASON = 5;
const epId = (n) => `e${String(n).padStart(3, '0')}`.padEnd(32, 'c');

/* ------------------------------------------------------------ network --- */

let rating = 'TV-MA';       // the series' rating, and every episode's
let missing = new Set();    // episode numbers the library does not have
let cleared = new Set();    // the episodes the AI check finds no nudity in
let aiCalls = [];           // the episode code of every prompt Gemini was sent

const json = (v, status = 200) => ({
  ok: status < 400, status, statusText: status < 400 ? 'OK' : 'Error', headers: new Headers(),
  json: async () => v, text: async () => JSON.stringify(v),
});

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('generativelanguage.googleapis.com')) {
    const prompt = JSON.parse(init.body).contents[0].parts[0].text;
    const code = prompt.match(/Episode: (S\d\dE(\d\d))/);
    aiCalls.push(code?.[1]);
    // As Groq answered the episodes it could not clear on 2026-10-11:
    // "nudity=null (0)", which clears nothing.
    const v = cleared.has(Number(code?.[2]))
      ? { nudity: false, confidence: 0.9, basis: 'no nudity' }
      : { nudity: null, confidence: 0, basis: 'not enough information' };
    return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(v) }] }, finishReason: 'STOP' }] });
  }
  const p = new URL(u);
  const held = Array.from({ length: 10 }, (_, k) => k + 1).filter((n) => !missing.has(n));
  if (p.pathname.endsWith('/Seasons')) return json({ Items: [{ Id: SEASON_ID, IndexNumber: SEASON, ChildCount: held.length }] });
  if (p.pathname.endsWith('/Episodes')) {
    return json({
      Items: held.map((n) => ({
        Id: epId(n), SeriesName: SHOW, SeriesId: SERIES_ID, SeasonId: SEASON_ID,
        ParentIndexNumber: SEASON, IndexNumber: n, Name: `Episode ${n}`, OfficialRating: rating,
        MediaSources: [{ Path: `/tv/obx/s5/${n}.mkv`, Size: 1000, Container: 'mkv' }],
      })),
    });
  }
  if (p.pathname === '/Items' && p.searchParams.get('Ids')) {
    return json({
      Items: p.searchParams.get('Ids').split(',').map((id) => ({
        Id: id, Type: 'Episode', Name: `Episode ${Number(id.slice(1, 4))}`, SeriesName: SHOW,
        ParentIndexNumber: SEASON, IndexNumber: Number(id.slice(1, 4)), Overview: 'What happens.',
      })),
    });
  }
  if (p.pathname === '/Items' || p.pathname === '/Search/Hints') {
    return json({
      Items: [{ Id: SERIES_ID, Name: SHOW, ProductionYear: 2020, OfficialRating: rating, RecursiveItemCount: held.length }],
      SearchHints: [],
    });
  }
  return json({}, 404);
};

/**
 * A TV-MA season of which the AI check clears `ok` (episode numbers) and no
 * other episode; `tv14` makes the show and its episodes TV-14, which needs no
 * check at all; `gone` are the episodes the library does not have.
 */
function reset(ok = [], { tv14 = false, gone = [] } = {}) {
  rating = tv14 ? 'TV-14' : 'TV-MA';
  missing = new Set(gone);
  cleared = new Set(ok); aiCalls = [];
  resetBreakers(); resetModelCache(); resetPacing();
}

/* ------------------------------------------------------------ harness --- */

function store() {
  const d = new Map();
  return { get: (k, v) => (d.has(k) ? d.get(k) : v), set: (k, v) => { d.set(k, v); }, delete: (k) => d.delete(k) };
}

/**
 * `notice` is the tv-rating-notice mode, `dup` tv-duplicate-notice's; `cap`
 * is tvRequests.maxEpisodesPerRequest. `tv` and `queue` are the store and the
 * queue to use, so a second harness on the first one's store is the next
 * process after a restart.
 */
function harness({ notice = 'off', dup = 'off', cap = 0, tv = store(), queue = null } = {}) {
  const texts = [], jobs = [], logs = [];
  const ctx = {
    config: {
      tvRequests: {
        enabled: true, requestGroups: [TVREQ], postsGroups: [POSTS], cooldownSecondsPerUser: 0,
        blockedRatings: ['TV-MA', 'R', 'NC-17', 'X'], maxEpisodesPerRequest: cap,
      },
      movieRequests: {
        requestGroups: [],
        reactions: { researching: '🔍', added: '🎬', duplicate: '🤥', rated: '⛔', notInLibrary: '📬', failed: '⚠️', done: '✅' },
        notify: { group: NOTIFY },
      },
      beta: { groups: [], postsGroup: '', features: { [RATING_NOTICE_FEATURE]: notice, 'tv-duplicate-notice': dup } },
      library: { jellyfin: { baseUrl: 'http://jf:8096', accessToken: 'TOK', userId: 'U1' } },
      // The operator's switch that lets a sure "no nudity" clear a rated
      // episode, on on the live bot.
      gemini: { enabled: true, contentCheck: true, apiKey: 'GEMINI-KEY-123', model: 'gemini-test', minContentConfidence: 0.7, allowCleanRatedFilms: true },
      media: { workDir: '/tmp/tv-range-named' },
    },
    bot: {
      isConnected: () => true,
      react: async () => {},
      sendText: async (jid, body) => { texts.push({ jid, body }); return { key: { id: 'X' } }; },
      isGroupAdmin: () => false,
      deleteMessage: async () => {},
      archiveChat: async () => {},
    },
    queue: queue ?? { maxLength: 500, pending: [], add: (j) => { jobs.push(j); return `job-${jobs.length}`; }, hasRoom: () => true },
    store: tv,
    overrideStore: store(),
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), debug() {} },
  };
  return {
    ctx, texts, jobs, logs, tv,
    history: () => tv.get('history', []),
    journal: () => tv.get('pending', []),
    notes: () => texts.filter((t) => t.jid === NOTIFY).map((t) => t.body),
  };
}

let seq = 0;
const mkMsg = (text, sender = '15551112222') => ({
  id: `MSG${++seq}`, key: { id: `MSG${seq}` }, text, chatJid: TVREQ, isGroup: true, fromMe: false,
  messageType: 'conversation', senderJid: `${sender}@lid`, senderNumber: sender,
  senderNumberDisplay: `+${sender}`, pushName: 'Aiden', timestamp: Date.now(),
});
const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));   // TV notifications are fire-and-forget
const ask = async (h, text, sender) => { await plugin.onMessage(mkMsg(text, sender), h.ctx); await settle(); };
const queued = (h) => h.jobs.map((j) => j.meta.episode);

/** Post every queued episode without downloading anything: each reports done. */
async function finishAll(h) {
  const real = plugin.deliverEpisode;
  plugin.deliverEpisode = async ({ notifier }) => { notifier?.episodeDone(); };
  try { for (const j of h.jobs.splice(0)) await j.run({ id: 'j', progress() {}, isCancelled: () => false }); }
  finally { plugin.deliverEpisode = real; }
  await settle();
}

/** Until `cond` holds, or a second has gone by. */
async function until(cond) {
  for (let i = 0; i < 100 && !cond(); i++) await settle();
  return cond();
}

/* ================================================================ cases */

console.log('=== a dash is every episode between its ends ===');
{
  for (const t of ['Outer Banks S05E04-E10', 'Outer Banks S05E04–E10', 'Outer Banks S05E04 - E10', 'Outer Banks S05E04-10',
    'Outer Banks s5e4-e10', 'Outer Banks S05 E04-E10', 'Outer Banks S05E04 to E10', 'Outer Banks S05E04-S05E10']) {
    const p = parseTvRequest(t);
    ok(p.show === SHOW && p.season === 5 && p.episode == null && p.episodeRange?.from === 4 && p.episodeRange?.to === 10,
      `"${t}" is S05, episodes 4 through 10 (${JSON.stringify(p.episodeRange)})`);
  }
}

console.log('=== the incident: seven looked up, two cleared, and the request named by those two ===');
{
  reset([8, 9]);
  const h = harness();
  await ask(h, 'Outer Banks S05E04-E10');
  ok(aiCalls.join() === 'S05E04,S05E05,S05E06,S05E07,S05E08,S05E09,S05E10',
    `every episode from 4 to 10 was looked up and put to the check (${aiCalls.join()})`);
  ok(queued(h).join() === '8,9', `E08 and E09 queued, the five the check could not clear withheld (${queued(h).join()})`);
  ok(h.notes()[0] === `🎬 ${SHOW} S05E08–E09 — 2 of E04–E10 — added to the queue`, `the "added" line names them: "${h.notes()[0]}"`);
  ok(h.logs.includes(`📺 queueing ${SHOW} S05E08–E09 — 2 of E04–E10`), 'and so does the log');
  ok(h.jobs.length === 2 && h.jobs.every((j) => j.groupLabel === `${SHOW} S05E08–E09`), `and the queue: "${h.jobs[0]?.groupLabel}"`);
  ok(h.journal()[0]?.label === `${SHOW} S05E08–E09 — 2 of E04–E10`,
    `and the journal, which a restart names it by: "${h.journal()[0]?.label}"`);
  const row = h.history()[0];
  ok(row.request === 'Outer Banks S05E04-E10', `History keeps what was typed ("${row.request}")`);
  ok(row.detail.startsWith('S05E08–E09 — 2 of E04–E10 · 5 withheld (TV-MA): E4–E7, E10'),
    `and says what is coming, and what was withheld: "${row.detail}"`);
  await finishAll(h);
  const done = h.notes().at(-1);
  ok(done === `✅ ${SHOW} S05E08–E09 — 2 of E04–E10 — all 2 episodes posted! Check the posts group`, `the finished notice: "${done}"`);
  ok(!h.notes().some((n) => n.includes('S05E04–E10 — 2 episode(s)')) && !h.history()[0].detail.includes('S05E04–E10'),
    'nothing says "S05E04–E10 — 2 episode(s)", which read as E04 and E10');
}

console.log('=== the rating notice on: its "added" line keeps the span, which its sentence explains ===');
{
  reset([8, 9]);
  const h = harness({ notice: 'on' });
  await ask(h, 'Outer Banks S05E04-E10');
  ok(h.notes()[0].startsWith(`🎬 ${SHOW} S05E04–E10 — 2 of 7 episodes added to the queue. `
    + "Episodes 4–7 and 10 are rated TV-MA, which can't be posted, so they were left out."), `"${h.notes()[0]}"`);
  ok(h.journal()[0]?.label === `${SHOW} S05E08–E09 — 2 of E04–E10`, `the request itself is named by what is coming: "${h.journal()[0]?.label}"`);
  await finishAll(h);
  ok(h.notes().at(-1).startsWith(`✅ ${SHOW} S05E08–E09 — 2 of E04–E10 — all 2 episodes posted!`), `"${h.notes().at(-1)}"`);
}

console.log('=== a gap is a comma, a run is a dash ===');
{
  reset([4, 10]);
  const ends = harness();
  await ask(ends, 'Outer Banks S05E04-E10');
  ok(queued(ends).join() === '4,10' && ends.journal()[0]?.label === `${SHOW} S05E04, E10 — 2 of E04–E10`,
    `E04 and E10 alone are "S05E04, E10" - what the operator took the old name for: "${ends.journal()[0]?.label}"`);
  ok(ends.jobs[0]?.groupLabel === `${SHOW} S05E04, E10`, `in the queue too: "${ends.jobs[0]?.groupLabel}"`);
  reset([4, 5, 9]);
  const runs = harness();
  await ask(runs, 'Outer Banks S05E04-E10');
  ok(runs.notes()[0] === `🎬 ${SHOW} S05E04–E05, E09 — 3 of E04–E10 — added to the queue`, `runs and single episodes: "${runs.notes()[0]}"`);
  ok(runs.history()[0].detail.startsWith('S05E04–E05, E09 — 3 of E04–E10 · 4 withheld (TV-MA): E6–E8, E10'), `"${runs.history()[0].detail}"`);
}

console.log('=== a season that queued part of itself is named by that part ===');
{
  reset([8, 9]);
  const h = harness();
  await ask(h, 'Outer Banks season 5');
  ok(queued(h).join() === '8,9', `E08 and E09 of the ten (${queued(h).join()})`);
  ok(h.notes()[0] === `🎬 ${SHOW} S05E08–E09 — 2 of season 5 — added to the queue`, `"${h.notes()[0]}"`);
  ok(h.jobs[0]?.groupLabel === `${SHOW} S05E08–E09` && h.journal()[0]?.label === `${SHOW} S05E08–E09 — 2 of season 5`,
    `the queue and the journal: "${h.journal()[0]?.label}"`);
  ok(h.history()[0].detail.startsWith('S05E08–E09 — 2 of season 5 · 8 withheld (TV-MA): E1–E7, E10'), `History: "${h.history()[0].detail}"`);
  await finishAll(h);
  ok(h.notes().at(-1).startsWith(`✅ ${SHOW} S05E08–E09 — 2 of season 5 — all 2 episodes posted!`), `"${h.notes().at(-1)}"`);
}

console.log('=== the other ways part of a request is left out ===');
{
  // Episodes waiting already from another member's request are not queued
  // twice (tv-duplicate-request): this one is named by the rest.
  reset([], { tv14: true });
  const h = harness({ dup: 'on' });
  await ask(h, 'Outer Banks S05E04-E06', '15553334444');
  h.ctx.queue.pending.push(...h.jobs.splice(0).map((j) => ({ kind: 'tv', label: j.label, meta: j.meta })));
  await ask(h, 'Outer Banks S05E04-E10');
  ok(queued(h).join() === '7,8,9,10', `E04-E06 were waiting already, E07-E10 queued (${queued(h).join()})`);
  ok(h.notes().at(-1) === `🎬 ${SHOW} S05E07–E10 — 4 of E04–E10 — added to the queue (3 more already waiting)`, `"${h.notes().at(-1)}"`);
  ok(h.journal().at(-1)?.label === `${SHOW} S05E07–E10 — 4 of E04–E10` && h.history()[0].detail === 'S05E07–E10 — 4 of E04–E10',
    `the journal and History: "${h.history()[0].detail}"`);

  // A run the library has a hole in: E07 is not on the server.
  reset([], { tv14: true, gone: [7] });
  const hole = harness();
  await ask(hole, 'Outer Banks S05E04-E10');
  ok(queued(hole).join() === '4,5,6,8,9,10' && hole.notes()[0] === `🎬 ${SHOW} S05E04–E06, E08–E10 — 6 of E04–E10 — added to the queue`,
    `"${hole.notes()[0]}"`);

  // maxEpisodesPerRequest: the first three of the seven.
  reset([], { tv14: true });
  const capped = harness({ cap: 3 });
  await ask(capped, 'Outer Banks S05E04-E10');
  ok(queued(capped).join() === '4,5,6' && capped.journal()[0]?.label === `${SHOW} S05E04–E06 — 3 of E04–E10`,
    `three of the seven: "${capped.journal()[0]?.label}"`);
}

console.log('=== a request that queued all it asked for reads as it always did ===');
{
  reset([], { tv14: true });
  const range = harness();
  await ask(range, 'Outer Banks S05E04-E10');
  ok(queued(range).join() === '4,5,6,7,8,9,10', `the seven (${queued(range).join()})`);
  ok(range.notes()[0] === `🎬 ${SHOW} S05E04–E10 — 7 episode(s) — added to the queue`, `the "added" line: "${range.notes()[0]}"`);
  ok(range.jobs[0]?.groupLabel === `${SHOW} S05E04–E10` && range.journal()[0]?.label === `${SHOW} S05E04–E10 — 7 episode(s)`,
    `the queue and the journal: "${range.journal()[0]?.label}"`);
  ok(range.history()[0].detail === 'S05E04–E10 — 7 episode(s)', `History: "${range.history()[0].detail}"`);
  await finishAll(range);
  ok(range.notes().at(-1) === `✅ ${SHOW} S05E04–E10 — 7 episode(s) — all 7 episodes posted! Check the posts group`, `"${range.notes().at(-1)}"`);

  // Typed past the season's end: named by the span the server holds, as before.
  reset([], { tv14: true });
  const past = harness();
  await ask(past, 'Outer Banks S05E04-E12');
  ok(past.journal()[0]?.label === `${SHOW} S05E04–E10 — 7 episode(s)`, `"S05E04-E12" of a ten-episode season: "${past.journal()[0]?.label}"`);

  // The whole run, cleared by the AI check.
  reset([4, 5, 6, 7, 8, 9, 10]);
  const allClear = harness();
  await ask(allClear, 'Outer Banks S05E04-E10');
  ok(allClear.notes()[0] === `🎬 ${SHOW} S05E04–E10 — 7 episode(s) — added to the queue`, `all seven cleared: "${allClear.notes()[0]}"`);

  reset([], { tv14: true });
  const season = harness();
  await ask(season, 'Outer Banks season 5');
  ok(queued(season).length === 10, 'the ten');
  ok(season.notes()[0] === `🎬 ${SHOW} season 5 — 10 episode(s) — added to the queue`, `the "added" line: "${season.notes()[0]}"`);
  ok(season.jobs[0]?.groupLabel === `${SHOW} season 5` && season.journal()[0]?.label === `${SHOW} season 5 — 10 episode(s)`,
    `the queue and the journal: "${season.journal()[0]?.label}"`);
  ok(season.history()[0].detail === 'season 5 — 10 episode(s)', `History: "${season.history()[0].detail}"`);
  await finishAll(season);
  ok(season.notes().at(-1) === `✅ ${SHOW} season 5 — 10 episode(s) — all 10 episodes posted! Check the posts group`, `"${season.notes().at(-1)}"`);

  reset([8]);
  const one = harness();
  await ask(one, 'Outer Banks S05E08');
  ok(queued(one).join() === '8' && one.journal()[0]?.label === `${SHOW} S05E08`, `one episode is its own name: "${one.journal()[0]?.label}"`);
}

console.log('=== the panel\'s manual queue names it the same way ===');
{
  reset([8, 9]);
  const h = harness();
  const r = await plugin.requeue('Outer Banks S05E04-E10', h.ctx);
  ok(r.queued === 2 && r.scope === 'S05E08–E09', `"Queued 2 episodes — ${SHOW} ${r.scope}"`);
  ok(h.history()[0].detail.startsWith('S05E08–E09 — 2 of E04–E10 · 5 withheld (TV-MA): E4–E7, E10'), `History: "${h.history()[0].detail}"`);
  ok(h.journal()[0]?.label === `${SHOW} S05E08–E09` && h.jobs[0]?.groupLabel === `${SHOW} S05E08–E09`,
    `the journal and the queue: "${h.journal()[0]?.label}"`);
  await finishAll(h);
  ok(h.notes().at(-1) === `✅ ${SHOW} S05E08–E09 — all 2 episodes posted! Check the posts group`, `the finished notice: "${h.notes().at(-1)}"`);

  reset([], { tv14: true });
  const whole = harness();
  const w = await plugin.requeue('Outer Banks S05E04-E10', whole.ctx);
  ok(w.scope === 'S05E04–E10' && whole.history()[0].detail === 'S05E04–E10 — 7 episode(s)' && whole.journal()[0]?.label === `${SHOW} S05E04–E10`,
    `all of it, as before: "${whole.history()[0].detail}"`);
}

console.log('=== a restart keeps the name ===');
{
  reset([8, 9]);
  const before = harness();
  await ask(before, 'Outer Banks S05E04-E10');
  await plugin.teardown();
  plugin._live = new Map();
  // The next process: the same store, the real queue, empty and held still.
  const q = new JobQueue({ concurrency: 1, maxLength: 50 });
  q.pause();
  const after = harness({ tv: before.tv, queue: q });
  await plugin.recoverPending(after.ctx);
  ok(after.logs.some((l) => l.startsWith(`📺 resuming "${SHOW} S05E08–E09 — 2 of E04–E10" — 2 episode(s) after a restart`)),
    'resumed under its name');
  ok(q.pendingLabels().join() === `${SHOW} S05E08–E09`, `one request in the queue, named as before the restart: "${q.pendingLabels().join()}"`);

  // queue-status, which the hourly check asks before a restart: the request
  // and the episode in hand.
  const real = plugin.deliverEpisode;
  let release;
  const held = new Promise((r) => { release = r; });
  plugin.deliverEpisode = async ({ notifier }) => { await held; notifier?.episodeDone(); };
  try {
    q.resume();
    await until(() => q.snapshot().active.length > 0);
    const status = await runAdminCommand({ op: 'queue-status' }, { queue: q });
    ok(status.media.running.join() === `${SHOW} S05E08–E09 (${SHOW} S05E08)`, `queue-status: "${status.media.running.join()}"`);
    release();
    await until(() => after.notes().some((n) => n.startsWith('✅')));
  } finally { plugin.deliverEpisode = real; }
  ok(after.notes().at(-1) === `✅ ${SHOW} S05E08–E09 — 2 of E04–E10 — all 2 episodes posted! Check the posts group`,
    `and it finishes under it: "${after.notes().at(-1)}"`);
  ok(after.history()[0].detail.startsWith('2 episode(s) posted (resumed) · 5 withheld (TV-MA): E4–E7, E10'), `History: "${after.history()[0].detail}"`);
  await plugin.teardown();
  q.close();
}

console.log('=== a journal entry written before this loads and finishes as it was named ===');
{
  // The entry the live journal held for Aiden's request at 07:16 UTC on
  // 2026-10-12, when a restart resumed it.
  reset();
  plugin._live = new Map();
  const tv = store();
  const ep = (n) => ({ id: epId(n), series: SHOW, season: SEASON, episode: n, title: `Episode ${n}`, rating: 'TV-MA',
    localPath: `/tv/obx/s5/${n}.mkv`, size: 1000, container: 'mkv' });
  tv.set('history', [{ id: 'OLD1', kind: 'tv', status: 'queued', request: 'Outer Banks S05E04-E10', title: SHOW, season: SEASON, episodes: 2,
    detail: 'S05E04–E10 — 2 episode(s) · 5 withheld (TV-MA): E4–E7, E10', withheld: '5 withheld (TV-MA): E4–E7, E10' }]);
  tv.set('pending', [{
    reqKey: 'tv-OLD1-1760217608259', label: `${SHOW} S05E04–E10 — 2 episode(s)`, msgId: 'OLD1', msgKey: { id: 'OLD1' }, chatJid: TVREQ,
    requester: '+15551112222', requesterNumber: '15551112222',
    baseRow: { id: 'OLD1', kind: 'tv', status: 'queued', request: 'Outer Banks S05E04-E10', title: SHOW, season: SEASON, episodes: 2,
      withheld: '5 withheld (TV-MA): E4–E7, E10' },
    episodes: [ep(8), ep(9)],
  }]);
  const q = new JobQueue({ concurrency: 1, maxLength: 50 });
  q.pause();
  const h = harness({ tv, queue: q });
  await plugin.recoverPending(h.ctx);
  ok(q.pendingLabels().join() === `${SHOW} S05E04–E10`, `back in the queue as it always was: "${q.pendingLabels().join()}"`);
  const real = plugin.deliverEpisode;
  plugin.deliverEpisode = async ({ notifier }) => { notifier?.episodeDone(); };
  try {
    q.resume();
    await until(() => h.notes().some((n) => n.startsWith('✅')));
  } finally { plugin.deliverEpisode = real; }
  ok(h.notes().at(-1) === `✅ ${SHOW} S05E04–E10 — 2 episode(s) — all 2 episodes posted! Check the posts group`,
    `and it finishes: "${h.notes().at(-1)}"`);
  ok(h.history()[0].status === 'sent' && h.history()[0].detail === '2 episode(s) posted (resumed) · 5 withheld (TV-MA): E4–E7, E10',
    `and its row says so: "${h.history()[0].status}: ${h.history()[0].detail}"`);
  await plugin.teardown();
  q.close();
}

console.log('=== the queue\'s name for a journalled request, old and new ===');
{
  const ep = { series: SHOW, season: SEASON, episode: 8 };
  const named = (label) => plugin._groupOf({ reqKey: 'k', label }, ep).groupLabel;
  for (const [label, want] of [
    [`${SHOW} S05E08–E09 — 2 of E04–E10`, `${SHOW} S05E08–E09`],
    [`${SHOW} S05E04, E10 — 2 of E04–E10`, `${SHOW} S05E04, E10`],
    [`${SHOW} S05E08–E09 — 2 of season 5`, `${SHOW} S05E08–E09`],
    [`${SHOW} S05E04–E10 — 2 episode(s)`, `${SHOW} S05E04–E10`],          // journalled before 2026-10-12
    [`${SHOW} season 5 — 10 episode(s)`, `${SHOW} season 5`],
    [`${SHOW} S05E08–E09`, `${SHOW} S05E08–E09`],                         // the panel's, which has no count
    [`${SHOW} S05E08`, `${SHOW} S05E08`],
  ]) ok(named(label) === want, `"${label}" is "${named(label)}" in the queue`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
