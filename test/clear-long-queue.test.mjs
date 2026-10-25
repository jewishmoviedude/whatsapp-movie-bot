/* Clearing a queue of more than 100 jobs takes every one of them out of the journal.
   Run: node test/clear-long-queue.test.mjs

   A job cancelled or cleared before it starts never runs, so its pipeline
   never takes it out of the journal; watchCancelledWhileWaiting (media/
   resume.js) does. It used to find those jobs in queue.history, which holds
   only the last 100, and clearPending() archives every job it removes before
   it says anything. With more than 100 waiting - 104 at 01:36 UTC on
   2026-09-28, and recovery now goes past the limit - the first ones cleared
   were pushed out of the history unseen. Those are the jobs at the head of the
   queue: the films (recovered first, and retries are moved to the top). They
   stayed journalled and came back at the next start, and a TV retry cleared
   that way never reported, so its season never closed. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import tvPlugin from '../src/plugins/tv-requests/index.js';
import { JobQueue } from '../src/core/queue.js';
import { RetryBook, watchCancelledWhileWaiting } from '../src/media/resume.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'clear-long-'));
const log = { info() {}, warn() {}, error() {}, debug() {} };

function fakeStore(data = {}) {
  return {
    get: (k, d = null) => (k in data ? data[k] : d),
    set: (k, v) => { data[k] = v; },
    push: (k, v) => { (data[k] ??= []).unshift(v); },
    data,
  };
}

function fakeBot() {
  const bot = new EventEmitter();
  bot.isConnected = () => true;
  bot.react = async () => true;
  bot.sendText = async () => ({});
  bot.groups = () => [];
  return bot;
}

/** Recovered TV episodes behind the films, past the limit as recovery adds them. */
function fillWithEpisodes(queue, n) {
  for (let i = 0; i < n; i++) {
    queue.add({ kind: 'tv', label: `One Piece S12E${i + 1}`, meta: { kind: 'tv' }, run: async () => {} }, { overLimit: true });
  }
}

console.log('=== films at the head of a queue of 103, cleared ===');
{
  const queue = new JobQueue({ concurrency: 3, maxLength: 104 });
  queue.pause();
  const store = fakeStore();
  const ctx = {
    bot: fakeBot(), store, queue, log, configStore: { update() {} },
    config: { movieRequests: { rules: 'x', reactions: {}, notify: {} }, media: { workDir: WORK }, library: {}, omdb: {} },
  };
  await moviePlugin.setup(ctx);

  for (const t of ['Doctor Strange', 'Ready Player One', 'Spaceballs']) {
    const jobKey = `MSG-${t}:tt`;
    moviePlugin._journalAdd(ctx, { jobKey, msgId: `MSG-${t}`, msgKey: null, movie: { title: t, year: 2000 }, record: { id: `MSG-${t}` } });
    queue.add({ label: `${t} (2000)`, meta: { jobKey }, run: async () => {} }, { overLimit: true });
  }
  fillWithEpisodes(queue, 100);
  ok(queue.pending.length === 103, 'three films and 100 episodes are waiting');

  queue.clearPending();
  ok(queue.history.length === 100, 'the queue\'s own history kept only the last 100 of them');
  const left = (store.data.pending ?? []).map((p) => p.movie.title);
  ok(left.length === 0, `every cleared film is out of the journal (${left.join(', ') || 'none left'})`);
  await moviePlugin.teardown();
}

