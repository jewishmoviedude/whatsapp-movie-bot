/* A "which one?" list can be answered by reacting to it with a number emoji.
   Run: node test/reaction-pick.test.mjs

   The operator's request (2026-10-01): "for beta001 users should be able to
   react with a number emoji instead of replying". beta001 is the movie pick
   list (src/plugins/movie-requests/pick-list.js). Until then bot.js handed a
   reaction to the plugins as a message with no text, which every one of them
   ignored, so a member who reacted 2️⃣ to a list got nothing at all.

   Pinned here: bot.js turns a member's reactionMessage into a message with
   msg.reaction = { emoji, targetId, targetFromMe } and no text, hands it on
   once (Baileys' second copy, 'messages.reaction', is not listened to), drops
   a reaction that was taken off, and never reacts to one; the keycaps 1️⃣ to
   9️⃣ and 🔟, with or without the variation selector, are the numbers 1 to
   10, and a list says so in its last line; only the list's requester, only
   on the list's own message, only with a number - anything else is ignored
   without a word; first pick wins; a number not on the list, or already
   turned down, gets ❓ from the bot on the list message it was put on -
   never on the reaction - taken off once a pick is taken; the TV
   plugin ignores reactions; in a beta group a reaction pick is a test, and
   the transcript records it as 'in-react', which the hourly scan threads
   with its list and does not take for the bot's own answer or for a queue
   position; a $stamtest's answer can be reacted on; and while requests are
   paused a reaction pick is held, with its ⏸️ on the request (never on the
   reaction), and run on resume.

   Changed after the review of 2026-10-01: a wrong reacted number's ❓ went
   on the member's request, where every group's legend says ❓ means
   "Couldn't match that title - check the spelling", and where the hourly
   beta scan filed it as a test code not taken; a reaction pick held by the
   pause got no ⏸️ anywhere; and the scan took the tester's first keycap
   anywhere for their pick, so a stray 1️⃣ after a typed pick that won was
   a "wrong film", and a 7️⃣ the bot refused hid the 2️⃣ it took.
   test/pick-list.test.mjs ("[reaction]") runs the whole pipeline for it.

   beta001 left beta for every group on 2026-10-11 (test/pick-list.test.mjs
   says why), so nothing here sets a mode for it, and the config is the
   incident's own: `beta.features: {}`. The lists below that carry a
   beta001 route are ones a "$beta001" test opened before then, still
   answered after the upgrade. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import tvPlugin from '../src/plugins/tv-requests/index.js';
import { WhatsAppBot } from '../src/core/bot.js';
import { PluginManager } from '../src/core/plugin-manager.js';
import { JobQueue } from '../src/core/queue.js';
import { RequestPause, slimMessage } from '../src/core/request-pause.js';
import { readTranscript } from '../src/core/beta-transcript.js';
import { betaFindings, excerptLine } from '../src/core/beta-scan.js';
import { stamIntercept } from '../src/core/stam-test.js';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';
import {
  keycapNumber, listMessageIds, formatPickList, MAX_REACTION_PICK,
} from '../src/plugins/movie-requests/pick-list.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'reaction-pick-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

const MOVIES = 'movies@g.us';
const TV = 'tv@g.us';
const BETA = 'beta@g.us';
const AVI = { jid: 'avi@lid', number: '15550000001' };
const BOB = { jid: 'bob@lid', number: '15550000002' };

/* ============================ bot.js ============================ */

const botConfig = {
  whatsapp: {},
  beta: { groups: [BETA], features: {} },
  movieRequests: { requestGroups: [MOVIES] },
};
function makeBot() {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'bot-'));
  const bot = new WhatsAppBot({ configStore: { get: () => botConfig }, dataDir });
  bot.state = 'connected';
  bot.groupCache = new Map([[BETA, { jid: BETA, subject: 'Testing things' }]]);
  bot.wire = [];
  bot.sock = { sendMessage: async (jid, content) => { bot.wire.push({ jid, content }); return { key: { id: `BOT${bot.wire.length}`, remoteJid: jid, fromMe: true } }; } };
  return { bot, dataDir };
}
/** A member's reaction as Baileys hands it to messages.upsert, after cleanMessage. */
const rawReaction = (chat, emoji, targetId, { id = 'R1', who = BOB, wrap = false } = {}) => {
  const content = { reactionMessage: { key: { remoteJid: chat, fromMe: true, id: targetId, participant: 'me@lid' }, text: emoji, senderTimestampMs: 1 } };
  return {
    key: { remoteJid: chat, participant: who.jid, participantPn: `${who.number}@s.whatsapp.net`, id, fromMe: false },
    messageTimestamp: 1_790_000_000, pushName: 'Bob',
    message: wrap ? { ephemeralMessage: { message: content } } : content,
  };
};

