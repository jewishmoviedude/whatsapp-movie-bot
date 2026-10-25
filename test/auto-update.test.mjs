/* Pulling updates on every start. Run: node test/auto-update.test.mjs

   The bot gets rebuilt on new Ubuntu boxes fairly often, and each of them
   used to stay on whatever commit it was cloned at until somebody logged in
   and pulled by hand. deploy/auto-update.sh now runs before every start
   (whatsapp-bot.service, ExecStartPre=) and fast-forwards the checkout.

   It runs unattended, at boot, on live installs, so most of what is pinned
   here is what it must REFUSE to do: pull over local edits or local commits,
   leave a half-installed node_modules, switch to code that does not parse,
   or ever stop the bot from starting. Everything runs against a local bare
   repository standing in for GitHub, with npm replaced by a stub - no
   network. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCRIPT = fileURLToPath(new URL('../deploy/auto-update.sh', import.meta.url));
const scriptText = fs.readFileSync(SCRIPT, 'utf8');

const have = (cmd) => spawnSync('bash', ['-c', `command -v ${cmd}`]).status === 0;
if (!have('git') || !have('flock') || !have('timeout')) {
  console.log('  ok   skipped: git, flock and timeout are needed to exercise the script');
  process.exit(0);
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-update-test-'));
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

// A stub npm: records how it was called, and either "installs" a marker into
// the directory it was run in or fails the way a dropped network does.
const STUB_BIN = path.join(ROOT, 'bin');
fs.mkdirSync(STUB_BIN);
fs.writeFileSync(path.join(STUB_BIN, 'npm'), `#!/usr/bin/env bash
echo "$PWD $*" >> "$NPM_LOG"
if [[ -n \${NPM_STUB_FAIL:-} ]]; then echo "npm ERR! network request failed" >&2; exit 1; fi
mkdir -p node_modules && echo new > node_modules/marker
`, { mode: 0o755 });

// A stub systemctl that answers NRestarts - how many times systemd has
// restarted the unit by itself - from a file the test controls.
fs.writeFileSync(path.join(STUB_BIN, 'systemctl'), `#!/usr/bin/env bash
[[ "$*" == *NRestarts* ]] && cat "$NRESTARTS_FILE"
`, { mode: 0o755 });

const GITCONFIG = path.join(ROOT, 'gitconfig');
fs.writeFileSync(GITCONFIG, '[init]\n\tdefaultBranch = main\n');
const baseEnv = {
  PATH: `${STUB_BIN}:${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
  HOME: path.join(ROOT, 'home'),
  GIT_CONFIG_GLOBAL: GITCONFIG,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  NPM_LOG: path.join(ROOT, 'npm.log'),
  NRESTARTS_FILE: path.join(ROOT, 'nrestarts'),
  AUTO_UPDATE_RETRY_DELAYS: '0',
  AUTO_UPDATE_FETCH_ATTEMPTS: '2',
};
fs.mkdirSync(baseEnv.HOME);

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env: baseEnv, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}
function write(dir, files) {
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
}

let n = 0;
/** A "GitHub" (bare repo), a developer clone that pushes to it, and an
 *  installed box cloned from it, the way docs/server-setup.md builds one. */