console.log('=== a film cleared before it starts shows ❌, as a TV request does ===');
{
  // The TV side reacts ❌ on each request cleared; a film's message kept its
  // place number for ever, though the group rules promise "❌ An admin
  // cancelled it" (review, group-facing lens).
  const queue = new JobQueue({ concurrency: 1, maxLength: 104 });
  queue.pause();
  const store = fakeStore();
  const reacted = [];
  const bot = fakeBot();
  bot.react = async (m, e) => { reacted.push(`${m.id} ${e}`); return true; };
  const ctx = {
    bot, store, queue, log, configStore: { update() {} },
    config: { movieRequests: { rules: 'x', reactions: { cancelled: '❌', skipped: '⏭️', failed: '⚠️' }, notify: {} }, media: { workDir: WORK }, library: {}, omdb: {} },
  };
  await moviePlugin.setup(ctx);
  for (const t of ['Heat', 'Up']) {
    const jobKey = `MSG-${t}:tt`;
    moviePlugin._journalAdd(ctx, { jobKey, msgId: `MSG-${t}`, msgKey: { id: `MSG-${t}`, remoteJid: 'req@g.us' }, chatJid: 'req@g.us', movie: { title: t, year: 2000 }, record: { id: `MSG-${t}` } });
    queue.add({ label: `${t} (2000)`, meta: { jobKey }, run: async () => {} });
  }
  queue.skip(queue.pending[1].id);
  queue.clearPending();
  await new Promise((r) => setTimeout(r, 20));
  ok(reacted.includes('MSG-Heat ❌') && reacted.includes('MSG-Up ⏭️'), `cleared: ❌; skipped: ⏭️ (${reacted.join(', ')})`);
  await moviePlugin.teardown();
}

console.log('=== a TV retry at the head of a long queue, cleared ===');
{
  const queue = new JobQueue({ concurrency: 3, maxLength: 104 });
  queue.pause();
  const store = fakeStore();
  const ctx = {
    bot: fakeBot(), store, queue, log,
    config: { tvRequests: { postsGroups: ['p@g.us'] }, movieRequests: { reactions: {}, notify: {} }, media: { workDir: WORK } },
  };
  tvPlugin._retries = new RetryBook({ delayMs: () => 1, log });
  const ep = { id: 'op-12-27', series: 'One Piece', season: 12, episode: 27 };
  tvPlugin._journalAdd(ctx, { reqKey: 'r', label: 'One Piece S12E27', episodes: [ep] });
  const outcome = [];
  const notifier = {
    stage() {}, episodeDone: () => outcome.push('done'),
    episodeFailed: () => outcome.push('failed'), episodeCancelled: () => outcome.push('cancelled'),
  };
  tvPlugin._retryEpisodeNow(ctx, { ep, msg: null, react: async () => {}, notifier, route: null, reqKey: 'r', index: 0, total: 1 }, 1);
  fillWithEpisodes(queue, 101);

  queue.clearPending();
  ok(outcome.join() === 'cancelled', `the request hears that its episode was cancelled (${outcome.join() || 'nothing'})`);
  ok(!(store.data.pending ?? []).some((r) => r.episodes.some((e) => e.id === ep.id)), 'and the episode is out of the journal');
  await tvPlugin.teardown();
}

console.log('=== what the watcher reports, and what it does not ===');
{
  const queue = new JobQueue({ concurrency: 1, maxLength: 10 });
  queue.pause();
  const heard = [];
  const off = watchCancelledWhileWaiting(queue, (e) => heard.push(`${e.label}:${e.state}`));
  queue.add({ label: 'a', run: async () => {} });
  queue.add({ label: 'b', run: async () => {} });
  queue.add({ label: 'c', run: () => new Promise(() => {}) });   // runs until the test ends
  queue.moveTop(queue.pending[2].id);
  ok(heard.length === 0, 'a reorder is not a cancel');
  queue.skip(queue.pending.find((e) => e.label === 'b').id);
  ok(heard.join() === 'b:skipped', `a skip is heard as a skip (${heard.join()})`);
  queue.resume();                                  // 'c' starts; 'a' waits behind it
  await new Promise((r) => setTimeout(r, 20));
  queue.pause();
  queue.add({ label: 'd', run: async () => {} });
  queue.clearPending();
  ok(heard.join() === 'b:skipped,a:cancelled,d:cancelled', `the cleared jobs are each heard once, as cancelled (${heard.join()})`);
  queue.emit('state', queue.snapshot());
  queue.emit('updated', queue.publicView([...queue.active.values()][0]));
  ok(heard.length === 3, 'a later event reports nothing again, and the running job is never reported');
  off();
  ok(queue.listenerCount('added') === 0 && queue.listenerCount('state') === 0, 'unsubscribing removes the listeners');
}

fs.rmSync(WORK, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
