/**
 * Queue a film from any public download link - no Jellyfin involved.
 *
 * The operator (2026-09-30): "For a movie like plandemic being that it's free
 * there's a public download link for it, so there should be a box on the
 * panel where an admin can manually enter any public mp4 download link and
 * it'll queue and process, why should it need to be jellyfin if it's public
 * anyway".
 *
 * Everything here exists because the bot now fetches a URL a person typed,
 * from a box that sits on a home LAN (192.168.20.x), on the tailnet
 * (100.64.0.0/10) and next to Jellyfin. A link to http://192.168.20.1/ or to
 * a public name that resolves to - or redirects to - one of those is a way
 * of making the bot read the router, the Jellyfin API or anything else on
 * that network (server-side request forgery). So:
 *
 *   - only http and https;
 *   - every address a name resolves to must be a public one, checked in the
 *     connection's own DNS lookup, so the address checked is the address
 *     connected to (a name that answers public for the check and private for
 *     the connection - DNS rebinding - gets nowhere);
 *   - every redirect hop is checked the same way, and there are at most five;
 *   - any port, since the address it is on is public by then;
 *   - a size cap (media.maxDownloadBytes), from the headers when the server
 *     gives a length and counted while streaming whether or not it does;
 *   - timeouts for an answer and for a body that stops arriving.
 *
 * A link can carry a token in its query string. The full URL is needed to
 * download, and is kept only in the job's journal entry on this box (data/
 * is private); logs, History, the audit log and the panel get linkForDisplay():
 * the host and path, never the query - but for a YouTube watch link's v=,
 * which is the video itself.
 *
 * A link to a web page that yt-dlp has a site extractor for - YouTube, on
 * 2026-10-11 - is not fetched here at all: media/yt-dlp.js takes it, after
 * assertPublicHost() has applied the same address rule to its host.
 */
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { fmtBytes } from './ffmpeg.js';

export const MAX_REDIRECTS = 5;
/** How much of a link with no telling content type is read to see whether it is a video. */
export const SNIFF_BYTES = 4 * 1024 * 1024;

/** A refusal the admin is shown as it is: coded, so a caller can tell it from a failure. */
export function linkError(message, code = 'LINK_REFUSED') {
  return Object.assign(new Error(message), { code });
}

/* ------------------------------------------------------------- the URL */

/**
 * The link as it may be shown or recorded anywhere: scheme, host and path.
 * No query string or fragment, which is where tokens live, and no user:pass@.
 *
 * One exception. A YouTube watch link's video is in its query
 * (https://www.youtube.com/watch?v=...), and without it every YouTube film in
 * History and the audit log read "https://www.youtube.com/watch", which says
 * nothing about which one. So v= stays, checked to be a video id and nothing
 * else; si= (the share button's tracker), pp=, list=, t= and every other key
 * still go, as every key of every other site does.
 */
export function linkForDisplay(raw) {
  let u;
  try { u = raw instanceof URL ? raw : new URL(String(raw)); } catch { return '(not a link)'; }
  const v = youtubeWatchId(u);
  return `${u.protocol}//${u.host}${u.pathname}${v ? `?v=${v}` : ''}`;
}

/** The video id of a youtube.com/watch link, or null for anything else. */
export function youtubeWatchId(u) {
  if (!/^(?:www\.|m\.|music\.)?youtube\.com$/i.test(u?.hostname ?? '') || u.pathname !== '/watch') return null;
  const v = u.searchParams.get('v');
  return v && /^[A-Za-z0-9_-]{6,20}$/.test(v) ? v : null;
}

/**
 * Parse what the admin pasted. Throws a readable refusal for anything that is
 * not an http(s) URL - file://, ftp://, data:, javascript: and the rest.
 */
export function checkLinkUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) throw linkError('Paste the download link.');
  let u;
  try { u = new URL(text); } catch { throw linkError("That isn't a link: it should start with https:// or http://."); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw linkError(`Only http:// and https:// links can be queued, not ${u.protocol.replace(/:$/, '')}://.`);
  }
  if (!u.hostname) throw linkError('That link has no host name.');
  // Credentials in the link would be sent on every hop, and logged by the
  // far end; nothing public needs them.
  if (u.username || u.password) throw linkError('A link with a user name or password in it is not a public link.');
  return u;
}

