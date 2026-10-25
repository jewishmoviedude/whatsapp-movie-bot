/* "season N" with a bare "e" after it is episodes of season N, never the whole season.
   Run: node test/tv-season-word-then-bare-e.test.mjs

   Ari's "#request avatar:the last Airbender 2005 season 1 e1-10" (2026-10-07
   19:19 UTC) posted all twenty episodes of season 1, and Marty's "Americas
   Got Talent season 21 E14-23" the same day all twenty-three. "season N"
   was read with an episode only when "episode" or "ep" followed it; a bare
   "e" did not count, so the request was the season. With the episode cap at
   ten (found in review, 2026-10-12), "Outer Banks season 5 e5, e7", "season
   5 e3-e4", "season 5, e6" and "season 5 - episodes 3, 5" each queued
   S05E01-E10. The operator's rule (2026-10-12): "if it's a dash it's 4
   through 10, comma then it'll only be those 2".

   Now a bare "e" after "season N" is an episode, as it is after "S05", and
   a list with no season of its own right after "season N" is that season's,
   with the season taken off the show's name. These run the real plugin
   against the real queue, with each episode's work replaced by a gate that
   never opens. */
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

// Five seasons of twenty episodes each, for both shows.
const SHOWS = { OB: 'Outer Banks', AV: 'Avatar: The Last Airbender' };
const SERIES = { Items: [
  { Id: 'OB', Name: 'Outer Banks', ProductionYear: 2020, OfficialRating: 'TV-14', RecursiveItemCount: 100 },
  { Id: 'AV', Name: 'Avatar: The Last Airbender', ProductionYear: 2005, OfficialRating: 'TV-Y7', RecursiveItemCount: 100 },
] };
const SEASONS = 5;
const PER_SEASON = 20;
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const json = (v) => ({ ok: true, status: 200, json: async () => v });
  const show = u.pathname.match(/\/Shows\/([^/]+)\//)?.[1];
  if (u.pathname.endsWith('/Seasons')) {
    return json({ Items: Array.from({ length: SEASONS }, (_, i) => ({ Id: `${show}S${i + 1}`, IndexNumber: i + 1, ChildCount: PER_SEASON })) });
  }
  if (u.pathname.endsWith('/Episodes')) {
    const season = Number(u.searchParams.get('season') ?? 1);
    return json({
      Items: season > SEASONS ? [] : Array.from({ length: PER_SEASON }, (_, i) => i + 1).map((n) => ({
        Id: `${show}S${season}E${n}`, SeriesName: SHOWS[show], ParentIndexNumber: season, IndexNumber: n,
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
      tvRequests: {
        enabled: true, requestGroups: [TVREQ], postsGroups: ['tvposts@g.us'], cooldownSecondsPerUser: 0,
        blockedRatings: ['TV-MA'], maxEpisodesPerRequest: 10, ...tv,
      },
      movieRequests: { reactions: R, notify: { group: NOTIFY } },
      beta: { groups: [], postsGroup: '', features: {} },
      library: { jellyfin: { baseUrl: 'http://jf:8096', accessToken: 'TOK', userId: 'U1' } },
      media: { workDir: '/tmp/tv-season-word-then-bare-e-test' },
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
    senderJid: `u${seq}@lid`, senderNumber: `1555222${String(seq).padStart(4, '0')}`, pushName: 'Ari', timestamp: Date.now(),
  };
  await plugin.onMessage(m, ctx);
  await settle();
  return m;
};
const codes = (q) => q.pending.filter((e) => e.kind === 'tv').map((e) => e.label.replace(/^.* (S\d+E\d+)$/, '$1'));
const range = (from, to, season) => Array.from({ length: to - from + 1 }, (_, i) => `S${String(season).padStart(2, '0')}E${String(from + i).padStart(2, '0')}`);

console.log('=== the parse: "season N" then a bare "e" ===');
{
  const read = (t) => {
    const p = parseTvRequest(t);
    const what = p.episodeList ? p.episodeList.join(',') : p.episodeRange ? `${p.episodeRange.from}-${p.episodeRange.to}` : String(p.episode);
    return `${p.show} | ${p.season} | ${what}`;
  };
  for (const [text, want] of [
    ['avatar:the last Airbender 2005 season 1 e1-10', 'avatar:the last Airbender 2005 | 1 | 1-10'],
    ['Americas Got Talent season 21 E14-23', 'Americas Got Talent | 21 | 14-23'],
    ['Outer Banks season 5 e5, e7', 'Outer Banks | 5 | 5,7'],
    ['Outer Banks season 5 e3-e4', 'Outer Banks | 5 | 3-4'],
    ['Outer Banks season 5, e6', 'Outer Banks | 5 | 6'],
    ['Outer Banks season 5 e6', 'Outer Banks | 5 | 6'],
    ['Outer Banks season 5,e6', 'Outer Banks | 5 | 6'],
    ['Outer Banks season 5,e3-e4', 'Outer Banks | 5 | 3-4'],
    ['Outer Banks season 5 - episodes 3, 5', 'Outer Banks | 5 | 3,5'],
    ['Outer Banks season 5 - e6', 'Outer Banks | 5 | 6'],
    ['Outer Banks series 5: e3-e4-e5', 'Outer Banks | 5 | 3-5'],
    ['The Boys season 2 episodes 5', 'The Boys | 2 | 5'],
  ]) ok(read(text) === want, `"${text}" -> ${want} (${read(text)})`);
  // What it never was: a season alone, a season list, or a title with a number.
  for (const [text, want] of [
    ['Outer Banks season 5', 'Outer Banks | 5 | null'],
    ['Stranger Things 4 episode 3', 'Stranger Things 4 | null | 3'],
    ['The Boys season 2, episode 5', 'The Boys | 2 | 5'],
  ]) ok(read(text) === want, `"${text}" is still ${want} (${read(text)})`);
  const two = parseTvRequest('The Office season 1 and 2');
  ok(JSON.stringify(two.seasons) === '[1,2]', '"season 1 and 2" is still two seasons');
  const many = parseTvRequest('The Office seasons 1-3 episodes 2, 4');
  ok(JSON.stringify(many.seasons) === '[1,2,3]' && !many.episodeList, 'and a list after several seasons names no one season, as before');
}

console.log('=== the incident: "season 1 e1-10" queues ten episodes, not the season\'s twenty ===');
{
  // No episode cap, as on 2026-10-07.
  const { t, ctx, q, store } = await setUp({ tv: { maxEpisodesPerRequest: 0 } });
  const m = await ask(ctx, 'avatar:the last Airbender 2005 season 1 e1-10');
  ok(codes(q).join() === range(1, 10, 1).join(), `E01 to E10 of season 1 (${codes(q).length}: ${codes(q).join()})`);
  ok(q.snapshot().pending[0]?.label === 'Avatar: The Last Airbender S01E01–E10', `named as the run (${q.snapshot().pending[0]?.label})`);
  ok(store.get('history')?.[0]?.detail === 'S01E01–E10 — 10 episode(s)', `History: "${store.get('history')?.[0]?.detail}"`);
  ok(t.on(m.id).includes('🎬'), `queued (${t.on(m.id).join(' ')})`);
  await plugin.teardown();
}

console.log('=== with the cap at ten, each asks for what it names, not S05E01-E10 ===');
for (const [text, want] of [
  ['Outer Banks season 5 e5, e7', ['S05E05', 'S05E07']],
  ['Outer Banks season 5 e3-e4', ['S05E03', 'S05E04']],
  ['Outer Banks season 5, e6', ['S05E06']],
  ['Outer Banks season 5 - episodes 3, 5', ['S05E03', 'S05E05']],
]) {
  const { ctx, q } = await setUp();
  await ask(ctx, text);
  ok(codes(q).join() === want.join(), `"${text}" queues ${want.join(', ')} (${codes(q).join()})`);
  await plugin.teardown();
}
{
  const { ctx, q } = await setUp();
  await ask(ctx, 'Outer Banks season 5');
  ok(codes(q).join() === range(1, 10, 5).join(), `"Outer Banks season 5" is still the season, to the cap (${codes(q).join()})`);
  await plugin.teardown();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
