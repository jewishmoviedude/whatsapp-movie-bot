/* A request asked for inside its member's cooldown is an extra in the fair queue.
   Run: node test/request-inside-cooldown-is-an-extra.test.mjs

   The operator, 2026-10-12, looking at the panel's queue: "I'm saying
   because in the queue is "11. Arrow season 1 / waiting extra / 23
   episodes" so I wanted you to manually adjust the queue that ... if any
   user did a request within the 3600 seconds/1 hour cooldown period it
   should go to bottom as extra". The fair order (queue.fairShare,
   test/fair-queue.test.mjs) ranked a request one more than its member's
   requests in the queue when it was asked for, so one asked for a minute
   after the member's previous request had left the queue - finished, or
   forgotten by a restart - was a first request. On the live box Eli
   Miller's Better Call Saul S01E07-E09, Ari's Hunter x Hunter season 1
   and shua's Marvel's Daredevil S02E05-E09 were each asked for a minute or
   two after the member's previous request, under the 30-second cooldown of
   the time; an hour's cooldown lets such a request through too when nobody
   else is waiting (cooldownOnlyWhenOthersWait).

   So a request the cooldown lets through inside its member's clock - read
   as the cooldown judged it (request-cooldown.js insideCooldown) - goes into
   the queue as an extra: rank 2 at least, never lower than the count makes
   it, journalled and told to expectBack, so a restart keeps it. Never for a
   request the cooldown does not hold - an admin's, one queued from the
   panel, a retry, one with no member, or any while the cooldown is 0 - and
   with the fair order off nothing changes at all. What was already waiting
   is marked once by the 'mark-extras' admin command (src/core/mark-extras.js),
   from the plugins' History: a dry run changes nothing, an apply moves
   exactly those requests and keeps an admin's moves, and a second apply
   changes nothing. These drive the real JobQueue, and the real TV and film
   plugins wherever what they queue and journal matters. */
import './fixtures/roomy-disk.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobQueue } from '../src/core/queue.js';
import tvPlugin from '../src/plugins/tv-requests/index.js';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import { insideCooldown, MemberCooldown } from '../src/core/request-cooldown.js';
import { holdTvRecovery } from '../src/media/resume.js';
import { runAdminCommand, auditAdminCommand, summariseAdminCommand } from '../src/core/admin-commands.js';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const NUM = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const HOUR = 3600;
const MIN = 60_000;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'inside-cooldown-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const LIB = path.join(TMP, 'lib');
const WORK = path.join(TMP, 'work');
fs.mkdirSync(LIB);
fs.mkdirSync(WORK);

/* ----------------------------------------------------------- the queue */

const MARK = { what: 'Arrow season 1', at: 1, gapMs: MIN };
const job = (label, who, meta = {}, extra = {}) => ({
  label, meta: { ...(who ? { memberKey: who } : {}), ...meta }, run: async () => {}, ...extra,
});
const waitingOf = (q) => q.snapshot().pending.map((e) => e.label);
const itemOf = (q, label) => q.snapshot().pending.find((e) => e.label === label);

console.log('=== the queue: a request asked for inside its cooldown is an extra, behind another member\'s first ===');
{
  const q = new JobQueue({ concurrency: 1, fairShare: true });
  q.pause();
  // Ari's Arrow has left the queue; he asks again a minute on, alone in it.
  q.add(job('Ari: Hunter x Hunter', 'ari', { insideCooldown: MARK }));
  q.add(job('Eli: Up', 'eli'));
  ok(waitingOf(q).join() === 'Eli: Up,Ari: Hunter x Hunter',
    `Eli's first request goes ahead of Ari's, asked inside his cooldown (${waitingOf(q).join()})`);
  const ari = itemOf(q, 'Ari: Hunter x Hunter');
  ok(ari.fair?.extra === true && ari.fair.rank === 2, `and the panel marks Ari's extra, rank 2 (${JSON.stringify(ari.fair)})`);
  ok(!itemOf(q, 'Eli: Up').fair, 'Eli\'s is a first request');
  q.add(job('Cal: Heat', 'cal'));
  ok(waitingOf(q).join() === 'Eli: Up,Cal: Heat,Ari: Hunter x Hunter', `and each new first goes ahead of it too (${waitingOf(q).join()})`);
}

console.log('=== the queue: the count still applies on top - never a lower rank ===');
{
  const q = new JobQueue({ concurrency: 1, fairShare: true });
  q.pause();
  q.add(job('Ari 1', 'ari'));
  q.add(job('Ari 2', 'ari'));
  q.add(job('Ari 3', 'ari', { insideCooldown: MARK }));
  ok(itemOf(q, 'Ari 3').fair?.rank === 3, `his third, inside the cooldown too, is still third (${itemOf(q, 'Ari 3').fair?.rank})`);
  ok(itemOf(q, 'Ari 2').fair?.rank === 2 && !itemOf(q, 'Ari 1').fair, 'and the others keep their ranks');
}

console.log('=== the queue: never for a job from the panel, an assigned one, a retry, or one with no member ===');
{
  const q = new JobQueue({ concurrency: 1, fairShare: true });
  q.pause();
  q.add(job('Panel', 'ari', { requester: 'manual (admin)', insideCooldown: MARK }));
  q.add(job('Assigned', 'ari', { requester: 'ari', assigned: true, insideCooldown: MARK }));
  q.add(job('Nobody', null, { insideCooldown: MARK }));
  q.add(job('Retry', 'ari', { insideCooldown: MARK }, { retry: 'failed' }));
  q.add(job('Bob', 'bob'));
  ok(q.snapshot().pending.every((e) => !e.fair), 'none of them is an extra');
  ok(waitingOf(q).join() === 'Retry,Panel,Assigned,Nobody,Bob', `and the line is as it always was (${waitingOf(q).join()})`);
}

