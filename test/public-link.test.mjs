/* Queue a public link: a film downloaded from any public URL, no Jellyfin.
   Run: node test/public-link.test.mjs

   The operator, 2026-09-30: "For a movie like plandemic being that it's free
   there's a public download link for it, so there should be a box on the
   panel where an admin can manually enter any public mp4 download link and
   it'll queue and process, why should it need to be jellyfin if it's public
   anyway".

   The bot then fetches a URL a person typed, from a box on a home LAN
   (192.168.20.x), on the tailnet (100.64/10) and next to Jellyfin: every way
   of pointing it at one of those - an address, a name that resolves to one,
   a public name that redirects to one, file:// or ftp:// - is refused here,
   before a byte is asked for. A link's query can be a token, and it is kept
   only in the journal: never in the log, History, the audit log or a reply.

   The clip is served from 127.0.0.1 (test/fixtures/restart-kit.mjs, and a
   second server for the odd answers) under the made-up public name
   public.example, through the plugin's test seam (ctx.linkNet); ffmpeg and
   ffprobe are the kit's stubs and WhatsApp a fake bot. Nothing here touches
   the internet. */
import './fixtures/roomy-disk.mjs';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import crypto from 'node:crypto';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import { RetryBook } from '../src/media/resume.js';
import { forgetThisProcess } from '../src/media/work-files.js';
import {
  isPublicAddress, checkLinkUrl, linkForDisplay, makeLinkFetch, typeKind, sniffContainer,
} from '../src/media/public-link.js';
import { rerunRefusal } from '../src/core/hourly-policy.js';
import { createApiRouter } from '../src/web/api.js';
import log from '../src/util/logger.js';
import { makeKit } from './fixtures/restart-kit.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const SECRET = 'tok_9f8e7d6c5b4a';
const kit = await makeKit('public-link');
const { WORK, server } = kit;
const KIT_PORT = new URL(kit.base).port;

/* The second server: the answers the kit's library does not give. */
const odd = { requests: [] };
const oddSrv = http.createServer((req, res) => {
  odd.requests.push(req.url);
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  if (p === '/page.mp4') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><p>Download page</p>'); return; }
  if (p === '/blob') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(crypto.randomBytes(64 * 1024)); return; }
  if (p === '/blob-mp4') {
    const b = crypto.randomBytes(64 * 1024);
    b.write('ftypisom', 4, 'latin1');
    res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(b); return;
  }
  if (p === '/grow.mp4') {
    // No length given, and more than the cap: stopped while streaming.
    res.writeHead(200, { 'content-type': 'video/mp4' });
    if (req.headers.range) { res.end(Buffer.alloc(1)); return; }
    let sent = 0;
    const tick = () => {
      if (res.destroyed) return;
      if (sent >= 3 * 1024 * 1024) { res.end(); return; }
      res.write(Buffer.alloc(64 * 1024));
      sent += 64 * 1024;
      setImmediate(tick);
    };
    tick();
    return;
  }
  if (p === '/to-loopback') { res.writeHead(302, { location: `http://127.0.0.1:${KIT_PORT}/Items/clip/Download` }); res.end(); return; }
  if (p === '/to-lan') { res.writeHead(302, { location: 'http://lan.example/film.mp4' }); res.end(); return; }
  if (p === '/to-file') { res.writeHead(302, { location: 'file:///etc/passwd' }); res.end(); return; }
  if (p === '/to-clip') { res.writeHead(301, { location: `http://public.example:${KIT_PORT}/Items/clip/Download?${u.search.slice(1)}` }); res.end(); return; }
  const loop = /^\/loop\/(\d+)$/.exec(p);
  if (loop) { res.writeHead(302, { location: `/loop/${Number(loop[1]) + 1}` }); res.end(); return; }
  res.writeHead(404); res.end();
});
oddSrv.on('connection', (s) => s.unref());
await new Promise((r) => oddSrv.listen(0, '127.0.0.1', r));
const ODD_PORT = oddSrv.address().port;

