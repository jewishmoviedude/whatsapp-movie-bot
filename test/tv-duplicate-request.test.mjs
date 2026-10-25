/* A TV request for episodes already waiting is not queued again.
   Run: node test/tv-duplicate-request.test.mjs

   The incident, 2026-09-28: the same member asked for "Loki season 1" at
   15:31 UTC and again at 19:06 while its six episodes were still waiting, and
   "the mentalist S03E05" was queued at 16:02 and again at 16:28. Both copies
   of each went into the queue and the journal - the 19:48 restart resumed
   them all - so every one of those episodes would have been posted twice.
   The movie side has no duplicate check to copy; a duplicate is answered the
   way an accepted request is (🎬 and a line in the notifications group),
   since what was asked for IS in the queue, and leaves a History row.

   Episodes waiting already are never queued again, whatever the mode. What
   the notifications group is told about them is new wording, staged through
   the beta group as 'tv-duplicate-notice' (most of these run it On); Off,
   it is the line the whole request always got.

   Since 2026-10-11 🤥 is for a DIFFERENT member asking for episodes already
   queued for the group. The member they are queued for, sending the request
   again, is shown where it is instead, and their row is not a duplicate
   (test/no-redo-reaction.test.mjs): a restart had put 🔄 on Ethan Adams's
   "Iron Man 3 2013", he sent it again, and was answered 🤥. So the second
   request in these cases comes from another member, where 🤥 is the point. */
import plugin from '../src/plugins/tv-requests/index.js';
import { JobQueue } from '../src/core/queue.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

const TVREQ = 'tvreq@g.us';
const BETA = 'beta@g.us';

const HOST = { Id: 'HOST', Name: 'Loki', ProductionYear: 2021 };
const MENTALIST = { Id: 'MENT', Name: 'The Mentalist', ProductionYear: 2008 };
const episodesOf = (series, season, n) => Array.from({ length: n }, (_, i) => ({
  Id: `${series.Id}-${season}-${i + 1}`, SeriesName: series.Name, ParentIndexNumber: season, IndexNumber: i + 1,
  Name: `Ep ${i + 1}`, MediaSources: [{ Path: `/tv/${series.Id}${i}.mkv`, Size: 1000, Container: 'mkv' }],
}));

/** A tiny Jellyfin: two shows, Loki season 1 (6) and The Mentalist season 3 (24). */
function jellyfin() {
  globalThis.fetch = async (url) => {
    const u = String(url);
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    if (u.includes('/Shows/HOST/Seasons')) return json({ Items: [{ Id: 'L1', IndexNumber: 1, ChildCount: 6 }] });
    if (u.includes('/Shows/MENT/Seasons')) return json({ Items: [{ Id: 'M3', IndexNumber: 3, ChildCount: 24 }] });
    if (u.includes('/Shows/HOST/Episodes')) return json({ Items: episodesOf(HOST, 1, 6) });
    if (u.includes('/Shows/MENT/Episodes')) return json({ Items: episodesOf(MENTALIST, 3, 24) });
    if (u.includes('/Items')) {
      const term = decodeURIComponent((u.match(/searchTerm=([^&]*)/) ?? [])[1] ?? '').toLowerCase();
      return json({ Items: [HOST, MENTALIST].filter((s) => !term || s.Name.toLowerCase().includes(term.replace(/^the /, ''))) });
    }
    return { ok: false, status: 404, statusText: 'NF', json: async () => ({}) };
  };
}

/** The live queue's shape: raw entries in pending and active, meta and kind on each. */
function fakeQueue() {
  let n = 0;
  return {
    maxLength: 500, pending: [], active: new Map(),
    add(job) {
      const entry = { id: `q${++n}`, label: job.label, kind: job.kind === 'tv' ? 'tv' : 'movie', meta: job.meta ?? {}, run: job.run };
      this.pending.push(entry);
      return entry.id;
    },
    start(label) {
      const i = this.pending.findIndex((e) => e.label === label);
      const [e] = this.pending.splice(i, 1);
      this.active.set(e.id, e);
    },
    cancelWaiting(label) {
      const i = this.pending.findIndex((e) => e.label === label);
      this.pending.splice(i, 1);
    },
  };
}

