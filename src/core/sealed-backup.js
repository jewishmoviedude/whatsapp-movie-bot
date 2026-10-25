/**
 * The whole machine, sealed, on one branch of the bot's own repository.
 *
 * The bot gets rebuilt on new Ubuntu boxes often, and every rebuild so far has
 * meant retyping API keys, re-linking the number from a phone, and redoing the
 * machine tweaks by hand from memory - the systemd unit's node path, the disk
 * growth, the Hyper-V NIC fix, passwordless sudo, Tailscale SSH. This keeps
 * everything that is not in git on the `sealed-backup` branch, so a rebuild is:
 * install gh, `gh auth login`, clone, run tools/bootstrap.sh, type the
 * passphrase once.
 *
 * NOTHING SECRET GOES IN IN THE CLEAR. Commit c4a0fe7 set that policy and the
 * reasons have not changed: the app bundle is the whole account (the WhatsApp
 * device keys, every API key, every admin password hash, and the MASTER_KEY
 * that decrypts them), and git history is permanent. So both bundles are
 * sealed with sealSecrets() from activity-backup.js - AES-256-GCM under a
 * scrypt key from a passphrase - and the only plaintext on the branch is a
 * manifest and a README that name what is inside without any value from it.
 *
 * Two bundles:
 *
 *   app   the paths in APP_BUNDLE_PATHS (activity-backup.js), from the app
 *         checkout: .env, data/config.json, the sessions, state, the outbound
 *         budget, description backups, filter CAs.
 *   home  an allowlist from $HOME: Claude Code's settings, agents, commands,
 *         skills and memory, ~/.gitconfig, ~/.ssh. NEVER ~/.config/gh/hosts.yml
 *         (the gh token: the repository is private, so `gh auth login` has to
 *         happen before the branch can even be fetched, and a token in a backup
 *         outlives every rotation) and NEVER ~/.claude.json (machine identity
 *         and caches, which would make two boxes the same Claude Code install).
 *         Transcripts and caches under ~/.claude are left out too.
 *
 * The branch is kept at exactly ONE commit. Each run that has something new
 * makes a fresh parentless commit and force-pushes it, so superseded
 * ciphertext does not pile up in the branch's history, and a clone of the
 * branch carries one copy of the session, not one per night.
 *
 * Its layout:
 *
 *   manifest.json, README.md, app.tar.gz.enc, home.tar.gz.enc
 *        the current backup, at the root: what tools/bootstrap.sh and
 *        `restore-secrets.mjs --from-branch` restore
 *   archive/<host>-<machine>/
 *        the last backup of each OTHER machine that wrote the root, moved
 *        there unchanged when this machine took the root over - one folder
 *        per machine, replaced by that machine's newer copy if it is archived
 *        again, so nothing piles up night after night
 *
 * The owner asked for the archive on 2026-09-29, after bot-box - the box then
 * running the bot - refused its first backup because the root still held
 * bot-box4's: "move the old backups into a separate folder for archiving
 * purposes and so this doesn't fail". Archived folders are carried from
 * commit to commit as tree entries, never opened: one may be sealed under
 * another machine's passphrase, and this machine has no business reading it.
 *
 * That is housekeeping, NOT revocation. A force-pushed commit is still on
 * GitHub, fetchable by its sha, until GitHub support purges it, and every
 * checkout that fetched it keeps it in its reflog for 90 days - a review on
 * 2026-09-22 opened a superseded blob with the old passphrase after a
 * reseal. So changing the passphrase protects future backups only. If the
 * passphrase (or a copy of the backup) has leaked, what protects the account
 * is rotating what is inside: MASTER_KEY, the API keys, the admin passwords,
 * and re-linking the number.
 *
 * The force-push is fenced three ways: the refspec is always exactly
 * refs/heads/sealed-backup (main and activity-backups cannot be named), the
 * lease is pinned to the sha fetched at the start of the run, so a concurrent
 * push is never overwritten, and a root last written by a different machine
 * (or by this one for a different bot) is replaced - moved to archive/, never
 * dropped - only by the machine that now runs that same bot, or on
 * --take-over (see decideRoot below). A standby never touches it. A run that
 * cannot read everything on the branch pushes nothing, and the tree about to
 * be committed is read back and checked before it is (assertNothingLost).
 *
 * The commits are made in a bare repository of their own at
 * data/sealed-backup/, never in the app checkout, which is the live production
 * one: a scheduled job leaving it dirty or on another branch would break the
 * next `git pull` during an upgrade. Same reasoning as activity-backup.js.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import dotenv from 'dotenv';
import log from '../util/logger.js';
import {
  sealSecrets, openSecrets, appBundlePaths, snapshotBundle, makeStagingDir, isAppBundlePath, APP_BUNDLE_PATHS,
} from './activity-backup.js';

const logger = log.scope('sealed-backup');

export const BRANCH = 'sealed-backup';
const REF = `refs/heads/${BRANCH}`;
const REMOTE_REF = `refs/remotes/origin/${BRANCH}`;
export const CLONE_SUBDIR = path.join('data', 'sealed-backup');
export const STATUS_FILE = path.join('data', 'sealed-backup-status.json');
export const MANIFEST_FORMAT = 1;
export const BUNDLE_FILES = Object.freeze({ app: 'app.tar.gz.enc', home: 'home.tar.gz.enc' });
export const MIN_PASSPHRASE = 12;
/** Where other machines' backups are kept on the branch. */
export const ARCHIVE_DIR = 'archive';
/**
 * How old a root that does not say which bot it belongs to must be before the
 * machine running the bot moves it to archive/ without being told. Manifests
 * written before 2026-09-29 carry no source.botId - bot-box4's, at the root
 * when this was written, is one - so for those the only evidence that their
 * machine has stopped backing up a live bot is that it has missed a night: a
 * running bot changes its session and state every day, and the nightly job
 * commits whenever something changed.
 */
export const UNLABELLED_STALE_MS = 36 * 3600_000;

// A backup without these would restore a bot that cannot read its own
// settings, which is worse than no backup because it looks like one.
const REQUIRED_APP_PATHS = ['.env', 'data/config.json'];

const GIT_TIMEOUT_MS = 120_000;
// The push carries the whole sealed session. This box once uploaded at
// 2 Mbit/s with 20% TCP loss (the Hyper-V offload problem in
// docs/server-setup.md), so give it room rather than failing a slow night.
const PUSH_TIMEOUT_MS = 600_000;

/**
 * What is taken from $HOME. An allowlist: a new file under ~/.claude stays
 * out until somebody decides it belongs. `*` matches one directory level.
 */
export const HOME_ALLOWLIST = Object.freeze([
  '.claude/settings.json',
  '.claude/CLAUDE.md',
  '.claude/keybindings.json',
  '.claude/agents',
  '.claude/commands',
  '.claude/skills',
  '.claude/projects/*/memory',
  '.gitconfig',
  '.ssh',
]);

/**
 * Never bundled and never restored, whatever the allowlist says. Checked on
 * the way in (snapshot) and on the way out (restore), so a mistaken edit to
 * the allowlist - say, adding all of `.config` - fails instead of quietly
 * sealing the gh token into a file that outlives every token rotation.
 */
export const HOME_NEVER = Object.freeze([
  '.config/gh',
  '.claude.json',
  '.claude/remote',
  '.claude/sessions',
  '.claude/cache',
  '.claude/shell-snapshots',
  '.claude/backups',
  '.claude/session-env',
]);

const lexists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const firstLine = (s) => String(s ?? '').trim().split('\n')[0];
// git's first stderr line is often just "To <remote>"; the reason is further
// down. Prefer the line that says what went wrong.
const whyLine = (s) => {
  const lines = String(s ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /^(fatal|error):|\[(remote )?rejected\]/.test(l)) ?? lines[0] ?? '';
};

/* ------------------------------------------------------------ plumbing --- */

/**
 * Run git with a hard timeout. A scheduled job that hangs on a stalled push
 * holds nothing useful and hides the failure, so every call is bounded, and
 * GIT_TERMINAL_PROMPT=0 makes a missing credential an error instead of a cron
 * job waiting forever for somebody to type a password.
 */
function git(args, { cwd, input, timeout = GIT_TIMEOUT_MS, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, {
      cwd,
      timeout,
      maxBuffer: 512 << 20,
      encoding: 'buffer',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    }, (err, stdout, stderr) => {
      if (err) {
        const why = err.killed ? `timed out after ${Math.round(timeout / 1000)}s` : (whyLine(stderr) || err.message);
        const e = new Error(`git ${args[0]}: ${why}`);
        e.exitCode = typeof err.code === 'number' ? err.code : null;
        return reject(e);
      }
      resolve(stdout);
    });
    child.stdin.on('error', () => { /* git exited before reading; the callback reports it */ });
    child.stdin.end(input ?? undefined);
  });
}

function tar(args, { input, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('tar', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 512 << 20, encoding: 'buffer' },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`tar: ${firstLine(stderr) || err.message}`));
        resolve(stdout);
      });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? undefined);
  });
}

/**
 * Member names of a gzipped tar held in memory, exactly as stored.
 *
 * --quoting-style=literal, because tar's default display escapes a backslash
 * as `\\` and, under a C or POSIX locale (a bare SSH session), every non-ASCII
 * byte as octal. Those display names match no file on disk, and the home
 * restore used to skip them as "unchanged": a memory file with a Hebrew name
 * was never restored, and nothing said so. A name containing a newline still
 * splits in two here; the restores treat a name they cannot find as an error.
 */
