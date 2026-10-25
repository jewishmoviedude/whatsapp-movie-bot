/* A list of episodes names what it could not take, and takes a lower number after a comma.
   Run: node test/tv-list-names-what-it-could-not-take.test.mjs

   Found in review, 2026-10-12, after a comma list became "only those"
   (test/tv-comma-list-queues-only-those-episodes.test.mjs): parts of a list
   were still dropped without a word. "Outer Banks S05E06, S06E01" queued
   S05E06 alone - one request is one season - and nobody said S06E01 had not
   gone in; "S05E10, 9" queued E10 alone, a bare number being read only
   going forwards; "S01E07-E04, E09" queued S01E07 alone, the backwards run
   ending the list. The member saw 🎬 and had no way to know.

   Now a bare lower number after a comma, "&" or "and" is one more episode
   when the list goes on or ends with it ("S01E06 and 2 more" is still one
   episode), and what a list named from an episode it could not take to its
   end is answered: a quoted reply naming it, to be asked for on its own, a
   line in the notifications group, and on the History row. The rest of the
   request goes on as it always did. These run the real plugin against the
   real queue, with each episode's work replaced by a gate that never opens. */
import plugin from '../src/plugins/tv-requests/index.js';
import directLinks from '../src/plugins/direct-links/index.js';
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