/** The container a link's path suggests, for the download's file name. */
export function containerOf(u, contentType = '') {
  const ext = path.extname(u.pathname).toLowerCase().replace(/^\./, '');
  if (/^(mp4|m4v|mkv|webm|mov|avi|ts|mpg|mpeg|wmv|flv)$/.test(ext)) return ext;
  if (/matroska/.test(contentType)) return 'mkv';
  if (/webm/.test(contentType)) return 'webm';
  if (/quicktime/.test(contentType)) return 'mov';
  return 'mp4';
}

/** A stable id for the link's work manifest: which file it is, without the token. */
export function linkId(fullUrl) {
  return `link:${crypto.createHash('sha256').update(String(fullUrl)).digest('hex').slice(0, 20)}`;
}

/* ------------------------------------------------------ the addresses */

// Not public: this network, loopback, RFC 1918, CGNAT (100.64/10 - the
// tailnet), link-local (169.254/16, cloud metadata among it), the IETF and
// documentation blocks, benchmarking, multicast and everything above it.
const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
// IPv6 is allowed only in global unicast (2000::/3), and within it not the
// documentation block, 6to4 (2002::/16) or Teredo (2001::/32), both of which
// carry an IPv4 address that could be a private one. Everything else - ::1,
// ::, fc00::/7, fe80::/10, ff00::/8, the IPv4-mapped ::ffff:0:0/96 and NAT64
// 64:ff9b::/96 - is outside 2000::/3.
const v4Blocked = new net.BlockList();
for (const [a, p] of V4_BLOCKED) v4Blocked.addSubnet(a, p, 'ipv4');
const v6Global = new net.BlockList();
v6Global.addSubnet('2000::', 3, 'ipv6');
const v6Blocked = new net.BlockList();
for (const [a, p] of [['2001:db8::', 32], ['2002::', 16], ['2001::', 32]]) v6Blocked.addSubnet(a, p, 'ipv6');

/** Whether the bot may connect to this address for a public link. */
export function isPublicAddress(ip) {
  const addr = String(ip ?? '').replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const kind = net.isIP(addr);
  if (kind === 4) return !v4Blocked.check(addr, 'ipv4');
  if (kind === 6) return v6Global.check(addr, 'ipv6') && !v6Blocked.check(addr, 'ipv6');
  return false;
}

const refusedAddress = (host, ip) => linkError(
  `Refused: ${host} ${net.isIP(host) ? 'is' : `resolves to ${ip}, which is`} a private, local or reserved address. `
  + 'Only links to public servers on the internet can be queued.',
);

/**
 * The address rule for a link the bot does not fetch itself: yt-dlp makes its
 * own connections (media/yt-dlp.js), which the guarded lookup below never
 * sees, so the link's host is looked up here first and every address it
 * gives must be public. It is the best that can be done from outside yt-dlp
 * - a name could answer differently a moment later - which is why yt-dlp is
 * also kept to its site extractors, whose hosts are the sites' own, and never
 * runs the generic one that would fetch any page it is pointed at.
 *
 * `lookup` and `allow` are the tests' seams, as in makeLinkFetch.
 */
export async function assertPublicHost(u, { lookup = dns.lookup, allow = null } = {}) {
  const host = String(u?.hostname ?? '').replace(/^\[|\]$/g, '');
  const permitted = (ip) => (allow ? allow(ip, host) : isPublicAddress(ip));
  if (!host) throw linkError('That link has no host name.');
  if (net.isIP(host)) {
    if (!permitted(host)) throw refusedAddress(host, host);
    return [host];
  }
  let list;
  try {
    list = await new Promise((resolve, reject) => lookup(host, { all: true }, (err, a) => (err ? reject(err) : resolve(a))));
  } catch (err) {
    // EAI_AGAIN stays in the message: it is a resolver that will answer
    // again (media/resume.js counts it as transient); ENOTFOUND is a name
    // that does not exist.
    throw linkError(`Could not look up ${host} (${err.code ?? err.message}).`, err.code === 'EAI_AGAIN' ? 'EAI_AGAIN' : 'LINK_REFUSED');
  }
  const addrs = (Array.isArray(list) ? list : [{ address: list }]).map((a) => a.address);
  if (!addrs.length) throw linkError(`${host} has no address.`);
  const bad = addrs.find((a) => !permitted(a));
  if (bad) throw refusedAddress(host, bad);
  return addrs;
}

