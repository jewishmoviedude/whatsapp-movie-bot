/* One set of notifications per TV REQUEST, not per episode.
   Run: node test/tv-notify.test.mjs

   A 10-episode season previously produced ~40 notification messages
   (downloading/converting/sending/posted, repeated for every episode). */
import plugin from '../src/plugins/tv-requests/index.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

function ctxFor() {
  const sent = [];
  return {
    sent,
    ctx: {
      config: {
        tvRequests: { enabled: true },
        movieRequests: {
          notify: { group: 'notif@g.us' },
          reactions: { downloading: '⬇️', converting: '⚙️', sending: '⬆️', done: '✅', failed: '⚠️' },
        },
      },
      bot: { isConnected: () => true, sendText: async (jid, t) => { sent.push(t); return {}; } },
      log: { info() {}, warn() {}, error() {}, debug() {} },
    },
  };
}

console.log('=== a whole season reports each step ONCE ===');
{
  const { ctx, sent } = ctxFor();
  const n = plugin._makeRequestNotifier(ctx, { label: 'Rick and Morty season 4', total: 10, msg: null, single: false });

  // every episode walks the same stages
  for (let i = 0; i < 10; i++) {
    n.stage('download', '⬇️', 'downloading');
    n.stage('convert', '⚙️', 'converting');
    n.stage('send', '⬆️', 'sending');
  }
  ok(sent.length === 3, `three stage messages for ten episodes, not thirty (got ${sent.length})`);
  ok(sent[0].includes('⬇️') && /downloading/.test(sent[0]), 'downloading announced once');
  ok(sent[1].includes('⚙️'), 'converting announced once');
  ok(sent[2].includes('⬆️'), 'sending announced once');
  ok(sent[0].includes('10 episodes'), 'the season message says how many episodes');
  ok(sent[0].includes('Rick and Morty season 4'), 'and names the request, not one episode');

  // only the LAST episode reports the finish
  for (let i = 0; i < 9; i++) n.episodeDone();
  ok(sent.length === 3, 'nine finished episodes produce no message');
  n.episodeDone();
  ok(sent.length === 4, 'the tenth produces exactly one');
  ok(/all 10 episodes posted/.test(sent[3]), `the finish reports the whole season: "${sent[3]}"`);
}

console.log('=== a single episode behaves exactly as before ===');
{
  const { ctx, sent } = ctxFor();
  const n = plugin._makeRequestNotifier(ctx, { label: 'Rick and Morty S04E01', total: 1, msg: null, single: true });
  n.stage('download', '⬇️', 'downloading');
  n.stage('send', '⬆️', 'sending');
  n.episodeDone();
  ok(sent.length === 3, 'one message per step');
  ok(!sent[0].includes('episodes'), 'no "(N episodes)" suffix for a single episode');
  ok(/posted!/.test(sent[2]) && !/all 1 episodes/.test(sent[2]), `finish reads naturally: "${sent[2]}"`);
}

console.log('=== partial failures are reported honestly, once ===');
{
  const { ctx, sent } = ctxFor();
  const n = plugin._makeRequestNotifier(ctx, { label: 'The Boys season 1', total: 3, msg: null, single: false });
  n.episodeDone();
  n.episodeFailed('download failed');
  ok(sent.length === 0, 'nothing reported while the request is still running');
  n.episodeDone();
  ok(sent.length === 1, 'exactly one message when the request finishes');
  ok(/2 of 3 posted, 1 failed/.test(sent[0]), `it states what actually happened: "${sent[0]}"`);
  ok(!sent[0].startsWith('✅'), 'a partial failure is NOT reported with a tick');
  ok(sent[0].startsWith('⚠️'), 'it uses the warning glyph instead');
}
{
  // every episode failing still reports once
  const { ctx, sent } = ctxFor();
  const n = plugin._makeRequestNotifier(ctx, { label: 'X season 1', total: 2, msg: null, single: false });
  n.episodeFailed('a'); n.episodeFailed('b');
  ok(sent.length === 1 && /0 of 2 posted, 2 failed/.test(sent[0]), 'a total failure is reported once');
}
{
  // a single episode failing says why, immediately
  const { ctx, sent } = ctxFor();
  const n = plugin._makeRequestNotifier(ctx, { label: 'X S01E01', total: 1, msg: null, single: true });
  n.episodeFailed('HTTP 404 Not Found');
  ok(sent.length === 1 && /404/.test(sent[0]), 'a single-episode failure reports the actual reason');
}

