/* A TV request shows its place in line, live, like a movie request.
   Run: node test/tv-queue-positions.test.mjs

   Reported by the operator: "in the TV requests group bot is not giving emoji
   reaction to requests with the spot in the queue that they are". A movie
   request's message has always carried a number (1️⃣ … 🔟, then 🔢) that
   moves as the line does; a TV request sat on 🎬 from being queued until its
   first episode started, however far back it was - while the group rules
   promise "1️⃣2️⃣3️⃣…🔟 Your place in line (updates live)" for both.

   The number is the request's TRUE place: a season is one place, and every
   waiting movie is ahead of TV while strict movie priority is on. Once an
   episode starts, the stage reactions own the message and no number may land
   on top of them. These run the real plugin against the real queue.

   It was put on Beta as 'tv-queue-positions' (beta002) and ran Off in the
   main groups, which is why the operator still saw no numbers. The operator
   (2026-09-29): "if it's always worked in the movie group why would it need
   to go to beta? I didn't instruct you to make that a beta". It is the movie
   group's behaviour brought to TV, so it has no flag: these run with an
   empty beta config, as a bot without one does. */
import fs from 'node:fs';
import plugin from '../src/plugins/tv-requests/index.js';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import { JobQueue } from '../src/core/queue.js';
import { holdTvRecovery } from '../src/media/resume.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const settle = () => new Promise((r) => setTimeout(r, 5));

const TVREQ = 'tvreq@g.us';
const POSTS = 'tvposts@g.us';
const TESTING = 'testing@g.us';
const NUM = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

// Two seasons, so a second request can be for episodes the first did not
// ask for: one for an episode already waiting is a duplicate, answered
// "already in the queue" and never queued (test/tv-duplicate-request.test.mjs).
const SERIES = { Items: [{ Id: 'SER1', Name: 'The Boys', ProductionYear: 2019 }] };
const SEASONS = { Items: [{ Id: 'S1', IndexNumber: 1 }, { Id: 'S2', IndexNumber: 2 }] };
const episodesOf = (season) => ({
  Items: [1, 2, 3].map((n) => ({
    Id: season === 1 ? `E${n}` : `S${season}E${n}`, SeriesName: 'The Boys', ParentIndexNumber: season, IndexNumber: n,
    Name: `Ep ${n}`, MediaSources: [{ Path: `/s${season}e${n}.mkv`, Size: n }],
  })),
});
globalThis.fetch = async (url) => {
  const u = String(url);
  const season = Number(new URL(u).searchParams.get('season') ?? 1);
  for (const [k, v] of Object.entries({ '/Items': SERIES, '/Seasons': SEASONS, '/Episodes': episodesOf(season) })) {
    if (u.includes(k)) return { ok: true, status: 200, json: async () => v };
  }
  return { ok: false, status: 404, statusText: 'NF', json: async () => ({}) };
};

/**
 * The bot, with the pacer made visible: every reaction waits in `line` until
 * its turn, and `unless` is asked then, as bot.react does. `shown` is what
 * each message is showing now.
 */
function fakeBot() {
  const t = { calls: [], shown: new Map(), withheld: [], notes: [], line: [], auto: true, shed: () => false };
  t.turn = () => {
    while (t.line.length) {
      const a = t.line.shift();
      if (t.shed(a)) { a.resolve(false); continue; }
      if (a.unless?.()) { t.withheld.push(`${a.msg.id}:${a.emoji}`); a.resolve(false); continue; }
      t.shown.set(a.msg.id, a.emoji);
      a.resolve(true);
    }
  };
  t.bot = {
    isConnected: () => true,
    isGroupAdmin: () => false,
    deleteMessage: async () => {},
    archiveChat: async () => {},
    sendText: async (jid, text) => { t.notes.push(text); return { key: { id: 'n' } }; },
    react: (msg, emoji, { kind = 'normal', unless = null } = {}) => new Promise((resolve) => {
      t.calls.push({ id: msg.id, emoji, kind });
      t.line.push({ msg, emoji, unless, resolve });
      if (t.auto) t.turn();
    }),
  };
  t.on = (id) => t.calls.filter((c) => c.id === id).map((c) => c.emoji);
  t.numbersOn = (id) => t.calls.filter((c) => c.id === id && NUM.concat('🔢').includes(c.emoji));
  return t;
}

/** The real queue, with each job's work replaced by a gate the test opens. */
function realQueue(opts = {}) {
  const q = new JobQueue({ concurrency: 1, maxLength: 104, ...opts });
  const gates = new Map();
  const add = q.add.bind(q);
  q.add = (job, o) => add({ ...job, run: () => new Promise((r) => gates.set(job.label, r)) }, o);
  q.finish = (label) => gates.get(label)?.();
  return q;
}

const NO_BETA = { groups: [], postsGroup: '', features: {} };

async function setUp({ queue = realQueue(), beta = NO_BETA, store = new Map(), awaitSetup = true } = {}) {
  await plugin.teardown();
  const t = fakeBot();
  const ctx = {
    config: {
      tvRequests: { enabled: true, requestGroups: [TVREQ], postsGroups: [POSTS], cooldownSecondsPerUser: 0, blockedRatings: [] },
      movieRequests: {
        reactions: {
          researching: '🔍', added: '🎬', failed: '⚠️', cancelled: '❌', skipped: '⏭️', done: '✅', redo: '🔄',
          duplicate: '🤥', downloading: '⬇️', positions: NUM, positionOverflow: '🔢',
        },
        notify: { group: 'notify@g.us' },
      },
      library: { jellyfin: { baseUrl: 'http://jf:8096', accessToken: 'TOK', userId: 'U1' } },
      media: { workDir: '/tmp/tv-positions-test' },
      ...(beta ? { beta } : {}),
    },
    bot: t.bot,
    queue,
    store: { get: (k, d) => (store.has(k) ? structuredClone(store.get(k)) : d), set: (k, v) => store.set(k, structuredClone(v)) },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  };
  // setup() recovers what the store holds before it resolves, waiting for
  // the films first; a test of what happens meanwhile does not wait for it.
  const ready = plugin.setup(ctx);
  if (awaitSetup) await ready;
  return { t, ctx, q: queue, store, ready };
}

