/* The sealed-backup branch's archive: another machine's backup is kept, not
   a reason to fail.
   Run: node test/sealed-backup-archive.test.mjs

   On 2026-09-29 the owner ran `node tools/backup-secrets.mjs --set-passphrase
   --install-cron` on bot-box, the box running the bot by then, and got "The
   backup did not happen: the sealed-backup branch holds the backup of another
   machine (bot-box4, written 2026-09-23T05:17:01.784Z) ... run
   `node tools/backup-secrets.mjs --take-over` once, by hand". Their answer:
   "move the old backups into a separate folder for archiving purposes and so
   this doesn't fail".

   So the top of the branch stays the current backup, restorable exactly as
   before, and archive/<host>-<machine>/ keeps the last backup of each other
   machine, moved there byte for byte. The box that runs the bot - the
   process from this checkout, the service active AND enabled at boot, and
   the same MASTER_KEY as the backup it replaces - takes the branch over by
   itself. A standby never does, and neither does a second bot on its own
   number: those two are what the machine check was built against, and
   "nothing is lost any more" is no reason to let the top of the branch flip
   between two live bots every night.

   No network: "GitHub" is a bare repository in a temp directory, systemd is a
   fake systemctl, and bot-box4's backup is written in the old one-commit
   layout exactly as the code before this change wrote it. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-archive-test-'));

// Hermetic: never the real ~/.gitconfig, never an inherited passphrase, never
// the real systemd.
fs.writeFileSync(path.join(T, 'gitconfig'), '');
process.env.GIT_CONFIG_GLOBAL = path.join(T, 'gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
delete process.env.BACKUP_PASSPHRASE;
const SYSTEMCTL_STATE = path.join(T, 'systemctl-show.txt');
const FAKE_SYSTEMCTL = path.join(T, 'fake-systemctl');
fs.writeFileSync(FAKE_SYSTEMCTL, `#!/bin/sh
echo "systemctl $*" >> '${T}/systemctl-calls.log'
[ "$1" = show ] || exit 1
[ -f '${SYSTEMCTL_STATE}' ] && cat '${SYSTEMCTL_STATE}'
exit 0
`, { mode: 0o755 });
process.env.SEALED_BACKUP_SYSTEMCTL = FAKE_SYSTEMCTL;
const setSystemd = ({ load = 'loaded', active = 'active', enabled = 'enabled', workdir }) => fs.writeFileSync(SYSTEMCTL_STATE,
  `WorkingDirectory=${workdir ?? ''}\nLoadState=${load}\nActiveState=${active}\nUnitFileState=${enabled}\n`);

const {
  runSealedBackup, snapshotApp, snapshotHome, botServiceState, runsBotHere, decideRoot, botIdentity, archiveFolderName,
  listSealedBackups, fetchSealedBackup, describeSealedBackup, BRANCH, ARCHIVE_DIR, UNLABELLED_STALE_MS,
} = await import('../src/core/sealed-backup.js');
const { sealSecrets, openSecrets, appBundlePaths } = await import('../src/core/activity-backup.js');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const rejects = async (fn, re) => {
  try { await fn(); return null; } catch (err) { return re.test(err.message) ? err : (console.log(`    (got: ${err.message})`), null); }
};
const git = (args, cwd, input) => execFileSync('git', args, { cwd, input, encoding: 'utf8', stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] }).trim();
const gitBuf = (args, cwd) => execFileSync('git', args, { cwd, maxBuffer: 64 << 20 });
const put = (file, data, mode) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  if (mode) fs.chmodSync(file, mode);
};
function walk(root, rel = '') {
  const out = {};
  const abs = path.join(root, rel);
  if (fs.lstatSync(abs).isDirectory()) {
    for (const n of fs.readdirSync(abs)) Object.assign(out, walk(root, path.join(rel, n)));
  } else {
    out[rel] = fs.readFileSync(abs);
  }
  return out;
}
const appFiles = (dir) => {
  const out = {};
  for (const p of appBundlePaths(dir)) Object.assign(out, walk(dir, p));
  return out;
};
const sameFiles = (a, b) => Object.keys(a).length > 3 && Object.keys(a).sort().join() === Object.keys(b).sort().join()
  && Object.keys(a).every((k) => a[k].equals(b[k]));

/* ------------------------------------------------ the fake world ------ */

const remote = path.join(T, 'remote.git');
git(['init', '-q', '--bare', '-b', 'main', remote]);
const seed = path.join(T, 'seed');
git(['init', '-q', '-b', 'main', seed]);
fs.copyFileSync(path.join(REPO, '.gitignore'), path.join(seed, '.gitignore'));
put(path.join(seed, 'README.md'), '# bot\n');
git(['add', '-A'], seed);
git(['-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', 'commit', '-q', '-m', 'seed'], seed);
git(['push', '-q', remote, 'main'], seed);
const mainSha = git(['rev-parse', 'main'], remote);