console.log('=== the delivery path uses the shared notifier ===');
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/plugins/tv-requests/index.js', import.meta.url), 'utf8');
  ok(/notifier\?\.stage\('download'/.test(src), 'download announces through the notifier');
  ok(/notifier\?\.stage\('convert'/.test(src), 'convert too');
  ok(/notifier\?\.stage\('send'/.test(src), 'send too');
  ok(/notifier\?\.episodeDone\(\)/.test(src), 'completion goes through the notifier');
  ok(!/_notify\(ctx, `\$\{R\.downloading/.test(src), 'no per-episode downloading message remains');
  ok(!/posted! \(\$\{index \+ 1\}\/\$\{total\}\)/.test(src), 'no per-episode "posted (3/10)" message remains');
  // Every entry point must build one: the group request, the portal, and
  // recovery after a restart - a resumed season reports its own progress
  // rather than inheriting a notifier that died with the last process.
  ok((src.match(/this\._makeRequestNotifier\(ctx, \{/g) ?? []).length === 3,
    'the group-request, portal and restart-recovery paths each create a notifier');
}

console.log('=== a cancelled episode must not strand the request on "queued" ===');
{
  // Real bug: the cancelled branch returned without reporting, so
  // completed+failed never reached the total, onFinish never fired, and three
  // real seasons sat at "queued" for ever with an empty queue.
  const { ctx, sent } = ctxFor();
  let finish = null;
  const n = plugin._makeRequestNotifier(ctx, {
    label: 'Prison Break season 2', total: 3, msg: null, single: false,
    onFinish: (r) => { finish = r; },
  });
  n.episodeDone();
  n.episodeCancelled();
  ok(finish === null, 'still open while episodes remain');
  n.episodeCancelled();
  ok(finish !== null, 'the request CONCLUDES once every episode reported, cancellations included');
  ok(finish.completed === 1 && finish.cancelled === 2, 'the counts are right');
  ok(/1 of 3 posted, 2 cancelled/.test(sent[0]), `and it says so: "${sent[0]}"`);
  ok(sent.length === 1, 'reported exactly once');
}
{
  // a fully cancelled request concludes too
  const { ctx, sent } = ctxFor();
  let finish = null;
  const n = plugin._makeRequestNotifier(ctx, { label: 'X season 1', total: 2, msg: null, single: false, onFinish: (r) => { finish = r; } });
  n.episodeCancelled(); n.episodeCancelled();
  ok(finish?.cancelled === 2 && finish.completed === 0, 'all-cancelled still concludes');
  ok(!sent[0].startsWith('✅'), 'and is not reported as a success');
}
{
  // mixed outcomes all add up
  const { ctx, sent } = ctxFor();
  let finish = null;
  const n = plugin._makeRequestNotifier(ctx, { label: 'Mixed season 1', total: 4, msg: null, single: false, onFinish: (r) => { finish = r; } });
  n.episodeDone(); n.episodeFailed('boom'); n.episodeCancelled(); n.episodeDone();
  ok(finish.completed === 2 && finish.failed === 1 && finish.cancelled === 1, 'every outcome counted');
  ok(finish.completed + finish.failed + finish.cancelled === 4, 'they add up to the total — nothing unexplained');
  ok(sent.length === 1, 'still a single report');
}
{
  // and it never double-reports
  const { ctx, sent } = ctxFor();
  const n = plugin._makeRequestNotifier(ctx, { label: 'Y season 1', total: 1, msg: null, single: false });
  n.episodeDone();
  n.episodeDone();
  ok(sent.length === 1, 'a stray extra report cannot fire the finish twice');
}

console.log('=== the delivery path reports cancellations ===');
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/plugins/tv-requests/index.js', import.meta.url), 'utf8');
  ok(/notifier\?\.episodeCancelled\(\)/.test(src), 'the cancelled branch reports back');
  const block = src.match(/if \(!interrupted && \(err\.code === 'CANCELLED'[^\n]*\{[\s\S]*?\n      \}/)[0];
  ok(/episodeCancelled/.test(block), 'inside the cancellation branch itself');
  ok(/status: \(failed === 0 && cancelled === 0\) \? 'sent'/.test(src), 'history is only "sent" on a clean sweep');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
