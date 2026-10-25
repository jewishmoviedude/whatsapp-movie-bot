import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import log from '../util/logger.js';
import { fmtBytes } from './ffmpeg.js';

/** "3m 20s" / "45s" - short enough to sit inside a progress line. */
export function fmtDuration(sec) {
  if (sec == null || !isFinite(sec)) return '?';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const logger = log.scope('download');

const cancelledError = () => Object.assign(new Error('cancelled'), { code: 'CANCELLED' });

/** fsync a file or a directory; not every filesystem lets a directory be synced. */
function syncPath(p) {
  let fd = null;
  try { fd = fs.openSync(p, 'r'); fs.fsyncSync(fd); } catch { /* see above */ } finally {
    if (fd != null) try { fs.closeSync(fd); } catch { /* closed */ }
  }
}

/**
 * Stream a URL to disk. Never buffers the body - a feature film will not fit
 * in this server's RAM. Reports progress when Content-Length is available.
 *
 * The bytes go to `<dest>.part`, renamed to `dest` only once all of them are
 * there - as many as the server said there would be - and synced. A body cut
 * short is an error ("download ended early"), not a finished file: it used
 * to be taken as one, with only a warning, and converted.
 *
 * `resume` ({ total, lastModified, etag }, what the caller recorded when the
 * download began) lets a download cut off by a restart or a failure go on
 * from the byte it reached, instead of from the first: The Parent Trap,
 * 2026-09-29, 2.62 GB, downloaded again from the start by a restart, twice.
 * The rest is asked for with Range and If-Range, so a server whose file has
 * changed since sends the whole new file (200) instead of the rest of the old
 * one; Jellyfin serves ranges and answers If-Range with a date. Without a
 * validator there is never a Range request - the rest of a file nobody can
 * vouch for is not worth having - and a partial with another name on it (a
 * hard link) is never appended to or truncated.
 *
 * `onResponse` is handed what the server said about the file - its length,
 * Last-Modified and ETag - before a byte of it is written: the caller records
 * it (media/work-files.js), which is what a later resume checks against. On
 * any error, a cancel included, the partial is left where it is, for the
 * caller to keep or delete; only an empty one is removed.
 */
export async function downloadToFile(url, destPath, {
  headers = {}, onProgress, signal, resume = null, onResponse = null, fetchImpl = null,
} = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const part = `${destPath}.part`;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  // What there is to go on from.
  const validator = resume?.etag || resume?.lastModified || null;
  let have = 0;
  if (validator && resume.total > 0) {
    let st = null;
    try { st = fs.lstatSync(part); } catch { /* none */ }
    if (st?.isFile() && st.nlink === 1 && st.size > 0 && st.size <= resume.total) {
      // All of it there but never renamed - killed in between: its last byte
      // is asked for again, which says whether it is still the same file.
      if (st.size === resume.total) fs.truncateSync(part, st.size - 1);
      have = Math.min(st.size, resume.total - 1);
    }
  }

  const request = async (from) => {
    const h = { ...headers };
    if (from > 0) {
      h.Range = `bytes=${from}-`;
      h['If-Range'] = resume.etag || resume.lastModified;
    }
    try {
      return await doFetch(url, { headers: h, signal, redirect: 'follow' });
    } catch (err) {
      // A cancel that lands before the server has answered comes out of fetch
      // itself as "This operation was aborted", not through the pipeline below.
      // Unmapped, deliver() took it for a real failure: "delivery failed",
      // ⚠️ and History "failed", eight times on 2026-09-28 for films an admin
      // had cancelled seconds after the 01:36 and 06:43 restarts resumed them.
      if (signal?.aborted) throw cancelledError();
      throw err;
    }
  };
  const discard = async (r) => { try { await r.body?.cancel?.(); } catch { /* already done */ } };

  let res = await request(have);
  if (have > 0) {
    if (res.status === 206) {
      const cr = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(res.headers.get('content-range') ?? '');
      if (!cr || Number(cr[1]) !== have || Number(cr[3]) !== Number(resume.total) || Number(cr[2]) !== resume.total - 1) {
        logger.warn(`${path.basename(destPath)}: asked for the rest from ${fmtBytes(have)}, the server sent `
          + `${res.headers.get('content-range') ?? 'no range'} - starting it again`);
        await discard(res);
        have = 0;
        res = await request(0);
      }
    } else if (res.status === 416) {
      logger.warn(`${path.basename(destPath)}: the server would not send the rest from ${fmtBytes(have)} - starting it again`);
      await discard(res);
      have = 0;
      res = await request(0);
    } else if (res.ok) {
      // The whole file, where the rest was asked for: the server does not
      // serve ranges, or the file is not the one the partial came from.
      const lm = res.headers.get('last-modified');
      const et = res.headers.get('etag');
      const len = Number(res.headers.get('content-length') ?? 0);
      const changed = (resume.etag && et && et !== resume.etag) || (resume.lastModified && lm && lm !== resume.lastModified)
        || (len > 0 && len !== Number(resume.total));
      logger.warn(`${path.basename(destPath)}: ${changed
        ? 'the file has changed on the server since the partial download - fetching all of it'
        : 'the server does not resume downloads - fetching all of it'}`);
      have = 0;
    }
  }
  if (!res.ok) {
    throw new Error(`download failed: HTTP ${res.status} ${res.statusText}`);
  }

  const resumed = have > 0;
  const total = resumed ? Number(resume.total) : (Number(res.headers.get('content-length') ?? 0) || null);
  // Not going on from the partial: it goes, and its going is on the disk,
  // before the caller records the file now being sent. The other way round,
  // a kill in between left a manifest vouching for the new file beside a
  // partial holding the old one's first bytes, and the next start asked for
  // the rest of the new file after them (If-Range matched the new
  // validator): a spliced source of exactly the new length, which passed
  // every check. Removed first, a kill in between leaves the old identity
  // with no partial, which the next start resets or downloads from byte 0.
  // Never truncated in place, and never through another name: a partial
  // with another name on it (a hard link) keeps its other name's bytes.
  if (!resumed) {
    fs.rmSync(part, { force: true });
    syncPath(path.dirname(part));
  }
  // What the server said about the file, before a byte is written.
  if (onResponse) {
    try {
      await onResponse({
        status: res.status, total, resumed,
        lastModified: res.headers.get('last-modified') ?? (resumed ? resume.lastModified ?? null : null),
        etag: res.headers.get('etag') ?? (resumed ? resume.etag ?? null : null),
      });
    } catch (err) {
      await discard(res);
      throw err;
    }
  }
  if (resumed) logger.info(`resuming ${path.basename(destPath)} from ${fmtBytes(have)} of ${fmtBytes(total)}`);

  let received = have;
  let lastLog = 0;
  const startedAt = Date.now();

  // Rolling window, so the reported rate reflects the last few seconds
  // rather than an average dragged down by a slow start.
  const window = [];

  // Appended to only when resumed; a fresh download writes a new file, the
  // partial having gone above.
  const out = fs.createWriteStream(part, { flags: resumed ? 'a' : 'wx' });

  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    received += chunk.length;
    const now = Date.now();

    window.push({ at: now, bytes: received });
    while (window.length > 1 && now - window[0].at > 5000) window.shift();

    if (!onProgress || now - lastLog < 700) return;
    lastLog = now;

    const span = (now - window[0].at) / 1000;
    const bytesPerSec = span > 0.5
      ? (received - window[0].bytes) / span
      : (received - have) / Math.max(0.001, (now - startedAt) / 1000);

    const pct = total ? Math.floor((received / total) * 100) : null;
    const etaSec = total && bytesPerSec > 0 ? Math.round((total - received) / bytesPerSec) : null;

    onProgress(pct, {
      stage: 'download',
      receivedBytes: received,
      totalBytes: total || null,
      bytesPerSec,
      etaSec,
      elapsedSec: Math.round((now - startedAt) / 1000),
      text: total
        ? `${fmtBytes(received)} of ${fmtBytes(total)} · ${fmtBytes(bytesPerSec)}/s${etaSec != null ? ` · ${fmtDuration(etaSec)} left` : ''}`
        : `${fmtBytes(received)} · ${fmtBytes(bytesPerSec)}/s`,
    });
  });

  try {
    await pipeline(body, out);
  } catch (err) {
    // The file is opened asynchronously, and a body that fails at once can
    // fail before it is: removed then, the file appeared a moment later and
    // stayed behind, empty. Wait for the stream to let go of it first. What
    // it holds is kept, for the caller to go on from or to delete.
    if (!out.closed) await new Promise((resolve) => { out.once('close', resolve); out.destroy(); });
    try { if (fs.statSync(part).size === 0) fs.rmSync(part, { force: true }); } catch { /* gone */ }
    if (signal?.aborted) throw cancelledError();
    throw err;
  }

  const size = fs.statSync(part).size;
  if (total && size !== total) {
    if (size > total) fs.rmSync(part, { force: true });
    throw new Error(size < total
      ? `download ended early: ${fmtBytes(size)} of ${fmtBytes(total)} (${path.basename(destPath)})`
      : `download came out longer than the server said: ${fmtBytes(size)} of ${fmtBytes(total)} (${path.basename(destPath)})`);
  }
  syncPath(part);
  fs.renameSync(part, destPath);
  syncPath(path.dirname(destPath));
  logger.info(`downloaded ${fmtBytes(size)} -> ${path.basename(destPath)}${resumed ? ` (the last ${fmtBytes(size - have)} of it just now)` : ''}`);
  return { path: destPath, size, total, resumed, from: have };
}

/** Filesystem-safe filename derived from a movie title and year. */
export function safeFilename(title, year, ext = '.mp4') {
  const base = `${title}${year ? ` (${year})` : ''}`
    .replace(/[/\\?%*:|"<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
  return `${base}${ext}`;
}