console.log('=== the queue: with the fair order off, nothing changes ===');
{
  const marked = new JobQueue({ concurrency: 1 });
  const plain = new JobQueue({ concurrency: 1 });
  for (const q of [marked, plain]) q.pause();
  marked.add(job('Ari', 'ari', { insideCooldown: MARK }));
  marked.add(job('Bob', 'bob'));
  plain.add(job('Ari', 'ari'));
  plain.add(job('Bob', 'bob'));
  const view = (q) => q.snapshot().pending.map((e) => `${e.place}.${e.label}${e.fair ? '*' : ''}`).join();
  ok(view(marked) === view(plain) && view(plain) === '1.Ari,2.Bob', `the same line, in arrival order (${view(marked)})`);
}

console.log('=== the queue: put back after a restart, it is still an extra - an old entry loads as before ===');
{
  const q = new JobQueue({ concurrency: 1, fairShare: true });
  q.pause();
  const t0 = Date.now() - 10 * MIN;
  q.expectBack([
    { key: 'k-ari', meta: { memberKey: 'ari', insideCooldown: MARK }, at: t0, label: 'Ari' },
    { key: 'k-cal', meta: { memberKey: 'cal' }, at: t0 + 1, label: 'Cal (journalled before the mark existed)' },
  ]);
  // Back as jobs that do not say it themselves: what expectBack was told is enough.
  q.add(job('Ari back', 'ari', {}, { rankKey: 'k-ari' }));
  q.add(job('Cal back', 'cal', {}, { rankKey: 'k-cal' }));
  q.add(job('Bob new', 'bob'));
  ok(waitingOf(q).join() === 'Cal back,Bob new,Ari back', `Ari's comes back an extra (${waitingOf(q).join()})`);
  ok(itemOf(q, 'Ari back').fair?.rank === 2 && !itemOf(q, 'Cal back').fair, 'and Cal\'s, which never had the mark, a first');
}

console.log('=== markInsideCooldown: an extra from now, said once, and nothing twice ===');
{
  const q = new JobQueue({ concurrency: 1, fairShare: true });
  q.pause();
  q.add(job('Ari', 'ari'));
  q.add(job('Bob', 'bob'));
  q.add(job('Cal', 'cal'));
  q.add(job('Panel', null, { requester: 'panel (owner)' }));
  let states = 0;
  q.on('state', () => { states += 1; });
  const line = q.fairLine();
  ok(line.requests.map((r) => `${r.label}:${r.rank}:${r.member ?? '-'}`).join() === 'Ari:1:ari,Bob:1:bob,Cal:1:cal,Panel:1:-',
    `fairLine says each request's rank and member (${line.requests.map((r) => `${r.label}:${r.rank}:${r.member ?? '-'}`).join()})`);
  ok(states === 0, 'reading it tells nobody anything');
  const ari = line.requests[0].key;
  const [r] = q.markInsideCooldown([{ key: ari, mark: MARK }]);
  ok(r?.before === 1 && r.after === 2 && !r.already && !r.moved, `Ari's goes from 1 to 2 (${JSON.stringify(r)})`);
  ok(waitingOf(q).join() === 'Bob,Cal,Panel,Ari', `and behind every first request (${waitingOf(q).join()})`);
  ok(states === 1, `the panel and the place-in-line reactions are told once (${states})`);
  ok(itemOf(q, 'Ari').meta.insideCooldown?.what === 'Arrow season 1', 'its meta says what it was inside of');
  const [again] = q.markInsideCooldown([{ key: ari, mark: MARK }]);
  ok(again?.already === true && again.after === 2 && states === 1 && waitingOf(q).join() === 'Bob,Cal,Panel,Ari',
    'marked again: already an extra, and nothing moves or is said');
  const panel = q.fairLine().requests.find((x) => x.label === 'Panel').key;
  ok(q.markInsideCooldown([{ key: panel }, { key: 'no-such-request' }]).every((x) => x === null),
    'a panel job, or a key that is not waiting, is never marked');
}

console.log('=== markInsideCooldown: an admin\'s moves stand ===');
{
  const q = new JobQueue({ concurrency: 1, fairShare: true });
  q.pause();
  // Jobs that run until the process ends, so one stays running below.
  const hang = { run: () => new Promise(() => {}) };
  for (const who of ['ari', 'bob', 'cal', 'dan']) q.add(job(who, who, {}, hang));
  const key = (label) => q.fairLine().requests.find((x) => x.label === label).key;
  // The admin moves Dan's up past Cal's: every request waiting keeps its
  // rank and place from then on (_keepLine), Dan's where it was put.
  q.move(key('dan'), 'up');
  ok(waitingOf(q).join() === 'ari,bob,dan,cal', `the admin's move (${waitingOf(q).join()})`);
  const [a] = q.markInsideCooldown([{ key: key('ari') }]);
  ok(a?.after === 2 && waitingOf(q).join() === 'bob,dan,cal,ari',
    `Ari's, left where it stood by the move, goes behind the first requests; the rest keep the admin's order (${waitingOf(q).join()})`);
  const [d] = q.markInsideCooldown([{ key: key('dan') }]);
  ok(d?.moved === true && d.before === 1 && d.after === 1 && waitingOf(q).join() === 'bob,dan,cal,ari',
    `Dan's, moved by the admin's own hand, stays where they put it (${JSON.stringify(d)})`);
  q.add(job('eve', 'eve', {}, hang));
  ok(waitingOf(q).join() === 'bob,dan,cal,eve,ari', `a new first request goes ahead of Ari's extra (${waitingOf(q).join()})`);
  q.resume();
  await settle();
  q.pause();
  const running = q.snapshot().active.map((e) => e.label).join();
  ok(running === 'bob', `Bob's starts first (${running})`);
  const bobKey = [...q.active.values()][0]?.id;
  ok(q.markInsideCooldown([{ key: bobKey }])[0] === null, 'and a request running is never marked');
  q.close();
}

