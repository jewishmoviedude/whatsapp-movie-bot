/* A TV request's message ends on how the request went, not on how its last
   episode went.
   Run: node test/tv-request-outcome.test.mjs

   Found in an audit of the TV group (2026-09-29). The requester's message
   was marked ✅ by whichever episode landed last, so a season whose E02
   failed for good still ended on ✅ - while History said "partial" and the
   notifications group "2 of 3 posted, 1 failed". The message now ends on
   the request's outcome: ⚠️ when any episode failed, ✅ otherwise. An admin
   skipping one episode is not the request failing or being cancelled, so a
   skip must not leave the message on ❌ (or on the ⏭️) when the rest posted;
   a request an admin cancels keeps its ❌.

   A review of that fix the same day found the other side of it: a request
   an admin set aside whole ended on nothing (ending() came back null, as for
   a cancel), so a member who had asked for it again, and followed it, was
   told ❌ "An admin cancelled it — it isn't coming". It ends on ⏭️ now, and
   its History row says "skipped". And the journal now counts each episode's
   outcome as it goes (test/tv-restart-recovery.test.mjs uses the count).

   The fixtures stand in for the heavy parts, as in
   test/send-retry-keeps-file.test.mjs: a download served from memory and a
   stub ffprobe that plans a plain copy. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';
import plugin from '../src/plugins/tv-requests/index.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-outcome-'));
const WORK = path.join(TMP, 'work');
fs.mkdirSync(WORK);
const FFPROBE = path.join(TMP, 'ffprobe');
fs.writeFileSync(FFPROBE, `#!/bin/sh
cat <<'JSON'
{"streams":[{"codec_type":"video","codec_name":"h264","width":1280,"height":720},{"codec_type":"audio","codec_name":"aac","channels":2}],"format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"60","size":"2048"}}
JSON
`, { mode: 0o755 });

// Free space as the bot will see it, whatever box runs this.
const realStatfs = fs.statfsSync;
fs.statfsSync = (p) => ({ ...realStatfs(p), bavail: Math.floor((50 * 1024 ** 3) / 4096), bsize: 4096 });
globalThis.fetch = async () => new Response(Buffer.alloc(2048, 1), { status: 200, headers: { 'content-length': '2048' } });

const TVREQ = 'tvreq@g.us';
const config = mergeDefaults({
  movieRequests: {
    notify: { group: 'notify@g.us' }, blockedRatings: [],
    reactions: {
      redo: '🔄', failed: '⚠️', cancelled: '❌', skipped: '⏭️', done: '✅',
      downloading: '⬇️', converting: '⚙️', sending: '⬆️',
    },
  },
  media: { workDir: WORK, ffprobePath: FFPROBE, ffmpegPath: '/bin/false', deleteAfterSend: true },
  tvRequests: { postsGroups: ['tvposts@g.us'] },
  whatsapp: { broadcastPacingMs: 0 },
}, DEFAULT_CONFIG);
config.library.jellyfin = { baseUrl: 'http://jf.test', accessToken: 'TOK' };

const log = { info() {}, warn() {}, error() {}, debug() {} };
const eps = [1, 2, 3].map((n) => ({ id: `boys-1-${n}`, series: 'The Boys', season: 1, episode: n, title: `Ep ${n}`, size: 2048 }));

/** WhatsApp whose uploads of the episodes named in `refuse` fail for good. */
function setUp({ refuse = [] } = {}) {
  const store = new Map();
  const notes = [];
  const followerReacts = [];
  const ctx = {
    config, log,
    store: { get: (k, d) => (store.has(k) ? store.get(k) : d), set: (k, v) => store.set(k, v) },
    queue: { pending: [], active: new Map(), add() { return 'q'; } },
    bot: {
      isConnected: () => true,
      sendText: async (jid, text) => { notes.push(text); return {}; },
      react: async (msg, emoji) => { followerReacts.push(`${msg.id} ${emoji}`); return true; },
      groups: () => [],
      groupMemberInfo: () => ({ isMember: false }),
      sendDocument: async (jid, file, { fileName }) => {
        // Not a dropped connection or anything else worth another try.
        if (refuse.some((n) => fileName.includes(`E0${n}`))) throw new Error('media file is too large for WhatsApp');
        return {};
      },
    },
  };
  const reacts = [];
  const react = async (e) => { reacts.push(e); };
  const reqKey = `tv-req-${Math.random().toString(16).slice(2, 8)}`;
  plugin._journalAdd(ctx, { reqKey, label: 'The Boys season 1 — 3 episode(s)', episodes: eps });
  const finished = [];
  const notifier = plugin._makeRequestNotifier(ctx, {
    label: 'The Boys season 1', total: eps.length, msg: { id: 'REQ', chatJid: TVREQ }, single: false, reqKey,
    onFinish: (r) => finished.push(r),
  });
  const job = ({ cancel = null } = {}) => ({
    id: `j${Math.random().toString(16).slice(2, 8)}`, signal: new AbortController().signal, progress() {},
    isCancelled: () => !!cancel, cancelReason: () => cancel,
  });
  const run = (i, opts) => plugin.deliverEpisode({
    ep: eps[i], ctx, job: job(opts), msg: { id: 'REQ', chatJid: TVREQ }, react, notifier, reqKey,
    isLast: i === eps.length - 1, index: i, total: eps.length,
  }).catch((err) => err);
  return { ctx, reacts, notes, followerReacts, notifier, finished, reqKey, run };
}

