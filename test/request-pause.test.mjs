/* Requests can be paused from the dashboard: each gets ⏸️ and waits, and they run in order on resume.
   Run: node test/request-pause.test.mjs

   The operator's request (2026-10-01): "add option in panel dash for me as
   admin to pause processing of requests, in case I don't want requests to
   process because were testing something but I also don't want to close the
   bot because I'm also debugging and because locking the group is annoying,
   instead when I place into pause mode all requests should get a ⏸️
   reaction. direct links can be excluded I guess because those take
   milliseconds anyway". Their answers: the held requests "Run them, in
   order" on resume, kept even through a restart, each handled as if it had
   just arrived; and of the jobs in hand, "Finish the running ones" - nothing
   new starts while paused. And from the main session the same day: the
   queue's own Pause lived in memory only, so a restart quietly undid it.

   Pinned here: a movie request, a TV request and a pick from a "which one?"
   list are held with ⏸️; chatter is moderated as ever and never gets ⏸️; the
   cooldown applies at intake and again on replay (below); the beta
   group and the direct-links group are not paused; the queue is paused with
   the requests and resumed only if they paused it; the replay runs in
   arrival order, paced with _bulkPace, each taken off the list before it is
   handed over, so a restart part-way goes on with the rest; the pause, the
   held requests and the queue's Pause survive a restart; the panel's API,
   its SSE push, the bot-cmd ops and the dashboard's button and banner. The
   dashboard part needs linkedom (a devDependency) and says so when it is
   skipped. tools/pause-requests.mjs has test/pause-requests-cli.test.mjs.

   And what the review of 2026-10-01 found wrong in the first version, each
   pinned below: WhatsApp dropping during the replay's pace still had the
   next request handed over, and off the list; queue-status and health said
   safeToRestart while a held film request, already off the disk, was being
   looked up; the dashboard said the queue was paused after the admin had
   resumed it by hand; a held pick outlasting its list's ten minutes no
   longer swallowed its owner's same number again, which was deleted as
   chatter; a replayed film's History row was dated back to its hold, out of
   every daily digest's window; a pick made by reacting got no ⏸️ anywhere;
   and the command channel's resume-requests dropped a failed replay without
   a log line.

   Changed the same evening by the operator's rule after Ben Lewis's three
   🚫 (test/cooldown-after-queued.test.mjs): a member's clock starts only
   when a request of theirs queues something, not when it arrives. So a held
   request starts no clock - it has queued nothing - and a second request
   from the same member is held too, where it used to get 🚫. Each is then
   handled on resume as if it had just arrived, as the operator asked: it
   meets the cooldown then, so when the first queues, the second gets 🚫 in
   place of its ⏸️ rather than queueing beside it. The blocks that pinned
   "taken at intake, not asked again" pin that instead. */
import './fixtures/roomy-disk.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import tvPlugin from '../src/plugins/tv-requests/index.js';
import directLinks from '../src/plugins/direct-links/index.js';
import { JobQueue } from '../src/core/queue.js';
import { StateStore } from '../src/core/state.js';
import {
  RequestPause, switchOn, switchOff, NAMESPACE, QUEUE_NAMESPACE, heldMessage, slimMessage,
} from '../src/core/request-pause.js';
import { runAdminCommand, auditAdminCommand } from '../src/core/admin-commands.js';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';
import { createServer } from '../src/web/server.js';
import { ConfigStore } from '../src/config/store.js';
import { hashPassword } from '../src/util/crypto.js';
import log from '../src/util/logger.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'request-pause-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

const MOVIES = 'movies@g.us';
const TV = 'tv@g.us';
const BETA = 'beta@g.us';
const LINKS = 'links@g.us';

/** A namespace like the state store's, in memory. */
function memStore(data = {}) {
  return {
    _data: data,
    get: (k, d = null) => (k in data ? data[k] : d),
    set: (k, v) => { data[k] = v; return v; },
    delete: (k) => { delete data[k]; },
    push: (k, v, cap = 200) => { (data[k] ??= []).unshift(v); if (data[k].length > cap) data[k].length = cap; },
    flush: () => true,
  };
}

function fakeBot(out = []) {
  return {
    out,
    paced: 0,
    isConnected: () => true,
    react: async (msg, emoji, opts = {}) => { out.push({ op: 'react', on: msg.id, emoji, kind: opts.kind ?? 'normal' }); return true; },
    sendText: async (jid, text, opts = {}) => { out.push({ op: 'text', jid, text, quoted: opts.quoted?.id ?? null }); return { key: { id: `BOT${out.length}`, remoteJid: jid } }; },
    editText: async (jid, key, text) => { out.push({ op: 'edit', jid, key: key.id, text }); return true; },
    deleteMessage: async (m) => { out.push({ op: 'delete', on: m.id }); },
    archiveChat: async () => {},
    isGroupAdmin: () => false,
    async _bulkPace() { this.paced += 1; },
    on() {}, off() {},
  };
}

function config({ movie = {}, tv = {}, betaMode = 'beta' } = {}) {
  return mergeDefaults({
    movieRequests: {
      requestGroups: [MOVIES], requirePrefix: true, prefix: '#request', cooldownSecondsPerUser: 30,
      cooldownOnlyWhenOthersWait: false, replyOnBlock: false, requireYearWhenAmbiguous: false,
      enforcement: { enabled: true, deleteNonRequests: true, exemptAdmins: true, warnByDm: false },
      ...movie,
    },
    tvRequests: {
      enabled: true, requestGroups: [TV], requirePrefix: true, prefix: '#request',
      cooldownSecondsPerUser: 900, cooldownOnlyWhenOthersWait: false, ...tv,
    },
    directLinks: {
      enabled: true, groups: [LINKS], apiKey: 'SHARE', publicBaseUrl: 'http://jf.test',
    },
    // A film test is asked under $beta004: beta001, the "which one?" list,
    // left beta for every group on 2026-10-11, and needs no mode at all.
    beta: { groups: [BETA], features: { 'movie-duplicate-notice': betaMode } },
  }, DEFAULT_CONFIG);
}

/** One process's worth: a queue, the pause, two plugins sharing a fake WhatsApp. */
function harness({ cfg = config(), state = null } = {}) {
  const out = [];
  const bot = fakeBot(out);
  const queue = new JobQueue({ concurrency: 1 });
  const ns = (name) => (state ? state.namespace(name) : memStore());
  const audit = memStore();
  const requestPause = new RequestPause({
    store: ns(NAMESPACE), queueStore: ns(QUEUE_NAMESPACE), queue, bot, audit, getConfig: () => cfg,
  });
  requestPause.restore();
  const logs = [];
  const log = (lvl) => (m) => logs.push(`${lvl} ${m}`);
  const mkCtx = (store) => ({
    config: cfg, store, bot, queue, linkQueue: queue, requestPause,
    log: { info: log('info'), warn: log('warn'), error: log('error'), debug() {} },
    configStore: { update() {} },
  });
  const movieCtx = mkCtx(state ? state.namespace('movie-requests') : memStore());
  const tvCtx = mkCtx(state ? state.namespace('tv-requests') : memStore());
  const plugins = new Map([
    ['movie-requests', { plugin: moviePlugin, ctx: movieCtx }],
    ['tv-requests', { plugin: tvPlugin, ctx: tvCtx }],
  ]);
  requestPause.attach({ plugins });
  return { out, bot, queue, requestPause, movieCtx, tvCtx, logs, audit, cfg };
}

