/* NVENC's pieces are made at one bitrate, never joined to CPU pieces, and a GPU that fails them hands the job to libx264.
   Run: node test/segmented-nvenc.test.mjs   (needs ffmpeg 5.1 or later; SKIP without it)

   2026-09-29: the bot moved to a laptop whose NVIDIA GPU encodes with
   h264_nvenc (ffmpeg.js pickEncoder) on the day re-encodes began to be made
   in 5-minute pieces that a restart goes on from (media/segmented.js). The
   NVENC change's author found that NVENC writes the bitrate into the SPS -
   pieces made at different bitrates have different SPS (the PPS is the
   same), and cannot be joined - while at one fixed bitrate the SPS matched.
   libx264's pieces steer their bitrate towards the budget, and are not
   affected. Checked again on the laptop's GPU when the two were merged: the
   SPS of two NVENC encodes at 2.9 and 3.1 Mbit/s differ in their HRD
   bit_rate_value and cpb_size_value, and a 75-second 1080p clip cut into
   four 20-second NVENC pieces at one bitrate joined and passed every check,
   its video within 1% of the budget.

   So an NVENC job's pieces are all made at one bitrate; the encoder is part
   of settingsHash, so GPU pieces are never joined to CPU ones; and a piece
   NVENC fails, or pieces over the cap, send the job back to the start of its
   pieces on libx264 - noted on its work, so a restart stays on the CPU.

   No GPU is used here: the ffmpeg given to the code is a stand-in that runs
   the real ffmpeg with libx264 wherever it is asked for h264_nvenc, logging
   what it was asked for, and that fails or overshoots on cue. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { convertForWhatsApp, encoderStatus, jobEncoder, _resetNvenc } from '../src/media/ffmpeg.js';
import { ffmpegVersion, settingsHash, segmentsReady, eligible } from '../src/media/segmented.js';
import { openWork, workKey, isSafeToDeleteIn } from '../src/media/work-files.js';

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'segmented-nvenc-'));
const flag = (f) => path.join(TMP, f);
const RUNS = flag('runs.log');
const FFMPEG = flag('ffmpeg.mjs');
// The stand-in: h264_nvenc becomes libx264 at the same bitrate - or three
// times it with OVERSHOOT - and with FAIL1 an NVENC run of piece 2 fails as
// a driver that has gone away does.
fs.writeFileSync(FFMPEG, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(RUNS)}, a.join(' ') + '\\n');
const nv = a.includes('h264_nvenc');
if (nv && fs.existsSync(${JSON.stringify(flag('FAIL1'))}) && a.some((x) => /v0001\\..*raw\\.ts$/.test(x))) {
  process.stderr.write('OpenEncodeSessionEx failed: no encode device (2)\\n');
  process.exit(1);
}
const drop = new Set(['-tune', '-rc', '-spatial-aq', '-rc-lookahead']);
const times = nv && fs.existsSync(${JSON.stringify(flag('OVERSHOOT'))}) ? 3 : 1;
const out = [];
for (let i = 0; i < a.length; i++) {
  if (nv && drop.has(a[i])) { i++; continue; }
  if (nv && a[i] === '-c:v') { out.push('-c:v', 'libx264'); i++; continue; }
  if (nv && a[i] === '-preset') { out.push('-preset', 'ultrafast'); i++; continue; }
  if (nv && ['-b:v', '-maxrate', '-bufsize'].includes(a[i])) { out.push(a[i], String(Number(a[i + 1]) * times)); i++; continue; }
  out.push(a[i]);
}
const r = spawnSync('nice', ['-n', '19', 'ffmpeg', ...out], { stdio: 'inherit' });
process.exit(r.status ?? 1);
`, { mode: 0o755 });
const runs = () => (fs.existsSync(RUNS) ? fs.readFileSync(RUNS, 'utf8').split('\n').filter(Boolean) : []);
const pieceRuns = (from) => runs().slice(from).filter((l) => /-frames:v \d+ .* v\d{4}\.[0-9a-f]+\.raw\.ts/.test(l));
const arg = (line, f) => { const p = line.split(' '); return p[p.indexOf(f) + 1]; };

console.log('=== building a fixture ===');
const SRC = flag('film.mkv');
await run('nice', ['-n', '19', 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24000/1001:duration=32',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=32:sample_rate=48000',
  '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-bf', '3', '-g', '48', '-c:a', 'ac3', '-b:a', '192k', SRC]);

const cfg = {
  audioBitrateK: 128, strategy: 'always-transcode', videoCodec: 'libx264', preset: 'ultrafast', encodeProfile: 'custom',
  audioCodec: 'aac', maxHeight: 240, ffmpegPath: FFMPEG, ffprobePath: 'ffprobe', maxOutputBytes: 2_250_000,
  segmentedEncode: true, segmentSec: 10, segmentWarmupSec: 2, videoEncoder: 'nvenc',
};
const WORK = flag('work');
fs.mkdirSync(WORK);
let n = 0;
function newWork() {
  n += 1;
  const w = openWork({ workDir: WORK, key: workKey.movie(`NV${n}:tt0120783`), label: `film ${n}`, isSafe: (p) => isSafeToDeleteIn(p, { workDir: WORK }) });
  w.lock();
  return w;
}

console.log('=== the encoder is part of what pieces are made with ===');
{
  const v = await ffmpegVersion(cfg);
  ok(settingsHash(cfg, v, 'nvenc') !== settingsHash(cfg, v, 'cpu'), 'GPU and CPU pieces have different settings, so they are never joined');
  ok(settingsHash(cfg, v) === settingsHash(cfg, v, 'cpu'), 'and pieces made on the CPU keep the hash they had');
  const info = { duration: 600, videoCount: 1, startTime: 0, video: { rFrameRate: '24/1', avgFrameRate: '24/1' } };
  ok(eligible(info, { ...cfg, videoCodec: 'h264_nvenc' }, { version: v, encoder: 'nvenc' }).ok, 'an NVENC job may be cut into pieces');
  ok(!eligible(info, { ...cfg, videoCodec: 'libx265' }, { version: v }).ok, 'another CPU codec still may not');
}

console.log('=== NVENC pieces are made at one bitrate, and joined ===');
{
  // A cap big enough that the budget is not the 400 kbps floor, where
  // libx264's pieces steer their bitrate - as a CPU run beside it shows.
  const roomy = { ...cfg, maxOutputBytes: 20_000_000 };
  _resetNvenc();
  const cpuFrom = runs().length;
  const cw = newWork();
  await convertForWhatsApp(SRC, cw.outPath, { ...roomy, videoEncoder: 'cpu' }, { work: cw });
  const cpuRates = new Set(pieceRuns(cpuFrom).map((l) => arg(l, '-b:v')));
  ok(cpuRates.size > 1, `libx264's pieces steer their bitrate (${[...cpuRates].join(', ')})`);
  const from = runs().length;
  const work = newWork();
  const r = await convertForWhatsApp(SRC, work.outPath, roomy, { work });
  const pieces = pieceRuns(from);
  ok(r.segmented && r.encoder === 'h264_nvenc' && !r.gpuFallback, `segmented on the GPU (${r.encoder}, ${pieces.length} pieces)`);
  ok(pieces.length >= 3 && pieces.every((l) => arg(l, '-c:v') === 'h264_nvenc'), 'every piece asked of h264_nvenc');
  ok(new Set(pieces.map((l) => arg(l, '-b:v'))).size === 1, `all at one bitrate (${[...new Set(pieces.map((l) => arg(l, '-b:v')))].join(', ')})`);
  ok(pieces.every((l) => arg(l, '-level:v')) && pieces.slice(1).every((l) => l.includes('-force_key_frames') && l.includes('-forced-idr 1')),
    'with the level pinned, and the join keyframes forced as for libx264');
  ok(r.size <= roomy.maxOutputBytes && fs.existsSync(work.outPath), `under the cap (${r.size})`);
  ok(encoderStatus(cfg).nvencEncodes === 1 && encoderStatus(cfg).failures === 0, 'counted as a GPU success');
}

console.log('=== a piece NVENC fails sends the job\'s pieces to libx264 ===');
{
  _resetNvenc();
  fs.writeFileSync(flag('FAIL1'), '');
  const from = runs().length;
  const work = newWork();
  const r = await convertForWhatsApp(SRC, work.outPath, cfg, { work });
  fs.rmSync(flag('FAIL1'), { force: true });
  const pieces = pieceRuns(from);
  const firstCpu = pieces.findIndex((l) => arg(l, '-c:v') === 'libx264');
  ok(r.segmented && r.encoder === 'libx264' && r.gpuFallback?.reason === 'error' && /OpenEncodeSession|piece 2/.test(r.gpuFallback.error),
    `made in pieces on the CPU after the GPU failed (${r.encoder}: ${r.gpuFallback?.error})`);
  ok(firstCpu === 2 && pieces.slice(0, 2).every((l) => arg(l, '-c:v') === 'h264_nvenc'), 'NVENC made piece 1 and failed piece 2');
  ok(/v0000\./.test(pieces[firstCpu]) && pieces.slice(firstCpu).every((l) => arg(l, '-c:v') === 'libx264'),
    'and libx264 began again from piece 1: no GPU piece is joined to CPU ones');
  ok(encoderStatus(cfg).failures === 1, 'counted as a GPU failure');
  ok(!!work.manifest.gpuFallback && await jobEncoder(cfg, work) === 'cpu', 'noted on the job, so a restart goes on with the CPU pieces');
  ok(await segmentsReady(work, cfg) === false, 'and nothing is left to be joined twice');
}

console.log('=== NVENC pieces that would not fit are made again on the CPU before they are joined ===');
{
  _resetNvenc();
  fs.writeFileSync(flag('OVERSHOOT'), '');
  const work = newWork();
  const r = await convertForWhatsApp(SRC, work.outPath, cfg, { work });
  fs.rmSync(flag('OVERSHOOT'), { force: true });
  ok(r.encoder === 'libx264' && r.gpuFallback?.reason === 'oversize' && r.size <= cfg.maxOutputBytes,
    `the CPU's pieces are sent (${r.encoder}, ${r.gpuFallback?.reason}, ${r.size})`);
  ok(fs.existsSync(SRC), 'and the source is still there: it is kept until the film is sent');
  ok(encoderStatus(cfg).failures === 0, 'an overshoot does not count towards turning NVENC off');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