export async function listTar(tarBuffer) {
  return String(await tar(['-tzf', '-', '--quoting-style=literal'], { input: tarBuffer })).split('\n').filter(Boolean);
}

/**
 * A member name in the exact form these bundles write - relative, with no
 * `.`, `..` or empty segments - minus a directory's trailing slash. Anything
 * else returns null.
 *
 * The allowlist and HOME_NEVER checks compare plain strings, so they only mean
 * something for names in this form: `./.claude.json` and `.config//gh/hosts.yml`
 * are not equal to `.claude.json` and `.config/gh/hosts.yml`, and tar would
 * extract them to exactly those places. Our own bundles never contain such a
 * name, so refusing them costs nothing.
 */
export function canonicalMember(name) {
  const rel = String(name).endsWith('/') ? String(name).slice(0, -1) : String(name);
  if (!rel || rel.startsWith('/') || rel.endsWith('/')) return null;
  if (rel.split('/').some((s) => s === '' || s === '.' || s === '..')) return null;
  return rel === path.posix.normalize(rel) ? rel : null;
}

/* ------------------------------------------------------------- guards --- */

/**
 * Running this as root would leave data/sealed-backup and the restored files
 * owned by root, and the bot - which runs as its own user - could then not
 * read its own session. Refuse rather than half-work.
 */
export function assertNotRoot() {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    throw new Error('run this as the user that owns the bot, not as root (no sudo) - '
      + 'files it writes as root would be unreadable to the bot');
  }
}

export function checkPassphrase(passphrase) {
  const p = String(passphrase ?? '');
  if (p.length < MIN_PASSPHRASE) {
    throw new Error(`the backup passphrase must be at least ${MIN_PASSPHRASE} characters`);
  }
  if (/[\r\n\0]/.test(p)) throw new Error('the backup passphrase cannot contain a line break');
  return p;
}

/**
 * A stable, non-reversible name for this machine.
 *
 * Two machines pushing to one branch take turns destroying each other's
 * backup: the old box after a hand-over, or a second bot on its own number
 * (docs/operations.md, "Two machines, two numbers"). Each run records which
 * machine wrote the branch, and refuses to overwrite another machine's copy
 * unless told to. /etc/machine-id is unique per OS install, so a rebuilt VM
 * with the same hostname still counts as a different machine; it is hashed
 * because systemd asks that the raw id not be published.
 */
export function machineFingerprint() {
  let id = '';
  for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try { id = fs.readFileSync(f, 'utf8').trim(); } catch { /* try the next */ }
    if (id) break;
  }
  if (!id) id = `host:${os.hostname()}`;
  return crypto.createHash('sha256').update(`whatsapp-bot sealed-backup\0${id}`).digest('hex').slice(0, 16);
}

/**
 * Is the bot running from this checkout right now? true, false, or null when
 * this machine cannot tell (no /proc).
 *
 * Recorded in the manifest because a backup taken while the bot runs is a
 * snapshot of a moving target: whatever the bot writes after it - the state
 * flush at shutdown, the outbound budget, Baileys' session and pre-key updates
 * - is not in it, and a job it finishes afterwards is re-queued by whichever
 * machine restores it, which posts the film twice. A hand-over should restore
 * a backup taken after the old bot stopped, and tools/bootstrap.sh asks before
 * restoring one that was not.
 *
 * Read from /proc rather than asked of systemd, so a bot started by hand
 * counts too: any process running this checkout's src/index.js, which is what
 * both the unit (`node src/index.js` in WorkingDirectory) and start.sh run.
 * Only read, never signalled.
 */
export function botProcessRunning(appRoot, { procDir = '/proc' } = {}) {
  let pids;
  try {
    pids = fs.readdirSync(procDir).filter((n) => /^\d+$/.test(n));
  } catch {
    return null;
  }
  let root = path.resolve(appRoot);
  try { root = fs.realpathSync(root); } catch { /* compare as given */ }
  const entry = path.join(root, 'src', 'index.js');
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    try {
      const argv = fs.readFileSync(path.join(procDir, pid, 'cmdline'), 'utf8').split('\0');
      const scripts = argv.filter((a) => a === 'src/index.js' || a.endsWith('/src/index.js'));
      if (!scripts.length) continue;
      const cwd = fs.readlinkSync(path.join(procDir, pid, 'cwd'));
      if (scripts.some((a) => path.resolve(cwd, a) === entry)) return true;
    } catch { /* exited, or another user's process */ }
  }
  return false;
}

/**
 * whatsapp-bot.service as systemd sees it, measured against THIS checkout.
 * null when systemd cannot be asked (no systemctl: a container, a laptop
 * without systemd). Only read, never changed. SEALED_BACKUP_SYSTEMCTL points
 * the tests at a fake, as SEALED_BACKUP_CRONTAB does for the crontab.
 */
