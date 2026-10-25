// A new install links with a QR code, not a pairing code (the operator,
// 2026-10-06: "default should be link with qr not default link with pairing
// code"). A pairing code goes only to whatsapp.phoneNumber, which is blank on
// a new box, so pairing as the default left the first link with nowhere to go.
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';

let failed = 0;
function ok(cond, name) { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) failed++; }

ok(DEFAULT_CONFIG.whatsapp.loginMethod === 'qr', 'the default link method is QR');
ok(mergeDefaults({}, DEFAULT_CONFIG).whatsapp.loginMethod === 'qr', 'a config with nothing saved links with QR');
ok(mergeDefaults({ whatsapp: { loginMethod: 'pairing' } }, DEFAULT_CONFIG).whatsapp.loginMethod === 'pairing',
  'a box that chose pairing keeps it');

const html = readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
const sel = html.slice(html.indexOf('id="f-loginmethod"'));
ok(sel.indexOf('value="qr"') < sel.indexOf('value="pairing"'), 'the panel lists QR first');

const app = readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
ok(!/loginMethod \?\? 'pairing'|loginMethod \|\| 'pairing'/.test(app), 'the panel never falls back to pairing');

// QR stays the default; the pairing code is the backup, offered beside the QR
// for one link (the operator, 2026-10-25: "Default should be pairing with QR,
// the code as a backup option (code usually fails from my experience)").
ok(/value="qr">[^<]*recommended/.test(sel) && /value="pairing">[^<]*backup/.test(sel), 'the setting says QR is recommended and the code is the backup');
const qrBox = app.slice(app.indexOf("s.state === 'awaiting-qr' && s.qr"), app.indexOf("s.state === 'connecting' && s.nextReconnectAt", app.indexOf("s.state === 'awaiting-qr' && s.qr")));
ok(/onclick="linkWith\('pairing'\)">Can't scan\? Use a pairing code instead/.test(qrBox), 'the QR box offers a pairing code as the backup');
const pairBox = app.slice(app.indexOf("s.state === 'awaiting-pairing' && s.pairingCode"), app.indexOf("s.state === 'awaiting-qr' && s.qr"));
ok(/onclick="linkWith\('qr'\)"/.test(pairBox), 'and a pairing code that fails can go back to a QR');
ok(/linkSpareWith\('\$\{esc\(a\.id\)\}', 'pairing'\)/.test(app) && /linkSpareWith\('\$\{esc\(a\.id\)\}', 'qr'\)/.test(app), 'a spare number gets the same choice');
const linkWith = app.slice(app.indexOf('window.linkWith'), app.indexOf('window.linkSpareWith'));
ok(/'\/wa\/start', \{ method \}/.test(linkWith) && !/loginMethod/.test(linkWith), 'the switch asks for one link and never changes the saved setting');

const api = readFileSync(new URL('../src/web/api.js', import.meta.url), 'utf8');
const start = api.slice(api.indexOf("router.post('/wa/start'"), api.indexOf("router.post('/wa/stop'"));
ok(/method === 'pairing' \|\| method === 'qr'\) bot\.loginOverride = method/.test(start), 'Connect takes the method for this link only');
ok(!/configStore\.update/.test(start), 'and saves nothing');

const bot = readFileSync(new URL('../src/core/bot.js', import.meta.url), 'utf8');
ok(/const usePairing = \(this\.loginOverride \?\? cfg\.loginMethod\) === 'pairing'/.test(bot), 'the bot links the way it was asked, else by the setting');
const open = bot.slice(bot.indexOf("if (connection === 'open') {"), bot.indexOf("if (connection === 'open') {") + 600);
ok(/this\.loginOverride = null/.test(open), 'and once linked, the next link goes back to the setting (QR)');

if (failed) process.exit(1);
