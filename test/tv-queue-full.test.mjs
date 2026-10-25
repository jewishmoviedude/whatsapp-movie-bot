/* A full queue must not swallow the rest of a season.
   Run: node test/tv-queue-full.test.mjs

   Six real errors one night: "plugin tv-requests onMessage error: Queue is
   full (50 waiting)". The episodes were added in a forEach, so QUEUE_FULL threw
   part way through - the first few landed, the rest were dropped on the floor,
   and the requester was told nothing at all. The error appeared only in the log.
   From the group it looked like the bot had simply lost half a season.

   The first fix took what fitted and said so. Since then the queue counts
   REQUESTS, not episodes (test/queue-requests.test.mjs): a season needs one
   free place and goes in whole, or - when there is none - is refused whole,
   out loud. There is no half-season left to explain. */
import fs from 'node:fs';
import plugin from '../src/plugins/tv-requests/index.js';
import { JobQueue } from '../src/core/queue.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const src = fs.readFileSync(new URL('../src/plugins/tv-requests/index.js', import.meta.url), 'utf8');

const EPISODES = Array.from({ length: 23 }, (_, i) => ({
  Id: `E${i + 1}`, SeriesName: 'The Mentalist', ParentIndexNumber: 1, IndexNumber: i + 1, Name: `Ep ${i + 1}`,
  MediaSources: [{ Path: `/e${i + 1}.mkv`, Size: 1 }],
}));
const ROUTES = {
  '/Items': { Items: [{ Id: 'SER1', Name: 'The Mentalist', ProductionYear: 2008 }] },
  '/Seasons': { Items: [{ Id: 'S1', IndexNumber: 1 }] },
  '/Episodes': { Items: EPISODES },
};
globalThis.fetch = async (url) => {
  for (const [k, v] of Object.entries(ROUTES)) {
    if (String(url).includes(k)) return { ok: true, status: 200, json: async () => v };
  }
  return { ok: false, status: 404, statusText: 'NF', json: async () => ({}) };
};

/** The real queue, paused, with `waiting` films already in line. */
function ctxWith(maxLength, waiting) {
  const queue = new JobQueue({ concurrency: 1, maxLength });
  queue.pause();
  for (let i = 0; i < waiting; i++) queue.add({ label: `Film ${i}`, run: async () => {} });
  const store = new Map();
  const reacted = [];
  const notes = [];
  return {
    queue, store, reacted, notes,
    ctx: {
      config: {
        tvRequests: { enabled: true, requestGroups: ['tv@g.us'], postsGroups: ['posts@g.us'], cooldownSecondsPerUser: 0 },
        movieRequests: { reactions: { researching: '🔍', added: '🎬', failed: '⚠️' }, notify: { group: 'n@g.us' } },
        library: { jellyfin: { baseUrl: 'http://jf', accessToken: 'T', userId: 'U' } },
        media: { workDir: '/tmp/tv-queue-full' },
      },
      bot: {
        react: async (m, e) => { reacted.push(e); return true; }, isConnected: () => true,
        sendText: async (j, t) => { notes.push(t); }, isGroupAdmin: () => false,
      },
      queue,
      store: { get: (k, d) => (store.has(k) ? store.get(k) : d), set: (k, v) => store.set(k, v) },
      log: { info() {}, warn() {}, error() {}, debug() {} },
    },
  };
}
const msg = { id: 'm1', key: { id: 'm1' }, text: 'The Mentalist season 1', chatJid: 'tv@g.us', isGroup: true, fromMe: false,
  senderJid: 'u@lid', senderNumber: '1555', messageType: 'conversation' };

console.log('=== the incident: 23 episodes, 8 free places ===');
{
  const { ctx, queue, reacted, notes } = ctxWith(50, 42);
  await plugin.onMessage(msg, ctx);
  ok(queue.pending.length === 42 + 23, `all 23 episodes were queued (${queue.pending.length - 42}), none dropped`);
  ok(queue.waitingCount() === 43, `taking ONE of the 8 free places (${queue.waitingCount()} of 50 waiting)`);
  ok(reacted.includes('🎬') && !reacted.includes('⚠️'), 'the requester sees it accepted');
  ok(!notes.some((n) => /full/i.test(n)), 'and nobody is told to ask again for the rest');
}

