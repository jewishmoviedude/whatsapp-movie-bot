/* The "Discord (read-only)" card, read as text: no DOM needed, so this runs
   on a production install too. Run: node test/discord-panel-static.test.mjs

   The operator, 2026-10-11: "create from scratch a way I can connect my
   discord account to the ubuntu so you can access it". They were told
   plainly, and accepted, that automating a personal account is against
   Discord's terms and that the token is the whole account; the card says
   both before the box where it is pasted, says how to take it back, and
   never shows it again. test/discord-panel.test.mjs runs the card in
   linkedom (a devDependency); this pins the markup and the script without
   it: the card is in Settings -> Connection, the warning is all there, the
   token box is a password box only the super-admin sees, the script loads
   after app.js and touches only elements that exist, times go through the
   24-hour helpers, a token Discord has refused leaves every button that
   would send it disabled, and the CSV export treats the box - and anything
   shaped like a Discord token - as a secret. */
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const html = read('src/web/public/index.html');
const js = read('src/web/public/discord.js');
const csv = read('src/web/public/csv-export.js');
const TOKEN = 'MTA5ODc2NTQzMjE5ODc2NTQzMg' + '.GxYzAb.' + 'fake-test-token_not-real_0123456789ab';

const start = html.indexOf('id="card-discord"');
const cardHtml = html.slice(start, html.indexOf('<div class="settings-group', start));

console.log('=== where it is ===');
{
  const group = html.indexOf('data-group="connection"');
  const next = html.indexOf('<div class="settings-group', group + 1);
  ok(start > group && start < next, 'in Settings -> Connection, beside the WhatsApp account it complements');
  ok(/the Discord account your support tickets are read from/.test(html.slice(group, start)), 'and the section says so');
  ok(/<h2>Discord \(read-only\)/.test(cardHtml), 'titled "Discord (read-only)"');
}

console.log('=== what it says before anything is pasted ===');
{
  const warn = cardHtml.slice(cardHtml.indexOf('id="dc-warning"'), cardHtml.indexOf('id="dc-token"'));
  ok(warn.length > 0 && cardHtml.indexOf('id="dc-warning"') < cardHtml.indexOf('id="dc-token"'), 'the warning comes before the box');
  for (const [re, what] of [
    [/against Discord's terms/, 'it is against Discord\'s terms'],
    [/can ban the account/, 'the account can be banned'],
    [/full access to your Discord account/, 'the token is full access to the account'],
    [/two-factor/, 'it gets past two-factor'],
    [/Changing your Discord password/, 'changing the password revokes it'],
    [/Log out of all devices/, 'and so does "Log out of all devices"'],
    [/Never paste the token in a chat/, 'never paste it in a chat'],
  ]) ok(re.test(warn), `it says: ${what}`);
  ok(/It only ever reads/.test(cardHtml) && /cannot post, react, edit, mark anything read or show you typing/.test(cardHtml), 'and what the reader does, and never does');
  const howto = cardHtml.slice(cardHtml.indexOf('id="dc-howto"'));
  ok(/developer tools/.test(howto) && /Network/.test(howto) && /discord\.com\/api/.test(howto) && /<b>authorization<\/b>/.test(howto),
    'how to get it: the browser\'s developer tools, Network, a request to discord.com/api, its "authorization" header');
}

console.log('=== the box, and who sees it ===');
{
  const input = cardHtml.match(/<input id="dc-token"[^>]*>/)?.[0] ?? '';
  ok(/type="password"/.test(input) && /autocomplete="off"/.test(input), `a password box, not remembered by the browser: ${input}`);
  const box = cardHtml.slice(cardHtml.indexOf('id="dc-connect-box"') - 40);
  ok(/class="superadmin-only" id="dc-connect-box"/.test(cardHtml), 'the controls are in a superadmin-only block, which app.js hides from a plain admin');
  for (const id of ['dc-token', 'dc-connect', 'dc-disconnect', 'dc-load-guilds', 'dc-watch-save', 'dc-read-now', 'dc-preview']) {
    ok(box.includes(`id="${id}"`), `#${id} is inside it`);
  }
  ok(/stored encrypted; never shown again, never logged/.test(cardHtml), 'it says the token is stored encrypted and never shown again');
}

