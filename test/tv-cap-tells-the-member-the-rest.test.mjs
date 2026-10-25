/* A request the episode limit cuts tells its member what was left out, and the exact message for the next part.
   Run: node test/tv-cap-tells-the-member-the-rest.test.mjs

   2026-10-12: the operator asked "why is the flash converting 23 episodes if
   it's max 10 per request?". The TV request group's description says the bot
   "Will only process 10 episodes at a time", but tvRequests.maxEpisodesPerRequest
   was 0, so The Flash season 2 queued all 23. The operator set it to 10 again
   (and maxSeasonsPerRequest to 1, the cooldown to 15 minutes) - and with a
   limit set, a season past it queued its first episodes and said nothing of
   the rest. "The Boys season 1", five episodes against a limit of two, got
   🔍 🎬, the notifications group read "The Boys season 1 — 2 episode(s) —
   added to the queue", and the request group heard nothing. A member asking
   for "Arrow s1", 23 episodes, would believe the whole season was coming. A
   whole season a multi-season message could not fit was named; part of one
   was not.

   Pinned here: one quoted reply in the request group naming what went in,
   what the limit left out, and the message for the next part - which reads
   back (parse.js) as that season and run of episodes, and queues exactly
   them when sent; the notifications line and the History row saying the
   request was cut, with a `cut` field the hourly check's scan reads, so the
   next part is not a member asking again; the finished notice naming the
   next part, journalled so a restart keeps it while an old journal entry
   finishes as it always did; the panel's Re-run saying what it cut, and
   telling no member anything more; and nothing at all changing when the
   limit is 0 or the request fits under it. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import plugin from '../src/plugins/tv-requests/index.js';
import { JobQueue } from '../src/core/queue.js';
import { runAdminCommand } from '../src/core/admin-commands.js';
import { StateStore } from '../src/core/state.js';
import { parseTvRequest } from '../src/plugins/tv-requests/parse.js';
// The next part is asked for with the one helper the trim's reply and the
// finished notice use too (next-part.js); the runs are parse.js's, which the
// hourly check's scan and re-run rules read History's `cut` with.
import {
  capCut, nextCode, cutReply, cutDetail, partAfter,
} from '../src/plugins/tv-requests/cap-cut.js';
import { nextAsk, partsOf } from '../src/plugins/tv-requests/next-part.js';
import { runsOf, numbersOfRuns } from '../src/plugins/tv-requests/parse.js';
import { requestChains, scan } from '../src/core/incident-scan.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const settle = () => new Promise((r) => setTimeout(r, 5));

const TVREQ = 'tvreq@g.us';
const NOTIFY = 'notify@g.us';
const BETA = '120363900000000013@g.us';
const NUM = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const R = {
  researching: '🔍', added: '🎬', failed: '⚠️', cancelled: '❌', skipped: '⏭️', done: '✅', rated: '⛔',
  notInLibrary: '📬', duplicate: '🤥', downloading: '⬇️', tooFast: '🚫', positions: NUM, positionOverflow: '🔢',
};
// The live settings since 2026-10-12, with the request group's prefix.
const LIVE = { maxEpisodesPerRequest: 10, maxSeasonsPerRequest: 1, requirePrefix: true, prefix: '#request' };

/* ------------------------------ the library ------------------------------ */

// Arrow: seasons 1 and 2, 23 episodes each, unless a case says otherwise.
// An episode is { n, rating?, end? } - `end` makes it a double-episode file.
const SHOW = { Id: 'ARW', Name: 'Arrow', ProductionYear: 2012, OfficialRating: 'TV-14' };
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
let library;
const resetLibrary = () => { library = { 1: range(1, 23).map((n) => ({ n })), 2: range(1, 23).map((n) => ({ n })) }; };
resetLibrary();
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const json = (v) => ({ ok: true, status: 200, json: async () => v });
  if (u.pathname.endsWith('/Seasons')) {
    return json({ Items: Object.keys(library).map((s) => ({ Id: `S${s}`, IndexNumber: Number(s), ChildCount: library[s].length })) });
  }
  if (u.pathname.endsWith('/Episodes')) {
    const s = Number(u.searchParams.get('season'));
    return json({ Items: (library[s] ?? []).map((e) => ({
      Id: e.id ?? `A${s}E${e.n}`, SeriesName: 'Arrow', ParentIndexNumber: s, IndexNumber: e.n, ...(e.end ? { IndexNumberEnd: e.end } : {}),
      Name: `Ep ${e.n}`, MediaSources: [{ Path: `/arrow/s${s}e${e.n}.mkv`, Size: 1 }], ...(e.rating ? { OfficialRating: e.rating } : {}),
    })) });
  }
  if (u.pathname.endsWith('/Items') || u.pathname.endsWith('/Search/Hints')) return json({ Items: [SHOW] });
  return { ok: false, status: 404, statusText: 'NF', json: async () => ({}) };
};

/* ------------------------------- the bot -------------------------------- */

function fakeBot() {
  const t = { calls: [], texts: [] };
  t.bot = {
    isConnected: () => true,
    _bulkPace: async () => {},
    isGroupAdmin: () => false,
    deleteMessage: async () => {},
    archiveChat: async () => {},
    sendText: async (jid, text, o = {}) => { t.texts.push({ jid, text, to: o.quoted?.id ?? null }); return { key: { id: 'n' } }; },
    react: async (msg, emoji, { unless = null } = {}) => {
      if (unless?.()) return false;
      t.calls.push({ id: msg.id, emoji });
      return true;
    },
  };
  t.on = (id) => t.calls.filter((c) => c.id === id).map((c) => c.emoji);
  t.notes = () => t.texts.filter((x) => x.jid === NOTIFY).map((x) => x.text);
  t.repliesTo = (id) => t.texts.filter((x) => x.jid !== NOTIFY && x.to === id).map((x) => x.text);
  return t;
}

// Each episode's work: ⬇️, then wait for the test to open its gate, then
// report to the request's notifier - what deliverEpisode does, without
// downloading anything (as test/tv-multi-season.test.mjs).
const gates = new Map();
// Episodes that fail instead, by code.
const failing = new Set();
const realDeliver = plugin.deliverEpisode;
plugin.deliverEpisode = async function ({ ep, ctx, react, notifier, reqKey }) {
  await react(this._react(ctx).downloading);
  await new Promise((r) => gates.set(`S${ep.season}E${ep.episode}`, r));
  if (failing.has(`S${ep.season}E${ep.episode}`)) {
    notifier.episodeFailed('the download broke');
    await this._reactEnding(ctx, notifier, react);
    this._journalEpisodeDone(ctx, reqKey, ep.id, 'failed');
    return;
  }
  notifier.episodeDone();
  await this._reactEnding(ctx, notifier, react);
  this._journalEpisodeDone(ctx, reqKey, ep.id);
};
const open = async (season, nums) => {
  for (const n of nums) { await settle(); gates.get(`S${season}E${n}`)?.(); gates.delete(`S${season}E${n}`); await settle(); }
};