// The bot's MASTER_KEY travels with a hand-over; a second number has its own.
const MASTER = 'SENTINEL-MASTER-KEY-the-bot-3c1d9e';
const OTHER_MASTER = 'SENTINEL-MASTER-KEY-second-number-77aa';
const PASS_VM4 = 'SENTINEL-PASS bot-box4 had its own passphrase';
const PASS_VM = 'SENTINEL-PASS bot-box chose a new one #2026';
// Fingerprints are 16 hex, as machineFingerprint() makes them. bot-box4's is
// the real one from the live branch's manifest.
const VM4 = '000000005568a657';
const VM = '3deb8b5bca399790';
const VM5 = 'a1b2c3d4e5f60718';
const LAPTOP = '0f0f0f0f12345678';
const SECOND = '99887766aabbccdd';

function makeApp(name, { masterKey = MASTER, passphrase = PASS_VM } = {}) {
  const dir = path.join(T, name);
  git(['clone', '-q', remote, dir]);
  git(['config', 'user.name', 'Test Owner'], dir);
  git(['config', 'user.email', 'owner@example.test'], dir);
  put(path.join(dir, '.env'), `MASTER_KEY=${masterKey}\nBACKUP_PASSPHRASE='${passphrase}'\n`, 0o600);
  put(path.join(dir, 'data/config.json'), JSON.stringify({ omdb: { apiKey: `SENTINEL-OMDB-${name}` } }), 0o600);
  put(path.join(dir, 'data/session/creds.json'), JSON.stringify({ noiseKey: `SENTINEL-NOISE-${name}` }));
  put(path.join(dir, 'data/session/pre-key-1.json'), '{"k":1}');
  put(path.join(dir, 'data/state.json'), JSON.stringify({ history: [name] }));
  put(path.join(dir, 'data/outbound-budget.json'), '{"sent":1}');
  return dir;
}
function makeHome(name) {
  const dir = path.join(T, `${name}-home`);
  put(path.join(dir, '.claude/settings.json'), JSON.stringify({ box: name }));
  put(path.join(dir, '.gitconfig'), `[user]\n\tname = ${name}\n`);
  return dir;
}
const running = (app) => ({ loaded: true, activeState: 'active', active: true, unitFileState: 'enabled', enabled: true, workdir: app, here: true });
const standby = (app) => ({ loaded: true, activeState: 'inactive', active: false, unitFileState: 'disabled', enabled: false, workdir: app, here: true });

/**
 * bot-box4's backup, in the one-commit layout the code before this change
 * wrote, with its manifest's fields exactly as the live branch has them - no
 * botId, no archive/ - and sealed under bot-box4's own passphrase. Written
 * straight into the "GitHub" repository, as bot-box4's push put it there.
 */
async function writeOldLayout({ appDir, homeDir, passphrase, createdAt, repo = remote }) {
  const app = await snapshotApp(appDir);
  const home = await snapshotHome(homeDir);
  const bundle = (snap, file, restoreTo) => ({ file, restoreTo, sha256: snap.digest, files: snap.files, bytes: snap.bytes, paths: snap.paths });
  const manifest = {
    format: 1,
    createdAt,
    source: {
      host: 'bot-box4', machine: VM4, botRunning: true, user: 'mommy', appRoot: '/home/mommy/whatsapp-bot',
      homeDir: '/home/mommy', node: 'v20.20.2', os: 'Linux 6.8.0-139-generic x64',
    },
    encryption: 'AES-256-GCM; key = scrypt(passphrase, N=2^15, r=8, p=1); each file starts with WABKP1',
    bundles: {
      app: bundle(app, 'app.tar.gz.enc', 'the app checkout (~/whatsapp-bot)'),
      home: bundle(home, 'home.tar.gz.enc', '$HOME'),
    },
  };
  const files = {
    'manifest.json': Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    'README.md': Buffer.from(`# Sealed settings backup\n\nWritten ${createdAt} by bot-box4. One commit, replaced\nwhenever something changes; it is not a history.\n`),
    'app.tar.gz.enc': sealSecrets(app.tar, passphrase),
    'home.tar.gz.enc': sealSecrets(home.tar, passphrase),
  };
  const blobs = {};
  for (const [name, buf] of Object.entries(files)) blobs[name] = git(['hash-object', '-w', '--stdin'], repo, buf);
  const tree = git(['mktree'], repo, Object.entries(blobs).map(([n, b]) => `100644 blob ${b}\t${n}`).join('\n') + '\n');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'bot-box4', GIT_AUTHOR_EMAIL: 'x@x', GIT_COMMITTER_NAME: 'bot-box4', GIT_COMMITTER_EMAIL: 'x@x' };
  const sha = execFileSync('git', ['commit-tree', tree, '-m', 'Sealed settings backup from bot-box4'], { cwd: repo, env, encoding: 'utf8' }).trim();
  git(['update-ref', `refs/heads/${BRANCH}`, sha], repo);
  return { sha, blobs, manifest, files };
}

