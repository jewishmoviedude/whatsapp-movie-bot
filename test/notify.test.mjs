/* Group membership + @mention resolution (LID-aware). Run: node test/notify.test.mjs */
import { WhatsAppBot } from '../src/core/bot.js';
let pass=0,fail=0;
const ok=(c,m)=>{c?(pass++,console.log(`  ok   ${m}`)):(fail++,console.log(`  FAIL ${m}`));};

const bot = new WhatsAppBot({ configStore: { get: () => ({ whatsapp:{} }) }, dataDir: '/tmp' });
// Seed a group cache like refreshGroups would build it.
bot.groupCache.set('notify@g.us', {
  jid:'notify@g.us', subject:'Notifications',
  memberIds: new Set(['111222333@lid', '17185551234@s.whatsapp.net']),
  memberNumbers: new Set(['17185551234', '19995550000']),
});

console.log('=== membership by phone number ===');
{
  const r = bot.groupMemberInfo('notify@g.us', { number:'17185551234', jid:'999@lid' });
  ok(r.isMember,'member matched by phone number');
  ok(r.mentionJid==='17185551234@s.whatsapp.net','mentions the phone JID for a clean @number tag');
  ok(r.mentionText==='17185551234','mention text is the bare number');
}

console.log('=== membership by LID (number not in the roster) ===');
{
  const r = bot.groupMemberInfo('notify@g.us', { number:'15550009999', jid:'111222333@lid' });
  ok(r.isMember,'member matched by LID even when the number is not listed');
}

console.log('=== membership by phoneNumber-derived roster entry ===');
{
  const r = bot.groupMemberInfo('notify@g.us', { number:'19995550000', jid:'abc@lid' });
  ok(r.isMember,'member matched by a number derived from participant metadata');
}

console.log('=== non-member -> no tag ===');
{
  const r = bot.groupMemberInfo('notify@g.us', { number:'14045551111', jid:'nomatch@lid' });
  ok(!r.isMember,'not a member');
  ok(r.mentionJid==='14045551111@s.whatsapp.net','still returns a mention JID (unused when not a member)');
}

console.log('=== unknown group -> not a member ===');
ok(bot.groupMemberInfo('missing@g.us',{number:'17185551234'}).isMember===false,'unknown group is never a member');

console.log('=== groups() does not leak internal Sets to the UI ===');
{
  const g = bot.groups().find((x)=>x.jid==='notify@g.us');
  ok(g && !('memberIds' in g) && !('memberNumbers' in g),'memberIds/memberNumbers stripped from public view');
}

console.log('=== _notify honors the no-tag opt-out ===');
{
  const plugin = (await import('../src/plugins/movie-requests/index.js')).default;
  function ctxWith(noTag) {
    const sent = [];
    return { sent, ctx: {
      config: { movieRequests: { notify: { group: 'n@g.us', tagRequester: true, steps: {}, noTag } } },
      bot: {
        isConnected: () => true,
        groupMemberInfo: () => ({ isMember: true, mentionJid: '15551234567@s.whatsapp.net', mentionText: '15551234567' }),
        sendText: async (jid, body, opts) => sent.push({ body, mentions: opts?.mentions ?? null }),
      },
      log: { info(){}, warn(){} },
    }};
  }
  const record = { requesterNumber: '15551234567', requesterJid: 'x@lid' };

  let w = ctxWith([]);
  await plugin._notify(w.ctx, 'done', 'Movie — posted', record);
  ok(w.sent[0].mentions && w.sent[0].body.startsWith('@15551234567'), 'member with empty no-tag list IS tagged');

  w = ctxWith(['15551234567']);
  await plugin._notify(w.ctx, 'done', 'Movie — posted', record);
  ok(!w.sent[0].mentions && !w.sent[0].body.startsWith('@'), 'muted number is NOT tagged (plain message)');
  ok(w.sent[0].body === 'Movie — posted', 'muted still receives the update, just no ping');

  w = ctxWith(['+1 (555) 123-4567']);   // formatted entry still matches
  await plugin._notify(w.ctx, 'done', 'Movie — posted', record);
  ok(!w.sent[0].mentions, 'formatted no-tag entry normalizes and matches');

  w = ctxWith(['19998887777']);          // different number not muted
  await plugin._notify(w.ctx, 'done', 'Movie — posted', record);
  ok(!!w.sent[0].mentions, 'a different muted number does not affect this requester');
}

console.log(`\n${'='.repeat(50)}\n  ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
