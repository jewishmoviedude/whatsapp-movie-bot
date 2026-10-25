/* The delete guard. This is the one function whose failure mode is
   destroying someone's media library, so it gets its own suite.
   Run: node test/safety.test.mjs

   Extended for job directories (The Parent Trap, 2026-09-29: a restart threw
   away a 2.62 GB download and 23 minutes of encoding, so each job now keeps
   its files in a directory of its own, deleted whole when the job ends). */
import { isSafeToDelete } from '../src/plugins/movie-requests/index.js';
let pass=0,fail=0;
const ok=(c,m)=>{c?(pass++,console.log(`  ok   ${m}`)):(fail++,console.log(`  FAIL ${m}`));};

const ctx = { config: {
  media: { workDir: '/home/bot/data/media' },
  library: { local: { roots: ['/mnt/media/Movies', '/mnt/nas/Films'] } },
}};

console.log('=== files we created, inside the work dir -> deletable ===');
for (const p of [
  '/home/bot/data/media/123-source.mkv',
  '/home/bot/data/media/123-John Wick (2014).mp4',
  '/home/bot/data/media/nested/deep.mp4',
]) ok(isSafeToDelete(p, ctx) === true, p);

console.log('\n=== the library original -> NEVER deletable ===');
for (const p of [
  '/mnt/media/Movies/John Wick (2014)/John.Wick.2014.mkv',
  '/mnt/media/Movies',
  '/mnt/nas/Films/Dune.2021.mkv',
]) ok(isSafeToDelete(p, ctx) === false, p);

console.log('\n=== anything outside the work dir -> refused ===');
for (const p of [
  '/etc/passwd', '/home/bot/data/config.json', '/home/bot/.env',
  '/', '/home/bot', '/tmp/something.mp4',
]) ok(isSafeToDelete(p, ctx) === false, p);

console.log('\n=== path-traversal attempts -> refused ===');
for (const p of [
  '/home/bot/data/media/../../../etc/passwd',
  '/home/bot/data/media/../config.json',
  '/home/bot/data/media/../../.env',
]) ok(isSafeToDelete(p, ctx) === false, `${p}  (resolves outside)`);

console.log('\n=== prefix-collision trap -> refused ===');
// A sibling directory whose name merely starts with the work dir's name
// must not be mistaken for being inside it.
ok(isSafeToDelete('/home/bot/data/media-backup/movie.mp4', ctx) === false,
   '/home/bot/data/media-backup/movie.mp4');

console.log('\n=== empty / rubbish input -> refused ===');
for (const p of [null, undefined, '']) ok(isSafeToDelete(p, ctx) === false, JSON.stringify(p));

console.log('\n=== library root nested inside the work dir -> still protected ===');
{
  const odd = { config: {
    media: { workDir: '/data' },
    library: { local: { roots: ['/data/library'] } },
  }};
  ok(isSafeToDelete('/data/scratch.mp4', odd) === true, '/data/scratch.mp4 deletable');
  ok(isSafeToDelete('/data/library/movie.mkv', odd) === false, '/data/library/movie.mkv protected');
}

console.log('\n=== the directories a job now has ===');
{
  // Since The Parent Trap (2026-09-29) each job keeps its files in a
  // directory of its own inside the work directory, and a finished job's
  // directory is deleted whole (media/work-files.js). A recursive delete is
  // the one that can take a library with it.
  const odd = { config: {
    media: { workDir: '/data' },
    library: { local: { roots: ['/data/library/films'] } },
  }};
  ok(isSafeToDelete('/data/library', odd) === false, '/data/library, which holds a library root, is never deletable');
  ok(isSafeToDelete('/data/job-0123456789abcdef0123', odd) === true, 'a job directory beside it is');
  ok(isSafeToDelete('/home/bot/data/media', ctx) === false, 'the work directory itself is never deletable as a directory');
  ok(isSafeToDelete('/home/bot/data/media/', ctx) === false, 'however it is written');
  ok(isSafeToDelete('/home/bot/data/media/job-0123456789abcdef0123', ctx) === true, 'a job directory inside it is');
}

console.log('\n=== a job directory that is a link out of the work directory -> refused ===');
{
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'safety-'));
  const work = path.join(T, 'media');
  const lib = path.join(T, 'elsewhere');
  fs.mkdirSync(work); fs.mkdirSync(lib);
  fs.writeFileSync(path.join(lib, 'film.mkv'), 'the only copy');
  fs.symlinkSync(lib, path.join(work, 'job-linked'));
  const real = { config: { media: { workDir: work }, library: { local: { roots: [] } } } };
  ok(isSafeToDelete(path.join(work, 'job-linked', 'film.mkv'), real) === false,
    'a file reached through a symbolic link that leads out of the work directory');
  ok(isSafeToDelete(path.join(work, 'job-linked'), real) === true, 'the link itself is ours to remove - which never follows it');
  fs.rmSync(T, { recursive: true, force: true });
}

console.log(`\n${'='.repeat(50)}\n  ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
