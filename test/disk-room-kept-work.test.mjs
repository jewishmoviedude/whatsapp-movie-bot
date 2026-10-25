/* Room on the disk for jobs that go on from where they stopped.
   Run: node test/disk-room-kept-work.test.mjs

   Since The Parent Trap (2026-09-29: a 2.62 GB download and 23 minutes of
   encoding thrown away by a restart, twice) a job keeps what it has done
   in a directory of its own (media/work-files.js), across a failed send and
   across a restart. What is in that directory is already on the disk, so a
   resumed job asks only for the room it still has to write - its film
   downloaded, it needs no room for the download again. And kept work waiting
   for its job to run again holds room that a new job must not take: that
   new job waits for it (DISK_WAIT) rather than being refused for good, as
   "Minority Report" was on 2026-09-28 while "Spaceballs"' kept file waited
   to be sent (media/disk-space.js). The kept work used to be forgotten
   after six hours, when the hourly sweep would have deleted it; the sweep
   keeps a journalled job's work now, so it is held until the job ends.

   Free space is whatever these tests say it is (fs.statfsSync). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  jobNeed, peakOf, reserveRoom, claimRoom, roomFor, keepRoom, forgetKept, keptFiles, heldRoom, dirBytes, SPARE_BYTES,
  describeNeed, waitForRoom, isDiskFull,
} from '../src/media/disk-space.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const GB = 1024 ** 3;
const MB = 1024 ** 2;
const PT = Math.round(2.62 * GB);          // The Parent Trap's download

const realStatfs = fs.statfsSync;
let free = 50 * GB;
fs.statfsSync = (p, ...rest) => ({ ...realStatfs(p, ...rest), bavail: Math.floor(free / 4096), bsize: 4096 });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kept-room-'));
const WORK = path.join(TMP, 'work');
fs.mkdirSync(WORK);
const log = { info() {}, warn() {}, error() {}, debug() {} };
const MAX_OUT = 1 * GB;
/** A job directory holding `bytes`, as a sparse file: the size the bot reads, none of the disk. */
function jobDir(name, bytes, file = 'source.mkv') {
  const d = path.join(WORK, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, file), '');
  fs.truncateSync(path.join(d, file), bytes);
  return d;
}

console.log('=== a resumed job asks only for the room it still has to write ===');
{
  // The Parent Trap: 2.62 GB downloaded before the restart.
  const whole = jobNeed({ workDir: WORK, sourceBytes: PT, maxOutputBytes: MAX_OUT });
  const resumed = jobNeed({ workDir: WORK, sourceBytes: PT, maxOutputBytes: MAX_OUT, onDisk: PT });
  ok(resumed.peak === whole.peak && resumed.total === whole.total - PT,
    `the same most it will hold, less what is on the disk already (${(whole.total / GB).toFixed(2)} GB -> ${(resumed.total / GB).toFixed(2)} GB)`);
  ok(/2\.62 GB of it on the disk already/.test(describeNeed(resumed)), `and the reason says so (${describeNeed(resumed)})`);

  const dir = jobDir('job-parent-trap', PT);
  free = resumed.total + 64 * MB;                 // room for the rest, not for the whole
  const claim = await reserveRoom({ key: 'pt', label: 'The Parent Trap', workDir: WORK, sourceBytes: PT, maxOutputBytes: MAX_OUT, jobDir: dir, log });
  ok(!!claim, 'with room for what is left it goes ahead - where a fresh download of it would have waited');
  ok(heldRoom()[0]?.outstanding === resumed.peak - PT, 'and holds only what it still has to write');
  claim.release();
  free = 50 * GB;
}

