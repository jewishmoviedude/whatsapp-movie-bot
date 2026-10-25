/* A TV requester is told when episodes are withheld on rating, and History says so.
   Run: node test/tv-rating-withheld.test.mjs

   Fullmetal Alchemist: Brotherhood (2009, TV-14) season 1 is 64 episodes, and
   14, 19 and 26 are rated TV-MA, which tvRequests.blockedRatings withholds.
   On 2026-09-27 the season was asked for: the log said "dropped 3 episode(s)
   ... on rating" at INFO, the requester was told "61 episode(s) - added to the
   queue", and History said "sent - 61 episode(s) posted". A member reported
   14, 19 and 26 as "did not go through". On 2026-09-28 they asked for S01E14
   on its own at 08:03 and 08:16 EDT and got a bare ⛔ each time, with no reply,
   no notification and no History row, then asked for the whole season again
   at 09:33, which posted the same 61 and left out the same 3 without a word.

   Which episodes are withheld is the owner's policy and is not changed here:
   these tests pin that the same ones are, and that it is now said.

   What a group member is told is behind the tv-rating-notice beta flag
   (CLAUDE.md, "beta first"): Off keeps the bare line and the bare ⛔, while
   History names the withheld episodes in every mode. Most cases below run
   with the flag On; the Off and Beta cases are pinned near the end.

   Since 2026-10-12 the bare line, the History row and the journal name the
   61 by their codes, "S01E01–E13, E15–E18, E20–E25, E27–E64 — 61 of season
   1": a request that queued part of what it asked for is named by what it
   queued, in every mode (test/tv-range-named-by-what-was-queued.test.mjs).
   The line with the notice keeps "season 1 — 61 of 64 episodes", which its
   sentence explains.

   Review found three more ways the words could mislead, pinned here too:
   "20 of 64 episodes added" when maxEpisodesPerRequest (or, since
   integration with the duplicate check, episodes waiting already) also cut
   the season, leaving 41 unexplained; "Episodes 14 are rated"
   and "2 withheld: E14" when the library holds two files of one episode; and
   E14 said to be both added and left out when one copy is TV-14 and the
   other TV-MA. */
import fs from 'node:fs';
import plugin from '../src/plugins/tv-requests/index.js';
import {
  describeWithheld, compactRuns, listProse, withheldFrom, RATING_NOTICE_FEATURE,
} from '../src/plugins/tv-requests/withheld.js';
import { FEATURES, featureMode } from '../src/core/beta.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const TVREQ = 'tvreq@g.us';
const NOTIFY = 'notify@g.us';
const POSTS = 'tvposts@g.us';
const BETA = '120363900000000013@g.us';

const FMA = 'Fullmetal Alchemist: Brotherhood';
const MA = new Set([14, 19, 26]);
const fmaEpisodes = (season = 1, n = 64, rated = (i) => (MA.has(i) ? 'TV-MA' : 'TV-14')) => ({
  Items: Array.from({ length: n }, (_, k) => ({
    Id: `E${season}-${k + 1}`, SeriesName: FMA, ParentIndexNumber: season, IndexNumber: k + 1,
    Name: `Episode ${k + 1}`, OfficialRating: rated(k + 1),
    MediaSources: [{ Path: `/tv/fma/${k + 1}.mkv`, Size: 1000, Container: 'mkv' }],
  })),
});

/** A Jellyfin that holds one show, answering the three calls a lookup makes. */
function jellyfin({ seriesRating = 'TV-14', episodes = fmaEpisodes(), name = FMA } = {}) {
  const series = { Items: [{ Id: 'SER1', Name: name, ProductionYear: 2009, OfficialRating: seriesRating, RecursiveItemCount: 64 }] };
  const seasons = { Items: [{ Id: 'S1', IndexNumber: 1, ChildCount: 64 }] };
  globalThis.fetch = async (url) => {
    const u = String(url);
    const json = (v) => ({ ok: true, status: 200, json: async () => v });
    if (u.includes('/Seasons')) return json(seasons);
    if (u.includes('/Episodes')) return json(episodes);
    if (u.includes('/Items') || u.includes('/Search/Hints')) return json(series);
    return { ok: false, status: 404, statusText: 'NF', json: async () => ({}) };
  };
}

/**
 * `feature` is the tv-rating-notice mode, `dup` the tv-duplicate-notice one
 * (the wording for episodes waiting already); `beta` replaces the whole beta
 * section.
 */
