/**
 * A film from a web page, through yt-dlp: a YouTube link pasted into "Queue a
 * public link".
 *
 * On 2026-10-11 an admin pasted a YouTube link (https://www.youtube.com/
 * watch?v=...) into the card, named it "the world of harry potter part 3",
 * for member Dan Smith, and was told "That link gives a web page
 * (text/html), not a video. Paste the direct download link of the video file
 * itself." There is no such link for a YouTube video. The operator: "add
 * ytdlp and whatever else needed to the bot system and I'll sign in with my
 * gmail if needed for cookies".
 *
 * yt-dlp knows how to get the video out of the pages of a long list of
 * sites. It is installed on every bot box by the `yt-dlp` routine (the
 * official zipapp in ~/.local/bin, and deno, its JavaScript runtime for
 * YouTube, in ~/.deno/bin: tools/install-yt-dlp.mjs), and updated daily by
 * the bot (media/yt-dlp-install.js, the `yt-dlp-update` routine), never while
 * it runs here. It makes its own connections, which the guarded fetch in
 * public-link.js cannot see, so everything that fetch promises is kept here
 * another way:
 *
 *   - it is only ever handed a link whose host resolves to public addresses
 *     (assertPublicHost, the file links' rule), checked before it starts;
 *   - only its site extractors run (--use-extractors default,-generic): the
 *     generic one fetches whatever page it is given and follows what is
 *     embedded there, which would make it the way round that rule;
 *   - --ignore-config and --no-plugin-dirs, so nothing on the box changes
 *     what it does, and --no-exec: it never runs a command;
 *   - spawn, never a shell, with the link after `--`, so no link can be read
 *     as an option;
 *   - the size cap (media.maxDownloadBytes): --max-filesize for each stream,
 *     and the bytes its progress reports counted against the cap as the HTTP
 *     download counts its own;
 *   - a time limit, and a cancel kills it, with the ffmpeg it merges with.
 *
 * Its work goes in the job's own directory, in a scratch folder the manifest
 * names (media/work-files.js), so a restart goes on from the streams it had
 * (yt-dlp's --continue), and a finished download is moved out of it and
 * recorded like any other: a restart then converts it without asking yt-dlp
 * for anything.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import log from '../util/logger.js';
import { assertPublicHost, checkLinkUrl, linkError, linkForDisplay } from './public-link.js';
import { fmtBytes } from './ffmpeg.js';
import { fmtDuration } from './download.js';

const logger = log.scope('yt-dlp');

/** Site extractors only: never the generic one, which fetches any page. */
export const EXTRACTORS = 'default,-generic';
/**
 * H.264 and AAC first, up to 1080p: that pair, merged into an mp4, is what
 * the converter sends as it is, or repackages, when it fits under the 2 GB
 * cap (ffmpeg.js planConversion) - no encode at all. Otherwise the best of
 * any codec up to 1080p, which the converter encodes anyway; 4K is never
 * fetched to be shrunk to 720p.
 */
export const FORMAT = 'bv*[height<=1080][vcodec^=avc1]+ba[acodec^=mp4a]/bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b';
/** mp4 when the streams allow it, mkv when they do not (VP9 or AV1 with Opus). */
export const MERGE_FORMATS = 'mp4/mkv';
/** The folder in a job's directory that yt-dlp works in (media/work-files.js `source.scratch`). */
export const SCRATCH = 'yt-dlp';
export const PROGRESS_TAG = '[bot-progress]';
export const FILE_TAG = '[bot-file]';
export const INSPECT_TIMEOUT_MS = 90_000;
export const DOWNLOAD_TIMEOUT_MS = 6 * 3600_000;
/** yt-dlp's own minimums for its JavaScript runtimes (its wiki, "EJS"). */
export const MIN_DENO = '2.3.0';
export const MIN_NODE_MAJOR = 22;
/** The cookies a browser exports, kept under data/ (media/yt-dlp-cookies.js). */
export const COOKIE_HINT = 'Settings -> Library & files -> File handling -> "Cookies for yt-dlp"';

