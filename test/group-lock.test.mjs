/* Per-group lock/unlock from the Groups tab. Run: node test/group-lock.test.mjs

   Previously lock/unlock existed only as a bulk "all groups" action, so an
   admin could not close a single group from its own page. */
import fs from 'node:fs';
import { WhatsAppBot } from '../src/core/bot.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const mkBot = (announce = false, alwaysLocked = []) => {
  const bot = new WhatsAppBot({
    configStore: { get: () => ({ whatsapp: {}, lockdown: { alwaysLocked } }) },
    dataDir: '/tmp',
  });
  bot.state = 'connected';
  bot.calls = [];
  bot.sock = {
    user: { id: '1@s.whatsapp.net' },
    groupMetadata: async () => ({
      subject: 'G', desc: '', announce, participants: [{ id: '1@s.whatsapp.net', admin: 'admin' }],
    }),
    groupSettingUpdate: async (jid, mode) => { bot.calls.push({ jid, mode }); },
  };
  return bot;
};

console.log('=== the group detail reports its real lock state ===');
{
  const open = await mkBot(false).groupDetails('g@g.us');
  ok(open.locked === false, 'an open group reports locked:false');
  const shut = await mkBot(true).groupDetails('g@g.us');
  ok(shut.locked === true, 'an announcement-mode group reports locked:true');
}

console.log('=== always-locked groups are flagged ===');
{
  const d = await mkBot(true, ['g@g.us']).groupDetails('g@g.us');
  ok(d.alwaysLocked === true, 'flagged, so an admin knows bulk unlock will skip it');
  const other = await mkBot(true, ['someone-else@g.us']).groupDetails('g@g.us');
  ok(other.alwaysLocked === false, 'a group not on the list is not flagged');
}

console.log('=== locking and unlocking one group ===');
{
  const bot = mkBot(false);
  await bot.setGroupLocked('g@g.us', true);
  ok(bot.calls[0].mode === 'announcement', 'lock sets announcement mode');
  ok(bot.calls[0].jid === 'g@g.us', 'targets just that group');
  await bot.setGroupLocked('g@g.us', false);
  ok(bot.calls[1].mode === 'not_announcement', 'unlock clears it');
  ok(bot.calls.length === 2, 'no other group was touched');
}

console.log('=== the route and UI exist ===');
{
  const api = fs.readFileSync(new URL('../src/web/api.js', import.meta.url), 'utf8');
  const block = api.match(/router\.post\('\/groups\/:jid\/lock'[\s\S]*?\n  \}\);/)[0];
  ok(/setGroupLocked\(req\.params\.jid, locked\)/.test(block), 'the route locks the requested group');
  ok(/audit\(req, `\$\{locked \? 'locked' : 'unlocked'\}/.test(block), 'the action is attributed in the audit log');
  ok(/friendlyGroupError/.test(block), 'a WhatsApp rejection is reported readably');

  const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
  ok(/id="ga-lock"/.test(html) && /id="ga-unlock"/.test(html), 'the group panel has lock and unlock buttons');
  ok(/id="ga-lock-state"/.test(html), 'and shows the current state');

  const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  ok(/renderLockState\(d\)/.test(app), 'the state is rendered when a group is opened');
  ok(/\$\('ga-lock'\)\.disabled = !!d\.locked/.test(app), 'the lock button is disabled when already locked');
  ok(/alwaysLocked/.test(app), 'always-locked groups are called out in the UI');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
