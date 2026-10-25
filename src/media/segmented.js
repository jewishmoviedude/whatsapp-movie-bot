/**
 * A re-encode done in pieces, so that a restart goes on from the last piece
 * finished instead of from the first frame.
 *
 * The Parent Trap (1998), 2026-09-29: downloaded, then 23 minutes into its
 * encode (libx264 veryfast, 1080p -> 720p, about 30 minutes of CPU on this
 * box at 3.4x real time) when the bot restarted at 19:07; the encode began
 * again from the start, and again after a second restart 11 seconds later.
 * The operator: "if bot gets interrupted it should be able to continue
 * where left off and not need to start over from step 1".
 *
 * The video is encoded in pieces of `segmentSec` (5 minutes), each starting
 * at an exact frame, and joined by stream copy. What was measured on ffmpeg
 * 6.1.1 (this box's), on made-up clips covering closed and open GOPs with
 * B-frames, AC3 5.1 in mkv, audio 5 ms early and 0.5 s late, video 1.0 s
 * late and a noisy clip hard to encode, decided how:
 *
 * - Each piece starts `segmentWarmupSec` (5 s) early, and that warm-up is
 *   encoded and then cut off. Without it each piece began about 1.3 dB
 *   softer for a second while x264's rate control restarted; with it, and a
 *   keyframe forced at the join, the frames after each join measure the same
 *   as a one-pass encode's, and the keyframe is the size of x264's own.
 * - Frames are counted (-frames:v), never timed: -to as an input option with
 *   -copyts on a file whose start time is not 0 kept one frame too many, and
 *   it appeared twice at a join. -ss is given -seek_timestamp 1, or it is
 *   offset by the file's start time. Pieces are written as MPEG-TS with
 *   +initial_discontinuity, or the concat protocol flags the first packet of
 *   each as corrupt, and shifted 10 s (-output_ts_offset) so the first
 *   piece's B-frame decode times stay positive (without it the muxer moved
 *   piece 0 by 83 ms, over piece 1).
 * - The H.264 level is pinned: at 480p a higher bitrate alone moved x264
 *   from level 3.0 to 3.1, which changes the SPS, and pieces with different
 *   SPS cannot be joined. Every piece's SPS/PPS hash, profile, level, size
 *   and pixel format are checked against the first piece's.
 * - The sound is encoded once, whole, in its own pass: each separately
 *   encoded AAC piece adds about 21 ms of encoder priming and ends padded to
 *   a frame, so every join would click and drift. Encoded whole it came out
 *   bit-identical to the one-pass encode's (same framemd5), for a minute or
 *   two of CPU on a film.
 *
 * Every piece is checked before it is recorded (its frame count, its first
 * frame a keyframe, its first and last times, its codec parameters); a
 * piece that fails its check, and a source that cannot be cut exactly (a
 * variable frame rate, one too short to be worth it, more than one video
 * stream, packet times that cannot be read), is encoded in one pass as
 * before, with the reason logged. A piece, the sound or the join whose
 * ffmpeg died or could not start is made again, once, from the pieces
 * already made (failedOnce). An interruption loses at most one piece (about
 * 90 s of CPU), the sound pass, or the join.
 *
 * On the GPU (h264_nvenc, ffmpeg.js pickEncoder) the pieces are made the
 * same way, with two differences found by the author of the NVENC change
 * (2026-09-29): NVENC writes a different SPS when the bitrate differs from
 * one piece to the next (the PPS stays the same), and pieces with different
 * SPS cannot be joined - so every NVENC piece is made at one fixed bitrate,
 * where libx264's pieces steer theirs towards the budget; with one bitrate
 * the SPS matched. And NVENC never fails a film: a piece it cannot make, or
 * makes unlike the first piece, or pieces that would not fit under the cap,
 * end in NVENC_FALLBACK, and convertForWhatsApp makes the job's pieces again
 * with libx264. The encoder is part of settingsHash, so GPU and CPU pieces
 * are never joined into one film.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import log from '../util/logger.js';
import {
  runFfmpeg, effectiveEncode, fmtBytes, checkSize, videoEncodeArgs, nvencPreset, jobEncoder,
} from './ffmpeg.js';
import { fsyncDir, statOf } from './work-files.js';

const execFileAsync = promisify(execFile);
const logger = log.scope('ffmpeg');

/** Seconds every piece's timestamps are shifted by (see the header). */
export const TS_OFFSET = 10;
const MIN_VERSION = [5, 1];                  // -fps_mode
const AUDIO = 'audio.m4a';
const META = 'meta.txt';
const pieceName = (k) => `v${String(k).padStart(4, '0')}.ts`;

/* ------------------------------------------------------------- helpers */

/** "24000/1001" -> 23.976..., or null. */
export function parseRate(r) {
  const m = /^(\d+)(?:\/(\d+))?$/.exec(String(r ?? ''));
  if (!m) return null;
  const v = Number(m[1]) / Number(m[2] ?? 1);
  return isFinite(v) && v > 0 ? v : null;
}

const versions = new Map();
/** ffmpeg's version line and number, asked once per binary. Null numbers when it cannot say. */
export async function ffmpegVersion(cfg) {
  const bin = cfg.ffmpegPath;
  if (!versions.has(bin)) {
    versions.set(bin, (async () => {
      try {
        const { stdout } = await execFileAsync(bin, ['-version'], { timeout: 10_000 });
        const line = String(stdout).split('\n')[0] ?? '';
        const m = /ffmpeg version n?(\d+)\.(\d+)/i.exec(line);
        return { text: line, major: m ? Number(m[1]) : null, minor: m ? Number(m[2]) : null };
      } catch {
        return { text: null, major: null, minor: null };
      }
    })());
  }
  return versions.get(bin);
}

