/* A library keeper's #issue asks for the hourly check at once; nobody else's
   does. Run: node test/keeper-issue-asks-for-a-check-now.test.mjs

   The operator, 2026-10-12: "Needless to say #issue tickets submitted by
   head admin 5558100180 get top priority" and "Meaning it should activate bot
   to send yo a notification to check right away". Until then her #issue in
   the discussions group waited for the top of the hour like anybody's.

   The bot cannot start the check (its unit's NoNewPrivileges breaks the sudo
   the check restarts it with, and a child of the service dies with it on a
   restart), so it writes data/check-now.json and cron's every-minute tick
   runs the check. What must hold:
   - only a keeper's #issue asks: not another member's #issue, not a plain
     message of hers, not anything outside the watched group;
   - the check waits two minutes after the latest ask, so a ticket written
     over two or three messages is read whole, but never more than ten after
     the first, so a stream of messages cannot put it off;
   - asks pile up in one file, and the bot and the check, writing it at the
     same moment, never lose one another's;
   - a failed ask is a log line, never an error in the message path. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import log from '../src/util/logger.js';
import { LibraryNews, readLibraryNews } from '../src/core/library-news.js';
import {
  checkNowFile, notBeforeOf, askForCheck, takeAsks, checkNowDue, readCheckNow, mergeAsks, askOf, keeperIssueTest,
  SETTLE_MS, MAX_SETTLE_MS, ASK_TEXT_MAX,
} from '../src/core/check-now.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'check-now-'));
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

const DISCUSSIONS = '120363900000000002@g.us';
const REQUESTS = '120363900000000003@g.us';
const HEAD = '15558100180';
const MIN = 60_000;
const NOW = Date.parse('2026-10-12T14:05:00Z');
const lines = [];
log.on('line', (e) => lines.push(`${e.level} ${e.scope}: ${e.msg}`));

const config = { libraryNews: { senders: ['+1 (555) 810-0180'], groups: [DISCUSSIONS] } };
let n = 0;
function recorder(dir) {
  let t = NOW;
  const news = new LibraryNews({ dataDir: dir, configStore: { get: () => config }, groupName: () => '06 MOVIE DISCUSSIONS', now: () => t });
  return { news, at: (ms) => { t = ms; } };
}
const msg = (o) => ({
  id: `3EB0${String(++n).padStart(6, '0')}`, isGroup: true, fromMe: false, chatJid: DISCUSSIONS,
  senderNumber: HEAD, pushName: 'Head Admin', text: 'hello', timestamp: NOW, ...o,
});
const fresh = () => fs.mkdtempSync(path.join(ROOT, 'data-'));
const file = (dir) => (fs.existsSync(checkNowFile(dir)) ? JSON.parse(fs.readFileSync(checkNowFile(dir), 'utf8')) : null);

console.log('=== only a library keeper\'s #issue asks for a check ===');
{
  const dir = fresh();
  const { news } = recorder(dir);
  const ari = news.record(msg({ senderNumber: '15558160178', pushName: 'Ari', text: '#issue #group01 the file sent for Dune is only 100mb' }));
  ok(ari?.kind === 'issue' && !ari.keeper && !fs.existsSync(checkNowFile(dir)), 'another member\'s #issue is kept, and asks for nothing');
  const plain = news.record(msg({ text: 'Frieren is fixed, all episodes renamed ✅' }));
  ok(plain?.kind === 'news' && !plain.keeper && !fs.existsSync(checkNowFile(dir)), 'her plain message is news, and asks for nothing');
  ok(news.record(msg({ chatJid: REQUESTS, text: '#issue the encode on X2 is green' })) === null && !fs.existsSync(checkNowFile(dir)),
    'her #issue outside the watched group is not kept, and asks for nothing');
  ok(news.record(msg({ fromMe: true, text: '#issue x' })) === null && !fs.existsSync(checkNowFile(dir)), 'nor the bot\'s own message');

  lines.length = 0;
  const long = `#issue #group01 the encode on X2 is green from the first minute ${'and stays green '.repeat(40)}`;
  const mom = news.record(msg({ text: long }));
  ok(mom?.kind === 'issue' && mom.keeper === true, 'her #issue is an issue, marked keeper: true');
  ok(readLibraryNews(dir).find((r) => r.id === mom.id)?.keeper === true, 'and so in library-news.jsonl, for the scan');
  const f = file(dir);
  ok(f?.v === 1 && f.asked.length === 1, `the bot asks for a check now: ${checkNowFile(dir)}`);
  const a = f?.asked[0] ?? {};
  ok(a.at === NOW && a.id === mom.id && a.sender === HEAD && a.name === 'Head Admin' && a.group === DISCUSSIONS
    && a.groupName === '06 MOVIE DISCUSSIONS' && a.askedAt === NOW, 'with who, when, where and its id');
  ok(a.text.length === ASK_TEXT_MAX && long.startsWith(a.text), `and the first ${ASK_TEXT_MAX} characters of what she wrote`);
  ok(f.notBefore === NOW + SETTLE_MS, 'due two minutes after it, for the rest of a ticket to arrive');
  ok(lines.filter((l) => /top-priority/.test(l)).length === 1
    && lines.includes('info library-news: 🚩 top-priority #issue from Head Admin - the hourly check is asked to run now'),
  `one info line says so (${lines.find((l) => /top-priority/.test(l))})`);
  ok((fs.statSync(checkNowFile(dir)).mode & 0o077) === 0, 'readable by the bot\'s user only');
  ok(fs.readdirSync(dir).every((x) => !/\.(tmp|taking)$/.test(x)), 'and nothing is left behind beside it');
}

console.log('=== the settle: the latest ask plus two minutes, never past ten from the first ===');
{
  ok(notBeforeOf([]) === null, 'no asks, no time');
  ok(notBeforeOf([{ at: NOW }, { at: NOW + MIN }]) === NOW + MIN + SETTLE_MS, 'a later ask pushes it on');
  ok(notBeforeOf([{ at: NOW }, { at: NOW + 9 * MIN }]) === NOW + MAX_SETTLE_MS, 'but not past ten minutes from the first');
  const dir = fresh();
  const { news, at } = recorder(dir);
  const parts = [0, 3, 6, 9, 12].map((m) => {
    at(NOW + m * MIN);
    return news.record(msg({ timestamp: NOW + m * MIN, text: `#issue part ${m}` }));
  });
  const f = file(dir);
  ok(f.asked.length === 5 && f.asked.map((x) => x.id).join() === parts.map((p) => p.id).join(), 'several asks, one file, oldest first');
  ok(f.notBefore === NOW + MAX_SETTLE_MS, `a stream of messages cannot put the check off: due ${new Date(f.notBefore).toISOString()}`);
  ok(checkNowDue(dir, NOW + MAX_SETTLE_MS - 1) === 'waiting' && checkNowDue(dir, NOW + MAX_SETTLE_MS) === 'due', 'waiting, then due');
  const two = fresh();
  const r2 = recorder(two);
  r2.news.record(msg({ timestamp: NOW, text: '#issue the subtitles on Loki s2e3' }));
  r2.at(NOW + 70_000);
  r2.news.record(msg({ timestamp: NOW + 70_000, text: '#issue and s2e4 has none at all' }));
  ok(file(two).notBefore === NOW + 70_000 + SETTLE_MS, 'a second message a minute later moves it to two minutes after that one');
  ok(checkNowDue(fresh(), NOW) === 'absent', 'no file: nothing asked');
}

console.log('=== the bot and the check never lose each other\'s asks ===');
{
  const dir = fresh();
  const row = (m, id) => ({ at: NOW + m * MIN, id, sender: HEAD, name: 'Head Admin', group: DISCUSSIONS, text: `#issue ${id}` });
  askForCheck(dir, row(0, 'A'), { now: NOW });
  askForCheck(dir, row(1, 'B'), { now: NOW + MIN });
  askForCheck(dir, row(1, 'B'), { now: NOW + MIN });
  ok(readCheckNow(dir).asked.map((a) => a.id).join() === 'A,B', 'the same message asked twice is one ask');
  // The check takes A; while it holds the file, the bot asks again (C) and
  // finds no file there, so it writes one of its own. The check's remainder
  // (B) must be merged into it, not written over it - nor C over B.
  let raced = false;
  const { taken } = takeAsks(dir, (a) => {
    if (!raced) { raced = true; askForCheck(dir, row(3, 'C'), { now: NOW + 3 * MIN }); }
    return a.id === 'A';
  });
  const left = readCheckNow(dir);
  ok(taken.map((a) => a.id).join() === 'A', 'the check takes what it covered');
  ok(left.asked.map((a) => a.id).join() === 'B,C', `and what it left and what the bot wrote meanwhile are both kept (${left.asked.map((a) => a.id)})`);
  ok(left.notBefore === notBeforeOf(left.asked), 'with the time worked out again from those');
  ok(fs.readdirSync(dir).every((x) => !/\.(tmp|taking)$/.test(x)), 'no temporary file is left behind');
  const all = takeAsks(dir, () => true);
  ok(all.taken.length === 2 && !fs.existsSync(checkNowFile(dir)), 'a run that covers everything takes the file away');
  ok(takeAsks(dir, () => true).taken.length === 0, 'and the next finds nothing to take');
  ok(mergeAsks([askOf(row(0, 'X'), NOW)], [{ ...askOf(row(0, 'X'), NOW), name: 'again' }]).length === 1, 'asks merge by message');
  fs.writeFileSync(checkNowFile(dir), '{"v":1,"asked":[{"at":');
  ok(checkNowDue(dir, NOW) === 'due', 'a file that does not parse is due at once - for the check to drop it, not to run for it');
  const bad = takeAsks(dir, () => true);
  ok(bad.corrupt && bad.taken.length === 0 && !fs.existsSync(checkNowFile(dir)), 'and taking it clears it, so the tick stops');
}

console.log('=== the file is only the bot\'s word: nothing in it puts the check off, or names a keeper on its own ===');
{
  // Found in review (2026-10-12): a file of any content there was a run, and
  // a notBefore read from the file could keep one waiting for ever, the
  // tick starting node every minute.
  const dir = fresh();
  const mom = { at: NOW, id: 'K', sender: HEAD, name: 'Head Admin', text: '#issue hers' };
  fs.writeFileSync(checkNowFile(dir), JSON.stringify({ v: 1, asked: [mom], notBefore: NOW + 400 * 24 * 60 * MIN }));
  ok(readCheckNow(dir).notBefore === NOW + SETTLE_MS && checkNowDue(dir, NOW + SETTLE_MS) === 'due',
    'a notBefore in the file is not taken: worked out from the asks, as the bot works it out');
  fs.writeFileSync(checkNowFile(dir), JSON.stringify({ v: 1, asked: [{ ...mom, at: NOW + 400 * 24 * 60 * MIN }] }));
  ok(checkNowDue(dir, NOW) === 'due', 'an ask dated further ahead than any settle is looked at now, not waited for');
  fs.writeFileSync(checkNowFile(dir), '{"v":1,"asked":[]}');
  ok(checkNowDue(dir, NOW) === 'due', 'and a file with no ask in it is looked at now too');

  const rows = [
    { kind: 'issue', keeper: true, at: NOW, id: 'K', sender: HEAD, text: '#issue hers' },
    { kind: 'issue', at: NOW, id: 'O', sender: HEAD, text: '#issue hers, written before rows were marked' },
    { kind: 'issue', at: NOW, id: 'S', sender: '15550002222', text: '#issue a stranger\'s' },
    { kind: 'news', keeper: true, at: NOW, id: 'P', sender: HEAD, text: 'a plain message of hers' },
  ];
  const isKeeper = keeperIssueTest(rows, new Set([HEAD]));
  const ask = (id, at = NOW, sender = HEAD) => ({ at, id, sender });
  ok(isKeeper(ask('K')) && isKeeper(ask('O')), 'a keeper\'s #issue row stands behind her ask: marked by the bot, or by her number');
  ok(!isKeeper(ask('S', NOW, '15550002222')), 'another member\'s #issue does not');
  ok(!isKeeper(ask('P')), 'nor a plain message of hers');
  ok(!isKeeper(ask('N')), 'nor no row at all');
  ok(!isKeeper(ask('K', NOW - MIN)), 'nor her row at another time than the ask says');
  ok(!keeperIssueTest(rows.slice(1), new Set())(ask('O')), 'and a number that is no keeper\'s now is not one');
}

console.log('=== a failed ask is a log line, never an error in the message path ===');
if (process.getuid?.() === 0) {
  console.log('  skip running as root: a read-only folder does not stop root');
} else {
  const dir = fresh();
  const { news } = recorder(dir);
  news.record(msg({ text: 'hello' }));
  fs.chmodSync(dir, 0o500);
  lines.length = 0;
  let row;
  let threw = null;
  try { row = news.record(msg({ text: '#issue the Parent Trap has no sound' })); } catch (err) { threw = err; }
  fs.chmodSync(dir, 0o700);
  ok(!threw && row?.kind === 'issue' && row.keeper === true, 'the message is still recorded, nothing thrown');
  ok(lines.some((l) => /^warn library-news: could not ask the hourly check to run now for Head Admin's #issue \(it waits for the hour\)/.test(l))
    && !lines.some((l) => /top-priority/.test(l)), `a warning says it waits for the hour (${lines.find((l) => /could not ask/.test(l))})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
