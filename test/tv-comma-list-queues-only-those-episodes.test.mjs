/* A comma list of episodes queues those episodes, and only those; a dash is still "through".
   Run: node test/tv-comma-list-queues-only-those-episodes.test.mjs

   The operator, 2026-10-12, about "Outer Banks S05E04-E10": "if it's a dash
   it's 4 through 10, comma then it'll only be those 2, comprendo?". The dash
   was read right - all seven episodes are TV-MA, and the AI check cleared
   only E08 and E09 - but a comma was not read at all. "The Office s01 e06,
   e09" came back as S01E06 alone and E09 was dropped without a word, though
   the TV group's description offers "e06, e09" as the way to ask for
   specific episodes. Only a list with no gap in it (Solo Leveling's
   "e11,e12", 2026-10-02) had been read, as a range. And a chain of dashes
   stopped at its first: "#request drake and josh S01 e03-e04-e05-e06-e07"
   (2026-10-12 21:32 UTC) queued "Drake & Josh S01E03–E04 — 2 episode(s)".

   Now a list is one request for exactly the episodes it names: one place in
   line, named by its codes ("S01E04–E07, E09") in the queue, the
   notifications group and History, checked for duplicates episode by
   episode, re-run from its History row as typed, and counted against
   maxEpisodesPerRequest as a range is. An episode it names that the season
   does not have is said to be missing; the rest still goes in. These run
   the real plugin against the real queue, with each episode's work replaced
   by a gate that never opens. */
import plugin from '../src/plugins/tv-requests/index.js';
import { JobQueue } from '../src/core/queue.js';
import { parseTvRequest } from '../src/plugins/tv-requests/parse.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const settle = () => new Promise((r) => setTimeout(r, 5));

const TVREQ = 'tvreq@g.us';
const NOTIFY = 'notify@g.us';
const NUM = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const R = {
  researching: '🔍', added: '🎬', failed: '⚠️', cancelled: '❌', skipped: '⏭️', done: '✅', redo: '🔄', rated: '⛔',
  notInLibrary: '📬', duplicate: '🤥', downloading: '⬇️', tooFast: '🚫', needSeason: '📺', positions: NUM, positionOverflow: '🔢',
};

// The Office: season 1 has ten episodes, E01 to E10, and so has Drake &
// Josh. A test that needs a second season (to be asked "which season?")
// sets `seasons` to 2.
const SHOWS = { OFF: 'The Office', DJ: 'Drake & Josh' };
const SERIES = { Items: [
  { Id: 'OFF', Name: 'The Office', ProductionYear: 2005, OfficialRating: 'TV-14', RecursiveItemCount: 10 },
  { Id: 'DJ', Name: 'Drake & Josh', ProductionYear: 2004, OfficialRating: 'TV-Y7', RecursiveItemCount: 10 },
] };
let seasons = 1;
const PER_SEASON = 10;
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const json = (v) => ({ ok: true, status: 200, json: async () => v });
  const show = u.pathname.match(/\/Shows\/([^/]+)\//)?.[1];
  if (u.pathname.endsWith('/Seasons')) {
    return json({ Items: Array.from({ length: seasons }, (_, i) => ({ Id: `${show}S${i + 1}`, IndexNumber: i + 1, ChildCount: PER_SEASON })) });
  }
  if (u.pathname.endsWith('/Episodes')) {
    const season = Number(u.searchParams.get('season') ?? 1);
    return json({
      Items: season > seasons ? [] : Array.from({ length: PER_SEASON }, (_, i) => i + 1).map((n) => ({
        Id: `${show === 'OFF' ? '' : show}S${season}E${n}`, SeriesName: SHOWS[show], ParentIndexNumber: season, IndexNumber: n,
        Name: `Ep ${n}`, MediaSources: [{ Path: `/${show}s${season}e${n}.mkv`, Size: n }],
      })),
    });
  }
  if (u.pathname.endsWith('/Items') || u.pathname.endsWith('/Search/Hints')) return json(SERIES);
  return { ok: false, status: 404, statusText: 'NF', json: async () => ({}) };
};