async function setUp({ store = new Map(), tv = {}, movie = {}, beta = null, paused = false } = {}) {
  await plugin.teardown();
  gates.clear();
  const t = fakeBot();
  const q = new JobQueue({ concurrency: 1, maxLength: 50 });
  if (paused) q.pause();
  const ctx = {
    config: {
      tvRequests: { enabled: true, requestGroups: [TVREQ], postsGroups: ['tvposts@g.us'], cooldownSecondsPerUser: 0, blockedRatings: ['TV-MA'], ...tv },
      movieRequests: { reactions: R, notify: { group: NOTIFY }, ...movie },
      beta: beta ?? { groups: [], postsGroup: '', features: {} },
      library: { jellyfin: { baseUrl: 'http://jf:8096', accessToken: 'TOK', userId: 'U1' } },
      media: { workDir: '/tmp/tv-cap-tells-the-rest' },
    },
    bot: t.bot,
    queue: q,
    store: { get: (k, d) => (store.has(k) ? structuredClone(store.get(k)) : d), set: (k, v) => store.set(k, structuredClone(v)) },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  };
  await plugin.setup(ctx);
  return { t, ctx, q, store };
}

let seq = 0;
const mkMsg = (text, { sender = 'ari@lid', chat = TVREQ } = {}) => {
  const id = `m${++seq}`;
  return {
    id, key: { id, remoteJid: chat }, text, chatJid: chat, isGroup: true, fromMe: false, messageType: 'conversation',
    senderJid: sender, senderNumber: '15551112222', pushName: 'Ari', timestamp: Date.now(),
  };
};
const ask = async (ctx, text, o) => { const m = mkMsg(text, o); await plugin.onMessage(m, ctx); await settle(); return m; };
const waiting = (q) => q.pending.filter((e) => e.kind === 'tv').map((e) => `S${e.meta.season}E${e.meta.episode}`);
const history = (store) => store.get('history') ?? [];
const rowOf = (store, id) => history(store).find((r) => r.id === id);
const journalOf = (store, msgId) => (store.get('pending') ?? []).find((r) => r.msgId === msgId);
const codesOf = (season, nums) => nums.map((n) => `S${season}E${n}`);
/** The message a reply tells the member to send, as they would copy it. */
const suggested = (text) => /send \*([^*]+)\*/.exec(text ?? '')?.[1] ?? null;
/** What onMessage hands the parser once the prefix is off. */
const unprefixed = (text, prefix = '#request') => (text.toLowerCase().startsWith(prefix) ? text.slice(prefix.length).trim() : text);

/* ============================ the reply ============================ */

console.log('=== (a) "Arrow s1", 23 episodes, limit 10: one reply names the rest and the next part ===');
let first;
{
  resetLibrary();
  const s = await setUp({ paused: true, tv: LIVE });
  const { t, ctx, q, store } = s;
  const m = await ask(ctx, '#request Arrow s1');
  ok(same(waiting(q), codesOf(1, range(1, 10))), `episodes 1 to 10 are queued (${waiting(q).join()})`);
  ok(t.on(m.id).join(' ') === '🔍 🎬 1️⃣', `the reactions any queued request gets (${t.on(m.id).join(' ')})`);
  const replies = t.repliesTo(m.id);
  ok(replies.length === 1, `ONE reply in the request group, quoted to the message (${replies.length})`);
  ok(replies[0] === "⚠️ *Arrow* season 1 — one request is at most 10 episodes: episodes 1–10 were added; 11–23 weren't.\n"
    + 'Once these are posted, send *#request Arrow S01E11-E20* for the next part.', `the reply: ${JSON.stringify(replies[0])}`);
  ok(t.texts.filter((x) => x.jid === TVREQ).length === 1, 'and nothing else in the request group');
  ok(t.notes().includes('🎬 Arrow S01E01–E10 — 10 of season 1 — added to the queue; one request is at most 10 episodes'),
    `the notifications line says it was cut (${t.notes().join(' | ')})`);

  const row = rowOf(store, m.id);
  ok(row?.status === 'queued' && row.episodes === 10, 'History: queued, 10 episodes');
  // Named by what was queued, as every request that queued part of what it
  // asked is (index.js queuedName), and the cut after it.
  ok(row?.detail === 'S01E01–E10 — 10 of season 1 · one request is at most 10; not queued: E11–E23 (next: S01E11-E20)',
    `History's detail says it was cut: "${row?.detail}"`);
  ok(same(row?.cut, {
    limit: 10, count: 10, of: 23, queued: [[1, 10]], left: [[11, 23]], next: { season: 1, from: 11, to: 20, last: false }, parts: [[11, 20], [21, 23]],
  }), `and its \`cut\` field says so in numbers, every part with it: ${JSON.stringify(row?.cut)}`);
  ok(same(journalOf(store, m.id)?.next, { send: '#request Arrow S01E11-E20', last: false }),
    `the journalled request keeps the next part for its finished notice: ${JSON.stringify(journalOf(store, m.id)?.next)}`);

  // The round trip: what the member is told to send reads back as exactly
  // that season and run of episodes...
  const text = suggested(replies[0]);
  const p = parseTvRequest(unprefixed(text));
  ok(p.show === 'Arrow' && p.season === 1 && same(p.episodeRange, { from: 11, to: 20 }) && p.episode == null,
    `"${text}" parses back as Arrow season 1, episodes 11-20 (${JSON.stringify({ show: p.show, season: p.season, range: p.episodeRange })})`);
  // ...and, sent, queues exactly them. Ten episodes fit under the limit, so
  // it is answered as any request that fits - but it is a part the first
  // named, and keeps the part after it for when it finishes.
  const m2 = await ask(ctx, text);
  ok(same(waiting(q).slice(10), codesOf(1, range(11, 20))), `sent, it queues episodes 11 to 20 and nothing else (${waiting(q).slice(10).join()})`);
  ok(t.repliesTo(m2.id).length === 0 && t.on(m2.id).join(' ') === '🔍 🎬 2️⃣', `it fits, and is answered as one that fits (${t.on(m2.id).join(' ')})`);
  ok(t.notes().at(-1) === '🎬 Arrow S01E11–E20 — 10 episode(s) — added to the queue', `with the line it always had (${t.notes().at(-1)})`);
  ok(rowOf(store, m2.id)?.status === 'queued' && !('cut' in rowOf(store, m2.id)), 'a request of its own, not a duplicate or a resend, and not cut');
  const next2 = journalOf(store, m2.id)?.next;
  ok(same(next2, { send: '#request Arrow S01E21-E23', last: true }), `its journal entry keeps the part after it: ${JSON.stringify(next2)}`);
  const m3 = await ask(ctx, next2.send);
  ok(same(waiting(q).slice(20), codesOf(1, [21, 22, 23])), `and the rest: 21 to 23 (${waiting(q).slice(20).join()})`);
  ok(t.repliesTo(m3.id).length === 0, 'which fits under the limit, and gets no reply');
  ok(t.notes().at(-1) === '🎬 Arrow S01E21–E23 — 3 episode(s) — added to the queue', `and the line it always had (${t.notes().at(-1)})`);
  ok(!('cut' in rowOf(store, m3.id)) && !journalOf(store, m3.id)?.next, 'the last part: no `cut`, nothing after it');
  first = { ...s, m, m2, m3 };
}

