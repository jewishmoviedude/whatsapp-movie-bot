/* The AI check on TV episodes and the TV duplicate check, together.
   Run: node test/tv-override-duplicate.test.mjs

   Two branches met here. One put a rating-blocked episode to the AI content
   check and queued it only on a confirmed "no nudity"; the other stopped a
   request queueing episodes that are already waiting (Loki season 1, asked
   for twice on 2026-09-28) and counts a season as one place in the queue.

   Since the operator's decisions of 2026-09-29 an episode on the bypass list
   is sent with no AI check ("Send it, no AI check"), and the check is asked
   only about an episode its rating blocks that it could clear ("No, AI only
   helps"). The machinery below is that check's, so it is pinned with the
   check clearing TV-MA episodes nobody listed; a listed season asks nothing
   at all.

   Pinned here:
    - the check runs only on episodes this request will really queue: one an
      earlier request already holds in the queue is neither asked about again
      nor queued again, and counts as "already waiting", never as withheld;
    - episodes another request queued while the checks ran are left out, and
      one skipped as waiting stays out even if it finished meanwhile - it was
      never checked for this request; but an episode the rating never blocked
      whose request was cancelled meanwhile is queued, not called "already
      waiting" with nobody left to post it;
    - the "added to the queue" line composes the queued episodes, the rating
      and AI-check sentences (tv-rating-notice) and "(N more already
      waiting)" (tv-duplicate-notice), each on its own flag;
    - the panel's manual queue refuses a duplicate the same way, asking
      nothing;
    - a restart resumes a cleared episode from the journal without asking
      the check again, and the kept answer spares a repeat request the call;
    - a listed season asked for twice asks nothing either time, and the
      second is a duplicate with nothing said about the list.
   Network: Jellyfin and Gemini are a stubbed fetch. */
import plugin from '../src/plugins/tv-requests/index.js';
import { JobQueue } from '../src/core/queue.js';
import { addOverride } from '../src/core/rating-overrides.js';
import { LIMITS, resetPacing, CACHE_KEY } from '../src/plugins/tv-requests/override-check.js';
import { RATING_NOTICE_FEATURE } from '../src/plugins/tv-requests/withheld.js';
import { resetBreakers } from '../src/core/ai-providers.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

LIMITS.paceMs = 0;

const TVREQ = 'tvreq@g.us';
const NOTIFY = 'notify@g.us';
const FMA = 'Fullmetal Alchemist: Brotherhood';
const SERIES_ID = 'a1'.repeat(16);
const SEASON_ID = 'b2'.repeat(16);
const epId = (n) => `e${String(n).padStart(3, '0')}`.padEnd(32, 'c');
const MA = new Set([14, 19, 26]);

let verdicts = {};
let aiCalls = [];
let aiDelay = 0;

const json = (v, status = 200) => ({
  ok: status < 400, status, statusText: status < 400 ? 'OK' : 'Error', headers: new Headers(),
  json: async () => v, text: async () => JSON.stringify(v),
});

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('generativelanguage.googleapis.com')) {
    const prompt = JSON.parse(init.body).contents[0].parts[0].text;
    const code = prompt.match(/Episode: (S\d\dE\d\d)/)?.[1];
    aiCalls.push(code);
    if (aiDelay) await tick(aiDelay);
    const v = verdicts[code] ?? { nudity: false, confidence: 0.9, basis: 'violence, no nudity' };
    return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(v) }] }, finishReason: 'STOP' }] });
  }
  const p = new URL(u);
  if (p.pathname.endsWith('/Seasons')) return json({ Items: [{ Id: SEASON_ID, IndexNumber: 1, ChildCount: 64 }] });
  if (p.pathname.endsWith('/Episodes')) {
    return json({
      Items: Array.from({ length: 64 }, (_, k) => ({
        Id: epId(k + 1), SeriesName: FMA, SeriesId: SERIES_ID, SeasonId: SEASON_ID,
        ParentIndexNumber: 1, IndexNumber: k + 1, Name: `Episode ${k + 1}`,
        OfficialRating: MA.has(k + 1) ? 'TV-MA' : 'TV-14',
        MediaSources: [{ Path: `/tv/fma/${k + 1}.mkv`, Size: 1000, Container: 'mkv' }],
      })),
    });
  }
  if (p.pathname === '/Items' && p.searchParams.get('Ids')) {
    const ids = p.searchParams.get('Ids').split(',');
    return json({ Items: ids.map((id) => ({ Id: id, Type: 'Episode', Name: 'x', SeriesName: FMA, ParentIndexNumber: 1, IndexNumber: Number(id.slice(1, 4)) })) });
  }
  if (p.pathname === '/Items' || p.pathname === '/Search/Hints') {
    return json({
      Items: [{ Id: SERIES_ID, Name: FMA, ProductionYear: 2009, OfficialRating: 'TV-14', RecursiveItemCount: 64, ProviderIds: { Imdb: 'tt1355642' } }],
      SearchHints: [],
    });
  }
  return json({}, 404);
};

