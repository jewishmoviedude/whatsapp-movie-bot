/* Queued TV requests are trimmed to the episode limit, and end on ✅.
   Run: node test/tv-trim-queued-requests-to-the-cap.test.mjs

   The operator, 2026-10-12: "fix the current queue that only 10 epsiodes max
   per req", and then "I'm saying because in the queue is "11. Arrow season 1
   / waiting extra / 23 episodes" so I wanted you to manually adjust the queue
   that no more than 10 epsidodes per request". tvRequests.maxEpisodesPerRequest
   was 0 (no limit) until 20:22 UTC that evening, and it applies as a request
   is made, so the requests already queued held up to 148 episodes (Hunter x
   Hunter season 1), 23 (Arrow season 1) and 16 (Malcolm in the Middle season
   1). The only tool was the panel's Cancel, which ends a request whole: The
   Flash season 2, cancelled at 20:24 UTC after 14 episodes had posted, ended
   on ❌ "An admin cancelled it — it isn't coming".

   The admin command 'trim-tv-requests' keeps every queued request to the
   limit: what it posted, failed, has running or waiting counts, in episode
   order; what runs is never stopped; the waiting episodes past the limit
   come off - the queue's, and the journal's, so no restart brings them back.
   That is a new outcome, not a cancel: the request ends on ✅, "all 10
   episodes posted". Each member is told once, quoted to their request, what
   is still coming and the exact message for the next part, which parses
   back to that season and run. Driven through the real JobQueue, the real
   plugin and its real deliverEpisode, with the fixtures of
   test/tv-request-outcome.test.mjs: a download served from memory and a stub
   ffprobe that plans a plain copy. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';
import tvPlugin from '../src/plugins/tv-requests/index.js';
import { JobQueue } from '../src/core/queue.js';
import { runAdminCommand, summariseAdminCommand } from '../src/core/admin-commands.js';
import { parseTvRequest } from '../src/plugins/tv-requests/parse.js';
import { holdTvRecovery } from '../src/media/resume.js';
import { trimPlan } from '../src/plugins/tv-requests/trim-queued.js';
// The trim asks for the next part with the one helper a request the limit
// cuts as it is made uses too (next-part.js), since the two were merged.
import { partsOf, nextAsk } from '../src/plugins/tv-requests/next-part.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 15_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await tick();
  }
  return true;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-trim-'));
const FFPROBE = path.join(TMP, 'ffprobe');
fs.writeFileSync(FFPROBE, `#!/bin/sh
cat <<'JSON'
{"streams":[{"codec_type":"video","codec_name":"h264","width":1280,"height":720},{"codec_type":"audio","codec_name":"aac","channels":2}],"format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"60","size":"2048"}}
JSON
`, { mode: 0o755 });
// Free space as the bot will see it, whatever box runs this.
const realStatfs = fs.statfsSync;
fs.statfsSync = (p) => ({ ...realStatfs(p), bavail: Math.floor((50 * 1024 ** 3) / 4096), bsize: 4096 });

const TVREQ = 'tvreq@g.us';
const NOTIFY = 'notify@g.us';

/* A tiny Jellyfin: season 1 of each show, and every download 2 KB. */
const SHOWS = {
  ARROW: { Name: 'Arrow', ProductionYear: 2012, n: 23 },
  HOST: { Name: 'Loki', ProductionYear: 2021, n: 6 },
  LOST: { Name: 'Lost', ProductionYear: 2004, n: 15 },
  MALC: { Name: 'Malcolm in the Middle', ProductionYear: 2000, n: 16 },
  HXH: { Name: 'Hunter x Hunter (2011)', ProductionYear: 2011, n: 40 },
  // Three numbered episodes and two the library never numbered.
  ODD: { Name: 'Odd Show', ProductionYear: 2020, n: 3, loose: 2 },
};
const episodesOf = (id) => [
  ...Array.from({ length: SHOWS[id].n }, (_, i) => ({
    Id: `${id}-1-${i + 1}`, SeriesName: SHOWS[id].Name, ParentIndexNumber: 1, IndexNumber: i + 1, Name: `Ep ${i + 1}`,
    MediaSources: [{ Path: `/tv/${id}/${i + 1}.mkv`, Size: 2048, Container: 'mkv' }],
  })),
  ...Array.from({ length: SHOWS[id].loose ?? 0 }, (_, i) => ({
    Id: `${id}-1-x${i + 1}`, SeriesName: SHOWS[id].Name, ParentIndexNumber: 1, Name: `Extra ${i + 1}`,
    MediaSources: [{ Path: `/tv/${id}/x${i + 1}.mkv`, Size: 2048, Container: 'mkv' }],
  })),
];
/** A journal episode as _runSeason writes one. */
const journalEp = (id, n) => ({ id: `${id}-1-${n}`, series: SHOWS[id].Name, season: 1, episode: n, title: `Ep ${n}`, size: 2048 });
globalThis.fetch = async (url) => {
  const u = String(url);
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.includes('/Download')) return new Response(Buffer.alloc(2048, 1), { status: 200, headers: { 'content-length': '2048' } });
  const show = u.match(/\/Shows\/(\w+)\/(Seasons|Episodes)/);
  if (show) {
    return show[2] === 'Seasons'
      ? json({ Items: [{ Id: `${show[1]}-S1`, IndexNumber: 1, ChildCount: SHOWS[show[1]].n }] })
      : json({ Items: episodesOf(show[1]) });
  }
  if (u.includes('/Items')) {
    const term = decodeURIComponent((u.match(/searchTerm=([^&]*)/) ?? [])[1] ?? '').toLowerCase();
    return json({
      Items: Object.entries(SHOWS).filter(([, s]) => !term || s.Name.toLowerCase().includes(term))
        .map(([Id, s]) => ({ Id, Name: s.Name, ProductionYear: s.ProductionYear, Type: 'Series' })),
    });
  }
  return new Response('{}', { status: 404 });
};

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
let seq = 0;
const mkMsg = (text, { sender = '15551110000', name = 'Avi' } = {}) => {
  const id = `MSG${++seq}`;
  const key = { remoteJid: TVREQ, id, fromMe: false };
  return {
    text, chatJid: TVREQ, isGroup: true, fromMe: false, messageType: 'conversation',
    senderJid: `${sender}@s.whatsapp.net`, senderNumber: sender, senderNumberDisplay: `+${sender}`,
    pushName: name, id, key, timestamp: Date.now(), raw: { key, message: { conversation: text } },
  };
};