let seq = 0;
const mkMsg = (text, chatJid = TVREQ) => {
  const id = `m${++seq}`;
  return {
    id, key: { id, remoteJid: chatJid }, text, chatJid, isGroup: true, fromMe: false, messageType: 'conversation',
    // A member of their own each: the same number is the same member
    // (requestMemberKey), and a member's own request asked again is not a
    // duplicate since 2026-10-11 (test/no-redo-reaction.test.mjs).
    senderJid: `u${seq}@lid`, senderNumber: `1555111${String(seq).padStart(4, '0')}`, senderNumberDisplay: '+1 555 111 2222', timestamp: Date.now(),
  };
};
const movie = (q, label) => q.add({ kind: 'movie', label, run: null });
const tvKeys = (q) => q.snapshot().pending.filter((e) => e.kind === 'tv').map((e) => e.id);

const ask = async (ctx, text, chat) => { const m = mkMsg(text, chat); await plugin.onMessage(m, ctx); await settle(); return m; };

console.log('=== movies waiting ahead count; a season is one place ===');
{
  const { t, ctx, q } = await setUp();
  q.pause();
  const m1 = movie(q, 'Inception (2010)');
  const season = await ask(ctx, 'The Boys season 1');
  ok(t.on(season.id).join(' ') === '🔍 🎬 2️⃣', `researching, added, then 2nd - the movie is ahead (${t.on(season.id).join(' ')})`);
  ok(t.calls.find((c) => c.id === season.id && c.emoji === '2️⃣').kind === 'low',
    'a place in line is low priority: the next one supersedes it');
  const single = await ask(ctx, 'The Boys S02E02');
  ok(t.shown.get(single.id) === '3️⃣', `the next request is 3rd, not 5th - three episodes are one place (${t.shown.get(single.id)})`);

  movie(q, 'Up (2009)'); await settle();
  ok(t.shown.get(season.id) === '3️⃣' && t.shown.get(single.id) === '4️⃣',
    'a movie asked for later still goes first, and both TV numbers move back');
  q.cancel(m1); await settle();
  ok(t.shown.get(season.id) === '2️⃣' && t.shown.get(single.id) === '3️⃣', 'and forward again when one ahead is cancelled');

  const before = t.calls.length;
  q.pause(); await settle();
  ok(t.calls.length === before, 'nothing is re-sent when no place changed');

  const [seasonKey, singleKey] = tvKeys(q);
  q.moveTop(singleKey); await settle();
  ok(t.shown.get(single.id) === '2️⃣' && t.shown.get(season.id) === '3️⃣', 'moving a request in the panel moves the numbers');
  ok(seasonKey && singleKey, 'each TV request is one row in the queue');
  await plugin.teardown();
}

console.log('=== once it starts, the stage reactions own the message ===');
{
  const { t, ctx, q } = await setUp();
  q.pause();
  movie(q, 'Up (2009)');
  const season = await ask(ctx, 'The Boys season 1');
  const later = await ask(ctx, 'The Boys S02E03');
  ok(t.shown.get(season.id) === '2️⃣' && t.shown.get(later.id) === '3️⃣', 'waiting: 2nd and 3rd');
  const [seasonKey] = tvKeys(q);
  q.resume(); await settle();                       // the movie starts
  ok(t.shown.get(season.id) === '1️⃣' && t.shown.get(later.id) === '2️⃣', 'the movie started, so both move up');

  const seen = t.numbersOn(season.id).length;
  q.finish('Up (2009)'); await settle();            // the season's first episode starts
  ok(q.snapshot().active.some((e) => e.label === 'The Boys season 1'), 'the season is running');
  ok(t.shown.get(later.id) === '1️⃣', 'the request behind it is next');
  q.finish('The Boys S01E01'); await settle();       // between two episodes
  q.finish('The Boys S01E02'); await settle();
  ok(t.numbersOn(season.id).length === seen, 'no number is put back on the season between its episodes');
  ok(!plugin._reactors.has(seasonKey) && plugin._reactors.size === 1, 'it is no longer tracked; the one behind it still is');
  await plugin.teardown();
}

console.log('=== a number still waiting for the pacer is withdrawn if the request starts ===');
{
  // The pacer sends by priority, so the ⬇️ of an episode that has just
  // started overtakes a 'low' number asked for a moment before - which would
  // then land on top of it and sit there through the whole download.
  const { t, ctx, q } = await setUp();
  q.pause();
  const m = movie(q, 'Up (2009)');
  const req = await ask(ctx, 'The Boys S01E01');
  ok(t.shown.get(req.id) === '2️⃣', 'waiting behind the movie: 2nd');
  t.auto = false;                                   // from here the pacer holds everything
  q.cancel(m); await settle();                      // 1st is asked for...
  ok(t.line.some((a) => a.msg.id === req.id && a.emoji === '1️⃣'), '1st is asked for, and waits its turn');
  q.resume(); await settle();                       // ...and before it goes, the episode starts
  t.shown.set(req.id, '⬇️');                       // which is what the stage reaction shows
  t.turn(); await settle();
  ok(t.shown.get(req.id) === '⬇️', `the number did not land on the stage reaction (showing ${t.shown.get(req.id)})`);
  ok(t.withheld.includes(`${req.id}:1️⃣`), 'it was withdrawn at its turn, not sent');
  t.auto = true;
  await plugin.teardown();
}

