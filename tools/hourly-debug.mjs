#!/usr/bin/env node
/**
 * The hourly check: find what failed or went unanswered, research and fix it,
 * restart, report.
 *
 *   node tools/hourly-debug.mjs run             what cron runs, on the hour
 *   node tools/hourly-debug.mjs run --asked     what cron's tick runs between the hours, when the bot asked
 *                                               for a check at once (data/check-now.json); silent when not due
 *   node tools/hourly-debug.mjs run --dry-run   scan and say what it would do; changes nothing
 *   node tools/hourly-debug.mjs restart --reason "<why>" [--expect <sha>]   by hand
 *   node tools/hourly-debug.mjs status          is everything it needs in place?
 *
 * Asked for by the operator: "every hour on the hour ... go through the chats
 * and any request that failed or you see got unfulfilled due to some sort of
 * error ... research ... report back to me on findings and remediation and of
 * course reboot the bot right away ... and of course make fixes to code in
 * repo." deploy/install-hourly-debug.sh puts it in cron; docs/operations.md,
 * "The hourly check", is the manual.
 *
 * A run is, in order:
 *
 *   1. Scan (src/core/incident-scan.js). Deterministic and cheap. Nothing new
 *      means an "all clear" row for the panel and nothing else: no model run,
 *      no email, and no restart, which would throw away every encode in
 *      progress for nothing.
 *   2. Restart right away when the bot is unhealthy in a way a restart cures
 *      (a stuck job, WhatsApp down, a film waiting for the next start), before
 *      any research, and wait for it to come back connected.
 *   3. Research: headless Claude Code, in a clone kept for the purpose and
 *      reset to origin/main - never the live checkout, which the auto-updater
 *      refuses to move while it has local changes. The prompt is
 *      deploy/hourly-debug/prompt.md; the findings are handed over as data.
 *   4. Ship a fix, when the session asks for one: this script, not the
 *      session, checks the commits, runs the whole suite on them and on main,
 *      pushes only when nothing new fails, and restarts the bot into the fix
 *      at once.
 *   5. Record the run for the panel, and email the report.
 *
 * A run can also be asked for between the hours. The operator, 2026-10-12:
 * "Needless to say #issue tickets submitted by head admin 5558100180 get top
 * priority" and "Meaning it should activate bot to send yo a notification to
 * check right away". The bot cannot start this script itself (its unit's
 * NoNewPrivileges would break the sudo restart, and a restart would kill its
 * own child), so a library keeper's #issue makes it write data/check-now.json
 * (src/core/check-now.js), and cron's tick, every minute, runs `run --asked`
 * while the file is there. Such a run does nothing at all until the file is
 * due, and runs only for a keeper's #issue it finds itself in
 * library-news.jsonl (askedGate); every run, on the hour or asked, takes the
 * asks its scan covered.
 *
 * Why this script does the pushing, the restarting and the talking to the
 * bot: the session runs with --permission-mode bypassPermissions over text
 * written by strangers in public groups, as the bot's own user, on a box
 * where that user may have passwordless sudo. What the prompt forbids, a
 * prompt injection can talk a model into; what the kernel forbids, it
 * cannot. So the session runs in deploy/hourly-debug/sandbox.py - no_new_privs
 * (sudo and every setuid program refuse to work for it) and Landlock (it can
 * write only its clone, this run's folder and scratch space; it cannot read
 * the GitHub login or the check's settings, nor write the live checkout or
 * data/bot-cmd.json) - and everything with an effect goes through here,
 * where its words cannot reach: shipping a fix (the check's own repository,
 * its own test run, its own push), restarting, and the bot commands.
 *
 * It never sends anything to WhatsApp. The only things it asks the running
 * bot are its health and, for the session, a queue's state or a re-run of a
 * request the scanner marked re-runnable; the only things it changes on the
 * box are data/hourly-debug/, its own state directory and, through the fixes
 * it ships, main.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scan, parseLog, headline, freshMemory, configCheckDue, UPLOAD_COPY_NAME } from '../src/core/incident-scan.js';
import { restartAdvice } from '../src/core/hourly-policy.js';
import { readTranscript } from '../src/core/beta-transcript.js';
import { readLibraryNews, newsSettings } from '../src/core/library-news.js';
import { checkNowDue, readCheckNow, takeAsks, askKey, checkNowFile, keeperIssueTest } from '../src/core/check-now.js';
import { readDiscordTickets } from '../src/core/discord-watch.js';
import { betaReportSection } from '../src/core/beta-scan.js';
import {
  hourlyDir, runDir as runDirFor, runIdFor, readMemory, writeMemory, appendRun, readRuns,
  writeJson, writeText, readOwnFile, readOwnJson, sanitize, sanitizeDeep, fallbackReport, restartParagraph, restartWords, pruneRunDirs,
  NUMBERS_DIR, numberLog, numbersFile, writeNumbers, readNumbers, expandNumbers,
} from '../src/core/hourly-checks.js';
import { withMaskLog, emailReady } from '../src/util/mailer.js';
import { fmtTime } from '../src/core/content-check-health.js';
import { OMDB_RETRY_SPAN_MS } from '../src/plugins/movie-requests/omdb.js';

/** "10-07-2026, 15:00 EDT": the hourly email's subject stamp, New York time,
    on the 24-hour clock (the operator's rule). */
