/* The TV posts group is tagged in the notifications chat, like movies are.
   Run: node test/tv-group-tag.test.mjs

   The movie side learned this the hard way: the token is the FULL jid
   (@1234@g.us), not the local part, and WhatsApp only renders a group mention
   when both groups are in the same community - across communities it shows the
   raw token, which reads as a bug. TV had none of this: its notify was a bare
   sendText, so "posted!" named no group and linked nowhere. */
import fs from 'node:fs';
import { applyGroupTag } from '../src/core/group-tag.js';
import plugin from '../src/plugins/tv-requests/index.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const NOTIFY = 'notify@g.us';
const TVPOSTS = 'tvposts@g.us';

function fakeBot({ sameCommunity = true, known = true } = {}) {
  const cache = new Map();
  if (known) cache.set(TVPOSTS, { jid: TVPOSTS, subject: 'TV POSTS ONLY!' });
  cache.set(NOTIFY, { jid: NOTIFY, subject: 'Queue notifications' });
  return {
    groupCache: cache,
    sameCommunity: () => sameCommunity,
    groupMentionToken: (jid) => `@${jid}`,
    isConnected: () => true,
    sent: [],
    sendText(jid, body, opts) { this.sent.push({ jid, body, opts }); return Promise.resolve({}); },
  };
}

console.log('=== the token is the full jid, as WhatsApp actually wants ===');
{
  const bot = fakeBot();
  const r = applyGroupTag(bot, { body: 'posted! Check {group}', notifyGroup: NOTIFY, tagGroup: TVPOSTS });
  ok(r.body === 'posted! Check @tvposts@g.us', `token is the full jid: "${r.body}"`);
  ok(r.groupMentions.length === 1, 'and a groupMentions entry accompanies it');
  ok(r.groupMentions[0].groupJid === TVPOSTS, 'naming the group');
  ok(r.groupMentions[0].groupSubject === 'TV POSTS ONLY!', 'with its subject, which is what renders');
}

console.log('=== across communities it degrades to the plain name ===');
{
  // Rendering a raw @jid at members would look like a bug, so don't.
  const bot = fakeBot({ sameCommunity: false });
  const r = applyGroupTag(bot, { body: 'posted! Check {group}', notifyGroup: NOTIFY, tagGroup: TVPOSTS });
  ok(r.body === 'posted! Check TV POSTS ONLY!', `the name is used instead: "${r.body}"`);
  ok(r.groupMentions === null, 'and no mention is attached, so nothing renders as a broken token');
}

console.log('=== a placeholder never escapes unsubstituted ===');
{
  for (const [label, bot, tag] of [
    ['an unknown group', fakeBot({ known: false }), TVPOSTS],
    ['no group to tag', fakeBot(), null],
  ]) {
    const r = applyGroupTag(bot, { body: 'posted! Check {group}', notifyGroup: NOTIFY, tagGroup: tag });
    ok(!r.body.includes('{group}'), `${label}: the raw placeholder is gone ("${r.body}")`);
    ok(/the posts group/.test(r.body), `${label}: it reads as a sentence`);
  }
  const off = applyGroupTag(fakeBot(), {
    body: 'Check {group}', notifyGroup: NOTIFY, tagGroup: TVPOSTS, enabled: false,
  });
  ok(off.body === 'Check the posts group', 'with tagging switched off it still reads properly');
  ok(off.groupMentions === null, 'and tags nothing');
}

console.log('=== the TV plugin tags its OWN posts group ===');
{
  const bot = fakeBot();
  const ctx = {
    bot,
    config: {
      movieRequests: { notify: { group: NOTIFY } },
      tvRequests: { postsGroups: [TVPOSTS, 'second@g.us'] },
    },
    log: { info() {}, debug() {}, warn() {} },
  };
  ok(plugin._tagTarget(ctx) === TVPOSTS, 'the first configured posts group is the one linked');

  plugin._notify(ctx, '✅ The Boys S01 — posted! Check {group}', null, { tagGroup: plugin._tagTarget(ctx) });
  await new Promise((r) => setTimeout(r, 10));
  ok(bot.sent.length === 1, 'a message went out');
  ok(bot.sent[0].jid === NOTIFY, 'to the notifications group');
  ok(bot.sent[0].body.includes('@tvposts@g.us'), `carrying the mention: "${bot.sent[0].body}"`);
  ok(bot.sent[0].opts.groupMentions?.[0]?.groupJid === TVPOSTS, 'with groupMentions set');
}

console.log('=== with no posts group configured, nothing breaks ===');
{
  const bot = fakeBot();
  const ctx = {
    bot,
    config: { movieRequests: { notify: { group: NOTIFY } }, tvRequests: {} },
    log: { info() {}, debug() {}, warn() {} },
  };
  ok(plugin._tagTarget(ctx) === null, 'there is simply nothing to tag');
  plugin._notify(ctx, 'done — Check {group}', null, { tagGroup: plugin._tagTarget(ctx) });
  await new Promise((r) => setTimeout(r, 10));
  ok(!bot.sent[0].body.includes('{group}'), 'and the placeholder is still resolved');
}

console.log('=== only a request that actually posted links through ===');
{
  const src = fs.readFileSync(new URL('../src/plugins/tv-requests/index.js', import.meta.url), 'utf8');
  ok(/const posted = completed > 0;/.test(src), 'the done message knows whether anything landed');
  ok(/tagGroup: posted \? this\._tagTarget\(ctx\) : null/.test(src),
    'a request where every episode failed does not point at the posts group');
  ok(/\$\{posted \? ' — see \{group\}' : ''\}/.test(src),
    'and does not even mention it — "0 of 3 posted, see the posts group" sends people to look at nothing');
  ok(/posted! Check \{group\}/.test(src), 'a clean run does link through');
}

console.log('=== movie and TV share ONE implementation ===');
{
  const movie = fs.readFileSync(new URL('../src/plugins/movie-requests/index.js', import.meta.url), 'utf8');
  const tv = fs.readFileSync(new URL('../src/plugins/tv-requests/index.js', import.meta.url), 'utf8');
  ok(/import \{ applyGroupTag \}/.test(movie), 'movies use the shared helper');
  ok(/import \{ applyGroupTag \}/.test(tv), 'and so does TV');
  // The duplication is what let TV fall behind in the first place.
  ok(!/groupMentionToken\(tagGroup\)/.test(movie), 'the movie plugin no longer has its own copy');
  ok(!/groupMentionToken\(/.test(tv), 'and TV never grew one');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
