import fs from 'node:fs';
import path from 'node:path';
import log from '../util/logger.js';

const logger = log.scope('state');

/** fsync a directory, so a rename in it is on the disk too. Not every filesystem allows it. */
function syncDir(dir) {
  let fd = null;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); } catch { /* see above */ } finally {
    if (fd != null) try { fs.closeSync(fd); } catch { /* closed */ }
  }
}

/**
 * Dead-simple persistent key/value store (one JSON file, debounced writes).
 * Used for request history, per-user cooldowns, and anything a plugin
 * wants to remember across restarts. Deliberately not a database - this
 * box has 900MB of RAM and the data is small.
 */
export class StateStore {
  constructor(file) {
    this.file = file;
    this.data = {};
    this._timer = null;
    this.load();
  }

  load() {
    if (fs.existsSync(this.file)) {
      try {
        this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch (err) {
        logger.error(`state file unreadable, starting fresh: ${err.message}`);
        this.data = {};
      }
    }
  }

  _scheduleSave() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      try {
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.data));
        fs.renameSync(tmp, this.file);
      } catch (err) {
        logger.error(`state save failed: ${err.message}`);
      }
    }, 500);
    this._timer.unref?.();
  }

  /**
   * Write now, at shutdown - and whole or not at all.
   *
   * It wrote straight into state.json, so a kill in the middle of it (a
   * restart that did not wait, systemd's stop timeout) left half a file, the
   * next start said "state file unreadable, starting fresh", and every
   * journalled job went with it: every film and episode a restart was meant
   * to resume from where it stopped (The Parent Trap, 2026-09-29). A
   * temporary file, synced to the disk and renamed over the old one, is the
   * old state or the new, never half of either.
   *
   * Also called by a plugin that must know a change is on the disk before it
   * does the next thing (namespace flush): a job's end is taken out of the
   * journal, and flushed, before its work directory - and the record there
   * that it was posted - is deleted. Returns whether it was written.
   */
  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    const tmp = `${this.file}.tmp`;
    let fd = null;
    try {
      fd = fs.openSync(tmp, 'w');
      fs.writeSync(fd, JSON.stringify(this.data));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmp, this.file);
      syncDir(path.dirname(this.file));
      return true;
    } catch (err) {
      if (fd != null) try { fs.closeSync(fd); } catch { /* closed */ }
      logger.error(`state flush failed: ${err.message}`);
      return false;
    }
  }

  namespace(ns) {
    if (!this.data[ns]) this.data[ns] = {};
    const self = this;
    return {
      get(key, fallback = null) {
        const v = self.data[ns][key];
        return v === undefined ? fallback : v;
      },
      set(key, value) {
        self.data[ns][key] = value;
        self._scheduleSave();
        return value;
      },
      delete(key) {
        delete self.data[ns][key];
        self._scheduleSave();
      },
      all() { return { ...self.data[ns] }; },
      /** Write the whole store now, synced (see StateStore.flush). Whether it was written. */
      flush() { return self.flush(); },
      /** Append to a capped array - handy for history logs. */
      push(key, value, cap = 200) {
        const arr = self.data[ns][key] ?? [];
        arr.unshift(value);
        if (arr.length > cap) arr.length = cap;
        self.data[ns][key] = arr;
        self._scheduleSave();
        return arr;
      },
    };
  }
}