/* ----------------------------------------------------------- the fetch */

/**
 * A fetch() for public links, with the rules at the top of this file. It
 * answers what downloadToFile and probeDownload need of a Response - status,
 * headers, and a web stream body - so the normal pipeline runs on it as it
 * is. `redirect` in its options is ignored: redirects are always followed
 * here, by hand, so that each hop is checked.
 *
 * `lookup` and `allow` are seams for the tests, which serve a clip from
 * 127.0.0.1 under a made-up public name; nothing in the bot passes them.
 */
export function makeLinkFetch({
  maxBytes = null, answerTimeoutMs = 30_000, idleTimeoutMs = 120_000, maxRedirects = MAX_REDIRECTS,
  lookup = dns.lookup, allow = null,
} = {}) {
  const permitted = (ip, host) => (allow ? allow(ip, host) : isPublicAddress(ip));

  // The connection's own lookup: the address checked is the one connected to.
  const guardedLookup = (host) => (hostname, options, cb) => {
    const opts = typeof options === 'object' && options ? options : {};
    lookup(hostname, { all: true, family: opts.family ?? 0, hints: opts.hints }, (err, addrs) => {
      if (err) return cb(err);
      const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: net.isIP(addrs) }];
      if (!list.length) return cb(linkError(`${host} has no address.`));
      const bad = list.find((a) => !permitted(a.address, host));
      if (bad) return cb(refusedAddress(host, bad.address));
      if (opts.all) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    });
  };

  function once(u, { method, headers, signal }) {
    const host = u.hostname.replace(/^\[|\]$/g, '');
    // An address typed into the link is never looked up, so it is checked here.
    if (net.isIP(host) && !permitted(host, host)) return Promise.reject(refusedAddress(host, host));
    return new Promise((resolve, reject) => {
      const mod = u.protocol === 'https:' ? https : http;
      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(answerTimer); fn(v); } };
      const req = mod.request(u, {
        method,
        headers: { 'user-agent': 'whatsapp-bot (public link)', 'accept-encoding': 'identity', ...headers },
        lookup: guardedLookup(host),
        agent: false,
        signal,
      });
      const answerTimer = setTimeout(() => {
        req.destroy(linkError(`${host} did not answer within ${Math.round(answerTimeoutMs / 1000)} s (ETIMEDOUT)`, 'ETIMEDOUT'));
      }, answerTimeoutMs);
      // A body that stops arriving: the socket's own idle timer, which runs
      // for the whole download.
      req.setTimeout(idleTimeoutMs, () => {
        req.destroy(linkError(`${host} stopped sending for ${Math.round(idleTimeoutMs / 1000)} s (ETIMEDOUT)`, 'ETIMEDOUT'));
      });
      req.on('response', (res) => done(resolve, { res, req }));
      req.on('error', (err) => done(reject, err));
      req.end();
    });
  }

  return async function linkFetch(url, { method = 'GET', headers = {}, signal = null } = {}) {
    let u = checkLinkUrl(url);
    for (let hop = 0; ; hop += 1) {
      const { res, req } = await once(u, { method, headers, signal });
      const loc = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && res.statusCode !== 304 && loc) {
        res.resume();
        req.destroy();
        if (hop >= maxRedirects) throw linkError(`The link redirected more than ${maxRedirects} times - not followed any further.`);
        let next;
        try { next = new URL(loc, u); } catch { throw linkError(`${u.host} redirected to something that is not a link.`); }
        // A redirect to file://, ftp:// or a private address is refused
        // like a link pasted that way (checkLinkUrl here, the lookup next).
        try { u = checkLinkUrl(next.href); } catch (err) {
          throw linkError(`${u.host} redirected to a link that cannot be followed: ${err.message}`);
        }
        continue;
      }
      return toResponse(res, req, u, maxBytes);
    }
  };
}

