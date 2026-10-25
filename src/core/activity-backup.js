/**
 * A daily, permanent record of everything the bot did.
 *
 * The runtime state under data/ is the only copy of what has happened here -
 * who asked for what, what was refused and why, what every admin did in the
 * portal - and it is gitignored, capped, and rotated. History is trimmed at 500
 * rows per plugin, the audit log at whatever fits, the debug logs pruned after
 * fourteen days. So the record of a dispute is gone before anybody thinks to
 * look for it. This writes the day's activity into git, once, at midnight, and
 * git keeps it.
 *
 * WHAT IS DELIBERATELY NOT IN HERE
 *
 * data/session/ and data/config.json are excluded, and a test enforces it.
 * They are not activity, they are credentials: session/creds.json holds the
 * noiseKey, signedIdentityKey, signedPreKey and advSecretKey for the linked
 * device - anyone holding that folder can send messages as this number -
 * and config.json holds the Jellyfin token, the API keys, the mail app
 * password and every admin's scrypt password hash. Those are encrypted with
 * MASTER_KEY, which lives in .env; committing both to the same repository
 * would put the lock and the key in one box. They ARE backed up, but only
 * sealed under a passphrase - see "the secrets bundle" below, and
 * src/core/sealed-backup.js for the nightly copy a new machine restores from.
 *
 * Everything else goes in whole, with the numbers and names intact, because a
 * record with the identities stripped out cannot answer the questions it
 * exists to answer.
 *
 * The commits go to a SEPARATE CLONE on its own branch. The bot's own checkout
 * is the live production one; leaving it dirty, or mid-rebase, would break the
 * next `git pull` during an upgrade.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import log from '../util/logger.js';

const logger = log.scope('backup');

const BRANCH = 'activity-backups';
const CLONE_DIR = 'activity-backup';        // under data/, gitignored
const GIT_TIMEOUT_MS = 120_000;

/** Never let a backup hang the bot: every git call is bounded. */
function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`git ${args[0]}: ${(stderr || err.message).trim().split('\n')[0]}`));
      resolve(String(stdout));
    });
  });
}

