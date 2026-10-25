/**
 * Putting work that was already accepted back in the queue - after a
 * transient failure, and after a restart. Shared by the movie and TV
 * pipelines, so the two answer these questions the same way.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Failures worth another attempt: the connection, the network or a file that
 * went missing under us, rather than anything wrong with the job itself.
 *
 * These are the strings production actually produces. The original list
 * matched almost none of them, so the most expensive possible moment to fail -
 * after a multi-gigabyte download and a 20-minute encode - was treated as
 * permanent and the work thrown away.
 */
/*
 * Four of these are the bot's own. "ended early" is a download that stopped
 * short of the length the server gave (download.js): its partial is kept and
 * the retry goes on from the byte it reached. "could not reach the library"
 * is the question asked before resuming a job's kept work - is the library's
 * file still the one it was made from (work-files.js verifyIdentity) - going
 * unanswered: the job waits with its files rather than throwing them away on
 * a guess. "pieces could not be joined" is a segmented encode whose source
 * had already gone (segmented.js): it is fetched and converted again. "could
 * not be made this time" is a piece, the sound or the join of a segmented
 * encode whose ffmpeg died or could not start (segmented.js failedOnce): the
 * retry goes on from the pieces made. SOURCE_VANISHED is a download that
 * went missing, or a library file read in place that was replaced during
 * its encode: the retry looks the film up again. "download failed: HTTP 502"
 * (also 503, 504, 429) is the library's proxy having a bad second: Daredevil
 * S02E09 failed for good on a 502 at 08:45 on 2026-10-02 while the episodes
 * either side of it downloaded fine, and the requester was left one short.
 * "Jellyfin did not respond within 30s" is a library that is slow for a
 * minute as the bot starts: Taken (2008) was failed for good on it while
 * resuming after the 04:05 restart on 2026-10-20, though its download and
 * half its encode were kept (the wanted recheck got the same timeout).
 */
export const TRANSIENT_ERROR = /not connected|ECONNRESET|ETIMEDOUT|ENETUNREACH|ECONNREFUSED|EPIPE|socket hang up|EAI_AGAIN|rate.?overlimit|Connection Closed|terminated|fetch failed|Timed Out|ENOENT|SOURCE_VANISHED|ended early|could not reach the library|did not respond within \d+s|pieces could not be joined|could not be made this time|download failed: HTTP (?:429|50[234])\b/i;

export function isTransient(err) {
  return TRANSIENT_ERROR.test(err?.message ?? '');
}

/** In-process attempts per job before it is left for the next start. */
export const MAX_RETRIES = 3;

/**
 * How long to wait before attempt `n`.
 *
 * Short for a dropped connection: the bot is usually back within seconds
 * (Spaceballs, 2026-09-28: closed 18:53:27, connected again 18:53:32). A rate
 * limit is WhatsApp asking us to slow down, and CLAUDE.md rule 4 says to back
 * off when it does, so that waits a quarter of an hour per attempt.
 */
export function retryDelayMs(attempt, err) {
  if (/rate.?overlimit/i.test(err?.message ?? '')) return 15 * 60_000 * attempt;
  return 30_000 * 2 ** (attempt - 1);                 // 30 s, 1 min, 2 min
}

