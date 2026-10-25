/* A stand-in for yt-dlp, for the tests of media/yt-dlp.js and the public
   link path that uses it. Nothing here touches the network.

   makeFakeYtDlp(dir) writes an executable script (node, by its #! line, so
   it is started exactly as the zipapp is: spawned, never through a shell)
   and a control folder. Each run appends what it was given - its argv, and
   what it found on the disk - to calls.jsonl; mode.json says how to answer:

     inspect:  'ok' | 'playlist' | 'live' | 'unsupported' | 'hang' | 'error:<text>'
     download: 'ok' | 'toobig' | 'grow' | 'hang' | 'elsewhere' | 'error:<text>'
               | 'part-then-error:<text>' (leaves a partial stream, then fails)
     source:   the file whose bytes a download "fetches"
     ext:      the merged file's extension (mp4)
     title, duration, id, videoBytes, audioBytes: what -J says
     rewriteCookies: write into the cookie file it is given, as yt-dlp does */
import fs from 'node:fs';
import path from 'node:path';

const SCRIPT = String.raw`
const fs = require('fs');
const path = require('path');
const ctl = process.env.FAKE_YTDLP_CTL;
const mode = JSON.parse(fs.readFileSync(path.join(ctl, 'mode.json'), 'utf8'));
const argv = process.argv.slice(2);
const dash = argv.indexOf('--');
const url = dash >= 0 ? argv[dash + 1] : null;
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 && (dash < 0 || i < dash) ? argv[i + 1] : null; };
const dir = opt('-P');
const cookies = opt('--cookies');
const part = dir ? path.join(dir, 'source.f137.mp4.part') : null;
let cookie = null;
if (cookies) {
  const st = fs.statSync(cookies);
  cookie = { path: cookies, mode: st.mode & 0o777, text: fs.readFileSync(cookies, 'utf8') };
  if (mode.rewriteCookies) fs.writeFileSync(cookies, '# rewritten by yt-dlp\n');
}
fs.appendFileSync(path.join(ctl, 'calls.jsonl'), JSON.stringify({
  argv, url, pid: process.pid, cwd: process.cwd(), hadPart: part ? fs.existsSync(part) : null, cookie,
}) + '\n');
const fail = (text) => { process.stderr.write('ERROR: [youtube] ' + (mode.id || 'abc') + ': ' + text + '\n'); process.exit(1); };
const hang = () => { fs.writeFileSync(path.join(ctl, 'pid'), String(process.pid)); setInterval(() => {}, 1000); };

if (argv.includes('-J')) {
  const m = mode.inspect || 'ok';
  if (m === 'hang') return hang();
  if (m === 'unsupported') { process.stderr.write('ERROR: No suitable extractor found for URL ' + url + '\n'); process.exit(1); }
  if (m.startsWith('error:')) fail(m.slice(6));
  const info = m === 'playlist'
    ? { _type: 'playlist', id: 'PL1', title: 'Top films', extractor_key: 'YoutubeTab', entries: [{ id: 'a' }, { id: 'b' }] }
    : {
      id: mode.id || 'abc', title: mode.title || 'The World of Harry Potter Part 3', duration: mode.duration || 5520,
      extractor_key: 'Youtube', is_live: m === 'live', live_status: m === 'live' ? 'is_live' : 'not_live',
      requested_formats: [
        { format_id: '137', filesize: mode.videoBytes || 2000000, height: 1080, vcodec: 'avc1.640028', acodec: 'none' },
        { format_id: '140', filesize: mode.audioBytes || 1000000, vcodec: 'none', acodec: 'mp4a.40.2' },
      ],
    };
  process.stdout.write(JSON.stringify(info));
  process.exit(0);
}

const m = mode.download || 'ok';
if (m === 'hang') { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(part, 'x'.repeat(1000)); return hang(); }
if (m.startsWith('error:')) fail(m.slice(6));
if (m.startsWith('part-then-error:')) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(part, 'x'.repeat(1000));
  fail(m.slice('part-then-error:'.length));
}
if (m === 'toobig') {
  console.log('[download] File is larger than max-filesize (5000000 bytes > 1000 bytes). Aborting.');
  process.exit(0);
}
const P = (fid, st, dl, total) => console.log('[bot-progress] ' + fid + ' ' + st + ' ' + dl + ' ' + total + ' NA 1048576 3');
if (m === 'grow') {
  let n = 0;
  setInterval(() => { n += 1048576; P('137', 'downloading', n, 'NA'); }, 15);
  return;
}
const body = fs.readFileSync(mode.source);
const half = Math.floor(body.length / 2);
P('137', 'downloading', Math.floor(half / 2), half);
P('137', 'finished', half, half);
P('140', 'downloading', Math.floor((body.length - half) / 2), body.length - half);
P('140', 'finished', body.length - half, body.length - half);
fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, 'source.' + (mode.ext || 'mp4'));
fs.writeFileSync(out, body);
if (part) fs.rmSync(part, { force: true });
console.log('[bot-file] ' + (m === 'elsewhere' ? '/etc/hostname' : out));
process.exit(0);
`;

export function makeFakeYtDlp(dir) {
  const ctl = path.join(dir, 'fake-yt-dlp-ctl');
  fs.mkdirSync(ctl, { recursive: true });
  const bin = path.join(dir, 'yt-dlp');
  fs.writeFileSync(bin, `#!${process.execPath}\n${SCRIPT}`, { mode: 0o755 });
  // Inherited by every yt-dlp the code under test spawns.
  process.env.FAKE_YTDLP_CTL = ctl;
  const fake = {
    bin, ctl,
    set(mode) { fs.writeFileSync(path.join(ctl, 'mode.json'), JSON.stringify(mode)); fs.rmSync(path.join(ctl, 'pid'), { force: true }); },
    calls() {
      const f = path.join(ctl, 'calls.jsonl');
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    reset() { fs.rmSync(path.join(ctl, 'calls.jsonl'), { force: true }); },
    pid() { const f = path.join(ctl, 'pid'); return fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : null; },
  };
  fake.set({});
  return fake;
}
