/* One film or episode, run in a process of its own so a test can kill it.

   The Parent Trap (2026-09-29) was killed by a restart 23 minutes into its
   encode, and a second restart 11 seconds later killed it again. A job that
   is merely made to fail in the test's own process does not leave the disk
   the way a killed one does: nothing in it runs its catch or its finally.
   So the tests that restart a job run it here, kill this whole process group
   with SIGKILL at the moment they choose, and then run the job again as the
   next process would.

   Run as: node test/fixtures/killable-job.mjs <spec.json>

   The spec says which pipeline (kind: movie | tv), the config, the job, where
   the journal lives (`store`, written through to the disk on every change,
   as nothing is flushed when a process is killed), and how WhatsApp behaves:
   `send` is "ok" or "hang" for every group or a map of group -> either, and
   `hangOnReact` an emoji whose reaction never returns. Everything the fake
   WhatsApp sees is appended to `events`, one JSON object a line. */
import './roomy-disk.mjs';
import fs from 'node:fs';
import path from 'node:path';

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { default: moviePlugin } = await import(path.join(spec.repo, 'src/plugins/movie-requests/index.js'));
const { default: tvPlugin } = await import(path.join(spec.repo, 'src/plugins/tv-requests/index.js'));
const { RetryBook } = await import(path.join(spec.repo, 'src/media/resume.js'));

const event = (e) => fs.appendFileSync(spec.events, `${JSON.stringify({ pid: process.pid, ...e })}\n`);
const data = fs.existsSync(spec.store) ? JSON.parse(fs.readFileSync(spec.store, 'utf8')) : {};
const save = () => {
  fs.writeFileSync(`${spec.store}.tmp`, JSON.stringify(data));
  fs.renameSync(`${spec.store}.tmp`, spec.store);
};
const store = {
  get: (k, d = null) => (k in data ? data[k] : d),
  set: (k, v) => { data[k] = v; save(); },
  push: (k, v) => { (data[k] ??= []).unshift(v); save(); },
  delete: (k) => { delete data[k]; save(); },
};
const never = new Promise(() => {});
const sendMode = (jid) => (typeof spec.send === 'object' ? spec.send?.[jid] : spec.send) ?? 'ok';
const bot = {
  isConnected: () => true,
  react: async (m, e) => {
    event({ react: e });
    if (spec.hangOnReact && e === spec.hangOnReact) await never;
    return true;
  },
  sendText: async () => ({}),
  groups: () => [],
  groupMemberInfo: () => ({ isMember: false }),
  on() {}, off() {},
  sendDocument: async (jid, file) => {
    event({ sending: jid, file, size: fs.statSync(file).size });
    if (sendMode(jid) === 'hang') await never;
    event({ sent: jid, file });
    return {};
  },
};
const log = {
  info: (m) => event({ log: m }), warn: (m) => event({ log: m }), error: (m) => event({ log: m }), debug() {},
};
const queue = { pending: [], active: new Map(), on() {}, off() {}, add() { return 'q1'; }, moveTop() { return true; } };
const ctx = { bot, store, queue, log, config: spec.config };
const job = {
  id: `child-${process.pid}`, signal: new AbortController().signal,
  progress() {}, isCancelled: () => false, cancelReason: () => null,
};

try {
  if (spec.kind === 'tv') {
    tvPlugin._retries = new RetryBook({ delayMs: () => 3_600_000, log });
    const notifier = { stage() {}, episodeDone() {}, episodeFailed() {}, episodeCancelled() {} };
    await tvPlugin.deliverEpisode({
      ep: spec.ep, ctx, job, msg: null, react: (e) => bot.react(null, e), notifier,
      reqKey: spec.reqKey, route: null, isLast: true, index: 0, total: 1,
    });
  } else {
    moviePlugin._retries = new RetryBook({ delayMs: () => 3_600_000, log });
    await moviePlugin.deliver({
      msg: null, movie: spec.movie, hit: spec.hit, ctx, job, record: spec.record,
      react: (e) => bot.react(null, e), jobKey: spec.jobKey,
    });
  }
  event({ done: true });
} catch (err) {
  event({ done: true, error: err.message });
}
process.exit(0);
