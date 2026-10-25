/* A YouTube link on "Queue a public link": through yt-dlp, down the same
   convert-and-post road as a file link. Run: node test/public-link-yt-dlp.test.mjs

   2026-10-11: an admin pasted https://www.youtube.com/watch?v=... into the
   card, named it "the world of harry potter part 3", for member Dan
   Smith, and got "That link gives a web page (text/html), not a video.
   Paste the direct download link of the video file itself." The operator:
   "add ytdlp and whatever else needed to the bot system and I'll sign in
   with my gmail if needed for cookies".

   Here the same link is queued, downloaded by a fake yt-dlp
   (test/fixtures/fake-yt-dlp.mjs), converted by the restart kit's stub
   ffmpeg and posted to a fake WhatsApp; a restart after the download does
   not run yt-dlp again, and one in the middle of it goes on from its
   streams. History and the audit log show the video's v= and never the
   share link's si=. Direct file links still go exactly as before. The
   panel's routes - the inspect step, the queue, and the cookies upload in
   Settings - are driven over HTTP. Nothing here touches the internet. */
import './fixtures/roomy-disk.mjs';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import { RetryBook } from '../src/media/resume.js';
import { forgetThisProcess } from '../src/media/work-files.js';
import { isPublicAddress, linkForDisplay } from '../src/media/public-link.js';
import { createApiRouter } from '../src/web/api.js';
import log from '../src/util/logger.js';
import { makeKit } from './fixtures/restart-kit.mjs';
import { makeFakeYtDlp } from './fixtures/fake-yt-dlp.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const attempt = async (fn) => { try { return { r: await fn() }; } catch (err) { return { err }; } };

const kit = await makeKit('public-link-yt-dlp');
const { WORK, server } = kit;
const KIT_PORT = new URL(kit.base).port;
const fake = makeFakeYtDlp(kit.TMP);
const SOURCE = path.join(kit.TMP, 'youtube-film.bin');
fs.writeFileSync(SOURCE, server.body);
const DATA = path.join(kit.TMP, 'data');
fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });

// ffmpeg that fails once, with a dropped connection in what it says (a
// transient failure: media/resume.js), and otherwise is the kit's.
const FLAKY = path.join(kit.TMP, 'ffmpeg-flaky');
const FAIL_ONCE = path.join(kit.TMP, 'FAIL_ONCE');
fs.writeFileSync(FLAKY, `#!/bin/sh\nif [ -f '${FAIL_ONCE}' ]; then rm -f '${FAIL_ONCE}'; echo 'av_read_frame: ECONNRESET' >&2; exit 1; fi\nexec '${kit.FFMPEG}' "$@"\n`, { mode: 0o755 });

/* A web page on a site that is not on the yt-dlp-first list. */
const pages = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>x</title>'); });
pages.on('connection', (s) => s.unref());
await new Promise((r) => pages.listen(0, '127.0.0.1', r));
const PAGE_PORT = pages.address().port;

const lookup = (host, _o, cb) => {
  if (host === 'public.example') return cb(null, [{ address: '127.0.0.1', family: 4 }]);
  if (host === 'm.youtube.com') return cb(null, [{ address: '10.1.2.3', family: 4 }]); // a resolver gone wrong
  if (/(^|\.)youtube\.com$|^youtu\.be$/.test(host)) return cb(null, [{ address: '142.250.180.14', family: 4 }]);
  return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }));
};
const allow = (ip, host) => host === 'public.example' || isPublicAddress(ip);

const TRACKER = 'TRACKER9f8e7d';
const WATCH = `https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=${TRACKER}`;
const SHOWN = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const CLIP = `http://public.example:${KIT_PORT}/Items/clip/Download?token=tok123`;

const allLogs = [];
log.setSink({ write: (e) => allLogs.push(`${e.scope} ${e.msg} ${e.extra ? JSON.stringify(e.extra) : ''}`) });
const logs = [];
const plog = { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)), debug() {} };