function harness({ notify = {}, replyOnBlock = false, beta = null, feature = 'on', dup = null, tv = {}, maxLength = 500, announceRated = true } = {}) {
  const texts = [], reacted = [], jobs = [];
  const store = new Map();
  const ctx = {
    config: {
      tvRequests: {
        enabled: true, requestGroups: [TVREQ], postsGroups: [POSTS], cooldownSecondsPerUser: 0,
        blockedRatings: ['TV-MA', 'R', 'NC-17', 'X'], ...tv,
      },
      movieRequests: {
        requestGroups: [], replyOnBlock, announceRated,
        reactions: { researching: '🔍', added: '🎬', rated: '⛔', notInLibrary: '📬', failed: '⚠️', done: '✅' },
        notify: { group: NOTIFY, ...notify },
      },
      beta: beta ?? {
        groups: [], postsGroup: '',
        features: { ...(feature ? { [RATING_NOTICE_FEATURE]: feature } : {}), ...(dup ? { 'tv-duplicate-notice': dup } : {}) },
      },
      library: { jellyfin: { baseUrl: 'http://jf:8096', accessToken: 'TOK', userId: 'U1' } },
      media: { workDir: '/tmp/tv-rating-withheld' },
    },
    bot: {
      isConnected: () => true,
      react: async (m, e) => { reacted.push(e); },
      sendText: async (jid, body, opts = {}) => { texts.push({ jid, body, quoted: !!opts.quoted }); return { key: { id: 'X' } }; },
      isGroupAdmin: () => false,
      deleteMessage: async () => {},
      archiveChat: async () => {},
    },
    queue: {
      maxLength, pending: [],
      add: (j) => { jobs.push(j); return `job-${jobs.length}`; },
    },
    store: { get: (k, d) => (store.has(k) ? store.get(k) : d), set: (k, v) => store.set(k, v) },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  };
  const history = () => store.get('history') ?? [];
  return { ctx, texts, reacted, jobs, store, history };
}

let seq = 0;
const mkMsg = (text, chatJid = TVREQ) => ({
  id: `MSG${++seq}`, key: { id: `MSG${seq}` }, text, chatJid, isGroup: true, fromMe: false,
  messageType: 'conversation', senderJid: 'ari@lid', senderNumber: '15551112222',
  senderNumberDisplay: '+1 555 111 2222', pushName: 'Ari', timestamp: Date.now(),
});

/** Finish every queued episode without downloading anything: each reports done. */
async function finishAll(jobs) {
  const real = plugin.deliverEpisode;
  plugin.deliverEpisode = async ({ notifier }) => { notifier?.episodeDone(); };
  try { for (const j of jobs.splice(0)) await j.run({ id: 'j', progress() {}, isCancelled: () => false }); }
  finally { plugin.deliverEpisode = real; }
}
const settle = () => new Promise((r) => setTimeout(r, 10));   // TV notifications are fire-and-forget
const onNotify = (texts) => texts.filter((t) => t.jid === NOTIFY).map((t) => t.body);

const SENTENCE = "Episodes 14, 19 and 26 are rated TV-MA, which can't be posted, so they were left out.";
const DETAIL = '3 withheld (TV-MA): E14, E19, E26';
// The 61 of the 64 that are queued, as the request is named once queued.
const QUEUED = 'S01E01–E13, E15–E18, E20–E25, E27–E64 — 61 of season 1';

console.log('=== the words: episodes named, runs folded, ratings given ===');
{
  const ep = (n, rating) => ({ season: 1, episode: n, rating });
  const w = describeWithheld([ep(14, 'TV-MA'), ep(19, 'TV-MA'), ep(26, 'TV-MA')]);
  ok(w.sentence === SENTENCE, `the Fullmetal three, in a sentence: "${w.sentence}"`);
  ok(w.detail === DETAIL, `and for History: "${w.detail}"`);
  ok(w.count === 3 && w.ratings.join() === 'TV-MA', 'with the count and the rating');

  const one = describeWithheld([ep(14, 'TV-MA')]);
  ok(one.sentence === "Episode 14 is rated TV-MA, which can't be posted, so it was left out.", 'one episode reads as one');
  ok(one.detail === '1 withheld (TV-MA): E14', 'and in History');

  const many = describeWithheld([1, 2, 3, 4, 5, 9, 12, 13, 14, 20, 21].map((n) => ep(n, 'TV-MA')));
  ok(many.clauses === 'Episodes 1–5, 9, 12–14, 20 and 21 are rated TV-MA', `a long list is folded into ranges: "${many.clauses}"`);
  ok(many.detail === '11 withheld (TV-MA): E1–E5, E9, E12–E14, E20, E21', `in History too: "${many.detail}"`);

  const mixed = describeWithheld([ep(26, 'R'), ep(14, 'TV-MA'), ep(19, 'tv-ma')]);
  ok(mixed.clauses === 'Episodes 14 and 19 are rated TV-MA and episode 26 is rated R',
    `two ratings are each named with their own episodes: "${mixed.clauses}"`);
  ok(mixed.detail === '3 withheld on rating — TV-MA: E14, E19; R: E26', `"${mixed.detail}"`);

  ok(describeWithheld([]) === null && describeWithheld(undefined) === null, 'nothing withheld is null, so nothing is added to any message');
  ok(compactRuns([7, 8]).join() === '7,8', 'two in a row stay apart ("7 and 8", not "7–8")');
  ok(listProse(['a']) === 'a' && listProse(['a', 'b']) === 'a and b' && listProse(['a', 'b', 'c']) === 'a, b and c', 'lists read as prose');
}