console.log('=== a claim counts everything in its job directory, a hard-linked file once ===');
{
  const dir = jobDir('job-linked', 300 * MB);
  fs.linkSync(path.join(dir, 'source.mkv'), path.join(dir, 'output.mp4'));   // plan=copy
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{}');
  fs.mkdirSync(path.join(dir, 'nested'));
  fs.writeFileSync(path.join(dir, 'nested', 'v0001.ts'), Buffer.alloc(1000));
  fs.symlinkSync('/etc/hostname', path.join(dir, 'a-link'));
  ok(dirBytes(dir) === 300 * MB + 2 + 1000, `300 MB once, a manifest and a piece - not 600 MB, and no link followed (${dirBytes(dir)})`);
  const c = claimRoom('linked', { dir: WORK, jobDir: dir, source: { bytes: 300 * MB }, out: { bytes: MAX_OUT }, upload: MAX_OUT });
  ok(roomFor(WORK, 0).held === peakOf(300 * MB, MAX_OUT, MAX_OUT) - dirBytes(dir), 'what it has still to write is its peak less all of that');
  c.release();
  fs.rmSync(dir, { recursive: true });
}

console.log('=== work kept for a queued job counts as held: new work waits, and is not refused for good ===');
{
  // A film's download kept, 1.5 GB of it, waiting for its retry - or for its
  // turn after a restart. It will write its converted file and upload copy.
  const kept = jobDir('job-kept', 1.5 * GB);
  const peak = jobNeed({ workDir: WORK, sourceBytes: 1.5 * GB, maxOutputBytes: MAX_OUT }).peak;
  keepRoom('K1', { dir: WORK, jobDir: kept, peak, label: 'The Parent Trap' });
  ok(keptFiles()[0]?.outstanding === peak - 1.5 * GB && !keptFiles()[0].made, 'kept: what it still has to write is its peak less its download');
  const need = jobNeed({ workDir: WORK, sourceBytes: 1 * GB, maxOutputBytes: MAX_OUT });
  free = need.total + 0.5 * GB;                   // room for the new job, but not with the kept one's still to come
  let err = null;
  try { await reserveRoom({ key: 'new', label: 'Heat', workDir: WORK, sourceBytes: 1 * GB, maxOutputBytes: MAX_OUT, log }); } catch (e) { err = e; }
  ok(err?.code === 'DISK_WAIT' && /until 1 job\(s\) whose work is kept for them have finished/.test(err.message),
    `a new job is refused for now, to wait for it (${err?.code}: ${err?.message})`);

  // The kept job itself runs: its own work is its own, and it waits on no one's.
  const other = jobDir('job-other-kept', 10 * MB, 'output.mp4');
  keepRoom('K2', { dir: WORK, jobDir: other, made: 10 * MB });
  const own = await reserveRoom({ key: 'k1-run', keptKey: 'K1', label: 'The Parent Trap', workDir: WORK, sourceBytes: 1.5 * GB, maxOutputBytes: MAX_OUT, jobDir: kept, log })
    .then((c) => c, (e) => e);
  ok(typeof own?.release === 'function' && !keptFiles().some((k) => k.key === 'K1'),
    'the job whose work it is goes ahead, and its work is no longer counted apart from it');
  own.release?.();

  fs.rmSync(kept, { recursive: true });
  fs.rmSync(other, { recursive: true });
  ok(roomFor(WORK, 0, { withKept: true }).keptOthers === 0 && !keptFiles().length, 'kept work whose directory is gone counts for nothing');
  keepRoom('K3', { dir: WORK, jobDir: jobDir('job-k3', 1), peak: 1 * GB });
  forgetKept('K3');
  ok(!keptFiles().length, 'and nothing once it is forgotten');
  free = 50 * GB;
}

console.log('=== kept work no longer lapses after six hours ===');
{
  const dir = jobDir('job-old', 100 * MB);
  keepRoom('OLD', { dir: WORK, jobDir: dir, peak: 2 * GB });
  const realNow = Date.now;
  Date.now = () => realNow() + 7 * 3600_000;
  const r = roomFor(WORK, 0, { withKept: true });
  Date.now = realNow;
  ok(r.keptOthers === 1 && r.held === 2 * GB - 100 * MB, 'seven hours on it still holds what it has to write');
  forgetKept('OLD');
}