function makeCtx({ slowReact = 0, dup = 'on' } = {}) {
  jellyfin();
  const reacted = [], notes = [];
  const store = new Map();
  const logs = [];
  return {
    reacted, notes, logs, store,
    ctx: {
      config: {
        tvRequests: { enabled: true, requestGroups: [TVREQ], postsGroups: ['tvposts@g.us'], cooldownSecondsPerUser: 0 },
        movieRequests: {
          reactions: { researching: '🔍', added: '🎬', duplicate: '🤥', needYear: '📅', notInLibrary: '📬', rated: '⛔', failed: '⚠️', done: '✅' },
          notify: { group: 'notif@g.us' },
        },
        beta: { groups: [BETA], postsGroup: 'betaposts@g.us', features: dup ? { 'tv-duplicate-notice': dup } : {} },
        library: { jellyfin: { baseUrl: 'http://jf:8096', accessToken: 'TOK', userId: 'U1' } },
        media: { workDir: '/tmp/tvdup' },
      },
      bot: {
        react: async (m, e) => { if (slowReact) await tick(slowReact); reacted.push(`${m.id} ${e}`); },
        isConnected: () => true,
        sendText: async (j, t) => { notes.push(t); return { key: { id: 'X' } }; },
        isGroupAdmin: () => false,
        deleteMessage: async () => {},
        archiveChat: async () => {},
        groupMemberInfo: () => ({ isMember: false }),
      },
      queue: fakeQueue(),
      store: { get: (k, d) => (store.has(k) ? store.get(k) : d), set: (k, v) => store.set(k, v) },
      log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), debug() {} },
    },
  };
}

let seq = 0;
const mkMsg = (text, { chatJid = TVREQ, sender = '15551112222' } = {}) => ({
  text, chatJid, isGroup: true, fromMe: false, messageType: 'conversation',
  senderJid: `${sender}@s.whatsapp.net`, senderNumber: sender, senderNumberDisplay: `+${sender}`,
  pushName: 'Avi', id: `MSG${++seq}`, key: { remoteJid: chatJid, id: `MSG${seq}`, fromMe: false }, timestamp: Date.now(),
});
const tvLabels = (q) => q.pending.filter((e) => e.kind === 'tv').map((e) => e.label);
const history = (store) => store.get('history') ?? [];

console.log('=== the incident: "Loki season 1" twice while the first is waiting ===');
{
  const { ctx, reacted, notes, store, logs } = makeCtx();
  const first = mkMsg('Loki season 1');
  await plugin.onMessage(first, ctx);
  ok(tvLabels(ctx.queue).length === 6, `the first request queues all six (${tvLabels(ctx.queue).length})`);

  // The same member asking again is their own request sent again: queued
  // once, and no 🤥 (test/no-redo-reaction.test.mjs).
  const own = mkMsg('Loki season 1');
  await plugin.onMessage(own, ctx);
  ok(tvLabels(ctx.queue).length === 6 && !reacted.includes(`${own.id} 🤥`)
    && history(store).find((h) => h.id === own.id)?.status === 'resent',
  'asked again by the member it is queued for: nothing more queued, no 🤥, and History says resent');

  const again = mkMsg('Loki season 1', { sender: '15553334444' });
  await plugin.onMessage(again, ctx);
  ok(tvLabels(ctx.queue).length === 6, `the second queues nothing more (${tvLabels(ctx.queue).length} waiting)`);
  ok((store.get('pending') ?? []).length === 1, 'and journals nothing, so a restart cannot resume a copy');
  // The operator's choice (2026-09-29): a repeat request gets 🤥, not the 🎬
  // of a fresh one, so the requester can tell it was already asked for.
  ok(reacted.includes(`${again.id} 🤥`) && !reacted.includes(`${again.id} 🎬`),
    `the requester gets 🤥, the duplicate reaction (${reacted.filter((r) => r.startsWith(again.id)).join(', ')})`);
  ok(notes.some((t) => /^🤥 Loki season 1 — already in the queue, not added again/.test(t)),
    'the notifications group is told it was already there, under the same 🤥');
  const row = history(store).find((h) => h.id === again.id);
  ok(row?.status === 'duplicate' && /already in the queue/.test(row.detail ?? ''), `and History keeps a row saying so (${row?.status})`);
  ok(logs.some((l) => /Loki season 1 is already in the queue - not queueing it again/.test(l)), 'with a log line');
}