const config = (media = {}) => mergeDefaults({
  movieRequests: {
    postsGroup: 'posts@g.us', notify: {}, blockedRatings: ['R'],
    reactions: { redo: '🔄', failed: '⚠️', cancelled: '❌', skipped: '⏭️', done: '✅', sending: '⬆️', downloading: '⬇️', converting: '⚙️' },
  },
  media: { workDir: WORK, ffprobePath: kit.FFPROBE, ffmpegPath: FLAKY, deleteAfterSend: true, segmentedEncode: false, ...media },
}, DEFAULT_CONFIG);

function fakeBot() {
  const bot = {
    sent: [], isConnected: () => true, react: async () => true, sendText: async () => ({}),
    groups: () => [], groupMemberInfo: () => ({ isMember: false }), on() {}, off() {},
    sendDocument: async (jid, file, opts) => { bot.sent.push({ jid, file, name: opts?.fileName, bytes: fs.readFileSync(file) }); return {}; },
  };
  return bot;
}
function makeCtx(media = {}) {
  forgetThisProcess();
  moviePlugin._parked = null;
  moviePlugin._retries = new RetryBook({ delayMs: () => 3_600_000, log: plog });
  const added = [];
  return {
    added, store: kit.loadStore(), bot: fakeBot(), log: plog, config: config(media),
    linkNet: { lookup, allow },
    ytdlp: { bin: fake.bin, deno: path.join(kit.TMP, 'no-deno'), dataDir: DATA, nodeVersion: '20.18.1' },
    queue: { pending: [], active: new Map(), on() {}, off() {}, add(j) { added.push(j); return `q${added.length}`; } },
  };
}
const job = (progress = []) => ({ id: `j${Math.random().toString(16).slice(2, 8)}`, signal: new AbortController().signal,
  progress: (p, pct) => progress.push({ ...p, pct }), isCancelled: () => false, cancelReason: () => null });
const clearJournal = () => { const s = kit.loadStore(); s.set('pending', []); s.set('history', []); };
const queueLink = (ctx, body) => attempt(() => moviePlugin.queuePublicLink(body, ctx, { requester: 'panel (mommy)' }));
const ytCalls = (kind) => fake.calls().filter((c) => (kind === 'inspect' ? c.argv.includes('-J') : !c.argv.includes('-J')));

console.log('=== linkForDisplay keeps a YouTube video\'s v=, and nothing else of its query ===');
{
  ok(linkForDisplay(WATCH) === SHOWN, `a watch link keeps v= and loses si= (${linkForDisplay(WATCH)})`);
  ok(linkForDisplay('https://m.youtube.com/watch?si=X&v=abcDEF12345&t=42s&pp=ygU') === 'https://m.youtube.com/watch?v=abcDEF12345', 'mobile, t= and pp= dropped too');
  ok(linkForDisplay('https://youtu.be/dQw4w9WgXcQ?si=X') === 'https://youtu.be/dQw4w9WgXcQ', 'a youtu.be link is its path, as before');
  ok(linkForDisplay('https://www.youtube.com/watch?v=<script>') === 'https://www.youtube.com/watch', 'a v= that is not a video id is not shown');
  ok(linkForDisplay('https://cdn.example.org/film.mp4?v=secret-token') === 'https://cdn.example.org/film.mp4', 'another site\'s v= is still never shown');
  ok(linkForDisplay('https://www.youtube.com/embed/x?v=abcDEF12345') === 'https://www.youtube.com/embed/x', 'nor anything but /watch\'s');
}

