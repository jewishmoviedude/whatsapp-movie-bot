import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import log from '../util/logger.js';
import { encodeSegmented, segmentsReady, joinReady, ffmpegVersion } from './segmented.js';

const execFileAsync = promisify(execFile);
const logger = log.scope('ffmpeg');

/**
 * Encode speed/quality profiles. On the CPU, re-encoding is software x264 at
 * roughly 3-6x realtime - a full movie took ~30 min on the laptop's
 * laptop CPU. Where NVENC works (media.videoEncoder, pickEncoder below) the
 * preset is mapped onto an NVENC preset instead. The levers are resolution
 * and preset; both trade quality for speed. Lower resolution helps most because it cuts
 * pixel count AND lets the same size budget buy more quality per pixel.
 */
export const ENCODE_PROFILES = {
  // Fast is the default since 2026-10-12, the operator's live setting (schema.js).
  fast:     { preset: 'ultrafast', maxHeight: 480, blurb: 'Fast · 480p · ~2\u00d7 quicker, fine on a phone · the default' },
  balanced: { preset: 'veryfast',  maxHeight: 720, blurb: 'Balanced · 720p' },
  quality:  { preset: 'faster',    maxHeight: 720, blurb: 'Best · 720p · slower, sharper' },
};

/** Effective preset + height: a named profile overrides the raw fields. */
export function effectiveEncode(cfg) {
  const prof = ENCODE_PROFILES[cfg.encodeProfile];
  return prof
    ? { preset: prof.preset, maxHeight: prof.maxHeight }
    : { preset: cfg.preset, maxHeight: cfg.maxHeight };
}

export async function checkTools(cfg) {
  const result = { ffmpeg: false, ffprobe: false, ffmpegVersion: null, error: null };
  try {
    const { stdout } = await execFileAsync(cfg.ffmpegPath, ['-version']);
    result.ffmpeg = true;
    result.ffmpegVersion = stdout.split('\n')[0];
  } catch (err) { result.error = err.message; }
  try {
    await execFileAsync(cfg.ffprobePath, ['-version']);
    result.ffprobe = true;
  } catch { /* reported via result.ffprobe */ }
  return result;
}

/** Inspect a media file: duration, streams, and whether it is already WhatsApp-ready. */
export async function probe(filePath, cfg) {
  const { stdout } = await execFileAsync(cfg.ffprobePath, [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ], { maxBuffer: 10 * 1024 * 1024 });

  const data = JSON.parse(stdout);
  const video = data.streams.find((s) => s.codec_type === 'video');
  const audio = data.streams.find((s) => s.codec_type === 'audio');
  const size = Number(data.format?.size ?? fs.statSync(filePath).size);
  const duration = Number(data.format?.duration ?? 0);
  const num = (v) => (v == null || v === 'N/A' || !isFinite(Number(v)) ? null : Number(v));

  // The start times, frame rates and time base are what a segmented encode
  // (media/segmented.js) needs to cut a film at exact frames and keep its
  // sound in sync; nothing else reads them.
  return {
    size,
    duration,
    container: data.format?.format_name ?? '',
    startTime: num(data.format?.start_time),
    // Cover art is a video stream too, and is not the film.
    videoCount: data.streams.filter((s) => s.codec_type === 'video' && !s.disposition?.attached_pic).length,
    // Every stream beyond the one video and one sound a post keeps:
    // subtitles, data, cover art, other languages (planConversion).
    extraStreams: data.streams.filter((s) => s !== video && s !== audio).length,
    video: video ? {
      codec: video.codec_name,
      width: Number(video.width ?? 0),
      height: Number(video.height ?? 0),
      bitrate: Number(video.bit_rate ?? 0),
      startTime: num(video.start_time),
      rFrameRate: video.r_frame_rate ?? null,
      avgFrameRate: video.avg_frame_rate ?? null,
      timeBase: video.time_base ?? null,
    } : null,
    audio: audio ? {
      codec: audio.codec_name,
      channels: Number(audio.channels ?? 0),
      bitrate: Number(audio.bit_rate ?? 0),
      startTime: num(audio.start_time),
      duration: num(audio.duration),
    } : null,
  };
}