/* The tests' network: public.example is "public" and served from 127.0.0.1;
   lan.example resolves to the router. Every other rule is the real one. */
const lookup = (host, _opts, cb) => {
  if (host === 'public.example') return cb(null, [{ address: '127.0.0.1', family: 4 }]);
  if (host === 'localhost') return cb(null, [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }]);
  if (host === 'lan.example') return cb(null, [{ address: '192.168.20.1', family: 4 }]);
  if (host === 'tailnet.example') return cb(null, [{ address: '100.100.100.100', family: 4 }]);
  return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }));
};
const allow = (ip, host) => host === 'public.example' || isPublicAddress(ip);
const linkNet = { lookup, allow };

const CLIP = `http://public.example:${KIT_PORT}/Items/clip/Download?token=${SECRET}`;
const ODD = (p) => `http://public.example:${ODD_PORT}${p}`;

// Every line the process logs, from any scope, and every line the plugin logs.
const allLogs = [];
log.setSink({ write: (e) => allLogs.push(`${e.scope} ${e.msg} ${e.extra ? JSON.stringify(e.extra) : ''}`) });
const logs = [];
const plog = { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)), debug() {} };

const config = (media = {}) => mergeDefaults({
  movieRequests: {
    postsGroup: 'posts@g.us', notify: {}, blockedRatings: ['R'],
    reactions: { redo: '🔄', failed: '⚠️', cancelled: '❌', skipped: '⏭️', done: '✅', sending: '⬆️', downloading: '⬇️', converting: '⚙️' },
  },
  media: { workDir: WORK, ffprobePath: kit.FFPROBE, ffmpegPath: kit.FFMPEG, deleteAfterSend: true, segmentedEncode: false, ...media },
}, DEFAULT_CONFIG);

function fakeBot() {
  const bot = {
    sent: [], texts: [],
    isConnected: () => true, react: async () => true,
    sendText: async (jid, text) => { bot.texts.push({ jid, text }); return {}; },
    groups: () => [], groupMemberInfo: () => ({ isMember: false }), on() {}, off() {},
    // What the job's directory held as the upload began: keep-until-sent
    // (media/work-files.js) keeps a public link's download there too.
    sendDocument: async (jid, file, opts) => {
      bot.sent.push({ jid, file, name: opts?.fileName, bytes: fs.readFileSync(file), work: fs.readdirSync(path.dirname(file)) });
      return {};
    },
  };
  return bot;
}
function makeCtx(media = {}) {
  forgetThisProcess();
  moviePlugin._parked = null;
  moviePlugin._retries = new RetryBook({ delayMs: () => 3_600_000, log: plog });
  const added = [];
  const store = kit.loadStore();
  return {
    added, store, bot: fakeBot(), log: plog, config: config(media), linkNet,
    // No yt-dlp here, whatever the box has: a web page is asked of it, and
    // this suite is about files (test/public-link-yt-dlp.test.mjs has pages).
    ytdlp: { bin: path.join(kit.TMP, 'no-yt-dlp'), dataDir: null },
    queue: { pending: [], active: new Map(), on() {}, off() {}, add(j) { added.push(j); return `q${added.length}`; } },
  };
}
const job = () => ({ id: `j${Math.random().toString(16).slice(2, 8)}`, signal: new AbortController().signal,
  progress() {}, isCancelled: () => false, cancelReason: () => null });
const clearJournal = () => { const s = kit.loadStore(); s.set('pending', []); s.set('history', []); };
const attempt = async (fn) => { try { return { r: await fn() }; } catch (err) { return { err }; } };
const queueLink = (ctx, body) => attempt(() => moviePlugin.queuePublicLink(body, ctx, { requester: 'panel (mommy)' }));