function store(init = {}) {
  const d = { ...init };
  return { _d: d, get: (k, v) => (k in d ? d[k] : v), set: (k, v) => { d[k] = v; } };
}

function harness({ notice = 'on', dup = 'on', entry = null } = {}) {
  verdicts = {}; aiCalls = []; aiDelay = 0;
  resetBreakers(); resetPacing();
  const notes = [], reacted = [];
  const tv = store();
  const ov = store();
  if (entry) addOverride(ov, entry, { addedBy: 'owner' });
  const q = new JobQueue({ concurrency: 1, maxLength: 50 });
  q.pause();
  const features = {};
  if (notice) features[RATING_NOTICE_FEATURE] = notice;
  if (dup) features['tv-duplicate-notice'] = dup;
  const ctx = {
    config: {
      tvRequests: {
        enabled: true, requestGroups: [TVREQ], postsGroups: ['tvposts@g.us'], cooldownSecondsPerUser: 0,
        blockedRatings: ['TV-MA', 'R', 'NC-17', 'X'],
      },
      movieRequests: {
        requestGroups: [],
        reactions: { researching: '🔍', added: '🎬', rated: '⛔', notInLibrary: '📬', failed: '⚠️', done: '✅', redo: '🔄' },
        notify: { group: NOTIFY },
      },
      beta: { groups: [], postsGroup: '', features },
      library: { jellyfin: { baseUrl: 'http://jf:8096', accessToken: 'TOK', userId: 'U1' } },
      // The AI check may clear a rated episode: the operator's switch, on on
      // the live bot.
      gemini: { enabled: true, contentCheck: true, apiKey: 'GEMINI-KEY-123', model: 'gemini-test', minContentConfidence: 0.7,
        allowCleanRatedFilms: true },
      media: { workDir: '/tmp/tv-override-duplicate' },
    },
    bot: {
      isConnected: () => true,
      react: async (m, e) => { reacted.push(`${m.id} ${e}`); },
      sendText: async (jid, body) => { if (jid === NOTIFY) notes.push(body); return { key: { id: 'X' } }; },
      isGroupAdmin: () => false,
      deleteMessage: async () => {},
      archiveChat: async () => {},
      groupMemberInfo: () => ({ isMember: false }),
    },
    queue: q,
    store: tv,
    overrideStore: ov,
    log: { info() {}, warn() {}, error() {}, debug() {} },
  };
  return { ctx, q, tv, notes, reacted, history: () => tv.get('history', []) };
}

