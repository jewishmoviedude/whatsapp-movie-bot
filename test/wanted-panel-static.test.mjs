/* The Wanted card, checked without a DOM. Run: node test/wanted-panel-static.test.mjs

   The operator, 2026-10-11, at the Wanted list: "give me a mark as resolved
   so other admins and you know as well as a box to add notes for you to
   review on the hour". test/wanted-panel.test.mjs runs the card in linkedom,
   a devDependency a production install does not have; this suite reads the
   files instead, so the wiring is checked on every box:
   - the markup has the card, its Resolved section and every element the
     card's script (src/web/public/wanted.js) looks for, and loads that
     script after app.js, whose helpers it uses;
   - the script keeps to itself (one IIFE: the panel's scripts share one
     global scope), calls each route with the key URL-encoded, rechecks the
     library before Refresh reloads, and shows times only through
     fmtDateTime, the 24-hour clock;
   - app.js hands it the server's 'wanted' push, and server.js sends one on
     every change to the list;
   - the CSV carries the resolutions and the notes;
   - the routes are behind the sign-in guard.

   And from the same day, the arrival re-runs (src/core/wanted-arrival.js):
   the card has the wanted.rerunOnArrival switch and "Re-run requests" on a
   resolved film, each calling its own guarded route. */
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const html = read('src/web/public/index.html');
const card = read('src/web/public/wanted.js');
const app = read('src/web/public/app.js');
const csv = read('src/web/public/csv-export.js');
const server = read('src/web/server.js');
const api = read('src/web/api.js');

console.log('=== the markup ===');
{
  const start = html.indexOf('id="card-wanted"');
  const markup = html.slice(start, html.indexOf('</section>', start));
  ok(start > html.indexOf('id="tab-history"') && start < html.indexOf('id="tab-members"'), 'the card is on the History tab');
  for (const id of ['wanted-list', 'wanted-status', 'btn-wanted-refresh', 'btn-wanted-clear', 'wanted-resolved-box', 'wanted-resolved-count', 'wanted-resolved',
    'wanted-rerun-on-arrival']) {
    ok(new RegExp(`id="${id}"`).test(markup), `#${id} is in it`);
  }
  ok(/<details id="wanted-resolved-box"[^>]*class="[^"]*\bhidden\b/.test(markup) && !/<details id="wanted-resolved-box"[^>]*\bopen\b/.test(markup),
    'Resolved is a collapsed section, hidden until something is resolved');
  ok(/Mark resolved/.test(markup) && /hourly check/.test(markup), 'the hint says what Mark resolved and a note are for');
  const scripts = [...html.matchAll(/<script src="\/([\w.-]+)"/g)].map((m) => m[1]);
  ok(scripts.indexOf('wanted.js') > scripts.indexOf('app.js') && scripts.indexOf('app.js') >= 0, `wanted.js loads after app.js (${scripts.join(', ')})`);
  const ids = new Set([...card.matchAll(/\$\('([\w-]+)'\)|getElementById\('([\w-]+)'\)/g)].map((m) => m[1] ?? m[2]));
  const missing = [...ids].filter((id) => !new RegExp(`id="${id}"`).test(html));
  ok(ids.size >= 7 && missing.length === 0, `every element the script looks for is in index.html${missing.length ? ` - missing ${missing.join(', ')}` : ''}`);
}

console.log('=== the card\'s script ===');
{
  const code = card.replace(/^\/\*[\s\S]*?\*\/\s*/, '');
  ok(/^\(function wantedCard\(\) \{/.test(code) && /\}\(\)\);\s*$/.test(code), 'one IIFE: nothing it declares can clash with app.js');
  ok(/const k = encodeURIComponent\(key\)/.test(card), 'the key is URL-encoded (an IMDb id, or "title|year")');
  ok(/api\('POST', `\/wanted\/\$\{k\}\/resolve`\)/.test(card), 'Mark resolved: POST /wanted/:key/resolve');
  ok(/api\('POST', `\/wanted\/\$\{k\}\/reopen`\)/.test(card), 'Reopen: POST /wanted/:key/reopen');
  ok(/api\('POST', `\/wanted\/\$\{k\}\/notes`, \{ text \}\)/.test(card), 'Save: POST /wanted/:key/notes {text}');
  ok(/api\('DELETE', `\/wanted\/\$\{k\}\/notes\/\$\{encodeURIComponent\(id\)\}`\)/.test(card), 'Delete: DELETE /wanted/:key/notes/:noteId');
  const refresh = card.slice(card.indexOf('async function refresh()'), card.indexOf('card.addEventListener'));
  ok(refresh.indexOf("api('POST', '/wanted/recheck')") > 0 && refresh.indexOf('await load()') > refresh.indexOf("api('POST', '/wanted/recheck')"),
    'Refresh rechecks the library first, then reloads');
  ok(/\$\('btn-wanted-refresh'\)\?\.addEventListener\('click', refresh\)/.test(card), 'and the button is Refresh');
  ok(/fmtDateTime\(n\.at\)/.test(card) && /fmtDateTime\(w\.resolved\.at\)/.test(card), 'a note\'s time and a resolution\'s through fmtDateTime');
  ok(!/toLocale(?:Date|Time)?String|hour12/.test(card), 'and no time formatted any other way - the 24-hour clock');
  ok(/maxlength="\$\{MAX_NOTE\}"/.test(card) && /const MAX_NOTE = 2000;/.test(card), 'the notes box holds 2000 characters, as the server does');
  ok(/drafts\.set\(key, e\.target\.value\)/.test(card) && /drafts\.get\(w\.key\)/.test(card), 'what is being typed survives a reload');
  ok(/role === 'superadmin'/.test(card), 'Delete shows on every note for the super-admin');
}

