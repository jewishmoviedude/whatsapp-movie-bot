/**
 * Who sent the messages this number cannot decrypt.
 *
 * On 2026-10-08 the journal held about a thousand libsignal lines in two
 * hours - "SessionError: Over 2000 messages into the future!" and "Bad MAC" -
 * none of them naming a chat or a sender. Baileys does name them, in its own
 * "failed to decrypt message" line with the message key, but the bot ran
 * Baileys with a silent logger, so every one went nowhere. A message that
 * cannot be decrypted reaches the bot as an empty placeholder and is dropped,
 * so a request in it is never seen and never answered, and nobody could say
 * whose.
 *
 * baileysLogger() is the logger Baileys gets instead. It stays silent for
 * everything but that one line, which it hands to a DecryptWatch. The watch
 * logs each sender at most every ten minutes per chat and kind of failure,
 * with a count - one line where the journal had hundreds - and keeps a
 * summary for the bot-cmd channel; the hourly check reads the lines.
 */
import pino from 'pino';
import logger from '../util/logger.js';

const log = logger.scope('decrypt');

const DECRYPT_FAILED = 'failed to decrypt message';

/** A failure, by kind, in words a person reading the log can act on. */
export function failureKind(message = '') {
  const m = String(message);
  if (/into the future/i.test(m)) return 'session out of step (Over 2000 messages into the future)';
  if (/bad mac/i.test(m)) return 'session keys disagree (Bad MAC)';
  if (/no session|no open session|no sessions/i.test(m)) return 'no session with this sender';
  if (/senderkey|sender key/i.test(m)) return 'no group sender key from this sender';
  return m.slice(0, 120) || 'unknown';
}

/**
 * A pino logger, silent except for Baileys' decrypt failures, each passed to
 * `onFailure({ chat, sender, fromMe, id, error })`. Anything it cannot parse
 * is dropped, as the silent logger dropped everything.
 */
export function baileysLogger(onFailure) {
  return pino({ level: 'error' }, {
    write(line) {
      let o;
      try { o = JSON.parse(line); } catch { return; }
      if (o?.msg !== DECRYPT_FAILED) return;
      const key = o.key ?? {};
      try {
        onFailure({
          chat: key.remoteJid ?? null,
          sender: key.participant || key.remoteJid || null,
          // Under LID migration the sender is a @lid, and its phone number,
          // when WhatsApp sends one, is in a parallel field.
          senderPn: key.participantPn || key.participantAlt || key.remoteJidAlt || null,
          fromMe: !!key.fromMe,
          id: key.id ?? null,
          error: o.err?.message ?? String(o.err ?? ''),
        });
      } catch { /* a report must never break decryption */ }
    },
  });
}

export class DecryptWatch {
  /**
   * @param describe ({ chat, sender }) => { chat, sender } in words: a group's
   *   name, a member's number. The bot passes its own lookups.
   */
  /**
   * @param everyMs at most one line per sender, chat and kind this often.
   *   flush() writes out what is left between them, so every failure is in
   *   the log within everyMs, for the hourly check to count.
   */
  constructor({ describe = (x) => x, now = () => Date.now(), everyMs = 10 * 60_000, limit = 200 } = {}) {
    this.describe = describe;
    this.now = now;
    this.everyMs = everyMs;
    this.limit = limit;
    this.seen = new Map();
  }

  record({ chat, sender, senderPn = null, fromMe = false, error = '' }) {
    const kind = failureKind(error);
    const k = `${sender}|${chat}|${kind}`;
    const t = this.now();
    let row = this.seen.get(k);
    if (!row) {
      if (this.seen.size >= this.limit) this.seen.delete(this.seen.keys().next().value);
      row = { chat, sender, senderPn, fromMe, kind, count: 0, first: t, last: t, loggedAt: 0, sinceLogged: 0 };
      this.seen.set(k, row);
    }
    row.count += 1;
    row.sinceLogged += 1;
    row.last = t;
    if (senderPn) row.senderPn = senderPn;
    if (!row.loggedAt || t - row.loggedAt >= this.everyMs) this._report(row, t);
  }

  /** Log every failure not yet logged. The bot runs it every everyMs. */
  flush() {
    const t = this.now();
    for (const row of this.seen.values()) if (row.sinceLogged > 0) this._report(row, t);
  }

  _report(row, t) {
    const { chat, sender, fromMe, kind } = row;
    const d = this.describe({ chat, sender, senderPn: row.senderPn });
    // The detail is for the hourly check (incident-scan.js decryptFindings),
    // which reads it back out of the log: `failed` is how many this line
    // stands for, so the lines in an hour add up to that hour's failures.
    log.warn(`cannot decrypt messages from ${d.sender}${fromMe ? ' (this number\'s own device)' : ''}`
      + `${chat !== sender ? ` in ${d.chat}` : ' (a direct message)'}: ${kind}`
      + (row.loggedAt ? ` - ${row.sinceLogged} since the last report, ${row.count} in all` : ' - the first since the bot started'),
    { chatJid: chat, senderJid: sender, senderPn: row.senderPn ?? null, fromMe, kind, failed: row.sinceLogged, total: row.count });
    row.loggedAt = t;
    row.sinceLogged = 0;
  }

  /** Every sender seen failing, most failures first. */
  summary() {
    return [...this.seen.values()]
      .sort((a, b) => b.count - a.count)
      .map(({ chat, sender, senderPn, fromMe, kind, count, first, last }) => ({
        ...this.describe({ chat, sender, senderPn }), chatJid: chat, senderJid: sender, fromMe, kind, count, first, last,
      }));
  }
}
