/* An #issue written as a reply carries the message it replies to, to the scan.
   Run: node test/issue-written-as-a-reply-is-read-with-it.test.mjs

   Head Admin's "#issue #group04" (2026-10-18 15:45 UTC) was a reply to a
   member's message asking why the bot had said episodes were not in the
   library. The bot kept her two words only, and the hourly check, with
   nothing else to go on, researched The Rookie season 8 and found nothing
   wrong. The operator: "had bot paid attention I was replying to a users
   message above in which he was wondering why bot said certain episodes are
   not in library". Now:
   - normalize() says which message a message replies to, who sent it and
     what it said;
   - library-news keeps that on the row;
   - the scan's #issue names it in its title and first evidence line, from the
     news row of the replied message when there is one. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WhatsAppBot } from '../src/core/bot.js';
import { LibraryNews, readLibraryNews } from '../src/core/library-news.js';
import { scan } from '../src/core/incident-scan.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-reply-'));
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

const DISCUSSIONS = '120363900000000002@g.us';
const HEAD = '15558100180';
const MEMBER = '15558050183';
const NOW = Date.parse('2026-10-18T15:45:00Z');
const config = { libraryNews: { senders: [HEAD], groups: [DISCUSSIONS] } };
const QUESTION = 'why did the bot say georgie and mandy SO1E11-E20 is not in the library? they should exist';

const bot = new WhatsAppBot({ configStore: { get: () => ({ whatsapp: {} }) }, dataDir: ROOT });
const msgOf = (id, sender, name, message, at) => ({
  key: { remoteJid: DISCUSSIONS, participant: `${sender}@s.whatsapp.net`, id, fromMe: false },
  messageTimestamp: at / 1000, pushName: name, message,
});
const question = msgOf('Q1', MEMBER, 'Jake Brown', { conversation: QUESTION }, NOW - 5 * 60_000);
const reply = msgOf('I1', HEAD, 'Head Admin', {
  extendedTextMessage: {
    text: '#issue #group04',
    contextInfo: { stanzaId: 'Q1', participant: `${MEMBER}@s.whatsapp.net`, quotedMessage: { conversation: QUESTION } },
  },
}, NOW);

console.log('=== normalize(): a reply says what it replies to ===');
{
  const m = bot.normalize(reply);
  ok(m.text === '#issue #group04', 'its own text is its own');
  ok(m.replyTo?.id === 'Q1' && m.replyTo.senderNumber === MEMBER && m.replyTo.text === QUESTION, `the message it replies to: ${JSON.stringify(m.replyTo)}`);
  ok(!bot.normalize(question).replyTo, 'a message that replies to nothing has no replyTo');
}

console.log('=== library-news keeps it, and the scan reads the #issue with it ===');
{
  const rec = new LibraryNews({ dataDir: ROOT, configStore: { get: () => config }, groupName: () => '06 MOVIE DISCUSSIONS', now: () => NOW });
  rec.record(bot.normalize(question));
  rec.record(bot.normalize(reply));
  const rows = readLibraryNews(ROOT);
  const issue = rows.find((r) => r.kind === 'issue');
  ok(issue?.replyTo?.id === 'Q1' && issue.replyTo.sender === MEMBER && issue.replyTo.text === QUESTION, 'the #issue row keeps the reply');

  const state = {
    'movie-requests': { history: [], pending: [] }, 'tv-requests': { history: [], pending: [], 'library-misses': [] },
    'msg-index': { entries: [] }, audit: { events: [] },
  };
  const cfg = {
    movieRequests: { requestGroups: [], notify: {} }, tvRequests: { requestGroups: [] }, beta: { groups: [], features: {} }, media: {}, libraryNews: config.libraryNews,
  };
  const r = scan({ now: NOW + 60_000, config: cfg, names: {}, unit: { ActiveState: 'active', NRestarts: '0' }, state, news: rows,
    memory: { v: 1, lastScanAt: NOW - 3600_000, seen: {}, configCheckedAt: NOW } });
  const f = r.incidents.find((x) => x.kind === 'member-issue' && x.report?.text === '#issue #group04');
  ok(/replying to Jake Brown \(\+1555\*+0183\): "why did the bot say georgie/.test(f?.title ?? ''), `the title says what it replies to: ${f?.title}`);
  ok(/the message the #issue replies to/.test(f?.evidence?.[0] ?? '') && f.evidence[0].includes('SO1E11-E20'), 'the first evidence line quotes it');
  ok(f?.report?.replyTo?.text === QUESTION, 'and the report carries it');
  ok(!JSON.stringify(f).includes(MEMBER), 'his full number appears nowhere in it');

  // The replied message older than the news the run was given: what the reply carried.
  const alone = scan({ now: NOW + 60_000, config: cfg, names: {}, unit: { ActiveState: 'active', NRestarts: '0' }, state, news: [issue],
    memory: { v: 1, lastScanAt: NOW - 3600_000, seen: {}, configCheckedAt: NOW } });
  const g = alone.incidents.find((x) => x.kind === 'member-issue');
  ok(/replying to \+1555\*+0183: "why did the bot say/.test(g?.title ?? ''), `without the row, from the reply itself: ${g?.title}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
