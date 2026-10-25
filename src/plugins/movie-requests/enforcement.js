/**
 * Decide whether a message in a request group breaks the posting rules and
 * should be removed.
 *
 * The request groups are strictly "requests only, no chatting", so anything
 * that isn't a properly formatted request is noise the admins would otherwise
 * delete by hand. This module is the whole decision - pure and side-effect
 * free, so every rule below is unit-tested without touching WhatsApp.
 *
 * Returns null to leave a message alone, or { reason, detail } to delete it.
 * Being conservative matters more than being thorough here: a false positive
 * deletes a real person's message, so anything ambiguous is left alone.
 */

/** Words that make "a and b" a single title rather than two requests. */
const TITLE_JOINERS = [
  'beauty and the beast', 'lilo and stitch', 'antman and wasp', 'ant-man and the wasp',
  'fast and furious', 'lady and the tramp', 'tom and jerry', 'sherlock holmes and',
  'harold and kumar', 'dumb and dumber', 'cheech and chong', 'mr and mrs',
];

import { normalizeCommand } from './rules.js';

export function checkMessage(msg, cfg = {}, { isAdmin = false } = {}) {
  const e = cfg.enforcement ?? {};
  if (!e.enabled) return null;
  if (msg.fromMe) return null;
  if (isAdmin && e.exemptAdmins !== false) return null;

  // Never touch bot commands - the rules command must always work.
  const text = (msg.text || '').trim();
  const lower = text.toLowerCase();
  // Normalised, so "#rules)" - which is what a bracketed wa.me link pre-fills -
  // is recognised as a command and never deleted as chatter.
  const cmd = normalizeCommand(text);
  const master = (cfg.rulesCommand || '#rules').toLowerCase();
  if (cmd === master || cmd.startsWith(`${master}-`)) return null;
  if ((cfg.ruleSets ?? []).some((s) => (s.command || '').trim().toLowerCase() === cmd)) return null;

  // Non-text posts: the rules ban pictures, screenshots and voice notes.
  //
  // A message carrying TEXT is never "media", whatever its declared type. This
  // is deliberate belt-and-braces: a mis-detected type once caused 100 valid
  // text requests to be deleted, and getting this wrong destroys real people's
  // messages. Only delete when we positively recognise a media type.
  const MEDIA_TYPES = [
    'imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage',
    'documentMessage', 'documentWithCaptionMessage', 'ptvMessage',
    'ptvSurveyMessage', 'contactMessage', 'contactsArrayMessage',
    'locationMessage', 'liveLocationMessage', 'pollCreationMessage',
  ];
  if (e.deleteMedia && !text && MEDIA_TYPES.includes(msg.messageType)) {
    return { reason: 'media', detail: 'only text requests are allowed here' };
  }

  if (!text) return null;

  // Missing the required prefix -> not a request at all (chatting, thanks,
  // "yes", tagging, or a request typed the wrong way).
  if (cfg.requirePrefix && e.deleteNonRequests) {
    const p = (cfg.prefix ?? '').trim().toLowerCase();
    if (p && !lower.startsWith(p)) {
      return { reason: 'no-prefix', detail: `requests must start with ${cfg.prefix}` };
    }
  }

  // From here on it is a prefixed request; validate the body.
  const body = cfg.requirePrefix
    ? text.slice((cfg.prefix ?? '').trim().length).trim()
    : text;

  if (e.deleteNonRequests && body.length < 2) {
    return { reason: 'empty', detail: 'no movie name given' };
  }

  // Two films in one message - explicitly one at a time in the rules.
  if (e.deleteMultiple && looksLikeMultipleTitles(body)) {
    return { reason: 'multiple', detail: 'one movie per message' };
  }

  return null;
}

/**
 * Does this request name more than one film? Only flags patterns that are
 * unambiguous, because plenty of real titles contain "and" or "&".
 */
export function looksLikeMultipleTitles(body = '') {
  const s = body.trim().toLowerCase();
  if (!s) return false;

  // A known title that legitimately contains a joiner is never "multiple".
  if (TITLE_JOINERS.some((t) => s.includes(t))) return false;

  // "oceans 11 and 12", "toy story 2 and 3" - a joiner between two numbers.
  if (/\b\d+\s*(?:,|and|&|\+)\s*\d+\b/.test(s)) return true;

  // Explicit list separators: "the matrix + inception", "shrek; shrek 2".
  // Commas are deliberately NOT treated as separators - far too many real
  // titles contain one ("The Good, the Bad and the Ugly", "Crouching Tiger,
  // Hidden Dragon"), and wrongly deleting a valid request is worse than
  // leaving a rare double request for an admin to handle.
  const parts = s.split(/\s*[;+]\s*/).filter(Boolean);
  if (parts.length > 1 && parts.every((p) => p.replace(/[^a-z0-9]/g, '').length >= 3)) return true;

  return false;
}

/**
 * Strip the polite filler people put in front of a title, so the corrected
 * message we hand back is an actual searchable request. "Requesting antman
 * and wasp 2023" becomes "antman and wasp 2023" - keeping "Requesting" would
 * make our own suggestion fail the lookup.
 */