const lsTree = (treeish) => {
  const out = git(['ls-tree', '-r', treeish], remote);
  return Object.fromEntries(out.split('\n').filter(Boolean).map((l) => { const [meta, name] = l.split('\t'); return [name, meta.split(' ')[2]]; }));
};
const branchSha = () => git(['rev-parse', BRANCH], remote);
const showJson = (p) => JSON.parse(git(['show', `${BRANCH}:${p}`], remote));
const blobAt = (p) => gitBuf(['cat-file', 'blob', `${BRANCH}:${p}`], remote);

const vm4App = makeApp('bot-box4', { passphrase: PASS_VM4 });
const vm4Home = makeHome('bot-box4');
const VM4_CREATED = '2026-09-23T05:17:01.784Z';
const vmApp = makeApp('bot-box');
const vmHome = makeHome('bot-box');
// bot-box restored bot-box4's .env and chose a new passphrase afterwards: same
// MASTER_KEY, different BACKUP_PASSPHRASE. Its state has moved on since.
put(path.join(vmApp, 'data/state.json'), JSON.stringify({ history: ['bot-box4', 'bot-box'] }));
const NOW = Date.parse('2026-09-29T05:17:00Z');
const vmBase = { appRoot: vmApp, homeDir: vmHome, passphrase: PASS_VM, machine: VM, now: NOW };

/* ----------------------------------------------------------- tests ---- */

console.log('=== the pieces: systemd as read, what counts as running the bot, the folder name ===');
{
  setSystemd({ workdir: vmApp });
  const s = await botServiceState(vmApp);
  ok(s && s.loaded && s.active && s.enabled && s.here, 'active, enabled, and running this checkout: read off systemctl show');
  ok((await botServiceState(vm4App)).here === false, 'the same unit, asked about another checkout: not here');
  setSystemd({ workdir: `!${vmApp}`, active: 'activating', enabled: 'disabled' });
  const s2 = await botServiceState(vmApp);
  ok(s2.here && !s2.active && !s2.enabled, 'a WorkingDirectory marked "ignore if missing" is still this checkout; activating is not active');
  ok(await botServiceState(vmApp, { systemctl: path.join(T, 'no-such-systemctl') }) === null, 'no systemctl: null, not a guess');
  fs.writeFileSync(SYSTEMCTL_STATE, '');
  ok(await botServiceState(vmApp) === null, 'nothing said: null');

  ok(runsBotHere({ appRoot: vmApp, botRunning: true, service: running(vmApp) }).live, 'process + active + enabled + this checkout: runs the bot');
  const cases = [
    [{ botRunning: false, service: running(vmApp) }, /not running from/],
    [{ botRunning: null, service: running(vmApp) }, /cannot tell/],
    [{ botRunning: true, service: null }, /systemd could not be asked/],
    [{ botRunning: true, service: { ...running(vmApp), active: false, activeState: 'inactive' } }, /is inactive/],
    [{ botRunning: true, service: { ...running(vmApp), enabled: false, unitFileState: 'disabled' } }, /disabled, not enabled at boot/],
    [{ botRunning: true, service: { ...running(vmApp), here: false, workdir: '/srv/other' } }, /runs \/srv\/other, not this one/],
    [{ botRunning: true, service: { loaded: false } }, /not installed here/],
  ];
  ok(cases.every(([c, re]) => { const r = runsBotHere({ appRoot: vmApp, ...c }); return !r.live && r.why.some((w) => re.test(w)); }),
    'any one of them missing - a bot started by hand, a unit not enabled at boot, another clone - is not running the bot, and says which');

  ok(archiveFolderName({ source: { host: 'bot-box4', machine: VM4 } }) === 'bot-box4-00000000', 'folder: <host>-<first 8 of the fingerprint>');
  ok(archiveFolderName({ source: { host: 'bot-box4', machine: VM4 } }, new Set(['bot-box4-00000000'])) === `bot-box4-${VM4}`,
    'a name another machine already has: the whole fingerprint');
  const odd = archiveFolderName({ source: { host: '../../etc\nx y', machine: 'ab/cd' } });
  ok(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(odd) && !odd.includes('..') && !odd.includes('/'), `a hostile host name is made safe (${odd})`);
  ok(botIdentity(vmApp) === botIdentity(vm4App) && /^[0-9a-f]{32}$/.test(botIdentity(vmApp)), 'one MASTER_KEY, one bot identity');
  ok(botIdentity(makeApp('scratch-other', { masterKey: OTHER_MASTER })) !== botIdentity(vmApp), 'another MASTER_KEY, another bot');
  ok(botIdentity(T) === null, 'no .env: no identity');

  const unlabelled = { createdAt: VM4_CREATED, source: { host: 'bot-box4', machine: VM4 } };
  const live = { live: true, why: [] };
  ok(decideRoot({ previous: unlabelled, machine: VM, live, botId: 'x', now: Date.parse(VM4_CREATED) + UNLABELLED_STALE_MS }).action === 'archive',
    `an unlabelled root ${UNLABELLED_STALE_MS / 3600_000} hours old is taken over by the box running the bot`);
  ok(decideRoot({ previous: unlabelled, machine: VM, live, botId: 'x', now: Date.parse(VM4_CREATED) + UNLABELLED_STALE_MS - 1 }).refused === 'recent',
    'a minute younger, it is left alone');
  ok(decideRoot({ previous: { ...unlabelled, createdAt: 'garbage' }, machine: VM, live, botId: 'x', now: NOW }).refused === 'recent',
    'and so is one whose age cannot be read');
  ok(decideRoot({ previous: unlabelled, machine: VM4, live: { live: false, why: ['x'] }, botId: 'x', now: NOW }).action === 'write',
    'its own root is a machine\'s to replace, running or not');
}

