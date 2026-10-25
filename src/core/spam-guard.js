import log from '../util/logger.js';
import { isPrivateGroupName } from './bot.js';

const logger = log.scope('spam-guard');

/**
 * A member flooding a group - stickers, pictures or chatter, one after
 * another - locks that group (admins-only) and says so in one message.
 *
 * The operator, 2026-10-21: "if someone goes rogue on one of the request
 * chats and start spamming random stickers or messages then the bot can
 * detect that and lock the chat", in every open group, at once and without
 * beta; "Chat should get locked and one message"; no messages deleted and
 * nobody removed, since each of those is a WhatsApp call per message or
 * member and hard to undo; and no automatic unlock - a person reopens it.
 *
 * Seeing the flood costs nothing: every message reaches the bot anyway, and
 * this only counts them. Answering it is two calls per incident, the lock
 * and the notice, however many messages the flood was.
 *
 * The windows are measured on each message's own timestamp, not on when it
 * reached the bot. After a reconnect WhatsApp hands over what was missed in
 * one burst, and an hour of ordinary messages arriving in a second is not a
 * flood.
 *
 * A held group stays held until somebody opens it: an admin in WhatsApp
 * (groups.update with announce off), or the panel's per-group unlock. The
 * Shabbos and yom tov unlock skips it (`isHeld`, read by _runLockdown in
 * bot.js), or havdalah would reopen it to the person who flooded it.
 */
export const SPAM_DEFAULTS = {
  enabled: true,
  // One member: this many messages within the window. A request group takes
  // one request an hour, and even a lively chat rarely has one person send
  // ten messages in a minute.
  perSender: 10,
  // Stickers, pictures, voice notes and the rest: fewer, since these are what
  // a spammer sends and what nobody sends six of in a minute by accident.
  perSenderMedia: 6,
  // The whole group, members only: several numbers flooding together.
  perGroup: 30,
  perGroupSenders: 3,
  windowSec: 60,
  notice: '🔒 This group has been locked because of spam. An admin will reopen it.',
};

// Content that is not a message a member typed or posted: an edit, a delete,
// a reaction. None of it adds a line to the chat.
const NOT_POSTS = new Set(['protocolMessage', 'reactionMessage', 'senderKeyDistributionMessage', 'messageContextInfo']);
const MEDIA = new Set([
  'imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage',
  'documentWithCaptionMessage', 'ptvMessage', 'lottieStickerMessage',
]);

export function spamConfig(cfg) {
  return { ...SPAM_DEFAULTS, ...(cfg?.spamGuard ?? {}) };
}

export class SpamGuard {
  /**
   * @param store     a state namespace; 'held' maps group jid -> why it was locked
   * @param getConfig the whole config
   * @param isAdmin   (groupJid, senderJid, senderNumber) -> boolean
   * @param groupName (groupJid) -> subject
   * @param lock      async (groupJid, incident) -> locks the group and posts the notice
   */
  constructor({ store, getConfig, isAdmin = () => false, groupName = () => null, lock, now = () => Date.now() }) {
    this.store = store;
    this.getConfig = getConfig;
    this.isAdmin = isAdmin;
    this.groupName = groupName;
    this.lock = lock;
    this.now = now;
    this.seen = new Map();      // group jid -> [{ at, sender, media }]
    this.locking = new Set();   // groups whose lock is in flight
    this.failedAt = new Map();  // group jid -> when a lock last failed
  }

  held() { return this.store.get('held', {}) ?? {}; }
  isHeld(jid) { return !!this.held()[jid]; }

  /** Opened by a person: the group counts afresh from here. */
  release(jid, by = 'an admin') {
    const held = this.held();
    if (!held[jid]) return false;
    delete held[jid];
    this.store.set('held', held);
    this.seen.delete(jid);
    logger.info(`🔓 "${this.groupName(jid) ?? jid}" was reopened by ${by} - the spam lock is lifted`);
    return true;
  }

  /**
   * Count one message. Returns the incident when this message is the one that
   * tips the group over, after starting the lock; null otherwise.
   */
  observe(msg) {
    const cfg = spamConfig(this.getConfig());
    if (!cfg.enabled || !msg?.isGroup || msg.fromMe || msg.catchUp) return null;
    if (msg.reaction || msg.edit || NOT_POSTS.has(msg.messageType)) return null;
    const jid = msg.chatJid;
    const subject = this.groupName(jid);
    // A "$" group is a private back-channel, outside the member tools.
    if (isPrivateGroupName(subject)) return null;
    if (this.isHeld(jid) || this.locking.has(jid)) return null;
    if (this.isAdmin(jid, msg.senderJid, msg.senderNumber)) return null;

    const now = this.now();
    const windowMs = Math.max(10, Number(cfg.windowSec) || 60) * 1000;
    // A message older than the window, handed over late, cannot be part of a
    // flood happening now.
    const at = msg.timestamp > 0 ? Math.min(msg.timestamp, now) : now;
    if (at < now - windowMs) return null;

    const sender = msg.senderNumber || msg.senderJid || '?';
    const media = MEDIA.has(msg.messageType) && !msg.text;
    const list = (this.seen.get(jid) ?? []).filter((m) => m.at > now - windowMs);
    list.push({ at, sender, media });
    this.seen.set(jid, list);
    this._prune(now - windowMs);

    const mine = list.filter((m) => m.sender === sender);
    const senders = new Set(list.map((m) => m.sender));
    let why = null;
    if (mine.length >= cfg.perSender) why = `${mine.length} messages from one member in ${cfg.windowSec}s`;
    else if (mine.filter((m) => m.media).length >= cfg.perSenderMedia) {
      why = `${mine.filter((m) => m.media).length} stickers or pictures from one member in ${cfg.windowSec}s`;
    } else if (list.length >= cfg.perGroup && senders.size >= cfg.perGroupSenders) {
      why = `${list.length} messages from ${senders.size} members in ${cfg.windowSec}s`;
    }
    if (!why) return null;

    // A lock that failed (the bot not an admin there, say) is not retried on
    // every further message of the same flood: once in ten minutes.
    if (now - (this.failedAt.get(jid) ?? 0) < 10 * 60_000) return null;

    const top = [...senders].map((s) => [s, list.filter((m) => m.sender === s).length]).sort((a, b) => b[1] - a[1]);
    const incident = { jid, group: subject ?? jid, why, at: now, senders: top.slice(0, 5).map(([s, n]) => ({ sender: s, count: n })) };
    this.locking.add(jid);
    Promise.resolve()
      .then(() => this.lock(jid, incident))
      .then(() => {
        const held = this.held();
        held[jid] = incident;
        this.store.set('held', held);
        this.seen.delete(jid);
      })
      .catch((err) => {
        this.failedAt.set(jid, this.now());
        logger.error(`could not lock "${incident.group}" against spam (${why}): ${err.message}`);
      })
      .finally(() => this.locking.delete(jid));
    return incident;
  }

  _prune(before) {
    for (const [jid, list] of this.seen) {
      if (!list.length || list[list.length - 1].at <= before) this.seen.delete(jid);
    }
  }
}
