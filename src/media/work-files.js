/**
 * Each job's files, in a directory of their own that a restart finds again.
 *
 * The operator, 2026-09-29: "parent trap is already downloaded, if bot gets
 * interrupted it should be able to continue where left off and not need to
 * start over from step 1". The Parent Trap (1998), 2.62 GB, was downloaded
 * 18:42-18:44 UTC and was 23 minutes into its encode when the bot restarted
 * at 19:07. Recovery resumed it - and it downloaded the film again, under a
 * new name, because nothing tied the old files to the job: they were named
 * from the time and the queue's job id, a restarted job gets a new id, and
 * the start-up sweep had already deleted them. A second restart 11 seconds
 * later started it over once more.
 *
 * So a job's files live in `<workDir>/job-<hash of its key>/`, named from a
 * key that does not change across restarts (workKey), beside a manifest that
 * says what each file is, which library file it came from, and how far the
 * job got. The job resumes from the furthest step recorded, once it has
 * checked that the library still holds the same file (verifyIdentity). The
 * sweeps keep every directory a journal still holds (sweepWorkDir), and a
 * job's directory is deleted when the job ends, however it ends, through
 * the caller's guard against deleting anything outside the work directory
 * (CLAUDE.md rule 5).
 *
 * And not before. The operator, 2026-09-30, after the restart that brought
 * these directories in deleted three fully converted films the older build
 * had made (La La Land's upload was still running, and it started again from
 * the download): "in the future files should remain in their folders until
 * fully sent on whatsapp to avoid this". So the download stays beside the
 * file made from it until WhatsApp has taken that file, and nothing is
 * deleted to make room on the disk (media/disk-space.js): the directory goes
 * whole once the job is sent, or cancelled, or failed for good. What is
 * deleted before that is only what cannot be built on - a file the manifest
 * does not refer to (tidy), a segmented encode's pieces once the file joined
 * from them is recorded (media/segmented.js), and work whose library file
 * has changed since (reset).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import log from '../util/logger.js';
import { dirBytes, forgetKept, roomFreed } from './disk-space.js';
import { fmtBytes } from './ffmpeg.js';

const logger = log.scope('work');

/** The manifest's format. A manifest of any other version is treated as empty. */
export const MANIFEST_VERSION = 2;
export const MANIFEST = 'manifest.json';
export const OUTPUT = 'output.mp4';

/* ------------------------------------------------------------ the guard */

/**
 * May `target` be deleted? Only what lies inside the work directory, and
 * never anything under a library root: when Jellyfin's storage is mounted
 * here, a film read in place and its "local copy" can be the same inode.
 *
 * Two more refusals, for the directories a job now has: the work directory
 * itself, which a recursive delete of a job's directory must never become,
 * and any directory holding a library root (a library mounted inside the
 * work directory, which the old flat files never had to think about).
 *
 * When the paths exist, the directory the target is in is looked at as the
 * disk sees it too, so a job directory that has become a symbolic link to
 * somewhere else is never deleted through.
 */
export function isSafeToDeleteIn(target, { workDir, roots = [] } = {}) {
  if (!target || !workDir) return false;
  const resolved = path.resolve(target);
  const work = path.resolve(workDir);
  if (!resolved.startsWith(work + path.sep)) return false;
  const underOrHolds = (p) => {
    for (const root of roots ?? []) {
      if (!root) continue;
      const r = path.resolve(root);
      if (p === r || p.startsWith(r + path.sep) || r.startsWith(p + path.sep)) return true;
    }
    return false;
  };
  if (underOrHolds(resolved)) return false;
  let realWork = null;
  let realParent = null;
  try {
    realWork = fs.realpathSync(work);
    realParent = fs.realpathSync(path.dirname(resolved));
  } catch { /* not on this disk: the paths above decide */ }
  if (realWork && realParent) {
    if (realParent !== realWork && !realParent.startsWith(realWork + path.sep)) return false;
    if (underOrHolds(path.join(realParent, path.basename(resolved)))) return false;
  }
  return true;
}

/* ------------------------------------------------------------- naming */

/** The key a job's files are found by, the same in every process that runs it. */
export const workKey = {
  movie: (jobKey) => `movie:${jobKey}`,
  tv: (reqKey, epId) => `tv:${reqKey}:${epId}`,
};

/** The directory name for a key: from the key alone, so a restarted job finds its own files. */
export function jobDirName(key) {
  return `job-${crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 20)}`;
}

/* -------------------------------------------------- in use, in process */

/*
 * Directories a running job has open (lock), and ones recovery is holding
 * while it takes films out of the journal to put them back (holdWork). The
 * sweeps and every drop spare both.
 */
