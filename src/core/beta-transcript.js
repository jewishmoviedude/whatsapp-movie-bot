/**
 * A word-for-word record of every beta group: what testers sent, what the bot
 * answered, every edit it made to an answer, and every reaction it put on a
 * message.
 *
 * The operator (2026-09-30): "the bot likes to edit it's messages on the test
 * group but I need it all logged somewhere for you to check on the hourly
 * debug so I don't have to manually report to you, hourly debug analyze the
 * recent conversations in that group". The history row of a test keeps only
 * how it ended, and the debug log keeps what the bot decided but not what the
 * tester saw - a pick list is edited in place up to four times (a refused
 * version struck through, "replaced", "expired", the ✔), and each version is
 * gone from WhatsApp the moment the next one lands. This file is what lets
 * the hourly check (beta-scan.js) read the conversation as the testers had it.
 *
 * It is written at the bot's send, edit and react layer (src/core/bot.js), so
 * nothing a plugin says in a beta group can miss it; the plugins add only what
 * the wire cannot show - a message ignored for having no test code, and what
 * the pick list's library search found (note()).
 *
 * Main groups are never written here: only a group on the beta list at the
 * moment of the event. A tester's number is not stored either - only their
 * display name and a short keyed hash of the number, enough to tell two
 * testers apart and to see one tester asking twice, and nothing a reader
 * could turn back into the number without this box's key file.
 *
 * One JSON line per event in data/beta-transcript/YYYY-MM-DD.jsonl (UTC
 * days), pruned after the debug log's retention (14 days by default).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isBetaGroup, readBetaTest, FEATURES } from './beta.js';

export const TRANSCRIPT_DIR = 'beta-transcript';
export const DEFAULT_RETENTION_DAYS = 14;
const DAY = 86_400_000;
// A reply is long enough to say anything a member needs at this length; the
// cap is only there so one runaway message cannot fill the file.
const MAX_TEXT = 8000;
// How many recent messages are remembered, so that an answer, and every edit
// of it, carries the test code and the request it belongs to.
const MEMORY = 1000;
const FILE = /^(\d{4}-\d\d-\d\d)\.jsonl$/;

// Message types that are not something a tester said: a reaction, an edit or
// delete notice, key distribution. Recording them as said would bury the
// requests. A reaction normalize() recognised (msg.reaction) is recorded
// apart, as 'in-react' (inboundReaction); only one it could not read is
// dropped here.
const NOT_SAID = /^(reactionMessage|encReactionMessage|protocolMessage|pollUpdateMessage|editedMessage|keepInChatMessage|pinInChatMessage|senderKeyDistributionMessage|messageContextInfo)$/;

/** The UTC day a time falls on, which names its file. */
export function dayOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * A short keyed hash of a phone number: eight hex characters of an HMAC under
 * the box's own key. Unkeyed, eight characters of a hash of a ten-digit
 * number is a lookup table away from the number itself.
 */
export function hashNumber(number, key) {
  const digits = String(number ?? '').replace(/\D/g, '');
  if (!digits) return null;
  return crypto.createHmac('sha256', String(key ?? '')).update(digits).digest('hex').slice(0, 8);
}