/** The date in New York, which is where midnight is being measured. */
export function nyDayKey(ts = Date.now()) {
  // en-CA gives YYYY-MM-DD, which sorts.
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * The hour in New York, 0-23. hourCycle 'h23', not hour12: false: en-US with
 * hour12: false writes the hour after midnight as "24", so this answered 24
 * rather than 0 from midnight to 1 in the morning.
 */
export function nyHour(ts = Date.now()) {
  return Number(new Date(ts).toLocaleString('en-US',
    { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }));
}

/**
 * Is a backup due?
 *
 * Fires on the first check at or after the configured hour, rather than
 * demanding an exact minute: this process restarts often, and a run that was
 * asleep at midnight should still write the day when it wakes rather than
 * losing it silently. Same reasoning as the daily digest.
 */
export function isDue(cfg, { now = Date.now(), lastRun = null } = {}) {
  if (!cfg?.enabled) return false;
  const today = nyDayKey(now);
  if (lastRun === today) return false;
  return nyHour(now) >= (cfg.hour ?? 0);
}

/**
 * Everything worth keeping, pulled out of the state store.
 *
 * Movies and TV keep separate namespaces, so both are read - forgetting the TV
 * half is the recurring bug in this codebase.
 */
export function collectActivity(stateStore, config = {}, { now = Date.now() } = {}) {
  const ns = (name) => {
    try { return stateStore.namespace(name); } catch { return { get: (_k, d) => d }; }
  };
  const movies = ns('movie-requests');
  const tv = ns('tv-requests');

  // Per-user cooldown timestamps are keyed by JID and are pure noise in a
  // record - they say nothing about what happened, only when somebody last
  // spoke. Everything else in the namespace is kept.
  const withoutCooldowns = (store, keys) => {
    const out = {};
    for (const k of keys) out[k] = store.get(k, []);
    return out;
  };

  return {
    generatedAt: new Date(now).toISOString(),
    day: nyDayKey(now),
    movies: withoutCooldowns(movies, ['history', 'wanted', 'library-misses']),
    tv: withoutCooldowns(tv, ['history', 'library-misses', 'pending']),
    audit: ns('audit').get('events', []),
    members: ns('member-activity').get('members', {}),
    groupActivity: ns('group-activity').get('events', []),
    messageIndex: ns('msg-index').get('entries', []),
    catalogue: ns('catalogue').get('clean', null) === null ? {} : {
      at: ns('catalogue').get('at', null),
      clean: ns('catalogue').get('clean', 0),
      scanned: ns('catalogue').get('scanned', 0),
      skipped: ns('catalogue').get('skipped', 0),
    },
    // Moderation state travels with the record it explains.
    bannedNumbers: config.bannedNumbers ?? [],
    alwaysLocked: config.lockdown?.alwaysLocked ?? [],
  };
}

/** A short human-readable index, so the folder is legible without a JSON viewer. */
export function summarise(a) {
  const n = (v) => (Array.isArray(v) ? v.length : Object.keys(v ?? {}).length);
  const count = (rows, status) => (rows ?? []).filter((r) => r.status === status).length;
  // Requests from a beta group are tests, and are counted apart, as the
  // daily digest counts them: a tester trying a refusal on purpose is not a
  // film a member was refused, and a test never sends anything (beta.js).
  const all = [...(a.movies?.history ?? []), ...(a.tv?.history ?? [])];
  const mh = (a.movies?.history ?? []).filter((r) => !r?.beta);
  const th = (a.tv?.history ?? []).filter((r) => !r?.beta);
  const tests = all.length - mh.length - th.length;
  // A wanted entry marked resolved (wanted.js) is kept a month to be seen,
  // and is not wanted any more: counted apart, as the Wanted card shows it.
  const wanted = Array.isArray(a.movies?.wanted) ? a.movies.wanted : [];
  const resolved = wanted.filter((w) => w?.resolved).length;
  return [
    `# Activity — ${a.day}`,
    '',
    `Generated ${a.generatedAt} (midnight, New York).`,
    '',
    '| | |',
    '|---|---:|',
    `| Movie requests on record | ${mh.length} |`,
    `| &nbsp;&nbsp;delivered | ${count(mh, 'sent')} |`,
    `| &nbsp;&nbsp;blocked | ${count(mh, 'blocked-rating')} |`,
    `| &nbsp;&nbsp;not in library | ${count(mh, 'not-in-library')} |`,
    // The operator's one-film-per-request rule (2026-10-11): refused, and
    // told to send each film on its own.
    `| &nbsp;&nbsp;several films in one request | ${count(mh, 'one-at-a-time')} |`,
    `| TV requests on record | ${th.length} |`,
    ...(tests ? [`| Beta tests (not counted above) | ${tests} |`] : []),
    `| Wanted (asked for, not on the server) | ${wanted.length - resolved} |`,
    ...(resolved ? [`| &nbsp;&nbsp;resolved in the last 30 days (not counted above) | ${resolved} |`] : []),
    `| Not-in-library faults | ${n(a.movies?.['library-misses']) + n(a.tv?.['library-misses'])} |`,
    `| Portal audit entries | ${n(a.audit)} |`,
    `| Members tracked | ${n(a.members)} |`,
    `| Group activity events | ${n(a.groupActivity)} |`,
    `| Banned numbers | ${n(a.bannedNumbers)} |`,
    '',
    'Full detail is in the JSON files beside this one. Credentials are not',
    'included: no WhatsApp session, no config.json, no .env.',
    '',
  ].join('\n');
}

/**
 * Write one day's files into the backup clone.
 * Returns the relative paths written.
 */
export function writeDay(repoDir, activity, { logFile = null } = {}) {
  const dir = path.join(repoDir, 'records', activity.day);
  fs.mkdirSync(dir, { recursive: true });

  const written = [];
  const put = (name, data) => {
    fs.writeFileSync(path.join(dir, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
    written.push(path.join('records', activity.day, name));
  };

  put('summary.md', summarise(activity));
  put('movie-requests.json', activity.movies?.history ?? []);
  put('tv-requests.json', activity.tv?.history ?? []);
  put('audit.json', activity.audit ?? []);
  put('wanted.json', activity.movies?.wanted ?? []);
  put('library-misses.json', [
    ...(activity.movies?.['library-misses'] ?? []),
    ...(activity.tv?.['library-misses'] ?? []),
  ]);
  put('members.json', activity.members ?? {});
  put('group-activity.json', activity.groupActivity ?? []);
  put('message-index.json', activity.messageIndex ?? []);
  put('moderation.json', { bannedNumbers: activity.bannedNumbers, alwaysLocked: activity.alwaysLocked });
  put('catalogue.json', activity.catalogue ?? {});

  // The debug log is the finest-grained record there is, and it is pruned
  // after fourteen days. Gzipped it is tens of kilobytes a day.
  if (logFile && fs.existsSync(logFile)) {
    const gz = zlib.gzipSync(fs.readFileSync(logFile));
    fs.writeFileSync(path.join(dir, path.basename(logFile) + '.gz'), gz);
    written.push(path.join('records', activity.day, path.basename(logFile) + '.gz'));
  }
  return written;
}

/* ------------------------------ the secrets bundle ---------------------- */

/**
 * Everything a new machine needs that is NOT in git, sealed under a passphrase.
 *
 * The point is redeploy: clone, restore, start - no re-entering API keys, no
 * re-linking the number from a phone, no history lost. That needs config.json
 * (all the settings), .env (the MASTER_KEY, without which config.json is
 * undecryptable noise), data/session/ and data/sessions/ (the linked devices,
 * without which you re-pair), data/state.json (request history, the wanted
 * list, the portal audit log), data/outbound-budget.json (the rolling WhatsApp
 * volume counter - a fresh box with an empty one hands a full budget to an
 * account that may already be close to a penalty), data/backups/ (the
 * original group descriptions, which exist so a bulk rewrite can be undone),
 * data/yt-dlp-cookies.txt (the YouTube login yt-dlp uses for "Queue a public
 * link", uploaded on the panel: media/yt-dlp-cookies.js - a rebuilt box that
 * lost it would answer the next YouTube link with "Sign in to confirm you're
 * not a bot" until somebody exported and uploaded it again), and any filter
 * CA in certs/, which is gitignored and without which outbound HTTPS fails on
 * a filtered network.
 *
 * Which is exactly why it is encrypted rather than committed as-is. Those
 * together are the whole account: the private keys that let anyone send as
 * this number, every API key, and every admin's password hash. Putting
 * MASTER_KEY in the same repository as the data it encrypts would make the
 * encryption pointless, and git history is permanent - a secret committed once
 * is in every clone forever, and rotating it later does not take it out of the
 * history. Commit c4a0fe7 set that policy; this list only widens what is
 * sealed, never what is stored in the clear.
 *
 * So: AES-256-GCM under a key derived from a passphrase. A repository leak then
 * yields a blob. Same primitives as util/crypto.js, no new dependency. The
 * passphrase is kept in .env beside MASTER_KEY so the nightly job can seal
 * without a human - the owner chose a nightly refresh over typing it each
 * time. It guards the copy in the repository; anyone who can already read
 * .env on this box has everything the bundle holds anyway.
 *
 * This list is shared with src/core/sealed-backup.js, which is what the nightly
 * cron and tools/bootstrap.sh use; the activity-backups branch only gets the
 * app bundle when backup.includeSecrets is switched on.
 */
export const APP_BUNDLE_PATHS = Object.freeze([
  '.env',
  'data/config.json',
  'data/session',
  'data/sessions',
  'data/state.json',
  'data/outbound-budget.json',
  'data/backups',
  'data/yt-dlp-cookies.txt',
]);
const CERT_FILE = /\.(crt|pem)$/;
const KDF_SALT = 'wa-bot-backup-v1';

/**
 * The bundle list as it exists on this machine: only paths that are present,
 * plus every certs/*.crt and certs/*.pem, expanded here because tar is never
 * handed a shell glob. Deliberately not data/sessions.json (web logins, which
 * mean nothing on another box), data/logs, data/media, or the backup clones
 * that live under data/ - an allowlist, so a new directory under data/ is left
 * out until somebody decides it belongs.
 */
export function appBundlePaths(appRoot) {
  const present = APP_BUNDLE_PATHS.filter((p) => fs.existsSync(path.join(appRoot, p)));
  let certs = [];
  try {
    certs = fs.readdirSync(path.join(appRoot, 'certs'))
      .filter((f) => CERT_FILE.test(f))
      .sort()
      .map((f) => `certs/${f}`);
  } catch { /* no certs/ directory: nothing to add */ }
  return [...present, ...certs];
}

/**
 * Does this relative path belong in the app bundle? The same allowlist as
 * appBundlePaths(), asked of a single name - which is how a restore checks
 * that an archive really is an app bundle before unpacking any of it.
 */
export function isAppBundlePath(rel) {
  const r = String(rel);
  if (APP_BUNDLE_PATHS.some((p) => r === p || r.startsWith(`${p}/`))) return true;
  return /^certs\/[^/]+$/.test(r) && CERT_FILE.test(r);
}

export function sealSecrets(tarBuffer, passphrase) {
  if (!passphrase || String(passphrase).length < 12) {
    throw new Error('backup passphrase must be at least 12 characters');
  }
  const salt = crypto.randomBytes(16);
  // scrypt, not a bare hash: this key is only as strong as the passphrase, so
  // make guessing it expensive.
  const key = crypto.scryptSync(String(passphrase), Buffer.concat([Buffer.from(KDF_SALT), salt]), 32,
    { N: 1 << 15, r: 8, p: 1, maxmem: 96 << 20 });
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(tarBuffer), c.final()]);
  return Buffer.concat([Buffer.from('WABKP1'), salt, iv, c.getAuthTag(), enc]);
}

export function openSecrets(blob, passphrase) {
  if (blob.subarray(0, 6).toString() !== 'WABKP1') throw new Error('not a bot secrets bundle');
  const salt = blob.subarray(6, 22);
  const iv = blob.subarray(22, 34);
  const tag = blob.subarray(34, 50);
  const enc = blob.subarray(50);
  const key = crypto.scryptSync(String(passphrase), Buffer.concat([Buffer.from(KDF_SALT), salt]), 32,
    { N: 1 << 15, r: 8, p: 1, maxmem: 96 << 20 });
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(enc), d.final()]);
  } catch {
    // GCM authentication failing means the passphrase is wrong or the file was
    // altered. Both deserve the same blunt answer.
    throw new Error('wrong passphrase, or the bundle is corrupt');
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lexists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

/* ----------------------------------------- plaintext staging, cleaned up --- */

/**
 * Plaintext staging directories that exist right now, in this process.
 *
 * A snapshot (and a home restore) passes through a private temp directory
 * holding .env, config.json and the session keys in the clear. `finally`
 * removes it - but Node's default response to Ctrl-C or SIGTERM is to exit
 * without running any `finally`, and a review on 2026-09-22 found exactly that
 * copy still sitting in $TMPDIR after an interrupted run. So every live one is
 * registered here and removed again on `exit` too, and the CLIs turn SIGINT,
 * SIGTERM and SIGHUP into an ordinary exit (exitCleanlyOnSignals) so that
 * handler runs. The files inside keep their real modes, because tar records
 * them for the restore; the 0700 directory around them is what keeps other
 * users out.
 */
const liveStaging = new Set();
export const STAGING_PREFIXES = Object.freeze(['wa-bkp-', 'wa-home-']);
const STALE_STAGING_MS = 60 * 60 * 1000;

function removeLiveStaging() {
  for (const dir of liveStaging) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort at exit */ }
  }
  liveStaging.clear();
}
process.on('exit', removeLiveStaging);

