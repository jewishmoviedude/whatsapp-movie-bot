/* Linking a spare number without moving the bot. Run: node test/spare-linker.test.mjs

   The operator's request: "NEED AN OPTION TO CONTROL LINKING FOR FAILOVER
   NUMBERS WITHOUT HAVING TO MANUALLY SWITCH CURRENT CONFIG OF BOT AND
   INTERRUPT SHIT". The only socket that could show a QR was the bot's own, and
   it only ever runs as the active account, so linking a spare meant switching
   the live bot onto it and leaving every group unanswered until someone
   scanned a code and switched back.

   src/core/spare-linker.js links a spare on a short-lived socket of its own.
   What these tests pin is that it cannot hurt the number that is serving:
   never a socket on the active session (rule 3), never a retry loop (rule 2),
   repeated codes paced and bounded (rule 1), nothing processed or posted, and
   no half-finished link that failover could mistake for a spare.

   Baileys is stubbed throughout; nothing here talks to WhatsApp. */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SpareLinker } from '../src/core/spare-linker.js';
import { sessionDirFor, isLinked } from '../src/core/accounts.js';
import { FailoverSupervisor } from '../src/core/failover.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** A fake Baileys that records every socket and the directory it was opened on. */
function fakeBaileys() {
  const f = { sockets: [], authDirs: [] };
  f.mod = {
    Browsers: null,
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
    useMultiFileAuthState: async (dir) => {
      f.authDirs.push(path.resolve(dir));
      const creds = { registered: false };
      return {
        state: { creds, keys: {} },
        saveCreds: async () => fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify({ me: creds.me ?? null })),
      };
    },
    makeWASocket: (opts) => {
      const ev = new EventEmitter();
      const sock = {
        opts,
        ev,
        ended: false,
        end() { this.ended = true; },
        pairingAskedFor: null,
        async requestPairingCode(phone) { this.pairingAskedFor = phone; return 'ABCD1234'; },
      };
      f.sockets.push(sock);
      return sock;
    },
  };
  f.load = async () => f.mod;
  f.last = () => f.sockets[f.sockets.length - 1];
  f.emit = (update) => f.last().ev.emit('connection.update', update);
  f.close = (statusCode) => f.emit({ connection: 'close', lastDisconnect: { error: { output: { statusCode } } } });
  return f;
}

/** A data dir with a main number (active, linked) and one spare. */
function world({ spareLinked = false, active = 'default', loginMethod = 'qr' } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spare-link-'));
  const cfg = {
    whatsapp: {
      activeAccount: active,
      phoneNumber: '15550000001',
      loginMethod,
      accounts: [
        { id: 'default', label: 'Main', phoneNumber: '15550000001' },
        { id: 'backup', label: 'Backup', phoneNumber: '15550000002' },
      ],
    },
  };
  const configStore = { get: () => cfg };
  const mainDir = sessionDirFor(dataDir, 'default');
  fs.mkdirSync(mainDir, { recursive: true });
  fs.writeFileSync(path.join(mainDir, 'creds.json'), '{"main":true}');
  if (spareLinked) {
    const d = sessionDirFor(dataDir, 'backup');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'creds.json'), '{"old":true}');
  }
  const bot = new EventEmitter();
  bot.dataDir = dataDir;
  bot.authDir = sessionDirFor(dataDir, active);
  bot.paced = 0;
  bot._bulkPace = async () => { bot.paced += 1; };
  const healthy = [];
  const failover = { switching: null, _switchBusy: false, markHealthy: (id) => healthy.push(id) };
  const baileys = fakeBaileys();
  const linker = new SpareLinker({
    bot, configStore, failover, loadBaileys: baileys.load, settleMs: 0, maxSockets: 3, timeoutMs: 60_000,
  });
  const changes = [];
  linker.on('change', (s) => changes.push(s));
  return { dataDir, cfg, configStore, bot, failover, baileys, linker, changes, healthy, mainDir };
}

/** Walk a link through scan, restart and login, as WhatsApp does it. */
async function scanAndLogin(w) {
  w.baileys.emit({ isNewLogin: true, qr: undefined });
  w.baileys.last().ev.emit('creds.update', {});
  w.baileys.close(515);                       // restartRequired
  await tick(20);
  w.baileys.emit({ connection: 'open' });
  await tick(20);
}