console.log('=== (d) the finished notice names the next part ===');
{
  const { t, q, store, m } = first;
  q.resume();
  await open(1, range(1, 10));
  const done = t.notes().find((n) => n.startsWith('✅ Arrow S01E01–E10'));
  ok(done === '✅ Arrow S01E01–E10 — 10 of season 1 — all 10 episodes posted! Check the posts group\n'
    + 'Send *#request Arrow S01E11-E20* for the next part.', `the notice: ${JSON.stringify(done)}`);
  const row = rowOf(store, m.id);
  ok(row?.status === 'sent' && row.detail === '10 episode(s) posted · one request is at most 10; not queued: E11–E23 (next: S01E11-E20)',
    `History, finished, still says it was cut: "${row?.detail}"`);
  ok(t.on(m.id).at(-1) === '✅', 'and the message ends on ✅, as before');
  await open(1, range(11, 20));
  ok(t.notes().some((n) => n === '✅ Arrow S01E11–E20 — 10 episode(s) — all 10 episodes posted! Check the posts group\n'
    + 'Send *#request Arrow S01E21-E23* for the rest.'), 'the next part, finished, names the rest');
  await open(1, [21, 22, 23]);
  ok(t.notes().at(-1) === '✅ Arrow S01E21–E23 — 3 episode(s) — all 3 episodes posted! Check the posts group',
    `and the last part's notice is the one it always was (${JSON.stringify(t.notes().at(-1))})`);

  // The hourly check's scan reads the three as one season in parts.
  const rows = history(store);
  const chains = requestChains({ 'tv-requests': { history: rows } }).filter((c) => c.plugin === 'tv');
  ok(chains.length === 3 && chains.every((c) => c.rows.length === 1), `three asks, none a repeat of another (${chains.map((c) => c.rows.length).join()})`);
  await plugin.teardown();
}

console.log('=== (b) "Arrow S01E05-E30": the next part ends where the season does ===');
{
  resetLibrary();
  const { t, ctx, q, store } = await setUp({ paused: true, tv: LIVE });
  const m = await ask(ctx, '#request Arrow S01E05-E30');
  ok(same(waiting(q), codesOf(1, range(5, 14))), `episodes 5 to 14 are queued (${waiting(q).join()})`);
  const replies = t.repliesTo(m.id);
  ok(replies.length === 1 && replies[0] === "⚠️ *Arrow* S01E05–E23 — one request is at most 10 episodes: episodes 5–14 were added; 15–23 weren't.\n"
    + 'Once these are posted, send *#request Arrow S01E15-E23* for the rest.', `the reply: ${JSON.stringify(replies[0])}`);
  const p = parseTvRequest(unprefixed(suggested(replies[0])));
  ok(p.season === 1 && same(p.episodeRange, { from: 15, to: 23 }), 'it reads back as S01 E15-E23: no episode 24 to 30, which the season does not have');
  ok(rowOf(store, m.id)?.detail === 'S01E05–E14 — 10 of E05–E23 · one request is at most 10; not queued: E15–E23 (next: S01E15-E23)',
    `History: "${rowOf(store, m.id)?.detail}"`);
  await plugin.teardown();
}

console.log('=== the rest named right when it does not run on from E1: waiting elsewhere, withheld on rating ===');
{
  resetLibrary();
  library[1][14].rating = 'TV-MA';                // E15
  const { t, ctx, q, store } = await setUp({ paused: true, tv: LIVE });
  await ask(ctx, '#request Arrow S01E03', { sender: 'bea@lid' });   // E03 waits for another member
  const m = await ask(ctx, '#request Arrow s1');
  ok(same(waiting(q).slice(1), codesOf(1, [1, 2, ...range(4, 11)])), `queued: 1, 2 and 4-11 - not 3, which waits already (${waiting(q).slice(1).join()})`);
  const replies = t.repliesTo(m.id);
  ok(replies.length === 1 && replies[0] === "⚠️ *Arrow* season 1 — one request is at most 10 episodes: episodes 1, 2 and 4–11 were added; 12–14 and 16–23 weren't.\n"
    + 'Once these are posted, send *#request Arrow S01E12-E21* for the next part.',
  `neither 3 (waiting) nor 15 (withheld) is called left out, and the next part spans ten numbers: ${JSON.stringify(replies[0])}`);
  const row = rowOf(store, m.id);
  ok(same(row?.cut?.left, [[12, 14], [16, 23]]) && same(row?.cut?.queued, [[1, 2], [4, 11]]) && row.cut.of === 21,
    `History's cut: ${JSON.stringify(row?.cut)}`);
  // Sent, the next part queues 12-14 and 16-21 - 15 is withheld again - and
  // fits. It spans ten episode numbers, the withheld one among them, since
  // the trim and this reply ask for the next part with one helper
  // (next-part.js): it was "S01E12-E22", ten of the rest by count, which a
  // part only stays under the limit with while E15 stays withheld.
  const m2 = await ask(ctx, suggested(replies[0]));
  ok(same(waiting(q).slice(11), codesOf(1, [12, 13, 14, ...range(16, 21)])), `sent, it queues 12-14 and 16-21 (${waiting(q).slice(11).join()})`);
  ok(t.repliesTo(m2.id).length === 0, 'nine episodes, under the limit: no reply');
  await plugin.teardown();

  // With the rating notice on and replies on blocking, the withheld episode
  // has a reply of its own to give - and it is folded into the one reply.
  resetLibrary();
  library[1][14].rating = 'TV-MA';
  const on = await setUp({ paused: true, tv: LIVE, movie: { replyOnBlock: true }, beta: { groups: [], postsGroup: '', features: { 'tv-rating-notice': 'on' } } });
  const m3 = await ask(on.ctx, '#request Arrow s1');
  const r3 = on.t.repliesTo(m3.id);
  ok(r3.length === 1, `still ONE reply (${r3.length})`);
  ok(r3[0] === "⚠️ *Arrow* season 1 — one request is at most 10 episodes: episodes 1–10 were added; 11–14 and 16–23 weren't.\n"
    + 'Once these are posted, send *#request Arrow S01E11-E20* for the next part.\n\n'
    + "Episode 15 is rated TV-MA, which can't be posted, so it was left out.", `with the withheld episode's words in it: ${JSON.stringify(r3[0])}`);
  ok(on.t.notes().includes("🎬 Arrow season 1 — 10 of 22 episodes added to the queue; one request is at most 10 episodes. "
    + "Episode 15 is rated TV-MA, which can't be posted, so it was left out."), `the notifications line: ${on.t.notes().join(' | ')}`);
  await plugin.teardown();
}

console.log('=== no episode number the season does not have ===');
{
  resetLibrary();
  library[1] = [...range(1, 10), ...range(12, 15)].map((n) => ({ n }));     // no E11 on the server
  const { t, ctx } = await setUp({ paused: true, tv: LIVE });
  const m = await ask(ctx, '#request Arrow s1');
  const reply = t.repliesTo(m.id)[0];
  ok(reply === "⚠️ *Arrow* season 1 — one request is at most 10 episodes: episodes 1–10 were added; 12–15 weren't.\n"
    + 'Once these are posted, send *#request Arrow S01E12-E15* for the rest.', `the rest starts at 12: ${JSON.stringify(reply)}`);
  await plugin.teardown();
}