console.log('=== with the new wording Off, the notifications group is told what it always was ===');
{
  // The wording is new group-facing text and ships Off (CLAUDE.md, beta
  // first); what main said for these two cases, with nothing queued twice.
  const { ctx, notes, store } = makeCtx({ dup: null });
  await plugin.onMessage(mkMsg('Loki season 1'), ctx);
  const again = mkMsg('Loki season 1', { sender: '15553334444' });
  await plugin.onMessage(again, ctx);
  ok(tvLabels(ctx.queue).length === 6, 'the second request queues nothing, Off as On');
  ok(notes.at(-1) === '🎬 Loki season 1 — 6 episode(s) — added to the queue' && notes.at(-2) === notes.at(-1),
    `a full duplicate gets the line the request always got: "${notes.at(-1)}"`);
  ok(history(store).find((h) => h.id === again.id)?.status === 'duplicate', 'History still says "duplicate"');
  await plugin.onMessage(mkMsg('the mentalist S03E05'), ctx);
  await plugin.onMessage(mkMsg('the mentalist season 3'), ctx);
  ok(notes.at(-1) === '🎬 The Mentalist season 3 — 24 episode(s) — added to the queue'
    && tvLabels(ctx.queue).filter((l) => l === 'The Mentalist S03E05').length === 1,
  `an overlap gets no "(1 more already waiting)", and S03E05 is still queued once: "${notes.at(-1)}"`);
}

console.log('=== "the mentalist S03E05" twice ===');
{
  const { ctx } = makeCtx();
  await plugin.onMessage(mkMsg('the mentalist S03E05'), ctx);
  await plugin.onMessage(mkMsg('the mentalist S03E05', { sender: '15553334444' }), ctx);
  ok(tvLabels(ctx.queue).length === 1, `one copy, whoever asked second (${tvLabels(ctx.queue).join(', ')})`);
}

console.log('=== a request that overlaps queues only what is missing ===');
{
  const { ctx, notes, store } = makeCtx();
  await plugin.onMessage(mkMsg('Loki S01E02'), ctx);
  await plugin.onMessage(mkMsg('Loki season 1'), ctx);
  const labels = tvLabels(ctx.queue);
  ok(labels.length === 6, `six episodes in all, not seven (${labels.length})`);
  ok(labels.filter((l) => /S01E02/.test(l)).length === 1, 'S01E02 once');
  // Named by the five it queued since 2026-10-12, the one waiting already
  // being part of another request (test/tv-range-named-by-what-was-queued.test.mjs).
  ok(notes.some((t) => /Loki S01E01, E03–E06 — 5 of season 1 — added to the queue \(1 more already waiting\)/.test(t)),
    'and the reply says which were added and how many were there already');
  const second = (store.get('pending') ?? [])[1];
  ok(second?.episodes?.length === 5, 'the second request journals its five');
}

console.log('=== an episode in progress counts as waiting ===');
{
  const { ctx } = makeCtx();
  await plugin.onMessage(mkMsg('the mentalist S03E05'), ctx);
  ctx.queue.start('The Mentalist S03E05');
  await plugin.onMessage(mkMsg('the mentalist S03E05'), ctx);
  ok(ctx.queue.pending.length === 0 && ctx.queue.active.size === 1, 'the running episode is not queued a second time');
}

console.log('=== one cancelled before it started is not waiting any more ===');
{
  // A cancel of a waiting job never runs it. The real queue tells the plugin
  // through onDiscard, which takes it out of the journal; this stand-in has
  // no such hook, so the journal still holds it here - and the queue, not the
  // journal, is what says whether it is coming.
  const { ctx } = makeCtx();
  await plugin.onMessage(mkMsg('the mentalist S03E05'), ctx);
  ctx.queue.cancelWaiting('The Mentalist S03E05');
  await plugin.onMessage(mkMsg('the mentalist S03E05'), ctx);
  ok(tvLabels(ctx.queue).length === 1, 'asking again queues it');
}