let seq = 0;
const AVI = { jid: 'avi@lid', number: '15550000001' };
const BOB = { jid: 'bob@lid', number: '15550000002' };
function mkMsg(text, chatJid, who = AVI) {
  const id = `M${++seq}`;
  return {
    id, key: { id, remoteJid: chatJid, participant: who.jid, fromMe: false }, chatJid, isGroup: true, fromMe: false,
    senderJid: who.jid, senderNumber: who.number, senderNumberDisplay: `+${who.number}`, pushName: who.jid.split('@')[0],
    text, timestamp: Date.now(), messageType: 'conversation', raw: { key: { id } },
  };
}

// The request pipelines themselves are not under test here, and they reach
// OMDb and Jellyfin: each plugin's _runRequest is replaced by a recorder.
const ran = [];
const realMovieRun = moviePlugin._runRequest;
const realTvRun = tvPlugin._runRequest;
let holdUp = null;            // a promise one replayed request waits on (a "crash")
moviePlugin._runRequest = async function stub(msg, text, ctx, opts = {}) {
  ran.push({ plugin: 'movie', id: msg.id, text, opts, msg });
  if (holdUp && holdUp.id === msg.id) await holdUp.promise;
  opts.onRecord?.({ status: 'queued', title: 'Venom', year: 2018, pickList: { ...(opts.pick ?? {}), units: 1 } });
  // What the real one resolves to when it has queued a film, which is what
  // starts the member's clock.
  return { queued: true };
};
tvPlugin._runRequest = async function stub(msg, text, ctx, opts = {}) {
  ran.push({ plugin: 'tv', id: msg.id, text, opts, msg });
  return { outcome: 'queued', queued: true };
};
process.on('exit', () => { moviePlugin._runRequest = realMovieRun; tvPlugin._runRequest = realTvRun; });

const reactions = (out, id) => out.filter((e) => e.op === 'react' && e.on === id).map((e) => e.emoji);

/* ============================== the switch ============================== */

console.log('=== pausing requests pauses the queue, and resuming resumes it only if it did ===');
{
  let r = switchOn(null, null, { by: 'alice', now: 1000 });
  ok(r.changed && r.req.paused && r.req.pausedQueue && r.queue.paused, 'a running queue is paused with the requests, and it is remembered');
  r = switchOff(r.req, r.queue);
  ok(r.changed && !r.req.paused && r.resumeQueue && !r.queue.paused, 'and resumed with them');
  r = switchOn(null, { paused: true, since: 5, by: 'bob' }, { by: 'alice', now: 1000 });
  ok(!r.req.pausedQueue && r.queue.by === 'bob', 'a queue already paused is left as it was');
  r = switchOff(r.req, r.queue);
  ok(!r.resumeQueue && r.queue.paused, 'and stays paused when requests resume');
  ok(!switchOn({ paused: true, since: 1, by: 'x' }, null, { by: 'y', now: 2 }).changed, 'pausing twice changes nothing');
  ok(!switchOff(null, null).changed, 'resuming what is not paused changes nothing');

  const h = harness();
  h.requestPause.pause('alice');
  ok(h.queue.paused && h.requestPause.isPaused(), 'the live queue is paused with the requests');
  h.requestPause.resume('alice');
  ok(!h.queue.paused && !h.requestPause.isPaused(), 'and runs again with them');

  const g = harness();
  g.requestPause.pauseQueue('bob');
  g.requestPause.pause('alice');
  g.requestPause.resume('alice');
  ok(g.queue.paused, 'a queue the admin paused first stays paused when requests resume');

  const k = harness();
  k.requestPause.pause('alice');
  k.requestPause.resumeQueue('bob');
  ok(!k.queue.paused && k.requestPause.isPaused(), 'the admin can run the queue while requests stay paused');
  k.requestPause.pauseQueue('bob');
  k.requestPause.resume('alice');
  ok(k.queue.paused, 'and a queue the admin paused again by hand is theirs: resuming requests leaves it paused');
}

console.log('=== nothing new starts while paused; what is running finishes ===');
{
  const h = harness();
  let release;
  const started = [];
  h.queue.add({ label: 'Running film', meta: {}, run: () => { started.push('running'); return new Promise((r) => { release = r; }); } });
  await settle();
  h.requestPause.pause('alice');
  h.queue.add({ label: 'Waiting film', meta: {}, run: async () => { started.push('waiting'); } });
  await settle();
  ok(started.join() === 'running', 'the film already running carries on; the new one waits');
  release();
  await settle();
  ok(started.join() === 'running', 'and once it is done, the next does not start while paused');
  h.requestPause.resume('alice');
  await settle();
  ok(started.join() === 'running,waiting', 'it starts on resume');
}

/* ============================ intake: films ============================ */

console.log('=== films: a request is held with ⏸️, and nothing else happens ===');
{
  const h = harness();
  h.requestPause.pause('alice');
  ran.length = 0;
  const m = mkMsg('#request Dune 2021', MOVIES);
  await moviePlugin.onMessage(m, h.movieCtx);
  ok(ran.length === 0, 'it is not run');
  ok(reactions(h.out, m.id).join() === '⏸️', 'it gets ⏸️ and nothing else');
  ok(h.out.find((e) => e.on === m.id)?.kind === 'critical', 'at critical priority: it is the whole answer for now');
  const held = h.requestPause._held();
  ok(held.length === 1 && held[0].plugin === 'movie-requests' && held[0].kind === 'request' && held[0].text === 'Dune 2021',
    'it is journalled with its plugin and the request text');
  ok(held[0].msg.key?.id === m.id && held[0].msg.senderNumber === AVI.number && !('raw' in held[0].msg) && Number.isFinite(held[0].at),
    'with enough of the message to run it later, and when it came');
  ok(h.logs.some((l) => /⏸️ held a request from \+15550000001/.test(l)), 'and a log line says so');
}

console.log('=== films: chatter is moderated as ever, and never gets ⏸️ ===');
{
  const h = harness();
  h.requestPause.pause('alice');
  const m = mkMsg('thanks!', MOVIES);
  await moviePlugin.onMessage(m, h.movieCtx);
  ok(h.out.some((e) => e.op === 'delete' && e.on === m.id), 'it is deleted, as without the pause');
  ok(!reactions(h.out, m.id).length && h.requestPause.heldCount() === 0, 'no ⏸️, nothing held');
}