/**
 * Bounded, backed-off, reconnect-aware retries, keyed by job.
 *
 * A transient failure used to keep its journal entry and wait for the next
 * process start - which can be days. On 2026-09-28 "Spaceballs" lost its
 * upload when WhatsApp closed the connection; the bot was connected again five
 * seconds later, and the requester was left looking at 🔄 until somebody
 * restarted the service.
 *
 * `schedule` books attempt n+1 for a key: once the delay has passed AND the
 * bot is connected (it waits for the 'connected' state if it is not), `run` is
 * called with the attempt number. Each key gets `max` attempts in this
 * process; after that `schedule` answers 0 and the caller falls back to what
 * it did before. A key already waiting is never booked twice, so one failure
 * cannot turn into two runs.
 *
 * `until`, when given, is one more thing to wait for once the delay has
 * passed, before the connection: a function of an AbortSignal returning a
 * promise, settled when the attempt is worth making. A job the disk filled
 * under waits for room this way (media/disk-space.js waitForRoom) rather
 * than failing for good, as three films did on 2026-09-28. forget() aborts
 * it. If it fails, the attempt is made anyway, and the job decides.
 *
 * `show`, when given, puts the job on the queue's panel while it waits
 * ({ queue, label, kind, meta, cancel }, see JobQueue.holdRetry). Between the
 * failure and the retry going back in the queue the job is in no queue at
 * all - 30 seconds to 2 minutes normally, 15 to 45 minutes after a rate
 * limit, as long as it takes while waiting for room on the disk - and it used
 * to be invisible there: the panel listed it only as "failed", Cancel by the
 * ids it had answered false, and queue-status said busy:false,
 * safeToRestart:true while Spaceballs and Loki S01E01 were about to be
 * posted. `cancel(state)` is what the panel's Cancel does to it.
 */
export class RetryBook {
  constructor({ max = MAX_RETRIES, delayMs = retryDelayMs, log = null } = {}) {
    this.max = max;
    this.delayMs = delayMs;
    this.log = log;
    this.attempts = new Map();      // key -> attempts booked so far
    this.waiting = new Map();       // key -> { attempt, timer }
    this.onConnect = new Map();     // key -> fire, for keys waiting on the connection
    this.unlisten = null;
  }

  /** @returns the attempt booked (1..max), or 0 once they are spent. */
  schedule(key, { bot, err = null, run, until = null, show = null }) {
    const booked = this.waiting.get(key);
    if (booked) return booked.attempt;
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    if (attempt > this.max) {
      this.attempts.delete(key);
      return 0;
    }
    this.attempts.set(key, attempt);

    const entry = { attempt, timer: null, abort: null, show: show?.queue?.holdRetry ? show : null };
    const shown = (waitingFor) => {
      if (!entry.show || this.waiting.get(key) !== entry) return;
      const { queue, cancel, label, kind, meta } = entry.show;
      try {
        queue.holdRetry({ key, label, kind, meta, attempt, max: this.max, waitingFor, cancel });
      } catch (e) { this.log?.warn?.(`could not show the retry of ${key}: ${e.message}`); }
    };
    const fire = () => {
      if (this.waiting.get(key) !== entry) return;     // forgotten meanwhile
      this.waiting.delete(key);
      this._unshow(key, entry);
      Promise.resolve()
        .then(() => run(attempt))
        .catch((e) => this.log?.error?.(`retry of ${key} failed to start: ${e.message}`));
    };
    const whenConnected = () => {
      if (this.waiting.get(key) !== entry) return;
      if (!bot || bot.isConnected()) fire();
      else { shown('connection'); this._whenConnected(bot, key, fire); }
    };
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (!until) return whenConnected();
      shown('room');
      entry.abort = new AbortController();
      Promise.resolve()
        .then(() => until(entry.abort.signal))
        .catch((e) => {
          if (entry.abort?.signal.aborted) return;
          this.log?.warn?.(`retry of ${key}: ${e.message} - trying it anyway`);
        })
        .finally(() => {
          const aborted = entry.abort?.signal.aborted;
          entry.abort = null;
          if (!aborted) whenConnected();
        });
    }, this.delayMs(attempt, err));
    // A retry waiting on the clock must not hold a stopping process open.
    entry.timer.unref?.();
    this.waiting.set(key, entry);
    shown('delay');
    return attempt;
  }

  /** Off the queue's panel: gone back in the queue, or finished with. */
  _unshow(key, entry) {
    if (!entry?.show) return;
    try { entry.show.queue.releaseRetry?.(key); } catch { /* the panel is not worth failing a retry for */ }
  }

  /** Is `key` booked and not yet re-queued? */
  isWaiting(key) { return this.waiting.has(key); }

  /** The job is finished with - delivered, cancelled or given up. */
  forget(key) {
    const entry = this.waiting.get(key);
    if (entry?.timer) clearTimeout(entry.timer);
    entry?.abort?.abort();
    this.waiting.delete(key);
    this._unshow(key, entry);
    this.onConnect.delete(key);
    if (!this.onConnect.size) this.unlisten?.();
    this.attempts.delete(key);
  }

  /** Teardown: nothing booked may fire into a plugin that has gone. */
  clear() {
    for (const key of [...this.waiting.keys()]) this.forget(key);
    this.attempts.clear();
  }

  /**
   * One 'state' listener for the whole book, however many jobs wait on it: a
   * season whose episodes fail while the connection is down is dozens of
   * them.
   */
  _whenConnected(bot, key, fire) {
    this.onConnect.set(key, fire);
    if (this.unlisten) return;
    const onState = (st) => {
      if (st?.state !== 'connected') return;
      const fires = [...this.onConnect.values()];
      this.onConnect.clear();
      this.unlisten?.();
      for (const f of fires) f();
    };
    bot.on('state', onState);
    this.unlisten = () => { bot.off('state', onState); this.unlisten = null; };
  }
}