export async function botServiceState(appRoot, { systemctl = process.env.SEALED_BACKUP_SYSTEMCTL || 'systemctl' } = {}) {
  let text;
  try {
    text = await new Promise((resolve, reject) => {
      execFile(systemctl, ['show', 'whatsapp-bot.service',
        '-p', 'LoadState', '-p', 'ActiveState', '-p', 'UnitFileState', '-p', 'WorkingDirectory'],
      { timeout: 15_000, encoding: 'utf8', env: { ...process.env, SYSTEMD_PAGER: '', SYSTEMD_COLORS: '0' } },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
  } catch {
    return null;
  }
  const v = {};
  for (const line of String(text).split('\n')) {
    const m = /^(\w+)=(.*)$/.exec(line);
    if (m) v[m[1]] = m[2];
  }
  if (!v.LoadState) return null;
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const loaded = v.LoadState === 'loaded';
  // A leading - or ! is systemd's "ignore if missing" marker, not the path.
  const workdir = loaded && v.WorkingDirectory ? v.WorkingDirectory.replace(/^[-!]+/, '') : null;
  return {
    loaded,
    activeState: v.ActiveState || 'unknown',
    active: ['active', 'reloading'].includes(v.ActiveState),
    unitFileState: v.UnitFileState || 'unknown',
    enabled: v.UnitFileState === 'enabled',
    workdir,
    here: Boolean(workdir) && real(workdir) === real(appRoot),
  };
}

/**
 * Does this machine run the bot firmly enough to move another machine's
 * backup off the root without being told? { live, why[] }, `why` naming each
 * thing that is missing.
 *
 * All four, because the two mistakes do not cost the same. A wrong "yes"
 * moves the live bot's backup out of the root, where a rebuild no longer
 * finds it; a wrong "no" costs one night and a message that says to run
 * --take-over. So:
 *   - a node src/index.js from THIS checkout is running (botProcessRunning);
 *   - whatsapp-bot.service is active - a bot somebody started by hand to try
 *     something on a standby laptop is not the live bot;
 *   - it is enabled at boot - the start-at-boot routine keeps that true on
 *     the box that runs the bot and on no other, and tools/bootstrap.sh
 *     enables it only together with starting it, on a typed "yes" that the
 *     old machine is stopped;
 *   - and the service runs this checkout, not another clone on the box.
 * "Connected to WhatsApp" is deliberately not one of them: nothing outside
 * the bot's process records it, and a box whose number is logged out is
 * still the box that runs the bot - its backup is the one a rebuild needs.
 */
export function runsBotHere({ appRoot, botRunning, service }) {
  const why = [];
  if (botRunning !== true) {
    why.push(botRunning === null ? 'this machine cannot tell whether the bot runs here (no /proc)'
      : `the bot is not running from ${appRoot}`);
  }
  if (!service) {
    why.push('systemd could not be asked about whatsapp-bot.service');
  } else if (!service.loaded) {
    why.push('whatsapp-bot.service is not installed here');
  } else {
    if (!service.active) why.push(`whatsapp-bot.service is ${service.activeState}`);
    if (!service.enabled) why.push(`whatsapp-bot.service is ${service.unitFileState}, not enabled at boot`);
    if (!service.here) why.push(`whatsapp-bot.service runs ${service.workdir ?? 'another checkout'}, not this one`);
  }
  return { live: why.length === 0, why };
}

/**
 * Which bot this checkout is, without revealing anything about it: a one-way
 * hash of MASTER_KEY, recorded in the manifest as source.botId.
 *
 * The machine fingerprint says which BOX wrote a backup; this says which BOT.
 * A hand-over carries .env across (bootstrap restores it; the manual way tars
 * it), so the retired box and its replacement share it, while a second bot on
 * its own number has its own (docs/operations.md, "Two machines, two
 * numbers"). That is what keeps a second bot, running and enabled on its own
 * box, from moving the first bot's backup off the root every night - the
 * 2026-09-22 review caught bootstrap doing exactly that with --take-over.
 *
 * It is the one plaintext value on the branch derived from a secret, and that
 * is a deliberate choice (review, 2026-09-29). The bot mints MASTER_KEY as 32
 * random bytes (src/index.js), which no amount of guessing recovers from a
 * hash. Only a MASTER_KEY somebody typed by hand at first start could be
 * guessed offline from this, so it is scrypt at the bundles' own cost, not a
 * bare hash. The salt has to be fixed - two machines must compute the same
 * value to compare it - so unlike the bundles' per-file salt, one dictionary
 * run covers every install; a hand-chosen MASTER_KEY needs to be as strong as
 * the passphrase, which it already did, since it guards config.json at rest.
 * null when .env has no MASTER_KEY.
 */
export function botIdentity(appRoot) {
  let key = '';
  try { key = dotenv.parse(fs.readFileSync(path.join(appRoot, '.env'))).MASTER_KEY || ''; } catch { /* no .env */ }
  if (!key) return null;
  return crypto.scryptSync(key, 'whatsapp-bot sealed-backup bot identity v1', 16,
    { N: 1 << 15, r: 8, p: 1, maxmem: 96 << 20 }).toString('hex');
}

/* --------------------------------------------------------- the bundles --- */

/** Is this home-relative path one that must never be bundled or restored? */
export function isForbiddenHomePath(rel) {
  const r = String(rel).replace(/\/+$/, '');
  if (HOME_NEVER.some((n) => r === n || r.startsWith(`${n}/`))) return true;
  // Transcripts. They sit beside the memory directories, and they are the
  // full text of every session, secrets pasted into it included.
  if (r.startsWith('.claude/projects/') && r.endsWith('.jsonl')) return true;
  return false;
}

/**
 * Refuse an allowlist entry that is, or contains, something forbidden. An
 * ancestor counts: allowing `.config` would sweep in `.config/gh/hosts.yml`.
 */
export function assertHomePathsAllowed(paths) {
  for (const p of paths) {
    if (path.isAbsolute(p) || p.split('/').includes('..')) {
      throw new Error(`home bundle path must be relative and inside $HOME: ${p}`);
    }
    if (isForbiddenHomePath(p) || HOME_NEVER.some((n) => n.startsWith(`${p}/`))) {
      throw new Error(`refusing to bundle ${p}: it is, or contains, a path that must never leave this machine`);
    }
  }
}

/** The home allowlist, expanded against a real home directory. */
export function homeBundlePaths(homeDir) {
  const out = [];
  for (const entry of HOME_ALLOWLIST) {
    if (!entry.includes('*')) {
      if (lexists(path.join(homeDir, entry))) out.push(entry);
      continue;
    }
    const [base, rest] = entry.split('/*/');
    let names = [];
    try {
      names = fs.readdirSync(path.join(homeDir, base), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch { /* no such directory */ }
    for (const n of names) {
      const rel = `${base}/${n}/${rest}`;
      if (lexists(path.join(homeDir, rel))) out.push(rel);
    }
  }
  assertHomePathsAllowed(out);
  return out;
}

export async function snapshotApp(appRoot, opts = {}) {
  const snap = await snapshotBundle(appRoot, appBundlePaths(appRoot), opts);
  for (const p of REQUIRED_APP_PATHS) {
    if (!snap.paths.includes(p)) throw new Error(`refusing to back up: ${p} is missing from ${appRoot}`);
  }
  return snap;
}

export async function snapshotHome(homeDir, opts = {}) {
  const paths = homeBundlePaths(homeDir);
  if (!paths.length) return null;
  return snapshotBundle(homeDir, paths, { ...opts, exclude: (rel) => isForbiddenHomePath(rel) });
}

/**
 * Open a freshly sealed blob and list it before it goes anywhere near git.
 * A backup that has never been opened is a hope, not a backup.
 */
async function verifySealed(sealed, passphrase, snap, label) {
  const back = openSecrets(sealed, passphrase);
  if (!back.equals(snap.tar)) throw new Error(`the sealed ${label} bundle does not decrypt to what was sealed`);
  const names = await listTar(back);
  for (const p of snap.paths) {
    if (!names.some((n) => n === p || n === `${p}/` || n.startsWith(`${p}/`))) {
      throw new Error(`the sealed ${label} bundle is missing ${p}`);
    }
  }
  return names;
}

/* ---------------------------------------------------------- passphrase --- */

const PASS_LINE = /^\s*(?:export\s+)?BACKUP_PASSPHRASE\s*[=:]/;

/** BACKUP_PASSPHRASE from the app's .env, parsed exactly as the bot parses it. */
export function readEnvPassphrase(appRoot) {
  try {
    return dotenv.parse(fs.readFileSync(path.join(appRoot, '.env'))).BACKUP_PASSPHRASE || '';
  } catch {
    return '';
  }
}

/**
 * Store the passphrase in .env, replacing any earlier line and leaving every
 * other line exactly as it was.
 *
 * On the box, beside MASTER_KEY, because the nightly job has to be able to
 * seal without a human; the passphrase protects the copy in the repository,
 * and anyone who can already read .env on this machine has everything the
 * bundle contains anyway. The value is quoted in whichever style dotenv reads
 * back unchanged, and that is checked, so a passphrase with a `#` or a space
 * in it is not silently truncated into one that opens nothing.
 */
export function writeEnvPassphrase(appRoot, passphrase) {
  const p = checkPassphrase(passphrase);
  const envPath = path.join(appRoot, '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error(`no .env in ${appRoot} - this is not a live install yet (restore it first; `
      + 'creating one here would block that restore)');
  }
  let line = null;
  for (const [open, close] of [["'", "'"], ['"', '"'], ['`', '`']]) {
    if (p.includes(open)) continue;
    const candidate = `BACKUP_PASSPHRASE=${open}${p}${close}`;
    if (dotenv.parse(`${candidate}\n`).BACKUP_PASSPHRASE === p) { line = candidate; break; }
  }
  if (!line) throw new Error('that passphrase cannot be stored in .env safely - avoid using all three quote characters');

  const text = fs.readFileSync(envPath, 'utf8');
  const lines = text.length ? text.replace(/\n$/, '').split('\n') : [];
  const at = lines.findIndex((l) => PASS_LINE.test(l));
  const kept = lines.filter((l) => !PASS_LINE.test(l));
  if (at === -1) kept.push(line);
  else kept.splice(Math.min(at, kept.length), 0, line);

  const tmp = `${envPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, `${kept.join('\n')}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, envPath);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  fs.chmodSync(envPath, 0o600);
  if (readEnvPassphrase(appRoot) !== p) throw new Error('wrote .env but the passphrase did not read back - check .env by hand');
  return envPath;
}

/**
 * Read a line from the terminal without echoing it.
 *
 * Never from argv: a command line ends up in shell history, in `ps`, and in
 * whatever ships that history off the box.
 */
export function askHidden(question, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    if (!input.isTTY) {
      reject(new Error('no terminal to ask for the passphrase on - set BACKUP_PASSPHRASE, or add it to .env with --set-passphrase'));
      return;
    }
    output.write(question);
    input.setRawMode(true);
    input.setEncoding('utf8');
    let buf = '';
    const finish = (fn, rest = '') => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      // Whatever arrived after the Enter belongs to the NEXT question - a
      // pasted "passphrase, Enter, passphrase, Enter" lands as one chunk, and
      // dropping the rest would make the confirmation read empty.
      if (rest) input.unshift(rest);
      output.write('\n');
      fn();
    };
    function onData(chunk) {
      const s = String(chunk);
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '\r' || ch === '\n' || ch === '') {
          const next = ch === '\r' && s[i + 1] === '\n' ? i + 2 : i + 1;
          return finish(() => resolve(buf), s.slice(next));
        }
        if (ch === '') return finish(() => reject(new Error('cancelled')));
        if (ch === '' || ch === '\b') { buf = buf.slice(0, -1); continue; }
        buf += ch;
      }
    }
    input.on('data', onData);
    input.resume();
  });
}

/**
 * The passphrase, from the first place that has one: the environment, then
 * .env, then (only when a human is there to answer) a hidden prompt.
 */
export async function resolvePassphrase({ appRoot, env = process.env, interactive = false, prompt = askHidden } = {}) {
  if (env.BACKUP_PASSPHRASE) return { passphrase: env.BACKUP_PASSPHRASE, source: 'BACKUP_PASSPHRASE' };
  const fromFile = readEnvPassphrase(appRoot);
  if (fromFile) return { passphrase: fromFile, source: '.env' };
  if (!interactive) return { passphrase: '', source: null };
  return { passphrase: await prompt('Backup passphrase: '), source: 'prompt' };
}

/* ----------------------------------------------------------------- git --- */

/** Make sure data/sealed-backup is a bare repository pointing at `remote`. */
async function ensureClone(cloneDir, remote) {
  if (!fs.existsSync(path.join(cloneDir, 'HEAD'))) {
    fs.mkdirSync(cloneDir, { recursive: true, mode: 0o700 });
    await git(['init', '-q', '--bare', cloneDir]);
  }
  fs.chmodSync(cloneDir, 0o700);
  try {
    await git(['remote', 'set-url', 'origin', remote], { cwd: cloneDir });
  } catch {
    await git(['remote', 'add', 'origin', remote], { cwd: cloneDir });
  }
}

async function revParse(cwd, ref) {
  try { return String(await git(['rev-parse', '--verify', '-q', `${ref}^{commit}`], { cwd })).trim() || null; } catch { return null; }
}

/**
 * Fetch the branch as it is on the remote right now. Returns its sha, or null
 * when the branch does not exist yet. A network failure throws: "could not
 * look" must never be mistaken for "nothing there", or a first-run-style push
 * would be attempted over a branch that exists.
 */
async function fetchRemoteBranch(cwd, remote = 'origin') {
  try {
    await git(['ls-remote', '--exit-code', remote, REF], { cwd });
  } catch (err) {
    if (err.exitCode === 2) return null;
    throw err;
  }
  await git(['fetch', '-q', '--no-tags', '--no-write-fetch-head', remote, `+${REF}:${REMOTE_REF}`], { cwd });
  return revParse(cwd, REMOTE_REF);
}

