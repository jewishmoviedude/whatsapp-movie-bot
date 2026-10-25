/* The sealed-backup archive never loses a backup it could not see.
   Run: node test/sealed-backup-archive-safety.test.mjs

   The review of the archive change (2026-09-29) found three ways a backup
   could still vanish from the branch, and reproduced each against a local
   bare remote:

   - A failed git read was taken for "nothing there". One `git ls-tree` that
     failed - a missing object, a git killed by the timeout or the OOM killer
     - and the nightly run pushed a root without archive/, or a take-over
     archived the previous root as an EMPTY folder while the log, the README
     and the status file all said it was moved "unchanged". One failed read of
     manifest.json and the root counted as nobody's, so even a standby with a
     different bot replaced the live bot's backup and archived nothing.
   - A take-over always deleted this machine's own archived folder, as
     "superseded", even when it held a different bot - the only copy of that
     bot on the branch.
   - This machine's own root was replaced outright, unarchived, by a second
     checkout on the same box with its own MASTER_KEY, running or not.

   So every read of the branch throws when git cannot answer, a root that
   cannot be named is refused (--take-over archives it), this machine's folder
   goes only when it is the same bot, a different bot's root on this machine
   is refused like another machine's, and the tree about to be committed is
   read back and checked before anything is committed.

   No network: "GitHub" is a bare repository in a temp directory, and git is
   a wrapper that fails the reads it is told to. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-archive-safety-'));

// Hermetic: never the real ~/.gitconfig, never an inherited passphrase, never
// the real systemd (every run here passes `service` or needs none).
fs.writeFileSync(path.join(T, 'gitconfig'), '');
process.env.GIT_CONFIG_GLOBAL = path.join(T, 'gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
delete process.env.BACKUP_PASSPHRASE;
process.env.SEALED_BACKUP_SYSTEMCTL = path.join(T, 'no-systemctl');

// The failing git. It stands in for the real one everywhere, and passes
// every call through until a flag file says otherwise.
const FLAGS = path.join(T, 'flags');
fs.mkdirSync(FLAGS);
const BIN = path.join(T, 'bin');
fs.mkdirSync(BIN);
process.env.REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
process.env.FAKE_GIT_FLAGS = FLAGS;
fs.writeFileSync(path.join(BIN, 'git'), `#!/bin/sh
if [ "$1" = ls-tree ] && [ -f "$FAKE_GIT_FLAGS/ls-tree" ]; then echo "fatal: not a tree object" >&2; exit 128; fi
if [ "$1" = cat-file ] && [ -f "$FAKE_GIT_FLAGS/cat-file" ]; then echo "fatal: unable to read" >&2; exit 128; fi
# Once: the next tree git is asked to make comes out empty, as a bug that
# lost the entries on the way would make it.
if [ "$1" = mktree ] && [ -f "$FAKE_GIT_FLAGS/mktree-empty-once" ]; then
  rm -f "$FAKE_GIT_FLAGS/mktree-empty-once"; exec "$REAL_GIT" mktree -z </dev/null
fi
exec "$REAL_GIT" "$@"
`, { mode: 0o755 });
process.env.PATH = `${BIN}:${process.env.PATH}`;
const failing = async (flag, fn) => {
  fs.writeFileSync(path.join(FLAGS, flag), '');
  try { return await fn(); } finally { fs.rmSync(path.join(FLAGS, flag), { force: true }); }
};

const {
  runSealedBackup, decideRoot, fetchSealedBackup, listSealedBackups, describeSealedBackup, botIdentity, BRANCH, ARCHIVE_DIR,
} = await import('../src/core/sealed-backup.js');
const { openSecrets } = await import('../src/core/activity-backup.js');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const rejects = async (fn, re) => {
  try { await fn(); console.log('    (it did not throw)'); return null; } catch (err) { return re.test(err.message) ? err : (console.log(`    (got: ${err.message})`), null); }
};
const git = (args, cwd, input) => execFileSync('git', args, { cwd, input, encoding: 'utf8', stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] }).trim();
const put = (file, data, mode) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  if (mode) fs.chmodSync(file, mode);
};

const PASS = 'SENTINEL-PASS safety test passphrase 1';
const NOW = Date.parse('2026-10-01T05:17:00Z');
const DAY = 86_400_000;
const HOST = os.hostname().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 64) || 'unknown-host';
const running = (app) => ({ loaded: true, activeState: 'active', active: true, unitFileState: 'enabled', enabled: true, workdir: app, here: true });

/** A "GitHub" of its own, with main on it, so each scenario starts clean. */
function world(name) {
  const remote = path.join(T, `${name}.git`);
  git(['init', '-q', '--bare', '-b', 'main', remote]);
  const seed = path.join(T, `${name}-seed`);
  git(['init', '-q', '-b', 'main', seed]);
  fs.copyFileSync(path.join(REPO, '.gitignore'), path.join(seed, '.gitignore'));
  put(path.join(seed, 'README.md'), '# bot\n');
  git(['add', '-A'], seed);
  git(['-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', 'commit', '-q', '-m', 'seed'], seed);
  git(['push', '-q', remote, 'main'], seed);
  const ls = (treeish = BRANCH) => Object.fromEntries(git(['ls-tree', '-r', '-t', treeish], remote).split('\n').filter(Boolean)
    .map((l) => { const [meta, n] = l.split('\t'); return [n, meta.split(' ')[2]]; }));
  return { remote, sha: () => git(['rev-parse', BRANCH], remote), ls };
}
function makeApp(w, name, masterKey) {
  const dir = path.join(T, name);
  git(['clone', '-q', w.remote, dir]);
  git(['config', 'user.name', 'Test Owner'], dir);
  git(['config', 'user.email', 'owner@example.test'], dir);
  put(path.join(dir, '.env'), `MASTER_KEY=${masterKey}\n`, 0o600);
  put(path.join(dir, 'data/config.json'), JSON.stringify({ box: name }), 0o600);
  put(path.join(dir, 'data/session/creds.json'), JSON.stringify({ noiseKey: `SENTINEL-NOISE-${name}` }));
  put(path.join(dir, 'data/state.json'), JSON.stringify({ history: [name] }));
  return dir;
}
function makeHome(name) {
  const dir = path.join(T, `${name}-home`);
  put(path.join(dir, '.gitconfig'), `[user]\n\tname = ${name}\n`);
  return dir;
}
const localRef = (app) => fs.existsSync(path.join(app, 'data/sealed-backup/refs/heads', BRANCH))
  ? git(['rev-parse', `refs/heads/${BRANCH}`], path.join(app, 'data/sealed-backup')) : null;
