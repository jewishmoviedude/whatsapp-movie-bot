/* The cookies yt-dlp signs in to YouTube with: read, kept 0600, described, never echoed.
   Run: node test/yt-dlp-cookies.test.mjs

   2026-10-11, the operator, asking for yt-dlp: "I'll sign in with my gmail if
   needed for cookies". YouTube can refuse a server it does not know ("Sign in
   to confirm you're not a bot") and keeps age-restricted videos for
   signed-in adults, so Settings takes a cookies.txt exported from a browser.
   It is a Google login: kept at one path under data/, mode 0600, carried by
   the sealed backup, and described - how many, youtube.com or not, signed in
   or not, when they expire, who uploaded them and when - but never sent back.
   The upload and removal routes, and their audit rows, are in
   test/public-link-yt-dlp.test.mjs; the backup in test/sealed-backup.test.mjs. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseCookies, summarize, saveCookies, describeCookies, removeCookies, withCookieCopy, cookiesPath, COOKIES_FILE,
} from '../src/media/yt-dlp-cookies.js';
import { APP_BUNDLE_PATHS, isAppBundlePath } from '../src/core/activity-backup.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const attempt = (fn) => { try { return { r: fn() }; } catch (err) { return { err }; } };

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-dlp-cookies-test-'));
process.on('exit', () => fs.rmSync(T, { recursive: true, force: true }));
const NOW = Date.parse('2026-10-11T12:00:00Z');
const SECRET = 'SAPISID-value-do-not-echo';
// As "Get cookies.txt LOCALLY" writes it: CRLF, a BOM, #HttpOnly_ lines.
const EXPORT = [
  '﻿# Netscape HTTP Cookie File', '# http://curl.haxx.se/rfc/cookie_spec.html', '# This is a generated file!  Do not edit.', '',
  `.youtube.com\tTRUE\t/\tTRUE\t1893456000\tSAPISID\t${SECRET}`,
  '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1861920000\t__Secure-3PSID\tpsid-value',
  '.youtube.com\tTRUE\t/\tTRUE\t0\tYSC\tsession-only',
  '.google.com\tTRUE\t/\tTRUE\t1800000000\tNID\tnid-value', '',
].join('\r\n');

console.log('=== a cookies.txt read as yt-dlp reads it ===');
{
  const c = parseCookies(EXPORT);
  ok(c.length === 4 && c.map((x) => x.name).join() === 'SAPISID,__Secure-3PSID,YSC,NID', 'four cookies: comments and blank lines skipped, #HttpOnly_ taken off');
  const s = summarize(c, NOW);
  ok(s.count === 4 && s.youtube && s.signedIn && s.expires === 1861920000 * 1000 && !s.expired,
    `youtube.com, signed in, expiring with its first sign-in cookie, not the session one or google.com's (${JSON.stringify(s)})`);
  const visitor = summarize(parseCookies('.youtube.com\tTRUE\t/\tTRUE\t1790000000\tVISITOR_INFO1_LIVE\tv\n'), NOW);
  ok(visitor.youtube && !visitor.signedIn && visitor.expired, 'a visitor\'s cookies: youtube.com, not signed in - and these have expired');
  for (const [label, text, re] of [
    ['empty', '  \n', /empty/],
    ['a JSON export', '[{"domain":".youtube.com"}]', /JSON export/],
    ['spaces for tabs', '.youtube.com TRUE / TRUE 0 SID x', /Line 1 is not a cookie/],
    ['a date for the expiry', '.youtube.com\tTRUE\t/\tTRUE\t2027-01-01\tSID\tx', /Line 1 has an expiry that is not a number/],
    ['only comments', '# Netscape HTTP Cookie File\n# nothing\n', /no cookies/],
  ]) {
    const { err } = attempt(() => parseCookies(text));
    ok(err?.code === 'COOKIES_REFUSED' && re.test(err.message), `${label}: ${err?.message}`);
  }
}

console.log('=== kept at one path, 0600, the uploader written into it ===');
{
  const data = path.join(T, 'data');
  ok(cookiesPath(data) === path.join(data, 'yt-dlp-cookies.txt') && COOKIES_FILE === 'yt-dlp-cookies.txt', 'data/yt-dlp-cookies.txt');
  const old = process.umask(0o000);
  let d;
  try { d = saveCookies(data, EXPORT, { by: 'mommy', now: NOW }); } finally { process.umask(old); }
  const file = cookiesPath(data);
  ok((fs.statSync(file).mode & 0o777) === 0o600, 'mode 0600, even under a umask that would allow anything');
  ok(fs.readdirSync(data).join() === 'yt-dlp-cookies.txt', 'written whole: no temporary file left beside it');
  const text = fs.readFileSync(file, 'utf8');
  ok(text.startsWith(`# Netscape HTTP Cookie File\n# whatsapp-bot: {"at":${NOW},"by":"mommy"}\n`) && text.split('# Netscape HTTP Cookie File').length === 2,
    'the header yt-dlp wants first, once; who and when next');
  ok(text.includes(SECRET) && !text.includes('\r') && !text.includes('﻿'), 'the cookies themselves, as given');
  ok(!JSON.stringify(d).includes(SECRET) && d.by === 'mommy' && d.uploadedAt === NOW && d.count === 4, `what the upload answers: ${JSON.stringify(d)}`);
  const seen = describeCookies(data, { now: NOW });
  ok(seen.set && seen.by === 'mommy' && seen.uploadedAt === NOW && seen.count === 4 && seen.youtube && seen.signedIn && !JSON.stringify(seen).includes(SECRET),
    'described from the file itself, never a value from it');

  saveCookies(data, EXPORT.replace('mommy', ''), { by: 'david', now: NOW + 1000 });
  const again = fs.readFileSync(file, 'utf8');
  ok(again.match(/# whatsapp-bot:/g).length === 1 && /"by":"david"/.test(again), 'a new upload replaces the old, with one line saying who');

  const big = attempt(() => saveCookies(data, 'x'.repeat(600 * 1024), { by: 'mommy' }));
  ok(big.err?.code === 'COOKIES_REFUSED' && /over 512 KB/.test(big.err.message) && fs.readFileSync(file, 'utf8') === again,
    'a file far too big is refused, and the kept one stays');

  fs.writeFileSync(file, '# Netscape HTTP Cookie File\n# whatsapp-bot: {"at":1,"by":"mommy"}\nbroken line\n', { mode: 0o600 });
  const torn = describeCookies(data);
  ok(torn.set && /Line 3 is not a cookie/.test(torn.problem), 'a file damaged by hand is described as set, and what is wrong with it');

  ok(removeCookies(data) === true && !fs.existsSync(file) && describeCookies(data).set === false, 'removed');
  ok(removeCookies(data) === false, 'removing none says there were none');
}

console.log('=== a copy for each run of yt-dlp, gone after, however the run ends ===');
{
  const data = path.join(T, 'data2');
  saveCookies(data, EXPORT, { by: 'mommy' });
  let seen = null;
  const r = await withCookieCopy(data, async (copy) => { seen = { copy, mode: fs.statSync(copy).mode & 0o777, dir: fs.statSync(path.dirname(copy)).mode & 0o777 }; return 'done'; });
  ok(r === 'done' && seen.mode === 0o600 && seen.dir === 0o700 && path.dirname(seen.copy) === path.join(data, 'yt-dlp-run') && !fs.existsSync(seen.copy),
    'a 0600 copy in a 0700 folder under data/, deleted after');
  let thrown = null;
  try { await withCookieCopy(data, async (copy) => { seen = copy; throw new Error('yt-dlp failed'); }); } catch (err) { thrown = err; }
  ok(thrown?.message === 'yt-dlp failed' && !fs.existsSync(seen), 'deleted after a failure too');
  // One a killed process left behind, an hour old, goes with the next run.
  const stale = path.join(data, 'yt-dlp-run', 'cookies-left-behind.txt');
  fs.writeFileSync(stale, 'x');
  fs.utimesSync(stale, new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000));
  await withCookieCopy(data, async () => {});
  ok(!fs.existsSync(stale), 'a copy a killed run left behind is cleared by the next');
}

console.log('=== carried by the sealed backup ===');
{
  ok(APP_BUNDLE_PATHS.includes('data/yt-dlp-cookies.txt') && isAppBundlePath('data/yt-dlp-cookies.txt'), 'on the app bundle\'s list');
  ok(!isAppBundlePath('data/yt-dlp-run/cookies-1.txt'), 'and the per-run copies are not');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
