/**
 * Room on the disk: whether a job may start, waiting for space rather than
 * failing on it, and knowing a full disk when one breaks a job.
 *
 * bot-box's disk is 29 GB, shared by the work directory, the temp directory
 * Baileys writes its encrypted upload copies to, the logs and the state. Three
 * jobs run at once, and a film holds its source (up to 5.1 GB seen, 3.9 GB at
 * the 99th percentile) until it is converted, its converted file (up to
 * media.maxOutputBytes, 1.8 GB) until it is posted, and a copy of that file in
 * the temp directory while it uploads. Nothing counted any of that before a
 * download started. On 2026-09-28 the disk reached 0 bytes free: "Charlie and
 * the Chocolate Factory" died in ffmpeg (exit 228, 20:34 UTC), "The Parent
 * Trap" in its download (ENOSPC, 21:01), and "Minority Report" uploaded a
 * copy the full disk had cut short for 33 minutes before "Media upload failed
 * on all hosts" (21:07). All three were marked failed - ⚠️ to the requester,
 * and nothing tried them again - although each would have gone through once
 * the jobs ahead of it had finished and freed their files.
 *
 * So a job now asks for room for the whole of itself before its download
 * starts (reserveRoom), counting what the jobs already running have still to
 * write, and waits for them to free it when there is not enough. A job that
 * the disk fills under anyway is retried once there is room (isDiskFull, and
 * RetryBook's `until` in media/resume.js), instead of failing for good.
 *
 * Nothing here deletes anything to make room. The operator, 2026-09-30,
 * after a restart deleted three fully converted films (La La Land's upload
 * was still running, and it started again from the download): "in the
 * future files should remain in their folders until fully sent on whatsapp
 * to avoid this". A job's files - its download included - stay until
 * WhatsApp has taken the file (media/work-files.js). Work kept on the disk
 * for a job that will run again used to be given up, the oldest first, for
 * a new job that did not fit; now the new job waits instead (DISK_HELD): it
 * does not start its download until there is room, and says so in an error
 * line the hourly check reports (incident-scan.js DISK_FULL).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import log from '../util/logger.js';
import { fmtBytes } from './ffmpeg.js';

const logger = log.scope('disk');

/**
 * Kept free beyond what a job itself writes: the logs, state.json and the
 * panel go on writing to the same disk, and a disk filled to the last byte
 * fails them too.
 */
export const SPARE_BYTES = 512 * 1024 ** 2;

/**
 * What a download is assumed to be when Jellyfin has not said. A film's
 * largest source seen on bot-box was 5.1 GB; an episode's is well under 2 GB.
 * Too big an estimate only makes a job wait; too small one fills the disk.
 */
export const UNKNOWN_SOURCE_BYTES = { movie: 6 * 1024 ** 3, tv: 2 * 1024 ** 3 };

/** How often a job waiting for space looks again when nothing in this process has freed any. */
export const POLL_MS = 60_000;

/**
 * Did the disk filling up cause this failure?
 *
 * A write that found no room says ENOSPC (the download, a hard link's copy,
 * the upload's pre-flight check in bot.js). ffmpeg exits with its own error as
 * the status, and -ENOSPC is 228 - with nothing about space in the last lines
 * of its output (Charlie and the Chocolate Factory: "ffmpeg exited 228:
 * drop_frames=0 | speed=2.78x | progress=end"). Our own "not enough disk
 * space" refusal (DISK_TOO_SMALL, see notEnoughRoom) is not: waiting would not
 * change it. The same refusal while a finished file kept for a retry is still
 * to be sent (DISK_WAIT) is: that file goes once it is posted. So is the one
 * while other jobs' work, kept until each is sent, holds the room
 * (DISK_HELD): it goes as they are.
 */
