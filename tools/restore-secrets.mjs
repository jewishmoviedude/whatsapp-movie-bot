#!/usr/bin/env node
/**
 * Restore a machine from a sealed backup bundle.
 *
 *   node tools/restore-secrets.mjs <app.tar.gz.enc>          the app bundle, from a file
 *                                                            (or an older secrets.tar.gz.enc)
 *   node tools/restore-secrets.mjs --home <home.tar.gz.enc>  the home bundle, into $HOME
 *   node tools/restore-secrets.mjs --from-branch             both, from origin/sealed-backup
 *   node tools/restore-secrets.mjs --from-branch --only home (or --only app)
 *   node tools/restore-secrets.mjs --from-branch --info      what the branch holds; opens nothing
 *   node tools/restore-secrets.mjs --list-archive            every backup on the branch: the current
 *                                                            one and the archived ones; opens nothing
 *   node tools/restore-secrets.mjs --from-archive <folder>   an archived backup instead of the current
 *                                                            one (--only app|home works here too)
 *
 *   --app-root <dir>   restore into that checkout instead of this one
 *
 * The top of the branch is the current backup, the one --from-branch and
 * tools/bootstrap.sh restore. archive/ keeps the last backup of each other
 * machine that held it, one folder per machine (src/core/sealed-backup.js);
 * an archived one may open only with that machine's passphrase.
 *
 * Unpacks .env, data/config.json, the WhatsApp sessions and the rest of the
 * app bundle back into this checkout, so a fresh box goes from `git clone` to
 * running without a single API key retyped or the number re-linked from a
 * phone. The home bundle puts back Claude Code's settings and memory,
 * ~/.gitconfig and ~/.ssh; anything it would replace is kept as `name.~1~`.
 *
 * The passphrase comes from BACKUP_PASSPHRASE or a hidden prompt, never from
 * a flag - a command line ends up in shell history, in `ps`, and in whatever
 * shipped that history off the box.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSecrets, exitCleanlyOnSignals } from '../src/core/activity-backup.js';
import {
  assertNotRoot, describeSealedBackup, fetchSealedBackup, listSealedBackups, resolvePassphrase, restoreAppBundle,
  restoreHomeBundle, ARCHIVE_DIR, BRANCH,
} from '../src/core/sealed-backup.js';

const USAGE = 'usage: node tools/restore-secrets.mjs <app.tar.gz.enc> [--home <home.tar.gz.enc>]\n'
  + '       node tools/restore-secrets.mjs --from-branch [--only app|home] [--info]\n'
  + '       node tools/restore-secrets.mjs --list-archive\n'
  + '       node tools/restore-secrets.mjs --from-archive <folder> [--only app|home]';

// The home restore stages plaintext in $TMPDIR; Ctrl-C must not leave it there.
exitCleanlyOnSignals();

let appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let appFile = null;
let homeFile = null;
let fromBranch = false;
let fromArchive = null;
let listArchive = false;
let only = null;
let info = false;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--app-root') appRoot = path.resolve(argv[++i] ?? '');
  else if (a === '--home') homeFile = argv[++i] ?? '';
  else if (a === '--from-branch') fromBranch = true;
  else if (a === '--from-archive') fromArchive = argv[++i] ?? '';
  else if (a === '--list-archive') listArchive = true;
  else if (a === '--only') only = argv[++i] ?? '';
  else if (a === '--info') info = true;
  else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
  else if (!a.startsWith('-') && !appFile) appFile = a;
  else { console.error(`unknown argument: ${a}\n${USAGE}`); process.exit(1); }
}
const fail = (m, code = 1) => { console.error(m); process.exit(code); };
// A wrong passphrase gets its own exit code, so tools/bootstrap.sh can ask
// again instead of making somebody re-run the whole rebuild over a typo.
const WRONG_PASSPHRASE = 3;

try { assertNotRoot(); } catch (err) { fail(err.message); }
if (only && !['app', 'home'].includes(only)) fail(`--only takes app or home\n${USAGE}`);
if (fromArchive !== null && !fromArchive) fail(`--from-archive needs the folder --list-archive shows\n${USAGE}`);
if (fromArchive !== null && fromBranch) fail(`--from-archive and --from-branch are two different backups: pick one\n${USAGE}`);
if (listArchive && (fromBranch || fromArchive !== null || appFile || homeFile || info || only)) {
  fail(`--list-archive only lists; it goes on its own\n${USAGE}`);
}
// An archived backup is still a backup on the branch: everything below that
// reads the branch reads it the same way, from its folder.
const fromGit = fromBranch || fromArchive !== null;
if (fromGit && (appFile || homeFile)) fail(`--from-branch reads both bundles from git; do not also name files\n${USAGE}`);
if (!fromGit && !listArchive && !appFile && !homeFile) fail(USAGE);
if (info && !fromBranch) fail(`--info describes the branch: use it with --from-branch\n${USAGE}`);

const when = (a) => `${a.host ?? 'an unknown host'}, written ${a.createdAt ?? 'at an unknown time'}`
  + `${a.botRunning === true ? ', its bot running' : a.botRunning === false ? ', its bot stopped' : ''}`;

if (listArchive) {
  try {
    const l = await listSealedBackups({ appRoot });
    if (!l) { console.log(`There is no ${BRANCH} branch on origin yet.`); process.exit(0); }
    console.log(`The ${BRANCH} branch (${l.sha.slice(0, 7)}):\n`);
    console.log(`  current   ${when(l.root)}   (node tools/restore-secrets.mjs --from-branch)`);
    if (!l.archive.length) {
      console.log(`\nNothing in ${ARCHIVE_DIR}/: no other machine's backup has been archived.`);
      process.exit(0);
    }
    console.log(`\nArchived - the last backup of each other machine that held the branch, newest first:\n`);
    const w = Math.max(...l.archive.map((a) => a.folder.length));
    for (const a of l.archive) console.log(`  ${a.folder.padEnd(w)}   ${when(a)}${a.hasHome ? '' : ', no home bundle'}`);
    console.log('\nRestore one:  node tools/restore-secrets.mjs --from-archive <folder>   (--only home for just ~)');
    console.log('An archived backup may open only with the passphrase of the machine that wrote it.');
    process.exit(0);
  } catch (err) {
    fail(err.message);
  }
}

// For tools/bootstrap.sh, which asks its questions before restoring anything:
// one key=value per line, from the plaintext manifest, no passphrase needed.
if (info) {
  try {
    const d = await describeSealedBackup({ appRoot });
    if (!d) { console.log('present=no'); process.exit(0); }
    // Values come from a plaintext manifest; a line break in one would forge
    // the next key for bootstrap's parser.
    const v = (x) => (x === null || x === undefined ? 'unknown' : String(x).replace(/[\r\n]+/g, ' '));
    console.log([
      'present=yes',
      `sha=${d.sha.slice(0, 7)}`,
      `createdAt=${v(d.createdAt)}`,
      `ageMinutes=${v(d.ageMinutes)}`,
      `host=${v(d.host)}`,
      `botRunning=${v(d.botRunning)}`,
      `thisMachine=${d.thisMachine ? 'yes' : 'no'}`,
      `archived=${d.archive.length}`,
      // One line, for bootstrap to show as it is: "bot-box4-00000000 (bot-box4, 2026-09-23T05:17:01.784Z); ..."
      `archivedList=${d.archive.map((a) => `${a.folder} (${v(a.host)}, ${v(a.createdAt)})`).join('; ')}`,
    ].join('\n'));
    process.exit(0);
  } catch (err) {
    fail(err.message);
  }
}
for (const f of [appFile, homeFile]) if (f !== null && !fs.existsSync(f)) fail(`no such file: ${f}`);

const wantApp = fromGit ? only !== 'home' : Boolean(appFile);
const wantHome = fromGit ? only !== 'app' : Boolean(homeFile);

// Refuse to clobber a machine that is already set up, BEFORE asking for
// anything. Restoring over a live install would swap the WhatsApp session
// under a running bot and orphan whatever config.json currently holds.
if (wantApp) {
  const existing = ['.env', 'data/config.json', 'data/session'].filter((p) => fs.existsSync(path.join(appRoot, p)));
  if (existing.length) {
    console.error('This checkout already has:');
    for (const p of existing) console.error(`  ${p}`);
    fail('\nRestoring would overwrite them. Move them aside first, restore into a fresh clone, '
      + 'or use --from-branch --only home to restore just the home bundle.');
  }
}

let blobs = { app: null, home: null };
if (fromGit) {
  try {
    const b = await fetchSealedBackup({ appRoot, folder: fromArchive });
    const running = b.manifest.source?.botRunning;
    console.log(`${b.folder ? `Archived backup ${ARCHIVE_DIR}/${b.folder}/` : 'Backup'} ${b.sha.slice(0, 7)}: `
      + `written ${b.manifest.createdAt} by ${b.manifest.source?.host ?? 'an unknown host'}`
      + `${running === true ? ', while its bot was running' : running === false ? ', with its bot stopped' : ''}.`);
    if (b.folder) {
      // The current backup is the live bot's; an archived one is what another
      // machine had when it gave the branch up. Say so before anything opens.
      console.log(`  This is NOT the current backup: that is ${when(b.root)} (--from-branch). An archived backup is\n`
        + '  what that machine had when another took the branch over; restore it only to bring that machine\'s bot back.');
    } else if (b.archive.length) {
      console.log(`  The branch also keeps ${b.archive.length} archived backup(s) of other machines: --list-archive.`);
    }
    if (wantApp && running !== false) {
      console.log('  Anything that bot did after that moment is not in this copy. For a hand-over, stop the bot on the old\n'
        + '  machine first, run node tools/backup-secrets.mjs there, and restore that.');
    }
    blobs = { app: wantApp ? b.app : null, home: wantHome ? b.home : null };
    if (wantHome && !b.home) console.log('That backup has no home bundle; restoring the app bundle only.');
  } catch (err) {
    fail(err.message);
  }
} else {
  blobs = { app: appFile ? fs.readFileSync(appFile) : null, home: homeFile ? fs.readFileSync(homeFile) : null };
}

const { passphrase } = await resolvePassphrase({ appRoot, interactive: true }).catch((err) => fail(err.message));
if (!passphrase) fail('nothing entered');

// Open everything before unpacking anything, so a wrong passphrase leaves the
// machine exactly as it was.
const opened = {};
for (const [name, blob] of Object.entries(blobs)) {
  if (!blob) continue;
  try {
    opened[name] = openSecrets(blob, passphrase);
  } catch (err) {
    fail(`Could not open the ${name} bundle: ${err.message}. Nothing was restored.`
      + (fromArchive !== null && /wrong passphrase/.test(err.message)
        ? ' An archived backup is sealed under the passphrase of the machine that wrote it, which may not be this one\'s.' : ''),
      /wrong passphrase/.test(err.message) ? WRONG_PASSPHRASE : 1);
  }
}

if (opened.app) {
  try {
    const r = await restoreAppBundle({ appRoot, tar: opened.app });
    console.log(`\nRestored into ${appRoot}:`);
    for (const p of r.restored) console.log(`  ${p}`);
  } catch (err) {
    fail(err.message);
  }
}

if (opened.home) {
  const homeDir = os.homedir();
  try {
    const r = await restoreHomeBundle({ homeDir, tar: opened.home });
    console.log(`\nRestored into ${homeDir}:`);
    for (const p of r.added) console.log(`  ${p}`);
    for (const p of r.replaced) console.log(`  ${p}   (the file it replaced is kept as ${p}.~N~)`);
    for (const p of r.merged) console.log(`  ${p}   (lines this machine did not have were added; none were removed)`);
    if (!r.added.length && !r.replaced.length && !r.merged.length) console.log('  nothing - every file was already identical');
  } catch (err) {
    fail(err.message);
  }
}

if (opened.app) {
  console.log(`
Before starting: make sure the OLD machine is stopped and disabled.
Two processes on one WhatsApp session is connectionReplaced, which is the
fastest way to lose the number.

  sudo systemctl disable --now whatsapp-bot     # on the OLD machine
  sudo systemctl enable --now whatsapp-bot      # then on this one
`);
}
