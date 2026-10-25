/**
 * One request message that became several requests, and the one reaction it
 * can carry.
 *
 * "The Office seasons 1-3" is three requests: a season is one place in line
 * and one row in History, as it is when asked for on its own. They share the
 * member's message, and WhatsApp keeps ONE reaction per message from the bot -
 * each new one replaces the last. Left to themselves, the three would each
 * put their own number on it (1️⃣, 2️⃣ and 3️⃣ in turn, so it showed the last
 * season's place, not the first's), season 1's ✅ would land while seasons 2
 * and 3 were still waiting, and a season that failed after it would never
 * show at all.
 *
 * So the message speaks for one season at a time: the first of its seasons,
 * in the order they were queued, that has not finished. It shows that
 * season's place in line while it waits and its stages (⬇️ ⚙️ ⬆️) while it
 * runs. When that season finishes, the next unfinished one takes over -
 * showing its own place, or the stage it has reached if it started alongside
 * (two TV episodes can run at once) - and the message shows an outcome only
 * once every season has finished: ⚠️ when any of them failed, ✅ when all of
 * them were sent, and ❌ when an admin cancelled some of it. That is the same
 * rule a single season's message follows (the notifier's ending()), taken
 * over the whole message.
 *
 * Before any season has been queued, an answer about one season - ⛔, 🤥, 📬,
 * ⚠️ - goes on the message as it would for a request on its own, so a message
 * none of whose seasons could be queued still says why. Once a season is
 * queued it speaks for the message, and the rest are answered in words (the
 * notifications group, and a reply where one is due) and in History.
 *
 * A season that was asked for and never queued - refused on its rating, not
 * on the server, the queue full, past the limit for one message - counts in
 * the ending too (refused()). It used to count for nothing: in a review's
 * harness (2026-09-29), "The Boys seasons 1-2" with season 2 refused on its
 * rating showed 🔍 🎬 1️⃣, and later ✅, and nothing a member could see said
 * season 2 was not coming. The ending is, in this order: ⚠️ when anything failed or could
 * not be added; ❌ when an admin cancelled some of it; ⛔ when a season was
 * refused on its rating; 📬 when a season is not on the server; ✅ when every
 * season was sent, or sent and partly set aside; ⏭️ when all of it was set
 * aside.
 */

/**
 * @param {object} o
 * @param {(emoji: string) => Promise<any>} o.send  reacts on the message
 * @param {{ failed: string, done: string, cancelled: string, skipped?: string,
 *           rated?: string, notInLibrary?: string }} o.R  the outcomes
 * @param {(key: string) => boolean} [o.onHandover]  show `key`'s place in line
 *        on the message; false when it is not waiting for one
 * @param {(key: string, ending: string|null) => void} [o.onEnded]  a season finished
 * @param {Array<string|null>} [o.before]  how seasons that finished before a
 *        restart ended, from the journal
 */
export function shareMessage({ send, R, onHandover = () => false, onEnded = () => {}, before = [] }) {
  const seasons = new Map();                 // key -> { last, ended, ending }
  const order = [];
  const ended = [...before];

  const owner = () => order.find((k) => !seasons.get(k).ended) ?? null;
  const outcome = () => {
    const all = [...ended, ...order.map((k) => seasons.get(k).ending)];
    if (all.includes(R.failed)) return R.failed;
    // A season's null ending is an admin's cancel (the notifier's ending()).
    if (all.some((e) => e == null || e === R.cancelled)) return R.cancelled;
    for (const e of [R.rated, R.notInLibrary]) if (e && all.includes(e)) return e;
    // A season set aside whole (⏭️) was not refused or cancelled either: an
    // admin skipped it, and the seasons that were sent still end on ✅.
    const skip = (e) => !!R.skipped && e === R.skipped;
    if (all.length && all.every((e) => e === R.done || skip(e))) return all.includes(R.done) ? R.done : R.skipped;
    return R.cancelled;
  };

  return {
    /** The season that speaks for the message now, or null. */
    owner,
    /** Has any season of the message been queued? */
    anyQueued: () => order.length > 0,

    /**
     * A react() for one season. Until join() gives it its request's key it
     * answers for that season alone (see above); after, it reaches the
     * message only while that season speaks for it.
     */
    voice() {
      let key = null;
      const react = (emoji) => {
        if (!emoji) return Promise.resolve();
        if (!key) return owner() ? Promise.resolve(false) : send(emoji);
        const st = seasons.get(key);
        if (!st.ended) st.last = emoji;
        return owner() === key ? send(emoji) : Promise.resolve(false);
      };
      return {
        react,
        /** This season has been queued, as request `k`. */
        join(k) {
          key = k;
          if (!seasons.has(k)) { seasons.set(k, { last: null, ended: false, ending: null }); order.push(k); }
        },
      };
    },

    /**
     * Seasons of the message that were answered and not queued, by what
     * each answer was (⛔, 📬 or ⚠️). They count in how the message ends.
     * When every queued season has finished already, the message has ended
     * on what was known then, and ends again, once, on this.
     */
    refused(...emojis) {
      const add = emojis.filter(Boolean);
      if (!add.length) return;
      for (const e of add) {
        ended.push(e);
        try { onEnded(null, e); } catch { /* bookkeeping only */ }
      }
      if (order.length && !owner()) send(outcome());
    },

    /**
     * Season `key` has finished, ending on `ending` (⚠️, ✅, ⏭️, or null for
     * a cancel, as the notifier's ending() says). When it was the one speaking,
     * the next takes over, or the message ends on the outcome.
     */
    concluded(key, ending) {
      const st = seasons.get(key);
      if (!st || st.ended) return;
      const spoke = owner() === key;
      st.ended = true;
      st.ending = ending ?? null;
      try { onEnded(key, st.ending); } catch { /* bookkeeping only */ }
      if (!spoke) return;
      const next = owner();
      if (!next) { send(outcome()); return; }
      const n = seasons.get(next);
      // Its place went on by another path, so a later stage of the same
      // emoji as before must not be taken for one already showing.
      if (onHandover(next)) send.forget?.();
      else if (n.last) send(n.last);
    },
  };
}
