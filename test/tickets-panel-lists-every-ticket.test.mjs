/* Every ticket that gets opened is in the panel's Tickets tab, to resolve or
   reopen. Run: node test/tickets-panel-lists-every-ticket.test.mjs

   The operator, 2026-10-23: "make a section in panel kinda like a ticketing
   system, for all the issue tickets that get opened". Member #issues and the
   agent's tickets share one counter, so one number is one ticket. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listTickets, setTicketStatus } from '../src/core/tickets.js';
import { LibraryNews } from '../src/core/library-news.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const DISCUSSIONS = '120363900000000002@g.us';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-'));
const mem = new Map();
const stateStore = { namespace: (ns) => ({ get: (k, d) => (mem.has(`${ns}:${k}`) ? mem.get(`${ns}:${k}`) : d), set: (k, v) => mem.set(`${ns}:${k}`, v), push() {} }) };
let t = Date.parse('2026-10-23T12:00:00Z');
const news = new LibraryNews({ dataDir, configStore: { get: () => ({ libraryNews: { senders: ['15558100180'], groups: [DISCUSSIONS] } }) }, groupName: () => '06 MOVIE DISCUSSIONS', now: () => t });
let n = 0;
const msg = (text, extra = {}) => ({ id: `T${++n}`, isGroup: true, fromMe: false, chatJid: DISCUSSIONS, senderNumber: '15551230000', pushName: 'Ari', text, timestamp: t, ...extra });

news.record(msg('#issue Daniel Sloss S01E01 will not open'));
t += 60_000;
news.record(msg('chatting', { id: 'C1' }));
t += 60_000;
const second = news.record(msg('#issue #group04 subtitles out of sync', { senderNumber: '15558100180', pushName: 'Head Admin' }));
news.record({ id: 'E1', isGroup: true, fromMe: false, chatJid: DISCUSSIONS, senderNumber: '15558100180', pushName: 'Head Admin', text: '', timestamp: t, edit: { targetId: second.id, text: '#issue #group04 subtitles out of sync in every file' } });
stateStore.namespace('agent-tickets').set('list', [{ n: 3, at: t + 1000, summary: 'Dune S01E02 is missing from the server', group: DISCUSSIONS, who: 'Hank', question: 'why does Dune not play?' }]);

console.log('=== one list, both kinds, newest number first ===');
{
  const list = listTickets({ dataDir, stateStore });
  ok(list.map((x) => x.n).join() === '3,2,1', `numbers 3, 2, 1 (${list.map((x) => x.n)})`);
  ok(list.find((x) => x.n === 1).source === 'member' && list.find((x) => x.n === 3).source === 'agent', 'with their sources');
  ok(list.every((x) => x.status === 'open'), 'all open to begin with');
  ok(list.find((x) => x.n === 2).text === 'subtitles out of sync in every file' || /out of sync/.test(list.find((x) => x.n === 2).text), 'an edited #issue is one ticket, saying what it says now');
  ok(list.find((x) => x.n === 2).keeper === true, 'a keeper\'s #issue is marked');
  ok(!list.some((x) => /^chatting$/.test(x.text)), 'chat is not a ticket');
  ok(list.find((x) => x.n === 3).question === 'why does Dune not play?', 'the agent\'s ticket keeps the question that led to it');
}

console.log('=== resolve and reopen ===');
{
  const r = setTicketStatus({ dataDir, stateStore, now: () => 5000 }, 1, { status: 'resolved', by: 'admin', note: 'Re-posted, opens now' });
  ok(r?.status === 'resolved' && r.by === 'admin', 'resolved, with who');
  const one = listTickets({ dataDir, stateStore }).find((x) => x.n === 1);
  ok(one.status === 'resolved' && one.note === 'Re-posted, opens now' && one.resolvedBy === 'admin' && one.resolvedAt === 5000, 'the list shows it, its note and who resolved it');
  ok(listTickets({ dataDir, stateStore }).filter((x) => x.status === 'open').length === 2, 'two are still open');
  setTicketStatus({ dataDir, stateStore }, 1, { status: 'open' });
  ok(listTickets({ dataDir, stateStore }).find((x) => x.n === 1).status === 'open', 'reopened');
}

console.log('=== a number no ticket has is refused ===');
{
  ok(setTicketStatus({ dataDir, stateStore }, 99, { status: 'resolved' }) === null, 'unknown number');
  ok(setTicketStatus({ dataDir, stateStore }, 'abc', { status: 'resolved' }) === null, 'not a number');
  ok(setTicketStatus({ dataDir, stateStore }, 1, { status: 'deleted' }) === null, 'only resolved or open');
}

console.log('=== the panel has it ===');
{
  const root = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  ok(/data-tab="tickets"/.test(root('src/web/public/index.html')) && /id="tab-tickets"/.test(root('src/web/public/index.html')), 'a Tickets tab');
  const api = root('src/web/api.js');
  ok(/router\.get\('\/tickets', guard/.test(api) && /router\.post\('\/tickets\/:n\/status', guard/.test(api), 'both routes need a login');
  ok(/audit\(req, `\$\{status === 'resolved' \? 'resolved' : 'reopened'\} ticket #/.test(api), 'and resolving is in the audit log');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