/* ------------------------------------------------------- the plugins */

const TVREQ = 'tvreq@g.us';
const FILMREQ = 'films@g.us';
const NUMBERS = {
  avi: '15550000001', bob: '15550000002', cal: '15550000003', dan: '15550000004',
  eve: '15550000005', fay: '15550000006', gil: '15550000007', hal: '15550000008',
};
const FILMS = {
  heat: { Title: 'Heat', Year: '1995', Rated: 'PG', imdbID: 'tt0113277' },
  dune: { Title: 'Dune', Year: '2021', Rated: 'PG-13', imdbID: 'tt1160419' },
  up: { Title: 'Up', Year: '2009', Rated: 'PG', imdbID: 'tt1049413' },
  alien: { Title: 'Alien', Year: '1979', Rated: 'PG', imdbID: 'tt0078748' },
};
for (const f of Object.values(FILMS)) fs.writeFileSync(path.join(LIB, `${f.Title} (${f.Year}).mp4`), 'not really a film');

// OMDb for the films; Jellyfin, with one show of eight two-episode seasons, for TV.
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  if (u.hostname.includes('omdbapi')) {
    const q = String(u.searchParams.get('t') ?? u.searchParams.get('s') ?? '').toLowerCase();
    const f = Object.entries(FILMS).find(([k]) => q.includes(k))?.[1];
    return json(f ? { Response: 'True', Type: 'movie', ...f } : { Response: 'False', Error: 'Movie not found!' });
  }
  if (u.hostname === 'jf') {
    const s = String(url);
    if (s.includes('/Items')) {
      const term = String(u.searchParams.get('searchTerm') ?? '').toLowerCase();
      return json({ Items: !term || term.includes('boys') ? [{ Id: 'SER1', Name: 'The Boys', ProductionYear: 2019 }] : [] });
    }
    if (s.includes('/Seasons')) return json({ Items: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ Id: `S${i}`, IndexNumber: i })) });
    if (s.includes('/Episodes')) {
      const season = Number(u.searchParams.get('season') ?? 1);
      return json({
        Items: [1, 2].map((e) => ({
          Id: `S${season}E${e}`, SeriesName: 'The Boys', ParentIndexNumber: season, IndexNumber: e,
          Name: `Ep ${e}`, MediaSources: [{ Path: `/s${season}e${e}.mkv`, Size: e }],
        })),
      });
    }
  }
  return json({}, 404);
};

/** A store over a plain object, as state.js namespaces behave. */
const storeOf = (data) => ({
  get: (k, d = null) => (k in data ? structuredClone(data[k]) : d),
  set: (k, v) => { data[k] = structuredClone(v); },
  delete: (k) => { delete data[k]; },
  data,
});

function makeConfig({ tvCooldown = HOUR, filmCooldown = HOUR } = {}) {
  return mergeDefaults({
    tvRequests: {
      enabled: true, requestGroups: [TVREQ], postsGroups: ['tvposts@g.us'], cooldownSecondsPerUser: tvCooldown,
      cooldownOnlyWhenOthersWait: true, blockedRatings: [], requirePrefix: false, maxEpisodesPerRequest: 0,
    },
    movieRequests: {
      requestGroups: [FILMREQ], postsGroup: 'posts@g.us', cooldownSecondsPerUser: filmCooldown,
      cooldownOnlyWhenOthersWait: true, blockedRatings: [], requirePrefix: false, rules: 'one at a time',
    },
    omdb: { apiKey: 'test-key' },
    library: {
      provider: 'local', local: { roots: [LIB], extensions: ['.mp4'] },
      jellyfin: { baseUrl: 'http://jf:8096', accessToken: 'TOK', userId: 'U1' },
    },
    media: { workDir: WORK },
    queue: { fairShare: true },
  }, DEFAULT_CONFIG);
}

let n = 0;
function msgFrom(who, text, chatJid) {
  n += 1;
  const id = `m${n}`;
  return {
    id, key: { id, remoteJid: chatJid }, text, chatJid, isGroup: true, fromMe: false, messageType: 'conversation',
    senderJid: `${who}@lid`, senderNumber: NUMBERS[who], senderNumberDisplay: null, pushName: who, timestamp: Date.now(),
  };
}

/**
 * Both plugins as a start of the bot has them, on one queue and one bot,
 * over stores that outlive it: a restart is another world over the same
 * data. Each plugin is a fresh object, as in a new process, and runs no
 * real download: an episode or a film that starts waits for `finish()`.
 */
