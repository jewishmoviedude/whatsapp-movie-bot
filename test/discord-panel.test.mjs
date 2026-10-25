/* The "Discord (read-only)" card, run in a DOM. Run: node test/discord-panel.test.mjs

   NEEDS THE DEV DEPENDENCIES: it stubs a DOM with linkedom, a devDependency.
   On a production install (npm install --omit=dev) it is skipped, with a
   line saying so, as fair-queue-panel and request-pause are, rather than
   adding a thirteenth suite to the ones CLAUDE.md lists as failing there.
   test/discord-panel-static.test.mjs checks the markup and the script
   without linkedom, and runs everywhere.

   The operator, 2026-10-11: "create from scratch a way I can connect my
   discord account to the ubuntu so you can access it". The card's script,
   src/web/public/discord.js, is run against the real index.html with app.js's
   real helpers and a stub of the API, and this pins what the card does with
   the token - sends it once, to /discord/connect, and empties the box as soon
   as it is saved - and that it shows connected as / broken since / last read
   on the 24-hour clock, lists the servers to choose from, and saves what to
   read. The card's CSV (csv-export.js) is built with a token typed in the
   box, and searched for it. */
import fs from 'node:fs';

// The card shows times in the browser's own zone; the instants below are UTC.
process.env.TZ = 'UTC';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

let parseHTML = null;
try { ({ parseHTML } = await import('linkedom')); } catch { /* production install */ }
if (!parseHTML) {
  console.log('=== the Discord card: skipped - linkedom (a devDependency) is not installed; npm install --include=dev to run it ===');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
}