function fakeBot() {
  const t = { calls: [], texts: [] };
  t.bot = {
    isConnected: () => true,
    _bulkPace: async () => {},
    isGroupAdmin: () => false,
    deleteMessage: async () => {},
    archiveChat: async () => {},
    sendText: async (jid, text, o = {}) => { t.texts.push({ jid, text, to: o.quoted?.id ?? null }); return { key: { id: 'n' } }; },
    react: async (msg, emoji) => { t.calls.push({ id: msg.id, emoji }); return true; },
  };
  t.on = (id) => t.calls.filter((c) => c.id === id).map((c) => c.emoji);
  t.notes = () => t.texts.filter((x) => x.jid === NOTIFY).map((x) => x.text);
  t.replies = (id) => t.texts.filter((x) => x.jid === TVREQ && (!id || x.to === id)).map((x) => x.text);
  return t;
}

// Nothing is downloaded: every episode waits in the paused queue.
plugin.deliverEpisode = async () => new Promise(() => {});

async function setUp({ tv = {} } = {}) {
  await plugin.teardown();
  const store = new Map();
  const t = fakeBot();
  const q = new JobQueue({ concurrency: 1, maxLength: 50 });
  q.pause();
  const ctx = {
    config: {
      tvRequests: { enabled: true, requestGroups: [TVREQ], postsGroups: ['tvposts@g.us'], cooldownSecondsPerUser: 0, blockedRatings: ['TV-MA'], ...tv },
      movieRequests: { reactions: R, notifyRefusals: true, notify: { group: NOTIFY } },
      beta: { groups: [], postsGroup: '', features: {} },
      library: { jellyfin: { baseUrl: 'http://jf:8096', accessToken: 'TOK', userId: 'U1' } },
      media: { workDir: '/tmp/tv-comma-list-test' },
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
const ask = async (ctx, text) => {
  const id = `m${++seq}`;
  const m = {
    id, key: { id, remoteJid: TVREQ }, text, chatJid: TVREQ, isGroup: true, fromMe: false, messageType: 'conversation',
    senderJid: `u${seq}@lid`, senderNumber: `1555111${String(seq).padStart(4, '0')}`, pushName: 'Aiden', timestamp: Date.now(),
  };
  await plugin.onMessage(m, ctx);
  await settle();
  return m;
};
const labels = (q) => q.pending.filter((e) => e.kind === 'tv').map((e) => e.label);
const places = (q) => q.snapshot().pending.filter((e) => e.kind === 'tv');
const history = (store) => store.get('history') ?? [];

console.log('=== the parse: a comma is "only these", a dash is "through" ===');
{
  const read = (t) => {
    const p = parseTvRequest(t);
    return p.episodeList ? `${p.season}:${p.episodeList.join(',')}` : p.episodeRange ? `${p.season}:${p.episodeRange.from}-${p.episodeRange.to}` : `${p.season}:${p.episode}`;
  };
  ok(read('The Office S01E06, E09') === '1:6,9', `"S01E06, E09" is E06 and E09 (${read('The Office S01E06, E09')})`);
  ok(read('Outer Banks S05E04-E10') === '5:4-10', `"S05E04-E10" is E04 through E10 (${read('Outer Banks S05E04-E10')})`);
  ok(read('Outer Banks S05E04, E10') === '5:4,10', `"S05E04, E10" is E04 and E10 only (${read('Outer Banks S05E04, E10')})`);
}

console.log('=== "The Office S01E06, E09" queues E06 and E09, and nothing between ===');
{
  const { t, ctx, q, store } = await setUp();
  const m = await ask(ctx, 'The Office S01E06, E09');
  ok(labels(q).join() === 'The Office S01E06,The Office S01E09', `exactly E06 and E09 are queued (${labels(q).join()})`);
  ok(places(q).length === 1 && places(q)[0].label === 'The Office S01E06, E09',
    `one place in line, named by its codes (${places(q).map((e) => e.label).join()})`);
  const row = history(store)[0];
  ok(row?.detail === 'S01E06, E09 — 2 episode(s)' && row.request === 'The Office S01E06, E09' && row.episodes === 2,
    `History: "${row?.detail}", re-run as "${row?.request}"`);
  ok(t.notes().includes('🎬 The Office S01E06, E09 — 2 episode(s) — added to the queue'),
    `the notifications group is told which (${t.notes().join(' | ')})`);
  ok(t.on(m.id).join(' ') === '🔍 🎬 1️⃣', `it shows its place like any request (${t.on(m.id).join(' ')})`);
  ok(t.replies(m.id).length === 0, 'and nothing is missing, so nothing more is said');

  // The same episodes again, from another member, are a duplicate; a list
  // that overlaps them queues only the episode that is not waiting.
  const again = await ask(ctx, 'The Office s01 e06, e09');
  ok(t.on(again.id).includes('🤥') && labels(q).length === 2, `the same list again is a duplicate, not queued twice (${t.on(again.id).join(' ')})`);
  const overlap = await ask(ctx, 'The Office S01E05 & E06');
  ok(labels(q).join() === 'The Office S01E06,The Office S01E09,The Office S01E05',
    `"S01E05 & E06" with E06 waiting queues E05 alone (${labels(q).join()})`);
  ok(t.on(overlap.id).includes('🎬'), 'as a request of its own');
  await plugin.teardown();
}

console.log('=== "S01E04-E07, E09": a run and an episode in one list ===');
{
  const { t, ctx, q, store } = await setUp();
  await ask(ctx, 'The Office S01E04-E07, E09');
  ok(labels(q).join() === ['04', '05', '06', '07', '09'].map((n) => `The Office S01E${n}`).join(),
    `E04 to E07 and E09, not E08 (${labels(q).join()})`);
  ok(places(q)[0]?.label === 'The Office S01E04–E07, E09', `named "S01E04–E07, E09" (${places(q)[0]?.label})`);
  ok(history(store)[0]?.detail === 'S01E04–E07, E09 — 5 episode(s)', `History: "${history(store)[0]?.detail}"`);
  ok(t.notes().includes('🎬 The Office S01E04–E07, E09 — 5 episode(s) — added to the queue'), `notifications: ${t.notes().join(' | ')}`);
  await plugin.teardown();
}

console.log('=== a dash still queues the whole run ===');
{
  const { ctx, q } = await setUp();
  await ask(ctx, 'The Office S01E04-E10');
  ok(labels(q).length === 7 && labels(q)[0] === 'The Office S01E04' && labels(q)[6] === 'The Office S01E10',
    `"S01E04-E10" is all seven, E04 through E10 (${labels(q).join()})`);
  ok(places(q)[0]?.label === 'The Office S01E04–E10', `named as the run it is (${places(q)[0]?.label})`);
  await plugin.teardown();
}

console.log('=== a chain of dashes is one run, first to last ===');
{
  const { ctx, q, store } = await setUp();
  await ask(ctx, 'drake and josh S01 e03-e04-e05-e06-e07');
  ok(labels(q).join() === ['03', '04', '05', '06', '07'].map((n) => `Drake & Josh S01E${n}`).join(),
    `"drake and josh S01 e03-e04-e05-e06-e07" queues E03 through E07 (${labels(q).join()})`);
  ok(places(q)[0]?.label === 'Drake & Josh S01E03–E07', `named "S01E03–E07" (${places(q)[0]?.label})`);
  ok(history(store)[0]?.detail === 'S01E03–E07 — 5 episode(s)', `History: "${history(store)[0]?.detail}"`);
  await plugin.teardown();
}
{
  const { ctx, q } = await setUp();
  await ask(ctx, 'The Office S01E01-E02-E03, E05');
  ok(labels(q).join() === ['01', '02', '03', '05'].map((n) => `The Office S01E${n}`).join(),
    `"S01E01-E02-E03, E05" is E01 to E03 and E05 (${labels(q).join()})`);
  ok(places(q)[0]?.label === 'The Office S01E01–E03, E05', `named "S01E01–E03, E05" (${places(q)[0]?.label})`);
  await plugin.teardown();
}

console.log('=== an episode of the list the season does not have is named ===');
{
  const { t, ctx, q, store } = await setUp();
  const m = await ask(ctx, 'The Office S01E02, E30');
  ok(labels(q).join() === 'The Office S01E02', `what the server has goes in (${labels(q).join()})`);
  ok(t.replies(m.id).includes("📭 *The Office* — we don't have S01E30.\nSeason 1 on the server: episodes 1–10."),
    `the member is told E30 is not on the server, and what is (${t.replies(m.id).join(' | ')})`);
  ok(t.notes().includes('📭 The Office — "The Office" S01 has no episode 30'), `and the notifications group (${t.notes().join(' | ')})`);
  const row = history(store)[0];
  ok(row?.detail === 'S01E02 — 1 episode(s) · 1 not on the server: E30' && row.absent === '1 not on the server: E30',
    `History says why E30 never comes (${row?.detail})`);
  ok(t.on(m.id).includes('🎬') && !t.on(m.id).includes('📬'), `the request itself is queued (${t.on(m.id).join(' ')})`);
  ok(!(store.get('library-misses') ?? []).length, 'and it is not a request refused as not in the library');

  const none = await ask(ctx, 'The Office S01E20, E30');
  ok(t.on(none.id).includes('📬') && labels(q).length === 1, `a list the season has none of is not in the library (${t.on(none.id).join(' ')})`);
  ok(t.replies(none.id).some((r) => r.startsWith("📭 *The Office* — we don't have S01E20, E30.")),
    `and the reply names both, as a range's is named (${t.replies(none.id).join(' | ')})`);
  ok(t.notes().includes('📭 The Office — "The Office" S01 has no episodes 20 and 30'), `notifications: ${t.notes().at(-1)}`);
  await plugin.teardown();
}

console.log('=== a list counts toward maxEpisodesPerRequest like a range ===');
{
  const { ctx, q, store } = await setUp({ tv: { maxEpisodesPerRequest: 2 } });
  await ask(ctx, 'The Office S01E01, E03, E05');
  ok(labels(q).join() === 'The Office S01E01,The Office S01E03', `two of the three, in order (${labels(q).join()})`);
  ok(history(store)[0]?.episodes === 2, 'and History counts the two');
  await plugin.teardown();
}

console.log('=== typed into the panel, or a History row re-run, a list queues the same ===');
{
  const { ctx, q, store } = await setUp();
  const r = await plugin.requeue('The Office S01E06, E09', ctx);
  ok(r.queued === 2 && r.scope === 'S01E06, E09' && labels(q).join() === 'The Office S01E06,The Office S01E09',
    `the panel queues E06 and E09 (${r.queued}, "${r.scope}", ${labels(q).join()})`);
  ok(history(store)[0]?.request === 'The Office S01E06, E09', 'and its row re-runs the same list');
  const part = await plugin.requeue('The Office S01E01, E30', ctx);
  ok(part.queued === 1 && part.notQueued?.join() === 'S01E30: not on the server',
    `an episode the season lacks is named where the panel says what did not go in (${part.notQueued?.join()})`);
  let threw = null;
  try { await plugin.requeue('The Office S01E20, E30', ctx); } catch (err) { threw = err; }
  ok(/The Office has none of S01E20, E30/.test(threw?.message ?? ''), `none of it there: refused, naming them (${threw?.message})`);
  await plugin.teardown();
}

console.log('=== with no season, "which season?" keeps the list in its example ===');
{
  seasons = 2;
  try {
    const { t, ctx, q } = await setUp();
    const m = await ask(ctx, 'The Office episodes 3, 5');
    ok(t.on(m.id).includes('📺') && !labels(q).length, `asked which season (${t.on(m.id).join(' ')})`);
    const reply = t.replies(m.id)[0] ?? '';
    ok(reply.includes('*#request The Office S01E03, E05*'), `the example asks for those two, not the run between them (${reply})`);
    const back = parseTvRequest('The Office S01E03, E05');
    ok(back.season === 1 && back.episodeList?.join() === '3,5', 'and reads back as exactly those episodes of season 1');
    await plugin.teardown();
  } finally {
    seasons = 1;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