function world({ config = makeConfig(), fairShare = true, admins = [], tvData = {}, filmData = {}, paused = true } = {}) {
  const calls = [];
  const bot = {
    isConnected: () => true,
    isGroupAdmin: (chat, { number } = {}) => admins.some((w) => NUMBERS[w] === String(number ?? '').replace(/\D/g, '')),
    react: async (msg, emoji, { unless = null } = {}) => {
      if (unless?.()) return false;
      calls.push({ id: msg.id, emoji });
      return true;
    },
    sendText: async () => ({ key: { id: `out-${++n}` } }),
    deleteMessage: async () => {}, archiveChat: async () => {}, groupMemberInfo: () => ({ isMember: false }),
    groups: () => [], on() {}, off() {}, _bulkPace: async () => {},
  };
  const queue = new JobQueue({ concurrency: 1, maxLength: 50, fairShare });
  if (paused) queue.pause();
  const running = [];
  const tv = Object.create(tvPlugin);
  tv.deliverEpisode = ({ ep, ctx, reqKey }) => new Promise((resolve) => running.push(() => {
    tv._journalEpisodeDone(ctx, reqKey, ep.id, 'done', null, { keepWork: true });
    resolve();
  }));
  const film = Object.create(moviePlugin);
  film._reactors = new Map();
  film.deliver = ({ ctx, jobKey }) => new Promise((resolve) => running.push(() => {
    film._journalRemove(ctx, jobKey, { keepWork: true });
    resolve();
  }));
  const configStore = { get: () => config, update() {} };
  const tvCtx = { config, bot, queue, store: storeOf(tvData), log: quiet, configStore };
  const filmCtx = { config, bot, queue, store: storeOf(filmData), log: quiet, configStore };
  // What the film plugin's setup hooks up: each waiting film's number follows the line.
  for (const ev of ['added', 'updated', 'state']) queue.on(ev, () => film._updatePositions(filmCtx));
  const w = {
    config, queue, tv, film, tvCtx, filmCtx, calls, running, tvData, filmData,
    // As a start does: each plugin tells the queue what it will put back,
    // the films go back in first, then the TV.
    async start() {
      const leftover = new Set((filmCtx.store.get('pending', []) ?? []).map((p) => p.jobKey));
      film._expectBack(filmCtx, leftover);
      const release = holdTvRecovery(queue);
      const tvUp = tv.setup(tvCtx);
      try { await film.recoverPending(filmCtx, { leftover }); } finally { release(); }
      await tvUp;
      await settle();
      return w;
    },
    async askTv(who, text) { const m = msgFrom(who, text, TVREQ); await tv.onMessage(m, tvCtx); await settle(); return m; },
    async askFilm(who, text) { const m = msgFrom(who, text, FILMREQ); await film.onMessage(m, filmCtx); await settle(); return m; },
    async finish() { running.shift()?.(); await settle(); },
    waiting: () => queue.snapshot().pending.map((e) => e.label),
    item: (label) => queue.snapshot().pending.find((e) => e.label === label),
    place: (msg) => calls.filter((c) => c.id === msg.id && NUM.includes(c.emoji)).map((c) => c.emoji).at(-1) ?? null,
    journalTv: (msg) => (tvData.pending ?? []).find((r) => r.msgId === msg.id),
    journalFilm: (msg) => (filmData.pending ?? []).find((p) => p.msgId === msg.id),
    async stop() { await tv.teardown(); queue.close(); },
  };
  return w;
}

/** The member's first request, queued, run and finished, and their clock moved back by `ago`: it ended that long ago. */
async function firstFinished(w, who, text, ago) {
  w.queue.resume();
  await w.askTv(who, text);
  while (w.running.length) await w.finish();
  w.queue.pause();
  const clock = w.tvCtx.store.get(`cooldown:${who}@lid`);
  if (clock) w.tvCtx.store.set(`cooldown:${who}@lid`, { ...clock, at: clock.at - ago });
  return clock;
}

console.log('=== TV: a second request a minute after the first finished is an extra, behind another member\'s first ===');
let afterB1 = null;
{
  const w = await world().start();
  const clock = await firstFinished(w, 'avi', 'The Boys season 1', MIN);
  ok(clock?.what === 'The Boys season 1', 'Avi\'s season 1 ran and finished, and his clock runs from it');
  ok(!w.queue.snapshot().active.length && !w.waiting().length, 'nothing of his is left in the queue');
  const s2 = await w.askTv('avi', 'The Boys season 2');
  ok(w.waiting().join() === 'The Boys season 2', 'a minute on, alone in the queue, his season 2 is let through (cooldownOnlyWhenOthersWait)');
  const s3 = await w.askTv('bob', 'The Boys season 3');
  ok(w.waiting().join() === 'The Boys season 3,The Boys season 2',
    `Bob's first request goes ahead of it (${w.waiting().join()})`);
  const mine = w.item('The Boys season 2');
  ok(mine.fair?.extra === true && mine.fair.rank === 2, `Avi's is an extra, rank 2 (${JSON.stringify(mine.fair)})`);
  ok(mine.meta.insideCooldown?.what === 'The Boys season 1' && mine.meta.insideCooldown.gapMs >= MIN
    && mine.meta.insideCooldown.gapMs < MIN + 5000, `inside the clock his season 1 started (${JSON.stringify(mine.meta.insideCooldown)})`);
  ok(w.journalTv(s2)?.insideCooldown?.what === 'The Boys season 1', 'and journalled so');
  ok(!w.journalTv(s3)?.insideCooldown && !w.item('The Boys season 3').fair, 'Bob\'s is neither');
  ok(w.place(s3) === '1️⃣' && w.place(s2) === '2️⃣', `their messages show the places (${w.place(s3)} ${w.place(s2)})`);
  await w.stop();
  afterB1 = { tvData: w.tvData, filmData: w.filmData, s2, s3 };
}

console.log('=== TV: after the cooldown it is a first request again ===');
{
  const w = await world().start();
  await firstFinished(w, 'avi', 'The Boys season 1', HOUR * 1000 + MIN);
  const s2 = await w.askTv('avi', 'The Boys season 2');
  await w.askTv('bob', 'The Boys season 3');
  ok(w.waiting().join() === 'The Boys season 2,The Boys season 3', `an hour and a minute on, in arrival order (${w.waiting().join()})`);
  ok(!w.item('The Boys season 2').fair && !w.journalTv(s2)?.insideCooldown, 'and not an extra');
  await w.stop();
}

