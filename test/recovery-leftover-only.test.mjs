/* Start-up recovery replays only what the last process left, so nothing is queued twice.
   Run: node test/recovery-leftover-only.test.mjs

   Both plugins recover on the first 'connected' event, and they used to take
   the journal as it stood at that moment. Anything this process journalled
   between setup and the connect was replayed as a leftover as well:

   - A film queued from the panel in the seconds after a restart fails its
     first run with "WhatsApp is not connected" and books its own retry, 30 s
     out. The connect came first (restarts on 2026-09-28 connected within
     2-16 s: 19:48:11 -> 19:48:13, 06:41:44 -> 06:42:00), recovery queued the
     film, and then the retry queued it again: two runs, two posts.
   - A TV request typed into the panel before the connect journals and queues
     itself, and recovery queued every one of its episodes a second time. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import tvPlugin from '../src/plugins/tv-requests/index.js';
import { RetryBook } from '../src/media/resume.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'leftover-work-'));
const LIB = fs.mkdtempSync(path.join(os.tmpdir(), 'leftover-lib-'));
fs.writeFileSync(path.join(LIB, 'Spaceballs 1987.mp4'), 'x');
fs.writeFileSync(path.join(LIB, 'Men in Black 1997.mp4'), 'x');

function fakeBot() {
  const bot = new EventEmitter();
  bot.connected = false;
  bot.isConnected = () => bot.connected;
  bot.react = async () => true;
  bot.sendText = async () => ({});
  bot.groups = () => [];
  bot.groupMemberInfo = () => ({ isMember: false });
  bot.connect = () => { bot.connected = true; bot.emit('state', { state: 'connected' }); };
  return bot;
}

function fakeStore(data = {}) {
  return {
    get: (k, d = null) => (k in data ? data[k] : d),
    set: (k, v) => { data[k] = v; },
    push: (k, v) => { (data[k] ??= []).unshift(v); },
    data,
  };
}

function fakeQueue() {
  const q = Object.assign(new EventEmitter(), {
    maxLength: 104, pending: [], active: new Map(), history: [], added: [],
    add(job, opts = {}) {
      const id = `q${q.added.length + 1}`;
      q.added.push({ job, opts, id });
      q.pending.push({ id, ...job, kind: job.kind ?? 'movie', meta: job.meta ?? {} });
      return id;
    },
    moveTop() { return true; },
  });
  return q;
}

const log = { info() {}, warn() {}, error() {}, debug() {} };

function film(id, title, year, imdbId) {
  const record = { id, request: title.toLowerCase(), status: 'queued', title, year, rated: 'PG' };
  return {
    jobKey: `${id}:${imdbId}`, msgId: id, msgKey: null, chatJid: 'posts@g.us',
    movie: { title, year, imdbId, rated: 'PG' }, meta: {}, record, at: Date.now(),
  };
}

console.log('=== a film journalled before the first connect is queued once ===');
{
  const bot = fakeBot();
  const store = fakeStore();
  const queue = fakeQueue();
  const ctx = {
    bot, store, queue, log, configStore: { update() {} },
    config: {
      movieRequests: { rules: 'x', reactions: { redo: '🔄' }, notify: {}, blockedRatings: ['R'] },
      media: { workDir: WORK }, library: { provider: 'local', local: { roots: [LIB] } }, omdb: {},
    },
  };
  // Left by the last process: this one must come back.
  const old = film('MSG-old', 'Men in Black', 1997, 'tt0119654');
  store.set('pending', [old]);

  await moviePlugin.setup(ctx);                     // not connected: recovery waits for 'connected'
  moviePlugin._retries = new RetryBook({ delayMs: () => 100, log });   // stands in for the real 30 s

  // Queued from the panel while the bot connects; its first run fails fast.
  const fresh = film('manual-1', 'Spaceballs', 1987, 'tt0094012');
  moviePlugin._journalAdd(ctx, fresh);
  const job = { id: 'j1', signal: new AbortController().signal, progress() {}, isCancelled: () => false, cancelReason: () => null };
  let first = null;
  try {
    await moviePlugin.deliver({
      msg: { id: 'manual-1', key: null }, movie: fresh.movie,
      hit: { title: 'Spaceballs', year: 1987, access: 'local', localPath: path.join(LIB, 'Spaceballs 1987.mp4') },
      ctx, job, record: { ...fresh.record }, react: async () => {}, jobKey: fresh.jobKey,
    });
  } catch (e) { first = e; }
  ok(/not connected/.test(first?.message ?? ''), 'the first run fails "not connected" and books a retry');

  bot.connect();                                    // WhatsApp connects before the retry is due
  await tick(50);
  const count = (key) => queue.added.filter((a) => a.job.meta?.jobKey === key).length;
  ok(count(old.jobKey) === 1, 'the last process\'s film is recovered');
  ok(count(fresh.jobKey) === 0, 'this process\'s film is not taken for a leftover');
  await tick(250);
  ok(count(fresh.jobKey) === 1, `its own retry queues it, once (${count(fresh.jobKey)} in all)`);
  ok((store.data.pending ?? []).filter((p) => p.jobKey === fresh.jobKey).length === 1, 'and it is journalled once');
  await moviePlugin.teardown();
}

console.log('=== a retry that finds its film in the queue already does not add another ===');
{
  const bot = fakeBot();
  bot.connected = true;
  const store = fakeStore();
  const queue = fakeQueue();
  const ctx = {
    bot, store, queue, log,
    config: {
      movieRequests: { reactions: { redo: '🔄' }, notify: {}, blockedRatings: ['R'] },
      media: { workDir: WORK }, library: { provider: 'local', local: { roots: [LIB] } }, omdb: {},
    },
  };
  const entry = film('MSG1', 'Spaceballs', 1987, 'tt0094012');
  store.set('pending', [entry]);
  queue.add({ label: 'Spaceballs (1987)', meta: { jobKey: entry.jobKey }, run: async () => {} });
  moviePlugin._retries = new RetryBook({ delayMs: () => 1, log });
  await moviePlugin._retryNow(ctx, entry.jobKey, 1);
  ok(queue.added.length === 1, `nothing is added (${queue.added.length} in the queue)`);
  moviePlugin._retries.clear();
}

console.log('=== a TV request queued from the panel before the first connect is not replayed ===');
{
  const bot = fakeBot();
  const store = fakeStore();
  const queue = fakeQueue();
  const ctx = {
    bot, store, queue, log,
    config: {
      tvRequests: { postsGroups: ['tvposts@g.us'] },
      movieRequests: { reactions: { redo: '🔄' }, notify: {} },
      media: { workDir: WORK },
    },
  };
  const eps = (show, n) => Array.from({ length: n }, (_, i) => ({ id: `${show}-${i + 1}`.toLowerCase(), series: show, season: 1, episode: i + 1 }));
  store.set('pending', [{ reqKey: 'tv-old', label: 'Dawson\'s Creek season 1', episodes: eps('Dawson\'s Creek', 2) }]);
  await tvPlugin.setup(ctx);

  // What requeue() does for "Loki season 1" typed in while the bot connects.
  const loki = eps('Loki', 2);
  tvPlugin._journalAdd(ctx, { reqKey: 'tv-manual-1', label: 'Loki season 1', episodes: loki });
  for (const ep of loki) queue.add({ kind: 'tv', label: `Loki S01E0${ep.episode}`, meta: { kind: 'tv', series: 'Loki', season: 1, episode: ep.episode }, run: async () => {} });

  bot.connect();
  await tick(50);
  const labels = queue.added.map((a) => a.job.label);
  const count = (re) => labels.filter((l) => re.test(l)).length;
  ok(count(/Dawson/) === 2, 'the last process\'s season is recovered');
  ok(count(/Loki/) === 2, `the panel's season is queued once, not twice (${count(/Loki/)} Loki jobs)`);
  await tvPlugin.teardown();
}

fs.rmSync(WORK, { recursive: true, force: true });
fs.rmSync(LIB, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