/**
 * Make a private staging directory that is removed on exit even if its
 * `finally` never runs. Returns [dir, remove].
 */
export function makeStagingDir(parent, prefix) {
  sweepStaleStaging(parent);
  const dir = fs.mkdtempSync(path.join(parent, prefix));
  liveStaging.add(dir);
  fs.chmodSync(dir, 0o700);
  return [dir, () => {
    liveStaging.delete(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }];
}

/**
 * Remove staging directories this user left behind in `parent` - a SIGKILL,
 * an OOM kill or a power cut runs no handler at all. Only ones over an hour
 * old: a run that is staging right now, in another process, finishes in
 * seconds, and deleting its directory under it would fail that run.
 */
export function sweepStaleStaging(parent = os.tmpdir(), { now = Date.now() } = {}) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  let names = [];
  try { names = fs.readdirSync(parent); } catch { return []; }
  const removed = [];
  for (const name of names) {
    if (!STAGING_PREFIXES.some((p) => name.startsWith(p))) continue;
    const dir = path.join(parent, name);
    try {
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || (uid !== null && st.uid !== uid)) continue;
      if (now - st.mtimeMs < STALE_STAGING_MS) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch { /* gone already, or not ours to remove */ }
  }
  if (removed.length) logger.warn(`removed ${removed.length} stale plaintext staging director${removed.length === 1 ? 'y' : 'ies'} left by an interrupted run`);
  return removed;
}

