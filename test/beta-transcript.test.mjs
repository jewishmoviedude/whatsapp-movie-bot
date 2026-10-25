/* Every beta group's conversation is transcribed, edits included; main groups never are.
   Run: node test/beta-transcript.test.mjs

   The operator, 2026-09-30: "the bot likes to edit it's messages on the test
   group but I need it all logged somewhere for you to check on the hourly
   debug so I don't have to manually report to you, hourly debug analyze the
   recent conversations in that group". The pick list is edited in place (a
   refused version struck through, "replaced", "expired", the ✔), and each
   version was gone from WhatsApp the moment the next one landed; the history
   row kept only the ending, and the debug log what the bot decided, never
   what the testers saw.

   Pinned here, through the real WhatsAppBot with a socket that records what
   it is asked to send: a tester's message, the bot's answer (with the test
   code and request it belongs to), every edit version in full, reactions, a
   failed send, a deleted message, a file, and a message ignored for having no
   code are all written for a beta group, and nothing at all for a main
   group; a tester's number is stored only as a short keyed hash; and days
   older than the log retention are pruned.

   The conversations are written under $beta004: beta001, the pick list they
   were first written with, left beta for every group on 2026-10-11, and a
   message under its code is a test of nothing now - transcribed with the
   code as typed and no feature. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WhatsAppBot } from '../src/core/bot.js';
import plugin from '../src/plugins/movie-requests/index.js';
import { BetaTranscript, readTranscript, pruneTranscript, hashNumber, TRANSCRIPT_DIR } from '../src/core/beta-transcript.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const BETA = '120363400000000001@g.us';
const MAIN = '120363400000000002@g.us';
const NUMBER = '15551234567';
const config = {
  whatsapp: {},
  beta: { groups: [BETA], features: { 'movie-duplicate-notice': 'beta' } },
  movieRequests: { requestGroups: [MAIN], reactions: { notFound: '❓' } },
};

function makeBot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beta-transcript-'));
  const bot = new WhatsAppBot({ configStore: { get: () => config }, dataDir });
  bot.state = 'connected';
  bot.groupCache = new Map([[BETA, { jid: BETA, subject: 'Testing things' }], [MAIN, { jid: MAIN, subject: 'Movie requests' }]]);
  let n = 0;
  bot.wire = [];
  bot.sock = {
    sendMessage: async (jid, content) => {
      bot.wire.push({ jid, content });
      if (content.text === 'boom') throw new Error('Connection Closed');
      return { key: { id: `BOT${++n}`, remoteJid: jid, fromMe: true } };
    },
  };
  return { bot, dataDir };
}

function inbound(bot, chatJid, id, text, { number = NUMBER, name = 'Mommy' } = {}) {
  const msg = {
    id, key: { id, remoteJid: chatJid, participant: `${number}@s.whatsapp.net` }, chatJid, isGroup: true, fromMe: false,
    senderJid: `${number}@s.whatsapp.net`, senderNumber: number, pushName: name, text, messageType: 'conversation', raw: {},
  };
  bot.transcript.inbound(msg);
  return msg;
}

console.log('=== a beta conversation is written in full: message, answer, every edit, reactions ===');
{
  const { bot, dataDir } = makeBot();
  const req = inbound(bot, BETA, 'REQ1', '$beta004 john wick');
  await bot.react(req, '🔍');
  const list = await bot.sendText(BETA, 'Search Results:\n1 John Wick (2014)\n2 John Wick: Chapter 2 (2017)', { quoted: req });
  const pick = inbound(bot, BETA, 'PICK1', '2');
  await bot.editText(BETA, list.key, 'Search Results:\n~1 John Wick (2014)~ — can\'t be sent\n2 John Wick: Chapter 2 (2017)');
  await bot.editText(BETA, list.key, '✔ 2 · John Wick: Chapter 2 (2017) — test passed, nothing sent');
  await bot.sendText(BETA, '✅ Test passed ($beta004): the bot would send *John Wick: Chapter 2* (2017) — nothing was downloaded.', { quoted: pick });
  await bot.react(pick, '✅');

  const rows = readTranscript(dataDir, { since: 0 });
  const types = rows.map((r) => r.type).join(',');
  ok(types === 'in,react,out,in,edit,edit,out,react', `every event, in order (${types})`);
  const [inRow, , outRow] = rows;
  ok(inRow.id === 'REQ1' && inRow.text === '$beta004 john wick' && inRow.test?.code === 'beta004', 'the tester\'s message: id, text and the test code');
  ok(inRow.groupName === 'Testing things' && inRow.group === BETA, 'with the group, by name');
  ok(inRow.from.name === 'Mommy' && /^[0-9a-f]{8}$/.test(inRow.from.id), 'the sender as a display name and an 8-character hash');
  ok(outRow.replyTo === 'REQ1' && outRow.id === list.key.id && outRow.code === 'beta004' && outRow.feature === 'movie-duplicate-notice' && outRow.request === 'REQ1',
    'the bot\'s answer: its id, what it answered, the test code, feature and request');
  const edits = rows.filter((r) => r.type === 'edit');
  ok(edits.length === 2 && edits.every((e) => e.of === list.key.id), 'both edits of the list, linked to the original message');
  ok(/~1 John Wick \(2014\)~/.test(edits[0].text) && /^✔ 2/.test(edits[1].text), 'each edit keeps its own full text');
  ok(edits.every((e) => e.code === 'beta004' && e.request === 'REQ1'), 'an edit carries the request it belongs to');
  ok(rows[1].emoji === '🔍' && rows[1].on === 'REQ1' && rows.at(-1).emoji === '✅' && rows.at(-1).on === 'PICK1', 'reactions: which emoji, on which message');
  ok(rows.every((r) => Number.isFinite(Date.parse(r.at))), 'every event has its time');
  const file = fs.readdirSync(path.join(dataDir, TRANSCRIPT_DIR)).find((n) => n.endsWith('.jsonl'));
  ok(/^\d{4}-\d\d-\d\d\.jsonl$/.test(file), `one JSON line per event in a file per UTC day (${file})`);
  ok(!fs.readFileSync(path.join(dataDir, TRANSCRIPT_DIR, file), 'utf8').includes('5551234567'), 'the tester\'s number is nowhere in the file');
}

console.log('=== failures, deletions, files and ignored messages are there too ===');
{
  const { bot, dataDir } = makeBot();
  const req = inbound(bot, BETA, 'REQ2', '$beta004 venom');
  let threw = false;
  try { await bot.sendText(BETA, 'boom', { quoted: req }); } catch { threw = true; }
  ok(threw, 'a failed send still fails for the caller');
  const chat = inbound(bot, BETA, 'CHAT1', 'captain phillips');
  await plugin._answerNotATest({ outcome: 'ignore' }, chat, {
    bot, config, log: { info() {}, warn() {} },
  });
  await bot.deleteMessage(chat);
  const film = path.join(dataDir, 'film.mp4');
  fs.writeFileSync(film, 'x');
  await bot.sendDocument(BETA, film, { caption: 'John Wick (2014)', quoted: req });
  const rows = readTranscript(dataDir, { since: 0 });
  const failed = rows.find((r) => r.type === 'failed');
  ok(failed?.action === 'send' && failed.replyTo === 'REQ2' && /Connection Closed/.test(failed.error) && failed.code === 'beta004', 'a send that failed, with why');
  const ignored = rows.find((r) => r.type === 'note');
  ok(ignored?.note === 'ignored: no test code' && ignored.ref === 'CHAT1', 'a message without a code: "ignored: no test code"');
  ok(rows.find((r) => r.type === 'in' && r.id === 'CHAT1')?.test === null, 'and the message itself, read as not a test');
  ok(rows.some((r) => r.type === 'delete' && r.of === 'CHAT1'), 'a message the bot deleted');
  const doc = rows.find((r) => r.type === 'out' && r.document);
  ok(doc?.document === 'film.mp4' && doc.text === 'John Wick (2014)' && doc.replyTo === 'REQ2', 'a file sent there, by name, with its caption');
}

console.log('=== a main group is never transcribed ===');
{
  const { bot, dataDir } = makeBot();
  const req = inbound(bot, MAIN, 'M1', '#request john wick');
  const sent = await bot.sendText(MAIN, 'Search Results:\n1 John Wick (2014)', { quoted: req });
  await bot.editText(MAIN, sent.key, 'expired');
  await bot.react(req, '🎬');
  await bot.sendText('15550000000@s.whatsapp.net', 'a DM');
  ok(bot.wire.length === 4, 'everything still went out');
  ok(readTranscript(dataDir, { since: 0 }).length === 0, 'and nothing of it was written');
  ok(!fs.existsSync(path.join(dataDir, TRANSCRIPT_DIR)) || fs.readdirSync(path.join(dataDir, TRANSCRIPT_DIR)).every((n) => !n.endsWith('.jsonl')),
    'not even an empty day file');
}

console.log('=== numbers are hashed, keyed, and stable ===');
{
  ok(hashNumber('15551234567', 'k1') === hashNumber('+1 555 123 4567', 'k1'), 'the same number, however written, is the same tester');
  ok(hashNumber('15551234567', 'k1') !== hashNumber('15551234568', 'k1'), 'two numbers, two testers');
  ok(hashNumber('15551234567', 'k1') !== hashNumber('15551234567', 'k2'), 'keyed: another box\'s key gives another hash');
  ok(hashNumber('', 'k1') === null, 'no number, no hash');
  const { bot } = makeBot();
  const a = inbound(bot, BETA, 'A', '$beta004 a');
  const b = inbound(bot, BETA, 'B', '$beta004 b');
  const rows = readTranscript(bot.dataDir, { since: 0 });
  ok(rows[0].from.id === rows[1].from.id && a && b, 'one tester\'s messages share a hash within the box');
}

console.log('=== a message under the retired beta001 is written with its code and no feature ===');
{
  const { bot } = makeBot();
  const old = inbound(bot, BETA, 'OLD', '$beta001 harry potter');
  await bot.sendText(BETA, '❓ $beta001 has finished.', { quoted: old });
  const [row, answer] = readTranscript(bot.dataDir, { since: 0 });
  ok(row?.test?.outcome === 'unknown' && row.test.code === 'beta001',
    `read as a code nothing is tested under, so the hourly check sees the ❓ it got (${JSON.stringify(row?.test)})`);
  ok(answer?.code === 'beta001' && answer.feature === null && answer.request === 'OLD', 'and its answer belongs to no feature');
}

console.log('=== days older than the log retention are pruned ===');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beta-prune-'));
  const tdir = path.join(dir, TRANSCRIPT_DIR);
  fs.mkdirSync(tdir, { recursive: true });
  const now = Date.parse('2026-09-30T12:00:00Z');
  for (const d of ['2026-09-01', '2026-09-15', '2026-09-16', '2026-09-30']) fs.writeFileSync(path.join(tdir, `${d}.jsonl`), '');
  fs.writeFileSync(path.join(tdir, '.key'), 'k\n');
  const gone = pruneTranscript(tdir, { now, days: 14 });
  ok(gone.sort().join(',') === '2026-09-01.jsonl,2026-09-15.jsonl', `older than 14 days removed (${gone.join(', ')})`);
  ok(fs.existsSync(path.join(tdir, '2026-09-16.jsonl')) && fs.existsSync(path.join(tdir, '2026-09-30.jsonl')), 'the last 14 days kept');
  ok(fs.existsSync(path.join(tdir, '.key')), 'the hash key kept');
  // At start, as the debug log is pruned, with the log's own retention setting.
  for (const d of ['2026-09-20']) fs.writeFileSync(path.join(tdir, `${d}.jsonl`), '');
  new BetaTranscript({ dataDir: dir, getConfig: () => ({ logging: { retentionDays: 7 } }), now: () => now });
  ok(!fs.existsSync(path.join(tdir, '2026-09-16.jsonl')) && fs.existsSync(path.join(tdir, '2026-09-30.jsonl')),
    'pruned when the bot starts, by logging.retentionDays');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