export function isDiskFull(err) {
  if (!err || err.code === 'DISK_TOO_SMALL') return false;
  if (err.code === 'ENOSPC' || err.code === 'DISK_WAIT' || err.code === 'DISK_HELD') return true;
  const m = String(err.message ?? '');
  return /ENOSPC|no space left on device/i.test(m) || /\bffmpeg exited 228\b/.test(m);
}

/*
 * When the disk was last seen full, by anything in this process.
 *
 * Baileys writes its encrypted upload copy with no error handler, so a full
 * disk surfaces as an uncaught ENOSPC (src/index.js) and, much later, as the
 * upload's own "Media upload failed on all hosts" - which says nothing about
 * the disk. bot.sendDocument asks whether the disk filled while it was
 * uploading to tell the two apart (diskFullSince).
 */
let lastFullAt = 0;

export function noteDiskFull(at = Date.now()) {
  if (at > lastFullAt) lastFullAt = at;
}

export function diskFullSince(t) {
  return lastFullAt > 0 && lastFullAt >= t;
}

/** Bytes free to this user on the filesystem holding `dir`, or null when it cannot say. */
export function freeBytes(dir) {
  try {
    const st = fs.statfsSync(dir);
    return st.bavail * st.bsize;
  } catch {
    return null;
  }
}

/**
 * Do `a` and `b` share a filesystem? When either cannot be looked at, they
 * are taken to: counting an upload copy that lands elsewhere only makes a job
 * wait, and not counting one that lands here is how the disk filled.
 */
function sameDisk(a, b) {
  try {
    return fs.statSync(a).dev === fs.statSync(b).dev;
  } catch {
    return true;
  }
}

/**
 * What a job needs free before it starts.
 *
 * Its download (Jellyfin's size when it gave one, UNKNOWN_SOURCE_BYTES when
 * not; nothing for a file read in place), the converted file at its largest
 * (maxOutputBytes - an encode aims just under it whatever the source's size),
 * Baileys' encrypted copy of that file when the temp directory is on the same
 * disk, and SPARE_BYTES.
 *
 * All three are on the disk at once while it uploads: the download is kept
 * until the file has been sent (the operator, 2026-09-30: "files should
 * remain in their folders until fully sent on whatsapp"). It used to be
 * deleted the moment the file was made, and the need was then the larger of
 * source + converted and converted + upload copy; now it is the sum
 * (peakOf). A copy that is a hard link of its source (plan=copy) shares its
 * bytes, so the count is on the safe side there. A segmented encode
 * (media/segmented.js) holds its pieces beside the source and then beside
 * the joined file: see peakOf.
 *
 * `made` is a finished file kept for a retry: all that is left to write is
 * its upload copy. `onDisk` is what the job has on the disk already - a job
 * resumed after a restart (The Parent Trap, 2026-09-29: a 2.62 GB download
 * finished before it) asks only for the room it still has to write.
 */
export function jobNeed({
  workDir, kind = 'movie', sourceBytes = null, download = true, maxOutputBytes = 0, made = null,
  tmpDir = os.tmpdir(), onDisk = 0, segmented = false,
}) {
  const shared = sameDisk(tmpDir, workDir);
  if (made != null) {
    const upload = shared ? Math.max(0, Number(made) || 0) : 0;
    return { source: 0, output: 0, upload, spare: SPARE_BYTES, peak: upload, onDisk: 0, total: upload + SPARE_BYTES, sourceKnown: true };
  }
  const known = Number(sourceBytes) > 0;
  const source = !download ? 0 : known ? Number(sourceBytes) : (UNKNOWN_SOURCE_BYTES[kind] ?? UNKNOWN_SOURCE_BYTES.movie);
  const output = Number(maxOutputBytes) > 0 ? Number(maxOutputBytes) : 2 * 1024 ** 3;
  const upload = shared ? output : 0;
  const peak = peakOf(source, output, upload, { segmented });
  const have = Math.max(0, Number(onDisk) || 0);
  return {
    source, output, upload, spare: SPARE_BYTES, peak, onDisk: have,
    total: Math.max(0, peak - have) + SPARE_BYTES, sourceKnown: known || !download,
  };
}