console.log('=== a segmented encode\'s largest use includes the pieces and the output together ===');
{
  // media/segmented.js: pieces beside the source while they are made, then
  // beside the joined file too while they are joined. The source is kept
  // until the film is sent (the operator, 2026-09-30), so it is there
  // throughout, and beside the upload's copy at the end.
  const S = 2.62 * GB;
  const O = 1.8 * GB;
  ok(peakOf(S, O, O) === S + O + O && peakOf(S, O, O, { segmented: true }) === S + O + O,
    'the source, the file made and its upload copy: the most, for one pass or in pieces');
  ok(peakOf(0.5 * GB, O, 0, { segmented: true }) === 0.5 * GB + 2 * O && peakOf(0.5 * GB, O, 0) === O + 0.5 * GB,
    'with the upload copy elsewhere: the source, the pieces and the joined file together, in pieces');
  const n = jobNeed({ workDir: WORK, sourceBytes: 0.5 * GB, maxOutputBytes: O, tmpDir: '/proc', segmented: true });
  ok(n.total === 0.5 * GB + 2 * O + SPARE_BYTES, 'which is what such a job asks for');
}

console.log('=== work kept on the disk is never given up for a new job: the new job waits ===');
{
  // The operator, 2026-09-30, after a restart deleted three fully converted
  // films: "files should remain in their folders until fully sent on
  // whatsapp". Work parked for the next start used to be given up, the
  // oldest first, for a job that could not fit beside it. Now the new job
  // is refused for now (DISK_HELD), which the pipelines wait out, and the
  // parked work stays.
  for (const n of fs.readdirSync(WORK)) fs.rmSync(path.join(WORK, n), { recursive: true, force: true });
  const parked = jobDir('job-parked', PT);
  fs.writeFileSync(path.join(parked, 'output.mp4'), 'the film, converted');
  const lines = [];
  const say = { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m), debug() {} };
  const need = jobNeed({ workDir: WORK, sourceBytes: 2 * GB, maxOutputBytes: MAX_OUT });
  // The disk as it would be: what fits once the parked work has gone, and
  // not before.
  const disk = need.total + 64 * MB;
  fs.statfsSync = (p, ...rest) => ({ ...realStatfs(p, ...rest), bavail: Math.floor((disk - dirBytes(WORK)) / 4096), bsize: 4096 });
  const err = await reserveRoom({ key: 'heat', label: 'Heat', workDir: WORK, sourceBytes: 2 * GB, maxOutputBytes: MAX_OUT, log: say })
    .then(() => null, (e) => e);
  ok(err?.code === 'DISK_HELD' && isDiskFull(err), `the new job does not start, and waits (${err?.code})`);
  ok(/^not enough disk space for Heat yet: .* held by the work of 1 other job\(s\), kept until each is sent - it waits, and nothing is deleted to make room$/.test(err?.message ?? ''),
    `and says why, in the words the hourly check reports (${err?.message})`);
  ok(fs.existsSync(path.join(parked, 'source.mkv')) && fs.existsSync(path.join(parked, 'output.mp4')) && dirBytes(parked) > PT,
    'the parked work is all still there');

  // Waiting outside the queue (RetryBook `until`), it goes once that work
  // has been sent - its directory dropped - and not before.
  let done = false;
  const wait = waitForRoom({ dir: WORK, need, key: 'heat', label: 'Heat', log: say, pollMs: 20, waitOnHeld: true }).then((r) => { done = r; });
  await new Promise((r) => setTimeout(r, 80));
  ok(!done, 'while the work is on the disk, it waits');
  fs.rmSync(parked, { recursive: true });
  await wait;
  ok(done?.fits && done.waited, 'once that work is gone, there is room, and it goes');

  // A job the disk could not hold even with the other work gone is refused
  // for good, as before: waiting would not change it.
  jobDir('job-parked-2', 100 * MB);
  const big = await reserveRoom({ key: 'big', label: 'Titanic', workDir: WORK, sourceBytes: 20 * GB, maxOutputBytes: MAX_OUT, log: say })
    .then(() => null, (e) => e);
  ok(big?.code === 'DISK_TOO_SMALL' && !isDiskFull(big), `a job too big for the disk however empty is refused for good (${big?.code})`);
  ok(fs.existsSync(path.join(WORK, 'job-parked-2', 'source.mkv')), 'and nothing is deleted for it either');
}

fs.statfsSync = realStatfs;
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
