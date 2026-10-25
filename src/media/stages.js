/**
 * Stage-level concurrency shared by EVERY pipeline (movies and TV).
 *
 * These must be module-global rather than per-plugin: this box has under a
 * gigabyte of RAM and one CPU budget, so two simultaneous downloads or two
 * ffmpeg encodes - whether both movies, both episodes, or one of each - would
 * thrash it. Sharing the semaphores is what makes "one thing at a time"
 * actually true across the whole app.
 */
import { Semaphore } from '../util/semaphore.js';

export const stageSems = {
  download: new Semaphore(1, 'download'),
  convert: new Semaphore(1, 'convert'),
  upload: new Semaphore(1, 'upload'),
};

/**
 * Who gets the next free stage slot. The queue puts movies ahead of TV; these
 * make the stages agree, instead of quietly re-ordering them back into arrival
 * order the moment a movie starts waiting for the download slot.
 */
export const STAGE_PRIORITY = { movie: 1, tv: 0 };

/**
 * Say truthfully what a job is waiting behind. The old text said "another
 * movie is downloading" whatever was actually holding the slot, so a movie
 * waiting on a TV episode reported a movie that did not exist.
 */
export function waitReason(sem, stage = 'download') {
  const holders = sem.holders?.() ?? [];
  const what = holders.length
    ? holders.join(', ')
    : (sem.inUse ? 'another job' : 'nothing');
  return `waiting for the ${stage} slot — ${what} ${holders.length > 1 ? 'are' : 'is'} ahead`;
}

/**
 * The line a running job is standing in, for the panel: which stage slot it
 * is waiting for, and its place (1 = next). Null when it is not waiting.
 * Jobs are found by the key they acquired with, which is their queue id.
 * `promote` moves one up that line (see Semaphore#promote).
 */
export const stageWaits = {
  where(key) {
    for (const [stage, sem] of Object.entries(stageSems)) {
      const position = sem.position(key);
      if (position) return { stage, position, of: sem.waiting };
    }
    return null;
  },
  promote(key, dir = 'top') {
    const w = stageWaits.where(key);
    return !!w && stageSems[w.stage].promote(key, dir);
  },
};

/** Resize the stages from config (media.pipeline). */
export function sizeSems(cfg) {
  const p = cfg?.media?.pipeline ?? {};
  stageSems.download.setCapacity(p.download ?? 1);
  stageSems.convert.setCapacity(p.convert ?? 1);
  stageSems.upload.setCapacity(p.upload ?? 1);
}
