#!/usr/bin/env node
/**
 * Seal every setting, login and key on this machine onto the sealed-backup
 * branch, so the next fresh install is tools/bootstrap.sh and one passphrase.
 *
 *   node tools/backup-secrets.mjs --set-passphrase --install-cron   first time
 *   node tools/backup-secrets.mjs                                   back up now
 *
 *   --set-passphrase   choose the passphrase (asked twice, hidden), keep it in
 *                      .env beside MASTER_KEY, then back up
 *   --install-cron     back up every night at 05:17 UTC (about 01:17 in New
 *                      York). On its own it only installs the line; with
 *                      --set-passphrase it also backs up now
 *   --remove-cron      take the nightly line out (on a machine being retired)
 *   --no-push          commit into data/sealed-backup, do not push
 *   --take-over        put this machine's backup at the root of the branch even
 *                      though another machine's is there; that one is moved,
 *                      unchanged, to archive/ on the branch. The box that runs
 *                      the bot (service active and enabled here, the same
 *                      MASTER_KEY as the backup it replaces) does this by
 *                      itself; this is for when it cannot tell
 *   --cron             what the nightly line runs: never prompts
 *   --save-passphrase-from-env
 *                      store $BACKUP_PASSPHRASE in .env and stop (bootstrap.sh)
 *   --app-root <dir>   the checkout to back up (default: this one)
 *
 * The passphrase comes from BACKUP_PASSPHRASE, then .env, then a hidden
 * prompt - never from a flag, because a command line ends up in shell
 * history, in `ps`, and in whatever ships that history off the box.
 *
 * The heavy lifting, and the reasons for it, are in src/core/sealed-backup.js.
 */
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { exitCleanlyOnSignals } from '../src/core/activity-backup.js';
import {
  assertNotRoot, askHidden, checkPassphrase, installCron, readEnvPassphrase, removeCron,
  resolvePassphrase, runSealedBackup, writeEnvPassphrase, writeStatus, BRANCH, CRON_SCHEDULE,
} from '../src/core/sealed-backup.js';

// A backup stages .env, config.json and the session in $TMPDIR in the clear;
// Ctrl-C or a SIGTERM must still remove that copy.
exitCleanlyOnSignals();

const FLAGS = new Set([
  '--set-passphrase', '--install-cron', '--remove-cron', '--no-push', '--take-over', '--cron',
  '--save-passphrase-from-env', '--help', '-h',
]);

let appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = new Set();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--app-root') { appRoot = path.resolve(argv[++i] ?? ''); continue; }
  if (!FLAGS.has(a)) {
    // Anything positional is refused outright: the likeliest thing to be
    // typed there is the passphrase itself.
    console.error(`unknown argument: ${a.startsWith('-') ? a : '(a positional value - never put the passphrase on the command line)'}`);
    console.error('usage: node tools/backup-secrets.mjs [--set-passphrase] [--install-cron] [--no-push] [--take-over]');
    process.exit(2);
  }
  flags.add(a);
}
const has = (f) => flags.has(f);
const cron = has('--cron');
const trigger = cron ? 'cron' : 'manual';
const started = Date.now();
const say = (m) => console.log(cron ? `${new Date().toISOString()} [backup-secrets] ${m}` : m);
// Set once this run is committed to backing up. From then on, every way it
// can fail is written to data/sealed-backup-status.json as well as printed:
// a nightly run that found no passphrase in .env used to exit through here
// and leave the status file saying the last run was fine.
let backupRun = false;
const fail = (m, code = 1, why = m, extra = {}) => {
  console.error(cron ? `${new Date().toISOString()} [backup-secrets] FAILED: ${m}` : `\n${m}`);
  if (backupRun) {
    writeStatus(appRoot, {
      at: new Date().toISOString(), ok: false, trigger, error: why, host: os.hostname(), durationMs: Date.now() - started, ...extra,
    });
  }
  process.exit(code);
};
// "bot-box4 (written 2026-09-23T05:17:01.784Z) in archive/bot-box4-00000000/"
const described = (a) => `${a.host ?? 'unknown host'} (written ${a.createdAt ?? 'at an unknown time'}) in archive/${a.folder}/`;

if (has('--help') || has('-h')) {
  console.log('usage: node tools/backup-secrets.mjs [--set-passphrase] [--install-cron] [--remove-cron] '
    + '[--no-push] [--take-over] [--cron] [--app-root <dir>]');
  process.exit(0);
}

try { assertNotRoot(); } catch (err) { fail(err.message, 2); }

