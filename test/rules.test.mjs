/* #rules PM command. Run: node test/rules.test.mjs */
import fs from 'node:fs';
import plugin from '../src/plugins/movie-requests/index.js';
let pass=0,fail=0; const ok=(c,m)=>{c?(pass++,console.log('  ok   '+m)):(fail++,console.log('  FAIL '+m));};

function mock(rules='*RULES* text', cmd='#rules', extra={}) {
  const sent=[]; const deleted=[];
  const ctx={
    config:{ movieRequests:{ groupRules:true, rules, rulesCommand:cmd, requestGroups:[], cooldownSecondsPerUser:0, reactions:{}, ...extra } },
    bot:{ sendText: async(jid,text,opts)=>sent.push({jid,text}), react:async()=>{}, deleteChat: async(jid)=>deleted.push(jid) },
    log:{ info(){}, warn(){} }, store:{ get:()=>0, set(){}, push(){} },
  };
  return { ctx, sent, deleted };
}

console.log('=== #rules in a PM is no longer answered ===');
{
  // The PM route is deliberately gone. It existed to serve text that now lives
  // in content/rules/, and it needed a wa.me link with a hard-coded phone
  // number in fifteen descriptions - so every number switch broke all fifteen.
  const {ctx,sent}=mock();
  await plugin.onMessage({ text:'#rules', isGroup:false, chatJid:'u@s.whatsapp.net', senderJid:'u@s.whatsapp.net', fromMe:false, key:{} }, ctx);
  ok(sent.length===0,'a DM asking for the rules gets no reply');
}
console.log('=== case-insensitive + trims, IN A GROUP ===');
{
  const {ctx,sent}=mock();
  await plugin.onMessage({ text:'  #RULES  ', isGroup:true, chatJid:'g@g.us', senderJid:'u', fromMe:false, key:{} }, ctx);
  ok(sent.length===1,'" #RULES " (caps/space) still triggers in a group');
}
console.log('=== custom command ===');
{
  const {ctx,sent}=mock('r', '!rules');
  await plugin.onMessage({ text:'!rules', isGroup:true, chatJid:'g@g.us', senderJid:'u', fromMe:false, key:{} }, ctx);
  ok(sent.length===1,'honors a custom rulesCommand');
}
console.log('=== does NOT fire on other text / from the bot ===');
{
  const {ctx,sent}=mock();
  await plugin.onMessage({ text:'hello', isGroup:false, chatJid:'u', senderJid:'u', fromMe:false, key:{} }, ctx);
  ok(sent.length===0,'ordinary DM text does nothing');
  await plugin.onMessage({ text:'#rules', isGroup:false, chatJid:'u', senderJid:'u', fromMe:true, key:{} }, ctx);
  ok(sent.length===0,"ignores messages from the bot itself");
}
console.log('=== empty rules -> nothing sent ===');
{
  const {ctx,sent}=mock('');
  await plugin.onMessage({ text:'#rules', isGroup:false, chatJid:'u', senderJid:'u', fromMe:false, key:{} }, ctx);
  ok(sent.length===0,'no rules configured -> silent');
}
console.log('=== the PM route is gone, and so is its housekeeping ===');
{
  // Rules are group-only now, and a group chat is never deleted - so the
  // "tidy the PM afterwards" branch can no longer be reached. Leaving it in
  // would be dead code guarding a case that cannot happen.
  const src = fs.readFileSync(new URL('../src/plugins/movie-requests/index.js', import.meta.url), 'utf8');
  ok(!/deleteChatAfterRules/.test(src), 'the unreachable PM cleanup is removed');
  ok(/rules are only answered in groups now/.test(src), 'and the reason is recorded where it was');
}

console.log('=== does NOT delete a GROUP chat ===');
{
  const {ctx,sent,deleted}=mock();
  await plugin.onMessage({ text:'#rules', isGroup:true, chatJid:'g@g.us', senderJid:'u', fromMe:false, key:{id:'k'}, raw:{} }, ctx);
  ok(sent.length===1 && deleted.length===0,'group #rules sends but does not delete the group');
}

console.log('=== nothing still advertises the PM route ===');
{
  /* The code stopped answering PMs, but the portal kept telling operators the
     rules were "sent to anyone who PMs the bot with the command below". A
     label describing a route that got the number flagged is worse than no
     label: it invites somebody to send people down it. */
  const fs = await import('node:fs');
  const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
  ok(!/sent to anyone who pms the bot/i.test(html), 'the portal no longer advertises PMing the bot');
  ok(/in groups only/i.test(html), 'and says where the rules ARE answered');
  ok(/flagged/i.test(html), 'with the reason, so nobody helpfully restores it');

  // Nothing the bot SENDS may point at a PM route either - a message telling
  // people to PM produces exactly the inbound traffic that got it flagged,
  // and now goes unanswered on top.
  for (const f of ['../src/plugins/movie-requests/enforcement.js', '../src/plugins/movie-requests/rules.js']) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    const strings = src.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'));
    ok(!/wa\.me/.test(strings.join('\n')), `${f.split('/').pop()} builds no wa.me link`);
  }
}
console.log('\n'+'='.repeat(46)+'\n  '+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);

console.log('=== the group rules command is off by default (the operator, 2026-10-22) ===');
{
  const r = rulesReplyFor({ rules: 'x', ruleSets: [{ command: '#rules-movies', text: 'MOVIE rules', label: 'movies' }] }, { text: '#rules', isGroup: true, chatJid: 'g@g.us' });
  ok(r === null, '#rules in a group gets no answer when groupRules is off');
  ok(rulesReplyFor({ groupRules: true, rules: 'x' }, { text: '#rules', isGroup: true, chatJid: 'g@g.us' })?.text === 'x', 'and answers once it is turned on');
}