console.log('=== TV: never an admin\'s, never the panel\'s, never with a cooldown of 0 ===');
{
  // An admin: the cooldown never holds them, so their clock never starts;
  // one from before they were made admin is written here, and still nothing.
  const a = await world({ admins: ['avi'] }).start();
  await firstFinished(a, 'avi', 'The Boys season 1', MIN);
  ok(a.tvCtx.store.get('cooldown:avi@lid') === null, 'an admin\'s request starts no clock');
  a.tvCtx.store.set('cooldown:avi@lid', { at: Date.now() - MIN, what: 'The Boys season 1' });
  const s2 = await a.askTv('avi', 'The Boys season 2');
  await a.askTv('bob', 'The Boys season 3');
  ok(a.waiting().join() === 'The Boys season 2,The Boys season 3' && !a.journalTv(s2)?.insideCooldown,
    `an admin's request is never an extra (${a.waiting().join()})`);
  await a.stop();

  // The panel: typed in, and assigned to Avi, while his clock runs.
  const p = await world().start();
  await firstFinished(p, 'avi', 'The Boys season 1', MIN);
  await p.tv.requeue('The Boys season 2', p.tvCtx);
  await p.tv.requeue('The Boys season 4', p.tvCtx, {
    requester: 'panel (owner)', member: { name: 'avi', jid: 'avi@lid', number: NUMBERS.avi, display: `+${NUMBERS.avi}` },
  });
  await p.askTv('bob', 'The Boys season 3');
  ok(p.waiting().join() === 'The Boys season 2,The Boys season 4,The Boys season 3',
    `jobs from the panel, assigned to him or not, are never extras (${p.waiting().join()})`);
  ok(p.queue.snapshot().pending.every((e) => !e.fair && !e.meta.insideCooldown), 'none is marked');
  await p.stop();

  // A cooldown of 0: no cooldown, so nothing is inside it.
  const z = await world({ config: makeConfig({ tvCooldown: 0 }) }).start();
  await firstFinished(z, 'avi', 'The Boys season 1', MIN);
  z.tvCtx.store.set('cooldown:avi@lid', { at: Date.now() - MIN, what: 'The Boys season 1' });
  const z2 = await z.askTv('avi', 'The Boys season 2');
  await z.askTv('bob', 'The Boys season 3');
  ok(z.waiting().join() === 'The Boys season 2,The Boys season 3' && !z.journalTv(z2)?.insideCooldown,
    `with the TV cooldown at 0, never (${z.waiting().join()})`);
  await z.stop();

  // And the clock it reads is the cooldown's own: the same answer at the same moment.
  const store = storeOf({});
  const keys = { clock: 'cooldown:x', answers: 'cooldown-answers:x' };
  store.set(keys.clock, { at: 1_000_000, what: 'One' });
  const cool = new MemberCooldown({ section: 'TV' });
  for (const now of [1_000_000 + HOUR * 1000 - 1, 1_000_000 + HOUR * 1000]) {
    const refused = cool.refusal(store, keys, { cooldownMs: HOUR * 1000, now })?.why === 'clock';
    ok(refused === !!insideCooldown(store, keys, { cooldownMs: HOUR * 1000, now }),
      `${now - 1_000_000} ms on: the cooldown ${refused ? 'refuses' : 'lets it go'}, and inside it is ${refused}`);
  }
  ok(insideCooldown(store, keys, { cooldownMs: 0, now: 1_000_001 }) === null, 'and a cooldown of 0 is never inside');
}

console.log('=== TV: with the fair order off, nothing changes ===');
{
  const views = [];
  for (const ago of [MIN, HOUR * 1000 + MIN]) {
    const w = await world({ fairShare: false }).start();
    await firstFinished(w, 'avi', 'The Boys season 1', ago);
    await w.askTv('avi', 'The Boys season 2');
    const s3 = await w.askTv('bob', 'The Boys season 3');
    views.push(w.queue.snapshot().pending.map((e) => `${e.place}.${e.label}${e.fair ? '*' : ''}`).join());
    views.push(w.place(s3));
    await w.stop();
  }
  ok(views[0] === views[2] && views[0] === '1.The Boys season 2,2.The Boys season 3',
    `inside the cooldown or not, the same line in arrival order (${views[0]} / ${views[2]})`);
  ok(views[1] === views[3], `and the same place on Bob's message (${views[1]} / ${views[3]})`);
}

console.log('=== TV: a restart keeps it, and an entry journalled before the mark loads as before ===');
{
  const { tvData, filmData, s2 } = afterB1;
  // Cal's request, journalled by a version that knew nothing of the mark.
  tvData.pending.push({
    reqKey: 'tv-cal-old', label: 'The Boys season 5 — 2 episode(s)', msgId: 'cal-old', msgKey: { id: 'cal-old', remoteJid: TVREQ },
    chatJid: TVREQ, requester: `+${NUMBERS.cal}`, requesterNumber: NUMBERS.cal, memberKey: `num:${NUMBERS.cal}`,
    baseRow: { id: 'cal-old', kind: 'tv', status: 'queued', at: Date.now(), requestedAt: Date.now() },
    episodes: [1, 2].map((e) => ({ id: `S5E${e}`, series: 'The Boys', season: 5, episode: e, title: `Ep ${e}`, size: e })),
    startedAt: 0,
  });
  const w = world({ tvData, filmData });
  // The queue is told before anything is back.
  const told = [];
  const expect = w.queue.expectBack.bind(w.queue);
  w.queue.expectBack = (list) => { told.push(...list); return expect(list); };
  await w.start();
  const avi = told.find((x) => x.key === w.journalTv(s2)?.reqKey);
  ok(avi?.meta?.insideCooldown?.what === 'The Boys season 1', 'expectBack is told Avi\'s season 2 was asked inside his cooldown');
  ok(w.waiting().join() === 'The Boys season 3,The Boys season 5,The Boys season 2',
    `back in the queue it is still an extra, behind Bob's and Cal's first requests (${w.waiting().join()})`);
  ok(w.item('The Boys season 2').fair?.rank === 2 && !w.item('The Boys season 5').fair,
    'Avi\'s rank 2; Cal\'s, journalled without the mark, a first as it always was');
  await w.stop();
}