console.log('=== the incident: "the world of harry potter part 3" from YouTube, queued, downloaded, posted ===');
{
  clearJournal();
  fake.reset();
  fake.set({ inspect: 'ok', download: 'ok', source: SOURCE, videoBytes: 2_000_000, audioBytes: 1_145_728 });
  logs.length = 0;
  allLogs.length = 0;
  const ctx = makeCtx();
  const { r, err } = await queueLink(ctx, { url: WATCH, title: 'the world of harry potter part 3' });
  ok(!err && r.via === 'yt-dlp' && r.site === 'YouTube' && r.duration === 5520 && r.link === SHOWN && r.title === 'the world of harry potter part 3',
    `queued, from YouTube via yt-dlp (${err?.message ?? `${r.title}, ${r.link}`})`);
  ok(ctx.added.length === 1 && ctx.added[0].label === 'the world of harry potter part 3', 'one job, under the name given');
  const entry = (ctx.store.get('pending', []) ?? [])[0];
  ok(entry?.publicLink?.url === WATCH && entry.publicLink.via === 'yt-dlp' && entry.publicLink.videoKey === 'Youtube:abc',
    'the journal keeps the link as pasted, and which video it is');
  ok(logs.some((l) => /queued "the world of harry potter part 3" from YouTube via yt-dlp \(https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ, 1 h 32 min, about 3\.00 MB\)/.test(l)),
    `the log says what, from where, and how long (${logs.find((l) => /queued/.test(l))})`);

  const progress = [];
  const e = await attempt(() => ctx.added[0].run(job(progress)));
  ok(!e.err, `the job runs to the end (${e.err?.message ?? 'ok'})`);
  const post = ctx.bot.sent[0];
  ok(post?.jid === 'posts@g.us' && post.name === 'the world of harry potter part 3.mp4' && Buffer.compare(post.bytes, server.body) === 0,
    `posted to the movie posts group, the film yt-dlp fetched, byte for byte (${post?.name})`);
  const dl = ytCalls('download')[0];
  ok(dl && dl.url === WATCH && dl.argv[dl.argv.indexOf('-P') + 1].startsWith(path.join(WORK, 'job-')) && dl.argv[dl.argv.indexOf('-P') + 1].endsWith('/yt-dlp'),
    `yt-dlp worked in the job's own directory (${dl?.argv[dl.argv.indexOf('-P') + 1]})`);
  ok(progress.some((p) => p.stage === 'download' && /via yt-dlp/.test(p.text ?? '') && p.pct === 39),
    'its progress is the job\'s, the download filling the first 40% of the bar (39 until yt-dlp is done)');
  const row = (ctx.store.get('history', []) ?? [])[0];
  ok(row?.status === 'sent' && row.publicLink === SHOWN && row.publicLinkVia === 'YouTube via yt-dlp',
    `History: sent, with the video's link (${row?.status}, ${row?.publicLink})`);
  ok(!(ctx.store.get('pending', []) ?? []).length && !fs.readdirSync(WORK).some((n) => n.startsWith('job-')), 'the journal is clear, and its files are gone');
  const everywhere = JSON.stringify(ctx.store.get('history', [])) + logs.join('\n') + allLogs.join('\n')
    + ctx.added.map((j) => JSON.stringify({ label: j.label, meta: j.meta })).join('');
  ok(!everywhere.includes(TRACKER), 'the share link\'s si= is in no log line, History row or queue entry');
}

console.log('=== no title: the page\'s own ===');
{
  clearJournal();
  fake.set({ inspect: 'ok', download: 'ok', source: SOURCE, id: 'xyz', title: 'Some Free Documentary' });
  const ctx = makeCtx();
  const { r, err } = await queueLink(ctx, { url: 'https://youtu.be/xyz?si=X' });
  ok(!err && r.title === 'Some Free Documentary' && ctx.added[0]?.label === 'Some Free Documentary', `named from the page (${err?.message ?? r.title})`);
  const file = await queueLink(ctx, { url: CLIP });
  ok(file.err && /Give the film its title/.test(file.err.message), 'a file link still needs its title, before anything is fetched');
}

console.log('=== the same video under another link is not queued twice ===');
{
  clearJournal();
  fake.set({ inspect: 'ok', id: 'abc' });
  const ctx = makeCtx();
  await queueLink(ctx, { url: WATCH, title: 'First Name' });
  const again = await queueLink(ctx, { url: 'https://youtu.be/abc?si=another', title: 'Second Name' });
  ok(again.err?.code === 'DUPLICATE' && /That video is already in the queue, as First Name/.test(again.err.message), `another link to it: ${again.err?.message}`);
  const same = await queueLink(ctx, { url: WATCH, title: 'Third Name' });
  ok(same.err?.code === 'DUPLICATE' && /That link is already in the queue/.test(same.err.message), `the same link: ${same.err?.message}`);
  ok(ctx.added.length === 1, 'one job');
}