export function subjectStamp(t) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
  }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return `${p.month}-${p.day}-${p.year}, ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN = 60_000;

/* ------------------------------ settings ----------------------------- */

const on = (v, dflt = true) => (v == null || v === '' ? dflt : !/^(0|false|no|off)$/i.test(String(v).trim()));

/**
 * Everything a run needs to know about the box, from the environment
 * deploy/hourly-debug/run.sh sets up. Absolute paths throughout: cron's
 * environment has almost nothing in it.
 */
export function settings(env = process.env) {
  const home = env.HOME || os.homedir();
  const appDir = path.resolve(env.HOURLY_DEBUG_APP_DIR || ROOT);
  const stateDir = path.resolve(env.HOURLY_DEBUG_STATE_DIR || path.join(home, '.local', 'share', 'whatsapp-bot-debug'));
  return {
    appDir,
    dataDir: path.resolve(env.HOURLY_DEBUG_DATA_DIR || env.DATA_DIR || path.join(appDir, 'data')),
    stateDir,
    // The session's working copy, made afresh from trustedDir every run.
    cloneDir: path.join(stateDir, 'repo'),
    // The check's own repository: bare, fetched from GitHub, pushed from,
    // and never writable by the session. Git run in a repository runs that
    // repository's hooks and config - which, in the session's clone, the
    // session wrote.
    trustedDir: path.join(stateDir, 'trusted.git'),
    // Where a fix is tested before it is pushed: a worktree of trustedDir.
    verifyDir: path.join(stateDir, 'verify'),
    // The test suites' dependencies, installed from main's lockfile.
    depsDir: path.join(stateDir, 'deps'),
    // HOME and TMPDIR inside the sandbox: Claude Code's own settings, npm's
    // cache, scratch files. Not /tmp, where other sessions keep scripts they
    // run later.
    homeDir: path.join(stateDir, 'home'),
    tmpDir: path.join(stateDir, 'tmp'),
    unit: env.HOURLY_DEBUG_UNIT || 'whatsapp-bot',
    // Where the bot's Baileys writes its upload copies: its os.tmpdir(). The
    // unit sets no TMPDIR, and run.sh may set one for this process, so it is
    // not this process's own.
    botTmpDir: path.resolve(env.HOURLY_DEBUG_BOT_TMPDIR || '/tmp'),
    systemctl: env.HOURLY_DEBUG_SYSTEMCTL || '/usr/bin/systemctl',
    python: env.HOURLY_DEBUG_PYTHON || '/usr/bin/python3',
    sandboxScript: path.join(appDir, 'deploy', 'hourly-debug', 'sandbox.py'),
    // Off: no_new_privs only, no Landlock - for a kernel without it, by the
    // operator's choice. The session cannot change this: it cannot write the
    // settings file.
    fsSandbox: on(env.HOURLY_DEBUG_FS_SANDBOX),
    claudeBin: env.HOURLY_DEBUG_CLAUDE_BIN || path.join(home, '.local', 'bin', 'claude'),
    hasToken: !!(env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY),
    model: env.HOURLY_DEBUG_MODEL || '',
    claudeMinutes: Math.max(5, Math.min(55, Number(env.HOURLY_DEBUG_CLAUDE_TIMEOUT_MIN) || 40)),
    useClaude: on(env.HOURLY_DEBUG_CLAUDE),
    // Off: a fix is pushed to a branch of its own for a person to merge,
    // instead of to main, which deploys it.
    pushToMain: on(env.HOURLY_DEBUG_PUSH),
    restart: on(env.HOURLY_DEBUG_RESTART),
    email: on(env.HOURLY_DEBUG_EMAIL),
    verifyMs: Math.max(30_000, Number(env.HOURLY_DEBUG_VERIFY_SEC || 300) * 1000),
    env,
  };
}

/* ------------------------------ processes ---------------------------- */

/**
 * Run a command; never throws. Output is capped - a model run can be chatty.
 *
 * It runs in a process group of its own, and the time limit ends the whole
 * group: a research session that is stopped leaves no test run, encode probe
 * or shell of its own still going on a box the bot is encoding on.
 */
export function run(cmd, args = [], { cwd, env, input, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: err.message, timedOut: false });
      return;
    }
    CHILD_GROUPS.add(child.pid);
    // Once its output has closed - every process holding it gone, not only
    // the one started.
    child.on('close', () => CHILD_GROUPS.delete(child.pid));
    const cap = 4 * 1024 * 1024;
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', (d) => { if (stdout.length < cap) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < cap) stderr += d; });
    const stop = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
    const timer = setTimeout(() => {
      timedOut = true;
      stop('SIGTERM');
      setTimeout(() => stop('SIGKILL'), 10_000).unref();
    }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr || err.message, timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr, timedOut }); });
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * The process groups run() has started and not yet seen end. Each child is
 * in a group of its own (detached), so when this process is ended from
 * outside - run.sh's `timeout 100m`, a person's Ctrl-C - its children did
 * not go with it: a research session, a test run, npm or a restart carried
 * on with no time limit and no parent, the lock was left, and the next
 * hour's run re-cloned the repository underneath a session still working in
 * it. endRun() stops them all.
 */
const CHILD_GROUPS = new Set();
let releaseLock = null;

/** Stop every child group - SIGTERM, then SIGKILL - and let go of the run's lock. */
export async function endRun({ graceMs = 5000 } = {}) {
  const signal = (sig) => {
    for (const pid of CHILD_GROUPS) {
      try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* gone */ } }
    }
  };
  signal('SIGTERM');
  const until = Date.now() + graceMs;
  while (CHILD_GROUPS.size && Date.now() < until) await sleep(100);
  signal('SIGKILL');
  try { releaseLock?.(); } catch { /* gone */ }
  releaseLock = null;
}

/** How many child groups are running now, for the tests. */
export const childGroups = () => [...CHILD_GROUPS];

/* ------------------------------ the sandbox -------------------------- */

// Read-only for anything sandboxed: the system, and the node and Claude Code
// the check uses (both under ~/.local on bot-box).
const SYSTEM_RO = ['/usr', '/etc', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/opt', '/snap', '/proc', '/sys', '/run', '/var', '/srv', '/mnt', '/media'];

// In the data directory, what research never needs and must never be able
// to send anywhere: the WhatsApp sessions (the number itself), the panel's
// login sessions, the activity backup's clone with its push access, and the
// check's own key to the members' numbers the dossier shows masked
// (hourly-numbers/, src/core/hourly-checks.js NUMBERS_DIR). That key is kept
// apart from data/hourly-debug/, which the session reads, for this reason.
const PRIVATE_DATA = new RegExp(`^(session|sessions|sessions\\.json|activity-backup|${NUMBERS_DIR})$`);

function entries(dir, skip) {
  try { return fs.readdirSync(dir).filter((n) => !skip(n)).map((n) => path.join(dir, n)); } catch { return []; }
}

/**
 * What each sandboxed thing may read (and run) and write. Nothing else in the
 * home directory can be opened: not the GitHub login (~/.config/gh), not the
 * check's settings file with its token, not ~/.ssh, not the operator's own
 * Claude Code history.
 *
 *   session  reads the live checkout and its data - the logs, state.json, and
 *            the settings with .env, which tools/diagnose-library.mjs needs to
 *            look things up the way the bot does - but not the WhatsApp
 *            sessions (PRIVATE_DATA); reads the check's repository; writes
 *            its clone and this run's folder - not data/bot-cmd.json, not the
 *            live checkout, not the check's settings.
 *   suite    the tests the check runs on a fix: the worktree read-only, so a
 *            test cannot leave anything behind for the check's own git.
 *   npm      installs the suites' dependencies, and nothing else.
 */
export function sandboxPaths(s, kind, { runDir = null, dir = null } = {}) {
  const home = s.env.HOME || os.homedir();
  // A tool's own directory, or the tool alone when that directory would be
  // the home directory (or above it): opening one must not open the rest.
  const within = (dir) => dir === home || home.startsWith(`${dir}${path.sep}`);
  const toolPath = (file, up = 1) => {
    let dir = file;
    for (let i = 0; i < up; i++) dir = path.dirname(dir);
    return within(dir) ? file : dir;
  };
  const tools = [path.join(home, '.local'), toolPath(process.execPath, 2)];
  try { tools.push(toolPath(fs.realpathSync(s.claudeBin))); } catch { /* not installed */ }
  const scratch = [s.homeDir, s.tmpDir, '/dev'];
  const hide = hiddenPaths(s, home);
  switch (kind) {
    case 'session': {
      // Landlock only grants: the checkout is given entry by entry, leaving
      // out the data directory, whose entries are given apart from the
      // private ones.
      const app = entries(s.appDir, (n) => path.join(s.appDir, n) === s.dataDir);
      const data = entries(s.dataDir, (n) => PRIVATE_DATA.test(n));
      return { ro: [...SYSTEM_RO, ...tools, s.depsDir, s.trustedDir, ...app, ...data], rw: [...scratch, s.cloneDir, runDir].filter(Boolean), hide };
    }
    case 'suite':
      return { ro: [...SYSTEM_RO, ...tools, s.depsDir, dir].filter(Boolean), rw: scratch, hide };
    case 'npm':
      return { ro: [...SYSTEM_RO, ...tools], rw: [...scratch, s.depsDir], hide };
    default:
      return { ro: [...SYSTEM_RO, ...tools], rw: scratch, hide };
  }
}

// In the home directory, what holds a login or a key.
const HOME_SECRETS = ['.config/gh', '.config/whatsapp-bot', '.claude', '.claude.json', '.ssh', '.git-credentials', '.config/git/credentials'];

/**
 * What the namespace sandbox (WSL, where the seccomp listener is taken) puts
 * an empty mount over, as well as Landlock leaving it out: the WhatsApp
 * sessions and the rest of PRIVATE_DATA, the GitHub login, the check's own
 * settings with its token, the operator's Claude Code login, SSH keys and git
 * credentials. The listener sandbox ignores these, and Landlock alone keeps
 * them out there. sandbox.py skips the ones that are not there.
 */
function hiddenPaths(s, home) {
  const envFile = s.env.HOURLY_DEBUG_ENV_FILE || path.join(home, '.config', 'whatsapp-bot', 'hourly-debug.env');
  return [...new Set([
    ...entries(s.dataDir, (n) => !PRIVATE_DATA.test(n)),
    ...HOME_SECRETS.map((f) => path.join(home, f)),
    path.dirname(envFile) === home ? envFile : path.dirname(envFile),
  ])];
}

/**
 * A command line that runs `cmd` in the sandbox (deploy/hourly-debug/sandbox.py),
 * below the bot in the scheduler: no_new_privs - sudo, su and every setuid
 * program refuse to work, for it and for everything it starts, which is what
 * keeps a session on a `NOPASSWD: ALL` box away from root - and Landlock,
 * limiting it to `paths`. The bot itself runs with NoNewPrivileges=true.
 */
export function sandboxed(s, cmd, args = [], { ro = [], rw = [], hide = [] } = {}) {
  return [s.python, [
    s.sandboxScript, ...(s.fsSandbox ? [] : ['--no-landlock']),
    ...ro.flatMap((p) => ['--ro', p]), ...rw.flatMap((p) => ['--rw', p]), ...hide.flatMap((p) => ['--hide', p]),
    '--', 'nice', '-n', '15', cmd, ...args,
  ]];
}

/**
 * The environment of anything sandboxed: its own HOME, no git or GitHub
 * credentials, and for the tests no Claude token either. Pushing is this
 * script's job, after it has run the suite itself.
 */
function sandboxEnv(s, extra = {}, { keepToken = false } = {}) {
  const env = { ...s.env, ...extra };
  // NODE_OPTIONS can load code from anywhere (--require, --import); inside
  // the sandbox node starts clean.
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GIT_ASKPASS', 'SSH_AUTH_SOCK', 'HOURLY_DEBUG_ENV_FILE', 'NODE_OPTIONS']) delete env[k];
  if (!keepToken) { delete env.CLAUDE_CODE_OAUTH_TOKEN; delete env.ANTHROPIC_API_KEY; }
  for (const d of [s.homeDir, s.tmpDir]) {
    try { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); } catch { /* the tests run without it */ }
  }
  return {
    ...env,
    HOME: s.homeDir,
    TMPDIR: s.tmpDir,
    TMP: s.tmpDir,
    TEMP: s.tmpDir,
    CLAUDE_CODE_TMPDIR: s.tmpDir,
    // The binary is on the tripwire list; it must not change under a session.
    DISABLE_AUTOUPDATER: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GH_CONFIG_DIR: path.join(s.homeDir, '.config', 'gh'),
  };
}

/**
 * Whether the sandbox can be had here: python3, the script, Landlock unless
 * turned off - and, tried from inside it, that it keeps shut the two doors
 * Landlock does not: a UNIX socket, through which `systemd-run --user` had
 * the user's systemd manager start a unit outside it (and, with NOPASSWD
 * sudo, root), and a signal to a process outside it, the bot included
 * (sandbox.py --probe, given this process's pid). Any of it open, and no
 * session is started.
 */
export async function sandboxProblem(s, exec = run) {
  if (!fs.existsSync(s.python)) return `${s.python} is missing`;
  if (!fs.existsSync(s.sandboxScript)) return `${s.sandboxScript} is missing`;
  if (s.fsSandbox) {
    const r = await exec(s.python, [s.sandboxScript, '--abi'], { timeoutMs: 15_000 });
    const abi = Number(String(r.stdout).trim());
    if (!(r.code === 0 && abi >= 1)) return 'this kernel has no Landlock (HOURLY_DEBUG_FS_SANDBOX=0 in the settings file runs the session with no_new_privs only)';
  }
  const p = await exec(s.python, [s.sandboxScript, '--probe', String(process.pid)], { timeoutMs: 15_000 });
  const said = String(p.stdout ?? '').trim().split('\n').pop();
  if (said !== 'closed') {
    return `the sandbox leaves ${said && p.code === 0 ? said : `its doors untested (${String(p.stderr || `exit ${p.code}`).trim().slice(0, 240)})`} open to the session`;
  }
  return null;
}

/**
 * Which of sandbox.py's two ways of keeping the session away from other
 * processes this box gets, in words: the seccomp supervisor, or - on WSL,
 * whose init holds the one seccomp listener a process may have - user, PID
 * and mount namespaces.
 */
export async function sandboxKind(s, exec = run) {
  const r = await exec(s.python, [s.sandboxScript, '--mode'], { timeoutMs: 15_000 });
  const m = String(r.stdout ?? '').trim();
  return m === 'namespaces' ? 'and its own PID and mount namespaces (the seccomp listener is taken here: WSL)'
    : m === 'listener' ? 'signals policed by its seccomp supervisor' : 'its kind not known';
}

/**
 * Tripwires on what runs later outside the sandbox, as this user: the live
 * checkout (the bot's code, and this very script, which cron runs next
 * hour), the check's settings file, the Claude binary, the shell's start-up
 * files, user units. Landlock keeps the session from writing any of them;
 * with it turned off (HOURLY_DEBUG_FS_SANDBOX=0) nothing does, so each is
 * looked at before the session and after it either way, anything that
 * changed in between is an alert, and no restart is made into a live
 * checkout that changed, since a restart would run it.
 */
export async function outsideSnapshot(s, exec = run) {
  const home = s.env.HOME || os.homedir();
  const envFile = s.env.HOURLY_DEBUG_ENV_FILE || path.join(home, '.config', 'whatsapp-bot', 'hourly-debug.env');
  let claude = s.claudeBin;
  try { claude = fs.realpathSync(s.claudeBin); } catch { /* missing: recorded as such */ }
  const files = [
    envFile, claude,
    ...['.bashrc', '.profile', '.bash_profile', '.bash_login', '.bash_logout', '.gitconfig', '.ssh/authorized_keys',
      '.config/systemd/user', '.config/autostart', '.config/environment.d', '.pam_environment'].map((f) => path.join(home, f)),
  ];
  const stat = {};
  // ctime moves on every change and cannot be set back by the file's owner.
  const mark = (st) => `${st.ino}:${st.ctimeMs}:${st.size}`;
  for (const f of files) {
    try { stat[f] = mark(fs.statSync(f)); } catch { stat[f] = 'missing'; }
  }
  // The launcher link itself too: pointing it at something else is enough.
  // (Claude Code updating itself moves it as well, which is why the session
  // runs with its updater off.)
  try { stat[`${s.claudeBin} (link)`] = mark(fs.lstatSync(s.claudeBin)); } catch { stat[`${s.claudeBin} (link)`] = 'missing'; }
  const g = await exec('git', ['--no-optional-locks', '-C', s.appDir, 'status', '--porcelain', '--untracked-files=normal'], { timeoutMs: 30_000 });
  return { stat, live: g.code === 0 ? g.stdout.split('\n').filter(Boolean) : null };
}

/** What changed between two snapshots, in words; the live checkout's files apart. */
export function outsideChanges(before, after) {
  if (!before || !after) return { files: [], live: [] };
  const files = Object.keys(after.stat).filter((f) => before.stat[f] !== undefined && before.stat[f] !== after.stat[f]);
  const was = new Set(before.live ?? []);
  const live = (after.live ?? []).filter((l) => !was.has(l)).map((l) => l.slice(3));
  return { files: [...new Set(files)], live };
}

/* ------------------------------ the inputs --------------------------- */

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** A list read from a file the session could write: anything else is none. */
const listOf = (v) => (Array.isArray(v) ? v : []);

/**
 * data/state.json, read while the bot is writing it. Its saves are atomic,
 * but its shutdown flush is not, so a read that lands in one is tried again.
 */
async function readState(dataDir, wait = sleep) {
  for (let i = 0; i < 3; i++) {
    try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')); } catch { await wait(700); }
  }
  return {};
}

/** Today's and yesterday's debug log, every part, gzipped or not, oldest first. */
export function readLogLines(dataDir, now = Date.now()) {
  const dir = path.join(dataDir, 'logs');
  const days = [new Date(now - 86_400_000), new Date(now)].map((d) => d.toISOString().slice(0, 10));
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const FILE = /^debug-(\d{4}-\d\d-\d\d)(?:\.(\d+))?\.log(\.gz)?$/;
  const pick = names
    .map((n) => ({ n, m: FILE.exec(n) }))
    .filter((x) => x.m && days.includes(x.m[1]))
    .sort((a, b) => a.m[1].localeCompare(b.m[1]) || Number(a.m[2] ?? 0) - Number(b.m[2] ?? 0));
  let text = '';
  for (const { n } of pick) {
    try {
      let buf = fs.readFileSync(path.join(dir, n));
      if (n.endsWith('.gz')) buf = zlib.gunzipSync(buf);
      text += buf.toString('utf8');
      if (!text.endsWith('\n')) text += '\n';
    } catch { /* a file rotated away mid-read is simply not there */ }
  }
  return parseLog(text);
}

/** The end of today's log, for watching a restart come back. */
function tailLines(dataDir, now = Date.now(), bytes = 256 * 1024) {
  const file = path.join(dataDir, 'logs', `debug-${new Date(now).toISOString().slice(0, 10)}.log`);
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return parseLog(buf.toString('utf8').replace(/^[^\n]*\n/, ''));
  } catch { return []; }
}

function groupNames(dataDir) {
  const snap = readJson(path.join(dataDir, 'backups', 'descriptions-latest.json'), null);
  return Object.fromEntries((snap?.groups ?? []).filter((g) => g?.jid).map((g) => [g.jid, g.subject ?? g.jid]));
}

/**
 * The groups the bot's WhatsApp account is in, for the once-a-day settings
 * check: asked of the bot (dump-groups, a read of its own group list, no
 * WhatsApp call) when it is connected, else the group snapshot the panel's
 * description backup writes, if it is less than two days old. Null when
 * neither can say - an empty list would make every group look left.
 */
export async function botGroups(s, { health = null, ask = botCommand, dryRun = false, now = Date.now() } = {}) {
  if (!dryRun && health?.connection?.state === 'connected') {
    const r = await ask(s.dataDir, { op: 'dump-groups' }, { timeoutMs: 20_000 });
    const jids = Array.isArray(r?.groups) ? r.groups.map((g) => g?.jid).filter(Boolean) : [];
    if (jids.length) return { at: Number(r.at) || now, jids, from: 'bot' };
  }
  const snap = readJson(path.join(s.dataDir, 'backups', 'descriptions-latest.json'), null);
  const jids = (snap?.groups ?? []).map((g) => g?.jid).filter(Boolean);
  const at = Number(snap?.at);
  return jids.length && Number.isFinite(at) && now - at < 2 * 86_400_000 ? { at, jids, from: 'snapshot' } : null;
}

/**
 * The disk as the scanner needs it (incident-scan.js diskFindings): free
 * space where the bot works, in the temp directory where Baileys copies each
 * upload, and those copies. Reads only; a figure it cannot get is left out.
 */
export function diskState(s, config = {}) {
  const workDir = path.resolve(String(config?.media?.workDir || '').trim() || path.join(s.dataDir, 'media'));
  const tmpDir = s.botTmpDir ?? '/tmp';
  const out = { workDir, tmpDir, uploadCopies: [] };
  const space = (dir) => {
    try {
      const st = fs.statfsSync(dir);
      return { free: st.bavail * st.bsize, size: st.blocks * st.bsize };
    } catch { return null; }
  };
  const w = space(workDir);
  if (w) Object.assign(out, w);
  const t = space(tmpDir);
  if (t) out.tmpFree = t.free;
  try { out.sameFs = fs.statSync(workDir).dev === fs.statSync(tmpDir).dev; } catch { /* unknown */ }
  let names = [];
  try { names = fs.readdirSync(tmpDir); } catch { /* none to list */ }
  for (const name of names) {
    if (!UPLOAD_COPY_NAME.test(name)) continue;
    try {
      const st = fs.lstatSync(path.join(tmpDir, name));
      if (st.isFile()) out.uploadCopies.push({ name, bytes: st.size, mtimeMs: st.mtimeMs });
    } catch { /* gone meanwhile */ }
  }
  return out;
}

/** `systemctl show` for the unit, as an object. Needs no privileges. */
export async function unitState(s, exec = run) {
  const r = await exec(s.systemctl, ['show', '-p', 'ActiveState,SubState,NRestarts,MainPID,ActiveEnterTimestamp,ExecMainStartTimestamp', s.unit], { timeoutMs: 15_000 });
  if (r.code !== 0) return null;
  return Object.fromEntries(r.stdout.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

/**
 * Ask the running bot something through its local command file (index.js
 * polls data/bot-cmd.json every 3 seconds). Read-only ops only from here.
 * Waits for somebody else's pending command rather than overwriting it, and
 * takes its own back if the bot never picked it up - a stale file would
 * otherwise run the moment the bot next starts.
 *
 * The answer is the one to this command: it carries the command's `ref`
 * back (answerFor, admin-commands.js). The bot runs one command at a time,
 * and one that outlasts its asker's wait answers late; matched by op and time
 * alone, a re-run still waiting out OMDb's retries was read as the answer to
 * the check's next re-run, which was then reported as queuing the earlier
 * film (found in review, 2026-10-12). A bot started before answers carried
 * a ref is matched as before.
 */
export async function botCommand(dataDir, cmd, { timeoutMs = 20_000, wait = sleep, now = Date.now, raw = false } = {}) {
  const file = path.join(dataDir, 'bot-cmd.json');
  const result = path.join(dataDir, 'bot-cmd.result.json');
  for (let i = 0; fs.existsSync(file); i++) {
    if (i >= 10) return null;
    await wait(1500);
  }
  const sentAt = now();
  const ref = crypto.randomUUID();
  const body = JSON.stringify({ ...cmd, by: 'hourly check', ref });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
  const deadline = sentAt + timeoutMs;
  while (now() < deadline) {
    await wait(1000);
    const r = readJson(result, null);
    // `raw`: a refusal comes back as it is, with the bot's reason.
    if (r && r.op === cmd.op && Number(r.at) >= sentAt && (r.ref ?? ref) === ref) return r.ok === false && !raw ? null : r;
  }
  try { if (fs.readFileSync(file, 'utf8') === body) fs.unlinkSync(file); } catch { /* the bot took it after all */ }
  return null;
}

/* ------------------------------ readiness ---------------------------- */

/** What this box can do right now: model, sudo, email. Asks, changes nothing. */
export async function readiness(s, exec = run) {
  let claude;
  if (!s.useClaude) claude = 'off';
  else if (!fs.existsSync(s.claudeBin)) claude = `not installed at ${s.claudeBin}`;
  else if (!s.hasToken) claude = 'no token - run `claude setup-token` and put it in ~/.config/whatsapp-bot/hourly-debug.env';
  else {
    // Fail closed: the session is never started outside its sandbox.
    const why = await sandboxProblem(s, exec);
    claude = why ? `not run: no sandbox - ${why}` : 'ready';
  }
  // -l asks whether this exact command would be allowed, without running it
  // and without prompting. It answers for a narrow rule that allows only
  // this restart as well as for full sudo.
  const sudo = (await exec('sudo', ['-n', '-l', s.systemctl, 'restart', s.unit], { timeoutMs: 10_000 })).code === 0;
  const cfg = readJson(path.join(s.dataDir, 'config.json'), {});
  // Switched on with no account to send through is off: email is on by
  // default since 2026-10-12, and a box with no address would otherwise
  // fail the report's email every hour (emailReady in src/util/mailer.js).
  return { claude, sudo, email: emailReady(cfg?.email) && s.email };
}

/**
 * What else this account could reach root with. The session cannot use sudo
 * (no_new_privs), but Landlock does not govern connecting to a unix socket,
 * so membership of the lxd group - root through LXD's socket, which Ubuntu's
 * lxd-installer answers on first use - is a door left open to it. Full
 * passwordless sudo is a risk for everything run outside the sandbox. For
 * --status and the installer; not asked every hour, since each sudo -l is a
 * line in auth.log.
 */
export async function privilegeWarnings(exec = run) {
  const out = [];
  const l = await exec('sudo', ['-n', '-l'], { timeoutMs: 10_000 });
  if (l.code === 0 && /NOPASSWD:\s*ALL\b/.test(l.stdout)) {
    out.push('this account has passwordless sudo for everything (NOPASSWD: ALL). The research session cannot use it (no_new_privs), '
      + 'but narrowing it to the one restart rule the installer prints is safer - docs/operations.md, "The hourly check".');
  }
  const g = await exec('id', ['-nG'], { timeoutMs: 5000 });
  if (g.code === 0 && /\blxd\b/.test(g.stdout)) {
    out.push('this account is in the lxd group, which is root by another door that no_new_privs does not close. '
      + 'If LXD is not used here: sudo gpasswd -d $USER lxd');
  }
  return out;
}

/* ------------------------------ the config --------------------------- */

/**
 * The bot's own settings, decrypted the bot's own way - through ConfigStore,
 * with MASTER_KEY read from .env as src/index.js reads it. Read-only: load()
 * saves when it has to fill in a missing value, and this must never write the
 * bot's config, so saving is switched off.
 */
export async function loadBotConfig(appDir, dataDir) {
  let key = '';
  try { key = fs.readFileSync(path.join(appDir, '.env'), 'utf8').match(/^MASTER_KEY=(.+)$/m)?.[1]?.trim() ?? ''; } catch { /* none */ }
  if (!key) return { config: null, why: 'no MASTER_KEY in .env' };
  const { ConfigStore } = await import('../src/config/store.js');
  const store = new ConfigStore({ dataDir, masterKey: key });
  store.save = () => store.config;
  try { return { config: store.load(), key }; } catch (err) { return { config: null, why: err.message }; }
}

/**
 * Every secret value the report must not carry. .env's own secrets besides
 * MASTER_KEY are in it too: the research session may read .env (the live
 * checkout is readable to it, and tools/diagnose-library.mjs needs it), and
 * since 2026-09-30 .env holds the Cloudflare tunnel's token, which is the
 * tunnel - whoever has it can serve the panel's hostname (review of the
 * cloudflare-tunnel routine: the scrub knew neither its value nor its shape).
 */
export async function secretsOf(appDir, dataDir, env) {
  const { config, key } = await loadBotConfig(appDir, dataDir);
  const { SECRET_PATHS, getPath } = await import('../src/config/schema.js');
  const vals = config ? SECRET_PATHS.map((p) => getPath(config, p)) : [];
  let dotenv = {};
  try {
    const { parse } = await import('dotenv');
    dotenv = parse(fs.readFileSync(path.join(appDir, '.env'), 'utf8'));
  } catch { /* no .env: nothing more to hide */ }
  const fromEnvFile = ENV_FILE_SECRETS.map((k) => dotenv[k]);
  return { config, secrets: [...vals, key, ...fromEnvFile, env.CLAUDE_CODE_OAUTH_TOKEN, env.ANTHROPIC_API_KEY]
    .filter((v) => typeof v === 'string' && v.length >= 6) };
}
/** The keys of .env whose values are secrets, besides MASTER_KEY. */
export const ENV_FILE_SECRETS = ['CLOUDFLARE_TUNNEL_TOKEN', 'BACKUP_PASSPHRASE'];

/* ------------------------------ the clone ---------------------------- */

const git = (s, args, opts = {}) => run('git', [
  '-c', 'credential.https://github.com.helper=',
  '-c', 'credential.https://github.com.helper=!gh auth git-credential',
  ...args,
], { timeoutMs: 120_000, ...opts, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(opts.env ?? {}) } });

/** https://github.com/owner/repo, from the live checkout's remote, with no credentials. */
async function repoWebUrl(s, exec = git) {
  const r = await exec(s, ['-C', s.appDir, 'remote', 'get-url', 'origin']);
  const url = r.stdout.trim().replace(/(:\/\/)[^/@\s]+@/, '$1');
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(\.git)?$/.exec(url);
  // The clone gets the remote without any credential in it: a token in the
  // live checkout's URL would otherwise be the session's to push with.
  return { remote: url, web: m ? `https://github.com/${m[1]}/${m[2]}` : null };
}

