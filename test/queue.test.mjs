/* Queue reorder, skip, cancel. Run: node test/queue.test.mjs */
import { JobQueue } from '../src/core/queue.js';
let pass=0,fail=0;
const ok=(c,m)=>{c?(pass++,console.log(`  ok   ${m}`)):(fail++,console.log(`  FAIL ${m}`));};
const never=()=>new Promise(()=>{});   // a job that never finishes, to hold the slot

console.log('=== reorder waiting jobs ===');
{
  const q=new JobQueue({concurrency:1});
  q.add({label:'running', run:never});     // occupies the single slot
  const b=q.add({label:'B', run:never});
  const c=q.add({label:'C', run:never});
  const d=q.add({label:'D', run:never});
  const pend=()=>q.snapshot().pending.map(e=>e.label).join(',');
  ok(pend()==='B,C,D','initial waiting order');
  q.move(d,'up');   ok(pend()==='B,D,C','move D up');
  q.move(b,'down'); ok(pend()==='D,B,C','move B down');
  q.moveTop(c);     ok(pend()==='C,D,B','move C to top');
  ok(q.move(c,'up')===false,'cannot move the first item up');
  ok(q.move('nope','up')===false,'unknown id is a no-op');
}

console.log('=== skip vs cancel on a waiting job ===');
{
  const q=new JobQueue({concurrency:1});
  q.add({label:'running', run:never});
  const b=q.add({label:'B', run:never});
  ok(q.skip(b)===true,'skip a waiting job');
  ok(q.snapshot().pending.length===0,'it left the queue');
  const hist=q.snapshot().history;
  ok(hist[0].state==='skipped','recorded as skipped, not cancelled');
}

console.log('=== clearPending empties the wait list only ===');
{
  const q=new JobQueue({concurrency:1});
  q.add({label:'running', run:never});
  q.add({label:'B', run:never});
  q.add({label:'C', run:never});
  const n=q.clearPending();
  ok(n===2,'cleared 2 waiting');
  ok(q.active.size===1,'the running job is untouched');
}

console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
