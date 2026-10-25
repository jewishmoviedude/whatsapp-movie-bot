/* A TV request written wrong is answered ✍️, not "not in the library".
   Run: node test/tv-request-written-wrong.test.mjs

   Jake Brown typed the next part of Georgie & Mandy's First Marriage as
   "SO1E11-E20", the letter O for the zero (2026-10-18). No code was read, the
   whole text was searched as a show name, and he was answered 📬 - so he and
   Head Admin went looking for whether the episodes existed ("Do those episodes
   exist? I noticed a lot of the things people request don't even exist").
   The O is read as a zero since 94888e9; the operator, 2026-10-19: "in the
   future when someone makes an improper request bot should react with a new
   emoji for "request not written properly" (you make up a new emoji for me)".
   ✍️ - write it again. Given only when no show has the name and the name
   still holds a code the bot could not read, or there is no show name at
   all; a show the server lacks is still 📬, and a written-wrong request is
   not put on the not-in-library list. These run the real plugin. */
import plugin from '../src/plugins/tv-requests/index.js';
import { JobQueue } from '../src/core/queue.js';
import { parseTvRequest, codeLeftIn } from '../src/plugins/tv-requests/parse.js';
import { DEFAULT_CONFIG } from '../src/config/schema.js';
import { reactionKind } from '../src/media/reaction-class.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const settle = () => new Promise((r) => setTimeout(r, 5));

const TVREQ = 'tvreq@g.us';
const NOTIFY = 'notify@g.us';
const R = { ...DEFAULT_CONFIG.movieRequests.reactions };

console.log('=== what is left of a code in a show name ===');
{
  const left = (t) => codeLeftIn(parseTvRequest(t).show);
  for (const [t, want] of [['the American so1eo1', 'so1eo1'], ['Fauda S01eo1-e5', 'S01eo1'], ['Georgie & Mandy SO1E11-E20', 'SO1E11'], ['the rookie sO8', 'sO8'], ['Rookie s1e', 's1e'], ['the rookie se01ep05', 'se01ep05'], ['the rookie s1e5e6', 's1e5e6'],
    ['the rookie 8th season', '8th season'], ['rookie 1x', '1x'], ['S01E05', 'S01E05']]) {
    ok(left(t) === want, `"${t}" leaves "${left(t)}"`);
  }
  for (const t of ['The Rookie S01E05', 's.w.a.t. s1', 'Se7en', 'Hunting Season', '24', '1883', 'The 4400', 'Episodes', 'Soe', '9-1-1']) {
    ok(left(t) === null, `"${t}" leaves nothing (${JSON.stringify(parseTvRequest(t).show)})`);
  }
  ok(R.writtenWrong === '✍️', 'the reaction is ✍️ by default');
  ok(reactionKind(R, R.writtenWrong) === 'critical', 'and it is the last word on a request, never shed');
}

const SERIES = { Items: [{ Id: 'OFF', Name: 'The Office', ProductionYear: 2005, OfficialRating: 'TV-14', RecursiveItemCount: 10 }] };
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const json = (v) => ({ ok: true, status: 200, json: async () => v });
  if (u.pathname.endsWith('/Seasons')) return json({ Items: [{ Id: 'S1', IndexNumber: 1, ChildCount: 10 }] });
  if (u.pathname.endsWith('/Episodes')) {
    return json({ Items: Array.from({ length: 10 }, (_, i) => ({ Id: `E${i + 1}`, SeriesName: 'The Office', ParentIndexNumber: 1, IndexNumber: i + 1, Name: `Ep ${i + 1}`, MediaSources: [{ Path: `/o${i}.mkv`, Size: 1 }] })) });
  }
  if (u.pathname.endsWith('/Items') || u.pathname.endsWith('/Search/Hints')) return json(SERIES);
  return { ok: false, status: 404, statusText: 'NF', json: async () => ({}) };
};
plugin.deliverEpisode = async () => new Promise(() => {});

const calls = [];
const texts = [];
const store = new Map();
await plugin.teardown();
const q = new JobQueue({ concurrency: 1, maxLength: 50 });
q.pause();
const ctx = {
  config: {
    tvRequests: { enabled: true, requestGroups: [TVREQ], postsGroups: ['tvposts@g.us'], cooldownSecondsPerUser: 0 },
    movieRequests: { reactions: R, notify: { group: NOTIFY } },
    beta: { groups: [], postsGroup: '', features: {} },
    library: { jellyfin: { baseUrl: 'http://jf:8096', accessToken: 'TOK', userId: 'U1' } },
    media: { workDir: '/tmp/tv-written-wrong-test' },
  },
  bot: {
    isConnected: () => true, _bulkPace: async () => {}, isGroupAdmin: () => false, deleteMessage: async () => {}, archiveChat: async () => {},
    sendText: async (jid, text) => { texts.push({ jid, text }); return { key: { id: 'n' } }; },
    react: async (msg, emoji) => { calls.push({ id: msg.id, emoji }); return true; },
  },
  queue: q,
  store: { get: (k, d) => (store.has(k) ? structuredClone(store.get(k)) : d), set: (k, v) => store.set(k, structuredClone(v)) },
  log: { info() {}, warn() {}, error() {}, debug() {} },
};
await plugin.setup(ctx);
let seq = 0;
const ask = async (text) => {
  const id = `m${++seq}`;
  await plugin.onMessage({
    id, key: { id, remoteJid: TVREQ }, text, chatJid: TVREQ, isGroup: true, fromMe: false, messageType: 'conversation',
    senderJid: `u${seq}@lid`, senderNumber: `1555111${String(seq).padStart(4, '0')}`, pushName: 'Jake', timestamp: Date.now(),
  }, ctx);
  await settle();
  return calls.filter((c) => c.id === id).map((c) => c.emoji);
};
const misses = () => (store.get('library-misses') ?? []).length;

console.log('=== in the TV group ===');
{
  const a = await ask('Georgie and Mandys first marriage s1e');
  ok(a.at(-1) === '✍️' && !a.includes('📬'), `a code the bot cannot read: ✍️ (${a.join(' ')})`);
  const b = await ask('S01E05');
  ok(b.at(-1) === '✍️', `a code with no show: ✍️ (${b.join(' ')})`);
  ok(misses() === 0, 'neither is put on the not-in-library list');
  const c = await ask('Georgie and Mandys first marriage S01E11-E20');
  ok(c.at(-1) === '📬', `written right, a show the server lacks is still 📬 (${c.join(' ')})`);
  ok(misses() === 1, 'and is on the not-in-library list');
  // Hank, 2026-10-19: "the American so1eo1" was queued. A show the server
  // has, written with the letter O for the zero, is ✍️ before any lookup.
  const d = await ask('The Office SO1E03');
  ok(d.at(-1) === '✍️' && !d.includes('🎬'), `the letter O for the zero, on a show the server has: ✍️, nothing queued (${d.join(' ')})`);
  ok(q.pending.length === 0, 'the queue is empty');
  const e = await ask('The Office S01E03');
  ok(e.includes('🎬'), `written right, it is queued (${e.join(' ')})`);
}

await plugin.teardown();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