console.log('=== a queue with no place left refuses the season whole, and says so ===');
{
  const { ctx, queue, reacted, notes, store } = ctxWith(50, 50);
  await plugin.onMessage({ ...msg, id: 'm2' }, ctx);
  ok(queue.pending.length === 50, 'nothing was added');
  ok(reacted.includes('⚠️') && !reacted.includes('🎬'), 'the requester sees it refused');
  ok(notes.some((n) => /the queue is full right now/.test(n) && /Nothing was added; please ask again once it clears/.test(n)),
    'and the notifications group says why, and what to do');
  ok(!(store.get('pending') ?? []).length && !(store.get('history') ?? []).length,
    'no journal entry or History row claims a season that never went in');
}

console.log('=== the source says what the tests above show ===');
{
  ok(/if \(!this\._hasRoom\(ctx\)\) \{/.test(src), 'room is checked for one request, before anything is written');
  // Plus the places of requests held while a restart is recovered, which
  // go in together with the old ones when it ends (_holdForRecovery).
  ok(/return ctx\.queue\.hasRoom\(1 \+ held\);/.test(src), 'one place, however many episodes');
  ok(!/const noRoomFor/.test(src) && !/capped\.slice\(0, room\)/.test(src), 'no season is cut to fit any more');
  // Nothing may take the last place between the check and the adds.
  const region = src.slice(src.indexOf('if (!this._hasRoom(ctx)) {'), src.indexOf('const accepted = [];'));
  ok(!/\n    await /.test(region.slice(region.indexOf('return;'))), 'nothing is awaited between the check and the adds');
}

console.log('=== a lost race still cannot leave half a request, or a silent one ===');
{
  // The check leaves no gap, but a queue can be wired differently. Only the
  // first episode can be refused - the rest join a request already counted -
  // and if it is, the request is refused whole, out loud.
  const loop = src.match(/const accepted = \[\];[\s\S]*?\n    \}\n/)[0];
  ok(/try \{/.test(loop) && /catch \(err\)/.test(loop), 'each add is guarded');
  ok(/if \(err\.code !== 'QUEUE_FULL'\) throw err;/.test(loop), 'and only QUEUE_FULL is swallowed — a real bug still surfaces');
  ok(/accepted\.push\(ep\)/.test(loop), 'what actually landed is tracked');
  ok(/if \(!accepted\.length\) \{[\s\S]*?this\._journalDrop\(ctx, reqKey\)[\s\S]*?status: 'failed'[\s\S]*?the queue is full right now/.test(src),
    'nothing landed: the journal entry goes, History says so, and so does the group');
  ok(/if \(accepted\.length !== queueing\.length\) \{[\s\S]*?notifier\?\.episodeCancelled\(\)[\s\S]*?episodes: accepted,/.test(src),
    'part landed: the notifier and the journal are corrected to it');

  // Proved against a queue that refuses the first add.
  const { ctx, store, reacted, notes } = ctxWith(50, 0);
  ctx.queue.hasRoom = () => true;                 // the check passes...
  const add = ctx.queue.add.bind(ctx.queue);
  ctx.queue.add = () => { throw ctx.queue.fullError(); };   // ...and the add is refused
  await plugin.onMessage({ ...msg, id: 'm3' }, ctx);
  ctx.queue.add = add;
  ok(!(store.get('pending') ?? []).length, 'the journal holds nothing to resurrect on restart');
  ok(store.get('history')?.[0]?.status === 'failed', `History says it failed (${store.get('history')?.[0]?.status})`);
  ok(reacted.at(-1) === '⚠️' && notes.some((n) => /queue is full/.test(n)), 'and the requester and the group are told');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
