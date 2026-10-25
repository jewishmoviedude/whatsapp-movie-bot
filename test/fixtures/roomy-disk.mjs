/* Plenty of room on the disk, whatever the box running the tests has.

   The pipelines ask the filesystem for room for a whole job - its download,
   its converted file and the upload's copy - before they start it
   (src/media/disk-space.js), and refuse one that cannot fit. A suite about
   something else must not pass or fail on how full the disk of the box
   running it happens to be: on bot-box that is the live bot's disk, with its
   own jobs coming and going, and it swung between 0.4 and 13 GB free on
   2026-09-28. Imported first by the suites that run a job through the
   pipeline; a suite about the disk sets its own figure instead
   (test/disk-full-retry.test.mjs). */
import fs from 'node:fs';

export const ROOMY_BYTES = 1024 ** 4;
const real = fs.statfsSync;
fs.statfsSync = (p, ...rest) => ({ ...real(p, ...rest), bavail: Math.floor(ROOMY_BYTES / 4096), bsize: 4096 });