/** What the pieces were made with: pieces made any other way are not joined to them. */
export function settingsHash(cfg, version, encoder = 'cpu') {
  const { preset, maxHeight } = effectiveEncode(cfg);
  const parts = [
    cfg.videoCodec, preset, maxHeight, cfg.audioCodec, cfg.audioBitrateK, cfg.maxOutputBytes, cfg.encodeProfile ?? null,
    segmentSec(cfg), warmupSec(cfg), version?.text ?? null,
  ];
  // Only for the GPU, so pieces made on the CPU keep the hash they had.
  if (encoder === 'nvenc') parts.push('h264_nvenc');
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}
const segmentSec = (cfg) => Math.max(1, Number(cfg.segmentSec) || 300);
const warmupSec = (cfg) => Math.max(0, Number(cfg.segmentWarmupSec ?? 5));

async function ffprobe(cfg, args) {
  const { stdout } = await execFileAsync(cfg.ffprobePath, ['-v', 'error', ...args], { maxBuffer: 512 * 1024 * 1024 });
  return String(stdout);
}

/**
 * One stream's packets: their presentation times sorted (P), how many there
 * are, their payload in bytes, where the first starts and the latest one
 * ends, whether the first in the file is a keyframe, and - with `rows` -
 * each one's time and flags in file order. A time ffprobe cannot give (N/A)
 * makes the list unusable: null.
 *
 * ffprobe's lines are read as it writes them, never gathered into one
 * string, and with `span` nothing is kept of each but where it starts and
 * ends. The sound of a Blu-ray remux is usually TrueHD, 1,200 packets a
 * second in MKV: a two-hour one is 8,640,000 of them, 197 MB of ffprobe's
 * output, and reading that whole (ffprobe 6.1.1 on this box, a made-up
 * two-hour TrueHD mkv) took 1.1 GB of memory and 52 seconds - on a box with
 * under a gigabyte, which would have been killed at the same film after
 * every restart. Only the sound's span is ever used, so that is all `span`
 * keeps. The video's times (some 170,000 for a two-hour film) go in a typed
 * array.
 *
 * `fd` is a file this process holds open, given to ffprobe as its fd 3
 * (sourceGuard); `file` is then /dev/fd/3.
 */
export function packets(cfg, file, stream = 'v:0', { rows: keepRows = false, span = false, fd = null, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(cfg.ffprobePath, [
        '-v', 'error', '-select_streams', stream, '-show_entries', 'packet=pts_time,duration_time,size,flags', '-of', 'csv=p=0', file,
      ], { stdio: ['ignore', 'pipe', 'pipe', ...(fd != null ? [fd] : [])] });
    } catch (err) {
      reject(new Error(`could not start ffprobe: ${err.message}`));
      return;
    }
    let times = span ? null : new Float64Array(4096);
    const rows = keepRows ? [] : null;
    let count = 0;
    let payload = 0;
    let firstKey = null;
    let first = Infinity;
    let end = -Infinity;
    let unusable = false;
    let rest = '';
    let errTail = '';
    const take = (line) => {
      if (!line.trim()) return;
      // csv order is ffprobe's own: pts_time, duration_time, size, flags.
      const [pts, dur, size, flags = ''] = line.split(',');
      if (pts === 'N/A' || pts === undefined || pts === '') { unusable = true; return; }
      const t = Number(pts);
      if (times) {
        if (count === times.length) {
          const grown = new Float64Array(times.length * 2);
          grown.set(times);
          times = grown;
        }
        times[count] = t;
      }
      count += 1;
      payload += Number(size) || 0;
      firstKey ??= /K/.test(flags);
      if (t < first) first = t;
      end = Math.max(end, t + (dur === 'N/A' ? 0 : Number(dur) || 0));
      rows?.push({ pts: t, flags });
    };
    const kill = () => { try { proc.kill('SIGKILL'); } catch { /* gone */ } };
    const onAbort = () => kill();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (s) => {
      if (unusable) return;
      const text = rest + s;
      let at = 0;
      for (;;) {
        const nl = text.indexOf('\n', at);
        if (nl < 0) break;
        take(text.slice(at, nl));
        at = nl + 1;
        // Nothing more is worth reading: the list is no use as it is.
        if (unusable) { kill(); return; }
      }
      rest = text.slice(at);
    });
    proc.stderr.on('data', (d) => { errTail = (errTail + d).slice(-2000); });
    proc.on('error', (err) => {
      signal?.removeEventListener?.('abort', onAbort);
      reject(new Error(`could not start ffprobe: ${err.message}`));
    });
    proc.on('close', (code, sig) => {
      signal?.removeEventListener?.('abort', onAbort);
      if (signal?.aborted) { reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })); return; }
      if (!unusable && rest) take(rest);
      if (unusable) { resolve(null); return; }
      if (code !== 0) {
        const tail = errTail.split('\n').filter(Boolean).slice(-2).join(' | ');
        reject(new Error(`ffprobe exited ${code ?? sig}${tail ? `: ${tail}` : ''}`));
        return;
      }
      const P = times ? times.slice(0, count).sort() : null;
      resolve({ P, count, payload, firstKey: !!firstKey, first: count ? first : null, end, rows });
    });
  });
}

