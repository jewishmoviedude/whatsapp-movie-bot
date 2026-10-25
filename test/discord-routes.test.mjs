/* Connecting Discord in the panel, and reading it from the box: super-admin
   only, checked with Discord first, audited, and the token nowhere but
   encrypted in config.json. Run: node test/discord-routes.test.mjs

   The operator, 2026-10-11: "create from scratch a way I can connect my
   discord account to the ubuntu so you can access it". The token pasted on
   the card is the whole account - it gets past two-factor, and only a
   password change or "Log out of all devices" takes it back - so this suite
   drives the real ConfigStore and the real API router over HTTP, and the
   real tools/discord.mjs, against a fake Discord
   (test/fixtures/fake-discord.mjs), and pins:

   - only the super-admin may connect, disconnect, choose what is read or
     ask Discord anything through the panel; a plain admin is refused (403),
     logged and audited, and Discord is never asked on their behalf; anyone
     signed in sees whether it is connected and as whom;
   - a token is checked with GET users/@me before it is saved; one Discord
     refuses is not saved; "connected Discord as headadmin" and "disconnected
     Discord" are audited, without the token;
   - the token is encrypted at rest (SECRET_PATHS), masked in GET /config,
     refused in a settings save (PUT /config can neither set it nor change
     what is read), and in no response, log line or audit row - searched for
     in everything this suite captured;
   - it travels in the sealed backup the way every other secret does: inside
     data/config.json, encrypted with MASTER_KEY, which .env carries in the
     same sealed bundle; the read positions, in data/state.json, too;
   - tools/discord.mjs reads the token the way tools/diagnose-library.mjs
     does, never prints it, never writes the settings, and prints times on the
     24-hour clock. */
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import log from '../src/util/logger.js';
import { ConfigStore, MASK } from '../src/config/store.js';
import { StateStore } from '../src/core/state.js';
import { createApiRouter } from '../src/web/api.js';
import { JobQueue } from '../src/core/queue.js';
import { hashPassword } from '../src/util/crypto.js';
import { DiscordWatch, NAMESPACE } from '../src/core/discord-watch.js';
import { DISCORD_ROUTE_GAP_MS, watchProblem } from '../src/web/discord-routes.js';
import { APP_BUNDLE_PATHS } from '../src/core/activity-backup.js';
import { main as cli, when } from '../tools/discord.mjs';
import { fakeDiscord, flake, msg } from './fixtures/fake-discord.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const logged = [];
log.setSink({ write: (e) => logged.push(JSON.stringify(e)) });

const TOKEN = 'MTA5ODc2NTQzMjE5ODc2NTQzMg' + '.GxYzAb.' + 'fake-test-token_not-real_0123456789ab';
const WRONG = 'MTA5ODc2NTQzMjE5ODc2NTQzMg' + '.GxYzAb.' + 'a-revoked-token_no-longer_good_98765';
const ME = '1098765432198765432';
const STAFF = '1077777777777777777';
const HOST = '1100000000000000001';
const HP = '1200000000000000001';
const OTHER = '1200000000000000002';
const VIEW = String(1 << 10);

// The clock moves on instead of the suite sleeping out each route's gap.
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
const later = () => { skew += Math.max(...Object.values(DISCORD_ROUTE_GAP_MS)) + 1000; };

const T0 = Date.now();
const D = await fakeDiscord({
  token: TOKEN,
  me: { id: ME, username: 'headadmin', global_name: 'Head Admin' },
  guilds: [{ id: HOST, name: 'Media Host' }, { id: '1100000000000000002', name: 'Another server' }],
  channels: {
    [HOST]: [
      { id: HP, name: 'ticket-0001', type: 0, permission_overwrites: [{ id: HOST, type: 0, allow: '0', deny: VIEW }, { id: ME, type: 1, allow: VIEW, deny: '0' }] },
      { id: OTHER, name: 'ticket-0002', type: 0, permission_overwrites: [{ id: HOST, type: 0, allow: '0', deny: VIEW }] },
      { id: '1200000000000000003', name: 'general', type: 0, permission_overwrites: [] },
    ],
  },
  messages: {
    [HP]: [
      msg({ id: flake(T0 - 2 * 86_400_000, 1), at: T0 - 2 * 86_400_000, author: { id: ME, username: 'headadmin', global_name: 'Head Admin' },
        content: 'Please rename Harry Potter and the Philosopher\'s Stone to Sorcerer\'s Stone, tt0241527' }),
      msg({ id: flake(T0 - 3_600_000, 2), at: T0 - 3_600_000, author: { id: STAFF, username: 'mediastaff' }, content: 'Renamed. Rescanning now.' }),
    ],
    [OTHER]: [],
  },
});

