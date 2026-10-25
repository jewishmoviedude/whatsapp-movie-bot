/* What the library's keepers say is kept, and the hourly check follows it up.
   Run: node test/library-news.test.mjs

   The operator, 2026-10-09: "keep tabs on what head admin 5558100180 says on
   discussions group for when issues are fixed so you're aware". She says in
   the discussions group when a title is added or fixed, and the bot kept
   only that she had posted, never what she said, so nothing could follow a
   fix up. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LibraryNews, readLibraryNews, newsSettings, newsFile, KEEP_DAYS, groupRefOf } from '../src/core/library-news.js';
import { scan, headline } from '../src/core/incident-scan.js';
import { DEFAULT_CONFIG as DEFAULTS } from '../src/config/schema.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const DISCUSSIONS = '120363900000000002@g.us';
const REQUESTS = '120363900000000003@g.us';
const HEAD = '15558100180';
const HOUR = 3600_000, DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-09T18:00:00Z');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'library-news-'));
let config = { libraryNews: { senders: ['+1 (555) 810-0180'], groups: [DISCUSSIONS] } };
let t = NOW - 30 * 60_000;
const news = new LibraryNews({ dataDir, configStore: { get: () => config }, groupName: (j) => (j === DISCUSSIONS ? '06 MOVIE DISCUSSIONS' : null), now: () => t });
const msg = (o) => ({
  id: `M${Math.random().toString(36).slice(2, 8)}`, isGroup: true, fromMe: false, chatJid: DISCUSSIONS,
  senderNumber: HEAD, pushName: 'Head Admin', text: 'hello', timestamp: t, ...o,
});

console.log('=== the setting ===');
ok(Array.isArray(DEFAULTS?.libraryNews?.senders) && DEFAULTS.libraryNews.senders.length === 0
  && Array.isArray(DEFAULTS.libraryNews.groups) && DEFAULTS.libraryNews.groups.length === 0, 'empty by default: nobody is watched');
const st = newsSettings(config);
ok(st.senders.has(HEAD) && st.groups.has(DISCUSSIONS), 'a number written any way is its digits');

console.log('=== what is kept ===');
ok(news.record(msg({ text: 'Frieren is fixed, all episodes renamed ✅' }))?.text.startsWith('Frieren'), 'her message in the discussions group is kept');
ok(news.record(msg({ chatJid: REQUESTS, text: 'fixed' })) === null, 'not in another group');
ok(news.record(msg({ senderNumber: '15558160178', pushName: 'Ari', text: 'anyone watch the bear?' }))?.kind === 'chat',
  'anyone else\'s message there is kept too, as chat: the operator, "you should still take a look at the random messages"');
ok(news.record(msg({ fromMe: true, text: 'fixed' })) === null, 'not the bot\'s own');
ok(news.record(msg({ text: '' })) === null, 'not an empty message (a sticker, a deletion)');
ok(news.record(msg({ text: 'lol', reaction: { emoji: '😂' } })) === null, 'not a reaction');
t += 60_000;
news.record(msg({ text: 'anyone seen the new dune trailer?' }));
const rows = readLibraryNews(dataDir).filter((r) => r.kind === 'news');
ok(rows.length === 2 && rows[0].groupName === '06 MOVIE DISCUSSIONS' && rows[0].name === 'Head Admin' && rows[0].sender === HEAD,
  `two rows, with who and where (${rows.length})`);

config = { libraryNews: { senders: [], groups: [DISCUSSIONS] } };
ok(news.record(msg({ text: 'fixed' }))?.kind === 'chat', 'with nobody watched, her message is chat like anyone\'s');
config = { libraryNews: { senders: [HEAD], groups: [] } };
ok(news.record(msg({ text: 'fixed' })) === null, 'and with no group watched, nothing is kept');
config = { libraryNews: { senders: [HEAD], groups: [DISCUSSIONS] } };

console.log('=== kept 90 days ===');
{
  const old = { at: NOW - (KEEP_DAYS + 1) * DAY, id: 'OLD', group: DISCUSSIONS, sender: HEAD, text: 'ancient' };
  fs.writeFileSync(newsFile(dataDir), `${JSON.stringify(old)}\n${fs.readFileSync(newsFile(dataDir), 'utf8')}`);
  t += DAY;
  news.record(msg({ text: 'added season 2 of the bear' }));
  const after = readLibraryNews(dataDir);
  ok(!after.some((r) => r.id === 'OLD') && after.length === 5, `older than ${KEEP_DAYS} days is dropped (${after.length} left)`);
}

console.log('=== the hourly check ===');
{
  const config2 = {
    movieRequests: { requestGroups: [], requirePrefix: true, prefix: '#request', notify: {} },
    tvRequests: { enabled: true, requestGroups: [REQUESTS], postsGroups: [], requirePrefix: true, prefix: '#request' },
    beta: { groups: [], features: {} }, media: {},
  };
  const state = {
    'movie-requests': { history: [], pending: [] }, 'tv-requests': { history: [], pending: [], 'library-misses': [] },
    'msg-index': { entries: [] }, audit: { events: [] },
  };
  const at = (m) => NOW - m * 60_000;
  const items = [
    { at: at(40), id: 'A', group: DISCUSSIONS, groupName: '06 MOVIE DISCUSSIONS', sender: HEAD, name: 'Head Admin', text: 'Frieren is fixed, all the episodes renamed' },
    { at: at(30), id: 'B', group: DISCUSSIONS, groupName: '06 MOVIE DISCUSSIONS', sender: HEAD, name: 'Head Admin', text: 'anyone seen the new dune trailer?' },
    { at: at(90), id: 'C', group: DISCUSSIONS, groupName: '06 MOVIE DISCUSSIONS', sender: HEAD, name: 'Head Admin', text: 'added X2 back' },
  ];
  const r = scan({ now: NOW, config: config2, names: {}, unit: { ActiveState: 'active', NRestarts: '0' }, state,
    memory: { v: 1, lastScanAt: NOW - HOUR, seen: {}, configCheckedAt: NOW }, news: items });
  const inc = r.incidents.filter((f) => f.kind === 'library-news');
  const note = r.notices.filter((f) => f.kind === 'library-news');
  ok(inc.length === 1 && /Head Admin said in "06 MOVIE DISCUSSIONS" that something in the library was fixed or added/.test(inc[0].title),
    `a fix she announced is an incident, researched: ${inc[0]?.title}`);
  ok(inc[0]?.messages.length === 1 && /Frieren is fixed/.test(inc[0].messages[0].text), 'with what she wrote, in full');
  ok(!inc[0]?.messages.some((m) => /X2/.test(m.text)), 'and only what is new since the last run');
  ok(/members who asked for it/.test(inc[0]?.remedy ?? ''), 'and what to do: check the library, find who was turned away');
  ok(note.length === 1 && /1 other message/.test(note[0].title) && /dune trailer/.test(note[0].messages.map((m) => m.text).join()),
    'her other messages are read: one notice with the hour\'s chat in full');
  ok(/library update to follow up/.test(headline(r.incidents)), `the headline names it: ${headline(r.incidents)}`);
  const again = scan({ now: NOW + HOUR, config: config2, names: {}, unit: { ActiveState: 'active', NRestarts: '0' }, state, memory: r.memory, news: items });
  ok(!again.incidents.some((f) => f.kind === 'library-news'), 'reported once');
}

console.log('=== a member\'s #issue report ===');
{
  // The operator's announcement in the group, 2026-10-09: "If there's an
  // actual issue with something type #issue #group01 ... and explain in
  // extensive detail" - e.g. "#issue #group01 the file sent for moviename is
  // only 100mb and corrupted".
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issues-'));
  const GROUPS = { 1: { jid: '120363900000000006@g.us', name: '01 MOVIE POSTS ONLY' } };
  const rec = new LibraryNews({ dataDir: dir, configStore: { get: () => config }, groupName: () => '06 MOVIE DISCUSSIONS',
    groupByNumber: (n) => GROUPS[n] ?? null, now: () => NOW - 20 * 60_000 });
  const member = (text, o = {}) => msg({ senderNumber: '15558160178', pushName: 'Ari', text, timestamp: NOW - 20 * 60_000, ...o });

  ok(groupRefOf('#issue #group01 x') === 1 && groupRefOf('#issue #group 4 x') === 4 && groupRefOf('#issue x') === null, '#group01, #group 4, none');
  const r1 = rec.record(member('#issue #group01 the file sent for Dune is only 100mb and corrupted'));
  ok(r1?.kind === 'issue' && r1.refGroup === GROUPS[1].jid && r1.refGroupName === '01 MOVIE POSTS ONLY', 'any member\'s #issue is kept, with the group it names');
  ok(rec.record(member('#ISSUE the subtitles are out of sync on Loki s2e3'))?.kind === 'issue', 'without a group too, in any case');
  ok(rec.record(member('#issue #group09 something', { chatJid: REQUESTS })) === null, 'only in the watched groups');
  ok(rec.record(member('I had an #issue yesterday lol'))?.kind === 'chat', 'a message that only mentions #issue in passing is chat, not a report');
  const r4 = rec.record(member('#issue #group42 nope'));
  ok(r4?.groupRef === 42 && r4.refGroup === null, 'a group number that matches no group is kept as the number');
  ok(rec.record(msg({ text: '#issue #group01 the encode on X2 is green' }))?.kind === 'issue', 'Head Admin\'s own #issue is an issue, not news');

  const r = scan({ now: NOW, config: { movieRequests: { requestGroups: [], notify: {} }, tvRequests: { requestGroups: [] }, beta: { groups: [], features: {} }, media: {} },
    names: {}, unit: { ActiveState: 'active', NRestarts: '0' },
    state: { 'movie-requests': { history: [], pending: [] }, 'tv-requests': { history: [], pending: [], 'library-misses': [] }, 'msg-index': { entries: [] }, audit: { events: [] } },
    memory: { v: 1, lastScanAt: NOW - HOUR, seen: {}, configCheckedAt: NOW }, news: readLibraryNews(dir) });
  const issues = r.incidents.filter((f) => f.kind === 'member-issue');
  ok(issues.filter((f) => f.severity === 'error').length === 4, `each report its own incident, top priority (${issues.length})`);
  const dune = issues.find((f) => /Dune/.test(f.title));
  ok(dune && /^(Ticket #\d+ - )?Ari \(\+1555\*\*\*0178\) reported an issue about "01 MOVIE POSTS ONLY": "the file sent for Dune is only 100mb and corrupted"$/.test(dune.title),
    `named, masked, with the group and what they said: ${dune?.title}`);
  ok(dune?.severity === 'error' && /extensive|as fully as the member described/.test(dune.remedy), 'top priority, with what to do');
  ok(dune && !/15558160178/.test(JSON.stringify(dune)), 'their full number appears nowhere in the finding');
  ok(issues.some((f) => /group 42 \(no group of that number was found\)/.test(f.title)), 'an unknown group number is said as such');
  ok(!r.incidents.some((f) => f.kind === 'library-news' && /#issue #group/.test(f.evidence.join())), 'and none is counted as library news');
  ok(/issues? members? reported|issue a member reported/.test(headline(r.incidents)), `the headline names them: ${headline(r.incidents)}`);
  ok(/`member-issue` is a member's own report/.test(fs.readFileSync(new URL('../deploy/hourly-debug/prompt.md', import.meta.url), 'utf8')),
    'and the research session is told how to work one');
}

console.log('=== the rest of the group: read, a complaint looked into ===');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-'));
  const rec = new LibraryNews({ dataDir: dir, configStore: { get: () => config }, groupName: () => '06 MOVIE DISCUSSIONS', now: () => NOW - 10 * 60_000 });
  const say = (who, number, text) => rec.record(msg({ senderNumber: number, pushName: who, text, timestamp: NOW - 10 * 60_000 }));
  say('David', '17185550199', 'anyone know a good thriller?');
  say('David', '17185550199', 'lol yes');
  say('Rivka', '18455550142', 'the Parent Trap I got last night has no sound');
  say('Ari', '15558160178', '#issue #group03 Loki s2e3 stops after 10 minutes');
  const r = scan({ now: NOW, config: { movieRequests: { requestGroups: [], notify: {} }, tvRequests: { requestGroups: [] }, beta: { groups: [], features: {} }, media: {} },
    names: {}, unit: { ActiveState: 'active', NRestarts: '0' },
    state: { 'movie-requests': { history: [], pending: [] }, 'tv-requests': { history: [], pending: [], 'library-misses': [] }, 'msg-index': { entries: [] }, audit: { events: [] } },
    memory: { v: 1, lastScanAt: NOW - HOUR, seen: {}, configCheckedAt: NOW }, news: readLibraryNews(dir) });
  const prefixed = r.incidents.find((f) => f.kind === 'member-issue' && f.severity === 'error');
  const passing = r.incidents.find((f) => f.kind === 'member-issue' && f.severity === 'unfulfilled');
  ok(/Loki s2e3/.test(prefixed?.title ?? ''), 'the #issue: top priority');
  ok(/^Rivka mentioned a problem in "06 MOVIE DISCUSSIONS", without #issue: "the Parent Trap I got last night has no sound"$/.test(passing?.title ?? ''),
    `a complaint in passing: researched, one level down (${passing?.title})`);
  ok(r.incidents.indexOf(prefixed) < r.incidents.indexOf(passing), 'and the #issue comes first');
  const chat = r.notices.find((f) => /other message/.test(f.title));
  ok(chat && /^2 other messages/.test(chat.title) && chat.messages.length === 2 && chat.messages.every((m) => m.who === 'David'),
    'the rest is one notice, every message in it, to be read');
  ok(!JSON.stringify(r).includes('17185550199') && !JSON.stringify(r).includes('18455550142'), 'no member\'s full number in any of it');
}

console.log('=== wired in ===');
{
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  ok(/bot\.libraryNews\.record\(msg\)/.test(read('src/index.js')) && /groupByNumber: \(n\) =>/.test(read('src/index.js')),
    'every inbound message passes the recorder, which can find a group by its number');
  ok(/news: newsForRun\(s\.dataDir/.test(read('tools/hourly-debug.mjs')) && /readLibraryNews\(dataDir, \{ since, until: t0 \}\)/.test(read('tools/hourly-debug.mjs')),
    'the hourly check reads it (a day back, and further for the row of a request for a check at once)');
  ok(/`library-news` is what the people who look after the library said/.test(read('deploy/hourly-debug/prompt.md')), 'and its research session is told what to do with it');
  ok(/id="card-library-news"/.test(read('src/web/public/index.html')) && /libraryNews: \{ senders, groups \}/.test(read('src/web/public/app.js')),
    'the panel sets who and where (Settings → Library & files)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