function world(extra = {}) {
  const dir = path.join(ROOT, `w${n++}`);
  const remote = path.join(dir, 'origin.git');
  const dev = path.join(dir, 'dev');
  const app = path.join(dir, 'app');
  fs.mkdirSync(dir);
  git(dir, 'init', '--bare', '-q', remote);
  git(dir, 'clone', '-q', remote, dev);
  write(dev, {
    '.gitignore': 'node_modules/\ndata/\n.env\n.auto-update-staging/\n.node_modules.old.*\n',
    'package.json': '{"name":"x","type":"module","dependencies":{"a":"1"}}\n',
    'package-lock.json': '{"lockfileVersion":3,"v":1}\n',
    'src/index.js': 'export const version = 1;\n',
    'whatsapp-bot.service': '[Service]\nExecStart=/usr/bin/node src/index.js\n',
    'deploy/auto-update.sh': scriptText,
    ...extra,
  });
  fs.chmodSync(path.join(dev, 'deploy/auto-update.sh'), 0o755);
  git(dev, 'add', '-A');
  git(dev, 'commit', '-qm', 'first');
  git(dev, 'push', '-q', 'origin', 'main');
  git(dir, 'clone', '-q', remote, app);
  fs.mkdirSync(path.join(app, 'data'), { mode: 0o700 });
  write(app, { 'node_modules/marker': 'old\n' });
  const push = (files, msg = 'change') => {
    write(dev, files);
    git(dev, 'add', '-A');
    git(dev, 'commit', '-qm', msg);
    git(dev, 'push', '-q', 'origin', 'main');
    return git(dev, 'rev-parse', 'HEAD');
  };
  const run = (env = {}) => {
    fs.rmSync(baseEnv.NPM_LOG, { force: true });
    const r = spawnSync('bash', [path.join(app, 'deploy/auto-update.sh')], {
      cwd: '/', env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 60_000,
    });
    let status = null;
    try { status = JSON.parse(fs.readFileSync(path.join(app, 'data/auto-update.json'), 'utf8')); } catch { /* checked by the caller */ }
    const npm = fs.existsSync(baseEnv.NPM_LOG) ? fs.readFileSync(baseEnv.NPM_LOG, 'utf8') : '';
    return { code: r.status, out: `${r.stdout}${r.stderr}`, status, npm };
  };
  const head = () => git(app, 'rev-parse', 'HEAD');
  const marker = () => fs.readFileSync(path.join(app, 'node_modules/marker'), 'utf8').trim();
  const leftovers = () => fs.readdirSync(app).filter((f) => f === '.auto-update-staging' || f.startsWith('.node_modules.old'));
  // A start by systemd: `restarts` is its NRestarts at that moment. It goes
  // up only when systemd restarts the bot by itself, after it died.
  const start = (restarts, env = {}) => {
    fs.writeFileSync(baseEnv.NRESTARTS_FILE, `${restarts}\n`);
    return run({ INVOCATION_ID: 'test', AUTO_UPDATE_UNIT: 'whatsapp-bot.service', ...env });
  };
  const state = () => {
    try { return Object.fromEntries(fs.readFileSync(path.join(app, 'data/auto-update.state'), 'utf8').trim().split('\n').map((l) => l.split('='))); } catch { return {}; }
  };
  return { dir, remote, dev, app, push, run, start, state, head, marker, leftovers };
}

console.log('=== a box that is behind is fast-forwarded to what was pushed ===');
{
  const w = world();
  const before = w.head();
  const pushed = w.push({ 'src/index.js': 'export const version = 2;\n' }, 'Make it better');
  const r = w.run();
  ok(r.code === 0, 'exits 0');
  ok(w.head() === pushed, 'HEAD is now the pushed commit');
  ok(fs.readFileSync(path.join(w.app, 'src/index.js'), 'utf8').includes('version = 2'), 'and the file on disk is the new one');
  ok(r.status?.result === 'updated', `data/auto-update.json says "updated" (${r.status?.result})`);
  ok(r.status?.from === before && r.status?.to === pushed && r.status?.commits === 1, 'with from, to and the commit count');
  ok(r.status?.branch === 'origin/main', `and the branch it followed (${r.status?.branch})`);
  ok(/\[auto-update\] .*Make it better/.test(r.out), 'the journal lists the commits it pulled, by subject');
  ok(r.npm === '', 'npm is not run when the dependencies did not change');
  ok(w.marker() === 'old', 'and node_modules is left as it was');

  const again = w.run();
  ok(again.status?.result === 'up-to-date', `a second start finds nothing to do (${again.status?.result})`);
  ok(!Number.isNaN(Date.parse(again.status?.checkedAt)), 'and stamps when it looked');
}