/** Node's answer as a fetch Response, its body counted against the cap. */
function toResponse(res, req, u, maxBytes) {
  const status = res.statusCode;
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    for (const one of Array.isArray(v) ? v : [v]) if (v != null) headers.append(k, String(one));
  }
  const range = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(res.headers['content-range'] ?? '');
  const length = Number(res.headers['content-length'] ?? 0);
  const whole = status === 206 ? (range ? Number(range[3]) : null) : (length > 0 ? length : null);
  const from = status === 206 && range ? Number(range[1]) : 0;
  if (maxBytes > 0 && whole > maxBytes) {
    res.resume();
    req.destroy();
    throw tooBig(u, whole, maxBytes);
  }
  const nullBody = status === 204 || status === 304 || status < 200;
  let body = null;
  if (!nullBody) {
    const cap = maxBytes > 0 ? maxBytes - from : Infinity;
    let seen = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        seen += chunk.length;
        if (seen > cap) {
          req.destroy();
          return cb(tooBig(u, from + seen, maxBytes, true));
        }
        return cb(null, chunk);
      },
    });
    // A connection that drops mid-body reads "aborted" from Node; named for
    // what it is, and as the retry logic knows it (media/resume.js).
    res.on('error', (err) => counter.destroy(err?.code === 'ETIMEDOUT' ? err
      : linkError(`the connection to ${u.host} dropped mid-download (ECONNRESET)`, 'ECONNRESET')));
    res.on('aborted', () => counter.destroy(linkError(`the connection to ${u.host} dropped mid-download (ECONNRESET)`, 'ECONNRESET')));
    counter.on('close', () => { if (!res.complete) req.destroy(); });
    res.pipe(counter);
    body = Readable.toWeb(counter);
  } else {
    res.resume();
  }
  return new Response(body, { status, statusText: res.statusMessage ?? '', headers });
}

function tooBig(u, bytes, maxBytes, streaming = false) {
  return linkError(streaming
    ? `The file from ${u.host} passed ${fmtBytes(maxBytes)} while downloading, the most a link may be (media.maxDownloadBytes) - stopped.`
    : `The file at ${u.host} is ${fmtBytes(bytes)}, over the ${fmtBytes(maxBytes)} a link may be (media.maxDownloadBytes).`, 'LINK_TOO_BIG');
}

/* ------------------------------------------------- is it a video at all? */

/**
 * What a Content-Type says: 'video', 'not-video', or 'unknown' when it says
 * nothing useful (application/octet-stream, or none), which is then looked at.
 */
export function typeKind(contentType) {
  const t = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  if (!t || t === 'application/octet-stream' || t === 'binary/octet-stream' || t === 'application/force-download'
    || t === 'application/download' || t === 'application/x-download') return 'unknown';
  if (t.startsWith('video/') || /^application\/(mp4|x-matroska|vnd\.rn-realmedia|x-msvideo|mxf)$/.test(t)) return 'video';
  return 'not-video';
}

/** A video container recognised from its first bytes, or null. */
export function sniffContainer(buf) {
  if (!buf || buf.length < 12) return null;
  const at = (i, s) => buf.subarray(i, i + s.length).toString('latin1') === s;
  if (['ftyp', 'moov', 'mdat', 'free', 'wide'].some((b) => at(4, b))) return 'mp4';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'mkv';
  if (at(0, 'RIFF') && at(8, 'AVI ')) return 'avi';
  if (at(0, 'FLV')) return 'flv';
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0xba) return 'mpg';
  if (buf[0] === 0x30 && buf[1] === 0x26 && buf[2] === 0xb2 && buf[3] === 0x75) return 'wmv';
  if (buf.length > 376 && buf[0] === 0x47 && buf[188] === 0x47 && buf[376] === 0x47) return 'ts';
  return null;
}

