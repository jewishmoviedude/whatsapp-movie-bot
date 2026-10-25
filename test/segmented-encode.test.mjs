/* A re-encode done in pieces is the one-pass encode, and a restart goes on from its last piece.
   Run: node test/segmented-encode.test.mjs   (needs ffmpeg 5.1 or later; SKIP without it)

   The Parent Trap (1998), 2026-09-29: downloaded, then 23 minutes into its
   encode (libx264 veryfast, 1080p -> 720p, about 30 minutes of CPU at 3.4x
   real time on this box) when the bot restarted at 19:07 - and the encode
   began again from the first frame, and again after a second restart 11
   seconds later. The operator: "if bot gets interrupted it should be able
   to continue where left off and not need to start over from step 1".

   A re-encode is now made in pieces (media/segmented.js), and what a member
   gets must not change: every frame of the source once, at its time, the
   sound the one-pass encode would have given, no softer picture after a
   join, the sound and picture as far apart as in the source, the tags and
   chapters kept, and under the size cap. These are made-up clips of about
   half a minute, cut into 10-second pieces with a 2-second warm-up. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { convertForWhatsApp, probe } from '../src/media/ffmpeg.js';
import { openWork, workKey, isSafeToDeleteIn, forgetThisProcess, statOf } from '../src/media/work-files.js';
import { eligible, planPieces, ffmpegVersion } from '../src/media/segmented.js';
import { sweepWorkDir, liveWorkDirs } from '../src/media/work-files.js';
import { RetryBook, isTransient } from '../src/media/resume.js';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import { makeKit } from './fixtures/restart-kit.mjs';

const run = promisify(execFile);
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

let version = null;
try {
  execFileSync('ffmpeg', ['-version']);
  version = await ffmpegVersion({ ffmpegPath: 'ffmpeg' });
} catch { /* none */ }
if (!version?.major || version.major < 5 || (version.major === 5 && version.minor < 1)) {
  console.log('  SKIP - ffmpeg 5.1 or later is not installed');
  process.exit(0);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'segmented-'));