console.log('=== with strict movie priority off, plain arrival order ===');
{
  const q = realQueue({ strictMoviePriority: false });
  const { t, ctx } = await setUp({ queue: q });
  q.pause();
  const season = await ask(ctx, 'The Boys season 1');
  movie(q, 'Up (2009)'); await settle();
  const single = await ask(ctx, 'The Boys S02E02');
  ok(t.shown.get(season.id) === '1️⃣', `the season asked for first is 1st, movie or no movie (${t.shown.get(season.id)})`);
  ok(t.shown.get(single.id) === '3️⃣', `and the movie between them counts for the one behind (${t.shown.get(single.id)})`);
  await plugin.teardown();
}

console.log('=== a shed number is not recorded as shown ===');
{
  const { t, ctx, q } = await setUp();
  q.pause();
  movie(q, 'Up (2009)');
  t.shed = (a) => NUM.includes(a.emoji);           // the budget drops cosmetic work
  const req = await ask(ctx, 'The Boys S01E01');
  ok(t.shown.get(req.id) === '🎬', 'the number was dropped');
  t.shed = () => false;
  q.pause(); await settle();                        // any queue event
  ok(t.shown.get(req.id) === '2️⃣', 'so the next pass sends it, rather than believing it went');
  await plugin.teardown();
}

console.log('=== a beta test takes no place in line ===');
{
  // A beta group's request used to be queued and numbered like any other.
  // Since 2026-09-29 it is a test that queues nothing (beta.js): "as soon as
  // bot can confirm it will download it should basically be like "test
  // passed" and not actually queue a download of the file interrupting
  // actual requests" (the operator). So it has no place to show.
  const beta = { groups: [TESTING], postsGroup: '', features: { 'tv-rating-notice': 'beta' } };
  const { t, ctx, q } = await setUp({ beta });
  q.pause();
  movie(q, 'Up (2009)');
  const main = await ask(ctx, 'The Boys S01E01');
  const req = await ask(ctx, '$beta003 The Boys season 2', TESTING);
  ok(t.shown.get(main.id) === '2️⃣', `a request from a main group gets its place (${t.on(main.id).join(' ')})`);
  ok(t.numbersOn(req.id).length === 0 && t.shown.get(req.id) === '✅', `the test gets ✅ and no number (${t.on(req.id).join(' ')})`);
  ok(tvKeys(q).length === 1, 'and nothing of it is queued');
  movie(q, 'Heat (1995)'); await settle();
  ok(t.shown.get(main.id) === '3️⃣', 'while the main request moves back behind the new film');
  await plugin.teardown();
}

console.log('=== a request picked back up after a restart gets its place too ===');
{
  const store = new Map();
  store.set('pending', [{
    reqKey: 'tv-old-1', label: 'The Boys season 1 — 3 episode(s)',
    msgId: 'old1', msgKey: { id: 'old1', remoteJid: TVREQ }, chatJid: TVREQ,
    requester: '+1 555', requesterNumber: '1555', baseRow: { id: 'old1', kind: 'tv', status: 'queued' },
    episodes: episodesOf(1).Items.map((e) => ({ id: e.Id, series: 'The Boys', season: 1, episode: e.IndexNumber, title: e.Name })),
  }]);
  const q = realQueue();
  q.pause();
  movie(q, 'Up (2009)');
  const { t } = await setUp({ queue: q, store });   // setup() recovers, WhatsApp being up
  await settle();
  // The number alone: it says the request was picked back up, and a 🔄
  // before it doubled what every start sent (review, group-facing lens).
  ok(t.on('old1').join(' ') === '2️⃣', `picked back up, shown by its place behind the movie (${t.on('old1').join(' ')})`);
  const row = q.snapshot().pending.find((e) => e.kind === 'tv');
  ok(row?.group === 'tv-old-1' && row.label === 'The Boys season 1' && row.jobs.total === 3,
    `one row for the resumed season (${row?.label}, ${row?.jobs?.total} episodes)`);
  await plugin.teardown();
}

console.log('=== a request picked back up that starts at once is shown its stage, not 🔄 ===');
{
  const store = new Map();
  store.set('pending', [{
    reqKey: 'tv-old-2', label: 'The Boys season 1 — 3 episode(s)',
    msgId: 'old2', msgKey: { id: 'old2', remoteJid: TVREQ }, chatJid: TVREQ,
    requester: '+1 555', requesterNumber: '1555', baseRow: { id: 'old2', kind: 'tv', status: 'queued' },
    episodes: episodesOf(1).Items.map((e) => ({ id: e.Id, series: 'The Boys', season: 1, episode: e.IndexNumber, title: e.Name })),
  }]);
  const { t, q } = await setUp({ store });           // nothing ahead of it, so it starts
  await settle();
  ok(q.snapshot().active.some((e) => e.group === 'tv-old-2'), 'it is running');
  // No place to show it by: the stage it is at, nothing of it done yet - the
  // download. It was 🔄, which a member read as "send it again" (Iron Man 3,
  // 2026-10-11).
  ok(t.on('old2').join(' ') === '⬇️', `no place to show it by, so its stage, ⬇️ - not 🔄 (${t.on('old2').join(' ')})`);
  await plugin.teardown();
}