/**
 * The most a job's own files hold at once - see jobNeed. The source is kept
 * until the file is sent, so it is there throughout. A segmented encode
 * holds its pieces (up to the converted file's size) beside it and, while
 * they are joined, beside the joined file; the pieces go once the joined
 * file is recorded, before the upload's copy is written.
 */
export function peakOf(source, output, upload, { segmented = false } = {}) {
  return source + output + Math.max(segmented ? output : 0, upload);
}

/**
 * "a 4.42 GB download and up to 1.80 GB converted, then 1.80 GB for the
 * upload's copy, 512 MB spare"
 */
export function describeNeed(need) {
  const parts = [];
  const download = need.source ? `${need.sourceKnown ? 'a' : 'an estimated'} ${fmtBytes(need.source)} download` : null;
  const first = [download, need.output ? `up to ${fmtBytes(need.output)} converted` : null].filter(Boolean).join(' and ');
  if (first) parts.push(first);
  if (need.upload) {
    parts.push(`${first ? 'then ' : ''}${fmtBytes(need.upload)} for the upload's copy`);
  }
  if (need.onDisk > 0) parts.push(`${fmtBytes(need.onDisk)} of it on the disk already`);
  parts.push(`${fmtBytes(need.spare)} spare`);
  return parts.join(', ');
}

/*
 * The jobs holding room: each running job that has passed reserveRoom, until
 * it ends. What they hold is on the disk already, and statfs counts it; what
 * they have still to write is not, and is subtracted from what is free for
 * the next one (outstanding). Shared by the movie and TV pipelines, like the
 * stage slots, because they share the disk.
 */
const claims = new Map();                   // key -> claim
const changes = new EventEmitter();
changes.setMaxListeners(0);

/*
 * Work kept for a job that will run again - a booked retry
 * (media/resume.js RetryBook), or a job a restart is resuming - each under
 * its retry's key. Kept work is on the disk until the job runs again, but in
 * between it belongs to no running job, so it held no room, and a job asked
 * for meanwhile found "nothing else in progress that will free more" and was
 * refused for good: "Spaceballs" kept (8.34 GB free on a 10 GB disk),
 * "Minority Report" refused, and moments later Spaceballs was posted and the
 * disk was empty again.
 *
 * Kept work counts, for new work, as a job ahead that has what it still has
 * to write to come and will then free everything (roomFor `withKept`): a
 * finished file its upload copy, anything else the rest of its peak. New
 * work does not wait for it while it holds a place in the queue - the job
 * may be waiting behind it for that very place - but is refused with
 * DISK_WAIT, which the pipelines wait out outside the queue (RetryBook
 * `until`) and try again. A job with kept work of its own never counts
 * another's, so two of them can never wait on each other; they wait on the
 * running jobs, as before.
 *
 * An entry lasts until its directory is gone or forgetKept is called. It
 * used to lapse after six hours, when the hourly sweep deleted kept files
 * too; the sweep keeps every journalled job's work now (work-files.js).
 */
const kept = new Map();                     // key -> { key, dir, jobDir, peak, made, upload, label, at }

/**
 * Note work kept in `jobDir` for the job that will run again under `key`.
 * `made` is the size of a finished file, when it is one: its upload copy is
 * all that is left to write. Otherwise `peak` is the most the job will hold
 * (jobNeed), less what is in `jobDir` already. Taken back by forgetKept, by
 * the job's own reserveRoom (`keptKey`), or by the directory going.
 */
export function keepRoom(key, { dir, jobDir, peak = 0, made = null, label = null, tmpDir = os.tmpdir() }) {
  if (!key || !dir || !jobDir) return;
  const upload = made != null && sameDisk(tmpDir, dir) ? Math.max(0, Number(made) || 0) : 0;
  kept.set(key, {
    key, dir: path.resolve(dir), jobDir: path.resolve(jobDir), peak: Math.max(0, Number(peak) || 0),
    made: made != null, upload, label, at: Date.now(),
  });
  changes.emit('change');
}