const busy = new Map();                       // dir name -> token of the handle that holds it
const held = new Set();                       // dir names recovery holds
const vouchedFor = new Map();                 // key -> manifest.createdAt this process checked or wrote

export function holdWork(keys) {
  for (const k of keys ?? []) if (k) held.add(jobDirName(k));
}

export function releaseWork(key) {
  if (key) held.delete(jobDirName(key));
}

/**
 * Forget what this process knows about jobs' work - what it has checked
 * against the library, what is open, what recovery holds - as a new process
 * would. It is how the tests restart the bot without leaving the process.
 */
export function forgetThisProcess() {
  vouchedFor.clear();
  busy.clear();
  held.clear();
}

export function isWorkBusy(name) {
  return busy.has(name) || held.has(name);
}

/* ----------------------------------------------------------- manifests */

function emptyManifest(key, kind, label) {
  const now = Date.now();
  return {
    v: MANIFEST_VERSION, key, kind: kind ?? null, label: label ?? null, createdAt: now, updatedAt: now,
    item: null, source: null, convert: null, output: null, sent: null,
  };
}

/**
 * The manifest in `dir` for `key`, or an empty one. A manifest torn by a
 * kill, of another version, or another key's (two keys can never share a
 * directory, but a hash is only a hash) is nothing this job can build on.
 */
export function readManifest(dir, key, { kind = null, label = null } = {}) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
    if (m && typeof m === 'object' && m.v === MANIFEST_VERSION && m.key === key) return m;
  } catch { /* none, or torn */ }
  return emptyManifest(key, kind, label);
}

/** fsync a directory, so a rename in it outlives a power cut as well as a kill. */
export function fsyncDir(dir) {
  let fd = null;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch { /* not every filesystem lets a directory be synced */ } finally {
    if (fd != null) try { fs.closeSync(fd); } catch { /* closed */ }
  }
}

/** Write `text` to `file` whole or not at all: a temporary file, synced, renamed over it. */
export function writeFileAtomic(file, text) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  fsyncDir(path.dirname(file));
}

/* ------------------------------------------------------------ a job's work */

class JobWork {
  constructor({ workDir, key, kind, label, isSafe, keptKey }) {
    this.workDir = path.resolve(workDir);
    this.key = key;
    this.kind = kind;
    this.label = label;
    this.name = jobDirName(key);
    this.dir = path.join(this.workDir, this.name);
    this.keptKey = keptKey ?? key;
    this.isSafe = typeof isSafe === 'function' ? isSafe : () => false;
    this.token = Symbol(key);
    this._m = null;
  }

  get manifest() {
    this._m ??= readManifest(this.dir, this.key, { kind: this.kind, label: this.label });
    return this._m;
  }

  /** Is anything recorded to build on - at the least, which library file it came from? */
  has() { return !!this.manifest.item; }

  path(name) { return path.join(this.dir, name); }
  sourcePath(ext = '.mkv') { return this.path(`source${ext}`); }
  get outPath() { return this.path(OUTPUT); }
  /** The download in progress, if one is recorded. */
  get partPath() { return this.manifest.source?.name ? this.path(`${this.manifest.source.name}.part`) : null; }
  exists() { try { return fs.lstatSync(this.dir).isDirectory(); } catch { return false; } }
  bytes() { return this.exists() ? dirBytes(this.dir) : 0; }

  /**
   * The directory, made if it is not there. Whatever else is at its name - a
   * file, or a symbolic link that could lead a delete out of the work
   * directory - is removed first, if the guard allows, and never followed.
   */
  ensure() {
    let st = null;
    try { st = fs.lstatSync(this.dir); } catch { /* not there */ }
    if (st && (st.isSymbolicLink() || !st.isDirectory())) {
      if (!this.isSafe(this.dir)) throw new Error(`${this.dir} is not a directory this bot may use`);
      fs.rmSync(this.dir, { force: true });
      st = null;
    }
    if (!st) fs.mkdirSync(this.dir, { recursive: true });
    return this.dir;
  }

  /** One run at a time: a second open of the same job's files in this process is refused. */
  lock() {
    const holder = busy.get(this.name);
    if (holder && holder !== this.token) {
      throw Object.assign(new Error(`the files of ${this.label ?? this.key} are in use by another run`), { code: 'WORK_BUSY' });
    }
    busy.set(this.name, this.token);
    try {
      this.ensure();
    } catch (err) {
      busy.delete(this.name);
      throw err;
    }
    return this;
  }

  release() {
    if (busy.get(this.name) === this.token) busy.delete(this.name);
  }