/** Codec parameters two pieces must share to be joined. */
async function codecParams(cfg, file) {
  const out = JSON.parse(await ffprobe(cfg, [
    '-select_streams', 'v:0', '-show_entries', 'stream=profile,level,width,height,pix_fmt,extradata_hash',
    '-show_data_hash', 'MD5', '-of', 'json', file,
  ]));
  const s = out.streams?.[0] ?? {};
  return { hash: s.extradata_hash ?? null, profile: s.profile ?? null, level: s.level ?? null, width: s.width ?? null, height: s.height ?? null, pixFmt: s.pix_fmt ?? null };
}
const sameParams = (a, b) => ['hash', 'profile', 'level', 'width', 'height', 'pixFmt'].every((k) => a?.[k] === b?.[k]);

/** First index of sorted `P` at or after `t` (P.length when none is). */
function lowerBound(P, t) {
  let lo = 0;
  let hi = P.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (P[mid] < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * The H.264 level for a picture of `w`x`h` at `fps`: one level, the same in
 * every piece. 4.0 - any phone plays it - for anything up to 1080p at 30
 * frames a second; higher only for what 4.0 cannot hold.
 */
function levelFor(w, h, fps) {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
  const rate = mbs * fps;
  if (mbs <= 8192 && rate <= 245_760) return '4.0';
  if (mbs <= 8704 && rate <= 522_240) return '4.2';
  return '5.1';
}

/* ---------------------------------------------------- can it be cut? */

/**
 * Can this source be cut into pieces at exact frames? Every condition must
 * hold; the first that does not is the reason it is encoded in one pass.
 * `P` is the video's packet times, sorted.
 */
export function eligible(info, cfg, { version, P = null, timeBase = null, encoder = 'cpu' } = {}) {
  const L = segmentSec(cfg);
  if (encoder !== 'nvenc' && cfg.videoCodec !== 'libx264') return { ok: false, why: `the encoder is ${cfg.videoCodec}, and only libx264 and h264_nvenc are cut into pieces` };
  if (version?.major == null) return { ok: false, why: 'ffmpeg\'s version is not known' };
  if (version.major < MIN_VERSION[0] || (version.major === MIN_VERSION[0] && version.minor < MIN_VERSION[1])) {
    return { ok: false, why: `ffmpeg ${version.major}.${version.minor} is older than 5.1` };
  }
  if (!(info.duration >= 2 * L)) return { ok: false, why: `it is shorter than two ${L}-second pieces` };
  if (info.videoCount !== 1) return { ok: false, why: `it has ${info.videoCount} video streams` };
  const r = parseRate(info.video?.rFrameRate);
  const avg = parseRate(info.video?.avgFrameRate);
  if (!r || !avg || Math.abs(r - avg) / r > 0.001) {
    return { ok: false, why: `its frame rate is not constant (${info.video?.rFrameRate} and ${info.video?.avgFrameRate} on average)` };
  }
  const start = info.startTime ?? 0;
  if (start < -1 || start > 10) return { ok: false, why: `it starts at ${start}s` };
  if (!P) return { ok: true, fps: r };
  if (P.length < 2) return { ok: false, why: 'its frames have no times' };
  const frame = 1 / r;
  const tick = parseRate(timeBase) ?? 0;
  const slack = Math.max(0.002, tick);
  for (let i = 1; i < P.length; i++) {
    const gap = P[i] - P[i - 1];
    if (Math.abs(gap - frame) > slack) {
      return { ok: false, why: `a frame at ${P[i].toFixed(3)}s is ${(gap * 1000).toFixed(1)} ms after the one before, not ${(frame * 1000).toFixed(1)} ms` };
    }
  }
  return { ok: true, fps: r };
}

/**
 * Where the pieces go. Piece k keeps the frames from index i_k (the first
 * at or after P[0] + k*L) up to the next piece's; a last piece shorter than
 * L/2 is merged into the one before. Each piece after the first is encoded
 * from `seekTs` - W seconds of warm-up earlier - with a keyframe forced at
 * `keyTs`, and cut back to that keyframe. The times given ffmpeg are the
 * mid-points between two frames, which survive any rounding.
 */
export function planPieces(P, { L, W, fps }) {
  const n = P.length;
  const idx = [0];
  for (let k = 1; ; k++) {
    const i = lowerBound(P, P[0] + k * L);
    if (i >= n) break;
    idx.push(i);
  }
  idx.push(n);
  const frame = 1 / fps;
  if (idx.length > 2) {
    const tailStart = idx[idx.length - 2];
    if (P[n - 1] + frame - P[tailStart] < L / 2) idx.splice(idx.length - 2, 1);
  }
  const pieces = [];
  for (let k = 0; k < idx.length - 1; k++) {
    const i = idx[k];
    const next = idx[k + 1];
    let j = 0;
    let keyTs = null;
    let seekTs = null;
    if (k > 0) {
      keyTs = (P[i - 1] + P[i]) / 2;
      j = lowerBound(P, P[i] - W);
      seekTs = j > 0 ? (P[j - 1] + P[j]) / 2 : null;
    }
    pieces.push({ k, i, n: next - i, e: next - j, keyTs, seekTs, first: P[i], last: P[next - 1] });
  }
  return { frames: n, start: P[0], end: P[n - 1] + frame, frame, pieces };
}

/* ------------------------------------------------------------- the work */

/**
 * Are all the pieces and the sound made, under today's settings and on the
 * encoder the job uses now? Then the job needs no source: they are only to
 * be joined (joinReady).
 */
export async function segmentsReady(work, cfg, { version = null, encoder = null } = {}) {
  const c = work?.manifest?.convert;
  if (c?.mode !== 'segmented' || !c.plan || c.joined) return false;
  // The encoder this job would use now (the plugins ask before downloading
  // again): pieces made on the other one are not joined to its pieces.
  encoder ??= await jobEncoder(cfg, work);
  if (c.settings !== settingsHash(cfg, version ?? await ffmpegVersion(cfg), encoder)) return false;
  if ((c.chunks ?? []).length !== c.plan.pieces.length) return false;
  if (c.plan.audio && !c.audio) return false;
  return intactChunks(work, c).length === c.plan.pieces.length && (!c.audio || fileIs(work.path(c.audio.name), c.audio.size));
}

const fileIs = (p, size) => { try { const st = fs.statSync(p); return st.isFile() && st.size === size; } catch { return false; } };

/** The recorded pieces still on the disk as they were written, in order, up to the first that is not. */
function intactChunks(work, c) {
  const out = [];
  for (const ch of c.chunks ?? []) {
    if (ch.k !== out.length || !fileIs(work.path(ch.name), ch.bytes)) break;
    out.push(ch);
  }
  return out;
}

/** Remove the pieces, the sound and the metadata from a job's work, through its delete guard. */
function dropPieces(work) {
  for (const name of fs.readdirSync(work.dir)) {
    if (/^v\d{4}\./.test(name) || name.startsWith(AUDIO) || name.startsWith(META)) {
      const p = work.path(name);
      if (work.isSafe(p)) fs.rmSync(p, { force: true });
    }
  }
}

/** Written whole, synced, then renamed: what a restart finds is either done or not there. */
function commit(part, final) {
  let fd = null;
  try { fd = fs.openSync(part, 'r'); fs.fsyncSync(fd); } finally { if (fd != null) fs.closeSync(fd); }
  fs.renameSync(part, final);
  fsyncDir(path.dirname(final));
}

/**
 * The library file a film is read from in place (access 'local'), held open
 * for the whole of one run.
 *
 * A segmented encode reads its source once for each of its steps - the
 * packet scans, the tags, the sound, every piece - where the one-pass
 * encode held one open file for its whole run. Opened again by name each
 * time, a library file replaced under the same name during the encode (an
 * upgraded release moved over the old one) would have had the pieces from
 * then on cut from the new file while the sound and the pieces before came
 * from the old one: a film that jumps at the join, its sound out of step
 * from there on, and nothing in the checks to notice at the same frame
 * rate. One replaced under a new name failed every later piece with "No
 * such file or directory" instead.
 *
 * So each run opens the file once, and every ffmpeg and ffprobe in it reads
 * that same open file, as /dev/fd/3. And before each step the file - the
 * one open and the one at its name - is checked against what the job
 * recorded of it (the manifest's item.local): anything changed, and the work
 * is reset and the job fails with SOURCE_VANISHED, which the pipelines treat
 * as transient - the retry looks the film up again and starts from the file
 * there now.
 *
 * A downloaded source is the job's own, in its own directory, and nothing
 * else writes it: it is read by name.
 */
function sourceGuard(work, input, label) {
  const it = work.manifest.item;
  if (it?.access !== 'local') return { input, fd: null, check() {}, close() {} };
  const was = it.local ?? {};
  const same = (s) => !!s && s.dev === was.dev && s.ino === was.ino && s.size === was.size && s.mtimeMs === was.mtimeMs;
  const replaced = () => {
    work.reset('the library file was replaced during the encode');
    return Object.assign(new Error(`SOURCE_VANISHED: the library file of ${label} was replaced or changed during its `
      + 'encode - it is converted again from the file there now'), { code: 'SOURCE_VANISHED' });
  };
  let fd = null;
  try { fd = fs.openSync(input, 'r'); } catch { throw replaced(); }
  const held = () => {
    try {
      const s = fs.fstatSync(fd);
      return { dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs };
    } catch { return null; }
  };
  // /dev/fd/N opened again is the same file, with an offset of its own, on
  // Linux; elsewhere it can share the offset, so the name is used there.
  const shared = process.platform === 'linux';
  const guard = {
    input: shared ? '/dev/fd/3' : input,
    fd: shared ? fd : null,
    check() {
      if (same(held()) && same(statOf(input))) return;
      guard.close();
      throw replaced();
    },
    close() {
      if (fd == null) return;
      try { fs.closeSync(fd); } catch { /* closed */ }
      fd = null;
    },
  };
  guard.check();
  return guard;
}

/** Errors that are the job's to handle, whatever step they came from. */
const theirs = (err) => err?.code === 'CANCELLED' || err?.code === 'ENOSPC' || err?.code === 'SOURCE_VANISHED';

/**
 * A step - a piece, the sound, the join - that failed in a way that says
 * nothing about what is already made: ffmpeg killed by a signal ("ffmpeg
 * exited null"), one that could not be started ("spawn EAGAIN"), an
 * ffprobe that failed, a library share that dropped for a moment. It used to
 * throw away every piece made and encode the whole film in one pass, for
 * good: with 20 of The Parent Trap's 24 pieces made, one such blip was
 * about 25 minutes of CPU lost.
 *
 * Now the failure is recorded (convert.failed) and the job fails with an
 * error the pipelines treat as transient ("could not be made this time",
 * media/resume.js): the retry, or the next start, goes on from the pieces
 * made. The same step failing a second time is taken to be the step's own
 * fault, and `fallback` - one pass, or the join given up - is the answer.
 */
function failedOnce(work, c, k, what, err, fallback) {
  const n = (c.failed?.k === k ? Number(c.failed.n) || 0 : 0) + 1;
  if (n >= 2) return fallback(`${what} failed twice: ${err.message}`);
  work.record({ convert: { ...c, failed: { k, n } } });
  logger.warn(`${work.label ?? 'the film'}: ${what} failed (${err.message}) - the retry goes on from what is made`);
  throw Object.assign(new Error(`${what} could not be made this time (${err.message}); it is tried again from there`), {
    code: 'STEP_RETRY', cause: err,
  });
}

/**
 * Encode `input` into `outPath` in pieces, going on from the pieces its work
 * already holds. Returns what convertForWhatsApp returns, or null when it is
 * to be encoded in one pass instead (recorded, with the reason, so a restart
 * does not try again what failed).
 *
 * `onProgress(pct, detail, { runPct })`: `pct` is the share of the whole
 * film made, pieces made before a restart included; `runPct` the share of
 * what was left of it when this run began, which is what a time left can be
 * worked out from (ffmpeg.js conversionClock).
 */
export async function encodeSegmented(input, outPath, cfg, {
  work, info, onProgress, signal, version, encoder = 'cpu',
}) {
  const settings = settingsHash(cfg, version, encoder);
  const gpu = encoder === 'nvenc';
  // The GPU's own failings go back to convertForWhatsApp, which makes the
  // pieces again on the CPU (see the header).
  const toCpu = (reason, message, cause = null) => Object.assign(new Error(message), { code: 'NVENC_FALLBACK', reason, cause });
  const label = work.label ?? path.basename(input);
  const onePass = (why) => {
    logger.info(`encoding ${label} in one pass: ${why}`);
    dropPieces(work);
    work.record({ convert: { settings, mode: 'one-pass', why } });
    return null;
  };

  let c = work.manifest.convert;
  // Joined once, and the joined file since lost: the pieces are made again.
  if (c?.joined) { dropPieces(work); c = null; }
  if (c?.settings === settings && c.mode === 'one-pass') return onePass(c.why ?? 'as it was before the restart');
  if (c && c.settings !== settings) {
    logger.info(`the encode settings for ${label} changed since its pieces were made - making them again`);
    dropPieces(work);
    c = null;
  }

  const src = sourceGuard(work, input, label);
  try {
    if (!c) {
      const first = eligible(info, cfg, { version, encoder });
      if (!first.ok) return onePass(first.why);
      // The scans are where a source nobody could cut is found out, and one
      // they cannot read goes to one pass as any other such source does: it
      // used to fail the film for good.
      let v;
      try {
        v = await packets(cfg, src.input, 'v:0', { fd: src.fd, signal });
      } catch (err) {
        if (theirs(err)) throw err;
        return onePass(`could not read its packet times: ${err.message}`);
      }
      if (!v) return onePass('its frames have no times');
      const ok = eligible(info, cfg, { version, P: v.P, timeBase: info.video?.timeBase, encoder });
      if (!ok.ok) return onePass(ok.why);
      const plan = planPieces(v.P, { L: segmentSec(cfg), W: warmupSec(cfg), fps: ok.fps });
      if (plan.pieces.length < 2) return onePass('it makes only one piece');
      const { maxHeight } = effectiveEncode(cfg);
      const outH = info.video.height > maxHeight ? maxHeight : info.video.height;
      const outW = Math.round((info.video.width * outH) / info.video.height / 2) * 2;
      plan.level = levelFor(outW, outH, ok.fps);
      plan.scale = info.video.height > maxHeight ? maxHeight : null;
      // What one pass takes as 0: the join puts the picture and the sound
      // where one pass would, relative to this.
      plan.fileStart = info.startTime ?? 0;
      if (info.audio) {
        // How long the sound lasts is all the sound pass is checked against.
        src.check();
        let a;
        try {
          a = await packets(cfg, src.input, 'a:0', { span: true, fd: src.fd, signal });
        } catch (err) {
          if (theirs(err)) throw err;
          return onePass(`could not read its packet times: ${err.message}`);
        }
        if (!a || !a.count) return onePass('its sound has no times');
        plan.audio = { span: a.end - a.first };
      } else plan.audio = null;
      // The global tags and chapters, which one pass copies from the source,
      // kept to give the joined file. ffmpeg writes the chapters moved by the
      // source's start time, as one pass moves them.
      let meta = null;
      src.check();
      try {
        await runFfmpeg(['-i', src.input, '-f', 'ffmetadata', `${META}.part`], { cfg, signal, cwd: work.dir, fd: src.fd });
        commit(work.path(`${META}.part`), work.path(META));
        meta = META;
      } catch (err) {
        if (theirs(err)) throw err;
        logger.warn(`${label}: could not keep its tags and chapters for the pieces: ${err.message}`);
      }
      c = { settings, mode: 'segmented', plan, audio: null, chunks: [], meta };
      work.record({ convert: c });
    }

    const { plan } = c;
    const done = intactChunks(work, c);
    if (done.length !== (c.chunks ?? []).length) {
      c = { ...c, chunks: done };
      work.record({ convert: c });
    }
    if (done.length) logger.info(`converting ${label} from piece ${done.length + 1} of ${plan.pieces.length}`);

    /* the sound, whole, first */
    if (plan.audio && !(c.audio && fileIs(work.path(c.audio.name), c.audio.size))) {
      const part = `${AUDIO}.part`;
      onProgress?.(0, 'encoding the sound');
      src.check();
      try {
        // With its length, so ffmpeg's progress is read and the panel's line
        // moves ("encoding the sound · 63% (95x)"). Without one, runFfmpeg
        // reports nothing, and the panel sat on "encoding the sound" at the
        // convert stage's 40% for the whole pass - a couple of minutes for a
        // film, with no sign it was working (operator, 2026-09-30,
        // Inception). The bar's share is still the pieces' (`pct` 0 here): it
        // stands for the picture, which is most of the time.
        await runFfmpeg(['-i', src.input, '-map', '0:a:0', '-vn', '-sn', '-dn', '-c:a', cfg.audioCodec, '-b:a', `${cfg.audioBitrateK}k`,
          '-ac', '2', '-f', 'mp4', part], {
          cfg, signal, cwd: work.dir, fd: src.fd,
          durationSec: plan.audio.span || info?.duration || 0,
          onProgress: (pct, detail) => onProgress?.(0, `encoding the sound · ${detail}`),
        });
      } catch (err) {
        fs.rmSync(work.path(part), { force: true });
        if (theirs(err)) throw err;
        return failedOnce(work, c, 'audio', 'its sound', err, onePass);
      }
      let got;
      try {
        got = await packets(cfg, work.path(part), 'a:0', { span: true, signal });
      } catch (err) {
        if (theirs(err)) throw err;
        return onePass(`could not read its sound's packet times: ${err.message}`);
      }
      const span = got?.count ? got.end - got.first : 0;
      if (!got || Math.abs(span - plan.audio.span) > 1) {
        return onePass(`its sound came out ${span.toFixed(2)}s long, not ${plan.audio.span.toFixed(2)}s`);
      }
      commit(work.path(part), work.path(AUDIO));
      c = { ...c, failed: null, audio: { name: AUDIO, size: fs.statSync(work.path(AUDIO)).size, payload: got.payload } };
      work.record({ convert: c });
    }

    /* the pieces */
    const T = Math.floor(cfg.maxOutputBytes * 0.93);
    const V = T - (c.audio?.payload ?? 0) - Math.max(8 * 1024 ** 2, 0.005 * T);
    const B0 = clamp((V * 8) / (plan.end - plan.start), 400_000, 8_000_000);
    const totalWork = plan.pieces.reduce((a, p) => a + p.e, 0);
    const workDone = () => plan.pieces.slice(0, c.chunks.length).reduce((a, p) => a + p.e, 0);
    // What was left when this run began: the time left is worked out from
    // how fast this run goes through it, not from a share of the film that
    // counts pieces made before a restart as made in no time at all.
    const runBase = workDone();
    const runWork = totalWork - runBase;
    const { preset } = effectiveEncode(cfg);
    if (!done.length) {
      logger.info(`encoding [${cfg.encodeProfile ?? 'custom'}] ${label} in ${plan.pieces.length} pieces of ${segmentSec(cfg)}s `
        + `with ${gpu ? 'h264_nvenc' : cfg.videoCodec}: `
        + `${gpu ? '' : 'about '}${Math.round(B0 / 1000)}kbps video, preset ${gpu ? nvencPreset(preset) : preset}, level ${plan.level}`);
    }
    for (let k = c.chunks.length; k < plan.pieces.length; k++) {
      const p = plan.pieces[k];
      const spent = c.chunks.reduce((a, ch) => a + ch.payload, 0);
      // libx264's pieces steer towards the budget; NVENC's keep one bitrate,
      // or their SPS differ and they cannot be joined (see the header). Its
      // CBR lands as close to the budget as libx264's steering does.
      const B = gpu ? Math.round(B0)
        : Math.round(clamp(((V - spent) * 8) / (plan.end - p.first), Math.max(400_000, 0.85 * B0), Math.min(8_000_000, 1.15 * B0)));
      const run = crypto.randomBytes(3).toString('hex');
      const raw = `v${String(k).padStart(4, '0')}.${run}.raw.ts`;
      const part = `${pieceName(k)}.part`;
      const before = workDone();
      src.check();
      let made;
      try {
        await runFfmpeg([
          '-copyts',
          ...(p.seekTs != null ? ['-seek_timestamp', '1', '-ss', p.seekTs.toFixed(6)] : []),
          '-i', src.input,
          '-map', '0:v:0',
          ...(plan.scale ? ['-vf', `scale=-2:${plan.scale}`] : []),
          ...videoEncodeArgs(cfg, encoder, B), '-level:v', plan.level,
          ...(p.keyTs != null ? ['-force_key_frames', p.keyTs.toFixed(6), '-forced-idr', '1'] : []),
          '-fps_mode', 'passthrough', '-frames:v', String(p.e), '-an', '-sn', '-dn',
          '-output_ts_offset', String(TS_OFFSET), '-f', 'mpegts', '-mpegts_copyts', '1', '-mpegts_flags', '+initial_discontinuity',
          raw,
        ], {
          cfg, signal, cwd: work.dir, frames: p.e, fd: src.fd,
          onProgress: (pct, detail) => {
            const at = before + (pct / 100) * p.e;
            onProgress?.(
              Math.min(99, Math.floor((at / totalWork) * 100)),
              `piece ${k + 1} of ${plan.pieces.length} · ${String(detail).replace(/^\d+%\s*/, '')}`.replace(/ · $/, ''),
              { runPct: runWork > 0 ? Math.min(99, ((at - runBase) / runWork) * 100) : null },
            );
          },
        });
        if (k === 0) fs.renameSync(work.path(raw), work.path(part));
        else {
          // Cut the warm-up off: from the keyframe forced at the join.
          const rawRows = (await packets(cfg, work.path(raw), 'v:0', { rows: true, signal }))?.rows ?? [];
          const idr = rawRows.filter((r) => /K/.test(r.flags) && r.pts >= p.keyTs + TS_OFFSET).map((r) => r.pts).sort((a, b) => a - b)[0];
          if (idr == null) throw Object.assign(new Error('no keyframe at the join'), { code: 'PIECE_CHECK' });
          await runFfmpeg(['-copyts', '-seek_timestamp', '1', '-ss', idr.toFixed(6), '-i', raw, '-map', '0:v', '-c', 'copy',
            '-f', 'mpegts', '-mpegts_copyts', '1', '-mpegts_flags', '+initial_discontinuity', part], { cfg, signal, cwd: work.dir });
          fs.rmSync(work.path(raw), { force: true });
        }
        made = await checkPiece(cfg, work.path(part), p, plan, c.chunks[0]?.params ?? null, signal);
      } catch (err) {
        fs.rmSync(work.path(raw), { force: true });
        fs.rmSync(work.path(part), { force: true });
        // Cancelled, the disk full, the library file replaced: the job's to
        // handle (it waits for room, and goes on from this piece). A piece
        // that came out wrong is the pieces' failing, and the film is
        // encoded in one pass. Anything else - ffmpeg killed, or unable to
        // start - is this piece's alone, and it is made again (failedOnce).
        if (theirs(err)) throw err;
        if (gpu) {
          throw toCpu(err.code === 'PIECE_CHECK' ? 'piece-check' : 'error',
            `NVENC could not make piece ${k + 1} of ${plan.pieces.length} (${err.message})`, err);
        }
        if (err.code === 'PIECE_CHECK') return onePass(`piece ${k + 1} of ${plan.pieces.length} failed: ${err.message}`);
        return failedOnce(work, c, k, `piece ${k + 1} of ${plan.pieces.length}`, err, onePass);
      }
      commit(work.path(part), work.path(pieceName(k)));
      c = {
        ...c,
        failed: null,
        chunks: [...c.chunks, {
          k, name: pieceName(k), bytes: fs.statSync(work.path(pieceName(k))).size, payload: made.payload, frames: p.n, bitrate: B, params: made.params,
        }],
      };
      work.record({ convert: c });
    }

    // Every piece made from the file the job recorded, the last one too.
    src.check();
    // NVENC's pieces at their one bitrate, over the cap once joined: made
    // again on the CPU now, rather than found too big after the join.
    if (gpu) {
      const payload = c.chunks.reduce((a, ch) => a + ch.payload, 0) + (c.audio?.payload ?? 0);
      // The MP4 the join writes adds well under 1% to the packets it holds.
      if (payload * 1.01 > cfg.maxOutputBytes) {
        throw toCpu('oversize', `NVENC's pieces come to ${fmtBytes(payload)}, too near the ${fmtBytes(cfg.maxOutputBytes)} cap`);
      }
    }
  } finally {
    src.close();
  }

  // Every piece and the sound made. The source is not needed for the join,
  // but it stays until the film is sent: it used to be deleted here, and a
  // join that failed had to download the film again to make it in one pass
  // (the operator, 2026-09-30: "files should remain in their folders until
  // fully sent on whatsapp").
  return joinReady(outPath, cfg, { work, onProgress, signal, version });
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Is piece `p`, in `file`, the frames it should be, made as the first piece was? */
async function checkPiece(cfg, file, p, plan, firstParams, signal = null) {
  const got = await packets(cfg, file, 'v:0', { signal });
  const fail = (why) => { throw Object.assign(new Error(why), { code: 'PIECE_CHECK' }); };
  if (!got) fail('its frames have no times');
  if (got.P.length !== p.n) fail(`it has ${got.P.length} frames, not ${p.n}`);
  if (!got.firstKey) fail('it does not start on a keyframe');
  const half = plan.frame / 2;
  if (Math.abs(got.P[0] - TS_OFFSET - p.first) > half) fail(`it starts at ${(got.P[0] - TS_OFFSET).toFixed(3)}s, not ${p.first.toFixed(3)}s`);
  if (Math.abs(got.P[got.P.length - 1] - TS_OFFSET - p.last) > half) fail(`it ends at ${(got.P[got.P.length - 1] - TS_OFFSET).toFixed(3)}s, not ${p.last.toFixed(3)}s`);
  const params = await codecParams(cfg, file);
  if (firstParams && !sameParams(params, firstParams)) {
    fail(`it was made with other codec parameters than the first piece (${JSON.stringify(params)})`);
  }
  return { payload: got.payload, params };
}

/**
 * Join the pieces and the sound into `outPath`, check the result, and record
 * it.
 *
 * The sound and the picture are put where one pass puts them. ffmpeg starts
 * each file it reads at 0 (its start time is taken off every timestamp), so
 * each is given that back with -itsoffset: the sound pass already holds the
 * source's timeline - its encoder's priming packet included, which the
 * player skips - and the pieces hold it 10 s on (TS_OFFSET). A source whose
 * picture starts late keeps that gap, where one pass fills it with copies of
 * the first frame.
 */
export async function joinReady(outPath, cfg, { work, onProgress, signal }) {
  const c = work.manifest.convert;
  const { plan } = c;
  const label = work.label ?? 'the film';
  const part = `${path.basename(outPath)}.part`;
  const names = c.chunks.map((ch) => ch.name);
  const broken = async (why) => {
    fs.rmSync(work.path(part), { force: true });
    dropPieces(work);
    const source = work.manifest.source;
    work.record({
      convert: { settings: c.settings, mode: 'one-pass', why: `the pieces could not be joined: ${why}` },
      ...(source?.state === 'dropped' ? { source: null } : {}),
    });
    // It is converted again in one pass from its download, which is kept
    // until the film is sent - or fetched again, when an older build deleted
    // it once the pieces were done ('dropped'). A transient failure, so the
    // job comes back.
    throw new Error(`the converted pieces could not be joined (${why}) - making it again in one pass`);
  };
  // Only what the join made being wrong - its frames, how long it lasts, a
  // join that does not decode - says the pieces cannot be joined, and gives
  // them up (broken). An ffmpeg or ffprobe that died, or could not start,
  // says nothing about them: the pieces are kept and the join is tried again
  // (failedOnce), and only a second such failure gives them up.
  const again = (what, err) => {
    fs.rmSync(work.path(part), { force: true });
    return failedOnce(work, c, 'join', what, err, broken);
  };
  const theirsHere = (err) => err?.code === 'CANCELLED' || err?.code === 'ENOSPC';
  onProgress?.(99, 'joining the pieces');
  const startOf = async (name) => Number((await ffprobe(cfg, ['-show_entries', 'format=start_time', '-of', 'csv=p=0', work.path(name)])).trim()) || 0;
  let args;
  try {
    const video = (await startOf(names[0])) - TS_OFFSET - (plan.fileStart ?? 0);
    const sound = c.audio ? await startOf(c.audio.name) : 0;
    args = [
      '-itsoffset', video.toFixed(6), '-i', `concat:${names.join('|')}`,
      ...(c.audio ? ['-itsoffset', sound.toFixed(6), '-i', c.audio.name] : []),
      ...(c.meta ? ['-f', 'ffmetadata', '-i', c.meta] : []),
      '-map', '0:v:0', ...(c.audio ? ['-map', '1:a:0'] : []),
      ...(c.meta ? ['-map_metadata', String(c.audio ? 2 : 1), '-map_chapters', String(c.audio ? 2 : 1)] : []),
      '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', part,
    ];
  } catch (err) {
    return again('the joined film', err);
  }
  try {
    await runFfmpeg(args, { cfg, signal, cwd: work.dir });
  } catch (err) {
    if (theirsHere(err)) { fs.rmSync(work.path(part), { force: true }); throw err; }
    return again('the joined film', err);
  }
  // The frames, all of them, spanning the time they did in the source.
  let got;
  try {
    got = await packets(cfg, work.path(part), 'v:0', { signal });
  } catch (err) {
    if (theirsHere(err)) { fs.rmSync(work.path(part), { force: true }); throw err; }
    return again('the joined film', err);
  }
  if (!got || got.P.length !== plan.frames) return broken(`it has ${got?.P.length ?? 0} frames, not ${plan.frames}`);
  const span = got.P[got.P.length - 1] - got.P[0] + plan.frame;
  if (Math.abs(span - (plan.end - plan.start)) > plan.frame) return broken(`it lasts ${span.toFixed(3)}s, not ${(plan.end - plan.start).toFixed(3)}s`);
  // And decodes cleanly either side of every join.
  const zero = got.P[0];
  for (const p of plan.pieces.slice(1)) {
    const at = Math.max(0, zero + (p.first - plan.start) - 2);
    try {
      const { stderr } = await execFileAsync(cfg.ffmpegPath, ['-hide_banner', '-nostdin', '-v', 'error', '-ss', at.toFixed(3), '-t', '4',
        '-i', work.path(part), '-map', '0:v:0', '-f', 'null', '-'], { maxBuffer: 16 * 1024 * 1024 });
      if (String(stderr).trim()) return broken(`decoding at the join ${(p.first - plan.start).toFixed(1)}s: ${String(stderr).trim().split('\n')[0]}`);
    } catch (err) {
      // An exit status of its own is the decode failing; a signal, or no
      // ffmpeg started at all, is not.
      if (typeof err.code === 'number' && !err.signal) {
        return broken(`decoding at the join ${(p.first - plan.start).toFixed(1)}s failed: ${err.message}`);
      }
      return again('the joined film', err);
    }
  }
  commit(work.path(part), outPath);
  const size = fs.statSync(outPath).size;
  work.record({
    output: { name: path.basename(outPath), size, action: 'encode', segmented: true },
    convert: { ...c, joined: true, failed: null },
  });
  dropPieces(work);
  work.record({ convert: { ...c, joined: true, failed: null, chunks: [], audio: null, meta: null } });
  logger.info(`joined ${label}'s ${plan.pieces.length} pieces: ${fmtBytes(size)}`);
  onProgress?.(100, 'ready');
  checkSize(size, cfg);
  return { action: 'encode', outPath, size, segmented: true };
}
