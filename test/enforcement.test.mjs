/* Request-group rule enforcement. Run: node test/enforcement.test.mjs */
import { checkMessage, looksLikeMultipleTitles, violationNotice, cleanTitle } from '../src/plugins/movie-requests/enforcement.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const cfg = {
  requirePrefix: true,
  prefix: '#request',
  rulesCommand: '#rules',
  ruleSets: [{ command: '#rules-requests', text: 'x' }],
  enforcement: { enabled: true, deleteNonRequests: true, deleteMedia: true, deleteMultiple: true, exemptAdmins: true },
};
const mk = (text, o = {}) => ({ text, fromMe: false, messageType: 'conversation', senderJid: 'a@lid', ...o });
const check = (text, o = {}, c = cfg, opt = {}) => checkMessage(mk(text, o), c, opt);

console.log('=== the two real offenders from the group ===');
ok(check('Requesting antman and wasp quantumania 2023')?.reason === 'no-prefix', '"Requesting antman and wasp quantumania 2023" -> deleted (no prefix)');
ok(check('The commuter 2018')?.reason === 'no-prefix', '"The commuter 2018" -> deleted (no prefix)');

console.log('=== properly formatted requests are LEFT ALONE ===');
ok(check('#request oceans 11') === null, 'valid request kept');
ok(check('#request The Truman Show 1998') === null, 'valid request with year kept');
ok(check('#REQUEST Blade 2003') === null, 'prefix is case-insensitive');
ok(check('  #request  Dune 2021  ') === null, 'surrounding whitespace tolerated');
ok(check('#request the dark night 2015') === null, 'a misspelled title is still a valid request (the bot corrects it)');
ok(check('#request Beauty and the Beast') === null, 'title containing "and" is not treated as two movies');
ok(check('#request Ant-Man and the Wasp Quantumania 2023') === null, 'known joiner title kept');
ok(check('#request Dune, 2021') === null, 'comma before a year is not a list');

console.log('=== bot commands are never deleted ===');
ok(check('#rules') === null, '#rules kept');
ok(check('#rules-requests') === null, 'a rule-set command kept');
ok(check('#RULES') === null, 'case-insensitive');

console.log('=== multiple titles ===');
ok(check('#request oceans 11 and 12')?.reason === 'multiple', '"oceans 11 and 12" -> one movie at a time');
ok(check('#request toy story 2 and 3')?.reason === 'multiple', 'numbered sequels flagged');
ok(check('#request the matrix, inception') === null, 'comma-separated titles are NOT flagged — too many real titles contain a comma');
ok(check('#request The Good, the Bad and the Ugly') === null, '"The Good, the Bad and the Ugly" survives (regression guard)');
ok(check('#request Crouching Tiger, Hidden Dragon') === null, '"Crouching Tiger, Hidden Dragon" survives');
ok(check('#request the matrix + inception')?.reason === 'multiple', 'plus-separated titles flagged');
ok(looksLikeMultipleTitles('oceans 11 and 12') === true, 'helper: numeric joiner');
ok(looksLikeMultipleTitles('Beauty and the Beast') === false, 'helper: real title with "and"');
ok(looksLikeMultipleTitles('Fast and Furious 9') === false, 'helper: franchise title kept');
ok(looksLikeMultipleTitles('') === false, 'helper: empty is not multiple');

console.log('=== media ===');
ok(check('', { messageType: 'imageMessage' })?.reason === 'media', 'image deleted');
ok(check('', { messageType: 'audioMessage' })?.reason === 'media', 'voice note deleted');
ok(check('', { messageType: 'stickerMessage' })?.reason === 'media', 'sticker deleted');
ok(check('#request Dune', { messageType: 'extendedTextMessage' }) === null, 'a normal text reply-style message is fine');

console.log('=== exemptions and safety ===');
ok(check('just chatting', {}, cfg, { isAdmin: true }) === null, 'admins are exempt by default');
ok(check('just chatting', { fromMe: true }) === null, "the bot's own messages are never deleted");
{
  const off = { ...cfg, enforcement: { ...cfg.enforcement, enabled: false } };
  ok(check('just chatting', {}, off) === null, 'master switch off -> nothing deleted');
}
{
  const noAdminExempt = { ...cfg, enforcement: { ...cfg.enforcement, exemptAdmins: false } };
  ok(check('chatting', {}, noAdminExempt, { isAdmin: true })?.reason === 'no-prefix', 'exemptAdmins:false moderates admins too');
}
{
  const mediaOff = { ...cfg, enforcement: { ...cfg.enforcement, deleteMedia: false } };
  ok(check('', { messageType: 'imageMessage' }, mediaOff) === null, 'deleteMedia:false leaves images');
}
{
  const multiOff = { ...cfg, enforcement: { ...cfg.enforcement, deleteMultiple: false } };
  ok(check('#request oceans 11 and 12', {}, multiOff) === null, 'deleteMultiple:false leaves multi-title requests');
}
{
  // With no prefix required, plain titles are valid requests and must survive.
  const noPrefix = { ...cfg, requirePrefix: false };
  ok(check('The commuter 2018', {}, noPrefix) === null, 'requirePrefix:false -> a bare title is a valid request');
}
ok(check('#request') === null || check('#request')?.reason === 'empty', 'prefix with no title flagged as empty, not as chatting');