/**
 * The finished file a job's work holds, if it is still there, intact.
 *
 * "Minority Report" (2026-09-28) was downloaded - 4.75 GB - and encoded for
 * 38 minutes into a 1.67 GB file, which then lost its upload to a dropped
 * connection; the cleanup deleted it, so a retry would have spent another 42
 * minutes making the same file. A job's converted file is recorded in its
 * manifest now (media/work-files.js), and the next attempt - a retry, or the
 * job resumed after a restart - sends that file, as long as it is still in
 * the job's own directory and exactly the size recorded. Anything else
 * (swept, truncated, replaced) and it is made again. Whether it is still the
 * library's file is the caller's to have asked first (verifyIdentity).
 *
 * @returns {{ outPath: string, size: number, action: string, reused: true, segmented: boolean } | null}
 */
export function finishedOutput(work) {
  const out = work?.manifest?.output;
  if (!out?.name || !(out.size > 0)) return null;
  const dir = path.resolve(work.dir);
  const file = path.resolve(dir, out.name);
  if (!file.startsWith(dir + path.sep)) return null;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size !== out.size) return null;
  } catch {
    return null;
  }
  return { outPath: file, size: out.size, action: out.action ?? 'kept', reused: true, segmented: !!out.segmented };
}

/**
 * Call `handler(entry)` once for every job the queue dropped before it ever
 * started: cancelled or skipped while waiting, or cleared with the rest.
 *
 * Such a job's run() is never called, so nothing in its pipeline hears about
 * it, and its journal entry outlived it: the next start put it back in the
 * queue. A cancelled job must never come back, and a retried job spends time
 * waiting in the queue like any other. `entry` is the queue's public view of
 * the job, meta included. Returns the unsubscribe function.
 *
 * Every watcher of a queue shares one set of listeners on it: the queue is
 * an ordinary EventEmitter, and each open panel tab already listens to it.
 *
 * The watcher keeps its own list of the jobs waiting, from 'added', rather
 * than reading the queue's history afterwards. The history holds the last
 * 100 jobs, and clearPending() archives every job it removes before saying
 * anything: clearing a queue of more than 100 (104 waiting at 01:36 UTC on
 * 2026-09-28, and recovery goes past the limit) pushed the first ones out
 * before they could be seen - the films at the head of the queue, which then
 * stayed journalled and came back at the next start.
 */
const cancelWatchers = new WeakMap();      // queue -> { handlers, waiting, listeners }

