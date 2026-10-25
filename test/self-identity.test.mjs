/* LID-aware self / admin detection. Run: node test/self-identity.test.mjs
   Regression: the bot compared its own participant entry against
   "<number>@s.whatsapp.net" only, so under LID it believed it was never an
   admin anywhere - the portal warned every edit would fail while edits worked. */
import { WhatsAppBot } from '../src/core/bot.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const mkBot = (user) => {
  const b = new WhatsAppBot({ configStore: { get: () => ({ whatsapp: {} }) }, dataDir: '/tmp' });
  b.state = 'connected';
  b.sock = { user };
  return b;
};

console.log('=== isSelf matches every identity form ===');
{
  const bot = mkBot({ id: '15558060189:12@s.whatsapp.net', lid: '99887766554433@lid' });
  ok(bot.isSelf('15558060189@s.whatsapp.net') === true, 'phone JID');
  ok(bot.isSelf('15558060189:12@s.whatsapp.net') === true, 'phone JID with device suffix');
  ok(bot.isSelf('15558060189:7@s.whatsapp.net') === true, 'a different device suffix still matches');
  ok(bot.isSelf('99887766554433@lid') === true, 'the @lid form — the case that was broken');
  ok(bot.isSelf('99887766554433:3@lid') === true, '@lid with a device suffix');
  ok(bot.isSelf('15550000000@s.whatsapp.net') === false, 'someone else is not us');
  ok(bot.isSelf('11112222@lid') === false, "another person's lid is not us");
  ok(bot.isSelf(null) === false, 'null is safe');
  ok(bot.isSelf('garbage') === false, 'garbage is safe');
}
{
  // some builds expose the phone form as `jid` instead
  const bot = mkBot({ id: '55443322110@lid', jid: '15558060189@s.whatsapp.net' });
  ok(bot.isSelf('15558060189@s.whatsapp.net') === true, 'phone form found via user.jid');
  ok(bot.isSelf('55443322110@lid') === true, 'lid-shaped user.id matches');
}

console.log('=== refreshGroups marks admin correctly under LID ===');
{
  const bot = mkBot({ id: '15558060189:12@s.whatsapp.net', lid: '99887766554433@lid' });
  bot.sock.groupFetchAllParticipating = async () => ({
    'a@g.us': { subject: 'Where we are admin (via lid)', participants: [
      { id: '99887766554433@lid', admin: 'admin' },
      { id: '15551112222@lid', admin: null },
    ] },
    'b@g.us': { subject: 'Where we are only a member', participants: [
      { id: '99887766554433@lid', admin: null },
      { id: '15551112222@lid', admin: 'superadmin' },
    ] },
    'c@g.us': { subject: 'Admin via phone JID', participants: [
      { id: '15558060189@s.whatsapp.net', admin: 'superadmin' },
    ] },
  });
  await bot.refreshGroups({ force: true });
  const g = Object.fromEntries(bot.groups().map((x) => [x.jid, x]));
  ok(g['a@g.us'].isAdmin === true, 'admin detected when we appear as @lid (the regression)');
  ok(g['b@g.us'].isAdmin === false, 'not admin where we are a plain member');
  ok(g['c@g.us'].isAdmin === true, 'admin detected when we appear as a phone JID');
}

console.log('=== groupDetails.botIsAdmin agrees ===');
{
  const bot = mkBot({ id: '15558060189:12@s.whatsapp.net', lid: '99887766554433@lid' });
  bot.sock.groupMetadata = async () => ({
    subject: 'G', desc: '', participants: [{ id: '99887766554433@lid', admin: 'admin' }],
  });
  const d = await bot.groupDetails('a@g.us');
  ok(d.botIsAdmin === true, 'botIsAdmin true under LID');
  bot.sock.groupMetadata = async () => ({
    subject: 'G', desc: '', participants: [{ id: '99887766554433@lid', admin: null }],
  });
  ok((await bot.groupDetails('a@g.us')).botIsAdmin === false, 'botIsAdmin false when not admin');
}

console.log('=== isGroupAdmin (used to exempt staff from enforcement) ===');
{
  const bot = mkBot({ id: '15558060189@s.whatsapp.net' });
  bot.groupCache = new Map([['g@g.us', { members: [
    { id: 'boss@lid', number: null, admin: 'superadmin' },
    { id: 'mod@lid', number: '15551112222', admin: 'admin' },
    { id: 'joe@lid', number: '15559998888', admin: null },
  ] }]]);
  ok(bot.isGroupAdmin('g@g.us', { jid: 'boss@lid' }) === true, 'admin matched by lid');
  ok(bot.isGroupAdmin('g@g.us', { number: '15551112222' }) === true, 'admin matched by number');
  ok(bot.isGroupAdmin('g@g.us', { jid: 'joe@lid' }) === false, 'ordinary member is not admin');
  ok(bot.isGroupAdmin('g@g.us', { number: '19999999999' }) === false, 'stranger is not admin');
  ok(bot.isGroupAdmin('missing@g.us', { jid: 'boss@lid' }) === false, 'unknown group -> false');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