/**
 * For command-line tools only: turn SIGINT, SIGTERM and SIGHUP into a normal
 * exit, so the `exit` handler above removes the plaintext staging copy. Not
 * installed by this module itself, because the bot has its own SIGTERM
 * handling for a graceful shutdown, and exiting early from under it would
 * lose whatever it was about to save.
 */
export function exitCleanlyOnSignals() {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    process.once(signal, () => {
      process.stderr.write(`\nInterrupted (${signal}); removing temporary files.\n`);
      process.exit(code);
    });
  }
}

/**
 * Copy one file into the staging directory, and for JSON make sure the copy
 * is whole.
 *
 * The bot rewrites these files while it runs, and not all of it is atomic:
 * Baileys' useMultiFileAuthState writes every data/session/*.json in place,
 * bot.js writes outbound-budget.json in place, and state.js's shutdown flush
 * does too. A read that lands mid-write gets a truncated file, and a tarball
 * of a truncated creds.json is a backup that restores a broken session - which
 * nobody would find out until the day it was needed. So every *.json copy is
 * parsed, a torn one is re-read a few times, and if it still will not parse the
 * snapshot fails loudly, naming the file, rather than sealing garbage.
 */
async function copyWhole(src, dst, rel, { copyFile, retries, retryDelayMs }) {
  for (let attempt = 0; ; attempt++) {
    copyFile(src, dst);
    if (!rel.endsWith('.json')) return;
    try {
      JSON.parse(fs.readFileSync(dst, 'utf8'));
      return;
    } catch {
      // The parser's own message is deliberately left out: V8 quotes a slice
      // of the input, and this input is session keys and API tokens headed
      // for a log file.
      if (attempt >= retries) {
        if (emptyKeyFile(src, rel)) {
          throw Object.assign(new Error(`${rel} is empty, and Baileys reads it as no key at all - left out`), { code: 'EMPTY_KEY_FILE' });
        }
        throw new Error(`${rel} is not valid JSON after ${attempt + 1} reads - refusing to seal a torn copy`);
      }
      await sleep(retryDelayMs);
    }
  }
}