/*
 * Every read below THROWS when git cannot answer, and a file is "absent" only
 * when a listing that succeeded does not name it. They used to answer [] or
 * null for any failure, and the review of 2026-09-29 showed what that costs:
 * one failed `git ls-tree` (a missing object, a git killed by the timeout or
 * the OOM killer) read as "no archive/", so the nightly run pushed a root
 * without it, and a take-over archived the previous root as an empty folder
 * while the log said "moved, unchanged"; one failed read of manifest.json read
 * as "nobody's backup", so even a standby replaced the live bot's root. The
 * same rule as fetchRemoteBranch: "could not look" is never "nothing there".
 */

/** The entries of one tree, exactly as git has them. Throws when git cannot read it. */
async function lsTree(cwd, treeish) {
  const out = String(await git(['ls-tree', '-z', treeish], { cwd }));
  return out.split('\0').filter(Boolean).map((rec) => {
    const tab = rec.indexOf('\t');
    const [mode, type, sha] = rec.slice(0, tab).split(' ');
    return { mode, type, sha, name: rec.slice(tab + 1) };
  });
}

/** The file `name` among these tree entries: its bytes, or null when the tree has no such file. */
async function blobIn(cwd, entries, name) {
  const e = entries.find((x) => x.name === name && x.type === 'blob');
  return e ? git(['cat-file', 'blob', e.sha], { cwd }) : null;
}

/** manifest.json among these tree entries, parsed; null when there is none or it is not JSON. */
async function manifestIn(cwd, entries) {
  const raw = await blobIn(cwd, entries, 'manifest.json');
  if (!raw) return null;
  try { return JSON.parse(String(raw)); } catch { return null; }
}

/** manifest.json at the root of `treeish`. */
async function readManifest(cwd, treeish) {
  return manifestIn(cwd, await lsTree(cwd, treeish));
}

/** A tree made of these entries, which must already be in the object store. */
async function mktree(cwd, entries) {
  const input = entries.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.name}\0`).join('');
  return String(await git(['mktree', '-z'], { cwd, input })).trim();
}

/**
 * archive/ in a commit whose root entries are `rootEntries`:
 * { entry, folders: [{ folder, tree, manifest }], others }. `entry` is the
 * archive/ tree entry itself, carried verbatim by a run that archives
 * nothing; `others` is anything in archive/ that is not a folder, carried as
 * it is. A branch in the older layout, with no archive/, has none. Nothing is
 * opened: only the plaintext manifests are read.
 */
async function readArchive(cwd, rootEntries) {
  const entry = rootEntries.find((e) => e.name === ARCHIVE_DIR && e.type === 'tree') ?? null;
  const folders = [];
  const others = [];
  if (!entry) return { entry, folders, others };
  for (const e of await lsTree(cwd, entry.sha)) {
    if (e.type === 'tree') folders.push({ folder: e.name, tree: e.sha, manifest: await readManifest(cwd, e.sha) });
    else others.push(e);
  }
  return { entry, folders, others };
}

/** What a person needs to pick an archived backup, from its manifest alone. */
function summarize(folder, manifest) {
  const running = manifest?.source?.botRunning;
  return {
    folder,
    host: manifest?.source?.host ?? null,
    machine: manifest?.source?.machine ?? null,
    createdAt: manifest?.createdAt ?? null,
    botRunning: typeof running === 'boolean' ? running : null,
    hasHome: Boolean(manifest?.bundles?.home),
  };
}

const newestFirst = (a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''));
const archiveSummary = (entries) => entries.map((a) => summarize(a.folder, a.manifest)).sort(newestFirst);

/**
 * The folder a machine's backup is archived under: `<host>-<first 8 of its
 * fingerprint>`, readable in a listing and unique per machine. The host comes
 * from a plaintext manifest, so it is cut down to characters that are safe in
 * a path; a name another machine's folder already has gets the whole
 * fingerprint instead, then a number.
 */
export function archiveFolderName(manifest, taken = new Set()) {
  const host = String(manifest?.source?.host ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 64)
    || 'unknown-host';
  const id = String(manifest?.source?.machine ?? '').replace(/[^A-Za-z0-9]+/g, '') || 'unknown';
  for (const name of [`${host}-${id.slice(0, 8)}`, `${host}-${id}`]) if (!taken.has(name)) return name;
  for (let i = 2; ; i++) if (!taken.has(`${host}-${id}-${i}`)) return `${host}-${id}-${i}`;
}

/**
 * May this machine put its backup at the root, and if another machine's is
 * there, why may it move that one to archive/? Returns { action: 'write' }
 * for its own root, { action: 'archive', by, why } to take the root over, or
 * { action: 'refuse', refused, message }.
 *
 *   --take-over          always: a person said so (it archives, too).
 *   a standby            never: it must not displace the live bot's backup.
 *                        It does not refresh a folder of its own in archive/
 *                        either: every box's nightly line fires at the same
 *                        05:17, so a standby pushing would race the live
 *                        box's push, and the lease would cost the live bot
 *                        that night's backup - for a copy of a bot that is not
 *                        running and so has nothing new to keep.
 *   the box running the bot, when the root belongs to the same bot (the same
 *   MASTER_KEY, see botIdentity): the hand-over. A root from before
 *   manifests named their bot is taken only once UNLABELLED_STALE_MS old.
 *   the box running a DIFFERENT bot: never - a second number on its own box.
 *   this machine's own root, written for a different bot (another MASTER_KEY:
 *   a second checkout on this box, or a reinstall that minted a new key):
 *                        not without --take-over, which archives it. It used
 *                        to be replaced outright, unarchived, because only
 *                        the machine was compared (review, 2026-09-29).
 *   a root whose manifest.json is missing or is not JSON: whose it is cannot
 *                        be told, so not without --take-over either.
 *
 * `hasRoot` says there is anything at the root besides archive/: a first
 * run, or a root somebody emptied, has nothing to lose and is written. A root
 * that cannot be read because git failed never gets here: the read throws.
 */
export function decideRoot({ previous, hasRoot = Boolean(previous), machine, takeOver = false, live, botId, now = Date.now() }) {
  if (!hasRoot) return { action: 'write' };
  const prevMachine = previous?.source?.machine;
  const prevBot = previous?.source?.botId ?? null;
  // A root from before manifests named their bot cannot name another one.
  if (prevMachine && prevMachine === machine && (!prevBot || prevBot === botId)) return { action: 'write' };
  if (takeOver) return { action: 'archive', by: 'take-over', why: '--take-over was given by hand' };
  const host = previous?.source?.host ?? 'unknown host';
  const when = previous?.createdAt ?? 'at an unknown time';
  const byHand = (whose) => 'If this machine is now the one running the bot, run `node tools/backup-secrets.mjs --take-over` once, '
    + `by hand: it moves ${whose} into ${ARCHIVE_DIR}/, unopened, and puts this one at the root`;
  if (!prevMachine) {
    return {
      action: 'refuse',
      refused: 'unreadable',
      message: `the ${BRANCH} branch has a backup at its root whose manifest.json is missing or is not valid JSON, so this `
        + 'machine cannot tell whose backup it is, and a standby must never replace the live bot\'s. Nothing was changed. '
        + byHand('what is there'),
    };
  }
  if (prevMachine === machine) {
    return {
      action: 'refuse',
      refused: 'other-bot',
      message: `the ${BRANCH} branch holds a backup this machine wrote for a different bot (${previous.source.appRoot ?? host}, `
        + `written ${when}): its MASTER_KEY is not this checkout's - another checkout on this box, or a reinstall that minted `
        + `a new MASTER_KEY. Nothing was changed. ${byHand('that backup')}`,
    };
  }
  const head = `the ${BRANCH} branch holds the backup of another machine (${host}, written ${when})`;
  if (!live.live) {
    return {
      action: 'refuse',
      refused: 'standby',
      message: `${head}, and this machine is not the one running the bot: ${live.why.join('; ')}. A standby never replaces `
        + 'the live bot\'s backup, so nothing was changed. Once the bot runs here (enabled and started, after the old machine '
        + `is stopped), the next backup moves ${host}'s into ${ARCHIVE_DIR}/ by itself. ${byHand(`${host}'s backup`)}`,
    };
  }
  if (prevBot) {
    if (prevBot === botId) {
      return { action: 'archive', by: 'runs-bot', why: `this machine runs the bot now, the same bot ${host} backed up (same MASTER_KEY)` };
    }
    return {
      action: 'refuse',
      refused: 'other-bot',
      message: `${head}, and that is a different bot: its MASTER_KEY is not this checkout's, so this box is not its `
        + 'replacement (a second number runs on its own .env). Nothing was changed. '
        + `${byHand(`${host}'s backup`)}. A box for another number does without this routine: node tools/routines.mjs --skip sealed-backup `
        + '--reason "runs another number"',
    };
  }
  const age = now - Date.parse(previous.createdAt ?? '');
  if (Number.isFinite(age) && age >= UNLABELLED_STALE_MS) {
    return {
      action: 'archive',
      by: 'runs-bot',
      why: `this machine runs the bot now, and ${host}'s backup is ${Math.floor(age / 3600_000)} hours old: it has stopped backing up`,
    };
  }
  return {
    action: 'refuse',
    refused: 'recent',
    message: `${head}, from before backups said which bot they belong to, and it is ${Number.isFinite(age)
      ? `only ${Math.max(0, Math.floor(age / 3600_000))} hours old` : 'of unknown age'}: that machine may still be backing up a `
      + `bot of its own, so it is left alone for now. Once it is ${UNLABELLED_STALE_MS / 3600_000} hours old, the next backup `
      + `moves it into ${ARCHIVE_DIR}/ by itself. ${byHand(`${host}'s backup`)}`,
  };
}