console.log('=== the number in use can never be linked in the background ===');
{
  const w = world();
  const r = await w.linker.start('default');
  ok(!r.ok, `refused: ${r.error}`);
  ok(w.baileys.sockets.length === 0, 'and no socket was opened');
  ok(fs.readFileSync(path.join(w.mainDir, 'creds.json'), 'utf8') === '{"main":true}', 'its session is untouched');
}

console.log('=== nor the session the bot socket is actually on, mid-switch ===');
{
  // Config already names the new number, but the socket was opened on the
  // spare's directory: the directory is the truth.
  const w = world();
  w.bot.authDir = sessionDirFor(w.dataDir, 'backup');
  const r = await w.linker.start('backup');
  ok(!r.ok && /session/.test(r.error), `refused: ${r.error}`);
  ok(w.baileys.sockets.length === 0, 'no socket');
}

console.log('=== nor while failover is switching numbers ===');
{
  const w = world();
  w.failover._switchBusy = true;
  const r = await w.linker.start('backup');
  ok(!r.ok && /switch/.test(r.error), `refused: ${r.error}`);
  ok(w.baileys.sockets.length === 0, 'no socket');
}

console.log('=== a spare links on its own socket, in staging, with nothing wired to the bot ===');
{
  const w = world();
  const botMessages = [];
  w.bot.on('message', (m) => botMessages.push(m));
  const r = await w.linker.start('backup');
  ok(r.ok, 'accepted');
  await tick(20);
  ok(w.baileys.sockets.length === 1, 'one socket opened');
  const staging = path.resolve(w.linker.stagingDirFor('backup'));
  ok(w.baileys.authDirs[0] === staging, 'on the staging directory');
  ok(!w.baileys.authDirs.includes(path.resolve(w.mainDir)), 'never on the active session');
  ok(!w.baileys.authDirs.includes(path.resolve(sessionDirFor(w.dataDir, 'backup'))),
    'nor on the spare\'s own directory, so a half-link cannot look "linked"');
  const sock = w.baileys.last();
  ok(sock.ev.listenerCount('messages.upsert') === 0, 'it listens for no messages');
  ok(sock.opts.markOnlineOnConnect === false, 'and does not show the spare online');
  ok(sock.opts.syncFullHistory === false, 'nor pull its history');

  w.baileys.emit({ qr: 'fake-qr-payload' });
  await tick(300);                            // the first QR render loads the encoder
  const snap = w.linker.snapshot().backup;
  ok(snap.state === 'awaiting-qr', `the QR is on offer (${snap.state})`);
  ok(/^data:image\/png;base64,/.test(snap.qr ?? ''), 'as an image the panel can draw');
  ok(w.changes.some((c) => c.backup?.state === 'awaiting-qr'), 'and was pushed, since the panel does not poll');
  ok(!isLinked(w.dataDir, 'backup'), 'not linked yet');

  await scanAndLogin(w);
  const done = w.linker.snapshot().backup;
  ok(done.state === 'linked', `linked (${done.state}${done.error ? `: ${done.error}` : ''})`);
  ok(w.baileys.sockets.length === 2, 'exactly one reconnect: the login WhatsApp asks for after the scan');
  // The first socket was closed by WhatsApp (the 515); the login socket is
  // the one the linker must close itself.
  ok(w.baileys.last().ended, 'and the login socket is closed afterwards, not left running');
  ok(isLinked(w.dataDir, 'backup'), 'the spare now has a session of its own');
  ok(!fs.existsSync(staging), 'moved out of staging');
  ok(fs.readFileSync(path.join(w.mainDir, 'creds.json'), 'utf8') === '{"main":true}', 'the main number was never touched');
  ok(w.healthy.includes('backup'), 'failover is told the number is usable again');
  ok(botMessages.length === 0, 'and the bot heard nothing from the linking socket');
}

