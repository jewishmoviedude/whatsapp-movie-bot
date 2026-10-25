/* Every #issue gets a ticket number of its own, and the hourly report says it.
   Run: node test/issue-gets-its-own-ticket.test.mjs

   The operator, 2026-10-22: "start giving each issue it's own ticket number".
   It starts from now: the counter is kept in its own file, not the news file,
   which is pruned after 90 days and would otherwise hand a number out again. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LibraryNews, readLibraryNews } from '../src/core/library-news.js';
import { nextTicket, ticketFile } from '../src/core/issue-tickets.js';
import { scan } from '../src/core/incident-scan.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const DISCUSSIONS = '120363900000000002@g.us';
const HEAD = '15558100180';
const NOW = Date.parse('2026-10-22T10:00:00Z');
const HOUR = 3600_000;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-tickets-'));
const config = { libraryNews: { senders: [HEAD], groups: [DISCUSSIONS] } };
let t = NOW;
const news = new LibraryNews({ dataDir, configStore: { get: () => config }, groupName: () => '06 MOVIE DISCUSSIONS', now: () => t });
let n = 0;
const msg = (text, extra = {}) => ({
  id: `T${++n}`, isGroup: true, fromMe: false, chatJid: DISCUSSIONS, senderNumber: HEAD, pushName: 'Head Admin',
  text, timestamp: t, ...extra,
});

console.log('=== each new #issue gets the next number ===');
{
  const a = news.record(msg('#issue Daniel Sloss S01E01 gives this message'));
  const b = news.record(msg('#issue #group04 the subtitles are out of sync'));
  ok(a?.ticket === 1 && b?.ticket === 2, `1 and 2 (${a?.ticket}, ${b?.ticket})`);
  const chat = news.record(msg('thanks all'));
  ok(chat && chat.ticket === undefined, 'chat gets no ticket');
  const c = news.record(msg('#issue another one'));
  ok(c?.ticket === 3, `the next is 3 after chat (${c?.ticket})`);
}

console.log('=== an edit of an #issue keeps its ticket ===');
{
  const orig = news.record(msg('#issue the trailer is missing'));
  const edit = news.record({ id: 'EDIT1', isGroup: true, fromMe: false, chatJid: DISCUSSIONS, senderNumber: HEAD, pushName: 'Head Admin', text: '', timestamp: t, edit: { targetId: orig.id, text: '#issue the trailer is missing and the sound too' } });
  ok(edit?.ticket === orig.ticket, `the edit is ticket ${orig.ticket}, not a new one (${edit?.ticket})`);
}

console.log('=== the counter survives a restart and a pruned news file ===');
{
  ok(fs.existsSync(ticketFile(dataDir)), 'it is kept in its own file');
  const next = JSON.parse(fs.readFileSync(ticketFile(dataDir), 'utf8')).next;
  const kept = fs.readFileSync(newsFileOf(dataDir), 'utf8');
  fs.writeFileSync(newsFileOf(dataDir), '');
  ok(nextTicket(dataDir) === next, `after the news file is emptied the next ticket is still ${next}`);
  fs.writeFileSync(newsFileOf(dataDir), kept);
}

console.log('=== the hourly report names the ticket ===');
{
  const rows = readLibraryNews(dataDir);
  ok(rows.length > 0, 'the news file is intact for the report');
  const r = scan({ now: NOW + HOUR, config: { movieRequests: { requestGroups: [], notify: {} }, tvRequests: { requestGroups: [] }, beta: { groups: [], features: {} }, media: {}, libraryNews: config.libraryNews }, names: {}, unit: { ActiveState: 'active', NRestarts: '0' }, state: {},
    memory: { v: 1, lastScanAt: NOW, seen: {}, configCheckedAt: NOW + HOUR }, news: rows.map((x) => ({ ...x })) });
  const inc = r.incidents.filter((f) => f.kind === 'member-issue');
  ok(inc.length > 0 && inc.every((f) => /^Ticket #\d+ - /.test(f.title)), `every issue's title starts with its ticket: ${inc.map((f) => f.title.slice(0, 14)).join(' | ')}`);
  ok(inc.some((f) => f.title.startsWith('Ticket #0001 - ')), 'and the first one is Ticket #0001');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

function newsFileOf(dir) { return path.join(dir, 'library-news.jsonl'); }
