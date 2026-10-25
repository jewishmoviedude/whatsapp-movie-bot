/* A finished upload is posted on the connection that is live when it ends.
   Run: node test/upload-relay.test.mjs

   The incident, 2026-09-28: "Spaceballs (1987)", 1.7 GB, started uploading
   at 18:50:11 UTC. WhatsApp closed the connection at 18:53:27 and the bot was
   connected again at 18:53:32; the send failed at 18:56:37 with "Connection
   Closed". 1711 MB in 6m26s is the box's usual 4.4 MB/s: the file had
   arrived. Baileys uploads media over HTTPS, which the closed websocket did
   not touch, then relays the message that points at it over the websocket -
   the one sendMessage started with, long dead. "Minority Report" lost its
   upload the same way an hour later (closed 19:40:25, failed 19:47:59).

   The Baileys message builder is the real one; the sockets are stand-ins
   whose upload can "reconnect" the bot while it runs, as happened. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WhatsAppBot } from '../src/core/bot.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
const FILM = path.join(dir, 'Spaceballs (1987).mp4');
fs.writeFileSync(FILM, Buffer.alloc(50_000, 9));
const POSTS = '120363900000000006@g.us';
const ME = '15550001111:4@s.whatsapp.net';

const closed = () => Object.assign(new Error('Connection Closed'), { output: { statusCode: 428 } });

/** A Baileys socket stand-in: records uploads and relays; `dead` fails relays the way a closed one does. */
function socket(name, { onUpload = null } = {}) {
  const s = {
    name, dead: false, uploads: 0, relays: [], sendMessages: 0,
    user: { id: ME }, authState: { creds: { me: { id: ME } } },
    waUploadToServer: async (filePath, opts) => {
      s.uploads += 1;
      if (!fs.existsSync(filePath)) throw new Error('the encrypted temp file is missing');
      await onUpload?.(opts);
      return { mediaUrl: 'https://mmg.whatsapp.net/v/t62.7119-24/x', directPath: '/v/t62.7119-24/x' };
    },
    relayMessage: async (jid, message, opts) => {
      if (s.dead) throw closed();
      s.relays.push({ jid, message, opts });
      return opts.messageId;
    },
    sendMessage: async () => { s.sendMessages += 1; return {}; },
  };
  return s;
}

function makeBot(sock) {
  const bot = new WhatsAppBot({ configStore: { get: () => ({ whatsapp: {} }) }, dataDir: dir });
  bot.state = 'connected';
  bot.sock = sock;
  bot.activeAccountId = 'christopher-nolan';
  bot.relayWaitMs = 300;
  return bot;
}

/** What bot.js does on a close and a reconnect, reduced to the fields that matter. */
function drop(bot) { bot.sock = null; bot._setState('connecting'); }
function reconnect(bot, sock) { bot.sock = sock; bot._setState('connected'); }

console.log('=== an ordinary send: one upload, one message, same socket ===');
{
  const s = socket('a');
  const bot = makeBot(s);
  const msg = await bot.sendDocument(POSTS, FILM, { fileName: 'Spaceballs (1987).mp4' });
  ok(s.uploads === 1 && s.relays.length === 1, 'uploaded once and relayed once');
  const doc = s.relays[0].message.documentMessage;
  ok(doc?.fileName === 'Spaceballs (1987).mp4' && doc.mimetype === 'video/mp4', 'as a document, with its name and type');
  ok(doc?.directPath === '/v/t62.7119-24/x' && Number(doc.fileLength) === 50_000, 'pointing at the uploaded file');
  ok(s.relays[0].jid === POSTS && s.relays[0].opts.messageId === msg.key.id, 'to the posts group, under the id it returns');
  ok(msg.key.remoteJid === POSTS && msg.key.fromMe === true, 'which is the message as Baileys built it');
}

