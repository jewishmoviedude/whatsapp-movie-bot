/**
 * Catching a group up on requests the bot never answered.
 *
 * Why (the operator, 2026-10-06): "go into links group and process all
 * requests from 0237 edt yesterday". The bot on bot-box2 had stopped, and a
 * second number was linked on another box. The messages members sent while
 * nothing was answering do reach a newly linked bot, but only through history
 * sync, which _onMessagesUpsert deliberately ignores (type 'append') and the
 * 'messaging-history.set' handler only mined for mention samples. So nothing
 * kept them, and there was no way to hand them to the plugins.
 *
 * HistoryBuffer keeps what history sync and live traffic deliver, per group,
 * in memory and bounded. catchUpPlan() picks out of it what a catch-up would
 * hand to the plugins: messages members sent since a moment, with text, that
 * the bot has not already answered (quoted in a reply, or reacted to).
 */

/** The id of the message a raw Baileys message quotes, or null. */
export function quotedIdOf(raw) {
  const m = raw?.message;
  if (!m || typeof m !== 'object') return null;
  const inner = m.ephemeralMessage?.message ?? m;
  for (const v of Object.values(inner)) {
    const id = v && typeof v === 'object' ? v.contextInfo?.stanzaId : null;
    if (id) return id;
  }
  return null;
}

/** The id of the message a raw reaction is on, or null. */
export function reactedIdOf(raw) {
  const m = raw?.message;
  const r = (m?.ephemeralMessage?.message ?? m)?.reactionMessage;
  return r?.text ? (r.key?.id ?? null) : null;
}

export class HistoryBuffer {
  constructor({ perChat = 5000 } = {}) {
    this.perChat = perChat;
    this.chats = new Map();   // chatJid -> Map(id -> raw), oldest first
    this.done = new Set();    // ids a catch-up already handed to the plugins
  }

  add(raws) {
    for (const raw of raws ?? []) {
      const chat = raw?.key?.remoteJid;
      const id = raw?.key?.id;
      if (!chat || !id || !chat.endsWith('@g.us')) continue;
      let m = this.chats.get(chat);
      if (!m) { m = new Map(); this.chats.set(chat, m); }
      m.set(id, raw);
      if (m.size > this.perChat) m.delete(m.keys().next().value);
    }
  }

  entries(chatJid) {
    return [...(this.chats.get(chatJid)?.values() ?? [])];
  }
}

const tsOf = (raw) => Number(raw?.messageTimestamp ?? 0) * 1000;

/**
 * What a catch-up of one group would process.
 *
 *   raws       everything buffered for the group
 *   sinceMs    the moment to catch up from
 *   normalize  bot.normalize, so the plugins get what live traffic gives them
 *   done       ids an earlier catch-up already handed over
 *
 * Returns { pending, answered, oldestMs, reachesSince }: pending in the order
 * they were sent; reachesSince false when the buffer does not go back far
 * enough yet, so the list may be missing the earliest requests.
 */
export function catchUpPlan(raws, { sinceMs, normalize, done = new Set() }) {
  const answered = new Set();
  let oldestMs = Infinity;
  for (const raw of raws) {
    const t = tsOf(raw);
    if (t && t < oldestMs) oldestMs = t;
    if (!raw?.key?.fromMe) continue;
    const q = quotedIdOf(raw) ?? reactedIdOf(raw);
    if (q) answered.add(q);
  }
  const pending = [];
  const skipped = [];
  for (const raw of [...raws].sort((a, b) => tsOf(a) - tsOf(b))) {
    if (raw?.key?.fromMe || tsOf(raw) < sinceMs) continue;
    const msg = normalize(raw);
    if (!msg || msg.reaction || !msg.text) continue;
    if (answered.has(msg.id) || done.has(msg.id)) { skipped.push(msg); continue; }
    pending.push(msg);
  }
  return { pending, answered: skipped, oldestMs: oldestMs === Infinity ? null : oldestMs, reachesSince: oldestMs <= sinceMs };
}