console.log('=== a beta test is judged against the real queue, and queues nothing ===');
{
  // Since 2026-09-29 a request in the beta group is a test, and a test never
  // downloads (beta.js): it used to queue its own six for the beta posts
  // group. "Asked for twice" (beta005) is tried with what members have
  // genuinely asked for.
  const { ctx, reacted, notes, store } = makeCtx();
  const t1 = mkMsg('$beta005 Loki season 1', { chatJid: BETA });
  await plugin.onMessage(t1, ctx);
  ok(tvLabels(ctx.queue).length === 0 && reacted.includes(`${t1.id} ✅`)
    && notes.some((t) => /^✅ \*Test passed\* \(\$beta005\)\n\nThe bot would queue 6 episodes of \*Loki\* season 1/.test(t)),
  `with nothing waiting, the test passes and queues nothing (${notes.at(-1)})`);
  await plugin.onMessage(mkMsg('Loki season 1'), ctx);
  ok(tvLabels(ctx.queue).length === 6, 'a member\'s request queues the six');
  const t2 = mkMsg('$beta005 Loki season 1', { chatJid: BETA });
  await plugin.onMessage(t2, ctx);
  ok(tvLabels(ctx.queue).length === 6 && reacted.includes(`${t2.id} 🤥`), 'tested again, it is the duplicate of the real request: 🤥');
  ok(history(store).find((h) => h.id === t2.id)?.status === 'duplicate'
    && history(store).find((h) => h.id === t2.id)?.test === 'beta005', 'its History row is a duplicate, marked as the test');
  ok((store.get('pending') ?? []).length === 1, 'and only the real request is journalled');
}

console.log('=== two requests for the same season at once ===');
{
  // Every reaction is paced, and slow here. Nothing between the duplicate
  // check and the queue may wait on one (the 🎬 is asked for, not awaited),
  // or the second request would find nothing of the first waiting yet.
  const { ctx, notes } = makeCtx({ slowReact: 30 });
  await Promise.all([
    plugin.onMessage(mkMsg('Loki season 1'), ctx),
    plugin.onMessage(mkMsg('Loki season 1', { sender: '15553334444' }), ctx),
  ]);
  ok(tvLabels(ctx.queue).length === 6, `one copy (${tvLabels(ctx.queue).length} waiting)`);
  ok(notes.some((t) => /Loki season 1 — already in the queue, not added again/.test(t)),
    'and the second is answered "already in the queue"');
}

console.log('=== over the real queue, where a season is one grouped item ===');
{
  // The queue groups a request's episodes into one item (tv-queue): one
  // place, one row, cancelled whole. The check still works per episode - the
  // queue holds one job per episode, whatever request it is grouped into -
  // and a request cancelled whole is out of the journal (the queue's
  // onDiscard), so asking for it again queues it again.
  const { ctx, notes } = makeCtx();
  const q = new JobQueue({ concurrency: 1, maxLength: 104 });
  q.pause();
  ctx.queue = q;
  await plugin.onMessage(mkMsg('Loki season 1'), ctx);
  ok(q.waitingCount() === 1 && q.pending.length === 6, `one request of six episodes (${q.waitingCount()} item, ${q.pending.length} jobs)`);
  await plugin.onMessage(mkMsg('Loki S01E03', { sender: '15553334444' }), ctx);
  ok(q.pending.length === 6 && notes.some((t) => /Loki S01E03 — already in the queue, not added again/.test(t)),
    'an episode inside the waiting season is a duplicate');
  const row = q.snapshot().pending[0];
  q.cancel(row.id);                                // the panel's Cancel, on the season's row
  ok(q.pending.length === 0 && !(ctx.store.get('pending', []) ?? []).length, 'cancelled whole, and out of the journal');
  await plugin.onMessage(mkMsg('Loki S01E03'), ctx);
  ok(q.pending.length === 1 && q.pendingLabels().join() === 'Loki S01E03', 'so asking for an episode of it again queues it');
  await plugin.teardown();
}