console.log('=== films: the cooldown is applied when the request arrives, as live ===');
{
  const h = harness();
  h.requestPause.pause('alice');
  const a = mkMsg('#request Dune 2021', MOVIES);
  const b = mkMsg('#request Heat 1995', MOVIES);
  await moviePlugin.onMessage(a, h.movieCtx);
  await moviePlugin.onMessage(b, h.movieCtx);
  ok(reactions(h.out, a.id).join() === '⏸️', 'the first is held');
  // Until 2026-10-01 the first took the clock as it arrived, and the second
  // got 🚫. Held, it has queued nothing, so it starts no clock.
  ok(reactions(h.out, b.id).join() === '⏸️' && h.requestPause.heldCount() === 2, 'the second is held too: nothing has queued yet');
  // A clock already running - a film of the member's queued before the
  // pause - is met as the request arrives.
  h.movieCtx.store.set(`cooldown:${AVI.jid}`, { at: Date.now(), what: 'Up (2009)' });
  const c = mkMsg('#request Inception 2010', MOVIES);
  await moviePlugin.onMessage(c, h.movieCtx);
  ok(reactions(h.out, c.id).join() === '🚫', 'one inside a running clock gets 🚫 - not ⏸️');
  ok(h.requestPause.heldCount() === 2, 'and is not held');
}

console.log('=== films: the beta group is not paused ===');
{
  const h = harness();
  h.requestPause.pause('alice');
  ran.length = 0;
  const m = mkMsg('$beta004 #request Dune', BETA);
  await moviePlugin.onMessage(m, h.movieCtx);
  ok(ran.length === 1 && ran[0].opts.beta === true && ran[0].opts.test === 'beta004', 'a test runs at once, as a test');
  ok(!reactions(h.out, m.id).includes('⏸️') && h.requestPause.heldCount() === 0, 'with no ⏸️, nothing held');
}

/* ========================== intake: pick lists ========================== */

/**
 * An open "which one?" list of Avi's in the movie group, as _offerPickList
 * journals it. No beta mode is set for it: the list has needed none since
 * it left beta (2026-10-11).
 */
function openList(h) {
  const req = mkMsg('#request venom', MOVIES);
  const now = Date.now();
  const list = {
    id: req.id, state: 'open', chatJid: MOVIES, listJid: MOVIES, listKey: { id: 'LIST1', remoteJid: MOVIES, fromMe: true },
    sender: { jid: AVI.jid, number: AVI.number }, msg: slimMessage(req), request: 'venom', title: 'Venom', query: 'venom',
    items: [{ title: 'Venom', year: 2005, rated: 'R' }, { title: 'Venom', year: 2018, rated: 'PG-13' }],
    refused: [], shownAt: now, expiresAt: now + 10 * 60_000, route: null, at: now,
    record: { id: req.id, request: 'venom', status: 'pick-list', pickList: { shownAt: now, expiresAt: now + 600_000, units: 1 } },
  };
  h.movieCtx.store.set('pickLists', [list]);
  return { req, list };
}

console.log('=== a pick from a "which one?" list is held, claimed so the first pick still wins ===');
{
  const h = harness();
  const { req } = openList(h);
  h.requestPause.pause('alice');
  ran.length = 0;
  const two = mkMsg('2', MOVIES);
  await moviePlugin.onMessage(two, h.movieCtx);
  ok(ran.length === 0, 'it is not run');
  ok(reactions(h.out, two.id).join() === '⏸️', 'the number gets ⏸️');
  const list = h.movieCtx.store.get('pickLists')[0];
  ok(list.state === 'picked' && list.pickedIndex === 1, 'the list is claimed for that pick, so it does not run out under it');
  const held = h.requestPause._held();
  ok(held.length === 1 && held[0].kind === 'pick' && held[0].listId === req.id && held[0].index === 1, 'the pick is held, with its list');
  ok(h.requestPause.holds('movie-requests', req.id), 'and the pause knows it holds that list');

  const again = mkMsg('1', MOVIES);
  await moviePlugin.onMessage(again, h.movieCtx);
  ok(!reactions(h.out, again.id).length && h.requestPause.heldCount() === 1, 'a second number is not held: the first pick wins, as live');

  const r = h.requestPause.resume('alice');
  await r.replay;
  ok(ran.length === 1 && ran[0].id === req.id && ran[0].text === 'Venom 2018' && ran[0].opts.pick?.picked === 2,
    'on resume the pick runs on the ORIGINAL request, as the version picked');
  ok(h.out.some((e) => e.op === 'react' && e.on === two.id && e.emoji === ''), 'and the ⏸️ is taken off the number');
  ok(h.movieCtx.store.get('pickLists')[0].state === 'answered', 'the list is settled as any pick is');
}

console.log('=== a wrong number is answered as ever, and a pick in the beta group is not held ===');
{
  const h = harness();
  openList(h);
  h.requestPause.pause('alice');
  const nine = mkMsg('9', MOVIES);
  await moviePlugin.onMessage(nine, h.movieCtx);
  ok(!reactions(h.out, nine.id).includes('⏸️') && h.requestPause.heldCount() === 0, 'a number not on the list is not held');
  ok(reactions(h.out, nine.id).join() === '❓', 'and is answered as ever, with ❓');
  ok(h.movieCtx.store.get('pickLists')[0].state === 'open', 'and the list stays open for a real pick');

  const b = harness();
  b.requestPause.pause('alice');
  const { list } = openList(b);
  const route = { beta: true, notifyGroup: BETA, test: 'beta004' };
  b.movieCtx.store.set('pickLists', [{ ...list, chatJid: BETA, listJid: BETA, route }]);
  ran.length = 0;
  const one = mkMsg('1', BETA);
  await moviePlugin.onMessage(one, b.movieCtx);
  await settle();
  ok(b.requestPause.heldCount() === 0 && !reactions(b.out, one.id).includes('⏸️'), 'a beta tester\'s pick is not held');
  ok(ran.length === 1 && ran[0].text === 'Venom 2005', 'it runs at once');
}

console.log('=== a held message that is a member\'s reaction: its ⏸️ goes on the request, never on the reaction ===');
{
  // A pick made by reacting to a list (the operator's request of the same
  // day): the bot never reacts back to a reaction. It got no ⏸️ anywhere at
  // first - against "all requests should get a ⏸️ reaction" - so the member
  // saw no sign the pick was taken for as long as the pause lasted.
  const h = harness();
  h.requestPause.pause('alice');
  const req = mkMsg('#request venom', MOVIES);
  const m = { ...mkMsg('', MOVIES), reaction: { emoji: '2️⃣', targetId: 'LIST1', targetFromMe: true } };
  await h.requestPause.hold(h.movieCtx, m, {
    plugin: 'movie-requests', kind: 'pick', extra: { listId: 'L', index: 1, form: 'reaction', reactOn: slimMessage(req) },
  });
  ok(h.requestPause.heldCount() === 1 && reactions(h.out, req.id).join() === '⏸️', 'held, with ⏸️ on the request it answers');
  ok(!reactions(h.out, m.id).length, 'and nothing on the reaction');
  ok(h.out.find((e) => e.on === req.id)?.kind === 'critical', 'as critical, like any ⏸️');
  ok(h.requestPause._held()[0].msg.reaction?.emoji === '2️⃣', 'journalled as the reaction it was');
  const g = harness();
  g.requestPause.pause('alice');
  await g.requestPause.hold(g.movieCtx, { ...m, id: 'M-R2' }, { plugin: 'movie-requests', kind: 'pick', extra: { listId: 'L', index: 1 } });
  ok(g.requestPause.heldCount() === 1 && !g.out.some((e) => e.op === 'react'), 'with no request to put it on, nothing is sent - still never on the reaction');
}