/** The bot, the queue and the plugin, wired as setup() wires them. */
function rig({ cap = 0, store = new Map(), workDir = fs.mkdtempSync(path.join(TMP, 'work-')) } = {}) {
  const notes = [];
  const replies = [];
  const reacts = [];
  const sent = [];
  const holds = new Map();
  const revoked = new Set();
  const counts = { paced: 0 };
  const config = mergeDefaults({
    movieRequests: { notify: { group: NOTIFY }, blockedRatings: [] },
    media: { workDir, ffprobePath: FFPROBE, ffmpegPath: '/bin/false', deleteAfterSend: true },
    tvRequests: {
      enabled: true, requestGroups: [TVREQ], postsGroups: ['tvposts@g.us'], cooldownSecondsPerUser: 0,
      maxEpisodesPerRequest: cap, requirePrefix: true, prefix: '#request', blockedRatings: [],
    },
    whatsapp: { broadcastPacingMs: 0 },
  }, DEFAULT_CONFIG);
  config.library.jellyfin = { baseUrl: 'http://jf.test', accessToken: 'TOK', userId: 'U1' };
  const bot = {
    isConnected: () => true,
    isGroupAdmin: () => false,
    groups: () => [],
    groupMemberInfo: () => ({ isMember: false }),
    deleteMessage: async () => {},
    archiveChat: async () => {},
    isRevoked: (id) => revoked.has(id),
    _bulkPace: async () => { counts.paced += 1; },
    react: async (msg, emoji) => { reacts.push(`${msg.id} ${emoji}`); return true; },
    sendText: async (jid, text, { quoted = null } = {}) => {
      if (jid === NOTIFY) notes.push(text);
      else replies.push({ jid, text, quoted: quoted?.key?.id ?? null, raw: !!quoted?.raw });
      return { key: { id: `S${replies.length}` } };
    },
    sendDocument: async (jid, file, { fileName }) => {
      const hold = [...holds.entries()].find(([code]) => fileName.includes(code))?.[1];
      if (hold) { hold.reached = true; await hold.gate; }
      sent.push(fileName.match(/S\d\dE\d\d/)?.[0] ?? fileName);
      return {};
    },
  };
  const q = new JobQueue({ concurrency: 1, maxLength: 50 });
  const p = Object.create(tvPlugin);
  Object.assign(p, {
    _live: new Map(), _reactors: new Map(), _followers: new Map(), _awaitingRecovery: null,
    _retries: null, _retryBooked: null, _handoffs: null, _positionsTimer: null, _pumping: false,
  });
  const ctx = {
    config, log: quiet, bot, queue: q,
    store: { get: (k, d) => (store.has(k) ? store.get(k) : d), set: (k, v) => store.set(k, v), flush: () => true },
  };
  const onQ = () => { try { p._pump(ctx); } catch { /* as setup() */ } p._positionsSoon(ctx); };
  for (const ev of ['added', 'updated', 'state']) q.on(ev, onQ);
  const pluginManager = { plugins: new Map([['tv-requests', { plugin: p, ctx }]]) };
  const hold = (code) => {
    let release;
    const gate = new Promise((r) => { release = r; });
    holds.set(code, { gate, release, reached: false });
  };
  return {
    p, q, ctx, store, notes, replies, reacts, sent, revoked, counts, pluginManager, hold,
    reached: (code) => !!holds.get(code)?.reached,
    release: (code) => holds.get(code)?.release(),
    journal: () => store.get('pending') ?? [],
    entry: (title) => (store.get('pending') ?? []).find((r) => String(r.label).startsWith(title)),
    row: (id) => (store.get('history') ?? []).find((h) => h.id === id),
    waitingOf: (title) => q.pending.filter((e) => e.groupLabel === title).map((e) => e.label.match(/E\d\d$/)[0]),
    on: (msg) => reacts.filter((r) => r.startsWith(`${msg.id} `)).map((r) => r.slice(msg.id.length + 1)),
    trim: (cmd = {}) => runAdminCommand({ op: 'trim-tv-requests', ...cmd }, { pluginManager }),
  };
}
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => `E${String(a + i).padStart(2, '0')}`);

const ARROW_NEXT = 'Once these are posted, send *#request Arrow S01E11-E20* for the next part.';
// Since the trim and a request the limit cuts as it is made were brought to
// agree (2026-10-12), a trimmed request is named as that one is, by what it
// holds and what it is part of: "Arrow S01E01–E10 — 10 of season 1", in the
// journal, the queue, History and the finished notice - which names the next
// part, as that one's does. These pins were "Arrow season 1 — 10 episode(s)".
const ARROW_NOW = 'Arrow S01E01–E10';
const ARROW_CUT = 'one request is at most 10; taken off the queue: E11–E23 (next: S01E11-E20)';
const ETHAN = '⚠️ *Arrow* S01E15 was taken off the queue: it was coming with an earlier request, and one request is at most 10 episodes now.\n'
  + 'Send *#request Arrow S01E15* for it.';