console.log('=== a reaction the budget shed is not taken as shown ===');
{
  // react() noted an emoji as shown before bot.react answered: a 🔄 shed at
  // a restart was believed shown, and the 🔄 of the episode's own retry was
  // skipped as a repeat - the message never showed it (review, group-facing
  // lens). The reaction is the stage now, not 🔄, and the trap the same.
  // It starts at once, so its message is told its stage rather than a number.
  const { t, ctx, store } = await setUp();
  store.set('pending', [{
    reqKey: 'tv-old-3', label: 'The Boys season 1 — 3 episode(s)',
    msgId: 'old3', msgKey: { id: 'old3', remoteJid: TVREQ }, chatJid: TVREQ,
    requester: '+1 555', requesterNumber: '1555', baseRow: { id: 'old3', kind: 'tv', status: 'queued' },
    episodes: episodesOf(1).Items.map((e) => ({ id: e.Id, series: 'The Boys', season: 1, episode: e.IndexNumber, title: e.Name })),
  }]);
  let shedNext = true;
  t.shed = () => { const x = shedNext; shedNext = false; return x; };
  await plugin.recoverPending(ctx);
  await settle();
  const live = plugin._live?.get('tv-old-3');
  const calls = () => t.calls.filter((c) => c.id === 'old3').map((c) => c.emoji);
  ok(calls().join(' ') === '⬇️' && t.shown.get('old3') !== '⬇️', `the restart's ⬇️ was shed (${calls().join(' ')})`);
  await live?.react('⬇️');
  await settle();
  ok(calls().join(' ') === '⬇️ ⬇️' && t.shown.get('old3') === '⬇️', `so the episode's own ⬇️ is sent, not skipped (${calls().join(' ')})`);
  await live?.react('⬇️');
  ok(calls().length === 2, 'and one that went is not sent twice');
  await plugin.teardown();
}

console.log('=== a request queued from the panel has no message, so no reactions ===');
{
  const { t, ctx, q } = await setUp();
  q.pause();
  movie(q, 'Up (2009)');
  const r = await plugin.requeue('The Boys season 1', ctx);
  await settle();
  ok(r.queued === 3 && q.waitingCount() === 2, 'the season is queued, as one request');
  ok(t.calls.length === 0, 'and nothing is reacted anywhere');
  await plugin.teardown();
}

console.log('=== cancelling a waiting request closes it, once ===');
{
  // A waiting episode that was cancelled never ran, so nothing reported it:
  // the request said "queued" in History for ever, and the journal kept it,
  // so the next restart queued the cancelled season all over again.
  const { t, ctx, q, store } = await setUp();
  q.pause();
  const req = await ask(ctx, 'The Boys season 1');
  ok(store.get('pending')?.length === 1, 'journalled while it waits');
  q.cancel(tvKeys(q)[0]); await settle();
  ok(t.on(req.id).filter((e) => e === '❌').length === 1, `the requester sees ❌ once, not once per episode (${t.on(req.id).join(' ')})`);
  ok((store.get('pending') ?? []).length === 0, 'the journal forgets it, so a restart does not bring it back');
  const row = (store.get('history') ?? [])[0];
  ok(row?.status === 'cancelled' && /0 of 3 posted, 3 cancelled/.test(row.detail), `History closes it: ${row?.status}, "${row?.detail}"`);
  ok(t.notes.filter((n) => /cancelled/.test(n)).length === 1, 'and the notifications group hears it once');
  ok(q.snapshot().pending.length === 0, 'nothing of it is left in the queue');
  await plugin.teardown();
}

console.log('=== movie numbers still count movies ahead, per request ===');
{
  const q = realQueue();
  q.pause();
  for (let i = 1; i <= 20; i++) q.add({ kind: 'tv', group: 'big', groupLabel: 'Big season 1', label: `Big E${i}`, run: null });
  const a = movie(q, 'A (2001)');
  const b = movie(q, 'B (2002)');
  const sent = [];
  moviePlugin._reactors = new Map([[a, { msg: { id: 'A' }, lastEmoji: null }], [b, { msg: { id: 'B' }, lastEmoji: null }]]);
  moviePlugin._updatePositions({
    config: { movieRequests: { reactions: { positions: NUM, positionOverflow: '🔢' } } },
    queue: q,
    bot: { react: async (m, e) => { sent.push(`${m.id}:${e}`); return true; } },
  });
  ok(sent.join() === 'A:1️⃣,B:2️⃣', `a season queued first does not push the films back (${sent.join()})`);
}

console.log('=== with strict movie priority off, a film and a TV request never share a number ===');
{
  // Films were numbered among the waiting films only, TV by the queue's real
  // place. With strict movie priority off, TV that arrived first starts
  // first: the TV request showed 1️⃣ and so did the film behind it (review
  // scenario b-places-strict-off).
  const q = realQueue({ strictMoviePriority: false });
  const { t, ctx } = await setUp({ queue: q });
  q.pause();
  const season = await ask(ctx, 'The Boys season 1');
  const heat = movie(q, 'Heat (1995)');
  const sent = [];
  moviePlugin._reactors = new Map([[heat, { msg: { id: 'HEAT' }, lastEmoji: null }]]);
  moviePlugin._updatePositions({
    config: { movieRequests: { reactions: { positions: NUM, positionOverflow: '🔢' } } },
    queue: q,
    bot: { react: async (m, e) => { sent.push(`${m.id}:${e}`); return true; } },
  });
  ok(t.shown.get(season.id) === '1️⃣' && sent.join() === 'HEAT:2️⃣',
    `the season asked for first is 1st and the film 2nd (${t.shown.get(season.id)}, ${sent.join()})`);
  moviePlugin._reactors = new Map();
  await plugin.teardown();
}

console.log('=== films: no late number on one that has started ===');
{
  // The same pacer race on the movie side: a film's number asked for a
  // moment before it started would land on its ⬇️.
  const q = realQueue();
  q.pause();
  const a = movie(q, 'A (2001)');
  const line = [];
  moviePlugin._reactors = new Map([[a, { msg: { id: 'A' }, lastEmoji: null }]]);
  const mctx = {
    config: { movieRequests: { reactions: { positions: NUM, positionOverflow: '🔢' } } },
    queue: q,
    bot: { react: (m, e, o) => new Promise((resolve) => line.push({ e, o, resolve })) },
  };
  moviePlugin._updatePositions(mctx);             // 1️⃣ asked for, waiting its turn
  ok(line[0]?.e === '1️⃣' && line[0].o.unless() === false, 'while it waits, the number is still wanted');
  q.resume(); await settle();                      // it starts
  moviePlugin._updatePositions(mctx);             // as the queue's 'updated' would
  ok(line[0].o.unless() === true, 'once it has started, the number is withdrawn at its turn');
}

