/* A run of episodes is one request; several seasons are one request each, sharing the message.
   Run: node test/tv-multi-season.test.mjs

   An audit of the TV place-in-line code (2026-09-29) found three shapes of
   request the TV group was getting wrong. "The Office S01E01-E05" queued
   S01E01 and nothing else. "The Office S01 S02", "season 1 and 2" and
   "S01-S03" queued season 1 and nothing else. "The Office seasons 1-3" was
   read as a show called "The Office seasons 1-3", which is not in any
   library, and got 📬. Each dropped the rest without a word.

   Now a run of episodes is ONE request of exactly those episodes - one place
   in line, as a season is - and several seasons are one request per season,
   each with its own place, History row and notifications, and every gate
   (rating, duplicate, queue room, maxEpisodesPerRequest) applied to each.
   The message counts once against the cooldown.

   The seasons share the member's message, which carries one reaction. It
   speaks for the first of its seasons that has not finished - that season's
   place while it waits, its stages while it runs - and ends on the outcome
   of them all once every one has finished (shared-message.js). These run the
   real plugin against the real queue, with each episode's work replaced by a
   gate the test opens.

   A review of that change the same day found five more faults, pinned
   below. One message could ask for any number of seasons - "seasons 1-30"
   took thirty places in a queue of fifty and sent thirty "added" lines, for
   one cooldown - and maxEpisodesPerRequest held each season, not the
   message. A season refused on its rating, turned away by a full queue or
   past a limit, after another had been queued, had its ⛔ or ⚠️ dropped (the
   queued season spoke for the message) and the message ended ✅. A season
   an admin set aside whole ended the message on ❌, "cancelled". And a
   restart while the seasons were still being worked through lost the ones
   not yet reached without a word.

   Merging this with the AI check for TV-MA episodes (override-fixes, the
   same evening) met the two halves for the first time: each season screened
   its episodes as a request of its own, so the check's per-request limits -
   stop at the first check that cannot run, at most LIMITS.maxChecks, at
   most LIMITS.budgetMs - started afresh for every season. "The Boys seasons
   1-3", a TV-MA show with Gemini out of quota, made three failing calls, one
   per season, and recorded three failures; three seasons could make 90
   checks. A message now has one budget for all its seasons, from a group or
   typed into the panel, and at most ten checks, half of Gemini's free day. */
import plugin from '../src/plugins/tv-requests/index.js';
import { shareMessage } from '../src/plugins/tv-requests/shared-message.js';
import { JobQueue } from '../src/core/queue.js';
import { LIMITS, resetPacing } from '../src/plugins/tv-requests/override-check.js';
import { resetBreakers, resetModelCache } from '../src/core/ai-providers.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const settle = () => new Promise((r) => setTimeout(r, 5));

const TVREQ = 'tvreq@g.us';
const NOTIFY = 'notify@g.us';
const NUM = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const R = {
  researching: '🔍', added: '🎬', failed: '⚠️', cancelled: '❌', skipped: '⏭️', done: '✅', redo: '🔄', rated: '⛔',
  notInLibrary: '📬', duplicate: '🤥', downloading: '⬇️', tooFast: '🚫', positions: NUM, positionOverflow: '🔢',
};