/**
 * Get the run's repositories ready, and return origin/main's sha.
 *
 *   trustedDir  the check's own bare repository: fetched from GitHub, pushed
 *               from, and read-only to the session. Everything the check
 *               decides - what a fix adds, what it touches, what is pushed -
 *               it reads here.
 *   depsDir     the suites' dependencies (linkedom and the rest of the dev
 *               ones), installed in the sandbox from main's lockfile, only
 *               when it changes; linked into the clone and the test worktree.
 *   cloneDir    the session's working copy, deleted and cloned afresh from
 *               trustedDir every run. Git run in a repository runs that
 *               repository's hooks and reads its config, some keys of which
 *               run commands; a clone the last session could write is not
 *               one this script runs git in.
 */
export async function prepareClone(s, exec = git, sh = run) {
  const { remote } = await repoWebUrl(s, exec);
  if (!remote) return { ok: false, why: 'the live checkout has no origin remote' };
  fs.mkdirSync(s.stateDir, { recursive: true, mode: 0o700 });
  const fail = (what, r) => ({ ok: false, why: `${what}: ${sanitize(r.stderr || r.stdout).split('\n').find(Boolean) ?? `exit ${r.code}`}` });
  if (!fs.existsSync(path.join(s.trustedDir, 'HEAD'))) {
    const c = await exec(s, ['clone', '--quiet', '--bare', '--no-tags', '--single-branch', '--branch', 'main', remote, s.trustedDir], { timeoutMs: 600_000 });
    if (c.code !== 0) return fail('clone failed', c);
  }
  for (const args of [
    ['remote', 'set-url', 'origin', remote],
    ['fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/main:refs/heads/main'],
  ]) {
    const r = await exec(s, ['-C', s.trustedDir, ...args], { timeoutMs: 300_000 });
    if (r.code !== 0) return fail(`git ${args[0]} failed`, r);
  }
  const sha = (await exec(s, ['-C', s.trustedDir, 'rev-parse', '--verify', '--quiet', 'refs/heads/main'])).stdout.trim();
  if (!sha) return { ok: false, why: 'origin has no main' };
  // Commits need an author - the check's own (a rebase) and the session's.
  // The last one on main is the owner of the repository.
  const who = {};
  for (const [k, fmt] of [['user.name', '%an'], ['user.email', '%ae']]) {
    who[k] = (await exec(s, ['-C', s.trustedDir, 'log', '-1', `--format=${fmt}`, sha])).stdout.trim();
    if (who[k]) await exec(s, ['-C', s.trustedDir, 'config', k, who[k]]);
  }

  // The suites' dependencies, from main's lockfile, in the sandbox: install
  // scripts are code from the registry.
  const lock = await exec(s, ['-C', s.trustedDir, 'show', `${sha}:package-lock.json`], { timeoutMs: 60_000 });
  const pkg = await exec(s, ['-C', s.trustedDir, 'show', `${sha}:package.json`], { timeoutMs: 60_000 });
  if (pkg.code !== 0) return fail('main has no package.json', pkg);
  const lockHash = crypto.createHash('sha256').update(`${pkg.stdout}\0${lock.code === 0 ? lock.stdout : ''}`).digest('hex');
  const stamp = path.join(s.depsDir, '.installed');
  let have = '';
  try { have = fs.readFileSync(stamp, 'utf8').trim(); } catch { /* never installed */ }
  if (have !== lockHash) {
    fs.rmSync(s.depsDir, { recursive: true, force: true });
    fs.mkdirSync(s.depsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(s.depsDir, 'package.json'), pkg.stdout);
    if (lock.code === 0) fs.writeFileSync(path.join(s.depsDir, 'package-lock.json'), lock.stdout);
    const [cmd, args] = sandboxed(s, 'npm', [lock.code === 0 ? 'ci' : 'install', '--include=dev', '--no-audit', '--no-fund', '--loglevel=error'], sandboxPaths(s, 'npm'));
    const npm = await sh(cmd, args, { cwd: s.depsDir, timeoutMs: 900_000, env: sandboxEnv(s) });
    if (npm.code !== 0) return { ...fail('npm could not install the suites\' dependencies', npm), sha };
    fs.writeFileSync(stamp, lockHash);
  }

  // The session's clone, afresh. rmSync removes a symbolic link the last
  // session left in it, never what the link points to.
  fs.rmSync(s.cloneDir, { recursive: true, force: true });
  const c = await exec(s, ['clone', '--quiet', '--shared', '--no-tags', '--branch', 'main', s.trustedDir, s.cloneDir], { timeoutMs: 300_000 });
  if (c.code !== 0) return fail('clone failed', c);
  for (const [k, v] of Object.entries(who)) if (v) await exec(s, ['-C', s.cloneDir, 'config', k, v]);
  linkModules(s, s.cloneDir);
  return { ok: true, sha };
}

/** node_modules for a checkout: the check's installed dependencies. */
function linkModules(s, dir) {
  const nm = path.join(dir, 'node_modules');
  try { if (!fs.existsSync(nm)) fs.symlinkSync(path.join(s.depsDir, 'node_modules'), nm, 'dir'); } catch { /* suites that need it fail on both sides alike */ }
}

const TRAILER = (runId) => `Hourly-Check: ${runId}`;