/**
 * Commit as whoever the app checkout commits as. This box has no global git
 * identity, and a bare repository inherits nothing, so without this
 * `commit-tree` fails with "Author identity unknown" - the same trap the
 * activity backup fell into.
 */
async function identity(appRoot) {
  const get = async (k) => {
    try { return String(await git(['config', '--get', k], { cwd: appRoot })).trim(); } catch { return ''; }
  };
  return { name: (await get('user.name')) || 'whatsapp-bot', email: (await get('user.email')) || 'bot@localhost' };
}

/* ---------------------------------------------------------- the backup --- */

function manifestFor({ now, appRoot, homeDir, machine, botId, botRunning, app, home }) {
  let user = '';
  try { user = os.userInfo().username; } catch { /* no passwd entry */ }
  const bundle = (snap, file, restoreTo) => ({
    file,
    restoreTo,
    // sha256 over each entry's type, path, mode and content hash - it moves
    // only when something that would be restored changed. No value from any
    // file is recoverable from it.
    sha256: snap.digest,
    files: snap.files,
    bytes: snap.bytes,
    paths: snap.paths,
  });
  return {
    format: MANIFEST_FORMAT,
    createdAt: new Date(now).toISOString(),
    source: {
      host: os.hostname(),
      machine,
      // Which bot, as a one-way hash of MASTER_KEY; null without one. See
      // botIdentity().
      botId,
      // true, false, or null when the machine could not tell. See
      // botProcessRunning().
      botRunning,
      user,
      appRoot,
      homeDir,
      node: process.version,
      os: `${os.type()} ${os.release()} ${os.arch()}`,
    },
    encryption: 'AES-256-GCM; key = scrypt(passphrase, N=2^15, r=8, p=1); each file starts with WABKP1',
    bundles: {
      app: bundle(app, BUNDLE_FILES.app, 'the app checkout (~/whatsapp-bot)'),
      ...(home ? { home: bundle(home, BUNDLE_FILES.home, '$HOME') } : {}),
    },
  };
}

const runningWord = (r) => (r === true ? 'its bot running' : r === false ? 'its bot stopped' : 'bot state unknown');

function readmeFor(manifest, { archive = [], archived = null } = {}) {
  const list = (b) => b.paths.map((p) => `  - \`${p}\``).join('\n');
  return [
    '# Sealed settings backup',
    '',
    `Written ${manifest.createdAt} by ${manifest.source.host}. One commit, replaced`,
    'whenever something changes; it is not a history. The files at the top of',
    'this branch are the current backup; `archive/` holds other machines\' last',
    'backups (see the end of this file).',
    '',
    ...(archived ? [
      `This backup took the branch over from ${archived.host ?? 'another machine'}: ${archived.why}.`,
      `The backup that was here (written ${archived.createdAt ?? 'at an unknown time'}) was moved, unchanged, to`,
      `\`${ARCHIVE_DIR}/${archived.folder}/\`.`,
      '',
    ] : []),
    'Everything that matters here is encrypted (AES-256-GCM, key from scrypt over',
    'a passphrase that is not in this repository). `manifest.json` and this file',
    'are the only plaintext, and they name what is inside without any value from',
    'it.',
    '',
    `\`${BUNDLE_FILES.app}\` restores into the app checkout:`,
    '',
    list(manifest.bundles.app),
    '',
    ...(manifest.bundles.home ? [
      `\`${BUNDLE_FILES.home}\` restores into \`$HOME\`:`,
      '',
      list(manifest.bundles.home),
      '',
    ] : []),
    'Never included: the gh token (`~/.config/gh/hosts.yml`), `~/.claude.json`,',
    'Claude Code transcripts and caches, Tailscale node state, web panel logins.',
    '',
    '## Rebuilding a machine from this',
    '',
    '```bash',
    '# on the NEW machine, after installing gh and running `gh auth login`:',
    'gh repo clone your-github-user/whatsapp-bot ~/whatsapp-bot',
    'cd ~/whatsapp-bot && tools/bootstrap.sh',
    '```',
    '',
    'or just the files: `node tools/restore-secrets.mjs --from-branch`.',
    '',
    'For a hand-over, on the OLD machine first: stop and disable the bot',
    '(`sudo systemctl disable --now whatsapp-bot`), THEN run',
    '`node tools/backup-secrets.mjs`, so the copy here is the final one. Two',
    'processes on one WhatsApp session is `connectionReplaced`, which is the',
    'fastest way to lose the number.',
    '',
    '## Archived backups',
    '',
    `\`${ARCHIVE_DIR}/\` keeps the last backup of each other machine that held the top of this`,
    'branch, one folder per machine, moved there unchanged when the machine that',
    'runs the bot took the branch over. A machine archived again replaces its own',
    'folder, and its folder goes once its backup of the same bot is back at the top.',
    'Each folder is still sealed, possibly under that machine\'s own passphrase,',
    'and restores exactly like the top of the branch:',
    '',
    ...(archive.length
      ? archive.map((a) => `  - \`${ARCHIVE_DIR}/${a.folder}/\`: ${a.host ?? 'unknown host'}, written ${a.createdAt ?? 'at an unknown time'}, `
        + `${runningWord(a.botRunning)}`)
      : ['  - none yet']),
    '',
    '```bash',
    'node tools/restore-secrets.mjs --list-archive',
    'node tools/restore-secrets.mjs --from-archive <folder>          # or add --only home',
    '```',
    '',
  ].join('\n');
}

/** Does the file among these root entries still open with this passphrase? */
async function opensWith(cwd, entries, file, passphrase) {
  const blob = await blobIn(cwd, entries, file);
  if (!blob) return false;
  try { openSecrets(blob, passphrase); return true; } catch { return false; }
}

/**
 * Read the tree about to be committed back out of git and prove that nothing
 * on the branch is lost by it: on this machine's own root, archive/ is the
 * very tree it was; on a take-over, every folder and file archive/ had and
 * keeps is there as the same object, and the previous root's files are in
 * their folder as the same blobs - no more, no fewer. Throws before anything
 * is committed.
 *
 * Everything that feeds this tree is read strictly now, so this should never
 * fire. It is here because the review of 2026-09-29 found a take-over that
 * pushed an EMPTY folder while every log line said "moved, unchanged": the
 * words were built from what the run meant to do, not from what it made.
 * This checks what it made.
 */
async function assertNothingLost(cwd, tree, { archiveBefore, keep = null, moved = null }) {
  const lost = (what) => new Error(`refusing to push: the new commit would lose ${what}. Nothing was changed`);
  const top = await lsTree(cwd, tree);
  const got = top.find((e) => e.name === ARCHIVE_DIR) ?? null;
  if (!keep) {
    if ((got?.sha ?? null) !== (archiveBefore?.sha ?? null)) throw lost(`${ARCHIVE_DIR}/ as it was`);
    return;
  }
  const inArchive = got ? await lsTree(cwd, got.sha) : [];
  const has = (list, e) => list.some((x) => x.name === e.name && x.sha === e.sha && x.type === e.type);
  for (const e of keep) if (!has(inArchive, e)) throw lost(`${ARCHIVE_DIR}/${e.name}`);
  if (!moved) return;
  const folder = inArchive.find((e) => e.name === moved.folder && e.type === 'tree');
  const inFolder = folder ? await lsTree(cwd, folder.sha) : [];
  if (inFolder.length !== moved.files.length || !moved.files.every((e) => has(inFolder, e))) {
    throw lost(`the backup it moves to ${ARCHIVE_DIR}/${moved.folder}/ (it would hold ${inFolder.length} of the `
      + `${moved.files.length} entries the root had)`);
  }
}

/**
 * Back everything up to the sealed-backup branch.
 *
 * Returns { changed, committed, pushed, sha, previousSha, manifest, archived,
 * archive }: `archived` says which machine's backup this run moved off the
 * root, and why (null when it moved none); `archive` lists what archive/
 * holds afterwards, newest first.
 * Throws, with a message fit for a human, on anything that means the backup
 * did not happen - including any read of the branch that git could not
 * answer; a refusal to take the root carries `refused` ('standby',
 * 'other-bot', 'recent' or 'unreadable') and `root` (who holds it).
 *
 * botRunning, service and botId are measured on this machine when left out;
 * the tests pass them in.
 */