console.log('=== a season with some episodes withheld: the requester is told which and why ===');
{
  jellyfin();
  const h = harness();
  await plugin.onMessage(mkMsg('Fullmetal alchemist:brotherhood season 1'), h.ctx);
  await settle();

  const queued = h.jobs.map((j) => j.meta.episode);
  ok(queued.length === 61, `61 episodes are queued, as before (${queued.length})`);
  ok(![14, 19, 26].some((n) => queued.includes(n)), 'and 14, 19 and 26 are still the ones left out - the policy is unchanged');

  const lines = onNotify(h.texts);
  const added = lines.find((l) => /added to the queue/.test(l));
  ok(added === `🎬 ${FMA} season 1 — 61 of 64 episodes added to the queue. ${SENTENCE}`,
    `the "added" line says 61 of 64 and names the three: "${added}"`);
  ok(lines.length === 1, 'in ONE message, not a second one after it');
  ok(!h.texts.some((t) => t.jid === TVREQ), 'nothing in the request group while replyOnBlock is off');
  ok(h.reacted.includes('🎬') && !h.reacted.includes('⛔'), 'the reaction is still 🎬 - the request was accepted');

  const row = h.history()[0];
  ok(row.status === 'queued' && row.detail === `${QUEUED} · ${DETAIL}`,
    `the queued History row says what was withheld: "${row.detail}"`);
  ok(row.withheld === DETAIL, 'and carries it as a field of its own');
  ok(row.episodes === 61, 'the episode count is what was queued');

  await finishAll(h.jobs);
  const done = h.history()[0];
  ok(done.status === 'sent' && done.detail === `61 episode(s) posted · ${DETAIL}`,
    `the final row no longer reads as the whole season: "${done.detail}"`);
  ok(h.history().length === 1, 'still one row for the request');

  // The journal carries the field, so a restart does not lose it.
  const pending = h.store.get('pending') ?? [];
  ok(pending[0]?.baseRow?.withheld === DETAIL, 'the journalled request carries it for a restart');
}

console.log('=== ...and with replyOnBlock on, in the request group as well ===');
{
  jellyfin();
  const h = harness({ replyOnBlock: true });
  const m = mkMsg('fullmetal alchemist brotherhood season 1');
  await plugin.onMessage(m, h.ctx);
  await settle();
  const reply = h.texts.find((t) => t.jid === TVREQ);
  ok(reply?.quoted && reply.body === `${FMA} season 1 — 61 of 64 episodes added to the queue. ${SENTENCE}`,
    `a quoted reply names them where the requester asked: "${reply?.body}"`);
}

console.log('=== one episode that is withheld: ⛔, the reason, and a History row ===');
{
  jellyfin();
  const h = harness();
  const m = mkMsg('fullmetal alchemist brotherhood S01E14');
  await plugin.onMessage(m, h.ctx);
  await settle();

  ok(h.jobs.length === 0, 'nothing is queued - it is still refused');
  ok(h.reacted.at(-1) === '⛔', 'the ⛔ reaction stays');
  const lines = onNotify(h.texts);
  ok(lines.length === 1 && lines[0] === `⛔ ${FMA} S01E14 — rated TV-MA, can't be posted`,
    `the reason goes where a refused film's does, in the film's words: "${lines[0]}"`);
  ok(!h.texts.some((t) => t.jid === TVREQ), 'no reply in the request group while replyOnBlock is off, as for a film');

  const row = h.history()[0];
  ok(row?.id === m.id && row?.kind === 'tv', 'a History row is written, where there was none');
  ok(row?.status === 'blocked-rating', 'with the status a film refused on rating gets, which the panel already labels');
  ok(row?.detail === 'S01E14 rated TV-MA' && row?.rated === 'TV-MA', `saying which and why: "${row?.detail}"`);
  ok(row?.title === FMA && row?.season === 1 && row?.episodes === 0, 'for the show and season, with nothing sent');
  ok(row?.request === 'fullmetal alchemist brotherhood S01E14' && row?.requester === 'Ari' && row?.groupJid === TVREQ,
    'naming the request, who asked, and where');
  ok(row?.withheld === '1 withheld (TV-MA): E14', 'and the withheld episode as a field');

  // Asked twice, as it was: two requests, two rows.
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood S01E14'), h.ctx);
  ok(h.history().filter((r) => r.status === 'blocked-rating').length === 2, 'asking again leaves a second row, not nothing');
}