  get owned() { return busy.get(this.name) === this.token; }
  /** Held by a run other than this handle's: nothing here may delete under it. */
  _heldElsewhere() {
    const holder = busy.get(this.name);
    return !!holder && holder !== this.token;
  }

  /**
   * Merge `patch` into the manifest and write it: a temporary file, synced,
   * renamed over the old one, and the directory synced - so a kill at any
   * moment leaves the old manifest or the new one, never half of either.
   */
  record(patch = {}) {
    this.ensure();
    const m = { ...this.manifest, ...patch, v: MANIFEST_VERSION, key: this.key, updatedAt: Date.now() };
    writeFileAtomic(this.path(MANIFEST), JSON.stringify(m));
    this._m = m;
    return m;
  }

  /** This process has checked, or itself downloaded, the file the work came from. */
  vouch() { vouchedFor.set(this.key, this.manifest.createdAt); }
  vouched() { return this.has() && vouchedFor.get(this.key) === this.manifest.createdAt; }

  /** The names the manifest refers to: everything else in the directory is a leftover. */
  referenced() {
    const m = this.manifest;
    const names = new Set([MANIFEST]);
    if (m.source?.name) { names.add(m.source.name); names.add(`${m.source.name}.part`); }
    // A download yt-dlp is making (media/yt-dlp.js): its streams, and its own
    // partial files, in a folder of their own, which its --continue goes on
    // from after a restart. Named only while the download is not finished.
    if (m.source?.scratch && m.source.state !== 'complete') names.add(m.source.scratch);
    if (m.output?.name) names.add(m.output.name);
    const c = m.convert;
    for (const ch of c?.chunks ?? []) if (ch?.name) names.add(ch.name);
    if (c?.audio?.name) names.add(c.audio.name);
    if (c?.meta) names.add(c.meta);
    return names;
  }

  _remove(name) {
    const p = this.path(name);
    if (!this.isSafe(p)) {
      logger.warn(`not deleting ${p}: the guard says it is not the bot's to delete`);
      return false;
    }
    try { fs.rmSync(p, { recursive: true, force: true }); return true; } catch { return false; }
  }

  /**
   * Delete what the manifest does not refer to: a download that was never
   * recorded, an encode ffmpeg was killed in the middle of, a manifest's
   * temporary file. None of it can be trusted, and all of it takes room.
   */
  tidy() {
    if (!this.exists() || this._heldElsewhere()) return 0;
    const keep = this.referenced();
    let removed = 0;
    for (const name of fs.readdirSync(this.dir)) {
      if (keep.has(name)) continue;
      if (this._remove(name)) removed += 1;
    }
    return removed;
  }

  /**
   * Start again from nothing: every file goes, and the manifest is empty -
   * but for where the job was posted (`sent`). Whether a post went out does
   * not depend on the file it was made from, and a reset used to take the
   * record with it: a film posted just before a restart, whose library file
   * had since changed (or whose check failed until the work was reset), was
   * made and posted to the group a second time.
   */
  reset(why = null) {
    if (this._heldElsewhere()) return;
    const sent = this.manifest.sent ?? null;
    if (this.exists()) for (const name of fs.readdirSync(this.dir)) this._remove(name);
    vouchedFor.delete(this.key);
    forgetKept(this.keptKey);
    this._m = { ...emptyManifest(this.key, this.kind, this.label), sent };
    this.record({});
    if (why) logger.debug(`${this.label ?? this.key}: work reset - ${why}`);
  }

  /** The job is finished with: its directory goes. Returns the bytes it held. */
  drop() {
    forgetKept(this.keptKey);
    vouchedFor.delete(this.key);
    if (this._heldElsewhere()) return 0;
    this._m = null;
    let st = null;
    try { st = fs.lstatSync(this.dir); } catch { return 0; }
    if (!this.isSafe(this.dir)) {
      logger.warn(`not deleting ${this.dir}: the guard says it is not the bot's to delete`);
      return 0;
    }
    const freed = st.isDirectory() ? dirBytes(this.dir) : 0;
    try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch (err) {
      logger.warn(`could not remove ${this.dir}: ${err.message}`);
      return 0;
    }
    roomFreed();
    return freed;
  }
}

/**
 * The work of the job known by `key`. Nothing is made on disk until the job
 * locks it or records something, so looking (recovery, a cancel) is free.
 * `isSafe` is the caller's delete guard; without one nothing is deleted.
 * `keptKey` is the key the job's room kept for a retry is known by
 * (disk-space.js keepRoom), forgotten when the work goes.
 */
