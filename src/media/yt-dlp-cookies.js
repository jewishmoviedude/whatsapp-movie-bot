/**
 * The cookies yt-dlp signs in to YouTube with.
 *
 * YouTube can refuse a server it does not know: "Sign in to confirm you're
 * not a bot", and an age-restricted video is only for a signed-in adult
 * account. The operator (2026-10-11): "I'll sign in with my gmail if needed
 * for cookies". So an admin can upload a cookies.txt - exported from a
 * browser signed in to YouTube, in the Netscape format the "Get cookies.txt
 * LOCALLY" extension writes - on Settings -> Library & files -> File
 * handling, beside the public-link size cap it shares.
 *
 * It is a login. So:
 *
 *   - it is kept at one fixed path, data/yt-dlp-cookies.txt, mode 0600, and
 *     carried by the sealed backup with the rest of the app bundle
 *     (activity-backup.js APP_BUNDLE_PATHS), which restores it 0600;
 *   - nothing ever sends it back: the panel is told only whether one is set,
 *     when and by whom it was uploaded, how many cookies it holds, whether
 *     youtube.com is among them and signed in, and when they expire
 *     (describeCookies);
 *   - who uploaded it, and when, is written into the file itself, as a
 *     comment line yt-dlp skips, so the backup carries that too;
 *   - yt-dlp writes its cookie jar back into the file it is given, so it
 *     only ever gets a copy, made for that one run and deleted after it
 *     (withCookieCopy);
 *   - every upload and removal is in the audit log (web/api.js), without a
 *     byte of it.
 *
 * The how-to on the panel says to use a secondary Google account: these
 * cookies are that account, for as long as they last, to anyone who has the
 * file.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const COOKIES_FILE = 'yt-dlp-cookies.txt';
/** Where each run's copy is made; inside data/, which is 0700, and never backed up. */
export const COPIES_DIR = 'yt-dlp-run';
export const MAX_COOKIE_BYTES = 512 * 1024;
const HEADER = '# Netscape HTTP Cookie File';
const META = '# whatsapp-bot:';
// The cookies YouTube's sign-in is made of: with none of them, the file is
// a visitor's, and does nothing for "Sign in to confirm you're not a bot".
const LOGIN = new Set(['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', 'LOGIN_INFO',
  '__Secure-1PSID', '__Secure-3PSID', '__Secure-1PAPISID', '__Secure-3PAPISID']);

export const cookiesPath = (dataDir) => path.join(dataDir, COOKIES_FILE);

const refuse = (message) => Object.assign(new Error(message), { code: 'COOKIES_REFUSED' });

/**
 * Read cookies.txt text, as yt-dlp would: comment and blank lines skipped,
 * "#HttpOnly_" taken off the domain, and every other line seven
 * tab-separated fields with a whole number of seconds for the expiry.
 * Anything else is refused here, by line, rather than skipped by yt-dlp
 * with a warning nobody reads.
 */
