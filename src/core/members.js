/**
 * Pure helpers for the cross-group member roster and per-member detail page.
 *
 * No WhatsApp / bot dependencies live here on purpose - everything is a plain
 * data transform so it can be unit-tested without a socket. The bot supplies
 * three raw inputs and these functions fold them together:
 *
 *   groups    [{ jid, subject, members: [{ id, number, admin }] }]  (live metadata)
 *   activity  { [key]: { key, lid, number, name, msgCount, firstSeen,
 *                        lastSeen, perGroup: { [jid]: { count, lastSeen } } } }
 *   events    [{ ts, groupJid, groupName, action, actor, actorNumber,
 *                targets: [{ jid, number }] }]  (join/leave/promote feed)
 *
 * Identity note: under WhatsApp's LID system a participant is usually an opaque
 * `…@lid` and only sometimes a phone JID. A person is keyed by phone number when
 * we know it (which also merges someone who shows as a phone JID in one group and
 * a @lid in another *if* the activity feed has linked their @lid to a number),
 * otherwise by their account-stable @lid.
 */

/*
 * Phone numbers, as a person sees them: "+" then the digits, country code
 * first, with no spaces, dashes or brackets - +15558100180, +447700900428.
 *
 * The operator (2026-10-01): "EVERYWHERE ON THE BOT NUMBERS SHOULD BE
 * FORMATTED +COUNTRYAREANUMBER NO SPACES NO DASHES NO PARENTHESIS ... I see
 * in history and queue it's got parenthesis and stuff making it un pastable
 * in the members tab". formatPhone used to write a US number as
 * "+1 (555) 804-0187", and a 10-digit one as "(555) 804-0187" with its
 * country code nowhere to be seen - a Singapore +65 number among them, since
 * WhatsApp's digits always start with the country code. Every request's
 * number went through it into History, the queue, the journals, the logs and
 * the audit log.
 *
 * What was stored in the old shape stays stored (the History rows, the
 * journals, the audit log, the log files); it is put right where it is shown,
 * by phoneOut and phonesInText. The panel's copies of these in
 * src/web/public/app.js follow the same rules, and test/phone-format.test.mjs
 * holds the two to each other.
 */

/** A number's digits as +<digits>, whatever it was written with; null when it has none. */
export function formatPhone(num) {
  const digits = String(num ?? '').replace(/[^0-9]/g, '');
  return digits ? `+${digits}` : null;
}

// A value that is nothing but a phone number, however it was written: what
// formatPhone once wrote, bare digits, or the +digits it writes now. Seven
// digits is the shortest full international number (+290 XXXX), fifteen the
// longest E.164 allows, so a name that happens to be "2024" is left alone.
const PHONE_SHAPED = /^\+?[0-9 ().-]+$/;
// A WhatsApp phone jid, device suffix or not: the number is its digits.
const PHONE_JID = /^(\d{7,15})(?::\d+)?@s\.whatsapp\.net$/;

/**
 * A value about to be shown to a person, with any phone number in it as
 * +<digits>: "+1 (555) 807-0190", "15558070190" and
 * "15558070190@s.whatsapp.net" all become "+15558070190". Anything else - a
 * name, a @lid, null - comes back as it was. For display only: jids, roster
 * keys and @mention tokens are WhatsApp's own formats and never go through it.
 */
export function phoneOut(v) {
  if (v === null || v === undefined) return v;
  const s = String(v).trim();
  const jid = s.match(PHONE_JID);
  if (jid) return `+${jid[1]}`;
  if (!PHONE_SHAPED.test(s)) return v;
  const digits = s.replace(/[^0-9]/g, '');
  return digits.length >= 7 && digits.length <= 15 ? `+${digits}` : v;
}

// The two shapes the old formatPhone wrote, wherever they sit in a sentence:
// "+1 (555) 807-0190", and "(555) 804-0187" for a number of ten digits.
const OLD_FORMATTED = /(?<![\w+])(\+1 )?\((\d{3})\) (\d{3})-(\d{4})(?!\d)/g;

/**
 * Free text - a log line, an audit entry, an error - with every number the
 * old formatPhone wrote into it rewritten as +<digits>. The text around it
 * is left exactly as it was.
 */
export function phonesInText(text) {
  if (text === null || text === undefined) return text;
  return String(text).replace(OLD_FORMATTED, (_m, one, a, b, c) => `+${one ? '1' : ''}${a}${b}${c}`);
}

/**
 * The digits to look for when a search query is a phone number - only
 * digits, spaces, +, -, ( ), with three digits or more - or null when it is
 * not one. A number is stored as bare digits and shown as +digits, and was
 * once shown as "+1 (555) 810-0180", so a pasted number has to be compared
 * digit for digit to find anyone.
 */
export function phoneQuery(q) {
  const s = String(q ?? '').trim();
  if (!PHONE_SHAPED.test(s)) return null;
  const digits = s.replace(/[^0-9]/g, '');
  return digits.length >= 3 ? digits : null;
}

/**
 * Does `text` hold the number `digits` (phoneQuery's answer), written either
 * way - as the old "+1 (555) 810-0180", as +digits, or inside a jid?
 */
export function textHasPhone(text, digits) {
  return !!digits && phonesInText(String(text ?? '')).includes(digits);
}

/**
 * The member an admin assigns a job queued by hand on the panel to.
 *
 * The operator (2026-09-30): "When i manually put an item in the queue I
 * should have the option to assign it to a member". A job queued from the
 * panel had no one behind it - History said "manual (admin)" and the
 * notifications group could not tag anyone. `key` is a roster key
 * (aggregateMembers), so only someone in one of the bot's groups can be
 * picked, never a number typed free-hand. Resolves to the requester fields a
 * request from a group carries (see the record in movie-requests _runRequest),
 * or null for no key; throws when the key is not on the roster.
 */