console.log('=== which addresses are public ===');
{
  for (const ip of ['127.0.0.1', '192.168.20.1', '10.0.0.5', '172.16.4.4', '100.100.100.100', '169.254.169.254',
    '0.0.0.0', '224.0.0.251', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd7a:115c:a1e0::1',
    '::ffff:127.0.0.1', '::ffff:192.168.20.1', '64:ff9b::a00:1', 'ff02::1', '2001:db8::1', '2002:c0a8:5601::1']) {
    ok(!isPublicAddress(ip), `${ip} is not public`);
  }
  for (const ip of ['8.8.8.8', '104.16.0.1', '2606:4700::1111']) ok(isPublicAddress(ip), `${ip} is public`);
}

console.log('=== only http and https links ===');
{
  for (const bad of ['file:///etc/passwd', 'ftp://example.com/film.mp4', 'javascript:alert(1)', 'data:video/mp4;base64,AAAA',
    'gopher://example.com/', 'not a link', '', 'https://user:pw@example.com/f.mp4']) {
    let err = null;
    try { checkLinkUrl(bad); } catch (e) { err = e; }
    ok(err?.code === 'LINK_REFUSED', `refused: ${JSON.stringify(bad)} (${err?.message})`);
  }
  ok(linkForDisplay(`https://cdn.example.org/a/b.mp4?token=${SECRET}#t=1`) === 'https://cdn.example.org/a/b.mp4',
    'shown as scheme, host and path - no query, no fragment');
  ok(typeKind('video/mp4') === 'video' && typeKind('text/html; charset=utf-8') === 'not-video'
    && typeKind('application/octet-stream') === 'unknown' && typeKind('') === 'unknown', 'content types sorted');
  const mp4 = Buffer.alloc(64); mp4.write('ftyp', 4, 'latin1');
  ok(sniffContainer(mp4) === 'mp4' && sniffContainer(Buffer.from('<!doctype html><html><body>hello</body></html>')) === null,
    'an mp4 is known by its first bytes, a web page is not');
}

console.log('=== every private way in is refused before a byte is asked for ===');
{
  const f = makeLinkFetch({ maxBytes: 1e9, ...linkNet });
  const before = server.requests.length;
  const cases = [
    ['127.0.0.1', `http://127.0.0.1:${KIT_PORT}/Items/clip/Download`],
    ['localhost', `http://localhost:${KIT_PORT}/Items/clip/Download`],
    ['192.168.20.1', 'http://192.168.20.1/admin'],
    ['10.x', 'http://10.1.2.3/film.mp4'],
    ['100.100.100.100 (the tailnet)', 'http://100.100.100.100/film.mp4'],
    ['::1', `http://[::1]:${KIT_PORT}/Items/clip/Download`],
    ['a name resolving to the router', 'http://lan.example/film.mp4'],
    ['a name resolving to the tailnet', 'https://tailnet.example/film.mp4'],
    ['a public host redirecting to 127.0.0.1', ODD('/to-loopback')],
    ['a public host redirecting to a name on the LAN', ODD('/to-lan')],
    ['a public host redirecting to file://', ODD('/to-file')],
    ['file://', 'file:///etc/passwd'],
    ['ftp://', 'ftp://public.example/film.mp4'],
  ];
  for (const [label, url] of cases) {
    const { err } = await attempt(() => f(url));
    ok(err?.code === 'LINK_REFUSED', `${label}: ${err?.message ?? 'NOT refused'}`);
  }
  ok(server.requests.length === before, 'and the clip server behind 127.0.0.1 was never asked for anything');

  // And through the box's own resolver, which answers localhost from /etc/hosts.
  const sys = await attempt(() => makeLinkFetch({ maxBytes: 1e9 })(`http://localhost:${KIT_PORT}/Items/clip/Download`));
  ok(sys.err?.code === 'LINK_REFUSED', `localhost through the real resolver: ${sys.err?.message}`);

  const { err: loopErr } = await attempt(() => f(ODD('/loop/0')));
  ok(loopErr?.code === 'LINK_REFUSED' && /more than 5 times/.test(loopErr.message), `redirects stop after five: ${loopErr?.message}`);
  ok(odd.requests.filter((r) => r.startsWith('/loop/')).length === 6, 'the first answer and five hops, no more');

  // Through the plugin, as the panel's route calls it: nothing journalled.
  clearJournal();
  const ctx = makeCtx();
  const { err } = await queueLink(ctx, { url: 'http://192.168.20.1/film.mp4', title: 'Router', year: 2020 });
  ok(err?.code === 'LINK_REFUSED' && ctx.added.length === 0 && !(ctx.store.get('pending', []) ?? []).length,
    'queuePublicLink refuses it and queues nothing');
  const redirected = await attempt(() => f(ODD(`/to-clip?token=${SECRET}`)));
  ok(redirected.r?.status === 200, 'a public host redirecting to another public one is followed');
  await redirected.r?.body?.cancel();
}