console.log('=== the notice explains itself ===');
{
  const n = violationNotice({ reason: 'no-prefix' }, cfg);
  ok(n.includes('#request'), 'notice shows the required prefix');
  ok(n.includes('#rules'), 'notice points at the rules command');
  const m = violationNotice({ reason: 'multiple' }, cfg);
  ok(/one movie per message/i.test(m), 'multiple-title notice explains the actual reason');
}

console.log('=== cleanTitle strips filler but never mangles a real title ===');
{
  ok(cleanTitle('Requesting antman and wasp quantumania 2023') === 'antman and wasp quantumania 2023', 'drops "Requesting"');
  ok(cleanTitle('please send Dune 2021') === 'Dune 2021', 'drops "please send"');
  ok(cleanTitle('Can you send me The Matrix') === 'The Matrix', 'drops a whole polite request phrase');
  ok(cleanTitle('send me Shrek thanks') === 'Shrek', 'drops trailing thanks');
  ok(cleanTitle('hi pls Toy Story 4') === 'Toy Story 4', 'drops stacked filler');
  // must NOT damage genuine titles
  ok(cleanTitle('The commuter 2018') === 'The commuter 2018', 'a title starting with "The" is untouched');
  ok(cleanTitle('The Truman Show 1998') === 'The Truman Show 1998', 'real title untouched');
  ok(cleanTitle('The Post') === 'The Post', '"The Post" is not mistaken for the verb "post"');
  ok(cleanTitle('Get Out 2017') === 'Get Out 2017', '"Get Out" survives the "get" filler');
  ok(cleanTitle('Send Help') === 'Send Help', '"Send Help" survives the "send" filler');
  ok(cleanTitle('Sing Street') === 'Sing Street', '"Sing Street" untouched');
  ok(cleanTitle('pls send me The Matrix') === 'The Matrix', 'politeness marker makes the following verb safe to strip');
  ok(cleanTitle('Sing 2') === 'Sing 2', 'short title untouched');
  ok(cleanTitle('') === '', 'empty is safe');
  ok(cleanTitle('please') === 'please', 'a message that is ONLY filler is not emptied');
}

console.log('=== the removal notice is actionable ===');
{
  const mk = (text) => ({ text, fromMe: false, messageType: 'conversation' });

  const m1 = mk('The commuter 2018');
  const n1 = violationNotice(checkMessage(m1, cfg, {}), cfg, m1);
  ok(n1.includes('The commuter 2018'), 'quotes what they actually wrote');
  ok(n1.includes('#request The commuter 2018'), 'hands them the exact corrected message');
  ok(/every request must start with/i.test(n1), 'names the specific rule that was broken');
  ok(n1.includes('#rules'), 'points at the full rules');

  const m2 = mk('Requesting antman and wasp quantumania 2023');
  const n2 = violationNotice(checkMessage(m2, cfg, {}), cfg, m2);
  ok(n2.includes('#request antman and wasp quantumania 2023'), 'the suggested fix drops the filler word');
  ok(!n2.includes('#request Requesting'), 'never suggests a request that would fail the lookup');

  const m3 = mk('#request oceans 11 and 12');
  const n3 = violationNotice(checkMessage(m3, cfg, {}), cfg, m3);
  ok(/one movie per message/i.test(n3), 'multi-title notice names the one-at-a-time rule');
  ok(n3.includes('#request oceans 11'), 'suggests just the first film');

  const m4 = { text: '', fromMe: false, messageType: 'imageMessage' };
  const n4 = violationNotice(checkMessage(m4, cfg, {}), cfg, m4);
  ok(/text only/i.test(n4), 'media notice names the text-only rule');
  ok(!n4.includes('You wrote'), 'does not show an empty quote for a picture');

  const m5 = mk('#request');
  const n5 = violationNotice(checkMessage(m5, cfg, {}), cfg, m5);
  ok(/needs the movie/i.test(n5), 'empty request explains what is missing');

  // a year hint only when they did not give one
  const withYear = mk('Dune 2021');
  const nY = violationNotice(checkMessage(withYear, cfg, {}), cfg, withYear);
  ok(!/Add the release year/i.test(nY), 'no year nag when they already gave one');
  const noYear = mk('Dune');
  const nN = violationNotice(checkMessage(noYear, cfg, {}), cfg, noYear);
  ok(/Add the release year/i.test(nN), 'suggests adding a year when missing');

  // long messages are truncated, not dumped whole
  const long = mk('x'.repeat(600));
  const nL = violationNotice(checkMessage(long, cfg, {}), cfg, long);
  ok(nL.length < 900, 'a very long message is truncated in the quote');
  ok(nL.includes('…'), 'truncation is visible');
}

console.log('=== a bracket-mangled command is never deleted as chatter ===');
{
  const mk = (text) => ({ text, fromMe: false, messageType: 'conversation' });
  ok(checkMessage(mk('#rules)'), cfg, {}) === null, '"#rules)" survives enforcement');
  ok(checkMessage(mk('#rules-requests)'), cfg, {}) === null, '"#rules-requests)" survives enforcement');
  ok(checkMessage(mk('#rules.'), cfg, {}) === null, '"#rules." survives enforcement');
  // and ordinary chatter is still removed
  ok(checkMessage(mk('thanks!'), cfg, {})?.reason === 'no-prefix', 'real chatter is still deleted');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
