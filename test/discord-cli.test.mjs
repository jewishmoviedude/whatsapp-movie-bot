/* tools/discord.mjs never sends a token Discord has refused, and never stops
   part way through and calls it done. Run: node test/discord-cli.test.mjs

   The operator, 2026-10-11: "create from scratch a way I can connect my
   discord account to the ubuntu so you can access it". The CLI reads the
   connected account from this box, and the hourly check's research session
   runs `read <channelId>` with nobody watching. The review of its first
   version found three ways it went wrong, each reproduced against the fake
   Discord (test/fixtures/fake-discord.mjs) and pinned here:

   - The bot's reader had marked the token broken (a 401: the password
     changed, or "Log out of all devices"), and `whoami` and `read` sent it to
     Discord again anyway, one request each. Now nothing that asks Discord
     runs while state.json says broken: exit 2, no request.
   - When the CLI was the first to get a 401 it kept it to itself (it may not
     write state.json, which belongs to the running bot), so its own next call
     and the bot's next run each sent the dead token once more. Now it leaves
     data/discord-refused.json - when, and on which connection, never the
     token - which both take as final until somebody connects again; where
     data/ is read-only (the research session's sandbox), it says so.
   - The reader's rate-limit wait was an unref'd timer, and in the CLI nothing
     else held the process open: one 429 made `whoami` print nothing and exit
     0, and an empty bucket cut `tickets --live` off after the first server.
     These run the CLI in a child process, the only place that shows it, and
     a request that can never finish now ends with exit 3 and a line saying
     the answer is incomplete, never a quiet 0. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import log from '../src/util/logger.js';
import { ConfigStore } from '../src/config/store.js';
import { StateStore } from '../src/core/state.js';
import { DiscordWatch, NAMESPACE, refusedFile, readRefused } from '../src/core/discord-watch.js';
import { main as cli } from '../tools/discord.mjs';
import { fakeDiscord, flake, msg } from './fixtures/fake-discord.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const logged = [];
log.setSink({ write: (e) => logged.push(JSON.stringify(e)) });

const TOKEN = 'MTA5ODc2NTQzMjE5ODc2NTQzMg' + '.GxYzAb.' + 'fake-test-token_not-real_0123456789ab';
const ME = '1098765432198765432';
const HOST = '1100000000000000001';
const HOST2 = '1100000000000000002';
const HP = '1200000000000000001';
const SW = '1200000000000000002';
const MASTER = 'test-master-key-for-the-discord-cli';
const T0 = Date.now();
const me = { id: ME, username: 'headadmin', global_name: 'Head Admin' };

const D = await fakeDiscord({
  token: TOKEN,
  me,
  guilds: [{ id: HOST, name: 'Media Host' }, { id: HOST2, name: 'Media Host Two' }],
  channels: {
    [HOST]: [{ id: HP, name: 'ticket-0001', type: 0, permission_overwrites: [] }],
    [HOST2]: [{ id: SW, name: 'ticket-0002', type: 0, permission_overwrites: [] }],
  },
  messages: {
    [HP]: [msg({ id: flake(T0 - 3_600_000, 1), at: T0 - 3_600_000, author: me, content: 'Please rename it to Sorcerer\'s Stone, tt0241527' })],
    [SW]: [],
  },
});

// A box of its own: .env with MASTER_KEY, data/config.json with the token
// encrypted, and state.json as the bot would leave it.
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-cli-'));
const data = path.join(box, 'data');
fs.mkdirSync(data);
fs.writeFileSync(path.join(box, '.env'), `MASTER_KEY=${MASTER}\n`);
const cs = new ConfigStore({ dataDir: data, masterKey: MASTER });
cs.load();
cs.update({ discord: { token: TOKEN, watch: { guilds: [HOST, HOST2], channelPattern: '^ticket-', channels: [] } } });
const CONNECTED = T0 - 86_400_000;
const writeState = (status) => fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ [NAMESPACE]: { status } }));

const printed = [];
const run = async (...argv) => {
  const out = [];
  const code = await cli(argv, { appDir: box, dataDir: data, env: {}, fetch: D.fetch, out: (s) => out.push(s), err: (s) => out.push(s) });
  printed.push(...out);
  return { code, text: out.join('\n') };
};
const LIVE = [['whoami'], ['guilds'], ['channels', HOST], ['read', HP], ['tickets', '--live']];

console.log('=== the bot\'s reader says the token is dead: nothing is sent ===');
{
  const brokenSince = Date.parse('2026-10-11T04:30:00Z');
  writeState({ user: { id: ME, username: 'headadmin' }, connectedAt: CONNECTED, brokenSince, brokenWhy: 'Discord refused the saved token (HTTP 401)' });
  D.scene.revoked = true;
  const from = D.requests.length;
  for (const argv of LIVE) {
    const r = await run(...argv);
    ok(r.code === 2 && /not sent again/.test(r.text) && /Settings -> Connection -> Discord/.test(r.text), `${argv.join(' ')}: exit 2, and where to reconnect`);
  }
  ok(D.requests.length === from, `not one request with the dead token (${D.requests.length - from})`);
  const r = await run('whoami');
  ok(/saved for headadmin at 2026-10-11 00:30 \(HTTP 401\)/.test(r.text), `it says whose token, and since when, on the 24-hour clock: ${r.text.split('\n')[0]}`);
  const kept = await run('tickets');
  ok(kept.code === 0 && D.requests.length === from, 'tickets without --live still prints what was kept, asking Discord nothing');
  D.scene.revoked = false;
}

console.log('=== Discord refuses it here first: the note, and nothing more is sent ===');
{
  writeState({ user: { id: ME, username: 'headadmin' }, connectedAt: CONNECTED, lastReadAt: T0 });
  D.scene.revoked = true;
  const from = D.requests.length;
  const r = await run('read', HP);
  ok(r.code === 2 && D.requests.length === from + 1 && /revoked/.test(r.text), 'read: one request, refused, exit 2');
  const note = readRefused(data);
  ok(note && Math.abs(note.at - Date.now()) < 60_000 && note.connectedAt === CONNECTED, `it leaves word: when, and on which connection (${JSON.stringify(note)})`);
  ok(/Word is left for the bot's reader/.test(r.text), 'and says so');
  const there = fs.existsSync(refusedFile(data));
  ok(there && !fs.readFileSync(refusedFile(data), 'utf8').includes(TOKEN) && (fs.statSync(refusedFile(data)).mode & 0o777) === 0o600,
    'the note holds no token, and only the bot\'s user can read it');
  for (const argv of LIVE) {
    const x = await run(...argv);
    ok(x.code === 2 && /not sent again/.test(x.text), `then ${argv.join(' ')}: exit 2 at once`);
  }
  ok(D.requests.length === from + 1, 'and not one more request');

  // The bot's reader, on the same data directory, takes the note as its own.
  const stateStore = new StateStore(path.join(data, 'state.json'));
  const watch = new DiscordWatch({ dataDir: data, configStore: cs, store: stateStore.namespace(NAMESPACE), audit: stateStore.namespace('audit'),
    fetch: D.fetch, sleep: async () => {} });
  const w = await watch.run({ force: true });
  ok(w.skipped === 'broken' && D.requests.length === from + 1, 'the bot\'s next run asks Discord nothing');
  ok(!!note && watch.status().brokenSince === note.at && watch.panelStatus().brokenSince === note.at, 'and the panel says broken since the CLI was refused');
  stateStore.flush();
  D.scene.revoked = false;
}

console.log('=== after a new Connect, the old note counts for nothing ===');
{
  writeState({ user: { id: ME, username: 'headadmin' }, connectedAt: Date.now(), lastReadAt: T0 });
  const from = D.requests.length;
  const r = await run('whoami');
  ok(r.code === 0 && /Signed in as headadmin/.test(r.text) && D.requests.length === from + 1, 'whoami asks Discord again, once');
  fs.rmSync(refusedFile(data), { force: true });
}

console.log('=== where data/ is read-only, it says it could not leave word ===');
if (process.getuid?.() === 0) {
  console.log('  (skipped: root writes through a read-only directory)');
} else {
  writeState({ user: { id: ME, username: 'headadmin' }, connectedAt: CONNECTED });
  fs.chmodSync(data, 0o555);
  D.scene.revoked = true;
  try {
    const r = await run('whoami');
    ok(r.code === 2 && /Could not leave word for the bot's reader/.test(r.text) && /Do not run this again/.test(r.text),
      'exit 2, that the bot finds out on its own next run, and not to run it again');
    ok(!fs.existsSync(refusedFile(data)), 'nothing was written');
  } finally {
    fs.chmodSync(data, 0o755);
    D.scene.revoked = false;
  }
}

console.log('=== in a process of its own, it waits as Discord asks, and finishes ===');
{
  writeState({ user: { id: ME, username: 'headadmin' }, connectedAt: CONNECTED, lastReadAt: T0 });
  // The CLI as a shell runs it (runCli), with fetch aimed at the fake by a
  // preamble, and the box above as its checkout.
  const runner = path.join(box, 'run-cli.mjs');
  const cliUrl = new URL('../tools/discord.mjs', import.meta.url).href;
  fs.writeFileSync(runner, `
const real = globalThis.fetch;
globalThis.fetch = process.env.FETCH_NEVER_ANSWERS ? () => new Promise(() => {}) : (url, init) => {
  const u = new URL(String(url));
  if (u.origin !== 'https://discord.com') throw new Error('aimed at ' + u.origin);
  return real('http://127.0.0.1:${D.port}' + u.pathname + u.search, init);
};
const { runCli } = await import(${JSON.stringify(cliUrl)});
runCli(process.argv.slice(2), { appDir: ${JSON.stringify(box)}, dataDir: ${JSON.stringify(data)}, env: {} });
`);
  const child = (args, env = {}) => new Promise((resolve) => {
    const t0 = Date.now();
    const c = spawn(process.execPath, [runner, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '', ...env } });
    let out = '';
    c.stdout.on('data', (b) => { out += b; });
    c.stderr.on('data', (b) => { out += b; });
    c.on('close', (code) => { printed.push(out); resolve({ code, out, ms: Date.now() - t0 }); });
  });

  D.scene.rateLimit = { times: 1, retryAfter: 1 };
  let from = D.requests.length;
  const a = await child(['whoami']);
  ok(a.code === 0 && /Signed in as headadmin/.test(a.out) && /Watching: 2 server/.test(a.out),
    `a 429 first: it waited and printed the whole answer (exit ${a.code}, ${a.ms} ms)`);
  ok(a.ms >= 1000 && D.requests.length === from + 2, 'it waited the one second Discord asked for, then retried once');

  D.scene.emptyBucket = { resetAfter: 1 };
  from = D.requests.length;
  const b = await child(['tickets', '--live']);
  ok(b.code === 0 && /Server 1100000000000000001: 1 channel/.test(b.out) && /Server 1100000000000000002: 1 channel/.test(b.out),
    `an empty bucket after the first server: it waited, and listed both (exit ${b.code}, ${b.ms} ms)`);
  ok(b.ms >= 1000 && D.requests.length === from + 2, 'one request per server, the second after the reset');

  const c = await child(['whoami'], { FETCH_NEVER_ANSWERS: '1' });
  ok(c.code === 3 && /stopped before it had finished/.test(c.out) && /incomplete/.test(c.out),
    `a request nothing holds open: exit 3, and the answer called incomplete - never a quiet 0 (${c.out.trim()})`);
}

console.log('=== the token is nowhere it was printed or logged ===');
{
  ok(printed.length > 10 && !printed.join('\n').includes(TOKEN), `${printed.length} outputs, none with the token`);
  ok(!logged.some((l) => l.includes(TOKEN)), `${logged.length} log lines, none with the token`);
  ok(!fs.readFileSync(path.join(data, 'state.json'), 'utf8').includes(TOKEN), 'nor state.json');
}

await D.close();
fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