console.log('=== the old one-commit layout (bot-box4\'s, no archive/) reads exactly as before ===');
const old = await writeOldLayout({ appDir: vm4App, homeDir: vm4Home, passphrase: PASS_VM4, createdAt: VM4_CREATED });
{
  const reader = path.join(T, 'reader');
  git(['clone', '-q', remote, reader]);
  const l = await listSealedBackups({ appRoot: reader });
  ok(l.root.host === 'bot-box4' && l.root.createdAt === VM4_CREATED && l.archive.length === 0, 'listed: bot-box4 at the root, nothing archived');
  const d = await describeSealedBackup({ appRoot: reader, machine: VM, now: NOW });
  ok(d.host === 'bot-box4' && d.botRunning === true && !d.thisMachine && d.archive.length === 0, 'described as before, with an empty archive');
  const b = await fetchSealedBackup({ appRoot: reader });
  ok(b.app.equals(old.files['app.tar.gz.enc']) && b.home.equals(old.files['home.tar.gz.enc']) && b.folder === null,
    'fetched: the root bundles, byte for byte');
  ok(await rejects(() => fetchSealedBackup({ appRoot: reader, folder: 'bot-box4-00000000' }), /no archived backup called .* has no archived backups/),
    'asking it for an archived backup says there are none');
}