console.log('=== after a restart, episodes about to be resumed are waiting ===');
{
  const { ctx } = makeCtx();
  // What the last process left: The Mentalist S03E05, journalled but not yet
  // back in the queue, because TV recovery waits for the films.
  const leftover = { reqKey: 'tv-old', label: 'The Mentalist S03E05', episodes: [{
    id: 'MENT-3-5', series: 'The Mentalist', season: 3, episode: 5,
  }] };
  ctx.store.set('pending', [leftover]);
  plugin._awaitingRecovery = new Set(['tv-old']);
  await plugin.onMessage(mkMsg('the mentalist S03E05'), ctx);
  plugin._awaitingRecovery = null;
  ok(tvLabels(ctx.queue).length === 0, 'a request for it meanwhile is answered "already in the queue"');
}

console.log('=== a restart resumes each journalled episode once per destination ===');
{
  // The journal the live bot held on 2026-09-28, in miniature: "Loki season 1"
  // journalled three times and "The Mentalist S03E05" twice, from before the
  // check above existed. Resumed as they were, each episode would have been
  // posted that many times.
  const { ctx, store, logs } = makeCtx();
  const ep = (show, s2, e) => ({ id: `${show.Id}-${s2}-${e}`, series: show.Name, season: s2, episode: e });
  const loki = [1, 2, 3].map((e) => ep(HOST, 1, e));
  const req = (reqKey, label, episodes, extra = {}) => ({
    reqKey, label, episodes, baseRow: { id: reqKey.replace('tv-', ''), kind: 'tv', title: label, status: 'queued' }, ...extra,
  });
  store.set('history', [{ id: 'L2', kind: 'tv', status: 'queued' }, { id: 'L3', kind: 'tv', status: 'queued' }]);
  ctx.store.set('pending', [
    req('tv-L1', 'Loki season 1', loki),
    req('tv-M1', 'The Mentalist S03E05', [ep(MENTALIST, 3, 5)]),
    req('tv-L2', 'Loki season 1', loki),
    req('tv-M2', 'The Mentalist S03E05', [ep(MENTALIST, 3, 5)]),
    req('tv-L3', 'Loki season 1', [...loki, ep(HOST, 1, 4)]),                 // one more than the others
    req('tv-B1', 'Loki season 1', loki, { route: { beta: true, postsGroup: 'betaposts@g.us' } }),
  ]);
  await plugin.recoverPending(ctx);

  const main = ctx.queue.pending.filter((e) => !e.meta.beta).map((e) => e.label);
  const count = (label) => main.filter((l) => l === label).length;
  ok(['Loki S01E01', 'Loki S01E02', 'Loki S01E03', 'The Mentalist S03E05'].every((l) => count(l) === 1),
    `each episode is queued once for the posts group (${main.join(', ')})`);
  ok(count('Loki S01E04') === 1, 'the one episode only the third request asked for is resumed as well');
  // A beta request journalled before tests stopped downloading (2026-09-29)
  // is not resumed at all: it would download a test in front of real ones.
  ok(ctx.queue.pending.filter((e) => e.meta.beta).length === 0, 'a beta request journalled before test mode is not resumed');
  const journal = (store.get('pending') ?? []).map((r) => `${r.reqKey}:${r.episodes.length}`);
  ok(journal.join() === 'tv-L1:3,tv-M1:1,tv-L3:1', `the journal keeps each episode once (${journal.join()})`);
  const row = history(store).find((h) => h.id === 'L2');
  ok(row?.status === 'duplicate' && /not resumed twice/.test(row.detail ?? ''), `a request left with nothing says so in History (${row?.status})`);
  ok(logs.some((l) => /"Loki season 1": 3 of its 3 episode\(s\) are journalled by an earlier request as well - not resuming it twice/.test(l)),
    'and in the log');
}