/**
 * Hosts whose links go straight to yt-dlp. Any other link is asked for as a
 * file first, as it always was, and goes to yt-dlp only when it answers with
 * a web page; these never give a file, and asking YouTube's page for its
 * first byte as if it were one is a wasted request that can itself be
 * refused (HTTP 429), which would then be the answer the admin got.
 */
const PAGE_HOSTS = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|vimeo\.com|dailymotion\.com|dai\.ly)$/i;
export const isVideoPageHost = (u) => PAGE_HOSTS.test(String(u?.hostname ?? ''));

/** Where a box keeps yt-dlp, deno and the record of the last update check. */
export function ytDlpPaths({ home = os.homedir(), env = process.env } = {}) {
  const state = env.XDG_STATE_HOME || path.join(home, '.local', 'state');
  return {
    bin: path.join(home, '.local', 'bin', 'yt-dlp'),
    deno: path.join(home, '.deno', 'bin', 'deno'),
    stamp: path.join(state, 'whatsapp-bot', 'yt-dlp.json'),
  };
}

/** "2.9.7" >= "2.3.0". */
export function versionAtLeast(have, want) {
  const a = String(have ?? '').split('.').map((n) => parseInt(n, 10));
  const b = String(want).split('.').map((n) => parseInt(n, 10));
  if (!Number.isFinite(a[0])) return false;
  for (let i = 0; i < b.length; i++) {
    const x = a[i] || 0;
    if (x !== b[i]) return x > b[i];
  }
  return true;
}

/**
 * Which JavaScript runtime yt-dlp is to use for YouTube's player code, as
 * arguments. Tried on the bot box on 2026-10-11 with yt-dlp 2026.08.19: node
 * 20.18 is refused ("node-20.18.1 (unsupported)" - yt-dlp wants node 22), and
 * without a runtime it warns that YouTube extraction without one is
 * deprecated and some formats may be missing; deno 2.9.7 works. So deno,
 * named by its path - the service's PATH does not have ~/.deno/bin - and
 * node only where the bot's own node is new enough.
 */
export function jsRuntimeArgs({ deno = null, nodePath = process.execPath, nodeVersion = process.versions.node, exists = fs.existsSync } = {}) {
  if (deno && exists(deno)) return ['--no-js-runtimes', '--js-runtimes', `deno:${deno}`];
  if (Number(String(nodeVersion).split('.')[0]) >= MIN_NODE_MAJOR) return ['--no-js-runtimes', '--js-runtimes', `node:${nodePath}`];
  return [];
}

const PROGRESS_TEMPLATE = `download:${PROGRESS_TAG} %(info.format_id)s %(progress.status)s %(progress.downloaded_bytes)s `
  + '%(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s';

/**
 * yt-dlp's arguments. Everything before `--` is ours; the link is the only
 * argument after it. `mode` is 'inspect' (-J, nothing downloaded) or
 * 'download' (into `outDir`).
 */
export function ytDlpArgs(url, { mode = 'inspect', outDir = null, maxBytes = null, jsRuntime = [], cookieFile = null } = {}) {
  const args = [
    '--ignore-config', '--no-plugin-dirs', '--no-exec',
    '--use-extractors', EXTRACTORS,
    // A watch link from a playlist carries &list=: the one video, never the
    // hundred around it.
    '--no-playlist',
    '--socket-timeout', '30',
    '-f', FORMAT,
  ];
  if (mode === 'inspect') {
    // A playlist link is answered without resolving every entry in it: it
    // is refused, and that must not take a request per video to find out.
    args.push('-J', '--skip-download', '--flat-playlist');
  } else {
    if (!outDir) throw new Error('a yt-dlp download needs a directory');
    args.push(
      '--merge-output-format', MERGE_FORMATS,
      '--match-filters', '!is_live',
      '-P', outDir, '-o', 'source.%(ext)s',
      '--continue', '--no-mtime',
      '--newline', '--progress', '--progress-template', PROGRESS_TEMPLATE,
      // --print would make it quiet, and quiet says nothing of a stream it
      // skipped for --max-filesize: tried on 2026-10-11, it exited 0 with no
      // file and no word why. --no-quiet after it brings that line back.
      '--print', `after_move:${FILE_TAG} %(filepath)s`, '--no-quiet',
    );
    if (maxBytes > 0) args.push('--max-filesize', String(Math.floor(maxBytes)));
  }
  args.push(...jsRuntime);
  if (cookieFile) args.push('--cookies', cookieFile);
  args.push('--', url);
  return args;
}