export async function runSealedBackup({
  appRoot,
  homeDir = os.homedir(),
  remote = null,
  passphrase,
  push = true,
  now = Date.now(),
  cloneDir = null,
  takeOver = false,
  machine = machineFingerprint(),
  botRunning,
  service,
  botId,
  snapshotOptions = {},
  hooks = {},
} = {}) {
  assertNotRoot();
  checkPassphrase(passphrase);
  appRoot = path.resolve(appRoot);
  homeDir = path.resolve(homeDir);
  cloneDir = path.resolve(cloneDir ?? path.join(appRoot, CLONE_SUBDIR));
  for (const p of REQUIRED_APP_PATHS) {
    if (!fs.existsSync(path.join(appRoot, p))) {
      throw new Error(`refusing to back up: ${p} is missing from ${appRoot}. Without it the backup `
        + 'would restore a bot that cannot read its own settings - this does not look like a live install');
    }
  }
  remote ||= String(await git(['remote', 'get-url', 'origin'], { cwd: appRoot })).trim();

  await ensureClone(cloneDir, remote);

  // The lease is pinned HERE, before anything is read, so a push that lands
  // while this run is snapshotting is never overwritten.
  let remoteSha = null;
  try {
    remoteSha = await fetchRemoteBranch(cloneDir);
  } catch (err) {
    if (push) throw new Error(`could not read the current backup from origin: ${err.message}`);
    logger.warn(`origin unreachable (${err.message}); comparing with the local copy only`);
  }
  const baseSha = push ? remoteSha : ((await revParse(cloneDir, REF)) ?? remoteSha);
  // Everything this run keeps from the branch comes from these reads, so a
  // read that fails ends the run here, before anything is decided.
  let rootEntries = [];
  let previous = null;
  let arch = { entry: null, folders: [], others: [] };
  if (baseSha) {
    try {
      rootEntries = await lsTree(cloneDir, baseSha);
      previous = await manifestIn(cloneDir, rootEntries);
      arch = await readArchive(cloneDir, rootEntries);
    } catch (err) {
      throw new Error(`could not read the current backup (${baseSha.slice(0, 7)}) in ${cloneDir}: ${err.message}. `
        + 'Nothing was changed: a run that cannot see everything on the branch could drop what it did not see');
    }
  }
  const archive = arch.folders;
  const prevMachine = previous?.source?.machine;

  // Looked at before the snapshot: a bot that stops halfway through it is
  // still recorded as running, which errs the safe way.
  if (botRunning === undefined) botRunning = botProcessRunning(appRoot);
  if (botId === undefined) botId = botIdentity(appRoot);
  // systemd is asked only when the answer decides something: when the root
  // holds another machine's backup and nobody said --take-over.
  let live = { live: false, why: [] };
  if (prevMachine && prevMachine !== machine && !takeOver) {
    if (service === undefined) service = await botServiceState(appRoot);
    live = runsBotHere({ appRoot, botRunning, service });
  }
  const isArchiveDir = (e) => e.name === ARCHIVE_DIR && e.type === 'tree';
  const hasRoot = rootEntries.some((e) => !isArchiveDir(e));
  const decision = decideRoot({ previous, hasRoot, machine, takeOver, live, botId, now });
  if (decision.action === 'refuse') {
    const err = new Error(decision.message);
    err.refused = decision.refused;
    err.root = summarize(null, previous);
    err.archive = archiveSummary(archive);
    throw err;
  }

  const app = await snapshotApp(appRoot, snapshotOptions);
  const home = await snapshotHome(homeDir, snapshotOptions);

  // Whether the bot was running is part of what the backup says. The last
  // backup before a hand-over is taken with the bot stopped, and often not a
  // byte has changed since the night before - it must still replace a copy
  // that says "taken while running", or the new machine is warned for nothing.
  // The bot's identity is part of it too: the first backup after an upgrade
  // writes it, so the next machine to look knows whose backup the root is.
  const sameContent = previous?.format === MANIFEST_FORMAT
    && previous.bundles?.app?.sha256 === app.digest
    && (previous.bundles?.home?.sha256 ?? null) === (home?.digest ?? null)
    && prevMachine === machine
    && (previous.source?.botRunning ?? null) === botRunning
    && (previous.source?.botId ?? null) === botId;
  // Same contents is not enough on its own: after --set-passphrase the old
  // blobs no longer open with the passphrase this machine now holds, and a
  // backup nobody can open is not a backup. Reseal whenever that is the case.
  if (sameContent
    && await opensWith(cloneDir, rootEntries, BUNDLE_FILES.app, passphrase)
    && (!home || await opensWith(cloneDir, rootEntries, BUNDLE_FILES.home, passphrase))) {
    logger.info(`nothing changed since ${baseSha.slice(0, 7)}; no new commit`);
    return {
      changed: false, committed: false, pushed: false, sha: baseSha, previousSha: baseSha, manifest: previous,
      archived: null, archive: archiveSummary(archive),
    };
  }

  // What archive/ holds after this run. On this machine's own root it is
  // carried forward exactly as it was: the same tree, stray files and all.
  // Taking the root over moves everything at the previous root but archive/
  // itself - the same blobs, so byte for byte what that machine wrote, sealed
  // under whatever passphrase it used - into a folder of its own, replacing
  // any older folder of that machine: one folder per machine, however many
  // nights and hand-overs. A folder of THIS machine's goes too, but only when
  // it holds this same bot, which the root now supersedes. One holding a
  // different bot (this box ran another number before) is the only copy of
  // that bot on the branch, and stays until this machine is archived again -
  // the review of 2026-09-29 caught it being dropped.
  let nextArchive = archive;
  let archiveEntry = arch.entry;
  let archived = null;
  let moved = null;
  let keep = null;
  if (decision.action === 'archive') {
    const ownerOf = (a) => a.manifest?.source?.machine;
    const isPrevMachine = (a) => Boolean(prevMachine) && ownerOf(a) === prevMachine;
    const superseded = (a) => ownerOf(a) === machine && Boolean(botId) && a.manifest?.source?.botId === botId;
    const kept = archive.filter((a) => !isPrevMachine(a) && !superseded(a));
    nextArchive = kept;
    const prevFiles = rootEntries.filter((e) => !isArchiveDir(e));
    if (prevFiles.length) {
      const folder = archiveFolderName(previous, new Set([...kept.map((a) => a.folder), ...arch.others.map((e) => e.name)]));
      nextArchive = [...kept, { folder, tree: await mktree(cloneDir, prevFiles), manifest: previous }];
      moved = { folder, files: prevFiles };
      archived = {
        folder,
        host: previous?.source?.host ?? null,
        machine: prevMachine ?? null,
        createdAt: previous?.createdAt ?? null,
        by: decision.by,
        why: decision.why,
        replaced: archive.filter(isPrevMachine).map((a) => a.folder),
      };
    }
    keep = [...arch.others, ...kept.map((a) => ({ mode: '040000', type: 'tree', sha: a.tree, name: a.folder }))];
    const folders = nextArchive.map((a) => ({ mode: '040000', type: 'tree', sha: a.tree, name: a.folder }));
    archiveEntry = folders.length || arch.others.length
      ? { mode: '040000', type: 'tree', sha: await mktree(cloneDir, [...arch.others, ...folders]), name: ARCHIVE_DIR }
      : null;
  }
  const archiveAfter = archiveSummary(nextArchive);

  const sealedApp = sealSecrets(app.tar, passphrase);
  await verifySealed(sealedApp, passphrase, app, 'app');
  const sealedHome = home ? sealSecrets(home.tar, passphrase) : null;
  if (home) await verifySealed(sealedHome, passphrase, home, 'home');

  const manifest = manifestFor({ now, appRoot, homeDir, machine, botId, botRunning, app, home });
  const files = {
    'manifest.json': Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    'README.md': Buffer.from(readmeFor(manifest, { archive: archiveAfter, archived })),
    [BUNDLE_FILES.app]: sealedApp,
    ...(home ? { [BUNDLE_FILES.home]: sealedHome } : {}),
  };
  const entries = [];
  for (const [name, buf] of Object.entries(files)) {
    const blob = String(await git(['hash-object', '-w', '--stdin'], { cwd: cloneDir, input: buf })).trim();
    entries.push({ mode: '100644', type: 'blob', sha: blob, name });
  }
  if (archiveEntry) entries.push(archiveEntry);
  const tree = await mktree(cloneDir, entries);
  await assertNothingLost(cloneDir, tree, decision.action === 'archive' ? { keep, moved } : { archiveBefore: arch.entry });

  const who = await identity(appRoot);
  const when = `@${Math.floor(now / 1000)} +0000`;
  const message = [
    `Sealed settings backup from ${os.hostname()}`,
    '',
    `app: ${app.files} files (${app.paths.join(', ')})`,
    home ? `home: ${home.files} files (${home.paths.join(', ')})` : 'home: nothing to back up',
    ...(archived ? [
      '',
      `Took the branch over from ${archived.host ?? 'another machine'}: ${archived.why}. Its backup`,
      `(written ${archived.createdAt ?? 'at an unknown time'}) is now ${ARCHIVE_DIR}/${archived.folder}/, unchanged.`,
    ] : []),
    ...(archiveAfter.length ? ['', `${ARCHIVE_DIR}/: ${archiveAfter.map((a) => a.folder).join(', ')}`] : []),
    '',
    'Everything except manifest.json and README.md is encrypted. Restore',
    'with tools/bootstrap.sh, or node tools/restore-secrets.mjs --from-branch.',
    '',
  ].join('\n');
  // Parentless on purpose: the branch is one commit, never a history.
  const sha = String(await git(['commit-tree', '--no-gpg-sign', tree, '-F', '-'], {
    cwd: cloneDir,
    input: message,
    env: {
      GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email, GIT_COMMITTER_DATE: when,
    },
  })).trim();
  await git(['update-ref', REF, sha], { cwd: cloneDir });

  const movedLine = archived
    ? `; ${archived.host ?? 'another machine'}'s backup (written ${archived.createdAt ?? 'at an unknown time'}) moved to `
      + `${ARCHIVE_DIR}/${archived.folder}/ - ${archived.why}`
    : '';
  if (!push) {
    logger.info(`sealed backup committed as ${sha.slice(0, 7)} in ${cloneDir} (not pushed)${movedLine}`);
    return { changed: true, committed: true, pushed: false, sha, previousSha: baseSha, manifest, archived, archive: archiveAfter };
  }

  // Only the tests use this: it is how they prove the lease holds when
  // another push lands between the fetch above and the push below.
  await hooks.beforePush?.();
  // Exactly one destination, spelled out in full. An empty lease means "the
  // branch must not exist yet", which is the first run.
  try {
    await git(['push', '-q', '--no-verify', `--force-with-lease=${REF}:${remoteSha ?? ''}`, 'origin', `${sha}:${REF}`],
      { cwd: cloneDir, timeout: PUSH_TIMEOUT_MS });
  } catch (err) {
    if (/stale info|fetch first|already exists/.test(err.message)) {
      throw new Error(`${err.message} - somebody else pushed to ${BRANCH} while this ran, and it was left alone. `
        + 'Run the backup again');
    }
    throw err;
  }
  await git(['update-ref', REMOTE_REF, sha], { cwd: cloneDir });
  // The previous commit's ciphertext is now unreachable; do not keep a copy of
  // every night's session on disk.
  try { await git(['gc', '-q', '--prune=now'], { cwd: cloneDir }); } catch (err) { logger.warn(`gc: ${err.message}`); }

  logger.info(`sealed backup pushed to ${BRANCH} as ${sha.slice(0, 7)}${movedLine}`);
  return { changed: true, committed: true, pushed: true, sha, previousSha: baseSha, manifest, archived, archive: archiveAfter };
}