console.log('=== the script ===');
{
  const scripts = [...html.matchAll(/<script src="\/([\w.-]+\.js)"/g)].map((m) => m[1]);
  ok(scripts.indexOf('discord.js') > scripts.indexOf('app.js'), `it loads after app.js, whose helpers it uses (${scripts.join(', ')})`);
  const ids = new Set([...js.matchAll(/\$\('([\w-]+)'\)|getElementById\('([\w-]+)'\)/g)].map((m) => m[1] ?? m[2]));
  const missing = [...ids].filter((id) => !new RegExp(`id="${id}"`).test(html));
  ok(ids.size > 10 && missing.length === 0, `every element it looks for is in index.html${missing.length ? ` - missing ${missing.join(', ')}` : ''}`);
  ok(!/toLocale(Time|Date)?String|hour12/.test(js) && /fmtDateTime\(/.test(js), 'times only through fmtDateTime: the 24-hour clock');
  ok(!/localStorage|sessionStorage|document\.cookie/.test(js), 'it keeps nothing in the browser');
  ok((js.match(/token/g) ?? []).length > 0 && /api\('POST', '\/discord\/connect', \{ token \}\)/.test(js)
    && (js.match(/\{ token \}/g) ?? []).length === 1, 'the token is sent once, to /discord/connect, and nowhere else');
  ok(/\$\('dc-token'\)\.value = '';/.test(js), 'and the box is emptied once it is saved');
  ok(!/setInterval|setTimeout/.test(js), 'no timer: it asks the server only when Settings is opened or a button is pressed');
  ok(!/discord\.com/.test(js.replace(/\/\*[\s\S]*?\*\//g, '')), 'and the browser never talks to Discord itself');
}

console.log('=== a refused token: the buttons that ask Discord are disabled (stand-in elements, no linkedom) ===');
{
  // "Load my servers" and "Show matching channels" stayed enabled after a
  // 401, and sent the revoked token to Discord again (review, 2026-10-11).
  // The card's own script runs here against a few stand-in elements, so this
  // holds on a production install, where linkedom is absent, too.
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) {
      els.set(id, { id, disabled: false, value: '', textContent: '', innerHTML: '', className: '', dataset: {},
        classList: { toggle() {}, contains: () => false }, addEventListener() {}, querySelectorAll: () => [] });
    }
    return els.get(id);
  };
  const document = { getElementById: el, querySelectorAll: () => [] };
  const window = {};
  let current = null;
  const status = (extra) => ({ connected: true, canChange: true, user: { id: '1098765432198765432', username: 'headadmin' }, everyMinutes: 30,
    watch: { guilds: [], channelPattern: '^ticket-', channels: [] }, guildNames: {}, ...extra });
  // eslint-disable-next-line no-new-func
  new Function('document', 'window', '$', 'api', 'confirm', 'esc', 'fmtDateTime', js)(
    document, window, el, async () => current, () => true, (s) => String(s ?? ''), (t) => String(t));
  const asking = ['dc-load-guilds', 'dc-preview', 'dc-read-now'];
  current = status({ brokenSince: Date.parse('2026-10-11T04:30:00Z'), brokenWhy: 'Discord refused the saved token (HTTP 401)' });
  await window.__discordCard.load();
  ok(asking.every((id) => el(id).disabled), 'broken: Load my servers, Show matching channels and Read now are disabled');
  ok(!el('dc-watch-save').disabled && el('dc-connect').textContent === 'Reconnect', 'while Save what to read (no request) and Reconnect are not');
  current = status({});
  await window.__discordCard.load();
  ok(asking.every((id) => !el(id).disabled), 'connected and working: they are enabled again');
}

console.log('=== the CSV export treats it as a secret ===');
{
  const name = new RegExp(csv.match(/const SECRET_NAME = \/(.+)\/i;/)?.[1] ?? '^$', 'i');
  ok(name.test('dc-token') && name.test('Discord token'), 'a box called "dc-token", labelled "Discord token", is a secret field (written as the mask)');
  const line = csv.split('\n').find((l) => l.includes('[MNO][A-Za-z0-9_-]{22,27}')) ?? '';
  const re = line.match(/\[\/(.+)\/g, `\$1\$\{MASK\}`\]/)?.[1];
  ok(!!re, 'a Discord token\'s shape is among the patterns every cell is swept for');
  const sweep = (s) => s.replace(new RegExp(re, 'g'), '$1••••••••');
  ok(!sweep(`pasted ${TOKEN} by mistake`).includes(TOKEN) && sweep(`x ${TOKEN}`) === 'x ••••••••', 'and it masks one wherever it was pasted');
  ok(sweep('The.Matrix.1999.1080p.BluRay.x264.mkv') === 'The.Matrix.1999.1080p.BluRay.x264.mkv', 'but not a dotted file name');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