console.log('=== a re-link keeps the old session until the new one works ===');
{
  const w = world({ spareLinked: true });
  const target = sessionDirFor(w.dataDir, 'backup');
  await w.linker.start('backup');
  await tick(20);
  w.baileys.emit({ qr: 'q' });
  await tick(20);
  await w.linker.cancel('backup');
  ok(fs.readFileSync(path.join(target, 'creds.json'), 'utf8') === '{"old":true}', 'cancelled: the old session is exactly as it was');
  ok(w.baileys.last().ended, 'the socket is closed');
  ok(!fs.existsSync(w.linker.stagingDirFor('backup')), 'and staging is cleared');
  ok(w.linker.snapshot().backup.state === 'cancelled', 'reported as cancelled');

  await w.linker.start('backup');
  await tick(20);
  await scanAndLogin(w);
  ok(w.linker.snapshot().backup.state === 'linked', 'a second attempt links');
  ok(fs.readFileSync(path.join(`${target}.previous`, 'creds.json'), 'utf8') === '{"old":true}',
    'the replaced session is kept beside it, not deleted');
}

console.log('=== unscanned codes are re-offered, paced and bounded — never a loop ===');
{
  const w = world();
  await w.linker.start('backup');
  await tick(20);
  for (let i = 0; i < 6; i++) { w.baileys.close(408); await tick(20); }
  const s = w.linker.snapshot().backup;
  ok(w.baileys.sockets.length === 3, `stops at the cap (${w.baileys.sockets.length} sockets for 6 expiries)`);
  ok(s.state === 'expired', `and gives up plainly (${s.state}: ${s.error})`);
  ok(w.bot.paced >= 2, `each fresh code waited on _bulkPace (${w.bot.paced})`);
  ok(!fs.existsSync(w.linker.stagingDirFor('backup')), 'staging cleared');
  ok(!isLinked(w.dataDir, 'backup'), 'nothing half-linked left behind');
}

console.log('=== any other close is reported, not retried ===');
{
  for (const code of [401, 440, 428, 500]) {
    const w = world();
    await w.linker.start('backup');
    await tick(20);
    w.baileys.close(code);
    await tick(20);
    ok(w.baileys.sockets.length === 1 && w.linker.snapshot().backup.state === 'failed',
      `close ${code}: failed after one socket`);
  }
}

console.log('=== one link at a time ===');
{
  const w = world();
  w.cfg.whatsapp.accounts.push({ id: 'third', label: 'Third', phoneNumber: '15550000003' });
  await w.linker.start('backup');
  const r = await w.linker.start('third');
  ok(!r.ok && r.busy, `a second link is refused while one runs: ${r.error}`);
}

console.log('=== a link nobody finishes is torn down ===');
{
  const w = world();
  w.linker.timeoutMs = 40;
  await w.linker.start('backup');
  await tick(20);
  w.baileys.emit({ qr: 'q' });
  await tick(60);
  ok(w.linker.snapshot().backup.state === 'expired', 'expired on the timeout');
  ok(w.baileys.last().ended, 'and its socket closed');
  ok(!w.linker.busy(), 'nothing left running');
}

console.log('=== a pairing code goes to the spare\'s own digits ===');
{
  const w = world({ loginMethod: 'pairing' });
  await w.linker.start('backup');
  await tick(20);
  w.baileys.emit({ qr: 'q' });
  await tick(20);
  w.baileys.emit({ qr: 'q2' });               // a QR refresh must not ask again
  await tick(20);
  ok(w.baileys.last().pairingAskedFor === '15550000002',
    `sent to the spare (+${w.baileys.last().pairingAskedFor}), not to whatsapp.phoneNumber`);
  const s = w.linker.snapshot().backup;
  ok(s.state === 'awaiting-pairing' && s.pairingCode === 'ABCD-1234', `shown as ${s.pairingCode}`);
  ok(s.qr === null, 'with no QR beside it');
  await w.linker.cancelAll();
}

console.log('=== failover will not switch to a number being linked ===');
{
  const w = world({ spareLinked: true });
  const fo = new FailoverSupervisor({ bot: w.bot, configStore: w.configStore });
  fo.linker = w.linker;
  const spare = fo.ranked().find((a) => a.id === 'backup');
  ok(fo.eligible(spare), 'a linked spare is eligible normally');
  await w.linker.start('backup');
  ok(!fo.eligible(spare), 'but not while it is being re-linked');
  ok(fo.status().accounts.find((a) => a.id === 'backup').linking === true, 'and the panel is told it is linking');
  const r = await fo.switchToAccount('backup');
  ok(!r.ok && /being linked/.test(r.error), `a manual switch is refused too: ${r.error}`);
  await w.linker.cancelAll();
  ok(fo.eligible(spare), 'eligible again once the link is cancelled');
}

