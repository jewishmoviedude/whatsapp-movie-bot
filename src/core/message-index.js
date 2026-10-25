/**
 * A rolling index of recently-seen group messages, kept so that banning someone
 * can also wipe what they posted.
 *
 * WhatsApp only honours "delete for everyone" for a limited window (about two
 * days), so there is no point remembering more than that - entries older than
 * the window are pruned on every write. Only the message *key* is stored (chat,
 * id, sender), never the text: this is a moderation tool, not a message archive,
 * and the box has little spare memory.
 *
 * Each entry also carries the message's type, its length and a leading command
 * word such as `#request` - still not the text. The hourly check
 * (src/core/incident-scan.js) reads this index to find requests that got no
 * answer at all, and without these it could not tell a "#request Inception"
 * nobody answered from a member's 👍, a photo, or chatter the prefix rule
 * ignores by design: its first read of a live day flagged 104 messages, nearly
 * all of them the latter.
 */

const DAY = 86_400_000;
export const DEFAULT_WINDOW_MS = 2 * DAY;

/** Stable identity for a sender: phone number when known, else the raw JID. */
export function senderKeyOf({ senderNumber = null, senderJid = null } = {}) {
  if (senderNumber) return `num:${senderNumber}`;
  if (senderJid) return `lid:${senderJid}`;
  return null;
}

/**
 * What kind of message it was, without what it said: the type, the length of
 * any text, and its first word when that word is a command (it starts with a
 * sigil such as # or !). Everything else about the text is left behind.
 *
 * Not an @mention or a +number, though they start with a sigil too, and not
 * any word with more than two digits in it: "@19735551576 can you send me the
 * link" would otherwise have put a member's phone number into state.json, in
 * an index that promises to keep nothing of what was said. A command word
 * such as #request has no digits at all.
 */
export function messageShape(msg) {
  const text = String(msg?.text ?? '').trim();
  const first = text.split(/\s+/)[0] ?? '';
  const command = /^[^\p{L}\p{N}\s@+]/u.test(first) && (first.match(/\p{N}/gu) ?? []).length <= 2;
  return {
    y: msg?.messageType ?? null,
    n: text.length,
    ...(command ? { w: first.toLowerCase().slice(0, 24) } : {}),
  };
}

export class MessageIndex {
  /**
   * @param store   a StateStore namespace (get/set), or null to stay in-memory
   * @param windowMs how long a message stays eligible for delete-for-everyone
   * @param cap     hard ceiling on retained entries, oldest dropped first
   */
  constructor({ store = null, windowMs = DEFAULT_WINDOW_MS, cap = 20_000 } = {}) {
    this.store = store;
    this.windowMs = windowMs;
    this.cap = cap;
    this.entries = store?.get('entries', []) ?? [];
  }

  /** Record one inbound group message. Ignores DMs and our own messages. */
  record(msg, now = Date.now()) {
    if (!msg?.isGroup || msg.fromMe) return false;
    const key = senderKeyOf(msg);
    if (!key || !msg.id || !msg.chatJid) return false;
    this.entries.push({
      k: key,
      g: msg.chatJid,
      i: msg.id,
      p: msg.senderJid ?? null,
      t: msg.timestamp || now,
      ...messageShape(msg),
    });
    this.prune(now);
    this._persist();
    return true;
  }

  /** Drop anything outside the delete window, then enforce the cap. */
  prune(now = Date.now()) {
    const cutoff = now - this.windowMs;
    this.entries = this.entries.filter((e) => (e.t ?? 0) >= cutoff);
    if (this.entries.length > this.cap) {
      this.entries.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
      this.entries = this.entries.slice(this.entries.length - this.cap);
    }
    return this.entries.length;
  }

  _persist() {
    try { this.store?.set('entries', this.entries); } catch { /* best effort */ }
  }

  /**
   * Every still-deletable message from one person, newest first.
   * Matches on phone number or JID so a @lid sender is found either way.
   */
  forSender({ number = null, jid = null } = {}, now = Date.now()) {
    const cutoff = now - this.windowMs;
    const wantKeys = new Set([number && `num:${number}`, jid && `lid:${jid}`].filter(Boolean));
    return this.entries
      .filter((e) => (e.t ?? 0) >= cutoff && (wantKeys.has(e.k) || (jid && e.p === jid)))
      .sort((a, b) => (b.t ?? 0) - (a.t ?? 0))
      .map((e) => ({
        groupJid: e.g,
        key: { remoteJid: e.g, fromMe: false, id: e.i, participant: e.p ?? undefined },
        ts: e.t,
      }));
  }

  /** Forget everything recorded for one person (after their messages are wiped). */
  forget({ number = null, jid = null } = {}) {
    const drop = new Set([number && `num:${number}`, jid && `lid:${jid}`].filter(Boolean));
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !(drop.has(e.k) || (jid && e.p === jid)));
    this._persist();
    return before - this.entries.length;
  }

  get size() { return this.entries.length; }
}
