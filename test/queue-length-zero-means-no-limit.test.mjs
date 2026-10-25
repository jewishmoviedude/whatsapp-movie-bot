/* Max queue length 0 is no limit, as every other limit in the panel reads 0.
   Run: node test/queue-length-zero-means-no-limit.test.mjs

   The operator set it to 0 on 2026-10-12 (21:00 UTC) and exported the
   request rules to make them the defaults. The queue read 0 as no room at
   all: hasRoom() was false and add() threw "Queue is full (0 waiting)" for
   every member's request, film or TV. */
import { JobQueue } from '../src/core/queue.js';
import tvPlugin from '../src/plugins/tv-requests/index.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const job = (i, extra = {}) => ({ label: `Film ${i}`, kind: 'movie', run: async () => {}, meta: { memberKey: `m${i}` }, ...extra });

console.log('=== 0: no limit ===');
{
  const q = new JobQueue({ concurrency: 1, maxLength: 0 });
  q.pause();
  ok(q.hasRoom(), 'an empty queue has room');
  let refused = null;
  try { for (let i = 0; i < 120; i++) q.add(job(i)); } catch (err) { refused = err; }
  ok(!refused, `120 requests all go in (${refused?.message ?? 'none refused'})`);
  ok(q.waitingCount() === 120 && q.hasRoom(5), 'and there is still room');
}

console.log('=== a limit set still holds ===');
{
  const q = new JobQueue({ concurrency: 1, maxLength: 2 });
  q.pause();
  q.add(job(1)); q.add(job(2));
  ok(!q.hasRoom(), 'two waiting of two: no room');
  let refused = null;
  try { q.add(job(3)); } catch (err) { refused = err; }
  ok(refused?.code === 'QUEUE_FULL' && /Queue is full \(2 waiting\)/.test(refused.message), 'the third is refused as before');
  let past = null;
  try { past = q.add(job(4), { overLimit: true }); } catch { /* nothing */ }
  ok(past != null, "an admin's own add still goes past it");
}

console.log('=== changed on the fly, as the panel does ===');
{
  const q = new JobQueue({ concurrency: 1, maxLength: 1 });
  q.pause();
  q.add(job(1));
  ok(!q.hasRoom(), 'full at 1');
  q.maxLength = 0;
  ok(q.hasRoom(), 'set to 0 in the panel: room at once');
}

console.log('=== the TV plugin, with a queue that has no hasRoom() ===');
{
  const ctx = { queue: { pending: new Array(80).fill({}), maxLength: 0 } };
  ok(tvPlugin._hasRoom.call(tvPlugin, ctx) === true, '0 is no limit there too');
  ctx.queue.maxLength = 50;
  ok(tvPlugin._hasRoom.call(tvPlugin, ctx) === false, 'and 50 is still 50');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
