// Catching a group up on requests nobody answered (the operator, 2026-10-06:
// "go into links group and process all requests from 0237 edt yesterday").
// The bot on bot-box2 had stopped; a newly linked number received the missed
// messages only through history sync, which nothing kept, so they could not
// be handed to the plugins.
import { HistoryBuffer, catchUpPlan, quotedIdOf } from '../src/core/catch-up.js';

let failed = 0;
function ok(cond, name) { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) failed++; }

const G = '120363900000000011@g.us';
const T0 = Date.parse('2026-10-05T06:37:00Z');
const raw = (id, sec, text, { fromMe = false, quote = null, react = null, chat = G } = {}) => ({
  key: { remoteJid: chat, id, fromMe, participant: fromMe ? undefined : '1@s.whatsapp.net' },
  messageTimestamp: Math.floor((T0 + sec * 1000) / 1000),
  message: react ? { reactionMessage: { text: '👍', key: { id: react } } }
    : quote ? { extendedTextMessage: { text, contextInfo: { stanzaId: quote } } }
    : { conversation: text },
});
const normalize = (r) => {
  const m = r.message;
  if (m.reactionMessage) return { id: r.key.id, reaction: { emoji: m.reactionMessage.text }, text: '' };
  return { id: r.key.id, text: m.conversation ?? m.extendedTextMessage?.text ?? '', timestamp: Number(r.messageTimestamp) * 1000 };
};

const buf = new HistoryBuffer({ perChat: 100 });
buf.add([
  raw('before', -60, 'link for inception'),
  raw('b', 120, 'link for interstellar'),
  raw('a', 60, 'link for tenet'),
  raw('answered', 180, 'link for dunkirk'),
  raw('reply', 200, 'here is dunkirk', { fromMe: true, quote: 'answered' }),
  raw('reacted', 240, 'link for memento'),
  raw('r', 250, '', { fromMe: true, react: 'reacted' }),
  raw('blank', 260, ''),
  raw('dm', 300, 'link for x', { chat: '1@s.whatsapp.net' }),
]);

const plan = catchUpPlan(buf.entries(G), { sinceMs: T0, normalize });
ok(plan.pending.map((m) => m.id).join() === 'a,b', `only unanswered requests since the moment, oldest first: ${plan.pending.map((m) => m.id)}`);
ok(plan.answered.length === 2, 'a request the bot quoted in a reply, or reacted to, is skipped');
ok(plan.reachesSince, 'the buffer reaching back before the moment says so');
ok(buf.entries('1@s.whatsapp.net').length === 0, 'only groups are kept');

const later = catchUpPlan(buf.entries(G), { sinceMs: T0 - 3600_000, normalize });
ok(!later.reachesSince, 'a moment before the oldest buffered message is reported as not reached');

buf.done.add('a');
ok(catchUpPlan(buf.entries(G), { sinceMs: T0, normalize, done: buf.done }).pending.map((m) => m.id).join() === 'b',
  'a request an earlier catch-up handed over is not handed over again');

const small = new HistoryBuffer({ perChat: 2 });
small.add([raw('1', 1, 'x'), raw('2', 2, 'y'), raw('3', 3, 'z')]);
ok(small.entries(G).map((r) => r.key.id).join() === '2,3', 'the buffer is bounded per group, dropping the oldest');

ok(quotedIdOf({ message: { ephemeralMessage: { message: { extendedTextMessage: { contextInfo: { stanzaId: 'q' } } } } } }) === 'q',
  'a quote inside a disappearing message is found');

if (failed) process.exit(1);