/** Commits in from..to, oldest first, each marked with whether it carries this run's trailer. */
async function rangeCommits(s, dir, from, to, runId, web, exec = git) {
  if (!from || !to || from === to) return [];
  const log = await exec(s, ['-C', dir, 'log', '--reverse', '--format=%H%x1f%s%x1f%B%x1e', `${from}..${to}`]);
  if (log.code !== 0) return [];
  return log.stdout.split('\x1e').map((x) => x.trim()).filter(Boolean).map((x) => {
    const [sha, subject, body = ''] = x.split('\x1f');
    return { sha, short: sha.slice(0, 7), subject, url: web ? `${web}/commit/${sha}` : null, mine: body.includes(TRAILER(runId)) };
  });
}

/* ------------------------------ the restart -------------------------- */

// Per run: one restart for the bot's health, two to deploy (a fix, then a
// fix for the fix). More means going round in circles on the live bot.
const RESTART_CAPS = { health: 1, deploy: 2 };
const NO_ATTEMPT = new Set(['needs-sudo', 'off', 'skipped']);

/**
 * Restart the bot and wait for it to come back: running, on the expected
 * commit, connected. Used by a run for the bot's health and after it has
 * shipped a fix - the one privileged thing the check does, so it is the one
 * place it is done, outside the research session's sandbox.
 *
 * `systemctl restart` by a person does not count against the auto-updater's
 * crash-loop rollback (only restarts systemd makes by itself do), which is
 * why the bot is restarted and never made to exit.
 */
export async function restartBot(s, {
  reason = '', expect = null, kind = 'manual', runDir = null, exec = run, now = Date.now, wait = sleep, ask = botCommand,
} = {}) {
  const log = runDir ? path.join(runDir, 'restart.json') : null;
  // The run folder is the session's to write too: read as writeText() writes.
  const done = log ? listOf(readOwnJson(log, [])) : [];
  const record = (r) => {
    const row = { at: now(), kind, reason, expect, ...r };
    if (log) writeJson(log, [...done, row]);
    return row;
  };
  if (!s.restart) return record({ outcome: 'off', detail: 'restarts are turned off (HOURLY_DEBUG_RESTART=0)' });
  const cap = RESTART_CAPS[kind];
  if (cap && done.filter((d) => d.kind === kind && !NO_ATTEMPT.has(d.outcome)).length >= cap) {
    return record({ outcome: 'skipped', detail: `already restarted ${cap === 1 ? 'once' : `${cap} times`} ${kind === 'health' ? 'for the bot\'s health' : 'to deploy'} in this run` });
  }
  const allowed = await exec('sudo', ['-n', '-l', s.systemctl, 'restart', s.unit], { timeoutMs: 10_000 });
  if (allowed.code !== 0) {
    return record({ outcome: 'needs-sudo', detail: `no passwordless sudo for "systemctl restart ${s.unit}" - see docs/operations.md, "The hourly check"` });
  }
  const before = await unitState(s, exec);
  if (before?.ActiveState && before.ActiveState !== 'active') {
    return record({ outcome: 'skipped', detail: `the service is ${before.ActiveState}; somebody stopped it, and this check does not start it` });
  }
  // WhatsApp stopped on purpose, or a second process on the session: the
  // bot connects again on boot, so a restart - even one to deploy a fix -
  // would overrule the first and walk into the second (CLAUDE.md, rule 3).
  const pre = await ask(s.dataDir, { op: 'health' }, { timeoutMs: 15_000 });
  const conn = pre?.connection?.state;
  if (conn === 'stopped' || conn === 'conflict') {
    return record({
      outcome: 'skipped',
      detail: conn === 'stopped'
        ? 'WhatsApp is stopped, and a restart would connect it again - left for a person (a pushed fix goes live at the next start)'
        : 'another process may be holding the WhatsApp session - a restart would fight it for the number',
    });
  }
  const t0 = now();
  const r = await exec('sudo', ['-n', s.systemctl, 'restart', s.unit], { timeoutMs: 25 * MIN });
  if (r.code !== 0) return record({ outcome: 'failed', detail: sanitize(r.stderr || r.stdout).split('\n')[0] || `exit ${r.code}` });

  let unit = null, au = null, connected = false, crashed = false;
  const deadline = t0 + s.verifyMs;
  while (now() < deadline) {
    await wait(5000);
    unit = await unitState(s, exec);
    au = readJson(path.join(s.dataDir, 'auto-update.json'), null);
    const updaterRan = Date.parse(au?.checkedAt ?? '') >= t0 - 2000;
    connected = tailLines(s.dataDir, now()).some((l) => l.ts >= t0 && l.scope === 'bot' && /^state -> connected/.test(l.msg));
    crashed = Number(unit?.NRestarts) > Number(before?.NRestarts ?? unit?.NRestarts);
    if (crashed) break;
    if (unit?.ActiveState === 'active' && unit.MainPID !== before?.MainPID && updaterRan && connected) break;
  }
  const head = (await exec('git', ['-C', s.appDir, 'rev-parse', 'HEAD'], { timeoutMs: 10_000 })).stdout.trim() || null;
  let onExpected = !expect || head === expect;
  if (expect && !onExpected && head) {
    onExpected = (await exec('git', ['-C', s.appDir, 'merge-base', '--is-ancestor', expect, head], { timeoutMs: 10_000 })).code === 0;
  }
  const health = unit?.ActiveState === 'active' ? await ask(s.dataDir, { op: 'health' }, { timeoutMs: 15_000 }) : null;
  const auNow = Date.parse(au?.checkedAt ?? '') >= t0 - 2000 ? au : null;
  const base = { head, autoUpdate: auNow ? { result: auNow.result, reason: sanitize(auNow.reason ?? '').slice(0, 300) } : null, waitedSec: Math.round((now() - t0) / 1000) };

  if (auNow?.result === 'rolled-back') return record({ ...base, outcome: 'rolled-back', detail: base.autoUpdate.reason });
  if (crashed) return record({ ...base, outcome: 'crash-restarting', detail: 'systemd restarted it by itself after the restart - see journalctl -u whatsapp-bot' });
  if (unit?.ActiveState !== 'active') return record({ ...base, outcome: 'down', detail: `systemd says ${unit?.ActiveState ?? 'nothing'}` });
  if (!onExpected) {
    return record({ ...base, outcome: 'not-updated', detail: `running ${head?.slice(0, 7) ?? '?'}, not ${expect.slice(0, 7)}${auNow ? ` - the updater said: ${base.autoUpdate.reason}` : ' - the updater did not run'}` });
  }
  if (!connected && health?.connection?.state !== 'connected') {
    return record({ ...base, outcome: 'not-connected', detail: `running ${head?.slice(0, 7) ?? '?'}; WhatsApp is ${health?.connection?.state ?? 'not connected'} after ${base.waitedSec}s` });
  }
  return record({ ...base, outcome: 'healthy', detail: `running ${head?.slice(0, 7) ?? '?'} and connected` });
}

/* ------------------------------ shipping a fix ----------------------- */

/**
 * What a fix from the research session may not change. The check itself,
 * and its prompt; what runs at every start of the bot (the updater, the
 * unit); what decides whether a change passed (the test runner); the
 * dependencies (no new ones - and the updater installs what the lockfile
 * says); and the house rules every future session starts from. A change to
 * any of these is for a person to make, and a fix that touches one is not
 * pushed, however green its tests. Test suites may be edited, not deleted:
 * deleting a failing one is the cheapest way to a clean run.
 */
export const PROTECTED = [
  /^deploy\//,
  /^tools\/(hourly-debug\.mjs|run-tests\.mjs|bootstrap\.sh|backup-secrets\.mjs|restore-secrets\.mjs|routines\.mjs)$/,
  // The routines registry: what a new session is told to install with --fix,
  // with the user's sudo, on every box. The check's own policy - when it
  // restarts the bot and what it may re-run (hourly-policy.js) - and the bot
  // commands it drives (admin-commands.js: health, queue-status, requeue):
  // a fix may change what the scanner finds, not what the check does next.
  // And when it runs between the hours (check-now.js): a take that lost its
  // way would start the check every minute, or never for Head Admin's #issue.
  /^src\/core\/(hourly-checks|hourly-policy|routines|admin-commands|check-now)\.js$/,
  /^(whatsapp-bot\.service|install\.sh|start\.sh|package\.json|package-lock\.json|CLAUDE\.md|\.gitignore)$/,
  /^\.github\//,
  // The suites that make `npm test` enforce CLAUDE.md's rules 1 and 2 (the
  // ban risks: _bulkPace, the reconnect ceiling, the outbound budget), the
  // beta-first rule, and the check's own guards. "No new failures" is all
  // the push gate asks, so one commit could weaken a guard and break its
  // rule together, and be restarted into.
  /^test\/(pacing|reconnect-loop|outbound-budget|always-locked-sync|routines|hourly-checks|hourly-ship-git|incident-scan|beta|bot-cmd-health-requeue)\.test\.mjs$/,
  // Project settings every later Claude Code session in the live checkout
  // reads - with full sudo - and npm's, which the updater's install reads.
  /^\.claude\//, /^\.mcp\.json$/, /^\.npmrc$/,
];

/** Why these file changes may not be shipped, or null. `changes` is `git diff --name-status` output. */
export function forbiddenChanges(changes) {
  const bad = [];
  for (const line of String(changes ?? '').split('\n').filter(Boolean)) {
    const [status, ...rest] = line.split('\t');
    const file = rest[rest.length - 1] ?? '';
    if (PROTECTED.some((re) => re.test(file))) bad.push(`changes ${file}`);
    else if (/^D/.test(status) && /^test\/.+\.test\.mjs$/.test(file)) bad.push(`deletes the test suite ${file}`);
  }
  return bad.length ? bad : null;
}

/**
 * Run every suite in `dir`, one at a time, each in the sandbox: the suites
 * are code the session wrote. The worktree is read-only to them, so a test
 * cannot leave behind anything the check's own git would then act on.
 * Returns the suites that failed. Run file by file here rather than through
 * tools/run-tests.mjs, which is the session's to read but not to decide with.
 */
export async function runSuites(s, dir, { exec = run, perSuiteMs = 5 * MIN } = {}) {
  let files = [];
  try { files = fs.readdirSync(path.join(dir, 'test')).filter((f) => f.endsWith('.test.mjs')).sort(); } catch { /* none */ }
  const failed = [];
  const why = {};
  for (const f of files) {
    const [cmd, args] = sandboxed(s, process.execPath, [path.join('test', f)], sandboxPaths(s, 'suite', { dir }));
    const r = await exec(cmd, args, { cwd: dir, env: sandboxEnv(s), timeoutMs: perSuiteMs });
    if (r.code === 0) continue;
    failed.push(f);
    why[f] = sanitize(`${r.stdout}\n${r.stderr}`).split('\n').filter((l) => /FAIL|Error|error:/.test(l)).slice(-4).join(' | ').slice(0, 400)
      || (r.timedOut ? 'timed out' : `exit ${r.code}`);
  }
  return { suites: files.length, failed, why };
}

/**
 * The test worktree - a worktree of the check's own repository - at `sha`,
 * clean, with the suites' dependencies. Made again from nothing when it is
 * missing or broken.
 */
async function checkoutVerify(s, sha, exec = git) {
  const fresh = async () => {
    fs.rmSync(s.verifyDir, { recursive: true, force: true });
    await exec(s, ['-C', s.trustedDir, 'worktree', 'prune']);
    const r = await exec(s, ['-C', s.trustedDir, 'worktree', 'add', '--force', '--detach', s.verifyDir, sha]);
    return r.code === 0 ? null : `could not make the test worktree: ${sanitize(r.stderr).split('\n')[0]}`;
  };
  if (!fs.existsSync(path.join(s.verifyDir, '.git'))) {
    const err = await fresh();
    if (err) return err;
  }
  const checkout = ['checkout', '--quiet', '--force', '--detach', sha];
  if ((await exec(s, ['-C', s.verifyDir, ...checkout])).code !== 0) {
    const err = await fresh();
    if (err) return err;
    const r = await exec(s, ['-C', s.verifyDir, ...checkout]);
    if (r.code !== 0) return `git checkout in the test worktree failed: ${sanitize(r.stderr).split('\n')[0]}`;
  }
  const c = await exec(s, ['-C', s.verifyDir, 'clean', '--quiet', '-fdx', '-e', 'node_modules']);
  if (c.code !== 0) return `git clean in the test worktree failed: ${sanitize(c.stderr).split('\n')[0]}`;
  linkModules(s, s.verifyDir);
  return null;
}

/**
 * The session's commits, into the check's repository, under refs/session/.
 * Fetching from a repository runs none of its hooks, and upload-pack reads
 * none of the config keys that run commands from the repository it serves
 * (the one that could, packObjectsHook, is honoured only from the system and
 * user config); the explicit command is belt and braces.
 */
async function takeSessionCommits(s, exec = git) {
  return exec(s, ['-C', s.trustedDir, 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--prune',
    '--upload-pack', 'git -c core.fsmonitor=false -c core.hooksPath=/dev/null upload-pack',
    `file://${s.cloneDir}`, '+refs/heads/*:refs/session/*', '+HEAD:refs/session/HEAD']);
}

/**
 * Ship one fix the session asked for: check it, test it against main, push
 * it, restart into it. Returns what happened, for the session (which waits
 * for it) and for the report.
 *
 * `ctx` carries the run: its id, `before` (origin/main when the run began),
 * the shas this script pushed so far, and the suite results already known.
 * Every git command here runs in the check's own repository or its test
 * worktree, never in the session's clone.
 */
