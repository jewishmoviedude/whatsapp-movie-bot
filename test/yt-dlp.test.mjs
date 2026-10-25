/* yt-dlp, as the bot runs it: media/yt-dlp.js against a fake yt-dlp.
   Run: node test/yt-dlp.test.mjs

   2026-10-11: an admin pasted a YouTube link into "Queue a public link",
   named it "the world of harry potter part 3", for member Dan Smith, and
   was told "That link gives a web page (text/html), not a video. Paste the
   direct download link of the video file itself." The operator: "add ytdlp
   and whatever else needed to the bot system and I'll sign in with my gmail
   if needed for cookies".

   yt-dlp makes its own connections from a box on a home LAN and a tailnet,
   so what the guarded fetch promises for a file link is pinned here another
   way: it is spawned, never through a shell, with the link after "--"; only
   its site extractors run (never the generic one, which fetches any page);
   no config, plugin or --exec of anybody's; a link whose host is private is
   refused before it starts; the size cap holds; a cancel and the time limit
   kill it; and what it says when it fails comes out as a sentence an admin
   can act on, the sign-in and age walls pointing at the cookies upload.

   The fake (test/fixtures/fake-yt-dlp.mjs) records every argv it is given. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ytDlpArgs, inspectPage, downloadPage, explainYtDlp, jsRuntimeArgs, parseProgress, describeInfo, fmtLength,
  versionAtLeast, isVideoPageHost, asTheUpdate, ytDlpRunning, EXTRACTORS, FORMAT,
} from '../src/media/yt-dlp.js';
import { withCookieCopy, saveCookies } from '../src/media/yt-dlp-cookies.js';
import { isTransient } from '../src/media/resume.js';
import { makeFakeYtDlp } from './fixtures/fake-yt-dlp.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const attempt = async (fn) => { try { return { r: await fn() }; } catch (err) { return { err }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-dlp-test-'));
process.on('exit', () => fs.rmSync(T, { recursive: true, force: true }));
const fake = makeFakeYtDlp(T);
const SOURCE = path.join(T, 'film.bin');
fs.writeFileSync(SOURCE, Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251)));

// The tests' resolver: YouTube's names are public, the LAN's are not.
const lookup = (host, _o, cb) => {
  if (/(^|\.)youtube\.com$|^youtu\.be$/.test(host)) return cb(null, [{ address: '142.250.180.14', family: 4 }]);
  if (host === 'lan.example') return cb(null, [{ address: '192.168.20.1', family: 4 }]);
  if (host === 'rebound.youtube.example') return cb(null, [{ address: '142.250.180.14', family: 4 }, { address: '10.0.0.7', family: 4 }]);
  return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }));
};
const WATCH = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=TRACKER123';
const base = { bin: fake.bin, deno: path.join(T, 'no-deno'), lookup, nodeVersion: '20.18.1' };

console.log('=== the arguments: no shell, no config, no generic extractor, the link after "--" ===');
{
  const a = ytDlpArgs(WATCH, { mode: 'download', outDir: '/w/job/yt-dlp', maxBytes: 5e9, jsRuntime: ['--no-js-runtimes', '--js-runtimes', 'deno:/d'], cookieFile: '/c.txt' });
  ok(a.at(-2) === '--' && a.at(-1) === WATCH && a.indexOf('--') === a.length - 2, 'the link is the one argument after --');
  ok(a.includes('--ignore-config') && a.includes('--no-plugin-dirs') && a.includes('--no-exec') && !a.includes('--exec'),
    'no config file, no plugin and no --exec of anybody\'s');
  ok(a[a.indexOf('--use-extractors') + 1] === 'default,-generic' && EXTRACTORS === 'default,-generic', 'site extractors only: never the generic one');
  ok(a.includes('--no-playlist') && a[a.indexOf('-f') + 1] === FORMAT && /height<=1080/.test(FORMAT) && /^bv\*\[height<=1080\]\[vcodec\^=avc1\]\+ba\[acodec\^=mp4a\]/.test(FORMAT),
    'one video, H.264 and AAC up to 1080p first (the converter sends that as it is)');
  ok(a[a.indexOf('--max-filesize') + 1] === '5000000000' && a[a.indexOf('-P') + 1] === '/w/job/yt-dlp' && a.includes('--continue'),
    'the size cap, the job\'s own folder, and --continue');
  ok(a[a.indexOf('--merge-output-format') + 1] === 'mp4/mkv' && a[a.indexOf('--cookies') + 1] === '/c.txt', 'merged as mp4 or mkv; the cookies copy given');
  ok(a.indexOf('--no-quiet') > a.indexOf('--print'), '--no-quiet after --print, so a stream skipped for its size is said');
  const j = ytDlpArgs(WATCH, { mode: 'inspect' });
  ok(j.includes('-J') && j.includes('--skip-download') && j.includes('--flat-playlist') && !j.includes('-P'), 'inspect: -J, nothing downloaded');
}

console.log('=== the JavaScript runtime: deno by path, node only from 22 ===');
{
  // Tried on the bot box, 2026-10-11, yt-dlp 2026.08.19: "node-20.18.1 (unsupported)".
  const deno = path.join(T, 'deno');
  fs.writeFileSync(deno, '');
  ok(jsRuntimeArgs({ deno, nodeVersion: '20.18.1' }).join(' ') === `--no-js-runtimes --js-runtimes deno:${deno}`, 'deno, named by its path');
  ok(jsRuntimeArgs({ deno: path.join(T, 'none'), nodeVersion: '20.18.1' }).length === 0, 'no deno and node 20: none (yt-dlp warns, and goes on)');
  ok(jsRuntimeArgs({ deno: null, nodeVersion: '22.4.0', nodePath: '/usr/bin/node' }).join(' ') === '--no-js-runtimes --js-runtimes node:/usr/bin/node',
    'node 22: the bot\'s own node');
  ok(versionAtLeast('2.9.7', '2.3.0') && !versionAtLeast('2.1.4', '2.3.0') && versionAtLeast('2.3.0', '2.3.0') && !versionAtLeast('', '2.3.0'), 'versions compared');
}

console.log('=== which links go straight to yt-dlp ===');
{
  for (const l of ['https://www.youtube.com/watch?v=x', 'https://youtu.be/x', 'https://m.youtube.com/watch?v=x', 'https://vimeo.com/1']) {
    ok(isVideoPageHost(new URL(l)), `${l}: yt-dlp`);
  }
  for (const l of ['https://archive.org/download/x/x.mp4', 'https://youtube.com.evil.example/x', 'https://notyoutube.com/x']) {
    ok(!isVideoPageHost(new URL(l)), `${l}: asked as a file first`);
  }
}

console.log('=== inspecting a page: title, length, size; playlists and live streams refused ===');
{
  fake.reset();
  fake.set({ inspect: 'ok', videoBytes: 2_000_000, audioBytes: 1_000_000 });
  const { r, err } = await attempt(() => inspectPage(WATCH, base));
  ok(!err && r.site === 'YouTube' && r.title === 'The World of Harry Potter Part 3' && r.duration === 5520 && r.expectedBytes === 3_000_000 && r.id === 'abc',
    `title, length and the streams' size (${err?.message ?? `${r.title}, ${r.duration} s, ${r.expectedBytes}`})`);
  ok(fmtLength(5520) === '1 h 32 min' && fmtLength(720) === '12 min' && fmtLength(45) === '45 s' && fmtLength(3600) === '1 h', 'lengths read as the panel shows them');
  const call = fake.calls()[0];
  ok(call.url === WATCH && call.argv.includes('--ignore-config') && call.argv[call.argv.indexOf('--use-extractors') + 1] === 'default,-generic',
    'yt-dlp got the link as it was pasted, with the extractors restricted');

  fake.set({ inspect: 'playlist' });
  const pl = await attempt(() => inspectPage('https://www.youtube.com/playlist?list=PL1', base));
  ok(pl.err?.code === 'YTDLP_PLAYLIST' && /playlist \("Top films"\), not one video/.test(pl.err.message), `a playlist: ${pl.err?.message}`);
  fake.set({ inspect: 'live' });
  const live = await attempt(() => inspectPage(WATCH, base));
  ok(live.err?.code === 'YTDLP_LIVE' && /live stream/.test(live.err.message), `a live stream: ${live.err?.message}`);
  fake.set({ inspect: 'unsupported' });
  const un = await attempt(() => inspectPage(WATCH, base));
  ok(un.err?.code === 'YTDLP_UNSUPPORTED', `no extractor: ${un.err?.message}`);
  ok(describeInfo({ id: 'x', title: 'X', extractor_key: 'Youtube', requested_formats: [{ filesize: 5 }, { filesize_approx: null }] }, new URL(WATCH)).expectedBytes === null,
    'a stream of unknown size makes the whole size unknown, not a guess');
}

console.log('=== what it says when it fails: a sentence to act on ===');
{
  const cases = [
    ['Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.', 'YTDLP_SIGN_IN', /sign in.*cookies\.txt.*secondary Google account.*Cookies for yt-dlp/s],
    ['Sign in to confirm your age. This video may be inappropriate for some users.', 'YTDLP_AGE', /age-restricted.*cookies\.txt.*Cookies for yt-dlp/s],
    ['Private video. Sign in if you\'ve been granted access to this video', 'YTDLP_PRIVATE', /private/],
    ['Join this channel to get access to members-only content like this video, and other exclusive perks.', 'YTDLP_MEMBERS', /members only/],
    ['The uploader has not made this video available in your country', 'YTDLP_GEO', /not available in the country/],
    ['This live event will begin in 3 hours.', 'YTDLP_LIVE', /live stream/],
    ['This video is unavailable', 'YTDLP_UNAVAILABLE', /unavailable: it was removed/],
    ['Unable to download webpage: <urlopen error [Errno -3] Temporary failure in name resolution>', 'YTDLP_NET', /ECONNRESET/],
    ['HTTP Error 429: Too Many Requests', 'YTDLP_NET', /HTTP 429/],
    ['Requested format is not available', 'YTDLP_FAILED', /yt-dlp could not get the video: Requested format is not available/],
  ];
  for (const [said, code, re] of cases) {
    const e = explainYtDlp([`ERROR: [youtube] dQw4w9WgXcQ: ${said}`], { site: 'YouTube', host: 'www.youtube.com' });
    ok(e.code === code && re.test(e.message), `${code}: ${e.message.slice(0, 110)}`);
  }
  const quoted = explainYtDlp(['ERROR: [vimeo] 1: Failed to fetch https://player.vimeo.com/video/1/config?token=SECRET77&expires=9 (giving up)'], { site: 'Vimeo' });
  ok(quoted.code === 'YTDLP_FAILED' && !quoted.message.includes('SECRET77') && quoted.message.includes('https://player.vimeo.com/video/1/config'),
    `a link yt-dlp quotes keeps its host and path, never its query (${quoted.message})`);
  const warned = explainYtDlp(['WARNING: [youtube] x: this live stream format list may be incomplete', 'ERROR: [youtube] x: Private video. Sign in if you\'ve been granted access'], { site: 'YouTube' });
  ok(warned.code === 'YTDLP_PRIVATE', `a WARNING beside the ERROR does not decide it (${warned.code})`);
  // The network failures are tried again (media/resume.js); the walls are not.
  const net = explainYtDlp(['ERROR: Unable to download video data: Connection reset by peer'], { site: 'YouTube' });
  const wall = explainYtDlp(['ERROR: [youtube] x: Sign in to confirm you\'re not a bot'], { site: 'YouTube' });
  ok(isTransient(net) && !isTransient(wall) && !isTransient(explainYtDlp(['ERROR: This video is unavailable'])),
    'a dropped connection is retried; a sign-in wall or a removed video is not');

  fake.set({ inspect: 'error:Sign in to confirm you’re not a bot. Use --cookies-from-browser' });
  const live = await attempt(() => inspectPage(WATCH, base));
  ok(live.err?.code === 'YTDLP_SIGN_IN', `from the process itself, as it says it: ${live.err?.message.slice(0, 80)}`);
}

console.log('=== a private address is refused before yt-dlp runs ===');
{
  fake.reset();
  fake.set({ inspect: 'ok', download: 'ok', source: SOURCE });
  for (const [label, url] of [
    ['127.0.0.1', 'http://127.0.0.1:8080/watch?v=abc'],
    ['the router', 'http://192.168.20.1/watch?v=abc'],
    ['the tailnet', 'http://100.100.100.100/watch?v=abc'],
    ['::1', 'http://[::1]/watch?v=abc'],
    ['a name on the LAN', 'https://lan.example/watch?v=abc'],
    ['a name with one private address among its public ones', 'https://rebound.youtube.example/watch?v=abc'],
  ]) {
    const i = await attempt(() => inspectPage(url, base));
    const d = await attempt(() => downloadPage(url, { ...base, dir: path.join(T, 'priv') }));
    ok(i.err?.code === 'LINK_REFUSED' && d.err?.code === 'LINK_REFUSED' && /private, local or reserved/.test(i.err.message), `${label}: ${i.err?.message}`);
  }
  ok(fake.calls().length === 0, 'and yt-dlp was never started for any of them');
  const nf = await attempt(() => inspectPage('https://nowhere.example/watch?v=1', base));
  ok(nf.err?.code === 'LINK_REFUSED' && /Could not look up nowhere\.example \(ENOTFOUND\)/.test(nf.err.message) && fake.calls().length === 0,
    `a name that does not resolve: ${nf.err?.message}`);
}

console.log('=== a link is an argument, never a command: no shell ===');
{
  fake.reset();
  fake.set({ inspect: 'ok' });
  const nasty = 'https://www.youtube.com/watch?v=abc&x=;touch${IFS}PWNED;$(touch${IFS}PWNED2)`touch PWNED3`';
  const { err } = await attempt(() => inspectPage(nasty, { ...base }));
  const call = fake.calls()[0];
  ok(!err && call?.url === new URL(nasty).href && call.argv.at(-1) === new URL(nasty).href, `yt-dlp got it as one argument, as it was (${err?.message ?? 'ok'})`);
  ok(!['PWNED', 'PWNED2', 'PWNED3'].some((f) => fs.existsSync(path.join(call?.cwd ?? T, f)) || fs.existsSync(path.join(T, f))),
    'and nothing in it was run');
}

console.log('=== downloading: progress over both streams, the merged file, in the job\'s folder ===');
{
  fake.reset();
  fake.set({ download: 'ok', source: SOURCE });
  const reports = [];
  const dir = path.join(T, 'job', 'yt-dlp');
  const { r, err } = await attempt(() => downloadPage(WATCH, {
    ...base, dir, maxBytes: 10_000_000, expectedBytes: 300_000, onProgress: (pct, info) => reports.push({ pct, ...info }),
  }));
  ok(!err && r.path === path.join(dir, 'source.mp4') && r.size === 300_000, `the merged file, in its folder (${err?.message ?? r.path})`);
  ok(Buffer.compare(fs.readFileSync(r.path), fs.readFileSync(SOURCE)) === 0, 'byte for byte what was "downloaded"');
  const last = reports.at(-1);
  ok(reports.length >= 2 && last.pct === 99 && last.receivedBytes === 300_000 && last.totalBytes === 300_000
    && /of .* from YouTube via yt-dlp/.test(last.text) && last.stage === 'download',
  `progress as the HTTP download reports it, summed over the video and audio streams (${reports.map((x) => x.pct).join(', ')}; "${last?.text}")`);
  ok(reports.every((x, i) => i === 0 || x.receivedBytes >= reports[i - 1].receivedBytes), 'and it only goes forward');
  ok(parseProgress('[bot-progress] 137 downloading 1024 NA 4096 NA NA')?.total === 4096
    && parseProgress('[bot-progress] 140 downloading 10 20 NA NA NA')?.speed === null && parseProgress('[download] 5%') === null,
  'a stream of unknown size is counted at its estimate; "NA" is unknown');

  fake.set({ download: 'elsewhere', source: SOURCE });
  const away = await attempt(() => downloadPage(WATCH, { ...base, dir }));
  ok(away.err?.code === 'YTDLP_FAILED' && /somewhere else/.test(away.err.message), `a file outside its folder is not taken: ${away.err?.message}`);
}

console.log('=== the size cap ===');
{
  fake.set({ download: 'toobig', source: SOURCE });
  const big = await attempt(() => downloadPage(WATCH, { ...base, dir: path.join(T, 'big'), maxBytes: 1000 }));
  ok(big.err?.code === 'LINK_TOO_BIG' && /media\.maxDownloadBytes/.test(big.err.message), `a stream over --max-filesize, skipped: ${big.err?.message}`);
  ok(fake.calls().at(-1).argv[fake.calls().at(-1).argv.indexOf('--max-filesize') + 1] === '1000', 'the cap was given to yt-dlp');

  // A stream whose size the site does not give grows past it: stopped.
  fake.set({ download: 'grow', source: SOURCE });
  const started = Date.now();
  const grow = await attempt(() => downloadPage(WATCH, { ...base, dir: path.join(T, 'grow'), maxBytes: 3 * 1048576 }));
  ok(grow.err?.code === 'LINK_TOO_BIG' && /passed 3\.00 MB while downloading/.test(grow.err.message) && Date.now() - started < 8000,
    `counted as it comes, and stopped: ${grow.err?.message}`);
  await sleep(100);
  const pids = fake.calls().slice(-1).map((c) => c.pid);
  ok(pids.every((p) => { try { process.kill(p, 0); return false; } catch { return true; } }), 'and yt-dlp is no longer running');
}

console.log('=== a cancel kills it; so does the time limit ===');
{
  fake.set({ download: 'hang', source: SOURCE });
  const ac = new AbortController();
  const p = attempt(() => downloadPage(WATCH, { ...base, dir: path.join(T, 'cancel'), signal: ac.signal }));
  for (let i = 0; i < 200 && !fake.pid(); i++) await sleep(20);
  ok(ytDlpRunning() === 1, 'one yt-dlp counted as running while it runs');
  ac.abort();
  const { err } = await p;
  const pid = fake.pid();
  await sleep(100);
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  ok(err?.code === 'CANCELLED' && !alive, `cancelled, and its process is gone (${err?.code}, pid ${pid})`);
  ok(ytDlpRunning() === 0, 'and no longer counted');

  fake.set({ inspect: 'hang' });
  const slow = await attempt(() => inspectPage(WATCH, { ...base, timeoutMs: 400 }));
  ok(slow.err?.code === 'YTDLP_NET' && /took more than 1 s to read the page at www\.youtube\.com \(ETIMEDOUT\)/.test(slow.err.message), `the time limit: ${slow.err?.message}`);
}

console.log('=== an update waits for a running yt-dlp, and a yt-dlp for a running update ===');
{
  fake.set({ download: 'hang', source: SOURCE });
  const ac = new AbortController();
  const run = attempt(() => downloadPage(WATCH, { ...base, dir: path.join(T, 'gate'), signal: ac.signal }));
  for (let i = 0; i < 200 && !fake.pid(); i++) await sleep(20);
  const refused = await asTheUpdate(async () => 'updated');
  ok(refused === null, 'no update while a yt-dlp download runs');
  ac.abort();
  await run;
  let order = [];
  fake.set({ inspect: 'ok' });
  const update = asTheUpdate(async () => { order.push('update start'); await sleep(150); order.push('update end'); return 'updated'; });
  const look = inspectPage(WATCH, base).then(() => order.push('yt-dlp ran'));
  ok(await update === 'updated', 'with none running, the update runs');
  await look;
  ok(order.join(' > ') === 'update start > update end > yt-dlp ran', `and a yt-dlp asked for meanwhile waits for it (${order.join(' > ')})`);
}

console.log('=== the cookies: a copy for each run, deleted after; the kept one never rewritten ===');
{
  const data = path.join(T, 'data');
  saveCookies(data, '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1893456000\tSAPISID\tsecret-value-1\n', { by: 'mommy' });
  const kept = fs.readFileSync(path.join(data, 'yt-dlp-cookies.txt'), 'utf8');
  fake.reset();
  fake.set({ inspect: 'ok', rewriteCookies: true });
  let used = null;
  await withCookieCopy(data, async (copy) => { used = copy; return inspectPage(WATCH, { ...base, cookieFile: copy }); });
  const c = fake.calls()[0].cookie;
  ok(c && c.path === used && c.mode === 0o600 && /secret-value-1/.test(c.text) && c.path !== path.join(data, 'yt-dlp-cookies.txt'),
    'yt-dlp got a 0600 copy, not the kept file');
  ok(!fs.existsSync(used) && fs.readFileSync(path.join(data, 'yt-dlp-cookies.txt'), 'utf8') === kept,
    'the copy is gone after the run, and the kept file is as it was, though yt-dlp rewrote its copy');
  let none = 'unset';
  await withCookieCopy(path.join(T, 'no-data'), async (copy) => { none = copy; });
  ok(none === null, 'no cookies kept: none given');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
