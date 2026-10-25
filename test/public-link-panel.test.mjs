/* The "Queue a public link" card with a YouTube link, and the cookies in Settings.
   Run: node test/public-link-panel.test.mjs

   2026-10-11: a YouTube link pasted into the card was refused as "a web page
   (text/html)". The card now looks at a link as it is pasted (POST
   /queue/public-link/inspect): a page through yt-dlp, the line under the
   link saying "from YouTube via yt-dlp - 1 h 32 min", and the page's title
   filling the name when none was typed - never over one that was. And
   Settings -> Library & files -> File handling takes the cookies.txt yt-dlp
   signs in to YouTube with, says only what may be said of them, and keeps
   no copy in the page.

   The first half reads index.html and app.js as text, and runs the two
   functions that word the lines, so it runs on a production install. The
   second half runs the card's code from app.js against the real index.html
   in linkedom, with api() stubbed; it needs linkedom, a devDependency, and
   is skipped, with a line saying so, where that is not installed
   (npm install --include=dev). */
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
const start = app.indexOf('/* ---------------------- queue a public link ----------------------- */');
const end = app.indexOf('/* ------------------------------ wanted ----------------------------- */');
const block = app.slice(start, end);
const CLOCK = { hourCycle: 'h23', timeZone: 'UTC' };
const fmtDateTime = (t) => new Date(t).toLocaleString('en-GB', CLOCK);
const fmtBytes = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};

console.log('=== the markup: the card says YouTube, and the cookies sit with the public-link cap ===');
{
  ok(start > 0 && end > start, 'the card\'s code is one block in app.js');
  const card = html.slice(html.indexOf('id="card-public-link"'), html.indexOf('id="card-reactions"'));
  ok(/placeholder="[^"]*YouTube link"/.test(card) && /YouTube page, which yt-dlp reads the video out of/.test(card), 'the card says a YouTube link may be pasted');
  ok(card.indexOf('id="pl-url"') < card.indexOf('id="pl-about"') && card.indexOf('id="pl-about"') < card.indexOf('id="pl-title"'),
    'the line about the link sits under it, above the name');
  const at = (s) => html.indexOf(s);
  ok(at('data-group="library-amp-files"') < at('id="ytdlp-cookies"') && at('id="ytdlp-cookies"') < at('data-group="account"'),
    'the cookies are in Settings -> Library & files');
  ok(at('id="f-maxdownload"') < at('id="ytdlp-cookies"') && at('id="ytdlp-cookies"') < at('id="f-strategy"'),
    'in File handling, right under "Largest public link", the setting it shares');
  const box = html.slice(at('id="ytdlp-cookies"'), at('id="f-strategy"'));
  ok(/Get cookies\.txt LOCALLY/.test(box) && /secondary Google account, never your main one/.test(box) && /never shown again/.test(box),
    'with the one-line how-to, the warning to use a secondary Google account, and that it is never shown again');
  ok(/type="file" id="ytdlp-cookies-file" accept="\.txt,text\/plain"/.test(box) && /id="btn-ytdlp-cookies-upload"/.test(box) && /id="btn-ytdlp-cookies-remove"/.test(box),
    'a file to choose, Upload and Remove');
}

