/* $stamtest: any request, tried in a beta group, answered once with how a
   main group would answer it.
   Run: node test/stam-test.test.mjs

   The operator (2026-09-30): "if I want to test any sort of requests without
   cluttering up the main groups I should be able to do in test group ... I'll
   send "$stamtest #request-tv friends s03 e06, e08" and bot will respond if
   it'll work on the main group. bots response should summarize what I wrote
   and it's response in said response so I can copy and paste elswhere outside
   the test group and whoever I send to will have context".

   So: readBetaTest takes "$stamtest <request>" as a test of no feature; the
   plugins judge it with only the features that are On (featureGroup); and
   while they run, every reaction, reply and deletion is gathered instead of
   sent (bot.js -> stamIntercept), and the plugin manager sends ONE message
   quoting the request and saying what the bot would have done. Another
   message handled at the same moment is not gathered. */
import { readBetaTest, featureGroup, isEnabled } from '../src/core/beta.js';
import { readStamTest, runStamTest, stamIntercept, formatStamSummary, isStamKey, stamCapture } from '../src/core/stam-test.js';
import { WhatsAppBot } from '../src/core/bot.js';
import { PluginManager } from '../src/core/plugin-manager.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const TEST_GROUP = 'test@g.us';
const cfg = {
  tvRequests: { enabled: true },
  movieRequests: { reactions: { done: '✅' } },
  beta: { groups: [TEST_GROUP], features: { 'on-feature': 'on', 'beta-feature': 'beta' } },
};

console.log('=== reading "$stamtest <request>" ===');
{
  const tv = readBetaTest(cfg, '$stamtest #request-tv friends s03 e06, e08');
  ok(tv.outcome === 'tv' && tv.stam && tv.code === 'stamtest' && tv.body === 'friends s03 e06, e08' && tv.forced,
    'the operator\'s example is a TV test of "friends s03 e06, e08"');
  const film = readBetaTest(cfg, '$stamtest harry potter');
  ok(film.outcome === 'movie' && film.stam && film.feature === null, 'a title alone is a film test, of no feature');
  ok(readBetaTest(cfg, '$stamtest the office season 2').outcome === 'tv', 'a named season is TV, as in any beta test');
  ok(readBetaTest(cfg, '$StamTest: dune 2021').body === 'dune 2021', 'any case, and a colon after the code');
  ok(readBetaTest(cfg, '$stamtests x').outcome === 'ignore', '"$stamtests" is not the code');
  ok(readBetaTest(cfg, '$stamtest a\n$beta001 b').outcome === 'several', 'two tests in one message are answered, not run');
  ok(readBetaTest({ ...cfg, tvRequests: { enabled: false } }, '$stamtest #request-tv friends s03').outcome === 'tv-off',
    'a TV stamtest with TV off is told so');
  ok(readStamTest('hello') === null && readStamTest('$stamtest x').body === 'x', 'readStamTest: only the code');
}

console.log('=== judged as a main group judges ===');
{
  const inTest = { chatJid: TEST_GROUP };
  const stam = { chatJid: TEST_GROUP, stam: true };
  const REG = [{ key: 'on-feature', code: 'beta901', scope: 'all' }, { key: 'beta-feature', code: 'beta902', scope: 'all' }];
  ok(isEnabled(cfg, 'beta-feature', featureGroup(inTest), REG), 'a $betaNNN test in the test group gets the Beta feature');
  ok(!isEnabled(cfg, 'beta-feature', featureGroup(stam), REG), 'a $stamtest does not: a main group would not');
  ok(isEnabled(cfg, 'on-feature', featureGroup(stam), REG), 'and a feature that is On applies to it');
}

console.log('=== what the bot would do is gathered, not sent ===');
{
  // The real bot methods, on a bot with no connection: a send that was not
  // gathered would throw "WhatsApp is not connected".
  const bot = Object.create(WhatsAppBot.prototype);
  bot.sock = null; bot.state = 'closed';
  const msg = { id: 'M1', key: { id: 'M1', remoteJid: TEST_GROUP } };
  const cap = await runStamTest(async () => {
    await bot.react(msg, '🔍');
    const sent = await bot.sendText(TEST_GROUP, 'a reply', { quoted: msg });
    ok(isStamKey(sent?.key), 'a gathered message has a made-up key its sender can keep');
    await bot.editText(TEST_GROUP, sent.key, 'edited');
    await bot.deleteMessage(msg);
    await bot.react(msg, '✅');
  });
  ok(cap.actions.map((a) => a.kind).join(',') === 'react,text,edit,delete,react', `every step gathered in order (${cap.actions.map((a) => a.kind)})`);
  let threw = null;
  try { await bot.sendText(TEST_GROUP, 'outside'); } catch (e) { threw = e; }
  ok(/not connected/.test(threw?.message ?? ''), 'outside a $stamtest a send is a real send');
  ok(await bot.editText(TEST_GROUP, { id: 'stam-x-1' }, 'late') === false,
    'a pick list that expires after its $stamtest does not edit a message that was never sent');
  ok(stamCapture() === null && stamIntercept('text', { text: 'x' }) === null, 'no capture outside');
}

