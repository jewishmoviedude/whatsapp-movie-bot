/* A request its sender deleted is not answered.
   Run: node test/deleted-request.test.mjs

   2026-10-09 08:08 UTC: Ari (+1555***0178) sent "#request friren:beyond
   journeys end", deleted it six seconds later and sent it again with "s1".
   The bot went on with the deleted one and asked "which season?" at 08:09:02,
   quoting a message the group no longer had, under the one that said s1; the
   operator: "he literally wrote s1". bot.js now notes each delete and drops a
   reaction on, or a reply quoting, a deleted message. */
import { WhatsAppBot } from '../src/core/bot.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const GROUP = '120363900000000003@g.us';
const bot = new WhatsAppBot({ configStore: { get: () => ({ whatsapp: { autoReconnect: false } }) }, dataDir: '/tmp/deleted-request-test' });
bot.state = 'connected';
bot._gate = async () => true;
const wire = [];
bot.sock = { sendMessage: async (jid, content) => { wire.push({ jid, content }); return { key: { id: `BOT${wire.length}`, remoteJid: jid, fromMe: true } }; } };
const heard = [];
bot.on('message', (m) => heard.push(m));

const member = '10000000000009@lid';
const request = (id, text) => ({
  key: { id, remoteJid: GROUP, participant: member, participantPn: '15558160178@s.whatsapp.net' },
  message: { conversation: text }, messageTimestamp: 1791496130, pushName: 'Ari',
});
const remove = (id, type) => ({
  key: { id: `DEL-${id}`, remoteJid: GROUP, participant: member },
  message: { protocolMessage: { key: { id, remoteJid: GROUP, participant: member }, ...(type === undefined ? {} : { type }) } },
  messageTimestamp: 1791496136,
});

bot._onMessagesUpsert({ type: 'notify', messages: [request('FIRST', '#request friren:beyond journeys end')] });
const first = heard.find((m) => m.id === 'FIRST');
ok(!!first, 'the first request reaches the plugins as before');

await bot.react(first, '🔍');
ok(wire.length === 1, 'and is reacted to while it stands');

bot._onMessagesUpsert({ type: 'notify', messages: [remove('FIRST', 0)] });
ok(bot.isRevoked('FIRST'), 'deleting it (REVOKE, type 0) is noted');

const asked = await bot.sendText(GROUP, "📺 Frieren: Beyond Journey's End — which season?", { quoted: first });
ok(asked === null && wire.length === 1, 'the "which season?" quoting the deleted request is not sent');
ok(await bot.react(first, '📺') === false && wire.length === 1, 'nor a reaction on it');

bot._onMessagesUpsert({ type: 'notify', messages: [request('SECOND', '#request friren:beyond journeys end s1')] });
const second = heard.find((m) => m.id === 'SECOND');
await bot.sendText(GROUP, 'queued', { quoted: second });
await bot.react(second, '🎬');
ok(wire.length === 3, 'the request sent again is answered, quoted and reacted to');

bot._onMessagesUpsert({ type: 'notify', messages: [request('THIRD', '#request x'), remove('THIRD', undefined)] });
ok(bot.isRevoked('THIRD'), 'a delete whose type protobuf left unset counts too');

bot._onMessagesUpsert({ type: 'notify', messages: [request('FOURTH', '#request y'), remove('FOURTH', 14)] });
ok(!bot.isRevoked('FOURTH'), 'an edit (MESSAGE_EDIT, 14) is not a delete');

await bot.sendText(GROUP, 'plain message, quoting nothing');
ok(wire.length === 4, 'a message quoting nothing is never held back');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