export function watchCancelledWhileWaiting(queue, handler) {
  if (typeof queue?.on !== 'function') return () => {};
  let w = cancelWatchers.get(queue);
  if (!w) {
    w = { handlers: new Set(), waiting: new Map() };        // job id -> public view, meta included
    const tell = (e) => {
      // A listener that throws would throw into queue.cancel() and the
      // panel's request; the handlers log their own failures.
      for (const h of w.handlers) { try { h(e); } catch { /* see above */ } }
    };
    const onAdded = (e) => { if (e?.id) w.waiting.set(e.id, e); };
    // A job starting, or cancelled or skipped on its own, is 'updated'.
    const onUpdated = (e) => {
      if (!e?.id) return;
      w.waiting.delete(e.id);
      if (!e.startedAt && (e.state === 'cancelled' || e.state === 'skipped')) tell(e);
    };
    // clearPending() says only 'state', once, after removing every job. A job
    // gone from the queue without an 'updated' - neither started nor
    // cancelled on its own - was cleared with the rest.
    const onState = () => {
      if (!w.waiting.size) return;
      const live = new Set([
        ...(queue.pending ?? []).map((p) => p.id),
        ...(queue.active?.keys?.() ?? []),
      ]);
      for (const [id, e] of [...w.waiting]) {
        if (live.has(id)) continue;
        w.waiting.delete(id);
        const now = queue.describe?.(id);
        if (now && now.state !== 'cancelled' && now.state !== 'skipped') continue;
        tell({ ...e, state: now?.state ?? 'cancelled' });
      }
    };
    // Jobs already waiting when the first watcher arrives (the TV side
    // watches from its first retry on).
    for (const p of queue.pending ?? []) {
      if (p?.id) w.waiting.set(p.id, typeof queue.publicView === 'function' ? queue.publicView(p) : p);
    }
    w.listeners = { added: onAdded, updated: onUpdated, state: onState };
    for (const [ev, fn] of Object.entries(w.listeners)) queue.on(ev, fn);
    cancelWatchers.set(queue, w);
  }
  w.handlers.add(handler);
  return () => {
    w.handlers.delete(handler);
    if (w.handlers.size || cancelWatchers.get(queue) !== w) return;
    for (const [ev, fn] of Object.entries(w.listeners)) queue.off?.(ev, fn);
    cancelWatchers.delete(queue);
  };
}

/*
 * Movies are put back in the queue before TV after a restart.
 *
 * Both plugins recover when WhatsApp connects, and they used to do it at the
 * same time. At 01:36 UTC on 2026-09-28 TV recovery had filled the queue with
 * 104 One Piece and Suits episodes while the movie side was still looking its
 * 13 films up one by one, and "Doctor Strange" and "Ready Player One" -
 * accepted before the restart - were refused as "Queue is full". Recovery now
 * goes past the limit on both sides, so nothing accepted is refused; this
 * keeps the order as well, so every film is waiting in the queue before a
 * recovered episode can take a slot, and the films' reactions - each one's
 * place or stage (stage-reaction.js) - are not paced out behind a hundred
 * episodes'.
 *
 * Keyed on the shared queue, so separate queues (tests) never wait on each
 * other.
 */
const movieRecoveries = new WeakMap();

/** The movie plugin, at setup: TV recovery waits until the returned release(). */
export function holdTvRecovery(queue) {
  let release = () => {};
  const done = new Promise((resolve) => { release = resolve; });
  if (queue && typeof queue === 'object') movieRecoveries.set(queue, done);
  return () => release();
}

/**
 * The TV plugin, before it recovers: resolves true once the movie side has
 * finished, straight away when there is no movie side, or false after
 * `timeoutMs` so a stuck movie recovery cannot hold TV back for ever.
 */
export async function afterMovieRecovery(queue, { timeoutMs = 5 * 60_000 } = {}) {
  const done = queue && typeof queue === 'object' ? movieRecoveries.get(queue) : null;
  if (!done) return true;
  let timer = null;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([done.then(() => true), late]);
  } finally {
    clearTimeout(timer);
  }
}