console.log('=== new dependencies are installed BEFORE the switch, off to the side ===');
{
  const w = world();
  const pushed = w.push({ 'package-lock.json': '{"lockfileVersion":3,"v":2}\n' }, 'Bump a dependency');
  const r = w.run();
  ok(w.head() === pushed, 'the update is applied');
  ok(w.marker() === 'new', 'node_modules is the freshly installed one');
  ok(/\.auto-update-staging ci --omit=dev/.test(r.npm), `npm ci ran in the staging directory, production only (${r.npm.trim()})`);
  ok(w.leftovers().length === 0, `no staging directory or old node_modules is left behind (${w.leftovers()})`);
}

console.log('=== a failed npm install leaves the old code AND the old node_modules ===');
{
  // npm ci empties node_modules before installing. Run in place, a dropped
  // network halfway through would leave a bot that cannot start at all.
  const w = world();
  const before = w.head();
  w.push({ 'package-lock.json': '{"lockfileVersion":3,"v":3}\n' });
  const r = w.run({ NPM_STUB_FAIL: '1' });
  ok(r.code === 0, 'still exits 0, so the bot still starts');
  ok(w.head() === before, 'HEAD did not move');
  ok(w.marker() === 'old', 'node_modules is untouched');
  ok(w.leftovers().length === 0, 'the half-finished staging directory is cleared away');
  ok(r.status?.result === 'failed' && /could not install the new dependencies/.test(r.status?.reason) && /network request failed/.test(r.status?.reason), `recorded as a failure, saying why (${r.status?.reason})`);
}

console.log('=== a box given the dev dependencies keeps them ===');
{
  const w = world();
  write(w.app, { 'node_modules/linkedom/package.json': '{}' });
  w.push({ 'package-lock.json': '{"lockfileVersion":3,"v":4}\n' });
  const r = w.run();
  ok(/--include=dev/.test(r.npm), 'npm is asked for them too, so the full test suite still runs there');
}

console.log('=== a commit that does not parse is never switched to ===');
{
  // Every box pulls on its next start; a syntax error on main would take
  // them all down together.
  const w = world();
  const before = w.head();
  w.push({ 'src/index.js': 'export const version = ;\n' }, 'Break it');
  const r = w.run();
  ok(r.code === 0, 'exits 0');
  ok(w.head() === before, 'HEAD stays on the code that works');
  ok(fs.readFileSync(path.join(w.app, 'src/index.js'), 'utf8').includes('version = 1'), 'and so does the file on disk');
  ok(r.status?.result === 'failed' && /does not parse/.test(r.status?.reason) && /src\/index\.js/.test(r.status?.reason),
    `the reason names the file (${r.status?.reason})`);
}

console.log('=== local edits to tracked files are never pulled over ===');
{
  const w = world({ 'we"ird.txt': 'x\n' });
  const before = w.head();
  w.push({ 'src/index.js': 'export const version = 2;\n' });
  fs.writeFileSync(path.join(w.app, 'src/index.js'), 'export const version = "hotfix";\n');
  fs.writeFileSync(path.join(w.app, 'we"ird.txt'), 'edited\n');
  const r = w.run();
  ok(r.code === 0, 'exits 0');
  ok(w.head() === before, 'HEAD did not move');
  ok(fs.readFileSync(path.join(w.app, 'src/index.js'), 'utf8').includes('hotfix'), 'the local edit is still there');
  ok(r.status?.result === 'skipped' && /local changes/.test(r.status.reason), `recorded as skipped on purpose (${r.status?.reason})`);
  ok(r.status !== null, 'and the status file is still valid JSON with a quote in a file name');
}

