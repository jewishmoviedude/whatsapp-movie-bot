/**
 * Resolve which rules text (if any) to reply with for an inbound message.
 *
 * Commands:
 *   #rules            master command.
 *                     - inside a group that has an assigned set -> that set's text
 *                     - in a DM (or an unassigned group) -> the master `rules`
 *                       text, or a menu of the available #rules-* commands
 *   #rules-<name>     a specific rule set, answered verbatim anywhere
 *
 * Pure and side-effect free so it can be unit-tested without a socket.
 * Returns { text, command } or null when the message isn't a rules command.
 */
/**
 * Normalise a typed command before matching.
 *
 * WhatsApp's link detection pulls a trailing ")" into a wa.me URL, so a link
 * written as "(PM the bot: …?text=%23rules)" pre-fills the message "#rules)".
 * People also type "#rules." or "#rules?". Strip that trailing punctuation
 * rather than silently ignoring somebody who asked for the rules.
 */
export function normalizeCommand(text) {
  return String(text ?? '')
    .trim()
    .replace(/[)\]}>.,!?;:'"”’]+$/u, '')
    .trim()
    .toLowerCase();
}

export function rulesReplyFor(cfg = {}, msg = {}) {
  // Off unless movieRequests.groupRules is on (the operator, 2026-10-22: remove
  // or disable the group rules feature). Off, a #rules message is an ordinary
  // message, so the request groups' own rules decide what happens to it.
  if (cfg.groupRules !== true) return null;
  const t = normalizeCommand(msg.text);
  if (!t) return null;

  // In groups only. The "PM the bot for the rules" route is gone: it existed
  // to serve text that now lives in content/rules/, and it required a wa.me
  // link carrying a hard-coded phone number in fifteen group descriptions -
  // so every number switch made all fifteen wrong at once. Asking in the
  // group still works, which is where people ask anyway.
  if (msg.isGroup === false) return null;

  const master = (cfg.rulesCommand || '#rules').toLowerCase();
  const sets = Array.isArray(cfg.ruleSets) ? cfg.ruleSets : [];

  // Exact match on a specific set command (e.g. "#rules-movies").
  const hit = sets.find((s) => (s.command || '').trim().toLowerCase() === t);
  if (hit && (hit.text || '').trim()) return { text: hit.text.trim(), command: hit.command };

  if (t === master) {
    // Inside a group with an assigned set, serve that set.
    if (msg.isGroup) {
      const assigned = cfg.groupRuleSet?.[msg.chatJid];
      if (assigned) {
        const s = sets.find((x) => (x.command || '').trim().toLowerCase() === String(assigned).trim().toLowerCase());
        if (s && (s.text || '').trim()) return { text: s.text.trim(), command: master };
      }
    }
    // Otherwise the master combined text.
    const base = (cfg.rules || '').trim();
    if (base) return { text: base, command: master };
    // Nothing combined set yet: offer a menu of the specific commands.
    const withText = sets.filter((s) => (s.command || '').trim() && (s.text || '').trim());
    if (withText.length) {
      const menu = 'Available rules — send any of these:\n' +
        withText.map((s) => `• ${s.command}${s.label ? ` — ${s.label}` : ''}`).join('\n');
      return { text: menu, command: master };
    }
  }

  return null;
}

/** True if the message text is any known rules command (master or a set). */
export function isRulesCommand(cfg = {}, msg = {}) {
  return rulesReplyFor(cfg, msg) != null;
}