if (has('--set-passphrase')) {
  if (cron || !process.stdin.isTTY) fail('--set-passphrase needs somebody at a terminal to type the passphrase');
  const had = readEnvPassphrase(appRoot);
  say(had
    ? 'Replacing the backup passphrase in .env. The next backup is resealed under the new one.'
    : 'Choose the backup passphrase. It opens the backup on GitHub; keep a copy in your password manager.');
  let first;
  try {
    first = await askHidden('New backup passphrase (12 or more characters): ');
    checkPassphrase(first);
    const again = await askHidden('Type it again: ');
    if (again !== first) fail('The two entries did not match. Nothing was changed.');
    writeEnvPassphrase(appRoot, first);
  } catch (err) {
    fail(`${err.message}. Nothing was changed.`);
  }
  say(`Stored in ${path.join(appRoot, '.env')} (mode 0600).`);
  say('Without this passphrase the backup cannot be opened and a new machine cannot be restored from it.');
}

if (has('--save-passphrase-from-env')) {
  const p = process.env.BACKUP_PASSPHRASE;
  if (!p) fail('--save-passphrase-from-env: BACKUP_PASSPHRASE is not set in the environment');
  const had = readEnvPassphrase(appRoot);
  if (had === p) {
    say('.env already holds this backup passphrase.');
  } else {
    try { writeEnvPassphrase(appRoot, p); } catch (err) { fail(err.message); }
    say(had ? 'Replaced the backup passphrase in .env with the one that opened the backup.'
      : 'Stored the backup passphrase in .env (mode 0600).');
  }
}

if (has('--remove-cron')) {
  try {
    const r = await removeCron();
    say(r.changed ? 'Removed the nightly backup line from this user\'s crontab.' : 'There was no nightly backup line to remove.');
  } catch (err) {
    fail(err.message);
  }
}

let cronInstalled = false;
if (has('--install-cron')) {
  try {
    const r = await installCron({ appRoot, nodePath: process.execPath });
    cronInstalled = true;
    say(r.changed ? `Installed the nightly backup (${CRON_SCHEDULE}, UTC):\n  ${r.line}`
      : 'The nightly backup line is already installed and up to date.');
  } catch (err) {
    fail(err.message);
  }
}

// Installing or removing the cron line and storing the passphrase are
// complete on their own - bootstrap.sh installs the line on a machine whose
// bot may not be started yet, where a backup would be refused. Anything else,
// including the first-time `--set-passphrase --install-cron`, ends in a
// backup, so a mistake shows up now rather than at five in the morning.
const actionOnly = has('--install-cron') || has('--remove-cron') || has('--save-passphrase-from-env');
if (actionOnly && !(has('--set-passphrase') || has('--take-over') || has('--no-push') || cron)) process.exit(0);
backupRun = true;

const { passphrase } = await resolvePassphrase({
  appRoot,
  interactive: !cron && Boolean(process.stdin.isTTY),
}).catch((err) => fail(err.message));
if (!passphrase) {
  fail(cron
    ? 'no BACKUP_PASSPHRASE in .env, and a cron job cannot ask for one. Run `node tools/backup-secrets.mjs --set-passphrase` by hand'
    : 'no passphrase: set BACKUP_PASSPHRASE, or run with --set-passphrase');
}

try {
  if (!cron) say(`Backing up ${appRoot} and ${os.homedir()} ...`);
  const r = await runSealedBackup({
    appRoot,
    passphrase,
    push: !has('--no-push'),
    takeOver: has('--take-over'),
  });
  // The archive is in the record as well as on the branch, so the routines
  // check can say what is kept there without fetching anything.
  writeStatus(appRoot, {
    at: new Date().toISOString(), ok: true, trigger, changed: r.changed, pushed: r.pushed,
    sha: r.sha, host: os.hostname(), durationMs: Date.now() - started,
    archived: r.archived, archive: r.archive,
  });
  if (!r.changed) {
    say(`Nothing changed since the last backup (${r.sha.slice(0, 7)}); no new commit.`);
  } else {
    const m = r.manifest;
    say(`Sealed ${m.bundles.app.files} app file(s)${m.bundles.home ? ` and ${m.bundles.home.files} home file(s)` : ''} `
      + `as ${r.sha.slice(0, 7)}${r.pushed ? `, pushed to ${BRANCH}` : ' (committed locally, not pushed)'}.`);
  }
  if (r.archived) {
    say(`This machine's backup is now the current one. The backup that was there - ${described(r.archived)} - was kept, unchanged: `
      + `${r.archived.why}.`);
  }
  if (r.archive?.length) {
    say(`Archived on the branch: ${r.archive.map(described).join('; ')}. `
      + 'List or restore them with node tools/restore-secrets.mjs --list-archive.');
  }
} catch (err) {
  fail(`The backup did not happen: ${err.message}`
    + (cronInstalled ? '\nThe nightly line is installed and will try again; fix the above and re-run this by hand.' : ''),
  1, err.message, err.refused ? { refused: err.refused, root: err.root, archive: err.archive } : {});
}
