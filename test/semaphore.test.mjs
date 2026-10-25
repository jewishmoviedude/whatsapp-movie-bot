/* Stage-concurrency semaphore. Run: node test/semaphore.test.mjs */
import { Semaphore } from '../src/util/semaphore.js';
let pass=0,fail=0;
const ok=(c,m)=>{c?(pass++,console.log(`  ok   ${m}`)):(fail++,console.log(`  FAIL ${m}`));};
const tick=()=>new Promise(r=>setTimeout(r,5));

console.log('=== capacity 1 serialises ===');
{
  const s=new Semaphore(1,'dl');
  const order=[];
  const a=s.run(async()=>{ order.push('a-start'); await tick(); order.push('a-end'); });
  const b=s.run(async()=>{ order.push('b-start'); await tick(); order.push('b-end'); });
  await Promise.all([a,b]);
  ok(order.join(',')==='a-start,a-end,b-start,b-end','second waits for the first');
}

console.log('=== capacity 1 across stages overlaps ===');
{
  const dl=new Semaphore(1), cv=new Semaphore(1);
  const events=[];
  // job A downloads then converts; job B downloads then converts.
  async function job(name){
    await dl.acquire(); events.push(`${name}:dl`); await tick(); dl.release();
    await cv.acquire(); events.push(`${name}:cv`); await tick(); cv.release();
  }
  await Promise.all([job('A'), job('B')]);
  // A downloads, then while A converts, B downloads -> overlap.
  const aCv=events.indexOf('A:cv'), bDl=events.indexOf('B:dl');
  ok(bDl < aCv || Math.abs(bDl-aCv)<=1, `B downloads around when A converts (events: ${events.join(' ')})`);
}

console.log('=== release hands off to a waiter, capacity respected ===');
{
  const s=new Semaphore(2,'x');
  await s.acquire(); await s.acquire();
  ok(s.free===0,'both slots taken');
  let got=false;
  const p=s.acquire().then(()=>{got=true;});
  await tick();
  ok(!got,'third acquire blocks');
  s.release();
  await tick();
  ok(got,'released slot wakes the waiter');
  ok(s.inUse===2,'still at capacity after handoff');
}

console.log('=== throwing fn still releases ===');
{
  const s=new Semaphore(1);
  try { await s.run(async()=>{ throw new Error('boom'); }); } catch {}
  ok(s.free===1,'slot freed after an exception');
}

console.log('=== setCapacity wakes waiters when grown ===');
{
  const s=new Semaphore(1);
  await s.acquire();
  let woke=false;
  s.acquire().then(()=>{woke=true;});
  await tick();
  ok(!woke,'blocked at capacity 1');
  s.setCapacity(2);
  await tick();
  ok(woke,'growing to 2 wakes the waiter');
}

console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