console.log('=== (c) several seasons: the cut season is a line of the message\'s one reply ===');
{
  // The limit runs out inside season 1; season 2 is past it.
  resetLibrary();
  let s = await setUp({ paused: true, tv: { ...LIVE, maxSeasonsPerRequest: 0 } });
  let m = await ask(s.ctx, '#request Arrow seasons 1-2');
  ok(same(waiting(s.q), codesOf(1, range(1, 10))), `season 1's first ten are queued (${waiting(s.q).join()})`);
  let replies = s.t.repliesTo(m.id);
  ok(replies.length === 1 && replies[0] === "⚠️ Season 1 — one request is at most 10 episodes: episodes 1–10 were added; 11–23 weren't. "
    + 'Once these are posted, send *#request Arrow S01E11-E20* for the next part.\n'
    + "⚠️ Season 2 wasn't added — one request is at most 10 episodes. Ask for it again later.", `one reply: ${JSON.stringify(replies[0])}`);
  ok(s.t.notes().includes('🎬 Arrow S01E01–E10 — 10 of season 1 — added to the queue; one request is at most 10 episodes'),
    'season 1\'s notifications line says it was cut');
  ok(same(journalOf(s.store, m.id)?.next, { send: '#request Arrow S01E11-E20', last: false }), 'and its journal entry keeps the next part');
  await plugin.teardown();

  // As the live settings have it, one season a message: season 2 is past
  // that limit first.
  resetLibrary();
  s = await setUp({ paused: true, tv: LIVE });
  m = await ask(s.ctx, '#request Arrow seasons 1-2');
  replies = s.t.repliesTo(m.id);
  ok(replies.length === 1 && replies[0] === "⚠️ Season 1 — one request is at most 10 episodes: episodes 1–10 were added; 11–23 weren't. "
    + 'Once these are posted, send *#request Arrow S01E11-E20* for the next part.\n'
    + "⚠️ Season 2 wasn't added — one request is at most 1 season. Ask for it again later.", `with the live settings: ${JSON.stringify(replies[0])}`);
  await plugin.teardown();

  // The limit runs out part-way through season 2: season 1 whole, four of season 2.
  resetLibrary();
  library[1] = range(1, 6).map((n) => ({ n }));
  s = await setUp({ paused: true, tv: { ...LIVE, maxSeasonsPerRequest: 0 } });
  m = await ask(s.ctx, '#request Arrow S01 S02');
  ok(same(waiting(s.q), [...codesOf(1, range(1, 6)), ...codesOf(2, range(1, 4))]), `season 1 and four of season 2 (${waiting(s.q).join()})`);
  replies = s.t.repliesTo(m.id);
  ok(replies.length === 1 && replies[0] === "⚠️ Season 2 — one request is at most 10 episodes: episodes 1–4 were added; 5–23 weren't. "
    + 'Once these are posted, send *#request Arrow S02E05-E14* for the next part.', `one reply, about season 2: ${JSON.stringify(replies[0])}`);
  const p = parseTvRequest(unprefixed(suggested(replies[0])));
  ok(p.season === 2 && same(p.episodeRange, { from: 5, to: 14 }), 'it reads back as S02 E05-E14');
  ok(s.t.notes().includes('🎬 Arrow season 1 — 6 episode(s) — added to the queue'), 'season 1, whole, has the line it always had');
  ok(s.t.notes().includes('🎬 Arrow S02E01–E04 — 4 of season 2 — added to the queue; one request is at most 10 episodes'), 'season 2 says it was cut');
  const s2 = (s.store.get('pending') ?? []).find((r) => r.baseRow?.season === 2);
  ok(same(s2?.next, { send: '#request Arrow S02E05-E14', last: false }) && !(s.store.get('pending') ?? []).find((r) => r.baseRow?.season === 1)?.next,
    'season 2\'s journal entry keeps its next part, and season 1\'s has none');
  await plugin.teardown();
}

console.log('=== a test is answered with what a member would be told, the code in front of the next part ===');
{
  resetLibrary();
  const { t, ctx, q } = await setUp({
    paused: true, tv: LIVE, beta: { groups: [BETA], postsGroup: '', features: { 'tv-rating-notice': 'beta' } },
  });
  const m = await ask(ctx, '$beta003 Arrow s1', { chat: BETA });
  ok(q.pending.length === 0, 'nothing is queued');
  const reply = t.repliesTo(m.id);
  ok(reply.length === 1 && reply[0] === '✅ *Test passed* ($beta003)\n\nThe bot would queue 10 episodes of *Arrow* season 1.\nNothing was downloaded.\n\n'
    + "⚠️ *Arrow* season 1 — one request is at most 10 episodes: episodes 1–10 were added; 11–23 weren't.\n"
    + 'Once these are posted, send *$beta003 #request Arrow S01E11-E20* for the next part.', `the answer: ${JSON.stringify(reply[0])}`);
  // Several seasons in a test: the cut season is a line of its one answer.
  ctx.config.tvRequests.maxSeasonsPerRequest = 0;
  const m2 = await ask(ctx, '$beta003 Arrow seasons 1-2', { chat: BETA });
  const r2 = t.repliesTo(m2.id);
  ok(r2.length === 1 && r2[0] === '✅ *Test passed* ($beta003)\n\nThe bot would queue 10 episodes of *Arrow* season 1.\nNothing was downloaded.\n\n'
    + "⚠️ Season 1 — one request is at most 10 episodes: episodes 1–10 were added; 11–23 weren't. "
    + 'Once these are posted, send *$beta003 #request Arrow S01E11-E20* for the next part.\n'
    + "⚠️ Season 2 wasn't added — one request is at most 10 episodes. Ask for it again later.", `several seasons: ${JSON.stringify(r2[0])}`);
  ok(q.pending.length === 0, 'and still nothing is queued');
  await plugin.teardown();
}

/* ======================= a restart, and an old journal ======================= */

console.log('=== the next part survives a restart; a journal entry from before it finishes as it always did ===');
{
  resetLibrary();
  const store = new Map();
  let s = await setUp({ store, paused: true, tv: LIVE });
  const m = await ask(s.ctx, '#request Arrow s1');
  await plugin.teardown();

  s = await setUp({ store, paused: true, tv: LIVE });
  await settle();
  ok(same(waiting(s.q), codesOf(1, range(1, 10))), 'the ten are resumed');
  s.q.resume();
  await open(1, range(1, 10));
  ok(s.t.notes().includes('✅ Arrow S01E01–E10 — 10 of season 1 — all 10 episodes posted! Check the posts group\n'
    + 'Send *#request Arrow S01E11-E20* for the next part.'), `resumed, its notice still names the next part (${s.t.notes().join(' | ')})`);
  ok(rowOf(store, m.id)?.detail === '10 episode(s) posted (resumed) · one request is at most 10; not queued: E11–E23 (next: S01E11-E20)',
    `and History says what it was cut to: "${rowOf(store, m.id)?.detail}"`);
  await plugin.teardown();

  // The same request as a journal written before 2026-10-12 holds it: no
  // `next`, no `cut` on its row.
  const old = new Map();
  let o = await setUp({ store: old, paused: true, tv: LIVE });
  const m2 = await ask(o.ctx, '#request Arrow s1');
  await plugin.teardown();
  const entry = old.get('pending')[0];
  delete entry.next;
  delete entry.baseRow.cut;
  entry.label = 'Arrow season 1 — 10 episode(s)';
  entry.baseRow.detail = 'season 1 — 10 episode(s)';
  old.set('history', old.get('history').map((r) => { const { cut, ...rest } = r; return { ...rest, detail: 'season 1 — 10 episode(s)' }; }));
  o = await setUp({ store: old, paused: true, tv: LIVE });
  await settle();
  o.q.resume();
  await open(1, range(1, 10));
  ok(o.t.notes().at(-1) === '✅ Arrow season 1 — 10 episode(s) — all 10 episodes posted! Check the posts group',
    `it loads, and its notice is the one it always was (${JSON.stringify(o.t.notes().at(-1))})`);
  ok(rowOf(old, m2.id)?.detail === '10 episode(s) posted (resumed)' && !('cut' in rowOf(old, m2.id)),
    `and so is its History row: "${rowOf(old, m2.id)?.detail}"`);
  ok(o.t.texts.every((x) => x.jid === NOTIFY), 'nothing is said in the request group after a restart');
  await plugin.teardown();
}

