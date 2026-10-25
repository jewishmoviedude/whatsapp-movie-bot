/**
 * yt-dlp and deno on this box, and yt-dlp kept current.
 *
 * Why these two and why this way (the `yt-dlp` routine, src/core/routines.js):
 *
 *   - yt-dlp is the official zipapp release in ~/.local/bin/yt-dlp, mode
 *     755, run by python3 through its own #! line. No root, no pip and no
 *     virtualenv: one file, checked against the SHA-256 the release
 *     publishes, and it carries yt-dlp-ejs, the part that solves YouTube's
 *     JavaScript challenges, inside it (pip's yt-dlp does not, unless asked).
 *   - deno is in ~/.deno/bin/deno, its official release, checked the same
 *     way. yt-dlp needs a JavaScript runtime for YouTube; it supports node
 *     only from 22, and the bot runs on Node 20: tried on 2026-10-11, node
 *     20.18 was "unsupported" and yt-dlp went on without one, warning that
 *     some formats may be missing. With deno 2.9.7 it solved the challenges.
 *
 * Kept current by the bot itself, once a day (YtDlpUpdater, the in-process
 * `yt-dlp-update` routine), not by a cron line: YouTube breaks an old yt-dlp
 * within weeks, and the update must never land under a running download.
 * yt-dlp -U writes the new release over the zipapp in place, while a
 * running yt-dlp is still reading its modules out of that file; only the
 * bot knows when its own yt-dlp is running (media/yt-dlp.js asTheUpdate). So
 * -U is run on a copy beside it, with yt-dlp's own checksum and update-lock
 * checks, and the copy is renamed over the original - whole or not at all -
 * at a moment when nothing here runs it. tools/install-yt-dlp.mjs (bootstrap
 * and `node tools/routines.mjs --fix`) does the same, and will not swap
 * while any yt-dlp process is running on the box.
 *
 * Every check, by either, is written down in ~/.local/state/whatsapp-bot/
 * yt-dlp.json, which the routine reads: the version date is no measure of
 * staleness on its own - stable releases came 84 days apart in 2026 - but a
 * day-old successful check is.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import log from '../util/logger.js';
import { asTheUpdate, ytDlpPaths, versionAtLeast, MIN_DENO } from './yt-dlp.js';

const logger = log.scope('yt-dlp');

export const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
export const YTDLP_SUMS_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS';
export const denoUrl = (arch = os.arch()) => {
  const a = { x64: 'x86_64', arm64: 'aarch64' }[arch];
  if (!a) throw new Error(`deno publishes no Linux build for ${arch}`);
  return `https://github.com/denoland/deno/releases/latest/download/deno-${a}-unknown-linux-gnu.zip`;
};
/** How often the bot updates yt-dlp. */
export const UPDATE_EVERY_MS = 24 * 3600_000;
/** After a failed check, the next one is this far on, not at every hourly tick. */
export const RETRY_FAILED_MS = 6 * 3600_000;
/** What the routine calls stale: three daily checks missed. */
export const STALE_AFTER_MS = 3 * 24 * 3600_000;
/** And a release this old is stale whatever the checks say. */
export const MAX_RELEASE_AGE_DAYS = 120;

/** Run a program (never a shell); { code, stdout, stderr }. */
export function runProgram(cmd, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 << 20, env: { ...process.env, PYTHONUNBUFFERED: '1' } },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : err.code === 'ENOENT' ? 127 : 1) : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? err?.message ?? '') });
      });
  });
}

/* ------------------------------------------------------------ the record */

export function readStamp(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return s && typeof s === 'object' ? s : null;
  } catch { return null; }
}