let seq = 0;
const mkMsg = (text, sender = '15551112222') => ({
  text, chatJid: TVREQ, isGroup: true, fromMe: false, messageType: 'conversation',
  senderJid: `${sender}@s.whatsapp.net`, senderNumber: sender, senderNumberDisplay: `+${sender}`,
  pushName: 'Ari', id: `MSG${++seq}`, key: { remoteJid: TVREQ, id: `MSG${seq}`, fromMe: false }, timestamp: Date.now(),
});
const eps = (q) => q.pending.filter((e) => e.kind === 'tv').map((e) => e.meta.episode);
const count = (q, n) => eps(q).filter((e) => e === n).length;
const forget = (tv) => tv.set(CACHE_KEY, {});      // no kept answers: any call would show

console.log('=== the season asked for twice: the second asks the check nothing ===');
{
  const h = harness();
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood season 1'), h.ctx);
  ok(eps(h.q).length === 64 && aiCalls.join() === 'S01E14,S01E19,S01E26',
    `the first request checks the three TV-MA episodes and queues all 64 (${eps(h.q).length}; ${aiCalls.join()})`);

  forget(h.tv);
  aiCalls = [];
  const again = mkMsg('fullmetal alchemist brotherhood season 1', '15553334444');
  await plugin.onMessage(again, h.ctx);
  ok(aiCalls.length === 0, `the second, with no kept answers, asks nothing: they are all waiting (${aiCalls.join()})`);
  ok(eps(h.q).length === 64, `and queues nothing more (${eps(h.q).length})`);
  ok(h.notes.at(-1) === `🎬 ${FMA} season 1 — already in the queue, not added again`,
    `it is a duplicate, and nothing is called withheld: "${h.notes.at(-1)}"`);
  const row = h.history().find((r) => r.id === again.id);
  ok(row?.status === 'duplicate' && /64 episode\(s\) waiting/.test(row.detail) && !row.withheld && !row.override,
    `History: duplicate, 64 waiting, no withheld or override part ("${row?.detail}")`);
  await plugin.teardown();
}

console.log('=== an episode the check cleared waiting already, then the season ===');
{
  const h = harness();
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood S01E14'), h.ctx);
  ok(eps(h.q).join() === '14' && aiCalls.join() === 'S01E14', 'S01E14 on its own: checked once, queued');

  forget(h.tv);
  aiCalls = [];
  verdicts.S01E19 = { nudity: true, confidence: 0.95, basis: 'nudity in a flashback' };
  const season = mkMsg('fullmetal alchemist brotherhood season 1', '15553334444');
  await plugin.onMessage(season, h.ctx);
  ok(aiCalls.join() === 'S01E19,S01E26', `the season asks about E19 and E26 only, not the waiting E14 (${aiCalls.join()})`);
  ok(count(h.q, 14) === 1 && count(h.q, 19) === 0 && count(h.q, 26) === 1 && eps(h.q).length === 63,
    `E14 once, E19 withheld on its rating, E26 cleared: 63 in the queue (${eps(h.q).length})`);
  const line = h.notes.at(-1);
  ok(line === `🎬 ${FMA} season 1 — 62 episode(s) added to the queue (1 more already waiting). `
    + "Episode 19 is rated TV-MA, which can't be posted, so it was left out. "
    + 'Episode 26 is rated TV-MA, but the content check found no nudity, so it was included.',
  `one line: the queued, the waiting suffix before the stop, then the rating and check sentences: "${line}"`);
  const row = h.history().find((r) => r.id === season.id);
  ok(row?.episodes === 62 && /1 sent: rated, but no nudity \(Gemini\): E26/.test(row.detail)
    && /1 not cleared by the AI check \(Gemini said nudity\), withheld on its rating: E19/.test(row.detail) && !/E14/.test(row.override ?? ''),
  `History names what the check did for this request, and not E14 ("${row?.detail}")`);
  await plugin.teardown();
}

