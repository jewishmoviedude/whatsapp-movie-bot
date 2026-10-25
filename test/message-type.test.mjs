/* Content-type detection. Run: node test/message-type.test.mjs

   REGRESSION — this destroyed real users' messages:
   messageType was Object.keys(inner)[0], but group messages carry
   `senderKeyDistributionMessage` BEFORE the actual content. Every plain-text
   group request was therefore typed as that, failed the "is it text?" check,
   and was deleted for everyone as media. 100 valid requests were lost. */
import { WhatsAppBot } from '../src/core/bot.js';
import { checkMessage } from '../src/plugins/movie-requests/enforcement.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const bot = new WhatsAppBot({ configStore: { get: () => ({ whatsapp: {} }) }, dataDir: '/tmp' });
const raw = (message) => ({ key: { remoteJid: 'g@g.us', participant: 'a@lid', id: 'M' }, messageTimestamp: 1, message });

console.log('=== the exact shapes that were being destroyed ===');
{
  const a = bot.normalize(raw({ senderKeyDistributionMessage: { groupId: 'g@g.us' }, conversation: '#request Dune 2021' }));
  ok(a.messageType === 'conversation', 'group text behind senderKeyDistributionMessage -> conversation');
  ok(a.text === '#request Dune 2021', 'and the text still comes through');

  const b = bot.normalize(raw({ messageContextInfo: {}, extendedTextMessage: { text: '#request Jaws 1975' } }));
  ok(b.messageType === 'extendedTextMessage', 'text behind messageContextInfo -> extendedTextMessage');

  const c = bot.normalize(raw({ senderKeyDistributionMessage: {}, messageContextInfo: {}, conversation: 'hi' }));
  ok(c.messageType === 'conversation', 'both metadata keys present -> still finds the content');
}

console.log('=== real media is still recognised ===');
for (const [type, body] of [
  ['imageMessage', { caption: '' }], ['videoMessage', {}], ['audioMessage', {}],
  ['stickerMessage', {}], ['documentMessage', {}], ['locationMessage', {}],
]) {
  const m = bot.normalize(raw({ senderKeyDistributionMessage: {}, [type]: body }));
  ok(m.messageType === type, `${type} detected behind the metadata key`);
}

console.log('=== wrapped messages ===');
{
  const e = bot.normalize(raw({ ephemeralMessage: { message: { senderKeyDistributionMessage: {}, conversation: 'x' } } }));
  ok(e.messageType === 'conversation', 'ephemeral wrapper unwrapped correctly');
}

console.log('=== enforcement never deletes a message that has text ===');
{
  const cfg = {
    requirePrefix: true, prefix: '#request', rulesCommand: '#rules',
    enforcement: { enabled: true, deleteNonRequests: true, deleteMedia: true, exemptAdmins: true },
  };
  // the precise case that deleted 100 valid requests
  const valid = { text: '#request Dune 2021', fromMe: false, messageType: 'conversation' };
  ok(checkMessage(valid, cfg, {}) === null, 'a valid text request survives');

  // even if the type is somehow unrecognised, TEXT is never "media"
  for (const t of ['senderKeyDistributionMessage', 'messageContextInfo', 'unknown', undefined]) {
    const m = { text: '#request Dune 2021', fromMe: false, messageType: t };
    ok(checkMessage(m, cfg, {}) === null, `text with messageType=${t} is not deleted as media`);
  }

  // and media with no text is still removed
  ok(checkMessage({ text: '', fromMe: false, messageType: 'imageMessage' }, cfg, {})?.reason === 'media',
    'an image with no text is still removed');
  ok(checkMessage({ text: '', fromMe: false, messageType: 'audioMessage' }, cfg, {})?.reason === 'media',
    'a voice note is still removed');
  // an unknown non-text type is LEFT ALONE rather than guessed at
  ok(checkMessage({ text: '', fromMe: false, messageType: 'someNewThingMessage' }, cfg, {}) === null,
    'an unrecognised type with no text is left in place, not deleted on a guess');
}

console.log('=== the source no longer uses the first key ===');
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/core/bot.js', import.meta.url), 'utf8');
  ok(!/messageType: Object\.keys\(inner\)\[0\]/.test(src), 'the first-key shortcut is gone');
  ok(/k !== 'senderKeyDistributionMessage'/.test(src), 'senderKeyDistributionMessage is skipped');
  ok(/k !== 'messageContextInfo'/.test(src), 'messageContextInfo is skipped');

  const enf = fs.readFileSync(new URL('../src/plugins/movie-requests/enforcement.js', import.meta.url), 'utf8');
  ok(/!text && MEDIA_TYPES\.includes/.test(enf), 'media deletion requires BOTH no text and a known media type');
  ok(!/!TEXT_TYPES\.includes\(msg\.messageType\)/.test(enf), 'the allow-list check that deleted anything unfamiliar is gone');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