console.log('=== numbers show in a main TV group with an empty beta config ===');
{
  // The operator's report: the TV group still showed no numbers, because
  // they were on Beta and Off. With no beta config at all, an empty one, or
  // the retired flag's "off" still sitting in config.json, a request in a
  // main TV group is shown its place.
  for (const [what, beta] of [
    ['no beta section at all', null],
    ['an empty beta config', NO_BETA],
    ['the retired flag still Off in config.json', { groups: [], postsGroup: '', features: { 'tv-queue-positions': 'off' } }],
  ]) {
    const { t, ctx, q } = await setUp({ beta });
    q.pause();
    movie(q, 'Up (2009)');
    const req = await ask(ctx, 'The Boys season 1');
    ok(t.on(req.id).join(' ') === '🔍 🎬 2️⃣', `${what}: 2nd, behind the film (${t.on(req.id).join(' ')})`);
    await plugin.teardown();
  }
}

console.log('=== a film that starts at once sends no TV place numbers ===');
{
  // Queueing a film fired 'added' - every waiting TV request one place
  // back - and then, the film starting at once, 'updated' - forward again.
  // Each pass asked for a number on every TV request, paced and counted
  // against the outbound budget, and withdrew it again. A season is running
  // here, on one of two slots; the other is kept free for films, so a film
  // starts the moment it is queued.
  const q = realQueue({ concurrency: 2 });
  const { t, ctx } = await setUp({ queue: q });
  await ask(ctx, 'The Boys season 1');
  ok(q.snapshot().active.some((e) => e.label === 'The Boys season 1'), 'a season is running');
  const waiting = await ask(ctx, 'The Boys S02E01');
  ok(t.shown.get(waiting.id) === '1️⃣', 'the request behind it is 1st');
  const before = t.calls.length;
  movie(q, 'Up (2009)'); await settle();
  ok(q.snapshot().active.some((e) => e.label === 'Up (2009)'), 'the film started at once');
  ok(t.calls.length === before, `and not one number was asked for (${t.calls.slice(before).map((c) => c.emoji).join(' ')})`);
  ok(t.shown.get(waiting.id) === '1️⃣', 'the TV request still shows 1st, which it still is');
  await plugin.teardown();
}

console.log('=== a number out of date by its turn is withdrawn, even when the place came back ===');
{
  // 3rd, then 2nd (a film ahead is cancelled), then 3rd again (another film
  // is asked for) - all while the pacer still held the 2️⃣. The place was
  // back to the number showing, so nothing new was asked for, and the 2️⃣
  // then landed: the message said 2nd until the next time the place changed,
  // which can be a whole film's download away.
  const { t, ctx, q } = await setUp();
  q.pause();
  const a = movie(q, 'Film A (2001)');
  movie(q, 'Film B (2002)');
  const req = await ask(ctx, 'The Boys season 1');
  ok(t.shown.get(req.id) === '3️⃣', 'third, behind two films');
  t.auto = false;
  q.cancel(a); await settle();
  ok(t.line.some((x) => x.msg.id === req.id && x.emoji === '2️⃣'), 'a film ahead is cancelled: 2nd is asked for');
  movie(q, 'Film C (2003)'); await settle();
  t.turn(); await settle();
  ok(t.shown.get(req.id) === '3️⃣', `another film is asked for before it goes, and the message still says 3rd (${t.shown.get(req.id)})`);
  ok(t.withheld.includes(`${req.id}:2️⃣`), 'the 2️⃣ was withdrawn at its turn, not sent');
  t.auto = true;
  await plugin.teardown();
}

console.log('=== a number already on its way when the place changes is followed by the right one ===');
{
  const { t, ctx, q } = await setUp();
  q.pause();
  const a = movie(q, 'Film A (2001)');
  movie(q, 'Film B (2002)');
  const req = await ask(ctx, 'The Boys season 1');
  t.auto = false;
  q.cancel(a); await settle();
  const sending = t.line.shift();                   // the 2️⃣'s turn comes...
  ok(sending?.emoji === '2️⃣' && sending.unless() === false, '2nd is still right at its turn, so it goes');
  movie(q, 'Film C (2003)'); await settle();        // ...and while it is being sent, 3rd again
  t.shown.set(req.id, sending.emoji);
  sending.resolve(true); await settle();
  t.turn(); await settle();
  ok(t.shown.get(req.id) === '3️⃣', `the right number follows it (${t.shown.get(req.id)})`);
  t.auto = true;
  await plugin.teardown();
}