console.log('=== one answer, quoting the request, with everything in it ===');
{
  const sends = [];
  const bot = Object.create(WhatsAppBot.prototype);
  bot.sock = { sendMessage: async () => ({ key: { id: 'REAL' } }) };
  bot.state = 'connected';
  // Only the summary may reach WhatsApp: recorded here, not really sent.
  bot.sendText = async function (jid, text, opts) {
    const g = stamIntercept('text', { jid, text, quoted: !!opts?.quoted });
    if (g) return g;
    sends.push({ jid, text, opts });
    return { key: { id: 'REAL' } };
  };
  const plugin = {
    name: 'tv-like',
    async onMessage(m, ctx) {
      if (!/^\$stamtest/i.test(m.text) && m.text !== 'other') return;
      await ctx.bot.react(m, '🔍');
      await new Promise((r) => setTimeout(r, 20));
      if (m.text === 'other') { await ctx.bot.sendText(m.chatJid, 'a real answer to another message', { quoted: m }); return; }
      await ctx.bot.sendText(m.chatJid, '✅ *Test passed* ($stamtest)\n\nThe bot would queue 2 episodes of *Friends* season 3.\nNothing was downloaded.', { quoted: m });
      await ctx.bot.react(m, '✅');
    },
  };
  bot.react = async function (m, emoji) { const g = stamIntercept('react', { emoji }); if (g) return g; sends.push({ react: emoji }); return true; };
  const pm = new PluginManager({ bot, configStore: { get: () => cfg }, stateStore: null });
  pm.plugins.set('tv-like', { plugin, ctx: { bot } });
  const msg = { id: 'T1', key: { id: 'T1', remoteJid: TEST_GROUP }, chatJid: TEST_GROUP, isGroup: true, text: '$stamtest #request-tv friends s03 e06, e08' };
  const other = { id: 'O1', key: { id: 'O1', remoteJid: 'main@g.us' }, chatJid: 'main@g.us', isGroup: true, text: 'other' };
  await Promise.all([pm.dispatchMessage(msg), pm.dispatchMessage(other)]);
  const summary = sends.find((s) => s.text?.includes('Stam test'));
  ok(sends.filter((s) => s.text?.includes('Stam test')).length === 1, 'exactly one $stamtest answer is sent');
  ok(summary?.opts?.quoted === msg, 'quoting the tester\'s message');
  ok(/It would work in the main group/.test(summary?.text ?? ''), 'it says whether it would work');
  ok(/\*Request:\*\n#request-tv friends s03 e06, e08/.test(summary?.text ?? ''), 'it repeats what was asked, as a member would type it');
  ok(/2 episodes of \*Friends\* season 3/.test(summary?.text ?? '') && !/Test passed/.test(summary?.text ?? ''),
    'with the bot\'s own answer, without the test-mode wording');
  ok(/\*Reactions:\* 🔍 → ✅/.test(summary?.text ?? ''), 'and the reactions the request would get');
  ok(!sends.some((s) => s.text?.includes('Test passed') || s.react === '✅'), 'nothing the plugin said for the test went out on its own');
  ok(sends.some((s) => s.text === 'a real answer to another message') && sends.some((s) => s.react === '🔍'),
    'a message handled at the same moment is answered as normal, not gathered');
}

console.log('=== the summary for other outcomes ===');
{
  const refused = formatStamSummary('some r film', [
    { kind: 'react', emoji: '🔍' }, { kind: 'react', emoji: '⛔' },
    { kind: 'text', jid: TEST_GROUP, text: '⛔ Some R Film (2020) — rated R, can\'t be posted', quoted: false },
  ], { groupJid: TEST_GROUP });
  ok(/would not go through as asked \(the bot would react ⛔\)/.test(refused), 'a refusal says it would not go through');
  ok(/\*Notifications group:\*\n⛔ Some R Film/.test(refused), 'and what the notifications group would be told');
  const deleted = formatStamSummary('hi all', [{ kind: 'delete' }, { kind: 'text', jid: '123@s.whatsapp.net', text: 'Please send #request …' }]);
  ok(/would be deleted/.test(deleted) && /\*Private message to the member:\*/.test(deleted), 'moderation: deleted, and the DM the member would get');
  ok(/nothing was downloaded or sent anywhere/.test(deleted), 'every answer says it was only a test');
  ok(/would not answer it at all/.test(formatStamSummary('x', [])), 'no answer at all is said too');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