const src = (n) => path.join(TMP, n);
const gen = (args) => run('nice', ['-n', '19', 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', ...args]);

// Every ffmpeg run, logged, so a test can see which pieces were encoded.
// Flag files make it misbehave on cue: DIE1 and DIE2 kill it by a signal
// (as an out-of-memory kill would), each once, as it starts piece 2;
// SLOWAUDIO and SLOWJOIN have it write a little and then hang in the sound
// pass or the join, for a test to kill the whole process there.
const RUNS = path.join(TMP, 'runs.log');
const FFMPEG = path.join(TMP, 'ffmpeg');
const flag = (f) => path.join(TMP, f);
fs.writeFileSync(FFMPEG, `#!/bin/sh
echo "$*" >> '${RUNS}'
case "$*" in
  *v0001.*.raw.ts*-progress*)
    if [ -f '${flag('DIE2')}' ]; then rm -f '${flag('DIE2')}'; kill -9 $$; fi
    if [ -f '${flag('DIE1')}' ]; then rm -f '${flag('DIE1')}'; kill -9 $$; fi ;;
  *audio.m4a.part*)
    if [ -f '${flag('SLOWAUDIO')}' ]; then head -c 1000 /dev/urandom > audio.m4a.part; touch '${flag('STALLED')}'; sleep 60; fi ;;
  *concat:*)
    if [ -f '${flag('SLOWJOIN')}' ]; then touch '${flag('STALLED')}'; sleep 60; fi ;;
esac
exec nice -n 19 ffmpeg "$@"
`, { mode: 0o755 });
const runs = () => (fs.existsSync(RUNS) ? fs.readFileSync(RUNS, 'utf8').split('\n').filter(Boolean) : []);
/** The pieces encoded, by number, from the runs logged since `from`. */
const piecesRun = (from = 0) => runs().slice(from).map((l) => /-frames:v \d+ .* v(\d{4})\.[0-9a-f]+\.raw\.ts/.exec(l)?.[1]).filter(Boolean).map(Number);

console.log('=== building fixtures ===');
fs.writeFileSync(src('meta.txt'), ';FFMETADATA1\ntitle=The Parent Trap (test)\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=12000\ntitle=Camp Walden\n'
  + '[CHAPTER]\nTIMEBASE=1/1000\nSTART=12000\nEND=32000\ntitle=London\n');
const film = (out, { v = [], a = [], vf = null, secs = 32, extra = [] } = {}) => gen([
  ...v, '-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=24000/1001:duration=${secs}`,
  ...a, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${secs}:sample_rate=48000`,
  '-f', 'ffmetadata', '-i', src('meta.txt'),
  '-map', '0:v', '-map', '1:a', '-map_metadata', '2', '-map_chapters', '2',
  ...(vf ? ['-vf', vf] : []),
  '-c:v', 'libx264', '-preset', 'veryfast', '-bf', '3', '-g', '48', '-c:a', 'ac3', '-b:a', '192k', ...extra, out,
]);
await film(src('plain.mkv'));
await film(src('late-audio.mkv'), { a: ['-itsoffset', '0.5'] });
await film(src('late-video.mkv'), { v: ['-itsoffset', '1.0'] });
await film(src('short.mkv'), { secs: 12 });
await film(src('vfr.mkv'), { vf: "select='not(eq(mod(n\\,7)\\,3))'", extra: ['-fps_mode', 'vfr'] });
await film(src('noise.mkv'), { vf: 'noise=alls=60:allf=t' });
console.log(`  built in ${TMP}`);

// About 400 kbps of video for both kinds of encode: the least either gives,
// where rate control shows, and a cap the result fits under.
const cfg = {
  audioBitrateK: 128, strategy: 'always-transcode', videoCodec: 'libx264', preset: 'ultrafast', encodeProfile: 'custom',
  audioCodec: 'aac', maxHeight: 240, ffmpegPath: FFMPEG, ffprobePath: 'ffprobe', maxOutputBytes: 2_250_000,
  segmentedEncode: true, segmentSec: 10, segmentWarmupSec: 2,
  // libx264, whatever GPU the box has: NVENC's pieces have their own tests
  // (segmented-nvenc.test.mjs).
  videoEncoder: 'cpu',
};
const WORK = path.join(TMP, 'work');
fs.mkdirSync(WORK);
let n = 0;
function newWork() {
  n += 1;
  const w = openWork({ workDir: WORK, key: workKey.movie(`SEG${n}:tt0120783`), label: `film ${n}`, isSafe: (p) => isSafeToDeleteIn(p, { workDir: WORK }) });
  w.lock();
  return w;
}
async function onePass(input, c = cfg) {
  const out = path.join(TMP, `one-${path.basename(input)}.mp4`);
  if (!fs.existsSync(out)) await convertForWhatsApp(input, out, c, {});
  return out;
}
async function segmented(input, { c = cfg, work = newWork(), signal = null, onProgress = null } = {}) {
  const r = await convertForWhatsApp(input, work.outPath, c, { work, signal, onProgress });
  return { r, work };
}
async function times(file, stream = 'v:0') {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', stream, '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file], { maxBuffer: 64 << 20 });
  // A packet with side data has a trailing comma: the time is the first field.
  return stdout.split('\n').filter(Boolean).map((l) => parseFloat(l)).sort((a, b) => a - b);
}
async function streams(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,start_time:format_tags=title', '-show_chapters', '-of', 'json', file]);
  return JSON.parse(stdout);
}
async function audioFrames(file) {
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a', '-c', 'copy', '-f', 'framemd5', '-'], { maxBuffer: 64 << 20 });
  // size and hash, frame by frame: what was encoded, not where it was put.
  return stdout.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').slice(-2).map((x) => x.trim()).join(' '));
}
async function psnr(file, reference, from, secs = 1) {
  const f = `[0:v]trim=start=${from}:end=${from + secs},setpts=PTS-STARTPTS[a];[1:v]trim=start=${from}:end=${from + secs},setpts=PTS-STARTPTS[b];[a][b]psnr`;
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', file, '-i', reference, '-lavfi', f, '-an', '-f', 'null', '-']);
  return Number(/average:([\d.]+)/.exec(stderr)?.[1]);
}

const PLAIN = src('plain.mkv');
const one = await onePass(PLAIN);

console.log('=== a segmented encode has exactly the source\'s frames, none repeated or lost at a join ===');
const recorded = [];
let plainSeg = null;
{
  const work = newWork();
  const rec = work.record.bind(work);
  work.record = (patch) => { if (patch.convert) recorded.push(JSON.parse(JSON.stringify(patch.convert))); return rec(patch); };
  const details = [];
  const { r } = await segmented(PLAIN, { work, onProgress: (pct, detail) => details.push({ pct, detail }) });
  plainSeg = r.outPath;
  // Inception, 2026-09-30: the panel sat on "encoding the sound" at the
  // convert stage's 40% for the whole sound pass, because the pass reported
  // nothing - ffmpeg was run with no length to measure it against. It now
  // reports as it goes, before the first piece, without moving the bar.
  const sound = details.filter((d) => /^encoding the sound · \d+%/.test(d.detail));
  const firstPiece = details.findIndex((d) => /^piece /.test(d.detail));
  ok(sound.length > 0 && details.indexOf(sound[0]) < firstPiece && sound.every((d) => d.pct === 0),
    `the sound pass reports its progress live (${sound.map((d) => d.detail).slice(-1)[0] ?? 'nothing'}), before the pieces, the bar left to them`);
  const pieces = recorded.find((c) => c.plan)?.plan.pieces.length;
  ok(r.action === 'encode' && r.segmented && pieces === 3, `encoded in ${pieces} pieces and joined`);
  const [s, seg, op] = await Promise.all([times(PLAIN), times(r.outPath), times(one)]);
  ok(seg.length === s.length && new Set(seg.map((t) => t.toFixed(4))).size === seg.length,
    `${seg.length} frames of the source's ${s.length}, each once`);
  const worst = Math.max(...seg.map((t, i) => Math.abs((t - seg[0]) - (s[i] - s[0]))));
  ok(worst < 0.001, `each at its time in the source (worst ${(worst * 1000).toFixed(2)} ms)`);
  const vsOne = Math.max(...seg.map((t, i) => Math.abs((t - seg[0]) - (op[i] - op[0]))));
  ok(op.length === seg.length && vsOne < 0.0006, `and within 0.6 ms of the one-pass encode's (${(vsOne * 1000).toFixed(2)} ms)`);
  const { stderr } = await run('ffmpeg', ['-v', 'error', '-i', r.outPath, '-f', 'null', '-']);
  ok(!stderr.trim(), 'it decodes with no errors');
  ok(!fs.readdirSync(work.dir).some((f) => /^v\d{4}|^audio|^meta/.test(f)), 'and its pieces are gone once joined');
}

console.log('=== its sound is the one-pass encode\'s ===');
{
  const [a, b] = await Promise.all([audioFrames(plainSeg), audioFrames(one)]);
  ok(a.length > 0 && a.length === b.length && a.every((x, i) => x === b[i]), `the same ${a.length} audio frames, bit for bit (framemd5)`);
}

console.log('=== every piece has the same codec parameters ===');
{
  const c = recorded.at(-1).chunks.length ? recorded.at(-1) : recorded.filter((x) => x.chunks?.length === 3).at(-1);
  const params = c?.chunks?.map((ch) => JSON.stringify(ch.params)) ?? [];
  ok(params.length === 3 && new Set(params).size === 1 && /MD5:/.test(params[0]), `one SPS/PPS, profile, level and size for all three (${params[0]})`);
}

console.log('=== the picture after each join is as good as one pass\'s ===');
{
  const plan = recorded.find((c) => c.plan).plan;
  // Each piece after the first is encoded from two seconds early, with a
  // keyframe forced at the join, and the warm-up cut off: on real films a
  // piece without one began about 1.3 dB softer for a second. These little
  // made-up clips hardly show it, so the warm-up itself is checked as well.
  const later = plan.pieces.slice(1);
  const encodes = runs().filter((l) => /-frames:v/.test(l) && l.includes(PLAIN));
  const warm = Math.floor(2 / plan.frame);                // the frames in two seconds
  ok(later.every((p) => p.e - p.n === warm && Math.abs((p.first - p.seekTs) - (warm + 0.5) * plan.frame) < 0.002
    && encodes.some((l) => l.includes(`-ss ${p.seekTs.toFixed(6)}`) && l.includes(`-force_key_frames ${p.keyTs.toFixed(6)}`) && l.includes(`-frames:v ${p.e}`))),
  `pieces 2 and 3 are encoded from 2 s (${warm} frames) before their first frame, with a keyframe forced there (${later.map((p) => `${p.seekTs.toFixed(3)} -> ${p.first.toFixed(3)}`).join(', ')})`);
  for (const p of plan.pieces.slice(1)) {
    const at = p.first - plan.start;
    const [s, o] = await Promise.all([psnr(plainSeg, PLAIN, at), psnr(one, PLAIN, at)]);
    ok(s >= o - 0.5, `the second after ${at.toFixed(2)}s: ${s.toFixed(2)} dB, one pass ${o.toFixed(2)} dB`);
  }
}

console.log('=== the sound and the picture stay as far apart as in the source ===');
{
  // The first sound packet is the encoder's priming, about 21 ms before the
  // first sound a player plays; one pass puts it there too.
  const gap = async (file) => {
    const [a, v] = await Promise.all([times(file, 'a:0'), times(file, 'v:0')]);
    return a[0] - v[0];
  };
  {
    const name = 'late-audio.mkv';
    const { r } = await segmented(src(name));
    const [s, seg, op] = await Promise.all([gap(src(name)), gap(r.outPath), gap(await onePass(src(name)))]);
    ok(r.segmented && Math.abs(seg - op) < 0.002 && Math.abs(seg - s) < 0.025,
      `sound 0.5 s late: ${s.toFixed(3)}s after the picture in the source, ${seg.toFixed(3)}s in the pieces joined, ${op.toFixed(3)}s in one pass`);
  }
  {
    const name = 'late-video.mkv';
    const { r } = await segmented(src(name));
    const [s, seg] = await Promise.all([gap(src(name)), gap(r.outPath)]);
    ok(r.segmented && Math.abs(seg - s) < 0.025,
      `picture 1.0 s late: ${(-s).toFixed(3)}s after the sound in the source, ${(-seg).toFixed(3)}s in the pieces joined`);
  }
}

console.log('=== killed mid-piece, it resumes at that piece and redoes only it ===');
let killedWork = null;
{
  const work = newWork();
  const ac = new AbortController();
  const from = runs().length;
  let err = null;
  try {
    await segmented(PLAIN, { work, signal: ac.signal, onProgress: (pct, detail) => { if (/^piece 2 of 3/.test(detail) && pct > 40) ac.abort(); } });
  } catch (e) { err = e; }
  ok(err?.code === 'CANCELLED' && work.manifest.convert?.chunks?.length === 1 && piecesRun(from).join() === '0,1',
    `stopped in piece 2, with piece 1 recorded (${piecesRun(from).join(', ')} started)`);
  // The next process: what the killed ffmpeg was writing is not recorded, and goes.
  forgetThisProcess();
  const again = openWork({ workDir: WORK, key: work.key, label: work.label, isSafe: work.isSafe });
  again.lock();
  again.tidy();
  const at = runs().length;
  const seen = [];
  const { r } = await segmented(PLAIN, { work: again, onProgress: (pct, detail, extra) => { if (/^piece/.test(detail)) seen.push({ pct, run: extra?.runPct }); } });
  ok(piecesRun(at).join() === '1,2', `the restart encodes pieces 2 and 3 only (${piecesRun(at).map((k) => k + 1).join(', ')})`);
  // The time left is worked out from what is left (ffmpeg.js
  // conversionClock): the share of the film counts piece 1 as made, the
  // share of this run does not.
  ok(seen.length > 1 && seen[0].pct >= 25 && seen[0].run < 20 && seen.at(-1).run > 80 && seen.every((x) => x.run <= x.pct),
    `progress says how far the film is (${seen[0]?.pct}% at first) and how far this run is (${seen[0]?.run?.toFixed(1)}%)`);
  const [s, seg] = await Promise.all([times(PLAIN), times(r.outPath)]);
  ok(seg.length === s.length && (await audioFrames(r.outPath)).join() === (await audioFrames(one)).join(), 'and the film is whole, with its sound');
  killedWork = again;
}

console.log('=== a restart after its pieces are all made joins them, without the source an older build deleted ===');
{
  const copy = path.join(TMP, 'download.mkv');
  fs.copyFileSync(PLAIN, copy);
  const work = newWork();
  const ac = new AbortController();
  let err = null;
  try {
    // The process is killed as the join starts, and the download is gone
    // as an older build left it: it deleted the source once the pieces were
    // made. The source is kept until the film is sent now, but work an
    // older build left behind is still only joined.
    await segmented(copy, {
      work, signal: ac.signal,
      onProgress: (pct, detail) => { if (detail === 'joining the pieces' && fs.existsSync(copy)) { fs.rmSync(copy); ac.abort(); } },
    });
  } catch (e) { err = e; }
  ok(err?.code === 'CANCELLED' && !fs.existsSync(copy) && work.manifest.convert?.chunks?.length === 3, 'killed at the join, with the source gone');
  forgetThisProcess();
  const again = openWork({ workDir: WORK, key: work.key, label: work.label, isSafe: work.isSafe });
  again.lock();
  const at = runs().length;
  const r = await convertForWhatsApp(copy, again.outPath, cfg, { work: again });
  ok(r.segmented && piecesRun(at).length === 0 && (await times(r.outPath)).length === (await times(PLAIN)).length,
    'the next process joins the pieces it has, encoding nothing');
}

console.log('=== a piece made with other codec parameters sends the job back to one pass ===');
{
  const work = newWork();
  const ac = new AbortController();
  try {
    await segmented(PLAIN, { work, signal: ac.signal, onProgress: (pct, detail) => { if (/^piece 2 of 3/.test(detail) && pct > 40) ac.abort(); } });
  } catch { /* stopped in piece 2 */ }
  const c = work.manifest.convert;
  work.record({ convert: { ...c, chunks: [{ ...c.chunks[0], params: { ...c.chunks[0].params, hash: 'MD5:00000000000000000000000000000000' } }] } });
  forgetThisProcess();
  const again = openWork({ workDir: WORK, key: work.key, label: work.label, isSafe: work.isSafe });
  again.lock();
  const { r } = await segmented(PLAIN, { work: again });
  ok(!r.segmented && again.manifest.convert?.mode === 'one-pass' && /other codec parameters than the first piece/.test(again.manifest.convert.why),
    `encoded in one pass instead (${again.manifest.convert?.why?.slice(0, 80)})`);
  ok((await times(r.outPath)).length === (await times(PLAIN)).length && !fs.readdirSync(again.dir).some((f) => /^v\d{4}/.test(f)),
    'whole, and with no pieces left behind');
}

console.log('=== an ffmpeg killed in a middle piece costs that piece, not the pieces made ===');
{
  // A piece failing for anything but its own check - ffmpeg killed by a
  // signal, one that could not start - threw every piece made away and
  // encoded the whole film in one pass, for good: with 20 of The Parent
  // Trap's 24 pieces made, one such blip was some 25 minutes of CPU.
  const work = newWork();
  fs.writeFileSync(flag('DIE1'), '');
  const from = runs().length;
  let err = null;
  try { await segmented(PLAIN, { work }); } catch (e) { err = e; }
  ok(isTransient(err) && /piece 2 of 3 could not be made this time \(ffmpeg exited null/.test(err?.message ?? ''),
    `piece 2 is killed, and the job fails as one to retry (${err?.message?.slice(0, 80)})`);
  ok(work.manifest.convert?.mode === 'segmented' && work.manifest.convert.chunks.length === 1 && work.manifest.convert.failed?.k === 1,
    'piece 1 is kept, and the failure recorded');
  const firstRun = piecesRun(from);
  const at = runs().length;
  const { r } = await segmented(PLAIN, { work });
  ok(firstRun.join() === '0,1' && piecesRun(at).join() === '1,2' && r.segmented,
    `the retry goes on from piece 2 (${piecesRun(at).map((k) => k + 1).join(', ')})`);
  ok((await times(r.outPath)).length === (await times(PLAIN)).length, 'and the film is whole');
}
{
  // Killed there twice, it is the piece's own fault: one pass.
  const work = newWork();
  fs.writeFileSync(flag('DIE1'), '');
  fs.writeFileSync(flag('DIE2'), '');
  try { await segmented(PLAIN, { work }); } catch { /* the first time */ }
  const { r } = await segmented(PLAIN, { work });
  ok(!r.segmented && work.manifest.convert?.mode === 'one-pass' && /piece 2 of 3 failed twice/.test(work.manifest.convert.why ?? ''),
    `killed twice in the same piece, it is encoded in one pass (${work.manifest.convert?.why?.slice(0, 60)})`);
}

console.log('=== a library file replaced during the encode is not spliced into it ===');
{
  // A film read in place was opened by name for every piece: a release
  // moved over the old one mid-encode had the pieces from then on cut from
  // the new file, the sound and the earlier ones from the old - a film that
  // jumps at the join, its sound out of step from there. The checks cannot
  // see it at the same frame rate.
  const lib = path.join(TMP, 'lib');
  fs.mkdirSync(lib, { recursive: true });
  const film = path.join(lib, 'The Parent Trap (1998).mkv');
  fs.copyFileSync(PLAIN, film);
  const work = newWork();
  work.record({ item: { provider: 'local', id: film, access: 'local', librarySize: null, local: statOf(film) } });
  let swapped = false;
  let err = null;
  try {
    await segmented(film, {
      work,
      onProgress: (pct, detail) => {
        if (swapped || !/^piece 2 of 3/.test(detail)) return;
        swapped = true;
        const upgrade = path.join(lib, '.upgrade.mkv');
        fs.copyFileSync(src('late-video.mkv'), upgrade);
        fs.renameSync(upgrade, film);
      },
    });
  } catch (e) { err = e; }
  ok(swapped && err?.code === 'SOURCE_VANISHED' && isTransient(err), `the encode stops, as one to retry (${err?.message ?? 'no error'})`);
  ok(!work.has() && !fs.readdirSync(work.dir).some((f) => /^v\d{4}|^audio|^output/.test(f)),
    'and its work is reset: nothing made from the old file is kept, and nothing joined');
  // The retry looks the film up again and starts from the file there now.
  work.record({ item: { provider: 'local', id: film, access: 'local', librarySize: null, local: statOf(film) } });
  const { r } = await segmented(film, { work });
  ok(r.segmented && (await times(r.outPath)).length === (await times(src('late-video.mkv'))).length,
    'the retry encodes the new file, whole');
  fs.rmSync(lib, { recursive: true, force: true });
}

console.log('=== a variable frame rate, or a short source, is encoded in one pass ===');
for (const [name, why] of [['vfr.mkv', /not constant|ms after the one before/], ['short.mkv', /shorter than two 10-second pieces/]]) {
  const { r, work } = await segmented(src(name));
  ok(!r.segmented && work.manifest.convert?.mode === 'one-pass' && why.test(work.manifest.convert.why),
    `${name}: one pass - ${work.manifest.convert?.why}`);
  ok((await times(r.outPath)).length === (await times(await onePass(src(name)))).length, `${name}: the file one pass always made`);
}
{
  const info = await probe(PLAIN, cfg);
  ok(!eligible(info, { ...cfg, videoCodec: 'libx265' }, { version }).ok, 'nor is anything but libx264 cut into pieces');
  ok(!eligible(info, cfg, { version: { major: 4, minor: 4 } }).ok, 'nor on an ffmpeg older than 5.1');
  const P = Array.from({ length: 1000 }, (_, i) => i / 24);
  const plan = planPieces(P, { L: 10, W: 2, fps: 24 });
  ok(plan.pieces.length === 4 && plan.pieces.at(-1).n === 1000 - 720 && plan.pieces.reduce((a, p) => a + p.n, 0) === 1000,
    `a last piece shorter than half of one is joined to the one before (${plan.pieces.map((p) => p.n).join('+')} frames)`);
}

console.log('=== the pieces together land under the size cap ===');
{
  const { r, work } = await segmented(src('noise.mkv'));
  ok(r.segmented && r.size <= cfg.maxOutputBytes && fs.statSync(work.outPath).size === r.size,
    `a noisy film, hard to encode: ${r.size} bytes, under the ${cfg.maxOutputBytes}-byte cap`);
}

console.log('=== changed encode settings throw the pieces away ===');
{
  const work = newWork();
  const ac = new AbortController();
  try {
    await segmented(PLAIN, { work, signal: ac.signal, onProgress: (pct, detail) => { if (/^piece 2 of 3/.test(detail) && pct > 40) ac.abort(); } });
  } catch { /* stopped in piece 2 */ }
  forgetThisProcess();
  const again = openWork({ workDir: WORK, key: work.key, label: work.label, isSafe: work.isSafe });
  again.lock();
  const at = runs().length;
  const { r } = await segmented(PLAIN, { work: again, c: { ...cfg, preset: 'superfast' } });
  ok(r.segmented && piecesRun(at).join() === '0,1,2', `the pieces made with the old settings are made again, all of them (${piecesRun(at).join(', ')})`);
}

console.log('=== the source\'s tags and chapters are kept ===');
{
  const [s, o] = await Promise.all([streams(plainSeg), streams(one)]);
  ok(s.format?.tags?.title === 'The Parent Trap (test)' && s.format.tags.title === o.format?.tags?.title, `its title (${s.format?.tags?.title})`);
  const ch = (x) => (x.chapters ?? []).map((c) => `${c.tags?.title}@${Number(c.start_time).toFixed(3)}-${Number(c.end_time).toFixed(3)}`).join(', ');
  ok(s.chapters?.length === 2 && ch(s) === ch(o), `and its chapters, where one pass puts them (${ch(s)})`);
}

console.log('=== The Parent Trap, killed in its third piece, goes on from there after the restart ===');
{
  // The whole pipeline, in a process of its own, killed with SIGKILL as a
  // restart kills it (test/fixtures/killable-job.mjs), and then run again
  // here as the next start runs it.
  const kit = await makeKit('segmented-restart');
  kit.server.body = fs.readFileSync(PLAIN);
  const media = { ...DEFAULT_CONFIG.media, ...cfg, workDir: kit.WORK, deleteAfterSend: true };
  const config = mergeDefaults({
    movieRequests: { postsGroup: 'posts@g.us', notify: {}, blockedRatings: [], reactions: { redo: '🔄', failed: '⚠️', done: '✅' } },
    library: { provider: 'jellyfin' }, media,
  }, DEFAULT_CONFIG);
  const MOVIE = { title: 'The Parent Trap', year: 1998, imdbId: 'tt0120783', rated: 'PG' };
  const jobKey = 'PT:tt0120783';
  const record = { id: 'PT', request: 'the parent trap', status: 'queued', title: MOVIE.title, year: MOVIE.year };
  const hit = { id: 'pt', provider: 'jellyfin', access: 'download', container: 'mkv', size: kit.server.body.length, downloadUrl: `${kit.base}/Items/pt/Download` };
  const store = kit.loadStore();
  store.set('pending', [{ jobKey, msgId: 'PT', msgKey: null, chatJid: 'req@g.us', movie: MOVIE, meta: {}, record, at: Date.now() }]);
  const from = runs().length;
  const first = await kit.runChild({ kind: 'movie', config, movie: MOVIE, hit, record, jobKey }, { killWhen: () => piecesRun(from).includes(2), timeoutMs: 120_000 });
  const w = openWork({ workDir: kit.WORK, key: workKey.movie(jobKey), isSafe: (p) => isSafeToDeleteIn(p, { workDir: kit.WORK }) });
  ok(first.killed && w.manifest.convert?.chunks?.length === 2 && w.manifest.source?.state === 'complete',
    `killed in piece 3 of 3, with two pieces made (${w.manifest.convert?.chunks?.length})`);

  forgetThisProcess();
  const ctx = {
    config, log: { info() {}, warn() {}, error() {}, debug() {} }, store: kit.loadStore(),
    queue: { pending: [], active: new Map(), on() {}, off() {}, add() { return 'q'; } },
    bot: { sent: [], isConnected: () => true, react: async () => true, sendText: async () => ({}), groups: () => [],
      groupMemberInfo: () => ({ isMember: false }), on() {}, off() {},
      sendDocument: async (jid, file) => { ctx.bot.sent.push(fs.statSync(file).size); await times(file).then((t) => ctx.bot.frames.push(t.length)); return {}; } },
  };
  ctx.bot.frames = [];
  sweepWorkDir(kit.WORK, { all: true, live: liveWorkDirs({ movie: ctx.store.get('pending', []) }), isSafe: (p) => isSafeToDeleteIn(p, { workDir: kit.WORK }) });
  const at = runs().length;
  moviePlugin._retries = new RetryBook({ delayMs: () => 3_600_000 });
  const err = await moviePlugin.deliver({
    msg: null, movie: MOVIE, hit, ctx, record: { ...record }, react: async () => {}, jobKey,
    job: { id: 'j-after', signal: new AbortController().signal, progress() {}, isCancelled: () => false, cancelReason: () => null },
  }).then(() => null, (e) => e);
  moviePlugin._retries.clear();
  ok(!err && piecesRun(at).join() === '2', `the restart encodes the third piece only (${piecesRun(at).map((k) => k + 1).join(', ')}) ${err?.message ?? ''}`);
  ok(kit.downloads().length === 1 && kit.probes().length === 1, 'from the download the first process made, after asking the library it is the same file');
  ok(ctx.bot.frames[0] === (await times(PLAIN)).length, `and the film posted has every frame (${ctx.bot.frames[0]})`);
  kit.close();
}

/** The Parent Trap run through the whole pipeline in a process of its own, killed once `until()` says. */
async function killedInPipeline(name, until) {
  const kit = await makeKit(name);
  kit.server.body = fs.readFileSync(PLAIN);
  const media = { ...DEFAULT_CONFIG.media, ...cfg, workDir: kit.WORK, deleteAfterSend: true };
  const config = mergeDefaults({
    movieRequests: { postsGroup: 'posts@g.us', notify: {}, blockedRatings: [], reactions: { redo: '🔄', failed: '⚠️', done: '✅' } },
    library: { provider: 'jellyfin' }, media,
  }, DEFAULT_CONFIG);
  const MOVIE = { title: 'The Parent Trap', year: 1998, imdbId: 'tt0120783', rated: 'PG' };
  const jobKey = 'PT:tt0120783';
  const record = { id: 'PT', request: 'the parent trap', status: 'queued', title: MOVIE.title, year: MOVIE.year };
  const hit = { id: 'pt', provider: 'jellyfin', access: 'download', container: 'mkv', size: kit.server.body.length, downloadUrl: `${kit.base}/Items/pt/Download` };
  kit.loadStore().set('pending', [{ jobKey, msgId: 'PT', msgKey: null, chatJid: 'req@g.us', movie: MOVIE, meta: {}, record, at: Date.now() }]);
  const first = await kit.runChild({ kind: 'movie', config, movie: MOVIE, hit, record, jobKey }, { killWhen: until, timeoutMs: 120_000 });
  fs.rmSync(flag('SLOWAUDIO'), { force: true });
  fs.rmSync(flag('SLOWJOIN'), { force: true });
  fs.rmSync(flag('STALLED'), { force: true });
  const w = openWork({ workDir: kit.WORK, key: workKey.movie(jobKey), isSafe: (p) => isSafeToDeleteIn(p, { workDir: kit.WORK }) });
  const manifest = JSON.parse(JSON.stringify(w.manifest));
  forgetThisProcess();
  const logs = [];
  const ctx = {
    config, log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), debug() {} }, store: kit.loadStore(),
    queue: { pending: [], active: new Map(), on() {}, off() {}, add() { return 'q'; } },
    bot: { frames: [], isConnected: () => true, react: async () => true, sendText: async () => ({}), groups: () => [],
      groupMemberInfo: () => ({ isMember: false }), on() {}, off() {},
      sendDocument: async (jid, file) => { ctx.bot.frames.push((await times(file)).length); return {}; } },
  };
  sweepWorkDir(kit.WORK, { all: true, live: liveWorkDirs({ movie: ctx.store.get('pending', []) }), isSafe: (p) => isSafeToDeleteIn(p, { workDir: kit.WORK }) });
  const at = runs().length;
  moviePlugin._retries = new RetryBook({ delayMs: () => 3_600_000 });
  const err = await moviePlugin.deliver({
    msg: null, movie: MOVIE, hit, ctx, record: { ...record }, react: async () => {}, jobKey,
    job: { id: `j-${name}`, signal: new AbortController().signal, progress() {}, isCancelled: () => false, cancelReason: () => null },
  }).then(() => null, (e) => e);
  moviePlugin._retries.clear();
  const after = runs().slice(at);
  kit.close();
  return { first, manifest, err, after, logs, frames: ctx.bot.frames, downloads: kit.downloads().length, pieces: piecesRun(at) };
}

console.log('=== The Parent Trap, killed in its sound pass, redoes the sound and the pieces from the download it kept ===');
{
  fs.writeFileSync(flag('SLOWAUDIO'), '');
  const k = await killedInPipeline('segmented-sound', () => fs.existsSync(flag('STALLED')));
  ok(k.first.killed && k.manifest.source?.state === 'complete' && k.manifest.convert?.mode === 'segmented' && !k.manifest.convert.audio,
    'killed while its sound was being written, with the download whole and no sound recorded');
  ok(!k.err && k.after.some((l) => l.includes('audio.m4a.part')) && k.pieces.join() === '0,1,2',
    `the restart makes the sound again, then every piece (${k.pieces.map((x) => x + 1).join(', ')}) ${k.err?.message ?? ''}`);
  ok(k.downloads === 1 && k.frames[0] === (await times(PLAIN)).length, `from the one download, and posts every frame (${k.frames[0]})`);
}

console.log('=== The Parent Trap, killed before the join, is only joined ===');
{
  fs.writeFileSync(flag('SLOWJOIN'), '');
  const k = await killedInPipeline('segmented-join', () => fs.existsSync(flag('STALLED')));
  // The download is kept until the film is sent (the operator, 2026-09-30:
  // "files should remain in their folders until fully sent on whatsapp").
  ok(k.first.killed && k.manifest.source?.state === 'complete' && k.manifest.convert?.chunks?.length === 3,
    'killed at the join, with every piece made and the download still whole beside them');
  ok(!k.err && k.logs.some((l) => /all its pieces were converted before the restart - joining them/.test(l)),
    `the restart says it only joins them ${k.err?.message ?? ''}`);
  ok(k.pieces.length === 0 && k.downloads === 1, 'encoding nothing and downloading nothing');
  ok(k.frames[0] === (await times(PLAIN)).length, `and posts every frame (${k.frames[0]})`);
}

killedWork?.release();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