console.log('=== each part of the line keeps its own flag ===');
{
  // tv-duplicate-notice Off: the line the whole request would have got,
  // with the rating and check sentences still behind tv-rating-notice.
  let h = harness({ dup: null });
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood S01E14'), h.ctx);
  verdicts.S01E19 = { nudity: true, confidence: 0.95, basis: 'x' };
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood season 1', '15553334444'), h.ctx);
  ok(h.notes.at(-1) === `🎬 ${FMA} season 1 — 63 of 64 episodes added to the queue. `
    + "Episode 19 is rated TV-MA, which can't be posted, so it was left out. "
    + 'Episode 26 is rated TV-MA, but the content check found no nudity, so it was included.',
  `duplicate wording Off: no suffix, the whole request counted: "${h.notes.at(-1)}"`);
  ok(count(h.q, 14) === 1 && eps(h.q).length === 63, 'and still nothing queued twice');
  await plugin.teardown();

  // tv-rating-notice Off: the bare line, with the duplicate suffix - naming
  // the 62 it queued, since 2026-10-12 (tv-range-named-by-what-was-queued).
  h = harness({ notice: null });
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood S01E14'), h.ctx);
  verdicts.S01E19 = { nudity: true, confidence: 0.95, basis: 'x' };
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood season 1', '15553334444'), h.ctx);
  ok(h.notes.at(-1) === `🎬 ${FMA} S01E01–E13, E15–E18, E20–E64 — 62 of season 1 — added to the queue (1 more already waiting)`,
    `rating notice Off: no rating or check sentences: "${h.notes.at(-1)}"`);
  ok(h.history().some((r) => /1 not cleared by the AI check \(Gemini said nudity\), withheld on its rating: E19/.test(r.detail ?? '')),
    'History records it whatever the flags');
  await plugin.teardown();

  // Both Off: exactly the line from before either branch.
  h = harness({ notice: null, dup: null });
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood S01E14'), h.ctx);
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood season 1', '15553334444'), h.ctx);
  ok(h.notes.at(-1) === `🎬 ${FMA} season 1 — 64 episode(s) — added to the queue`,
    `both Off: the old line, word for word: "${h.notes.at(-1)}"`);
  await plugin.teardown();
}

console.log('=== queued by another request while the checks ran ===');
{
  // The checks await the providers, so the duplicate check is read again
  // after them: the second of two requests at once finds the first's
  // episodes waiting, and is a duplicate, not a second copy of the season.
  const h = harness();
  aiDelay = 30;
  await Promise.all([
    plugin.onMessage(mkMsg('fullmetal alchemist brotherhood season 1'), h.ctx),
    plugin.onMessage(mkMsg('fullmetal alchemist brotherhood season 1', '15553334444'), h.ctx),
  ]);
  ok(eps(h.q).length === 64 && [14, 19, 26, 1, 64].every((n) => count(h.q, n) === 1),
    `one copy of the season (${eps(h.q).length} waiting)`);
  ok(aiCalls.length === 3, `and each TV-MA episode asked about once, the second request using the first's answers (${aiCalls.join()})`);
  ok(h.notes.some((t) => /already in the queue, not added again/.test(t)), 'the second is answered as a duplicate');
  await plugin.teardown();
}

console.log('=== an episode skipped as waiting that finishes meanwhile stays out ===');
{
  // E14 is waiting when the season arrives, so the season does not ask
  // about it. If E14's job leaves the queue while the season's checks run,
  // a fresh read alone would call it new - and queue it without a check.
  const h = harness();
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood S01E14'), h.ctx);
  forget(h.tv);
  aiCalls = [];
  aiDelay = 30;
  const going = plugin.onMessage(mkMsg('fullmetal alchemist brotherhood season 1', '15553334444'), h.ctx);
  await tick(10);
  const row = h.q.snapshot().pending.find((r) => /S01E14/.test(r.label ?? ''));
  h.q.cancel(row?.id);                              // gone from the queue and the journal
  await going;
  ok(!aiCalls.includes('S01E14'), `E14 was never asked about by the season (${aiCalls.join()})`);
  ok(count(h.q, 14) === 0 && eps(h.q).length === 63, `and is not queued by it unchecked (${eps(h.q).length} waiting)`);
  await plugin.teardown();
}