console.log('=== pushed to every open panel ===');
{
  ok(/es\.addEventListener\('wanted', \(\) => window\.__wanted\?\.changed\(\)\)/.test(app), 'app.js hands the \'wanted\' push to the card');
  ok(/window\.__wanted\?\.load\(\)/.test(app.slice(app.indexOf('async function enterApp()'), app.indexOf('async function enterApp()') + 1200)),
    'and loads it when the panel opens');
  ok(!/\bloadWanted\b/.test(app), 'no second copy of the card left in app.js');
  ok(/import \{ wantedEvents \} from '\.\.\/core\/wanted\.js'/.test(server) && /wantedEvents\.on\('change', onWanted\)/.test(server)
    && /wantedEvents\.off\('change', onWanted\)/.test(server) && /send\('wanted', ev\)/.test(server),
    'server.js sends every change as \'wanted\', and lets go when the page closes');
}

console.log('=== the CSV, and the routes ===');
{
  const fn = csv.slice(csv.indexOf('async function exportWanted()'), csv.indexOf('async function exportTransfers()'));
  ok(/'Resolved', 'Resolved by', 'Resolved at', 'Notes'/.test(fn), 'the CSV has Resolved, Resolved by, Resolved at and Notes');
  ok(/\[\.\.\.asList\(d\?\.wanted\), \.\.\.asList\(d\?\.resolved\)\]/.test(fn), 'and a row for every film, open and resolved');
  for (const [method, route] of [['post', '/wanted/:key/resolve'], ['post', '/wanted/:key/reopen'], ['post', '/wanted/:key/notes'], ['delete', '/wanted/:key/notes/:noteId'],
    ['post', '/wanted/:key/rerun'], ['post', '/wanted/settings']]) {
    ok(api.includes(`router.${method}('${route}', guard,`), `${method.toUpperCase()} /api${route} is behind the sign-in guard`);
  }
  ok(/api\('POST', `\/wanted\/\$\{k\}\/rerun`\)/.test(card), 'Re-run requests: POST /wanted/:key/rerun');
  ok(/api\('POST', '\/wanted\/settings', \{ rerunOnArrival: on \}\)/.test(card), 'the switch: POST /wanted/settings {rerunOnArrival}');
  ok(/data-wanted="rerun"/.test(card) && /w\.resolved\s*\n?\s*\? '<button class="btn small" data-wanted="rerun"/.test(card),
    'Re-run requests is on a resolved film only');
  ok(/fmtDateTime\(r\.at\)/.test(card) && /fmtDateTime\(a\.at\)/.test(card), 'a re-run\'s time and an announcement\'s through fmtDateTime');
}

// Review of the arrival re-runs (2026-10-11): a member whose film was posted
// since with another request is marked done, not posted to twice
// ('already-posted'); one a stopped batch left is 'waiting' for the next
// pass; and an admin's unfinished re-run shows on its card. The card's own
// rerunHtml, run here on its own (the full card needs linkedom).
console.log('=== what each re-run came to, in a word ===');
{
  const start = card.indexOf('  const ON_ITS_WAY');
  const end = card.indexOf('\n  }\n', card.indexOf('function rerunHtml(r)')) + 4;
  const rerunHtml = new Function('esc', 'phoneOut', 'fmtDateTime', `${card.slice(start, end)}\nreturn rerunHtml;`)(
    (s) => String(s), (s) => s, () => '11/10/2026, 15:00');
  const text = (r) => rerunHtml({ at: 1, ...r }).replace(/<[^>]+>/g, '');
  ok(/^Mia: already posted \(posted since it arrived on the server, with ❤️Hannah's request for it\) - marked done ·/.test(
    text({ requester: 'Mia', ran: true, outcome: 'already-posted', detail: 'posted since it arrived on the server, with ❤️Hannah\'s request for it' })),
  'a member answered "posted since" reads as already posted, marked done - not "still to tell"');
  ok(/^❤️Hannah: waiting - stopped: WhatsApp is not connected - re-run at the next pass ·/.test(
    text({ requester: '❤️Hannah', ran: false, outcome: 'waiting', why: 'stopped: WhatsApp is not connected - re-run at the next pass' })),
  'one a stopped batch left reads as waiting, and why');
  ok(/^Aiden: re-run: queued ·/.test(text({ requester: 'Aiden', ran: true, outcome: 'queued' }))
    && /^Dan: re-run: blocked-rating \(rated R\) - still to tell ·/.test(text({ requester: 'Dan', ran: true, outcome: 'blocked-rating', detail: 'rated R' })),
  'the others as before');
  ok(/w\.rerunPending \? `<div class="item-sub wanted-rerun-pending">Re-run requests by \$\{esc\(w\.rerunPending\.by/.test(card)
    && /esc\(fmtDateTime\(w\.rerunPending\.at\)\)/.test(card), 'an admin\'s unfinished re-run shows on its card, its time through fmtDateTime');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
