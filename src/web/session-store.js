import fs from 'node:fs';
import path from 'node:path';
import session from 'express-session';
import log from '../util/logger.js';

const logger = log.scope('session');

/**
 * File-backed session store.
 *
 * express-session defaults to an in-memory store, which means every restart
 * silently logs everyone out - and because the API then answers 401, the UI
 * reports it as whatever the user was doing failing. Persisting sessions
 * removes a whole class of confusing "it says unauthorized" reports.
 *
 * Small enough to keep entirely in memory and mirror to one JSON file;
 * this is a single-admin control panel, not a multi-tenant service.
 */
export class FileSessionStore extends session.Store {
  constructor({ file, ttlMs = 7 * 24 * 3600 * 1000 } = {}) {
    super();
    this.file = file;
    this.ttlMs = ttlMs;
    this.sessions = new Map();
    this._timer = null;
    this._load();
  }

  _load() {
    if (!fs.existsSync(this.file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const now = Date.now();
      let restored = 0;
      for (const [sid, rec] of Object.entries(raw)) {
        if (rec.expires && rec.expires < now) continue;   // drop stale
        this.sessions.set(sid, rec);
        restored += 1;
      }
      if (restored) logger.info(`restored ${restored} session(s) across restart`);
    } catch (err) {
      logger.warn(`session file unreadable, starting fresh: ${err.message}`);
    }
  }

  _scheduleSave() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      try {
        const out = {};
        const now = Date.now();
        for (const [sid, rec] of this.sessions) {
          if (rec.expires && rec.expires < now) continue;
          out[sid] = rec;
        }
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
        fs.renameSync(tmp, this.file);
      } catch (err) {
        logger.warn(`could not persist sessions: ${err.message}`);
      }
    }, 400);
    this._timer.unref?.();
  }

  _expiryOf(sess) {
    const cookieExpires = sess?.cookie?.expires;
    if (cookieExpires) return new Date(cookieExpires).getTime();
    return Date.now() + this.ttlMs;
  }

  get(sid, cb) {
    const rec = this.sessions.get(sid);
    if (!rec) return cb(null, null);
    if (rec.expires && rec.expires < Date.now()) {
      this.sessions.delete(sid);
      this._scheduleSave();
      return cb(null, null);
    }
    let data;
    try { data = JSON.parse(rec.data); } catch { return cb(null, null); }
    cb(null, data);
  }

  set(sid, sess, cb) {
    try {
      this.sessions.set(sid, { data: JSON.stringify(sess), expires: this._expiryOf(sess) });
      this._scheduleSave();
      cb?.(null);
    } catch (err) {
      cb?.(err);
    }
  }

  touch(sid, sess, cb) {
    const rec = this.sessions.get(sid);
    if (rec) {
      rec.expires = this._expiryOf(sess);
      this._scheduleSave();
    }
    cb?.(null);
  }

  destroy(sid, cb) {
    this.sessions.delete(sid);
    this._scheduleSave();
    cb?.(null);
  }

  /**
   * Sign one account out everywhere, optionally sparing the session doing it.
   *
   * Used when a password changes. Someone changing their password because they
   * think it has been used by somebody else expects that to END the other
   * person's access - leaving those sessions alive would make the change
   * cosmetic, since the stolen cookie keeps working for its full lifetime.
   *
   * @returns the number of sessions removed
   */
  destroyUser(username, { keepSid = null } = {}) {
    const want = String(username ?? '').trim().toLowerCase();
    if (!want) return 0;
    let removed = 0;
    for (const [sid, rec] of [...this.sessions]) {
      if (sid === keepSid) continue;
      let who = null;
      try { who = JSON.parse(rec.data)?.user?.username; } catch { continue; }
      if (String(who ?? '').trim().toLowerCase() !== want) continue;
      this.sessions.delete(sid);
      removed += 1;
    }
    if (removed) this._scheduleSave();
    return removed;
  }

  length(cb) { cb(null, this.sessions.size); }

  clear(cb) {
    this.sessions.clear();
    this._scheduleSave();
    cb?.(null);
  }

  all(cb) {
    const out = [];
    for (const rec of this.sessions.values()) {
      try { out.push(JSON.parse(rec.data)); } catch { /* skip corrupt */ }
    }
    cb(null, out);
  }
}