/**
 * A session key file that is empty, and has been for a while: not a torn
 * read, but a file a stopped process truncated and never refilled. On
 * bot-box2, pre-key-37.json and pre-key-38.json were left at 0 bytes by the
 * restart at 04:23 UTC on 2026-09-30, and every backup after that - the
 * nightly one, and the one taken with the bot stopped - refused to seal "a
 * torn copy", so the machine had no backup at all. Baileys' own readData
 * returns null for a file that will not parse, so to the bot an empty key file
 * is the same as a missing one, and it is left out as a missing one would be.
 * creds.json is never this case: an empty one is a broken session, and the
 * snapshot still fails on it. A file emptied in the last minute is still
 * treated as torn, since writeFile truncates before it writes.
 */
const EMPTY_KEY_MIN_AGE_MS = 60_000;
function emptyKeyFile(src, rel) {
  if (!/^data\/sessions?\/(?:[^/]+\/)?[^/]+\.json$/.test(rel) || path.basename(rel) === 'creds.json') return false;
  try {
    const st = fs.statSync(src);
    return st.size === 0 && Date.now() - st.mtimeMs >= EMPTY_KEY_MIN_AGE_MS;
  } catch { return false; }
}

/** Copy a tree into staging, recording what went in for the content digest. */
async function stageTree(srcRoot, rel, stageRoot, entries, opts) {
  const src = path.join(srcRoot, rel);
  let st;
  try {
    st = fs.lstatSync(src);
  } catch (err) {
    // Baileys deletes used pre-keys as it goes, so a file listed a moment ago
    // can be gone. The snapshot is of the state after that, which is correct.
    if (err.code === 'ENOENT') return;
    throw err;
  }
  if (opts.exclude?.(rel)) return;
  const dst = path.join(stageRoot, rel);
  const mode = st.mode & 0o7777;

  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
    let names = [];
    try { names = fs.readdirSync(src).sort(); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    for (const name of names) await stageTree(srcRoot, path.join(rel, name), stageRoot, entries, opts);
    // Owner rwx is forced so the staging copy can always be cleaned up.
    fs.chmodSync(dst, mode | 0o700);
    entries.push({ rel, line: `d ${rel} ${(mode | 0o700).toString(8)}` });
  } else if (st.isFile()) {
    fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
    try {
      await copyWhole(src, dst, rel, opts);
    } catch (err) {
      // Deleted between a torn read and its retry: drop the torn copy too, or
      // it would be tarred along with the rest of the directory.
      fs.rmSync(dst, { force: true });
      if (err.code === 'ENOENT') return;
      if (err.code === 'EMPTY_KEY_FILE') {
        logger.warn(err.message);
        return;
      }
      throw err;
    }
    fs.chmodSync(dst, mode);
    // Keep the real mtime, so a restored file does not look brand new.
    fs.utimesSync(dst, st.atime, st.mtime);
    const data = fs.readFileSync(dst);
    const sha = crypto.createHash('sha256').update(data).digest('hex');
    entries.push({ rel, bytes: data.length, line: `f ${rel} ${mode.toString(8)} ${sha}` });
  } else if (st.isSymbolicLink()) {
    fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
    const target = fs.readlinkSync(src);
    fs.symlinkSync(target, dst);
    entries.push({ rel, line: `l ${rel} ${target}` });
  }
  // Sockets and fifos are skipped. The realistic one is an ssh ControlMaster
  // socket in ~/.ssh, which means nothing on another machine.
}