console.log('=== ...with replyOnBlock on it is also answered in the request group, like a film ===');
{
  jellyfin();
  const h = harness({ replyOnBlock: true });
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood S01E14'), h.ctx);
  await settle();
  const reply = h.texts.find((t) => t.jid === TVREQ);
  ok(reply?.quoted && reply.body === `${FMA} S01E14 is rated TV-MA.`, `the film's reply, for the episode: "${reply?.body}"`);
}

console.log('=== ...and the movie side\'s `blocked` switch silences the line, not the record ===');
{
  jellyfin();
  const h = harness({ notify: { steps: { blocked: false } } });
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood S01E14'), h.ctx);
  await settle();
  ok(onNotify(h.texts).length === 0, 'no ⛔ line when blocked notifications are switched off - no chattier than movies');
  ok(h.reacted.at(-1) === '⛔' && h.history()[0]?.status === 'blocked-rating', 'the reaction and the History row stay');

  // The switch is only asked by the refusal: every other TV line is sent as before.
  const h2 = harness({ notify: { steps: { blocked: false, queued: false } } });
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood season 1'), h2.ctx);
  await settle();
  ok(onNotify(h2.texts).some((l) => /added to the queue/.test(l)), 'the "added" line ignores the step switches, as it always has');
}

// The operator, 2026-10-21: a rated refusal is the reaction alone - "Rated R
// denies should not go in the queue group either". The cases here turn
// announceRated on to keep the wording tested; off is the default.
console.log('=== by default a withheld episode gets the ⛔ alone: no reply, no notifications line ===');
{
  jellyfin();
  const h = harness({ replyOnBlock: true, announceRated: false });
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood S01E14'), h.ctx);
  await settle();
  ok(h.reacted.at(-1) === '⛔', 'the ⛔ reaction');
  ok(h.texts.length === 0, `no text anywhere: ${JSON.stringify(h.texts)}`);
  ok(h.history()[0]?.status === 'blocked-rating', 'and the History row');
}

console.log('=== a whole season withheld is refused with every episode named ===');
{
  jellyfin({ episodes: fmaEpisodes(1, 3, () => 'TV-MA') });
  const h = harness();
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood season 1'), h.ctx);
  await settle();
  ok(h.jobs.length === 0 && h.reacted.at(-1) === '⛔', 'nothing queued, ⛔');
  const lines = onNotify(h.texts);
  ok(lines[0] === `⛔ ${FMA} season 1 — episodes 1–3 are rated TV-MA, can't be posted`, `"${lines[0]}"`);
  const row = h.history()[0];
  ok(row?.status === 'blocked-rating' && row?.detail === 'season 1 — all 3 withheld (TV-MA): E1–E3', `History: "${row?.detail}"`);
}

console.log('=== a series rated as a whole is recorded too ===');
{
  jellyfin({ seriesRating: 'TV-MA', name: 'The Boys' });
  const h = harness({ replyOnBlock: true });
  await plugin.onMessage(mkMsg('The Boys season 1'), h.ctx);
  await settle();
  ok(h.jobs.length === 0 && h.reacted.at(-1) === '⛔', 'refused with ⛔, as before');
  ok(onNotify(h.texts)[0] === "⛔ The Boys (2009) — rated TV-MA, can't be posted", `the film's line: "${onNotify(h.texts)[0]}"`);
  ok(h.texts.find((t) => t.jid === TVREQ)?.body === 'The Boys (2009) is rated TV-MA.', 'and the film\'s reply, when it is on');
  const row = h.history()[0];
  ok(row?.status === 'blocked-rating' && row.detail === 'rated TV-MA' && row.rated === 'TV-MA',
    `a History row, where the series-level block wrote none: "${row?.detail}"`);
  ok(row && !('withheld' in row), 'no withheld-episodes field: the show itself is what is rated');
}

console.log('=== nothing withheld: every message exactly as before ===');
{
  jellyfin({ episodes: fmaEpisodes(1, 3, () => 'TV-14'), name: 'The Boys' });
  const h = harness({ replyOnBlock: true });
  await plugin.onMessage(mkMsg('The Boys season 1'), h.ctx);
  await settle();
  const lines = onNotify(h.texts);
  ok(lines.length === 1 && lines[0] === '🎬 The Boys season 1 — 3 episode(s) — added to the queue', `"${lines[0]}"`);
  ok(!h.texts.some((t) => t.jid === TVREQ), 'no reply in the request group, even with replyOnBlock on - nothing was refused');
  const row = h.history()[0];
  ok(row.detail === 'season 1 — 3 episode(s)' && !('withheld' in row), `the History row is unchanged: "${row.detail}"`);
  await finishAll(h.jobs);
  ok(h.history()[0].detail === '3 episode(s) posted', 'and so is the final one');

  // Unrated episodes were never withheld, and are not now.
  jellyfin({ episodes: fmaEpisodes(1, 3, () => null), name: 'The Boys' });
  const h2 = harness();
  await plugin.onMessage(mkMsg('The Boys season 1'), h2.ctx);
  ok(h2.jobs.length === 3, 'an episode with no rating is still sent, as before');
}

