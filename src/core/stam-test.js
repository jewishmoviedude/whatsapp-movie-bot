/**
 * $stamtest: try any request in a beta group and be told how a MAIN group
 * would answer it, in one message that can be pasted anywhere.
 *
 * The operator (2026-09-30): "if I want to test any sort of requests without
 * cluttering up the main groups I should be able to do in test group ... I'll
 * send "$stamtest #request-tv friends s03 e06, e08" and bot will respond if
 * it'll work on the main group. bots response should summarize what I wrote
 * and it's response in said response so I can copy and paste elswhere outside
 * the test group and whoever I send to will have context".
 *
 * A $betaNNN test runs one feature being tried out. A $stamtest belongs to no
 * feature: it runs the request as a main group would, with only the features
 * that are On (readBetaTest marks it `stam`, and the plugins then ask
 * isEnabled() with no group, which a Beta feature does not pass). It is still
 * a test, so nothing is downloaded, queued or posted.
 *
 * Its answer is gathered rather than rebuilt. The plugins run as for any test
 * inside runStamTest(), and while they do, bot.js hands every reaction, reply,
 * notification, edit and deletion to stamIntercept() instead of WhatsApp.
 * Afterwards the plugin manager sends ONE message: what was asked, then what
 * the bot would have done. Rebuilding the answer from each outcome instead
 * would have to know every way a film or a season can end - rated, not in
 * the library, a duplicate, a pick list, episodes held back - and would
 * drift from what the bot really says the first time one of those changed.
 *
 * The capture is an AsyncLocalStorage, so it follows the test's own awaits
 * and callbacks and nothing else: another request handled at the same moment,
 * in another group or from another tester, is sent as normal.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();

/** The code, as typed at the start of a message. */
export const STAM_CODE = 'stamtest';
const STAM_RE = /^\$stamtest(?!\w)[\s:,.;-]*([\s\S]*)$/i;

/** The request after "$stamtest", or null when the message is not one. */
export function readStamTest(text) {
  const m = STAM_RE.exec(String(text ?? '').trim());
  return m ? { body: m[1].trim() } : null;
}

/** The capture a $stamtest is running under, or null (every ordinary send). */
export function stamCapture() {
  return als.getStore() ?? null;
}

/**
 * Run `fn` with everything it would send captured. Resolves to the capture:
 * { actions: [...] } in the order they happened.
 */
export async function runStamTest(fn) {
  const cap = { actions: [], n: 0 };
  await als.run(cap, fn);
  return cap;
}

/**
 * What bot.js calls first in each method that reaches WhatsApp. Null means
 * "not a $stamtest, go on"; anything else is the method's result, as good as
 * a real one for the caller - a sent message needs a key, which later edits
 * of it (a pick list's) look for, so it gets a made-up one that
 * isStamKey() recognises.
 */
export function stamIntercept(kind, detail) {
  const cap = stamCapture();
  if (!cap) return null;
  cap.actions.push({ kind, ...detail });
  if (kind === 'text' || kind === 'document') {
    cap.n += 1;
    return { key: { id: `stam-${Date.now().toString(36)}-${cap.n}`, remoteJid: detail.jid ?? null, fromMe: true }, messageTimestamp: Math.floor(Date.now() / 1000) };
  }
  return true;
}

/**
 * A key made up by stamIntercept. An open pick list outlives its test, and
 * when it expires it edits its message - which was never sent. The edit is
 * dropped instead of going to WhatsApp with an id it has never seen.
 */
export function isStamKey(key) {
  return /^stam-/.test(String(key?.id ?? key ?? ''));
}

/**
 * The one message a $stamtest is answered with. `typed` is the request as the
 * tester wrote it after the code; `actions` what the bot would have done.
 *
 * It opens with the verdict, then the request, then each thing the bot
 * would do, so it reads on its own once pasted outside the test group. The
 * test-mode wording the plugins use ("*Test passed* ($stamtest)") is taken
 * off the replies: in a main group there is no test, only the answer.
 */
export function formatStamSummary(typed, actions, { groupJid = null, done = '✅' } = {}) {
  const reacts = actions.filter((a) => a.kind === 'react' && a.emoji).map((a) => a.emoji);
  const last = reacts[reacts.length - 1] ?? null;
  const texts = actions.filter((a) => a.kind === 'text' && a.text);
  const passed = texts.some((a) => /\*?Test passed\*?/.test(a.text)) || last === done;
  const deleted = actions.some((a) => a.kind === 'delete');

  const clean = (t) => String(t)
    .replace(/^✅ \*Test passed\*(?: \(\$\w+\))?\s*\n+/, '')
    .replace(/\s*\n?Nothing was downloaded\.?/g, '')
    .replace(/\s*\(start it with \$stamtest\)/g, '')
    .trim();

  const verdict = deleted ? '🧹 It would be deleted, not taken as a request.'
    : passed ? '✅ It would work in the main group.'
      : last ? `❌ It would not go through as asked (the bot would react ${last}).`
        : '🤐 The bot would not answer it at all.';

  const lines = [];
  for (const a of actions) {
    if (a.kind === 'text' && a.text) {
      const where = a.jid && !String(a.jid).endsWith('@g.us') ? 'Private message to the member'
        : a.quoted ? 'Reply' : (groupJid && a.jid === groupJid ? 'Notifications group' : 'Message');
      const body = clean(a.text);
      if (body) lines.push(`*${where}:*\n${body}`);
    } else if (a.kind === 'edit' && a.text) {
      lines.push(`*Then edits its message to:*\n${clean(a.text)}`);
    } else if (a.kind === 'delete') {
      lines.push('*Deletes the request* (the group\'s rules)');
    } else if (a.kind === 'document') {
      lines.push(`*Posts a file:* ${a.name ?? 'a file'}`);
    }
  }
  const parts = [
    '🧪 *Stam test* - how a main group would answer',
    verdict,
    `*Request:*\n${typed || '(nothing after $stamtest)'}`,
  ];
  if (reacts.length) parts.push(`*Reactions:* ${reacts.join(' → ')}`);
  parts.push(...lines);
  parts.push('_Tested in the test group: nothing was downloaded or sent anywhere._');
  return parts.join('\n\n');
}