/* ============================== the panel ============================== */

console.log('=== (4) a panel Re-run says what it cut, and tells no member anything more ===');
{
  resetLibrary();
  const { t, ctx, q, store } = await setUp({ paused: true, tv: LIVE });
  const r = await plugin.requeue('Arrow season 1', ctx, { requester: 'Ari (re-run by the hourly check)' });
  ok(r.queued === 10 && same(waiting(q), codesOf(1, range(1, 10))), `ten queued (${r.queued})`);
  ok(r.cutNote === 'one request is at most 10; not queued: E11–E23 (next: Arrow S01E11-E20)',
    `the answer says what was cut, and what to queue next - with no prefix, as the queue box takes it: "${r.cutNote}"`);
  ok(same(r.cut?.next, { season: 1, from: 11, to: 20, last: false }), 'and carries the `cut`');
  const row = history(store)[0];
  ok(row?.detail === 'S01E01–E10 — 10 of season 1 · one request is at most 10; not queued: E11–E23 (next: S01E11-E20)' && row.cut?.of === 23,
    `History says so: "${row?.detail}"`);
  ok(t.texts.length === 0, `nothing is said in any group (${t.texts.length})`);
  ok(!(store.get('pending') ?? [])[0]?.next, 'no next part is journalled for a member');
  q.resume();
  await open(1, range(1, 10));
  ok(same(t.notes(), ['✅ Arrow S01E01–E10 — all 10 episodes posted! Check the posts group']),
    `its finished notice is the one it always was (${t.notes().join(' | ')})`);

  const several = await plugin.requeue('Arrow seasons 1-2', ctx);
  ok(several.cutNote === 'season 1: one request is at most 10; not queued: E11–E23 (next: Arrow S01E11-E20)'
    + ' · season 2: one request is at most 10; not queued: E11–E23 (next: Arrow S02E11-E20)',
  `several seasons, each said: "${several.cutNote}"`);
  await plugin.teardown();

  // Where the admin reads it: the panel's toast, and the bot commands the
  // hourly check's re-run and an operator on the box use.
  const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  ok(/const queuedLabel = [\s\S]*?r\.cutNote/.test(app), "the panel's toast shows what was cut");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-cap-cut-'));
  try {
    const st = new StateStore(path.join(tmp, 'state.json'));
    const tvNs = st.namespace('tv-requests');
    tvNs.set('history', [{ id: 'T1', kind: 'tv', at: Date.now() - 3600_000, status: 'failed', title: 'Arrow', year: 2012, season: 1, request: 'Arrow s1', requester: 'Ari' }]);
    const stub = { plugins: new Map([['tv-requests', { plugin: { async requeue() { return r; } }, ctx: { store: tvNs } }]]) };
    const viaCheck = await runAdminCommand({ op: 'requeue', plugin: 'tv', id: 'T1', by: 'hourly check' }, { bot: {}, dataDir: tmp, stateStore: st, pluginManager: stub });
    ok(viaCheck.ok && viaCheck.note === r.cutNote, `the hourly check's re-run is told what was cut: "${viaCheck.note}"`);
    const viaBox = await runAdminCommand({ op: 'queue', plugin: 'tv', text: 'Arrow season 1' }, { bot: {}, dataDir: tmp, stateStore: st, pluginManager: stub });
    ok(viaBox.ok && viaBox.note === r.cutNote, `and so is a request queued on the box: "${viaBox.note}"`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/* ====================== nothing changes under the limit ====================== */

console.log('=== (5) with no limit, or a request that fits, everything is as it was ===');
{
  // Everything a request leaves behind that a member or an admin can see,
  // less the ids and clocks.
  const run = async (tv, text) => {
    resetLibrary();
    const { t, ctx, q, store } = await setUp({ paused: true, tv: { requirePrefix: true, prefix: '#request', ...tv } });
    const m = await ask(ctx, text);
    const strip = ({ id, at, requestedAt, ...rest }) => rest;
    const seen = {
      reactions: t.on(m.id),
      texts: t.texts.map((x) => ({ jid: x.jid, text: x.text, quoted: !!x.to })),
      queue: q.pending.map((e) => e.label),
      groups: q.snapshot().pending.map((e) => e.label),
      history: history(store).map(strip),
      journal: (store.get('pending') ?? []).map(({ reqKey, baseRow, startedAt, ...rest }) => ({ ...rest, baseRow: strip(baseRow) })),
    };
    q.resume();
    for (const season of [1, 2]) await open(season, range(1, 23));
    seen.done = t.notes().filter((n) => n.startsWith('✅'));
    seen.ended = t.on(m.id).at(-1);
    seen.finished = history(store).map(strip);
    await plugin.teardown();
    // The message's own id is in its rows and its journal entry: the same
    // request, whichever message asked for it.
    return JSON.parse(JSON.stringify(seen).split(m.id).join('MSG'));
  };
  for (const text of ['#request Arrow s1', '#request Arrow S01E05-E09', '#request Arrow seasons 1-2']) {
    const none = await run({ maxEpisodesPerRequest: 0 }, text);
    const fits = await run({ maxEpisodesPerRequest: 46 }, text);
    ok(same(none, fits), `"${text}": a limit it fits under changes nothing - reactions, texts, queue, History, journal, notices`);
    ok(!none.texts.some((x) => x.jid === TVREQ) && !none.history.some((r) => 'cut' in r) && !none.journal.some((j) => 'next' in j),
      `"${text}": no reply, no \`cut\`, no next part`);
  }
  const season = await run({ maxEpisodesPerRequest: 0 }, '#request Arrow s1');
  ok(same(season.reactions, ['🔍', '🎬', '1️⃣']) && season.queue.length === 23, 'Arrow s1 with no limit: 🔍 🎬 1️⃣, 23 episodes');
  ok(same(season.texts, [{ jid: NOTIFY, text: '🎬 Arrow season 1 — 23 episode(s) — added to the queue', quoted: false }]),
    `and only the line it always had (${JSON.stringify(season.texts)})`);
  ok(season.history[0].detail === 'season 1 — 23 episode(s)' && season.finished[0].detail === '23 episode(s) posted',
    'History as it always was');
  ok(same(season.done, ['✅ Arrow season 1 — 23 episode(s) — all 23 episodes posted! Check the posts group']), 'and the notice');

  resetLibrary();
  const { ctx } = await setUp({ paused: true, tv: { maxEpisodesPerRequest: 0 } });
  const r0 = await plugin.requeue('Arrow season 1', ctx);
  ok(r0.queued === 23 && !('cut' in r0) && !('cutNote' in r0), 'a panel Re-run with no limit answers as it did');
  await plugin.teardown();
}

/* ============================ the hourly check ============================ */

console.log('=== the hourly check\'s scan: a season in parts is not a repeat, a failure, or missing episodes ===');
{
  const NOW = Date.parse('2026-10-12T20:00:00Z');
  const MIN = 60_000;
  const cutA = {
    limit: 10, count: 10, of: 23, queued: [[1, 10]], left: [[11, 23]], next: { season: 1, from: 11, to: 20, last: false }, parts: [[11, 20], [21, 23]],
  };
  const tvRow = (id, request, at, extra = {}) => ({
    id, kind: 'tv', request, title: 'Arrow', year: 2012, season: 1, episodes: 10, status: 'queued',
    requester: 'Ari', requesterJid: 'ari@lid', groupJid: TVREQ, requestedAt: at, at, ...extra,
  });
  const chainsOf = (rows) => requestChains({ 'tv-requests': { history: rows } }).filter((c) => c.plugin === 'tv');

  // The first part still being made when the member sends the next, as the
  // cooldown lets them a quarter of an hour on.
  const a = tvRow('A', 'Arrow s1', NOW - 60 * MIN, { cut: cutA, detail: 'S01E01–E10 — 10 of season 1 · one request is at most 10; not queued: E11–E23 (next: S01E11-E20)' });
  const b = tvRow('B', 'Arrow S01E11-E20', NOW - 30 * MIN);
  ok(chainsOf([a, b]).length === 2, 'the next part, asked for while the first is still being made, is not the same ask');
  const { cut, ...before } = a;
  ok(chainsOf([before, b]).length === 1, 'without `cut` - every row before 2026-10-12 - the scan took it for asking again (the false alarm this mends)');
  const found = scan({ now: NOW, state: { 'tv-requests': { history: [a, b] } }, options: { firstRunLookbackMs: 24 * 60 * MIN } });
  const all = [...found.incidents, ...found.notices];
  ok(!all.some((f) => ['repeat-request', 'refused-again', 'request-failed'].includes(f.kind)),
    `and the scan reports nothing for it (${all.map((f) => f.kind).join() || 'nothing'})`);

  // After a failure part-way, the next part is still the next part; the
  // failure is its own finding, and its row shows what the limit cut.
  const partial = { ...a, status: 'partial', detail: '9 of 10 posted, 1 failed · one request is at most 10; not queued: E11–E23 (next: S01E11-E20)' };
  ok(chainsOf([partial, b]).length === 2, 'after one of its episodes failed, the next part is still not a repeat');
  const f2 = scan({ now: NOW, state: { 'tv-requests': { history: [partial, b] } }, options: { firstRunLookbackMs: 24 * 60 * MIN } });
  const failed = f2.incidents.find((f) => f.kind === 'request-failed');
  ok(failed && same(failed.request?.cut?.next, { season: 1, from: 11, to: 20 }) && same(failed.request.cut.queued, [[1, 10]]),
    `the failure's dossier entry carries the cut, for the research session (${JSON.stringify(failed?.request?.cut)})`);
  ok(!f2.incidents.some((f) => f.kind === 'repeat-request'), 'and no repeat-request beside it');

  // Episodes it queued, asked for again, are still asking again.
  ok(chainsOf([a, tvRow('C', 'Arrow S01E05', NOW - 20 * MIN, { episodes: 1 })]).length === 1, 'an episode it queued, asked for again, is a repeat');
  ok(chainsOf([a, tvRow('D', 'Arrow season 1', NOW - 20 * MIN)]).length === 1, 'and so is the whole season again');
  ok(chainsOf([a, tvRow('E', 'Arrow S01E08-E15', NOW - 20 * MIN)]).length === 1, 'and a run that takes in some of what it queued');

  // Withheld on rating in between: the part the bot named spans E15 and is
  // the next part; E15 asked for on its own is asking again for what was
  // withheld (refused-again), as it always was.
  const cutW = {
    limit: 10, count: 10, of: 21, queued: [[1, 2], [4, 11]], left: [[12, 14], [16, 23]], next: { season: 1, from: 12, to: 21, last: false }, parts: [[12, 21], [22, 23]],
  };
  const w = tvRow('W', 'Arrow s1', NOW - 60 * MIN, { cut: cutW, withheld: '1 withheld (TV-MA): E15', status: 'sent' });
  ok(chainsOf([w, tvRow('X', 'Arrow S01E12-E21', NOW - 30 * MIN, { withheld: '1 withheld (TV-MA): E15' })]).length === 2,
    'the next part the bot named, withheld episode and all, is not asking again');
  ok(chainsOf([w, tvRow('Y', 'Arrow S01E15', NOW - 30 * MIN, { status: 'blocked-rating', episodes: 0 })]).length === 1,
    'the withheld episode on its own is still the same ask');
}

/* ============================== the words ============================== */

console.log('=== the next part, as words: it reads back, and never asks for what was queued ===');
{
  const eps = (season, nums, o = {}) => nums.map((n) => ({ id: `${season}-${n}`, season, episode: n, ...o }));
  for (const [name, season, from, to] of [
    ['Arrow', 1, 11, 20], ['The Flash', 2, 11, 20], ['9-1-1', 3, 5, 14], ['Episodes', 1, 4, 7], ['24', 8, 13, 22],
    ['Doctor Who', 12, 2, 10], ['One Piece', 17, 101, 110], ['Grey\'s Anatomy', 19, 9, 9],
  ]) {
    const c = capCut({ season, limit: 10, queued: eps(season, range(Math.max(1, from - 10), from - 1)), left: eps(season, range(from, to)) });
    const text = nextAsk(c.next, { name, prefix: '#request' });
    const p = parseTvRequest(unprefixed(text));
    const back = p.episodeRange ?? (p.episode != null ? { from: p.episode, to: p.episode } : null);
    ok(p.show === name && p.season === season && same(back, { from, to }), `"${text}" reads back as ${name} season ${season}, ${from}-${to}`);
  }
  const noPrefix = capCut({ season: 1, limit: 10, queued: eps(1, range(1, 10)), left: eps(1, range(11, 23)) });
  ok(nextAsk(noPrefix.next, { name: 'Arrow' }) === 'Arrow S01E11-E20', 'without requirePrefix, no prefix');

  // A double-episode file ends a part at its second half, so the part after
  // never starts inside it (jellyfin-tv.js matches a run on either half).
  const dbl = capCut({ season: 2, limit: 3, queued: eps(2, [18, 19, 20]), left: [...eps(2, [21], { episodeEnd: 22 }), ...eps(2, [23, 24, 25])] });
  // Three episode numbers at most, the file's two among them (next-part.js).
  ok(nextCode(dbl) === 'S02E21-E23' && same(dbl.left, [[21, 25]]) && same(dbl.parts, [[21, 23], [24, 25]]),
    `E21-E22 as one file: the next part is ${nextCode(dbl)}`);

  // Two files of one episode: the second copy left out is no episode left out.
  ok(capCut({ season: 1, limit: 1, queued: eps(1, [14]), left: [{ id: 'twin', season: 1, episode: 14 }] }) === null,
    'a second copy of a queued episode is not called left out');
  // An episode queued in the middle of what was left out is never asked for
  // again: the next part stops short of it.
  const mid = capCut({ season: 1, limit: 5, queued: eps(1, [1, 2, 5]), left: eps(1, [3, 4, 6, 7]) });
  ok(nextCode(mid) === 'S01E03-E04', `the next part stops before E05, which was queued (${nextCode(mid)})`);
  // Nothing left out, or no limit: no cut.
  ok(capCut({ season: 1, limit: 10, queued: eps(1, range(1, 10)), left: [] }) === null, 'nothing left out: null');
  ok(capCut({ season: 1, limit: 0, queued: eps(1, range(1, 10)), left: eps(1, [11]) }) === null, 'no limit: null');
  // One episode each way reads as one.
  const one = capCut({ season: 1, limit: 1, queued: eps(1, [1]), left: eps(1, [2]) });
  ok(cutReply(one, { lead: '*Arrow* season 1', ask: nextAsk(one.next, { name: 'Arrow' }) })
    === "⚠️ *Arrow* season 1 — one request is at most 1 episode: episode 1 was added; 2 wasn't.\nOnce it is posted, send *Arrow S01E02* for the rest.",
  'one episode, one left: singular throughout');
  ok(same(numbersOfRuns(runsOf([5, 1, 2, 3, 9])), [1, 2, 3, 5, 9]), 'runs round-trip');
}

/* ======================= found in review, 2026-10-12 ======================= */

console.log('=== a next part never takes in an episode another request has waiting ===');
{
  // Bea's "S01E15-E18" was queued, then Ari asked for "Arrow s1": the next
  // part he was told was "S01E11-E23", ten of what the limit left out by
  // count - thirteen episode numbers, Bea's four among them. Her four were
  // posted before his E1-E10, so by the time he sent it as told they were
  // queued, and posted, a second time, and the thirteen were cut again.
  // A part stops short of an episode coming anyway, as it does of one this
  // request queued (next-part.js).
  resetLibrary();
  const { t, ctx, q, store } = await setUp({ paused: true, tv: LIVE });
  await ask(ctx, '#request Arrow S01E15-E18', { sender: 'bea@lid' });
  const m = await ask(ctx, '#request Arrow s1');
  const reply = t.repliesTo(m.id)[0];
  ok(reply === "⚠️ *Arrow* season 1 — one request is at most 10 episodes: episodes 1–10 were added; 11–14 and 19–23 weren't.\n"
    + 'Once these are posted, send *#request Arrow S01E11-E14* for the next part.', `the next part stops before Bea's E15: ${JSON.stringify(reply)}`);
  ok(same(rowOf(store, m.id)?.cut?.parts, [[11, 14], [19, 23]]), `and the part after it starts past them (${JSON.stringify(rowOf(store, m.id)?.cut?.parts)})`);
  q.resume();
  await open(1, [15, 16, 17, 18]);
  await open(1, range(1, 10));
  ok(t.notes().includes('✅ Arrow S01E01–E10 — 10 of season 1 — all 10 episodes posted! Check the posts group\n'
    + 'Send *#request Arrow S01E11-E14* for the next part.'), 'his finished notice names the same part');
  // Everything posted, he sends it as told: no posted episode is queued
  // again, and nothing is cut again.
  q.pause();
  const m2 = await ask(ctx, suggested(reply));
  ok(same(waiting(q), codesOf(1, [11, 12, 13, 14])), `sent, it queues 11-14 and nothing posted (${waiting(q).join()})`);
  ok(t.repliesTo(m2.id).length === 0 && !rowOf(store, m2.id)?.cut, 'and it fits: no reply, no cut');
  ok(same(journalOf(store, m2.id)?.next, { send: '#request Arrow S01E19-E23', last: true }), 'it ends naming the rest');
  q.resume();
  await open(1, [11, 12, 13, 14]);
  q.pause();
  const m3 = await ask(ctx, '#request Arrow S01E19-E23');
  ok(same(waiting(q), codesOf(1, range(19, 23))) && t.repliesTo(m3.id).length === 0, `and the rest is 19-23 (${waiting(q).join()})`);
  await plugin.teardown();
}

console.log('=== a list\'s next part takes in only the episodes it named ===');
{
  // parse.js reads "S01E02, E05, E06" as those three; a run is every episode
  // between its ends, so a part of a list never spans an episode it left out.
  resetLibrary();
  const { t, ctx, q, store } = await setUp({ paused: true, tv: { ...LIVE, maxEpisodesPerRequest: 1 } });
  const m = await ask(ctx, '#request Arrow S01E02, E05, E06');
  ok(same(waiting(q), codesOf(1, [2])), `one queued (${waiting(q).join()})`);
  ok(same(rowOf(store, m.id)?.cut?.parts, [[5, 5], [6, 6]]), `each part a run of what it named (${JSON.stringify(rowOf(store, m.id)?.cut?.parts)})`);
  ok(t.repliesTo(m.id)[0] === "⚠️ *Arrow* S01E02, E05, E06 — one request is at most 1 episode: episode 2 was added; 5 and 6 weren't.\n"
    + 'Once it is posted, send *#request Arrow S01E05* for the next part.', `"${t.repliesTo(m.id)[0]}"`);
  await plugin.teardown();
  resetLibrary();
  const two = await setUp({ paused: true, tv: { ...LIVE, maxEpisodesPerRequest: 2 } });
  const m2 = await ask(two.ctx, '#request Arrow S01E01, E02, E05, E06, E09');
  ok(same(rowOf(two.store, m2.id)?.cut?.parts, [[5, 6], [9, 9]]), `"S01E05-E06" and then "S01E09", never "S01E05-E09" (${JSON.stringify(rowOf(two.store, m2.id)?.cut?.parts)})`);
  ok(/send \*#request Arrow S01E05-E06\* for the next part\.$/.test(two.t.repliesTo(m2.id)[0] ?? ''), 'a dash run, which parse.js reads back as a run');
  await plugin.teardown();
  // Within the limit's span, the gap still ends a part: "S01E05-E07" would
  // queue E06, which the list never named.
  resetLibrary();
  const three = await setUp({ paused: true, tv: { ...LIVE, maxEpisodesPerRequest: 3 } });
  const m3 = await ask(three.ctx, '#request Arrow S01E01, E02, E03, E05, E07');
  ok(same(rowOf(three.store, m3.id)?.cut?.parts, [[5, 5], [7, 7]]), `E05, then E07 - not E05-E07 (${JSON.stringify(rowOf(three.store, m3.id)?.cut?.parts)})`);
  await plugin.teardown();
  // An episode left out that is coming anyway - a second copy of one
  // queued, which the trim can leave out as it keeps the first - starts no
  // part: the part never asks for one that will have been posted.
  const eps = (nums) => nums.map((n) => ({ id: `p-${n}`, season: 1, episode: n }));
  ok(same(partsOf({ season: 1, left: [{ id: 'twin', season: 1, episode: 5 }, ...eps([6, 7])], coming: eps([5]), max: 10 }), [{ season: 1, from: 6, to: 7 }]),
    'a part starts past an episode coming anyway');
}

console.log('=== several seasons: a cut season still says which of its episodes the rating withheld ===');
{
  // "Arrow seasons 1-2" with S01E05 TV-MA, replyOnBlock and the rating
  // notice on: before 2026-10-12 the request group read "Arrow season 1 —
  // 10 episode(s) added to the queue. Episode 5 is rated TV-MA, which can't
  // be posted, so it was left out." With season 1 cut, its line of the one
  // reply said nothing of episode 5 (found in review). A season asked for
  // alone folds those words into its one reply; one of several, into its line.
  resetLibrary();
  library[1][4].rating = 'TV-MA';
  const s = await setUp({
    paused: true, tv: { ...LIVE, maxSeasonsPerRequest: 0 }, movie: { replyOnBlock: true },
    beta: { groups: [], postsGroup: '', features: { 'tv-rating-notice': 'on' } },
  });
  const m = await ask(s.ctx, '#request Arrow seasons 1-2');
  const replies = s.t.repliesTo(m.id);
  ok(replies.length === 1 && replies[0] === "⚠️ Season 1 — one request is at most 10 episodes: episodes 1–4 and 6–11 were added; 12–23 weren't. "
    + "Once these are posted, send *#request Arrow S01E12-E21* for the next part. Episode 5 is rated TV-MA, which can't be posted, so it was left out.\n"
    + "⚠️ Season 2 wasn't added — one request is at most 10 episodes. Ask for it again later.", `one reply, episode 5 in it: ${JSON.stringify(replies[0])}`);
  await plugin.teardown();
  // Without replyOnBlock it has no reply of its own to give, and adds none.
  resetLibrary();
  library[1][4].rating = 'TV-MA';
  const quiet = await setUp({ paused: true, tv: { ...LIVE, maxSeasonsPerRequest: 0 }, beta: { groups: [], postsGroup: '', features: { 'tv-rating-notice': 'on' } } });
  const q2 = await ask(quiet.ctx, '#request Arrow seasons 1-2');
  ok(!/Episode 5/.test(quiet.t.repliesTo(q2.id)[0] ?? ''), 'with replyOnBlock off, the line is the cut alone, as a season asked for alone is');
  await plugin.teardown();
}

console.log('=== a second copy of an episode is not another episode in the cut\'s counts ===');
{
  // Arrow season 1 with E03 held twice: "10 of 24 episodes" in the
  // notifications group and History while the member read "episodes 1–9
  // were added; 10–23 weren't" (found in review). The cut counts episodes.
  // Since 2026-10-13 the copy never reaches the cut at all (jellyfin-tv.js
  // oneCopyEach: American Dad!'s season 15, held twice), so the ten are E01-E10.
  resetLibrary();
  library[1].splice(3, 0, { n: 3, id: 'A1E3-copy' });
  const { t, ctx, store } = await setUp({ paused: true, tv: LIVE, movie: { replyOnBlock: true } });
  const m = await ask(ctx, '#request Arrow s1');
  const cut = rowOf(store, m.id)?.cut;
  ok(cut?.count === 10 && cut.of === 23 && same(cut.queued, [[1, 10]]), `10 of 23 episodes, E03 once (${JSON.stringify(cut)})`);
  ok(/^⚠️ \*Arrow\* season 1 — one request is at most 10 episodes: episodes 1–10 were added; 11–23 weren't\./.test(t.repliesTo(m.id)[0] ?? ''),
    'as the member reads it');
  await plugin.teardown();
}

console.log('=== the part after: only of the same season, the same side of the beta line, and never past the last ===');
{
  resetLibrary();
  // Another member asks for a run of season 2 that a season 1 row named.
  let s = await setUp({ paused: true, tv: LIVE });
  await ask(s.ctx, '#request Arrow s1');
  const other = await ask(s.ctx, '#request Arrow S02E11-E20', { sender: 'bea@lid' });
  ok(!journalOf(s.store, other.id)?.next, `season 2's E11-E20 is no part of season 1's cut (${JSON.stringify(journalOf(s.store, other.id)?.next)})`);
  await plugin.teardown();

  // A beta row's parts are the beta group's.
  const cutRow = (id, at, parts, extra = {}) => ({
    id, kind: 'tv', at, title: 'Arrow', season: 1, request: 'Arrow s1', status: 'queued',
    cut: { limit: 10, count: 10, of: 23, queued: [[1, 10]], left: [[11, 23]], next: { season: 1, from: parts[0][0], to: parts[0][1] }, parts }, ...extra,
  });
  resetLibrary();
  s = await setUp({ paused: true, tv: LIVE, store: new Map([['history', [cutRow('BETA', Date.now() - 60_000, [[11, 20], [21, 23]], { beta: true })]]]) });
  const fromMain = await ask(s.ctx, '#request Arrow S01E11-E20');
  ok(!journalOf(s.store, fromMain.id)?.next, 'a beta row\'s part asked for in a main group names no part after it');
  await plugin.teardown();

  // The newest row that names the run decides: here it is its last part.
  resetLibrary();
  s = await setUp({
    paused: true, tv: LIVE,
    store: new Map([['history', [cutRow('NEW', Date.now() - 60_000, [[11, 20], [21, 23]]), cutRow('OLD', Date.now() - 3600_000, [[21, 23], [24, 30]])]]]),
  });
  const last = await ask(s.ctx, '#request Arrow S01E21-E23');
  ok(!journalOf(s.store, last.id)?.next, `the last part of the newest cut names nothing after it, whatever an older row said (${JSON.stringify(journalOf(s.store, last.id)?.next)})`);
  await plugin.teardown();
}

console.log('=== a cut request that posted nothing names no next part ===');
{
  resetLibrary();
  const { t, ctx, q } = await setUp({ paused: true, tv: LIVE });
  for (const n of range(1, 10)) failing.add(`S1E${n}`);
  await ask(ctx, '#request Arrow s1');
  q.resume();
  await open(1, range(1, 10));
  const notice = t.notes().find((n) => n.startsWith('⚠️ Arrow S01E01–E10'));
  ok(notice === '⚠️ Arrow S01E01–E10 — 10 of season 1 — 0 of 10 posted, 10 failed', `"${notice}" - nothing to follow, so no next part`);
  failing.clear();
  await plugin.teardown();
}

console.log('=== without requirePrefix the next part is sent as the group takes it, with no prefix ===');
{
  resetLibrary();
  const { t, ctx } = await setUp({ paused: true, tv: { ...LIVE, requirePrefix: false } });
  const m = await ask(ctx, 'Arrow s1');
  ok(/send \*Arrow S01E11-E20\* for the next part\.$/.test(t.repliesTo(m.id)[0] ?? ''), `"${t.repliesTo(m.id)[0]}"`);
  await plugin.teardown();
}

console.log('=== episodes the library never numbered ===');
{
  const eps = (season, nums) => nums.map((n) => ({ id: `${season}-${n}`, season, episode: n }));
  const loose = (k) => Array.from({ length: k }, (_, i) => ({ id: `loose-${i}`, season: 1, episode: null }));
  const c = capCut({ season: 1, limit: 10, queued: eps(1, range(1, 10)), left: [...eps(1, [11, 12]), ...loose(2)] });
  ok(c.unnumbered === 2 && same(c.parts, [[11, 12]]) && c.next.last === false, 'one part, which is not the rest: two have no number to ask by');
  ok(cutReply(c, { lead: '*Arrow* season 1', ask: '#request Arrow S01E11-E12' })
    === "⚠️ *Arrow* season 1 — one request is at most 10 episodes: episodes 1–10 were added; 11, 12 and 2 more weren't.\n"
    + 'Once these are posted, send *#request Arrow S01E11-E12* for the next part.', 'counted, and named "2 more"');
  ok(cutReply(c, { lead: '*Arrow* season 1', ask: null }).endsWith('\nAsk for them again once these are posted.'),
    'with no message to give (a name parse.js would misread), the member is asked to ask again');
  ok(cutDetail(c) === 'one request is at most 10; not queued: E11, E12, 2 without a number (next: S01E11-E12)', `History: "${cutDetail(c)}"`);
  ok(partAfter({ ...c, parts: [[11, 12], [13, 14]] }, { from: 11, to: 12 }, 1)?.last === false,
    'the part after the next is not "the rest" either while some have no number');
  ok(partAfter({ parts: [[11, 12], [13, 14]] }, { from: 11, to: 12 }, 1)?.last === true, 'and is, when all of them have one');
}

console.log('=== a panel Re-run cut to one episode says what it cut ===');
{
  resetLibrary();
  const { ctx, store } = await setUp({ paused: true, tv: { ...LIVE, maxEpisodesPerRequest: 1 } });
  const r = await plugin.requeue('Arrow season 1', ctx);
  const row = history(store)[0];
  ok(r.queued === 1 && row?.detail === 'S01E01 — 1 of season 1 · one request is at most 1; not queued: E2–E23 (next: S01E02)',
    `one episode of a cut season is named as part of it, not as the episode alone: "${row?.detail}"`);
  await plugin.teardown();
}

plugin.deliverEpisode = realDeliver;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