console.log('=== the incident: closed and back during the upload ===');
{
  const fresh = socket('new');
  let bot;
  const old = socket('old', {
    onUpload: async () => {
      old.dead = true;              // 18:53:27, a minute into the upload
      drop(bot);
      await tick();
      reconnect(bot, fresh);        // 18:53:32
      await tick();                 // ...and the upload runs on to 18:56:37
    },
  });
  bot = makeBot(old);
  let err = null;
  let msg = null;
  try { msg = await bot.sendDocument(POSTS, FILM, { fileName: 'Spaceballs (1987).mp4' }); } catch (e) { err = e; }
  ok(!err, `the send succeeds (${err?.message ?? 'no error'})`);
  ok(old.uploads === 1 && fresh.uploads === 0, 'without uploading the file a second time');
  ok(old.relays.length === 0 && fresh.relays.length === 1, 'the message goes on the new connection');
  ok(fresh.relays[0]?.opts.messageId === msg?.key.id, 'under the id the upload was built with');
}

console.log('=== closed during the upload, back only after it finished ===');
{
  const fresh = socket('new');
  let bot;
  const old = socket('old', { onUpload: async () => { old.dead = true; drop(bot); } });
  bot = makeBot(old);
  setTimeout(() => reconnect(bot, fresh), 60);
  let err = null;
  try { await bot.sendDocument(POSTS, FILM); } catch (e) { err = e; }
  ok(!err && fresh.relays.length === 1, 'it waits for the connection, then sends');
}

console.log('=== the socket dies as the message goes, with no close seen yet ===');
{
  const fresh = socket('new');
  const old = socket('old');
  old.dead = true;                  // the relay itself answers "Connection Closed"
  const bot = makeBot(old);
  setTimeout(() => { drop(bot); reconnect(bot, fresh); }, 30);
  let err = null;
  try { await bot.sendDocument(POSTS, FILM); } catch (e) { err = e; }
  ok(!err && fresh.relays.length === 1 && old.uploads === 1, 'it is sent again on the next connection, not uploaded again');
}

console.log('=== what still fails, as before ===');
{
  // A switch to another number: its media is not re-posted by a different one.
  const fresh = socket('other-number');
  let bot;
  const old = socket('old', {
    onUpload: async () => { old.dead = true; drop(bot); bot.activeAccountId = 'default'; reconnect(bot, fresh); },
  });
  bot = makeBot(old);
  let err = null;
  try { await bot.sendDocument(POSTS, FILM); } catch (e) { err = e; }
  ok(/Connection Closed/.test(err?.message ?? '') && fresh.relays.length === 0,
    'the number changed mid-upload: "Connection Closed", for the pipeline to retry');

  // No connection in time.
  let bot2;
  const lone = socket('lone', { onUpload: async () => { lone.dead = true; drop(bot2); } });
  bot2 = makeBot(lone);
  const t0 = Date.now();
  let err2 = null;
  // The wait's timer is unref'd, so it cannot hold a stopping bot open; this
  // keeps the test process alive long enough to see it run out.
  const keepAlive = setTimeout(() => {}, 5000);
  try { await bot2.sendDocument(POSTS, FILM); } catch (e) { err2 = e; }
  clearTimeout(keepAlive);
  ok(/Connection Closed/.test(err2?.message ?? '') && Date.now() - t0 < 2000, 'nothing reconnects: it gives up after the wait');
  ok(bot2.listenerCount('state') === 0, 'and leaves no listener behind');

  // Any other refusal is not a connection problem, and is not retried.
  const s = socket('s');
  s.relayMessage = async () => { throw Object.assign(new Error('forbidden'), { output: { statusCode: 403 } }); };
  const bot3 = makeBot(s);
  let err3 = null;
  try { await bot3.sendDocument(POSTS, FILM); } catch (e) { err3 = e; }
  ok(err3?.message === 'forbidden', 'a refusal is passed on as it is');
}

console.log('=== a socket without the two steps uses sendMessage ===');
{
  const s = { sendMessage: async () => { s.sent = (s.sent ?? 0) + 1; return { key: { id: 'X' } }; } };
  const bot = makeBot(s);
  const r = await bot.sendDocument(POSTS, FILM);
  ok(s.sent === 1 && r.key.id === 'X', 'the one-call path, unchanged');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
