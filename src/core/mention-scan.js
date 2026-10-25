/**
 * Ground truth for how WhatsApp encodes a group mention.
 *
 * Neither Baileys nor its protobuf documents the in-text token WhatsApp links
 * against, and guessing it wrong renders a raw JID to real users. Rather than
 * reason about it, pull real messages off this account and decode any that
 * carry contextInfo.groupMentions - a single genuine example, sent by the
 * official WhatsApp client, settles the convention exactly.
 */

/** Pull the text + mention metadata out of one raw message, if it has any. */
export function extractMention(raw) {
  const inner = raw?.message?.ephemeralMessage?.message
    ?? raw?.message?.viewOnceMessage?.message
    ?? raw?.message;
  if (!inner) return null;

  const ext = inner.extendedTextMessage;
  const text = ext?.text ?? inner.conversation ?? '';
  const ci = ext?.contextInfo ?? inner.contextInfo ?? null;
  const groupMentions = ci?.groupMentions ?? [];
  if (!groupMentions.length) return null;

  return {
    chatJid: raw.key?.remoteJid ?? null,
    fromMe: !!raw.key?.fromMe,
    ts: Number(raw.messageTimestamp ?? 0),
    text,
    groupMentions: groupMentions.map((g) => ({ groupJid: g.groupJid, groupSubject: g.groupSubject })),
    mentionedJid: ci?.mentionedJid ?? [],
  };
}

/** Every message in a batch that carries a group mention. */
export function scanForGroupMentions(messages = []) {
  const out = [];
  for (const raw of messages) {
    try {
      const hit = extractMention(raw);
      if (hit) out.push(hit);
    } catch { /* a malformed message must not stop the scan */ }
  }
  return out;
}

/**
 * Work out, from a real sample, what literal token the sender put in the text
 * for each mentioned group. This is the whole point of the scan: we compare the
 * candidate conventions against what WhatsApp actually produced.
 */
export function deduceTokenConvention(sample) {
  const results = [];
  for (const gm of sample.groupMentions ?? []) {
    const jid = gm.groupJid ?? '';
    const local = jid.split('@')[0];
    const candidates = [
      { name: 'full-jid', token: `@${jid}` },
      { name: 'jid-local-part', token: `@${local}` },
      { name: 'subject', token: `@${gm.groupSubject ?? ''}` },
    ];
    const present = candidates.filter((c) => c.token && sample.text.includes(c.token));
    // "@<local>" is a substring of "@<jid>", so prefer the most specific match.
    const order = { 'full-jid': 3, subject: 2, 'jid-local-part': 1 };
    present.sort((a, b) => (order[b.name] ?? 0) - (order[a.name] ?? 0));
    results.push({
      groupJid: jid,
      groupSubject: gm.groupSubject ?? null,
      matched: present[0]?.name ?? 'NONE',
      token: present[0]?.token ?? null,
      allMatches: present.map((c) => c.name),
    });
  }
  return results;
}
