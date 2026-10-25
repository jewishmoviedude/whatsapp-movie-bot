/**
 * A waiting request's place in line, shown as a number reaction on the message
 * that asked for it and kept current as the line moves.
 *
 * Shared by the movie and TV pipelines, like reaction-class.js next door, so
 * the two cannot drift apart. They had: the TV side guarded against sending a
 * number twice while it waited with the pacer and the movie side did not, so
 * the films resumed after a restart were each sent their number over and over
 * - four films, sixteen reactions - because every film picked back up fired a
 * queue event while the earlier numbers were still waiting behind the 🔄s.
 *
 * `r` is the caller's record for one request, which this keeps up to date:
 *
 *   msg        the message to react on
 *   lastEmoji  what the message shows - set only once a reaction has really
 *              gone. Recorded optimistically, a shed number was believed shown
 *              and suppressed for good, freezing the requester's place.
 *   want       the number on its way through the pacer, if any
 *   target     the number the place calls for now
 *   gone       set by the caller once the request has left the line: it has
 *              started, and the stage reactions (⬇️ ⚙️ ⬆️ ✅) own the message
 *   onShown    optional, called with a number once it has really gone: the
 *              movie side journals what a member's message sent again shows
 *              (movie-requests _resendShown), so a restart does not send it
 *              the same number again
 *
 * Every number is 'low' - the next one supersedes it, so it is the first
 * thing the outbound budget drops - and asks bot.react's `unless` at its turn
 * with the pacer, which can be many seconds later. By then it may be out of
 * date: the request started (a ⬇️ overtakes a 'low' number in the pacer, and
 * the number would then sit on top of it through the whole download), or the
 * place moved again. Either way it is dropped rather than sent.
 */

/**
 * Show `emoji` as this request's place, or, given null, show nothing new -
 * the feature is off, or a beta request's group has become a main one - and
 * withdraw whatever is still waiting.
 */
export function showPlace(bot, r, emoji) {
  r.target = emoji ?? null;
  // Back to the number already showing (3rd, 2nd, 3rd again - a film ahead
  // started, then another was asked for): a 2️⃣ still waiting in the pacer is
  // now wrong. Left alone, it landed, and the message said 2nd until the next
  // time the place changed, which can be a whole film away.
  if (!emoji || emoji === r.lastEmoji) { r.want = null; return; }
  if (emoji === r.want) return;              // already on its way
  r.want = emoji;
  bot.react(r.msg, emoji, { kind: 'low', unless: () => !!r.gone || r.want !== emoji })
    .then((sent) => {
      if (r.want === emoji) r.want = null;
      if (!sent) return;                     // shed or withdrawn: the next pass tries again
      r.lastEmoji = emoji;
      try { r.onShown?.(emoji); } catch { /* the caller's record of it; the reaction itself went */ }
      // It was already past `unless`, being sent, when the place changed:
      // what it shows is out of date, so the current one follows it. Only
      // after a reaction that really went, so a budget shedding 'low' work
      // cannot turn this into a loop.
      if (!r.gone && r.target && r.target !== emoji && !r.want) showPlace(bot, r, r.target);
    }, () => { if (r.want === emoji) r.want = null; });
}
