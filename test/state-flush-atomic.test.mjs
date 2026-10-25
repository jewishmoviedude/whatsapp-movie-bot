/* The state file is written whole or not at all, even by a process killed mid-write.
   Run: node test/state-flush-atomic.test.mjs

   The journal of every film and episode waiting or in progress lives in
   data/state.json (src/core/state.js), and a restart resumes each from it.
   Since The Parent Trap (2026-09-29: a 2.62 GB download and 23 minutes of
   encoding thrown away by a restart, twice) a restart resumes each from
   the step it reached - but only if the journal is there to say which jobs
   those are. flush(), called at shutdown, wrote straight into state.json:
   a process killed while it wrote (a restart that did not wait, systemd's
   stop timeout) left half a file, the next start said "state file
   unreadable, starting fresh", and every journalled job was forgotten. It
   writes a temporary file, syncs it and renames it over the old one now. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StateStore } from '../src/core/state.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'state-flush-'));
const FILE = path.join(TMP, 'state.json');

console.log('=== flush never leaves a half-written state file ===');
{
  // A process flushing a journal of several megabytes again and again,
  // killed at random moments. Whatever it was doing, the file afterwards is
  // a whole state: the next start reads every job in it.
  const script = path.join(TMP, 'flusher.mjs');
  fs.writeFileSync(script, `
import { StateStore } from ${JSON.stringify(path.join(REPO, 'src/core/state.js'))};
const s = new StateStore(${JSON.stringify(FILE)});
const movies = s.namespace('movie-requests');
const pending = [];
for (let i = 0; i < 4000; i++) pending.push({ jobKey: 'PT' + i + ':tt0120783', movie: { title: 'The Parent Trap', year: 1998 }, pad: 'x'.repeat(600) });
let round = s.data.round ?? 0;
process.stdout.write('ready\\n');
for (;;) { s.data.round = ++round; movies.set('pending', pending); s.flush(); }
`);
  // A whole state to start from, as a box that has run before has.
  const first = new StateStore(FILE);
  first.namespace('movie-requests').set('pending', Array.from({ length: 4000 }, (_, i) => ({ jobKey: `PT${i}:tt0120783` })));
  first.flush();
  let whole = 0;
  let rounds = [];
  const kills = 15;
  for (let i = 0; i < kills; i++) {
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((r) => child.stdout.once('data', r));
    await new Promise((r) => setTimeout(r, 10 + Math.floor(Math.random() * 150)));
    child.kill('SIGKILL');
    await new Promise((r) => child.on('exit', r));
    try {
      const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (data['movie-requests']?.pending?.length === 4000) { whole += 1; rounds.push(data.round); }
    } catch { /* torn */ }
  }
  ok(whole === kills, `${kills} kills mid-flush, ${whole} whole state files (rounds ${rounds.join(', ')})`);
  const s = new StateStore(FILE);
  ok(s.namespace('movie-requests').get('pending', []).length === 4000, 'and the next start reads every journalled job');
}

console.log('=== a flush still writes what it holds ===');
{
  const f = path.join(TMP, 'plain.json');
  const s = new StateStore(f);
  s.namespace('tv-requests').set('pending', [{ reqKey: 'tv-OP17', episodes: [{ id: 'op-17-1' }] }]);
  s.flush();
  ok(JSON.parse(fs.readFileSync(f, 'utf8'))['tv-requests'].pending[0].reqKey === 'tv-OP17' && !fs.existsSync(`${f}.tmp`),
    'the file has it, and no temporary file is left');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
