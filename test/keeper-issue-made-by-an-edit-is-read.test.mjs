/* A message edited into an #issue is one, and details added to an #issue by
   an edit reach the check. Run: node test/keeper-issue-made-by-an-edit-is-read.test.mjs

   Found in review, 2026-10-12, of the operator's request that day: "Needless
   to say #issue tickets submitted by head admin 5558100180 get top priority"
   and "Meaning it should activate bot to send yo a notification to check
   right away". WhatsApp sends an edit as a protocolMessage of type
   MESSAGE_EDIT (its apps wrap it in editedMessage), and Baileys 6.7.x hands
   the new text on only as 'messages.update', which the bot does not listen
   to. normalize() read no text from it, so library-news never saw it: Head
   Admin's "Frieren e12 is missing", edited within WhatsApp's window to
   "#issue Frieren e12 is missing", wrote no row, asked for no check, and was
   no TOP PRIORITY finding; and details she added to an #issue by an edit
   never reached the research. What must hold:
   - normalize() says which message an edit changes and what it says now,
     and keeps the edit's own text empty, so no plugin takes it for a new
     request;
   - library-news keeps the edit as a row of its own, under the edit's id,
     `edits` naming the message, its kind by what it says now - and a
     keeper's edit into an #issue asks for the check at once, an ask the
     check's own test (keeperIssueTest) finds behind a row;
   - the scan reads it as her #issue, TOP PRIORITY. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WhatsAppBot } from '../src/core/bot.js';
import { LibraryNews, readLibraryNews } from '../src/core/library-news.js';
import { checkNowFile, readCheckNow, keeperIssueTest } from '../src/core/check-now.js';
import { scan } from '../src/core/incident-scan.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'news-edit-'));
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

const DISCUSSIONS = '120363900000000002@g.us';
const HEAD = '15558100180';
const HEAD_LID = '100000000000006@lid';
const NOW = Date.parse('2026-10-12T14:05:00Z');
const config = { libraryNews: { senders: ['+1 (555) 810-0180'], groups: [DISCUSSIONS] } };

const bot = new WhatsAppBot({ configStore: { get: () => ({ whatsapp: {} }) }, dataDir: ROOT });
const key = (id) => ({ remoteJid: DISCUSSIONS, participant: HEAD_LID, participantPn: `${HEAD}@s.whatsapp.net`, id, fromMe: false });
/** What Baileys' messages.upsert carries: a message as sent. */
const sent = (id, text, at = NOW) => ({ key: key(id), messageTimestamp: at / 1000, pushName: 'Head Admin', message: { conversation: text } });
/** And an edit of message `of`, as WhatsApp's apps send it (wrapped in editedMessage), or bare as Baileys sends one. */
const edited = (id, of, content, { at = NOW, bare = false } = {}) => {
  const pm = { key: { remoteJid: DISCUSSIONS, fromMe: false, id: of, participant: HEAD_LID }, type: 14, editedMessage: content, timestampMs: String(at) };
  return {
    key: key(id), messageTimestamp: at / 1000, pushName: 'Head Admin',
    message: bare ? { protocolMessage: pm } : { editedMessage: { message: { protocolMessage: pm } } },
  };
};
const recorder = (dir, now = NOW) => new LibraryNews({ dataDir: dir, configStore: { get: () => config }, groupName: () => '06 MOVIE DISCUSSIONS', now: () => now });

console.log('=== normalize(): an edit says what it changes and what it says now ===');
{
  const m = bot.normalize(edited('EDIT1', 'ORIG1', { extendedTextMessage: { text: '  #issue Frieren e12 is missing ' } }));
  ok(m?.edit?.targetId === 'ORIG1' && m.edit.text === '#issue Frieren e12 is missing', `wrapped in editedMessage, as the apps send it (${JSON.stringify(m?.edit)})`);
  ok(m.text === '', 'its own text stays empty: no plugin takes an edit for a new request');
  ok(m.id === 'EDIT1' && m.senderNumber === HEAD, 'its id is the edit\'s own, its sender the member who edited');
  const bare = bot.normalize(edited('EDIT2', 'ORIG2', { conversation: '#issue X2 is green' }, { bare: true }));
  ok(bare?.edit?.targetId === 'ORIG2' && bare.edit.text === '#issue X2 is green' && bare.text === '', 'bare, as Baileys sends one');
  const caption = bot.normalize(edited('EDIT3', 'ORIG3', { imageMessage: { caption: '#issue this frame is green' } }));
  ok(caption?.edit?.text === '#issue this frame is green', 'a picture\'s caption edited');
  const revoke = bot.normalize({ key: key('DEL1'), messageTimestamp: 1, message: { protocolMessage: { key: { id: 'ORIG4' }, type: 0 } } });
  ok(revoke && !revoke.edit, 'a delete is not an edit');
  const plain = bot.normalize(sent('PLAIN1', '#issue a plain one'));
  ok(plain.text === '#issue a plain one' && !plain.edit, 'and a message as sent is as before');
}