console.log('=== a season with a failed episode ends on ⚠️, not ✅ ===');
{
  const { reacts, notes, finished, run } = setUp({ refuse: [2] });
  ok(!(await run(0)), 'E01 is posted');
  ok(/too large/.test((await run(1))?.message ?? ''), 'E02 fails, and not in a way worth another try');
  ok(reacts.at(-1) === '⚠️', `E02's failure shows at once (${reacts.join(' ')})`);
  ok(!(await run(2)), 'E03 is posted');
  ok(reacts.at(-1) === '⚠️', `the message ends on ⚠️ - it used to end on E03's ✅ (${reacts.join(' ')})`);
  ok(!reacts.includes('✅'), 'and never shows ✅ at all');
  ok(finished[0]?.completed === 2 && finished[0]?.failed === 1, 'the request reports "2 of 3 posted, 1 failed"');
  ok(notes.some((n) => /^⚠️ The Boys season 1 — 2 of 3 posted, 1 failed/.test(n)), 'as the notifications group is told');
}

console.log('=== the journal counts how each episode ended, so a restart can ===');
{
  const { ctx, run, reqKey } = setUp({ refuse: [2] });
  await run(0);
  await run(1);
  const entry = (ctx.store.get('pending', []) ?? []).find((r) => r.reqKey === reqKey);
  ok(entry?.tally?.completed === 1 && entry.tally.failed === 1 && /too large/.test(entry.tally.why ?? ''),
    `E01 posted and E02 failed are on the journal entry (${JSON.stringify(entry?.tally)})`);
  ok(entry?.episodes?.map((e) => e.episode).join() === '3', 'with E03 the one left to do');
}

console.log('=== a clean season still ends on ✅ ===');
{
  const { reacts, run } = setUp();
  for (const i of [0, 1, 2]) await run(i);
  ok(reacts.filter((e) => e === '✅').length === 1 && reacts.at(-1) === '✅', `once, at the end (${reacts.join(' ')})`);
}