/** The work kept under `key` is gone, or nothing will run it again. */
export function forgetKept(key) {
  if (key && kept.delete(key)) changes.emit('change');
}

/**
 * A job's directory has gone (media/work-files.js drop): a job waiting on
 * work held on the disk (heldElsewhere) looks again now, not at its next
 * poll a minute on.
 */
export function roomFreed() {
  changes.emit('change');
}

/** What kept work `k` has still to write. */
function keptOutstanding(k) {
  return k.made ? k.upload : Math.max(0, k.peak - dirBytes(k.jobDir));
}

/** The kept work still waiting to run, in `where`, bar `except`'s. */
function keptIn(where, except = null) {
  const out = [];
  for (const k of [...kept.values()]) {
    if (k.key === except || k.dir !== where) continue;
    // Gone - posted, dropped, swept: no longer anything that will free room.
    if (!fs.existsSync(k.jobDir)) { kept.delete(k.key); continue; }
    out.push(k);
  }
  return out;
}

/*
 * Work on the disk that no running job holds room for: a film parked for the
 * next start (its retries in this process spent), a job resumed after a
 * restart that has not run yet, anything else left there. It frees its room
 * when its job is sent, or finished with for good, and nothing here gives it
 * up for a new job: that job waits (DISK_HELD). Parked work used to be given
 * up, the oldest first, for a job that did not fit - the operator,
 * 2026-09-30: "files should remain in their folders until fully sent".
 *
 * Counted only when a job does not fit with nothing running to free more, to
 * tell one that fits once other work is sent (a wait) from one too big for
 * the disk however empty it is (DISK_TOO_SMALL). `except` is the asker's own
 * job directory; `running` the directories of jobs holding room, which are
 * counted as theirs.
 */
function heldElsewhere(where, { except = null, running = new Set() } = {}) {
  let names = [];
  try { names = fs.readdirSync(where); } catch { return { count: 0, bytes: 0 }; }
  let count = 0;
  let bytes = 0;
  for (const n of names) {
    const p = path.join(where, n);
    if ((except && p === except) || running.has(p)) continue;
    const b = dirBytes(p);
    if (b <= 0) continue;
    count += 1;
    bytes += b;
  }
  return { count, bytes };
}

/** The kept work, for the tests and the panel's curiosity. */
export function keptFiles() {
  return [...kept.values()].map((k) => ({
    key: k.key, label: k.label, dir: k.dir, jobDir: k.jobDir, made: k.made, upload: k.upload, outstanding: keptOutstanding(k),
  }));
}

/**
 * Bytes in `dir` and everything under it, each file once however many
 * names it has there (plan=copy hard-links the converted file to its
 * source), never following a symbolic link. 0 when it is not there.
 */
export function dirBytes(dir) {
  const seen = new Set();
  let total = 0;
  const walk = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      let names = [];
      try { names = fs.readdirSync(p); } catch { return; }
      for (const n of names) walk(path.join(p, n));
      return;
    }
    if (!st.isFile()) return;
    const id = `${st.dev}:${st.ino}`;
    if (seen.has(id)) return;
    seen.add(id);
    total += st.size;
  };
  if (dir) walk(dir);
  return total;
}

/**
 * Bytes a job's files hold on the disk now: everything in its job directory,
 * or, for a claim made with paths, its source and converted file. A converted
 * file that is a hard link of its source (plan=copy) shares its bytes, and is
 * counted once.
 */
function onDisk(c) {
  if (c.jobDir) return dirBytes(c.jobDir);
  const st = (p) => { try { return p ? fs.statSync(p) : null; } catch { return null; } };
  const a = st(c.source.path);
  const b = st(c.out.path);
  if (a && b && a.dev === b.dev && a.ino === b.ino) return a.size;
  return (a?.size ?? 0) + (b?.size ?? 0);
}