console.log('=== a standby is refused, and nothing moves ===');
{
  const laptop = makeApp('laptop');
  const laptopHome = makeHome('laptop');
  const base = { appRoot: laptop, homeDir: laptopHome, passphrase: PASS_VM, machine: LAPTOP, now: NOW };
  const err = await rejects(() => runSealedBackup({ ...base, botRunning: false, service: standby(laptop) }),
    /holds the backup of another machine \(bot-box4, written 2026-09-23T05:17:01\.784Z\), and this machine is not the one running the bot/);
  ok(err && err.refused === 'standby' && err.root.host === 'bot-box4', 'a laptop kept for failover: refused as a standby, naming the root\'s owner');
  ok(/moves bot-box4's into archive\/ by itself/.test(err?.message) && /--take-over/.test(err?.message), 'and it says what will happen, and the by-hand way');
  ok(branchSha() === old.sha, 'the branch did not move');
  // The bot started by hand on the laptop to try something: the process runs
  // from this checkout, but the unit is not active and enabled here.
  ok(await rejects(() => runSealedBackup({ ...base, botRunning: true, service: standby(laptop) }), /not the one running the bot: whatsapp-bot\.service is inactive/),
    'a bot started by hand, service down: still a standby');
  ok(await rejects(() => runSealedBackup({ ...base, botRunning: true, service: { ...running(laptop), enabled: false, unitFileState: 'disabled' } }),
    /not enabled at boot/), 'the service started but not enabled at boot: still a standby');
  // With no service passed, it is read off (fake) systemd: the unit runs bot-box's checkout, not the laptop's.
  setSystemd({ workdir: vmApp });
  ok(await rejects(() => runSealedBackup({ ...base, botRunning: true }), /runs \S+bot-box, not this one/),
    'measured for real: the unit on this box runs another checkout');
  ok(branchSha() === old.sha && !lsTree(BRANCH)[`${ARCHIVE_DIR}/bot-box4-00000000/manifest.json`], 'and after all of that, still nothing moved and nothing was archived');
  ok(!fs.existsSync(path.join(laptop, 'data/sealed-backup/refs/heads', BRANCH)), 'not even a local commit was made');
}

console.log('=== a root from before bot identities, only hours old, is left alone ===');
{
  const err = await rejects(() => runSealedBackup({ ...vmBase, now: Date.parse(VM4_CREATED) + 5 * 3600_000, botRunning: true, service: running(vmApp) }),
    /from before backups said which bot they belong to, and it is only 5 hours old/);
  ok(err?.refused === 'recent', 'the box running the bot waits: bot-box4 may still be backing up a bot of its own');
  ok(branchSha() === old.sha, 'the branch did not move');
}

console.log('=== the box running the bot takes the branch over, and bot-box4\'s backup is archived byte for byte ===');
let first;
{
  first = await runSealedBackup({ ...vmBase, botRunning: true, service: running(vmApp) });
  ok(first.pushed && first.archived?.folder === 'bot-box4-00000000' && first.archived.by === 'runs-bot',
    `no --take-over needed: pushed, and bot-box4's backup went to ${ARCHIVE_DIR}/${first.archived?.folder}/`);
  ok(/runs the bot now, and bot-box4's backup is 14[34] hours old: it has stopped backing up/.test(first.archived?.why), `and it says why (${first.archived?.why})`);
  ok(git(['rev-list', '--count', BRANCH], remote) === '1' && !/^parent /m.test(git(['cat-file', '-p', BRANCH], remote)),
    'still exactly one parentless commit');
  ok(git(['rev-parse', 'main'], remote) === mainSha, 'main was not touched');

  const tree = lsTree(BRANCH);
  const folder = `${ARCHIVE_DIR}/bot-box4-00000000`;
  ok(JSON.stringify(Object.keys(tree).sort()) === JSON.stringify([
    'README.md', 'app.tar.gz.enc', `${folder}/README.md`, `${folder}/app.tar.gz.enc`, `${folder}/home.tar.gz.enc`,
    `${folder}/manifest.json`, 'home.tar.gz.enc', 'manifest.json',
  ]), `the branch: this machine's backup at the root, bot-box4's in its folder (${Object.keys(tree).join(', ')})`);
  ok(Object.entries(old.blobs).every(([n, sha]) => tree[`${folder}/${n}`] === sha), 'every archived file is the very blob bot-box4 pushed');
  ok(blobAt(`${folder}/app.tar.gz.enc`).equals(old.files['app.tar.gz.enc']), 'byte-identical, not resealed');
  ok(JSON.stringify(showJson(`${folder}/manifest.json`)) === JSON.stringify(old.manifest), 'its manifest intact');
  ok(openSecrets(blobAt(`${folder}/app.tar.gz.enc`), PASS_VM4).length > 0, 'and it still opens with bot-box4\'s own passphrase, never needed here');

  const m = showJson('manifest.json');
  ok(m.source.machine === VM && m.source.botId === botIdentity(vmApp) && m.source.botRunning === true,
    'the root is bot-box\'s, and now says which bot it is');
  ok(openSecrets(blobAt('app.tar.gz.enc'), PASS_VM).length > 0, 'sealed under bot-box\'s passphrase');
  const readme = git(['show', `${BRANCH}:README.md`], remote);
  ok(/took the branch over from bot-box4/.test(readme) && /`archive\/bot-box4-00000000\/`/.test(readme)
    && /--list-archive/.test(readme) && /--from-archive <folder>/.test(readme), 'the README says what was archived, and how to restore it');
  const msg = git(['log', '-1', '--format=%B', BRANCH], remote);
  ok(/Took the branch over from bot-box4/.test(msg) && /archive\/bot-box4-00000000\/, unchanged/.test(msg), 'and so does the commit message');
  ok(first.archive.length === 1 && first.archive[0].host === 'bot-box4' && first.archive[0].createdAt === VM4_CREATED, 'the returned archive lists it');

  // Nothing secret in the clear anywhere: every object in "GitHub".
  const everything = execFileSync('git', ['cat-file', '--batch-all-objects', '--batch'], { cwd: remote, maxBuffer: 64 << 20 });
  const secrets = [MASTER, PASS_VM, PASS_VM4, 'SENTINEL-OMDB-bot-box', 'SENTINEL-NOISE-bot-box4'];
  ok(secrets.every((s) => !everything.includes(Buffer.from(s))), 'no MASTER_KEY, passphrase or key appears anywhere in the remote');
}

console.log('=== the same machine, nightly: the root is replaced, the archive carried untouched ===');
{
  const archiveTree = git(['rev-parse', `${BRANCH}:${ARCHIVE_DIR}`], remote);
  const noop = await runSealedBackup({ ...vmBase, botRunning: true });
  ok(!noop.changed && noop.sha === first.sha && noop.archive.length === 1 && noop.archive[0].folder === 'bot-box4-00000000',
    'nothing changed: no commit, and the archive is still reported');
  put(path.join(vmApp, 'data/state.json'), JSON.stringify({ history: ['bot-box4', 'bot-box', 'night 2'] }));
  // Its own root needs no proof that it runs the bot: systemd is not even asked.
  fs.rmSync(path.join(T, 'systemctl-calls.log'), { force: true });
  const night = await runSealedBackup({ ...vmBase, now: NOW + 86_400_000, botRunning: true });
  ok(night.changed && night.pushed && night.archived === null, 'a change: a new commit, and nothing newly archived');
  ok(git(['rev-parse', `${BRANCH}:${ARCHIVE_DIR}`], remote) === archiveTree, 'archive/ is the very same tree');
  ok(git(['rev-list', '--count', BRANCH], remote) === '1', 'still one commit');
  ok(!fs.existsSync(path.join(T, 'systemctl-calls.log')), 'systemd was not asked about its own root');
  first = night;
}

console.log('=== a second bot on its own number is refused, even running and enabled ===');
{
  const second = makeApp('second-number', { masterKey: OTHER_MASTER });
  const base = { appRoot: second, homeDir: makeHome('second-number'), passphrase: PASS_VM, machine: SECOND, now: NOW + 3 * 86_400_000 };
  const before = branchSha();
  const err = await rejects(() => runSealedBackup({ ...base, botRunning: true, service: running(second) }), /that is a different bot: its MASTER_KEY is not this checkout's/);
  ok(err?.refused === 'other-bot' && /--skip sealed-backup/.test(err.message), 'refused, with the skip a second-number box wants');
  ok(err?.archive?.length === 1 && err.root.machine === VM, 'the refusal carries who holds the root and what is archived');
  ok(branchSha() === before, 'the branch did not move: the first bot\'s nightly job is not broken by the second');
}

console.log('=== a hand-over and back: one folder per machine, the newest copy in it ===');
{
  // bot-box5 replaces bot-box (same MASTER_KEY); then bot-box comes back; then
  // bot-box5 again. Each machine is archived at most once at any time.
  const vm5App = makeApp('bot-box5');
  put(path.join(vm5App, 'data/state.json'), JSON.stringify({ history: ['bot-box5'] }));
  const vm5 = { appRoot: vm5App, homeDir: makeHome('bot-box5'), passphrase: PASS_VM, machine: VM5 };
  const vmRootBlob = lsTree(BRANCH)['app.tar.gz.enc'];

  const t1 = await runSealedBackup({ ...vm5, now: NOW + 4 * 86_400_000, botRunning: true, service: running(vm5App) });
  ok(t1.archived?.by === 'runs-bot' && /same bot .* \(same MASTER_KEY\)/.test(t1.archived.why), 'same bot, new box: taken over by itself, as the same bot');
  const vmFolder = t1.archived.folder;
  ok(lsTree(BRANCH)[`${ARCHIVE_DIR}/${vmFolder}/app.tar.gz.enc`] === vmRootBlob, `bot-box's backup is archive/${vmFolder}/, the same blob`);
  ok(t1.archive.map((a) => a.host).sort().join() === [os.hostname(), 'bot-box4'].sort().join() && t1.archive.length === 2, 'two machines archived');

  put(path.join(vmApp, 'data/state.json'), JSON.stringify({ history: ['back on bot-box'] }));
  const t2 = await runSealedBackup({ ...vmBase, now: NOW + 5 * 86_400_000, takeOver: true, botRunning: false });
  ok(t2.archived?.by === 'take-over' && t2.archived.why === '--take-over was given by hand', '--take-over still works, standby or not, and archives too');
  const folders = () => Object.keys(lsTree(BRANCH)).filter((p) => p.startsWith(`${ARCHIVE_DIR}/`)).map((p) => p.split('/')[1]);
  ok(!folders().includes(vmFolder), 'bot-box is at the root again, so its archived copy is gone - superseded, not kept twice');

  put(path.join(vm5App, 'data/state.json'), JSON.stringify({ history: ['bot-box5 again'] }));
  const t3 = await runSealedBackup({ ...vm5, now: NOW + 6 * 86_400_000, botRunning: true, service: running(vm5App) });
  const archived = [...new Set(folders())];
  ok(archived.length === 2 && archived.includes('bot-box4-00000000') && archived.includes(t3.archived.folder),
    `bot-box archived a second time: one folder for it, not two (${archived.join(', ')})`);
  ok(showJson(`${ARCHIVE_DIR}/${t3.archived.folder}/manifest.json`).createdAt === new Date(NOW + 5 * 86_400_000).toISOString(),
    'and it holds bot-box\'s newer copy');
  ok(lsTree(BRANCH)[`${ARCHIVE_DIR}/bot-box4-00000000/app.tar.gz.enc`] === old.blobs['app.tar.gz.enc'], 'bot-box4\'s is still the very blob it pushed');

  // Back to bot-box for the rest.
  await runSealedBackup({ ...vmBase, now: NOW + 7 * 86_400_000, takeOver: true, botRunning: true });
}

console.log('=== the lease still holds a concurrent push out, mid take-over ===');
{
  // Root: bot-box5's, as if it had pushed last. bot-box takes over by itself -
  // and bot-box5's nightly push lands in between.
  const vm5App = path.join(T, 'bot-box5');
  await runSealedBackup({ appRoot: vm5App, homeDir: path.join(T, 'bot-box5-home'), passphrase: PASS_VM, machine: VM5,
    now: NOW + 8 * 86_400_000, takeOver: true, botRunning: true });
  const vm5Sha = branchSha();
  let intruder;
  put(path.join(vmApp, 'data/state.json'), JSON.stringify({ history: ['raced'] }));
  const err = await rejects(() => runSealedBackup({
    ...vmBase, now: NOW + 9 * 86_400_000, botRunning: true, service: running(vmApp),
    hooks: {
      beforePush: () => {
        const tree = git(['rev-parse', `${vm5Sha}^{tree}`], remote);
        intruder = execFileSync('git', ['commit-tree', tree, '-m', 'bot-box5\'s nightly, pushed a moment later'], {
          cwd: remote, env: { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x' },
          encoding: 'utf8',
        }).trim();
        git(['update-ref', `refs/heads/${BRANCH}`, intruder], remote);
      },
    },
  }), /stale info.* - somebody else pushed to sealed-backup while this ran/);
  ok(err, 'the take-over\'s push is rejected: the lease was pinned before anything was archived');
  ok(branchSha() === intruder && showJson('manifest.json').source.machine === VM5, 'the other push is still there, root and archive as it left them');
  const next = await runSealedBackup({ ...vmBase, now: NOW + 9 * 86_400_000, botRunning: true, service: running(vmApp) });
  ok(next.pushed && next.archived?.machine === VM5 && git(['rev-list', '--count', BRANCH], remote) === '1', 'the next run takes it over cleanly');
}

console.log('=== restore: the root, and an archived folder, from the CLI ===');
{
  const restore = (dir, home, args, extra = {}) => spawnSync(process.execPath, [path.join(REPO, 'tools/restore-secrets.mjs'), ...args, '--app-root', dir],
    { encoding: 'utf8', env: { ...process.env, HOME: home, ...extra } });
  const fresh = (name) => { const d = path.join(T, name); git(['clone', '-q', remote, d]); return { dir: d, home: fs.mkdtempSync(path.join(T, `${name}-home-`)) }; };

  const a = fresh('restore-root');
  const list = restore(a.dir, a.home, ['--list-archive']);
  const host = os.hostname().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  ok(list.status === 0 && new RegExp(`current\\s+${host}, written`).test(list.stdout) && /bot-box4-00000000\s+bot-box4, written 2026-09-23T05:17:01\.784Z, its bot running/.test(list.stdout)
    && /--from-archive <folder>/.test(list.stdout), `--list-archive shows the current backup and every archived one${list.status ? `: ${list.stderr}` : ''}`);
  const info = restore(a.dir, a.home, ['--from-branch', '--info']);
  ok(/^archived=2$/m.test(info.stdout) && /^archivedList=.*bot-box4-00000000 \(bot-box4, 2026-09-23T05:17:01\.784Z\)/m.test(info.stdout),
    '--info tells bootstrap how many are archived, and which');

  const r = restore(a.dir, a.home, ['--from-branch'], { BACKUP_PASSPHRASE: PASS_VM });
  ok(r.status === 0 && /also keeps 2 archived backup\(s\)/.test(r.stdout), `--from-branch restores the root, as before${r.status ? `: ${r.stderr}` : ''}`);
  ok(sameFiles(appFiles(vmApp), appFiles(a.dir)), 'bot-box\'s files, byte for byte');

  const b = fresh('restore-archive');
  const wrong = restore(b.dir, b.home, ['--from-archive', 'bot-box4-00000000'], { BACKUP_PASSPHRASE: PASS_VM });
  ok(wrong.status === 3 && /sealed under the passphrase of the machine that wrote it/.test(wrong.stderr) && !fs.existsSync(path.join(b.dir, '.env')),
    'this machine\'s passphrase on bot-box4\'s archive: exit 3, says why, restores nothing');
  const rb = restore(b.dir, b.home, ['--from-archive', `${ARCHIVE_DIR}/bot-box4-00000000/`], { BACKUP_PASSPHRASE: PASS_VM4 });
  ok(rb.status === 0 && /Archived backup archive\/bot-box4-00000000\//.test(rb.stdout) && /This is NOT the current backup/.test(rb.stdout),
    `--from-archive restores bot-box4's, and says it is not the current one${rb.status ? `: ${rb.stderr}` : ''}`);
  ok(sameFiles(appFiles(vm4App), appFiles(b.dir)), 'bot-box4\'s app files, byte for byte');
  ok(fs.readFileSync(path.join(b.home, '.claude/settings.json'), 'utf8') === JSON.stringify({ box: 'bot-box4' }), 'and its home bundle');

  const c = fresh('restore-bad');
  const nope = restore(c.dir, c.home, ['--from-archive', '../manifest.json'], { BACKUP_PASSPHRASE: PASS_VM });
  ok(nope.status === 1 && /no archived backup called/.test(nope.stderr) && /bot-box4-00000000/.test(nope.stderr),
    'a folder that is not in the archive is refused, listing the ones that are');
  ok(restore(c.dir, c.home, ['--from-archive', 'x', '--from-branch']).status === 1, '--from-archive with --from-branch: refused');
  ok(restore(c.dir, c.home, ['--list-archive', '--only', 'app']).status === 1, '--list-archive takes nothing else');
}

console.log('=== the CLI on the box that runs the bot: bot-box\'s refusal of 2026-09-29, fixed ===');
{
  // Rebuild the morning of 2026-09-29: bot-box4's old-layout backup at the
  // root, six days old, and bot-box running the bot - a real node
  // src/index.js from its checkout, and (fake) systemd saying the unit is
  // active and enabled there.
  const cliRemote = path.join(T, 'cli-remote.git');
  git(['init', '-q', '--bare', '-b', 'main', cliRemote]);
  git(['push', '-q', cliRemote, 'main'], seed);
  // The CLI reads the real clock, so "six days old" is measured from now.
  const created = new Date(Date.now() - 6 * 86_400_000).toISOString();
  const { sha: oldSha } = await writeOldLayout({ appDir: vm4App, homeDir: vm4Home, passphrase: PASS_VM4, createdAt: created, repo: cliRemote });

  const box = path.join(T, 'cli-bot-box');
  git(['clone', '-q', cliRemote, box]);
  git(['config', 'user.name', 'Test Owner'], box);
  git(['config', 'user.email', 'owner@example.test'], box);
  for (const f of ['.env', 'data/config.json', 'data/session/creds.json', 'data/state.json']) {
    put(path.join(box, f), fs.readFileSync(path.join(vmApp, f)), f === '.env' ? 0o600 : undefined);
  }
  const home = makeHome('cli-bot-box');
  const cli = (args, extra = {}) => spawnSync(process.execPath, [path.join(REPO, 'tools/backup-secrets.mjs'), ...args, '--app-root', box],
    { encoding: 'utf8', env: { ...process.env, HOME: home, ...extra } });
  const status = () => JSON.parse(fs.readFileSync(path.join(box, 'data/sealed-backup-status.json'), 'utf8'));

  // First as a standby: no bot process, the unit inactive. Refused, recorded.
  setSystemd({ workdir: box, active: 'inactive', enabled: 'disabled' });
  const s1 = cli(['--cron']);
  ok(s1.status === 1 && /not the one running the bot/.test(s1.stderr), 'with the bot stopped here, the nightly run is refused');
  ok(status().ok === false && status().refused === 'standby' && status().root?.host === 'bot-box4', 'and the status file says why, and whose root it is');
  ok(git(['rev-parse', BRANCH], cliRemote) === oldSha, 'the branch did not move');

  put(path.join(box, 'src/index.js'), 'setInterval(() => {}, 1 << 30);\n');
  const bot = spawn(process.execPath, ['src/index.js'], { cwd: box, stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 300));
    setSystemd({ workdir: box });
    const r = cli(['--cron']);
    ok(r.status === 0, `the same nightly line, with the bot running here: exits 0${r.status ? `: ${r.stderr}` : ''}`);
    ok(/The backup that was there - bot-box4 \(written [^)]+\) in archive\/bot-box4-00000000\/ - was kept, unchanged: this machine runs the bot now/.test(r.stdout),
      'and the log says what was archived, and why');
    const st = status();
    ok(st.ok === true && st.pushed === true && st.archived?.folder === 'bot-box4-00000000' && st.archived.host === 'bot-box4'
      && st.archive?.length === 1 && st.archive[0].createdAt === created, 'the status file records the take-over and the archive');
    ok(JSON.parse(git(['show', `${BRANCH}:manifest.json`], cliRemote)).source.botRunning === true
      && git(['rev-parse', `${BRANCH}:${ARCHIVE_DIR}/bot-box4-00000000/app.tar.gz.enc`], cliRemote) === git(['rev-parse', `${oldSha}:app.tar.gz.enc`], cliRemote),
    'the branch: this box\'s backup at the root, bot-box4\'s blob untouched in the archive');
    const again = cli(['--cron']);
    ok(again.status === 0 && /Nothing changed/.test(again.stdout) && status().archive?.[0]?.folder === 'bot-box4-00000000',
      'the next night: a no-op, still listing the archive');
  } finally {
    bot.kill('SIGKILL');
  }
}

fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