console.log('=== refused before anything is queued: a sign-in wall, a private address, the size cap ===');
{
  clearJournal();
  fake.reset();
  fake.set({ inspect: 'error:Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.' });
  const ctx = makeCtx();
  const wall = await queueLink(ctx, { url: WATCH, title: 'Walled' });
  ok(wall.err?.code === 'YTDLP_SIGN_IN' && /Cookies for yt-dlp/.test(wall.err.message) && /secondary Google account/.test(wall.err.message),
    `the sign-in wall, pointing at the cookies upload: ${wall.err?.message}`);

  fake.reset();
  const lan = await queueLink(ctx, { url: 'https://m.youtube.com/watch?v=abc', title: 'Hijacked' });
  ok(lan.err?.code === 'LINK_REFUSED' && /resolves to 10\.1\.2\.3/.test(lan.err.message) && fake.calls().length === 0,
    `a YouTube name that resolves to a private address: refused before yt-dlp runs (${lan.err?.message})`);

  fake.set({ inspect: 'ok', videoBytes: 2_000_000, audioBytes: 1_000_000 });
  const capped = makeCtx({ maxDownloadBytes: 1024 * 1024 });
  const big = await queueLink(capped, { url: WATCH, title: 'Big' });
  ok(big.err?.code === 'LINK_TOO_BIG' && /about 2\.86 MB, over the 1\.00 MB/.test(big.err.message), `over the cap by yt-dlp's reckoning: ${big.err?.message}`);
  ok(ctx.added.length === 0 && capped.added.length === 0 && !(kit.loadStore().get('pending', []) ?? []).length, 'nothing queued or journalled');
}

console.log('=== a wall met while downloading fails the job with the sentence, and is not retried ===');
{
  clearJournal();
  fake.set({ inspect: 'ok', download: 'error:Sign in to confirm your age. This video may be inappropriate for some users.', source: SOURCE });
  const ctx = makeCtx();
  await queueLink(ctx, { url: WATCH, title: 'Age Walled' });
  await attempt(() => ctx.added[0].run(job()));
  const row = (ctx.store.get('history', []) ?? []).find((h) => h.title === 'Age Walled');
  ok(row?.status === 'failed' && /age-restricted.*Cookies for yt-dlp/s.test(row.detail ?? ''), `History: failed, saying why and what to do (${row?.status}: ${row?.detail})`);
  ok(!(ctx.store.get('pending', []) ?? []).length && ctx.bot.sent.length === 0, 'out of the journal, nothing posted');
}

console.log('=== a restart after the download: converted from what it has, yt-dlp not run again ===');
{
  clearJournal();
  fake.reset();
  fake.set({ inspect: 'ok', download: 'ok', source: SOURCE });
  let ctx = makeCtx();
  await queueLink(ctx, { url: WATCH, title: 'Downloaded Once' });
  fs.writeFileSync(FAIL_ONCE, '');
  const first = await attempt(() => ctx.added[0].run(job()));
  ok(first.err && /ECONNRESET/.test(first.err.message) && (ctx.store.get('pending', []) ?? []).length === 1,
    `the encode failed transiently after the download, and the journal keeps the job (${first.err?.message.slice(0, 60)})`);
  const downloads = ytCalls('download').length;
  moviePlugin._retries.clear();

  ctx = makeCtx();
  await moviePlugin.recoverPending(ctx);
  ok(ctx.added.length === 1, 'recovery puts it back, from its link');
  const e = await attempt(() => ctx.added[0].run(job()));
  ok(!e.err && Buffer.compare(ctx.bot.sent[0]?.bytes ?? Buffer.alloc(0), server.body) === 0, `and it is posted whole (${e.err?.message ?? 'ok'})`);
  ok(ytCalls('download').length === downloads && downloads === 1, `yt-dlp downloaded it once, not again after the restart (${ytCalls('download').length})`);
  ok(logs.some((l) => /download finished before the restart - converting it without fetching it again/.test(l)), 'and the log says so');
}

