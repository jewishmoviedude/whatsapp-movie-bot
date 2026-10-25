/* A segmented encode reads a remux's packet times within the bot's memory, and one it cannot read goes to one pass.
   Run: node test/segmented-packet-scan.test.mjs

   The sound of a Blu-ray remux is usually TrueHD, which MKV holds as 1,200
   packets a second. A two-hour one is 8,640,000 of them: on ffprobe 6.1.1
   on this box, a made-up two-hour TrueHD mkv gave 197 MB of packet lines,
   and reading them the way the segmented encode first did - the whole of
   ffprobe's output as one string, then an array and a typed array of every
   time - peaked at 1,106,744 KB of memory and took 52 seconds. The bot's
   box has under a gigabyte: it would have been killed at that film, and
   recovery would have resumed the same film at every start after, into the
   same scan - a crash loop. Only the sound's span is ever used. And a scan
   that failed outright (ffprobe exiting non-zero, its output over the
   512 MB it was allowed) failed the film for good, where the film can
   always be encoded in one pass.

   Stub ffprobe and ffmpeg stand in for the real ones: no ffmpeg is needed. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { convertForWhatsApp } from '../src/media/ffmpeg.js';
import { openWork, workKey, isSafeToDeleteIn } from '../src/media/work-files.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'packet-scan-'));

console.log('=== the sound of a long TrueHD remux is scanned in a few megabytes, not a gigabyte ===');
{
  // Four million packets: 55 minutes of TrueHD, some 100 MB of lines.
  const N = 4_000_000;
  const FFPROBE = path.join(TMP, 'ffprobe-truehd');
  fs.writeFileSync(FFPROBE, `#!/bin/sh
awk 'BEGIN { for (i = 0; i < ${N}; i++) printf "%.6f,0.000833,40,K__\\n", i / 1200 }'
`, { mode: 0o755 });
  // In a process of its own with a small heap: holding the output whole
  // (100 MB of text) cannot fit in it.
  const script = path.join(TMP, 'scan.mjs');
  fs.writeFileSync(script, `
import { packets } from ${JSON.stringify(path.join(HERE, '..', 'src', 'media', 'segmented.js'))};
const a = await packets({ ffprobePath: ${JSON.stringify(FFPROBE)} }, 'remux.mkv', 'a:0', { span: true });
console.log(JSON.stringify({ count: a.count, first: a.first, end: a.end, times: a.P, maxRssKb: process.resourceUsage().maxRSS }));
`);
  const started = Date.now();
  const res = spawnSync(process.execPath, ['--max-old-space-size=48', script], { encoding: 'utf8', timeout: 120_000 });
  const out = (() => { try { return JSON.parse(res.stdout.trim().split('\n').pop()); } catch { return null; } })();
  ok(res.status === 0 && out?.count === N, `all ${N} packets are read, under a 48 MB heap (exit ${res.status}${res.status ? `: ${res.stderr.split('\n').filter(Boolean).slice(-2).join(' | ')}` : ''})`);
  ok(out && out.first === 0 && Math.abs(out.end - ((N - 1) / 1200 + 0.000833)) < 1e-6, `and give its span: ${out?.end?.toFixed(3)}s`);
  ok(out && out.times === null, 'with no time kept for each packet');
  ok(out && out.maxRssKb < 250 * 1024, `the process peaked at ${Math.round((out?.maxRssKb ?? 0) / 1024)} MB, in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

console.log('=== a packet scan that fails sends the film to one pass, not to a failure ===');
{
  const FFPROBE = path.join(TMP, 'ffprobe-fails');
  fs.writeFileSync(FFPROBE, `#!/bin/sh
case "$*" in
  *packet=*) echo "remux.mkv: Invalid data found when processing input" >&2; exit 1 ;;
esac
cat <<'JSON'
{"streams":[{"codec_type":"video","codec_name":"hevc","width":1920,"height":1080,"r_frame_rate":"24/1","avg_frame_rate":"24/1","time_base":"1/1000"},{"codec_type":"audio","codec_name":"truehd","channels":8}],"format":{"format_name":"matroska,webm","duration":"700","size":"9000000000","start_time":"0"}}
JSON
`, { mode: 0o755 });
  const FFMPEG = path.join(TMP, 'ffmpeg');
  fs.writeFileSync(FFMPEG, `#!/bin/sh
if [ "$1" = "-version" ]; then echo "ffmpeg version 6.1.1 Copyright (c) 2000-2023 the FFmpeg developers"; exit 0; fi
prev=""; out=""
for a in "$@"; do [ "$a" = "-progress" ] && out="$prev"; prev="$a"; done
printf 'encoded' > "$out"
`, { mode: 0o755 });
  const WORK = path.join(TMP, 'work');
  fs.mkdirSync(WORK);
  const input = path.join(TMP, 'remux.mkv');
  fs.writeFileSync(input, 'not really a film');
  const work = openWork({ workDir: WORK, key: workKey.movie('SCAN:tt0120783'), label: 'The Parent Trap', isSafe: (p) => isSafeToDeleteIn(p, { workDir: WORK }) });
  work.lock();
  const cfg = {
    ffprobePath: FFPROBE, ffmpegPath: FFMPEG, strategy: 'always-transcode', videoCodec: 'libx264', preset: 'veryfast', maxHeight: 720,
    audioCodec: 'aac', audioBitrateK: 128, maxOutputBytes: 1932735283, segmentedEncode: true, segmentSec: 300, segmentWarmupSec: 5,
    videoEncoder: 'cpu',
  };
  let r = null;
  let err = null;
  try { r = await convertForWhatsApp(input, work.outPath, cfg, { work }); } catch (e) { err = e; }
  ok(!err && r?.action === 'encode' && !r.segmented && fs.readFileSync(work.outPath, 'utf8') === 'encoded',
    `the film is encoded in one pass (${err?.message ?? r?.action})`);
  ok(work.manifest.convert?.mode === 'one-pass' && /could not read its packet times: ffprobe exited 1: remux\.mkv: Invalid data/.test(work.manifest.convert.why ?? ''),
    `and its work records why, so a restart does not try again (${work.manifest.convert?.why})`);
  work.release();
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
