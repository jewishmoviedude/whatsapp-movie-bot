/* Scanning real messages to learn WhatsApp's group-mention convention.
   Run: node test/mention-scan.test.mjs */
import { extractMention, scanForGroupMentions, deduceTokenConvention } from '../src/core/mention-scan.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const JID = '120363900000000006@g.us';
const SUBJ = 'MOVIE POSTS ONLY';

const mkMsg = (text, { groupMentions = [{ groupJid: JID, groupSubject: SUBJ }], mentionedJid = [] } = {}) => ({
  key: { remoteJid: 'notif@g.us', id: 'M1', fromMe: false },
  messageTimestamp: 1700,
  message: { extendedTextMessage: { text, contextInfo: { groupMentions, mentionedJid } } },
});

console.log('=== extraction ===');
{
  const hit = extractMention(mkMsg(`check @${JID}`));
  ok(!!hit, 'a message with groupMentions is extracted');
  ok(hit.groupMentions[0].groupJid === JID, 'carries the group jid');
  ok(hit.groupMentions[0].groupSubject === SUBJ, 'carries the subject');
  ok(hit.chatJid === 'notif@g.us', 'records which chat it came from');
}
{
  const plain = { key: { remoteJid: 'g@g.us', id: 'X' }, message: { conversation: 'hello' } };
  ok(extractMention(plain) === null, 'a plain message is ignored');
  ok(extractMention({ key: {} }) === null, 'a message with no body is ignored');
  ok(extractMention(null) === null, 'null is safe');
  const noGm = { key: { remoteJid: 'g@g.us' }, message: { extendedTextMessage: { text: 'hi', contextInfo: { mentionedJid: ['1@s.whatsapp.net'] } } } };
  ok(extractMention(noGm) === null, 'a PERSON mention alone is not a group mention');
}
{
  // group mentions can arrive wrapped
  const wrapped = { key: { remoteJid: 'g@g.us', id: 'W' }, messageTimestamp: 1,
    message: { ephemeralMessage: { message: { extendedTextMessage: { text: `x @${JID}`, contextInfo: { groupMentions: [{ groupJid: JID, groupSubject: SUBJ }] } } } } } };
  ok(!!extractMention(wrapped), 'unwraps ephemeral messages');
}

console.log('=== batch scan is resilient ===');
{
  const batch = [mkMsg(`a @${JID}`), null, { garbage: true }, mkMsg(`b @${JID}`)];
  const hits = scanForGroupMentions(batch);
  ok(hits.length === 2, 'finds both real mentions and skips the junk');
  ok(scanForGroupMentions([]).length === 0, 'empty batch is fine');
}

console.log('=== the scan can TELL THE CONVENTIONS APART ===');
{
  // This is the whole point: given a genuine sample, say which token was used.
  const full = deduceTokenConvention(extractMention(mkMsg(`Check @${JID} now`)));
  ok(full[0].matched === 'full-jid', 'full jid token -> "full-jid"');
  ok(full[0].token === `@${JID}`, 'reports the exact token found');

  const localOnly = deduceTokenConvention(extractMention(mkMsg('Check @120363900000000006 now')));
  ok(localOnly[0].matched === 'jid-local-part', 'local-part token -> "jid-local-part"');

  const subj = deduceTokenConvention(extractMention(mkMsg(`Check @${SUBJ} now`)));
  ok(subj[0].matched === 'subject', 'subject token -> "subject"');

  const none = deduceTokenConvention(extractMention(mkMsg('Check the posts group')));
  ok(none[0].matched === 'NONE', 'no recognisable token -> "NONE"');
}
{
  // "@<local>" is a substring of "@<jid>", so the specific form must win.
  const conv = deduceTokenConvention(extractMention(mkMsg(`Check @${JID}`)));
  ok(conv[0].matched === 'full-jid', 'full jid preferred over its own local-part substring');
  ok(conv[0].allMatches.includes('jid-local-part'), 'the substring match is still reported for transparency');
}
{
  // several groups mentioned at once
  const two = extractMention(mkMsg(`@${JID} and @999@g.us`, {
    groupMentions: [{ groupJid: JID, groupSubject: SUBJ }, { groupJid: '999@g.us', groupSubject: 'Other' }],
  }));
  const conv = deduceTokenConvention(two);
  ok(conv.length === 2, 'reports a verdict per mentioned group');
  ok(conv.every((c) => c.matched === 'full-jid'), 'both resolved');
}

console.log('=== our own outgoing messages are usable evidence too ===');
{
  const mine = { key: { remoteJid: 'notif@g.us', id: 'S1', fromMe: true }, messageTimestamp: 5,
    message: { extendedTextMessage: { text: `Check @${JID}`, contextInfo: { groupMentions: [{ groupJid: JID, groupSubject: SUBJ }] } } } };
  const hit = extractMention(mine);
  ok(hit.fromMe === true, 'marks messages we sent, so they are not mistaken for ground truth');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