console.log('=== Plandemic from a public link: downloaded, converted, posted as "Title (Year)" ===');
{
  clearJournal();
  server.requests.length = 0;
  logs.length = 0;
  allLogs.length = 0;
  const ctx = makeCtx();
  const { r, err } = await queueLink(ctx, { url: CLIP, title: 'Plandemic', year: '2020' });
  ok(!err && r.title === 'Plandemic' && r.year === 2020, `queued (${err?.message ?? 'ok'})`);
  ok(r?.size === server.body.length, `with its size, from the link's answer (${r?.size})`);
  ok(ctx.added.length === 1 && ctx.added[0].label === 'Plandemic (2020)', `one job, labelled "${ctx.added[0]?.label}"`);
  const entry = (ctx.store.get('pending', []) ?? [])[0];
  ok(entry?.publicLink?.url === CLIP, 'the journal keeps the full link, token and all, to download from');

  const e = await attempt(() => ctx.added[0].run(job()));
  ok(!e.err, `the job runs to the end (${e.err?.message ?? 'ok'})`);
  const post = ctx.bot.sent[0];
  ok(post?.jid === 'posts@g.us' && post?.name === 'Plandemic (2020).mp4', `posted to the movie posts group as ${post?.name}`);
  ok(post && Buffer.compare(post.bytes, server.body) === 0, 'the file posted is the link\'s, byte for byte');
  ok(server.requests.some((q) => q.url.includes(`token=${SECRET}`) && !q.range), 'downloaded with its query, which it needs');
  // The operator, 2026-09-30: "files should remain in their folders until
  // fully sent on whatsapp" - a public link's download is no exception.
  ok(post?.work?.some((n) => /^source\./.test(n)) && post.work.some((n) => n === path.basename(post.file)),
    `its download was still beside the film as the upload began (${post?.work?.join(', ')})`);
  const row = (ctx.store.get('history', []) ?? [])[0];
  ok(row?.status === 'sent' && row.publicLink === `http://public.example:${KIT_PORT}/Items/clip/Download`,
    `History: sent, with the link's host and path (${row?.status}, ${row?.publicLink})`);
  ok(!(ctx.store.get('pending', []) ?? []).length, 'and the journal is clear');

  const everywhere = JSON.stringify(ctx.store.get('history', [])) + logs.join('\n') + allLogs.join('\n')
    + JSON.stringify(ctx.store.get('transfers', [])) + ctx.added.map((j) => JSON.stringify({ label: j.label, meta: j.meta })).join('');
  ok(!everywhere.includes(SECRET), 'the query string is in no log line, History row, transfer record or queue entry');
  ok(logs.some((l) => /queued "Plandemic \(2020\)" from a public link \(http:\/\/public\.example:\d+\/Items\/clip\/Download, 3\.00 MB\)/.test(l)),
    'the log says what was queued, from where, without the query');
}