console.log('=== a beta test: the notice stays in the beta group, and nothing is queued ===');
{
  // Since 2026-09-29 a beta-group request is a test, started with its code,
  // that queues nothing and answers "✅ Test passed" with what a real request
  // would have been told (beta.js).
  const BETA_ON = { groups: [BETA], postsGroup: '', features: { [RATING_NOTICE_FEATURE]: 'beta' } };
  jellyfin();
  const h = harness({ beta: BETA_ON });
  await plugin.onMessage(mkMsg('$beta003 fullmetal alchemist brotherhood season 1', BETA), h.ctx);
  await settle();
  ok(h.jobs.length === 0, 'the test queues nothing');
  ok(!h.texts.some((t) => t.jid === NOTIFY), 'nothing reaches the main notifications group');
  const inBeta = h.texts.filter((t) => t.jid === BETA);
  ok(inBeta.length === 1 && inBeta[0].quoted && inBeta[0].body
    === `✅ *Test passed* ($beta003)\n\nThe bot would queue 61 episodes of *${FMA}* season 1.\nNothing was downloaded.\n\n${SENTENCE}`,
  `one quoted "Test passed", with the withheld sentence: "${inBeta[0]?.body}"`);
  ok(h.reacted.at(-1) === '✅', '✅ on the request');
  ok(h.history()[0].beta === true && h.history()[0].status === 'test-passed' && h.history()[0].withheld === DETAIL,
    'History marks the row a passed beta test, with the withheld episodes');

  const h2 = harness({ beta: BETA_ON });
  await plugin.onMessage(mkMsg('$beta003 fullmetal alchemist brotherhood S01E14', BETA), h2.ctx);
  await settle();
  ok(!h2.texts.some((t) => t.jid === NOTIFY), 'a beta refusal says nothing in the main notifications group');
  ok(h2.texts.some((t) => t.jid === BETA && t.body === `⛔ ${FMA} S01E14 — rated TV-MA, can't be posted`),
    'and says why in the beta group');
  ok(h2.history()[0]?.beta === true && h2.history()[0]?.status === 'blocked-rating', 'its History row is marked beta');

  const h3 = harness({ beta: BETA_ON });
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood season 1', BETA), h3.ctx);
  await settle();
  ok(!h3.texts.length && !h3.reacted.length && !h3.jobs.length && !h3.history().length,
    'with no code, the same request in the beta group is ignored');
}

console.log('=== the panel\'s manual queue names the withheld episodes the same way ===');
{
  jellyfin();
  const h = harness();
  h.ctx.queue.hasRoom = () => true;
  const r = await plugin.requeue('Fullmetal Alchemist Brotherhood season 1', h.ctx);
  ok(r.queued === 61 && r.withheld === 3, `61 queued, 3 withheld (${r.queued}, ${r.withheld})`);
  ok(r.withheldNote === SENTENCE, `the answer says which and why: "${r.withheldNote}"`);
  ok(!h.jobs.some((j) => MA.has(j.meta.episode)), 'and the same three stay out');
  const row = h.history()[0];
  ok(row.detail === `${QUEUED} · ${DETAIL}` && row.withheld === DETAIL, `its History row too: "${row.detail}"`);
  await finishAll(h.jobs);
  ok(h.history()[0].detail === `61 episode(s) posted · ${DETAIL}`, 'and its final row');

  let err = null;
  try { await plugin.requeue('Fullmetal Alchemist Brotherhood S01E14', harness().ctx); } catch (e) { err = e; }
  ok(err?.message === `${FMA} S01E14 is rated TV-MA (blocked)`, `a withheld episode is refused by name: "${err?.message}"`);

  jellyfin({ episodes: fmaEpisodes(1, 3, () => 'TV-MA') });
  err = null;
  try { await plugin.requeue('Fullmetal Alchemist Brotherhood season 1', harness().ctx); } catch (e) { err = e; }
  ok(err?.message === `Every episode of ${FMA} season 1 is blocked on rating: episodes 1–3 are rated TV-MA`,
    `a season with nothing left says which and why: "${err?.message}"`);

  jellyfin({ episodes: fmaEpisodes(1, 3, () => 'TV-14'), name: 'The Boys' });
  const clean = await plugin.requeue('The Boys season 1', harness().ctx);
  ok(!('withheld' in clean) && !('withheldNote' in clean), 'nothing withheld: the answer is exactly as before');

  const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  ok(/const queuedLabel = [\s\S]*?r\.withheldNote/.test(app), 'the panel\'s toast shows the note');
}