console.log('=== a held pick outlasting its list\'s ten minutes: the same number again is still that list\'s ===');
{
  // Found in review: the "already answered" swallow asked the list's expiry
  // only, so eleven minutes into a pause the owner's "2" again fell through
  // to moderation and was deleted (enforcement is on in this harness).
  const h = harness();
  const { req } = openList(h);
  h.requestPause.pause('alice');
  await moviePlugin.onMessage(mkMsg('2', MOVIES), h.movieCtx);
  ok(h.requestPause.heldCount() === 1, 'the pick is held');
  h.movieCtx.store.set('pickLists', h.movieCtx.store.get('pickLists').map((l) => ({ ...l, expiresAt: Date.now() - 60_000 })));
  const again = mkMsg('2', MOVIES);
  const coded = mkMsg('#request 2', MOVIES);
  await moviePlugin.onMessage(again, h.movieCtx);
  await moviePlugin.onMessage(coded, h.movieCtx);
  ok(!h.out.some((e) => e.op === 'delete'), 'neither "2" nor "#request 2" is deleted as chatter');
  ok(h.requestPause.heldCount() === 1 && !reactions(h.out, again.id).length && !reactions(h.out, coded.id).length,
    'nor held as a new request, nor reacted to');
  ok(h.logs.filter((l) => /their list for "venom" was already answered/.test(l)).length === 2, 'each is logged as an answer to a list already answered');
  ran.length = 0;
  await h.requestPause.resume('alice').replay;
  ok(ran.length === 1 && ran[0].id === req.id && ran[0].text === 'Venom 2018', 'and on resume the one pick runs');
  const done = harness();
  openList(done);
  done.movieCtx.store.set('pickLists', done.movieCtx.store.get('pickLists').map((l) => ({
    ...l, state: 'answered', pickedIndex: 1, expiresAt: Date.now() - 60_000,
  })));
  const late = mkMsg('2', MOVIES);
  await moviePlugin.onMessage(late, done.movieCtx);
  ok(done.out.some((e) => e.op === 'delete' && e.on === late.id), 'a list NOT held keeps its ten minutes: after them a bare "2" is chatter again');
}

console.log('=== a restart does not run a held pick behind the pause\'s back ===');
{
  const h = harness();
  openList(h);
  h.requestPause.pause('alice');
  await moviePlugin.onMessage(mkMsg('2', MOVIES), h.movieCtx);
  ran.length = 0;
  await moviePlugin.recoverPickLists(h.movieCtx);
  ok(ran.length === 0, 'recovery leaves a held pick to the pause');
  ok(h.movieCtx.store.get('pickLists')[0].state === 'picked', 'still claimed, waiting for resume');
}

/* ============================== intake: TV ============================== */

console.log('=== TV: a request is held with ⏸️, and meets the cooldown again when it runs on resume ===');
{
  const h = harness();
  h.requestPause.pause('alice');
  ran.length = 0;
  const m = mkMsg('#request The Boys S01', TV);
  await tvPlugin.onMessage(m, h.tvCtx);
  ok(ran.length === 0 && reactions(h.out, m.id).join() === '⏸️', 'held with ⏸️, not run');
  const held = h.requestPause._held()[0];
  ok(held?.plugin === 'tv-requests' && held.text === 'The Boys S01', 'journalled with its text');
  // Until 2026-10-01 the clock was taken here, journalled with the request,
  // and the second request got 🚫. A held request has queued nothing, so it
  // starts no clock, and the second is held as well.
  ok(h.tvCtx.store.get(`cooldown:${AVI.jid}`, null) == null, 'no clock has started');
  const b = mkMsg('#request Loki S02', TV);
  await tvPlugin.onMessage(b, h.tvCtx);
  ok(reactions(h.out, b.id).join() === '⏸️' && h.requestPause.heldCount() === 2, 'a second request is held too');
  const r = h.requestPause.resume('alice');
  await r.replay;
  ok(ran.length === 1 && ran[0].text === 'The Boys S01' && ran[0].opts.route === null,
    'on resume the first runs as a main-group request, and queues');
  ok(reactions(h.out, b.id).join() === '⏸️,🚫',
    `the second, run as if it had just arrived, meets the clock the first started: 🚫 in place of its ⏸️ (${reactions(h.out, b.id).join()})`);
  ok(ran[0].msg.raw?.message?.conversation === '#request The Boys S01' && ran[0].msg.raw.key.id === m.id,
    'and a reply can still quote it');
}

console.log('=== TV: the beta group is not paused ===');
{
  const h = harness({ cfg: config({ betaMode: 'beta' }) });
  h.cfg.beta.features['tv-rating-notice'] = 'beta';
  h.requestPause.pause('alice');
  ran.length = 0;
  const m = mkMsg('$beta003 #request The Boys S01', BETA);
  await tvPlugin.onMessage(m, h.tvCtx);
  ok(ran.length === 1 && ran[0].plugin === 'tv' && ran[0].opts.route?.test === 'beta003', 'a TV test runs at once, as a test');
  ok(h.requestPause.heldCount() === 0 && !reactions(h.out, m.id).includes('⏸️'), 'with no ⏸️, nothing held');
}

console.log('=== direct links are not paused ===');
{
  const h = harness();
  h.requestPause.pause('alice');
  const linkJobs = [];
  const ctx = { ...h.movieCtx, linkQueue: { add: (j) => { linkJobs.push(j); return 'L1'; } } };
  const m = mkMsg('#request-movie The Truman Show 1998', LINKS);
  await directLinks.onMessage(m, ctx);
  ok(linkJobs.length === 1, 'a link request is looked up at once');
  ok(!reactions(h.out, m.id).includes('⏸️') && h.requestPause.heldCount() === 0, 'with no ⏸️, nothing held');
}

/* =============================== the replay =============================== */

