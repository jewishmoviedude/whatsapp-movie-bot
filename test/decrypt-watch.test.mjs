/* The messages this number cannot decrypt are named: whose, and in which chat.
   Run: node test/decrypt-watch.test.mjs

   On 2026-10-08 the journal held about a thousand libsignal errors in two
   hours ("Over 2000 messages into the future!", "Bad MAC"), none naming a
   sender. Baileys names them in its "failed to decrypt message" line, but the
   bot gave it a silent logger. A message that fails is dropped unread, so a
   request in it is never answered, and nobody could say whose it was. */
import { baileysLogger, DecryptWatch, failureKind } from '../src/core/decrypt-watch.js';
import { runAdminCommand } from '../src/core/admin-commands.js';
import log from '../src/util/logger.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

// What the watch writes to the bot's log, caught.
const lines = [];
const origWrite = log._write.bind(log);
log._write = (level, scope, msg, extra) => { if (scope === 'decrypt') lines.push(`${level} ${msg}`); return origWrite(level, scope, msg, extra); };

const flush = () => new Promise((r) => setTimeout(r, 30));

console.log('=== Baileys\' decrypt failure reaches the watch, with whose it was ===');
{
  const got = [];
  const bl = baileysLogger((f) => got.push(f));
  const child = bl.child({ class: 'baileys' });
  const key = { remoteJid: '120363900000000003@g.us', participant: '10000000000009@lid', participantPn: '15558160178@s.whatsapp.net', id: 'ABC', fromMe: false };
  child.error({ key, err: new Error('Over 2000 messages into the future!') }, 'failed to decrypt message');
  child.error({ err: new Error('something else') }, 'some other baileys error');
  child.warn({ key }, 'failed to decrypt message');
  child.info('connected');
  await flush();
  ok(got.length === 1, `only the decrypt failure, at error level, is passed on (${got.length})`);
  ok(got[0]?.chat === key.remoteJid && got[0]?.sender === key.participant && got[0]?.senderPn === key.participantPn,
    'with the chat, the sender and the sender\'s phone number when WhatsApp gives one');
  ok(/into the future/.test(got[0]?.error ?? ''), 'and the error');

  const dm = [];
  const b2 = baileysLogger((f) => dm.push(f));
  b2.error({ key: { remoteJid: '12125550186@s.whatsapp.net', id: 'X' }, err: new Error('Bad MAC') }, 'failed to decrypt message');
  await flush();
  ok(dm[0]?.sender === '12125550186@s.whatsapp.net', 'a direct message: the chat is the sender');

  const boom = baileysLogger(() => { throw new Error('report broke'); });
  let threw = false;
  try { boom.error({ key, err: new Error('Bad MAC') }, 'failed to decrypt message'); await flush(); } catch { threw = true; }
  ok(!threw, 'a report that throws never breaks decryption');
}

console.log('=== the kinds, in words ===');
ok(/out of step/.test(failureKind('Over 2000 messages into the future!')), 'into the future: the session is out of step');
ok(/Bad MAC/.test(failureKind('Bad MAC')), 'Bad MAC: the keys disagree');
ok(/no session/.test(failureKind('No session record')), 'no session');

console.log('=== one line an hour per sender, not one per message ===');
{
  let t = 1_000_000;
  const w = new DecryptWatch({ now: () => t, everyMs: 60 * 60_000, describe: ({ chat, sender, senderPn }) => ({ chat: `G(${chat})`, sender: senderPn ? `+${senderPn.split('@')[0]}` : sender }) });
  lines.length = 0;
  const f = { chat: 'g1@g.us', sender: 'a@lid', senderPn: '15558160178@s.whatsapp.net', error: 'Over 2000 messages into the future!' };
  for (let i = 0; i < 500; i++) { w.record(f); t += 5_000; }
  ok(lines.length === 1, `500 failures in 40 minutes: one line (${lines.length})`);
  ok(/cannot decrypt messages from \+15558160178 in G\(g1@g.us\): session out of step/.test(lines[0] ?? ''), `naming them: ${lines[0]}`);
  t += 60 * 60_000;
  w.record(f);
  ok(lines.length === 2 && /501 in all/.test(lines[1]) && /since the last report/.test(lines[1]), `an hour on, one more, with the count (${lines[1]})`);
  w.record({ chat: 'b@lid', sender: 'b@lid', error: 'Bad MAC' });
  ok(lines.length === 3 && /a direct message/.test(lines[2]), 'another sender gets a line of its own');
  w.record(f);
  const before = lines.length;
  w.flush();
  ok(lines.length === before + 1 && /1 since the last report, 502 in all/.test(lines.at(-1)), 'flush writes out what is left, once');
  w.flush();
  ok(lines.length === before + 1, 'and nothing when nothing is left');
  const s = w.summary();
  ok(s.length === 2 && s[0].count === 502 && s[0].sender === '+15558160178' && s[0].senderJid === 'a@lid', 'the summary: most failures first, named');
}

console.log('=== the bot-cmd channel answers decrypt-failures ===');
{
  const w = new DecryptWatch({ describe: (x) => x });
  w.record({ chat: 'g@g.us', sender: 's@lid', error: 'Bad MAC' });
  const r = await runAdminCommand({ op: 'decrypt-failures' }, { bot: { decryptWatch: w }, dataDir: '/nonexistent', configStore: { get: () => ({}) } });
  ok(r.ok && r.senders.length === 1 && r.senders[0].count === 1, 'with every sender seen failing');
  const none = await runAdminCommand({ op: 'decrypt-failures' }, { bot: {}, dataDir: '/nonexistent', configStore: { get: () => ({}) } });
  ok(none.ok && none.senders.length === 0, 'and an empty list from a bot without the watch');
}

console.log('=== the bot hands Baileys this logger, not a silent one ===');
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/core/bot.js', import.meta.url), 'utf8');
  const sock = src.slice(src.indexOf('this.sock = makeWASocket({'), src.indexOf('this.sock = makeWASocket({') + 1500);
  ok(/logger: \(this\._baileysLog \?\?= baileysLogger\(/.test(sock), 'makeWASocket gets baileysLogger');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