console.log('=== Arrow season 1, 23 episodes with 3 posted and 1 running, is trimmed to 10 and ends on ✅ ===');
let afterTrim = null;                         // the store as the trim left it, for the restart below
let arrowId = null;
{
  const r = rig();
  r.hold('S01E04');
  const arrow = mkMsg('#request Arrow season 1', { sender: '15551110001', name: 'Avi' });
  arrowId = arrow.id;
  await r.p.onMessage(arrow, r.ctx);
  // Another member's request under the limit, waiting behind it; and a third
  // member asking for an episode of it, who follows it as a duplicate.
  const loki = mkMsg('#request Loki season 1', { sender: '15551110002', name: 'Diane' });
  await r.p.onMessage(loki, r.ctx);
  const dup = mkMsg('#request Arrow S01E15', { sender: '15551110003', name: 'Ethan' });
  await r.p.onMessage(dup, r.ctx);
  ok(await until(() => r.reached('S01E04')), 'E01-E03 are posted and E04 is being sent');
  ok(r.sent.join() === 'S01E01,S01E02,S01E03', `three posted (${r.sent.join()})`);
  ok(r.waitingOf('Arrow season 1').length === 19 && r.journal().find((e) => e.label.startsWith('Arrow'))?.episodes.length === 20,
    'nineteen waiting in the queue, twenty in the journal with the running one');
  await until(() => r.on(loki).includes('1️⃣'), 2000);
  const lokiBefore = r.on(loki).join(' ');
  ok(lokiBefore === '🔍 🎬 1️⃣', `Loki waits first in line (${lokiBefore})`);

  // The limit is set after they were queued, as on 2026-10-12.
  r.ctx.config.tvRequests.maxEpisodesPerRequest = 10;

  console.log('--- the dry run changes nothing, and says what it would do ---');
  const replyBefore = r.replies.length;
  const dry = await r.trim();
  const d = dry.requests?.[0];
  ok(dry.ok && dry.applied === false && dry.max === 10 && dry.trimmed === 1, `one request over the limit (${JSON.stringify({ applied: dry.applied, max: dry.max, trimmed: dry.trimmed })})`);
  ok(d?.request === 'Arrow season 1' && d.member === 'Avi +15551110001', `named with its member (${d?.request} / ${d?.member})`);
  ok(d?.posted === 3 && d.inHand === 'E4' && d.kept === 'E5–E10' && d.takenOff === 'E11–E23'
    && d.episodes.before === 23 && d.episodes.after === 10,
  `3 posted, E04 in hand, E05–E10 kept, E11–E23 off (${JSON.stringify({ inHand: d?.inHand, kept: d?.kept, off: d?.takenOff })})`);
  const expected = '⚠️ *Arrow* season 1 — one request is at most 10 episodes now, so episodes 4–10 are still coming '
    + `(3 are posted already) and 11–23 were taken off the queue.\n${ARROW_NEXT}`;
  ok(d?.reply === expected, `the exact words its member would get:\n${d?.reply}`);
  ok(d?.next === '#request Arrow S01E11-E20' && d.told === 'dry run: would be sent', `and the next part (${d?.next}; ${d?.told})`);
  // Ethan asked for E15 alone, and E15 is taken off: he is told so, and let
  // go of the request, rather than end on its ✅ for an episode that never
  // came (found in review, 2026-10-12).
  ok(d?.followers?.length === 1 && d.followers[0].told === 'dry run: would be sent' && d.followers[0].takenOff === true
    && d.followers[0].reply === ETHAN, `the member following it would be told his episode is off (${d?.followers?.[0]?.reply})`);
  ok(dry.untouched.join() === 'Loki season 1 (6 episode(s))', `Loki is under the limit (${dry.untouched.join()})`);
  ok(r.waitingOf('Arrow season 1').length === 19 && r.entry('Arrow').episodes.length === 20
    && r.entry('Arrow').label === 'Arrow season 1 — 23 episode(s)' && r.replies.length === replyBefore
    && r.row(arrow.id).episodes === 23,
  'and nothing changed: queue, journal, label, History, no reply');
  ok(summariseAdminCommand({ op: 'trim-tv-requests' }, dry) === null, 'a dry run is not audited as a change');

  console.log('--- applied ---');
  const res = await r.trim({ apply: true, by: 'owner' });
  const a = res.requests?.[0];
  ok(res.ok && res.applied === true && a?.reply === expected && a.told === 'sent', `done, and the member told (${a?.told})`);
  ok(r.waitingOf(ARROW_NOW).join() === range(5, 10).join(), `the queue holds E05–E10 waiting, under its new name (${r.waitingOf(ARROW_NOW).join()})`);
  ok(r.q.active.size === 1 && [...r.q.active.values()][0].label === 'Arrow S01E04', 'E04 is still running, untouched');
  const view = r.q.snapshot().active.find((v) => v.label === ARROW_NOW);
  ok(view?.jobs.total === 10 && view.jobs.done === 3 && view.jobs.running === 1 && view.jobs.waiting === 6 && view.jobs.cancelled === 0,
    `the panel shows a request of 10, 3 done (${JSON.stringify(view?.jobs)})`);
  const e = r.entry('Arrow');
  ok(e?.label === 'Arrow S01E01–E10 — 10 of season 1' && e.episodes.map((x) => x.episode).join() === '4,5,6,7,8,9,10',
    `the journal holds E04–E10 as "Arrow S01E01–E10 — 10 of season 1" (${e?.label}: ${e?.episodes.map((x) => x.episode).join()})`);
  ok(e?.next?.send === '#request Arrow S01E11-E20' && e.next.last === false && e.baseRow?.cut?.trimmed === true,
    `and the next part its finished notice names, and the cut (${JSON.stringify(e?.next)})`);
  ok(e?.tally?.trimmed === 13 && !e.tally.cancelled, 'the thirteen are counted as trimmed, not cancelled');
  const row = r.row(arrow.id);
  ok(row?.status === 'queued' && row.episodes === 10 && row.detail === `S01E01–E10 — 10 of season 1 · ${ARROW_CUT}`
    && JSON.stringify(row.cut?.queued) === '[[1,10]]' && JSON.stringify(row.cut?.parts) === '[[11,20],[21,23]]',
    `History says what is coming now (${row?.episodes}: ${row?.detail})`);
  const owner = r.replies.filter((x) => x.quoted === arrow.id);
  ok(owner.length === 1 && owner[0].jid === TVREQ && owner[0].text === expected, 'one reply in the request group, quoted to the request');
  const told = r.replies.filter((x) => x.quoted === dup.id);
  ok(told.length === 1 && told[0].text === ETHAN, 'the member following it is told on their own message that his episode is off');
  const ethanRow = (r.store.get('history') ?? []).find((h) => h.request === '#request Arrow S01E15' || /Arrow S01E15/.test(h.request ?? ''));
  ok(ethanRow?.status === 'trimmed' && /taken off the queue, with an earlier request for it/.test(ethanRow.detail ?? '')
    && !(r.entry('Arrow').followers ?? []).length, `his row says so, and he no longer follows it (${ethanRow?.status}: ${ethanRow?.detail})`);
  ok(r.counts.paced === 1, `the two replies are paced (${r.counts.paced} pace)`);
  ok(!r.on(arrow).includes('❌') && !r.on(dup).includes('❌'), 'no ❌ anywhere');
  await tick(20);
  ok(r.on(loki).join(' ') === lokiBefore, `Loki keeps its place and its reactions (${r.on(loki).join(' ')})`);
  ok(r.waitingOf('Loki season 1').length === 6 && r.entry('Loki').episodes.length === 6, 'and all six of its episodes');
  const audit = summariseAdminCommand({ op: 'trim-tv-requests', by: 'owner' }, res);
  ok(/trimmed 1 queued TV request\(s\) to at most 10 episodes/.test(audit?.action ?? '')
    && /Arrow season 1: E11–E23 taken off, 10 kept/.test(audit?.detail ?? ''),
  `the audit log names what was trimmed (${audit?.action} - ${audit?.detail})`);

  // What a member is told to send asks for exactly the next ten.
  const ask = parseTvRequest(d.next.replace(/^#request\s+/, ''));
  ok(ask.show === 'Arrow' && ask.season === 1 && ask.episodeRange?.from === 11 && ask.episodeRange?.to === 20,
    `"${d.next}" parses back to Arrow season 1, E11-E20 (${JSON.stringify(ask.episodeRange)})`);

  console.log('--- run again: nothing to do ---');
  const repliesNow = r.replies.length;
  const again = await r.trim({ apply: true });
  ok(again.trimmed === 0 && again.untouched.length === 2 && r.replies.length === repliesNow
    && r.waitingOf(ARROW_NOW).length === 6 && r.entry('Arrow').episodes.length === 7,
  `a second run trims nothing and tells nobody (${again.untouched.join(' · ')})`);

  afterTrim = new Map(JSON.parse(JSON.stringify([...r.store])));

  console.log('--- the rest is posted ---');
  r.release('S01E04');
  ok(await until(() => r.notes.some((n) => n.startsWith('✅ Arrow'))), 'the request concludes');
  ok(r.sent.filter((c) => c.startsWith('S01')).length >= 10, 'its episodes are posted');
  const arrowSent = r.sent.slice(0, 10);
  ok(arrowSent.join() === range(1, 10).map((x) => `S01${x}`).join(), `E01–E10, and nothing past them (${arrowSent.join()})`);
  const done = r.notes.find((n) => n.startsWith('✅ Arrow'));
  ok(done === '✅ Arrow S01E01–E10 — 10 of season 1 — all 10 episodes posted! Check the posts group\n'
    + 'Send *#request Arrow S01E11-E20* for the next part.', `the notice names the next part: "${done}"`);
  ok(r.on(arrow).at(-1) === '✅' && !r.on(arrow).some((x) => ['❌', '⚠️', '⏭️'].includes(x)),
    `the request's message ends on ✅ (${r.on(arrow).join(' ')})`);
  ok(!r.on(dup).includes('✅'), `and the member whose episode was taken off is not told it was posted (${r.on(dup).join(' ')})`);
  ok(ethanRow && (r.store.get('history') ?? []).find((h) => h.id === ethanRow.id)?.status === 'trimmed', 'his row still says trimmed');
  const fin = r.row(arrow.id);
  ok(fin?.status === 'sent' && fin.episodes === 10 && fin.detail === `10 episode(s) posted · ${ARROW_CUT}`
    && /E11–E23/.test(fin.trimmed ?? ''),
  `History: sent, 10 episodes (${fin?.status}, ${fin?.episodes}: ${fin?.detail})`);
  ok(await until(() => r.notes.some((n) => n.startsWith('✅ Loki'))), 'Loki, untouched, runs after it');
  ok(/all 6 episodes posted/.test(r.notes.find((n) => n.startsWith('✅ Loki')) ?? ''), 'all six');
  ok(!r.sent.some((c) => /S01E(1[1-9]|2\d)/.test(c) && r.sent.indexOf(c) < 10), 'no trimmed episode was ever sent');
  ok(r.journal().length === 0, 'and the journal is empty');
  r.q.close();
}

console.log('=== a restart after the trim does not bring the episodes back ===');
{
  const r = rig({ cap: 10, store: afterTrim });
  r.q.pause();
  await r.p.recoverPending(r.ctx);
  const labels = r.q.pending.filter((e) => e.groupLabel === ARROW_NOW).map((e) => e.label.match(/E\d\d$/)[0]);
  ok(labels.join() === range(4, 10).join(), `only E04–E10 go back in (${labels.join()})`);
  r.q.resume();
  ok(await until(() => r.notes.some((n) => n.startsWith('✅ Arrow'))), 'and it concludes');
  ok(r.notes.find((n) => n.startsWith('✅ Arrow')) === '✅ Arrow S01E01–E10 — 10 of season 1 — all 10 episodes posted! Check the posts group\n'
    + 'Send *#request Arrow S01E11-E20* for the next part.', `"${r.notes.find((n) => n.startsWith('✅ Arrow'))}"`);
  const row = (r.store.get('history') ?? []).find((h) => h.id === arrowId);
  ok(row?.status === 'sent' && row.episodes === 10 && row.detail === `10 episode(s) posted (resumed) · ${ARROW_CUT}`,
    `History still says 10 (${row?.episodes}: ${row?.detail})`);
  ok(!r.sent.some((c) => /E(1[1-9]|2\d)$/.test(c)), `nothing past E10 is posted (${r.sent.join()})`);
  r.q.close();
}

console.log('=== while a restart is still putting requests back, nothing is trimmed; once they are back, they are ===');
{
  // Malcolm in the Middle season 1 (16), journalled by the version before
  // this one: no trimmed count, no start recorded, no episode numbers. Lost
  // season 1, in the same old shape, four of its ten posted before the
  // restart. And a Loki-sized request under the limit, which goes back
  // exactly as it always did.
  //
  // A request a restart left has no notifier until TV recovery has waited
  // for the films and resumed it. Trimmed to nothing in the journal before
  // then, it was dropped from it and never finished: History "queued" for
  // good, no ✅, no notice, its followers never told - Lucifer season 6 on
  // the live journal with "max": 4 (found in review, 2026-10-12). So while
  // requests are being put back the trim refuses, as mark-extras does, and
  // a dry run still says what it would do.
  const store = new Map();
  const malcolm = {
    reqKey: 'tv-MALCMSG-1', label: 'Malcolm in the Middle season 1 — 16 episode(s)',
    msgId: 'MALCMSG', msgKey: { remoteJid: TVREQ, id: 'MALCMSG', fromMe: false }, chatJid: TVREQ,
    requester: '+15551110004', requesterNumber: '15551110004', memberKey: 'num:15551110004',
    baseRow: {
      id: 'MALCMSG', kind: 'tv', at: Date.now() - 3600_000, requester: 'Ari', request: 'malcolm in the middle s1',
      title: 'Malcolm in the Middle', season: 1, episodes: 16, status: 'queued', detail: 'season 1 — 16 episode(s)',
    },
    episodes: Array.from({ length: 16 }, (_, i) => journalEp('MALC', i + 1)),
  };
  const lost = {
    reqKey: 'tv-LOSTMSG-1', label: 'Lost season 1 — 10 episode(s)',
    msgId: 'LOSTMSG', msgKey: { remoteJid: TVREQ, id: 'LOSTMSG', fromMe: false }, chatJid: TVREQ,
    requester: '+15551110008', requesterNumber: '15551110008', memberKey: 'num:15551110008',
    baseRow: { id: 'LOSTMSG', kind: 'tv', title: 'Lost', season: 1, episodes: 10, status: 'queued', detail: 'season 1 — 10 episode(s)' },
    tally: { completed: 4, failed: 0, cancelled: 0, skipped: 0 },
    episodes: Array.from({ length: 6 }, (_, i) => journalEp('LOST', i + 5)),
  };
  const loki = {
    reqKey: 'tv-LOKIMSG-1', label: 'Loki season 1 — 6 episode(s)',
    msgId: 'LOKIMSG', msgKey: { remoteJid: TVREQ, id: 'LOKIMSG', fromMe: false }, chatJid: TVREQ,
    requester: '+15551110005', baseRow: { id: 'LOKIMSG', kind: 'tv', title: 'Loki', season: 1, episodes: 6, status: 'queued', detail: 'season 1 — 6 episode(s)' },
    episodes: Array.from({ length: 6 }, (_, i) => journalEp('HOST', i + 1)),
  };
  store.set('pending', [malcolm, lost, loki]);
  store.set('history', [{ ...malcolm.baseRow }, { ...lost.baseRow }, { ...loki.baseRow }]);
  const r = rig({ cap: 0, store });
  r.revoked.add('MALCMSG');                   // its member deleted the request since
  const films = holdTvRecovery(r.q);
  const recovering = r.p.recoverPending(r.ctx);
  await tick(20);
  ok(r.p._awaitingRecovery?.size === 3 && r.q.pending.length === 0, 'TV recovery waits for the films; nothing is in the queue');
  // A request made meanwhile is held behind them (_holdForRecovery).
  const arrow = mkMsg('#request Arrow season 1', { sender: '15551110006', name: 'Shawn' });
  await r.p.onMessage(arrow, r.ctx);
  ok(r.p._live.get(r.entry('Arrow').reqKey)?.held && r.q.pending.length === 0, 'Arrow, asked for now, is held behind them');

  const refused = await r.trim({ apply: true }).catch((err) => err);
  ok(/maxEpisodesPerRequest is 0/.test(refused?.message ?? ''), `with no limit set and no max given it refuses (${refused?.message})`);
  ok(r.entry('Malcolm').episodes.length === 16, 'and changes nothing');

  const early = await r.trim({ apply: true, max: 4 }).catch((err) => err);
  ok(/3 TV request\(s\) left by the restart are still being put back into the queue - nothing was trimmed/.test(early?.message ?? ''),
    `while they are being put back, it refuses (${early?.message})`);
  ok(r.entry('Lost')?.episodes.length === 6 && r.entry('Malcolm').episodes.length === 16 && r.entry('Arrow').episodes.length === 23
    && !r.replies.length, 'and changes nothing - Lost, which "max": 4 would take everything waiting of, is still journalled - and tells nobody');
  const dry = await r.trim({ max: 10 });
  ok(dry.applied === false && dry.trimmed === 2, `a dry run still says what it would do (${dry.requests.map((x) => x.request).join(', ')})`);

  r.q.pause();
  films();
  await recovering;
  const queued = (t) => r.q.pending.filter((e) => e.groupLabel === t).length + [...r.q.active.values()].filter((e) => e.groupLabel === t).length;
  ok(!r.p._awaitingRecovery && queued('Malcolm in the Middle season 1') === 16 && queued('Arrow season 1') === 23,
    'once the films are back, every request is in the queue');

  const res = await r.trim({ apply: true, max: 10 });
  const byName = (t) => res.requests.find((x) => x.request === t);
  ok(res.trimmed === 2 && res.max === 10, `max given: two trimmed to 10 (${res.requests.map((x) => x.request).join(', ')})`);
  ok(res.untouched.join() === 'Lost season 1 (10 episode(s)),Loki season 1 (6 episode(s))', `Lost and Loki are left alone (${res.untouched.join()})`);
  const m = r.entry('Malcolm');
  // An old entry with nothing posted yet: every episode it holds is in the
  // journal, so it is named by them as a new one is.
  ok(m?.episodes.length === 10 && m.label === 'Malcolm in the Middle S01E01–E10 — 10 of season 1' && m.tally?.trimmed === 6,
    `Malcolm's journal holds E01–E10 (${m?.episodes.length}, ${m?.label})`);
  ok(byName('Malcolm in the Middle season 1')?.told === 'not told: its message was deleted'
    && !r.replies.some((x) => x.quoted === 'MALCMSG'), 'its request was deleted: trimmed, not answered');
  ok(byName('Malcolm in the Middle season 1')?.reply === '⚠️ *Malcolm in the Middle* season 1 — one request is at most 10 episodes now, '
    + 'so episodes 1–10 are still coming and 11–16 were taken off the queue.\n'
    + 'Once these are posted, send *#request Malcolm in the Middle S01E11-E16* for the rest.', 'what it would have said names the rest');
  const ar = r.entry('Arrow');
  ok(ar?.episodes.length === 10 && ar.label === 'Arrow S01E01–E10 — 10 of season 1', 'the held Arrow is trimmed too');
  const arrowReply = r.replies.find((x) => x.quoted === arrow.id);
  ok(arrowReply?.raw && arrowReply.text === '⚠️ *Arrow* season 1 — one request is at most 10 episodes now, so episodes 1–10 are '
    + `still coming and 11–23 were taken off the queue.\n${ARROW_NEXT}`, `Shawn is told, quoted (${arrowReply?.text})`);

  ok(queued('Malcolm in the Middle S01E01–E10') === 10 && queued(ARROW_NOW) === 10 && queued('Loki season 1') === 6 && queued('Lost season 1') === 6,
    `ten of each trimmed request stay, Loki's six and Lost's six (${queued('Malcolm in the Middle S01E01–E10')}, ${queued(ARROW_NOW)}, ${queued('Loki season 1')}, ${queued('Lost season 1')})`);
  r.q.resume();
  ok(await until(() => ['Malcolm', 'Loki', 'Arrow', 'Lost'].every((t) => r.notes.some((n) => n.startsWith(`✅ ${t}`))), 30_000), 'all four conclude');
  ok(r.notes.find((n) => n.startsWith('✅ Malcolm')) === '✅ Malcolm in the Middle S01E01–E10 — 10 of season 1 — all 10 episodes posted! '
    + 'Check the posts group\nSend *#request Malcolm in the Middle S01E11-E16* for the rest.',
  `"${r.notes.find((n) => n.startsWith('✅ Malcolm'))}"`);
  ok(r.notes.find((n) => n.startsWith('✅ Arrow')) === '✅ Arrow S01E01–E10 — 10 of season 1 — all 10 episodes posted! Check the posts group\n'
    + 'Send *#request Arrow S01E11-E20* for the next part.', `"${r.notes.find((n) => n.startsWith('✅ Arrow'))}"`);
  const lokiDone = (r.store.get('history') ?? []).find((h) => h.id === 'LOKIMSG');
  ok(lokiDone?.status === 'sent' && lokiDone.episodes === 6 && lokiDone.detail === '6 episode(s) posted (resumed)',
    `the old entry under the limit loads and ends as it always did (${lokiDone?.detail})`);
  const lostDone = (r.store.get('history') ?? []).find((h) => h.id === 'LOSTMSG');
  ok(lostDone?.status === 'sent' && lostDone.detail === '10 episode(s) posted (resumed)', `and so does Lost (${lostDone?.status}: ${lostDone?.detail})`);
  const malcRow = (r.store.get('history') ?? []).find((h) => h.id === 'MALCMSG');
  ok(malcRow?.status === 'sent' && malcRow.episodes === 10, `Malcolm's row: sent, 10 (${malcRow?.episodes}: ${malcRow?.detail})`);
  ok(r.sent.filter((c) => c.startsWith('S01')).length === 32, `32 episodes posted in all (${r.sent.length})`);
  r.q.close();
}

console.log('=== a request past the limit already keeps nothing waiting, and concludes when its running episode ends ===');
{
  const r = rig();
  r.hold('S01E13');
  const lost = mkMsg('#request Lost season 1', { sender: '15551110007', name: 'Moshe' });
  await r.p.onMessage(lost, r.ctx);
  ok(await until(() => r.reached('S01E13')), 'twelve posted, E13 being sent');
  r.ctx.config.tvRequests.maxEpisodesPerRequest = 10;
  const res = await r.trim({ apply: true });
  const x = res.requests[0];
  ok(x?.posted === 12 && x.inHand === 'E13' && x.kept === null && x.takenOff === 'E14, E15' && x.episodes.after === 13,
    `E13 runs on; E14 and E15 come off (${JSON.stringify({ inHand: x?.inHand, kept: x?.kept, off: x?.takenOff })})`);
  ok(x?.reply === '⚠️ *Lost* season 1 — one request is at most 10 episodes now, so episode 13 is still coming '
    + '(12 are posted already) and 14 and 15 were taken off the queue.\nOnce it is posted, send *#request Lost S01E14-E15* for the rest.',
  `"${x?.reply}"`);
  ok(r.q.pending.length === 0, 'nothing of it waits');
  r.release('S01E13');
  ok(await until(() => r.notes.some((n) => n.startsWith('✅ Lost'))), 'it concludes when E13 is posted');
  ok(r.notes.find((n) => n.startsWith('✅ Lost')) === '✅ Lost S01E01–E13 — 13 of season 1 — all 13 episodes posted! Check the posts group\n'
    + 'Send *#request Lost S01E14-E15* for the rest.', `named by what it held, and the rest: "${r.notes.find((n) => n.startsWith('✅ Lost'))}"`);
  ok(r.on(lost).at(-1) === '✅', `on ✅ (${r.on(lost).join(' ')})`);
  ok(r.journal().length === 0 && !r.sent.includes('S01E14'), 'and E14 never goes');
  r.q.close();
}

console.log('=== episodes the member was sent already by an earlier request are taken off, and keep no place ===');
{
  // Hunter x Hunter (2011) season 1, 148 episodes, on the live journal, was
  // Ari's, and his "hunter x hunter s1 e1-10" had been sent on 2026-10-08
  // ("10 episode(s) posted (resumed)"). Kept to its first ten, the season
  // would have posted E1-E10 to him a second time and taken off E11-E148,
  // the ones he did not have (found in review, 2026-10-12). Forty here.
  const ARI = '15551110009';
  const earlier = {
    id: 'ACFBE674', kind: 'tv', at: Date.now() - 4 * 86400_000, request: 'hunter x hunter s1 e1-10', title: 'Hunter x Hunter (2011)',
    season: 1, status: 'sent', episodes: 10, detail: '10 episode(s) posted (resumed)', requester: 'Ari', requesterNumber: ARI, requesterJid: 'ari@lid',
  };
  const r = rig({ store: new Map([['history', [earlier]]]) });
  r.q.pause();
  const hxh = mkMsg('#request hunter x hunter s1', { sender: ARI, name: 'Ari' });
  await r.p.onMessage(hxh, r.ctx);
  ok(r.waitingOf('Hunter x Hunter (2011) season 1').length === 40, 'queued before the limit: all forty');
  r.ctx.config.tvRequests.maxEpisodesPerRequest = 10;
  const HXH_REPLY = '⚠️ *Hunter x Hunter (2011)* season 1 — one request is at most 10 episodes now, so episodes 11–20 are still coming '
    + 'and 21–40 were taken off the queue. Episodes 1–10 were taken off too, as they were sent to you already.\n'
    + 'Once these are posted, send *#request Hunter x Hunter (2011) S01E21-E30* for the next part.';
  const dry = await r.trim();
  const d = dry.requests[0];
  ok(d?.kept === 'E11–E20' && d.sentAlready === 'E1–E10' && d.takenOff === 'E1–E10, E21–E40' && d.episodes.after === 10,
    `E11-E20 kept, E1-E10 off as sent already (${JSON.stringify({ kept: d?.kept, sent: d?.sentAlready, off: d?.takenOff })})`);
  ok(d?.next === '#request Hunter x Hunter (2011) S01E21-E30' && d.reply === HXH_REPLY, `the words he would get:\n${d?.reply}`);
  ok(d?.named === 'Hunter x Hunter (2011) S01E11–E20 — 10 of season 1', `and what it would be named (${d?.named})`);
  const res = await r.trim({ apply: true });
  ok(res.requests[0]?.told === 'sent' && r.replies.find((x) => x.quoted === hxh.id)?.text === HXH_REPLY, 'applied: he is told');
  const now = 'Hunter x Hunter (2011) S01E11–E20';
  ok(r.waitingOf(now).join() === range(11, 20).join(), `the queue holds E11-E20 (${r.waitingOf(now).join()})`);
  const row = r.row(hxh.id);
  ok(JSON.stringify(row?.cut?.queued) === '[[11,20]]' && JSON.stringify(row.cut.sentAlready) === '[[1,10]]' && JSON.stringify(row.cut.parts) === '[[21,30],[31,40]]',
    `History's cut says so (${JSON.stringify(row?.cut)})`);
  ok(row?.detail === 'S01E11–E20 — 10 of season 1 · one request is at most 10; taken off the queue: E21–E40, and E1–E10, sent to them already (next: S01E21-E30)',
    `History: "${row?.detail}"`);

  // Which of a member's rows count: one of theirs, sent, from a main group,
  // about episodes it names - less any it withheld.
  const req = r.entry('Hunter');
  const sentBy = (rows) => { r.store.set('history', rows); return [...r.p._sentAlready(r.ctx, req)].sort((a, b) => a - b).join(); };
  const other = { ...earlier, requesterNumber: '15550000000', requesterJid: 'someone@lid' };
  ok(sentBy([other]) === '', 'another member\'s request: none');
  ok(sentBy([{ ...earlier, status: 'partial' }]) === '', 'a partial one: none - its row does not say which failed');
  ok(sentBy([{ ...earlier, request: 'hunter x hunter s1' }]) === '', 'a whole season: none - its row does not say which episodes');
  ok(sentBy([{ ...earlier, beta: true }]) === '', 'a beta test: none');
  ok(sentBy([{ ...earlier, withheld: '1 withheld (TV-MA): E4' }]) === '1,2,3,5,6,7,8,9,10', 'one withheld on rating was never sent');
  ok(sentBy([{ ...earlier, request: 'hunter x hunter s01e03, e07' }]) === '3,7', 'a list: what it named');
  r.q.close();
}

console.log('=== a request named by part of what it asked is named again by what it holds ===');
{
  // Since 2026-10-12 a request that queued part of what it asked is named by
  // what went in: Bea's E1-E5 waiting, Avi's "Arrow season 1" queued E6-E23
  // as "Arrow S01E06–E23 — 18 of season 1". The trim's renames knew only "—
  // 18 episode(s)": the reply led "⚠️ *Arrow* S01E06–E23 — 18 of season 1 —
  // one request is…", and the label, the finished notice and the queue kept
  // the old span (found in review).
  const r = rig();
  r.q.pause();
  await r.p.onMessage(mkMsg('#request Arrow S01E01-E05', { sender: '15551110010', name: 'Bea' }), r.ctx);
  const avi = mkMsg('#request Arrow season 1', { sender: '15551110011', name: 'Avi' });
  await r.p.onMessage(avi, r.ctx);
  ok(r.entry('Arrow S01E06').label === 'Arrow S01E06–E23 — 18 of season 1', `queued as part of it (${r.entry('Arrow S01E06')?.label})`);
  r.ctx.config.tvRequests.maxEpisodesPerRequest = 10;
  const res = await r.trim({ apply: true });
  const a = res.requests.find((x) => x.request === 'Arrow S01E06–E23');
  ok(a?.reply === '⚠️ *Arrow* season 1 — one request is at most 10 episodes now, so episodes 6–15 are still coming and 16–23 were taken off the queue.\n'
    + 'Once these are posted, send *#request Arrow S01E16-E23* for the rest.', `the reply leads with what was asked for: "${a?.reply}"`);
  ok(r.entry('Arrow S01E06')?.label === 'Arrow S01E06–E15 — 10 of season 1', `the journal (${r.entry('Arrow S01E06')?.label})`);
  ok(r.waitingOf('Arrow S01E06–E15').join() === range(6, 15).join() && r.q.snapshot().pending.some((v) => v.label === 'Arrow S01E06–E15'),
    'the queue, and its item on the panel');
  ok(r.row(avi.id)?.detail === 'S01E06–E15 — 10 of season 1 · one request is at most 10; taken off the queue: E16–E23 (next: S01E16-E23)',
    `History: "${r.row(avi.id)?.detail}"`);
  r.q.resume();
  ok(await until(() => r.notes.some((n) => n.startsWith('✅ Arrow S01E06'))), 'it concludes');
  ok(r.notes.find((n) => n.startsWith('✅ Arrow S01E06')) === '✅ Arrow S01E06–E15 — 10 of season 1 — all 10 episodes posted! Check the posts group\n'
    + 'Send *#request Arrow S01E16-E23* for the rest.', `the notice: "${r.notes.find((n) => n.startsWith('✅ Arrow S01E06'))}"`);
  r.q.close();
}

console.log('=== episodes with no number are taken off by item, not by number ===');
{
  // Two episodes the library never numbered share a season and a "number":
  // matched on those, the plan kept one and queue.trim took off both
  // (found in review). The queue's jobs carry the item now.
  const r = rig();
  r.q.pause();
  const odd = mkMsg('#request Odd Show season 1', { sender: '15551110012', name: 'Dan' });
  await r.p.onMessage(odd, r.ctx);
  const jobs = () => r.q.pending.filter((e) => e.group === r.entry('Odd Show')?.reqKey);
  ok(jobs().length === 5, `five queued (${jobs().length})`);
  const res = await r.trim({ apply: true, max: 1 });
  const x = res.requests[0];
  ok(x?.kept && x.episodes.after === 1, `one kept (${x?.kept})`);
  const left = jobs();
  const kept = r.entry('Odd Show')?.episodes ?? [];
  ok(left.length === 1 && kept.length === 1 && left[0].meta.epId === String(kept[0].id),
    `the queue holds the one kept, and only it (${left.map((e) => e.meta.epId).join()} / ${kept.map((e) => e.id).join()})`);
  r.q.close();

  // One of the two running: the other is waiting, not in hand with it.
  const r2 = rig();
  r2.hold('S01E00');
  await r2.p.onMessage(mkMsg('#request Odd Show season 1', { sender: '15551110013', name: 'Dan' }), r2.ctx);
  ok(await until(() => r2.reached('S01E00')), 'the first of the two with no number is being sent');
  const y = (await r2.trim({ apply: true, max: 2 })).requests[0];
  ok(y?.inHand === '1 without a number' && y.kept === '1 without a number' && y.takenOff === 'E1–E3',
    `one in hand, the other kept, the numbered three off (${JSON.stringify({ inHand: y?.inHand, kept: y?.kept, off: y?.takenOff })})`);
  r2.release('S01E00');
  ok(await until(() => r2.notes.some((n) => n.startsWith('✅ Odd Show'))), 'and it concludes with both');
  r2.q.close();
}

console.log('=== a retry waiting counts as in hand; the waiting ones fill the rest in episode order ===');
{
  const r = rig({ cap: 10 });
  const req = { reqKey: 'tv-R', label: 'Arrow season 1 — 12 episode(s)', tally: { completed: 0, failed: 1 },
    episodes: Array.from({ length: 12 }, (_, i) => journalEp('ARROW', i + 1)).reverse() };
  r.p._retryBooked = new Map([['tv-R:ARROW-1-2', {}]]);
  const plan = r.p._trimPlanOf(r.ctx, req, 10);
  ok(plan.inHand.map((e) => e.episode).join() === '2', 'E02, waiting for its retry, is in hand');
  ok(plan.keep.map((e) => e.episode).join() === '1,3,4,5,6,7,8,9', `one failed and one in hand leave eight (${plan.keep.map((e) => e.episode).join()})`);
  ok(plan.off.map((e) => e.episode).join() === '10,11,12', 'and the last three go');
  r.q.close();
}

console.log('=== an entry an older version journalled, part-posted, keeps the kind of name it had ===');
{
  // Which episodes it posted is not in a journal written before this
  // version (no `numbers`), so it cannot be named by what it holds; it
  // keeps "season 1 — N episode(s)", counted down, as the trim named every
  // request before.
  const r = rig({ cap: 10 });
  const req = {
    reqKey: 'tv-OLD', label: 'Arrow season 1 — 23 episode(s)', tally: { completed: 3, failed: 0, cancelled: 0, skipped: 0 },
    baseRow: { id: 'OLD', title: 'Arrow', season: 1, request: 'arrow s1' },
    episodes: Array.from({ length: 20 }, (_, i) => journalEp('ARROW', i + 4)),
  };
  const words = r.p._trimWords(r.ctx, req, r.p._trimPlanOf(r.ctx, req, 10), 10);
  ok(words.label === 'Arrow season 1 — 10 episode(s)' && JSON.stringify(words.cut.queued) === '[[4,10]]',
    `"${words.label}", its cut counting what the journal holds (${JSON.stringify(words.cut.queued)})`);
  const fresh = r.p._trimWords(r.ctx, { ...req, tally: undefined, episodes: Array.from({ length: 23 }, (_, i) => journalEp('ARROW', i + 1)) },
    r.p._trimPlanOf(r.ctx, { ...req, tally: undefined, episodes: Array.from({ length: 23 }, (_, i) => journalEp('ARROW', i + 1)) }, 10), 10);
  ok(fresh.label === 'Arrow S01E01–E10 — 10 of season 1', `with nothing posted yet it holds what it lists: "${fresh.label}"`);
  r.q.close();
}

console.log('=== the next part always reads back as what it asks for ===');
{
  const eps = (show, n) => Array.from({ length: n }, (_, i) => ({ id: `${show}-${i + 1}`, series: show, season: 1, episode: i + 1 }));
  for (const [show, n, max, want] of [
    ['Hunter x Hunter (2011)', 148, 10, [11, 20]], ['Arrow', 23, 10, [11, 20]], ['24', 24, 5, [6, 10]],
    ['9-1-1', 18, 10, [11, 18]], ['Arrow', 11, 10, [11, 11]],
  ]) {
    const all = eps(show, n);
    const plan = trimPlan({ done: 0, inHand: [], waiting: all, max });
    const [part] = partsOf({ season: 1, left: plan.past, coming: plan.keep, max });
    const ask = nextAsk(part, { name: show, prefix: '#request' });
    const back = parseTvRequest(ask.replace(/^#request\s+/, ''));
    const got = back.episodeRange ? [back.episodeRange.from, back.episodeRange.to] : [back.episode, back.episode];
    ok(back.show === show && back.season === 1 && got.join() === want.join() && got[1] - got[0] + 1 <= max,
      `"${ask}" → ${back.show} season ${back.season}, ${got.join('-')}`);
  }
  // A show parse.js would read as something else is never handed out.
  ok(nextAsk({ season: 1, from: 11, to: 20 }, { name: 'Show S02E01-E05', prefix: '#request' }) === null,
    'a name that would parse as another range gets no message to send');
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.statfsSync = realStatfs;
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