/** tar a staged tree to a buffer. Bounded, like every child process here. */
function tarDir(dir, relPaths) {
  return new Promise((resolve, reject) => {
    execFile('tar', ['-czf', '-', '-C', dir, '--', ...relPaths],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: 512 << 20, encoding: 'buffer' },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`tar: ${String(stderr).trim().split('\n')[0] || err.message}`));
        resolve(stdout);
      });
  });
}

/**
 * A consistent snapshot of some paths under a root, as a gzipped tar.
 *
 * Staged through a private 0700 copy rather than tarred in place, because tar
 * reading the live tree while the bot rewrites it is how a torn file gets in;
 * copying first lets every JSON file be checked before anything is sealed.
 * The staging copy is plaintext secrets, so it is removed in `finally` whatever
 * happens, and on process exit if `finally` never gets to run (see
 * makeStagingDir).
 *
 * Returns { tar, digest, paths, files, bytes }. `digest` is a sha256 over the
 * sorted (type, path, mode, content hash) of every entry - NOT over the tar
 * bytes, which change with every timestamp - so it moves only when something
 * that would be restored actually changed. That is what lets a quiet night
 * produce no commit.
 */
export async function snapshotBundle(root, relPaths, {
  exclude = null,
  retries = 4,
  retryDelayMs = 250,
  copyFile = fs.copyFileSync,
  tmpParent = os.tmpdir(),
} = {}) {
  const [staging, removeStaging] = makeStagingDir(tmpParent, 'wa-bkp-');
  try {
    const entries = [];
    const opts = { exclude, retries, retryDelayMs, copyFile };
    for (const rel of relPaths) await stageTree(root, rel, staging, entries, opts);
    const present = relPaths.filter((p) => lexists(path.join(staging, p)));
    if (!present.length) throw new Error('nothing to bundle');

    const lines = entries.map((e) => e.line).sort();
    const digest = crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
    const tar = await tarDir(staging, present);
    return {
      tar,
      digest,
      paths: present,
      files: entries.filter((e) => e.line.startsWith('f ')).length,
      bytes: entries.reduce((n, e) => n + (e.bytes ?? 0), 0),
    };
  } finally {
    removeStaging();
  }
}

/**
 * Write the sealed bundle, but only when its contents actually changed.
 *
 * The ciphertext differs on every run - fresh salt and IV - so writing it
 * unconditionally would commit a new multi-megabyte blob every night whether or
 * not anything moved. The content digest decides, and is stored beside it.
 */
