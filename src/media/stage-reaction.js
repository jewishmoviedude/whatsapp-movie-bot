/**
 * Where a request is now, as the one reaction its message carries, for the
 * moments the bot speaks to a member about a request it already has: picked
 * back up after a restart, retried after a failure, or sent again by the
 * member waiting for it.
 *
 * THE INCIDENT, 2026-10-11, in the movie requests group. Ethan Adams asked
 * for "Iron Man 3 2013" at 14:21 UTC; it was queued, downloaded, and waiting
 * for the encoder when the hourly check restarted the bot at 15:22. Recovery
 * picked it back up and reacted 🔄 on his message - the redo reaction, which
 * the schema called "resumed after a restart / retried" and the panel's guide
 * "Picked back up after a restart". A member reads 🔄 as "do it again": at
 * 15:49 he sent "Iron Man 3 2013" again, the bot answered that it was
 * "already in the queue - not queueing it again" and reacted 🤥 - the
 * duplicate reaction, which tells a repeat request apart from a fresh one -
 * and he asked the discussions group "what shld I do?". The operator: "Bot
 * asked Ethan to redo the iron man request and then reacted with 🤥 when he
 * did". Three restarts that day (08:53, 12:37, 15:22 UTC) each put 🔄 on
 * several members' messages.
 *
 * So no reaction here asks the member for anything. A request shows where it
 * actually is: its place in line while it waits (place-reaction.js, as
 * before), and otherwise the stage it is at, in the reactions the stages use
 * themselves - ⬇️ downloading, ⚙️ converting, ⬆️ sending - or 🎬 when it is
 * accepted and nothing of it has started. The redo reaction is gone from the
 * configuration; a config.json that still holds one is cleaned on load
 * (config/store.js).
 *
 * Shared by the movie and TV pipelines, as reaction-class.js and
 * place-reaction.js are, so the two cannot drift apart.
 */
import { finishedOutput } from './resume.js';

/** The queue's stage names (job.progress, stageWaits) and the reaction each one uses. */
const STAGE_KEY = { download: 'downloading', convert: 'converting', upload: 'sending' };

/**
 * The stage a job's kept work has reached (media/work-files.js), as the
 * reaction key of what its run does next: a finished file is sent, a whole
 * download or pieces of an encode are converted, and anything less - a
 * partial download, a film read in place - is fetched. Null when there is no
 * work at all. Iron Man 3's work held its whole 2.61 GB download: ⚙️.
 */
export function workStage(work) {
  if (!work || typeof work.has !== 'function' || !work.has()) return null;
  if (finishedOutput(work)) return 'sending';
  const m = work.manifest ?? {};
  if (m.source?.state === 'complete' || (m.convert?.chunks?.length ?? 0) > 0) return 'converting';
  return 'downloading';
}

/**
 * The stage a running job is at, from the queue's view of it (queue.js
 * publicView, or a request's _itemView): the stage it is working on, or the
 * one whose slot it stands in line for (media/stages.js stageWaits). Null
 * before it has reached one - just started, or waiting for room on the disk.
 */
export function liveStage(view) {
  const now = view?.progress?.stage;
  return STAGE_KEY[now] ?? STAGE_KEY[view?.waiting?.stage] ?? null;
}

/**
 * The reaction for where a request is, from the configured reactions `R`:
 * its live stage while it runs (`view`), else the stage its work has reached
 * (`work`), else ⬇️ when it is running with nothing done yet - the download
 * is the first thing it does - and 🎬 (`added`) when it is accepted and not
 * started. Never a place number: those go through place-reaction.js, which
 * keeps them current as the line moves.
 */
export function stageReaction(R, { view = null, work = null, running = false } = {}) {
  const key = liveStage(view) ?? workStage(work) ?? (running ? 'downloading' : null);
  return (key && R?.[key]) || R?.added || null;
}
