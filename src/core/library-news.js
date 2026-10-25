/**
 * What the people who look after the library say about it.
 *
 * The operator, 2026-10-09: "keep tabs on what head admin 5558100180 says on
 * discussions group for when issues are fixed so you're aware". She looks
 * after the Jellyfin library and says in the discussions group when a title
 * is added or fixed - Frieren's episodes renamed, a missing season put back.
 * Until then the bot kept only that she had posted (message-index.js keeps a
 * message's length, never its text), so nothing that follows the requests -
 * the hourly check above all - could know a fix it was waiting on had been
 * made, or tell the members who had been turned away.
 *
 * Who is watched, and where, is `libraryNews` in the settings (Settings ->
 * Library & files -> Library updates); empty means nobody. Each text message
 * from a watched number in a watched group is one line of
 * `<dataDir>/library-news.jsonl`, kept 90 days. The hourly check reads it
 * (incident-scan.js newsFindings).
 *
 * Members' issue reports too. The operator, the same day, told the
 * discussions group: "If there's an actual issue with something type #issue
 * #group01 (to reference the group if specific to that group) and explain in
 * extensive detail" - e.g. "#issue #group01 the file sent for moviename is
 * only 100mb and corrupted". A message starting #issue, from anyone, in a
 * watched group is kept the same way (kind 'issue'), with the group a
 * #groupNN names (the group whose name starts with that number), and each
 * new one is a finding the hourly check researches and fixes.
 *
 * And everything else said there. The operator, the same day: "you should
 * still take a look at the random messages but obviously if someone uses the
 * prefix that will raise your attention to that message better". Every text
 * message in a watched group is kept (kind 'chat' from anyone else), and the
 * hourly check reads them all, a complaint in passing included.
 *
 * A keeper's own #issue does not wait for the hour. The operator, 2026-10-12:
 * "Needless to say #issue tickets submitted by head admin 5558100180 get top
 * priority" and "Meaning it should activate bot to send yo a notification to
 * check right away". Her row is marked `keeper: true`, and the bot asks for
 * the check at once (check-now.js) - a file cron's every-minute tick looks
 * for, since the bot cannot start the check itself. The scan puts it first,
 * as TOP PRIORITY (incident-scan.js newsFindings).
 */
import fs from 'node:fs';
import path from 'node:path';
import log from '../util/logger.js';
import { askForCheck } from './check-now.js';
import { nextTicket } from './issue-tickets.js';

const logger = log.scope('library-news');
export const KEEP_DAYS = 90;
const DAY = 24 * 60 * 60_000;

export const newsFile = (dataDir) => path.join(dataDir, 'library-news.jsonl');

const digits = (n) => String(n ?? '').replace(/\D/g, '');

/** A member's issue report: "#issue" first, optionally "#group01". */
export const ISSUE = /^\s*#issues?\b/i;
const GROUP_REF = /#group\s?0*(\d{1,2})\b/i;

/** The number a "#group01" names, or null. */
export function groupRefOf(text) {
  const m = GROUP_REF.exec(String(text ?? ''));
  return m ? Number(m[1]) : null;
}

/** The watched numbers (digits, country code first) and groups, from the settings. */
export function newsSettings(config) {
  const c = config?.libraryNews ?? {};
  return {
    senders: new Set((Array.isArray(c.senders) ? c.senders : []).map(digits).filter((n) => n.length >= 7)),
    groups: new Set((Array.isArray(c.groups) ? c.groups : []).filter((g) => typeof g === 'string' && g.endsWith('@g.us'))),
  };
}

export class LibraryNews {
  /**
   * @param groupName (jid) => the group's name, for the record
   */
  /**
   * @param groupByNumber (n) => { jid, name } of the group whose name starts
   *   with that number ("01 MOVIE POSTS ONLY"), or null
   */
  constructor({ dataDir, configStore, groupName = () => null, groupByNumber = () => null, now = () => Date.now() }) {
    this.dataDir = dataDir;
    this.configStore = configStore;
    this.groupName = groupName;
    this.groupByNumber = groupByNumber;
    this.now = now;
    this.prunedDay = null;
  }