console.log('=== films: inside the cooldown, the film is an extra; a restart keeps it ===');
{
  const w = await world().start();
  // His Heat ran and finished a minute ago: the clock its queueing started
  // (a film runs through deliver(), which is not what this is about).
  w.filmCtx.store.set('cooldown:avi@lid', { at: Date.now() - MIN, what: 'Heat (1995)' });
  const dune = await w.askFilm('avi', 'dune 2021');
  const up = await w.askFilm('bob', 'up 2009');
  ok(w.waiting().join() === 'Up (2009),Dune (2021)', `Bob's first film goes ahead of Avi's (${w.waiting().join()})`);
  ok(w.item('Dune (2021)').fair?.rank === 2 && w.item('Dune (2021)').meta.insideCooldown?.what === 'Heat (1995)',
    'Avi\'s Dune is an extra, inside the clock his Heat started');
  ok(w.journalFilm(dune)?.meta?.insideCooldown?.what === 'Heat (1995)' && !w.journalFilm(up)?.meta?.insideCooldown,
    'and journalled so; Bob\'s is not');
  ok(w.place(up) === '1️⃣' && w.place(dune) === '2️⃣', `their messages show the places (${w.place(up)} ${w.place(dune)})`);
  await w.stop();

  // Cal's film, journalled before the mark existed.
  w.filmData.pending.push({
    jobKey: 'cal-alien:tt0078748', msgId: 'cal-alien', msgKey: { id: 'cal-alien', remoteJid: FILMREQ }, chatJid: FILMREQ,
    movie: { title: 'Alien', year: 1979, imdbId: 'tt0078748', rated: 'PG' },
    meta: { requester: 'cal', requesterNumber: `+${NUMBERS.cal}`, group: FILMREQ, imdbId: 'tt0078748', memberKey: `num:${NUMBERS.cal}` },
    record: { id: 'cal-alien', request: 'alien 1979', status: 'queued', title: 'Alien', year: 1979, requester: 'cal' },
    at: Date.now(), startedAt: 0,
  });
  const back = await world({ tvData: w.tvData, filmData: w.filmData }).start();
  ok(back.waiting().join() === 'Up (2009),Alien (1979),Dune (2021)',
    `after a restart Dune is still behind both first requests (${back.waiting().join()})`);
  ok(back.item('Dune (2021)').fair?.rank === 2 && !back.item('Alien (1979)').fair, 'an extra; Cal\'s old entry a first');
  await back.stop();
}

console.log('=== films: a pick from a "which one?" list, inside the cooldown, queues an extra ===');
{
  // A pick meets no cooldown (it answers the bot's question), but the film
  // it queues is the member's request: the list's request was let through
  // inside his clock, and queued nothing itself.
  const w = await world().start();
  w.filmCtx.store.set('cooldown:avi@lid', { at: Date.now() - MIN, what: 'Heat (1995)' });
  const up = await w.askFilm('bob', 'up 2009');
  const asked = msgFrom('avi', 'dune', FILMREQ);
  const list = {
    id: asked.id, msg: asked, request: 'dune', route: null, state: 'picked', pickedIndex: 0,
    items: [{ title: 'Dune', year: 2021 }, { title: 'Dune', year: 1984 }],
    record: { pickList: { units: 1 } }, at: Date.now() - 5000, shownAt: Date.now() - 5000, pickedAt: Date.now(),
  };
  await w.film._runPick(w.filmCtx, list, 0, 'digit');
  await settle();
  ok(w.waiting().join() === 'Up (2009),Dune (2021)', `the picked Dune waits behind Bob's first film (${w.waiting().join()})`);
  ok(w.item('Dune (2021)').fair?.rank === 2 && w.journalFilm(asked)?.meta?.insideCooldown?.what === 'Heat (1995)',
    'an extra, journalled so');
  ok(w.place(up) === '1️⃣', 'Bob keeps 1️⃣');
  await w.stop();
}

console.log('=== films: never an admin\'s, never with a cooldown of 0 ===');
for (const [why, opts] of [['an admin', { admins: ['avi'] }], ['a cooldown of 0', { config: makeConfig({ filmCooldown: 0 }) }]]) {
  const w = await world(opts).start();
  w.filmCtx.store.set('cooldown:avi@lid', { at: Date.now() - MIN, what: 'Heat (1995)' });
  const dune = await w.askFilm('avi', 'dune 2021');
  await w.askFilm('bob', 'up 2009');
  ok(w.waiting().join() === 'Dune (2021),Up (2009)' && !w.journalFilm(dune)?.meta?.insideCooldown,
    `${why}: the film is not an extra (${w.waiting().join()})`);
  await w.stop();
}

/* ------------------------------------------------------ mark-extras */