export function assignedMember(roster = [], key) {
  const k = String(key ?? '').trim();
  if (!k) return null;
  const m = roster.find((x) => x.key === k);
  if (!m) throw new Error('That member is not in any of the bot\'s groups any more - pick them again from the list.');
  const display = formatPhone(m.number);
  return {
    key: m.key,
    name: m.name || display || (m.id ? m.id.split('@')[0] : k),
    jid: m.id ?? (m.number ? `${m.number}@s.whatsapp.net` : null),
    number: m.number ?? null,
    display,
  };
}

/**
 * A hand-queued job's requester fields: the assigned member's when there is
 * one, with the admin who queued it kept beside them as `assignedBy`, or the
 * panel's own label when there is not.
 */
export function panelRequester(requester, member = null) {
  if (!member) return { requester, requesterJid: null, requesterNumber: null, requesterNumberDisplay: null };
  return {
    requester: member.name,
    requesterJid: member.jid,
    requesterNumber: member.number,
    requesterNumberDisplay: member.display,
    assignedBy: requester,
  };
}

/** Canonical identity key: phone number wins, else the @lid. */
export function memberKey({ number, id } = {}) {
  if (number) return `num:${number}`;
  if (id) return `lid:${id}`;
  return null;
}

/**
 * Whose request a group message is, for the queue's fair order and the
 * cooldown's "nobody else is waiting" (src/core/queue.js, `memberKey` on a
 * job): the sender's number, digits only, when WhatsApp gave it, else their
 * JID - the same key the roster gives them (memberKey above). Journalled with
 * the request, so a job resumed after a restart is still theirs.
 */
export function requestMemberKey(msg) {
  const digits = String(msg?.senderNumber ?? '').replace(/[^0-9]/g, '');
  return memberKey({ number: digits || null, id: msg?.senderJid ?? null });
}

/** Fold every group's participant list into one deduplicated roster. */
export function aggregateMembers(groups = [], activity = {}) {
  // The activity feed is the only place a @lid gets linked to a real phone
  // number (messages carry participantPn). Use that linkage to merge a person
  // who appears under both forms across different groups.
  const lidToNumber = new Map();
  for (const e of Object.values(activity)) {
    if (e && e.lid && e.number) lidToNumber.set(e.lid, e.number);
  }

  const byKey = new Map();
  for (const g of groups) {
    for (const p of g.members ?? []) {
      const number = p.number || lidToNumber.get(p.id) || null;
      const key = number ? `num:${number}` : (p.id ? `lid:${p.id}` : null);
      if (!key) continue;
      let m = byKey.get(key);
      if (!m) {
        m = { key, id: p.id ?? null, number, name: null, groups: [], adminCount: 0 };
        byKey.set(key, m);
      }
      if (!m.number && number) m.number = number;
      if (!m.id && p.id) m.id = p.id;
      // Guard against a member being listed twice in one group's metadata.
      if (!m.groups.some((x) => x.jid === g.jid)) {
        m.groups.push({ jid: g.jid, subject: g.subject, admin: p.admin ?? null });
        if (p.admin) m.adminCount++;
      }
    }
  }

  const out = [];
  for (const m of byKey.values()) {
    const a = resolveActivity(activity, m) || {};
    out.push({
      key: m.key,
      id: m.id,
      number: m.number,
      name: a.name ?? null,
      groups: m.groups,
      groupCount: m.groups.length,
      adminCount: m.adminCount,
      msgCount: a.msgCount ?? 0,
      firstSeen: a.firstSeen ?? null,
      lastSeen: a.lastSeen ?? null,
    });
  }
  // Most active first, then broadest reach, then a stable tiebreak.
  out.sort((x, y) =>
    (y.msgCount - x.msgCount) ||
    (y.groupCount - x.groupCount) ||
    String(x.key).localeCompare(String(y.key)));
  return out;
}

/** Find the activity entry for a member regardless of which key it was stored under. */
export function resolveActivity(activity = {}, member = {}) {
  if (!member) return null;
  return (
    (member.key && activity[member.key]) ||
    (member.number && activity[`num:${member.number}`]) ||
    (member.id && activity[`lid:${member.id}`]) ||
    Object.values(activity).find((e) => e &&
      ((member.id && e.lid === member.id) ||
       (member.number && e.number === member.number))) ||
    null
  );
}

/**
 * The membership timeline for one member, oldest event first. Only events that
 * happened while the bot was watching are here - anyone already in a group when
 * the bot started has no recorded join (WhatsApp does not expose historical
 * join dates), which the UI surfaces as "joined before tracking".
 */
export function memberTimeline(events = [], member = {}) {
  const lid = member.id;
  const number = member.number;
  const hits = [];
  for (const ev of events) {
    const hit = (ev.targets ?? []).some((t) =>
      (lid && t.jid === lid) || (number && t.number === number));
    if (!hit) continue;
    hits.push({
      ts: ev.ts,
      action: ev.action,
      groupJid: ev.groupJid,
      groupName: ev.groupName,
      by: ev.actorNumber ? `+${ev.actorNumber}` : (ev.actor ?? null),
    });
  }
  hits.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  return hits;
}

/** Full detail payload for one member: roster fields + timeline + per-group activity. */
export function memberDetail({ member, events = [], activity = {} } = {}) {
  const entry = resolveActivity(activity, member);
  return {
    ...member,
    timeline: memberTimeline(events, member),
    perGroup: entry?.perGroup ?? {},
  };
}