console.log('=== an admin skipping the last episode does not leave the message on ❌ or ⏭️ ===');
{
  const { ctx, reacts, followerReacts, finished, run, reqKey } = setUp();
  // Somebody asked for the same season while it waited, and follows it.
  plugin._addTvFollowers(ctx, { reqKey }, [{ msgId: 'FOLLOWER', msgKey: { id: 'FOLLOWER' }, chatJid: TVREQ, historyId: 'FOLLOWER', route: null }]);
  await run(0);
  await run(1);
  await run(2, { cancel: 'skipped' });
  ok(reacts.slice(-2).join(' ') === '⏭️ ✅', `⏭️ for the skipped episode, then ✅ for the request (${reacts.join(' ')})`);
  ok(!reacts.includes('❌'), 'no ❌ anywhere');
  ok(finished[0]?.completed === 2 && finished[0]?.cancelled === 1, 'History still says what happened: 2 of 3, 1 cancelled');
  await tick();
  ok(followerReacts.includes('FOLLOWER ✅') && !followerReacts.includes('FOLLOWER ❌'),
    `the request that followed it ends on ✅ too, not ❌ (${followerReacts.join(', ')})`);
}

console.log('=== skipped while waiting, after a failure: ⚠️ ===');
{
  const { ctx, reacts, notifier, reqKey, run } = setUp({ refuse: [1] });
  await run(0);                                              // fails for good
  await run(1);
  const discard = plugin._discarder(ctx, { reqKey, label: 'The Boys season 1', notifier, react: async (e) => { reacts.push(e); } });
  discard(eps[2])('skipped');                                // E03 skipped in the queue
  await tick();
  ok(reacts.slice(-2).join(' ') === '⏭️ ⚠️', `the skip concludes the request, which ends on ⚠️ (${reacts.join(' ')})`);
}

console.log('=== a request an admin set aside whole ends on ⏭️, and so does its follower ===');
{
  const { ctx, followerReacts, finished, notes } = setUp();
  const reacts = [];
  const reqKey = 'tv-one';
  plugin._journalAdd(ctx, { reqKey, label: 'The Boys S01E02', episodes: [eps[1]] });
  plugin._addTvFollowers(ctx, { reqKey }, [{ msgId: 'FOLLOWER', msgKey: { id: 'FOLLOWER' }, chatJid: TVREQ, historyId: 'FOLLOWER', route: null }]);
  const one = plugin._makeRequestNotifier(ctx, {
    label: 'The Boys S01E02', total: 1, msg: { id: 'REQ', chatJid: TVREQ }, single: true, reqKey,
    onFinish: (r) => finished.push(r),
  });
  // The request's react(), which skips the same emoji twice running, as on a real message.
  const react = plugin._sameTwiceSkipped(async (e) => { reacts.push(e); return true; });
  plugin._discarder(ctx, { reqKey, label: 'The Boys S01E02', notifier: one, react })(eps[1])('skipped');
  await tick();
  ok(one.ending() === '⏭️' && reacts.join(' ') === '⏭️', `the message shows ⏭️ and ends there (${reacts.join(' ')})`);
  ok(followerReacts.includes('FOLLOWER ⏭️') && !followerReacts.includes('FOLLOWER ❌'),
    `the request that followed it is told ⏭️, not ❌ "cancelled" (${followerReacts.join(', ')})`);
  ok(ctx.store.get('history', []).find((h) => h.id === 'FOLLOWER')?.status === 'skipped', "and its History row says skipped");
  ok(notes.some((n) => /^⏭️ The Boys S01E02 — 0 of 1 posted, 1 skipped/.test(n)), `as the notifications group is told (${notes.join(' | ')})`);
}

console.log('=== a season an admin cancels keeps its ❌ ===');
{
  const { ctx, reacts, notifier, reqKey, run } = setUp();
  await run(0);
  await run(1, { cancel: 'cancelled' });                     // the episode in hand is stopped
  const discard = plugin._discarder(ctx, { reqKey, label: 'The Boys season 1', notifier, react: async (e) => { reacts.push(e); } });
  discard(eps[2])('cancelled');                              // and the one waiting thrown away
  await tick();
  ok(notifier.isFinished() && reacts.at(-1) === '❌', `it ends on ❌ (${reacts.join(' ')})`);
  ok(!reacts.includes('✅'), 'with no ✅ for the one episode that was posted');
}

fs.statfsSync = realStatfs;
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