export function cleanTitle(text = '') {
  let t = String(text).trim();
  const fillers = [
    /^(?:hi|hey|hello)[\s,!.]+/i,
    // "please send X" / "pls get me X" - the politeness marker proves the verb
    // that follows is a verb, so it is safe to strip both together.
    /^(?:pls|plz|please)[\s,!.]*(?:send|post|upload|add|get|grab)?\s*(?:me\s+)?/i,
    /^(?:can|could)\s+(?:you|u|i|someone)\s+(?:please\s+)?(?:send|post|get|upload|add|do)\s*(?:me\s*)?/i,
    /^(?:i\s*(?:would\s*like|want|need)\s*(?:to\s*(?:request|watch|see)\s*)?)/i,
    /^(?:looking\s+for)\s*/i,
    /^(?:requesting|request(?:ing)?\s+for|request)\s*/i,
    // Deliberately excludes a bare "get": "Get Out" and "Get Smart" are real
    // titles. These only strip when the verb is clearly aimed at us.
    /^(?:send|post|upload|add)\s+me\s+/i,
    /^(?:get|grab)\s+me\s+/i,

    /^(?:the\s+movie|movie|film)\s+(?=\w)/i,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of fillers) {
      const next = t.replace(f, '').trim();
      if (next && next !== t) { t = next; changed = true; }
    }
  }
  // trailing politeness
  t = t.replace(/[\s,]*(?:please|pls|plz|thanks|thank\s*you|ty)\s*[!.?]*$/i, '').trim();
  return t || String(text).trim();
}

/** Human-readable note for the person whose message was removed. */

/**
 * The note PM'd to someone whose message was removed.
 *
 * A bare "your message broke the rules" leaves people guessing, so this quotes
 * what they actually wrote, names the specific rule, and - where we can work it
 * out - hands them the exact corrected message to send. For a missing prefix
 * that is simply their own text with the prefix in front, so the fix is a
 * copy-paste rather than a puzzle.
 */
export function violationNotice(check, cfg = {}, msg = {}) {
  const prefix = (cfg.prefix ?? '#request').trim();
  const rulesCmd = cfg.rulesCommand || '#rules';
  const original = String(msg?.text ?? '').trim();
  const quoted = original.length > 300 ? `${original.slice(0, 300)}…` : original;

  const lines = [];
  lines.push('*Your message in the request group was removed.*');
  lines.push('');

  if (quoted) {
    lines.push('*You wrote:*');
    lines.push(`"${quoted}"`);
    lines.push('');
  }

  switch (check?.reason) {
    case 'no-prefix':
      lines.push(`*The rule:* every request must start with *${prefix}*. Messages that don't are treated as chatting, which isn't allowed in the request group.`);
      lines.push('');
      lines.push('*Send this instead:*');
      lines.push(`${prefix} ${shorten(cleanTitle(quoted), 120)}`);
      if (!/\b(19|20)\d{2}\b/.test(quoted)) {
        lines.push('');
        lines.push('_Add the release year if you know it — it helps us find the right film._');
      }
      break;

    case 'multiple':
      lines.push('*The rule:* one movie per message. Asking for more than one at a time gets the request deleted.');
      lines.push('');
      lines.push('*Send them separately, e.g.:*');
      lines.push(`${prefix} ${splitSuggestion(quoted, prefix)}`);
      break;

    case 'media':
      lines.push('*The rule:* text only — no pictures, screenshots, voice notes, stickers or links.');
      lines.push('');
      lines.push('*Send it as plain text, e.g.:*');
      lines.push(`${prefix} The Truman Show 1998`);
      break;

    case 'empty':
      lines.push(`*The rule:* ${prefix} on its own isn't a request — it needs the movie's name.`);
      lines.push('');
      lines.push('*For example:*');
      lines.push(`${prefix} The Truman Show 1998`);
      break;

    default:
      lines.push('*The rule:* requests must follow the required format.');
      lines.push('');
      lines.push('*For example:*');
      lines.push(`${prefix} The Truman Show 1998`);
  }

  lines.push('');
  lines.push(`Send *${rulesCmd}* here for the full rules.`);
  return lines.join('\n');
}

/** Cap a suggestion: a film title is never hundreds of characters long. */
function shorten(v = '', max = 120) {
  const t = String(v).trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Turn "oceans 11 and 12" into a first-request suggestion the user can send. */
function splitSuggestion(body = '', prefix = '#request') {
  const stripped = body.replace(new RegExp(`^\\s*${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'), '').trim();
  // "oceans 11 and 12" -> "oceans 11"; otherwise fall back to the first part.
  const m = stripped.match(/^(.*?\b\d+)\s*(?:,|and|&|\+)\s*\d+\b/i);
  if (m) return m[1].trim();
  const part = stripped.split(/\s*[;+]\s*/)[0].trim();
  return part || 'The Truman Show 1998';
}