console.log('=== films picked back up after a restart: one number each ===');
{
  // Resumed films now get their place, as new ones do. The movie side had
  // no guard against asking again while a number waited in the pacer, and
  // every film picked back up fires a queue event while the earlier films'
  // numbers still wait behind the 🔄s (the pacer serves 'normal' before
  // 'low'): four films were sent sixteen numbers, Heat's 1️⃣ seven times -
  // a burst of identical reactions at every restart.
  const FILMS = [['Heat', 1995], ['Up', 2009], ['Alien', 1979], ['Jaws', 1975]];
  const tvFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const term = new URL(String(url)).searchParams.get('searchTerm') ?? '';
    const f = FILMS.find(([title]) => title.toLowerCase() === term.toLowerCase());
    const items = f ? [{ Id: `id-${f[0]}`, Name: f[0], ProductionYear: f[1], OfficialRating: 'PG', Type: 'Movie',
      Path: `/m/${f[0]}.mkv`, MediaSources: [{ Path: `/m/${f[0]}.mkv`, Size: 1 }] }] : [];
    return { ok: true, status: 200, json: async () => ({ Items: items, TotalRecordCount: items.length }) };
  };
  const data = {};
  const store = { get: (k, d = null) => (k in data ? structuredClone(data[k]) : d), set: (k, v) => { data[k] = structuredClone(v); } };
  store.set('pending', FILMS.map(([title, year], i) => ({
    jobKey: `k${i}`, msgId: `msg-${title}`, msgKey: { id: `msg-${title}` }, chatJid: 'movies@g.us',
    movie: { title, year, rated: 'PG' }, meta: { requester: 'x' }, record: { request: title },
  })));
  const low = [];
  const sent = [];
  const bot = {
    react: (msg, emoji, { kind = 'normal', unless = null } = {}) => {
      if (kind !== 'low') { sent.push(`${msg.id}:${emoji}`); return Promise.resolve(true); }
      return new Promise((resolve) => low.push({ msg, emoji, unless, resolve }));
    },
  };
  const q = new JobQueue({ concurrency: 1, maxLength: 104 });
  q.pause();
  const mctx = {
    store, bot, queue: q,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    config: {
      library: { provider: 'jellyfin', jellyfin: { baseUrl: 'http://jf:8096', apiKey: 'K', authMethod: 'apikey' } },
      media: {}, omdb: {},
      movieRequests: { blockedRatings: [], reactions: { redo: '🔄', positions: NUM, positionOverflow: '🔢' } },
    },
  };
  moviePlugin._reactors = new Map();                // what setup() does for positions
  const onQ = () => moviePlugin._updatePositions(mctx);
  for (const ev of ['added', 'updated', 'state']) q.on(ev, onQ);
  try {
    await moviePlugin.recoverPending(mctx);
  } finally {
    globalThis.fetch = tvFetch;
  }
  for (const x of low) {                            // the pacer gets round to the numbers
    if (x.unless?.()) { x.resolve(false); continue; }
    sent.push(`${x.msg.id}:${x.emoji}`);
    x.resolve(true);
  }
  await settle();
  const nums = sent.filter((x) => NUM.some((n) => x.endsWith(n)));
  ok(q.pending.length === 4, `all four films were picked back up (${q.pending.length})`);
  ok(nums.join() === 'msg-Heat:1️⃣,msg-Up:2️⃣,msg-Alien:3️⃣,msg-Jaws:4️⃣',
    `each gets its place, once (${nums.length} sent: ${nums.join()})`);
  // One reaction a film at every start, not two: the number says it was
  // picked back up, and a 🔄 before it doubled what each start sent - 4
  // films, 8 reactions; 30, 60 (review, group-facing lens).
  ok(!sent.some((x) => x.endsWith(':🔄')) && sent.length === 4, `and no 🔄 as well (${sent.join()})`);

  // The same _resume puts a film back after a transient failure, in this
  // process (incident-fixes' _retryNow). That one was running when it failed:
  // its message shows 🔄 for it, and it goes in at the front, so it gets no
  // number. Nor does a film queued from the panel, with no message at all.
  sent.length = 0;
  low.length = 0;
  globalThis.fetch = async (url) => {
    const term = new URL(String(url)).searchParams.get('searchTerm') ?? '';
    const f = FILMS.find(([title]) => title.toLowerCase() === term.toLowerCase());
    const items = f ? [{ Id: `id-${f[0]}`, Name: f[0], ProductionYear: f[1], OfficialRating: 'PG', Type: 'Movie',
      Path: `/m/${f[0]}.mkv`, MediaSources: [{ Path: `/m/${f[0]}.mkv`, Size: 1 }] }] : [];
    return { ok: true, status: 200, json: async () => ({ Items: items, TotalRecordCount: items.length }) };
  };
  try {
    await moviePlugin._resume(mctx, {
      jobKey: 'kr', msgId: 'msg-Retried', msgKey: { id: 'msg-Retried' }, chatJid: 'movies@g.us',
      movie: { title: 'Heat', year: 1995, rated: 'PG' }, meta: { requester: 'y' }, record: { request: 'heat' },
    }, { retry: 1 });
    await moviePlugin._resume(mctx, {
      jobKey: 'kp', msgId: 'manual-1790263529080', msgKey: null, chatJid: null,
      movie: { title: 'Up', year: 2009, rated: 'PG' }, meta: { requester: 'manual (admin)' }, record: { request: 'up' },
    });
  } finally {
    globalThis.fetch = tvFetch;
  }
  for (const x of low) {
    if (x.unless?.()) { x.resolve(false); continue; }
    sent.push(`${x.msg.id}:${x.emoji}`);
    x.resolve(true);
  }
  await settle();
  ok(q.pending.length === 6 && q.pending[0].meta.retry === 1, 'the retry is back, at the front, and the panel film behind');
  ok(!sent.some((x) => x.startsWith('msg-Retried:') || x.startsWith('manual-')),
    `neither the retried film nor the panel's gets a number (${sent.join()})`);
  ok(sent.includes('msg-Heat:2️⃣'), 'while the films it went in front of move back a place');
  for (const ev of ['added', 'updated', 'state']) q.off(ev, onQ);
}

