/* A film accepted before a restart comes back after it, however full the
   queue is by then. Run: node test/resume-over-limit.test.mjs

   Found by the hourly check's first read of bot-box's log (2026-09-28, 01:36):
   a restart with a long TV backlog journalled ahead of it resumed the TV
   episodes first, filled the queue, and then refused the films -
   "could not resume "Doctor Strange": Queue is full (104 waiting)", three
   times. The film stayed in the journal and in History as "queued", but not
   in the queue, so nothing ran it until some later restart. The operator has
   accepted that the hourly check restarts the bot "right away (interrupting
   the queue is fine as it'll resume right away)" - which a full queue made
   untrue for films. A resumed job was admitted once already; the limit is
   for new requests. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import plugin from '../src/plugins/movie-requests/index.js';
import { JobQueue } from '../src/core/queue.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const LIB = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-lib-'));
process.on('exit', () => fs.rmSync(LIB, { recursive: true, force: true }));
fs.writeFileSync(path.join(LIB, 'Doctor Strange (2016).mp4'), '');

const data = {};
const store = { get: (k, d = null) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; } };
const errors = [];

// A queue already at its limit, the way the TV backlog left it.
const queue = new JobQueue({ concurrency: 1, maxLength: 3 });
queue.pause();
for (let i = 0; i < 3; i++) queue.add({ label: `One Piece S12E0${i}`, kind: 'tv', run: async () => {} });

store.set('pending', [{
  jobKey: 'M1:tt1211837', msgId: 'M1', msgKey: { id: 'M1', remoteJid: 'req@g.us' }, chatJid: 'req@g.us',
  movie: { title: 'Doctor Strange', year: 2016, imdbId: 'tt1211837', rated: 'PG-13' },
  meta: { requester: 'Shia', group: 'req@g.us' },
  record: { id: 'M1', request: 'doctor strange', requester: 'Shia', status: 'queued', title: 'Doctor Strange', year: 2016 },
  at: Date.now() - 3600_000,
}]);

const ctx = {
  store,
  queue,
  log: { info() {}, warn() {}, debug() {}, error: (m) => errors.push(m) },
  bot: { react: async () => true },
  config: {
    library: { provider: 'local', local: { roots: [LIB], extensions: ['.mp4'] } },
    movieRequests: { reactions: {}, blockedRatings: ['R'] },
    omdb: { apiKey: '' },
    media: {},
  },
};

await plugin.recoverPending(ctx);
ok(errors.length === 0, `no "could not resume" (${errors.join(' | ') || 'none'})`);
ok(queue.pending.some((e) => e.label === 'Doctor Strange (2016)'), 'the film is back in the queue, past the limit');
ok(store.get('pending').length === 1 && store.get('pending')[0].jobKey === 'M1:tt1211837', 'and still journalled, for a restart after this one');
let refused = null;
try { queue.add({ label: 'A new request', run: async () => {} }); } catch (err) { refused = err.message; }
ok(/Queue is full/.test(refused ?? ''), 'a NEW request is still refused by the limit');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