export function openWork({ workDir, key, kind = null, label = null, isSafe = null, keptKey = null }) {
  if (!workDir || !key) throw new Error('a job\'s work needs a work directory and a key');
  return new JobWork({ workDir, key, kind, label, isSafe, keptKey });
}

/**
 * Hand the work of `fromKey` to `toKey`: recovery resuming one of two
 * journalled twins of the same film or episode takes the other's files, if
 * it has none of its own, rather than making them again. Otherwise the
 * other's go. Returns 'adopted', 'dropped' or 'none'.
 */
export function adoptWork({ workDir, fromKey, toKey, isSafe, keptKey = null }) {
  const from = openWork({ workDir, key: fromKey, isSafe, keptKey });
  if (!from.exists()) return 'none';
  const to = openWork({ workDir, key: toKey, isSafe });
  if (!from.has() || to.has() || busy.has(to.name) || busy.has(from.name)) {
    from.drop();
    return 'dropped';
  }
  try {
    if (to.exists()) {
      if (!isSafe(to.dir)) throw new Error('not the bot\'s to replace');
      fs.rmSync(to.dir, { recursive: true, force: true });
    }
    fs.renameSync(from.dir, to.dir);
    const m = { ...readManifestRaw(to.dir), key: toKey, updatedAt: Date.now() };
    writeFileAtomic(path.join(to.dir, MANIFEST), JSON.stringify(m));
    forgetKept(keptKey ?? fromKey);
    return 'adopted';
  } catch (err) {
    logger.warn(`could not hand ${from.dir} on: ${err.message}`);
    from.drop();
    return 'dropped';
  }
}

function readManifestRaw(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')); } catch { return {}; }
}

/* ------------------------------------------------------ is it the same file? */

/**
 * Ask the library about a download without downloading it: a GET for its
 * first byte, whose answer carries the file's length (Content-Range, or
 * Content-Length when ranges are not served), Last-Modified and ETag. The
 * body is cancelled at once.
 *
 * A 404 or 410 is an answer - the library no longer has it - and so is any
 * other refusal short of the server being unwell. The server being
 * unreachable, or unwell (5xx, 429), is not an answer: it throws, with a
 * message the pipelines treat as transient (media/resume.js), so the job
 * waits rather than throwing its files away on a guess.
 */
export async function probeDownload(url, { headers = {}, signal = null, fetchImpl = null } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  let res;
  try {
    res = await doFetch(url, { headers: { ...headers, Range: 'bytes=0-0' }, signal, redirect: 'follow' });
  } catch (err) {
    if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
    throw Object.assign(new Error(`could not reach the library to check the kept files: ${err.message}`), { cause: err });
  }
  try { await res.body?.cancel?.(); } catch { /* already done */ }
  if (res.status >= 500 || res.status === 429) {
    throw new Error(`could not reach the library to check the kept files: HTTP ${res.status}`);
  }
  if (!res.ok) return { ok: false, status: res.status };
  const range = /^bytes\s+\d+-\d+\/(\d+)$/i.exec(res.headers.get('content-range') ?? '');
  const length = Number(res.headers.get('content-length') ?? 0);
  const total = res.status === 206 ? (range ? Number(range[1]) : null) : (length > 0 ? length : null);
  return {
    ok: true, status: res.status, total, ranges: res.status === 206,
    lastModified: res.headers.get('last-modified') ?? null, etag: res.headers.get('etag') ?? null,
  };
}

/** A library copy's identity as the manifest records it. */
export function itemIdOf(copy) {
  const id = copy?.id ?? copy?.localPath ?? copy?.downloadUrl ?? null;
  return id == null ? null : String(id);
}