console.log('=== a re-run from the panel or the box queues nothing that is waiting ===');
{
  // requeue() is the panel's Re-run and the hourly check's requeue, and it
  // had no duplicate check: "Loki season 1 [6 eps]" went in twice while a
  // group request for the same season was refused as a duplicate (review
  // scenario a2-requeue-dups).
  const { ctx, store } = makeCtx();
  await plugin.onMessage(mkMsg('Loki season 1'), ctx);
  let err = null;
  try { await plugin.requeue('Loki season 1', ctx, { requester: 'Avi (re-run by the hourly check)' }); } catch (e) { err = e; }
  ok(err?.code === 'DUPLICATE' && /Loki season 1 is already in the queue/.test(err.message), `refused, saying why (${err?.message})`);
  ok(tvLabels(ctx.queue).length === 6 && (store.get('pending') ?? []).length === 1
    && !history(store).some((h) => /^tv-manual-/.test(h.id)), 'nothing queued, journalled or written to History');

  await plugin.onMessage(mkMsg('the mentalist S03E05'), ctx);
  const r = await plugin.requeue('the mentalist season 3', ctx, { requester: 'manual (admin)' });
  const mentalist = tvLabels(ctx.queue).filter((l) => /Mentalist/.test(l));
  ok(r.queued === 23 && mentalist.length === 24 && mentalist.filter((l) => l === 'The Mentalist S03E05').length === 1,
    `a season that overlaps queues only the episodes not waiting (${r.queued} queued, S03E05 once)`);
}

console.log('=== a duplicate hears how the request that holds its episodes ends ===');
{
  // A duplicate was answered 🎬 and a "duplicate" row, and nothing
  // remembered its message: the original cancelled, the duplicate still
  // showed 🔍 🎬 and its row said "duplicate" (review, group-facing lens).
  const { ctx, reacted, store } = makeCtx();
  const q = new JobQueue({ concurrency: 1, maxLength: 104 });
  q.pause();
  ctx.queue = q;
  const first = mkMsg('Loki season 1');
  await plugin.onMessage(first, ctx);
  const again = mkMsg('Loki S01E03', { sender: '15553334444' });
  await plugin.onMessage(again, ctx);
  ok((store.get('pending') ?? [])[0]?.followers?.map((f) => f.historyId).join() === again.id,
    'the duplicate is written on the journal entry of the request it follows, so a restart keeps it');
  q.clearPending();
  await tick();
  ok(reacted.includes(`${again.id} ❌`), `the duplicate's message gets the ❌ its original got (${reacted.filter((r) => r.startsWith(again.id)).join(', ')})`);
  const row = history(store).find((h) => h.id === again.id);
  ok(row?.status === 'cancelled' && /with an earlier request for it/.test(row.detail ?? ''), `and its row the outcome (${row?.status}: ${row?.detail})`);
}

console.log('=== after a restart, the request resumed carries its followers, and those of a copy it replaced ===');
{
  const { ctx, reacted, store } = makeCtx();
  const q = new JobQueue({ concurrency: 1, maxLength: 104 });
  q.pause();
  ctx.queue = q;
  const ep = (n) => ({ id: `HOST-1-${n}`, series: 'Loki', season: 1, episode: n });
  const eps = [1, 2].map(ep);
  store.set('history', [{ id: 'A1', kind: 'tv', status: 'queued' }, { id: 'B1', kind: 'tv', status: 'queued' }, { id: 'F1', kind: 'tv', status: 'duplicate' }]);
  ctx.store.set('pending', [
    { reqKey: 'tv-A1', label: 'Loki season 1', msgId: 'A1', msgKey: { id: 'A1' }, chatJid: TVREQ, baseRow: { id: 'A1', kind: 'tv' }, episodes: eps,
      followers: [{ msgId: 'F1', msgKey: { id: 'F1' }, chatJid: TVREQ, historyId: 'F1', route: null }] },
    { reqKey: 'tv-B1', label: 'Loki season 1', msgId: 'B1', msgKey: { id: 'B1' }, chatJid: TVREQ, baseRow: { id: 'B1', kind: 'tv' }, episodes: eps },
  ]);
  await plugin.recoverPending(ctx);
  const journal = store.get('pending') ?? [];
  ok(journal.length === 1 && journal[0].followers?.map((f) => f.historyId).join() === 'F1,B1',
    `the copy's requester follows the one resumed (${journal.map((r) => `${r.reqKey}:${(r.followers ?? []).map((f) => f.historyId)}`).join(' ')})`);
  q.cancel(q.snapshot().pending[0].id);
  await tick();
  ok(reacted.includes('F1 ❌') && reacted.includes('B1 ❌'), `both hear the cancel (${reacted.join(', ')})`);
  ok(['F1', 'B1'].every((id) => history(store).find((h) => h.id === id)?.status === 'cancelled'), 'and their rows say so');
  await plugin.teardown();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