export function parseCookies(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) throw refuse('That file is empty.');
  if (/^\s*[[{]/.test(raw)) {
    throw refuse('That is a JSON export. Export the cookies as cookies.txt (the Netscape format) instead - '
      + '"Get cookies.txt LOCALLY" does by default.');
  }
  const cookies = [];
  const lines = raw.replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((line, i) => {
    let l = line;
    if (l.startsWith('#HttpOnly_')) l = l.slice('#HttpOnly_'.length);
    else if (l.startsWith('#') || !l.trim()) return;
    const f = l.split('\t');
    if (f.length !== 7) throw refuse(`Line ${i + 1} is not a cookie: a cookies.txt line has seven fields separated by tabs. Export the file again, as cookies.txt.`);
    const [domain, , , , expires, name] = f;
    if (!/^\d*$/.test(expires)) throw refuse(`Line ${i + 1} has an expiry that is not a number of seconds.`);
    cookies.push({ domain: domain.toLowerCase(), name, expires: Number(expires) || 0 });
  });
  if (!cookies.length) throw refuse('There are no cookies in that file.');
  return cookies;
}

/** What may be said about a set of cookies: never a name's value. */
export function summarize(cookies, now = Date.now()) {
  const on = (d, site) => d === site || d === `.${site}` || d.endsWith(`.${site}`);
  const yt = cookies.filter((c) => on(c.domain, 'youtube.com'));
  const login = yt.filter((c) => LOGIN.has(c.name));
  // When it stops working: the first sign-in cookie to expire, or failing
  // those the first of youtube.com's, or of any. A session cookie (0) has
  // no date.
  const pick = [login, yt, cookies].find((set) => set.some((c) => c.expires > 0)) ?? [];
  const first = Math.min(...pick.filter((c) => c.expires > 0).map((c) => c.expires * 1000));
  return {
    count: cookies.length,
    youtube: yt.length > 0,
    signedIn: login.length > 0,
    expires: Number.isFinite(first) ? first : null,
    expired: Number.isFinite(first) && first <= now,
  };
}

/** The upload's own line in the file: who and when, nothing else. */
function readMeta(text) {
  const line = String(text).split(/\r?\n/).find((l) => l.startsWith(META));
  if (!line) return {};
  try {
    const m = JSON.parse(line.slice(META.length));
    return { at: Number(m.at) || null, by: m.by ? String(m.by).slice(0, 64) : null };
  } catch { return {}; }
}

/**
 * What the panel may know about the stored cookies, or { set: false }. Read
 * from the file every time, so a file restored from the sealed backup, or
 * removed by hand, is described as it is.
 */
export function describeCookies(dataDir, { now = Date.now() } = {}) {
  let text;
  try { text = fs.readFileSync(cookiesPath(dataDir), 'utf8'); } catch { return { set: false }; }
  const meta = readMeta(text);
  let summary;
  try { summary = summarize(parseCookies(text), now); } catch (err) {
    return { set: true, uploadedAt: meta.at ?? null, by: meta.by ?? null, problem: err.message };
  }
  return { set: true, uploadedAt: meta.at ?? null, by: meta.by ?? null, ...summary };
}

/**
 * Keep an uploaded cookies.txt: checked, written whole or not at all with
 * mode 0600, the uploader recorded in its own comment line. Returns what
 * describeCookies would say of it.
 */
export function saveCookies(dataDir, text, { by, now = Date.now() } = {}) {
  const raw = String(text ?? '');
  if (Buffer.byteLength(raw) > MAX_COOKIE_BYTES) throw refuse(`That file is over ${MAX_COOKIE_BYTES / 1024} KB: it is not a cookies.txt.`);
  const cookies = parseCookies(raw);
  const body = raw.replace(/^﻿/, '').split(/\r?\n/)
    .filter((l) => !/^#\s*(Netscape )?HTTP Cookie File/i.test(l) && !l.startsWith(META));
  // The header first, as yt-dlp's cookie jar wants it, then ours.
  const out = [HEADER, `${META} ${JSON.stringify({ at: now, by: String(by ?? '?').slice(0, 64) })}`, ...body].join('\n')
    .replace(/\n*$/, '\n');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = cookiesPath(dataDir);
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, out, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  fs.chmodSync(file, 0o600);
  return { set: true, uploadedAt: now, by: String(by ?? '?').slice(0, 64), ...summarize(cookies, now) };
}

/** Forget the cookies. True when there were some. */
export function removeCookies(dataDir) {
  const file = cookiesPath(dataDir);
  const had = fs.existsSync(file);
  fs.rmSync(file, { force: true });
  return had;
}

/**
 * Run `fn(copyPath | null)` with a copy of the cookies made for it, deleted
 * after, however it ends. yt-dlp rewrites the cookie file it is given, and
 * two runs at once would each rewrite the one file; the kept one is never
 * handed to it. A copy a killed process left behind is cleared by the next
 * run once it is an hour old.
 */
export async function withCookieCopy(dataDir, fn) {
  if (!dataDir) return fn(null);
  const src = cookiesPath(dataDir);
  if (!fs.existsSync(src)) return fn(null);
  const dir = path.join(dataDir, COPIES_DIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* not ours to change: the copy is 0600 anyway */ }
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    try { if (Date.now() - fs.statSync(p).mtimeMs > 3600_000) fs.rmSync(p, { force: true }); } catch { /* gone */ }
  }
  const copy = path.join(dir, `cookies-${crypto.randomBytes(6).toString('hex')}.txt`);
  fs.copyFileSync(src, copy);
  fs.chmodSync(copy, 0o600);
  try {
    return await fn(copy);
  } finally {
    fs.rmSync(copy, { force: true });
  }
}
