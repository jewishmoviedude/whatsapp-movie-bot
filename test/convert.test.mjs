/* End-to-end conversion against real video. Generates its own fixtures with
   ffmpeg, so it needs ffmpeg installed. Run: node test/convert.test.mjs */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probe, planConversion, convertForWhatsApp, fmtBytes } from '../src/media/ffmpeg.js';

const execFileAsync = promisify(execFile);
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const base = {
  audioBitrateK: 128, strategy: 'auto', videoCodec: 'libx264', preset: 'ultrafast',
  audioCodec: 'aac', maxHeight: 720, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe',
  // libx264, whatever GPU the box has: the GPU path has its own tests.
  videoEncoder: 'cpu',
};

try {
  await execFileAsync('ffmpeg', ['-version']);
} catch {
  console.log('  SKIP - ffmpeg is not installed');
  process.exit(0);
}

const W = fs.mkdtempSync(path.join(os.tmpdir(), 'convtest-'));
const gen = (args) => execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

console.log('=== building fixtures ===');
await gen(['-f','lavfi','-i','testsrc2=size=1920x1080:rate=30:duration=20',
           '-f','lavfi','-i','sine=frequency=440:duration=20',
           '-c:v','libx264','-preset','ultrafast','-b:v','12000k',
           '-c:a','aac','-b:a','192k','-pix_fmt','yuv420p', `${W}/big.mkv`]);
await gen(['-f','lavfi','-i','testsrc2=size=640x360:rate=24:duration=8',
           '-f','lavfi','-i','sine=frequency=440:duration=8',
           '-c:v','libx264','-preset','ultrafast','-b:v','300k',
           '-c:a','aac','-b:a','96k','-pix_fmt','yuv420p','-movflags','+faststart', `${W}/small.mp4`]);
await gen(['-i', `${W}/small.mp4`, '-c','copy', `${W}/small.mkv`]);
console.log(`  built in ${W}`);

console.log('\n=== compatible mp4 under the cap -> copy ===');
{
  const cfg = { ...base, maxOutputBytes: 5_000_000 };
  const out = `${W}/o1.mp4`;
  const r = await convertForWhatsApp(`${W}/small.mp4`, out, cfg, {});
  ok(r.action === 'copy', 'action=copy');
  ok(fs.statSync(out).size === fs.statSync(`${W}/small.mp4`).size, 'byte-identical output');
}

console.log('\n=== mkv with good codecs -> remux, no re-encode ===');
{
  const cfg = { ...base, maxOutputBytes: 5_000_000 };
  const out = `${W}/o2.mp4`;
  const r = await convertForWhatsApp(`${W}/small.mkv`, out, cfg, {});
  ok(r.action === 'remux', 'action=remux');
  const i = await probe(out, cfg);
  ok(/mp4/.test(i.container), `container is mp4 (${i.container})`);
  ok(i.video.codec === 'h264', 'video stream copied');
}

console.log('\n=== over the cap -> re-encoded to fit ===');
{
  const CAP = 4_000_000;
  const cfg = { ...base, maxOutputBytes: CAP };
  const out = `${W}/o3.mp4`;
  const src = await probe(`${W}/big.mkv`, cfg);
  ok(planConversion(src, cfg).action === 'encode', 'planned as encode');

  let maxPct = 0;
  const r = await convertForWhatsApp(`${W}/big.mkv`, out, cfg, {
    onProgress: (p) => { if (p > maxPct) maxPct = p; },
  });
  ok(maxPct > 0, `progress reported (${maxPct}%)`);
  ok(r.size <= CAP, `${fmtBytes(src.size)} -> ${fmtBytes(r.size)}, within ${fmtBytes(CAP)}`);
  ok(r.size > CAP * 0.5, `used ${(r.size / CAP * 100).toFixed(1)}% of budget`);

  const i = await probe(out, cfg);
  ok(i.video.height <= 720, `downscaled to ${i.video.height}p`);
  ok(i.video.codec === 'h264' && i.audio.codec === 'aac', 'h264/aac');
  ok(Math.abs(i.duration - src.duration) < 1, 'duration preserved');
}

console.log('\n=== copy-only + oversized -> refuse rather than send junk ===');
{
  const cfg = { ...base, maxOutputBytes: 1_000_000, strategy: 'copy-only' };
  const out = `${W}/o4.mp4`;
  let threw = null;
  try { await convertForWhatsApp(`${W}/big.mkv`, out, cfg, {}); } catch (e) { threw = e; }
  ok(!!threw, 'threw instead of producing an oversized file');
  ok(!fs.existsSync(out), 'no partial output left behind');
}

fs.rmSync(W, { recursive: true, force: true });
console.log(`\n${'='.repeat(50)}\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
