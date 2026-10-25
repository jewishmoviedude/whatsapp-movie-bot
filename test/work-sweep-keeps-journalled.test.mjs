/* The work directory's sweeps keep what a journalled job will resume from.
   Run: node test/work-sweep-keeps-journalled.test.mjs

   The Parent Trap (1998), 2026-09-29: 2.62 GB downloaded 18:42-18:44 UTC,
   23 minutes into its encode when the bot restarted at 19:07. The movie
   plugin's start-up sweep deleted everything in the work directory but the
   finished files a journal named - so the download and the partial encode
   went, and the film was downloaded again from the first byte, and again
   after a second restart 11 seconds later. The hourly sweep deleted anything
   six hours old, journalled or not.

   The sweeps now run from src/index.js, before any plugin loads, and keep
   every job directory either journal holds (media/work-files.js
   sweepWorkDir); everything else goes as before. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sweepWorkDir, liveWorkDirs, jobDirName, workKey, openWork, holdWork, releaseWork, isSafeToDeleteIn,
} from '../src/media/work-files.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'work-sweep-'));
const WORK = path.join(TMP, 'work');
fs.mkdirSync(WORK);
const isSafe = (p) => isSafeToDeleteIn(p, { workDir: WORK });
const logs = [];
const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m) };
const HOUR = 3600_000;

const movieJournal = [{ jobKey: 'PT1:tt0120783' }];
const tvJournal = [{ reqKey: 'tv-OP17-1', episodes: [{ id: 'op-17-1' }, { id: 'op-17-2' }] }];
const live = () => liveWorkDirs({ movie: movieJournal, tv: tvJournal });

/** A job's directory with a file in it, `ageMs` old. */
function job(key, { ageMs = 0, bytes = 1024 } = {}) {
  const w = openWork({ workDir: WORK, key, isSafe });
  w.record({ item: { id: key, access: 'download', total: bytes } });
  fs.writeFileSync(w.path('source.mkv'), Buffer.alloc(bytes));
  w.record({ source: { name: 'source.mkv', state: 'complete', bytes } });
  age(w.dir, ageMs);
  return w.dir;
}
function age(p, ms) {
  const t = new Date(Date.now() - ms);
  if (fs.lstatSync(p).isDirectory()) for (const n of fs.readdirSync(p)) age(path.join(p, n), ms);
  fs.lutimesSync(p, t, t);
}

console.log('=== the start-up sweep keeps both journals\' work and clears the rest ===');
{
  const film = job(workKey.movie('PT1:tt0120783'), { bytes: 3000 });
  const e1 = job(workKey.tv('tv-OP17-1', 'op-17-1'));
  const e2 = job(workKey.tv('tv-OP17-1', 'op-17-2'));
  const orphan = job(workKey.movie('GONE:tt1'));
  const legacy = path.join(WORK, '1790263529080-j12-source.mkv');
  fs.writeFileSync(legacy, 'a flat file from before job directories');
  const legacyOut = path.join(WORK, '1790263529080-j12-The Parent Trap (1998).mp4');
  fs.writeFileSync(legacyOut, 'the finished file an old journal pointed at');
  const r = sweepWorkDir(WORK, { all: true, live: live(), isSafe, log });
  ok([film, e1, e2].every((d) => fs.existsSync(path.join(d, 'source.mkv'))), 'the film and both episodes keep their work');
  ok(!fs.existsSync(orphan), 'a job directory no journal holds goes');
  ok(!fs.existsSync(legacy) && !fs.existsSync(legacyOut), 'and so do the flat files of the version before');
  ok(r.removed === 3 && r.kept === 3 && r.keptBytes >= 5048, `${r.removed} removed, ${r.kept} kept (${r.keptBytes} bytes)`);
  ok(logs.some((l) => /kept [0-9.]+ KB of work for 3 journalled job\(s\), to resume from where each stopped/.test(l)), 'and the log says what it kept for whom');
}

console.log('=== the hourly sweep keeps journalled work whatever its age ===');
{
  const film = path.join(WORK, jobDirName(workKey.movie('PT1:tt0120783')));
  age(film, 10 * 24 * HOUR);
  sweepWorkDir(WORK, { olderThanMs: 6 * HOUR, live: live(), isSafe, log });
  ok(fs.existsSync(path.join(film, 'source.mkv')), 'a film journalled ten days ago keeps its download');
}