/** What a local file is, to tell later whether it is still the same one. */
export function statOf(file) {
  try {
    const st = fs.statSync(file);
    return { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Is the work in manifest `m` still the library's file `current`
 * ({ id, access, librarySize, localPath })? `probe` asks the library about a
 * download (probeDownload); it throws when the library cannot be reached,
 * and so does this: an unanswered question is never taken as a yes or a no.
 *
 * @returns {{ ok: true } | { ok: false, why: string }}
 */
export async function verifyIdentity(m, current, { probe = null } = {}) {
  const it = m?.item;
  if (!it) return { ok: false, why: 'nothing says which library file it came from' };
  const how = (a) => (a === 'local' ? 'read from the library in place' : 'downloaded');
  if (it.access !== current.access) return { ok: false, why: `it was ${how(it.access)}, and would now be ${how(current.access)}` };
  if (String(it.id) !== String(current.id)) return { ok: false, why: 'it came from another library item' };
  if (it.librarySize > 0 && current.librarySize > 0 && Number(it.librarySize) !== Number(current.librarySize)) {
    return { ok: false, why: `the library's file was ${fmtBytes(it.librarySize)} and is now ${fmtBytes(current.librarySize)}` };
  }
  if (it.access === 'local') {
    const now = statOf(current.localPath);
    if (!now) return { ok: false, why: 'the library file is not there any more' };
    const was = it.local ?? {};
    if (now.dev !== was.dev || now.ino !== was.ino || now.size !== was.size || now.mtimeMs !== was.mtimeMs) {
      return { ok: false, why: 'the library file was replaced or changed' };
    }
    return { ok: true };
  }
  if (typeof probe !== 'function') return { ok: false, why: 'the library cannot be asked about it' };
  const p = await probe();
  if (!p?.ok) return { ok: false, why: `the library no longer serves it (HTTP ${p?.status ?? '?'})` };
  if (!(it.total > 0) || !(p.total > 0)) return { ok: false, why: 'the library does not say how long the file is' };
  if (Number(p.total) !== Number(it.total)) {
    return { ok: false, why: `the library's file was ${fmtBytes(it.total)} and is now ${fmtBytes(p.total)}` };
  }
  if (it.lastModified && p.lastModified && it.lastModified !== p.lastModified) {
    return { ok: false, why: `the library's file was modified (${it.lastModified} -> ${p.lastModified})` };
  }
  if (it.etag && p.etag && it.etag !== p.etag) return { ok: false, why: 'the library\'s file has a new ETag' };
  return { ok: true };
}

/* -------------------------------------------------------------- sweeping */

/** The job directories the journals still hold: a restart resumes each from what is in it. */
export function liveWorkDirs({ movie = [], tv = [] } = {}) {
  const names = new Set();
  for (const p of movie ?? []) if (p?.jobKey) names.add(jobDirName(workKey.movie(p.jobKey)));
  for (const r of tv ?? []) {
    if (!r?.reqKey) continue;
    for (const e of r.episodes ?? []) if (e?.id != null) names.add(jobDirName(workKey.tv(r.reqKey, e.id)));
  }
  return names;
}

/** The newest change anywhere in `p`, never following a symbolic link. */
function newestMtime(p) {
  let st;
  try { st = fs.lstatSync(p); } catch { return 0; }
  let newest = st.mtimeMs;
  if (st.isDirectory()) {
    let names = [];
    try { names = fs.readdirSync(p); } catch { /* unreadable */ }
    for (const n of names) newest = Math.max(newest, newestMtime(path.join(p, n)));
  }
  return newest;
}

/**
 * Clear the work directory of what nothing will resume from.
 *
 * `live` is liveWorkDirs(): those directories are kept whatever their age,
 * and so is any a job in this process has open or recovery is holding. At
 * start-up (`all`) everything else goes - a legacy flat file, a directory no
 * journal holds. Hourly, only what has not changed for `olderThanMs` (a
 * directory's age is the newest change inside it): a finished film left on
 * disk because its operator keeps local copies (media.deleteAfterSend off)
 * still goes six hours on, as it always did.
 *
 * Nothing is followed through a symbolic link, and nothing is deleted that
 * `isSafe` - the caller's guard, CLAUDE.md rule 5 - refuses.
 */
export function sweepWorkDir(workDir, {
  live = new Set(), all = false, olderThanMs = 6 * 3600_000, isSafe = null, log: out = logger, now = Date.now(),
} = {}) {
  const result = { removed: 0, kept: 0, keptBytes: 0 };
  if (!workDir) return result;
  let entries;
  try { entries = fs.readdirSync(workDir, { withFileTypes: true }); } catch { return result; }
  const safe = typeof isSafe === 'function' ? isSafe : () => false;
  for (const e of entries) {
    const p = path.join(workDir, e.name);
    if (live.has(e.name) || isWorkBusy(e.name)) {
      if (live.has(e.name) && e.isDirectory()) {
        result.kept += 1;
        result.keptBytes += dirBytes(p);
      }
      continue;
    }
    if (!all && now - newestMtime(p) <= olderThanMs) continue;
    if (!safe(p)) {
      out.warn?.(`not sweeping ${p}: the guard says it is not the bot's to delete`);
      continue;
    }
    try {
      fs.rmSync(p, { recursive: true, force: true });
      result.removed += 1;
    } catch { /* ignore races */ }
  }
  if (result.removed) out.info?.(`cleaned ${result.removed} ${all ? 'abandoned' : 'stale'} item(s) from the work dir`);
  if (result.kept && all) {
    out.info?.(`kept ${fmtBytes(result.keptBytes)} of work for ${result.kept} journalled job(s), to resume from where each stopped`);
  }
  return result;
}
