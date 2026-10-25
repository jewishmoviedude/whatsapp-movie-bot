/* Re-encodes use the NVIDIA GPU when it works, and a GPU that fails never fails a request.
   Run: node test/nvenc-encoder.test.mjs

   Why, 2026-09-29: conversion was the slow step - libx264 at ~3.4x real
   time on the laptop's laptop CPU, about 30 minutes a film - and the operator
   moved the bot to WSL2 for the laptop's NVIDIA GPU, where h264_nvenc
   works. media.videoEncoder picks the encoder: 'auto' probes NVENC once,
   'nvenc' and 'cpu' force one. A GPU is also a new way to fail (no device,
   a Windows driver update pulling it out from under WSL2, the concurrent
   session limit), so a failed NVENC encode goes again with libx264, and
   three in a row leave the GPU alone until restart.

   No real encoding here: ffprobe and ffmpeg are stubs that record their
   arguments and write a few bytes to the output path, in a temp dir. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../src/config/schema.js';
import {
  convertForWhatsApp, buildEncodeArgs, pickEncoder, targetVideoBitrate, encoderStatus,
  NVENC_MAX_FAILURES, _resetNvenc,
} from '../src/media/ffmpeg.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-encoder-'));
const IN = path.join(TMP, 'film.mkv');
const OUT = path.join(TMP, 'film.mp4');
fs.writeFileSync(IN, 'x');

// The Balanced profile (720p, veryfast) this was written against, the default
// until 2026-10-12 (live-settings-defaults); the fast cases ask for Fast.
const cfg = (over = {}) => ({ ...DEFAULT_CONFIG.media, encodeProfile: 'balanced', preset: 'veryfast', ...over });
// A two-hour 1080p HEVC film, 6 GB: over the cap, so the plan is encode.
const info = {
  size: 6 * 1024 ** 3, duration: 7200, container: 'matroska,webm',
  video: { codec: 'hevc', width: 1920, height: 1080 }, audio: { codec: 'eac3', channels: 6 },
};
const probeMedia = async () => info;

// The ffmpeg stub: records every call; `failNvenc` makes an h264_nvenc run
// throw the way runFfmpeg does, `bytes` is what it "writes".
function stubRun({ failNvenc = null, bytes = () => 1000 } = {}) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const nv = args.includes('h264_nvenc');
    if (nv && failNvenc) throw failNvenc;
    fs.writeFileSync(args[args.length - 1], Buffer.alloc(bytes(nv)));
  };
  return { run, calls };
}
const codecOf = (args) => args[args.indexOf('-c:v') + 1];
const probeYes = async () => true;
const probeNo = async () => false;

console.log('=== auto picks the GPU only when the probe says it works ===');
{
  _resetNvenc();
  ok(DEFAULT_CONFIG.media.videoEncoder === 'auto', 'the default encoder setting is auto');
  ok(await pickEncoder(cfg(), { probeNvenc: probeYes }) === 'nvenc', 'auto + a working probe -> nvenc');
  ok(await pickEncoder(cfg(), { probeNvenc: probeNo }) === 'cpu', 'auto + a failing probe -> cpu');
  const s = stubRun();
  const r = await convertForWhatsApp(IN, OUT, cfg(), { run: s.run, probeMedia, probeNvenc: probeYes });
  ok(r.action === 'encode' && r.encoder === 'h264_nvenc' && codecOf(s.calls[0]) === 'h264_nvenc',
    'auto with a working probe encodes with h264_nvenc');
  const s2 = stubRun();
  const r2 = await convertForWhatsApp(IN, OUT, cfg(), { run: s2.run, probeMedia, probeNvenc: probeNo });
  ok(r2.encoder === 'libx264' && s2.calls.length === 1 && codecOf(s2.calls[0]) === 'libx264',
    'auto with a failing probe encodes with libx264, and only once');
}

console.log('\n=== forced cpu never touches NVENC, not even the probe ===');
{
  _resetNvenc();
  let probed = 0;
  const s = stubRun();
  const r = await convertForWhatsApp(IN, OUT, cfg({ videoEncoder: 'cpu' }),
    { run: s.run, probeMedia, probeNvenc: async () => { probed += 1; return true; } });
  ok(probed === 0, 'the NVENC probe is never run');
  ok(s.calls.every((a) => !a.join(' ').includes('nvenc')) && r.encoder === 'libx264', 'no nvenc in any ffmpeg call');
}

console.log('\n=== forced nvenc skips the probe ===');
{
  _resetNvenc();
  const s = stubRun();
  const r = await convertForWhatsApp(IN, OUT, cfg({ videoEncoder: 'nvenc' }), { run: s.run, probeMedia, probeNvenc: probeNo });
  ok(r.encoder === 'h264_nvenc', 'nvenc is used even though the probe would have said no');
}

console.log('\n=== the NVENC argument list ===');
{
  const c = cfg();
  const a = buildEncodeArgs({ input: IN, outPath: OUT, info, cfg: c, encoder: 'nvenc' });
  const after = (flag) => a[a.indexOf(flag) + 1];
  const vb = targetVideoBitrate(info.duration, c);
  ok(after('-c:v') === 'h264_nvenc', '-c:v h264_nvenc');
  ok(after('-preset') === 'p5' && after('-tune') === 'hq', 'balanced (x264 veryfast) -> -preset p5 -tune hq');
  ok(after('-profile:v') === 'high', '-profile:v high, as libx264 writes');
  ok(after('-rc') === 'cbr', '-rc cbr, which lands under the cap as libx264 does');
  ok(after('-b:v') === String(vb) && after('-maxrate') === String(Math.floor(vb * 1.5)) && after('-bufsize') === String(vb * 2),
    'the same -b:v / -maxrate / -bufsize the libx264 path computes');
  ok(after('-pix_fmt') === 'yuv420p', '-pix_fmt yuv420p');
  ok(after('-vf') === 'scale=-2:720', 'scaled to 720p on the CPU, as before');
  ok(!a.includes('-hwaccel'), 'decoding stays on the CPU (no -hwaccel)');
  ok(a.includes('-map') && after('-c:a') === 'aac' && after('-b:a') === '128k' && after('-ac') === '2',
    'the same audio and stream mapping');
  ok(after('-movflags') === '+faststart' && a[a.length - 1] === OUT, 'faststart, output last');
  ok(!a.includes('-threads'), 'no x264 -threads for the GPU');
  const fast = buildEncodeArgs({ input: IN, outPath: OUT, info, cfg: cfg({ encodeProfile: 'fast' }), encoder: 'nvenc' });
  ok(fast[fast.indexOf('-preset') + 1] === 'p2' && fast[fast.indexOf('-vf') + 1] === 'scale=-2:480',
    'fast profile -> p2 at 480p');
}

console.log('\n=== the size budget is identical on both encoders ===');
{
  for (const [label, over] of [['balanced', {}], ['fast', { encodeProfile: 'fast' }], ['smaller cap', { maxOutputBytes: 1e9 }]]) {
    const c = cfg(over);
    const pick = (a) => ['-b:v', '-maxrate', '-bufsize', '-vf', '-b:a'].map((f) => a[a.indexOf(f) + 1]).join(' ');
    const cpu = buildEncodeArgs({ input: IN, outPath: OUT, info, cfg: c, encoder: 'cpu' });
    const gpu = buildEncodeArgs({ input: IN, outPath: OUT, info, cfg: c, encoder: 'nvenc' });
    ok(pick(cpu) === pick(gpu), `${label}: ${pick(gpu)}`);
  }
  const cpu = buildEncodeArgs({ input: IN, outPath: OUT, info, cfg: cfg(), encoder: 'cpu' });
  ok(cpu.join(' ').includes('-c:v libx264 -preset veryfast') && cpu.includes('-threads'),
    'the libx264 arguments are unchanged');
}

console.log('\n=== a failed NVENC encode goes again on the CPU, and the job succeeds ===');
{
  _resetNvenc();
  const s = stubRun({ failNvenc: new Error('ffmpeg exited 1: OpenEncodeSessionEx failed: out of memory (10)') });
  const r = await convertForWhatsApp(IN, OUT, cfg(), { run: s.run, probeMedia, probeNvenc: probeYes });
  ok(s.calls.length === 2 && codecOf(s.calls[0]) === 'h264_nvenc' && codecOf(s.calls[1]) === 'libx264',
    'nvenc tried first, then libx264');
  ok(r.action === 'encode' && r.encoder === 'libx264' && fs.existsSync(OUT), 'the conversion succeeds');
  ok(r.gpuFallback?.reason === 'error' && /OpenEncodeSession/.test(r.gpuFallback.error), 'the fallback is on the result');
  ok(encoderStatus(cfg()).failures === 1 && /OpenEncodeSession/.test(encoderStatus(cfg()).lastError), 'and recorded');
}

console.log(`\n=== ${NVENC_MAX_FAILURES} failures in a row leave the GPU alone until restart ===`);
{
  _resetNvenc();
  const err = new Error('ffmpeg exited 1: Cannot load libcuda.so.1');
  for (let i = 0; i < NVENC_MAX_FAILURES; i++) {
    const s = stubRun({ failNvenc: err });
    await convertForWhatsApp(IN, OUT, cfg(), { run: s.run, probeMedia, probeNvenc: probeYes });
  }
  ok(encoderStatus(cfg()).disabled === true, 'NVENC is off');
  const s = stubRun({ failNvenc: err });
  const r = await convertForWhatsApp(IN, OUT, cfg({ videoEncoder: 'nvenc' }), { run: s.run, probeMedia, probeNvenc: probeYes });
  ok(s.calls.length === 1 && codecOf(s.calls[0]) === 'libx264' && r.gpuFallback === null,
    'the next film goes straight to libx264, even with nvenc forced');
  _resetNvenc();
  const s1 = stubRun({ failNvenc: err });
  await convertForWhatsApp(IN, OUT, cfg(), { run: s1.run, probeMedia, probeNvenc: probeYes });
  const s2 = stubRun();
  await convertForWhatsApp(IN, OUT, cfg(), { run: s2.run, probeMedia, probeNvenc: probeYes });
  ok(encoderStatus(cfg()).failures === 0 && !encoderStatus(cfg()).disabled, 'a success in between resets the count');
}

console.log('\n=== cancelling or a full disk is not a GPU fault ===');
{
  _resetNvenc();
  for (const code of ['CANCELLED', 'ENOSPC']) {
    const s = stubRun({ failNvenc: Object.assign(new Error(code), { code }) });
    let threw = null;
    try { await convertForWhatsApp(IN, OUT, cfg(), { run: s.run, probeMedia, probeNvenc: probeYes }); } catch (e) { threw = e; }
    ok(threw?.code === code && s.calls.length === 1, `${code} propagates without a CPU retry`);
  }
  ok(encoderStatus(cfg()).failures === 0, 'and neither counts as a GPU failure');
}

console.log('\n=== an NVENC file over the cap is made again on the CPU ===');
{
  _resetNvenc();
  const c = cfg({ maxOutputBytes: 5000 });
  const s = stubRun({ bytes: (nv) => (nv ? 6000 : 4000) });
  const r = await convertForWhatsApp(IN, OUT, c, { run: s.run, probeMedia, probeNvenc: probeYes });
  ok(r.encoder === 'libx264' && r.size === 4000 && r.gpuFallback?.reason === 'oversize', 'libx264 output under the cap is sent');
  ok(encoderStatus(c).failures === 0, 'an overshoot does not count towards turning NVENC off');
}

console.log('\n=== copy and remux never encode ===');
{
  _resetNvenc();
  let probed = 0;
  const s = stubRun();
  const small = { ...info, size: 1e6, container: 'matroska,webm', video: { codec: 'h264', height: 720 }, audio: { codec: 'aac' } };
  const r = await convertForWhatsApp(IN, OUT, cfg(), {
    run: s.run, probeMedia: async () => small, probeNvenc: async () => { probed += 1; return true; },
  });
  ok(r.action === 'remux' && probed === 0 && !s.calls[0].includes('-c:v') && s.calls[0].includes('copy'),
    'a remux is a stream copy and never probes NVENC');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