console.log('=== a year is optional, and none reads as no year, not "(null)" ===');
{
  clearJournal();
  const ctx = makeCtx();
  const { r, err } = await queueLink(ctx, { url: `http://public.example:${KIT_PORT}/Items/other/Download`, title: 'Some Free Film' });
  ok(!err && r.year === null && ctx.added[0]?.label === 'Some Free Film', `labelled "${ctx.added[0]?.label}"`);
  await ctx.added[0].run(job());
  ok(ctx.bot.sent[0]?.name === 'Some Free Film.mp4', `posted as ${ctx.bot.sent[0]?.name}`);
  ok(!logs.some((l) => l.includes('(null)')), 'no line says "(null)"');
  const bad = await queueLink(ctx, { url: CLIP, title: 'X', year: '20' });
  ok(bad.err && /four digits/.test(bad.err.message), `a year that is not one is refused: ${bad.err?.message}`);
  const none = await queueLink(ctx, { url: CLIP, title: '  ' });
  ok(none.err && /title/.test(none.err.message), `a title is required: ${none.err?.message}`);
}

console.log('=== no rating gate and no AI check: queueing it by hand is the approval ===');
{
  clearJournal();
  const ctx = makeCtx();
  // An AI check that would be asked, if anything were: it must not be.
  ctx.config.gemini = { ...ctx.config.gemini, apiKey: 'k', enabled: true };
  const realFetch = globalThis.fetch;
  let outside = 0;
  globalThis.fetch = async () => { outside += 1; throw new Error('no network in tests'); };
  try {
    const { err } = await queueLink(ctx, { url: CLIP, title: 'An R Film', year: 2001 });
    ok(!err && ctx.added.length === 1, `queued with the posts group's blocked list set (${err?.message ?? 'ok'})`);
    ok(outside === 0, 'nothing asked OMDb, Jellyfin or an AI provider');
  } finally { globalThis.fetch = realFetch; }
}

console.log('=== the same link, or the same film, is not queued twice ===');
{
  clearJournal();
  const ctx = makeCtx();
  await queueLink(ctx, { url: CLIP, title: 'Plandemic', year: 2020 });
  const again = await queueLink(ctx, { url: CLIP, title: 'Plandemic Indoctornation', year: 2020 });
  ok(again.err?.code === 'DUPLICATE' && /That link is already in the queue, as Plandemic \(2020\)/.test(again.err.message),
    `the same link: ${again.err?.message}`);
  const twin = await queueLink(ctx, { url: `http://public.example:${KIT_PORT}/Items/mirror/Download`, title: 'plandemic', year: 2020 });
  ok(twin.err?.code === 'DUPLICATE' && /already in the queue/.test(twin.err.message), `the same film from another link: ${twin.err?.message}`);
  ok(ctx.added.length === 1, 'one job, not three');
  ok(!again.err?.message.includes(SECRET), 'and the refusal does not repeat the token');
}

console.log('=== not a video: refused with a reason ===');
{
  clearJournal();
  const ctx = makeCtx();
  const page = await queueLink(ctx, { url: ODD('/page.mp4'), title: 'Page', year: 2020 });
  ok(page.err?.code === 'NOT_VIDEO' && /web page \(text\/html\), not a video/.test(page.err.message), `a web page: ${page.err?.message}`);
  // A type that says nothing: its first bytes are looked at, then ffprobe.
  const noVideo = path.join(kit.TMP, 'ffprobe-novideo');
  fs.writeFileSync(noVideo, '#!/bin/sh\necho \'{"streams":[{"codec_type":"audio"}],"format":{}}\'\n', { mode: 0o755 });
  const ctx2 = makeCtx({ ffprobePath: noVideo });
  const blob = await queueLink(ctx2, { url: ODD('/blob'), title: 'Blob', year: 2020 });
  ok(blob.err?.code === 'NOT_VIDEO' && /ffprobe/.test(blob.err.message), `octet-stream that ffprobe finds no video in: ${blob.err?.message}`);
  ok(!fs.readdirSync(WORK).some((n) => n.startsWith('link-sniff-')), 'the bytes it looked at are not left in the work directory');
  const mp4 = await queueLink(ctx2, { url: ODD('/blob-mp4'), title: 'Blob Film', year: 2020 });
  ok(!mp4.err && ctx2.added.length === 1, `octet-stream that starts like an mp4 is taken (${mp4.err?.message ?? 'ok'})`);
  ok(ctx.added.length === 0, 'and nothing else was queued');
}