/**
 * Decide the cheapest route to a WhatsApp-sendable mp4.
 *
 *   copy    - already an mp4 with compatible codecs and small enough: just use it
 *   remux   - compatible codecs in the wrong container (mkv): stream-copy, seconds not minutes
 *   encode  - too big, or codecs WhatsApp/most phones will not play: full re-encode
 */
export function planConversion(info, cfg) {
  const fitsSize = info.size <= cfg.maxOutputBytes;
  const compatVideo = ['h264', 'avc1'].includes(info.video?.codec);
  const compatAudio = ['aac', 'mp3'].includes(info.audio?.codec);
  const isMp4 = /mp4|mov|m4a/.test(info.container ?? '');

  if (cfg.strategy === 'always-transcode') return { action: 'encode', reason: 'strategy=always-transcode' };
  if (cfg.strategy === 'copy-only') {
    if (!fitsSize) return { action: 'reject', reason: `file is ${fmtBytes(info.size)}, over the ${fmtBytes(cfg.maxOutputBytes)} limit, and strategy is copy-only` };
    return { action: isMp4 && !(Number(info.extraStreams ?? 0) > 0) ? 'copy' : 'remux', reason: 'strategy=copy-only' };
  }

  // An mp4 that carries more than one video and one sound is repackaged with
  // just those two, never sent as it is. "Daniel Sloss - Live Shows -
  // S01E01-02" was an H.264/AAC mp4 with over a dozen mov_text subtitle
  // tracks; posted untouched on 2026-10-12, WhatsApp answered every member
  // who opened it "This file was sent in an unusual format that may indicate
  // it is dangerous, corrupted, or otherwise not supported on WhatsApp" (A.
  // Ito's #issue #group04). The remux keeps the picture and sound as they
  // are, takes seconds, and puts the index at the front (+faststart).
  const extras = Number(info.extraStreams ?? 0);
  if (fitsSize && isMp4 && compatVideo && compatAudio && extras > 0) {
    return { action: 'remux', reason: `compatible mp4, but ${extras} more stream(s) than one video and one sound - repackaging without them` };
  }
  if (fitsSize && isMp4 && compatVideo && compatAudio) {
    return { action: 'copy', reason: 'already a compatible mp4 within the size limit' };
  }
  if (fitsSize && compatVideo && compatAudio) {
    return { action: 'remux', reason: 'compatible codecs, repackaging into mp4' };
  }
  if (!fitsSize) {
    return { action: 'encode', reason: `${fmtBytes(info.size)} exceeds the ${fmtBytes(cfg.maxOutputBytes)} limit` };
  }
  return { action: 'encode', reason: `codec ${info.video?.codec}/${info.audio?.codec} needs converting` };
}

/**
 * Compute a video bitrate that lands the output just under the target size.
 * WhatsApp hard-rejects oversized documents, so we aim at 93% and verify after.
 */
