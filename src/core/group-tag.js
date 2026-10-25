/**
 * Turn a "{group}" placeholder in a notification into a real, tappable
 * @-mention of the posts group.
 *
 * WhatsApp renders a group mention only when both groups belong to the SAME
 * community; across communities the token is shown as raw text, which reads as
 * a bug. So an unlinked group falls back to its plain name.
 *
 * Shared by the movie and TV plugins deliberately. The TV side started as its
 * own bare sendText and quietly fell behind the movie one - no requester tag,
 * no group tag - which is exactly the drift one implementation prevents.
 */

/**
 * @param bot           the WhatsApp wrapper (needs groupCache, sameCommunity,
 *                      groupMentionToken)
 * @param body          message text, may contain "{group}"
 * @param notifyGroup   where the message is being posted
 * @param tagGroup      the group to link to, or null
 * @param enabled       false to skip tagging but still substitute a name
 * @returns {{ body: string, groupMentions: object[]|null }}
 */
export function applyGroupTag(bot, { body, notifyGroup, tagGroup, enabled = true } = {}) {
  let out = String(body ?? '');
  let groupMentions = null;

  if (enabled && tagGroup) {
    const subject = bot?.groupCache?.get?.(tagGroup)?.subject;
    if (subject) {
      if (bot.sameCommunity?.(notifyGroup, tagGroup)) {
        out = out.replace('{group}', bot.groupMentionToken(tagGroup));
        groupMentions = [{ groupJid: tagGroup, groupSubject: subject }];
      } else {
        out = out.replace('{group}', subject);
      }
    }
  }

  // Never let an unsubstituted placeholder reach a real group.
  out = out.replace('{group}', 'the posts group');
  return { body: out, groupMentions };
}