console.log('=== too big: refused up front when the server says so, stopped mid-stream when it does not ===');
{
  clearJournal();
  const ctx = makeCtx({ maxDownloadBytes: 1024 * 1024 });
  const big = await queueLink(ctx, { url: CLIP, title: 'Big', year: 2020 });
  ok(big.err?.code === 'LINK_TOO_BIG' && /3\.00 MB, over the 1\.00 MB/.test(big.err.message), `refused before queueing: ${big.err?.message}`);
  ok(ctx.added.length === 0, 'nothing queued');

  const grow = await queueLink(ctx, { url: ODD('/grow.mp4'), title: 'Growing', year: 2020 });
  ok(!grow.err && ctx.added.length === 1, `a link with no length is queued (${grow.err?.message ?? 'ok'})`);
  const e = await attempt(() => ctx.added[0].run(job()));
  const row = (ctx.store.get('history', []) ?? []).find((h) => h.title === 'Growing');
  ok(/passed 1\.00 MB while downloading/.test(`${e.err?.message} ${row?.detail}`), `stopped mid-stream: ${e.err?.message ?? row?.detail}`);
  ok(row?.status === 'failed', `History says failed, not retried (${row?.status})`);
  ok(ctx.bot.sent.length === 0, 'and nothing was posted');
}

console.log('=== a restart goes on with the download from the byte it reached ===');
{
  clearJournal();
  server.requests.length = 0;
  let ctx = makeCtx();
  await queueLink(ctx, { url: CLIP, title: 'Plandemic', year: 2020 });
  server.cutAt = 1024 * 1024;
  const first = await attempt(() => ctx.added[0].run(job()));
  server.cutAt = null;
  const entry = (kit.loadStore().get('pending', []) ?? [])[0];
  ok(!!entry?.publicLink, `the connection dropped mid-download (${first.err?.message ?? 'no error'}) and the journal keeps the job`);
  moviePlugin._retries.clear();

  // The next process.
  ctx = makeCtx();
  server.requests.length = 0;
  await moviePlugin.recoverPending(ctx);
  ok(ctx.added.length === 1 && ctx.added[0].label === 'Plandemic (2020)', 'recovery puts it back in the queue, from its link');
  const e = await attempt(() => ctx.added[0].run(job()));
  ok(!e.err, `and it runs (${e.err?.message ?? 'ok'})`);
  const ranged = server.requests.find((q) => /^bytes=[1-9]\d*-$/.test(q.range ?? ''));
  ok(!!ranged, `the rest is asked for with Range (${ranged?.range ?? server.requests.map((q) => q.range).join(', ')})`);
  ok(Buffer.compare(ctx.bot.sent[0]?.bytes ?? Buffer.alloc(0), server.body) === 0, 'and the film posted is whole, byte for byte');
  ok(!server.requests.some((q) => q.url.includes('/search')), 'no library was searched for it');

  // A server that does not serve ranges: it starts again, and still gets there.
  clearJournal();
  ctx = makeCtx();
  await queueLink(ctx, { url: CLIP, title: 'No Ranges', year: 2020 });
  server.cutAt = 1024 * 1024;
  await attempt(() => ctx.added[0].run(job()));
  server.cutAt = null;
  moviePlugin._retries.clear();
  server.ranges = false;
  ctx = makeCtx();
  server.requests.length = 0;
  await moviePlugin.recoverPending(ctx);
  const e2 = await attempt(() => ctx.added[0]?.run(job()));
  server.ranges = true;
  ok(!e2.err && Buffer.compare(ctx.bot.sent[0]?.bytes ?? Buffer.alloc(0), server.body) === 0,
    `without ranges it downloads it again from the start, and posts it whole (${e2.err?.message ?? 'ok'})`);
}