/**
 * A durable record of the last run, success or failure, beside the data it
 * describes. The cron job's output goes to a log nobody reads; this is small
 * enough for the panel, or a person, to check.
 */
export function writeStatus(appRoot, record) {
  const file = path.join(appRoot, STATUS_FILE);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    logger.warn(`could not write ${file}: ${err.message}`);
  }
}

/* --------------------------------------------------------- the restore --- */

const noBranch = (remote) => new Error(`there is no ${BRANCH} branch on ${remote} yet - on the old machine, run `
  + '`node tools/backup-secrets.mjs --set-passphrase` first');

// A bundle's file name comes from a plaintext manifest on the branch; it is
// looked up inside git, never on disk, but a name that is not a plain file
// name has no business there either.
const plainName = (f) => typeof f === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(f);

/**
 * Fetch the branch into the app checkout and read both bundles out of it:
 * the current backup at the root, or with `folder`, the archived one in
 * archive/<folder>/. The older layout, with no archive/, reads the same.
 */
export async function fetchSealedBackup({ appRoot, remote = 'origin', folder = null }) {
  const sha = await fetchRemoteBranch(appRoot, remote);
  if (!sha) throw noBranch(remote);
  let dir = '';
  let where = `the ${BRANCH} branch (${sha.slice(0, 7)})`;
  const rootEntries = await lsTree(appRoot, sha);
  const { folders: archive } = await readArchive(appRoot, rootEntries);
  let entries = rootEntries;
  if (folder != null) {
    // Take "archive/x/" as readily as "x": both are what a listing shows.
    const name = String(folder).replace(new RegExp(`^${ARCHIVE_DIR}/+`), '').replace(/\/+$/, '');
    const hit = archive.find((a) => a.folder === name);
    if (!hit) {
      throw new Error(`there is no archived backup called "${folder}" on the ${BRANCH} branch`
        + `${archive.length ? ` (there is ${archive.map((a) => a.folder).join(', ')})` : ' - it has no archived backups'}. `
        + 'node tools/restore-secrets.mjs --list-archive lists them');
    }
    entries = await lsTree(appRoot, hit.tree);
    dir = `${ARCHIVE_DIR}/${name}`;
    where = `${dir}/ on the ${BRANCH} branch (${sha.slice(0, 7)})`;
  }
  const manifest = await manifestIn(appRoot, entries);
  if (!manifest?.bundles?.app) throw new Error(`${where} has no readable manifest.json`);
  for (const b of Object.values(manifest.bundles)) {
    if (!plainName(b?.file)) throw new Error(`${where} names a bundle file ${JSON.stringify(b?.file)}, which is not a plain file name`);
  }
  const app = await blobIn(appRoot, entries, manifest.bundles.app.file);
  if (!app) throw new Error(`${where} is missing ${manifest.bundles.app.file}`);
  const home = manifest.bundles.home ? await blobIn(appRoot, entries, manifest.bundles.home.file) : null;
  const root = folder == null ? manifest : await manifestIn(appRoot, rootEntries);
  return { sha, manifest, app, home, folder: dir ? dir.slice(ARCHIVE_DIR.length + 1) : null, root: summarize(null, root), archive: archiveSummary(archive) };
}

/**
 * Every backup on the branch, from the plaintext manifests alone - no
 * passphrase: { sha, root, archive[] }, or null when there is no branch yet.
 */
export async function listSealedBackups({ appRoot, remote = 'origin' }) {
  const sha = await fetchRemoteBranch(appRoot, remote);
  if (!sha) return null;
  const rootEntries = await lsTree(appRoot, sha);
  return {
    sha,
    root: summarize(null, await manifestIn(appRoot, rootEntries)),
    archive: archiveSummary((await readArchive(appRoot, rootEntries)).folders),
  };
}

/**
 * What the branch holds, from its plaintext manifest alone - no passphrase.
 * tools/bootstrap.sh asks this before restoring, so it can say how old the
 * backup is, whether the old bot was still running when it was taken, whether
 * this machine wrote it, and which other machines' backups are archived
 * beside it. null when there is no branch yet.
 */
export async function describeSealedBackup({ appRoot, remote = 'origin', now = Date.now(), machine = machineFingerprint() }) {
  const sha = await fetchRemoteBranch(appRoot, remote);
  if (!sha) return null;
  const rootEntries = await lsTree(appRoot, sha);
  const manifest = await manifestIn(appRoot, rootEntries);
  if (!manifest) throw new Error(`the ${BRANCH} branch (${sha.slice(0, 7)}) has no readable manifest.json`);
  const created = Date.parse(manifest.createdAt ?? '');
  const running = manifest.source?.botRunning;
  return {
    sha,
    createdAt: manifest.createdAt ?? null,
    ageMinutes: Number.isFinite(created) ? Math.max(0, Math.floor((now - created) / 60_000)) : null,
    host: manifest.source?.host ?? null,
    botRunning: typeof running === 'boolean' ? running : null,
    thisMachine: manifest.source?.machine === machine,
    hasHome: Boolean(manifest.bundles?.home),
    archive: archiveSummary((await readArchive(appRoot, rootEntries)).folders),
  };
}

/** Which of these app-bundle entries already exist here, by bundle root. */
export function appConflicts(appRoot, entries) {
  const rootOf = (e) => APP_BUNDLE_PATHS.find((p) => e === p || e.startsWith(`${p}/`)) ?? e.replace(/\/+$/, '');
  const found = new Set(['.env', 'data/config.json', 'data/session'].filter((p) => lexists(path.join(appRoot, p))));
  for (const e of entries) {
    if (e.endsWith('/')) continue;
    if (lexists(path.join(appRoot, e))) found.add(rootOf(e));
  }
  return [...found].sort();
}

const HOME_BUNDLE_HINT = /^(\.ssh|\.claude|\.gitconfig)(\/|$)/;

/**
 * Is this archive an app bundle, and nothing else? Checked before a single
 * member is unpacked.
 *
 * The app and home bundles sit side by side on the branch, and
 * `restore-secrets.mjs home.tar.gz.enc` is an easy slip. Unchecked, that
 * unpacked ~/.ssh/id_ed25519 into the git working tree, where .gitignore does
 * not cover it and the next `git add -A` commits the private key in the clear
 * (found in review, 2026-09-22). So every member must be under the app
 * allowlist, in canonical form, and the bundle must hold what every app backup
 * holds.
 */
export function checkAppBundleMembers(entries) {
  for (const e of entries) {
    const rel = canonicalMember(e);
    if (rel && isAppBundlePath(rel)) continue;
    if (rel && HOME_BUNDLE_HINT.test(rel)) {
      throw new Error(`refusing to restore: this is the HOME bundle (it holds ${rel}), not the app bundle. `
        + 'Restore it with --home <file>, which unpacks it into $HOME');
    }
    throw new Error(`refusing to restore: the bundle holds ${JSON.stringify(e)}, which is not part of an app backup. `
      + 'Nothing was unpacked');
  }
  const names = new Set(entries.map((e) => e.replace(/\/$/, '')));
  const missing = REQUIRED_APP_PATHS.filter((p) => !names.has(p));
  if (missing.length) {
    throw new Error(`refusing to restore: the bundle has no ${missing.join(' or ')}, so it is not an app backup. Nothing was unpacked`);
  }
}

/**
 * Unpack the app bundle into a checkout that does not have one yet.
 *
 * Refuses to clobber: restoring over a live install would swap the WhatsApp
 * session under a running bot and orphan whatever config.json holds now.
 */