const HTMLISH = /^\s*(<!doctype|<html|<\?xml|<head|<body|\{|\[)/i;

/**
 * Ask a link about its file before queueing it: whether it answers, how big
 * it is, and whether it is a video. A ranged GET for the first byte gives the
 * length and the type; a type that says nothing (octet-stream) has its first
 * few megabytes read into `sniffDir` and recognised by their signature, or by
 * ffprobe finding a video stream in them. Anything else - a web page, JSON,
 * an image - is refused with a reason an admin can act on.
 *
 * `isSafe` is the caller's delete guard (CLAUDE.md rule 5) for the sniffed
 * bytes, which are written only inside `sniffDir`, the work directory.
 */
export async function inspectLink(url, {
  fetchImpl, maxBytes = null, sniffDir = null, ffprobePath = 'ffprobe', isSafe = () => false, signal = null,
} = {}) {
  const u = checkLinkUrl(url);
  const res = await fetchImpl(u.href, { headers: { Range: 'bytes=0-0' }, signal });
  try { await res.body?.cancel?.(); } catch { /* done */ }
  if (!res.ok) {
    throw linkError(`${u.host} answered HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} for that link - `
      + 'check it opens as a download in a browser.', 'LINK_HTTP');
  }
  const range = /^bytes\s+\d+-\d+\/(\d+)$/i.exec(res.headers.get('content-range') ?? '');
  const length = Number(res.headers.get('content-length') ?? 0);
  const total = res.status === 206 ? (range ? Number(range[1]) : null) : (length > 0 ? length : null);
  if (maxBytes > 0 && total > maxBytes) throw tooBig(u, total, maxBytes);
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const kind = typeKind(contentType);
  if (kind === 'not-video') {
    // `page`: a web page, which yt-dlp may know how to read the video out of
    // (media/yt-dlp.js); an image or a JSON answer is not worth asking it.
    throw Object.assign(linkError(`That link gives ${/html/.test(contentType) ? 'a web page' : 'a file'} (${contentType}), not a video. `
      + 'Paste the direct download link of the video file itself.', 'NOT_VIDEO'), { page: /html/.test(contentType) });
  }
  let container = containerOf(u, contentType);
  if (kind === 'unknown') {
    const seen = await sniffLink(u, { fetchImpl, sniffDir, ffprobePath, isSafe, signal });
    container = seen ?? container;
  }
  return {
    total, contentType: contentType || null, container, ranges: res.status === 206,
    lastModified: res.headers.get('last-modified'), etag: res.headers.get('etag'),
  };
}

async function sniffLink(u, { fetchImpl, sniffDir, ffprobePath, isSafe, signal }) {
  const res = await fetchImpl(u.href, { headers: { Range: `bytes=0-${SNIFF_BYTES - 1}` }, signal });
  if (!res.ok) {
    try { await res.body?.cancel?.(); } catch { /* done */ }
    throw linkError(`${u.host} answered HTTP ${res.status} when asked for the start of the file.`, 'LINK_HTTP');
  }
  // Only the first few megabytes, whether or not the server honoured Range.
  const chunks = [];
  let got = 0;
  const reader = res.body.getReader();
  try {
    while (got < SNIFF_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
    }
  } finally {
    try { await reader.cancel(); } catch { /* done */ }
  }
  const head = Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, SNIFF_BYTES);
  const known = sniffContainer(head);
  if (known) return known;
  const notVideo = () => linkError('That link does not give a video file: nothing in its first '
    + `${fmtBytes(head.length)} is a film ffprobe can read. Paste the direct download link of the video itself.`, 'NOT_VIDEO');
  if (HTMLISH.test(head.subarray(0, 64).toString('latin1'))) {
    throw Object.assign(notVideo(), { page: /^\s*(<!doctype|<html|<head|<body)/i.test(head.subarray(0, 64).toString('latin1')) });
  }
  if (!sniffDir) throw notVideo();
  fs.mkdirSync(sniffDir, { recursive: true });
  const file = path.join(sniffDir, `link-sniff-${crypto.randomBytes(6).toString('hex')}.bin`);
  fs.writeFileSync(file, head);
  try {
    const hasVideo = await new Promise((resolve) => {
      execFile(ffprobePath, ['-v', 'quiet', '-print_format', 'json', '-show_streams', file],
        { maxBuffer: 4 * 1024 * 1024, timeout: 30_000 }, (err, stdout) => {
          if (err) return resolve(false);
          try {
            resolve((JSON.parse(stdout).streams ?? []).some((s) => s.codec_type === 'video' && !s.disposition?.attached_pic));
          } catch { resolve(false); }
        });
    });
    if (!hasVideo) throw notVideo();
    return null;
  } finally {
    if (isSafe(file)) fs.rmSync(file, { force: true });
  }
}