console.log('=== the rule, on its own ===');
{
  const sent = [];
  const handed = [];
  const share = shareMessage({
    send: (e) => { sent.push(e); return Promise.resolve(true); },
    R: { failed: '⚠️', done: '✅', cancelled: '❌' },
    onHandover: (k) => { handed.push(k); return k === 'waiting'; },
  });
  const a = share.voice(); const b = share.voice(); const c = share.voice();
  a.react('⛔');
  ok(sent.join() === '⛔', 'before anything is queued, an answer about one season shows');
  b.join('first'); b.react('🎬');
  c.join('waiting'); c.react('🎬');
  a.react('📬');
  ok(sent.join(' ') === '⛔ 🎬', `once one is queued it speaks alone: the later ones' 🎬 and a refusal do not show (${sent.join(' ')})`);
  ok(share.owner() === 'first', 'the first queued speaks');
  b.react('⬇️'); c.react('⬇️');
  share.concluded('first', '✅');
  ok(handed.join() === 'waiting' && !sent.includes('✅'), 'when it finishes, the next shows its place - no ✅ yet');
  c.react('⚙️');
  share.concluded('waiting', '✅');
  ok(sent[sent.length - 1] === '✅', `and only when all have finished does the message end, on ✅ (${sent.join(' ')})`);

  const out = (endings) => {
    const s2 = []; const sh = shareMessage({ send: (e) => { s2.push(e); return Promise.resolve(true); }, R: { failed: '⚠️', done: '✅', cancelled: '❌' } });
    endings.forEach((_, i) => sh.voice().join(`k${i}`));
    endings.forEach((e, i) => sh.concluded(`k${i}`, e));
    return s2[s2.length - 1];
  };
  ok(out(['✅', '⚠️']) === '⚠️' && out(['⚠️', '✅']) === '⚠️', 'any season failing ends it on ⚠️, whichever finished last');
  ok(out(['✅', null]) === '❌', 'a season an admin cancelled ends it on ❌');
  ok(out(['✅', '✅', '✅']) === '✅', 'all sent is ✅');

  // A later season finishing first changes nothing on the message.
  const s3 = []; const sh = shareMessage({ send: (e) => { s3.push(e); return Promise.resolve(true); }, R: { failed: '⚠️', done: '✅', cancelled: '❌' } });
  const x = sh.voice(); const y = sh.voice(); x.join('x'); y.join('y');
  sh.concluded('y', '⚠️');
  ok(s3.length === 0 && sh.owner() === 'x', 'a season behind the one speaking can finish first without showing');
  sh.concluded('x', '✅');
  ok(s3.join() === '⚠️', 'and its failure still decides the ending');

  const r4 = []; const again = shareMessage({ send: (e) => { r4.push(e); return Promise.resolve(true); }, R: { failed: '⚠️', done: '✅', cancelled: '❌' }, before: ['⚠️'] });
  const z = again.voice(); z.join('z'); again.concluded('z', '✅');
  ok(r4.join() === '⚠️', 'how seasons ended before a restart counts too');

  // Seasons answered and never queued count as well, and a season set aside
  // whole is not a cancel (the review of 2026-09-29).
  const FULL = { failed: '⚠️', done: '✅', cancelled: '❌', skipped: '⏭️', rated: '⛔', notInLibrary: '📬' };
  const run = (endings, refusals = []) => {
    const got = []; const sh = shareMessage({ send: (e) => { got.push(e); return Promise.resolve(true); }, R: FULL });
    endings.forEach((_, i) => sh.voice().join(`k${i}`));
    sh.refused(...refusals);
    endings.forEach((e, i) => sh.concluded(`k${i}`, e));
    return got;
  };
  ok(run(['✅'], ['⛔']).at(-1) === '⛔', 'a season refused on its rating keeps the message off ✅: ⛔');
  ok(run(['✅'], ['📬']).at(-1) === '📬', 'one the server lacks: 📬');
  ok(run(['✅'], ['⛔', '📬', '⚠️']).at(-1) === '⚠️', 'one that could not be added (full, unreachable, past a limit): ⚠️, first of all');
  ok(run(['✅', null], ['⛔']).at(-1) === '❌', "an admin's cancel comes before a refusal");
  ok(run(['✅', '⏭️']).at(-1) === '✅' && run(['⏭️', '⏭️']).at(-1) === '⏭️',
    'a season set aside whole leaves the rest on ✅, and all of it set aside is ⏭️, not ❌');
  const late = []; const lt = shareMessage({ send: (e) => { late.push(e); return Promise.resolve(true); }, R: FULL });
  lt.voice().join('only'); lt.concluded('only', '✅'); lt.refused('⛔', '📬');
  ok(late.join(' ') === '✅ ⛔', `refused after every queued season had finished, the message ends again, once (${late.join(' ')})`);
}

// The Boys: seasons 1 and 2, three episodes each. Season 3 is not on the
// server. A test that needs more sets `onServer`; one that needs a season
// whose every episode is rated TV-MA (the series itself is TV-14) puts it in
// `ratedSeasons`.
const SERIES = { Items: [{ Id: 'SER1', Name: 'The Boys', ProductionYear: 2019, OfficialRating: 'TV-14', RecursiveItemCount: 6 }] };
let onServer = 2;
let perSeason = 3;
const ratedSeasons = new Set();
const seasonsList = () => ({ Items: Array.from({ length: onServer }, (_, i) => ({ Id: `S${i + 1}`, IndexNumber: i + 1, ChildCount: perSeason })) });
const episodesOf = (season) => ({
  Items: season > onServer ? [] : Array.from({ length: perSeason }, (_, i) => i + 1).map((n) => ({
    Id: `S${season}E${n}`, SeriesName: 'The Boys', ParentIndexNumber: season, IndexNumber: n,
    Name: `Ep ${n}`, MediaSources: [{ Path: `/s${season}e${n}.mkv`, Size: n }],
    ...(ratedSeasons.has(season) ? { OfficialRating: 'TV-MA' } : {}),
  })),
});
// What Gemini answers the AI check about an episode: 'quota' (HTTP 429, out
// of the day's allowance) or a verdict. Only the cases that turn the check
// on ever reach it.
let geminiSays = 'quota';
const geminiAsked = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const json = (v) => ({ ok: true, status: 200, json: async () => v });
  if (u.hostname === 'generativelanguage.googleapis.com') {
    geminiAsked.push(JSON.parse(init.body).contents[0].parts[0].text.match(/Episode: (S\d\dE\d\d)/)?.[1]);
    const reply = (v, status) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (geminiSays === 'quota') {
      return reply({ error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } }, 429);
    }
    return reply({ candidates: [{ content: { parts: [{ text: JSON.stringify(geminiSays) }] }, finishReason: 'STOP' }] }, 200);
  }
  if (u.pathname.endsWith('/Seasons')) return json(seasonsList());
  if (u.pathname.endsWith('/Episodes')) return json(episodesOf(Number(u.searchParams.get('season') ?? 1)));
  if (u.pathname.endsWith('/Items') || u.pathname.endsWith('/Search/Hints')) return json(SERIES);
  return { ok: false, status: 404, statusText: 'NF', json: async () => ({}) };
};

