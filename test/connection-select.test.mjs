/* The "current WhatsApp connection" dropdown. Run: node test/connection-select.test.mjs

   It replaced a free-text phone box. That box looked like it set which number
   the bot runs as, but the bot runs as whichever ACCOUNT is active - so the two
   could silently disagree, and a hand-typed number would be overwritten by the
   next account switch without explanation.

   The dropdown is bound to whatsapp.phoneNumber on save, so its option VALUES
   must stay plain digits or a save would write a label into the config. */
import fs from 'node:fs';
import { parseHTML } from 'linkedom';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');

/* Run the real fillPhoneOptions against a real DOM. */
function build(wa) {
  const { document } = parseHTML('<!doctype html><html><body>'
    + '<select id="f-phone"></select><div id="f-phone-note"></div></body></html>');
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const src = app.match(/function fillPhoneOptions[\s\S]*?\n\}/)[0];
  const helper = app.match(/function accountInUseId[\s\S]*?\n\}/)[0];
  // eslint-disable-next-line no-new-func
  const fn = new Function('$', 'esc', `${helper}\n${src}; return fillPhoneOptions;`)($, esc);
  fn(wa);
  const sel = $('f-phone');
  // linkedom has no HTMLSelectElement.value getter, so read the marked option.
  Object.defineProperty(sel, 'chosen', {
    get: () => [...sel.options].find((o) => o.hasAttribute('selected'))?.value ?? '',
  });
  return { document, sel, note: $('f-phone-note') };
}

const ACCOUNTS = [
  { id: 'default', label: '+15558060189', phoneNumber: '15558060189' },
  { id: 'christopher-nolan', label: 'Christopher Nolan', phoneNumber: '15558020184' },
  { id: 'second-phone', label: 'Second Phone', phoneNumber: '15558110179' },
];

console.log('=== it lists your numbers and marks the live one ===');
{
  const { sel } = build({ accounts: ACCOUNTS, activeAccount: 'second-phone', phoneNumber: '15558110179' });
  ok(sel.options.length === 3, `one option per configured number (${sel.options.length})`);
  const active = [...sel.options].find((o) => o.textContent.includes('in use'));
  ok(active?.textContent.includes('Second Phone'), `the live number is marked: "${active?.textContent}"`);
  ok([...sel.options].filter((o) => o.textContent.includes('in use')).length === 1,
    'and exactly one is marked, so there is no ambiguity about what is connected');
}

console.log('=== the value stays plain digits, so saving cannot corrupt the config ===');
{
  const { sel } = build({ accounts: ACCOUNTS, activeAccount: 'default', phoneNumber: '15558060189' });
  for (const o of sel.options) {
    ok(/^[0-9]*$/.test(o.value), `option value is digits only: "${o.value}"`);
  }
  // app.js saves with: $('f-phone').value.replace(/[^0-9]/g, '')
  ok(sel.chosen === '15558060189', 'and the selected value is the active number');
  ok(sel.chosen.replace(/[^0-9]/g, '') === '15558060189', 'which survives the save transform unchanged');
}

console.log('=== each option carries the account it belongs to ===');
{
  const { sel } = build({ accounts: ACCOUNTS, activeAccount: 'default', phoneNumber: '15558060189' });
  const ids = [...sel.options].map((o) => o.getAttribute('data-id'));
  ok(ids.join(',') === 'default,christopher-nolan,second-phone',
    'so choosing one can switch the ACCOUNT, not just edit a number');
}

console.log('=== a number configured before the accounts list is not silently dropped ===');
{
  // The dangerous case: an old install whose whatsapp.phoneNumber matches no
  // account. Without an option for it the select would fall back to the first
  // entry, and the next save would quietly rewrite the configured number.
  const { sel } = build({ accounts: ACCOUNTS, activeAccount: 'default', phoneNumber: '19998887777' });
  ok(sel.chosen === '19998887777', 'the configured number is still selected');
  ok(sel.options.length === 4, 'it is added as its own option');
  ok([...sel.options][0].textContent.includes('not in your numbers list'),
    'and flagged, rather than looking like a normal choice');
}

console.log('=== a fresh install with no accounts still works ===');
{
  const { sel } = build({ phoneNumber: '15558060189' });
  ok(sel.options.length === 1, 'it invents the default entry');
  ok(sel.chosen === '15558060189', 'and selects the configured number');

  const empty = build({});
  ok(empty.sel.options.length === 1, 'even with nothing configured there is an option');
  ok(empty.sel.chosen === '', 'and no number is invented');
}

console.log('=== a new install marks the number in use, though activeAccount is blank ===');
{
  // schema.js ships activeAccount: ''. The dropdown resolved it with
  // `activeAccount ?? 'default'`, and '' is not missing, so on a new install
  // (whose first account need not be 'default') nothing was marked in use.
  const inUse = (sel) => [...sel.options].filter((o) => o.textContent.includes('in use'));
  const accounts = ACCOUNTS.slice(1);           // first account is NOT 'default'

  const blank = build({ accounts, activeAccount: '', phoneNumber: '15558020184' });
  ok(inUse(blank.sel).length === 1 && inUse(blank.sel)[0].textContent.includes('Christopher Nolan'),
    'a blank activeAccount marks the first number, as listAccounts() does');

  const stale = build({ accounts, activeAccount: 'deleted-number', phoneNumber: '15558020184' });
  ok(inUse(stale.sel).length === 1 && inUse(stale.sel)[0].textContent.includes('Christopher Nolan'),
    'so does one naming a number that no longer exists');
}

console.log('=== the markup and wiring match ===');
{
  ok(/<select id="f-phone"><\/select>/.test(html), 'the field is a select, not a text box');
  ok(!/<input id="f-phone"/.test(html), 'the old free-text box is gone');
  ok(/Current WhatsApp connection/.test(html), 'and it is labelled as the current connection');
  ok(/fillPhoneOptions\(wa\);\n\s+\$\('f-phone'\)\.value/.test(app),
    'options are filled BEFORE the value is set — a select cannot hold a value with no matching option');
  ok(/\$\('f-phone'\)\?\.addEventListener\('change'/.test(app), 'changing it does something');
  ok(/window\.switchAccount\(id, \{ skipConfirm: true \}\)/.test(app),
    'it switches the account rather than only editing a field');
  ok(/if \(!confirm\(/.test(app.match(/\$\('f-phone'\)\?\.addEventListener[\s\S]*?\n\}\);/)[0]),
    'and asks first, since it disconnects the live number');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
