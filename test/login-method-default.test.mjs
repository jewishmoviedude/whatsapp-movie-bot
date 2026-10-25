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

if (failed) process.exit(1);
