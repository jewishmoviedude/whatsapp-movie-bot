/* "$" groups are internal: excluded from bulk member adds.
   Run: node test/private-groups.test.mjs */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WhatsAppBot, isPrivateGroupName } from '../src/core/bot.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

console.log('=== which names count as private ===');
ok(isPrivateGroupName('$Admins internal') === true, '"$Admins internal" is private');
ok(isPrivateGroupName('  $Backchannel') === true, 'leading whitespace tolerated');
ok(isPrivateGroupName('$') === true, 'a bare "$" counts');
ok(isPrivateGroupName('MOVIE POSTS ONLY') === false, 'a normal group is not private');
ok(isPrivateGroupName('Cost $5 group') === false, '"$" elsewhere in the name does not count');
ok(isPrivateGroupName('') === false, 'empty name is not private');
ok(isPrivateGroupName(null) === false, 'null is safe');
ok(isPrivateGroupName(undefined) === false, 'undefined is safe');

console.log('=== the flag reaches the group list ===');
{
  const bot = new WhatsAppBot({ configStore: { get: () => ({ whatsapp: {} }) }, dataDir: '/tmp' });
  bot.state = 'connected';
  bot.sock = {
    user: { id: '1@s.whatsapp.net' },
    groupFetchAllParticipating: async () => ({
      'pub@g.us': { subject: 'MOVIE POSTS ONLY', participants: [] },
      'priv@g.us': { subject: '$Admins internal', participants: [] },
    }),
  };
  await bot.refreshGroups({ force: true });
  const g = Object.fromEntries(bot.groups().map((x) => [x.jid, x]));
  ok(g['priv@g.us'].private === true, 'private group flagged');
  ok(g['pub@g.us'].private === false, 'public group not flagged');
}

console.log('=== bulk ADD is refused for a private group, server side ===');
{
  const bot = new WhatsAppBot({ configStore: { get: () => ({ whatsapp: {} }) }, dataDir: '/tmp' });
  bot.state = 'connected';
  bot.groupCache = new Map([
    ['pub@g.us', { jid: 'pub@g.us', subject: 'Public', private: false }],
    ['priv@g.us', { jid: 'priv@g.us', subject: '$Internal', private: true }],
  ]);
  const touched = [];
  bot._rawParticipant = async (jid, num, action) => { touched.push({ jid, action }); return 'ok'; };
  bot.refreshGroups = async () => [];

  const res = await bot.participantAcrossGroups('15551112222', ['pub@g.us', 'priv@g.us'], 'add');
  ok(touched.length === 1 && touched[0].jid === 'pub@g.us', 'only the public group was actually touched');
  const priv = res.find((r) => r.jid === 'priv@g.us');
  ok(!!priv.error && /private/i.test(priv.error), `private group reported as refused: "${priv.error}"`);
  ok(res.find((r) => r.jid === 'pub@g.us').status === 'ok', 'the public group still succeeded');
}

console.log('=== removing / demoting in a private group is still allowed ===');
{
  const bot = new WhatsAppBot({ configStore: { get: () => ({ whatsapp: {} }) }, dataDir: '/tmp' });
  bot.state = 'connected';
  bot.groupCache = new Map([['priv@g.us', { jid: 'priv@g.us', subject: '$Internal', private: true }]]);
  const touched = [];
  bot._rawParticipant = async (jid, num, action) => { touched.push(action); return 'ok'; };
  bot.refreshGroups = async () => [];
  await bot.participantAcrossGroups('15551112222', ['priv@g.us'], 'demote');
  ok(touched.includes('demote'), 'demote goes through — safety operations are not blocked');
}

console.log('=== ban still reaches private groups ===');
{
  // A banned number must be removed everywhere, internal groups included.
  const bot = new WhatsAppBot({ configStore: { get: () => ({ whatsapp: {} }) }, dataDir: '/tmp' });
  bot.state = 'connected';
  bot.groupCache = new Map([['priv@g.us', {
    jid: 'priv@g.us', subject: '$Internal', private: true,
    memberIds: new Set(['x@lid']), memberNumbers: new Set(['15551112222']),
  }]]);
  const removed = [];
  bot._rawParticipant = async (jid, num, action) => { removed.push({ jid, action }); return 'removed'; };
  bot.refreshGroups = async () => [];
  bot.messageIndex = null;
  const res = await bot.banFromAllGroups('15551112222');
  ok(removed.some((r) => r.jid === 'priv@g.us' && r.action === 'remove'), 'ban removes them from the private group too');
  ok(res.length === 1, 'reported in the results');
}

console.log('=== the portal hides them from the bulk picker ===');
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const appJs = fs.readFileSync(path.join(here, '..', 'src', 'web', 'public', 'app.js'), 'utf8');
  const fn = appJs.match(/function renderMxGroups\(\)[\s\S]*?\n\}/)[0];
  ok(/GROUPS\.filter\(\(g\) => !g\.private\)/.test(fn), 'bulk picker filters out private groups');
  ok(/private group/i.test(fn), 'tells the admin that some groups were hidden');
  // the per-group Groups tab must still list everything
  const gl = appJs.match(/function renderGroupList[\s\S]*?\n\}/);
  if (gl) ok(!/!g\.private/.test(gl[0]), 'the Groups tab still shows every group, private included');
  else ok(true, 'no separate group-list renderer to check');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