console.log('=== the hourly check does not re-run it by title ===');
{
  const why = rerunRefusal({ plugin: 'movie', row: { id: 'panel-1', status: 'failed', at: Date.now(), title: 'Plandemic', year: 2020, publicLink: 'https://x/y.mp4' } });
  ok(/public link/.test(why ?? ''), `refused: ${why}`);
}

console.log('=== the panel route: admins only, audited without the query ===');
{
  clearJournal();
  const ctx = makeCtx();
  const events = [];
  const stateStore = {
    namespace: (name) => ({
      get: (k, d) => (name === 'audit' && k === 'events' ? events : d),
      set() {}, push: (k, v) => { if (name === 'audit') events.unshift(v); },
    }),
  };
  const configStore = {
    get: () => ({ ...ctx.config, web: { adminPasswordHash: 'x', admins: [{ username: 'mommy', role: 'admin', passwordHash: 'x' }] } }),
    update: () => ({}), redacted: () => ({}), onChange: () => {},
  };
  const mount = (signedIn) => {
    const app = express();
    app.use(express.json());
    if (signedIn) app.use((req, _res, next) => { req.session = { user: { username: 'mommy', role: 'admin' } }; next(); });
    else app.use((req, _res, next) => { req.session = {}; next(); });
    app.use('/api', createApiRouter({
      configStore, bot: { groups: () => [], on() {} }, queue: { pending: [], on() {} },
      pluginManager: { plugins: new Map([['movie-requests', { plugin: moviePlugin, ctx }]]), notifyConfigChange: async () => {} },
      stateStore, fileLogger: { tail: () => [] }, alerts: {}, lockScheduler: {},
    }));
    return new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  };
  const post = (port, body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/queue/public-link',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
    });
    r.on('error', reject);
    r.end(data);
  });

  const anon = await mount(false);
  const refused = await post(anon.address().port, { url: CLIP, title: 'Plandemic', year: 2020 });
  ok(refused.status === 401 && ctx.added.length === 0, `not signed in: ${refused.status}, nothing queued`);
  anon.close();

  const srv = await mount(true);
  const port = srv.address().port;
  allLogs.length = 0;
  const good = await post(port, { url: CLIP, title: 'Plandemic', year: 2020 });
  ok(good.status === 200 && good.body.ok && good.body.size === server.body.length && good.body.title === 'Plandemic',
    `an admin queues it: ${good.status}, ${good.body?.title} (${good.body?.year}), ${good.body?.size} bytes`);
  const dup = await post(port, { url: CLIP, title: 'Plandemic', year: 2020 });
  ok(dup.status === 409 && /already in the queue/.test(dup.body.error), `a duplicate is 409: ${dup.body?.error}`);
  const lan = await post(port, { url: `http://192.168.20.1/x.mp4?key=${SECRET}`, title: 'Router', year: 2020 });
  ok(lan.status === 400 && /private, local or reserved/.test(lan.body.error), `a private address is 400: ${lan.body?.error}`);
  srv.close();

  ok(events.some((e) => /queued "Plandemic \(2020\)" from a public link/.test(e.action) && e.detail.includes('/Items/clip/Download')),
    'the audit log says who queued what, with the link\'s host and path');
  ok(events.some((e) => e.action === 'public link not queued' && e.detail.startsWith('http://192.168.20.1/x.mp4')),
    'and records the refusals as well');
  const said = JSON.stringify(events) + JSON.stringify([good.body, dup.body, lan.body]) + allLogs.join('\n')
    + JSON.stringify(ctx.store.get('history', []));
  ok(!said.includes(SECRET), 'the query string is in no audit row, reply, log line or History row');
}

kit.close();
oddSrv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
