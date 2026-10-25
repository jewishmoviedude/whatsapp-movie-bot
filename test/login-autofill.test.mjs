/* The sign-in form must look like a sign-in form to a password manager.
   Run: node test/login-autofill.test.mjs

   Reported from mobile: 1Password filled the username and left the password
   empty. Three things were fighting it - autocomplete="off" on the form
   overriding the per-field hints, no `name` attributes (what most managers
   actually match on), and a second password input which makes a form look
   like REGISTRATION rather than sign-in. */
import fs from 'node:fs';
import { parseHTML } from 'linkedom';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);

const form = document.getElementById('gate-form');
const user = document.getElementById('gate-user');
const pw = document.getElementById('gate-pw');
const pw2 = document.getElementById('gate-pw2');

console.log('=== the form does not suppress autofill ===');
{
  ok(!!form, 'the sign-in form exists');
  ok(form.getAttribute('autocomplete') !== 'off',
    'autocomplete="off" is gone — it overrode the per-field hints below it');
  ok(form.tagName === 'FORM', 'it is a real form, not a div — managers look for one');
}

console.log('=== both fields carry the hints a manager reads ===');
{
  ok(user.getAttribute('autocomplete') === 'username', 'the username field is marked as such');
  ok(pw.getAttribute('autocomplete') === 'current-password',
    'and the password as an EXISTING password, not a new one');
  ok(pw.getAttribute('type') === 'password', 'it is a real password input');
}

console.log('=== name attributes, which is what most managers match on ===');
{
  // With only ids, 1Password filled the username and left the password alone.
  ok(user.getAttribute('name') === 'username', 'the username field has name="username"');
  ok(pw.getAttribute('name') === 'password', 'and the password has name="password"');
}

console.log('=== one password field, so it reads as sign-in not registration ===');
{
  // Two password inputs is the signature of a signup form, and a manager
  // offering to SAVE a new login instead of filling the saved one is exactly
  // the reported symptom.
  ok(pw2.hasAttribute('disabled'),
    'the confirm field is disabled while hidden, so the form parses as sign-in');
  ok(pw2.getAttribute('autocomplete') === 'new-password',
    'and is marked new-password for when it IS used, during first-run setup');

  const active = [...form.querySelectorAll('input[type=password]')].filter((i) => !i.hasAttribute('disabled'));
  ok(active.length === 1, `exactly one live password field (${active.length})`);
}

console.log('=== the disabled flag is kept in step with hidden ===');
{
  // Leaving it disabled during first-run setup would make the confirm field
  // unusable; leaving it enabled the rest of the time reintroduces the bug.
  ok(/\$\('gate-pw2'\)\.disabled = true;/.test(app), 'disabled when hidden');
  ok(/\$\('gate-pw2'\)\.disabled = false;/.test(app), 'and enabled when shown for setup');
  const hideAt = app.indexOf("$('gate-pw2').classList.add('hidden')");
  const disableAt = app.indexOf("$('gate-pw2').disabled = true");
  ok(disableAt > hideAt && disableAt - hideAt < 200, 'the two are set together, not in different places');
}

console.log('=== mobile keyboards do not mangle the username ===');
{
  ok(user.getAttribute('autocapitalize') === 'none', 'no auto-capitalising the first letter');
  ok(user.getAttribute('autocorrect') === 'off', 'no autocorrect');
  ok(user.getAttribute('spellcheck') === 'false', 'and no spellcheck underline');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