/**
 * What a running job has yet to write to the disk: the most it will hold at
 * once (jobNeed's peak) less what it holds already. Once its file is made,
 * all that is left to write is the upload's copy: the source stays until the
 * file is sent, but it is written already.
 */
function outstanding(c) {
  if (c.made) return c.upload;
  return Math.max(0, peakOf(c.source.bytes, c.out.bytes, c.upload, c.shape) - onDisk(c));
}

/**
 * How things stand for a job of `need` bytes wanting to start in `dir`.
 * `others` is how many running jobs hold room there - the ones that will
 * free some as they finish. `available` is null when the filesystem cannot
 * say, and such a job is let through, as it always was.
 *
 * `withKept` counts the work kept for jobs that will run again (see `kept`)
 * as well, bar the one under `keptKey` - the asker's own: what they still
 * have to write is held, and `keptOthers` says how many there are. New work
 * passes it; a job with kept work of its own does not.
 */
export function roomFor(dir, need, { key = null, withKept = false, keptKey = null, jobDir = null } = {}) {
  const want = typeof need === 'number' ? need : need.total;
  const where = path.resolve(dir);
  let held = 0;
  let others = 0;
  const running = new Set();
  const runningDirs = new Set();
  for (const c of claims.values()) {
    if (c.key === key || c.dir !== where) continue;
    others += 1;
    held += outstanding(c);
    if (c.keptKey) running.add(c.keptKey);
    if (c.jobDir) runningDirs.add(c.jobDir);
  }
  let keptOthers = 0;
  let keptUnfinished = 0;
  if (withKept) {
    // Kept work whose job is running is that job's, counted above.
    for (const k of keptIn(where, keptKey)) {
      if (running.has(k.key)) continue;
      keptOthers += 1;
      if (!k.made) keptUnfinished += 1;
      held += keptOutstanding(k);
    }
  }
  const free = freeBytes(dir);
  if (free == null) {
    return { fits: true, free: null, held, others, keptOthers, keptUnfinished, heldOthers: 0, heldBytes: 0, available: null, need: want };
  }
  const available = free - held;
  const fits = available >= want;
  // Other work kept on the disk (heldElsewhere): only worth the walk when the job does not fit.
  const elsewhere = fits ? { count: 0, bytes: 0 }
    : heldElsewhere(where, { except: jobDir ? path.resolve(jobDir) : null, running: runningDirs });
  return {
    fits, free, held, others, keptOthers, keptUnfinished,
    heldOthers: elsewhere.count, heldBytes: elsewhere.bytes, available, need: want,
  };
}

/**
 * Wait until a job of `need` bytes fits in `dir`, or until there is nothing
 * left to wait for.
 *
 * Space comes back when a running job frees its files, which it says (the
 * claims below), and when anything else frees some - an operator clearing
 * old files - which only looking again finds, every `pollMs`. It says once
 * that it is waiting, and once that it has stopped; nothing in between.
 *
 * It stops waiting when no running job holds room: nothing that will finish
 * and free some is left, and waiting on would be for ever. The caller then
 * has `fits: false` to refuse the job with (notEnoughRoom). A job waiting here
 * holds no room itself, so two of them can never wait on each other.
 *
 * `signal` aborts the wait, with a CANCELLED error. `unref` lets a stopping
 * process go while a retry waits (RetryBook); a job in the queue keeps it.
 */