console.log('=== on resume the held requests run in the order they came, paced, each meeting the cooldown as it runs ===');
{
  const h = harness();
  h.requestPause.pause('alice');
  ran.length = 0;
  const a = mkMsg('#request Dune 2021', MOVIES, AVI);
  const b = mkMsg('#request The Boys S01', TV, BOB);
  const c = mkMsg('#request Heat 1995', MOVIES, BOB);
  for (const [m, p, ctx] of [[a, moviePlugin, h.movieCtx], [b, tvPlugin, h.tvCtx], [c, moviePlugin, h.movieCtx]]) {
    await p.onMessage(m, ctx);
  }
  ok(h.requestPause.heldCount() === 3, 'three held');
  // One per member and section, so none is behind another's clock. (Until
  // 2026-10-01 everyone's clock was set here, to show the replay did not ask
  // the cooldown; it asks it now - the block above has the refusal.)
  const arrived = h.requestPause._held()[0].at;
  const r = h.requestPause.resume('alice');
  ok(r.ran === 3 && h.requestPause.snapshot().replaying, 'resume says how many it is running, and the replay is under way');
  await r.replay;
  ok(ran.map((x) => x.id).join() === [a.id, b.id, c.id].join(), 'in arrival order, films and TV together');
  // Dated back to its hold at first, a row written after the daily digest
  // had read that hour fell in no digest's window (found in review).
  ok(Number.isFinite(arrived) && ran[0].opts.at == null && ran[0].msg.timestamp === a.timestamp,
    'a film\'s History row is dated when it runs, as any request\'s; when it was sent stays on its message (requestedAt)');
  ok(h.bot.paced === 3, `paced with _bulkPace before each (CLAUDE.md rule 1): ${h.bot.paced}`);
  ok(!h.out.some((e) => e.emoji === '🚫'), 'nothing was refused for the cooldown on replay');
  ok(h.movieCtx.store.get(`cooldown:${AVI.jid}`)?.at > 0 && h.tvCtx.store.get(`cooldown:${BOB.jid}`)?.at > 0,
    'and each that queued started its member\'s clock in its own section');
  ok(h.requestPause.heldCount() === 0, 'and the list is empty');
}

console.log('=== pausing again part-way stops the replay; the rest stay held ===');
{
  const h = harness();
  h.requestPause.pause('alice');
  for (let i = 0; i < 3; i += 1) await moviePlugin.onMessage(mkMsg(`#request Film ${i} 2001`, MOVIES, { jid: `m${i}@lid`, number: `1555000010${i}` }), h.movieCtx);
  ran.length = 0;
  h.bot._bulkPace = async function pace() { this.paced += 1; if (this.paced === 2) h.requestPause.pause('bob'); };
  const r = h.requestPause.resume('alice');
  await r.replay;
  ok(ran.length === 1 && h.requestPause.heldCount() === 2, 'one ran, and two wait for the next resume');
}

console.log('=== WhatsApp gone during the pace: the next one is not handed over, and runs at the next connect ===');
{
  // Found in review: the connection was asked before the pace and not after
  // it, so a socket that dropped in those seconds still had the next request
  // taken off the list and handed over with nothing to answer it on.
  const h = harness();
  h.requestPause.pause('alice');
  const msgs = [0, 1, 2].map((i) => mkMsg(`#request Drop ${i} 2001`, MOVIES, { jid: `d${i}@lid`, number: `1555000030${i}` }));
  for (const m of msgs) await moviePlugin.onMessage(m, h.movieCtx);
  ran.length = 0;
  let connected = true;
  h.bot.isConnected = () => connected;
  h.bot._bulkPace = async function pace() { this.paced += 1; if (this.paced === 2) connected = false; };
  await h.requestPause.resume('alice').replay;
  ok(ran.map((x) => x.id).join() === msgs[0].id, `only the first ran: WhatsApp went during the pace before the second (${ran.length} ran)`);
  ok(h.requestPause._held().map((it) => it.id).join() === [msgs[1].id, msgs[2].id].join(), 'the second and third are still held, in order');
  connected = true;
  await h.requestPause.replay();
  ok(ran.map((x) => x.id).join() === msgs.map((m) => m.id).join() && h.requestPause.heldCount() === 0, 'and the next connect runs them, in order');
}

console.log('=== a replay that fails says so in the log, and leaves the rest held ===');
{
  // Found in review: the command channel's resume-requests dropped the
  // replay's rejection with a comment saying the replay had logged it, and
  // nothing had - the op's answer said "running" while nothing ran.
  const h = harness();
  h.requestPause.pause('alice');
  await moviePlugin.onMessage(mkMsg('#request Fail 2001', MOVIES, { jid: 'f0@lid', number: '15550000400' }), h.movieCtx);
  h.bot._bulkPace = async () => { throw new Error('pacing broke'); };
  const lines = [];
  const listen = (e) => lines.push(`${e.level} ${e.scope}: ${e.msg}`);
  log.on('line', listen);
  ran.length = 0;
  const res = await runAdminCommand({ op: 'resume-requests', by: 'main session' }, { bot: h.bot, dataDir: TMP, requestPause: h.requestPause, queue: h.queue });
  await settle(10);
  let rejected = false;
  const again = await h.requestPause.replay().catch(() => { rejected = true; });
  log.off('line', listen);
  ok(res.ok && res.ran === 1, 'the op answers as before');
  ok(lines.some((l) => /^error request-pause: running the held requests stopped: pacing broke - 1 still held/.test(l)),
    `the failure is an error line (${lines.find((l) => /pacing broke/.test(l)) ?? 'none'})`);
  ok(ran.length === 0 && h.requestPause.heldCount() === 1 && !h.requestPause.snapshot().replaying, 'nothing ran, and the request is still held, on the disk');
  ok(!rejected && again === 0, 'replay() itself never rejects, so no caller can drop it unlogged');
}

console.log('=== not "safe to restart" while held requests are being run ===');
{
  // Found in review: each is off the disk as it is handed over, and a film
  // request mid-lookup has no History row or journal entry yet, so a restart
  // on safeToRestart: true lost it without a trace.
  const h = harness();
  const deps = { bot: { ...h.bot, status: () => ({ state: 'connected' }) }, dataDir: TMP, requestPause: h.requestPause, queue: h.queue };
  h.requestPause.pause('alice');
  const m = mkMsg('#request Busy 2001', MOVIES, { jid: 'b0@lid', number: '15550000500' });
  await moviePlugin.onMessage(m, h.movieCtx);
  ok((await runAdminCommand({ op: 'queue-status' }, deps)).safeToRestart === true, 'held and waiting: safe, it is on the disk');
  ran.length = 0;
  let release;
  holdUp = { id: m.id, promise: new Promise((r) => { release = r; }) };
  h.requestPause.resume('alice');
  for (let i = 0; i < 50 && !ran.length; i += 1) await settle(2);
  const status = await runAdminCommand({ op: 'queue-status' }, deps);
  const health = await runAdminCommand({ op: 'health' }, deps);
  ok(ran.length === 1 && h.requestPause.heldCount() === 0, 'being run: off the disk, in its plugin');
  ok(status.requests.replaying === true && status.busy === false && status.safeToRestart === false,
    'queue-status: not safe to restart, though the queue itself is idle');
  ok(health.safeToRestart === false && health.requests.replaying === true, 'health says the same');
  holdUp = null;
  release();
  await h.requestPause._replaying;
  ok((await runAdminCommand({ op: 'queue-status' }, deps)).safeToRestart === true, 'and safe again once it is done');
}

