/**
 * Send one finished file to every posts group configured for a section.
 *
 * WhatsApp has no "send to many chats" primitive, so each group is a separate
 * upload of the same local file, done sequentially - two concurrent 1.5 GB
 * uploads from this box would starve each other. A failure in one group is
 * reported but never stops the others: getting the file to two of three groups
 * beats getting it to none.
 */

/** Normalise the configured posts groups into a deduplicated list. */
export function postsTargets(cfg = {}) {
  const list = [];
  if (typeof cfg.postsGroup === 'string' && cfg.postsGroup.trim()) list.push(cfg.postsGroup.trim());
  for (const g of cfg.postsGroups ?? []) {
    if (typeof g === 'string' && g.trim()) list.push(g.trim());
  }
  return [...new Set(list)];
}

/**
 * @param send   (jid) => Promise   - performs one upload
 * @returns { sent: [jid], failed: [{ jid, error, err }] } - `error` is the
 *   message, `err` the error itself, whose code the caller may need (see
 *   noGroupPosted).
 */
export async function broadcastFile(targets, send, { onEach = null, paceMs = 0 } = {}) {
  const sent = [];
  const failed = [];
  for (let i = 0; i < targets.length; i++) {
    const jid = targets[i];
    try {
      onEach?.({ jid, index: i, total: targets.length });
      await send(jid);
      sent.push(jid);
    } catch (err) {
      failed.push({ jid, error: err?.message ?? String(err), err });
    }
    // Breathe between groups. Posting the same large file to several groups
    // back to back is exactly the burst WhatsApp notices.
    if (paceMs > 0 && i < targets.length - 1) {
      await new Promise((r) => setTimeout(r, paceMs));
    }
  }
  return { sent, failed };
}

/**
 * The error for a file that reached no group at all, keeping what the
 * individual failures were.
 *
 * It used to be a bare Error carrying only the joined messages, so a code
 * the caller acts on was lost on the way: the upload's own "not enough disk
 * space to upload ..." and "the disk filled while ... was uploading" are
 * ENOSPC (core/bot.js sendDocument), which the TV pipeline waits out and
 * retries - but as "could not post to any group: ..." with no code, an
 * episode the disk filled under at its upload was failed for good, the
 * Minority Report failure of 21:07 UTC on 2026-09-28 all over again, for
 * every episode. A film sends to its one group directly and never lost it.
 *
 * The code is the failures' own when they agree, and ENOSPC when any of
 * them was the disk: nothing was posted anywhere, so waiting for room and
 * sending again repeats nothing. `isDiskFull` is media/disk-space.js's,
 * passed in so this module stays free of the disk.
 */
export function noGroupPosted(failed, { isDiskFull = () => false } = {}) {
  const err = new Error(`could not post to any group: ${failed.map((f) => f.error).join('; ')}`);
  const causes = failed.map((f) => f.err).filter(Boolean);
  const codes = [...new Set(causes.map((e) => e?.code).filter(Boolean))];
  if (causes.some((e) => isDiskFull(e))) err.code = 'ENOSPC';
  else if (codes.length === 1 && causes.every((e) => e?.code === codes[0])) err.code = codes[0];
  if (causes.length) err.cause = causes[0];
  return err;
}