console.log('=== an episode the rating never blocked, whose request ends while the checks run, is queued ===');
{
  // E05 (TV-14) is waiting for an earlier request when the season arrives.
  // That request is cancelled while the season's checks of E14/E19/E26 run:
  // nobody holds E05 any more, so the season queues it - as it would have
  // with nothing to check, when nothing awaited between the duplicate check
  // and the adds. It used to keep the first read too, call E05 "already
  // waiting", and leave it with nobody to post it.
  const h = harness();
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood S01E05'), h.ctx);
  ok(eps(h.q).join() === '5' && (h.tv.get('pending') ?? []).length === 1, 'E05 is queued and journalled by the first request');
  aiDelay = 30;
  const going = plugin.onMessage(mkMsg('fullmetal alchemist brotherhood season 1', '15553334444'), h.ctx);
  await tick(10);
  h.q.cancel(h.q.snapshot().pending.find((r) => /S01E05/.test(r.label ?? ''))?.id);
  ok(count(h.q, 5) === 0 && !(h.tv.get('pending') ?? []).length, 'cancelled while the checks run: gone from the queue and the journal');
  await going;
  ok(aiCalls.join() === 'S01E14,S01E19,S01E26', `the season checks the three TV-MA episodes (${aiCalls.join()})`);
  ok(count(h.q, 5) === 1 && eps(h.q).length === 64, `and queues E05 with the rest: 64 (${eps(h.q).length})`);
  ok(h.notes.at(-1)?.startsWith(`🎬 ${FMA} season 1 — 64 episode(s) added to the queue. `),
    `nothing is called already waiting: "${h.notes.at(-1)}"`);
  await plugin.teardown();

  // The panel's manual queue, the same way round.
  const h2 = harness();
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood S01E05'), h2.ctx);
  aiDelay = 30;
  const manual = plugin.requeue('Fullmetal Alchemist Brotherhood season 1', h2.ctx);
  await tick(10);
  h2.q.cancel(h2.q.snapshot().pending.find((r) => /S01E05/.test(r.label ?? ''))?.id);
  const r = await manual;
  ok(r.queued === 64 && count(h2.q, 5) === 1, `the panel's Re-run queues E05 too (${r.queued})`);
  await plugin.teardown();
}

console.log('=== the panel\'s manual queue: a duplicate is refused, asking nothing ===');
{
  const h = harness();
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood season 1'), h.ctx);
  forget(h.tv);
  aiCalls = [];
  let err = null;
  await plugin.requeue('Fullmetal Alchemist Brotherhood season 1', h.ctx).catch((e) => { err = e; });
  ok(err?.code === 'DUPLICATE' && aiCalls.length === 0, `DUPLICATE, and no check spent (${err?.message}; ${aiCalls.length} calls)`);
  await plugin.teardown();

  const h2 = harness();
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood S01E14'), h2.ctx);
  forget(h2.tv);
  aiCalls = [];
  const r = await plugin.requeue('Fullmetal Alchemist Brotherhood season 1', h2.ctx);
  ok(r.queued === 63 && aiCalls.join() === 'S01E19,S01E26' && count(h2.q, 14) === 1,
    `an overlap queues the rest, checking E19 and E26 only (${r.queued}; ${aiCalls.join()})`);
  await plugin.teardown();
}