console.log('=== after a restart the final row still names them ===');
{
  jellyfin();
  const before = harness();
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood season 1'), before.ctx);
  const journal = before.store.get('pending');

  const after = harness();
  after.store.set('pending', journal);
  after.store.set('history', before.history());
  await plugin.recoverPending(after.ctx);
  ok(after.jobs.length === 61, 'the season is resumed');
  await finishAll(after.jobs);
  ok(after.history()[0].detail === `61 episode(s) posted (resumed) · ${DETAIL}`,
    `the resumed row keeps the withheld episodes: "${after.history()[0].detail}"`);
}

console.log('=== beta first: Off keeps the group text as it was, History still names the episodes ===');
{
  const f = FEATURES.find((x) => x.key === RATING_NOTICE_FEATURE);
  ok(f?.scope === 'tv' && f.label && f.description, 'the flag is registered for TV, with a label and a description');
  ok(featureMode({}, RATING_NOTICE_FEATURE) === 'off', 'and starts at Off, like every feature');

  // The FMA season, flag Off, replyOnBlock on: the line and the request group
  // are exactly as on origin/main.
  jellyfin();
  const h = harness({ feature: 'off', replyOnBlock: true });
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood season 1'), h.ctx);
  await settle();
  ok(h.jobs.length === 61, 'the same 61 are queued');
  const lines = onNotify(h.texts);
  ok(lines.length === 1 && lines[0] === `🎬 ${FMA} ${QUEUED} — added to the queue`,
    `Off: the "added" line is the bare one, naming the 61: "${lines[0]}"`);
  ok(!h.texts.some((t) => t.jid === TVREQ), 'Off: no reply in the request group, even with replyOnBlock on');
  ok(h.history()[0].detail === `${QUEUED} · ${DETAIL}` && h.history()[0].withheld === DETAIL,
    'Off: the History row still names the three - it is the owner\'s, not the group\'s');
  await finishAll(h.jobs);
  ok(h.history()[0].detail === `61 episode(s) posted · ${DETAIL}`, 'and the final row');

  // Asked again while it waits, flag Off: the duplicate answer as it is
  // without the notice (tv-duplicate-request), no sentence on the end.
  jellyfin();
  const h5 = harness({ feature: 'off', dup: 'on' });
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood season 1'), h5.ctx);
  h5.ctx.queue.pending.push(...h5.jobs.map((j) => ({ kind: 'tv', label: j.label, meta: j.meta })));
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood season 1'), h5.ctx);
  await settle();
  ok(onNotify(h5.texts).at(-1) === `🎬 ${FMA} season 1 — already in the queue, not added again`,
    `Off: the duplicate answer names nothing withheld: "${onNotify(h5.texts).at(-1)}"`);
  // Both notices Off: the line the request always got.
  jellyfin();
  const h6 = harness({ feature: 'off' });
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood season 1'), h6.ctx);
  h6.ctx.queue.pending.push(...h6.jobs.map((j) => ({ kind: 'tv', label: j.label, meta: j.meta })));
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood season 1'), h6.ctx);
  await settle();
  ok(onNotify(h6.texts).at(-1) === `🎬 ${FMA} ${QUEUED} — added to the queue` && h6.jobs.length === 61,
    `both Off: the bare line, and still nothing queued twice: "${onNotify(h6.texts).at(-1)}"`);

  // S01E14 alone, flag Off: a bare ⛔, as it was, and now a row.
  jellyfin();
  const h2 = harness({ feature: 'off', replyOnBlock: true });
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood S01E14'), h2.ctx);
  await settle();
  ok(h2.reacted.at(-1) === '⛔' && h2.jobs.length === 0, 'Off: S01E14 is still refused with ⛔');
  ok(h2.texts.length === 0, 'Off: with no line and no reply, as before');
  const row = h2.history()[0];
  ok(row?.status === 'blocked-rating' && row.detail === 'S01E14 rated TV-MA' && row.rated === 'TV-MA',
    `Off: but the refusal is recorded in History, where nothing was: "${row?.detail}"`);

  // A series rated as a whole, flag Off.
  jellyfin({ seriesRating: 'TV-MA', name: 'The Boys' });
  const h3 = harness({ feature: 'off', replyOnBlock: true });
  await plugin.onMessage(mkMsg('The Boys season 1'), h3.ctx);
  await settle();
  ok(h3.reacted.at(-1) === '⛔' && h3.texts.length === 0, 'Off: a rated series gets its bare ⛔');
  ok(h3.history()[0]?.status === 'blocked-rating' && h3.history()[0].detail === 'rated TV-MA', 'and a History row');

  // Beta: a main group is still Off, the beta group gets the words.
  const BETA_ON = { groups: [BETA], postsGroup: '', features: { [RATING_NOTICE_FEATURE]: 'beta' } };
  jellyfin();
  const h4 = harness({ beta: BETA_ON, replyOnBlock: true });
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood season 1'), h4.ctx);
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood S01E14'), h4.ctx);
  await settle();
  ok(onNotify(h4.texts).join('\n') === `🎬 ${FMA} ${QUEUED} — added to the queue`,
    'Beta: a MAIN group\'s request gets the bare line and no ⛔ line');
  ok(!h4.texts.some((t) => t.jid === TVREQ), 'Beta: and no reply in the main request group');
  ok(h4.history().length === 2 && h4.history().every((r) => !r.beta), 'both are recorded, as main requests');
}

