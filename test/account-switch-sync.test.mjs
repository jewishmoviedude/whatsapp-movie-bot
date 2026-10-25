/* Switching numbers must be visible everywhere at once.
   Run: node test/account-switch-sync.test.mjs

   Reported: change the number in Settings because the current one got
   unlinked, go to the Dashboard to link the new one, and the Dashboard still
   names the old number - "not syncing with that manual setting".

   The switch itself worked. stop() left `me` - the CONNECTED identity - set to
   the previous number, and the panel had nothing else to show, so it kept
   naming a number the bot was no longer using. */
import fs from 'node:fs';
import { WhatsAppBot } from '../src/core/bot.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const ACCOUNTS = [
  { id: 'default', label: '+15558060189', phoneNumber: '15558060189' },
  { id: 'christopher-nolan', label: 'Christopher Nolan', phoneNumber: '15558020184' },
];

function bot(activeAccount) {
  return new WhatsAppBot({
    configStore: { get: () => ({ whatsapp: { activeAccount, accounts: ACCOUNTS, autoReconnect: false } }) },
    dataDir: '/tmp/wa-switch-test',
  });
}

console.log('=== a stopped bot is not signed in as anyone ===');
{
  const b = bot('default');
  b.me = { id: '15558060189:1@s.whatsapp.net', name: 'Old Number' };
  b.state = 'connected';

  await b.stop();
  ok(b.me === null, 'stop() clears the connected identity');
  ok(b.status().me === null, 'so the panel is not handed a stale one');
}

console.log('=== status reports which number is SELECTED ===');
{
  // This is the part that was missing: with `me` null there was nothing left
  // to show, so the panel fell back to the last connected identity.
  const b = bot('christopher-nolan');
  const s = b.status();
  ok(s.account?.id === 'christopher-nolan', 'the selected account is reported');
  ok(s.account?.label === 'Christopher Nolan', 'with its label, for the panel to show');
  ok(s.account?.phoneNumber === '15558020184', 'and its number');
  ok(typeof s.account?.linked === 'boolean', 'and whether it still needs linking');
}

console.log('=== switching is reflected immediately, with no connection ===');
{
  const before = bot('default').status();
  const after = bot('christopher-nolan').status();
  ok(before.account.id === 'default', 'before the switch it names the old account');
  ok(after.account.id === 'christopher-nolan', 'after it names the new one');
  ok(after.account.phoneNumber !== before.account.phoneNumber, 'and the number changes with it');
}

console.log('=== the panel shows the selected number when disconnected ===');
{
  const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  ok(/will link as \$\{a\.label\}/.test(app),
    'the dashboard says what it WILL link as, rather than what it last was');
  ok(/already linked/.test(app) && /not linked yet/.test(app),
    'and whether that number still needs linking');
  // The whole if/else chain, not just the first branch.
  const chain = app.match(/if \(s\.me\?\.id\) \{[\s\S]*?\n  \} else \{[\s\S]*?\n  \}/)[0];
  ok(chain.indexOf('s.me?.id') < chain.indexOf('s.account'),
    'a live connection still takes precedence over the configured account');
  ok(/\} else if \(s\.account\)/.test(chain), 'the selected account is the fallback, not the primary');
}

console.log('=== Settings cannot desync which number is active ===');
{
  // Two writers for one fact is how they drifted apart: the dropdown switched
  // the account, and Save settings wrote phoneNumber straight from the same
  // control, so saving could point the pairing flow at one number while the
  // bot ran as another.
  const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  const save = app.match(/whatsapp: \{[\s\S]*?\n    \},/)[0];
  ok(!/phoneNumber: \$\('f-phone'\)/.test(save),
    'the settings save no longer writes phoneNumber from the dropdown');
  ok(/switchAccount\(id, \{ skipConfirm: true \}\)/.test(app),
    'changing the dropdown switches the account instead, which is the single writer');

  const accounts = fs.readFileSync(new URL('../src/core/accounts.js', import.meta.url), 'utf8');
  ok(/patch\.whatsapp\.phoneNumber = digits/.test(accounts) || /phoneNumber: target\.phoneNumber/.test(accounts),
    'and switchAccount keeps phoneNumber in step with the active account');
}

console.log('=== the panel is TOLD when the account changes ===');
{
  // The page does not poll /status - it lives entirely off the SSE stream.
  // Pushing status only on a STATE change meant an account rename, or a switch
  // that left the bot in the same state, never reached it.
  const server = fs.readFileSync(new URL('../src/web/server.js', import.meta.url), 'utf8');
  ok(/configStore\.onChange\(onConfig\)/.test(server), 'the stream listens for config changes');
  ok(/send\('status', bot\.status\(\)\);/.test(server.match(/const onConfig[\s\S]*?\n    \};/)[0]),
    'and pushes a fresh status when they happen');
  ok(/if \(key === lastAccountKey\) return;/.test(server),
    'only when the NUMBERS change — every unrelated settings save would otherwise spam the stream');
  ok(/offConfig\?\.\(\);/.test(server),
    'and it unsubscribes on disconnect, or every reconnecting tab leaks a listener');
}

console.log('=== a rename counts as a change worth pushing ===');
{
  // The label is what the dashboard shows, so renaming an account with the
  // bot sitting still must still reach the page.
  const server = fs.readFileSync(new URL('../src/web/server.js', import.meta.url), 'utf8');
  const keyed = server.match(/const key = JSON\.stringify\(\{[\s\S]*?\}\);/)[0];
  ok(/a\.label/.test(keyed), 'the label is part of the change key');
  ok(/a\.phoneNumber/.test(keyed), 'so is the number');
  ok(/activeAccount/.test(keyed), 'and which one is active');
}

console.log('=== start() resolves the account fresh, not at construction ===');
{
  const src = fs.readFileSync(new URL('../src/core/bot.js', import.meta.url), 'utf8');
  const start = src.match(/async start\(\)[\s\S]*?logger\.info\(`using account/)[0];
  ok(/activeAccount\(this\.config, this\.dataDir\)/.test(start),
    'a switch made while stopped is picked up on the next start');
  ok(/this\.authDir = sessionDirFor/.test(start), 'and the session directory follows it');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