  /** Record `msg` (bot.js normalize()) if it is news. Returns the row, or null. */
  record(msg) {
    // An edit (bot.js normalize() `edit`) is kept as what the message says
    // now, a row of its own under the edit's own id, `edits` naming the one
    // it changed: a message edited into an #issue is one, and details added
    // by an edit reach the check (found in review, 2026-10-12).
    const text = msg?.text || msg?.edit?.text || '';
    if (!msg?.isGroup || msg.fromMe || !text || msg.reaction) return null;
    const { senders, groups } = newsSettings(this.configStore.get());
    if (!groups.has(msg.chatJid)) return null;
    const issue = ISSUE.test(text);
    const keeper = senders.has(digits(msg.senderNumber));
    const topPriority = issue && keeper;
    const ref = issue ? groupRefOf(text) : null;
    let refGroup = null;
    if (ref != null) { try { refGroup = this.groupByNumber(ref); } catch { /* named by number below */ } }
    // An #issue gets its ticket here, once. An edit of one keeps the ticket of
    // the message it changes, so the same issue is not numbered twice.
    const editedIssue = issue && msg.edit?.targetId ? this._ticketOf(msg.edit.targetId) : null;
    let ticket = null;
    if (issue) {
      try { ticket = editedIssue ?? nextTicket(this.dataDir); } catch (err) {
        // The row is kept all the same: a number that cannot be written is
        // a missing number, never a missing #issue.
        logger.warn(`could not give the #issue a ticket number: ${err.message}`);
      }
    }
    const row = {
      kind: issue ? 'issue' : keeper ? 'news' : 'chat',
      ...(ticket != null ? { ticket } : {}),
      ...(topPriority ? { keeper: true } : {}),
      ...(ref != null ? { groupRef: ref, refGroup: refGroup?.jid ?? null, refGroupName: refGroup?.name ?? null } : {}),
      at: msg.timestamp || this.now(),
      id: msg.id ?? null,
      group: msg.chatJid,
      groupName: this.groupName(msg.chatJid) ?? null,
      sender: digits(msg.senderNumber),
      name: msg.pushName ?? null,
      text: String(text).slice(0, 4000),
      ...(!msg.text && msg.edit ? { edits: msg.edit.targetId } : {}),
      // The message this one replies to (bot.js normalize() `replyTo`): an
      // #issue written as a reply is about that message - Head Admin's bare
      // "#issue #group04" of 2026-10-18 answered a member's question about
      // episodes the bot had called not in the library.
      ...(msg.replyTo?.id ? {
        replyTo: {
          id: msg.replyTo.id,
          sender: digits(msg.replyTo.senderNumber) || null,
          text: String(msg.replyTo.text ?? '').slice(0, 1500),
        },
      } : {}),
    };
    try {
      this._prune();
      fs.appendFileSync(newsFile(this.dataDir), `${JSON.stringify(row)}\n`);
      const said = `${row.name ?? row.sender} in ${row.groupName ?? row.group}: ${row.text.slice(0, 160).replace(/\s+/g, ' ')}`;
      // Chat is kept for the check, not announced: a busy group would fill the log.
      if (issue || keeper) logger.info(`${issue ? '🚩 issue from' : '📣'} ${said}`);
      else logger.debug(`💬 ${said}`);
    } catch (err) {
      logger.warn(`could not record a library update: ${err.message}`);
      return null;
    }
    // After the row, never before: a run takes the asks whose rows its scan
    // read. A failed ask costs only the "at once" - the hour's scan finds the
    // row all the same - so it is a log line, never an error in the message
    // path.
    if (topPriority) {
      const who = row.name ?? row.sender;
      try {
        askForCheck(this.dataDir, row, { now: this.now() });
        logger.info(`🚩 top-priority #issue from ${who} - the hourly check is asked to run now`);
      } catch (err) {
        logger.warn(`could not ask the hourly check to run now for ${who}'s #issue (it waits for the hour): ${err.message}`);
      }
    }
    return row;
  }

  /** The ticket of the #issue row with this message id, or null. */
  _ticketOf(id) {
    const row = readLines(newsFile(this.dataDir)).find((r) => r.id === id && r.ticket != null);
    return row?.ticket ?? null;
  }

  /** Once a day, drop what is older than KEEP_DAYS. */
  _prune() {
    const day = Math.floor(this.now() / DAY);
    if (this.prunedDay === day) return;
    this.prunedDay = day;
    const file = newsFile(this.dataDir);
    if (!fs.existsSync(file)) return;
    const cutoff = this.now() - KEEP_DAYS * DAY;
    const keep = readLines(file).filter((r) => r.at >= cutoff);
    fs.writeFileSync(file, keep.map((r) => `${JSON.stringify(r)}\n`).join(''));
  }
}

function readLines(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* a torn last line is skipped */ }
  }
  return out;
}

/** What was said between `since` and `until`, oldest first. */
export function readLibraryNews(dataDir, { since = 0, until = Infinity } = {}) {
  return readLines(newsFile(dataDir)).filter((r) => r.at >= since && r.at <= until).sort((a, b) => a.at - b.at);
}
