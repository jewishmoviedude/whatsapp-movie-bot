#!/usr/bin/env node
/**
 * Switch the request pause on or off in data/state.json, while the bot is stopped.
 *
 *   node tools/pause-requests.mjs status          what the file says, and whether the bot runs
 *   node tools/pause-requests.mjs on  [--by WHO]  pause requests (and the queue, unless it already is)
 *   node tools/pause-requests.mjs off [--by WHO]  resume them; held requests run, in order, at the next start
 *
 * Exit: 0 done, 1 refused (the bot is running, or state.json is unreadable), 2 usage.
 *
 * Why it exists: the request pause (src/core/request-pause.js, the operator's
 * request of 2026-10-01) is read when the bot starts, before any message is
 * handled. Stopping the bot, switching the pause on here and starting it
 * again restarts the live bot with no moment in which a request runs - every
 * request that arrives gets ⏸️ and waits for Resume on the panel. The main
 * session restarts the bot exactly this way.
 *
 * It writes ONLY while the bot is stopped. A running bot holds the whole of
 * state.json in memory and writes it back within half a second of any
 * change, so an edit made under it is overwritten, and a pause that seemed to
 * take would not. While it runs, pause from the panel (Dashboard -> ⏸️ Pause
 * requests) or with the command channel: {"op":"pause-requests"} in
 * data/bot-cmd.json.
 *
 * What it writes, in data/state.json - in DATA_DIR where that is set, found
 * as the bot finds it: the environment first, then the checkout's .env
 * (src/index.js loads it with dotenv), then <checkout>/data:
 *
 *   "request-pause": { "state": { "paused": true, "since": <ms>, "by": "<who>", "pausedQueue": <bool> } }
 *   "queue-pause":   { "state": { "paused": true, "since": <ms>, "by": "<who>" } }
 *
 * "pausedQueue" says the queue was paused by this pause, so turning it off
 * resumes the queue as well; a queue that was already paused is left so.
 * The held requests ("request-pause"."held") are never touched here.
 *
 * The queue is paused with the requests, and a restart puts the jobs it
 * interrupted back in that queue: they wait there too, until Resume
 * requests, or the queue's own Resume, which lets them go on while requests
 * stay paused. `on` says so.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import {
  NAMESPACE, QUEUE_NAMESPACE, switchOn, switchOff, normalState, normalQueue, clock,
} from '../src/core/request-pause.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE = 'whatsapp-bot.service';
const RUNNING_STATES = new Set(['active', 'activating', 'reloading', 'deactivating', 'refreshing']);

/** `systemctl is-active` for the service: 'active', 'inactive', … or null with no systemd. */
export function serviceState(run = spawnSync) {
  const r = run('systemctl', ['is-active', SERVICE], { encoding: 'utf8' });
  if (r.error) return null;
  return String(r.stdout ?? '').trim() || null;
}

/** Every process on the box, as { pid, argv, cwd } - cwd null where it cannot be read. */
export function listProcesses(procDir = '/proc') {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(procDir); } catch { return out; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let argv;
    try { argv = fs.readFileSync(path.join(procDir, name, 'cmdline'), 'utf8').split('\0').filter(Boolean); }
    catch { continue; }
    let cwd = null;
    try { cwd = fs.readlinkSync(path.join(procDir, name, 'cwd')); } catch { /* another user's */ }
    out.push({ pid: Number(name), argv, cwd });
  }
  return out;
}

/**
 * The bot's own processes on this checkout: node running src/index.js here,
 * however it was started (the unit's `node src/index.js` in the checkout,
 * start.sh, an absolute path). One whose directory cannot be read is
 * counted, since it may be: a refusal costs a `sudo`, a write under a live
 * bot costs the pause.
 */
export function botProcesses(procs, root = ROOT, self = process.pid) {
  const entry = path.join(root, 'src', 'index.js');
  return procs.filter((p) => {
    if (p.pid === self || !p.argv?.length) return false;
    if (!/(^|\/)node(js)?(\d+)?$/.test(p.argv[0])) return false;
    return p.argv.slice(1).some((a) => {
      if (!/(^|\/)src\/index\.js$/.test(a)) return false;
      if (path.isAbsolute(a)) return path.resolve(a) === entry;
      return p.cwd == null || path.resolve(p.cwd, a) === entry;
    });
  });
}

/** Why the file may not be written now, or null when the bot is not running. */
export function runningBot({ root = ROOT, service = serviceState, procs = listProcesses } = {}) {
  const st = service();
  if (st && RUNNING_STATES.has(st)) return `${SERVICE} is ${st}`;
  const found = botProcesses(procs(), root);
  if (found.length) {
    return `node src/index.js is running on this checkout (pid ${found.map((p) => p.pid).join(', ')})`;
  }
  return null;
}

/**
 * The bot's data directory, found as the bot finds it. src/index.js starts
 * with `import 'dotenv/config'`, so a DATA_DIR in the checkout's .env (where
 * the sealed backup puts the settings back) is the bot's, unless the
 * environment already has one; the unit runs it in the checkout, so a
 * relative one is from there. Reading only the environment, as this did at
 * first, a pause written from a shell without DATA_DIR went into a new
 * <checkout>/data/state.json, and the bot started unpaused on its real one
 * (found in review, 2026-10-01).
 */
export function dataDirFor(root = ROOT, env = process.env) {
  if (env.DATA_DIR) return env.DATA_DIR;
  const fromFile = envFileDataDir(root);
  if (fromFile) return path.resolve(root, fromFile);
  return path.join(root, 'data');
}

function envFileDataDir(root) {
  try { return dotenv.parse(fs.readFileSync(path.join(root, '.env'))).DATA_DIR || null; }
  catch { return null; }
}