console.log('=== an untracked file in the way stops the switch, and survives it ===');
{
  const w = world();
  const before = w.head();
  w.push({ 'notes.txt': 'from upstream\n' });
  fs.writeFileSync(path.join(w.app, 'notes.txt'), 'mine\n');
  const r = w.run();
  ok(w.head() === before, 'HEAD did not move');
  ok(fs.readFileSync(path.join(w.app, 'notes.txt'), 'utf8') === 'mine\n', 'the local file is untouched');
  ok(r.status?.result === 'failed', `recorded as a failure (${r.status?.reason})`);
}

console.log('=== local commits, a diverged branch, a pinned commit: all left alone ===');
{
  const ahead = world();
  write(ahead.app, { 'local.txt': 'x\n' });
  git(ahead.app, 'add', '-A');
  git(ahead.app, 'commit', '-qm', 'local work');
  const aheadHead = ahead.head();
  const r1 = ahead.run();
  ok(ahead.head() === aheadHead && r1.status?.result === 'skipped' && /not on origin\/main/.test(r1.status.reason),
    `a box with unpushed commits keeps them (${r1.status?.reason})`);

  const diverged = world();
  write(diverged.app, { 'local.txt': 'x\n' });
  git(diverged.app, 'add', '-A');
  git(diverged.app, 'commit', '-qm', 'local work');
  const divergedHead = diverged.head();
  diverged.push({ 'src/index.js': 'export const version = 2;\n' });
  const r2 = diverged.run();
  ok(diverged.head() === divergedHead && r2.status?.result === 'skipped' && /diverged/.test(r2.status.reason),
    `a diverged box is left for a person (${r2.status?.reason})`);

  const pinned = world();
  git(pinned.app, 'checkout', '-q', '--detach');
  const pinnedHead = pinned.head();
  pinned.push({ 'src/index.js': 'export const version = 2;\n' });
  const r3 = pinned.run();
  ok(pinned.head() === pinnedHead && r3.status?.result === 'skipped' && /detached/.test(r3.status.reason),
    `a detached HEAD stays pinned (${r3.status?.reason})`);

  const loose = world();
  git(loose.app, 'branch', '-q', '--unset-upstream');
  const r4 = loose.run();
  ok(r4.status?.result === 'skipped' && /tracks no remote branch/.test(r4.status.reason), `a branch with no upstream is skipped (${r4.status?.reason})`);
}

console.log('=== no network: it gives up in bounded time and the bot starts anyway ===');
{
  const w = world();
  const before = w.head();
  git(w.app, 'remote', 'set-url', 'origin', path.join(w.dir, 'gone.git'));
  const t0 = Date.now();
  const r = w.run();
  ok(r.code === 0, 'exits 0');
  ok(w.head() === before, 'HEAD did not move');
  ok(/fetch attempt 1 failed/.test(r.out), 'it retried, because the network can lag behind network-online.target');
  ok(r.status?.result === 'failed' && /could not fetch origin\/main after 2 attempts/.test(r.status.reason), `and then said so (${r.status?.reason})`);
  ok(Date.now() - t0 < 30_000, 'without holding up the start');
}

console.log('=== AUTO_UPDATE=0 in .env turns it off; the environment wins over .env ===');
{
  const w = world();
  const before = w.head();
  w.push({ 'src/index.js': 'export const version = 2;\n' });
  fs.writeFileSync(path.join(w.app, '.env'), 'MASTER_KEY=abc\nAUTO_UPDATE="off" # this box is pinned\n');
  const r = w.run();
  ok(w.head() === before && r.status?.result === 'off' && /turned off/.test(r.status.reason),
    `quoted "off" with a comment is honoured, and recorded as off rather than stuck (${r.status?.reason})`);
  ok(!r.out.includes('abc'), 'and nothing else from .env reaches the log');
  const r2 = w.run({ AUTO_UPDATE: '1' });
  ok(r2.status?.result === 'updated', `AUTO_UPDATE=1 in the environment overrides it (${r2.status?.result})`);
}