/* ------------------------------ the server ------------------------------ */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-routes-'));
const MASTER = 'test-master-key-for-the-discord-routes';
const configStore = new ConfigStore({ dataDir: dir, masterKey: MASTER });
configStore.load();
configStore.update({ web: { admins: [
  { username: 'mommy', role: 'superadmin', passwordHash: hashPassword('x-password-1') },
  { username: 'helper', role: 'admin', passwordHash: hashPassword('x-password-2') },
] } });
const stateStore = new StateStore(path.join(dir, 'state.json'));
const discordWatch = new DiscordWatch({
  dataDir: dir, configStore, store: stateStore.namespace(NAMESPACE), audit: stateStore.namespace('audit'),
  fetch: D.fetch, sleep: async () => {},
});

const SUPER = { username: 'mommy', role: 'superadmin' };
const PLAIN = { username: 'helper', role: 'admin' };
let who = SUPER;
const queue = new JobQueue({ concurrency: 1 });
queue.pause();
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = who ? { user: who } : {}; next(); });
app.use('/api', createApiRouter({
  configStore,
  bot: { groupCache: new Map(), groups: () => [], on: () => {}, state: 'connected' },
  queue, linkQueue: queue,
  pluginManager: { plugins: new Map(), notifyConfigChange: async () => {}, list: () => [] },
  stateStore, fileLogger: { tail: () => [] }, alerts: {}, lockScheduler: {},
  discordWatch,
}));
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const port = server.address().port;
const events = () => stateStore.namespace('audit').get('events', []);
const onDisk = () => fs.readFileSync(path.join(dir, 'config.json'), 'utf8');