function readState(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return { data: {}, fresh: true };
    return { error: `${file} cannot be read: ${err.message}` };
  }
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: `${file} is not a JSON object` };
    return { data, fresh: false };
  } catch (err) {
    // Never "start fresh" over it, as the bot would: that file holds every
    // journalled job, the history and the cooldowns.
    return { error: `${file} is not valid JSON (${err.message}) - not touching it` };
  }
}

/** Whole or not at all, as the bot writes it (StateStore.flush). */
function writeState(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(data));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

function describe(data) {
  const req = normalState(data?.[NAMESPACE]?.state);
  const q = normalQueue(data?.[QUEUE_NAMESPACE]?.state);
  const held = Array.isArray(data?.[NAMESPACE]?.held) ? data[NAMESPACE].held.length : 0;
  const lines = [
    req.paused
      ? `requests: PAUSED since ${clock(req.since)} (${req.since ? new Date(req.since).toISOString() : '?'}) by ${req.by ?? '?'}`
        + `${req.pausedQueue ? ' - it paused the queue too' : ''}`
      : 'requests: not paused',
    `held: ${held} request(s)${held ? (req.paused ? ', run in order on Resume' : ', run in order at the next start') : ''}`,
    q.paused ? `queue: paused since ${clock(q.since)} by ${q.by ?? '?'}` : 'queue: not paused',
  ];
  return lines.join('\n');
}

/**
 * The command. Everything it touches is passed in, so the tests run it
 * against a scratch directory with systemd and the process list stubbed.
 */
export function main(argv, {
  root = ROOT, dataDir = dataDirFor(root),
  service = serviceState, procs = listProcesses, now = () => Date.now(),
  out = (s) => console.log(s), err = (s) => console.error(s),
} = {}) {
  const [cmd, ...rest] = argv;
  let user = process.env.USER || 'local shell';
  try { user = os.userInfo().username; } catch { /* no passwd entry */ }
  let by = `${user} (tools/pause-requests.mjs)`;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--by' && rest[i + 1]) { by = String(rest[i + 1]).slice(0, 80); i += 1; }
    else { err(`pause-requests: unknown argument ${rest[i]}`); return 2; }
  }
  if (!['on', 'off', 'status'].includes(cmd)) {
    err('usage: node tools/pause-requests.mjs on|off|status [--by WHO]');
    return 2;
  }
  const file = path.join(dataDir, 'state.json');
  const running = runningBot({ root, service, procs });

  if (cmd === 'status') {
    const read = readState(file);
    if (read.error) { err(`pause-requests: ${read.error}`); return 1; }
    out(describe(read.data));
    out(running
      ? `bot: running (${running}) - this is the file as it last saved it; the panel shows the live state`
      : 'bot: not running');
    return 0;
  }

  if (running) {
    err(`pause-requests: refusing - ${running}.`);
    err('A running bot keeps state.json in memory and writes it back within half a second, so a change made here would be lost.');
    err(cmd === 'on'
      ? 'Pause it live instead: Dashboard -> "⏸️ Pause requests", or echo \'{"op":"pause-requests"}\' > data/bot-cmd.json.'
        + ' Or stop it first (sudo systemctl stop whatsapp-bot), run this again, and start it.'
      : 'Resume it live instead: Dashboard -> "▶️ Resume requests", or echo \'{"op":"resume-requests"}\' > data/bot-cmd.json.');
    return 1;
  }

  const read = readState(file);
  if (read.error) { err(`pause-requests: ${read.error}`); return 1; }
  // A checkout with a .env is an install the bot has run on, and its
  // state.json is never missing: one that is means this is not the file
  // the bot reads, and a pause written to a new one would not be in force.
  if (read.fresh && fs.existsSync(path.join(root, '.env'))) {
    err(`pause-requests: refusing - ${file} does not exist, yet this checkout has a .env, so the bot has run here `
      + 'and keeps its state somewhere else.');
    err('Set DATA_DIR to the directory the bot uses (its log says "data dir :" as it starts) and run this again.');
    return 1;
  }
  const data = read.data;
  const ns = data[NAMESPACE] && typeof data[NAMESPACE] === 'object' ? data[NAMESPACE] : {};
  const qns = data[QUEUE_NAMESPACE] && typeof data[QUEUE_NAMESPACE] === 'object' ? data[QUEUE_NAMESPACE] : {};
  const r = cmd === 'on'
    ? switchOn(ns.state, qns.state, { by, now: now() })
    : switchOff(ns.state, qns.state);
  if (!r.changed) {
    out(cmd === 'on' ? 'requests were already paused - nothing changed' : 'requests were not paused - nothing changed');
    out(describe(data));
    return 0;
  }
  data[NAMESPACE] = { ...ns, state: r.req };
  data[QUEUE_NAMESPACE] = { ...qns, state: r.queue };
  writeState(file, data);
  out(`wrote ${file}: "${NAMESPACE}".state = ${JSON.stringify(r.req)}, "${QUEUE_NAMESPACE}".state = ${JSON.stringify(r.queue)}`);
  out(describe(data));
  out(cmd === 'on'
    ? 'Start the bot and every request gets ⏸️ until Resume (Dashboard -> "▶️ Resume requests").'
      // Paused with them, or already: either way a job the restart
      // interrupted is put back in a paused queue.
      + '\nThe queue is paused too: any job the restart interrupted is put back in it and waits there as well,'
      + ' until Resume requests - or the queue\'s own Resume, which lets them go on while requests stay paused.'
    : 'Start the bot and requests run as normal.');
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main(process.argv.slice(2)));
}