console.log('=== one run at a time ===');
{
  const w = world();
  const before = w.head();
  w.push({ 'src/index.js': 'export const version = 2;\n' });
  // Another run is mid-install: it holds the lock and owns a staging directory.
  write(w.app, { '.auto-update-staging/package.json': '{}' });
  const holder = spawn('flock', [path.join(w.app, 'data/.auto-update.lock'), 'sleep', '10'], { stdio: 'ignore' });
  await sleep(300);
  const r = w.run();
  holder.kill();
  ok(r.code === 0 && /already running/.test(r.out), 'a second run bows out');
  ok(w.head() === before, 'without touching the checkout');
  ok(fs.existsSync(path.join(w.app, '.auto-update-staging/package.json')), "and without deleting the other run's staging directory");
}

console.log('=== a change to the unit file is pointed out, since the installed copy cannot follow it ===');
{
  const w = world();
  w.push({ 'whatsapp-bot.service': '[Service]\nExecStart=/usr/bin/node src/index.js\nTimeoutStopSec=300\n' });
  const r = w.run();
  ok(/whatsapp-bot\.service changed/.test(r.out), 'the journal says to re-install it');
}

console.log('=== a commit that keeps crashing is taken back out ===');
{
  // Every start opens a WhatsApp socket with no backoff, and the unit
  // restarts every 10s: a commit that dies after connecting would reconnect
  // ~300 times an hour, unattended - the pattern behind the real logouts.
  const w = world();
  const good = w.head();
  const bad = w.push({ 'src/index.js': 'export const version = "crashes";\n' }, 'Crash on start');
  const r1 = w.start(0);
  ok(w.head() === bad && r1.status?.trial === bad, 'the update is applied, on trial');
  const r2 = w.start(1);
  ok(w.head() === bad && /died \d+s after starting \(restart 1 of 3/.test(r2.out), 'one crash is counted, not acted on');
  w.start(2);
  const r4 = w.start(3);
  ok(w.head() === good, `after the third crash-restart it is back on the commit that ran (${w.head().slice(0, 7)})`);
  ok(/rolled-back/.test(r4.out) || /went back to/.test(r4.out), 'and the journal says so');
  ok(r4.status?.rejected === bad, 'the bad commit is remembered');
  ok(r4.status?.result === 'skipped' && /taken back out after it crash-looped/.test(r4.status.reason),
    `and not taken again, although it is still what main points at (${r4.status?.reason})`);
  const r5 = w.start(3);
  ok(w.head() === good && r5.status?.result === 'skipped', 'nor on the next start');

  const fix = w.push({ 'src/index.js': 'export const version = "fixed";\n' }, 'Fix the crash');
  const r6 = w.start(3);
  ok(w.head() === fix && r6.status?.result === 'updated', 'a newer commit is tried as soon as it is pushed');
  ok(r6.status?.rejected === '', 'and the old rejection is forgotten');
}

console.log('=== people restarting it are not crashes ===');
{
  const w = world();
  const pushed = w.push({ 'src/index.js': 'export const version = 2;\n' });
  w.start(4);
  // `systemctl restart` by a person does not move NRestarts.
  for (let i = 0; i < 5; i++) w.start(4);
  ok(w.head() === pushed, 'five quick manual restarts do not roll anything back');
  const outside = world();
  const p2 = outside.push({ 'src/index.js': 'export const version = 2;\n' });
  outside.run();
  for (let i = 0; i < 4; i++) outside.run();
  ok(outside.head() === p2, 'nor do runs outside systemd, where there is no restart count to go by');
}

console.log('=== a commit that runs for a while is kept ===');
{
  const w = world();
  w.push({ 'package-lock.json': '{"lockfileVersion":3,"v":5}\n' });
  w.start(0);
  ok(fs.existsSync(path.join(w.app, '.node_modules.previous/marker')), 'the old node_modules are kept while the update is on trial');
  const r = w.start(1, { AUTO_UPDATE_QUICK_SECS: '0' });
  ok(/keeping it/.test(r.out) && w.state().trial_sha === '', 'a restart long after the start ends the trial');
  ok(!fs.existsSync(path.join(w.app, '.node_modules.previous')), 'and the kept node_modules are cleared away');
}

console.log('=== going back also brings back the dependencies it ran with ===');
{
  const w = world();
  const good = w.head();
  w.push({ 'package-lock.json': '{"lockfileVersion":3,"v":6}\n', 'src/index.js': 'export const version = "crashes";\n' });
  w.start(0);
  ok(w.marker() === 'new', 'the update brought new node_modules');
  w.start(1); w.start(2); w.start(3);
  ok(w.head() === good && w.marker() === 'old', 'the rollback restored the code AND the node_modules it ran with');
  ok(!fs.existsSync(path.join(w.app, '.node_modules.previous')) && w.leftovers().length === 0, 'with nothing left lying around');
}

console.log('=== two updates in a row roll back to the last one that ran, not the one in between ===');
{
  const w = world();
  const good = w.head();
  const a = w.push({ 'package-lock.json': '{"lockfileVersion":3,"v":7}\n' }, 'A');
  w.start(0);
  ok(w.head() === a, 'A is applied');
  const b = w.push({ 'src/index.js': 'export const version = "B crashes";\n' }, 'B');
  w.start(0); // a person restarts it before A has proven anything
  ok(w.head() === b && w.state().trial_prev === good, `B is applied, and going back would still mean ${good.slice(0, 7)}`);
  w.start(1); w.start(2); w.start(3);
  ok(w.head() === good && w.marker() === 'old', 'B crash-loops, and it goes back to the commit that ran - with its node_modules');
}

console.log('=== the catalogue the app writes into library/ does not block updates ===');
{
  // The panel's catalogue rebuild writes library/clean-titles.* into the
  // checkout. Counted as local edits, one rebuild would stop the box from
  // ever updating again.
  const w = world({ 'library/clean-titles.md': 'upstream v1\n', 'library/clean-titles.json': '{"count":1}\n' });
  fs.writeFileSync(path.join(w.app, 'library/clean-titles.md'), 'this box rebuilt it\n');
  const p1 = w.push({ 'src/index.js': 'export const version = 2;\n' });
  w.run();
  ok(w.head() === p1, 'an update that does not touch them goes ahead');
  ok(fs.readFileSync(path.join(w.app, 'library/clean-titles.md'), 'utf8') === 'this box rebuilt it\n', "and keeps this box's rebuild");
  const p2 = w.push({ 'library/clean-titles.md': 'upstream v2\n' });
  const r = w.run();
  ok(w.head() === p2, 'an update that does touch them goes ahead too');
  ok(fs.readFileSync(path.join(w.app, 'library/clean-titles.md'), 'utf8') === 'upstream v2\n', 'with the pushed copy in the checkout');
  const kept = fs.readdirSync(path.join(w.app, 'data/auto-update-replaced'));
  ok(kept.length === 1 && fs.readFileSync(path.join(w.app, 'data/auto-update-replaced', kept[0]), 'utf8') === 'this box rebuilt it\n',
    `and this box's copy kept in data/ (${kept})`);
  ok(/pushed copy replaces/.test(r.out), 'saying so in the journal');
  fs.writeFileSync(path.join(w.app, 'src/index.js'), 'export const version = "hotfix";\n');
  w.push({ 'src/index.js': 'export const version = 3;\n' });
  const r2 = w.run();
  ok(r2.status?.result === 'skipped' && /src\/index\.js/.test(r2.status.reason), 'a real local edit elsewhere still stops it');
}

console.log('=== content/ regenerated by `npm test` does not block updates either ===');
{
  // test/rules-freshness imports tools/build-descriptions.mjs, which rewrites
  // content/ as it loads: one `npm test` on a live box dirtied the tree.
  const w = world({ 'content/README.md': 'v1\n', 'content/descriptions/head-admins.txt': 'v1\n', 'content/rules/rules.txt': 'v1\n' });
  fs.writeFileSync(path.join(w.app, 'content/descriptions/head-admins.txt'), 'regenerated here\n');
  fs.writeFileSync(path.join(w.app, 'content/rules/rules.txt'), 'regenerated here\n');
  const p1 = w.push({ 'content/rules/rules.txt': 'v2\n' });
  w.run();
  ok(w.head() === p1, 'it updates');
  ok(fs.readFileSync(path.join(w.app, 'content/rules/rules.txt'), 'utf8') === 'v2\n', 'the pushed file wins where both changed');
  ok(fs.readFileSync(path.join(w.app, 'content/descriptions/head-admins.txt'), 'utf8') === 'regenerated here\n', 'and the local one stays where only it did');
  write(w.app, { 'content/backups/by-hand.md': 'x\n' });
  git(w.app, 'add', '-A'); git(w.app, 'commit', '-qm', 'by hand');
  git(w.app, 'reset', '-q', '--soft', 'HEAD~1');
  const r = w.run();
  ok(r.status?.result === 'skipped' && /content\/backups\/by-hand\.md/.test(r.status.reason), `content/backups is not generated, and still counts (${r.status?.reason})`);
}

console.log('=== a commit that reaches into data/ or .env is refused ===');
{
  // git treats ignored files as expendable: a commit adding data/config.json
  // would overwrite this box's settings, session and all, without a word.
  const w = world();
  const before = w.head();
  write(w.app, { 'data/config.json': '{"mine":true}\n' });
  const dev = w.dev;
  write(dev, { 'data/config.json': '{"theirs":true}\n' });
  git(dev, 'add', '-f', 'data/config.json');
  git(dev, 'commit', '-qm', 'oops');
  git(dev, 'push', '-q', 'origin', 'main');
  const r = w.run();
  ok(w.head() === before, 'HEAD did not move');
  ok(fs.readFileSync(path.join(w.app, 'data/config.json'), 'utf8') === '{"mine":true}\n', "this box's data/config.json is untouched");
  ok(r.status?.result === 'failed' && /data\/config\.json/.test(r.status.reason), `and the reason names it (${r.status?.reason})`);

  const w2 = world();
  const b2 = w2.head();
  write(w2.app, { 'secret.log': 'mine\n' });
  write(w2.dev, { '.gitignore': 'node_modules/\ndata/\n.env\n*.log\n' });
  git(w2.dev, 'add', '-A'); git(w2.dev, 'commit', '-qm', 'ignore logs'); git(w2.dev, 'push', '-q', 'origin', 'main');
  w2.run();
  write(w2.dev, { 'secret.log': 'theirs\n' });
  git(w2.dev, 'add', '-f', 'secret.log'); git(w2.dev, 'commit', '-qm', 'add a log'); git(w2.dev, 'push', '-q', 'origin', 'main');
  const r2 = w2.run();
  ok(fs.readFileSync(path.join(w2.app, 'secret.log'), 'utf8') === 'mine\n' && /exists here as an ignored local file/.test(r2.status?.reason),
    `nor is any other ignored local file overwritten (${r2.status?.reason})`);
  ok(w2.head() !== b2, '(the harmless commit before it was taken)');
}

console.log('=== --check says what the next start would do, and changes nothing ===');
{
  const w = world();
  const before = w.head();
  w.push({ 'package-lock.json': '{"lockfileVersion":3,"v":8}\n' }, 'Something new');
  const r = spawnSync('bash', [path.join(w.app, 'deploy/auto-update.sh'), '--check'], { env: baseEnv, encoding: 'utf8' });
  ok(r.status === 0 && /would update .* \(1 commit\(s\) from origin\/main\), installing new dependencies first/.test(r.stdout),
    `it names the update and the dependency install (${r.stdout.split('\n')[0]})`);
  ok(/Something new/.test(r.stdout), 'and the commits');
  ok(w.head() === before && w.marker() === 'old', 'HEAD and node_modules are untouched');
  ok(!fs.existsSync(path.join(w.app, 'data/auto-update.json')) && !fs.existsSync(path.join(w.app, 'data/auto-update.state')),
    'and it writes no status: that file describes real starts');
  const bad = spawnSync('bash', [path.join(w.app, 'deploy/auto-update.sh'), '--frobnicate'], { env: baseEnv, encoding: 'utf8' });
  ok(bad.status === 2 && /usage/.test(bad.stderr), 'an unknown option is a usage error, not a run');
}

console.log('=== run by hand while the bot is running, it refuses ===');
{
  // Changing the code under a live process gives a mixed-version bot: the
  // panel's files are read from disk on every request.
  const w = world();
  const before = w.head();
  w.push({ 'src/index.js': 'export const version = 2;\n' });
  const bot = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', 'src/index.js'], { cwd: w.app, stdio: 'ignore' });
  await sleep(300);
  const r = w.run();
  const c = spawnSync('bash', [path.join(w.app, 'deploy/auto-update.sh'), '--check'], { env: baseEnv, encoding: 'utf8' });
  bot.kill();
  ok(r.code === 0 && /the bot is running from .* \(pid \d+\)/.test(r.out), `it says why (${r.out.trim().split('\n')[0]})`);
  ok(w.head() === before, 'and leaves the code alone');
  ok(/would update/.test(c.stdout), '--check still works, since it changes nothing');
  await sleep(100);
  w.run();
  ok(w.head() !== before, 'once the bot has stopped, it updates');
}

console.log('=== a token in the remote URL never reaches the journal or the status file ===');
{
  const w = world();
  git(w.app, 'remote', 'set-url', 'origin', 'https://someone:ghp_SECRETTOKEN123@127.0.0.1:9/nope.git');
  const r = w.run({ AUTO_UPDATE_FETCH_TIMEOUT: '5' });
  const file = fs.readFileSync(path.join(w.app, 'data/auto-update.json'), 'utf8');
  ok(r.status?.result === 'failed', `the fetch fails (${r.status?.reason})`);
  ok(!/SECRETTOKEN/.test(r.out) && !/SECRETTOKEN/.test(file), 'and the token appears in neither');
}

console.log('=== node_modules can never be committed, as a directory or a symlink ===');
{
  // 342e112 committed a node_modules symlink: .gitignore said "node_modules/",
  // which matches only a directory. Every box pulls main, and git would have
  // put that link where each box's real node_modules is.
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const tracked = spawnSync('git', ['ls-files', '--', 'node_modules'], { cwd: repo, encoding: 'utf8' });
  ok(tracked.status !== 0 || tracked.stdout.trim() === '', 'nothing called node_modules is tracked');
  const ignore = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8');
  ok(/^node_modules$/m.test(ignore), '.gitignore names it without a trailing slash, so a symlink is ignored too');
}

console.log('=== the script cannot destroy work ===');
{
  // Commands only: comments and quoted messages may name what it never does.
  const code = scriptText.split('\n').filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/"(?:[^"\\]|\\.)*"/g, '""')).join('\n');
  ok(!/reset[ \t]+(--hard|--merge)|\bgit\b[^\n]*\b(clean|stash|checkout|switch|restore)\b/.test(code), 'no reset --hard, clean, stash, checkout or restore anywhere in it');
  ok((code.match(/reset\s+--quiet\s+--keep/g) ?? []).length === (code.match(/\breset\b/g) ?? []).length,
    'the only reset is --keep, undoing its own fast-forward, which refuses rather than overwrite');
  ok(/merge --ff-only/.test(code), 'it only ever fast-forwards');
  ok(!/source\s+.*\.env|\.\s+.*\.env/.test(code), '.env is read as text, never sourced');
  ok(/GIT_TERMINAL_PROMPT=0/.test(code), 'and git never waits for a password nobody is there to type');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
