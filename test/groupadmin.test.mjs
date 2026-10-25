/* Group-admin: number parsing, JID conversion, event capture. Run: node test/groupadmin.test.mjs */
import { WhatsAppBot } from '../src/core/bot.js';
let pass=0,fail=0;
const ok=(c,m)=>{c?(pass++,console.log(`  ok   ${m}`)):(fail++,console.log(`  FAIL ${m}`));};
const bot = new WhatsAppBot({ configStore:{ get:()=>({whatsapp:{}}) }, dataDir:'/tmp' });

console.log('=== numberFromJid ===');
ok(bot.numberFromJid('17185551234@s.whatsapp.net')==='17185551234','phone JID -> number');
ok(bot.numberFromJid('17185551234:12@s.whatsapp.net')==='17185551234','strips device suffix');
ok(bot.numberFromJid('111222333@lid')===null,'@lid -> null (not a phone number)');
ok(bot.numberFromJid('bad')===null,'garbage -> null');

console.log('=== modifyParticipants converts + chunks + paces ===');
{
  const calls=[];
  bot.sock = { groupParticipantsUpdate: async (jid, jids, action)=>{ calls.push({jids,action}); return jids.map(j=>({jid:j,status:'200'})); } };
  bot.state='connected';
  bot.refreshGroups = async()=>[];  // stub
  // 7 numbers -> 2 chunks of 5 + 2
  const nums=['15551112222','16172223333','+1 (818) 333-4444','19994445555','12105556666','13106667777','14087778888'];
  const res = await bot.modifyParticipants('g@g.us', nums, 'remove');
  ok(calls.length===2,`chunked into ${calls.length} calls (5 + 2)`);
  ok(calls[0].jids.every(j=>j.endsWith('@s.whatsapp.net')),'plain numbers -> phone JIDs');
  ok(calls[0].jids.includes('18183334444@s.whatsapp.net'),'formatted number "+1 (818) 333-4444" normalized');
  ok(res.length===7,'returns a result per target');
  ok(calls[0].action==='remove','action passed through');

  // a full JID passes through untouched
  calls.length=0;
  await bot.modifyParticipants('g@g.us', ['999@lid'], 'promote');
  ok(calls[0].jids[0]==='999@lid','existing JID passed through unchanged');

  // invalid action rejected
  let threw=false;
  try { await bot.modifyParticipants('g@g.us',['1'],'nuke'); } catch { threw=true; }
  ok(threw,'invalid action rejected');
}

console.log('=== group-event emitted from participant updates ===');
{
  const events=[];
  bot.on('group-event', (e)=>events.push(e));
  bot.groupCache.set('g@g.us',{subject:'Test Group'});
  // simulate the handler body directly (the socket wiring is in start())
  const u={ id:'g@g.us', action:'remove', author:'17180001111@s.whatsapp.net', participants:['15559998888@s.whatsapp.net'] };
  bot.emit('group-event',{
    ts:Date.now(), groupJid:u.id, groupName:bot.groupCache.get(u.id)?.subject??u.id,
    action:u.action, actor:u.author, actorNumber:bot.numberFromJid(u.author),
    targets:u.participants.map(pj=>({jid:pj,number:bot.numberFromJid(pj)})),
  });
  const e=events[0];
  ok(e && e.action==='remove','event action');
  ok(e.groupName==='Test Group','group name resolved from cache');
  ok(e.actorNumber==='17180001111','actor number extracted');
  ok(e.targets[0].number==='15559998888','target number extracted');
}

console.log('=== setAllGroupsLocked paces + reports per group ===');
{
  const calls=[];
  bot.sock={ groupSettingUpdate: async(jid,setting)=>{ calls.push({jid,setting}); if(jid==='bad@g.us') throw new Error('not-authorized'); } };
  bot.state='connected';
  bot.groupCache=new Map([['a@g.us',{jid:'a@g.us',subject:'A'}],['bad@g.us',{jid:'bad@g.us',subject:'B'}]]);
  bot.groups=()=>[...bot.groupCache.values()];
  const res=await bot.setAllGroupsLocked(true);
  ok(calls.every(c=>c.setting==='announcement'),'lock sends announcement setting');
  ok(res.find(r=>r.jid==='a@g.us').ok,'admin group locked');
  ok(/not an admin/.test(res.find(r=>r.jid==='bad@g.us').error),'non-admin group reports that the bot is not an admin there');
}

console.log('=== unlock skips always-locked groups ===');
{
  const calls=[];
  bot.configStore={ get:()=>({ whatsapp:{}, lockdown:{ alwaysLocked:['keep@g.us'] } }) };
  bot.sock={ groupSettingUpdate: async(jid,setting)=>{ calls.push({jid,setting}); } };
  bot.state='connected';
  bot.groupCache=new Map([['open@g.us',{jid:'open@g.us',subject:'Open'}],['keep@g.us',{jid:'keep@g.us',subject:'Keep locked'}]]);
  bot.groups=()=>[...bot.groupCache.values()];
  const res=await bot.setAllGroupsLocked(false);   // unlock all
  ok(calls.length===1 && calls[0].jid==='open@g.us','only the normal group is unlocked');
  ok(res.find(r=>r.jid==='keep@g.us').skipped==='always locked','always-locked group is skipped on unlock');
  // but LOCK still touches everything
  calls.length=0;
  await bot.setAllGroupsLocked(true);
  ok(calls.length===2,'lock still applies to every group');
}

console.log('=== banFromAllGroups only touches groups the number is in ===');
{
  const removed=[];
  bot.sock={ groupParticipantsUpdate: async(jid,jids,action)=>{ removed.push({jid,action}); return jids.map(j=>({jid:j,status:'200'})); } };
  bot.refreshGroups=async()=>[];
  bot.groupCache=new Map([
    ['g1@g.us',{jid:'g1@g.us',subject:'G1',memberIds:new Set(),memberNumbers:new Set(['15551234567'])}],
    ['g2@g.us',{jid:'g2@g.us',subject:'G2',memberIds:new Set(),memberNumbers:new Set(['19998887777'])}],
  ]);
  bot.groups=()=>[...bot.groupCache.values()];
  const res=await bot.banFromAllGroups('15551234567');
  ok(res.length===1 && res[0].jid==='g1@g.us','removed only from the group they were in');
  ok(removed.length===1 && removed[0].action==='remove','one remove call, not on the other group');
}

console.log(`\n${'='.repeat(50)}\n  ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