console.log('=== it keeps the work recovery is holding ===');
{
  // recoverPending takes the films out of the journal before it puts each
  // back; the hourly sweep can run in between.
  const key = workKey.movie('REC:tt2');
  const dir = job(key, { ageMs: 7 * HOUR });
  holdWork([key]);
  sweepWorkDir(WORK, { olderThanMs: 6 * HOUR, live: live(), isSafe, log });
  sweepWorkDir(WORK, { all: true, live: live(), isSafe, log });
  ok(fs.existsSync(dir), 'held: kept by both sweeps, journal or no journal');
  releaseWork(key);
  sweepWorkDir(WORK, { olderThanMs: 6 * HOUR, live: live(), isSafe, log });
  ok(!fs.existsSync(dir), 'released, and in no journal: swept like any leftover');
}

console.log('=== and the work of a job running in this process ===');
{
  const key = workKey.tv('tv-nojournal', 'e1');
  const w = openWork({ workDir: WORK, key, isSafe });
  w.lock();
  age(w.dir, 7 * HOUR);
  sweepWorkDir(WORK, { all: true, live: live(), isSafe, log });
  ok(fs.existsSync(w.dir), 'open in this process: kept');
  w.release();
  w.drop();
}

console.log('=== an orphan goes six hours on, not before ===');
{
  const old = job(workKey.movie('OLD:tt3'), { ageMs: 7 * HOUR });
  const young = job(workKey.movie('YOUNG:tt4'), { ageMs: 1 * HOUR });
  // A directory whose files are old but one of which changed an hour ago is
  // an hour old: its age is its newest change.
  const mixed = job(workKey.movie('MIXED:tt5'), { ageMs: 7 * HOUR });
  fs.writeFileSync(path.join(mixed, 'v0001.ts'), 'a piece written an hour ago');
  age(path.join(mixed, 'v0001.ts'), 1 * HOUR);
  const oldFile = path.join(WORK, 'stray.part');
  fs.writeFileSync(oldFile, 'x');
  age(oldFile, 7 * HOUR);
  sweepWorkDir(WORK, { olderThanMs: 6 * HOUR, live: live(), isSafe, log });
  ok(!fs.existsSync(old) && !fs.existsSync(oldFile), 'seven hours old: gone');
  ok(fs.existsSync(young) && fs.existsSync(mixed), 'an hour old, or changed an hour ago: kept');
  fs.rmSync(young, { recursive: true });
  fs.rmSync(mixed, { recursive: true });
}

console.log('=== it never follows a symbolic link out of the work directory ===');
{
  const outside = path.join(TMP, 'library');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'The Parent Trap (1998).mkv'), 'the only copy');
  fs.symlinkSync(outside, path.join(WORK, 'job-0000000000000000link'));
  const dir = job(workKey.movie('LINKS:tt6'));
  fs.symlinkSync(outside, path.join(dir, 'lib'));
  fs.symlinkSync(path.join(outside, 'The Parent Trap (1998).mkv'), path.join(dir, 'film.mkv'));
  sweepWorkDir(WORK, { all: true, live: live(), isSafe, log });
  ok(!fs.existsSync(path.join(WORK, 'job-0000000000000000link')) && !fs.existsSync(dir), 'the links are gone');
  ok(fs.readFileSync(path.join(outside, 'The Parent Trap (1998).mkv'), 'utf8') === 'the only copy',
    'and what they pointed at is untouched');
  const kept = path.join(WORK, 'job-0000000000000000keep');
  fs.mkdirSync(kept);
  sweepWorkDir(WORK, { all: true, live: live(), isSafe: () => false, log });
  ok(fs.existsSync(kept) && logs.some((l) => /not sweeping .*job-0000000000000000keep: the guard says/.test(l)),
    'nothing the guard refuses is deleted, and the log says so');
}

console.log('=== the wiring: src/index.js sweeps before any plugin loads, sparing both journals ===');
{
  const src = fs.readFileSync(path.join(REPO, 'src/index.js'), 'utf8');
  const sweep = src.indexOf('sweepWorkDir(config.media.workDir, { all: true');
  ok(sweep > 0 && sweep < src.indexOf('await pluginManager.load('), 'the start-up sweep runs before the plugins load');
  ok(/namespace\('movie-requests'\)\.get\('pending'/.test(src) && /namespace\('tv-requests'\)\.get\('pending'/.test(src),
    'with what both journals hold');
  ok(/const sweeper = setInterval\(\(\) => sweepWorkDir\(config\.media\.workDir, \{\s*olderThanMs: 6 \* 3600_000, live: liveWorkDirs\(journals\(\)\)/.test(src),
    'and the hourly one too');
  const plugin = fs.readFileSync(path.join(REPO, 'src/plugins/movie-requests/index.js'), 'utf8');
  ok(!/cleanWorkDir|sweepWorkDir\(/.test(plugin), 'the movie plugin no longer sweeps on its own');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