console.log('=== the code: inspect as pasted, fill only an empty name, keep no cookie in the page ===');
{
  ok(/api\('POST', '\/queue\/public-link\/inspect', \{ url \}\)/.test(block), 'the link is looked at through POST /queue/public-link/inspect');
  ok(/if \(r\.title && !\$\('pl-title'\)\.value\.trim\(\)\) \$\('pl-title'\)\.value = r\.title;/.test(block), 'the page\'s title goes in only where no name was typed');
  ok(/input\.value = '';/.test(block) && !/innerHTML[^;]*file\.text|textContent[^;]*file\.text/.test(block), 'the chosen cookies file is cleared, and never shown');
  ok(/api\('GET', '\/yt-dlp'\)/.test(block) && /dataset\.tab === 'settings'/.test(block), 'the yt-dlp line is read when Settings opens');
  ok(!/hour12/.test(block) && /fmtDateTime\(/.test(block), 'times through fmtDateTime: the 24-hour clock');

  const grab = (name) => new RegExp(`^function ${name}\\([\\s\\S]*?^}\\n`, 'm').exec(block)?.[0] ?? '';
  // eslint-disable-next-line no-new-func
  const { describePublicLink, describeYtDlp } = new Function('fmtBytes', 'fmtDateTime',
    `${grab('describePublicLink')}${grab('describeYtDlp')}return { describePublicLink, describeYtDlp };`)(fmtBytes, fmtDateTime);
  const page = describePublicLink({ kind: 'page', site: 'YouTube', length: '1 h 32 min', size: 3_000_000, title: 'The World of Harry Potter Part 3' });
  ok(page.startsWith('from YouTube via yt-dlp - 1 h 32 min') && /about 2\.9 MB/.test(page) && /“The World of Harry Potter Part 3”/.test(page), `a page: "${page}"`);
  ok(describePublicLink({ kind: 'file', size: 3_145_728 }) === 'a video file - 3.0 MB'
    && describePublicLink({ kind: 'file', size: null }) === 'a video file - its size not given by the server', 'a file: its size');

  const at = Date.UTC(2026, 9, 11, 21, 5);
  const d = describeYtDlp({
    installed: true, deno: true, version: '2026.08.19', lastCheck: { at, ok: true },
    cookies: { set: true, uploadedAt: at, by: 'mommy', count: 4, youtube: true, signedIn: true, expires: Date.UTC(2027, 9, 1, 0, 30), expired: false },
  });
  ok(/yt-dlp 2026\.08\.19 is installed, with deno; last update check 11\/10\/2026, 21:05:00/.test(d.tool), `the tool: "${d.tool}"`);
  ok(d.cookies === 'Cookies: set, uploaded 11/10/2026, 21:05:00 by mommy, 4 cookies, youtube.com present: yes, signed in: yes, expires 01/10/2027, 00:30:00.' && !d.warn,
    `the cookies, as the server describes them, 24-hour: "${d.cookies}"`);
  const bad = describeYtDlp({ installed: false, cookies: { set: true, uploadedAt: at, by: 'x', count: 2, youtube: false, expires: null } });
  ok(/not installed on this box: node tools\/routines\.mjs --fix/.test(bad.tool) && /youtube\.com present: no\./.test(bad.cookies) && bad.warn,
    'no yt-dlp, and cookies with no youtube.com in them: both said, in red');
  ok(describeYtDlp({ installed: true, deno: false, cookies: { set: false } }).cookies === 'Cookies: none uploaded - yt-dlp fetches as a visitor.', 'none uploaded');
}

let parseHTML = null;
try { ({ parseHTML } = await import('linkedom')); } catch { /* production install */ }
if (!parseHTML) {
  console.log('=== the card in a page: skipped - linkedom (a devDependency) is not installed ===');
} else {
  console.log('=== the card in a page: pasted, looked at, named, queued ===');
  const win = parseHTML(html);
  const { document } = win;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const calls = [];
  const PAGE = { ok: true, kind: 'page', link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', via: 'yt-dlp', site: 'YouTube',
    title: 'The World of Harry Potter Part 3', duration: 5520, length: '1 h 32 min', size: 3_000_000 };
  const api = async (method, url, body) => {
    calls.push({ method, url, body });
    if (url === '/queue/public-link/inspect') return PAGE;
    if (url === '/queue/public-link') return { ok: true, title: body.title, year: null, via: 'yt-dlp', site: 'YouTube', duration: 5520, length: '1 h 32 min', link: PAGE.link };
    if (method === 'GET' && url === '/yt-dlp') {
      return { installed: true, deno: true, version: '2026.08.19', lastCheck: { at: Date.UTC(2026, 9, 11, 21, 5), ok: true },
        cookies: { set: true, uploadedAt: Date.UTC(2026, 9, 11, 21, 6), by: 'mommy', count: 4, youtube: true, signedIn: true, expires: null } };
    }
    if (method === 'PUT' && url === '/yt-dlp/cookies') return { ok: true, cookies: { set: true, count: 4, youtube: true, signedIn: true } };
    return { ok: true };
  };
  const timers = [];
  // eslint-disable-next-line no-new-func
  const h = new Function('$', 'esc', 'api', 'document', 'confirm', 'fmtDateTime', 'fmtBytes', 'memberKeyFrom', 'CURRENT_USER',
    'setTimeout', 'clearTimeout', `${block}\nreturn { loadYtDlp, inspectPublicLink };`)(
    $, esc, api, document, () => true, fmtDateTime, fmtBytes, async () => '', { username: 'mommy' },
    (fn) => { timers.push(fn); return timers.length; }, () => {});
  const settle = () => new Promise((r) => setTimeout(r, 10));
  const fire = (id, type) => $(id).dispatchEvent(new win.Event(type));

  $('pl-url').value = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=TRACKER';
  fire('pl-url', 'change');
  await settle();
  ok(calls.at(-1)?.url === '/queue/public-link/inspect' && calls.at(-1).body.url === $('pl-url').value, 'pasting it asks the server about it');
  ok($('pl-about').textContent === 'from YouTube via yt-dlp - 1 h 32 min · about 2.9 MB · “The World of Harry Potter Part 3”',
    `the line under it: "${$('pl-about').textContent}"`);
  ok($('pl-title').value === 'The World of Harry Potter Part 3', 'and the empty name is filled from the page');

  fire('btn-pl-queue', 'click');
  await settle();
  const q = calls.find((c) => c.url === '/queue/public-link');
  ok(q?.body.title === 'The World of Harry Potter Part 3' && q.body.url.includes('v=dQw4w9WgXcQ'), 'Queue sends the link and the name');
  ok($('pl-note').textContent === 'Queued: The World of Harry Potter Part 3 - from YouTube via yt-dlp - 1 h 32 min', `the answer: "${$('pl-note').textContent}"`);
  ok(!$('pl-url').value && !$('pl-title').value && !$('pl-about').textContent, 'and the link, the name and the line are cleared');

  // A name typed first stays as typed.
  calls.length = 0;
  $('pl-title').value = 'the world of harry potter part 3';
  $('pl-url').value = 'https://youtu.be/dQw4w9WgXcQ';
  fire('pl-url', 'input');
  ok(timers.length === 1 && !calls.length, 'typing waits a moment before asking');
  await timers.pop()();
  ok(calls.length === 1 && $('pl-title').value === 'the world of harry potter part 3', 'a name the admin typed is never replaced');
  fire('pl-url', 'change');
  await settle();
  ok(calls.length === 1, 'and the same link is not asked about twice');

  // Queue with no name: looked at, named, and left for the admin to check.
  calls.length = 0;
  $('pl-title').value = '';
  $('pl-url').value = 'https://www.youtube.com/watch?v=other1234';
  fire('btn-pl-queue', 'click');
  await settle();
  ok(calls.map((c) => c.url).join() === '/queue/public-link/inspect' && $('pl-title').value === 'The World of Harry Potter Part 3'
    && $('pl-note').textContent === 'Named from the page - check the name, then press Queue.', 'Queue with no name names it from the page, and queues nothing yet');

  console.log('=== Settings: the yt-dlp line, and a cookies upload that leaves nothing in the page ===');
  await h.loadYtDlp();
  ok(/yt-dlp 2026\.08\.19 is installed, with deno/.test($('ytdlp-status').textContent)
    && /Cookies: set, uploaded 11\/10\/2026, 21:06:00 by mommy, 4 cookies, youtube\.com present: yes, signed in: yes\./.test($('ytdlp-status').textContent),
  `the line: "${$('ytdlp-status').textContent}"`);
  calls.length = 0;
  fire('btn-ytdlp-cookies-upload', 'click');
  await settle();
  ok(/Choose the cookies\.txt file first/.test($('ytdlp-note').textContent) && !calls.length, 'no file chosen: says so, sends nothing');
  const file = { size: 120, text: async () => '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tvalue' };
  Object.defineProperty($('ytdlp-cookies-file'), 'files', { value: [file], configurable: true });
  fire('btn-ytdlp-cookies-upload', 'click');
  await settle();
  const put = calls.find((c) => c.method === 'PUT');
  ok(put?.url === '/yt-dlp/cookies' && /SID\tvalue/.test(put.body.text), 'the file\'s text goes to PUT /yt-dlp/cookies');
  ok($('ytdlp-note').textContent === 'Saved: 4 cookies, signed in to YouTube.' && !document.body.innerHTML.includes('SID\tvalue'),
    `"${$('ytdlp-note').textContent}", and not a byte of the file is in the page`);
  ok(calls.some((c) => c.method === 'GET' && c.url === '/yt-dlp'), 'and the line is read again');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