console.log('=== a restart in the middle of the download: yt-dlp goes on from its streams ===');
{
  clearJournal();
  fake.reset();
  fake.set({ inspect: 'ok', download: 'part-then-error:Unable to download video data: Connection reset by peer', source: SOURCE });
  let ctx = makeCtx();
  await queueLink(ctx, { url: WATCH, title: 'Cut Off' });
  const first = await attempt(() => ctx.added[0].run(job()));
  ok(first.err?.code === 'YTDLP_NET' && (ctx.store.get('pending', []) ?? []).length === 1, `a dropped connection is transient (${first.err?.message.slice(0, 70)})`);
  moviePlugin._retries.clear();

  fake.set({ inspect: 'ok', download: 'ok', source: SOURCE });
  ctx = makeCtx();
  await moviePlugin.recoverPending(ctx);
  const e = await attempt(() => ctx.added[0].run(job()));
  const second = ytCalls('download').at(-1);
  ok(!e.err && second?.hadPart === true, `the next start's yt-dlp found the stream it had begun (tidy kept its folder) (${e.err?.message ?? 'ok'})`);
  ok(ctx.bot.sent.length === 1, 'and the film is posted');
}

console.log('=== a page on another site: asked as a file first, then yt-dlp ===');
{
  clearJournal();
  fake.reset();
  fake.set({ inspect: 'unsupported' });
  const ctx = makeCtx();
  const page = await queueLink(ctx, { url: `http://public.example:${PAGE_PORT}/watch/1`, title: 'Page' });
  ok(page.err?.code === 'NOT_VIDEO' && /web page \(text\/html\), not a video/.test(page.err.message) && /yt-dlp has no extractor for that site either/.test(page.err.message),
    `a page yt-dlp knows nothing on: the old answer, and why yt-dlp could not help (${page.err?.message})`);
  ok(ytCalls('inspect').length === 1, 'yt-dlp was asked once');

  fake.set({ inspect: 'ok', id: 'vid9', title: 'Hosted Elsewhere' });
  const known = await queueLink(ctx, { url: `http://public.example:${PAGE_PORT}/watch/2` });
  ok(known.err && /Give the film its title/.test(known.err.message), 'a link off the list needs its title up front, as a file link does');
  const named = await queueLink(ctx, { url: `http://public.example:${PAGE_PORT}/watch/2`, title: 'Hosted Elsewhere' });
  ok(!named.err && named.r.via === 'yt-dlp' && ctx.added.length === 1, `one yt-dlp knows: queued through it (${named.err?.message ?? 'ok'})`);

  const missing = makeCtx();
  missing.ytdlp = { ...missing.ytdlp, bin: path.join(kit.TMP, 'not-installed') };
  const none = await queueLink(missing, { url: `http://public.example:${PAGE_PORT}/watch/3`, title: 'Nope' });
  ok(none.err?.code === 'NOT_VIDEO' && /yt-dlp, which reads the video out of pages like YouTube's, is not installed on this box \(node tools\/routines\.mjs --fix\)/.test(none.err.message),
    `no yt-dlp on the box: says so, and how to fix it (${none.err?.message})`);
  const yt = await queueLink(missing, { url: WATCH, title: 'Nope' });
  ok(yt.err?.code === 'YTDLP_MISSING' && !/ENOENT/.test(yt.err.message), `a YouTube link with no yt-dlp: ${yt.err?.message}`);
}