export function targetVideoBitrate(durationSec, cfg) {
  const safety = 0.93;
  const totalBits = cfg.maxOutputBytes * 8 * safety;
  const audioBits = cfg.audioBitrateK * 1000 * durationSec;
  const videoBits = totalBits - audioBits;
  const bps = Math.floor(videoBits / Math.max(1, durationSec));
  // Below ~400kbps the result is not worth sending; above 8Mbps is pointless here.
  return Math.max(400_000, Math.min(bps, 8_000_000));
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 2 : 0)} ${u[i]}`;
}
export { fmtBytes };

/**
 * Run ffmpeg, reporting progress. Resolves with the output path.
 * `onProgress(pct, detail)` is called as encoding advances.
 *
 * `frames`, when given, is how many frames the run will write, and progress
 * is counted in those: with -copyts (a segmented encode's pieces) the time
 * ffmpeg reports is the film's, not the run's. `cwd` is where it runs. `fd`
 * is a file this process holds open, given to ffmpeg as its fd 3, which the
 * arguments then read as /dev/fd/3 (segmented.js sourceGuard).
 */
export function runFfmpeg(args, { cfg, durationSec = 0, onProgress, signal, frames = 0, cwd = undefined, fd = null } = {}) {
  return new Promise((resolve, reject) => {
    logger.debug(`ffmpeg ${args.join(' ')}`);
    let proc;
    try {
      proc = spawn(cfg.ffmpegPath, ['-hide_banner', '-nostdin', '-y', ...args, '-progress', 'pipe:2', '-loglevel', 'error'], {
        stdio: ['ignore', 'pipe', 'pipe', ...(fd != null ? [fd] : [])], cwd,
      });
    } catch (err) {
      reject(new Error(`could not start ffmpeg: ${err.message}`));
      return;
    }

    let stderrTail = '';
    let lastPct = -1;

    const onAbort = () => {
      logger.warn('ffmpeg aborted');
      proc.kill('SIGKILL');
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      stderrTail = (stderrTail + s).slice(-4000);

      // -progress writes key=value lines; out_time_ms drives the percentage,
      // or frame= when the run was given its frame count.
      const m = frames > 0 ? [...s.matchAll(/(?:^|\n)frame=\s*(\d+)/g)].pop() : [...s.matchAll(/out_time_ms=(\d+)/g)].pop();
      if (m && (frames > 0 || durationSec > 0) && onProgress) {
        const pct = frames > 0
          ? Math.min(99, Math.floor((Number(m[1]) / frames) * 100))
          : Math.min(99, Math.floor((Number(m[1]) / 1_000_000 / durationSec) * 100));
        if (pct !== lastPct) {
          lastPct = pct;
          const speed = [...s.matchAll(/speed=\s*([\d.]+)x/g)].pop()?.[1];
          onProgress(pct, speed ? `${pct}% (${speed}x)` : `${pct}%`);
        }
      }
    });

    proc.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`could not start ffmpeg: ${err.message}`));
    });

    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));
      if (code === 0) return resolve();
      // ffmpeg exits with its own error as the status, and -ENOSPC is 228.
      // Its last lines need not say so: "Charlie and the Chocolate Factory"
      // (2026-09-28 20:34 UTC) ended "drop_frames=0 | speed=2.78x |
      // progress=end" and was failed for good. Coded, so the pipelines wait
      // for room and try again (media/disk-space.js isDiskFull).
      const full = code === 228 || /No space left on device/i.test(stderrTail);
      const tail = stderrTail.split('\n').filter(Boolean).slice(-3).join(' | ');
      reject(Object.assign(
        new Error(`ffmpeg exited ${code}${full ? ' (no space left on device)' : ''}: ${tail}`),
        full ? { code: 'ENOSPC' } : {},
      ));
    });
  });
}

/**
 * How long a conversion has run, and how long it has left, for the panel.
 *
 * Called with each progress report: `pct` is the share of the file made,
 * and a segmented encode adds `runPct`, the share made of what was left when
 * this run began (segmented.js). The time left is worked out from `runPct`
 * when there is one, over the time since it was first reported: from `pct`,
 * a film resumed with 8 of its 10 pieces made read "piece 9 of 10 · 13s
 * left" a minute in, with two pieces - some three minutes - still to make,
 * because the eight made before the restart counted as made in no time.
 */
export function conversionClock(now = Date.now) {
  const started = now();
  let runStarted = null;
  return (pct, extra = null) => {
    const t = now();
    const elapsed = Math.round((t - started) / 1000);
    const runPct = extra?.runPct;
    if (runPct != null) {
      runStarted ??= t;
      const ran = (t - runStarted) / 1000;
      return { elapsed, eta: runPct > 0 && ran > 0 ? Math.round((ran / runPct) * (100 - runPct)) : null };
    }
    return { elapsed, eta: pct > 0 ? Math.round((elapsed / pct) * (100 - pct)) : null };
  };
}

/**
 * Convert `input` into a WhatsApp-sendable mp4 at `outPath`.
 * Returns { action, outPath, size, info, plan }.
 *
 * `work` is the job's work (media/work-files.js), when there is one: an
 * encode is then done in pieces that a restart goes on from
 * (media/segmented.js) - unless media.segmentedEncode is off, or the source
 * cannot be cut exactly, when it is one pass as before. A segmented encode
 * whose pieces were all made before a restart is only joined: `input` is not
 * read then (an older build deleted it once the pieces were made).
 *
 * A one-pass remux or encode writes `<outPath>.part` and renames it once
 * ffmpeg has finished: an ffmpeg stopped by a signal leaves a playable but
 * short file, and only an exit of 0 says it is whole.
 */
export async function convertForWhatsApp(input, outPath, cfg, {
  onProgress, signal, work = null, ffmpegVersion: version = null,
  // Seams for tests: the ffmpeg runner, the ffprobe step and the NVENC probe.
  run = runFfmpeg, probeMedia = probe, probeNvenc = nvencWorks,
} = {}) {
  const segmented = !!work && cfg.segmentedEncode !== false;
  // Pieces all made before a restart are only joined - with the encoder
  // they were made with still the one this job uses (settingsHash), so a
  // film is never GPU pieces joined to CPU ones. Asked only when there are
  // pieces, so a copy or a remux never probes the GPU.
  if (segmented && work.manifest?.convert?.mode === 'segmented') {
    const enc = await jobEncoder(cfg, work, { probeNvenc });
    if (await segmentsReady(work, cfg, { version, encoder: enc })) {
      const joined = await joinReady(outPath, cfg, { work, onProgress, signal, version });
      return { ...joined, encoder: encoderName(enc, cfg), gpuFallback: null };
    }
  }

  const info = await probeMedia(input, cfg);
  const plan = planConversion(info, cfg);
  logger.info(`plan=${plan.action} (${plan.reason}) for ${path.basename(input)}`);

  if (plan.action === 'reject') {
    throw new Error(plan.reason);
  }

  if (plan.action === 'copy') {
    // Same filesystem: hardlink instead of duplicating gigabytes.
    try {
      fs.linkSync(input, outPath);
    } catch {
      fs.copyFileSync(input, outPath);
    }
    onProgress?.(100, 'ready');
    return { action: 'copy', outPath, size: fs.statSync(outPath).size, info, plan };
  }

  const part = `${outPath}.part`;
  if (plan.action === 'remux') {
    await run(
      ['-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', part],
      { cfg, durationSec: info.duration, onProgress, signal },
    );
    fs.renameSync(part, outPath);
    return { action: 'remux', outPath, size: fs.statSync(outPath).size, info, plan };
  }

  // Full re-encode targeted at the size ceiling: on the GPU when this box has
  // a working NVENC and the settings allow it, else with libx264 as before -
  // in pieces when the job has work to keep them in (segmented.js), or in
  // one pass.
  const { preset, maxHeight } = effectiveEncode(cfg);
  const vBitrate = targetVideoBitrate(info.duration, cfg);
  let encoder = await jobEncoder(cfg, work, { probeNvenc });
  let gpuFallback = null;

  if (segmented) {
    const segOpts = { work, info, onProgress, signal, version: version ?? await ffmpegVersion(cfg) };
    let seg = null;
    if (encoder === 'nvenc') {
      try {
        seg = await encodeSegmented(input, outPath, cfg, { ...segOpts, encoder: 'nvenc' });
        if (seg) noteNvencSuccess();
      } catch (err) {
        if (err?.code !== 'NVENC_FALLBACK') throw err;
        // A piece NVENC could not make, or made unlike the first piece, or
        // pieces that would not fit under the cap: this job's pieces are
        // made again on the CPU (its different settingsHash drops the GPU
        // ones). Noted on the job's work, so a restart goes on with the CPU
        // pieces rather than back to the GPU.
        gpuFallback = { reason: err.reason, error: err.message };
        logger.warn(`${work.label ?? path.basename(input)}: ${err.message}; making its pieces again with libx264`);
        if (err.reason !== 'oversize') noteNvencFailure(err.cause ?? err);
        work.record({ gpuFallback });
        onProgress?.(0, 'GPU encode failed, converting on the CPU');
        encoder = 'cpu';
      }
    }
    if (!seg && encoder === 'cpu') seg = await encodeSegmented(input, outPath, cfg, { ...segOpts, encoder: 'cpu' });
    if (seg) return { ...seg, info, plan, encoder: encoderName(encoder, cfg), gpuFallback };
    // Not to be cut into pieces (recorded, with the reason): one pass, on
    // the encoder this job is on.
  }

  logger.info(
    `encoding [${cfg.encodeProfile ?? 'custom'}] with ${encoderName(encoder, cfg)}: ` +
    `${Math.round(vBitrate / 1000)}kbps video, ` +
    `preset ${encoder === 'nvenc' ? nvencPreset(preset) : preset}, ` +
    `${info.video?.height ?? '?'}p -> ${Math.min(info.video?.height ?? maxHeight, maxHeight)}p, ` +
    `${Math.round(info.duration / 60)} min source`,
  );

  // A one-pass encode writes <outPath>.part and renames it once ffmpeg has
  // exited 0 (see above). ffmpeg runs with -y, so a second attempt
  // overwrites whatever the first left there; nothing is deleted here.
  const encodeOnce = async (enc) => {
    await run(buildEncodeArgs({ input, outPath: part, info, cfg, encoder: enc }),
      { cfg, durationSec: info.duration, onProgress, signal });
    fs.renameSync(part, outPath);
    return fs.statSync(outPath).size;
  };

  let size;
  if (encoder === 'nvenc') {
    try {
      size = await encodeOnce('nvenc');
      noteNvencSuccess();
      if (size > cfg.maxOutputBytes) {
        // NVENC's VBR holds the target less tightly than libx264's, so an
        // overshoot goes again on the CPU, whose output has always fit,
        // before anybody is told the film is too big. The GPU worked, so this
        // does not count towards turning it off.
        gpuFallback = { reason: 'oversize', error: `NVENC output ${fmtBytes(size)} is over the ${fmtBytes(cfg.maxOutputBytes)} cap` };
        logger.warn(`${gpuFallback.error} for ${path.basename(input)}; encoding again with libx264`);
        encoder = 'cpu';
      }
    } catch (err) {
      // Cancelling and a full disk are not the GPU's doing: the pipelines'
      // own handling (disk-space.js waits for room) must see them unchanged.
      if (err?.code === 'CANCELLED' || err?.code === 'ENOSPC' || signal?.aborted) throw err;
      // Anything else - no device, a Windows driver update pulling the GPU
      // out from under WSL2, a consumer card's limit on concurrent NVENC
      // sessions - must never fail a request: the same job goes again on the
      // CPU, and the failure is logged and counted (noteNvencFailure).
      gpuFallback = { reason: 'error', error: err?.message ?? String(err) };
      logger.warn(`NVENC encode failed for ${path.basename(input)}: ${gpuFallback.error}; encoding again with libx264`);
      noteNvencFailure(err);
      onProgress?.(0, 'GPU encode failed, converting on the CPU');
      encoder = 'cpu';
    }
    // A one-pass job that went to the CPU stays there after a restart.
    if (encoder === 'cpu' && work) work.record({ gpuFallback });
  }
  if (encoder === 'cpu') size = await encodeOnce('cpu');

  checkSize(size, cfg);
  return { action: 'encode', outPath, size, info, plan, encoder: encoderName(encoder, cfg), gpuFallback };
}

/**
 * Bitrate targeting overshot. Rather than silently sending something
 * WhatsApp will reject, fail loudly with the numbers.
 */
export function checkSize(size, cfg) {
  if (size > cfg.maxOutputBytes) {
    throw new Error(
      `encoded file is ${fmtBytes(size)}, still over the ${fmtBytes(cfg.maxOutputBytes)} limit. ` +
      `Try the Fast (480p) encode profile, or lower maxOutputBytes in Settings.`,
    );
  }
}

/* ----------------------------- the encoder ----------------------------- */

/**
 * x264 preset -> NVENC preset (p1 fastest .. p7 best quality). The encode
 * profiles were tuned for x264's speed/quality trade; on the GPU even p7
 * encodes 720p far faster than the CPU decodes a 1080p source, so each
 * profile buys a little more quality than its x264 twin instead of speed.
 */
const NVENC_PRESETS = {
  ultrafast: 'p2', superfast: 'p3', veryfast: 'p5', faster: 'p6', fast: 'p6', medium: 'p7', slow: 'p7',
};
export function nvencPreset(x264Preset) { return NVENC_PRESETS[x264Preset] ?? 'p5'; }

/** The ffmpeg encoder a choice of 'nvenc' or 'cpu' stands for. */
export function encoderName(encoder, cfg) {
  return encoder === 'nvenc' ? 'h264_nvenc' : (cfg.videoCodec || 'libx264');
}

/**
 * The full re-encode's arguments. Both encoders get the same size, the same
 * bitrate budget (targetVideoBitrate, maxrate 1.5x, bufsize 2x), the same
 * audio and stream mapping, yuv420p, High profile and faststart; only the
 * video encoder's own options differ.
 *
 * With NVENC, decoding and scaling stay on the CPU, deliberately. `-hwaccel
 * cuda` would move decoding to the GPU, but not every source codec and bit
 * depth has a CUVID path, and a hardware decode that fails partway is one
 * more way for a film to fail. The CPU decodes 1080p H.264 many times faster
 * than real time; it was libx264's encoding that made conversions slow.
 */
export function buildEncodeArgs({ input, outPath, info, cfg, encoder }) {
  const { maxHeight } = effectiveEncode(cfg);
  const scale = info.video?.height > maxHeight ? ['-vf', `scale=-2:${maxHeight}`] : [];
  return [
    '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?',
    ...scale,
    ...videoEncodeArgs(cfg, encoder, targetVideoBitrate(info.duration, cfg)),
    '-c:a', cfg.audioCodec,
    '-b:a', `${cfg.audioBitrateK}k`,
    '-ac', '2',
    '-movflags', '+faststart',
    // Named, because the one-pass output is <film>.mp4.part until it is whole.
    '-f', 'mp4',
    outPath,
  ];
}

/**
 * The video encoder's options for `encoder` ('nvenc' or 'cpu') at `vBitrate`,
 * from -c:v to -pix_fmt: the one place either encoder's settings live, so
 * any other encode path can use the same choice.
 */
export function videoEncodeArgs(cfg, encoder, vBitrate) {
  const { preset } = effectiveEncode(cfg);
  const rate = [
    '-b:v', String(vBitrate),
    '-maxrate', String(Math.floor(vBitrate * 1.5)),
    '-bufsize', String(vBitrate * 2),
  ];
  return encoder === 'nvenc'
    ? [
      '-c:v', 'h264_nvenc',
      '-preset', nvencPreset(preset),
      '-tune', 'hq',
      // NVENC defaults to Main; libx264 at yuv420p writes High. Asked for
      // outright, so both encoders hand WhatsApp the same kind of stream.
      '-profile:v', 'high',
      // CBR, not VBR: measured here (2026-09-29, ffmpeg 6.1.1, NVIDIA GPU)
      // NVENC's VBR came in at 97-102% of the cap where libx264 lands at 93%
      // - over it on a 10 s clip, so the film would be encoded twice - while
      // CBR landed at 93-94%, as libx264 does. The cap is the one thing
      // that must hold; lookahead and spatial AQ win back most of what CBR
      // gives up.
      '-rc', 'cbr',
      ...rate,
      '-spatial-aq', '1',
      '-rc-lookahead', '20',
      '-pix_fmt', 'yuv420p',
    ]
    : [
      '-c:v', cfg.videoCodec || 'libx264',
      '-preset', preset,
      ...rate,
      '-pix_fmt', 'yuv420p',
      '-threads', '0',
    ];
}

// After this many NVENC failures in a row the GPU is left alone until the bot
// restarts. Each failure costs whatever the encode had done before it died,
// and a GPU that has gone away (under WSL2 a Windows driver update can leave
// it gone until Windows reboots) would cost that on every film.
export const NVENC_MAX_FAILURES = 3;

const nvenc = { probes: new Map(), available: null, failures: 0, disabled: false, lastError: null, lastFailureAt: null, encodes: 0 };

/**
 * Does h264_nvenc actually work here? Encoding one second of a test pattern
 * is the only real answer: Ubuntu's ffmpeg lists h264_nvenc on every box, GPU
 * or not, and bot-box2's GPU partition failed only at cuInit
 * (docs/server-setup.md, "GPU partitioning"). Asked once per ffmpeg binary,
 * at the first encode rather than at start, and the answer kept until
 * restart.
 */
export function nvencWorks(cfg) {
  const bin = cfg.ffmpegPath || 'ffmpeg';
  if (!nvenc.probes.has(bin)) {
    nvenc.probes.set(bin, execFileAsync(bin, [
      '-hide_banner', '-nostdin', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '1',
      '-c:v', 'h264_nvenc', '-pix_fmt', 'yuv420p', '-f', 'null', '-',
    ], { timeout: 30_000 }).then(
      () => { nvenc.available = true; logger.info('NVENC probe: h264_nvenc works on this box; encoding on the GPU'); return true; },
      (err) => {
        const why = String(err?.stderr || err?.message || err).trim().split('\n').pop();
        nvenc.available = false;
        logger.info(`NVENC probe: h264_nvenc does not work here (${why}); encoding with libx264`);
        return false;
      },
    ));
  }
  return nvenc.probes.get(bin);
}

/**
 * 'nvenc' or 'cpu' for this encode. media.videoEncoder 'auto' (the default)
 * uses the GPU when the probe says it works; 'nvenc' uses it without asking;
 * 'cpu' never touches it, not even to probe.
 */
export async function pickEncoder(cfg, { probeNvenc = nvencWorks } = {}) {
  const mode = cfg.videoEncoder ?? 'auto';
  if (mode === 'cpu' || nvenc.disabled) return 'cpu';
  if (mode === 'nvenc') return 'nvenc';
  return (await probeNvenc(cfg)) ? 'nvenc' : 'cpu';
}

/**
 * pickEncoder for one job: the CPU for a job whose work says NVENC already
 * failed it (convertForWhatsApp records gpuFallback there), so a restart goes
 * on with the pieces made on the CPU instead of starting again on the GPU.
 */
export async function jobEncoder(cfg, work = null, { probeNvenc = nvencWorks } = {}) {
  if (work?.manifest?.gpuFallback) return 'cpu';
  return pickEncoder(cfg, { probeNvenc });
}

function noteNvencSuccess() {
  nvenc.failures = 0;
  nvenc.encodes += 1;
}

function noteNvencFailure(err) {
  nvenc.failures += 1;
  nvenc.lastError = err?.message ?? String(err);
  nvenc.lastFailureAt = new Date().toISOString();
  if (nvenc.failures >= NVENC_MAX_FAILURES && !nvenc.disabled) {
    nvenc.disabled = true;
    // Error level, so the alert email goes out: films still go, only slower,
    // until somebody looks at the GPU and restarts the bot.
    logger.error(
      `NVENC failed ${nvenc.failures} times in a row (last: ${nvenc.lastError}); ` +
      'encoding with libx264 until the bot restarts',
    );
  }
}

/** The GPU encoder's state, for the diagnostics panel. */
export function encoderStatus(cfg = {}) {
  return {
    mode: cfg.videoEncoder ?? 'auto',
    available: nvenc.available,  // the probe's answer; null until the first encode asks
    disabled: nvenc.disabled,
    failures: nvenc.failures,
    lastError: nvenc.lastError,
    lastFailureAt: nvenc.lastFailureAt,
    nvencEncodes: nvenc.encodes,
  };
}

/** Tests only: forget the probe answers and the failure count. */
export function _resetNvenc() {
  nvenc.probes.clear();
  Object.assign(nvenc, { available: null, failures: 0, disabled: false, lastError: null, lastFailureAt: null, encodes: 0 });
}