// The Office: two seasons of ten episodes each.
const SERIES = { Items: [{ Id: 'OFF', Name: 'The Office', ProductionYear: 2005, OfficialRating: 'TV-14', RecursiveItemCount: 20 }] };
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const json = (v) => ({ ok: true, status: 200, json: async () => v });
  if (u.pathname.endsWith('/Seasons')) {
    return json({ Items: [1, 2].map((s) => ({ Id: `S${s}`, IndexNumber: s, ChildCount: 10 })) });
  }
  if (u.pathname.endsWith('/Episodes')) {
    const season = Number(u.searchParams.get('season') ?? 1);
    return json({
      Items: season > 2 ? [] : Array.from({ length: 10 }, (_, i) => i + 1).map((n) => ({
        Id: `S${season}E${n}`, SeriesName: 'The Office', ParentIndexNumber: season, IndexNumber: n,
        Name: `Ep ${n}`, MediaSources: [{ Path: `/s${season}e${n}.mkv`, Size: n }],
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
  t.replies = (id) => t.texts.filter((x) => x.jid === TVREQ && x.to === id).map((x) => x.text);
  return t;
}

// Nothing is downloaded: every episode waits in the paused queue.
plugin.deliverEpisode = async () => new Promise(() => {});

async function setUp() {
  await plugin.teardown();
  const store = new Map();
  const t = fakeBot();
  const q = new JobQueue({ concurrency: 1, maxLength: 50 });
  q.pause();
  const ctx = {
    config: {
      tvRequests: { enabled: true, requestGroups: [TVREQ], postsGroups: ['tvposts@g.us'], cooldownSecondsPerUser: 0, blockedRatings: ['TV-MA'] },
      movieRequests: { reactions: R, notify: { group: NOTIFY } },
      beta: { groups: [], postsGroup: '', features: {} },
      library: { jellyfin: { baseUrl: 'http://jf:8096', accessToken: 'TOK', userId: 'U1' } },
      media: { workDir: '/tmp/tv-list-unread-test' },
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
    senderJid: `u${seq}@lid`, senderNumber: `1555333${String(seq).padStart(4, '0')}`, pushName: 'Aiden', timestamp: Date.now(),
  };
  await plugin.onMessage(m, ctx);
  await settle();
  return m;
};
const labels = (q) => q.pending.filter((e) => e.kind === 'tv').map((e) => e.label.replace(/^The Office /, ''));

console.log('=== the parse ===');
{
  const read = (t) => {
    const p = parseTvRequest(t);
    const what = p.episodeList ? p.episodeList.join(',') : p.episodeRange ? `${p.episodeRange.from}-${p.episodeRange.to}` : String(p.episode);
    return `${p.season}:${what}${p.unread ? ` unread ${p.unread.join(', ')}` : ''}`;
  };
  for (const [text, want] of [
    // Another season's episode, and the rest of the list after it.
    ['Outer Banks S05E06, S06E01', '5:6 unread S06E01'],
    ['Outer Banks S05E06, S06E01-E03', '5:6 unread S06E01–E03'],
    ['The Office S01E06, S02E09, E10', '1:6 unread S02E09, E10'],
    ['The Office S01E04, E05, S02E01', '1:4-5 unread S02E01'],
    ['The Office S01E20-S02E03', '1:20 unread S02E03'],
    ['The Office S01E03-E04-S02E05', '1:3-4 unread S02E05'],
    // A run typed backwards, and what follows it.
    ['Outer Banks S01E07-E04, E09', '1:7 unread S01E04, E09'],
    ['The Office S01E09 E06', '1:9 unread S01E06'],
    // A bare lower number after a comma, "&" or "and" is one more episode.
    ['Outer Banks S05E10, 9', '5:9-10'],
    ['The Office S01E10 & 8', '1:8,10'],
    ['The Office S01E10, 8, 6', '1:6,8,10'],
    ['Outer Banks S05E10, 9 please', '5:9-10'],
  ]) ok(read(text) === want, `"${text}" -> ${want} (${read(text)})`);
  // Nothing to name: a title, a word, a clock time, or an episode the run took.
  for (const [text, want] of [
    ['The Office S01E06 and 2 more', '1:6'],
    ['Lost S01E05 3 Days Later', '1:5'],
    ['Lost S01E01-E02 - 3 Days Later', '1:1-2'],
    ['24 S01E02, 1:00 A.M.', '1:2'],
    ['The Office S01E03-E05-E04', '1:3-5'],
    ['The Office S01E06, E06', '1:6'],
    ['The Office S01E06, E09', '1:6,9'],
  ]) ok(read(text) === want, `"${text}" -> ${want}, nothing unread (${read(text)})`);
}

console.log('=== another season\'s episode is named to the member, and the rest goes in ===');
{
  const { t, ctx, q, store } = await setUp();
  const m = await ask(ctx, 'The Office S01E06, S02E01');
  ok(labels(q).join() === 'S01E06', `S01E06 is queued, and nothing of season 2 (${labels(q).join()})`);
  ok(t.on(m.id).includes('🎬'), `the request itself is queued (${t.on(m.id).join(' ')})`);
  ok(t.replies(m.id).includes("⚠️ *The Office* — S02E01 wasn't added: one request is one season, its episodes in order. Please ask for it on its own."),
    `the member is told S02E01 was not added, and to ask for it on its own (${t.replies(m.id).join(' | ')})`);
  ok(t.notes().includes('⚠️ The Office — S02E01 not added: one request is one season, its episodes in order'),
    `and the notifications group (${t.notes().join(' | ')})`);
  const row = (store.get('history') ?? []).find((h) => h.id === m.id);
  ok(row?.unread === 'S02E01' && row.status === 'queued', `the History row says so (${JSON.stringify({ unread: row?.unread, status: row?.status })})`);
  await plugin.teardown();
}

console.log('=== a run typed backwards: what follows it is named too ===');
{
  const { t, ctx, q } = await setUp();
  const m = await ask(ctx, 'The Office S01E07-E04, E09');
  ok(labels(q).join() === 'S01E07', `S01E07 is queued (${labels(q).join()})`);
  ok(t.replies(m.id).includes("⚠️ *The Office* — S01E04, E09 weren't added: one request is one season, its episodes in order. Please ask for them on their own."),
    `E04 and E09 are named (${t.replies(m.id).join(' | ')})`);
  await plugin.teardown();
}

console.log('=== "S01E10, 9" is both episodes ===');
{
  const { t, ctx, q } = await setUp();
  const m = await ask(ctx, 'The Office S01E10, 9');
  ok(labels(q).join() === 'S01E09,S01E10', `E09 and E10 (${labels(q).join()})`);
  ok(t.replies(m.id).length === 0, 'and nothing is left to say');
  await plugin.teardown();
}

console.log('=== a list it reads whole says nothing more ===');
{
  const { t, ctx, store } = await setUp();
  const m = await ask(ctx, 'The Office S01E06, E09');
  ok(t.replies(m.id).length === 0 && !t.notes().some((n) => /not added/.test(n)), 'no reply, no line');
  ok(!('unread' in ((store.get('history') ?? []).find((h) => h.id === m.id) ?? {})), 'and nothing on the row');
  await plugin.teardown();
}

console.log('=== the direct-links group names them too ===');
{
  const sent = [];
  const ctx = {
    config: {
      directLinks: { enabled: true, groups: ['links@g.us'], apiKey: 'K', movieCommand: '#request-movie', tvCommand: '#request-tv' },
      library: { jellyfin: { baseUrl: 'https://jf', accessToken: 'TOK', userId: 'U1' } },
    },
    bot: { sendText: async (j, txt) => { sent.push(txt); return {}; } },
    linkQueue: { add: (j) => j.run({ isCancelled: () => false }) },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  };
  await directLinks.onMessage({ text: '#request-tv The Office S01E06, S02E01', chatJid: 'links@g.us', isGroup: true, fromMe: false, messageType: 'conversation' }, ctx);
  await settle();
  const links = [...sent.join('\n').matchAll(/\/Videos\/(S\dE\d+)\//g)].map((x) => x[1]).join();
  ok(links === 'S1E6', `a link to S01E06 alone (${links})`);
  ok(sent.at(-1) === "⚠️ No link for S02E01 of *The Office*: one request is one season, its episodes in order. Please ask for it on its own.",
    `and S02E01 is named (${sent.at(-1)})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