export function writeStamp(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** yt-dlp's version is its release date: 2026.08.19 -> days since, or null. */
export function releaseAgeDays(version, now = Date.now()) {
  const m = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(String(version ?? ''));
  if (!m) return null;
  return Math.floor((now - Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) / 86_400_000);
}

export async function ytDlpVersion(bin, { run = runProgram } = {}) {
  if (!fs.existsSync(bin)) return null;
  const r = await run(bin, ['--version'], { timeoutMs: 60_000 });
  const v = r.stdout.trim().split('\n')[0];
  return r.code === 0 && /^\d{4}\.\d{2}\.\d{2}/.test(v) ? v : null;
}

export async function denoVersion(bin, { run = runProgram } = {}) {
  if (!fs.existsSync(bin)) return null;
  const r = await run(bin, ['--version'], { timeoutMs: 60_000 });
  return r.code === 0 ? (/^deno (\d+\.\d+\.\d+)/m.exec(r.stdout)?.[1] ?? null) : null;
}

/* --------------------------------------------------------------- fetching */

/**
 * A release file, with curl: what bootstrap fetches everything else with
 * (Claude Code, Tailscale), on the system's certificates - and what the
 * bootstrap tests stub, so that no test ever downloads a release.
 */
async function fetchBytes(url, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-dlp-fetch-'));
  try {
    const file = path.join(dir, 'download');
    const r = await run('curl', ['-fsSL', '--retry', '3', '--connect-timeout', '30', '--max-time', '900', '-o', file, url], { timeoutMs: 960_000 });
    if (r.code !== 0) throw new Error(`could not download ${url}: ${r.stderr.trim().split('\n').pop() || `curl exit ${r.code}`}`);
    if (!fs.existsSync(file)) throw new Error(`could not download ${url}: nothing came`);
    return fs.readFileSync(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The SHA-256 a release's sums file gives for `name`, or null. */
export function sumFor(text, name) {
  for (const line of String(text).split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
    if (m && path.basename(m[2]) === name) return m[1].toLowerCase();
  }
  return null;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Write `bytes` beside `dest`, executable, and check `ok(tmp)` before it takes dest's name. */
async function placeExecutable(dest, bytes, ok) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.new-${process.pid}`);
  try {
    fs.writeFileSync(tmp, bytes, { mode: 0o755 });
    fs.chmodSync(tmp, 0o755);
    await ok(tmp);
    fs.renameSync(tmp, dest);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/* ------------------------------------------------------------- installing */

/** The latest yt-dlp zipapp, checked against the release's SHA2-256SUMS, at `bin`. */
export async function installYtDlp({ bin = ytDlpPaths().bin, run = runProgram } = {}) {
  const sums = (await fetchBytes(YTDLP_SUMS_URL, run)).toString('utf8');
  const want = sumFor(sums, 'yt-dlp');
  if (!want) throw new Error('the yt-dlp release lists no checksum for the zipapp (SHA2-256SUMS)');
  const bytes = await fetchBytes(YTDLP_URL, run);
  if (sha256(bytes) !== want) throw new Error('the yt-dlp download does not match its published SHA-256 - not installed');
  let version = null;
  await placeExecutable(bin, bytes, async (tmp) => {
    version = await ytDlpVersion(tmp, { run });
    if (!version) throw new Error('the downloaded yt-dlp does not run here (is python3 installed?)');
  });
  return version;
}

/** The latest deno for Linux, checked against its .sha256sum, at `bin`, unpacked with python3 (there may be no unzip). */
export async function installDeno({ bin = ytDlpPaths().deno, run = runProgram, arch = os.arch() } = {}) {
  const url = denoUrl(arch);
  const want = sumFor((await fetchBytes(`${url}.sha256sum`, run)).toString('utf8'), path.basename(url));
  if (!want) throw new Error('the deno release lists no checksum for its zip');
  const zip = await fetchBytes(url, run);
  if (sha256(zip) !== want) throw new Error('the deno download does not match its published SHA-256 - not installed');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'deno-install-'));
  try {
    const zipFile = path.join(work, 'deno.zip');
    fs.writeFileSync(zipFile, zip);
    // -I: python3 isolated, so nothing in the working directory or the
    // environment is imported along with zipfile.
    const unzip = await run('python3', ['-I', '-c',
      'import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nopen(sys.argv[2], "wb").write(z.read("deno"))',
      zipFile, path.join(work, 'deno')], { timeoutMs: 120_000 });
    if (unzip.code !== 0) throw new Error(`could not unpack deno: ${unzip.stderr.trim().split('\n').pop()}`);
    let version = null;
    await placeExecutable(bin, fs.readFileSync(path.join(work, 'deno')), async (tmp) => {
      version = await denoVersion(tmp, { run });
      if (!version) throw new Error('the downloaded deno does not run here');
    });
    return version;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * yt-dlp -U, on a copy beside it, the copy renamed over it when it took a
 * new release. Returns { before, after, updated, output }.
 */
export async function updateYtDlp({ bin = ytDlpPaths().bin, run = runProgram } = {}) {
  const before = await ytDlpVersion(bin, { run });
  if (!before) throw new Error(`${bin} is not there or does not run - install it first`);
  const copy = path.join(path.dirname(bin), `.${path.basename(bin)}.update-${process.pid}`);
  try {
    fs.copyFileSync(bin, copy);
    fs.chmodSync(copy, 0o755);
    const r = await run(copy, ['--ignore-config', '--no-plugin-dirs', '-U'], { timeoutMs: 300_000 });
    const output = `${r.stdout}${r.stderr}`.trim().split('\n').filter(Boolean).slice(-4).join(' | ');
    if (r.code !== 0) throw new Error(`yt-dlp -U failed (exit ${r.code}): ${output}`);
    const after = await ytDlpVersion(copy, { run });
    if (!after) throw new Error('the updated yt-dlp does not run - the old one is kept');
    if (after === before) return { before, after, updated: false, output };
    fs.renameSync(copy, bin);
    return { before, after, updated: true, output };
  } finally {
    fs.rmSync(copy, { force: true });
  }
}

/**
 * Everything the routine asks for: yt-dlp and a new-enough deno installed,
 * and yt-dlp updated when `update` is true. `busy()` says whether a yt-dlp
 * is running; then the update is put off and the result says so. Writes the
 * record the routine reads. Returns { ytdlp, deno, installed[], update }.
 */
export async function ensureYtDlp({
  paths = ytDlpPaths(), update = false, busy = () => false, run = runProgram,
  out = () => {}, by = 'tools/install-yt-dlp.mjs', now = () => Date.now(),
} = {}) {
  const installed = [];
  let ytdlp = await ytDlpVersion(paths.bin, { run });
  if (!ytdlp) {
    out(`installing yt-dlp into ${paths.bin}`);
    ytdlp = await installYtDlp({ bin: paths.bin, run });
    installed.push(`yt-dlp ${ytdlp}`);
    // Just fetched from the latest release: that is a check.
    writeStamp(paths.stamp, { at: new Date(now()).toISOString(), ok: true, version: ytdlp, updated: true, by });
  }
  let deno = await denoVersion(paths.deno, { run });
  if (!deno || !versionAtLeast(deno, MIN_DENO)) {
    out(`installing deno into ${paths.deno}${deno ? ` (${deno} is older than the ${MIN_DENO} yt-dlp needs)` : ''}`);
    deno = await installDeno({ bin: paths.deno, run });
    installed.push(`deno ${deno}`);
  }
  let result = null;
  if (update && !installed.some((i) => i.startsWith('yt-dlp'))) {
    if (busy()) {
      result = { skipped: 'a yt-dlp download is running on this box: not swapped under it' };
    } else {
      try {
        result = await updateYtDlp({ bin: paths.bin, run });
        ytdlp = result.after;
        writeStamp(paths.stamp, { at: new Date(now()).toISOString(), ok: true, version: ytdlp, updated: result.updated, by });
      } catch (err) {
        writeStamp(paths.stamp, { at: new Date(now()).toISOString(), ok: false, version: ytdlp, error: err.message.slice(0, 300), by });
        throw err;
      }
    }
  }
  return { ytdlp, deno, installed, update: result };
}

/* ------------------------------------------------------- inside the bot */

/**
 * The daily update, from the bot: every hour it looks at the record, and
 * once the last good check is a day old (six hours after a failed one) it
 * runs the update - unless a yt-dlp is running here, in which case it waits
 * for the next hour. Nothing is installed from here; that is the routine's
 * (`node tools/routines.mjs --fix`), which says so.
 */
export class YtDlpUpdater {
  constructor({ paths = ytDlpPaths(), run = runProgram, everyMs = UPDATE_EVERY_MS, tickMs = 3600_000, firstMs = 10 * 60_000,
    now = () => Date.now(), log: out = logger } = {}) {
    Object.assign(this, { paths, run, everyMs, tickMs, firstMs, now, out });
    this._timer = null;
    this._first = null;
    this._busy = false;
    this._saidMissing = 0;
  }

  start() {
    if (this._timer) return;
    // Not at once: a bot that starts is busy enough, and one crash-looping
    // must not ask GitHub on every start (the record would stop it anyway).
    this._first = setTimeout(() => this.tick(), this.firstMs);
    this._first.unref?.();
    this._timer = setInterval(() => this.tick(), this.tickMs);
    this._timer.unref?.();
  }

  stop() {
    clearTimeout(this._first);
    clearInterval(this._timer);
    this._timer = null;
  }

  /** One look: returns what it did, for the log and the tests. */
  async tick() {
    if (this._busy) return 'busy';
    const stamp = readStamp(this.paths.stamp);
    const at = Date.parse(stamp?.at ?? '');
    const wait = stamp?.ok ? this.everyMs : RETRY_FAILED_MS;
    if (Number.isFinite(at) && this.now() - at < wait) return 'recent';
    if (!fs.existsSync(this.paths.bin)) {
      if (this.now() - this._saidMissing > 24 * 3600_000) {
        this._saidMissing = this.now();
        this.out.warn(`yt-dlp is not installed (${this.paths.bin}): links to video pages are refused until `
          + 'node tools/routines.mjs --fix installs it');
      }
      return 'missing';
    }
    this._busy = true;
    try {
      const r = await asTheUpdate(async () => {
        try {
          const u = await updateYtDlp({ bin: this.paths.bin, run: this.run });
          writeStamp(this.paths.stamp, { at: new Date(this.now()).toISOString(), ok: true, version: u.after, updated: u.updated, by: 'the bot' });
          this.out.info(u.updated ? `yt-dlp updated: ${u.before} -> ${u.after}` : `yt-dlp ${u.after} is the latest`);
          return u.updated ? 'updated' : 'current';
        } catch (err) {
          writeStamp(this.paths.stamp, { at: new Date(this.now()).toISOString(), ok: false, error: err.message.slice(0, 300), by: 'the bot' });
          this.out.warn(`yt-dlp update failed: ${err.message} - the version it has is kept, and it is tried again in 6 h`);
          return 'failed';
        }
      });
      if (r === null) {
        this.out.info('yt-dlp update put off: a yt-dlp download is running - trying again in an hour');
        return 'deferred';
      }
      return r;
    } finally {
      this._busy = false;
    }
  }
}