/** A hand-made commit on the branch, as somebody else's push would put it there. */
function pushTree(w, lines, message) {
  const tree = git(['mktree'], w.remote, `${lines.join('\n')}\n`);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x' };
  const sha = execFileSync('git', ['commit-tree', tree, '-m', message], { cwd: w.remote, env, encoding: 'utf8' }).trim();
  git(['update-ref', `refs/heads/${BRANCH}`, sha], w.remote);
  return sha;
}
const blob = (w, text) => git(['hash-object', '-w', '--stdin'], w.remote, text);

/* ----------------------------------------------------------- tests ---- */

console.log('=== decideRoot: a root nobody can name, and this machine\'s root of another bot ===');
{
  const live = { live: true, why: [] };
  const mine = { createdAt: new Date(NOW).toISOString(), source: { host: 'box', machine: 'M', botId: 'bot-1', appRoot: '/srv/one' } };
  ok(decideRoot({ previous: null, hasRoot: false, machine: 'M', live, botId: 'b' }).action === 'write', 'no branch, or an empty root: written');
  ok(decideRoot({ previous: null, machine: 'M', live, botId: 'b' }).action === 'write', 'hasRoot left out still means "is there a manifest", as before');
  const unreadable = decideRoot({ previous: null, hasRoot: true, machine: 'M', live, botId: 'b' });
  ok(unreadable.refused === 'unreadable' && /manifest\.json is missing or is not valid JSON/.test(unreadable.message) && /--take-over/.test(unreadable.message),
    'files at the root and no manifest to read: refused, even for the box running the bot, with the by-hand way');
  ok(decideRoot({ previous: { source: { host: 'x' } }, hasRoot: true, machine: 'M', live, botId: 'b' }).refused === 'unreadable',
    'a manifest that names no machine: the same');
  ok(decideRoot({ previous: null, hasRoot: true, machine: 'M', live, botId: 'b', takeOver: true }).action === 'archive', '--take-over archives it');
  ok(decideRoot({ previous: mine, hasRoot: true, machine: 'M', live: { live: false, why: [] }, botId: 'bot-1' }).action === 'write',
    'this machine\'s own root of the same bot: written, running or not');
  const other = decideRoot({ previous: mine, hasRoot: true, machine: 'M', live, botId: 'bot-2' });
  ok(other.refused === 'other-bot' && /this machine wrote for a different bot \(\/srv\/one/.test(other.message),
    'this machine\'s root of ANOTHER bot: refused, naming the checkout that wrote it');
  ok(decideRoot({ previous: mine, hasRoot: true, machine: 'M', live, botId: 'bot-2', takeOver: true }).action === 'archive', 'and --take-over archives it');
  const { botId, ...unlabelled } = mine.source;
  ok(decideRoot({ previous: { ...mine, source: unlabelled }, hasRoot: true, machine: 'M', live, botId: 'bot-2' }).action === 'write',
    'a root of its own from before manifests named their bot cannot name another one: written, as before');
}

// World 1: A, then B - the same bot on a new box - took the branch over.
const w1 = world('w1');
const KEY = 'SENTINEL-MASTER-KEY-the-bot';
const aApp = makeApp(w1, 'a', KEY);
const bApp = makeApp(w1, 'b', KEY);
const cApp = makeApp(w1, 'c', KEY);
const A = 'aaaaaaaa11111111', B = 'bbbbbbbb22222222', C = 'cccccccc33333333';
await runSealedBackup({ appRoot: aApp, homeDir: makeHome('a'), passphrase: PASS, machine: A, now: NOW, botRunning: true });
const aRoot = w1.ls();
const bRun = await runSealedBackup({ appRoot: bApp, homeDir: makeHome('b'), passphrase: PASS, machine: B, now: NOW + 2 * DAY,
  botRunning: true, service: running(bApp) });
const aFolder = `${ARCHIVE_DIR}/${HOST}-aaaaaaaa`;
const s0 = w1.sha();
const s0Tree = w1.ls();

console.log('=== a failed `git ls-tree` ends the run: a take-over pushes nothing ===');
{
  ok(bRun.archived?.folder === `${HOST}-aaaaaaaa` && s0Tree[`${aFolder}/app.tar.gz.enc`] === aRoot['app.tar.gz.enc'], 'the start: B at the root, A archived');
  const err = await failing('ls-tree', () => rejects(() => runSealedBackup({ appRoot: cApp, homeDir: makeHome('c'), passphrase: PASS, machine: C,
    now: NOW + 4 * DAY, botRunning: true, service: running(cApp) }), /could not read the current backup \(\w{7}\) .*not a tree object\. Nothing was changed/));
  ok(err && !err.refused, 'C, the box now running the same bot, fails with what git said - not a refusal, and not a success');
  ok(w1.sha() === s0, 'the branch did not move: B\'s root and A\'s folder are still there, not an empty folder in their place');
  ok(localRef(cApp) === null, 'and not even a local commit was made');
}

console.log('=== a failed `git ls-tree` ends the run: a nightly run keeps archive/ ===');
{
  put(path.join(bApp, 'data/state.json'), JSON.stringify({ history: ['b', 'night 2'] }));
  const before = localRef(bApp);
  ok(await failing('ls-tree', () => rejects(() => runSealedBackup({ appRoot: bApp, homeDir: makeHome('b'), passphrase: PASS, machine: B,
    now: NOW + 3 * DAY, botRunning: true }), /could not read the current backup/)), 'B\'s own nightly run fails, rather than push a root without archive/');
  ok(w1.sha() === s0 && localRef(bApp) === before, 'the branch did not move, nor B\'s local copy');
  const night = await runSealedBackup({ appRoot: bApp, homeDir: makeHome('b'), passphrase: PASS, machine: B, now: NOW + 3 * DAY, botRunning: true });
  ok(night.pushed && w1.ls()[ARCHIVE_DIR] === s0Tree[ARCHIVE_DIR], 'the next night: pushed, archive/ the very same tree');
}
const s1 = w1.sha();

console.log('=== a failed read of manifest.json ends the run: a standby never writes ===');
{
  const standbyApp = makeApp(w1, 'standby', 'SENTINEL-MASTER-KEY-some-other-bot');
  const base = { appRoot: standbyApp, homeDir: makeHome('standby'), passphrase: PASS, machine: 'dddddddd44444444', now: NOW + 4 * DAY, botRunning: false, service: null };
  ok(await failing('cat-file', () => rejects(() => runSealedBackup(base), /could not read the current backup .*unable to read/)),
    'a standby of another bot, when the manifest cannot be read: fails, instead of taking the root for nobody\'s');
  ok(w1.sha() === s1 && localRef(standbyApp) === null, 'the live bot\'s root is untouched');
  const err = await rejects(() => runSealedBackup(base), /this machine is not the one running the bot/);
  ok(err?.refused === 'standby' && w1.sha() === s1, 'and read properly, it is refused as the standby it is');
}

console.log('=== restore and --list-archive fail on a failed read, rather than report nothing ===');
{
  const reader = path.join(T, 'reader');
  git(['clone', '-q', w1.remote, reader]);
  ok(await failing('ls-tree', () => rejects(() => fetchSealedBackup({ appRoot: reader, folder: `${HOST}-aaaaaaaa` }), /not a tree object/)),
    'restoring an archived folder: git\'s error, not "there is no archived backup called ..."');
  ok(await failing('ls-tree', () => rejects(() => listSealedBackups({ appRoot: reader }), /not a tree object/)), 'listing: the same');
  ok(await failing('ls-tree', () => rejects(() => describeSealedBackup({ appRoot: reader, machine: B }), /not a tree object/)),
    'and what bootstrap asks before restoring: the same');
  ok(await failing('cat-file', () => rejects(() => fetchSealedBackup({ appRoot: reader }), /unable to read/)), 'a bundle git cannot read: an error, never a partial restore');
  const b = await fetchSealedBackup({ appRoot: reader, folder: `${HOST}-aaaaaaaa` });
  ok(openSecrets(b.app, PASS).length > 0 && b.archive.length === 1, 'and when git answers, the archived folder restores as before');
}

console.log('=== the tree about to be committed is checked: an empty archived folder is never pushed ===');
{
  const before = w1.sha();
  const err = await failing('mktree-empty-once', () => rejects(() => runSealedBackup({ appRoot: cApp, homeDir: makeHome('c'), passphrase: PASS,
    machine: C, now: NOW + 5 * DAY, botRunning: true, service: running(cApp) }),
  /refusing to push: the new commit would lose the backup it moves to archive\/\S+-bbbbbbbb\/ \(it would hold 0 of the 4 entries the root had\)/));
  ok(err, 'a take-over whose archived folder came out empty is stopped before it is committed, and says so');
  ok(w1.sha() === before && localRef(cApp) === null, 'nothing was pushed or committed');
  const r = await runSealedBackup({ appRoot: cApp, homeDir: makeHome('c'), passphrase: PASS, machine: C, now: NOW + 5 * DAY,
    botRunning: true, service: running(cApp) });
  const t = w1.ls();
  ok(r.pushed && t[`${ARCHIVE_DIR}/${HOST}-bbbbbbbb/app.tar.gz.enc`] === w1.ls(before)['app.tar.gz.enc']
    && t[`${aFolder}/app.tar.gz.enc`] === aRoot['app.tar.gz.enc'], 'the next run archives B\'s root whole, and keeps A\'s');
}

console.log('=== a root whose manifest cannot be read is refused; --take-over archives it whole ===');
{
  // Somebody's push left files at the root with a manifest that is not JSON,
  // beside the archive C's run left.
  const archiveTree = w1.ls()[ARCHIVE_DIR];
  const junk = { 'manifest.json': blob(w1, '{"format": 1, "source": {'), 'app.tar.gz.enc': blob(w1, 'WABKP1 not really sealed'), 'README.md': blob(w1, '# ?\n') };
  const odd = pushTree(w1, [...Object.entries(junk).map(([n, b]) => `100644 blob ${b}\t${n}`), `040000 tree ${archiveTree}\t${ARCHIVE_DIR}`], 'a push by hand');
  const err = await rejects(() => runSealedBackup({ appRoot: cApp, homeDir: makeHome('c'), passphrase: PASS, machine: C, now: NOW + 6 * DAY,
    botRunning: true, service: running(cApp) }), /manifest\.json is missing or is not valid JSON/);
  ok(err?.refused === 'unreadable' && err.archive.length === 2, 'refused, even on the box running the bot, and the refusal still lists the archive');
  ok(w1.sha() === odd, 'nothing moved');
  const r = await runSealedBackup({ appRoot: cApp, homeDir: makeHome('c'), passphrase: PASS, machine: C, now: NOW + 6 * DAY, takeOver: true, botRunning: true });
  const t = w1.ls();
  const folder = `${ARCHIVE_DIR}/unknown-host-unknown`;
  ok(r.archived?.folder === 'unknown-host-unknown' && Object.entries(junk).every(([n, b]) => t[`${folder}/${n}`] === b),
    '--take-over moves every file that was at the root, as the very same blobs, to archive/unknown-host-unknown/');
  ok(t[`${aFolder}/app.tar.gz.enc`] === aRoot['app.tar.gz.enc'] && t[`${ARCHIVE_DIR}/${HOST}-bbbbbbbb/manifest.json`], 'and keeps the folders already archived');
  const readme = git(['show', `${BRANCH}:README.md`], w1.remote);
  ok(/took the branch over from another machine: --take-over was given by hand/.test(readme) && /written at an unknown time/.test(readme),
    'the README says so without inventing a host or a date');
}

console.log('=== this machine\'s archived folder of ANOTHER bot survives its take-over ===');
{
  // M backed up bot X; N (bot Y) took over by hand, archiving X; then M was
  // set up for bot Y and runs it. M's take-over supersedes nothing of X.
  const w = world('w2');
  const M = 'eeeeeeee55555555', N = 'ffffffff66666666';
  const mX = makeApp(w, 'm-bot-x', 'SENTINEL-MASTER-KEY-bot-x');
  await runSealedBackup({ appRoot: mX, homeDir: makeHome('m-x'), passphrase: PASS, machine: M, now: NOW, botRunning: true });
  const xBlob = w.ls()['app.tar.gz.enc'];
  const nY = makeApp(w, 'n-bot-y', 'SENTINEL-MASTER-KEY-bot-y');
  await runSealedBackup({ appRoot: nY, homeDir: makeHome('n-y'), passphrase: PASS, machine: N, now: NOW + DAY, takeOver: true, botRunning: true });
  const mFolder = `${ARCHIVE_DIR}/${HOST}-eeeeeeee`;
  ok(w.ls()[`${mFolder}/app.tar.gz.enc`] === xBlob, 'the start: bot X, from M, archived');
  const mY = makeApp(w, 'm-bot-y', 'SENTINEL-MASTER-KEY-bot-y');
  const r = await runSealedBackup({ appRoot: mY, homeDir: makeHome('m-y'), passphrase: PASS, machine: M, now: NOW + 2 * DAY,
    botRunning: true, service: running(mY) });
  const t = w.ls();
  ok(r.archived?.by === 'runs-bot' && t[`${ARCHIVE_DIR}/${HOST}-ffffffff/manifest.json`], 'M, now running bot Y, takes the branch over from N by itself');
  ok(t[`${mFolder}/app.tar.gz.enc`] === xBlob && r.archive.length === 2, 'and M\'s folder, holding bot X, is kept: it was not superseded by bot Y');
  ok(JSON.parse(git(['show', `${BRANCH}:${mFolder}/manifest.json`], w.remote)).source.botId === botIdentity(mX), 'its manifest still says bot X');

  // The same bot's copy IS superseded: N takes over by hand, then M again.
  put(path.join(nY, 'data/state.json'), JSON.stringify({ history: ['n again'] }));
  await runSealedBackup({ appRoot: nY, homeDir: makeHome('n-y'), passphrase: PASS, machine: N, now: NOW + 3 * DAY, takeOver: true, botRunning: true });
  ok(w.ls()[`${mFolder}/app.tar.gz.enc`] !== xBlob, 'archived again, M\'s folder holds M\'s newer copy - one folder per machine');
  put(path.join(mY, 'data/state.json'), JSON.stringify({ history: ['m again'] }));
  await runSealedBackup({ appRoot: mY, homeDir: makeHome('m-y'), passphrase: PASS, machine: M, now: NOW + 4 * DAY, takeOver: true, botRunning: true });
  ok(!Object.keys(w.ls()).some((p) => p.startsWith(`${mFolder}/`)), 'and when M\'s backup of that same bot is back at the root, its folder goes');
}

console.log('=== a second checkout on this machine, with its own MASTER_KEY, never replaces the root ===');
{
  const w = world('w3');
  const P = '1234567812345678';
  const one = makeApp(w, 'checkout-one', 'SENTINEL-MASTER-KEY-first');
  await runSealedBackup({ appRoot: one, homeDir: makeHome('one'), passphrase: PASS, machine: P, now: NOW, botRunning: true });
  const oneRoot = w.ls();
  const s = w.sha();
  const two = makeApp(w, 'checkout-two', 'SENTINEL-MASTER-KEY-second');
  const err = await rejects(() => runSealedBackup({ appRoot: two, homeDir: makeHome('two'), passphrase: PASS, machine: P, now: NOW + DAY, botRunning: false }),
    /holds a backup this machine wrote for a different bot/);
  ok(err?.refused === 'other-bot' && err.message.includes(one), 'refused as another bot, naming the checkout whose backup it is');
  ok(w.sha() === s && localRef(two) === null, 'nothing moved');
  const r = await runSealedBackup({ appRoot: two, homeDir: makeHome('two'), passphrase: PASS, machine: P, now: NOW + DAY, takeOver: true, botRunning: true });
  const t = w.ls();
  const folder = `${ARCHIVE_DIR}/${HOST}-12345678`;
  ok(r.archived?.folder === `${HOST}-12345678` && ['manifest.json', 'README.md', 'app.tar.gz.enc', 'home.tar.gz.enc'].every((n) => t[`${folder}/${n}`] === oneRoot[n]),
    '--take-over archives the first checkout\'s backup, blob for blob, instead of dropping it');
  put(path.join(two, 'data/state.json'), JSON.stringify({ history: ['two, night 2'] }));
  const night = await runSealedBackup({ appRoot: two, homeDir: makeHome('two'), passphrase: PASS, machine: P, now: NOW + 2 * DAY, botRunning: true });
  ok(night.pushed && !night.archived && w.ls()[`${folder}/app.tar.gz.enc`] === oneRoot['app.tar.gz.enc'], 'after which its nightly runs are ordinary, the archive kept');
}

console.log('=== archive/ is carried whole: stray files, and folders with no readable manifest ===');
{
  // archive/ as a person might leave it after tidying by hand: a note, and a
  // folder whose manifest is gone.
  const w = world('w4');
  const Q = '9999999988888888', R = '7777777766666666';
  const q = makeApp(w, 'q', KEY);
  await runSealedBackup({ appRoot: q, homeDir: makeHome('q'), passphrase: PASS, machine: Q, now: NOW, botRunning: true });
  const root = git(['ls-tree', BRANCH], w.remote).split('\n');
  const note = blob(w, 'kept by hand: see the owner\'s notes\n');
  const broken = git(['mktree'], w.remote, `100644 blob ${blob(w, 'sealed, manifest lost')}\tapp.tar.gz.enc\n`);
  const arch = git(['mktree'], w.remote, `100644 blob ${note}\tNOTES.txt\n040000 tree ${broken}\tbroken\n`);
  pushTree(w, [...root, `040000 tree ${arch}\t${ARCHIVE_DIR}`], 'tidied by hand');
  put(path.join(q, 'data/state.json'), JSON.stringify({ history: ['q, night 2'] }));
  const night = await runSealedBackup({ appRoot: q, homeDir: makeHome('q'), passphrase: PASS, machine: Q, now: NOW + DAY, botRunning: true });
  ok(night.pushed && w.ls()[ARCHIVE_DIR] === arch, 'a nightly run carries archive/ as the very same tree, the note included');
  const r = makeApp(w, 'r', KEY);
  const took = await runSealedBackup({ appRoot: r, homeDir: makeHome('r'), passphrase: PASS, machine: R, now: NOW + 3 * DAY, botRunning: true, service: running(r) });
  const t = w.ls();
  ok(took.archived && t[`${ARCHIVE_DIR}/NOTES.txt`] === note && t[`${ARCHIVE_DIR}/broken`] === broken
    && t[`${ARCHIVE_DIR}/${took.archived.folder}/manifest.json`], 'a take-over keeps the note and the broken folder beside the newly archived one');
}

fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
