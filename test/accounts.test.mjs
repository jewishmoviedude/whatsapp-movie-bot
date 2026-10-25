/* Multiple WhatsApp numbers with independent sessions.
   Run: node test/accounts.test.mjs

   Why: a single hardcoded session directory meant one number, so a linking
   problem took the whole bot down with no way back. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  listAccounts, activeAccount, sessionDirFor, isLinked,
  addAccount, removeAccount, switchAccount, accountId, updateAccount,
} from '../src/core/accounts.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accts-'));
const apply = (cfg, patch) => ({ whatsapp: { ...cfg.whatsapp, ...patch.whatsapp } });

console.log('=== an existing single-number install is untouched ===');
{
  const legacy = { whatsapp: { phoneNumber: '15558060189' } };
  const all = listAccounts(legacy, tmp);
  ok(all.length === 1 && all[0].id === 'default', 'one implicit "default" account');
  ok(all[0].active === true, 'and it is active');
  ok(all[0].label === '+15558060189', 'labelled with the configured number');
  // CRITICAL: the default account must keep using data/session, or upgrading
  // would silently look in an empty directory and demand a re-link.
  ok(sessionDirFor('/data', 'default') === path.join('/data', 'session'), 'default still uses data/session');
  ok(sessionDirFor('/data', 'backup') === path.join('/data', 'sessions', 'backup'), 'others use data/sessions/<id>');
}

console.log('=== adding a backup ===');
{
  let cfg = { whatsapp: { phoneNumber: '15558060189' } };
  const { id, patch } = addAccount(cfg, { label: 'Backup', phoneNumber: '1 (555) 802-0184' });
  cfg = apply(cfg, patch);
  ok(id === 'backup', 'id derived from the label');
  ok(cfg.whatsapp.accounts.length === 2, 'both numbers stored');
  ok(cfg.whatsapp.accounts[1].phoneNumber === '15558020184', 'number normalised to digits');
  ok(listAccounts(cfg, tmp)[0].active, 'the original stays active until switched');

  let threw = null;
  try { addAccount(cfg, { label: 'Dup', phoneNumber: '15558020184' }); } catch (e) { threw = e; }
  ok(/already set up/.test(threw?.message ?? ''), 'the same number cannot be added twice');
}

console.log('=== switching ===');
{
  let cfg = { whatsapp: { phoneNumber: '15558060189' } };
  cfg = apply(cfg, addAccount(cfg, { label: 'Backup', phoneNumber: '15558020184' }).patch);
  const { target, patch } = switchAccount(cfg, 'backup');
  cfg = apply(cfg, patch);
  ok(target.id === 'backup', 'returns which account was chosen');
  ok(activeAccount(cfg, tmp).id === 'backup', 'the backup is now active');
  ok(cfg.whatsapp.phoneNumber === '15558020184', 'whatsapp.phoneNumber follows, so pairing targets the right number');
  ok(sessionDirFor(tmp, activeAccount(cfg, tmp).id).endsWith(path.join('sessions', 'backup')), 'and it uses its own session directory');

  // switching back must not lose the original
  cfg = apply(cfg, switchAccount(cfg, 'default').patch);
  ok(activeAccount(cfg, tmp).id === 'default', 'switching back works');
  ok(cfg.whatsapp.accounts.length === 2, 'both accounts survive a round trip');

  let threw = null;
  try { switchAccount(cfg, 'nope'); } catch (e) { threw = e; }
  ok(/no such account/.test(threw?.message ?? ''), 'an unknown id is rejected');
}

console.log('=== linked detection is per account ===');
{
  const dir = fs.mkdtempSync(path.join(tmp, 'd-'));
  ok(isLinked(dir, 'default') === false, 'not linked before any credentials exist');
  fs.mkdirSync(path.join(dir, 'session'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'session', 'creds.json'), '{}');
  ok(isLinked(dir, 'default') === true, 'linked once creds.json is written');
  ok(isLinked(dir, 'backup') === false, 'a different account is still unlinked — sessions are independent');
}

console.log('=== removing ===');
{
  let cfg = { whatsapp: { phoneNumber: '15558060189' } };
  cfg = apply(cfg, addAccount(cfg, { label: 'Backup', phoneNumber: '15558020184' }).patch);

  let threw = null;
  try { removeAccount(cfg, 'default'); } catch (e) { threw = e; }
  ok(/switch to another number/.test(threw?.message ?? ''), 'the number in use cannot be removed out from under the bot');

  cfg = apply(cfg, removeAccount(cfg, 'backup').patch);
  ok(cfg.whatsapp.accounts.length === 1, 'the inactive one is removed');

  threw = null;
  try { removeAccount(cfg, 'default'); } catch (e) { threw = e; }
  ok(/only account/.test(threw?.message ?? ''), 'the last account cannot be removed');
}

console.log('=== ids stay unique and filesystem-safe ===');
{
  ok(accountId('Backup #2!') === 'backup-2', 'punctuation stripped');
  ok(accountId('Backup', [{ id: 'backup' }]) === 'backup-2', 'collisions get a suffix');
  ok(accountId('') === 'account', 'an empty label still yields an id');
  ok(!/[\\/]/.test(accountId('a/b\\c')), 'never contains a path separator');
}

console.log('=== the bot resolves its session from the active account ===');
{
  const src = fs.readFileSync(new URL('../src/core/bot.js', import.meta.url), 'utf8');
  ok(/this\.authDir = sessionDirFor\(this\.dataDir, acct\?\.id\)/.test(src), 'authDir is resolved per connection');
  ok(/const acct = activeAccount\(this\.config, this\.dataDir\)/.test(src), 'from the live config, so a switch applies without a restart');
  ok(!/this\.authDir = path\.join\(dataDir, 'session'\);\s*\n\s*this\.sock/.test(src), 'no longer hardcoded to one directory');
}

console.log('=== a backup number can be renamed and corrected ===');
{
  const cfg = { whatsapp: { activeAccount: 'default', phoneNumber: '15558060189', accounts: [
    { id: 'default', label: '+15558060189', phoneNumber: '15558060189' },
    { id: 'nolan', label: 'Christopher Nolan', phoneNumber: '15558020184' },
  ] } };

  const { target, patch } = updateAccount(cfg, 'nolan', { label: 'Backup #1', phoneNumber: '+1 (555) 802-0184' });
  ok(target.label === 'Backup #1', 'the name changes');
  ok(target.phoneNumber === '15558020184', 'and the digits are normalised out of a formatted number');
  ok(patch.whatsapp.accounts.length === 2, 'the other numbers are untouched');
  ok(patch.whatsapp.accounts[0].label === '+15558060189', 'including the one in use');
  ok(patch.whatsapp.phoneNumber === undefined,
    'editing a BACKUP does not repoint the pairing number, which belongs to the active one');
}

console.log('=== editing the number in use keeps the pairing number in step ===');
{
  const cfg = { whatsapp: { activeAccount: 'nolan', phoneNumber: '15558020184', accounts: [
    { id: 'default', label: 'Main', phoneNumber: '15558060189' },
    { id: 'nolan', label: 'Christopher Nolan', phoneNumber: '15558020184' },
  ] } };
  const { patch } = updateAccount(cfg, 'nolan', { phoneNumber: '15558020170' });
  ok(patch.whatsapp.phoneNumber === '15558020170',
    'a pairing code would go to the corrected number, not the old one');
}

console.log('=== on a new install, editing the number in use sets the pairing number too ===');
{
  // A new install's activeAccount is '' - present, not missing - so the old
  // `activeAccount ?? 'default'` never fell back to 'default'. Edit filled in
  // the numbers list and left whatsapp.phoneNumber blank, and Link / Connect
  // failed with "Set your WhatsApp phone number in Settings before linking",
  // on exactly the path the fresh-install checklist sends people down.
  const fresh = { whatsapp: { accounts: [], activeAccount: '', phoneNumber: '' } };
  const { patch } = updateAccount(fresh, 'default', { label: 'Main', phoneNumber: '+1 555 123 0000' });
  ok(patch.whatsapp.phoneNumber === '15551230000', 'the only number, edited, becomes the pairing number');

  // With numbers listed and none chosen, the first is the one in use - the
  // same rule listAccounts() and the bot follow.
  const unchosen = { whatsapp: { activeAccount: '', phoneNumber: '', accounts: [
    { id: 'main', label: 'Main', phoneNumber: '' },
    { id: 'spare', label: 'Spare', phoneNumber: '15551239999' },
  ] } };
  ok(updateAccount(unchosen, 'main', { phoneNumber: '15551230000' }).patch.whatsapp.phoneNumber === '15551230000',
    'with none chosen, the first number is the one in use');
  ok(updateAccount(unchosen, 'spare', { phoneNumber: '15551238888' }).patch.whatsapp.phoneNumber === undefined,
    'and editing the spare still leaves the pairing number alone');
}

console.log('=== editing a number never unlinks it ===');
{
  // The session lives in a directory keyed by account ID. If an edit could
  // move it, correcting a typo would silently require a re-link.
  const dir = path.join(tmp, 'sessions', 'nolan');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'creds.json'), '{}');
  ok(isLinked(tmp, 'nolan') === true, 'linked before the edit');

  const cfg = { whatsapp: { activeAccount: 'default', accounts: [
    { id: 'default', label: 'Main', phoneNumber: '15558060189' },
    { id: 'nolan', label: 'Christopher Nolan', phoneNumber: '15558020184' },
  ] } };
  const { patch } = updateAccount(cfg, 'nolan', { label: 'Renamed', phoneNumber: '19998887777' });
  ok(patch.whatsapp.accounts.find((a) => a.id === 'nolan').id === 'nolan',
    'the id is stable, so the session directory does not move');
  ok(isLinked(tmp, 'nolan') === true, 'still linked after the edit');
  ok(sessionDirFor(tmp, 'nolan') === dir, 'and points at the same directory');
}

console.log('=== bad edits are refused rather than half-applied ===');
{
  const cfg = { whatsapp: { accounts: [{ id: 'a', label: 'A', phoneNumber: '15558060189' }] } };
  let threw = null;
  try { updateAccount(cfg, 'a', { phoneNumber: '123' }); } catch (e) { threw = e; }
  ok(!!threw, 'a number too short to be real is rejected');

  threw = null;
  try { updateAccount(cfg, 'nope', { label: 'x' }); } catch (e) { threw = e; }
  ok(/no such account/.test(threw?.message ?? ''), 'and so is an unknown account');

  const kept = updateAccount(cfg, 'a', { label: '   ' });
  ok(kept.target.label === 'A', 'a blank name keeps the existing one rather than leaving it nameless');

  const clearNum = updateAccount(cfg, 'a', { phoneNumber: '' });
  ok(clearNum.target.phoneNumber === '', 'but a number CAN be cleared deliberately');
}

console.log('=== the portal shows linked state and reach separately ===');
{
  const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  const fn = app.match(/function renderFailover[\s\S]*?\n\}/)[0];
  ok(/const link = /.test(fn) && /const reach = /.test(fn),
    'linked state and group coverage are computed separately');
  ok(/const ready = `\$\{link\}\$\{reach\}`/.test(fn),
    'and BOTH are shown — coverage no longer hides whether the number is even linked');
  ok(/pill ok">linked</.test(fn), 'a linked number says so');
  ok(/not linked — cannot take over/.test(fn), 'and an unlinked one says what that means');
  ok(/editAccount\('\$\{esc\(a\.id\)\}'\)/.test(fn), 'each number can be edited from the failover list');

  const api = fs.readFileSync(new URL('../src/web/api.js', import.meta.url), 'utf8');
  ok(/router\.put\('\/wa\/accounts\/:id'/.test(api), 'and there is a route to save the edit');
  ok(/edited WhatsApp number/.test(api), 'which is audited');
}

console.log('=== startup looks at the ACTIVE account, not the default one ===');
{
  // The bug this covers: data/session was hardcoded, so after a restart on any
  // other number the bot checked the wrong folder, concluded it had never been
  // linked, and sat offline with a perfectly good session for the number in
  // use. It happened for real - the default account was wiped by a logout
  // while a fully-linked spare was the one selected.
  const idx = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  ok(/sessionDirFor\(DATA_DIR, activeAccount\(configStore\.get\(\), DATA_DIR\)\.id\)/.test(idx),
    'the auto-connect check resolves the active account\'s directory, the way bot.start() does');
  ok(!/const sessionDir = path\.join\(DATA_DIR, 'session'\)/.test(idx),
    'and the hardcoded default path is gone');

  // And the helper it now uses really does point somewhere different.
  ok(sessionDirFor(tmp, 'default') !== sessionDirFor(tmp, 'spare'),
    'the two accounts genuinely resolve to different folders');
  ok(sessionDirFor(tmp, 'default').endsWith('session'),
    'the default keeps data/session, so an existing install does not re-link');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