console.log('=== a restart part-way through the replay goes on with what is left, and runs nothing twice ===');
{
  const file = path.join(TMP, 'crash', 'state.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = new StateStore(file);
  const h = harness({ state: before });
  h.requestPause.pause('alice');
  const msgs = [0, 1, 2].map((i) => mkMsg(`#request Crash ${i} 2001`, MOVIES, { jid: `c${i}@lid`, number: `1555000020${i}` }));
  for (const m of msgs) await moviePlugin.onMessage(m, h.movieCtx);
  ran.length = 0;
  let stuck;
  holdUp = { id: msgs[1].id, promise: new Promise((r) => { stuck = r; }) };
  h.requestPause.resume('alice');
  for (let i = 0; i < 50 && ran.length < 2; i += 1) await settle(2);
  ok(ran.map((x) => x.id).join() === [msgs[0].id, msgs[1].id].join(), 'the first ran, and the second is being handled when the process dies');

  const after = new StateStore(file);      // the next process, from the disk
  const left = after.namespace(NAMESPACE).get('held', []);
  ok(left.length === 1 && left[0].id === msgs[2].id, 'the disk holds only the one not yet handed over');
  ok(after.namespace(NAMESPACE).get('state').paused === false, 'and says requests are not paused');
  const next = harness({ state: after });
  ran.length = 0;
  ok(next.requestPause.heldCount() === 1 && !next.requestPause.isPaused(), 'the next process starts with it held and requests running');
  await next.requestPause.replay();
  ok(ran.map((x) => x.id).join() === msgs[2].id, 'and runs just that one, once WhatsApp is up');
  holdUp = null;
  stuck();
}

console.log('=== the pause, the held requests and the queue\'s Pause survive a restart ===');
{
  const file = path.join(TMP, 'restart', 'state.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const first = new StateStore(file);
  const h = harness({ state: first });
  h.requestPause.pause('alice');
  await moviePlugin.onMessage(mkMsg('#request Dune 2021', MOVIES), h.movieCtx);
  first.flush();

  const second = harness({ state: new StateStore(file) });
  ok(second.requestPause.isPaused() && second.requestPause.state().by === 'alice', 'the next process starts paused, by whom it was');
  ok(second.queue.paused, 'with the queue paused before anything is added to it');
  ok(second.requestPause.heldCount() === 1, 'and the held request still held');
  second.queue.add({ label: 'recovered film', meta: {}, run: async () => { throw new Error('must not start'); } });
  await settle();
  ok(second.queue.snapshot().active.length === 0, 'a job recovery puts back does not start');
  ran.length = 0;
  await second.requestPause.replay();
  ok(ran.length === 0, 'nothing is replayed while still paused');

  // The queue's own Pause, alone.
  const qfile = path.join(TMP, 'queue-only', 'state.json');
  fs.mkdirSync(path.dirname(qfile), { recursive: true });
  const q1 = harness({ state: new StateStore(qfile) });
  q1.requestPause.pauseQueue('bob');
  const q2 = harness({ state: new StateStore(qfile) });
  ok(q2.queue.paused && !q2.requestPause.isPaused(), 'the queue\'s Pause comes back after a restart, without pausing requests');
  ok(q2.requestPause.snapshot().queue.by === 'bob', 'saying who paused it');
  q2.requestPause.resumeQueue('bob');
  const q3 = harness({ state: new StateStore(qfile) });
  ok(!q3.queue.paused, 'and a Resume is kept as well');

  // A file edited by hand with only the request pause in it.
  fs.mkdirSync(path.join(TMP, 'hand'), { recursive: true });
  const hand = new StateStore(path.join(TMP, 'hand', 'state.json'));
  hand.namespace(NAMESPACE).set('state', { paused: true, since: 1, by: 'by hand', pausedQueue: true });
  const h4 = harness({ state: hand });
  ok(h4.queue.paused && h4.requestPause.isPaused(), 'a request pause written alone still pauses the queue it says it paused');
  h4.requestPause.resume('alice');
  ok(!h4.queue.paused, 'and resuming requests resumes it');
}

console.log('=== a held request whose plugin is gone gets ⚠️, an error line and an audit row ===');
{
  const h = harness();
  h.requestPause.pause('alice');
  const m = mkMsg('#request Dune 2021', MOVIES);
  await moviePlugin.onMessage(m, h.movieCtx);
  h.requestPause.attach({ plugins: new Map() });
  await h.requestPause.resume('alice').replay;
  ok(reactions(h.out, m.id).includes('⚠️'), '⚠️ on the request');
  ok((h.audit.get('events', []) ?? []).some((e) => /could not run a held request/.test(e.action)), 'and a row in the audit log');
}

console.log('=== TV switched off while held, or a pick whose list is gone: ⚠️ and an audit row, not a silent drop ===');
{
  const h = harness();
  h.requestPause.pause('alice');
  const m = mkMsg('#request The Boys S01', TV);
  await tvPlugin.onMessage(m, h.tvCtx);
  const { req } = openList(h);
  const two = mkMsg('2', MOVIES);
  await moviePlugin.onMessage(two, h.movieCtx);
  h.cfg.tvRequests.enabled = false;
  h.movieCtx.store.set('pickLists', []);
  ran.length = 0;
  await h.requestPause.resume('alice').replay;
  ok(ran.length === 0, 'neither is run');
  ok(reactions(h.out, m.id).includes('⚠️') && reactions(h.out, two.id).includes('⚠️'), '⚠️ on each');
  const rows = (h.audit.get('events', []) ?? []).map((e) => `${e.action} - ${e.detail}`);
  ok(rows.some((r) => /The Boys S01/.test(r) && /switched off/.test(r)) && rows.some((r) => /list is gone/.test(r)),
    'and the audit log says why, for each');
  ok(h.requestPause.heldCount() === 0 && req.id, 'they are not left held for ever');
}

console.log('=== the start-up wiring: put back before any plugin loads, run at the connect ===');
{
  const src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const restoreAt = src.indexOf('requestPause.restore()');
  ok(restoreAt > 0 && restoreAt < src.indexOf('pluginManager.load('), 'restore() runs before the plugins load (and before any message)');
  ok(/new PluginManager\(\{[^}]*requestPause/.test(src), 'the plugins are given the pause');
  ok(/isPaused\(\) && requestPause\.heldCount\(\)[\s\S]{0,40}requestPause\.replay\(\)/.test(src), 'held requests run at the connect when not paused');
}

/* ======================= the box's command channel ======================= */

console.log('=== bot-cmd: pause-requests and resume-requests, audited ===');
{
  const h = harness();
  const auditNs = memStore();
  const stateStore = { namespace: (n) => (n === 'audit' ? auditNs : memStore()) };
  const deps = { bot: { ...h.bot, status: () => ({ state: 'connected' }) }, dataDir: TMP, requestPause: h.requestPause, queue: h.queue };
  const cmd = { op: 'pause-requests', by: 'main session' };
  const res = await runAdminCommand(cmd, deps);
  ok(res.ok && res.paused && res.pausedQueue && h.queue.paused, 'pause-requests pauses them, and the queue');
  auditAdminCommand(stateStore, cmd, res);
  ok(/paused requests from the box, and the queue/.test(auditNs.get('events')?.[0]?.action ?? ''), 'and is in the audit log');
  const health = await runAdminCommand({ op: 'health' }, deps);
  ok(health.requests?.paused === true && health.requests.by === 'main session', 'health says requests are paused, and by whom');
  const status = await runAdminCommand({ op: 'queue-status' }, deps);
  ok(status.requests?.paused === true && status.safeToRestart === true, 'queue-status too; held requests do not make a restart unsafe');
  await moviePlugin.onMessage(mkMsg('#request Dune 2021', MOVIES), h.movieCtx);
  const rcmd = { op: 'resume-requests', by: 'main session' };
  const r2 = await runAdminCommand(rcmd, deps);
  ok(r2.ok && r2.paused === false && r2.resumedQueue && r2.ran === 1, 'resume-requests resumes them and says how many held it runs');
  auditAdminCommand(stateStore, rcmd, r2);
  ok(/resumed requests from the box, and the queue/.test(auditNs.get('events')?.[0]?.action ?? '')
    && /running the 1 held/.test(auditNs.get('events')?.[0]?.detail ?? ''), 'audited with the count');
  let threw = null;
  try { await runAdminCommand({ op: 'pause-requests' }, { ...deps, requestPause: null }); } catch (err) { threw = err.message; }
  ok(/not available/.test(threw ?? ''), 'a process without the pause says so rather than pretending');
  await h.requestPause._replaying;
}

/* ============================ the panel's API ============================ */

async function boot(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  const cs = new ConfigStore({ dataDir: dir, masterKey: 'test-master-key-0123456789abcdef' });
  cs.load();
  cs.update({
    web: { admins: [{ username: 'alice', role: 'superadmin', passwordHash: hashPassword('alice-secret-1'), createdAt: 1, lastLogin: null }] },
    media: { workDir: path.join(dir, 'media') },
  });
  const spaces = new Map();
  const stateStore = { namespace(n) { if (!spaces.has(n)) spaces.set(n, memStore()); return spaces.get(n); } };
  const queue = new JobQueue({ concurrency: 1 });
  const out = [];
  const bot = Object.assign(new EventEmitter(), fakeBot(out), {
    dataDir: cs.dataDir, groupCache: new Map(), groups: () => [], state: 'connected', status: () => ({ state: 'connected' }),
  });
  const requestPause = new RequestPause({
    store: stateStore.namespace(NAMESPACE), queueStore: stateStore.namespace(QUEUE_NAMESPACE), queue, bot,
    audit: stateStore.namespace('audit'), getConfig: () => cs.get(),
  });
  requestPause.attach({ plugins: new Map() });
  const server = await new Promise((r) => {
    const s = createServer({
      configStore: cs, bot, queue, linkQueue: new JobQueue({ concurrency: 1 }),
      pluginManager: { plugins: new Map(), notifyConfigChange: async () => {} },
      stateStore, fileLogger: { tail: () => [] }, alerts: {}, lockScheduler: {}, failover: null, requestPause,
    }).listen(0, '127.0.0.1', () => r(s));
  });
  const port = server.address().port;
  let cookie = '';
  const call = (method, p, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = cookie ? { cookie } : {};
    if (data !== null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.headers['set-cookie']) cookie = res.headers['set-cookie'].map((x) => x.split(';')[0]).join('; ');
        let json = null;
        try { json = JSON.parse(buf); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('error', reject);
    if (data !== null) r.write(data);
    r.end();
  });
  /** The SSE stream: every event pushed, until closed. */
  const events = () => new Promise((resolve) => {
    const got = [];
    const r = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/events', headers: { cookie } }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev) got.push({ ev, data: data ? JSON.parse(data) : null });
        }
      });
      resolve({ got, close: () => r.destroy() });
    });
    r.on('error', () => {});
    r.end();
  });
  const login = await call('POST', '/api/auth/login', { username: 'alice', password: 'alice-secret-1' });
  if (login.status !== 200) throw new Error(`sign-in failed: ${login.status}`);
  return { call, events, queue, requestPause, stateStore, close: () => server.close() };
}