export async function restoreAppBundle({ appRoot, tar: tarBuffer }) {
  const entries = await listTar(tarBuffer);
  checkAppBundleMembers(entries);
  const conflicts = appConflicts(appRoot, entries);
  if (conflicts.length) {
    const e = new Error(`this checkout already has ${conflicts.join(', ')} - restoring would overwrite them. `
      + 'Move them aside first, or restore into a fresh clone');
    e.conflicts = conflicts;
    throw e;
  }
  await tar(['-xzf', '-', '-C', appRoot, '--no-same-owner'], { input: tarBuffer });
  // The permissions matter as much as the contents.
  // The yt-dlp cookies are a Google login (media/yt-dlp-cookies.js).
  for (const [p, mode] of [['.env', 0o600], ['data', 0o700], ['data/config.json', 0o600], ['data/yt-dlp-cookies.txt', 0o600]]) {
    try { fs.chmodSync(path.join(appRoot, p), mode); } catch { /* not in this bundle */ }
  }
  const top = [...new Set(entries.map((e) => APP_BUNDLE_PATHS.find((p) => e === p || e.startsWith(`${p}/`)) ?? e))];
  return { restored: top.filter((p) => !p.endsWith('/')) };
}

function sameFile(a, b) {
  try {
    const sa = fs.lstatSync(a);
    const sb = fs.lstatSync(b);
    if (sa.isSymbolicLink() || sb.isSymbolicLink()) {
      return sa.isSymbolicLink() && sb.isSymbolicLink() && fs.readlinkSync(a) === fs.readlinkSync(b);
    }
    if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

/**
 * Files whose lines are merged into what the new box already has, never
 * replaced. The old machine's authorized_keys says who could log in THERE;
 * replacing a fresh box's with it - on bot-box4 it is empty - locks out the key
 * the Ubuntu installer imported, and the numbered copy tar keeps is a file
 * sshd never reads. known_hosts is the same shape: both sets of trusted hosts
 * are right.
 */
const MERGE_LINES = new Set(['.ssh/authorized_keys', '.ssh/known_hosts']);

function mergeLines(from, into) {
  const have = fs.readFileSync(into, 'utf8');
  const known = new Set(have.split('\n'));
  const add = [...new Set(fs.readFileSync(from, 'utf8').split('\n'))].filter((l) => l.trim() && !known.has(l));
  if (!add.length) return false;
  fs.appendFileSync(into, `${have && !have.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`);
  return true;
}

/**
 * Unpack the home bundle into $HOME, keeping whatever it would replace.
 *
 * GNU tar's --backup=numbered renames a file it is about to overwrite to
 * `name.~1~`, so a fresh box's own ~/.gitconfig or Claude settings survive
 * beside the restored ones. Only members that are missing or different are
 * extracted - otherwise every re-run of bootstrap.sh would pile up another
 * numbered copy of every identical file - which means unpacking once into a
 * private staging directory to compare, then extracting just that list.
 *
 * HOME_NEVER is enforced on names in canonical form (canonicalMember), and a
 * member under a symlink the bundle itself makes is refused, because
 * `.x -> .config` followed by `.x/gh/hosts.yml` would write the one file this
 * must never write while every name looked innocent. Every check runs before
 * anything in $HOME is touched.
 */
export async function restoreHomeBundle({ homeDir, tar: tarBuffer }) {
  const entries = await listTar(tarBuffer);
  const rels = [];
  for (const e of entries) {
    const rel = canonicalMember(e);
    if (!rel) {
      throw new Error(`refusing to restore: the home bundle has a member named ${JSON.stringify(e)}, `
        + 'which is not a plain relative path. Nothing was restored');
    }
    if (isForbiddenHomePath(rel)) {
      throw new Error(`refusing to restore: the home bundle contains ${rel}, which must never be restored from a backup`);
    }
    rels.push(rel);
  }

  const [work, removeWork] = makeStagingDir(os.tmpdir(), 'wa-home-');
  try {
    const staging = path.join(work, 'tree');
    fs.mkdirSync(staging, { mode: 0o700 });
    await tar(['-xzf', '-', '-C', staging, '--no-same-owner'], { input: tarBuffer });

    const links = new Set();
    for (const rel of rels) {
      try { if (fs.lstatSync(path.join(staging, rel)).isSymbolicLink()) links.add(rel); } catch { /* checked below */ }
    }
    const want = [];
    const replaced = [];
    const added = [];
    const toMerge = [];
    for (let i = 0; i < entries.length; i++) {
      const name = entries[i];
      const rel = rels[i];
      const parts = rel.split('/');
      for (let j = 1; j < parts.length; j++) {
        const up = parts.slice(0, j).join('/');
        if (links.has(up)) throw new Error(`refusing to restore: ${rel} sits under ${up}, which the bundle makes a symlink`);
      }
      const staged = path.join(staging, rel);
      const dest = path.join(homeDir, rel);
      let st;
      try {
        st = fs.lstatSync(staged);
      } catch {
        // Once, a name tar displayed escaped matched no staged file and was
        // skipped here as "unchanged". A member that did not unpack is a
        // failed restore, and says so.
        throw new Error(`the home bundle lists ${JSON.stringify(name)}, but it did not unpack. Nothing was restored`);
      }
      if (st.isDirectory()) {
        if (!lexists(dest)) want.push(name);
        continue;
      }
      if (!lexists(dest)) { want.push(name); added.push(rel); continue; }
      if (sameFile(staged, dest)) continue;
      if (MERGE_LINES.has(rel) && st.isFile()) {
        let isFile = false;
        try { isFile = fs.statSync(dest).isFile(); } catch { /* dangling */ }
        if (isFile) {
          toMerge.push([rel, staged, dest]);
          continue;
        }
      }
      want.push(name);
      replaced.push(rel);
    }

    const merged = [];
    for (const [rel, staged, dest] of toMerge) if (mergeLines(staged, dest)) merged.push(rel);
    if (want.length) {
      const list = path.join(work, 'members');
      fs.writeFileSync(list, want.map((n) => `${n}\0`).join(''), { mode: 0o600 });
      await tar(['-xzf', '-', '-C', homeDir, '--no-same-owner', '--backup=numbered', '--no-recursion',
        '--null', '--verbatim-files-from', '--no-unquote', '-T', list], { input: tarBuffer });
    }
    // ssh refuses keys in a directory anyone else can write to.
    try { if (fs.lstatSync(path.join(homeDir, '.ssh')).isDirectory()) fs.chmodSync(path.join(homeDir, '.ssh'), 0o700); } catch { /* none */ }
    return { added, replaced, merged, unchanged: entries.length - want.length - merged.length };
  } finally {
    removeWork();
  }
}

/* ---------------------------------------------------------------- cron --- */

export const CRON_TAG = '# whatsapp-bot:sealed-backup';
// 05:17 UTC is 01:17 in New York in summer and 00:17 in winter: after the
// activity backup's midnight, and at a quiet hour for the groups. The box runs
// UTC, and Ubuntu's cron does not support CRON_TZ, so the offset is fixed here.
export const CRON_SCHEDULE = '17 5 * * *';

const shq = (s) => (/^[\w@+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`);
// `%` ends the command in a crontab line unless escaped.
const cronq = (s) => shq(s).replace(/%/g, '\\%');

export function cronLine({ appRoot, nodePath = process.execPath }) {
  return `${CRON_SCHEDULE} cd ${cronq(path.resolve(appRoot))} && ${cronq(nodePath)} tools/backup-secrets.mjs --cron `
    + `>> data/logs/backup-secrets.log 2>&1 ${CRON_TAG}`;
}

const isOurCronLine = (l) => l.includes(CRON_TAG)
  || (!l.trimStart().startsWith('#') && /tools\/backup-secrets\.mjs\b.*--cron/.test(l));

/**
 * The crontab program, overridable so the tests never touch the real
 * crontab of whoever runs them.
 */
const crontabCmd = () => process.env.SEALED_BACKUP_CRONTAB || 'crontab';

function runCrontab(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(crontabCmd(), args, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(`crontab ${args.join(' ')}: ${firstLine(stderr) || err.message}`);
        e.stderr = String(stderr);
        e.exitCode = typeof err.code === 'number' ? err.code : null;
        return reject(e);
      }
      resolve(String(stdout));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? undefined);
  });
}

export async function readCrontab() {
  try {
    return await runCrontab(['-l']);
  } catch (err) {
    if (/no crontab for/i.test(err.stderr ?? '')) return '';
    throw err;
  }
}

/**
 * Install (or refresh) the one nightly line. Idempotent: any earlier copy of
 * our line is replaced, every other line is left exactly as it was.
 *
 * Refuses unless .env holds the passphrase, because that is the only place a
 * cron job can get it - cron does not inherit your shell's environment, and
 * the job must never prompt. A cron line that can only ever fail is worse than
 * none, because it looks like a backup.
 */
export async function installCron({ appRoot, nodePath = process.execPath } = {}) {
  appRoot = path.resolve(appRoot);
  if (!readEnvPassphrase(appRoot)) {
    throw new Error('refusing to install the nightly backup: .env has no BACKUP_PASSPHRASE, and a cron job cannot '
      + 'ask for one. Run `node tools/backup-secrets.mjs --set-passphrase` first');
  }
  fs.mkdirSync(path.join(appRoot, 'data', 'logs'), { recursive: true });
  const line = cronLine({ appRoot, nodePath });
  const current = await readCrontab();
  const lines = current.trim() === '' ? [] : current.replace(/\n+$/, '').split('\n');
  const next = `${[...lines.filter((l) => !isOurCronLine(l)), line].join('\n')}\n`;
  if (next === current) return { changed: false, line };
  await runCrontab(['-'], next);
  return { changed: true, line };
}

/** Take our line out again - for a machine being retired. */
export async function removeCron() {
  const current = await readCrontab();
  const lines = current.split('\n');
  const kept = lines.filter((l) => !isOurCronLine(l));
  if (kept.length === lines.length) return { changed: false };
  await runCrontab(['-'], kept.join('\n'));
  return { changed: true };
}