console.log('=== bot.js: a member\'s reaction becomes a message with msg.reaction, and no text ===');
{
  const { bot } = makeBot();
  const m = bot.normalize(rawReaction(MOVIES, '2️⃣', 'LIST1'));
  ok(m.reaction?.emoji === '2️⃣' && m.reaction.targetId === 'LIST1' && m.reaction.targetFromMe === true,
    `msg.reaction = { emoji, targetId, targetFromMe } (${JSON.stringify(m.reaction)})`);
  ok(m.text === '' && m.messageType === 'reactionMessage', 'no text; its type says what it is');
  ok(m.senderJid === BOB.jid && m.senderNumber === BOB.number && m.id === 'R1' && m.chatJid === MOVIES,
    'the member who reacted is its sender, with their number, like any message');
  ok(bot.normalize(rawReaction(MOVIES, '3️⃣', 'LIST1', { wrap: true })).reaction?.emoji === '3️⃣', 'inside a disappearing-messages wrapper too');
  const text = bot.normalize({ key: { remoteJid: MOVIES, participant: BOB.jid, id: 'T' }, messageTimestamp: 1, message: { conversation: '2' } });
  ok(!('reaction' in text), 'an ordinary message has no reaction field');

  const seen = [];
  bot.on('message', (x) => seen.push(x));
  bot._onMessagesUpsert({ type: 'notify', messages: [rawReaction(MOVIES, '2️⃣', 'LIST1')] });
  ok(seen.length === 1 && seen[0].reaction?.emoji === '2️⃣', 'handed on once, as a message');
  bot._onMessagesUpsert({ type: 'notify', messages: [rawReaction(MOVIES, '', 'LIST1', { id: 'R2' })] });
  ok(seen.length === 1, 'a reaction taken off (an empty one) is not handed on');
  bot._onMessagesUpsert({ type: 'append', messages: [rawReaction(MOVIES, '2️⃣', 'LIST1', { id: 'R3' })] });
  ok(seen.length === 1, 'nor one from the offline backlog, as for any message');

  const src = fs.readFileSync(new URL('../src/core/bot.js', import.meta.url), 'utf8');
  ok(!/ev\.on\(\s*['"]messages\.reaction['"]/.test(src), 'Baileys\' second copy (messages.reaction) is not listened to: no double dispatch');
}

console.log('=== bot.js: the bot never reacts to a reaction ===');
{
  const { bot } = makeBot();
  const m = bot.normalize(rawReaction(MOVIES, '2️⃣', 'LIST1'));
  ok(await bot.react(m, '❓') === false && bot.wire.length === 0, 'react() on a member\'s reaction sends nothing');
  ok(await bot.react(slimMessage(m), '⚠️') === false && bot.wire.length === 0, 'nor on a journalled one');
  const text = bot.normalize({ key: { remoteJid: MOVIES, participant: BOB.jid, id: 'T' }, messageTimestamp: 1, message: { conversation: 'x' } });
  ok(await bot.react(text, '✅') === true && bot.wire.length === 1, 'an ordinary message is reacted to as ever');
}

console.log('=== the beta transcript records a tester\'s reaction as in-react ===');
{
  const { bot, dataDir } = makeBot();
  const listMsg = await bot.sendText(BETA, '🔍 *Search results for "venom"*\n\n*1.* Venom (2005)\n\n*2.* Venom (2018)', { quoted: { id: 'REQ', key: { id: 'REQ' } } });
  bot._onMessagesUpsert({ type: 'notify', messages: [rawReaction(BETA, '2️⃣', listMsg.key.id, { id: 'RB1' })] });
  bot._onMessagesUpsert({ type: 'notify', messages: [rawReaction(BETA, '', listMsg.key.id, { id: 'RB2' })] });
  bot._onMessagesUpsert({ type: 'notify', messages: [rawReaction(MOVIES, '2️⃣', 'X', { id: 'RM1' })] });
  const rows = readTranscript(dataDir, { since: 0 });
  const r = rows.filter((e) => e.type === 'in-react');
  ok(r.length === 1 && r[0].emoji === '2️⃣' && r[0].on === listMsg.key.id && r[0].id === 'RB1',
    `one in-react row: the emoji, and the message it is on (${JSON.stringify(r[0] ?? null)})`);
  ok(r[0]?.request === 'REQ' && r[0].from?.name === 'Bob' && /^[0-9a-f]{8}$/.test(r[0].from.id) && !JSON.stringify(r[0]).includes(BOB.number),
    'with the request the list answers, and the tester as a name and a keyed hash, never the number');
  ok(!rows.some((e) => e.id === 'RB2') && !rows.some((e) => e.group === MOVIES), 'a reaction taken off is not written, nor anything in a main group');
  ok(!rows.some((e) => e.type === 'in' && e.messageType === 'reactionMessage'), 'and it is not written as something said');
}

/* ============================ the pure parts ============================ */

console.log('=== keycaps are the numbers 0 to 10 ===');
{
  const caps = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
  ok(caps.every((c, i) => keycapNumber(c) === i + 1), '1️⃣..9️⃣ and 🔟 are 1 to 10');
  ok(['1⃣', '5⃣', '9⃣'].map(keycapNumber).join() === '1,5,9', 'without the variation selector too');
  ok(keycapNumber('0️⃣') === 0, '0️⃣ is 0 - a wrong number, as "0" typed is');
  ok(['#️⃣', '*️⃣', '👍', '2', '', null, '1️⃣1️⃣', '❤️'].every((e) => keycapNumber(e) === null), 'nothing else is a number: #️⃣ *️⃣ 👍 a bare digit, two keycaps');
  ok(MAX_REACTION_PICK === 10, 'reactions reach ten');
  ok(listMessageIds({ listKey: { id: 'A' }, listIds: ['B', 'A'] }).join() === 'A,B' && listMessageIds({}).length === 0,
    'a list\'s own messages: the one it was posted as, and any other that carries it');
}

console.log('=== the list says a number can be reacted ===');
{
  const items = (n) => Array.from({ length: n }, (_, i) => ({ title: `Film ${i + 1}`, year: 2000 + i }));
  ok(formatPickList(items(5)).endsWith('\n\nReply with a number (1–5), or react with it, to get it. This list expires in 10 minutes.'),
    'up to ten: "Reply with a number (1–5), or react with it, to get it."');
  ok(formatPickList(items(10), { test: true }).endsWith('Reply with a number (1–10), or react with it, to test it. Nothing is downloaded. This list expires in 10 minutes.'),
    'a test says "to test it", and ten is still all reactable');
  ok(formatPickList(items(12)).endsWith('Reply with a number (1–12) to get it, or react 1️⃣–🔟 for one of the first ten. This list expires in 10 minutes.'),
    'past ten, reacting is for the first ten');
  // beta001's testers' guide and the operator's description said so too,
  // until it left beta (2026-10-11); the list's own last line, above, is what
  // every member reads now.
}

/* ======================= the movie plugin, by reaction ======================= */

function memStore(data = {}) {
  return {
    _data: data,
    get: (k, d = null) => (k in data ? data[k] : d),
    set: (k, v) => { data[k] = v; return v; },
    delete: (k) => { delete data[k]; },
    push: (k, v, cap = 200) => { (data[k] ??= []).unshift(v); if (data[k].length > cap) data[k].length = cap; },
    flush: () => true,
  };
}
function fakeBot(out = []) {
  return {
    out,
    paced: 0,
    isConnected: () => true,
    // As the real one (bot.js react): nothing goes out without a key.
    react: async (msg, emoji, opts = {}) => {
      if (!msg?.key?.id || !msg.key.remoteJid) return false;
      out.push({ op: 'react', on: msg.id, emoji, kind: opts.kind ?? 'normal', key: msg.key, jid: msg.chatJid });
      return true;
    },
    sendText: async (jid, text, opts = {}) => { out.push({ op: 'text', jid, text, quoted: opts.quoted?.id ?? null }); return { key: { id: `BOT${out.length}`, remoteJid: jid } }; },
    editText: async (jid, key, text) => { out.push({ op: 'edit', jid, key: key.id, text }); return true; },
    deleteMessage: async (m) => { out.push({ op: 'delete', on: m.id }); },
    archiveChat: async () => {},
    isGroupAdmin: () => false,
    async _bulkPace() { this.paced += 1; },
    on() {}, off() {},
  };
}
function config() {
  return mergeDefaults({
    movieRequests: {
      requestGroups: [MOVIES], requirePrefix: true, prefix: '#request', cooldownSecondsPerUser: 30,
      cooldownOnlyWhenOthersWait: false, replyOnBlock: false,
      enforcement: { enabled: true, deleteNonRequests: true, deleteMedia: true, exemptAdmins: true, warnByDm: false },
    },
    tvRequests: { enabled: true, requestGroups: [TV], requirePrefix: true, prefix: '#request', cooldownSecondsPerUser: 900 },
    beta: { groups: [BETA], features: {} },
  }, DEFAULT_CONFIG);
}
function harness({ cfg = config() } = {}) {
  const out = [];
  const bot = fakeBot(out);
  const queue = new JobQueue({ concurrency: 1 });
  const audit = memStore();
  const requestPause = new RequestPause({ store: memStore(), queueStore: memStore(), queue, bot, audit, getConfig: () => cfg });
  const logs = [];
  const log = (lvl) => (m) => logs.push(`${lvl} ${m}`);
  const mkCtx = () => ({
    config: cfg, store: memStore(), bot, queue, linkQueue: queue, requestPause,
    log: { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') },
    configStore: { update() {} },
  });
  const movieCtx = mkCtx();
  const tvCtx = mkCtx();
  requestPause.attach({ plugins: new Map([['movie-requests', { plugin: moviePlugin, ctx: movieCtx }], ['tv-requests', { plugin: tvPlugin, ctx: tvCtx }]]) });
  return { out, bot, queue, requestPause, movieCtx, tvCtx, logs, audit, cfg };
}

let seq = 0;
function mkMsg(text, chatJid, who = AVI) {
  const id = `M${++seq}`;
  return {
    id, key: { id, remoteJid: chatJid, participant: who.jid, fromMe: false }, chatJid, isGroup: true, fromMe: false,
    senderJid: who.jid, senderNumber: who.number, senderNumberDisplay: `+${who.number}`, pushName: who.jid.split('@')[0],
    text, timestamp: Date.now(), messageType: 'conversation', raw: { key: { id } },
  };
}
const mkReaction = (emoji, targetId, chatJid = MOVIES, who = AVI) => ({
  ...mkMsg('', chatJid, who), messageType: 'reactionMessage', reaction: { emoji, targetId, targetFromMe: true },
});

// The pipeline itself is test/pick-list.test.mjs's: here each pick's request
// is recorded, and answers with the status `nextStatus` says.
const ran = [];
let nextStatus = 'queued';
const realRun = moviePlugin._runRequest;
const realTvRun = tvPlugin._runRequest;
moviePlugin._runRequest = async function stub(msg, text, ctx, opts = {}) {
  ran.push({ id: msg.id, text, opts });
  await settle(1);
  opts.onRecord?.({ id: msg.id, status: nextStatus, title: 'Venom', year: 2018, detail: nextStatus, pickList: { ...(opts.pick ?? {}), units: 1 } });
};
tvPlugin._runRequest = async function stub(msg, text) { ran.push({ plugin: 'tv', id: msg.id, text }); return { outcome: 'queued' }; };
process.on('exit', () => { moviePlugin._runRequest = realRun; tvPlugin._runRequest = realTvRun; });
moviePlugin._reactors = new Map();

/** An open "which one?" list of Avi's, as _offerPickList journals it. */
function openList(h, { chat = MOVIES, items = 3, route = null, listKeyId = 'LIST1' } = {}) {
  const req = mkMsg('#request venom', chat);
  const now = Date.now();
  const list = {
    id: req.id, state: 'open', chatJid: chat, listJid: chat, listKey: { id: listKeyId, remoteJid: chat, fromMe: true },
    sender: { jid: AVI.jid, number: AVI.number }, msg: slimMessage(req), request: 'venom', title: 'Venom', query: 'venom',
    items: Array.from({ length: items }, (_, i) => ({ title: 'Venom', year: 1990 + i, rated: 'PG' })),
    refused: [], shownAt: now, expiresAt: now + 10 * 60_000, route, at: now,
    record: { id: req.id, request: 'venom', status: 'pick-list', pickList: { shownAt: now, expiresAt: now + 600_000, units: 1, invalid: 0 } },
  };
  h.movieCtx.store.set('pickLists', [list]);
  return { req, list };
}
const reactionsOn = (out, id) => out.filter((e) => e.op === 'react' && e.on === id).map((e) => e.emoji);
const journal = (h) => h.movieCtx.store.get('pickLists', [])[0];

console.log('=== a keycap on the list, from its requester, is the pick ===');
{
  const h = harness();
  const { req } = openList(h);
  ran.length = 0;
  const r = mkReaction('2️⃣', 'LIST1');
  await moviePlugin.onMessage(r, h.movieCtx);
  await settle(10);
  ok(ran.length === 1 && ran[0].id === req.id && ran[0].text === 'Venom 1991', 'the 2nd version runs, on the ORIGINAL request');
  ok(ran[0].opts.pick?.form === 'reaction' && ran[0].opts.pick.picked === 2, 'as a pick of 2, by reaction (History\'s form)');
  ok(!h.out.some((e) => e.on === r.id), 'nothing is ever said to the reaction itself');
  ok(!h.out.some((e) => e.op === 'delete'), 'and it is not moderated');
  ok(journal(h).state === 'answered' && journal(h).pickForm === 'reaction', 'the list is settled, its pick journalled as by reaction');
  ok(h.logs.some((l) => /^info 🔢 .* picked 2 \(reacted 2️⃣, reaction\)/.test(l)), 'the log line says it was reacted');
}

console.log('=== first pick wins: two reactions at once, and one changed afterwards ===');
{
  const h = harness();
  openList(h);
  ran.length = 0;
  await Promise.all([
    moviePlugin.onMessage(mkReaction('1️⃣', 'LIST1'), h.movieCtx),
    moviePlugin.onMessage(mkReaction('3️⃣', 'LIST1'), h.movieCtx),
  ]);
  await settle(10);
  ok(ran.length === 1 && ran[0].text === 'Venom 1990', 'only the first is taken');
  const n = h.out.length;
  await moviePlugin.onMessage(mkReaction('2️⃣', 'LIST1'), h.movieCtx);
  await moviePlugin.onMessage(mkMsg('2', MOVIES), h.movieCtx);
  await settle(10);
  ok(ran.length === 1 && h.out.length === n, 'a changed reaction, or a typed number after it, is ignored: 0 outbound');
  ok(h.logs.some((l) => /^info ignoring reacted 2️⃣ from .*: their list for "venom" was already answered/.test(l)), 'with a line saying why');
}

console.log('=== only the requester, only on the list, only a number ===');
{
  const h = harness();
  openList(h);
  ran.length = 0;
  const cases = [
    ['Bob\'s 2️⃣ on Avi\'s list', mkReaction('2️⃣', 'LIST1', MOVIES, BOB)],
    ['Avi\'s 2️⃣ on another message', mkReaction('2️⃣', 'SOMETHING-ELSE')],
    ['Avi\'s 👍 on the list', mkReaction('👍', 'LIST1')],
    ['Avi\'s #️⃣ on the list', mkReaction('#️⃣', 'LIST1')],
    ['Avi\'s 2️⃣ on the list, in another group', mkReaction('2️⃣', 'LIST1', TV)],
  ];
  for (const [what, r] of cases) {
    await moviePlugin.onMessage(r, h.movieCtx);
    await tvPlugin.onMessage(r, h.tvCtx);
  }
  await settle(10);
  ok(ran.length === 0 && h.out.length === 0, `ignored without a word: ${cases.map((c) => c[0]).join('; ')}`);
  ok(journal(h).state === 'open', 'the list is still open for its owner');
  ok(!h.logs.some((l) => /^info /.test(l)), 'and none of it fills the log: other people\'s reactions are debug lines');
  await moviePlugin.onMessage(mkReaction('3️⃣', 'LIST1'), h.movieCtx);
  await settle(10);
  ok(ran.length === 1 && ran[0].text === 'Venom 1992', 'the owner\'s 3️⃣ on the list still works');
}
{
  // The same member, seen under their phone JID instead of their LID.
  const h = harness();
  openList(h);
  ran.length = 0;
  await moviePlugin.onMessage(mkReaction('1️⃣', 'LIST1', MOVIES, { jid: `${AVI.number}@s.whatsapp.net`, number: AVI.number }), h.movieCtx);
  await settle(10);
  ok(ran.length === 1, 'the requester under their phone JID still counts (sameSender)');
}
{
  // A list sent in parts, or shown again elsewhere: each of its messages takes a reaction.
  const h = harness();
  const { list } = openList(h);
  h.movieCtx.store.set('pickLists', [{ ...list, listIds: ['LIST1-PART2'] }]);
  ran.length = 0;
  await moviePlugin.onMessage(mkReaction('2️⃣', 'LIST1-PART2'), h.movieCtx);
  await settle(10);
  ok(ran.length === 1 && ran[0].text === 'Venom 1991', 'a reaction on another of the list\'s own messages counts too');
}
{
  const h = harness();
  const { list } = openList(h);
  h.movieCtx.store.set('pickLists', [{ ...list, expiresAt: Date.now() - 1000 }]);
  ran.length = 0;
  await moviePlugin.onMessage(mkReaction('2️⃣', 'LIST1'), h.movieCtx);
  ok(ran.length === 0 && h.out.length === 0, 'a list that has run out takes no reaction');
  // There is no kill switch any more: a config.json that still holds the
  // retired key's Off, as one restored from before 2026-10-11 can, stops
  // nothing.
  const stale = harness();
  stale.cfg.beta.features = { 'movie-pick-list': 'off' };
  openList(stale);
  await moviePlugin.onMessage(mkReaction('2️⃣', 'LIST1'), stale.movieCtx);
  await settle(10);
  ok(ran.length === 1 && ran[0].text === 'Venom 1991', 'while one with the retired beta001 still Off in config.json is answered');
}

console.log('=== a wrong number, or a version already turned down: ❓ on the list, beside it ===');
{
  const h = harness();
  const { req } = openList(h);
  ran.length = 0;
  const seven = mkReaction('7️⃣', 'LIST1');
  await moviePlugin.onMessage(seven, h.movieCtx);
  ok(reactionsOn(h.out, 'LIST1').join() === '❓' && !reactionsOn(h.out, seven.id).length,
    '7️⃣ on a 3-item list: ❓ on the list message it was put on, nothing on the reaction');
  ok(!reactionsOn(h.out, req.id).length, 'and nothing on the request, whose ❓ would say "couldn\'t match that title"');
  const q = h.out.find((e) => e.op === 'react' && e.on === 'LIST1');
  ok(q?.key?.fromMe === true && q.key.remoteJid === MOVIES && q.jid === MOVIES, 'on the bot\'s own list, in the group it went to');
  ok(journal(h).state === 'open' && journal(h).record.pickList.invalid === 1, 'the list stays open, the wrong number counted');
  ok(journal(h).questioned === 'LIST1', 'and the journal remembers where the ❓ is');
  await moviePlugin.onMessage(mkReaction('0️⃣', 'LIST1'), h.movieCtx);
  ok(reactionsOn(h.out, 'LIST1').length === 2, '0️⃣ is a wrong number too');
  ok(h.logs.some((l) => /answered the list for "venom" with reacted 7️⃣ - not one of 1-3/.test(l)), 'the log says what was reacted');
  await moviePlugin.onMessage(mkReaction('2️⃣', 'LIST1'), h.movieCtx);
  await settle(10);
  ok(ran.length === 1 && ran[0].text === 'Venom 1991', 'then 2️⃣ picks');
  ok(reactionsOn(h.out, 'LIST1').at(-1) === '' && !journal(h).questioned, 'and the ❓ comes off the list it no longer fits');
  ok(!reactionsOn(h.out, req.id).length, 'the request was never given a ❓');

  const g = harness();
  const { req: r2, list } = openList(g);
  g.movieCtx.store.set('pickLists', [{ ...list, refused: [1] }]);
  await moviePlugin.onMessage(mkReaction('2️⃣', 'LIST1'), g.movieCtx);
  ok(reactionsOn(g.out, 'LIST1').join() === '❓' && !reactionsOn(g.out, r2.id).length && ran.length === 1,
    'a version already turned down: ❓ on the list, nothing on the request, nothing run');

  // A typed right number after a reacted wrong one takes the ❓ off too.
  const t = harness();
  openList(t);
  await moviePlugin.onMessage(mkReaction('9️⃣', 'LIST1'), t.movieCtx);
  await moviePlugin.onMessage(mkMsg('3', MOVIES), t.movieCtx);
  await settle(10);
  ok(reactionsOn(t.out, 'LIST1').join() === '❓,' && ran.at(-1).text === 'Venom 1992', 'a typed pick after it: the ❓ is taken off as well');
  // A list with no wrong reacted number has nothing to take off.
  const n = harness();
  openList(n);
  await moviePlugin.onMessage(mkReaction('1️⃣', 'LIST1'), n.movieCtx);
  await settle(10);
  ok(!reactionsOn(n.out, 'LIST1').length, 'a clean pick sends nothing to the list');
}
{
  // A refused pick reopens the list (status blocked-rating), and the next reaction picks from what is left.
  const h = harness();
  const { req } = openList(h);
  ran.length = 0;
  nextStatus = 'blocked-rating';
  await moviePlugin.onMessage(mkReaction('1️⃣', 'LIST1'), h.movieCtx);
  await settle(10);
  nextStatus = 'queued';
  ok(journal(h).state === 'open' && journal(h).refused.join() === '0', 'a refused version: the list is open again, minus it');
  await moviePlugin.onMessage(mkReaction('1️⃣', 'LIST1'), h.movieCtx);
  ok(reactionsOn(h.out, 'LIST1').includes('❓') && !reactionsOn(h.out, req.id).includes('❓') && ran.length === 1,
    'reacting it again: ❓ on the list, not on the request');
  await moviePlugin.onMessage(mkReaction('2️⃣', 'LIST1'), h.movieCtx);
  await settle(10);
  ok(ran.length === 2 && ran[1].text === 'Venom 1991' && journal(h).state === 'answered', 'another version still works');
}

console.log('=== past ten: 🔟 reacts, 11 on are typed ===');
{
  const h = harness();
  openList(h, { items: 12 });
  ran.length = 0;
  await moviePlugin.onMessage(mkReaction('🔟', 'LIST1'), h.movieCtx);
  await settle(10);
  ok(ran.length === 1 && ran[0].text === 'Venom 1999' && ran[0].opts.pick.picked === 10, '🔟 picks the 10th of 12');
  const g = harness();
  openList(g, { items: 12 });
  await moviePlugin.onMessage(mkMsg('11', MOVIES), g.movieCtx);
  await settle(10);
  ok(ran.length === 2 && ran[1].text === 'Venom 2000', 'the 11th is typed, as ever');
}

console.log('=== TV ignores reactions; a beta group takes a reaction pick as a test ===');
{
  const h = harness();
  ran.length = 0;
  await tvPlugin.onMessage(mkReaction('2️⃣', 'ANY', TV), h.tvCtx);
  ok(ran.length === 0 && h.out.length === 0, 'the TV plugin does nothing with a reaction');

  const b = harness({ cfg: config() });
  const route = { beta: true, notifyGroup: BETA, test: 'beta001' };
  const { req } = openList(b, { chat: BETA, route });
  await moviePlugin.onMessage(mkReaction('2️⃣', 'LIST1', BETA), b.movieCtx);
  await settle(10);
  ok(ran.length === 1 && ran[0].id === req.id && ran[0].opts.route?.test === 'beta001',
    'a tester\'s 2️⃣ on a list a $beta001 test opened before beta001 was retired runs the pick, as a test');
  const n = b.out.length;
  await moviePlugin.onMessage(mkReaction('😂', 'LIST1', BETA), b.movieCtx);
  await moviePlugin.onMessage(mkReaction('2️⃣', 'NOT-A-LIST', BETA, BOB), b.movieCtx);
  ok(b.out.length === n && !b.logs.some((l) => /ignored: no test code|not being tested/.test(l)),
    'any other reaction there is not "a message without a test code": nothing said, nothing noted');
}

console.log('=== a $stamtest\'s answer can be reacted on ===');
{
  // The plugin manager tells the plugins which message the answer went out as.
  const told = [];
  const bot = {
    sendText: async (jid, text, opts) => stamIntercept('text', { jid, text, quoted: !!opts?.quoted }) ?? { key: { id: 'SUMMARY1', remoteJid: jid } },
    react: async () => true,
  };
  const pm = new PluginManager({ bot, configStore: { get: () => config() }, stateStore: null });
  pm.plugins.set('spy', { plugin: { name: 'spy', async onMessage() {}, onStamAnswered: (m, sent) => told.push({ m: m.id, sent: sent.key.id }) }, ctx: {} });
  await pm.dispatchMessage({ ...mkMsg('$stamtest #request venom', BETA) });
  ok(told.length === 1 && told[0].sent === 'SUMMARY1', 'onStamAnswered is given the answer\'s key');

  // The movie plugin adds it to the list the test opened, under the tester's message.
  const h = harness();
  const { req, list } = openList(h, { chat: BETA, route: { beta: true, notifyGroup: BETA, test: 'stamtest' }, listKeyId: 'stam-abc-1' });
  moviePlugin.onStamAnswered({ id: req.id }, { key: { id: 'SUMMARY1' } }, h.movieCtx);
  ok(listMessageIds(journal(h)).join() === 'stam-abc-1,SUMMARY1', 'the answer becomes one of the list\'s messages');
  moviePlugin.onStamAnswered({ id: 'someone-else' }, { key: { id: 'SUMMARY2' } }, h.movieCtx);
  ok(listMessageIds(journal(h)).length === 2, 'another message\'s answer is not');
  h.movieCtx.store.set('pickLists', [{ ...journal(h), listKey: { id: 'BOT7' }, listIds: [] }]);
  moviePlugin.onStamAnswered({ id: req.id }, { key: { id: 'SUMMARY3' } }, h.movieCtx);
  ok(listMessageIds(journal(h)).join() === 'BOT7', 'nor is a list that was really posted (not a $stamtest\'s)');
  h.movieCtx.store.set('pickLists', [{ ...list, listIds: ['SUMMARY1'] }]);
  ran.length = 0;
  await moviePlugin.onMessage(mkReaction('3️⃣', 'SUMMARY1', BETA), h.movieCtx);
  await settle(10);
  ok(ran.length === 1 && ran[0].text === 'Venom 1992', '3️⃣ on the $stamtest\'s answer picks the 3rd');
}

console.log('=== while requests are paused, a reaction pick is held - its ⏸️ on the request - and run on resume ===');
{
  const h = harness();
  const { req } = openList(h);
  h.requestPause.pause('alice');
  ran.length = 0;
  const r = mkReaction('2️⃣', 'LIST1');
  await moviePlugin.onMessage(r, h.movieCtx);
  ok(ran.length === 0, 'not run');
  ok(reactionsOn(h.out, req.id).join() === '⏸️' && !reactionsOn(h.out, r.id).length,
    '⏸️ on the request the list answers - never on the reaction (it got none at all at first)');
  ok(journal(h).state === 'picked' && journal(h).pickedIndex === 1 && journal(h).pickForm === 'reaction', 'claimed, so the first pick still wins');
  const held = h.requestPause._held();
  ok(held.length === 1 && held[0].kind === 'pick' && held[0].form === 'reaction' && held[0].msg.reaction?.emoji === '2️⃣',
    'held as the reaction pick it was');
  ok(held[0].reactOn?.id === req.id, 'with the request it answers, for a ⚠️ if it cannot run');
  ok(h.requestPause.snapshot().heldItems[0]?.text === 'reacted 2️⃣', 'the dashboard\'s banner shows what was reacted');
  await moviePlugin.onMessage(mkReaction('3️⃣', 'LIST1'), h.movieCtx);
  ok(h.requestPause.heldCount() === 1, 'a second reaction is not held');

  const before = h.out.length;
  let seenAtRun = null;
  const realStub = moviePlugin._runRequest;
  moviePlugin._runRequest = async function spy(...args) { seenAtRun = reactionsOn(h.out, req.id).at(-1); return realStub.apply(this, args); };
  try { await h.requestPause.resume('alice').replay; } finally { moviePlugin._runRequest = realStub; }
  ok(ran.length === 1 && ran[0].id === req.id && ran[0].text === 'Venom 1991' && ran[0].opts.pick?.form === 'reaction',
    'on resume the pick runs, on the original request, by reaction');
  ok(seenAtRun === '🔍' && h.out.slice(before).some((e) => e.on === req.id && e.emoji === '🔍'),
    'its ⏸️ gives way to 🔍 before the lookup (a pick sends no 🔍 of its own)');
  ok(!h.out.some((e) => e.on === r.id), 'and nothing is ever sent to the reaction');
}
{
  const h = harness();
  const { req } = openList(h);
  h.requestPause.pause('alice');
  const r = mkReaction('2️⃣', 'LIST1');
  await moviePlugin.onMessage(r, h.movieCtx);
  h.movieCtx.store.set('pickLists', []);
  ran.length = 0;
  await h.requestPause.resume('alice').replay;
  ok(ran.length === 0 && reactionsOn(h.out, req.id).includes('⚠️') && !reactionsOn(h.out, r.id).length,
    'its list gone by then: ⚠️ on the request, not on the reaction');
  ok((h.audit.get('events', []) ?? []).some((e) => /could not run a held request/.test(e.action) && /list is gone/.test(e.detail)),
    'and an audit row says why');
}
{
  const b = harness({ cfg: config() });
  b.requestPause.pause('alice');
  openList(b, { chat: BETA, route: { beta: true, notifyGroup: BETA, test: 'beta001' } });
  ran.length = 0;
  await moviePlugin.onMessage(mkReaction('1️⃣', 'LIST1', BETA), b.movieCtx);
  await settle(10);
  ok(b.requestPause.heldCount() === 0 && ran.length === 1, 'a beta tester\'s reaction pick is not paused');
}

/* ============================ the hourly beta scan ============================ */

console.log('=== the hourly scan reads a reaction pick with its list ===');
{
  const G = '120363400000000001@g.us';
  const base = { group: G, groupName: 'Testing things' };
  const at = (hms) => `2026-10-01T${hms}.000Z`;
  const TESTER = { name: 'Mommy', id: '1a2b3c4d' };
  const list = formatPickList([{ title: 'Venom', year: 1981 }, { title: 'Venom', year: 2005 }, { title: 'Venom', year: 2018 }], { test: true, query: 'venom' });
  const convo = (passedFor) => [
    { ...base, at: at('01:00:00'), type: 'in', id: 'V', from: TESTER, text: '$beta001 venom', test: { outcome: 'movie', code: 'beta001', typed: '$beta001' } },
    { ...base, at: at('01:00:06'), type: 'out', id: 'B-V', replyTo: 'V', text: list, code: 'beta001', request: 'V' },
    { ...base, at: at('01:01:00'), type: 'in-react', id: 'RX', from: TESTER, on: 'B-V', emoji: '2️⃣', code: 'beta001', request: 'V' },
    { ...base, at: at('01:01:03'), type: 'edit', of: 'B-V', text: '✔ 2 · Venom (2005) — test passed, nothing sent', code: 'beta001' },
    { ...base, at: at('01:01:03'), type: 'react', on: 'V', emoji: '✅' },
    { ...base, at: at('01:01:04'), type: 'out', id: 'B-T', replyTo: 'V', text: `✅ *Test passed* ($beta001)\n\nThe bot would send *Venom* (${passedFor}), 1.2 GB.\nNothing was downloaded.`, code: 'beta001', request: 'V' },
  ];
  const run = (events) => betaFindings({ events, since: Date.parse(at('00:00:00')), now: Date.parse(at('03:00:00')), config: {} });
  const clean = run(convo(2005));
  ok(clean.length === 0, `a clean reaction pick gives nothing - the tester's 2️⃣ is not a queue position (${clean.map((f) => f.rule).join() || 'none'})`);
  const wrong = run(convo(2018));
  ok(wrong.length === 1 && wrong[0].rule === 'wrong-film' && /reacted 2️⃣, picking 2 · Venom \(2005\), and the test passed for Venom \(2018\)/.test(wrong[0].title),
    `a "Test passed" for another film than the one reacted is caught (${wrong[0]?.title})`);
  ok(wrong[0]?.excerpt.some((l) => /Mommy \(#1a2b3c4d\) reacted 2️⃣ on \[B-V\]/.test(l)), 'and the excerpt shows the reaction, threaded with its list');
  ok(excerptLine({ at: at('01:01:00'), type: 'in-react', from: TESTER, on: 'B-V', emoji: '2️⃣' }) === '01:01:00 UTC Mommy (#1a2b3c4d) reacted 2️⃣ on [B-V]',
    'an in-react line reads as the group saw it');
  const unanswered = run([convo(2005)[0], convo(2005)[1], convo(2005)[2]]);
  ok(!unanswered.some((f) => f.rule === 'unanswered'), 'a list the tester reacted on was answered by the list - their own reaction is not the bot\'s answer, and not a fault either');
  const lone = run([convo(2005)[0], { ...base, at: at('01:00:30'), type: 'in-react', id: 'RY', from: TESTER, on: 'V', emoji: '👍' }]);
  ok(lone.length === 1 && lone[0].rule === 'unanswered', 'a coded test answered only by the tester\'s own 👍 still counts as unanswered');

  // Found in review: the first keycap anywhere was taken for the pick.
  const [V, BV, , edit, done, passed] = convo(2005);
  const typedWon = run([V, BV,
    { ...base, at: at('01:00:50'), type: 'in', id: 'P2', from: TESTER, text: '$beta001 2', test: { outcome: 'movie', code: 'beta001', typed: '$beta001' } },
    { ...base, at: at('01:00:55'), type: 'in-react', id: 'RX1', from: TESTER, on: 'B-V', emoji: '1️⃣', code: 'beta001', request: 'V' },
    edit, done, passed]);
  ok(!typedWon.some((f) => f.rule === 'wrong-film'),
    `a typed "2" that won, then a stray 1️⃣ the bot ignored: no wrong film (${typedWon.map((f) => f.title).join(' | ') || 'none'})`);
  const refusedFirst = run([V, BV,
    { ...base, at: at('01:00:40'), type: 'in-react', id: 'RX7', from: TESTER, on: 'B-V', emoji: '7️⃣', code: 'beta001', request: 'V' },
    { ...base, at: at('01:00:41'), type: 'react', on: 'B-V', emoji: '❓' },
    { ...base, at: at('01:00:50'), type: 'in-react', id: 'RX2', from: TESTER, on: 'B-V', emoji: '2️⃣', code: 'beta001', request: 'V' },
    edit, done, { ...passed, text: passed.text.replace('(2005)', '(2018)') }]);
  ok(refusedFirst.some((f) => f.rule === 'wrong-film' && /reacted 2️⃣, picking 2 · Venom \(2005\), and the test passed for Venom \(2018\)/.test(f.title)),
    `a 7️⃣ the bot refused, then the 2️⃣ it took: the wrong film behind it is still caught (${refusedFirst.map((f) => f.title).join(' | ') || 'none'})`);
  ok(!refusedFirst.some((f) => f.rule === 'code-questioned'),
    'and the ❓ the bot put on the list for the 7️⃣ is not read as a test code not taken');
  const elsewhere = run([V, BV,
    { ...base, at: at('01:00:40'), type: 'in-react', id: 'RX3', from: TESTER, on: 'V', emoji: '3️⃣', code: 'beta001', request: 'V' },
    { ...base, at: at('01:00:50'), type: 'in-react', id: 'RX2', from: TESTER, on: 'B-V', emoji: '2️⃣', code: 'beta001', request: 'V' },
    edit, done, passed]);
  ok(!elsewhere.some((f) => f.rule === 'wrong-film'), 'a keycap on another message than the list is not the pick');
  const struck = formatPickList([{ title: 'Venom', year: 1981 }, { title: 'Venom', year: 2005 }, { title: 'Venom', year: 2018 }], { test: true, query: 'venom', refused: [0] });
  const strikeThenPick = run([V, { ...BV, text: struck },
    { ...base, at: at('01:00:40'), type: 'in-react', id: 'RX1b', from: TESTER, on: 'B-V', emoji: '1️⃣', code: 'beta001', request: 'V' },
    { ...base, at: at('01:00:50'), type: 'in-react', id: 'RX2b', from: TESTER, on: 'B-V', emoji: '2️⃣', code: 'beta001', request: 'V' },
    edit, done, passed]);
  ok(!strikeThenPick.some((f) => f.rule === 'wrong-film'), 'a struck-through number reacted first is not the pick either');
  ok(excerptLine({ at: at('01:02:00'), type: 'react', on: 'B-V', emoji: '' }) === '01:02:00 UTC BOT took its reaction off [B-V]',
    'a reaction the bot took back off reads as such in the excerpt');
}

console.log('=== in a beta group too, a wrong reacted number\'s ❓ is on the list, not on the coded request ===');
{
  // Where the hourly scan's rule 8 reads a ❓ on the request as a test code
  // not taken (the scan's side is pinned just above).
  const b = harness({ cfg: config() });
  const route = { beta: true, notifyGroup: BETA, test: 'beta001' };
  const { req } = openList(b, { chat: BETA, route });
  await moviePlugin.onMessage(mkReaction('7️⃣', 'LIST1', BETA), b.movieCtx);
  ok(reactionsOn(b.out, 'LIST1').join() === '❓' && !reactionsOn(b.out, req.id).length, 'in a beta group too, the ❓ is on the list');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
