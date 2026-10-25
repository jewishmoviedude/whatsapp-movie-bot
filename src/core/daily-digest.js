/**
 * The once-a-day email.
 *
 * `dailySummary` and `dailySummaryHour` have been settings since the start
 * with nothing behind them, so the switch did nothing. What makes the digest
 * worth sending is the wanted list: films people asked for that resolved to a
 * real title the server does not have. That is the one thing in the day's
 * activity an admin can act on, and until now it ended at a reaction emoji.
 */
import crypto from 'node:crypto';
import log from '../util/logger.js';
import { allWanted, formatWanted } from './wanted.js';
import { listMisses, formatMisses } from './library-misses.js';
import { pickListLine } from '../plugins/movie-requests/pick-list.js';
import { emailReady } from '../util/mailer.js';

const logger = log.scope('digest');

/** Local-time hour, so "8" means 8am where the box is, not UTC. */
function hourOf(ts) {
  return new Date(ts).getHours();
}

/** The day a timestamp belongs to, for "have we already sent today?". */
export function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Should the digest go out right now?
 * Fires once on the first check at or after the configured hour. A bot that
 * was asleep or restarting at exactly 8am should still send when it wakes,
 * rather than skipping the day silently.
 */
export function isDue(cfg, { now = Date.now(), lastSent = null } = {}) {
  if (!cfg?.enabled) return false;
  const today = dayKey(now);
  if (lastSent === today) return false;              // already sent today
  return hourOf(now) >= (cfg.hour ?? 0);
}

/**
 * Assemble the digest body. `wanted` is the whole wanted list, resolved
 * entries and all: only the open ones are listed, and the ones resolved since
 * `lastSummaryAt` (the last daily summary sent, null for none) are counted.
 */
export function buildDigest({ wanted = [], misses = [], history = [], queue = null, now = Date.now(), lastSummaryAt = null } = {}) {
  const since = now - 86_400_000;
  const inWindow = history.filter((h) => (h.at ?? 0) >= since);
  // Requests from a beta group are counted on a line of their own rather than
  // in the totals. The totals describe the service the members got; an
  // afternoon of an admin testing a feature would otherwise read as a busy
  // day, or a run of deliberate test failures as an outage.
  const recent = inWindow.filter((h) => !h.beta);
  const beta = inWindow.length - recent.length;
  const count = (s) => recent.filter((h) => h.status === s).length;

  const lines = [
    `Daily summary — ${dayKey(now)}`,
    '',
    'LAST 24 HOURS',
    `  Requests handled : ${recent.length}`,
    `  Delivered        : ${count('sent')}`,
    `  Blocked          : ${count('blocked')}`,
    `  Failed           : ${count('failed') + count('error')}`,
  ];
  // Refused for asking for several films in one message, the operator's
  // one-film-per-request rule (2026-10-11): neither delivered, blocked nor
  // failed, so without a line of its own it would only swell "handled".
  const several = count('one-at-a-time');
  if (several) lines.push(`  Several at once  : ${several} (told to send one film per request)`);
  if (beta) lines.push(`  Beta tests       : ${beta} (not counted above)`);
  // The "which one?" list is judged on these numbers before it leaves the
  // beta group, so they are reported whichever group the lists were in.
  const picks = pickListLine(inWindow, { since });
  if (picks) lines.push(picks);
  if (queue) {
    lines.push(`  Waiting now      : ${queue.waiting ?? 0}`, `  Running now      : ${queue.active ?? 0}`);
  }

  lines.push('', 'WANTED — asked for, and not on the server', '');
  lines.push(formatWanted(wanted, { now, since: lastSummaryAt }));
  // Separate from WANTED on purpose. That list is a shopping list; this one is
  // a fault log - every line is a request that cleared every other gate and
  // died at the library lookup. Anything here that IS on the server is a bug,
  // and the whole point of putting it in the daily mail is that somebody
  // notices without having to go looking.
  lines.push('', 'NOT IN THE LIBRARY — refused for that reason and no other', '');
  // Only what was asked for since the last summary (or in the last 24
  // hours): old rows are the panel's, not the mail's (formatMisses).
  lines.push(formatMisses(misses, { now, since: Number.isFinite(lastSummaryAt) && lastSummaryAt > 0 ? lastSummaryAt : since }));
  lines.push('', 'The full log is attached.');
  return lines.join('\n');
}