/* ------------------------------------------------- running it, one at a time with the update */

/*
 * The zipapp's own updater (yt-dlp -U) writes the new release over the file
 * in place, and a running yt-dlp reads its modules out of that file as it
 * goes; the bot's update swaps a whole new file in instead (yt-dlp-install.js),
 * but a process that is running reads the new file's bytes at the old one's
 * offsets all the same. So an update waits until no yt-dlp is running here,
 * and a yt-dlp waits for an update that has begun.
 */
const gate = { running: 0, updating: null };

/** How many yt-dlp processes this bot is running now. */
export const ytDlpRunning = () => gate.running;

/**
 * Run `fn` as the update, unless a yt-dlp is running: then null, and the
 * update waits for its next turn.
 */
export async function asTheUpdate(fn) {
  if (gate.running || gate.updating) return null;
  let done;
  gate.updating = new Promise((r) => { done = r; });
  try {
    return await fn();
  } finally {
    gate.updating = null;
    done();
  }
}

async function withYtDlp(fn) {
  while (gate.updating) await gate.updating;
  gate.running += 1;
  try {
    return await fn();
  } finally {
    gate.running -= 1;
  }
}

const cancelledError = () => Object.assign(new Error('cancelled'), { code: 'CANCELLED' });

/**
 * Spawn yt-dlp - never through a shell - and hand each line it writes to
 * `onLine(line, stream)`. Resolves { code, stdout (only when `keepStdout`),
 * tail } once it exits; rejects only when it cannot be started.
 *
 * Its own process group, so that a cancel or the time limit takes the ffmpeg
 * it merges with, and deno, along with it.
 */
function spawnYtDlp(bin, args, { timeoutMs, signal = null, onLine = null, keepStdout = false, kill = null } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelledError());
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, PYTHONUNBUFFERED: '1' } });
    } catch (err) {
      return reject(err);
    }
    let stdout = '';
    const tail = [];
    let why = null;
    const stop = (reason) => {
      if (why) return;
      why = reason;
      const hit = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
      hit('SIGTERM');
      setTimeout(() => hit('SIGKILL'), 5000).unref();
    };
    if (kill) kill.stop = stop;
    const timer = setTimeout(() => stop('time'), timeoutMs);
    const onAbort = () => stop('cancel');
    signal?.addEventListener('abort', onAbort, { once: true });
    const take = (line, stream) => {
      if (!line) return;
      // Our own progress lines are read, not kept: a stream skipped for
      // being too big says so once, and the next stream's hundred progress
      // lines would push that line out of the tail.
      if (!line.startsWith(PROGRESS_TAG)) {
        tail.push(line);
        if (tail.length > 60) tail.shift();
      }
      try { onLine?.(line, stream); } catch (err) { stop(err); }
    };
    const rest = { stdout: '', stderr: '' };
    const lines = (stream) => (chunk) => {
      const text = chunk.toString('utf8');
      if (stream === 'stdout' && keepStdout) { stdout += text; return; }
      rest[stream] += text;
      let i;
      while ((i = rest[stream].search(/[\r\n]/)) >= 0) {
        take(rest[stream].slice(0, i).trim(), stream);
        rest[stream] = rest[stream].slice(i + 1);
      }
    };
    child.stdout.on('data', lines('stdout'));
    child.stderr.on('data', lines('stderr'));
    child.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // A last line written without a newline is still a line.
      for (const stream of ['stdout', 'stderr']) take(rest[stream].trim(), stream);
      resolve({ code, stdout, tail, why });
    });
  });
}