export async function shipFix(s, request, ctx, {
  exec = run, gitExec = git, suites = runSuites, restart = restartBot, ask = botCommand, attempt = 1,
} = {}) {
  const { runId, before, web, runDir } = ctx;
  const refuse = (why, extra = {}) => ({ outcome: 'refused', why, ...extra });
  const g = (dir, args, opts) => gitExec(s, ['-C', dir, ...args], opts);
  const T = s.trustedDir;
  const ref = s.pushToMain ? 'main' : `hourly-check/${runId}`;

  if (ctx.ships.filter((x) => x.outcome === 'shipped').length >= 2) return refuse('two fixes were shipped in this run already; a third is for a person to look at');
  const want = String(request?.commit ?? '').trim();
  if (!/^[0-9a-f]{7,40}$/i.test(want)) return refuse('the request names no commit (write {"commit": "<sha>"})');
  const took = await takeSessionCommits(s, gitExec);
  if (took.code !== 0) return refuse(`could not read the commits from ${s.cloneDir}: ${sanitize(took.stderr).split('\n')[0]}`);
  const sha = (await g(T, ['rev-parse', '--verify', '--quiet', `${want}^{commit}`])).stdout.trim();
  if (!sha) return refuse(`no commit ${want} on a branch of ${s.cloneDir} (commit it, on main or any branch)`);

  const f = await g(T, ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${ref}:refs/heads/${ref}`]);
  let mainNow = (await g(T, ['rev-parse', '--verify', '--quiet', `refs/heads/${ref}`])).stdout.trim();
  if (!mainNow && ref !== 'main') mainNow = before;
  if (f.code !== 0 && ref === 'main') return refuse(`could not fetch origin/main: ${sanitize(f.stderr).split('\n')[0]}`);

  // Commits of this run's that the check did not push: the session got a
  // push out by itself, which it has no login for and was told not to do.
  // Nothing more is shipped in this run, and nothing is restarted into.
  const onMain = await rangeCommits(s, T, before, mainNow, runId, web, gitExec);
  const rogue = onMain.filter((c) => c.mine && !ctx.pushed.has(c.sha));
  if (rogue.length) {
    ctx.rogue = rogue;
    return refuse(`the session pushed ${rogue.map((c) => c.short).join(', ')} to ${ref} itself, which it may not do - nothing more is shipped or restarted into in this run`);
  }

  // What the fix adds on top of main: every commit carries this run's
  // trailer, and none touches what a fix may not.
  const adds = await rangeCommits(s, T, mainNow, sha, runId, web, gitExec);
  if (!adds.length) return refuse(`${sha.slice(0, 7)} adds nothing to ${ref}`);
  if (adds.length > 10) return refuse(`${adds.length} commits - more than one fix`);
  const untagged = adds.filter((c) => !c.mine);
  if (untagged.length) return refuse(`${untagged.map((c) => c.short).join(', ')} ${untagged.length === 1 ? 'does' : 'do'} not end with "${TRAILER(runId)}"`);
  const baseOfFix = (await g(T, ['merge-base', mainNow, sha])).stdout.trim();
  const changes = (await g(T, ['diff', '--name-status', '--no-renames', baseOfFix, sha])).stdout;
  const bad = forbiddenChanges(changes);
  if (bad) return refuse(`a fix may not do this - it is for a person: ${bad.join('; ')}`);

  // The suite, on main as it is now and on the fix on top of it. A fix
  // built on an older main is put on top of the new one first.
  const baseErr = await checkoutVerify(s, mainNow, gitExec);
  if (baseErr) return refuse(baseErr);
  const base = ctx.baselines.get(mainNow) ?? await suites(s, s.verifyDir, { exec });
  ctx.baselines.set(mainNow, base);
  const fixErr = await checkoutVerify(s, sha, gitExec);
  if (fixErr) return refuse(fixErr);
  let candidate = sha;
  if (baseOfFix !== mainNow) {
    const rb = await g(s.verifyDir, ['rebase', '--quiet', '--onto', mainNow, baseOfFix]);
    if (rb.code !== 0) {
      await g(s.verifyDir, ['rebase', '--abort']);
      return refuse(`main moved while the fix was made, and the fix does not go on top of it cleanly: ${sanitize(rb.stderr || rb.stdout).split('\n')[0]}`);
    }
    candidate = (await g(s.verifyDir, ['rev-parse', 'HEAD'])).stdout.trim();
  }
  const after = await suites(s, s.verifyDir, { exec });
  const newFailures = after.failed.filter((x) => !base.failed.includes(x));
  if (newFailures.length) {
    return refuse(`${newFailures.length} suite(s) fail with the fix that pass on ${ref}: ${newFailures.join(', ')}`, {
      newFailures: newFailures.map((x) => ({ suite: x, why: after.why[x] ?? '' })),
    });
  }

  // Push, as a fast-forward only. Refused because main moved meanwhile:
  // once more from the top - fetch, rebase, test - and then give up.
  const push = await g(s.verifyDir, ['push', '--quiet', 'origin', `${candidate}:refs/heads/${ref}`], { timeoutMs: 180_000 });
  if (push.code !== 0) {
    if (attempt < 2 && /reject|non-fast-forward|fetch first|stale/i.test(`${push.stderr}${push.stdout}`)) {
      return shipFix(s, { ...request, commit: sha }, ctx, { exec, gitExec, suites, restart, ask, attempt: attempt + 1 });
    }
    return refuse(`the push was refused: ${sanitize(push.stderr || push.stdout).split('\n').find(Boolean) ?? `exit ${push.code}`}`);
  }
  const shipped = await rangeCommits(s, T, mainNow, candidate, runId, web, gitExec);
  for (const c of shipped) ctx.pushed.add(c.sha);
  // The session's `git fetch origin` (its origin is this repository) now
  // brings the fix back, so its next one builds on it.
  await g(T, ['update-ref', `refs/heads/${ref}`, candidate]);
  // Commits from elsewhere that were on main when this went out: a restart
  // into the fix deploys them too, and the report must say so.
  const others = onMain.filter((c) => !c.mine);
  const result = {
    outcome: 'shipped',
    commit: candidate,
    pushedTo: ref,
    commits: shipped.map(({ sha: h, short, subject, url }) => ({ sha: h, short, subject, url })),
    others: others.map(({ sha: h, short, subject, url }) => ({ sha: h, short, subject, url })),
    tested: { suites: after.suites, failingOnMainToo: base.failed },
    restart: null,
  };
  // Right away, so the fix is live now rather than at some later restart
  // nobody is watching. Not for a branch: nothing is deployed from one. Not
  // into a live checkout that changed under the session: a restart runs it.
  const trip = ctx.outsideBefore ? outsideChanges(ctx.outsideBefore, await outsideSnapshot(s, exec)).live : [];
  if (trip.length) {
    ctx.liveChanged = trip;
    result.restart = {
      outcome: 'skipped', kind: 'deploy', at: Date.now(),
      detail: `the live checkout changed while the session ran (${trip.slice(0, 5).join(', ')}) - a restart would run that; left for a person`,
    };
  } else if (s.pushToMain) {
    result.restart = await restart(s, {
      kind: 'deploy', reason: `deploy ${shipped.map((c) => c.short).join(', ')}${request?.reason ? ` - ${String(request.reason).slice(0, 120)}` : ''}`,
      expect: candidate, runDir, exec, ask,
    });
  }
  return result;
}

// What the session may ask the bot, through the check. Nothing that sends to
// WhatsApp: the bot's command file takes ops that post to groups, which is
// why the session cannot write it itself.
const SESSION_OPS = new Set(['health', 'queue-status', 'requeue', 'repost']);
const MAX_REQUEUES = 5;
// A re-post sends again a file that was sent: only in a run whose findings
// quote WhatsApp's "unusual format" refusal (incident-scan.js UNOPENABLE),
// and no more of them than such findings, at most two a run.
const MAX_REPOSTS = 2;

/*
 * How long a re-run is waited for: the minute it always had, for the
 * library, the rating and the AI check, and OMDb's retries on top. Since
 * 2026-10-12 an OMDb call that meets a failure of the moment tries again for
 * up to OMDB_RETRY_SPAN_MS ("First daughter 2004" got ⚠️ for an outage of
 * under 90 seconds), and a re-run asked for while OMDb was still failing
 * outlasted the 60 seconds, was reported as "the bot did not answer", and
 * held the bot's one-at-a-time command channel past the check's next ask
 * (found in review, 2026-10-12).
 */
export const REQUEUE_WAIT_MS = 60_000 + OMDB_RETRY_SPAN_MS;

/**
 * A bot command the session asked for, if it may have it: read-only ones, and
 * a re-run of a request the scanner marked re-runnable, at most five a run.
 * The bot then applies its own rules (once per request, not a beta row...).
 */
export async function botRequest(s, request, ctx, { ask = botCommand } = {}) {
  const op = String(request?.op ?? '');
  if (!SESSION_OPS.has(op)) return { ok: false, error: `"${op}" is not one the session may send - only ${[...SESSION_OPS].join(', ')}` };
  if (op !== 'requeue' && op !== 'repost') return (await ask(s.dataDir, { op }, { timeoutMs: 30_000 })) ?? { ok: false, error: 'the bot did not answer' };
  if (op === 'repost') return repost(s, request, ctx, ask);
  const plugin = request.plugin === 'tv' ? 'tv' : request.plugin === 'movie' ? 'movie' : null;
  const id = String(request.id ?? '');
  if (!plugin || !id) return { ok: false, error: 'requeue needs "plugin" ("movie" or "tv") and "id"' };
  if (!ctx.rerunnable.has(`${plugin}:${id}`)) return { ok: false, error: `${plugin} request ${id} is not one this run's findings mark re-runnable` };
  if (ctx.requeued >= MAX_REQUEUES) return { ok: false, error: `${MAX_REQUEUES} re-runs in this run already` };
  ctx.requeued += 1;
  const answer = await ask(s.dataDir, { op: 'requeue', plugin, id, by: `hourly check ${ctx.runId}` }, { timeoutMs: REQUEUE_WAIT_MS, raw: true });
  if (!answer) ctx.requeued -= 1;
  // Unanswered is not the same as not done: the bot may still be on it, and
  // it refuses a second re-run of a request it has queued.
  return answer ?? { ok: false, error: `the bot did not answer within ${Math.round(REQUEUE_WAIT_MS / 60_000)} minutes - it may still be re-running it; History shows how it ended` };
}

/**
 * A file members could not open, sent again: the bot's requeue of a "sent"
 * row with `repost` (hourly-policy.js rerunRefusal), once per row as every
 * re-run is. Only in a run that has a finding quoting WhatsApp's refusal, and
 * no more re-posts than such findings (two at most) - the session cannot
 * re-send whatever it likes.
 */
async function repost(s, request, ctx, ask) {
  const plugin = request.plugin === 'tv' ? 'tv' : request.plugin === 'movie' ? 'movie' : null;
  const id = String(request.id ?? '');
  if (!plugin || !id) return { ok: false, error: 'repost needs "plugin" ("movie" or "tv") and "id"' };
  const allowed = Math.min(MAX_REPOSTS, Number(ctx.unopenable ?? 0));
  if (!allowed) return { ok: false, error: 'no finding in this run quotes WhatsApp\'s "unusual format" refusal - nothing sent is re-posted otherwise' };
  if ((ctx.reposted ?? 0) >= allowed) return { ok: false, error: `${allowed} re-post(s) in this run already, one per finding that quotes the refusal` };
  ctx.reposted = (ctx.reposted ?? 0) + 1;
  const answer = await ask(s.dataDir, { op: 'requeue', plugin, id, repost: true, by: `hourly check ${ctx.runId}` }, { timeoutMs: REQUEUE_WAIT_MS, raw: true });
  if (!answer) ctx.reposted -= 1;
  return answer ?? { ok: false, error: `the bot did not answer within ${Math.round(REQUEUE_WAIT_MS / 60_000)} minutes - it may still be re-posting it; History shows how it ended` };
}

/**
 * While the session runs, do what it asks, as it asks: ship a fix
 * (RUN_DIR/ship-request.json, answered in ship-result.json) and pass a bot
 * command on (bot-request.json, answered in bot-result.json). After the
 * session ends, one last look, for a request written in its final seconds.
 */
export async function watchSession(s, ctx, session, { pollMs = 5000, tick = sleep, ship = shipFix, deps = {} } = {}) {
  let ended = false;
  const finished = Promise.resolve(session).then((r) => { ended = true; return r; });
  const takeFile = (name, n) => {
    const file = path.join(ctx.runDir, `${name}-request.json`);
    if (!fs.existsSync(file)) return null;
    const taken = path.join(ctx.runDir, `${name}-request.${n}.json`);
    try { fs.renameSync(file, taken); } catch { return null; }
    // Never through a link the session put there (hourly-checks.js readOwnFile).
    return { request: readOwnJson(taken, null) };
  };
  const take = async () => {
    const shipReq = takeFile('ship', ctx.ships.length + 1);
    if (shipReq) {
      const n = ctx.ships.length + 1;
      const resFile = path.join(ctx.runDir, 'ship-result.json');
      const { request } = shipReq;
      writeJson(resFile, { n, commit: request?.commit ?? null, state: 'working', note: 'testing on main and on the fix, then pushing and restarting - this takes several minutes' });
      let result;
      try {
        result = request ? await ship(s, request, ctx, deps) : { outcome: 'refused', why: 'ship-request.json is not valid JSON' };
      } catch (err) {
        result = { outcome: 'refused', why: `the check failed while shipping: ${sanitize(err.message)}` };
      }
      const row = { n, at: Date.now(), asked: request?.commit ?? null, reason: request?.reason ?? null, ...result };
      ctx.ships.push(row);
      writeJson(resFile, { ...row, state: 'done' });
    }
    const botReq = takeFile('bot', ctx.botCalls.length + 1);
    if (botReq) {
      let answer;
      try {
        answer = botReq.request ? await botRequest(s, botReq.request, ctx, deps) : { ok: false, error: 'bot-request.json is not valid JSON' };
      } catch (err) {
        answer = { ok: false, error: sanitize(err.message) };
      }
      ctx.botCalls.push({ at: Date.now(), op: botReq.request?.op ?? null, id: botReq.request?.id ?? null, ok: answer?.ok !== false, error: answer?.error ?? null });
      writeJson(path.join(ctx.runDir, 'bot-result.json'), { n: ctx.botCalls.length, op: botReq.request?.op ?? null, at: Date.now(), ...answer });
    }
  };
  while (!ended) {
    await Promise.race([finished, tick(pollMs)]);
    await take();
  }
  await take();
  return finished;
}

/* ------------------------------ the model ---------------------------- */

/**
 * Commands the prompt forbids, refused by Claude Code itself as well. A
 * backstop, not the guard: a prefix rule does not cover the same thing run
 * from a script. What actually keeps the session from sudo is no_new_privs
 * (sandboxed()), and from pushing, that it has no credentials and that this
 * script tests and pushes (shipFix()).
 */
export const FORBIDDEN_TOOLS = [
  'Bash(sudo:*)', 'Bash(su:*)',
  // A backstop: the sandbox refuses them already (sandbox.py, seccomp).
  'Bash(systemd-run:*)', 'Bash(systemctl --user:*)', 'Bash(busctl:*)', 'Bash(dbus-send:*)', 'Bash(lxc:*)',
  'Bash(kill:*)', 'Bash(pkill:*)', 'Bash(killall:*)',
  'Bash(git push:*)',
  'Bash(npm install:*)', 'Bash(npm i:*)', 'Bash(npm ci:*)', 'Bash(npm update:*)',
  'Bash(npm start:*)', 'Bash(node src/index.js:*)', 'Bash(./start.sh:*)',
  'Bash(crontab:*)',
];

export function composePrompt(template, vars) {
  return String(template).replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

function healthRestartText(advice, row) {
  if (row) {
    return `The check restarted the bot for its health before this session began (${advice.reasons.join('; ')}): `
      + `${restartWords(row.outcome)}${row.detail ? ` - ${row.detail}` : ''}.`;
  }
  if (advice.advised) return `A restart for the bot's health was advised (${advice.reasons.join('; ')}) but not made.`;
  if (advice.blockedBy.length) return `No restart for the bot's health: ${advice.blockedBy.join('; ')}.`;
  return 'No restart for the bot\'s health was needed.';
}

async function runClaude(s, { runId, runDir, healthRestart, web, exec = run }) {
  const template = fs.readFileSync(path.join(s.appDir, 'deploy', 'hourly-debug', 'prompt.md'), 'utf8');
  const deadline = Date.now() + s.claudeMinutes * MIN;
  const prompt = composePrompt(template, {
    RUN_ID: runId,
    RUN_DIR: runDir,
    APP_DIR: s.appDir,
    DATA_DIR: s.dataDir,
    CLONE_DIR: s.cloneDir,
    STATE_DIR: s.stateDir,
    MINUTES: s.claudeMinutes,
    DEADLINE: new Date(deadline).toISOString(),
    REPO_URL: web ?? '(unknown)',
    PUSH_TARGET: s.pushToMain ? 'main, and restarts the bot into it at once' : `the branch hourly-check/${runId} (pushing to main is turned off on this box, so a fix waits there for the operator to merge, and nothing is restarted)`,
    HEALTH_RESTART: healthRestart,
    UNIT: s.unit,
    PROTECTED_LIST: 'deploy/, tools/hourly-debug.mjs, tools/run-tests.mjs, tools/bootstrap.sh, tools/backup-secrets.mjs, '
      + 'tools/restore-secrets.mjs, tools/routines.mjs, src/core/hourly-checks.js, src/core/routines.js, src/core/check-now.js, whatsapp-bot.service, '
      + 'install.sh, start.sh, package.json, '
      + 'package-lock.json, CLAUDE.md, .gitignore, .github/',
  });
  const args = ['-p', '--permission-mode', 'bypassPermissions', '--output-format', 'json', '--no-session-persistence',
    '--add-dir', s.dataDir, '--add-dir', runDir, ...(s.model ? ['--model', s.model] : []),
    '--disallowedTools', ...FORBIDDEN_TOOLS];
  const t0 = Date.now();
  const [cmd, full] = sandboxed(s, s.claudeBin, args, sandboxPaths(s, 'session', { runDir }));
  const r = await exec(cmd, full, {
    cwd: s.cloneDir,
    input: prompt,
    timeoutMs: s.claudeMinutes * MIN,
    env: sandboxEnv(s, {
      HOURLY_DEBUG_APP_DIR: s.appDir,
      HOURLY_DEBUG_DATA_DIR: s.dataDir,
      HOURLY_DEBUG_STATE_DIR: s.stateDir,
      HOURLY_DEBUG_RUN_DIR: runDir,
      HOURLY_DEBUG_RUN_ID: runId,
    }, { keepToken: true }),
  });
  try { writeText(path.join(runDir, 'claude-output.json'), r.stdout || r.stderr || ''); } catch { /* best effort */ }
  const minutes = Math.round((Date.now() - t0) / MIN);
  if (r.timedOut) return { ran: true, outcome: 'timeout', detail: `stopped after ${s.claudeMinutes} min` };
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* not JSON: an error before the session started */ }
  if (r.code !== 0 || out?.is_error) {
    const why = String(out?.result ?? r.stderr ?? '').split('\n').find(Boolean) ?? `exit ${r.code}`;
    return { ran: true, outcome: 'failed', detail: /auth|login|token|401/i.test(why) ? `not logged in - ${why}` : why.slice(0, 200) };
  }
  return { ran: true, outcome: 'finished', detail: `${minutes} min${out?.num_turns ? `, ${out.num_turns} turns` : ''}` };
}

/* ------------------------------ the run ------------------------------ */

/**
 * One run at a time, for a run started by hand next to cron's (which run.sh
 * already serialises with flock). A lock older than any run can last is
 * ignored, so a reused process id cannot stop the check for good.
 */
function lockRun(dir) {
  const file = path.join(dir, '.lock');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lockHeld(dir)) return null;
  fs.writeFileSync(file, String(process.pid));
  return () => { try { fs.unlinkSync(file); } catch { /* gone */ } };
}