console.log('=== mark-extras: what was waiting, judged from History; a dry run changes nothing ===');
{
  // The requests were queued under the old 30-second cooldown, as the live
  // ones were; the cooldown is an hour now (the operator, 2026-10-12).
  const config = makeConfig({ tvCooldown: 30, filmCooldown: 30 });
  const w = await world({ config, admins: ['dan'] }).start();
  const now = Date.now();
  // A TV row says how many episodes its request queued, as the plugin
  // writes it: what mark-extras goes by (src/core/mark-extras.js).
  const row = (who, id, request, status, ago, extra = {}) => ({
    id, kind: 'tv', at: now - ago, requestedAt: now - ago, requester: who, requesterJid: `${who}@lid`,
    requesterNumber: NUMBERS[who], requesterNumberDisplay: null, groupJid: TVREQ, request, title: 'The Boys', status,
    episodes: status === 'blocked-rating' ? 0 : 2, ...extra,
  });
  // Each member's earlier requests, as History holds them.
  w.tvCtx.store.set('history', [
    row('avi', 'h-avi', 'the boys s1', 'sent', 90_000),                      // posted; asked 1.5 min before
    row('bob', 'h-bob', 'the boys s1', 'sent', 2 * HOUR * 1000),            // two hours before
    row('cal', 'h-cal1', 'the boys s2', 'blocked-rating', MIN),              // a refusal queues nothing
    row('cal', 'h-cal2', 'the boys s1', 'sent', 3 * HOUR * 1000),
    row('dan', 'h-dan', 'the boys s1', 'sent', MIN),                         // an admin
    row('eve', 'h-eve', 'the boys s1', 'sent', MIN, { assignedBy: 'panel (owner)' }),   // the panel's
    row('fay', 'h-fay0', 'the boys s1', 'sent', 10 * MIN),                  // ten minutes before
    row('fay', 'h-fay', 'the boys s1', 'resent', MIN, { episodes: 0 }),      // and sent again while it waited
    row('hal', 'h-hal', 'the boys s1', 'sent', MIN),                         // TV, not a film
  ]);
  w.filmCtx.store.set('history', [{
    id: 'h-gil', at: now - 2 * MIN, requestedAt: now - 2 * MIN, requester: 'gil', requesterJid: 'gil@lid',
    requesterNumber: NUMBERS.gil, groupJid: FILMREQ, request: 'heat 1995', title: 'Heat', year: 1995, status: 'sent',
    enqueuedAt: now - 2 * MIN + 2000,
  }]);
  const ask = {};
  for (const [who, s] of [['avi', 2], ['bob', 3], ['cal', 4], ['dan', 5], ['eve', 6], ['fay', 7]]) {
    ask[who] = await w.askTv(who, `The Boys season ${s}`);
  }
  await w.tv.requeue('The Boys season 8', w.tvCtx);
  ask.gil = await w.askFilm('gil', 'dune 2021');
  ask.hal = await w.askFilm('hal', 'up 2009');
  const before = w.waiting().join();
  ok(before === 'Dune (2021),Up (2009),The Boys season 2,The Boys season 3,The Boys season 4,The Boys season 5,'
    + 'The Boys season 6,The Boys season 7,The Boys season 8', `every one a first request, in arrival order (${before})`);

  config.tvRequests.cooldownSecondsPerUser = HOUR;
  config.movieRequests.cooldownSecondsPerUser = HOUR;
  const pluginManager = { plugins: new Map([['tv-requests', { plugin: w.tv, ctx: w.tvCtx }], ['movie-requests', { plugin: w.film, ctx: w.filmCtx }]]) };
  const audit = [];
  const stateStore = { namespace: () => ({ push: (k, v) => audit.push(v), get: () => null, set() {} }) };
  const deps = { bot: w.tvCtx.bot, queue: w.queue, pluginManager, configStore: { get: () => config }, stateStore };
  let states = 0;
  w.queue.on('state', () => { states += 1; });
  const snap = JSON.stringify(w.queue.snapshot().pending);
  const journals = JSON.stringify([w.tvData.pending, w.filmData.pending]);

  const dry = await runAdminCommand({ op: 'mark-extras' }, deps);
  auditAdminCommand(stateStore, { op: 'mark-extras' }, dry);
  const res = (label) => dry.requests.find((r) => r.label === label);
  ok(dry.ok && dry.applied === false && dry.wouldMark === 3, `the dry run would mark three (${dry.wouldMark})`);
  const s2 = res('The Boys season 2');
  ok(s2.extra && s2.previous?.request === 'the boys s1' && s2.gapSeconds >= 90 && s2.gapSeconds < 95
    && s2.rank.before === 1 && s2.rank.after === 2 && s2.member?.name === 'avi',
    `Avi's season 2: ${s2.gap} after his season 1 was asked for, rank 1 -> 2 (${s2.why})`);
  // Her resend queued nothing and started no clock: what counts is the
  // request it repeated (found in review, 2026-10-12).
  ok(res('The Boys season 7').extra && res('The Boys season 7').previous?.status === 'sent'
    && res('The Boys season 7').gapSeconds >= 600 && res('The Boys season 7').gapSeconds < 605,
    `Fay's season 7: ten minutes after her request, not one after she sent it again (${res('The Boys season 7').why})`);
  ok(res('Dune (2021)').extra && res('Dune (2021)').previous?.title === 'Heat' && res('Dune (2021)').rank.after === 2,
    'Gil\'s Dune: two minutes after his Heat');
  ok(!res('The Boys season 3').extra && /2h after it: past the 1h TV cooldown/.test(res('The Boys season 3').why),
    `Bob's: two hours on, past it (${res('The Boys season 3').why})`);
  ok(!res('The Boys season 4').extra && res('The Boys season 4').previous?.request === 'the boys s1',
    'Cal\'s: the refusal a minute before queued nothing, and his request before that was hours ago');
  ok(!res('The Boys season 5').extra && /admin/.test(res('The Boys season 5').why), `Dan's: an admin (${res('The Boys season 5').why})`);
  ok(!res('The Boys season 6').extra && /no earlier TV request/.test(res('The Boys season 6').why),
    `Eve's: what the panel queued for her does not count (${res('The Boys season 6').why})`);
  ok(!res('The Boys season 8').extra && /panel/.test(res('The Boys season 8').why), 'the panel\'s own: never');
  ok(!res('Up (2009)').extra && /no earlier film request/.test(res('Up (2009)').why),
    `Hal's film: his TV request a minute before is another kind (${res('Up (2009)').why})`);
  ok(JSON.stringify(w.queue.snapshot().pending) === snap && JSON.stringify([w.tvData.pending, w.filmData.pending]) === journals,
    'the dry run moved nothing and wrote nothing');
  ok(states === 0 && audit.length === 0, `told nobody, and is no audit event (${states}, ${audit.length})`);
  ok(summariseAdminCommand({ op: 'mark-extras' }, dry) === null, 'a dry run is a read');

  console.log('=== mark-extras: apply moves exactly those, keeps the admin\'s moves, and a restart keeps it ===');
  // Before it runs, the admin moved Cal's season 4 to the top of the TV,
  // and Fay's season 7 up one, by hand.
  const keyOf = (label) => w.queue.fairLine().requests.find((r) => r.label === label).key;
  w.queue.moveTop(keyOf('The Boys season 4'));
  w.queue.move(keyOf('The Boys season 7'), 'up');
  ok(w.waiting().slice(2).join() === 'The Boys season 4,The Boys season 2,The Boys season 3,The Boys season 5,'
    + 'The Boys season 7,The Boys season 6,The Boys season 8', `the admin's moves (${w.waiting().slice(2).join()})`);
  states = 0;
  const applied = await runAdminCommand({ op: 'mark-extras', apply: true, by: 'owner' }, deps);
  auditAdminCommand(stateStore, { op: 'mark-extras', apply: true, by: 'owner' }, applied);
  await settle();
  const after = w.waiting().join();
  ok(after === 'Up (2009),Dune (2021),The Boys season 4,The Boys season 3,The Boys season 5,The Boys season 7,'
    + 'The Boys season 6,The Boys season 8,The Boys season 2',
    `Dune behind Hal's first film, Avi's season 2 behind every first; Cal's and Fay's where the admin put them (${after})`);
  const r = (label) => applied.requests.find((x) => x.label === label);
  ok(applied.applied && applied.marked === 3 && r('The Boys season 2').changed && r('Dune (2021)').changed
    && r('The Boys season 7').changed && applied.requests.filter((x) => x.changed).length === 3,
    `exactly three marked (${applied.requests.filter((x) => x.changed).map((x) => x.label).join(', ')})`);
  ok(r('The Boys season 2').rank.after === 2 && r('The Boys season 2').place.before === 4 && r('The Boys season 2').place.after === 9,
    `Avi's: rank 2, from 4th to 9th (${JSON.stringify(r('The Boys season 2').place)})`);
  ok(r('The Boys season 7').moved === true && r('The Boys season 7').rank.after === 1,
    'Fay\'s, moved by the admin\'s hand, keeps its place and rank for now');
  ok(w.item('The Boys season 2').fair?.extra && w.item('Dune (2021)').fair?.extra && !w.item('The Boys season 7').fair,
    'the panel marks Avi\'s and Gil\'s extra');
  ok(w.journalTv(ask.avi)?.insideCooldown?.by === 'mark-extras' && w.journalTv(ask.fay)?.insideCooldown?.by === 'mark-extras'
    && w.journalFilm(ask.gil)?.meta?.insideCooldown?.what === 'heat 1995',
    'and each is journalled as one, so a restart keeps it');
  ok(['bob', 'cal', 'dan', 'eve'].every((who) => !w.journalTv(ask[who])?.insideCooldown) && !w.journalFilm(ask.hal)?.meta?.insideCooldown,
    'nobody else is');
  ok(states === 1, `the panel and the reactions are told once (${states})`);
  ok(w.place(ask.avi) === NUM[8] && w.place(ask.hal) === NUM[0] && w.place(ask.gil) === NUM[1],
    `the place-in-line reactions follow (Avi ${w.place(ask.avi)}, Hal ${w.place(ask.hal)}, Gil ${w.place(ask.gil)})`);
  ok(audit.length === 1 && /made 3 waiting request\(s\) extras/.test(audit[0].action) && /owner - /.test(audit[0].detail),
    `one audit line (${audit[0]?.action}: ${audit[0]?.detail})`);

  states = 0;
  const snap2 = JSON.stringify(w.queue.snapshot().pending);
  const journals2 = JSON.stringify([w.tvData.pending, w.filmData.pending]);
  const again = await runAdminCommand({ op: 'mark-extras', apply: true }, deps);
  ok(again.marked === 0 && again.requests.every((x) => !x.changed)
    && again.requests.filter((x) => x.already).length === 3, 'a second apply finds them extras already');
  ok(JSON.stringify(w.queue.snapshot().pending) === snap2 && JSON.stringify([w.tvData.pending, w.filmData.pending]) === journals2
    && states === 0, 'and changes nothing at all');
  await w.stop();

  // A restart forgets the admin's moves, as it always has; the marks stay.
  const back = await world({ config, tvData: w.tvData, filmData: w.filmData, admins: ['dan'] }).start();
  ok(back.waiting().join() === 'Up (2009),Dune (2021),The Boys season 3,The Boys season 4,The Boys season 5,'
    + 'The Boys season 6,The Boys season 8,The Boys season 2,The Boys season 7',
    `after a restart Avi's and Fay's are extras, and Gil's Dune (${back.waiting().join()})`);
  const dry2 = await runAdminCommand({ op: 'mark-extras' }, { ...deps, queue: back.queue,
    pluginManager: { plugins: new Map([['tv-requests', { ctx: back.tvCtx }], ['movie-requests', { ctx: back.filmCtx }]]) } });
  ok(dry2.wouldMark === 0 && dry2.requests.filter((x) => x.already).length === 3, 'and nothing is left to mark');
  await back.stop();
}

console.log('=== mark-extras: not with the fair order off, nor while a restart is still putting requests back ===');
{
  const off = new JobQueue({ concurrency: 1 });
  const r = await runAdminCommand({ op: 'mark-extras', apply: true }, { queue: off, pluginManager: { plugins: new Map() }, configStore: { get: () => makeConfig() } });
  ok(r.ok && r.fairShare === false && r.applied === false && !r.requests.length, `fair order off: nothing (${r.note})`);
  const q = new JobQueue({ concurrency: 1, fairShare: true });
  q.expectBack([{ key: 'k', meta: { memberKey: 'ari' }, at: Date.now() }]);
  let err = null;
  try { await runAdminCommand({ op: 'mark-extras', apply: true }, { queue: q, pluginManager: { plugins: new Map() }, configStore: { get: () => makeConfig() } }); }
  catch (e) { err = e.message; }
  ok(/still being put back/.test(err ?? ''), `a restart's requests not back yet: run it again later (${err})`);
  const dry = await runAdminCommand({ op: 'mark-extras' }, { queue: q, pluginManager: { plugins: new Map() }, configStore: { get: () => makeConfig() } });
  ok(dry.ok && dry.applied === false, 'a dry run still answers');
  q.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
