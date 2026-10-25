import { EventEmitter } from 'node:events';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const RING_SIZE = 500;

/**
 * Tiny logger that keeps a ring buffer so the web UI can show recent
 * activity without tailing a file, and emits every line for live streaming.
 */
class Logger extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    this.ring = [];
    this.sink = null;
    this.level = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;
  }

  /**
   * Attach a persistent sink. It receives EVERY entry regardless of the
   * console level, so the file on disk is always a full debug trace even
   * when the console is set to info.
   */
  setSink(sink) {
    this.sink = sink;
  }

  _write(level, scope, msg, extra) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      scope,
      msg: String(msg),
      ...(extra !== undefined && extra !== null ? { extra } : {}),
    };

    // The file always gets everything; the console and UI respect the level.
    try { this.sink?.write(entry); } catch { /* never let logging break the app */ }

    if (LEVELS[level] < this.level) return;

    this.ring.push(entry);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    const line = `${entry.ts} [${level.toUpperCase()}] (${scope}) ${entry.msg}`;
    (level === 'error' ? console.error : console.log)(line, extra ?? '');
    this.emit('line', entry);
  }

  recent(n = 200) {
    return this.ring.slice(-n);
  }

  /** Namespaced child logger, e.g. log.scope('bot').info('connected') */
  scope(name) {
    return {
      debug: (m, e) => this._write('debug', name, m, e),
      info: (m, e) => this._write('info', name, m, e),
      warn: (m, e) => this._write('warn', name, m, e),
      error: (m, e) => this._write('error', name, m, e),
    };
  }
}

export const log = new Logger();
export default log;