const everyResponse = [];
function request(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path: p,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
    (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch { /* not JSON */ }
        everyResponse.push(buf);
        resolve({ status: res.statusCode, text: buf, json: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/* ------------------------------ the tests ------------------------------ */

console.log('=== before anything is connected ===');
{
  who = PLAIN;
  const r = await request('GET', '/api/discord');
  ok(r.status === 200 && r.json.connected === false && r.json.canChange === false, 'any admin sees it is not connected, and that they cannot change it');
  ok(!('recent' in r.json), 'a plain admin is not shown the ticket messages');
  who = SUPER;
}

console.log('=== a plain admin can do none of it, and Discord is not asked ===');
{
  who = PLAIN;
  for (const [method, p, body, what] of [
    ['POST', '/api/discord/connect', { token: TOKEN }, 'connect Discord'],
    ['POST', '/api/discord/disconnect', {}, 'disconnect Discord'],
    ['PUT', '/api/discord/watch', { guilds: [HOST] }, 'change what the Discord reader reads'],
    ['GET', '/api/discord/guilds', undefined, 'list the Discord servers'],
    ['GET', `/api/discord/channels?guild=${HOST}`, undefined, 'list Discord channels'],
    ['POST', '/api/discord/read-now', {}, 'read Discord now'],
  ]) {
    const r = await request(method, p, body);
    ok(r.status === 403 && /Only the super-admin/.test(r.json?.error), `${method} ${p.split('?')[0]}: 403`);
    ok(events()[0]?.action === `refused: ${what}` && events()[0].user === 'helper', `audited: "${events()[0]?.action}" by helper`);
  }
  ok(D.requests.length === 0 && !configStore.get().discord.token, 'nothing was saved, and Discord was asked nothing');
  who = SUPER;
}

console.log('=== connecting: checked with Discord before it is saved ===');
{
  const bad = await request('POST', '/api/discord/connect', { token: `Bot ${TOKEN}` });
  ok(bad.status === 400 && /bot token/.test(bad.json.error) && D.requests.length === 0, `a bot token is refused without asking Discord: ${bad.json?.error}`);
  later();
  const wrong = await request('POST', '/api/discord/connect', { token: WRONG });
  ok(wrong.status === 400 && /Discord did not accept that token/.test(wrong.json.error) && /Nothing was saved/.test(wrong.json.error),
    `one Discord refuses: ${wrong.json?.error}`);
  ok(D.requests.length === 1 && D.requests[0].path === 'users/@me' && D.requests[0].auth === WRONG, 'it was asked once: GET users/@me, with that token');
  ok(!configStore.get().discord.token && !discordWatch.status().brokenSince, 'not saved, and the reader is not marked broken by a token it never had');
  ok(events()[0].action === 'refused: connect Discord' && !JSON.stringify(events()[0]).includes(WRONG), 'audited, without the token');
  const tooFast = await request('POST', '/api/discord/connect', { token: TOKEN });
  ok(tooFast.status === 429 && D.requests.length === 1, 'a second try straight away is held back: one call to Discord every few seconds');

  later();
  const r = await request('POST', '/api/discord/connect', { token: `  ${TOKEN}\n` });
  ok(r.status === 200 && r.json.connected && r.json.user?.username === 'headadmin', `connected as ${r.json?.user?.username}`);
  ok(D.requests.length === 2 && D.requests[1].path === 'users/@me', 'after one GET users/@me');
  ok(configStore.get().discord.token === TOKEN, 'the token is kept (trimmed)');
  ok(!onDisk().includes(TOKEN) && /"token": "[^"]+"/.test(onDisk()), 'config.json holds it encrypted');
  const fresh = new ConfigStore({ dataDir: dir, masterKey: MASTER });
  fresh.save = () => fresh.config;
  ok(fresh.load().discord.token === TOKEN, 'and MASTER_KEY reads it back');
  const row = events()[0];
  ok(row.action === 'connected Discord as headadmin' && row.user === 'mommy' && /read-only/.test(row.detail), `audited: "${row.action}" (${row.detail})`);
  ok(!JSON.stringify(events()).includes(TOKEN), 'no audit row holds it');
}

console.log('=== the settings never show it, and cannot change it ===');
{
  const c = await request('GET', '/api/config');
  ok(c.json.discord.token === MASK && !c.text.includes(TOKEN), 'GET /config: masked');
  for (const [user, status] of [[SUPER, 400], [PLAIN, 403]]) {
    who = user;
    for (const patch of [{ discord: { token: 'MTAxMDEwMTAxMDEwMTAxMDEwMTAx.AAAAAA.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } }, { discord: { token: '' } },
      { discord: { watch: { channels: ['1999999999999999999'] } } }, { discord: { token: MASK } }]) {
      const r = await request('PUT', '/api/config', patch);
      ok(r.status === status && /Discord/.test(r.json?.error) && /Nothing was saved/.test(r.json?.error),
        `${user.username}: PUT /config ${JSON.stringify(patch).slice(0, 40)}… refused (${r.status})`);
    }
  }
  who = SUPER;
  ok(configStore.get().discord.token === TOKEN && configStore.get().discord.watch.channels.length === 0, 'the token and the watch are as they were');
  ok(events().some((e) => e.action === 'refused: change the Discord connection through settings' && e.user === 'helper'), 'each refusal audited');
  const other = await request('PUT', '/api/config', { logging: { level: 'debug' } });
  ok(other.status === 200 && configStore.get().discord.token === TOKEN && other.json.discord.token === MASK,
    'an ordinary settings save still works, leaves the token alone and answers with it masked');
}

console.log('=== choosing what to read ===');
{
  later();
  const g = await request('GET', '/api/discord/guilds');
  ok(g.status === 200 && g.json.guilds.map((x) => x.name).join() === 'Media Host,Another server', 'the account\'s servers, by name');
  for (const [body, why] of [[{ guilds: ['loki'] }, /not a Discord id/], [{ guilds: [HOST], channelPattern: '(' }, /not a valid regular expression/],
    [{ guilds: HOST }, /must be a list/], [{ guilds: [HOST], channels: ['../../x'] }, /not a Discord id/], [[], /send/]]) {
    const r = await request('PUT', '/api/discord/watch', body);
    ok(r.status === 400 && why.test(r.json.error), `refused: ${JSON.stringify(body)} - ${r.json?.error}`);
  }
  ok(watchProblem({ guilds: [HOST] }) === null, 'a server alone is enough: the pattern defaults to ^ticket-');
  const r = await request('PUT', '/api/discord/watch', { guilds: [HOST], channelPattern: '^ticket-', channels: [] });
  ok(r.status === 200 && configStore.get().discord.watch.guilds.join() === HOST, 'saved');
  ok(events()[0].action === 'changed what the Discord reader reads' && /Media Host/.test(events()[0].detail) && /\^ticket-/.test(events()[0].detail),
    `audited with the server's name: ${events()[0].detail}`);
  later();
  const from = D.requests.length;
  const ch = await request('GET', `/api/discord/channels?guild=${HOST}&pattern=${encodeURIComponent('^ticket-')}`);
  const list = ch.json.guilds?.[0]?.channels ?? [];
  ok(ch.status === 200 && list.map((c) => `${c.name}:${c.visible}`).join() === 'ticket-0001:true,ticket-0002:false',
    `which channels match, and which are the operator's (${list.map((c) => `${c.name}:${c.visible}`).join()})`);
  ok(D.requests.length === from + 1, 'one request to Discord');
  later();
  const badPattern = await request('GET', `/api/discord/channels?guild=${HOST}&pattern=${encodeURIComponent('[')}`);
  ok(badPattern.status === 400, 'a pattern that does not compile is refused before Discord is asked');
}

console.log('=== Read now, and the latest messages ===');
{
  later();
  const r = await request('POST', '/api/discord/read-now', {});
  ok(r.status === 200 && r.json.result.ok && r.json.result.appended === 2, `read: ${JSON.stringify(r.json?.result?.appended)} new messages`);
  ok(r.json.recent?.[0]?.text === 'Renamed. Rescanning now.' && r.json.recent[0].who === 'mediastaff', 'the latest messages, newest first, for the super-admin');
  const again = await request('POST', '/api/discord/read-now', {});
  ok(again.status === 429, 'once a minute at most');
  who = PLAIN;
  const st = await request('GET', '/api/discord');
  ok(st.json.connected && st.json.user.username === 'headadmin' && st.json.lastReadAt && !('recent' in st.json),
    'a plain admin sees connected as headadmin and when it last read, not the messages');
  who = SUPER;
}

console.log('=== a revoked token: the panel is told, and sends it nowhere again ===');
{
  D.scene.revoked = true;
  later();
  const r = await request('POST', '/api/discord/read-now', {});
  ok(r.status === 200 && r.json.result.ok === false && r.json.brokenSince, 'Read now: the reader stops');
  const st = await request('GET', '/api/discord');
  ok(st.json.brokenSince && /HTTP 401/.test(st.json.brokenWhy), `GET /discord says broken since then: ${st.json.brokenWhy}`);
  // "Load my servers" and "Show matching channels" checked only that a
  // token was saved, and sent the revoked one again (review, 2026-10-11).
  const from = D.requests.length;
  for (const [method, p] of [['GET', '/api/discord/guilds'], ['GET', `/api/discord/channels?guild=${HOST}`], ['POST', '/api/discord/read-now']]) {
    later();
    const x = await request(method, p, method === 'POST' ? {} : undefined);
    ok(x.status === 409 && x.json.code === 'broken' && /not sent again/.test(x.json.error) && /Connect/.test(x.json.error),
      `${method} ${p.split('?')[0]}: 409 - ${x.json?.error}`);
  }
  ok(D.requests.length === from, 'and not one request reached Discord with the revoked token');
  D.scene.revoked = false;
  later();
  const again = await request('POST', '/api/discord/connect', { token: TOKEN });
  ok(again.status === 200 && !again.json.brokenSince, 'Connect with a token Discord accepts clears it');
  later();
  const g = await request('GET', '/api/discord/guilds');
  ok(g.status === 200 && g.json.guilds.length === 2 && D.requests.length === from + 2, 'and the server list works again: one request after the check');
}

console.log('=== disconnecting wipes it ===');
{
  const r = await request('POST', '/api/discord/disconnect', {});
  ok(r.status === 200 && r.json.connected === false && !r.json.brokenSince, 'disconnected, and no longer broken');
  ok(configStore.get().discord.token === '' && !onDisk().includes(TOKEN), 'the token is gone from memory and from config.json');
  ok(events()[0].action === 'disconnected Discord' && /was connected as headadmin/.test(events()[0].detail), `audited: ${events()[0].detail}`);
  ok((await request('GET', '/api/config')).json.discord.token === '', 'and GET /config shows nothing saved');
}

console.log('=== it travels in the sealed backup like every other secret ===');
{
  ok(APP_BUNDLE_PATHS.includes('data/config.json') && APP_BUNDLE_PATHS.includes('.env'),
    'the sealed bundle carries config.json - the token in it encrypted with MASTER_KEY - and .env, which holds MASTER_KEY');
  ok(APP_BUNDLE_PATHS.includes('data/state.json'), 'and state.json, with the read positions: a rebuilt box reads on, not back');
  ok(!APP_BUNDLE_PATHS.some((p) => /discord-tickets/.test(p)), 'the messages themselves stay on the box, like library-news.jsonl');
}

console.log('=== tools/discord.mjs ===');
{
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-cli-'));
  const data = path.join(box, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(box, '.env'), `MASTER_KEY=${MASTER}\n`);
  const cs = new ConfigStore({ dataDir: data, masterKey: MASTER });
  cs.load();
  cs.update({ discord: { token: TOKEN, watch: { guilds: [HOST], channelPattern: '^ticket-', channels: [] } } });
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ [NAMESPACE]: { status: { user: { id: ME, username: 'headadmin' }, lastReadAt: T0 } } }));
  fs.copyFileSync(path.join(dir, 'discord-tickets.jsonl'), path.join(data, 'discord-tickets.jsonl'));
  const settingsBefore = fs.readFileSync(path.join(data, 'config.json'), 'utf8');
  const printed = [];
  const run = async (...argv) => {
    const out = [];
    const code = await cli(argv, { appDir: box, dataDir: data, env: {}, fetch: D.fetch, out: (s) => out.push(s), err: (s) => out.push(s) });
    printed.push(...out);
    return { code, text: out.join('\n') };
  };
  const from = D.requests.length;
  const w = await run('whoami');
  ok(w.code === 0 && /Signed in as headadmin \(Head Admin\), id 1098765432198765432/.test(w.text) && /Watching: 1 server/.test(w.text), `whoami:\n${w.text}`);
  const g = await run('guilds');
  ok(g.code === 0 && new RegExp(`\\* ${HOST}  Media Host`).test(g.text), 'guilds: the watched one starred');
  const c = await run('channels', HOST);
  ok(c.code === 0 && /\* 1200000000000000001  #ticket-0001/.test(c.text) && /#ticket-0002.*\[hidden from this account\]/.test(c.text),
    'channels: the tickets read starred, somebody else\'s marked hidden');
  const r = await run('read', HP, '--limit', '5');
  ok(r.code === 0 && /^\d{4}-\d\d-\d\d \d\d:\d\d  Head Admin \(you\): Please rename/m.test(r.text) && /mediastaff: Renamed\./.test(r.text),
    `read: oldest first, the operator marked (you):\n${r.text}`);
  ok(D.requests.slice(from).find((q) => q.path === `channels/${HP}/messages`)?.query.limit === '5', 'with the limit asked for');
  const k = await run('tickets', '--days', '30');
  ok(k.code === 0 && /=== #ticket-0001 on Media Host/.test(k.text) && /Renamed\. Rescanning now\./.test(k.text), 'tickets: the kept record, ticket by ticket');
  const before = D.requests.length;
  await run('tickets');
  ok(D.requests.length === before, 'and without --live it asks Discord nothing');
  const live = await run('tickets', '--live');
  ok(live.code === 0 && /Server 1100000000000000001: 2 channel\(s\) named/.test(live.text), '--live lists the ticket channels Discord shows now');
  ok(!/\b(AM|PM)\b/.test(printed.join('\n')) && when(Date.parse('2026-10-11T04:30:00Z')) === '2026-10-11 00:30',
    'times are New York time on the 24-hour clock (00:30, never 12:30 AM or 24:30)');
  ok(D.requests.slice(from).every((q) => q.method === 'GET'), 'nothing but GETs');
  D.scene.revoked = true;
  const dead = await run('whoami');
  ok(dead.code === 2 && /revoked/.test(dead.text) && /Settings -> Connection -> Discord/.test(dead.text), 'a revoked token: exit 2, and where to reconnect');
  D.scene.revoked = false;
  const usage = await run('post', HP, 'hello');
  ok(usage.code === 1 && /whoami/.test(usage.text), 'there is no command that writes: an unknown one prints the usage');
  const wrongKey = await cli(['whoami'], { appDir: fs.mkdtempSync(path.join(os.tmpdir(), 'discord-cli-nokey-')), dataDir: data, env: {}, fetch: D.fetch, out: (s) => printed.push(s), err: (s) => printed.push(s) });
  ok(wrongKey === 1, 'no MASTER_KEY: exit 1');
  ok(fs.readFileSync(path.join(data, 'config.json'), 'utf8') === settingsBefore, 'the settings were never written');
  ok(!printed.join('\n').includes(TOKEN), `${printed.length} lines printed, none with the token`);
  fs.rmSync(box, { recursive: true, force: true });
}

console.log('=== the token is nowhere it should not be ===');
{
  ok(everyResponse.length > 30 && !everyResponse.some((b) => b.includes(TOKEN) || b.includes(WRONG)), `${everyResponse.length} responses, none with a token`);
  ok(!logged.some((l) => l.includes(TOKEN) || l.includes(WRONG)), `${logged.length} log lines, none with a token`);
  ok(!JSON.stringify(events()).includes(TOKEN), 'no audit row');
  stateStore.flush();
  ok(!fs.readFileSync(path.join(dir, 'state.json'), 'utf8').includes(TOKEN), 'not state.json');
  ok(!fs.readFileSync(path.join(dir, 'discord-tickets.jsonl'), 'utf8').includes(TOKEN), 'not the ticket record');
}

server.close();
await D.close();
Date.now = realNow;
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