export async function waitForRoom({
  dir, need, key = null, label = 'a job', signal = null, log: out = logger,
  pollMs = POLL_MS, unref = false, onWait = null, withKept = false, waitOnKept = false, keptKey = null,
  waitOnHeld = false, jobDir = null,
} = {}) {
  // `waitOnKept`: kept work (see `kept`) is also worth waiting for. Only
  // outside the queue - RetryBook's `until` - and only for new work, which
  // is what makes it safe: see `kept`. `waitOnHeld`: so is any other work on
  // the disk (heldElsewhere), which frees its room only as each job is sent,
  // perhaps not before the next start. On the same terms - outside the
  // queue, for a job with no work of its own - so no two jobs can wait on
  // each other.
  const look = () => roomFor(dir, need, { key, withKept: withKept || waitOnKept, keptKey, jobDir });
  const ahead = (x) => x.others + (waitOnKept ? x.keptOthers : 0) + (waitOnHeld ? x.heldOthers : 0);
  let r = look();
  if (r.fits || !ahead(r)) return { ...r, waited: false };
  const started = Date.now();
  out.warn(`💾 waiting for disk space for ${label}: it needs ${fmtBytes(r.need)} and ${fmtBytes(Math.max(0, r.available))} `
    + (r.others ? `is free once ${r.others} job(s) in progress have written what they still have to`
      : `is free until the work kept for ${ahead(r)} other job(s) has been sent`));
  onWait?.(r);
  for (;;) {
    await new Promise((resolve, reject) => {
      let timer = null;
      const stop = () => {
        clearTimeout(timer);
        changes.off('change', again);
        signal?.removeEventListener?.('abort', abort);
      };
      const again = () => { stop(); resolve(); };
      const abort = () => { stop(); reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })); };
      if (signal?.aborted) return abort();
      timer = setTimeout(again, pollMs);
      if (unref) timer.unref?.();
      changes.on('change', again);
      signal?.addEventListener?.('abort', abort, { once: true });
    });
    r = look();
    if (r.fits || !ahead(r)) {
      const secs = Math.round((Date.now() - started) / 1000);
      out.info(`💾 ${r.fits ? 'room on the disk' : 'nothing left in progress to free space'} for ${label} after ${secs}s `
        + `(${fmtBytes(Math.max(0, r.available ?? 0))} free)`);
      return { ...r, waited: true };
    }
  }
}

/**
 * The refusal for a job the disk cannot hold with nothing else running.
 * While a finished file kept for a retry is still to be sent
 * (`r.keptOthers`), it is DISK_WAIT, which the pipelines wait out
 * (isDiskFull): that file frees its room once it is posted. While other work
 * kept on the disk would leave room once it is sent (`r.heldBytes`), it is
 * DISK_HELD, waited out too: the job does not start, and nothing is deleted
 * for it. Only a job the disk could not hold with all of that gone as well
 * is DISK_TOO_SMALL, final.
 */
export function notEnoughRoom(label, need, r) {
  const free = fmtBytes(Math.max(0, r.available ?? 0));
  const heldBack = !r.keptOthers && r.heldOthers > 0
    && Math.max(0, r.available ?? 0) + (r.heldBytes ?? 0) >= need.total;
  if (r.keptOthers > 0) {
    const what = r.keptUnfinished
      ? `${r.keptOthers} job(s) whose work is kept for them have finished`
      : `${r.keptOthers} finished file(s) kept for a retry have been sent`;
    return Object.assign(new Error(
      `not enough disk space for ${label} yet: it needs ${fmtBytes(need.total)} (${describeNeed(need)}) and ${free} `
      + `is free until ${what}`,
    ), { code: 'DISK_WAIT' });
  }
  if (heldBack) {
    return Object.assign(new Error(
      `not enough disk space for ${label} yet: it needs ${fmtBytes(need.total)} (${describeNeed(need)}) and ${free} `
      + `is free, with ${fmtBytes(r.heldBytes)} held by the work of ${r.heldOthers} other job(s), kept until each is sent - `
      + 'it waits, and nothing is deleted to make room',
    ), { code: 'DISK_HELD' });
  }
  return Object.assign(new Error(
    `not enough disk space for ${label}: it needs ${fmtBytes(need.total)} (${describeNeed(need)}) `
    + `and only ${free} is free, with nothing else in progress that will free more`,
  ), { code: 'DISK_TOO_SMALL' });
}