export async function writeSecretsBundle(repoDir, appRoot, passphrase) {
  const snap = await snapshotBundle(appRoot, appBundlePaths(appRoot));
  const digest = snap.digest;
  const dir = path.join(repoDir, 'restore');
  fs.mkdirSync(dir, { recursive: true });

  const stampFile = path.join(dir, 'secrets.sha256');
  const previous = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, 'utf8').trim() : null;
  if (previous === digest) return { changed: false, files: [] };

  fs.writeFileSync(path.join(dir, 'secrets.tar.gz.enc'), sealSecrets(snap.tar, passphrase));
  fs.writeFileSync(stampFile, `${digest}\n`);
  fs.writeFileSync(path.join(dir, 'README.md'), [
    '# Restoring onto a new machine',
    '',
    '`secrets.tar.gz.enc` holds everything the bot keeps outside git: `.env`,',
    '`data/config.json`, the WhatsApp sessions (`data/session/`,',
    '`data/sessions/`), `data/state.json` (request history and the portal audit',
    'log), `data/outbound-budget.json`, `data/backups/`, `data/yt-dlp-cookies.txt`, and any filter CA in',
    '`certs/`. Everything a fresh box would otherwise need re-entered or re-linked',
    'by hand.',
    '',
    'It is encrypted with AES-256-GCM under a passphrase that is deliberately',
    'NOT stored in this repository. Without it the file is a blob, which is the',
    'point: it contains the private keys that can send messages as this number,',
    'every API key, and every admin password hash.',
    '',
    'The fuller, preferred copy is the `sealed-backup` branch, which also carries',
    'the machine-level settings and is what `tools/bootstrap.sh` restores from.',
    'See "Fast path" at the top of docs/server-setup.md. To use this file instead:',
    '',
    '```bash',
    'git clone <this repo> ~/whatsapp-bot && cd ~/whatsapp-bot',
    './install.sh',
    'node tools/restore-secrets.mjs /path/to/secrets.tar.gz.enc',
    'sudo systemctl enable --now whatsapp-bot',
    '```',
    '',
    'Stop the old machine first. Two processes on one WhatsApp session is',
    '`connectionReplaced`, which is the fastest way to lose the number.',
    '',
  ].join('\n'));

  return { changed: true, files: ['restore/secrets.tar.gz.enc', 'restore/secrets.sha256', 'restore/README.md'] };
}

/**
 * Make sure the separate backup clone exists and is on the right branch.
 *
 * An orphan branch, so the record does not carry the code history around with
 * it and a `git log` of the backups is only backups.
 */
async function ensureClone(repoDir, remote) {
  if (fs.existsSync(path.join(repoDir, '.git'))) {
    try { await git(['fetch', 'origin', BRANCH], repoDir); } catch { /* first run, or offline */ }
    try {
      await git(['checkout', BRANCH], repoDir);
      await git(['reset', '--hard', `origin/${BRANCH}`], repoDir);
    } catch { /* branch not on the remote yet; keep what we have */ }
    return;
  }

  fs.mkdirSync(path.dirname(repoDir), { recursive: true });
  await git(['clone', '--no-checkout', '--depth', '1', remote, repoDir], path.dirname(repoDir));
  try {
    await git(['fetch', 'origin', `${BRANCH}:${BRANCH}`], repoDir);
    await git(['checkout', BRANCH], repoDir);
  } catch {
    // Branch does not exist yet: start it empty rather than on top of the code.
    await git(['checkout', '--orphan', BRANCH], repoDir);
    try { await git(['rm', '-rf', '--cached', '.'], repoDir); } catch { /* nothing staged */ }
  }
}

/**
 * Give the backup clone a committer identity.
 *
 * A fresh clone inherits nothing, and this box has no GLOBAL git identity - the
 * app checkout was configured locally. So `git commit` failed with "Author
 * identity unknown" and every nightly backup would have died at the last step,
 * having already written the files. Copy the app checkout's identity where
 * there is one, and fall back to something obviously the bot otherwise.
 */
async function ensureIdentity(repoDir, appRoot) {
  for (const [key, fallback] of [['user.name', 'whatsapp-bot'], ['user.email', 'bot@localhost']]) {
    let value = null;
    try { value = (await git(['config', '--get', key], appRoot)).trim(); } catch { /* not set there either */ }
    try { await git(['config', key, value || fallback], repoDir); } catch { /* best effort */ }
  }
}

/** Commit and push the day. Returns { committed, pushed, sha }. */
async function commitAndPush(repoDir, day, files, { push = true } = {}) {
  await git(['add', '--', ...files], repoDir);
  const status = await git(['status', '--porcelain'], repoDir);
  if (!status.trim()) return { committed: false, pushed: false, sha: null };

  await git(['commit', '-q', '-m', `Activity for ${day}`], repoDir);
  const sha = (await git(['rev-parse', '--short', 'HEAD'], repoDir)).trim();
  if (!push) return { committed: true, pushed: false, sha };

  await git(['push', '-u', 'origin', BRANCH], repoDir);
  return { committed: true, pushed: true, sha };
}