/** Whether another run holds the lock now; reads only. */
function lockHeld(dir) {
  const file = path.join(dir, '.lock');
  try {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    const age = Date.now() - fs.statSync(file).mtimeMs;
    if (pid && pid !== process.pid && age < 2 * 3600_000) { process.kill(pid, 0); return true; }
  } catch { /* no lock, or its process is gone */ }
  return false;
}

/**
 * The asks a run covered (src/core/check-now.js): each library keeper's
 * #issue whose row its scan read, and no other - so a run never takes an
 * ask whose #issue it did not report. It once also took any ask the bot had
 * written before the run began, its row read or not; and a row that reached
 * the bot more than a day late (a phone or a bot offline for a day) was
 * outside the day of news a run reads, so the ask was taken, no finding
 * made, and Head Admin's #issue dropped without a word (found in review,
 * 2026-10-12). The news is now read back to the oldest ask waiting
 * (newsForRun), so every such row is read. One whose row arrived after the
 * scan read the news (an #issue sent at 10:59:59 and written at 11:00:02)
 * stays for the next tick: an extra run, never a lost ask. One no row
 * stands behind is dropped by the next asked tick (askedGate), so none is
 * left over for ever, starting a run every minute.
 */
export function asksCovered(news, t0, keepers = new Set()) {
  const read = keeperIssueTest(news, keepers);
  return (a) => Number(a.at) <= t0 && read(a);
}

/**
 * The library news a run reads: a day back, as always, and further back the
 * rows of the asks waiting (`asks`, check-now.js) - only theirs, so an older
 * #issue already reported is not read again.
 */
export function newsForRun(dataDir, t0, asks = []) {
  const dayBack = t0 - 24 * 60 * MIN;
  const waiting = new Set(asks.map(askKey));
  const since = Math.min(dayBack, ...asks.map((a) => Number(a.at)).filter(Number.isFinite));
  return readLibraryNews(dataDir, { since, until: t0 }).filter((r) => r.at >= dayBack || waiting.has(askKey(r)));
}

/**
 * Whether an asked tick (`run --asked`) runs: 'run', or 'quiet' - not due
 * yet, gone, or nothing in it a library keeper's #issue. Only an ask the
 * check itself finds behind a keeper's #issue row (keeperIssueTest) may
 * start a run; the rest is dropped, with one line, since only something
 * other than the bot can have written it.
 */
export function askedGate(s, t0, { out = console.log, id = runIdFor(t0) } = {}) {
  const f = readCheckNow(s.dataDir);
  if (!f) return 'quiet';
  const config = readJson(path.join(s.dataDir, 'config.json'), {});
  const genuine = keeperIssueTest(readLibraryNews(s.dataDir), newsSettings(config).senders);
  if (f.corrupt || !f.asked.length || !f.asked.every(genuine)) {
    // Taken by rename like any take, so an ask the bot adds in this moment
    // is kept (check-now.js).
    const { taken, corrupt } = takeAsks(s.dataDir, (a) => !genuine(a));
    if (corrupt) out(`${id}: ${checkNowFile(s.dataDir)} did not parse - removed, no run`);
    else if (!f.asked.length) out(`${id}: ${checkNowFile(s.dataDir)} held no ask - removed, no run`);
    if (taken.length) {
      out(`${id}: dropped ${taken.length} request(s) for a check at once naming no library keeper's #issue `
        + `in library-news.jsonl - no run for ${taken.length === 1 ? 'it' : 'them'}`);
    }
  }
  // What is left is the bot's: a run once its settle is over, by the asks'
  // own times - never for an #issue stamped later than now (a clock behind
  // WhatsApp's), which no run could take yet.
  const left = readCheckNow(s.dataDir);
  return left && !left.corrupt && left.notBefore != null && left.notBefore <= t0 ? 'run' : 'quiet';
}

/** "Head Admin's #issue", for the panel's headline and the log. */
export function askedWords(asked = []) {
  const who = [...new Set(asked.map(askerOf))];
  if (!who.length) return 'a check at once';
  if (who.length > 1) return `#issues from ${who.join(' and ')}`;
  return `${who[0]}'s ${asked.length === 1 ? '#issue' : `${asked.length} #issues`}`;
}

/** The keeper's name, or their number for one with no WhatsApp name (masked wherever it is written). */
const askerOf = (a) => (a.name && !/^\+?[0-9 ().-]+$/.test(a.name) ? a.name : a.sender ? `+${a.sender}` : 'a library keeper');

/** The asks as the dossier and the run row carry them: who, when, where, what. Masked by the caller. */
function askedRows(asked = []) {
  return asked.map((a) => ({
    at: new Date(Number(a.at)).toISOString(),
    who: askerOf(a),
    group: a.groupName ?? a.group ?? null,
    text: String(a.text ?? '').slice(0, 300),
  }));
}

const ATTEMPTED = (r) => r && !NO_ATTEMPT.has(r.outcome) && r.outcome !== 'failed';

/**
 * One hourly run. `deps` replace the outside world in tests. `asked`: started
 * by cron's tick between the hours, for the bot's request (check-now.js).
 */
