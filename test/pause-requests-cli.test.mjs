/* tools/pause-requests.mjs switches the request pause in data/state.json, and only while the bot is stopped.
   Run: node test/pause-requests-cli.test.mjs

   The request pause (src/core/request-pause.js, the operator's request of
   2026-10-01) is read when the bot starts, before any message is handled.
   The main session restarts the live bot by stopping it, switching the
   pause on with this tool and starting it again, so that no request runs in
   between. A running bot keeps state.json in memory and writes it back
   within half a second, so an edit made under it would be lost without a
   word: the tool refuses while whatsapp-bot.service is active or a
   `node src/index.js` runs on the checkout.

   systemd and the process list are stubbed; the files are in a scratch
   directory. One run of the real script, with a fake `systemctl` that says
   "active", checks the refusal end to end and that it wrote nothing.

   From the review of 2026-10-01: it read DATA_DIR from the environment
   only, while the bot also loads the checkout's .env (dotenv), so a pause
   written from a shell without DATA_DIR went into a new data/state.json and
   the bot started unpaused on its real one; and `on` never said that the
   jobs a restart interrupts wait in the paused queue too. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main, botProcesses, runningBot, dataDirFor } from '../tools/pause-requests.mjs';
import { StateStore } from '../src/core/state.js';
import { JobQueue } from '../src/core/queue.js';
import { RequestPause, NAMESPACE, QUEUE_NAMESPACE } from '../src/core/request-pause.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pause-requests-cli-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const ROOT = path.join(TMP, 'checkout');
fs.mkdirSync(path.join(ROOT, 'src'), { recursive: true });

const stopped = { service: () => 'inactive', procs: () => [] };
function run(argv, deps = {}) {
  const out = [];
  const err = [];
  const code = main(argv, {
    root: ROOT, dataDir: deps.dataDir ?? path.join(ROOT, 'data'), now: () => 1_790_000_000_000,
    out: (s) => out.push(s), err: (s) => err.push(s), ...stopped, ...deps,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const readJson = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));

console.log('=== which processes are the bot on this checkout ===');
{
  const procs = [
    { pid: 10, argv: ['/usr/bin/node', 'src/index.js'], cwd: ROOT },                        // the unit
    { pid: 11, argv: ['node', path.join(ROOT, 'src/index.js')], cwd: '/' },                  // an absolute path
    { pid: 12, argv: ['node', 'src/index.js'], cwd: '/home/someone/other-project' },         // another checkout
    { pid: 13, argv: ['bash', '-c', 'grep src/index.js'], cwd: ROOT },                      // not node
    { pid: 14, argv: ['node', 'src/index.js'], cwd: null },                                  // cwd unreadable: counted
    { pid: process.pid, argv: ['node', 'src/index.js'], cwd: ROOT },                        // this process
  ];
  const found = botProcesses(procs, ROOT).map((p) => p.pid).join();
  ok(found === '10,11,14', `the unit's process, one by absolute path, and one it cannot see into; not another checkout, not grep, not itself (${found})`);
  ok(runningBot({ root: ROOT, service: () => 'active', procs: () => [] }) === 'whatsapp-bot.service is active', 'an active service is a running bot');
  ok(/activating/.test(runningBot({ root: ROOT, service: () => 'activating', procs: () => [] })), 'so is one starting');
  ok(runningBot({ root: ROOT, service: () => null, procs: () => [] }) === null, 'no systemd and no process: not running');
  ok(/pid 10/.test(runningBot({ root: ROOT, service: () => 'inactive', procs: () => procs.slice(0, 1) })), 'a process found by pid');
}

console.log('=== on, with the bot stopped: the request pause and the queue\'s, in data/state.json ===');
{
  const dataDir = path.join(TMP, 'on');
  fs.mkdirSync(dataDir, { recursive: true });
  const before = { 'movie-requests': { history: [{ id: 'h1' }], pending: [{ jobKey: 'j1' }] }, 'request-pause': { held: [{ id: 'x' }] } };
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify(before));
  const r = run(['on', '--by', 'main session'], { dataDir });
  ok(r.code === 0, `it succeeds (${r.err})`);
  const after = readJson(dataDir);
  ok(JSON.stringify(after['request-pause'].state) === JSON.stringify({ paused: true, since: 1_790_000_000_000, by: 'main session', pausedQueue: true }),
    `"request-pause".state is { paused, since, by, pausedQueue } (${JSON.stringify(after['request-pause'].state)})`);
  ok(JSON.stringify(after['queue-pause'].state) === JSON.stringify({ paused: true, since: 1_790_000_000_000, by: 'main session' }),
    '"queue-pause".state pauses the queue with it');
  ok(JSON.stringify(after['movie-requests']) === JSON.stringify(before['movie-requests']), 'everything else in the file is as it was');
  ok(after['request-pause'].held?.[0]?.id === 'x', 'and the held requests are left alone');
  ok(/"request-pause"\.state/.test(r.out) && /PAUSED/.test(r.out), 'it says what it wrote');
  ok(/The queue is paused too: any job the restart interrupted is put back in it and waits there as well/.test(r.out)
    && /queue's own Resume/.test(r.out), 'and that the jobs a restart interrupts wait in the paused queue, until a Resume');

  // What the bot makes of it when it starts.
  const store = new StateStore(path.join(dataDir, 'state.json'));
  const queue = new JobQueue({ concurrency: 1 });
  const rp = new RequestPause({ store: store.namespace(NAMESPACE), queueStore: store.namespace(QUEUE_NAMESPACE), queue });
  rp.restore();
  ok(rp.isPaused() && queue.paused && rp.state().by === 'main session', 'the bot starts with requests and the queue paused');

  const again = run(['on'], { dataDir });
  ok(again.code === 0 && /already paused/.test(again.out) && readJson(dataDir)['request-pause'].state.by === 'main session',
    'on twice changes nothing');

  const off = run(['off'], { dataDir });
  const o = readJson(dataDir);
  ok(off.code === 0 && o['request-pause'].state.paused === false && o['queue-pause'].state.paused === false,
    'off resumes requests, and the queue they paused');
  ok(/at the next start/.test(off.out), 'and says the held one runs at the next start');
}

console.log('=== a queue already paused by hand stays paused through on and off ===');
{
  const dataDir = path.join(TMP, 'queue-paused');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ 'queue-pause': { state: { paused: true, since: 5, by: 'alice' } } }));
  run(['on'], { dataDir });
  ok(readJson(dataDir)['request-pause'].state.pausedQueue === false && readJson(dataDir)['queue-pause'].state.by === 'alice',
    'on: the queue was already paused, so it is not taken over');
  run(['off'], { dataDir });
  ok(readJson(dataDir)['queue-pause'].state.paused === true, 'off: and it stays paused');
}

console.log('=== a fresh install with no state.json yet ===');
{
  const dataDir = path.join(TMP, 'fresh');
  const r = run(['on'], { dataDir });
  ok(r.code === 0 && readJson(dataDir)['request-pause'].state.paused === true, 'it is created, with the pause in it');
}

console.log('=== the data directory, found as the bot finds it: the environment, then .env, then data/ ===');
{
  const root = path.join(TMP, 'with-env');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  ok(dataDirFor(root, {}) === path.join(root, 'data'), 'no DATA_DIR anywhere: <checkout>/data');
  fs.writeFileSync(path.join(root, '.env'), 'MASTER_KEY=abc\nDATA_DIR=/srv/bot-data\n');
  ok(dataDirFor(root, {}) === '/srv/bot-data', 'DATA_DIR in the checkout\'s .env, as dotenv gives it to the bot');
  ok(dataDirFor(root, { DATA_DIR: '/elsewhere' }) === '/elsewhere', 'the environment first, as dotenv never overrides it');
  fs.writeFileSync(path.join(root, '.env'), 'DATA_DIR="state-here"\n');
  ok(dataDirFor(root, {}) === path.join(root, 'state-here'), 'a relative one is from the checkout, where the unit runs the bot');

  // The real file, through main's own default (its environment has no DATA_DIR here).
  const real = path.join(root, 'state-here');
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, 'state.json'), JSON.stringify({ 'movie-requests': { history: [] } }));
  const env = process.env.DATA_DIR;
  delete process.env.DATA_DIR;
  const out = [];
  const err = [];
  let code;
  try {
    code = main(['on', '--by', 'main session'], { root, now: () => 5, out: (x) => out.push(x), err: (x) => err.push(x), ...stopped });
  } finally { if (env != null) process.env.DATA_DIR = env; }
  ok(code === 0 && JSON.parse(fs.readFileSync(path.join(real, 'state.json'), 'utf8'))['request-pause']?.state?.paused === true,
    `on writes the pause into the state.json the bot reads (${err.join(' ')})`);
  ok(!fs.existsSync(path.join(root, 'data', 'state.json')), 'and makes no new data/state.json beside it');

  // A checkout with a .env whose state.json is not where it looks: not the bot's file.
  const lost = path.join(TMP, 'not-the-bots');
  const r = run(['on'], { root, dataDir: lost });
  ok(r.code === 1 && /does not exist, yet this checkout has a \.env/.test(r.err) && /Set DATA_DIR/.test(r.err),
    `refused, saying why and what to do (${r.err.split('\n')[0]})`);
  ok(!fs.existsSync(path.join(lost, 'state.json')), 'and nothing is created there');
  ok(run(['off'], { root, dataDir: lost }).code === 1, 'off likewise');
  ok(run(['status'], { root, dataDir: lost }).code === 0, 'status still answers');
}

console.log('=== refused while the bot runs, and the file untouched ===');
{
  const dataDir = path.join(TMP, 'running');
  fs.mkdirSync(dataDir, { recursive: true });
  const text = JSON.stringify({ 'movie-requests': { history: [] } });
  fs.writeFileSync(path.join(dataDir, 'state.json'), text);
  const a = run(['on'], { dataDir, service: () => 'active' });
  ok(a.code === 1 && /refusing - whatsapp-bot\.service is active/.test(a.err), 'the service active: refused, and why');
  ok(/pause-requests/.test(a.err) && /Pause requests/.test(a.err), 'pointing at the live ways to pause: the panel and the command channel');
  const b = run(['off'], { dataDir, procs: () => [{ pid: 4242, argv: ['node', 'src/index.js'], cwd: ROOT }] });
  ok(b.code === 1 && /pid 4242/.test(b.err), 'a node src/index.js on this checkout: refused');
  ok(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8') === text, 'nothing was written either time');
  const s = run(['status'], { dataDir, service: () => 'active' });
  ok(s.code === 0 && /requests: not paused/.test(s.out) && /bot: running/.test(s.out), 'status still answers, read-only, and says the bot runs');
}

console.log('=== a state.json it cannot read is never replaced ===');
{
  const dataDir = path.join(TMP, 'broken');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'state.json'), '{"movie-requests": {"hist');
  const r = run(['on'], { dataDir });
  ok(r.code === 1 && /not valid JSON/.test(r.err), 'refused, saying why');
  ok(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8') === '{"movie-requests": {"hist', 'and the file is as it was');
}

console.log('=== usage ===');
{
  ok(run([]).code === 2 && run(['pause']).code === 2 && run(['on', '--nope']).code === 2, 'anything else is a usage error');
}

console.log('=== the real script, with systemctl saying "active" ===');
{
  const bin = path.join(TMP, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'systemctl'), '#!/bin/sh\necho active\nexit 0\n', { mode: 0o755 });
  const dataDir = path.join(TMP, 'spawned');
  const script = fileURLToPath(new URL('../tools/pause-requests.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script, 'on'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DATA_DIR: dataDir },
  });
  ok(r.status === 1 && /whatsapp-bot\.service is active/.test(r.stderr), `it refuses (exit ${r.status})`);
  ok(!fs.existsSync(path.join(dataDir, 'state.json')), 'and writes nothing');
  const st = spawnSync(process.execPath, [script, 'status'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DATA_DIR: dataDir },
  });
  ok(st.status === 0 && /requests: not paused/.test(st.stdout), 'status works from the command line');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
