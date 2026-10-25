/**
 * Per-member activity stats for the Members roster.
 *
 * Counts only - how many messages someone has sent, where, and when they were
 * first and last seen. No message text is kept; this exists to answer "how
 * active is this person and in which groups", not to archive conversations.
 *
 * Keyed the same way the roster is (phone number when known, else @lid), and
 * records the lid<->number linkage when a message reveals both, which is what
 * lets the roster merge someone who appears as a @lid in one group and a phone
 * JID in another.
 */

export class MemberActivity {
  constructor({ store = null, maxMembers = 5000 } = {}) {
    this.store = store;
    this.maxMembers = maxMembers;
    this.data = store?.get('members', {}) ?? {};
    this._dirty = false;
  }

  /** Record one inbound group message against its sender. */
  record(msg, now = Date.now()) {
    if (!msg?.isGroup || msg.fromMe) return false;
    const number = msg.senderNumber || null;
    const lid = msg.senderJid || null;
    if (!number && !lid) return false;

    const key = number ? `num:${number}` : `lid:${lid}`;
    const ts = msg.timestamp || now;

    let e = this.data[key];
    if (!e) {
      // Someone first seen as a @lid may later resolve to a phone number.
      // Fold the old lid-keyed record into the number-keyed one so their
      // history is not split across two rows.
      if (number && lid && this.data[`lid:${lid}`]) {
        e = this.data[`lid:${lid}`];
        delete this.data[`lid:${lid}`];
        e.key = key;
      } else {
        e = { key, lid: null, number: null, name: null, msgCount: 0, firstSeen: ts, lastSeen: ts, perGroup: {} };
      }
      this.data[key] = e;
    }

    if (lid && !e.lid) e.lid = lid;
    if (number && !e.number) e.number = number;
    if (msg.pushName) e.name = msg.pushName;      // most recent display name wins

    e.msgCount++;
    if (!e.firstSeen || ts < e.firstSeen) e.firstSeen = ts;
    if (!e.lastSeen || ts > e.lastSeen) e.lastSeen = ts;

    const g = e.perGroup[msg.chatJid] ?? (e.perGroup[msg.chatJid] = { count: 0, lastSeen: 0 });
    g.count++;
    if (ts > g.lastSeen) g.lastSeen = ts;

    this._dirty = true;
    this._evictIfNeeded();
    this._persist();
    return true;
  }

  /** Keep the store bounded: drop the least-recently-active people first. */
  _evictIfNeeded() {
    const keys = Object.keys(this.data);
    if (keys.length <= this.maxMembers) return;
    keys.sort((a, b) => (this.data[a].lastSeen ?? 0) - (this.data[b].lastSeen ?? 0));
    for (const k of keys.slice(0, keys.length - this.maxMembers)) delete this.data[k];
  }

  _persist() {
    if (!this._dirty) return;
    try { this.store?.set('members', this.data); this._dirty = false; } catch { /* best effort */ }
  }

  all() { return this.data; }

  get size() { return Object.keys(this.data).length; }
}