/** The bot: every reaction and message, in order; `shown` is what each message shows now. */
function fakeBot({ pace = null } = {}) {
  const t = { calls: [], shown: new Map(), texts: [], paced: 0 };
  t.bot = {
    isConnected: () => true,
    _bulkPace: async () => { t.paced += 1; if (pace) await pace(t.paced); },
    isGroupAdmin: () => false,
    deleteMessage: async () => {},
    archiveChat: async () => {},
    sendText: async (jid, text, o = {}) => { t.texts.push({ jid, text, quoted: !!o.quoted, to: o.quoted?.id ?? null }); return { key: { id: 'n' } }; },
    react: async (msg, emoji, { unless = null } = {}) => {
      if (unless?.()) return false;
      t.calls.push({ id: msg.id, emoji });
      t.shown.set(msg.id, emoji);
      return true;
    },
  };
  t.on = (id) => t.calls.filter((c) => c.id === id).map((c) => c.emoji);
  t.notes = () => t.texts.filter((x) => x.jid === NOTIFY).map((x) => x.text);
  t.replies = () => t.texts.filter((x) => x.jid === TVREQ).map((x) => x.text);
  return t;
}

/**
 * Each episode's work: ⬇️, then wait for the test to open its gate, then
 * report to the request's notifier and put its ending on the message - what
 * deliverEpisode does, without downloading anything.
 */
const gates = new Map();
const failing = new Set();
const realDeliver = plugin.deliverEpisode;
plugin.deliverEpisode = async function ({ ep, ctx, react, notifier, reqKey }) {
  const RR = this._react(ctx);
  await react(RR.downloading);
  const code = `S${ep.season}E${ep.episode}`;
  await new Promise((r) => gates.set(code, r));
  if (failing.has(code)) {
    await react(RR.failed);
    notifier.episodeFailed('boom');
    this._journalEpisodeDone(ctx, reqKey, ep.id);
    return;
  }
  notifier.episodeDone();
  await this._reactEnding(ctx, notifier, react);
  this._journalEpisodeDone(ctx, reqKey, ep.id);
};
const open = async (...codes) => { for (const c of codes) { await settle(); gates.get(c)?.(); gates.delete(c); await settle(); } };

async function setUp({ store = new Map(), tv = {}, paused = false, maxLength = 50, pace = null, gemini = null } = {}) {
  await plugin.teardown();
  const t = fakeBot({ pace });
  const q = new JobQueue({ concurrency: 1, maxLength });
  if (paused) q.pause();                         // before setup() puts anything journalled back
  const ctx = {
    config: {
      tvRequests: { enabled: true, requestGroups: [TVREQ], postsGroups: ['tvposts@g.us'], cooldownSecondsPerUser: 0, blockedRatings: ['TV-MA'], ...tv },
      movieRequests: { reactions: R, announceRated: true, notifyRefusals: true, notify: { group: NOTIFY } },
      beta: { groups: [], postsGroup: '', features: {} },
      library: { jellyfin: { baseUrl: 'http://jf:8096', accessToken: 'TOK', userId: 'U1' } },
      media: { workDir: '/tmp/tv-multi-season-test' },
      ...(gemini ? { gemini } : {}),
    },
    bot: t.bot,
    queue: q,
    // Every check, as content-check-health.js is told of it.
    contentHealth: { checks: [], async record(r) { this.checks.push(r); } },
    store: { get: (k, d) => (store.has(k) ? structuredClone(store.get(k)) : d), set: (k, v) => store.set(k, structuredClone(v)) },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  };
  await plugin.setup(ctx);
  return { t, ctx, q, store };
}

let seq = 0;
const mkMsg = (text, sender = null) => {
  const id = `m${++seq}`;
  return {
    id, key: { id, remoteJid: TVREQ }, text, chatJid: TVREQ, isGroup: true, fromMe: false, messageType: 'conversation',
    // A member of their own each, unless the sender is named: the same number
    // is the same member (requestMemberKey), and since 2026-10-11 a member's
    // own request asked again is no duplicate (test/no-redo-reaction.test.mjs).
    senderJid: sender ?? `u${seq}@lid`, senderNumber: sender ? '15551112222' : `1555111${String(seq).padStart(4, '0')}`,
    pushName: 'Ari', timestamp: Date.now(),
  };
};
const ask = async (ctx, text, sender) => { const m = mkMsg(text, sender); await plugin.onMessage(m, ctx); await settle(); return m; };
const waitingTv = (q) => q.snapshot().pending.filter((e) => e.kind === 'tv');
const history = (store) => store.get('history') ?? [];