console.log('=== nothing changes for an operator who never uses it ===');
{
  const w = world({ spareLinked: true });
  const fo = new FailoverSupervisor({ bot: w.bot, configStore: w.configStore });
  const spare = fo.ranked().find((a) => a.id === 'backup');
  ok(fo.eligible(spare), 'failover without a linker behaves as before');
  ok(fo.status().accounts.find((a) => a.id === 'backup').linking === false, 'and reports nothing linking');
}

console.log('=== the wiring the unit tests cannot reach ===');
{
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  const bot = read('../src/core/bot.js');
  const start = bot.slice(bot.indexOf('  async _start() {'), bot.indexOf('this.sock = makeWASocket({'));
  ok(/spareLinker\?\.isLinking\?\.\(this\.activeAccountId\)/.test(start)
    && /spareLinker\.cancel\(/.test(start),
  'the bot cancels a link for the number it is about to connect as, before it opens a socket');

  const api = read('../src/web/api.js');
  const activate = api.slice(api.indexOf("router.post('/wa/accounts/:id/activate'"), api.indexOf("router.get('/wa/status'"));
  ok(/spareLinker\?\.isLinking\(req\.params\.id\)/.test(activate), 'a manual switch to a number being linked is refused');
  const link = api.slice(api.indexOf("router.post('/wa/accounts/:id/link'"), api.indexOf("router.delete('/wa/accounts/:id/link'"));
  ok(/switchInFlight \|\| failover\?\.switching/.test(link), 'linking is refused while a switch is in flight');

  const server = read('../src/web/server.js');
  ok(/spareLinker\?\.on\('change', onSpares\)/.test(server) && /spareLinker\?\.off\('change', onSpares\)/.test(server),
    'link progress is pushed over /events, and the listener is removed with the stream');

  const idx = read('../src/index.js');
  ok(/failover\.linker = spareLinker/.test(idx) && /bot\.spareLinker = spareLinker/.test(idx), 'index.js wires both guards');
  ok(/spareLinker\.cancelAll\(\)/.test(idx), 'and closes any link on shutdown');

  const src = read('../src/core/spare-linker.js');
  ok(!/messages\.upsert|sendMessage|groupFetch/.test(src.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')),
    'the linker has no message handling or send path at all');
}

console.log('=== the panel: status and buttons per number ===');
{
  const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pick = (name) => app.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))[0];
  // eslint-disable-next-line no-new-func
  const fns = new Function('esc', `${pick('spareLinkLive')}\n${pick('spareLinkPill')}\n${pick('spareLinkButtons')}\n${pick('spareLinkBox')}
    return { spareLinkPill, spareLinkButtons, spareLinkBox };`)(esc);

  const main = { id: 'default', label: 'Main', active: true, linked: true };
  const spare = { id: 'backup', label: 'Backup', active: false, linked: false };
  const linkedSpare = { ...spare, linked: true };
  ok(fns.spareLinkButtons(main, null) === '', 'no background Link on the number in use');
  ok(/>Link</.test(fns.spareLinkButtons(spare, null)), 'an unlinked spare offers Link');
  ok(/>Re-link</.test(fns.spareLinkButtons(linkedSpare, null)), 'a linked one offers Re-link');
  ok(/Cancel link/.test(fns.spareLinkButtons(spare, { state: 'awaiting-qr' })), 'a running link offers Cancel');
  ok(/linking…/.test(fns.spareLinkPill(spare, { state: 'starting' })), 'status: linking…');
  ok(/>linked</.test(fns.spareLinkPill(linkedSpare, { state: 'linked' })), 'status: linked');
  ok(/not linked/.test(fns.spareLinkPill(spare, { state: 'failed' })), 'status: not linked');
  ok(/<img src="data:image\/png;base64,X"/.test(fns.spareLinkBox(spare, { state: 'awaiting-qr', qr: 'data:image/png;base64,X' })),
    'the QR is drawn on the spare\'s own row');
  ok(/ABCD-1234/.test(fns.spareLinkBox(spare, { state: 'awaiting-pairing', pairingCode: 'ABCD-1234' })), 'and so is a pairing code');
  ok(/timed out/.test(fns.spareLinkBox(spare, { state: 'expired', error: '3 codes went unscanned' })), 'an abandoned attempt says so');
  ok(/es\.addEventListener\('spares'/.test(app), 'the panel listens for the push');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
