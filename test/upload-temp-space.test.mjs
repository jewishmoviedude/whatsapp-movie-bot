/* An upload is never started without room for its encrypted copy, and the copies a dead process left are cleared at start.
   Run: node test/upload-temp-space.test.mjs

   The incident, 2026-09-28 20:34:47 UTC: "uncaught exception: ENOSPC: no
   space left on device, write". Baileys writes an encrypted copy of every
   document it sends to os.tmpdir() - the same disk as the work directory on
   bot-box - with no error handler on that write. The copy of "Minority Report"
   stopped at 1.01 GB of 1.67 GB, the process logged the uncaught exception,
   and the upload went on reading the truncated copy for more than half an
   hour. "Charlie and the Chocolate Factory" failed at the same moment
   (ffmpeg exited 228), and "The Parent Trap" at 21:01 (ENOSPC).

   Part of what filled the disk was 4.09 GB of those copies in /tmp, from
   processes stopped mid-send on 09-23, 09-24 and at 06:43 and 06:44 that day:
   Baileys deletes its copy when a send ends, not when the process dies, and
   nothing else ever did. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WhatsAppBot, sweepUploadLeftovers } from '../src/core/bot.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

// Never os.tmpdir() itself: on the live box that holds the running bot's copies.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-temp-'));
const TMP = path.join(dir, 'tmp');
fs.mkdirSync(TMP);

console.log('=== leftovers from an earlier process are cleared at start ===');
{
  const started = Date.now();
  const past = new Date(started - 3600_000);
  const file = (name, { mtime = past, dir: d = TMP } = {}) => {
    const p = path.join(d, name);
    fs.writeFileSync(p, 'x'.repeat(1000));
    fs.utimesSync(p, mtime, mtime);
    return p;
  };
  const left = [
    file('document3EB00ACBC023C6347B1F89-enc'),       // 09-24, 1.36 GB on the day
    file('document3EB083C11E16E06F448D78-enc'),       // 09-23
    file('video3EB01BFD56055ADB6D8FC3-original'),
  ];
  const inFlight = file('document3EB05CEC8CA0B522A26BA1-enc', { mtime: new Date(started + 5000) });
  const others = [
    file('notes.txt'),
    file('document-enc'),
    file('document3EB0abc-enc'),
    file('Minority Report (2002).mp4'),
  ];
  const lookalikeDir = path.join(TMP, 'image3EB01BFD56055ADB6D8FC3-enc');
  fs.mkdirSync(lookalikeDir);

  const removed = sweepUploadLeftovers(TMP, { before: started });
  ok(removed === 3, `the three copies left by a dead process are removed (${removed})`);
  ok(left.every((p) => !fs.existsSync(p)), 'and are gone');
  ok(fs.existsSync(inFlight), 'a copy written since this process started - an upload in progress - is kept');
  ok(others.every((p) => fs.existsSync(p)), 'anything not named exactly as Baileys names its copies is kept');
  ok(fs.statSync(lookalikeDir).isDirectory(), 'and so is a directory, whatever its name');
  ok(sweepUploadLeftovers(null) === 0 && sweepUploadLeftovers(path.join(dir, 'missing')) === 0,
    'no directory, or a missing one, removes nothing');
}

console.log('=== the sweep is wired to the start, on the temp directory, and nowhere else ===');
{
  const src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  ok(/sweepUploadLeftovers\(os\.tmpdir\(\)\)/.test(src), 'src/index.js clears os.tmpdir() once at start');
  const bot = fs.readFileSync(new URL('../src/core/bot.js', import.meta.url), 'utf8');
  ok((bot.match(/sweepUploadLeftovers\(/g) ?? []).length === 1, 'the bot itself never calls it (tests construct bots)');
}

console.log('=== an upload with no room for its encrypted copy is refused before it starts ===');
{
  const FILM = path.join(dir, 'Minority Report (2002).mp4');
  fs.writeFileSync(FILM, Buffer.alloc(40_000, 3));
  const sock = {
    uploads: 0, relays: 0, sendMessages: 0,
    user: { id: '15550001111:4@s.whatsapp.net' }, authState: { creds: { me: { id: '15550001111:4@s.whatsapp.net' } } },
    waUploadToServer: async () => { sock.uploads += 1; return { mediaUrl: 'https://mmg.whatsapp.net/x', directPath: '/x' }; },
    relayMessage: async (jid, message, opts) => { sock.relays += 1; return opts.messageId; },
    sendMessage: async () => { sock.sendMessages += 1; return {}; },
  };
  const bot = new WhatsAppBot({ configStore: { get: () => ({ whatsapp: {} }) }, dataDir: dir });
  bot.state = 'connected';
  bot.sock = sock;
  bot.activeAccountId = 'christopher-nolan';
  let gated = 0;
  const gate = bot._gate.bind(bot);
  bot._gate = (kind) => { gated += 1; return gate(kind); };

  const realStatfs = fs.statfsSync;
  const asked = [];
  let free = 10 * 1024 * 1024;
  fs.statfsSync = (p) => { asked.push(p); return { ...realStatfs(p), bavail: Math.floor(free / 4096), bsize: 4096 }; };
  let err = null;
  try { await bot.sendDocument('posts@g.us', FILM); } catch (e) { err = e; }
  ok(err?.code === 'ENOSPC' && /not enough disk space to upload Minority Report \(2002\)\.mp4/.test(err.message),
    `it fails with the reason (${err?.message})`);
  ok(asked.includes(os.tmpdir()), 'asking about the temp directory, where Baileys writes the copy');
  ok(sock.uploads === 0 && sock.relays === 0 && sock.sendMessages === 0, 'nothing is encrypted, uploaded or sent');
  ok(gated === 0, 'and it does not spend a slot of the outbound budget');
  ok(!/not connected|Connection Closed|ENOENT/i.test(err?.message ?? ''), 'it is not dressed up as a dropped connection');

  free = 50 * 1024 ** 3;
  const msg = await bot.sendDocument('posts@g.us', FILM);
  ok(sock.uploads === 1 && sock.relays === 1 && msg?.key?.id, 'with room, the same file goes as before');
  fs.statfsSync = realStatfs;
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
