/* Live queue-position reaction logic. Run: node test/reactions.test.mjs */
import plugin from '../src/plugins/movie-requests/index.js';
let pass=0,fail=0;
const ok=(c,m)=>{c?(pass++,console.log(`  ok   ${m}`)):(fail++,console.log(`  FAIL ${m}`));};

const cfg = { reactions: {
  positions:['1️⃣','2️⃣','3️⃣'], positionOverflow:'🔢', added:'🎬',
}};

console.log('=== position emoji ===');
ok(plugin._positionEmoji(cfg,1)==='1️⃣','position 1 -> 1️⃣');
ok(plugin._positionEmoji(cfg,3)==='3️⃣','position 3 -> 3️⃣');
ok(plugin._positionEmoji(cfg,4)==='🔢','position 4 (past list) -> overflow');
ok(plugin._positionEmoji({reactions:{}},2)==='⏳','no config -> hourglass fallback');

console.log('=== updatePositions reacts + prunes ===');
{
  const reacted=[];
  const pending=[{id:'a'},{id:'b'},{id:'c'}];
  const active=[{id:'x'}];
  const ctx={
    config:{movieRequests:cfg},
    queue:{snapshot:()=>({pending,active,history:[]})},
    // Returns true, as the real react() does. The dedupe guard is now keyed on
    // the ANSWER rather than on having asked, so a fake that returns undefined
    // reads as "shed" and correctly records nothing.
    bot:{react:async(msg,e)=>{reacted.push(msg.tag+':'+e);return true;}},
  };
  plugin._reactors=new Map([
    ['a',{msg:{tag:'A'},lastEmoji:null}],
    ['b',{msg:{tag:'B'},lastEmoji:null}],
    ['c',{msg:{tag:'C'},lastEmoji:null}],
    ['gone',{msg:{tag:'G'},lastEmoji:'9️⃣'}],   // no longer in queue -> pruned
  ]);
  plugin._updatePositions(ctx);
  // lastEmoji is now recorded only once the send comes back, so let the
  // reaction promises settle before reading it.
  await new Promise((r)=>setTimeout(r,10));
  ok(reacted.includes('A:1️⃣')&&reacted.includes('B:2️⃣')&&reacted.includes('C:3️⃣'),'each pending reacts its position');
  ok(!plugin._reactors.has('gone'),'a job that left the queue is pruned');
  ok(plugin._reactors.get('a').lastEmoji==='1️⃣','lastEmoji recorded');

  // second call: nothing changed -> no new reactions
  reacted.length=0;
  plugin._updatePositions(ctx);
  await new Promise((r)=>setTimeout(r,10));
  ok(reacted.length===0,'no re-react when positions unchanged');

  // b completes, c shifts up
  pending.shift();  // remove 'a' (now running)
  plugin._reactors.get('a').lastEmoji='done'; // pretend a is active now
  active.push({id:'a'});
  reacted.length=0;
  plugin._updatePositions(ctx);
  ok(reacted.includes('B:1️⃣')&&reacted.includes('C:2️⃣'),'remaining jobs move up a place');
}

console.log('=== a SHED position reaction must not be recorded as shown ===');
{
  // The bug: lastEmoji was set before the send. When the outbound budget sheds
  // a position update the requester never sees that number, but the guard
  // believed they had - so it suppressed that position for good and their
  // place appeared frozen. An optimistically recorded side effect turns a
  // dropped action into a permanent lie.
  const cfg={reactions:{positions:['1\u20e3','2\u20e3','3\u20e3'],positionOverflow:'\ud83d\udd22'}};
  const tried=[];
  const ctx={
    config:{movieRequests:cfg},
    queue:{snapshot:()=>({pending:[{id:'a'}],active:[],history:[]})},
    bot:{react:async(msg,e)=>{tried.push(e);return false;}},   // budget sheds it
  };
  const r={msg:{tag:'A'},lastEmoji:null};
  plugin._reactors=new Map([['a',r]]);
  plugin._updatePositions(ctx);
  await new Promise((res)=>setTimeout(res,10));
  ok(tried.length===1,'the reaction was attempted');
  ok(r.lastEmoji===null,'but nothing was recorded, so the next pass will try again');

  // and once it does go through, it IS recorded
  ctx.bot.react=async(msg,e)=>{tried.push(e);return true;};
  plugin._updatePositions(ctx);
  await new Promise((res)=>setTimeout(res,10));
  ok(r.lastEmoji==='1\u20e3',`recorded once actually sent (${r.lastEmoji})`);
}

console.log(`\n${'='.repeat(46)}\n  ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