console.log('=== a run of episodes is one request for exactly those episodes ===');
{
  const { t, ctx, q, store } = await setUp();
  q.pause();
  const m = await ask(ctx, 'The Boys S01E02-E03');
  const tv = waitingTv(q);
  ok(tv.length === 1, `one place in line (${tv.length})`);
  ok(q.pending.map((e) => e.label).join() === 'The Boys S01E02,The Boys S01E03', `exactly E02 and E03 are queued (${q.pending.map((e) => e.label).join()})`);
  ok(tv[0]?.label === 'The Boys S01E02–E03', `named by its codes in the queue (${tv[0]?.label})`);
  const row = history(store)[0];
  ok(row?.detail === 'S01E02–E03 — 2 episode(s)' && row.request === 'The Boys S01E02-E03', `History: "${row?.detail}"`);
  ok(t.notes().some((n) => n === '🎬 The Boys S01E02–E03 — 2 episode(s) — added to the queue'), `the notifications line names the range (${t.notes().join(' | ')})`);
  ok(t.on(m.id).join(' ') === '🔍 🎬 1️⃣', `and it shows its place like any request (${t.on(m.id).join(' ')})`);

  // Past the end of the season, and overlapping what is waiting: only E01 is
  // new, the server has nothing after E03, and E02 and E03 are not queued twice.
  const m2 = await ask(ctx, 'The Boys S01E01-E09');
  ok(q.pending.length === 3 && q.pending[2].label === 'The Boys S01E01',
    `asked past the end, only what the server has and is not waiting goes in (${q.pending.map((e) => e.label).join()})`);
  ok(t.on(m2.id).includes('🎬') && waitingTv(q).length === 2, 'as a request of its own, one more place');

  const m3 = await ask(ctx, 'The Boys S01E07-E09');
  ok(t.on(m3.id).includes('📬'), 'a range the season does not have is not in the library');
  ok(t.replies().some((r) => /we don't have S01E07–E09\./.test(r)), `and the reply says which (${t.replies().join(' | ')})`);
  await plugin.teardown();
}

console.log('=== several seasons: one request each, one place each ===');
let shared;
{
  const s = await setUp();
  const { t, ctx, q, store } = s;
  shared = s;
  q.pause();
  q.add({ kind: 'movie', label: 'Up (2009)', run: () => new Promise((r) => gates.set('Up', r)) });
  const m = await ask(ctx, 'The Boys seasons 1-3');
  const tv = waitingTv(q);
  ok(tv.map((e) => e.label).join() === 'The Boys season 1,The Boys season 2', `two requests, one place each (${tv.map((e) => e.label).join()})`);
  ok(q.pending.filter((e) => e.kind === 'tv').length === 6, 'every episode of both');

  const rows = history(store);
  const s1 = rows.find((r) => r.season === 1);
  const s2 = rows.find((r) => r.season === 2);
  ok(rows.length === 2 && s1 && s2, `a History row for each season (${rows.length})`);
  ok(s1?.id === m.id && s2?.id === `${m.id}:s2`, `the first keeps the message's id, the next its own (${s1?.id}, ${s2?.id})`);
  ok(s1?.request === 'The Boys season 1' && s2?.request === 'The Boys season 2', 'a Re-run of one queues that season alone');
  ok(s1?.typed === 'The Boys seasons 1-3', 'with what the member typed beside it');

  const notes = t.notes();
  ok(notes.filter((n) => /added to the queue/.test(n)).length === 2, `each season has its own "added" line (${notes.join(' | ')})`);
  ok(notes.some((n) => n === '📭 The Boys — "The Boys" has no season 3'), 'and the season the server lacks is said, once');
  ok(t.replies().filter((r) => /we don't have season 3/.test(r)).length === 1, `in one reply to the member (${t.replies().join(' | ')})`);
  const misses = store.get('library-misses') ?? [];
  ok(misses.length === 1 && misses[0].season === 3, 'and recorded as one miss');

  ok(t.paced === 1, `the two seasons looked up are paced like bulk work (CLAUDE.md rule 1): ${t.paced} pause between them`);
  ok(t.on(m.id).join(' ') === '🔍 🎬 2️⃣', `the message shows season 1's place, the film ahead of it: ${t.on(m.id).join(' ')}`);
  ok(!t.on(m.id).includes('3️⃣'), "season 2's place never lands on it");

  const journal = store.get('pending') ?? [];
  ok(journal.length === 2 && journal.every((r) => r.shared?.id === m.id), 'both seasons are journalled as sharing the message');
  shared.m = m;
}

console.log('=== the message follows the first unfinished season, and ends on all of them ===');
{
  const { t, q, store, m } = shared;
  q.resume();
  await open('Up');
  ok(t.shown.get(m.id) === '⬇️', `season 1 starts: its stage shows (${t.on(m.id).join(' ')})`);
  await open('S1E1', 'S1E2');
  const before = t.on(m.id).length;
  await open('S1E3');
  const after = t.on(m.id).slice(before);
  ok(!after.includes('✅'), `season 1 is done, but season 2 is still to come: no ✅ (${after.join(' ')})`);
  ok(after.includes('⬇️') && t.shown.get(m.id) === '⬇️', `season 2 takes the message over (${after.join(' ')})`);
  ok(history(store).find((r) => r.season === 1)?.status === 'sent', 'season 1 is sent in History');
  ok(t.notes().some((n) => /The Boys season 1 — 3 episode\(s\) — all 3 episodes posted/.test(n)), 'and says so in the notifications group');
  await open('S2E1', 'S2E2', 'S2E3');
  // Season 3 was asked for and is not on the server: the message does not
  // end on ✅ as though all of it came, but on 📬.
  ok(t.shown.get(m.id) === '📬', `once season 2 is done too, the message ends - on 📬, since season 3 never came (${t.on(m.id).join(' ')})`);
  ok(t.on(m.id).filter((e) => e === '📬').length === 1 && !t.on(m.id).includes('✅'), 'once, and never on ✅');
  ok((store.get('pending') ?? []).length === 0, 'nothing is left in the journal');
  await plugin.teardown();
}

console.log('=== a failed season shows at the end, whichever finished last ===');
{
  const { t, ctx, q, store } = await setUp();
  failing.add('S1E2');
  const m = await ask(ctx, 'The Boys S01 S02');
  await open('S1E1', 'S1E2', 'S1E3', 'S2E1', 'S2E2', 'S2E3');
  failing.clear();
  ok(t.shown.get(m.id) === '⚠️', `season 1 lost an episode: the message ends on ⚠️ though season 2 was sent last (${t.on(m.id).join(' ')})`);
  const rows = history(store);
  ok(rows.find((r) => r.season === 1)?.status === 'partial' && rows.find((r) => r.season === 2)?.status === 'sent',
    'History has each season as it ended');
  await plugin.teardown();
}

console.log('=== a season already waiting is answered as a duplicate, and the rest still go in ===');
{
  const { t, ctx, q, store } = await setUp({ paused: true });
  const first = await ask(ctx, 'The Boys season 1');
  const m = await ask(ctx, 'The Boys seasons 1-2');
  ok(waitingTv(q).length === 2 && q.pending.filter((e) => e.meta?.season === 1).length === 3,
    'season 1 is not queued twice; season 2 goes in as a request of its own');
  const rows = history(store).filter((r) => r.typed === 'The Boys seasons 1-2');
  ok(rows.find((r) => r.season === 1)?.status === 'duplicate' && rows.find((r) => r.season === 2)?.status === 'queued',
    'History: season 1 a duplicate, season 2 queued');
  ok(t.shown.get(m.id) === '2️⃣' && t.shown.get(first.id) === '1️⃣',
    `the message shows season 2's place, the season it queued (${t.on(m.id).join(' ')})`);
  const holder = (store.get('pending') ?? []).find((r) => r.msgId === first.id);
  ok(holder?.followers?.some((f) => f.historyId === m.id && !f.msgKey),
    "season 1's duplicate row still hears how the earlier request ends, without a reaction on the message");

  const all = await ask(ctx, 'The Boys S01 S02');
  ok(waitingTv(q).length === 2, 'asked again for both, nothing more is queued');
  ok(t.on(all.id).includes('🤥') && NUM.includes(t.shown.get(all.id)),
    `a message all of whose seasons are waiting follows the first of them, as one duplicate does (${t.on(all.id).join(' ')})`);
  await plugin.teardown();
}

console.log('=== a show refused on its rating is said once, and recorded for each season ===');
{
  const rating = SERIES.Items[0].OfficialRating;
  SERIES.Items[0].OfficialRating = 'TV-MA';
  try {
    const { t, ctx, q, store } = await setUp({ paused: true });
    ctx.config.beta.features['tv-rating-notice'] = 'on';
    const m = await ask(ctx, 'The Boys seasons 1-2');
    ok(q.pending.length === 0, 'nothing is queued');
    ok(t.shown.get(m.id) === '⛔', `the message gets ⛔ (${t.on(m.id).join(' ')})`);
    ok(t.notes().filter((n) => /rated TV-MA/.test(n)).length === 1, `the refusal is said once (${t.notes().join(' | ')})`);
    ok(history(store).filter((r) => r.status === 'blocked-rating').length === 2, 'and each season has its History row');
  } finally {
    SERIES.Items[0].OfficialRating = rating;
  }
  await plugin.teardown();
}

console.log('=== typed into the panel, or re-run, the same shapes queue the same way ===');
{
  const { ctx, q, store } = await setUp({ paused: true });
  const r = await plugin.requeue('The Boys S01E02-E03', ctx);
  ok(r.queued === 2 && r.scope === 'S01E02–E03' && q.pending.length === 2, `a run of episodes: ${r.queued} episodes, "${r.scope}"`);
  const m = await plugin.requeue('The Boys seasons 2-3', ctx);
  ok(m.queued === 3 && m.seasons?.join() === '2' && waitingTv(q).length === 2, `several seasons: each queued that the server has (${m.scope})`);
  ok(m.notQueued?.length === 1 && /season 3/.test(m.notQueued[0]), `and the panel is told which did not go in (${m.notQueued?.join(' · ')})`);
  const row = history(store).find((x) => x.season === 2);
  ok(row?.request === 'The Boys season 2', 'its History row re-runs that season alone');
  let threw = null;
  try { await plugin.requeue('The Boys seasons 3-4', ctx); } catch (err) { threw = err; }
  ok(/season 3: .*season 4: /.test(threw?.message ?? ''), `none of them there: refused, with each season's reason (${threw?.message})`);
  await plugin.teardown();
}

console.log('=== one message is one request for the cooldown ===');
{
  const { t, ctx, store } = await setUp({ tv: { cooldownSecondsPerUser: 900 } });
  const sender = 'ari@lid';
  await ask(ctx, 'The Boys season 1 and 2', sender);
  ok(store.get(`cooldown:${sender}`)?.at > 0, 'the cooldown is taken once');
  const again = await ask(ctx, 'The Boys S01E01', sender);
  ok(t.on(again.id).join() === '🚫', 'and the next request inside it is too soon');

  // Until 2026-10-01 a message none of whose seasons could be queued kept
  // the clock too, having been answered in the groups. Since the operator's
  // rule after Ben Lewis's 🚫 ("cooldown is only if the members first
  // request actually puts an item in queue") it starts none, and counts once
  // towards the flood backstop instead (test/cooldown-after-queued.test.mjs).
  const { store: s2, ctx: c2 } = await setUp({ tv: { cooldownSecondsPerUser: 900 } });
  await ask(c2, 'The Boys seasons 3-4', 'bea@lid');
  ok(s2.get('cooldown:bea@lid') == null, 'a message none of whose seasons could be queued starts no clock');
  ok(s2.get('cooldown-answers:bea@lid')?.length === 1, 'and counts once towards the backstop, as one request');
  await plugin.teardown();
}

console.log('=== a restart keeps the message shared between its seasons ===');
{
  const store = new Map();
  let s = await setUp({ store });
  failing.add('S1E3');
  const m = await ask(s.ctx, 'The Boys S01-S02');
  await open('S1E1', 'S1E2', 'S1E3');             // season 1 ends, one episode lost; season 2 starts
  failing.clear();
  ok((store.get('pending') ?? [])[0]?.shared?.ended?.join() === '⚠️', 'how season 1 ended is written on season 2\'s journal entry');
  await plugin.teardown();

  // The bot stops while season 2 runs, and starts again.
  s = await setUp({ store, paused: true });
  await settle();
  ok(waitingTv(s.q).length === 1 && s.q.pending.length === 3, 'season 2 is put back, whole');
  s.q.resume();
  await open('S2E1', 'S2E2', 'S2E3');
  ok(s.t.shown.get(m.id) === '⚠️', `and the message still ends on the outcome of both (${s.t.on(m.id).join(' ')})`);
  await plugin.teardown();
}

console.log('=== after a restart, only the first season still waiting shows its place ===');
{
  const store = new Map();
  let s = await setUp({ store, paused: true });
  const m = await ask(s.ctx, 'The Boys season 1 & 2');
  await plugin.teardown();
  s = await setUp({ store, paused: true });
  await settle();
  const nums = s.t.on(m.id).filter((e) => NUM.includes(e));
  ok(waitingTv(s.q).length === 2, 'both seasons are back in the queue');
  ok(nums.join() === '1️⃣', `the message shows season 1's place and not season 2's (${s.t.on(m.id).join(' ')})`);
  await plugin.teardown();
}

console.log('=== one message asking for seasons 1-30 takes at most maxSeasonsPerRequest places, and the rest are named in one line ===');
{
  onServer = 30;
  try {
    const { t, ctx, q, store } = await setUp({ paused: true, tv: { maxSeasonsPerRequest: 3 } });
    const m = await ask(ctx, 'The Boys seasons 1-30');
    const tv = waitingTv(q);
    ok(tv.map((e) => e.label).join() === 'The Boys season 1,The Boys season 2,The Boys season 3',
      `three places, where it took thirty (${tv.length}: ${tv.map((e) => e.label).join()})`);
    ok(t.notes().filter((n) => /added to the queue/.test(n)).length === 3, 'three "added" lines, not thirty');
    const over = t.notes().filter((n) => /4–30/.test(n));
    ok(over.length === 1 && /The Boys seasons 4–30 weren't added — one request is at most 3 seasons; ask for them again later\./.test(over[0]),
      `the rest are named in one notifications line (${over.join(' | ')})`);
    const reply = t.texts.find((x) => x.jid === TVREQ && x.to === m.id);
    ok(/⚠️ Seasons 4–30 weren't added — one request is at most 3 seasons\. Ask for them again later\./.test(reply?.text ?? ''),
      `and in one quoted reply (${reply?.text})`);
    ok(t.paced === 2 && history(store).length === 3, `only three were looked up, paced twice (${t.paced}), with a History row each`);
    q.resume();
    await open('S1E1', 'S1E2', 'S1E3', 'S2E1', 'S2E2', 'S2E3', 'S3E1', 'S3E2', 'S3E3');
    ok(t.shown.get(m.id) === '⚠️' && !t.on(m.id).includes('✅'),
      `the three sent, the message ends on ⚠️, not ✅: seasons 4 to 30 did not come (${t.on(m.id).join(' ')})`);
  } finally { onServer = 2; }
  await plugin.teardown();
}

console.log('=== maxEpisodesPerRequest is for the whole message, not each season ===');
{
  onServer = 30;
  try {
    const { t, ctx, q } = await setUp({ paused: true, tv: { maxSeasonsPerRequest: 0, maxEpisodesPerRequest: 4 } });
    await ask(ctx, 'The Boys seasons 1-30');
    const eps = q.pending.filter((e) => e.kind === 'tv').map((e) => `S${e.meta.season}E${e.meta.episode}`);
    ok(eps.join() === 'S1E1,S1E2,S1E3,S2E1', `four episodes in all - season 1, and one of season 2 (${eps.join()})`);
    ok(waitingTv(q).length === 2, 'in two places');
    const over = t.notes().filter((n) => /3–30/.test(n));
    ok(over.length === 1 && /one request is at most 4 episodes/.test(over[0]), `the seasons past it are named in one line (${over.join(' | ')})`);
    ok(t.paced === 1, `and not looked up (${t.paced} pause)`);
  } finally { onServer = 2; }
  await plugin.teardown();
}

console.log('=== a season refused on its rating after another was queued: the message ends on ⛔, not ✅, and says which ===');
{
  ratedSeasons.add(2);
  try {
    // No beta config: the rating notice (tv-rating-notice) is off.
    const { t, ctx, store } = await setUp();
    const m = await ask(ctx, 'The Boys seasons 1-2');
    ok(history(store).find((r) => r.season === 2)?.status === 'blocked-rating', 'season 2 is refused on its rating');
    const reply = t.texts.find((x) => x.jid === TVREQ && x.to === m.id);
    ok(/^⛔ Season 2 can't be posted\.$/.test(reply?.text ?? ''), `a quoted reply says which season, without naming the rating (${reply?.text})`);
    ok(t.notes().includes("⛔ The Boys season 2 — can't be posted"), `and a line in the notifications group (${t.notes().join(' | ')})`);
    await open('S1E1', 'S1E2', 'S1E3');
    ok(t.shown.get(m.id) === '⛔' && !t.on(m.id).includes('✅'), `season 1 sent, the message ends on ⛔ (${t.on(m.id).join(' ')})`);
    await plugin.teardown();

    // The notice on: the rating is named, and the season's own line says it.
    const on = await setUp();
    on.ctx.config.beta.features['tv-rating-notice'] = 'on';
    const m2 = await ask(on.ctx, 'The Boys seasons 1-2');
    const r2 = on.t.texts.find((x) => x.jid === TVREQ && x.to === m2.id);
    ok(/^⛔ Season 2 — rated TV-MA, can't be posted\.$/.test(r2?.text ?? ''), `with the notice on, the reply names the rating (${r2?.text})`);
    ok(on.t.notes().filter((n) => /can't be posted/.test(n)).length === 1, 'and the refusal is said once in the notifications group');
    await open('S1E1', 'S1E2', 'S1E3');
    await plugin.teardown();

    // Refused first, queued after: the ⛔ showed at once, and the ending keeps it.
    ratedSeasons.clear(); ratedSeasons.add(1);
    const first = await setUp();
    const m3 = await ask(first.ctx, 'The Boys seasons 1-2');
    await open('S2E1', 'S2E2', 'S2E3');
    ok(first.t.shown.get(m3.id) === '⛔', `season 1 refused, season 2 sent: it ends on ⛔ (${first.t.on(m3.id).join(' ')})`);
  } finally { ratedSeasons.clear(); }
  await plugin.teardown();
}

console.log('=== a season turned away by a full queue after another was queued: a quoted reply names it, and it does not end on ✅ ===');
{
  const { t, ctx, q } = await setUp({ paused: true, maxLength: 1 });
  const m = await ask(ctx, 'The Boys S01 S02');
  ok(waitingTv(q).length === 1, 'season 1 takes the one place');
  const reply = t.texts.find((x) => x.jid === TVREQ && x.to === m.id);
  ok(/^⚠️ Season 2 wasn't added — the queue is full\. Ask again once it clears\.$/.test(reply?.text ?? ''),
    `a quoted reply in the request group names season 2 (${reply?.text})`);
  q.resume();
  await open('S1E1', 'S1E2', 'S1E3');
  ok(t.shown.get(m.id) === '⚠️' && !t.on(m.id).includes('✅'), `the message ends on ⚠️ (${t.on(m.id).join(' ')})`);
  await plugin.teardown();
}

console.log('=== a season an admin set aside whole does not end the message on ❌ ===');
{
  const { t, ctx, q, store } = await setUp({ paused: true });
  const m = await ask(ctx, 'The Boys S01 S02');
  const s2 = waitingTv(q).find((e) => /season 2/.test(e.label));
  q.skip(s2.group ?? s2.id);
  await settle();
  ok(history(store).find((r) => r.season === 2)?.status === 'skipped', `season 2's History row says skipped, not cancelled (${history(store).find((r) => r.season === 2)?.status})`);
  ok(t.notes().some((n) => /^⏭️ The Boys season 2 — 3 episode\(s\) — 0 of 3 posted, 3 skipped$/.test(n)),
    `and so does its notifications line (${t.notes().filter((n) => /season 2/.test(n)).join(' | ')})`);
  q.resume();
  await open('S1E1', 'S1E2', 'S1E3');
  ok(t.shown.get(m.id) === '✅' && !t.on(m.id).includes('❌'), `season 1 sent, season 2 set aside: it ends on ✅ (${t.on(m.id).join(' ')})`);
  await plugin.teardown();
}

console.log('=== a restart part-way through the seasons answers the ones never reached, and the message ends on ⚠️ ===');
{
  onServer = 4;
  const store = new Map();
  try {
    // The bot stops during the second pause between seasons: 1 and 2 are
    // queued, 3 and 4 not yet looked at.
    let s = await setUp({ store, paused: true, pace: (n) => (n >= 2 ? new Promise(() => {}) : undefined) });
    const m = mkMsg('The Boys S01-S04');
    plugin.onMessage(m, s.ctx);
    await settle(); await settle();
    ok(waitingTv(s.q).length === 2, 'seasons 1 and 2 were queued before the stop');
    ok((store.get('seasonBatches') ?? [])[0]?.seasons?.join() === '3,4', 'and the note still holds 3 and 4');
    await plugin.teardown();

    s = await setUp({ store, paused: true });
    await settle();
    const reply = s.t.texts.find((x) => x.jid === TVREQ && x.to === m.id);
    ok(/seasons 3 and 4 weren't added: the bot restarted part-way through the request\. Please ask for them again\./.test(reply?.text ?? ''),
      `the member is told which seasons to ask for again (${reply?.text})`);
    ok(s.t.notes().some((n) => /The Boys seasons 3 and 4 — weren't added/.test(n)), 'and the notifications group');
    const row = history(store).find((r) => r.id === `${m.id}:restart`);
    ok(row?.status === 'failed' && row.request === 'The Boys seasons 3, 4', `with a History row a Re-run can queue them from (${row?.status}: ${row?.request})`);
    ok(!(store.get('seasonBatches') ?? []).length, 'the note is answered once, and gone');
    ok(waitingTv(s.q).length === 2, 'seasons 1 and 2 are resumed as usual');
    s.q.resume();
    await open('S1E1', 'S1E2', 'S1E3', 'S2E1', 'S2E2', 'S2E3');
    ok(s.t.shown.get(m.id) === '⚠️' && !s.t.on(m.id).includes('✅'), `once they are sent, the message ends on ⚠️ (${s.t.on(m.id).join(' ')})`);
  } finally { onServer = 2; }
  await plugin.teardown();
}

console.log('=== a restart before any season was queued marks the message too ===');
{
  onServer = 4;
  const store = new Map();
  try {
    // Season 1 is waiting already, so the message queues nothing before the stop.
    let s = await setUp({ store, paused: true, pace: (n) => (n >= 1 ? new Promise(() => {}) : undefined) });
    await ask(s.ctx, 'The Boys season 1');
    const m = mkMsg('The Boys S01-S03');
    plugin.onMessage(m, s.ctx);
    await settle(); await settle();
    await plugin.teardown();
    s = await setUp({ store, paused: true });
    await settle();
    ok(s.t.on(m.id).join() === '⚠️', `its message gets ⚠️ at once (${s.t.on(m.id).join(' ')})`);
    ok(s.t.texts.some((x) => x.to === m.id && /seasons 2 and 3 weren't added/.test(x.text)), 'and the reply names seasons 2 and 3');
  } finally { onServer = 2; }
  await plugin.teardown();
}

console.log('=== several seasons share one AI check budget: a check that cannot run stops the rest of the message ===');
{
  // The Boys as a TV-MA show, so every episode of every season is put to the
  // check; the check on, and allowed to clear a rated episode, as on the live
  // bot; Gemini out of its day's allowance.
  const GEMINI = { enabled: true, contentCheck: true, allowCleanRatedFilms: true, apiKey: 'GEMINI-KEY', model: 'gemini-test', minContentConfidence: 0.7 };
  const rating = SERIES.Items[0].OfficialRating;
  SERIES.Items[0].OfficialRating = 'TV-MA';
  onServer = 3;
  const pace = LIMITS.paceMs;
  const max = LIMITS.maxChecks;
  LIMITS.paceMs = 0;
  const fresh = () => { geminiAsked.length = 0; resetBreakers(); resetModelCache(); resetPacing(); };
  try {
    fresh();
    geminiSays = 'quota';
    const { t, ctx, q, store } = await setUp({ paused: true, gemini: GEMINI });
    const m = await ask(ctx, 'The Boys seasons 1-3');
    ok(geminiAsked.length === 1, `one call for the whole message, where each season made one (${geminiAsked.length}: ${geminiAsked.join()})`);
    const failed = ctx.contentHealth.checks.filter((r) => !r.ok);
    ok(failed.length === 1, `and one failure recorded in the content check's health (${failed.length})`);
    const rows = history(store).filter((r) => r.typed === 'The Boys seasons 1-3');
    ok(rows.length === 3 && rows.every((r) => r.status === 'blocked-rating') && q.pending.length === 0,
      `every season is refused on its rating, as the check could not run (${rows.map((r) => r.status).join()})`);
    ok(rows.every((r) => /did not run/.test(r.override ?? '')), `and each row says the check did not run (${rows.map((r) => r.override).join(' | ')})`);
    ok(t.shown.get(m.id) === '⛔', `and the message ends on ⛔ (${t.on(m.id).join(' ')})`);
    await plugin.teardown();

    // Typed into the panel, the seasons share one budget too.
    fresh();
    const panel = await setUp({ paused: true, gemini: GEMINI });
    let threw = null;
    try { await plugin.requeue('The Boys seasons 1-3', panel.ctx); } catch (err) { threw = err; }
    ok(geminiAsked.length === 1 && /season 1: .*season 2: .*season 3: /.test(threw?.message ?? ''),
      `the panel's "seasons 1-3" makes one call too (${geminiAsked.length}), and says why each season was refused`);
    await plugin.teardown();

    // Every answer "nudity", and a small maxChecks: the message as a whole
    // makes at most that many checks, not that many per season.
    fresh();
    geminiSays = { nudity: true, confidence: 0.95, basis: 'nudity' };
    LIMITS.maxChecks = 4;
    const nude = await setUp({ paused: true, gemini: GEMINI });
    await ask(nude.ctx, 'The Boys seasons 1-3');
    ok(geminiAsked.length === LIMITS.maxChecks,
      `at most LIMITS.maxChecks (${LIMITS.maxChecks}) checks across all three seasons, where each season made its own (${geminiAsked.length}: ${geminiAsked.join()})`);
    await plugin.teardown();
    LIMITS.maxChecks = max;

    // The default: a message never spends Gemini's free day (20 checks) on
    // its own. Three seasons of six TV-MA episodes, every answer "no nudity".
    fresh();
    perSeason = 6;
    geminiSays = { nudity: false, confidence: 0.95, basis: 'violence, no nudity' };
    ok(LIMITS.maxChecks <= 10, `a message asks about at most ${LIMITS.maxChecks} episodes, half of Gemini's 20 a day`);
    const big = await setUp({ paused: true, gemini: GEMINI });
    await ask(big.ctx, 'The Boys seasons 1-3');
    const queued = big.q.pending.filter((e) => e.kind === 'tv').map((e) => `S${e.meta.season}E${e.meta.episode}`);
    ok(geminiAsked.length === LIMITS.maxChecks,
      `18 rated episodes asked for, ${geminiAsked.length} checks made (${geminiAsked.join()})`);
    ok(queued.length === LIMITS.maxChecks && queued.join() === geminiAsked.map((c) => c.replace(/S0(\d)E0(\d)/, 'S$1E$2')).join(),
      `the ones it cleared are queued, and the rest wait for another day (${queued.join()})`);
    await plugin.teardown();
  } finally {
    SERIES.Items[0].OfficialRating = rating;
    onServer = 2; perSeason = 3;
    LIMITS.paceMs = pace; LIMITS.maxChecks = max;
    geminiSays = 'quota';
  }
}

plugin.deliverEpisode = realDeliver;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
