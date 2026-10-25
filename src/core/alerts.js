import log from '../util/logger.js';
import { sendLog, emailReady } from '../util/mailer.js';

const logger = log.scope('alerts');

/**
 * Watches the log stream and emails when things go wrong.
 *
 * Throttled hard: a failing loop can produce thousands of errors a minute,
 * and the point of an alert is to tell you once, not to fill your inbox.
 * Errors that arrive during the quiet period are counted and summarised in
 * the next message rather than dropped silently.
 */
export class AlertWatcher {
  constructor({ configStore, fileLogger }) {
    this.configStore = configStore;
    this.fileLogger = fileLogger;
    this.lastSent = 0;
    this.suppressed = [];
    this.attached = false;
  }

  get cfg() { return this.configStore.get().email; }

  attach() {
    if (this.attached) return;
    this.attached = true;
    log.on('line', (entry) => {
      if (entry.level !== 'error') return;
      // Never alert about the alerting itself - that is how loops start.
      if (entry.scope === 'alerts' || entry.scope === 'mail') return;
      this.onError(entry);
    });
    logger.info('error alerting armed');
  }

  onError(entry) {
    const cfg = this.cfg;
    // With no account to send through there is nothing to try: email is on by
    // default, and a new install has none yet (emailReady).
    if (!cfg?.enabled || !cfg.onError || !emailReady(cfg)) return;

    const throttleMs = Math.max(1, cfg.errorThrottleMinutes ?? 30) * 60_000;
    const since = Date.now() - this.lastSent;

    if (since < throttleMs) {
      this.suppressed.push(entry);
      return;
    }

    this.lastSent = Date.now();
    const held = this.suppressed.splice(0, this.suppressed.length);

    const note = [
      `An error was logged by the WhatsApp bot.`,
      '',
      `  ${entry.ts}`,
      `  (${entry.scope}) ${entry.msg}`,
      '',
      held.length
        ? `${held.length} further error(s) were suppressed during the previous ${cfg.errorThrottleMinutes} minute quiet period.`
        : '',
      `Further alerts are paused for ${cfg.errorThrottleMinutes} minutes.`,
    ].filter(Boolean).join('\n');

    sendLog(cfg, {
      logText: this.fileLogger.today(),
      label: 'error alert',
      note,
    }).catch((err) => {
      // Log at warn, not error - an error here would re-enter this handler.
      logger.warn(`could not send error alert: ${err.message}`);
    });
  }

  /**
   * Email about one significant event, throttled per KIND.
   *
   * Separate from the error watcher above: a failover is not an error line in
   * the log, it is a thing that happened that someone needs to know about. The
   * throttle is per kind so a storm of one sort cannot mask another - being
   * told the bot went down should never be suppressed because it also failed
   * back twice an hour ago.
   */
  async notify({ kind, label, note, throttleMinutes = 15, attachLog = true }) {
    const cfg = this.cfg;
    if (!cfg?.enabled) return { sent: false, why: 'email is off' };
    // Switched on, as it is by default, with no account to send through: not
    // tried, and not logged as a failure (emailReady).
    if (!emailReady(cfg)) return { sent: false, why: 'email is not set up' };

    this.lastByKind ??= new Map();
    const throttleMs = Math.max(0, throttleMinutes) * 60_000;
    const last = this.lastByKind.get(kind) ?? 0;
    if (throttleMs && Date.now() - last < throttleMs) {
      return { sent: false, why: 'throttled' };
    }

    try {
      await this._deliver(cfg, {
        logText: attachLog ? this.fileLogger.today() : '',
        label,
        note,
      });
      // Only a message that actually went out starts the quiet period. Marking
      // it before delivery meant a transient SMTP failure burned the slot, and
      // the next event - possibly the one saying the bot is down - was silently
      // swallowed for the rest of the period.
      this.lastByKind.set(kind, Date.now());
      logger.info(`emailed "${label}"`);
      return { sent: true };
    } catch (err) {
      // warn, not error: an error here re-enters the error watcher.
      logger.warn(`could not send "${label}" email: ${err.message}`);
      return { sent: false, why: err.message };
    }
  }

  /** The one place mail actually leaves the process. Overridden in tests. */
  _deliver(cfg, payload) {
    return sendLog(cfg, payload);
  }

  /** Manually trigger a summary, used by the "email me the log" button. */
  async sendNow({ label = 'debug log', note = '' } = {}) {
    const cfg = this.cfg;
    if (!cfg?.enabled) throw new Error('Email is not enabled in Settings');
    return sendLog(cfg, { logText: this.fileLogger.today(), label, note });
  }
}