console.log('=== the API: pause and resume requests, guarded and audited, pushed over SSE ===');
{
  const s = await boot('api');
  const sse = await s.events();
  await settle(30);
  const first = sse.got.find((e) => e.ev === 'requestpause');
  ok(first && first.data.paused === false, 'the dashboard is told the state as soon as it connects');
  const p = await s.call('POST', '/api/requests/pause');
  ok(p.status === 200 && p.json.paused === true && p.json.by === 'alice' && p.json.pausedQueue === true, 'POST /api/requests/pause pauses them, by the admin signed in');
  ok(s.queue.paused, 'and the queue with them');
  await settle(30);
  ok(sse.got.filter((e) => e.ev === 'requestpause').at(-1)?.data.paused === true, 'and the change is pushed, not polled');
  const audit = s.stateStore.namespace('audit').get('events', []);
  ok(audit.some((e) => e.user === 'alice' && e.action === 'paused requests and the queue'), 'audited, by name');
  ok(!audit.some((e) => /^POST /.test(e.action)), 'once, without a second contentless row');
  const got = await s.call('GET', '/api/requests/pause');
  ok(got.status === 200 && got.json.paused === true, 'GET says so too');
  const r = await s.call('POST', '/api/requests/resume');
  ok(r.status === 200 && r.json.paused === false && !s.queue.paused, 'POST /api/requests/resume resumes them, and the queue');
  ok(s.stateStore.namespace('audit').get('events', []).some((e) => e.action === 'resumed requests and the queue'), 'audited');

  const qp = await s.call('POST', '/api/queue/pause');
  ok(qp.status === 200 && s.queue.paused && s.stateStore.namespace(QUEUE_NAMESPACE).get('state')?.paused === true
    && s.stateStore.namespace(QUEUE_NAMESPACE).get('state')?.by === 'alice', 'the queue\'s own Pause is now written down, by whom');
  await settle(30);
  ok(sse.got.filter((e) => e.ev === 'requestpause').at(-1)?.data.queue?.paused === true, 'and pushed, for the Queue card');
  await s.call('POST', '/api/queue/resume');
  ok(!s.queue.paused && s.stateStore.namespace(QUEUE_NAMESPACE).get('state')?.paused === false, 'and its Resume');
  sse.close();

  await s.call('POST', '/api/auth/logout');
  const anon = await s.call('POST', '/api/requests/pause');
  ok(anon.status === 401 && !s.requestPause.isPaused(), 'signed out, it is refused');
  s.close();
}