console.log('=== "N of M" only when the rating filter is all that cut the season ===');
{
  // maxEpisodesPerRequest = 20: 20 queued of 61 allowed. "20 of 64" beside
  // three named episodes left 41 unexplained. Since 2026-10-12 a request the
  // limit cut says so (test/tv-cap-tells-the-member-the-rest.test.mjs): 20 of
  // the 61 it could send, and the limit - which, with the three named, is
  // all 64.
  jellyfin();
  const h = harness({ tv: { maxEpisodesPerRequest: 20 } });
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood season 1'), h.ctx);
  await settle();
  ok(h.jobs.length === 20, 'the cap still takes 20');
  const added = onNotify(h.texts).find((l) => /added to the queue/.test(l));
  ok(added === `🎬 ${FMA} season 1 — 20 of 61 episodes added to the queue; one request is at most 20 episodes. ${SENTENCE}`,
    `a capped season counts what it could send, and says what cut the rest: "${added}"`);
  ok(!/of 64/.test(added), 'no "of 64"');
  // The next part spans at most 20 episode numbers, E26 (withheld) one of
  // them - "S01E23-E42", not "S01E23-E43" - since a request the limit cuts
  // and one trimmed to it ask for the next part with one helper
  // (next-part.js): whatever a part takes in, it is never cut again.
  ok(h.history()[0].detail === `S01E01–E13, E15–E18, E20–E22 — 20 of season 1 · one request is at most 20; `
    + `not queued: E23–E25, E27–E64 (next: S01E23-E42) · ${DETAIL}`,
  `History: the 20 queued, what the limit left out, and the three: "${h.history()[0].detail}"`);

  // Five of it already in the queue from an earlier request, which are not
  // queued twice (tv-duplicate-request): the line says how many are waiting
  // already, and claims no total. (A nearly full queue no longer cuts a
  // season: it is one place in the queue, and goes in whole or not at all.)
  jellyfin();
  const h2 = harness({ dup: 'on' });
  const earlier = [1, 2, 3, 4, 5].map((n) => ({ id: `E1-${n}`, series: FMA, season: 1, episode: n }));
  plugin._journalAdd(h2.ctx, { reqKey: 'tv-earlier', label: `${FMA} season 1 — 5 episode(s)`, episodes: earlier });
  h2.ctx.queue.pending.push(...earlier.map((e) => ({ kind: 'tv', label: `E${e.episode}`, meta: { kind: 'tv', ...e } })));
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood season 1'), h2.ctx);
  await settle();
  const lines = onNotify(h2.texts);
  ok(h2.jobs.length === 56, `the other 56 are queued (${h2.jobs.length})`);
  ok(lines[0] === `🎬 ${FMA} season 1 — 56 episode(s) added to the queue (5 more already waiting). ${SENTENCE}`,
    `a season partly waiting already does not claim a total either: "${lines[0]}"`);
  ok(lines.length === 1, 'and that one line says it all');

  // All of it already in the queue: asked again, as the member did at 09:33,
  // the answer still names the three the rating filter leaves out.
  jellyfin();
  const h4 = harness({ dup: 'on' });
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood season 1'), h4.ctx);
  h4.ctx.queue.pending.push(...h4.jobs.map((j) => ({ kind: 'tv', label: j.label, meta: j.meta })));
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood season 1'), h4.ctx);
  await settle();
  const again = onNotify(h4.texts).at(-1);
  ok(again === `🎬 ${FMA} season 1 — already in the queue, not added again. ${SENTENCE}`,
    `asked again, it is already in the queue - and the three are named: "${again}"`);
  // Ari's own request, asked again: since 2026-10-11 a 'resent' row, not a
  // duplicate (test/no-redo-reaction.test.mjs) - and it names them as well.
  const dup = h4.history().find((r) => r.status === 'resent');
  ok(dup?.withheld === DETAIL && dup.detail.endsWith(` · ${DETAIL}`), `History's row for the request asked again names them too: "${dup?.detail}"`);

  // Nothing but the rating filter: 61 + 3 = 64.
  jellyfin();
  const h3 = harness({ tv: { maxEpisodesPerRequest: 64 } });
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood season 1'), h3.ctx);
  await settle();
  ok(onNotify(h3.texts)[0] === `🎬 ${FMA} season 1 — 61 of 64 episodes added to the queue. ${SENTENCE}`,
    'a cap the season fits under still reads "61 of 64"');
}