console.log('=== films: a number out of date by its turn is withdrawn too ===');
{
  const q = realQueue();
  q.pause();
  const line = [];
  const shown = new Map();
  let auto = true;
  const flush = () => {
    while (line.length) {
      const x = line.shift();
      if (x.unless?.()) { x.resolve(false); continue; }
      shown.set(x.id, x.emoji);
      x.resolve(true);
    }
  };
  const mctx = {
    config: { movieRequests: { reactions: { positions: NUM, positionOverflow: '🔢' } } },
    queue: q,
    bot: { react: (m, emoji, o = {}) => new Promise((resolve) => { line.push({ id: m.id, emoji, unless: o.unless, resolve }); if (auto) flush(); }) },
  };
  moviePlugin._reactors = new Map();
  const onQ = () => moviePlugin._updatePositions(mctx);
  for (const ev of ['added', 'updated', 'state']) q.on(ev, onQ);
  const a = movie(q, 'A (2001)');
  movie(q, 'B (2002)');
  const c = movie(q, 'C (2003)');
  moviePlugin._reactors.set(c, { msg: { id: 'C' }, lastEmoji: null });
  moviePlugin._updatePositions(mctx);
  await settle();
  ok(shown.get('C') === '3️⃣', 'C is third');
  auto = false;
  q.cancel(a); await settle();                      // 2nd, held by the pacer
  q.moveTop(movie(q, 'D (2004)')); await settle(); // 3rd again
  flush(); await settle();
  ok(shown.get('C') === '3️⃣', `and still says so once the pacer catches up (${shown.get('C')})`);
  for (const ev of ['added', 'updated', 'state']) q.off(ev, onQ);
}

console.log('=== a duplicate request shows the place of the season it follows ===');
{
  // Found in an audit of the TV group (2026-09-29): a second member asking
  // for a season already waiting was answered 🤥 and then nothing, however
  // far back the season was, while the first requester watched their number
  // count down - and the 🤥 stayed until the season's ✅.
  const { t, ctx, q } = await setUp();
  q.pause();
  movie(q, 'Up (2009)');
  const first = await ask(ctx, 'The Boys season 1');
  const dup = await ask(ctx, 'The Boys season 1');
  ok(q.snapshot().pending.filter((e) => e.kind === 'tv').length === 1, 'the duplicate is not queued');
  ok(t.on(dup.id).join(' ') === '🔍 🤥 2️⃣', `🤥, then the season's place (${t.on(dup.id).join(' ')})`);
  ok(t.shown.get(first.id) === '2️⃣', 'the same as the first request shows');
  movie(q, 'Heat (1995)'); await settle();
  ok(t.shown.get(first.id) === '3️⃣' && t.shown.get(dup.id) === '3️⃣', 'both move back as the line does');

  q.resume(); await settle();                       // Up starts
  q.finish('Up (2009)'); await settle();             // Heat starts
  ok(t.shown.get(dup.id) === '1️⃣', 'and forward');
  const numbers = t.numbersOn(dup.id).length;
  q.finish('Heat (1995)'); await settle();           // the season starts
  ok(t.shown.get(dup.id) === '⬇️', `once the season starts, the follower is moved on from its number (${t.shown.get(dup.id)})`);
  ok(t.numbersOn(dup.id).length === numbers, 'and is given no number after that');
  await plugin.teardown();
}

console.log('=== a follower\'s ⬇️ still waiting when the season has already ended is withdrawn ===');
{
  // The outcome is 'critical' and the ⬇️ is not, so a real pacer sends an
  // outcome that came quickly ahead of it; the ⬇️ must not then land on top.
  const { t, ctx, q, store } = await setUp();
  q.pause();
  movie(q, 'Up (2009)');
  await ask(ctx, 'The Boys season 1');
  const dup = await ask(ctx, 'The Boys season 1');
  const { reqKey } = store.get('pending')[0];
  q.resume(); await settle();                       // Up starts: 1st
  ok(t.shown.get(dup.id) === '1️⃣', 'the follower shows 1st');
  t.auto = false;
  q.finish('Up (2009)'); await settle();             // the season starts
  ok(t.line.some((a) => a.msg.id === dup.id && a.emoji === '⬇️'), '⬇️ is asked for, and waits its turn');
  plugin._tellTvFollowers(ctx, reqKey, { status: 'failed', emoji: '⚠️' });   // and the season fails at once
  t.turn(); await settle();
  ok(t.shown.get(dup.id) === '⚠️' && t.withheld.includes(`${dup.id}:⬇️`),
    `the follower ends on the outcome, the ⬇️ withdrawn (${t.shown.get(dup.id)})`);
  t.auto = true;
  await plugin.teardown();
}

console.log('=== a duplicate of a season already running gets no number ===');
{
  const { t, ctx, q } = await setUp();
  await ask(ctx, 'The Boys season 1');               // starts at once
  const dup = await ask(ctx, 'The Boys season 1');
  ok(t.on(dup.id).join(' ') === '🔍 🤥', `🤥, and it hears how the season ends (${t.on(dup.id).join(' ')})`);
  ok(q.snapshot().active.some((e) => e.label === 'The Boys season 1'), 'the season is running');
  await plugin.teardown();
}

console.log('=== a beta test of a duplicate shows no place in line ===');
{
  // A test is over once it is answered (2026-09-29, beta.js): its 🤥 does
  // not follow the real request's place, which is not the test's to show.
  const beta = { groups: [TESTING], postsGroup: '', features: { 'tv-duplicate-notice': 'beta' } };
  const { t, ctx, q } = await setUp({ beta });
  q.pause();
  movie(q, 'Up (2009)');
  const real = await ask(ctx, 'The Boys season 1');
  const dup = await ask(ctx, '$beta005 The Boys season 1', TESTING);
  ok(t.shown.get(real.id) === '2️⃣', `the real request has its place (${t.on(real.id).join(' ')})`);
  ok(t.shown.get(dup.id) === '🤥' && t.numbersOn(dup.id).length === 0, `the test gets 🤥 and no number (${t.on(dup.id).join(' ')})`);
  movie(q, 'Heat (1995)'); await settle();
  ok(t.numbersOn(dup.id).length === 0, 'nor one when the line moves');
  await plugin.teardown();
}