console.log('=== direct file links go exactly as before: no yt-dlp ===');
{
  clearJournal();
  fake.reset();
  server.requests.length = 0;
  const ctx = makeCtx();
  const { r, err } = await queueLink(ctx, { url: CLIP, title: 'Plandemic', year: 2020 });
  ok(!err && !r.via && r.size === server.body.length && r.link === `http://public.example:${KIT_PORT}/Items/clip/Download`, `queued as a file (${err?.message ?? r.link})`);
  await ctx.added[0].run(job());
  ok(Buffer.compare(ctx.bot.sent[0]?.bytes ?? Buffer.alloc(0), server.body) === 0 && fake.calls().length === 0, 'downloaded and posted, and yt-dlp never ran');
}

console.log('=== the panel\'s routes: the inspect step, the queue, and the cookies ===');
{
  clearJournal();
  fake.reset();
  fake.set({ inspect: 'ok', download: 'ok', source: SOURCE, rewriteCookies: true });
  const ctx = makeCtx();
  const events = [];
  const stateStore = { namespace: (name) => ({ get: (k, d) => (name === 'audit' && k === 'events' ? events : d), set() {}, push: (k, v) => { if (name === 'audit') events.unshift(v); } }) };
  const configStore = {
    dataDir: DATA,
    get: () => ({ ...ctx.config, web: { adminPasswordHash: 'x', admins: [{ username: 'mommy', role: 'admin', passwordHash: 'x' }] } }),
    update: () => ({}), redacted: () => ({}), onChange: () => {},
  };
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => { req.session = { user: { username: 'mommy', role: 'admin' } }; next(); });
  app.use('/api', createApiRouter({
    configStore, bot: { groups: () => [], on() {} }, queue: { pending: [], on() {} },
    pluginManager: { plugins: new Map([['movie-requests', { plugin: moviePlugin, ctx }]]), notifyConfigChange: async () => {} },
    stateStore, fileLogger: { tail: () => [] }, alerts: {}, lockScheduler: {},
  }));
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const call = (method, p, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const rq = http.request({ host: '127.0.0.1', port: srv.address().port, method, path: `/api${p}`,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null, raw: buf }));
    });
    rq.on('error', reject);
    rq.end(data);
  });

  const look = await call('POST', '/queue/public-link/inspect', { url: WATCH });
  ok(look.status === 200 && look.body.kind === 'page' && look.body.site === 'YouTube' && look.body.title === 'The World of Harry Potter Part 3'
    && look.body.length === '1 h 32 min' && look.body.link === SHOWN, `inspect: a page, its title and length (${JSON.stringify(look.body)})`);
  ok(!events.length && ctx.added.length === 0, 'looking queues nothing and writes no audit row');
  const lookFile = await call('POST', '/queue/public-link/inspect', { url: CLIP });
  ok(lookFile.status === 200 && lookFile.body.kind === 'file' && lookFile.body.size === server.body.length && !/tok123/.test(lookFile.raw),
    'inspect: a file, its size, never its token');
  const lookBad = await call('POST', '/queue/public-link/inspect', { url: 'http://192.168.20.1/watch?v=1' });
  ok(lookBad.status === 400 && /private, local or reserved/.test(lookBad.body.error), `inspect: a private address is 400 (${lookBad.body?.error})`);

  const q = await call('POST', '/queue/public-link', { url: WATCH, title: 'the world of harry potter part 3' });
  ok(q.status === 200 && q.body.via === 'yt-dlp' && ctx.added.length === 1, `queue: a page link is queued (${q.status} ${q.body?.error ?? ''})`);
  const row = events.find((e) => /queued "the world of harry potter part 3" from YouTube via yt-dlp/.test(e.action));
  ok(row && row.detail.startsWith(SHOWN) && /1 h 32 min/.test(row.detail), `the audit log: who, what, the video and its length (${row?.action} | ${row?.detail})`);

  // The cookies.
  const SECRET = 'SAPISID-secret-value-77';
  const cookies = ['# Netscape HTTP Cookie File', '# exported by Get cookies.txt LOCALLY',
    `.youtube.com\tTRUE\t/\tTRUE\t1893456000\tSAPISID\t${SECRET}`,
    '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1861920000\tLOGIN_INFO\tAFmmF2sw',
    '.youtube.com\tTRUE\t/\tFALSE\t0\tYSC\tsession-only', '.google.com\tTRUE\t/\tTRUE\t1893456000\tNID\tn1d', ''].join('\n');
  const none = await call('GET', '/yt-dlp');
  ok(none.status === 200 && none.body.cookies.set === false, 'Settings: no cookies yet');
  const up = await call('PUT', '/yt-dlp/cookies', { text: cookies });
  const kept = path.join(DATA, 'yt-dlp-cookies.txt');
  ok(up.status === 200 && up.body.cookies.count === 4 && up.body.cookies.youtube && up.body.cookies.signedIn && up.body.cookies.by === 'mommy'
    && up.body.cookies.expires === 1861920000 * 1000, `uploaded: 4 cookies, youtube.com, signed in, expiring with the first login cookie (${JSON.stringify(up.body.cookies)})`);
  ok((fs.statSync(kept).mode & 0o777) === 0o600 && fs.readFileSync(kept, 'utf8').startsWith('# Netscape HTTP Cookie File\n# whatsapp-bot: '),
    'kept at data/yt-dlp-cookies.txt, mode 0600, the header first and who uploaded it next');
  const after = await call('GET', '/yt-dlp');
  ok(after.body.cookies.set && after.body.cookies.by === 'mommy' && after.body.cookies.uploadedAt > 0 && after.body.cookies.count === 4,
    'Settings: set, when, by whom, how many');
  ok(![up.raw, after.raw].some((t) => t.includes(SECRET) || t.includes('AFmmF2sw')), 'and no route ever sends a cookie back');

  fake.reset();
  await call('POST', '/queue/public-link/inspect', { url: 'https://youtu.be/abc' });
  const used = fake.calls()[0]?.cookie;
  ok(used && used.text.includes(SECRET) && used.mode === 0o600 && used.path !== kept && !fs.existsSync(used.path),
    'yt-dlp signs in with a 0600 copy, deleted after the run');
  ok(fs.readFileSync(kept, 'utf8').includes(SECRET), 'the kept file is untouched though yt-dlp rewrote its copy');

  const bad = await call('PUT', '/yt-dlp/cookies', { text: '[{"domain":".youtube.com","name":"SID","value":"x"}]' });
  ok(bad.status === 400 && /JSON export/.test(bad.body.error) && fs.readFileSync(kept, 'utf8').includes(SECRET), `a JSON export is refused, the kept file stays (${bad.body?.error})`);
  const torn = await call('PUT', '/yt-dlp/cookies', { text: '# Netscape HTTP Cookie File\n.youtube.com TRUE / TRUE 0 SID x\n' });
  ok(torn.status === 400 && /Line 2 is not a cookie/.test(torn.body.error), `spaces instead of tabs: the line is named (${torn.body?.error})`);

  const del = await call('DELETE', '/yt-dlp/cookies');
  ok(del.status === 200 && del.body.cookies.set === false && !fs.existsSync(kept), 'removed');
  srv.close();

  const actions = events.map((e) => e.action);
  ok(actions.includes('uploaded cookies for yt-dlp') && actions.includes('cookies for yt-dlp not saved') && actions.includes('removed the cookies for yt-dlp'),
    `every upload, refusal and removal is in the audit log (${actions.filter((a) => /cookies/.test(a)).join(' | ')})`);
  ok(events.find((e) => e.action === 'uploaded cookies for yt-dlp')?.detail === '4 cookie(s) · youtube.com present, signed in · expire 2029-01-01',
    `described, not copied (${events.find((e) => e.action === 'uploaded cookies for yt-dlp')?.detail})`);
  const said = JSON.stringify(events) + allLogs.join('\n') + logs.join('\n') + JSON.stringify(ctx.store.get('history', []));
  ok(!said.includes(SECRET) && !said.includes(TRACKER), 'no cookie and no si= anywhere in the audit log, the log or History');
}

kit.close();
pages.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