console.log('=== two files of one episode count as one episode ===');
{
  const ep = (n, rating, id = `e${n}`) => ({ id, season: 1, episode: n, rating });
  const twice = describeWithheld([ep(14, 'TV-MA'), ep(14, 'TV-MA', 'dup')]);
  ok(twice.count === 1 && twice.clauses === 'Episode 14 is rated TV-MA', `not "Episodes 14 are": "${twice.clauses}"`);
  ok(twice.detail === '1 withheld (TV-MA): E14', `not "2 withheld: E14": "${twice.detail}"`);
  ok(withheldFrom([ep(14, 'TV-MA')], [ep(14, 'TV-14', 'dup')]).length === 0, 'an episode that went out as another copy is not withheld');
  ok(withheldFrom([ep(14, 'TV-MA')], [ep(15, 'TV-14')]).length === 1, 'one that did not, is');
  const special = (title, rating) => ({ id: title, season: 1, episode: null, title, rating });
  ok(withheldFrom([special('Special A', 'TV-MA')], [special('Special B', 'TV-14')]).length === 1,
    'an episode with no number is never mistaken for another');
  ok(describeWithheld([special('Special A', 'TV-MA'), special('Special B', 'TV-MA')]).count === 2,
    'and two of them are two episodes');

  const dup = (rating) => {
    const eps = fmaEpisodes();
    eps.Items.push({ Id: 'dup14', SeriesName: FMA, ParentIndexNumber: 1, IndexNumber: 14, Name: 'Episode 14 (alt)',
      OfficialRating: rating, MediaSources: [{ Path: '/tv/fma-alt/14.mkv', Size: 1000, Container: 'mkv' }] });
    return eps;
  };

  // Both copies TV-MA: still S01E14, not "season 1 — episodes 14 are".
  jellyfin({ episodes: dup('TV-MA') });
  const h = harness();
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood S01E14'), h.ctx);
  await settle();
  ok(h.jobs.length === 0 && h.reacted.at(-1) === '⛔', 'refused, ⛔');
  ok(onNotify(h.texts)[0] === `⛔ ${FMA} S01E14 — rated TV-MA, can't be posted`, `named as the episode: "${onNotify(h.texts)[0]}"`);
  const row = h.history()[0];
  ok(row?.detail === 'S01E14 rated TV-MA' && row.withheld === '1 withheld (TV-MA): E14', `History: "${row?.detail}"`);

  // One copy TV-14, one TV-MA: the TV-14 one goes, and nothing is said to be left out.
  jellyfin({ episodes: dup('TV-14') });
  const h2 = harness();
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood S01E14'), h2.ctx);
  await settle();
  ok(h2.jobs.length === 1 && h2.jobs[0].meta.episode === 14, 'the TV-14 copy is queued, as before');
  const lines = onNotify(h2.texts);
  ok(lines.length === 1 && lines[0].endsWith('— added to the queue') && !/left out/.test(lines[0]),
    `and E14 is not also called left out: "${lines[0]}"`);
  ok(!('withheld' in h2.history()[0]), 'History does not call it withheld');

  // The season with a second TV-MA E14: still three withheld.
  jellyfin({ episodes: dup('TV-MA') });
  const h3 = harness();
  await plugin.onMessage(mkMsg('fullmetal alchemist brotherhood season 1'), h3.ctx);
  await settle();
  ok(h3.jobs.length === 61, '61 queued');
  ok(onNotify(h3.texts)[0] === `🎬 ${FMA} season 1 — 61 of 64 episodes added to the queue. ${SENTENCE}`,
    `three episodes withheld, not four items: "${onNotify(h3.texts)[0]}"`);
  ok(h3.history()[0].withheld === DETAIL, 'History says 3');

  // The panel's manual queue, both copies TV-MA.
  jellyfin({ episodes: dup('TV-MA') });
  let err = null;
  try { await plugin.requeue('Fullmetal Alchemist Brotherhood S01E14', harness().ctx); } catch (e) { err = e; }
  ok(err?.message === `${FMA} S01E14 is rated TV-MA (blocked)`, `the manual queue names the episode too: "${err?.message}"`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