/**
 * Runs the backup once a day at midnight, New York time.
 *
 * A timer rather than a cron expression, for the same reason the digest uses
 * one: the bot restarts often and a missed exact-minute firing would lose the
 * day entirely.
 */
export class ActivityBackup {
  constructor({ configStore, stateStore, dataDir, alerts = null }) {
    this.configStore = configStore;
    this.stateStore = stateStore;
    this.dataDir = dataDir;
    this.alerts = alerts;
    this._timer = null;
    this.running = false;
  }

  get cfg() {
    const b = this.configStore.get().backup ?? {};
    return {
      enabled: b.enabled === true,
      hour: Number(b.hour ?? 0),
      push: b.push !== false,
      includeSecrets: b.includeSecrets === true,
      // Read from the environment first so it need never be written into the
      // config file the bundle itself contains.
      passphrase: process.env.BACKUP_PASSPHRASE || b.passphrase || '',
    };
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      this.tick().catch((err) => logger.warn(`backup check failed: ${err.message}`));
    }, 60_000);
    this._timer.unref?.();
    logger.info('daily activity backup armed');
  }

  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }

  async tick(now = Date.now()) {
    const st = this.stateStore.namespace('backup');
    if (!isDue(this.cfg, { now, lastRun: st.get('lastRun', null) })) return false;
    if (this.running) return false;
    this.running = true;
    try {
      const r = await this.run({ now });
      // Only mark the day done if it actually landed, so a network failure is
      // retried on the next tick rather than silently skipping the day.
      if (r.committed || r.upToDate) st.set('lastRun', nyDayKey(now));
      return true;
    } catch (err) {
      logger.error(`activity backup failed: ${err.message}`);
      this.alerts?.notify?.({
        kind: 'backup-failed', label: 'daily activity backup failed',
        note: `The ${nyDayKey(now)} activity backup did not complete: ${err.message}`,
        throttleMinutes: 240,
      }).catch(() => {});
      return false;
    } finally {
      this.running = false;
    }
  }

  /** Do it now, regardless of the schedule. */
  async run({ now = Date.now() } = {}) {
    const repoDir = path.join(this.dataDir, CLONE_DIR);
    const appRoot = path.resolve(this.dataDir, '..');
    const remote = (await git(['remote', 'get-url', 'origin'], appRoot)).trim();

    await ensureClone(repoDir, remote);
    await ensureIdentity(repoDir, appRoot);

    const config = this.configStore.get();
    const activity = collectActivity(this.stateStore, config, { now });
    // Yesterday's log is the one that is complete. At midnight the file for the
    // day just ended is the interesting one.
    const logFile = path.join(this.dataDir, 'logs', `debug-${activity.day}.log`);
    const files = writeDay(repoDir, activity, { logFile });

    // The turnkey-redeploy half: sealed, and only rewritten when the contents
    // actually changed, so a settings tweak produces a commit and a quiet day
    // produces none.
    const cfg = this.cfg;
    if (cfg.includeSecrets) {
      if (!cfg.passphrase) {
        logger.warn('backup.includeSecrets is on but no passphrase is set '
          + '(BACKUP_PASSPHRASE, or backup.passphrase) - skipping the secrets bundle');
      } else {
        try {
          const sealed = await writeSecretsBundle(repoDir, path.resolve(this.dataDir, '..'), cfg.passphrase);
          if (sealed.changed) {
            files.push(...sealed.files);
            logger.info('secrets bundle changed - resealed');
          }
        } catch (err) {
          // A failed bundle must not cost the day's activity record.
          logger.error(`secrets bundle failed: ${err.message}`);
        }
      }
    }

    const r = await commitAndPush(repoDir, activity.day, files, { push: this.cfg.push });
    if (r.committed) {
      logger.info(`activity backup for ${activity.day}: ${files.length} file(s), ${r.sha}`
        + (r.pushed ? ', pushed' : ' (not pushed)'));
    } else {
      logger.info(`activity backup for ${activity.day}: nothing changed`);
    }
    return { ...r, day: activity.day, files: files.length, upToDate: !r.committed };
  }
}