/**
 * Hold room for a job that is about to start writing, waiting for it first
 * when there is not enough (waitForRoom). Throws notEnoughRoom when the job
 * cannot fit even once everything else has finished.
 *
 * `made` is the size of a finished file kept for a retry, which only has its
 * upload copy left to write (jobNeed). `jobDir` is the job's own directory
 * (media/work-files.js): what is in it already is on the disk, and counted
 * as the job's, so a job resumed with its download done asks only for the
 * rest. `keptKey` is the key the job's kept work is known by (keepRoom): it
 * is this job's now, and no longer counted apart. Other kept work counts
 * only for a job that has none of its own (see `kept`).
 *
 * Returns the job's claim: made(bytes) once its file is converted - all it
 * has left to write is the upload's copy - and
 * release() when it ends, however it ends. Both tell anyone waiting.
 */
export async function reserveRoom({
  key, label, workDir, kind = 'movie', sourceBytes = null, download = true, maxOutputBytes = 0, made = null,
  source = null, out: outPath = null, signal = null, log: out = logger, onWait = null, pollMs = POLL_MS,
  keptKey = null, jobDir = null, segmented = false,
}) {
  const shape = { segmented };
  const need = () => jobNeed({
    workDir, kind, sourceBytes, download, maxOutputBytes, made, onDisk: jobDir ? dirBytes(jobDir) : 0, ...shape,
  });
  const withKept = made == null && !(keptKey && kept.has(keptKey));
  // Looked at again in the same tick as the claim: two jobs told "it fits"
  // together - a download and a film read in place - would otherwise both
  // take the same room.
  let n = need();
  for (;;) {
    const r = await waitForRoom({ dir: workDir, need: n, key, label, signal, log: out, onWait, pollMs, withKept, keptKey, jobDir });
    // Nothing running will free more. Nothing kept on the disk is given up
    // for it either (heldElsewhere): the refusal says whether it waits.
    if (!r.fits) throw notEnoughRoom(label, n, r);
    n = need();
    if (roomFor(workDir, n, { key, withKept, keptKey, jobDir }).fits) break;
  }
  if (keptKey) kept.delete(keptKey);
  const claim = claimRoom(key, {
    dir: workDir, label, keptKey, jobDir, ...shape,
    source: { path: source, bytes: n.source },
    out: { path: outPath, bytes: n.output },
    upload: n.upload,
  });
  if (made != null) claim.made(made);
  return claim;
}

/** Register a running job's room directly; reserveRoom is the usual way in. */
export function claimRoom(key, {
  dir, label = null, source = {}, out = {}, upload = 0, keptKey = null, jobDir = null, segmented = false,
}) {
  const c = {
    key, label, dir: path.resolve(dir), made: false, upload, keptKey, jobDir: jobDir ? path.resolve(jobDir) : null,
    shape: { segmented },
    source: { path: source.path ?? null, bytes: source.bytes ?? 0 },
    out: { path: out.path ?? null, bytes: out.bytes ?? 0 },
  };
  claims.set(key, c);
  return {
    need: peakOf(c.source.bytes, c.out.bytes, c.upload, c.shape),
    made(bytes) {
      c.made = true;
      // Its upload copy is the size of what was made, not of the largest
      // file it might have been.
      if (c.upload) c.upload = Math.max(0, Number(bytes) || 0);
      changes.emit('change');
    },
    release() {
      if (claims.get(key) !== c) return;
      claims.delete(key);
      changes.emit('change');
    },
  };
}

/** The jobs holding room, for the tests and the panel's curiosity. */
export function heldRoom() {
  return [...claims.values()].map((c) => ({ key: c.key, label: c.label, dir: c.dir, outstanding: outstanding(c), made: c.made }));
}