console.log('=== a restart resumes a cleared episode without asking again ===');
{
  const h = harness();
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood S01E14'), h.ctx);
  const journalled = (h.tv.get('pending') ?? [])[0]?.episodes?.map((e) => e.episode) ?? [];
  ok(journalled.join() === '14', `S01E14 is journalled (${journalled.join()})`);
  await plugin.teardown();

  // The next process: a fresh queue, the same store, no kept answers.
  forget(h.tv);
  aiCalls = [];
  const q2 = new JobQueue({ concurrency: 1, maxLength: 50 });
  q2.pause();
  const ctx2 = { ...h.ctx, queue: q2 };
  await plugin.recoverPending(ctx2);
  await tick(20);
  ok(count(q2, 14) === 1, `S01E14 is back in the queue (${eps(q2).join()})`);
  ok(aiCalls.length === 0, `and the check is not asked again - it cleared it when it was queued (${aiCalls.join()})`);
  await plugin.teardown();

  // A repeat request later is spared the call by the kept answer.
  const h3 = harness();
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood S01E14'), h3.ctx);
  const first = aiCalls.length;
  h3.q.cancel(h3.q.snapshot().pending[0]?.id);
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood S01E14', '15553334444'), h3.ctx);
  ok(first === 1 && aiCalls.length === 1 && count(h3.q, 14) === 1, `asked for again: queued on the kept answer, no second call (${aiCalls.length})`);
  await plugin.teardown();
}

console.log('=== the source keeps the order ===');
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/plugins/tv-requests/index.js', import.meta.url), 'utf8');
  const intake = src.slice(src.indexOf('// Rating gate, mirroring the movie rules.'), src.indexOf('const accepted = [];'));
  // Read for `waitingFor`: the request's route, or none for a beta test,
  // which is judged against the real queue (2026-09-29, beta.js).
  const firstWaiting = intake.indexOf('this._waitingEpisodeIds(ctx, waitingFor)');
  const screening = intake.indexOf('await this._screenRated(');
  const reread = intake.indexOf('this._waitingEpisodeIds(ctx, waitingFor)', screening);
  ok(firstWaiting > 0 && firstWaiting < screening && reread > screening,
    'what is waiting is read before the checks, and read again after them');
  ok(/waiting,\s*\n?\s*limit:/.test(intake.slice(screening, screening + 300)), 'and the checks are told it');
  ok(!/\n    await /.test(intake.slice(reread, intake.indexOf('if (!queueing.length)'))),
    'nothing is awaited from the second read to the queue-room answer');
  ok(/const waitingNow = this\._waitingEpisodeIds\(ctx, waitingFor\);\s*\n\s*for \(const \{ ep \} of screen\?\.waiting \?\? \[\]\) waitingNow\.add/.test(intake)
    && !/waiting\.add\(id\)/.test(src), 'after the checks, what is waiting now decides, plus only what the checks skipped as waiting');
  const retry = src.slice(src.indexOf('_retryEpisodeLater(ctx'), src.indexOf('_noteWaitingForDisk('));
  const recover = src.slice(src.indexOf('async recoverPending'), src.indexOf('_retryEpisodeLater(ctx'));
  ok(!/_screenRated|screenRated/.test(retry + recover), 'retries and recovery re-queue what was checked; they do not screen again');
}

console.log('=== a listed season asked for twice: nothing is asked either time ===');
{
  const h = harness({ entry: FMA });
  verdicts.S01E19 = { nudity: true, confidence: 0.95, basis: 'x' };
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood season 1'), h.ctx);
  ok(eps(h.q).length === 64 && aiCalls.length === 0, `the first queues all 64, nothing asked (${eps(h.q).length}; ${aiCalls.length})`);
  const again = mkMsg('fullmetal alchemist brotherhood season 1', '15553334444');
  await plugin.onMessage(again, h.ctx);
  ok(aiCalls.length === 0 && eps(h.q).length === 64, 'the second asks nothing and queues nothing more');
  ok(h.notes.at(-1) === `🎬 ${FMA} season 1 — already in the queue, not added again`,
    `a duplicate, with nothing said about the list - the request that holds them said it: "${h.notes.at(-1)}"`);
  const row = h.history().find((r) => r.id === again.id);
  ok(row?.status === 'duplicate' && !row.override, `History: duplicate, no list part ("${row?.detail}")`);
  await plugin.teardown();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