const card = fs.readFileSync(new URL('../src/web/public/discord.js', import.meta.url), 'utf8');
const csvJs = fs.readFileSync(new URL('../src/web/public/csv-export.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
const pick = (re) => app.match(re)?.[0] ?? '';
const helpers = [
  pick(/function esc\([\s\S]*?\n\}/), pick(/const CLOCK_24 = .*;/), pick(/const HM = .*;/),
  pick(/function fmtDateTime\([\s\S]*?\n\}/), pick(/function fmtClock\([\s\S]*?\n\}/),
].join('\n');

const TOKEN = 'MTA5ODc2NTQzMjE5ODc2NTQzMg' + '.GxYzAb.' + 'fake-test-token_not-real_0123456789ab';
const HOST = '1100000000000000001';
const T = Date.parse('2026-10-11T18:05:09Z');
const OFF = { connected: false, user: null, watch: { guilds: [], channelPattern: '^ticket-', channels: [] }, guildNames: {}, canChange: true, everyMinutes: 30 };
const ON = {
  connected: true, user: { id: '1098765432198765432', username: 'headadmin', name: 'Head Admin' }, connectedAt: T - 3600_000,
  lastReadAt: T, lastRun: { requests: 2, channels: 3, appended: 1, private: 4 }, everyMinutes: 30,
  watch: { guilds: [HOST], channelPattern: '^ticket-', channels: [] }, guildNames: { [HOST]: 'Media Host' }, canChange: true,
  recent: [{ at: T, channelName: 'ticket-0001', guildName: 'Media Host', who: 'mediastaff', fromMe: false, bot: false, text: 'Renamed it.' }],
};

function mount({ status = OFF, answers = {} } = {}) {
  const win = parseHTML(html);
  const { document } = win;
  const $ = (id) => document.getElementById(id);
  const calls = [];
  let current = status;
  const confirms = [];
  const api = async (method, url, body) => {
    calls.push({ method, url, body });
    const key = `${method} ${url.split('?')[0]}`;
    if (answers[key]) {
      const a = answers[key](body, url);
      if (a instanceof Error) throw a;
      if (a?.connected !== undefined) current = a;
      return a;
    }
    if (key === 'GET /discord') return current;
    throw new Error(`unexpected ${key}`);
  };
  const window = {};
  let confirmAnswer = true;
  // eslint-disable-next-line no-new-func
  new Function('document', 'window', '$', 'api', 'confirm', `${helpers}\n${card}`)(
    document, window, $, api, (q) => { confirms.push(q); return confirmAnswer; });
  const click = async (el) => { el.dispatchEvent(new win.Event('click', { bubbles: true })); await new Promise((r) => setTimeout(r, 5)); };
  return { document, $, calls, dc: window.__discordCard, click, win, setConfirm: (v) => { confirmAnswer = v; }, confirms, window, api };
}

console.log('=== loading, when Settings is opened ===');
{
  const m = mount();
  ok(m.dc && m.calls.length === 0, 'nothing is fetched before Settings is opened');
  await m.click(m.document.querySelector('.tab[data-tab="settings"]'));
  ok(m.calls.length === 1 && m.calls[0].url === '/discord', 'opening Settings loads its status');
  ok(/not connected/.test(m.$('dc-pill').textContent) && /Nothing is read from Discord/.test(m.$('dc-status').textContent), 'not connected, nothing read');
  ok(m.$('dc-connect').textContent === 'Connect' && m.$('dc-disconnect').classList.contains('hidden'), 'Connect offered; no Disconnect');
  ok(m.$('dc-load-guilds').disabled && m.$('dc-watch-save').disabled && m.$('dc-read-now').disabled, 'nothing to choose until it is connected');
}

console.log('=== connecting: the token goes once, to /discord/connect, and the box is emptied ===');
{
  const m = mount({ answers: { 'POST /discord/connect': (body) => (body.token === TOKEN ? ON : new Error('Discord did not accept that token. Nothing was saved.')) } });
  await m.dc.load();
  await m.click(m.$('dc-connect'));
  ok(m.calls.length === 1 && /Paste the token first/.test(m.$('dc-note').textContent), 'an empty box: asked to paste, nothing sent');
  m.$('dc-token').value = 'MTAwMDAwMDAwMDAwMDAwMDAw.AAAAAA.wrongwrongwrongwrongwrongwrongwrong';
  await m.click(m.$('dc-connect'));
  ok(/did not accept/.test(m.$('dc-note').textContent) && m.$('dc-token').value !== '', 'a refused token: the reason, and the box kept to fix it');
  m.$('dc-token').value = `${TOKEN}\n`;
  await m.click(m.$('dc-connect'));
  const sent = m.calls.filter((c) => c.method === 'POST');
  ok(sent.at(-1).url === '/discord/connect' && sent.at(-1).body.token === TOKEN, 'sent to /discord/connect, trimmed');
  ok(m.$('dc-token').value === '', 'and the box is emptied once it is saved');
  ok(m.calls.filter((c) => JSON.stringify(c.body ?? {}).includes(TOKEN)).length === 1, 'it went nowhere else');
  ok(/Connected as headadmin/.test(m.$('dc-note').textContent) && /connected as headadmin/.test(m.$('dc-pill').textContent), 'connected as headadmin');
  const st = m.$('dc-status').textContent;
  ok(/Connected as headadmin \(Head Admin\) since/.test(st) && /Last read: .*18:05:09/.test(st) && !/AM|PM/.test(st), `status, 24-hour: ${st}`);
  ok(/4 channels that are somebody else's skipped/.test(st), 'and what the last run skipped');
  ok(/mediastaff/.test(m.$('dc-recent').textContent) && /Renamed it\./.test(m.$('dc-recent').textContent), 'the latest messages read');
  ok(m.$('dc-connect').textContent === 'Replace token' && !m.$('dc-disconnect').classList.contains('hidden'), 'now: Replace token, and Disconnect');
}

console.log('=== a broken connection says so ===');
{
  const m = mount({ status: { ...ON, brokenSince: T, brokenWhy: 'Discord refused the saved token (HTTP 401)' } });
  await m.dc.load();
  ok(/disconnected - reconnect/.test(m.$('dc-pill').textContent) && /bad/.test(m.$('dc-pill').className), 'the pill: disconnected');
  ok(/Broken since .*18:05:09/.test(m.$('dc-status').textContent) && /HTTP 401/.test(m.$('dc-status').textContent), 'broken since when, and why');
  ok(m.$('dc-connect').textContent === 'Reconnect', 'and Reconnect');
  // These buttons sent the revoked token to Discord again (review, 2026-10-11).
  ok(m.$('dc-load-guilds').disabled && m.$('dc-preview').disabled && m.$('dc-read-now').disabled,
    'Load my servers, Show matching channels and Read now are disabled: they would send the refused token');
  ok(!m.$('dc-watch-save').disabled, 'saving what to read, which asks Discord nothing, is not');
}

console.log('=== disconnecting asks first ===');
{
  const m = mount({ status: ON, answers: { 'POST /discord/disconnect': () => OFF } });
  await m.dc.load();
  m.setConfirm(false);
  await m.click(m.$('dc-disconnect'));
  ok(m.confirms.length === 1 && /token is wiped/.test(m.confirms[0]) && !m.calls.some((c) => c.url === '/discord/disconnect'), 'said no: nothing sent');
  m.setConfirm(true);
  await m.click(m.$('dc-disconnect'));
  ok(m.calls.some((c) => c.url === '/discord/disconnect') && /not connected/.test(m.$('dc-pill').textContent), 'said yes: disconnected');
}

console.log('=== choosing the server and the channels ===');
{
  const saved = [];
  const m = mount({ status: ON, answers: {
    'GET /discord/guilds': () => ({ guilds: [{ id: HOST, name: 'Media Host' }, { id: '1100000000000000002', name: 'Another server' }] }),
    'PUT /discord/watch': (body) => { saved.push(body); return { ...ON, watch: { ...body } }; },
    'GET /discord/channels': (_b, url) => ({ pattern: new URLSearchParams(url.split('?')[1]).get('pattern'), guilds: [{ guild: HOST, guildName: 'Media Host', channels: [
      { id: '1200000000000000001', name: 'ticket-0001', matches: true, read: true, visible: true, lastMessageAt: T },
      { id: '1200000000000000002', name: 'ticket-0002', matches: true, read: false, visible: false, lastMessageAt: null }] }] }),
    'POST /discord/read-now': () => ({ ...ON, result: { ok: true, appended: 2, channels: 1, requests: 2, errors: [] } }),
  } });
  await m.dc.load();
  const boxes = () => [...m.document.querySelectorAll('#dc-guilds input.dc-g')];
  ok(boxes().length === 1 && boxes()[0].hasAttribute('checked') && /Media Host/.test(m.$('dc-guilds').textContent), 'the saved server, ticked, before the list is loaded');
  await m.click(m.$('dc-load-guilds'));
  ok(boxes().length === 2 && /Another server/.test(m.$('dc-guilds').textContent), 'Load my servers: every server, by name');
  ok(m.$('dc-pattern').value === '^ticket-', 'the pattern box shows ^ticket-');
  m.$('dc-channels').value = '1200000000000000009, 1200000000000000010';
  await m.click(m.$('dc-watch-save'));
  ok(saved[0]?.guilds.join() === HOST && saved[0].channelPattern === '^ticket-' && saved[0].channels.join() === '1200000000000000009,1200000000000000010',
    `saved: ${JSON.stringify(saved[0])}`);
  await m.click(m.$('dc-preview'));
  const list = m.$('dc-matches').textContent;
  ok(/ticket-0001/.test(list) && /read before/.test(list) && /ticket-0002/.test(list) && /somebody else's - skipped/.test(list), 'the matching channels, and which are skipped');
  await m.click(m.$('dc-read-now'));
  ok(/2 new messages from 1 channel, 2 requests/.test(m.$('dc-watch-note').textContent), `Read now: ${m.$('dc-watch-note').textContent}`);
}

console.log('=== a plain admin sees it, and cannot change it ===');
{
  const m = mount({ status: { ...ON, canChange: false, recent: undefined } });
  await m.dc.load();
  ok(m.$('dc-load-guilds').disabled && m.$('dc-watch-save').disabled && m.$('dc-read-now').disabled, 'every control that changes or asks Discord is disabled');
  ok(m.$('dc-connect-box').classList.contains('superadmin-only'), 'and the whole box is one app.js hides from a plain admin');
}

console.log('=== the card\'s CSV never carries the token ===');
{
  const m = mount({ status: ON });
  await m.dc.load();
  m.$('dc-token').value = TOKEN;
  m.$('dc-channels').value = `${TOKEN}`;   // pasted in the wrong box by mistake
  // eslint-disable-next-line no-new-func
  new Function('document', 'window', 'api', 'toast', csvJs)(m.document, m.window, m.api, () => {});
  const out = await m.window.panelCsv.csvFor(m.$('card-discord'));
  ok(out.rows.length > 0 && /Discord token/.test(out.text), `the card exports (${out.rows.length} rows)`);
  ok(!out.text.includes(TOKEN), 'and the token is in none of it - masked in its box and wherever else it was pasted');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
