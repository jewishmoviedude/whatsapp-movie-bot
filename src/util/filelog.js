import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Persistent debug log.
 *
 * The in-memory ring buffer behind the Logs tab only holds the last few
 * hundred lines and dies with the process - useless for working out what
 * happened overnight. This writes everything to a dated file on disk, always
 * at debug level regardless of what the console is set to, so a problem can
 * be investigated after the fact.
 *
 * Files rotate daily and are gzipped after a day, with old ones pruned.
 */
export class FileLogger {
  constructor({ dir, retentionDays = 14, maxBytes = 32 * 1024 * 1024 } = {}) {
    this.dir = dir;
    this.retentionDays = retentionDays;
    this.maxBytes = maxBytes;
    this.fd = null;
    this.currentDay = null;
    this.written = 0;
    this.part = 0;
    fs.mkdirSync(dir, { recursive: true });
    this.prune();
  }

  static dayStamp(d = new Date()) {
    return d.toISOString().slice(0, 10);
  }

  fileFor(day, part = 0) {
    return path.join(this.dir, part ? `debug-${day}.${part}.log` : `debug-${day}.log`);
  }

  _ensureFd() {
    const day = FileLogger.dayStamp();

    if (this.currentDay !== day) {
      this._closeFd();
      this.currentDay = day;
      this.part = 0;
      // Continue an existing file for today rather than clobbering it.
      while (fs.existsSync(this.fileFor(day, this.part))
             && fs.statSync(this.fileFor(day, this.part)).size >= this.maxBytes) {
        this.part += 1;
      }
      const f = this.fileFor(day, this.part);
      this.written = fs.existsSync(f) ? fs.statSync(f).size : 0;
      this.fd = fs.openSync(f, 'a');
      this.compressOlder();
      this.prune();
    }

    // Roll over within the day if a single file gets huge.
    if (this.written >= this.maxBytes) {
      this._closeFd();
      this.part += 1;
      this.written = 0;
      this.fd = fs.openSync(this.fileFor(this.currentDay, this.part), 'a');
    }

    return this.fd;
  }

  _closeFd() {
    if (this.fd !== null) {
      try { fs.closeSync(this.fd); } catch { /* already gone */ }
      this.fd = null;
    }
  }

  /**
   * Writes are synchronous on purpose. A debug log whose last lines are lost
   * in a buffer when the process dies is worthless precisely when it matters
   * most, and the fd is held open so this is a single write syscall, not an
   * open/write/close each time.
   */
  write(entry) {
    try {
      const fd = this._ensureFd();
      let line = `${entry.ts} [${entry.level.toUpperCase().padEnd(5)}] (${entry.scope}) ${entry.msg}`;
      if (entry.extra !== undefined && entry.extra !== null) {
        let extra;
        try {
          extra = typeof entry.extra === 'string' ? entry.extra : JSON.stringify(entry.extra);
        } catch { extra = String(entry.extra); }
        if (extra && extra !== '{}') line += ` | ${extra}`;
      }
      line += '\n';
      fs.writeSync(fd, line);
      this.written += Buffer.byteLength(line);
    } catch {
      // Logging must never take the app down.
    }
  }

  /** Newest-first list of log files with sizes. */
  list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir)
      .filter((f) => /^debug-\d{4}-\d{2}-\d{2}(\.\d+)?\.log(\.gz)?$/.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(this.dir, f));
        return { name: f, size: st.size, mtime: st.mtimeMs, gzipped: f.endsWith('.gz') };
      })
      .sort((a, b) => b.mtime - a.mtime);
  }

  /** Read a log file back, transparently handling gzip. */
  read(name, { maxBytes = 5 * 1024 * 1024 } = {}) {
    if (!/^debug-\d{4}-\d{2}-\d{2}(\.\d+)?\.log(\.gz)?$/.test(name)) {
      throw new Error('bad log filename');
    }
    const p = path.join(this.dir, name);
    if (!fs.existsSync(p)) throw new Error('no such log file');

    let buf = fs.readFileSync(p);
    if (name.endsWith('.gz')) buf = zlib.gunzipSync(buf);
    if (buf.length > maxBytes) {
      // Keep the tail - the end of a log is where the failure is.
      buf = buf.subarray(buf.length - maxBytes);
      return `... truncated, showing the last ${Math.round(maxBytes / 1024)} KB ...\n` + buf.toString('utf8');
    }
    return buf.toString('utf8');
  }

  /** The current day's log, for emailing or downloading. */
  today() {
    const day = FileLogger.dayStamp();
    const parts = this.list().filter((f) => f.name.startsWith(`debug-${day}`) && !f.gzipped);
    if (!parts.length) return '';
    return parts.reverse().map((f) => this.read(f.name)).join('');
  }

  /** Gzip anything that is not today's file. */
  compressOlder() {
    const day = FileLogger.dayStamp();
    for (const f of this.list()) {
      if (f.gzipped || f.name.startsWith(`debug-${day}`)) continue;
      const src = path.join(this.dir, f.name);
      try {
        fs.writeFileSync(`${src}.gz`, zlib.gzipSync(fs.readFileSync(src)));
        fs.rmSync(src, { force: true });
      } catch { /* not worth failing over */ }
    }
  }

  prune() {
    const cutoff = Date.now() - this.retentionDays * 86400_000;
    for (const f of this.list()) {
      if (f.mtime < cutoff) {
        try { fs.rmSync(path.join(this.dir, f.name), { force: true }); } catch {}
      }
    }
  }

  close() {
    this._closeFd();
  }
}