console.log('=== library-news: her message edited into an #issue is one, and asks for the check ===');
{
  const dir = fs.mkdtempSync(path.join(ROOT, 'data-'));
  const news = recorder(dir);
  const first = news.record(bot.normalize(sent('ORIG1', 'Frieren e12 is missing', NOW - 3 * 60_000)));
  ok(first?.kind === 'news' && !fs.existsSync(checkNowFile(dir)), 'as sent, it is news, and asks for nothing');
  const row = news.record(bot.normalize(edited('EDIT1', 'ORIG1', { conversation: '#issue Frieren e12 is missing' })));
  ok(row?.kind === 'issue' && row.keeper === true && row.text === '#issue Frieren e12 is missing',
    `the edit is her #issue, kept as what it says now (${JSON.stringify(row && { kind: row.kind, keeper: row.keeper, text: row.text })})`);
  ok(row.id === 'EDIT1' && row.edits === 'ORIG1' && row.at === NOW, 'a row of its own, under the edit\'s id, naming the message it changed');
  ok(readLibraryNews(dir).length === 2, 'both kept: what she sent, and what she made it');
  const f = readCheckNow(dir);
  ok(f?.asked.length === 1 && f.asked[0].id === 'EDIT1', 'and the bot asks for the check at once');
  const genuine = keeperIssueTest(readLibraryNews(dir), new Set([HEAD]));
  ok(f.asked.every(genuine), 'an ask the check itself finds behind a keeper\'s #issue row, so it runs');

  // The scan's inputs as keeper-issue-scanned-first-as-top-priority.test.mjs gives them.
  const res = scan({
    now: NOW + 5 * 60_000, names: {}, unit: { ActiveState: 'active', NRestarts: '0' },
    config: {
      movieRequests: { requestGroups: [], notify: {} }, tvRequests: { requestGroups: [] }, beta: { groups: [], features: {} }, media: {},
      libraryNews: { senders: [HEAD], groups: [DISCUSSIONS] },
    },
    state: {
      'movie-requests': { history: [], pending: [] }, 'tv-requests': { history: [], pending: [], 'library-misses': [] },
      'msg-index': { entries: [] }, audit: { events: [] },
    },
    memory: { v: 1, lastScanAt: NOW - 60 * 60_000, seen: {}, configCheckedAt: NOW },
    news: readLibraryNews(dir),
  });
  const top = res.incidents[0];
  ok(top?.priority === true && /^(Ticket #\d+ - )?TOP PRIORITY: Head Admin/.test(top.title) && /Frieren e12 is missing/.test(top.title),
    `the scan puts it first, TOP PRIORITY (${top?.title?.slice(0, 90)})`);
}

console.log('=== details added to an #issue by an edit reach the check ===');
{
  const dir = fs.mkdtempSync(path.join(ROOT, 'data-'));
  const news = recorder(dir);
  news.record(bot.normalize(sent('ORIG5', '#issue X2', NOW - 60_000)));
  const more = news.record(bot.normalize(edited('EDIT5', 'ORIG5', { conversation: '#issue X2 is green from the first minute, all of it' })));
  ok(more?.kind === 'issue' && more.edits === 'ORIG5' && /green from the first minute/.test(more.text), 'the edit, with her details, is kept');
  ok(readCheckNow(dir)?.asked.map((a) => a.id).join() === 'ORIG5,EDIT5', 'and asked for with the first, read in the same run');
}

console.log('=== what is not hers, or not there, is as before ===');
{
  const dir = fs.mkdtempSync(path.join(ROOT, 'data-'));
  const news = recorder(dir);
  const other = { ...edited('EDIT6', 'ORIG6', { conversation: '#issue mine' }), pushName: 'Ari', key: { ...key('EDIT6'), participant: '1@lid', participantPn: '15558160178@s.whatsapp.net' } };
  const ari = news.record(bot.normalize(other));
  ok(ari?.kind === 'issue' && !ari.keeper && !fs.existsSync(checkNowFile(dir)), 'another member\'s edit into an #issue is kept, and asks for nothing');
  ok(news.record(bot.normalize(edited('EDIT7', 'ORIG7', { conversation: '' }))) === null, 'an edit that leaves no text is nothing');
  const ours = edited('EDIT8', 'ORIG8', { conversation: '#issue x' });
  ours.key.fromMe = true;
  ok(news.record(bot.normalize(ours)) === null, 'nor an edit of the bot\'s own');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