function cut(text) {
  const s = String(text ?? '');
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}… (${s.length} characters in all)` : s;
}

export class BetaTranscript {
  /**
   * @param dataDir     the bot's data directory
   * @param getConfig   the live config, asked at every event: which groups are
   *                    beta can change at any moment
   * @param groupName   jid -> the group's name, when known
   */
  constructor({ dataDir, getConfig, groupName = () => null, now = Date.now, log = null }) {
    this.dir = path.join(dataDir, TRANSCRIPT_DIR);
    this.getConfig = getConfig;
    this.groupName = groupName;
    this.now = now;
    this.log = log;
    this._day = null;
    this._key = null;
    this._warned = false;
    // id -> { code, feature, request, sender } for recent messages in beta groups.
    this._known = new Map();
    // Pruned at start, as the debug log is; and again at each new day.
    this.prune();
  }

  _config() {
    try { return this.getConfig?.() ?? {}; } catch { return {}; }
  }

  /** Is this chat one to record now? */
  covers(jid) {
    return !!jid && isBetaGroup(this._config(), jid);
  }

  _hashKey() {
    if (this._key != null) return this._key;
    const file = path.join(this.dir, '.key');
    try {
      this._key = fs.readFileSync(file, 'utf8').trim();
    } catch {
      this._key = crypto.randomBytes(16).toString('hex');
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(file, `${this._key}\n`, { mode: 0o600 });
      } catch { /* the hashes then last as long as the process */ }
    }
    return this._key;
  }

  _remember(id, info) {
    if (!id) return;
    this._known.delete(id);
    this._known.set(id, info);
    while (this._known.size > MEMORY) this._known.delete(this._known.keys().next().value);
  }

  _write(jid, event) {
    const at = this.now();
    const row = { at: new Date(at).toISOString(), group: jid, groupName: this.groupName(jid) ?? null, ...event };
    try {
      const day = dayOf(at);
      if (day !== this._day) {
        fs.mkdirSync(this.dir, { recursive: true });
        if (this._day) this.prune();
        this._day = day;
      }
      fs.appendFileSync(path.join(this.dir, `${day}.jsonl`), `${JSON.stringify(row)}\n`);
    } catch (err) {
      // Never the reason a reply is not sent; said once, not on every event.
      if (!this._warned) this.log?.warn?.(`could not write the beta transcript: ${err.message}`);
      this._warned = true;
    }
    return row;
  }

  /** What a message sent in reply to `replyTo`, or an edit of `id`, belongs to. */
  _context(...ids) {
    for (const id of ids) {
      const k = id && this._known.get(id);
      if (k) return k;
    }
    return null;
  }

  /** A message somebody sent in a beta group, as the bot received it. */
  inbound(msg) {
    if (!msg?.isGroup || !this.covers(msg.chatJid)) return null;
    // A reaction a tester put on a message. Since a "which one?" list can be
    // answered by reacting with its number (the operator, 2026-10-01: "for
    // beta001 users should be able to react with a number emoji instead of
    // replying"), a reaction can be the whole of a pick, and without it here
    // the hourly check would see a list ticked with no answer to it. Its own
    // type, so nothing reading the bot's reactions ('react') mistakes a
    // tester's 2️⃣ for a queue position.
    if (msg.reaction) return this.inboundReaction(msg);
    if (NOT_SAID.test(msg.messageType ?? '') && !msg.text) return null;
    const test = readBetaTest(this._config(), msg.text);
    const code = test.code ?? null;
    const feature = code ? FEATURES.find((f) => f.code === code)?.key ?? null : null;
    const from = msg.fromMe
      ? { name: 'this account', id: 'self' }
      : { name: msg.pushName ?? null, id: hashNumber(msg.senderNumber ?? msg.senderJid, this._hashKey()) };
    this._remember(msg.id, { code, feature, request: msg.id, sender: from.id });
    return this._write(msg.chatJid, {
      type: 'in',
      id: msg.id ?? null,
      from,
      text: cut(msg.text),
      ...(msg.text ? {} : { messageType: msg.messageType ?? null }),
      // How the beta group reads it: a test and its code, a code that is not
      // one, or not a test at all.
      test: test.outcome === 'ignore' ? null : { outcome: test.outcome, code, typed: test.typed ?? null },
    });
  }

  /**
   * A tester's reaction: which emoji, on which message, and - from that
   * message - the test and the request it belongs to. A reaction taken off
   * never gets here (bot.js drops it).
   */
  inboundReaction(msg) {
    if (!msg?.isGroup || !msg.reaction || !this.covers(msg.chatJid)) return null;
    const on = msg.reaction.targetId ?? null;
    const ctx = this._context(on);
    const from = msg.fromMe
      ? { name: 'this account', id: 'self' }
      : { name: msg.pushName ?? null, id: hashNumber(msg.senderNumber ?? msg.senderJid, this._hashKey()) };
    return this._write(msg.chatJid, {
      type: 'in-react',
      id: msg.id ?? null,
      from,
      on,
      emoji: String(msg.reaction.emoji ?? ''),
      code: ctx?.code ?? null,
      request: ctx?.request ?? null,
    });
  }

  /** A message the bot sent into a beta group (text, or a file's caption). */
  sent(jid, { id = null, text = '', replyTo = null, document = null } = {}) {
    if (!this.covers(jid)) return null;
    const ctx = this._context(replyTo);
    this._remember(id, ctx ?? { code: null, feature: null, request: replyTo, sender: null });
    return this._write(jid, {
      type: 'out',
      id,
      replyTo,
      text: cut(text),
      ...(document ? { document } : {}),
      code: ctx?.code ?? null,
      feature: ctx?.feature ?? null,
      request: ctx?.request ?? replyTo ?? null,
    });
  }

  /** The bot rewrote one of its own messages: the new text, in full. */
  edited(jid, { of, text = '' } = {}) {
    if (!this.covers(jid)) return null;
    const ctx = this._context(of);
    return this._write(jid, {
      type: 'edit',
      of: of ?? null,
      text: cut(text),
      code: ctx?.code ?? null,
      feature: ctx?.feature ?? null,
      request: ctx?.request ?? null,
    });
  }

  /** A reaction the bot put on a message. */
  reacted(jid, { on, emoji } = {}) {
    if (!this.covers(jid)) return null;
    const ctx = this._context(on);
    return this._write(jid, {
      type: 'react', on: on ?? null, emoji: emoji ?? '', code: ctx?.code ?? null, request: ctx?.request ?? on ?? null,
    });
  }

  /** A message the bot deleted for everyone (moderation). */
  deleted(jid, { id } = {}) {
    if (!this.covers(jid)) return null;
    return this._write(jid, { type: 'delete', of: id ?? null });
  }

  /** Something the bot tried to say there and could not. */
  failed(jid, { action, replyTo = null, of = null, error = '' } = {}) {
    if (!this.covers(jid)) return null;
    const ctx = this._context(replyTo, of);
    return this._write(jid, {
      type: 'failed', action, replyTo, of, error: cut(error).slice(0, 500), code: ctx?.code ?? null, request: ctx?.request ?? null,
    });
  }

  /**
   * What the plugin knows and the wire does not: "ignored: no test code",
   * or what the pick list's library search found. `ref` is the message it
   * is about.
   */
  note(jid, { ref = null, note, ...fields } = {}) {
    if (!this.covers(jid)) return null;
    const ctx = this._context(ref);
    return this._write(jid, { type: 'note', ref, note: String(note ?? ''), code: ctx?.code ?? null, ...fields });
  }

  /** Delete the days older than the retention - the debug log's own setting. */
  prune() {
    const days = Number(this._config()?.logging?.retentionDays) || DEFAULT_RETENTION_DAYS;
    return pruneTranscript(this.dir, { now: this.now(), days });
  }
}

/** Removes transcript days older than `days`; returns the files removed. */
export function pruneTranscript(dir, { now = Date.now(), days = DEFAULT_RETENTION_DAYS } = {}) {
  const cutoff = dayOf(now - days * DAY);
  const gone = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return gone; }
  for (const n of names) {
    const m = FILE.exec(n);
    if (!m || m[1] >= cutoff) continue;
    try { fs.unlinkSync(path.join(dir, n)); gone.push(n); } catch { /* gone already */ }
  }
  return gone;
}

/**
 * The events from `since` to `until`, oldest first, read from the day files
 * that can hold them. A line that does not parse (a write cut short by a
 * crash) is skipped.
 */
export function readTranscript(dataDir, { since = 0, until = Date.now() } = {}) {
  const dir = path.join(dataDir, TRANSCRIPT_DIR);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const from = dayOf(Math.max(0, since));
  const to = dayOf(until);
  const out = [];
  for (const n of names.sort()) {
    const m = FILE.exec(n);
    if (!m || m[1] < from || m[1] > to) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(dir, n), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        const t = Date.parse(e.at);
        if (Number.isFinite(t) && t >= since && t <= until) out.push(e);
      } catch { /* a torn line */ }
    }
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
