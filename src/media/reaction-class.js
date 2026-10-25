/**
 * How droppable a reaction is when the outbound volume budget is tight.
 *
 * Shared by the movie and TV pipelines deliberately. When only the movie side
 * had this, every TV reaction fell through to `normal` - so "which season?",
 * "not in the library" and "blocked on rating" were all shed at full
 * utilisation, which is precisely the hard constraint this was built to respect.
 * One implementation, so the two cannot drift apart again.
 *
 * Keyed by CONFIG KEY rather than by the emoji itself, so an operator editing
 * an emoji in the portal cannot silently reclassify it as droppable.
 *
 * The distinction is the one the schema already draws:
 *
 *   TERMINAL - a dead end, a question, or a completion. It is the LAST thing
 *   the requester will ever see about that request, so dropping it leaves them
 *   staring at nothing for ever. `needSeason` is the sharpest case: the bot is
 *   waiting on an answer to a question the requester was never asked, so the
 *   request deadlocks permanently. `tooFast` is next: silence there is exactly
 *   what made the throttle look broken before the notice was added.
 *
 *   LIVE - replaced by the next stage a minute later, so losing one costs
 *   nothing but a missing intermediate frame.
 *
 *   POSITION - superseded by its own next update, and positions only ever move
 *   down, so a stale one under-promises and self-corrects.
 */

/** Reactions that are the last word on a request. Never shed. */
export const TERMINAL_KEYS = [
  'rated', 'theaters', 'notFound', 'needYear', 'needSeason', 'notInLibrary',
  'failed', 'skipped', 'cancelled', 'tooFast', 'done',
  // Several films in one request: refused, and the member is to send each on
  // its own - the ☝️ is all a member outside the notifications group sees.
  'oneAtATime',
  // Written wrong (✍️): the member is to write it again.
  'writtenWrong',
];

/** Reactions superseded by their own next update. Shed first. */
export const POSITION_KEYS = ['positions', 'positionOverflow'];

/**
 * @param reactions  the merged reaction table (movie defaults + section overrides)
 * @param emoji      the emoji about to be sent
 * @returns 'critical' | 'normal' | 'low'
 */
export function reactionKind(reactions, emoji) {
  const r = reactions ?? {};
  if (!emoji) return 'normal';

  for (const k of TERMINAL_KEYS) if (r[k] && r[k] === emoji) return 'critical';

  for (const k of POSITION_KEYS) {
    const v = r[k];
    if (Array.isArray(v) ? v.includes(emoji) : v === emoji) return 'low';
  }

  // Anything unrecognised is `normal`, never `low`. Failing toward serving the
  // requester is the right direction for a bot whose failure mode is looking
  // broken, and a new reaction added later must not be silently droppable.
  return 'normal';
}

/**
 * The emoji for a 1-based place in line: 1️⃣ … 🔟 from the `positions` list,
 * then one shared overflow marker, so a long line cannot mint a new reaction
 * for every place (docs/whatsapp-ban-risk.md, 4c). Shared by the movie and TV
 * pipelines for the same reason as reactionKind.
 */
export function positionEmoji(reactions, pos) {
  const arr = reactions?.positions ?? [];
  return arr[pos - 1] ?? reactions?.positionOverflow ?? reactions?.added ?? '⏳';
}
