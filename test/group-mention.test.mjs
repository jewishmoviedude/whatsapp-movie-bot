/* Tagging the posts group in notifications. Run: node test/group-mention.test.mjs */
import { WhatsAppBot } from '../src/core/bot.js';
import plugin from '../src/plugins/movie-requests/index.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const NOTIF = '120363900000000015@g.us';
const POSTS = '120363900000000006@g.us';
const COMMUNITY = '120363111111111111@g.us';

function makeBot({ sameCommunity = true } = {}) {
  const bot = new WhatsAppBot({ configStore: { get: () => ({ whatsapp: {} }) }, dataDir: '/tmp' });
  bot.state = 'connected';
  bot.groupCache = new Map([
    [NOTIF, { jid: NOTIF, subject: 'Request queue notifications', community: COMMUNITY,
              memberIds: new Set(['req@lid']), memberNumbers: new Set(['15551112222']) }],
    [POSTS, { jid: POSTS, subject: 'MOVIE POSTS ONLY', community: sameCommunity ? COMMUNITY : null,
              memberIds: new Set(), memberNumbers: new Set() }],
  ]);
  bot.sent = [];
  bot.sock = { sendMessage: async (jid, content, opts) => { bot.sent.push({ jid, content, opts }); return {}; } };
  return bot;
}

console.log('=== groupMentionToken ===');
{
  const bot = makeBot();
  // Group mentions invert the person convention: FULL jid, domain included.
  ok(bot.groupMentionToken(POSTS) === '@120363900000000006@g.us', 'token is @ + the FULL jid (domain included)');
  ok(bot.groupMentionToken(POSTS).endsWith('@g.us'), 'the @g.us domain is NOT stripped (stripping it broke rendering)');
  ok(bot.groupMentionToken('nope@g.us') === '@nope@g.us', 'works for a group not in the cache');
  ok(bot.groupMentionToken('') === '', 'empty jid yields no stray "@"');
}

console.log('=== sameCommunity ===');
{
  ok(makeBot().sameCommunity(NOTIF, POSTS) === true, 'linked groups -> true');
  ok(makeBot({ sameCommunity: false }).sameCommunity(NOTIF, POSTS) === false, 'unlinked -> false');
  const bot = makeBot();
  ok(bot.sameCommunity(NOTIF, 'nope@g.us') === false, 'unknown group -> false');
}

console.log('=== sendText emits contextInfo.groupMentions ===');
{
  const bot = makeBot();
  await bot.sendText(NOTIF, 'check @120363900000000006', {
    groupMentions: [{ groupJid: POSTS, groupSubject: 'MOVIE POSTS ONLY' }],
  });
  const c = bot.sent[0].content;
  ok(Array.isArray(c.contextInfo?.groupMentions), 'groupMentions attached to contextInfo');
  ok(c.contextInfo.groupMentions[0].groupJid === POSTS, 'carries the group jid');
  ok(c.contextInfo.groupMentions[0].groupSubject === 'MOVIE POSTS ONLY', 'carries the subject');
  ok(!('groupMentions' in c), 'not left as a bogus top-level field');
}
{
  // subject filled in from cache when omitted
  const bot = makeBot();
  await bot.sendText(NOTIF, 'x', { groupMentions: [{ groupJid: POSTS }] });
  ok(bot.sent[0].content.contextInfo.groupMentions[0].groupSubject === 'MOVIE POSTS ONLY', 'subject resolved from the group cache');
}
{
  // plain sends stay clean
  const bot = makeBot();
  await bot.sendText(NOTIF, 'plain');
  ok(!bot.sent[0].content.contextInfo, 'no contextInfo when no group mention');
}

console.log('=== done notification tags the posts group ===');
{
  const bot = makeBot();
  const ctx = {
    bot,
    config: { movieRequests: { notify: { group: NOTIF, tagRequester: true }, postsGroup: POSTS } },
    log: { info() {}, warn() {} },
  };
  await plugin._notify(ctx, 'done', '✅ The Truman Show (1998) — posted! Check {group}',
    { requesterNumber: '15551112222', requesterJid: 'req@lid' }, { tagGroup: POSTS });
  const s = bot.sent[0];
  ok(s.content.text.includes('@120363900000000006@g.us'), 'text carries the full-jid mention token');
  ok(s.content.contextInfo.groupMentions[0].groupSubject === 'MOVIE POSTS ONLY', 'subject travels in groupMentions — WhatsApp renders it in place of the token');
  ok(!s.content.text.includes('{group}'), 'placeholder fully substituted');
  ok(s.content.contextInfo?.groupMentions?.[0].groupJid === POSTS, 'group mention metadata sent');
  ok(s.content.text.startsWith('@'), 'requester tagged first, then the message');
}

console.log('=== falls back to the plain name outside the community ===');
{
  const bot = makeBot({ sameCommunity: false });
  const ctx = {
    bot,
    config: { movieRequests: { notify: { group: NOTIF, tagRequester: false }, postsGroup: POSTS } },
    log: { info() {}, warn() {} },
  };
  await plugin._notify(ctx, 'done', '✅ Movie — posted! Check {group}', {}, { tagGroup: POSTS });
  const s = bot.sent[0];
  ok(s.content.text.includes('MOVIE POSTS ONLY'), 'uses the readable group name');
  ok(!s.content.text.includes('@1203631668'), 'no dangling mention token that would render as a raw number');
  ok(!s.content.contextInfo, 'no group mention metadata when it would not render');
}

console.log('=== toggle + placeholder safety ===');
{
  const bot = makeBot();
  const ctx = {
    bot,
    config: { movieRequests: { notify: { group: NOTIF, tagRequester: false, tagPostsGroup: false }, postsGroup: POSTS } },
    log: { info() {}, warn() {} },
  };
  await plugin._notify(ctx, 'done', '✅ Movie — posted! Check {group}', {}, { tagGroup: POSTS });
  ok(bot.sent[0].content.text.includes('the posts group'), 'tagPostsGroup:false -> neutral wording');
  ok(!bot.sent[0].content.contextInfo, 'no group mention when disabled');
}
{
  // an unknown group must never leak a raw {group} placeholder to users
  const bot = makeBot();
  const ctx = {
    bot,
    config: { movieRequests: { notify: { group: NOTIF, tagRequester: false }, postsGroup: 'ghost@g.us' } },
    log: { info() {}, warn() {} },
  };
  await plugin._notify(ctx, 'done', '✅ Movie — posted! Check {group}', {}, { tagGroup: 'ghost@g.us' });
  ok(!bot.sent[0].content.text.includes('{group}'), 'unknown group still substitutes the placeholder');
}
{
  // messages without the placeholder are untouched
  const bot = makeBot();
  const ctx = {
    bot,
    config: { movieRequests: { notify: { group: NOTIF, tagRequester: false }, postsGroup: POSTS } },
    log: { info() {}, warn() {} },
  };
  await plugin._notify(ctx, 'queued', '🎬 Movie — added to the queue', {});
  ok(bot.sent[0].content.text === '🎬 Movie — added to the queue', 'other steps unchanged');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