/* ============================ the dashboard ============================ */

let parseHTML = null;
try { ({ parseHTML } = await import('linkedom')); } catch { /* production install */ }
if (!parseHTML) {
  console.log('=== the dashboard: skipped - linkedom (a devDependency) is not installed ===');
} else {
  const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
  const { document, window } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const calls = [];
  let answer = {};
  const fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method ?? 'GET' });
    if (url === '/api/auth/status') return new Promise(() => {});
    if (url.startsWith('/api/wa/groups')) return new Promise(() => {});
    return { ok: true, status: 200, statusText: '200', text: async () => JSON.stringify(url.startsWith('/api/requests/') ? answer : {}) };
  };
  function EventSource() { this.addEventListener = () => {}; this.close = () => {}; }
  const win = { document, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { reload() {}, href: '' }, navigator: {}, scrollTo() {}, addEventListener() {} };
  const names = ['renderRequestPause', 'renderReactionGuide'];
  // eslint-disable-next-line no-new-func
  const make = new Function('window', 'document', 'localStorage', 'fetch', 'EventSource',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'confirm', 'alert', 'prompt', 'navigator', 'location',
    `"use strict";\n${app}\n;return { ${names.join(', ')} };`);
  const h = make(win, document, win.localStorage, fetch, EventSource,
    (fn) => { Promise.resolve().then(fn); return 1; }, () => {}, () => {}, () => {}, () => true, () => {}, () => null,
    win.navigator, win.location);
  const $ = (id) => document.getElementById(id);

  console.log('=== the dashboard: a button by the queue\'s Pause, and a banner while paused ===');
  {
    const qCard = html.slice(html.indexOf('id="btn-pause"'), html.indexOf('id="btn-pause"') + 1200);
    ok(qCard.includes('id="btn-req-pause"'), 'the control sits right by the queue\'s Pause and Resume');
    ok(/es\.addEventListener\('requestpause'/.test(app), 'and is kept live by the SSE push');
    const at = new Date(); at.setHours(14, 2, 0, 0);
    const snap = {
      paused: true, since: at.getTime(), by: 'alice', pausedQueue: true, held: 3, replaying: false,
      heldItems: [{ at: at.getTime(), plugin: 'movie-requests', kind: 'request', who: '+15550000001', text: 'Dune 2021' },
        { at: at.getTime(), plugin: 'tv-requests', kind: 'request', who: '+15550000002', text: 'The Boys S01' }],
      queue: { paused: true, since: at.getTime(), by: 'alice' },
    };
    h.renderRequestPause(snap);
    ok($('btn-req-pause').textContent === '▶️ Resume requests (runs 3 held)', `the button offers to resume, with the count ("${$('btn-req-pause').textContent}")`);
    ok(!$('card-req-paused').classList.contains('hidden'), 'the banner shows');
    ok($('req-paused-line').textContent === 'Requests paused since 14:02 by alice · 3 held', `on the 24-hour clock ("${$('req-paused-line').textContent}")`);
    ok(/Dune 2021/.test($('req-paused-held').innerHTML) && /The Boys S01 \(TV\)/.test($('req-paused-held').innerHTML)
      && /and 1 more/.test($('req-paused-held').innerHTML), 'with whose are waiting');
    ok(/stays paused through a restart/.test($('queue-paused-note').textContent) && /14:02/.test($('queue-paused-note').textContent),
      'the Queue card says since when the queue is paused, and that a restart keeps it');

    answer = { ...snap, paused: false, held: 3, replaying: true, heldItems: [], queue: { paused: false }, ran: 3 };
    $('btn-req-pause').dispatchEvent(new window.Event('click'));
    await settle(10);
    ok(calls.some((c) => c.url === '/api/requests/resume' && c.method === 'POST'), 'pressed while paused, it resumes');
    ok($('btn-req-pause').textContent === '⏸️ Pause requests' && $('card-req-paused').classList.contains('hidden'), 'and the banner goes');
    ok(/Running the held requests, in the order they came: 3 to go/.test($('req-pause-note').textContent), 'while they run, it says so');
    $('btn-req-pause').dispatchEvent(new window.Event('click'));
    await settle(10);
    ok(calls.some((c) => c.url === '/api/requests/pause' && c.method === 'POST'), 'pressed again, it pauses');

    // Found in review: the note read pausedQueue alone, and after the queue's
    // own Resume it went on saying the queue was paused while it downloaded.
    h.renderRequestPause({ ...snap, pausedQueue: true });
    ok(/paused with them, and resumes with them/.test($('req-pause-note').textContent), 'paused with them: the note says so');
    h.renderRequestPause({ ...snap, pausedQueue: false, queue: { paused: false, since: null, by: null } });
    ok(/The queue is running \(resumed by hand\)/.test($('req-pause-note').textContent) && !/paused/.test($('req-pause-note').textContent.replace('Resume requests', '')),
      `the queue resumed by hand while requests stay paused: the note says it runs ("${$('req-pause-note').textContent}")`);
    ok($('queue-paused-note').classList.contains('hidden'), 'and the Queue card agrees');
    h.renderRequestPause({ ...snap, pausedQueue: false, queue: { paused: true, since: at.getTime(), by: 'bob' } });
    ok(/paused by its own Pause; Resume requests leaves it paused/.test($('req-pause-note').textContent),
      'paused by its own Pause: Resume requests leaves it so');
  }

  console.log('=== the reaction legend card explains ⏸️ ===');
  {
    h.renderReactionGuide(DEFAULT_CONFIG.movieRequests.reactions);
    ok(/⏸️[\s\S]*requests are paused/.test($('reaction-guide').textContent), 'What the reactions mean has a line for it');
    // And none for 🔄, which no request gets since 2026-10-11 (Iron Man 3, a
    // restart's 🔄 read as "send it again"; test/no-redo-reaction.test.mjs) -
    // not even from a config.json that still holds one.
    h.renderReactionGuide({ ...DEFAULT_CONFIG.movieRequests.reactions, redo: '🔄' });
    const guide = $('reaction-guide').textContent;
    ok(!guide.includes('🔄') && !/Picked back up after a restart/.test(guide), 'and none for the redo reaction that is gone');
    ok(!$('r-redo'), 'nor a Settings field for it');
  }
}

console.log('=== the legends and the config know ⏸️ ===');
{
  ok(DEFAULT_CONFIG.movieRequests.reactions.paused === '⏸️', 'reactions.paused defaults to ⏸️');
  const { LEGEND, TV_LEGEND } = await import('../tools/legends.mjs');
  ok(/⏸️ On hold/.test(LEGEND) && /⏸️ On hold/.test(TV_LEGEND), 'both group legends explain it');
  ok(heldMessage({ id: 'x', key: null, text: 'hi' }).raw === undefined, 'a message with no key gets no quote to fail on');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
