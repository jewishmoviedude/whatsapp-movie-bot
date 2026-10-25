import fs from 'node:fs';
import log from '../util/logger.js';
import { DOCX_MIME, newYorkParts } from './drive-links.js';

const logger = log.scope('drive-links');

/**
 * The Google Drive Links document, posted to the group (src/core/drive-links.js
 * has the archive and the document).
 *
 * Two posts, both the operator's (2026-10-23):
 *  - every night at 00:00 New York time ("I will have the bot send an
 *    organized docx file at 12am NY time daily");
 *  - after members join, so they have what was posted before they came. The
 *    WhatsApp feature that sends history to a new member is on the phone and
 *    the bot's library has no call for it, so the document is posted in the
 *    group, tagging them. Never a private message.
 *
 * Nothing is posted while the groups are locked for Shabbos or yom tov: the
 * night's post is skipped, not made up later. A failure is tried again each
 * minute until 4 am.
 */

export const NIGHT_HOURS = 4;            // tried from 00:00 until 04:00 New York
export const JOIN_QUIET_MS = 10 * 60_000; // wait this long after the last join, so a batch is one post
export const JOIN_MIN_GAP_MS = 30 * 60_000; // and never two join posts closer than this
export const FILE_NAME = 'Google Drive Links.docx';

export class DriveLinksJob {
  /**
   * @param drive     a DriveLinks
   * @param bot       sendDocument(jid, file, opts), sendText(jid, text, {mentions}), isConnected(), numberFromJid(jid)
   * @param store     a state namespace: 'lastPostedDate', 'lastPost', 'skippedDate', 'lastError'
   * @param isLocked  () => true while the groups are locked
   */
  constructor({ drive, bot, store, isLocked = () => false, now = () => Date.now(), tickMs = 60_000 }) {
    this.drive = drive;
    this.bot = bot;
    this.store = store;
    this.isLocked = isLocked;
    this.now = now;
    this.tickMs = tickMs;
    this.pending = new Map();      // joined member jid -> mention number
    this.joinTimer = null;
    this.lastJoinPostAt = 0;
    this.busy = false;
  }

  start() {
    this._timer = setInterval(() => { this.tick().catch((err) => logger.warn(`nightly post: ${err.message}`)); }, this.tickMs);
    this._timer.unref?.();
    const c = this.drive.cfg;
    logger.info(c.enabled && c.group
      ? `Google Drive Links document: links are kept${c.post ? '; posted nightly at 00:00 New York time, and to members who join' : '; not posted (driveLinks.post is off)'}`
      : 'Google Drive Links document: off (no group chosen in driveLinks.group)');
  }

  stop() {
    clearInterval(this._timer);
    clearTimeout(this.joinTimer);
  }

  /** The nightly post: from 00:00 New York, once a day. Returns what it did, for tests. */
  async tick() {
    const c = this.drive.cfg;
    if (!c.enabled || !c.post || !c.group) return 'off';
    const ny = newYorkParts(this.now());
    if (ny.hour >= NIGHT_HOURS) return 'not-night';
    if (this.store.get('lastPostedDate', null) === ny.date) return 'posted-already';
    if (this.store.get('skippedDate', null) === ny.date) return 'skipped';
    if (this.isLocked()) {
      this.store.set('skippedDate', ny.date);
      logger.info(`Google Drive Links document not posted for ${ny.date}: the groups are locked (Shabbos or yom tov)`);
      return 'locked';
    }
    if (!this.bot.isConnected() || this.busy) return 'not-ready';
    const links = this.drive.items().length;
    if (!links) return 'empty';
    this.busy = true;
    try {
      await this._post(c.group, { caption: `Google Drive links — everything posted so far (${links} links). Updated daily at 00:00 New York time.` });
      this.store.set('lastPostedDate', ny.date);
      this.store.set('lastPost', { at: this.now(), links, kind: 'nightly' });
      this.store.set('lastError', null);
      logger.info(`📎 posted the Google Drive Links document (${links} links)`);
      return 'posted';
    } catch (err) {
      this.store.set('lastError', { at: this.now(), message: String(err.message).slice(0, 200) });
      logger.warn(`could not post the Google Drive Links document (tried again next minute): ${err.message}`);
      return 'failed';
    } finally {
      this.busy = false;
    }
  }

  /** The document, with its names fetched first, sent to `jid`. */
  async _post(jid, { caption }) {
    await this.drive.nameLinks();
    const { file, dir } = this.drive.writeDocument();
    try {
      await this.bot.sendDocument(jid, file, { fileName: FILE_NAME, mimetype: DOCX_MIME, caption });
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a temp folder */ }
    }
  }

  /**
   * The document posted to one group on request: the admin command
   * "post-drive-links", used to try it in the beta group before it goes to the
   * Drive Links group. Counts as no night's post.
   */
  async postTo(jid, caption = 'Google Drive links — everything posted so far.') {
    if (!this.bot.isConnected()) throw new Error('WhatsApp is not connected');
    const links = this.drive.items().length;
    if (!links) throw new Error('no links have been kept yet');
    await this._post(jid, { caption });
    return { links };
  }

  /** Someone was added to a group: noted if it is the Drive Links group. */
  onJoin(groupJid, jids) {
    const c = this.drive.cfg;
    if (!c.enabled || !c.post || !c.group || groupJid !== c.group) return 0;
    let n = 0;
    for (const jid of jids ?? []) {
      if (this.bot.isSelf?.(jid) || this.pending.has(jid)) continue;
      this.pending.set(jid, this.bot.numberFromJid?.(jid) ?? null);
      n += 1;
    }
    if (n) {
      clearTimeout(this.joinTimer);
      const wait = Math.max(JOIN_QUIET_MS, this.lastJoinPostAt + JOIN_MIN_GAP_MS - this.now());
      this.joinTimer = setTimeout(() => { this.flushJoins().catch((err) => logger.warn(`join post: ${err.message}`)); }, wait);
      this.joinTimer.unref?.();
    }
    return n;
  }

  /** One post for everyone who joined since the last: the document, tagging them. */
  async flushJoins() {
    const c = this.drive.cfg;
    if (!c.enabled || !c.post || !c.group || !this.pending.size) return 'nothing';
    if (this.isLocked() || !this.bot.isConnected() || !this.drive.items().length) {
      // Not now; the next join (or the nightly post) will carry them.
      this.pending.clear();
      return 'held';
    }
    const members = [...this.pending.entries()];
    this.pending.clear();
    const mentions = members.map(([jid, number]) => (number ? `${number}@s.whatsapp.net` : jid));
    const tags = members.map(([jid, number]) => `@${number ?? jid.split('@')[0]}`).join(' ');
    try {
      await this.bot.sendText(c.group, `Welcome ${tags} 👋 Here is every Google Drive link posted in this group so far, in one document. New links are added as they are posted.`, { mentions });
      await this._post(c.group, { caption: 'Google Drive links — everything posted so far.' });
      this.lastJoinPostAt = this.now();
      this.store.set('lastJoinPost', { at: this.now(), members: members.length });
      logger.info(`📎 sent the Google Drive Links document to ${members.length} new member(s)`);
      return 'posted';
    } catch (err) {
      logger.warn(`could not send the document to new members: ${err.message}`);
      return 'failed';
    }
  }
}