console.log('=== after a restart, a duplicate keeps following the season\'s place ===');
{
  // The follower is journalled with the season it follows, so a restart
  // brings back its number with the season's.
  const store = new Map();
  store.set('pending', [{
    reqKey: 'tv-old-8', label: 'The Boys season 1 — 3 episode(s)',
    msgId: 'old8', msgKey: { id: 'old8', remoteJid: TVREQ }, chatJid: TVREQ,
    requester: '+1 555', requesterNumber: '1555', baseRow: { id: 'old8', kind: 'tv', status: 'queued' },
    episodes: episodesOf(1).Items.map((e) => ({ id: e.Id, series: 'The Boys', season: 1, episode: e.IndexNumber, title: e.Name })),
    followers: [{ msgId: 'dup8', msgKey: { id: 'dup8', remoteJid: TVREQ }, chatJid: TVREQ, historyId: 'dup8', route: null }],
  }]);
  const q = realQueue();
  q.pause();
  movie(q, 'Up (2009)');
  const { t, ctx } = await setUp({ queue: q, store });
  await settle();
  ok(t.shown.get('old8') === '2️⃣' && t.shown.get('dup8') === '2️⃣',
    `the season and the request that followed it both show 2nd (${t.on('old8').join(' ')} / ${t.on('dup8').join(' ')})`);
  const later = await ask(ctx, 'The Boys season 1');
  ok(t.on(later.id).join(' ') === '🔍 🤥 2️⃣', `and a duplicate asked since the restart joins them (${t.on(later.id).join(' ')})`);
  ok((store.get('pending')?.[0]?.followers ?? []).length === 2, 'journalled with the season, next to the first');
  await plugin.teardown();
}

console.log('=== a TV request asked while films are being recovered waits behind the requests from before the restart ===');
{
  // After a restart, TV recovery waits for the journalled films to be looked
  // up again, and then put the old TV requests at the back of the queue. A
  // TV request asked in those seconds had gone in already - ahead of them,
  // and with nothing else in the queue yet, straight to the front.
  const store = new Map();
  store.set('pending', [{
    reqKey: 'tv-old-9', label: 'The Boys season 1 — 3 episode(s)',
    msgId: 'old9', msgKey: { id: 'old9', remoteJid: TVREQ }, chatJid: TVREQ,
    requester: '+1 555', requesterNumber: '1555', baseRow: { id: 'old9', kind: 'tv', status: 'queued' },
    episodes: episodesOf(1).Items.map((e) => ({ id: e.Id, series: 'The Boys', season: 1, episode: e.IndexNumber, title: e.Name })),
  }]);
  const q = realQueue();
  const release = holdTvRecovery(q);                // the films are still being looked up
  const { t, ctx, ready } = await setUp({ queue: q, store, awaitSetup: false });
  const fresh = await ask(ctx, 'The Boys season 2');
  ok(t.on(fresh.id).join(' ') === '🔍 🎬', `the new request is accepted (${t.on(fresh.id).join(' ')})`);
  ok(!q.snapshot().active.length && !q.snapshot().pending.length, 'but nothing goes into the queue - or starts - yet');
  ok((store.get('pending') ?? []).length === 2, 'it is journalled, so a restart meanwhile loses nothing');
  const dup = await ask(ctx, 'The Boys S02E01');
  ok(t.on(dup.id).join(' ').startsWith('🔍 🤥'), 'and a duplicate of it is still caught while it is held');

  release();                                          // film recovery is done
  await ready; await settle();
  const snap = q.snapshot();
  ok(snap.active[0]?.group === 'tv-old-9', `the request from before the restart starts first (${snap.active[0]?.label})`);
  ok(snap.pending.map((e) => e.label).join() === 'The Boys season 2', 'the one asked during the recovery waits behind it');
  ok(!snap.pending[0].meta.resumed, 'and is not marked as picked back up');
  ok(t.shown.get(fresh.id) === '1️⃣', `with its place in line, from the moment it is let in (${t.on(fresh.id).join(' ')})`);
  ok((store.get('pending') ?? []).map((r) => r.reqKey)[0] === 'tv-old-9', 'the journal keeps the old request first, for the next restart');
  await plugin.teardown();
}

console.log('=== a request held for the recovery takes its place in the queue\'s limit ===');
{
  // Held out of the queue, it is not in the queue's own count; left out of
  // the limit as well, every request asked during a slow recovery would find
  // a free place and go in past it.
  const store = new Map();
  store.set('pending', [{
    reqKey: 'tv-old-10', label: 'The Boys S01E01',
    msgId: 'old10', msgKey: { id: 'old10', remoteJid: TVREQ }, chatJid: TVREQ,
    requester: '+1 555', requesterNumber: '1555', baseRow: { id: 'old10', kind: 'tv', status: 'queued' },
    episodes: [{ id: 'E1', series: 'The Boys', season: 1, episode: 1, title: 'Ep 1' }],
  }]);
  const q = realQueue({ maxLength: 1 });
  const release = holdTvRecovery(q);
  const { t, ctx, ready } = await setUp({ queue: q, store, awaitSetup: false });
  const held = await ask(ctx, 'The Boys S02E01');
  ok(t.on(held.id).join(' ') === '🔍 🎬', 'the one free place is taken by the first request');
  const refused = await ask(ctx, 'The Boys S02E02');
  ok(t.on(refused.id).join(' ') === '🔍 ⚠️', `the next is told the queue is full (${t.on(refused.id).join(' ')})`);
  release();
  await ready; await settle();
  ok(q.snapshot().active[0]?.group === 'tv-old-10' && q.snapshot().pending.map((e) => e.label).join() === 'The Boys S02E01',
    'the old request and the held one go in, in that order');
  await plugin.teardown();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
