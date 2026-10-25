/* A job's files live in a directory named from its key, with a manifest a kill cannot tear.
   Run: node test/job-work-dir.test.mjs

   The Parent Trap (1998), 2026-09-29: downloaded (2.62 GB, 18:42-18:44 UTC)
   and 23 minutes into its encode when the bot restarted at 19:07. Recovery
   resumed the job and it downloaded the film again: its files were named
   from the time and the queue's job id, which a restarted job does not
   keep, so nothing could have found them even if the start-up sweep had not
   deleted them first. A second restart 11 seconds later started it over
   again. Now each job has a directory named from a key that a restart keeps
   (media/work-files.js), and a manifest there says how far it got - written
   so that a process killed at any moment leaves the old manifest or the
   new one, never half of either. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  openWork, workKey, jobDirName, readManifest, MANIFEST_VERSION, forgetThisProcess, adoptWork, isSafeToDeleteIn,
} from '../src/media/work-files.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'job-work-'));
const WORK = path.join(TMP, 'work');
fs.mkdirSync(WORK);
const isSafe = (p) => isSafeToDeleteIn(p, { workDir: WORK });

console.log('=== a job\'s directory is named from its key alone, so a restarted job finds its own files ===');
{
  const key = workKey.movie('3EB0C431A1:tt0120783');
  const here = jobDirName(key);
  const there = execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { jobDirName } from ${JSON.stringify(path.join(REPO, 'src/media/work-files.js'))}; process.stdout.write(jobDirName(${JSON.stringify(key)}));`,
  ]).toString();
  ok(here === there && /^job-[0-9a-f]{20}$/.test(here), `another process names it the same: ${here}`);
  ok(jobDirName(key) === here, 'and so does this one, every time');

  const w = openWork({ workDir: WORK, key, kind: 'movie', label: 'The Parent Trap', isSafe });
  w.lock();
  fs.writeFileSync(w.sourcePath('.mkv'), 'the whole film');
  w.record({ item: { id: 'pt', access: 'download', total: 14 }, source: { name: 'source.mkv', state: 'complete', bytes: 14 } });
  w.release();
  forgetThisProcess();                                 // the restart
  const again = openWork({ workDir: WORK, key, isSafe });
  ok(again.dir === w.dir && again.has() && again.manifest.source?.state === 'complete'
    && fs.readFileSync(again.path(again.manifest.source.name), 'utf8') === 'the whole film',
  'the job opened again after a restart finds the download it made, and what it is');
  ok(!again.vouched(), 'but has not yet checked it against the library - a new process never takes that on trust');
}

console.log('=== two keys never share a directory ===');
{
  const keys = [];
  for (let i = 0; i < 2000; i++) keys.push(workKey.movie(`M${i}:tt${i}`), workKey.tv(`tv-${i}`, `ep-${i}`));
  keys.push(workKey.movie('a:b'), workKey.tv('a', 'b'), workKey.tv('a:b', ''), `job:${1}`);
  const names = new Set(keys.map(jobDirName));
  ok(names.size === keys.length, `${keys.length} keys, ${names.size} directories`);
  ok(workKey.tv('r1', 'e1') !== workKey.movie('r1:e1'), 'an episode and a film with look-alike ids have different keys');
}

console.log('=== a torn manifest, a wrong version or another key\'s manifest is treated as empty ===');
{
  const key = workKey.movie('TORN:tt1');
  const w = openWork({ workDir: WORK, key, isSafe });
  w.lock();
  w.record({ item: { id: 'x', access: 'download', total: 5 }, output: { name: 'output.mp4', size: 5, action: 'copy' } });
  const file = path.join(w.dir, 'manifest.json');
  const whole = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, whole.slice(0, Math.floor(whole.length / 2)));
  const torn = readManifest(w.dir, key);
  ok(torn.v === MANIFEST_VERSION && torn.key === key && !torn.item && !torn.output, 'half a manifest: nothing to build on');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(whole), v: 1 }));
  ok(!readManifest(w.dir, key).item, 'a manifest of another version: nothing');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(whole), key: workKey.movie('OTHER:tt2') }));
  ok(!readManifest(w.dir, key).item, 'another job\'s manifest: nothing');
  fs.writeFileSync(file, whole);
  ok(readManifest(w.dir, key).output?.size === 5, 'its own, whole: everything');
  w.release();
}

console.log('=== a manifest survives a kill between steps ===');
{
  // A process recording step after step, killed at random moments: what is
  // on the disk afterwards is always a whole manifest, of some step.
  const key = workKey.movie('KILL:tt3');
  const script = path.join(TMP, 'recorder.mjs');
  fs.writeFileSync(script, `
import { openWork } from ${JSON.stringify(path.join(REPO, 'src/media/work-files.js'))};
const w = openWork({ workDir: ${JSON.stringify(WORK)}, key: ${JSON.stringify(key)}, isSafe: () => true });
w.lock();
const pad = 'x'.repeat(256 * 1024);
let step = w.manifest.convert?.step ?? 0;
process.stdout.write('ready\\n');
for (;;) w.record({ convert: { step: ++step, pad } });
`);
  let torn = 0;
  let steps = [];
  for (let i = 0; i < 12; i++) {
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((r) => child.stdout.once('data', r));
    await new Promise((r) => setTimeout(r, 20 + Math.floor(Math.random() * 120)));
    child.kill('SIGKILL');
    await new Promise((r) => child.on('exit', r));
    const w = openWork({ workDir: WORK, key, isSafe });
    try {
      const m = JSON.parse(fs.readFileSync(path.join(w.dir, 'manifest.json'), 'utf8'));
      if (m.key !== key || !(m.convert?.step > 0) || m.convert.pad.length !== 256 * 1024) torn += 1;
      else steps.push(m.convert.step);
    } catch { torn += 1; }
  }
  ok(torn === 0 && steps.length === 12, `12 kills, 12 whole manifests (steps ${steps.join(', ')})`);
  ok(steps.every((s, i) => i === 0 || s >= steps[i - 1]), 'each carrying on from the last');
}

console.log('=== one run at a time, and what it did not record goes ===');
{
  const key = workKey.tv('tv-OP17', 'op-17-1');
  const a = openWork({ workDir: WORK, key, isSafe });
  a.lock();
  let err = null;
  try { openWork({ workDir: WORK, key, isSafe }).lock(); } catch (e) { err = e; }
  ok(err?.code === 'WORK_BUSY', 'a second run of the same job in this process is refused');
  ok(openWork({ workDir: WORK, key, isSafe }).drop() === 0 && fs.existsSync(a.dir), 'and cannot delete the first one\'s files');
  fs.writeFileSync(a.path('source.mkv.part'), 'half');
  fs.writeFileSync(a.path('v0003.1a2b.raw.ts'), 'a piece ffmpeg was killed in');
  fs.writeFileSync(a.path('output.mp4'), 'never recorded');
  a.record({ item: { id: 'op-17-1', access: 'download', total: 4 }, source: { name: 'source.mkv', state: 'partial', bytes: 4 } });
  ok(a.tidy() === 2 && fs.readdirSync(a.dir).sort().join() === 'manifest.json,source.mkv.part',
    `tidy keeps the download the manifest records, and nothing it does not (${fs.readdirSync(a.dir).sort().join(', ')})`);
  a.reset('the library\'s file changed');
  ok(fs.readdirSync(a.dir).join() === 'manifest.json' && !a.has(), 'reset leaves an empty manifest');
  a.release();
  const freed = a.drop();
  ok(!fs.existsSync(a.dir) && freed >= 0, 'drop removes the directory');
}

console.log('=== a job directory taken by a link is replaced, never followed ===');
{
  const outside = path.join(TMP, 'library');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'film.mkv'), 'the only copy');
  const key = workKey.movie('LINK:tt4');
  fs.symlinkSync(outside, path.join(WORK, jobDirName(key)));
  const w = openWork({ workDir: WORK, key, isSafe });
  w.lock();
  w.reset();
  w.release();
  ok(fs.existsSync(path.join(outside, 'film.mkv')) && !fs.lstatSync(w.dir).isSymbolicLink(),
    'the link is replaced by a directory of its own, and what it pointed at is untouched');
  w.drop();
}

console.log('=== a lock that cannot make its directory leaves the job free ===');
{
  // A job that failed there used to stay marked as running, and every later
  // attempt at it in the process was refused as a second run.
  const key = workKey.movie('FILE:tt7');
  fs.writeFileSync(path.join(WORK, jobDirName(key)), 'a file where the directory goes');
  let err = null;
  try { openWork({ workDir: WORK, key, isSafe: () => false }).lock(); } catch (e) { err = e; }
  ok(err && err.code !== 'WORK_BUSY' && /is not a directory this bot may use/.test(err.message), `refused: ${err?.message}`);
  const w = openWork({ workDir: WORK, key, isSafe });
  let again = null;
  try { w.lock(); } catch (e) { again = e; }
  ok(!again && fs.lstatSync(w.dir).isDirectory(), 'and the next attempt is not taken for a second run');
  w.release();
  w.drop();
}

console.log('=== a twin\'s work is handed on, or dropped ===');
{
  const from = openWork({ workDir: WORK, key: workKey.movie('T2:tt5'), isSafe });
  from.record({ item: { id: 'x', access: 'download', total: 3 }, output: { name: 'output.mp4', size: 3, action: 'copy' } });
  fs.writeFileSync(from.outPath, 'abc');
  ok(adoptWork({ workDir: WORK, fromKey: workKey.movie('T2:tt5'), toKey: workKey.movie('T1:tt5'), isSafe }) === 'adopted',
    'to a twin with none of its own');
  const to = openWork({ workDir: WORK, key: workKey.movie('T1:tt5'), isSafe });
  ok(to.manifest.output?.size === 3 && fs.readFileSync(to.outPath, 'utf8') === 'abc' && !fs.existsSync(from.dir),
    'which now holds it, under its own key');
  const other = openWork({ workDir: WORK, key: workKey.movie('T3:tt5'), isSafe });
  other.record({ item: { id: 'y', access: 'download', total: 1 } });
  ok(adoptWork({ workDir: WORK, fromKey: workKey.movie('T3:tt5'), toKey: workKey.movie('T1:tt5'), isSafe }) === 'dropped'
    && !fs.existsSync(other.dir) && to.has(), 'a twin with work of its own keeps its own, and the other\'s goes');
  to.drop();
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
