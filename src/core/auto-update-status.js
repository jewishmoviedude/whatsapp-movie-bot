/**
 * What deploy/auto-update.sh did before this process started, for the panel.
 *
 * The updater runs as the unit's ExecStartPre=, so it is gone before node
 * starts and cannot report anything itself; it leaves data/auto-update.json
 * behind instead. This reads that file and says whether it describes THIS
 * start. That matters because a box whose installed unit predates the
 * updater still has the script (it came with the pull) but never runs it,
 * and a status file left by some earlier start would otherwise read as
 * "updates are working" on a box that has quietly stopped taking them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// The updater stamps its file when it finishes, and node starts right after.
// A dependency install can make that run long, but the stamp is still taken
// at its end, so a few minutes is ample slack either side of "just before".
const BEFORE_START_MS = 5 * 60_000;
const AFTER_START_MS = 60_000;

const RESULTS = new Set(['updated', 'up-to-date', 'off', 'skipped', 'failed', 'rolled-back']);
const SHA = /^[0-9a-f]{40}$/;

/** When this process started, in ms since the epoch. */
export function processStartedAt() {
  return Date.now() - Math.round(process.uptime() * 1000);
}

/** A token in a remote URL (https://user:token@host) is never passed on. */
export function scrubUrlCredentials(text) {
  return String(text ?? '').replace(/(:\/\/)[^/@\s]+@/g, '$1***@');
}

/**
 * The commit this process is running, read once at startup: reading HEAD on
 * every request would report a pull made while the process was running as if
 * the code in memory had changed too. null outside a git checkout.
 */
export function runningCommit(dir = process.cwd()) {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return SHA.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * The updater's last outcome, and whether it ran for this start.
 *
 *   null                           - no data directory to look in
 *   { installed: false }           - no status file: the updater has never run here
 *   { installed: true, ... }       - see below
 *
 * `ranThisStart` is false when the file is older than this process by more
 * than the slack above: the updater did not run when the bot last started,
 * which almost always means the installed unit has no ExecStartPre= line.
 */
export function readAutoUpdate(dataDir, { startedAt = processStartedAt() } = {}) {
  if (!dataDir) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'auto-update.json'), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { installed: false };
    return { installed: true, ranThisStart: false, result: 'unreadable', reason: 'data/auto-update.json could not be read' };
  }
  const checked = Date.parse(raw?.checkedAt);
  const sha = (v) => (typeof v === 'string' && SHA.test(v) ? v : null);
  return {
    installed: true,
    ranThisStart: Number.isFinite(checked)
      && checked >= startedAt - BEFORE_START_MS && checked <= startedAt + AFTER_START_MS,
    result: RESULTS.has(raw?.result) ? raw.result : 'unreadable',
    reason: scrubUrlCredentials(raw?.reason).slice(0, 500),
    checkedAt: Number.isFinite(checked) ? new Date(checked).toISOString() : null,
    branch: typeof raw?.branch === 'string' ? raw.branch.slice(0, 200) : '',
    head: sha(raw?.head),
    from: sha(raw?.from),
    to: sha(raw?.to),
    commits: Number.isFinite(raw?.commits) ? raw.commits : 0,
    trial: sha(raw?.trial),
    rejected: sha(raw?.rejected),
  };
}