/** Not there, or not runnable: said as what to do about it, never as ENOENT (which would be retried). */
function notInstalled(bin, err) {
  return linkError(`yt-dlp is not installed on this box (${bin}${err?.code === 'EACCES' ? ' is not executable' : ''}), `
    + 'so a link to a video page cannot be fetched: node tools/routines.mjs --fix installs it.', 'YTDLP_MISSING');
}

/* --------------------------------------------------------- what went wrong */

// yt-dlp's own words go into History and the log, and they can quote the
// link whole ("... for URL https://...?token=..."): any link in them is shown
// as every link is (linkForDisplay), never with its query.
const lastError = (lines) => {
  const errs = lines.filter((l) => /^ERROR:/.test(l));
  return (errs.at(-1) ?? lines.at(-1) ?? '').replace(/^ERROR:\s*/, '').replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, '')
    .replace(/https?:\/\/[^\s<>"')]+/g, (m) => linkForDisplay(m)).slice(0, 300);
};

/**
 * What yt-dlp said, as a sentence an admin can act on, with a code. The two
 * that cookies can cure - YouTube asking this server to sign in, and an
 * age-restricted video - say where to upload them. A network failure keeps
 * a word media/resume.js counts as transient (ECONNRESET, ETIMEDOUT, HTTP
 * 5xx/429), so the job is tried again and goes on from its streams; nothing
 * else here is retried.
 */
export function explainYtDlp(lines, { site = 'The site', host = '' } = {}) {
  // Its ERROR lines when it gave any: a WARNING beside them (about formats,
  // or a runtime) is not why it stopped. Without one - a stream skipped for
  // its size, or turned away by the live filter, exits 0 - all of it.
  const errors = lines.filter((l) => /^ERROR:/.test(l));
  const text = (errors.length ? errors : lines).join('\n');
  const err = (code, message) => linkError(message, code);
  if (/Sign in to confirm you(?:'|’)?re not a bot|confirm you are not a bot/i.test(text)) {
    return err('YTDLP_SIGN_IN', `${site} asked this server to sign in before it would hand over the video `
      + `("Sign in to confirm you're not a bot"). Upload a cookies.txt from a browser signed in to YouTube - `
      + `with a secondary Google account - in ${COOKIE_HINT}, then queue it again.`);
  }
  if (/Sign in to confirm your age|age[- ]restricted|inappropriate for some users|age verification/i.test(text)) {
    return err('YTDLP_AGE', `The video is age-restricted: ${site} shows it only to a signed-in adult account. `
      + `Upload a cookies.txt from a browser signed in to such an account - a secondary Google account - in ${COOKIE_HINT}, then queue it again.`);
  }
  if (/Private video|This video is private|video is private/i.test(text)) {
    return err('YTDLP_PRIVATE', 'The video is private: only its owner, and the people they shared it with, can watch it. '
      + 'Ask for a public or unlisted link.');
  }
  if (/members[- ]only|Join this channel to get access|available to this channel's members|channel members/i.test(text)) {
    return err('YTDLP_MEMBERS', 'The video is for the channel\'s paying members only, so it cannot be downloaded.');
  }
  if (/not (?:made this video )?available in your country|geo[- ]?restrict|blocked it in your country|not available in your (?:country|region)/i.test(text)) {
    return err('YTDLP_GEO', `The video is not available in the country this server is in, so ${site} will not hand it over.`);
  }
  if (/live event will begin|Premieres? in|is a live ?stream|is_live|currently live|live stream/i.test(text)) {
    return err('YTDLP_LIVE', 'That is a live stream, or one that has not started yet: only a finished video can be queued. '
      + 'Queue it once the stream has ended and been saved.');
  }
  if (/File is larger than max-filesize/i.test(text)) {
    return err('LINK_TOO_BIG', `The video at ${host || site} is over the size a link may be (media.maxDownloadBytes).`);
  }
  if (/No suitable extractor|Unsupported URL/i.test(text)) {
    return err('YTDLP_UNSUPPORTED', 'yt-dlp has no extractor for that site, so it cannot get a video out of the page.');
  }
  if (/Video unavailable|video is unavailable|has been removed|account associated with this video has been terminated|This video does not exist|HTTP Error 404|HTTP Error 410/i.test(text)) {
    return err('YTDLP_UNAVAILABLE', `${site} says the video is unavailable: it was removed, or the link is wrong.`);
  }
  if (/HTTP Error 429|Too Many Requests/i.test(text)) {
    return err('YTDLP_NET', `${site} is refusing this server for asking too often (download failed: HTTP 429). `
      + `It is tried again later; if it keeps happening, a cookies.txt in ${COOKIE_HINT} usually helps.`);
  }
  if (/HTTP Error 50[234]/i.test(text)) {
    return err('YTDLP_NET', `${site} answered with a server error (download failed: HTTP 503): ${lastError(lines)}`);
  }
  if (/timed? ?out|Connection reset|Connection aborted|urlopen error|Temporary failure in name resolution|Unable to download|IncompleteRead|Remote end closed/i.test(text)) {
    return err('YTDLP_NET', `could not reach ${host || site} (ECONNRESET): ${lastError(lines)}`);
  }
  return err('YTDLP_FAILED', `yt-dlp could not get the video: ${lastError(lines) || 'it stopped without saying why'}`);
}

/** "Youtube" -> "YouTube"; otherwise yt-dlp's own name for the site. */
export function siteName(extractorKey, host = '') {
  const k = String(extractorKey ?? '');
  if (/^youtube/i.test(k) || /youtu/.test(host)) return 'YouTube';
  if (/^vimeo/i.test(k)) return 'Vimeo';
  if (/^dailymotion/i.test(k)) return 'Dailymotion';
  return k || host || 'the site';
}

/* ------------------------------------------------------------ inspecting */

/**
 * Ask yt-dlp about a page without downloading it: what the video is called,
 * how long it is, and roughly how big the streams it would fetch are. A
 * playlist, a live stream and anything yt-dlp has no site extractor for are
 * refused here, before anything is queued.
 *
 * `lookup`/`allow` are public-link.js's test seams for the address check.
 */
export async function inspectPage(url, {
  bin = ytDlpPaths().bin, deno = ytDlpPaths().deno, cookieFile = null, timeoutMs = INSPECT_TIMEOUT_MS,
  signal = null, lookup, allow, nodeVersion,
} = {}) {
  const u = checkLinkUrl(url);
  await assertPublicHost(u, { lookup, allow });
  const args = ytDlpArgs(u.href, { mode: 'inspect', jsRuntime: jsRuntimeArgs({ deno, nodeVersion }), cookieFile });
  let r;
  try {
    r = await withYtDlp(() => spawnYtDlp(bin, args, { timeoutMs, signal, keepStdout: true }));
  } catch (err) {
    if (err.code === 'CANCELLED') throw err;
    throw notInstalled(bin, err);
  }
  const site = siteName('', u.hostname);
  if (r.why === 'cancel') throw cancelledError();
  if (r.why === 'time') throw linkError(`yt-dlp took more than ${Math.ceil(timeoutMs / 1000)} s to read the page at ${u.host} (ETIMEDOUT).`, 'YTDLP_NET');
  if (r.code === 127) throw notInstalled(bin);
  let info = null;
  try { info = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { /* not JSON: an error */ }
  if (r.code !== 0 || !info) throw explainYtDlp(r.tail, { site, host: u.host });
  return describeInfo(info, u);
}

/** What -J said, reduced to what the panel and the job need. */
export function describeInfo(info, u) {
  const site = siteName(info.extractor_key ?? info.ie_key ?? '', u?.hostname ?? '');
  if (info._type === 'playlist' || info._type === 'multi_video' || Array.isArray(info.entries)) {
    throw linkError(`That is a ${site} playlist${info.title ? ` ("${String(info.title).slice(0, 80)}")` : ''}, not one video: `
      + 'open the film itself and paste its link.', 'YTDLP_PLAYLIST');
  }
  if (info.is_live || info.live_status === 'is_live' || info.live_status === 'is_upcoming') {
    throw explainYtDlp(['is_live'], { site });
  }
  const formats = Array.isArray(info.requested_formats) && info.requested_formats.length ? info.requested_formats : [info];
  const sizes = formats.map((f) => Number(f.filesize ?? f.filesize_approx ?? 0));
  const expectedBytes = sizes.every((s) => s > 0) ? sizes.reduce((a, b) => a + b, 0) : null;
  const height = Math.max(0, ...formats.map((f) => Number(f.height ?? 0)));
  return {
    site,
    extractor: String(info.extractor_key ?? info.extractor ?? ''),
    id: info.id != null ? String(info.id) : null,
    title: String(info.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || null,
    duration: Number(info.duration) > 0 ? Math.round(Number(info.duration)) : null,
    expectedBytes,
    height: height || null,
    uploader: info.uploader ? String(info.uploader).slice(0, 120) : null,
  };
}

/** "1 h 32 min", "12 min", "45 s" - for the panel's line about a page. */
export function fmtLength(sec) {
  if (!(sec > 0)) return null;
  if (sec < 60) return `${Math.round(sec)} s`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

/* ------------------------------------------------------------ downloading */

/** One progress line of ours, or null. 'NA' is yt-dlp's "not known". */
export function parseProgress(line) {
  if (!line.startsWith(PROGRESS_TAG)) return null;
  const [formatId, status, ...nums] = line.slice(PROGRESS_TAG.length).trim().split(/\s+/);
  const n = (s) => (s == null || s === 'NA' || s === 'None' || !Number.isFinite(Number(s)) ? null : Number(s));
  const [downloaded, total, estimate, speed, eta] = nums.map(n);
  return { formatId, status, downloaded, total: total ?? estimate, speed, eta };
}

/**
 * Download the video on a page into `dir` (the job's scratch folder), and
 * return { path, size }: the merged file, still in `dir`, for the caller to
 * move and record.
 *
 * Progress is reported as downloadToFile reports it - onProgress(pct, {
 * stage, receivedBytes, totalBytes, bytesPerSec, etaSec, text }) - over all
 * the streams together (a video stream and an audio stream are two
 * downloads to yt-dlp), against `expectedBytes` from the inspection while
 * yt-dlp has not yet said how big the later ones are.
 */
export async function downloadPage(url, {
  dir, bin = ytDlpPaths().bin, deno = ytDlpPaths().deno, cookieFile = null, maxBytes = null, expectedBytes = null,
  onProgress = null, signal = null, timeoutMs = DOWNLOAD_TIMEOUT_MS, lookup, allow, nodeVersion,
} = {}) {
  const u = checkLinkUrl(url);
  await assertPublicHost(u, { lookup, allow });
  fs.mkdirSync(dir, { recursive: true });
  const site = siteName('', u.hostname);
  const args = ytDlpArgs(u.href, { mode: 'download', outDir: dir, maxBytes, jsRuntime: jsRuntimeArgs({ deno, nodeVersion }), cookieFile });

  const parts = new Map();
  let file = null;
  let tooBig = null;
  let lastReport = 0;
  const startedAt = Date.now();
  const kill = {};
  const onLine = (line) => {
    if (line.startsWith(FILE_TAG)) { file = line.slice(FILE_TAG.length).trim(); return; }
    const p = parseProgress(line);
    if (!p) return;
    parts.set(p.formatId, { done: p.downloaded ?? 0, total: p.total, speed: p.speed, eta: p.eta });
    const received = [...parts.values()].reduce((a, b) => a + (b.done || 0), 0);
    const known = [...parts.values()].reduce((a, b) => a + (b.total || 0), 0);
    const total = Math.max(expectedBytes || 0, known) || null;
    // The cap, counted as the HTTP download counts it: --max-filesize only
    // knows a stream's size when the site says it in advance.
    if (maxBytes > 0 && received > maxBytes && !tooBig) {
      tooBig = linkError(`The video from ${u.host} passed ${fmtBytes(maxBytes)} while downloading, `
        + 'the most a link may be (media.maxDownloadBytes) - stopped.', 'LINK_TOO_BIG');
      kill.stop?.('cap');
      return;
    }
    const now = Date.now();
    if (!onProgress || (now - lastReport < 700 && p.status !== 'finished')) return;
    lastReport = now;
    const cur = parts.get(p.formatId);
    const bytesPerSec = cur.speed ?? null;
    const etaSec = total && bytesPerSec > 0 ? Math.round((total - received) / bytesPerSec) : null;
    // Never 100 before yt-dlp is done: with no estimate from the page, the
    // total is the streams seen so far, and the video alone read as all of
    // it on the live check (2026-10-11) until the audio stream began.
    const pct = total ? Math.min(99, Math.floor((received / total) * 100)) : null;
    onProgress(pct, {
      stage: 'download', receivedBytes: received, totalBytes: total, bytesPerSec, etaSec,
      elapsedSec: Math.round((now - startedAt) / 1000),
      text: `${total ? `${fmtBytes(received)} of ${fmtBytes(total)}` : fmtBytes(received)} from ${site} via yt-dlp`
        + `${bytesPerSec ? ` · ${fmtBytes(bytesPerSec)}/s` : ''}${etaSec != null ? ` · ${fmtDuration(etaSec)} left` : ''}`,
    });
  };

  let r;
  try {
    r = await withYtDlp(() => spawnYtDlp(bin, args, { timeoutMs, signal, onLine, kill }));
  } catch (err) {
    if (err.code === 'CANCELLED') throw err;
    throw notInstalled(bin, err);
  }
  if (tooBig) throw tooBig;
  if (r.why === 'cancel' || signal?.aborted) throw cancelledError();
  if (r.why instanceof Error) throw r.why;
  if (r.why === 'time') {
    throw linkError(`yt-dlp was still downloading from ${site} after ${fmtDuration(Math.round(timeoutMs / 1000))} and was stopped.`, 'YTDLP_SLOW');
  }
  if (r.code === 127) throw notInstalled(bin);
  if (r.code !== 0) throw explainYtDlp(r.tail, { site, host: u.host });
  // Exit 0 and no file is a stream it skipped: over --max-filesize, or a
  // live stream the match filter turned away.
  if (!file || !fs.existsSync(file)) {
    const e = explainYtDlp(r.tail, { site, host: u.host });
    if (e.code !== 'YTDLP_FAILED') throw e;
    throw linkError(`yt-dlp finished without a file from ${site}: ${lastError(r.tail) || 'it did not say why'}`, 'YTDLP_FAILED');
  }
  // Only ever its own output: a path outside the folder it was given is not
  // something this job made.
  const real = path.resolve(file);
  if (path.dirname(real) !== path.resolve(dir)) {
    throw linkError(`yt-dlp put the video somewhere else (${path.basename(real)}) - not taken.`, 'YTDLP_FAILED');
  }
  const size = fs.statSync(real).size;
  logger.info(`downloaded ${fmtBytes(size)} from ${site} -> ${path.basename(real)}`);
  return { path: real, size };
}