/**
 * How long a summary that failed to send waits before it is tried again,
 * unless the email settings change first.
 *
 * A failed send is retried rather than given up for the day, but it used to
 * be retried on the very next minute's check. With the summary on by default
 * at midnight (the operator's live settings, 2026-10-12) a saved account that
 * cannot send - a normal password where Gmail wants an app password, or a
 * box whose SMTP port is blocked - was due all day: a review reproduced one
 * error and two warn lines a minute, about 1,440 failed SMTP logins a day
 * against the account. Every half hour is 48, and the summary still goes the
 * same day once whatever stopped it is fixed; a fix made in the panel is
 * tried on the next check rather than half an hour on.
 */
export const DIGEST_RETRY_MS = 30 * 60_000;

/**
 * The account a send went through, as a fingerprint: only compared, never
 * logged or stored, so the app password is not copied anywhere it could be.
 */
function mailAccountKey(e = {}) {
  const parts = ['provider', 'host', 'port', 'secure', 'user', 'appPassword', 'from', 'to'].map((k) => String(e[k] ?? ''));
  return crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);
}

/**
 * Checks once a minute whether the digest is due. A timer rather than a cron
 * expression on purpose: the bot restarts often, and a missed exact-minute
 * firing would lose the day entirely.
 */
export class DailyDigest {
  constructor({ configStore, stateStore, alerts, queue = null }) {
    this.configStore = configStore;
    this.stateStore = stateStore;
    this.alerts = alerts;
    this.queue = queue;
    this._timer = null;
    // The last failed send, { at, account }, for DIGEST_RETRY_MS. In memory:
    // a restart tries once more, which is what a restart is often for.
    this._failed = null;
  }

  // Not due without an account to send through. Email and the summary are
  // on by default (2026-10-12), at midnight, so on a new install it was due
  // on every minute's check, failed for want of an address, and said so
  // twice a minute (emailReady).
  get cfg() {
    const e = this.configStore.get().email ?? {};
    return {
      enabled: e.enabled === true && e.dailySummary === true && emailReady(e),
      hour: Number(e.dailySummaryHour ?? 0),
    };
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      this.tick().catch((err) => logger.warn(`digest check failed: ${err.message}`));
    }, 60_000);
    this._timer.unref?.();
    logger.info('daily digest armed');
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  async tick(now = Date.now()) {
    const st = this.stateStore.namespace('digest');
    if (!isDue(this.cfg, { now, lastSent: st.get('lastSent', null) })) return false;
    const account = mailAccountKey(this.configStore.get().email ?? {});
    // Said once, when it failed (below): waiting is not news every minute.
    if (this._failed && now - this._failed.at < DIGEST_RETRY_MS && this._failed.account === account) return false;

    const movies = this.stateStore.namespace('movie-requests');
    const tv = this.stateStore.namespace('tv-requests');
    const body = buildDigest({
      // Resolved entries too: the mail lists only what is still wanted, and
      // says how many were resolved since the last one went.
      wanted: allWanted(movies, { now }),
      lastSummaryAt: st.get('lastSentAt', null),
      // Both plugins keep their own store, so both are read - a TV miss is
      // exactly as much a fault as a movie one.
      misses: [...listMisses(movies), ...listMisses(tv)].sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0)),
      history: movies.get('history', []),
      // Requests, not jobs: a season is one waiting, not one per episode.
      queue: this.queue
        ? (this.queue.requestCounts?.() ?? { active: this.queue.active?.size ?? 0, waiting: this.queue.pending?.length ?? 0 })
        : null,
      now,
    });

    const res = await this.alerts.notify({
      kind: 'daily-digest',
      label: 'daily summary',
      note: body,
      throttleMinutes: 0,          // once a day already; no second gate
    });
    // Only mark the day done if it actually went. A failed send is retried
    // (DIGEST_RETRY_MS on, or at once for new email settings), not silently
    // skipped until tomorrow.
    if (res?.sent) {
      this._failed = null;
      st.set('lastSent', dayKey(now));
      // The instant, as well as the day: "resolved since the last summary"
      // counts from it.
      st.set('lastSentAt', now);
      logger.info(`daily digest sent for ${dayKey(now)}`);
    } else {
      this._failed = { at: now, account };
      logger.warn(`daily digest not sent (${res?.why ?? 'unknown'}) - will retry in `
        + `${Math.round(DIGEST_RETRY_MS / 60_000)} minutes, or as soon as the email settings change`);
    }
    return !!res?.sent;
  }
}