export async function hourlyRun(s, {
  dryRun = false, asked = false, out = console.log, now = Date.now, exec = run, gitExec = git,
  ask = botCommand, mail = null, claude = runClaude, clone = prepareClone, restart = restartBot,
  suites = runSuites, pollMs = 5000, tick = sleep,
} = {}) {
  const t0 = now();
  const id = runIdFor(t0);
  // The tick comes every minute while the request is there. Until it is due,
  // and while another run holds the lock, nothing at all: no file read past
  // these two, no question to the bot, no line in cron.log, no row.
  if (asked && !dryRun && (checkNowDue(s.dataDir, t0) !== 'due' || lockHeld(hourlyDir(s.dataDir)))) {
    return { id, skipped: true, quiet: true };
  }
  // Due: a run only for a library keeper's #issue the check finds itself
  // in library-news.jsonl, not on the request file's word (askedGate).
  if (asked && !dryRun && askedGate(s, t0, { out, id }) !== 'run') return { id, skipped: true, quiet: true };
  // The asks waiting now, whose rows the news is read back to.
  const pending = readCheckNow(s.dataDir);
  const [state, unit] = await Promise.all([readState(s.dataDir), unitState(s, exec)]);
  const memory = readMemory(s.dataDir);
  const config = readJson(path.join(s.dataDir, 'config.json'), {});
  // A dry run writes nothing, not even a question to the bot.
  const health = dryRun ? null : await ask(s.dataDir, { op: 'health' }, {});
  const inputs = {
    now: t0,
    memory,
    state,
    config,
    lines: readLogLines(s.dataDir, t0),
    autoUpdate: readJson(path.join(s.dataDir, 'auto-update.json'), null),
    unit,
    health,
    names: groupNames(s.dataDir),
    disk: diskState(s, config),
    // Only for the once-a-day look at the settings, so the bot is asked for
    // its groups once a day, not every hour.
    groups: configCheckDue(memory?.v === 1 ? memory : null, t0) ? await botGroups(s, { health, ask, dryRun, now: t0 }) : null,
    // The beta groups' conversations (the operator, 2026-09-30: "hourly debug
    // analyze the recent conversations in that group"). A day back: the
    // scanner reports only what happened since its last run, and the older
    // part is the context - the list a number sent since is answering.
    betaEvents: readTranscript(s.dataDir, { since: t0 - 24 * 60 * MIN, until: t0 }),
    // What the library's keepers said (library-news.js); the scan keeps what
    // is new. A day back, and the row of every ask waiting however old, so a
    // run never takes an ask it did not read (asksCovered).
    news: newsForRun(s.dataDir, t0, pending?.asked ?? []),
    // The operator's support tickets with the Jellyfin host, as the Discord
    // reader kept them (discord-watch.js): all of them, since a ticket's
    // earlier messages - the request, with its film and IMDb link - are the
    // evidence for a reply; the scan reports only what was read since it last
    // looked.
    tickets: readDiscordTickets(s.dataDir, { until: t0 }),
  };
  // Every number the scanner masks as it goes (a quoted log line, a row's
  // detail) is noted, as well as those the dossier's own scrub masks below:
  // the key to them is what lets the report name a member to the operator.
  const numbers = numberLog();
  const result = withMaskLog(numbers, () => scan(inputs));
  // Whether to restart is the check's policy (hourly-policy.js, which a fix
  // may not change), asked here with the scanner's findings - not taken on
  // the scanner's word, since a fix may change the scanner.
  result.restart = restartAdvice({
    incidents: result.incidents, notices: result.notices, unit,
    mem: memory?.v === 1 ? memory : {}, now: t0, blockers: result.blockers ?? [],
  });
  // What was only noted, by title, for the panel: an hour that is all clear
  // can still carry the rating digest or a settings note, and a count alone
  // says nothing.
  const noted = result.notices.slice(0, 10).map((n) => sanitize(n.title).slice(0, 300));
  const ready = await readiness(s, exec);

  if (dryRun) {
    const covered = (pending?.asked ?? []).filter(asksCovered(inputs.news, t0, newsSettings(config).senders));
    out(dryRunText({ s, id, result, ready, unit, pending, covered }));
    return { id, result, ready, dryRun: true };
  }

  const unlock = lockRun(hourlyDir(s.dataDir));
  if (!unlock) {
    // An asked run leaves the request for a later minute, without a word:
    // the tick comes every minute.
    if (!asked) out('another hourly check is still running - leaving this hour to it');
    return { id, skipped: true, quiet: asked };
  }
  releaseLock = unlock;
  try {
    const envRow = { claude: ready.claude, sudo: ready.sudo, email: ready.email };
    // The asks this run answers (check-now.js), taken once it holds the
    // lock, on the hour as well as asked for: those its scan covered. The
    // rest stay in the file for the next tick.
    let askedFor = [];
    try {
      askedFor = takeAsks(s.dataDir, asksCovered(inputs.news, t0, newsSettings(inputs.config).senders)).taken;
    } catch (err) {
      // A request this run cannot take would start a run every minute. The
      // #issues of the asks waiting when it began are in this run's scan all
      // the same (newsForRun), so the file goes.
      out(`${id}: could not take the request for a check at once, removed: ${sanitize(err.message)}`);
      try { fs.rmSync(checkNowFile(s.dataDir), { force: true }); } catch { /* said above */ }
    }
    const trigger = asked ? 'asked' : 'hourly';
    const askedShown = askedRows(askedFor);
    const lead = askedFor.length ? `asked: ${askedWords(askedFor)} - ` : '';
    if (asked) out(`${id}: asked for at once - ${askedFor.length ? sanitize(askedWords(askedFor)) : 'nothing left to take, a run all the same'}`);
    // Nothing new: say so for the panel, and stop. No model, no email, and
    // above all no restart - it would cost every encode in progress.
    if (!result.incidents.length && !result.restart.advised) {
      const clear = result.notices.length ? `all clear (${result.notices.length} noted)` : 'all clear';
      appendRun(s.dataDir, {
        id, at: t0, finishedAt: now(), result: 'all-clear', found: 0, notices: result.notices.length, noted,
        headline: sanitize(`${lead}${clear}`), trigger, ...(askedFor.length ? { asked: sanitizeDeep(askedShown) } : {}),
        restart: { outcome: 'not-needed' }, claude: { outcome: 'not-needed' }, env: envRow, hasReport: false,
      });
      writeMemory(s.dataDir, result.memory);
      pruneRunDirs(s.dataDir, { now: t0 });
      out(`${id}: ${sanitize(lead)}${clear}`);
      return { id, result, allClear: true, asked: askedFor };
    }

    const dir = runDirFor(s.dataDir, id);
    const { secrets, config } = await secretsOf(s.appDir, s.dataDir, s.env);
    const dossier = {
      runId: id,
      checkedAt: new Date(t0).toISOString(),
      since: new Date(result.since).toISOString(),
      firstRun: result.firstRun,
      // 'asked': started between the hours for a library keeper's #issue,
      // `asked` saying whose and when (deploy/hourly-debug/prompt.md).
      trigger,
      asked: askedShown,
      process: result.process,
      restartAdvice: result.restart,
      incidents: result.incidents,
      notices: result.notices,
      overflow: result.overflow,
    };
    const masked = sanitizeDeep(dossier, secrets, numbers);
    writeJson(path.join(dir, 'dossier.json'), masked);
    // The key to the masked numbers the dossier shows, for the operator's
    // eyes only (src/core/hourly-checks.js, "members' numbers"): written
    // before the session starts, outside its run folder, where the sandbox
    // gives it no way in (PRIVATE_DATA) - the namespace sandbox can only
    // hide what is already there. Without it, the report reads masked.
    const shown = JSON.stringify(masked);
    try {
      writeNumbers(s.dataDir, id, numbers.map(shown, { secrets }));
    } catch (err) {
      out(`${id}: could not keep the key to the dossier's numbers: ${sanitize(err.message, secrets)}`);
    }

    // "Reboot the bot right away": for its health, before any research - a
    // stuck job or a dead connection is not left for the forty minutes a
    // session can take. The research that follows reads what happened from
    // the logs, which the restart does not touch.
    const healthRow = result.restart.advised
      ? await restart(s, { kind: 'health', reason: result.restart.reasons.join('; '), runDir: dir, exec, ask })
      : null;

    const { web } = await repoWebUrl(s, gitExec);
    let claudeRun = { ran: false, outcome: ready.claude === 'off' ? 'off' : 'not-set-up', detail: ready.claude };
    const ctx = {
      runId: id, runDir: dir, web, before: null, pushed: new Set(), ships: [], baselines: new Map(), rogue: [], outsideBefore: null, liveChanged: [],
      botCalls: [], requeued: 0,
      // What the session may have re-run: only what the scanner marked so.
      rerunnable: new Set([...result.incidents, ...result.notices]
        .flatMap((f) => [f, ...(f.items ?? [])])
        .filter((f) => f.rerunnable && f.request?.id && f.request?.plugin)
        .map((f) => `${f.request.plugin}:${f.request.id}`)),
      // How many findings quote WhatsApp's "unusual format" refusal: as many
      // re-posts as that (repost, above).
      unopenable: [...result.incidents, ...result.notices].filter((f) => f.unopenable).length,
      reposted: 0,
    };
    let outside = { files: [], live: [] };
    if (ready.claude === 'ready') {
      const c = await clone(s, gitExec, exec);
      ctx.before = c.sha ?? null;
      if (c.ok) {
        ctx.outsideBefore = await outsideSnapshot(s, exec);
        const session = claude(s, { runId: id, runDir: dir, healthRestart: healthRestartText(result.restart, healthRow), web, exec });
        claudeRun = await watchSession(s, ctx, session, { pollMs, tick, deps: { exec, gitExec, suites, restart, ask } });
        outside = outsideChanges(ctx.outsideBefore, await outsideSnapshot(s, exec));
      } else {
        claudeRun = { ran: false, outcome: 'failed', detail: c.why };
      }
    }

    // What reached main while the session ran, beyond what this check
    // shipped: the session's own pushes (which it may not make) and
    // everybody else's.
    let finalMain = ctx.before;
    if (ctx.before) {
      const ref = s.pushToMain ? 'main' : `hourly-check/${id}`;
      await gitExec(s, ['-C', s.trustedDir, 'fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${ref}:refs/heads/${ref}`]);
      finalMain = (await gitExec(s, ['-C', s.trustedDir, 'rev-parse', '--verify', '--quiet', `refs/heads/${ref}`])).stdout.trim() || ctx.before;
    }
    const arrived = await rangeCommits(s, s.trustedDir, ctx.before, finalMain, id, web, gitExec);
    const rogue = [...new Map([...ctx.rogue, ...arrived.filter((c) => c.mine && !ctx.pushed.has(c.sha))].map((c) => [c.sha, c])).values()];
    const shippedRows = ctx.ships.filter((x) => x.outcome === 'shipped');
    const shipped = shippedRows.flatMap((x) => x.commits);
    const deployedOthers = new Set(shippedRows.filter((x) => ATTEMPTED(x.restart)).flatMap((x) => x.others.map((c) => c.sha)));
    const others = arrived.filter((c) => !c.mine).map((c) => ({ ...c, deployed: deployedOthers.has(c.sha) }));
    const refused = ctx.ships.filter((x) => x.outcome === 'refused');

    // What the session could write (the run folder), read never through a
    // link, a hard link or a FIFO it put there (hourly-checks.js readOwnFile).
    const restarted = listOf(readOwnJson(path.join(dir, 'restart.json'), []));
    // The restart the panel shows: the last one into a fix (made, or held
    // back and why), else the one for the bot's health.
    const restartRow = [...shippedRows].reverse().find((x) => x.restart)?.restart ?? healthRow ?? null;
    // Remembered so a health restart that did not cure the bot is not
    // repeated every hour (restartAdvice): that would be a reconnect loop.
    const healthRestart = ATTEMPTED(healthRow);
    const aiResult = readOwnJson(path.join(dir, 'result.json'), null);

    const alerts = [];
    const liveChanged = [...new Set([...ctx.liveChanged, ...outside.live])];
    if (liveChanged.length) {
      alerts.push(`The live checkout changed while the research session ran: ${liveChanged.slice(0, 8).join(', ')}. The session may not touch it; `
        + 'the bot and next hour\'s check would run those changes, and the auto-updater will not update past them. Review them: git -C ~/whatsapp-bot status');
    }
    if (outside.files.length) {
      alerts.push(`Files that run outside the research sandbox changed while it ran: ${outside.files.slice(0, 8).join(', ')}. Check that you changed them yourself.`);
    }
    if (rogue.length) {
      alerts.push(`The research session pushed ${rogue.map((c) => c.short).join(', ')} to ${s.pushToMain ? 'main' : 'its branch'} by itself, which it has no credentials for and was told not to do. `
        + 'Nothing was restarted into; review and revert it - it goes live at the next restart otherwise.');
    }

    // The report: the model's, when it wrote one, with what actually
    // happened appended by this script - which checked, rather than took the
    // model's word for it.
    const theirs = readOwnFile(path.join(dir, 'report.md'));
    // Whose #issue the run answered, in New York time like the subject.
    const askedLine = askedFor.length
      ? `${asked ? 'Started at once, outside the hour,' : 'Took the request for a check at once'} for ${askedWords(askedFor)}, written `
        + `${askedFor.map((a) => subjectStamp(a.at)).join('; ')} - top priority, the operator's word (2026-10-12).`
      : null;
    const facts = [
      '', '---', '', '## What the check itself verified', '',
      ...alerts.map((a) => `- **ALERT:** ${a}`),
      ...(askedLine ? [`- ${askedLine}`] : []),
      `- Found: ${headline(result.incidents)}${result.notices.length ? `; also noted ${result.notices.length}` : ''}.`,
      `- Restart for the bot's health: ${restartParagraph(result.restart, healthRow)}`,
      `- Research: ${claudeRun.outcome}${claudeRun.detail ? ` (${claudeRun.detail})` : ''}.`,
      ...(shippedRows.length
        ? shippedRows.map((x) => `- Shipped to ${x.pushedTo} after the whole suite passed on it (${x.tested?.suites ?? '?'} suites, no new failures): `
          + `${x.commits.map((c) => `${c.short} ${c.subject}${c.url ? ` (${c.url})` : ''}`).join('; ')}. `
          + `Restart: ${x.restart ? restartParagraph(null, x.restart) : 'none - nothing is deployed from a branch.'}`)
        : ['- Nothing shipped by this run.']),
      ...refused.map((x) => `- Refused to ship ${x.asked ? String(x.asked).slice(0, 7) : 'a request'}: ${x.why}`),
      ...others.map((c) => (c.deployed
        ? `- Also on main from elsewhere, and deployed by this check's restart: ${c.short} ${c.subject}.`
        : `- Also new on main from elsewhere, not deployed by this check (it goes live at the next restart): ${c.short} ${c.subject}.`)),
    ];
    // The tests, under a heading of their own and with the conversation as
    // the testers saw it, whatever the session wrote: the operator should
    // not have to retype what happened in the testing group.
    const beta = betaReportSection([...result.incidents, ...result.notices]);
    if (beta.length) facts.push('', ...beta);
    const body = theirs
      ? `${theirs.trimEnd()}\n${facts.join('\n')}\n`
      : `${fallbackReport({ id, scanResult: result, claude: claudeRun, healthRestart: healthRow, ships: ctx.ships, others, alerts, asked: askedLine }).trimEnd()}\n`;
    // Every number this scrub masks is noted (`wrote`): one the session
    // copied in from the logs or state.json, which it can read, may mask to a
    // handle the dossier uses for somebody else, and the key must then fill
    // in neither (numberLog().map, `also`).
    const wrote = numberLog();
    const scrub = (t) => sanitize(t, secrets, wrote);
    const report = scrub(body);

    const row = {
      id,
      at: t0,
      result: 'incidents',
      found: result.incidents.length,
      notices: result.notices.length,
      noted: noted.map((n) => scrub(n)),
      headline: scrub(`${lead}${headline(result.incidents)}`),
      trigger,
      ...(askedFor.length ? { asked: sanitizeDeep(askedShown, secrets, wrote) } : {}),
      summary: typeof aiResult?.summary === 'string' ? scrub(aiResult.summary).slice(0, 600) : null,
      claude: { outcome: claudeRun.outcome, detail: claudeRun.detail ?? null },
      commits: shipped.map(({ sha, subject, url }) => ({ sha, subject, url })),
      pushedTo: shipped.length ? (s.pushToMain ? 'main' : `hourly-check/${id}`) : null,
      restart: restartRow ? { outcome: restartRow.outcome, detail: restartRow.detail ?? null, reason: restartRow.reason ?? null } : { outcome: 'not-needed' },
      restarts: restarted.length,
      refused: refused.map((x) => scrub(x.why).slice(0, 300)),
      alerts: alerts.map((a) => scrub(a)),
      reruns: Array.isArray(aiResult?.reruns) ? aiResult.reruns.slice(0, 10).map((x) => scrub(String(x)).slice(0, 200)) : [],
      userActions: Array.isArray(aiResult?.userActions) ? aiResult.userActions.slice(0, 10).map((x) => scrub(String(x)).slice(0, 300)) : [],
      env: envRow,
      hasReport: true,
    };
    // The key again, now that what the session wrote has been scrubbed, and
    // before the report is there to be shown: a handle it collided with is
    // never filled in. A key that cannot be rewritten is removed rather than
    // left to fill in a collision; the report then reads masked.
    try {
      writeNumbers(s.dataDir, id, numbers.map(shown, { also: wrote, secrets }));
    } catch (err) {
      try { fs.rmSync(numbersFile(s.dataDir, id), { force: true }); } catch { /* reported below */ }
      out(`${id}: could not settle the key to the dossier's numbers: ${sanitize(err.message, secrets)}`);
    }
    writeText(path.join(dir, 'report.md'), report);

    // Email the report to the owner, the way the bot's own alerts go.
    row.emailed = 'off';
    if (ready.email && emailReady(config?.email)) {
      // The date and hour, nothing else (the operator, 2026-10-07: "thats it
      // not all that other info in the subject"). The headline, a shipped fix,
      // a restart and an alert are all at the top of the report itself.
      const subject = `WhatsApp Bot — hourly check ${subjectStamp(t0)}`;
      try {
        const send = mail ?? (await import('../src/util/mailer.js')).sendMail;
        // The report as it is on disk, scrubbed, with each member it names by
        // a masked number given in full: it goes to the operator's own
        // address. The subject is left masked - it shows in notifications.
        const text = expandNumbers(report, readNumbers(s.dataDir, id), secrets);
        await send(config.email, { subject: sanitize(subject, secrets), text: `${text}\nThe same report is in the panel: Logs → Hourly checks.\n` });
        row.emailed = true;
      } catch (err) {
        row.emailed = false;
        row.emailError = sanitize(err.message, secrets).slice(0, 200);
      }
    }
    row.finishedAt = now();
    appendRun(s.dataDir, row);
    writeMemory(s.dataDir, { ...result.memory, lastHealthRestartAt: healthRestart ? now() : result.memory.lastHealthRestartAt });
    pruneRunDirs(s.dataDir, { now: t0 });
    out(`${id}: ${row.headline}; research ${claudeRun.outcome}; ${shipped.length} commit(s) shipped; restart ${restartRow?.outcome ?? 'not needed'}; email ${row.emailed}`);
    return { id, result, row };
  } finally {
    unlock();
    releaseLock = null;
  }
}

/* ------------------------------ dry run ------------------------------ */

function dryRunText({ s, id, result, ready, unit, pending = null, covered = [] }) {
  const r = result;
  const p = r.process;
  const L = [];
  L.push(`Hourly check - DRY RUN ${id} (${fmtTime(r.now)})`);
  L.push('Changes nothing: no memory saved, no question to the bot, no model, no restart, no email.');
  L.push(`Data: ${s.dataDir}`);
  L.push(`Looking back to ${fmtTime(r.since)}${r.firstRun ? ' (first run: one day back)' : ''}.`);
  L.push(`Bot: WhatsApp ${p.connection ?? 'unknown'}${p.connectionSince ? ` since ${fmtTime(p.connectionSince)}` : ''}; ${p.runningJobs} job(s) running; `
    + `systemd ${unit?.ActiveState ?? 'unknown'}, ${unit?.NRestarts ?? '?'} automatic restart(s); last deploy: ${p.autoUpdate?.result ?? 'unknown'}.`);
  L.push('');
  L.push(`Found ${r.incidents.length}: ${headline(r.incidents)}`);
  for (const f of r.incidents) {
    L.push(`  ${f.ref} [${f.severity}] ${f.kind}: ${f.title}`);
    if (f.request?.text) L.push(`       asked: ${JSON.stringify(f.request.text)}${f.request.requester ? ` by ${f.request.requester}` : ''}${f.request.group ? ` in ${f.request.group}` : ''}`);
    if (f.request?.detail) L.push(`       detail: ${f.request.detail}`);
    for (const e of (f.evidence ?? []).slice(0, 3)) L.push(`       | ${e}`);
    if (f.items) L.push(`       (${f.items.length} item(s) in the list)`);
    if (f.remedy) L.push(`       remedy: ${f.remedy}`);
  }
  if (r.notices.length) {
    L.push('');
    L.push(`Also noted ${r.notices.length} (listed, not researched on their own):`);
    for (const f of r.notices) {
      L.push(`  ${f.ref} ${f.kind}: ${f.title}`);
      if (f.remedy) L.push(`       remedy: ${f.remedy}`);
    }
  }
  L.push('');
  L.push('Would do:');
  if (pending?.corrupt) {
    L.push(`  - remove ${checkNowFile(s.dataDir)}, which does not parse (the bot writes it whole), and run for nothing in it`);
  } else if (covered.length) {
    L.push(`  - take the request for a check at once, the asks this scan covered: ${sanitize(askedWords(covered))}, `
      + `written ${covered.map((a) => fmtTime(a.at)).join('; ')}${pending.notBefore ? `; due ${fmtTime(pending.notBefore)}` : ''}`);
  }
  const later = (pending?.asked?.length ?? 0) - covered.length;
  if (later > 0) {
    L.push(`  - leave ${later} ask(s) for a check at once in ${checkNowFile(s.dataDir)}: no library keeper's #issue this scan read stands behind them`);
  }
  if (!r.incidents.length && !r.restart.advised) {
    L.push('  - record an "all clear" run for the panel, and stop (no model, no email, no restart)');
  } else {
    L.push(`  - write the dossier to ${path.join(hourlyDir(s.dataDir), 'runs', id)}/`);
    L.push(`  - restart for the bot's health, right away and before any research: ${r.restart.advised ? `yes (${r.restart.reasons.join('; ')})` : r.restart.blockedBy.length ? `no (${r.restart.blockedBy.join('; ')})` : 'no, not needed'}`
      + `${r.restart.advised ? (s.restart ? (ready.sudo ? ` - sudo for systemctl restart ${s.unit}: yes` : ' - BUT there is no passwordless sudo for it, so it would be reported as needed') : ' - turned off') : ''}`);
    L.push(ready.claude === 'ready'
      ? `  - clone origin/main afresh into ${s.cloneDir} and run Claude Code on the dossier in the sandbox - no_new_privs${s.fsSandbox ? ', Landlock' : ''}, no git credentials (limit ${s.claudeMinutes} min); `
        + `a fix it asks to ship is tested by the check against main and pushed to ${s.pushToMain ? 'main, then restarted into at once' : 'a branch'}`
      : `  - NOT run Claude Code: ${ready.claude}; the report lists the findings as they are`);
    L.push(`  - email the report: ${ready.email ? 'yes' : 'no (email is off, or has no account to send through)'}`);
    L.push('  - record the run for the panel (Logs → Hourly checks) and remember these findings as handled');
  }
  return L.join('\n');
}

/* ------------------------------ status ------------------------------ */

async function statusText(s) {
  // Run by hand, this process has not been given the settings file the way
  // run.sh gives it to cron, so a token there is looked for, not loaded.
  const envFile = s.env.HOURLY_DEBUG_ENV_FILE || path.join(s.env.HOME || os.homedir(), '.config', 'whatsapp-bot', 'hourly-debug.env');
  let inFile = false;
  try { inFile = /^\s*(export\s+)?(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=.+/m.test(fs.readFileSync(envFile, 'utf8')); } catch { /* none */ }
  const ready = await readiness({ ...s, hasToken: s.hasToken || inFile });
  const cron = await run('crontab', ['-l'], { timeoutMs: 10_000 });
  // The installer's line names tick.sh and not run.sh (tick.sh says why), an
  // older one run.sh: looking for run.sh alone said "NOT installed" of the
  // line the installer writes now (found in review, 2026-10-12).
  const installed = /deploy\/hourly-debug\/(run|tick)\.sh\b/.test(cron.stdout);
  const runs = readRuns(s.dataDir);
  const last = runs[0];
  const warnings = await privilegeWarnings();
  return [
    `cron entry:  ${!installed ? 'NOT installed (deploy/install-hourly-debug.sh)'
      : /\/deploy\/hourly-debug\/tick\.sh\b/.test(cron.stdout) ? 'installed (a tick every minute: on the hour, and at once for a library keeper\'s #issue)'
        : 'installed, on the hour only - a library keeper\'s #issue waits for it (deploy/install-hourly-debug.sh brings it up to date)'}`,
    `claude:      ${ready.claude}`,
    `sandbox:     ${(await sandboxProblem(s)) ?? `${s.sandboxScript}: no_new_privs${s.fsSandbox ? ' and Landlock' : ' only (Landlock turned off)'}, ${await sandboxKind(s)}`}`,
    `sudo:        ${ready.sudo ? `yes, for systemctl restart ${s.unit}` : 'NO - restarts will be reported as needed, not made'}`,
    `email:       ${ready.email ? 'on' : 'off'}`,
    `pushes to:   ${s.pushToMain ? 'main' : 'a branch per run'}`,
    `last run:    ${last ? `${fmtTime(last.at)} - ${last.headline}` : 'never'}`,
    ...warnings.map((w) => `WARNING:     ${w}`),
  ].join('\n');
}

/* ------------------------------ CLI ---------------------------------- */

async function main(argv) {
  const [cmd, ...rest] = argv;
  const flag = (name) => rest.includes(name);
  const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : null; };
  const s = settings();
  if (opt('--data')) s.dataDir = path.resolve(opt('--data'));
  switch (cmd) {
    case 'run': {
      const r = await hourlyRun(s, { dryRun: flag('--dry-run'), asked: flag('--asked') });
      if (flag('--json') && r.result) console.log(JSON.stringify({ incidents: r.result.incidents, notices: r.result.notices, restart: r.result.restart }, null, 2));
      return 0;
    }
    case 'restart': {
      const row = await restartBot(s, { reason: opt('--reason') ?? 'by hand', expect: opt('--expect'), kind: 'manual' });
      console.log(JSON.stringify(row, null, 2));
      return ['healthy', 'not-connected'].includes(row.outcome) ? 0 : 1;
    }
    case 'status':
      console.log(await statusText(s));
      return 0;
    case 'verify-token': {
      // The installer's proof that a run will work: one word back from
      // Claude, no tools, in the very sandbox a run uses.
      const why = await sandboxProblem(s);
      if (why) { console.log(`no sandbox - ${why}`); return 1; }
      if (!s.hasToken) { console.log('no CLAUDE_CODE_OAUTH_TOKEN'); return 1; }
      const runDir = path.join(s.tmpDir, 'verify-token');
      fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(s.cloneDir, { recursive: true, mode: 0o700 });
      const [c, a] = sandboxed(s, s.claudeBin, ['-p', 'Reply with the single word OK and nothing else.', '--output-format', 'json', '--no-session-persistence', '--tools', ''],
        sandboxPaths(s, 'session', { runDir }));
      const r = await run(c, a, { cwd: s.cloneDir, timeoutMs: 150_000, env: sandboxEnv(s, {}, { keepToken: true }) });
      let out = null;
      try { out = JSON.parse(r.stdout); } catch { /* not JSON */ }
      if (r.code === 0 && out?.is_error === false && /OK/.test(String(out.result ?? ''))) { console.log('ok'); return 0; }
      console.log(sanitize(String(out?.result ?? r.stderr ?? r.stdout ?? `exit ${r.code}`)).split('\n').find(Boolean)?.slice(0, 300) ?? `exit ${r.code}`);
      return 1;
    }
    default:
      console.error('usage: node tools/hourly-debug.mjs run [--dry-run | --asked] [--json] | restart --reason "<why>" [--expect <sha>] | status | verify-token');
      return 2;
  }
}

/**
 * Exit once what was printed has gone. process.exit() straight after a
 * console.log drops what a pipe has not taken yet: `run --json | jq` got 83
 * of 138 KB and did not parse.
 */
export function exitWhenFlushed(code) {
  process.exitCode = code;
  process.stdout.write('', () => process.exit(code));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // Ended from outside (run.sh's timeout, Ctrl-C, a hang-up): the children
  // go too, and the lock is let go (see endRun).
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.once(sig, () => {
      console.error(`hourly check: ${sig} - stopping ${CHILD_GROUPS.size} child process group(s)`);
      endRun().finally(() => process.exit(128 + (os.constants.signals[sig] ?? 15)));
    });
  }
  main(process.argv.slice(2)).then(exitWhenFlushed, (err) => {
    console.error(`hourly check failed: ${err.stack ?? err.message}`);
    exitWhenFlushed(1);
  });
}

export { freshMemory };
