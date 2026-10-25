#!/usr/bin/env node
/**
 * Check the routines every bot box runs, and activate what is missing.
 *
 *   node tools/routines.mjs              what this box has, what is missing, and the exact next command
 *   node tools/routines.mjs --fix        activate everything that needs no person, then check again
 *   node tools/routines.mjs --list       the registry itself: every routine, why, how to check and install it
 *   node tools/routines.mjs --json       the check, for a script or a Claude session
 *
 *   --only <id>[,<id>]                   just these routines
 *   --role active|standby                say what this box is, instead of reading it off systemd
 *   --skip <id> --reason "<why>"         this box does without that routine (it is reported, not flagged)
 *   --unskip <id>
 *
 * Exit: 0 every routine that applies here is in place; 1 something is
 * missing or needs a person; 2 refused or a usage error.
 *
 * A new Claude session on any box runs this first (CLAUDE.md, "Routines
 * every box runs"). The registry, and the reasons behind each routine, are in
 * src/core/routines.js.
 *
 * It is safe on a box that does not run the bot - a standby laptop, a
 * rebuilt server before the hand-over: it never starts, stops, restarts or
 * enables the bot, and the routines that belong to the box running the bot
 * are reported there, not installed. --fix runs only from the checkout the
 * service runs, and never as root. What needs a password, a browser login or
 * a passphrase it does not attempt: it prints the command for a person.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ROUTINES, SKIP_FILE, byId, inspectBox, checkAll, exitCode, fixRefusal, skipRefusal, applyFixes,
  formatReport, formatRegistry, jsonReport, readSkips,
} from '../src/core/routines.js';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The real box. Every probe reaches the system through this, so the tests
 * can hand the same code a fake one. run() never throws: a missing program
 * is exit 127, a timeout is exit 124, as a shell would say.
 */
export function realSys(env = process.env) {
  return {
    env,
    home: os.homedir(),
    user: os.userInfo().username,
    host: os.hostname(),
    execPath: process.execPath,
    now: () => Date.now(),
    run(cmd, args = [], { cwd, timeoutMs = 20_000, input } = {}) {
      return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let child;
        try {
          child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (err) {
          resolve({ code: 127, stdout: '', stderr: err.message });
          return;
        }
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
        let timedOut = false;
        timer.unref?.();
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', (err) => { clearTimeout(timer); resolve({ code: err.code === 'ENOENT' ? 127 : 1, stdout, stderr: err.message }); });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          if (signal === 'SIGKILL') timedOut = true;
          resolve({ code: timedOut ? 124 : (code ?? 1), stdout, stderr });
        });
        child.stdin.on('error', () => {});
        // Nothing is ever asked on a terminal from here: a prompt would hang.
        child.stdin.end(input ?? undefined);
      });
    },
    readFile(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } },
    readdir(p) { try { return fs.readdirSync(p); } catch { return null; } },
    exists(p) { return fs.existsSync(p); },
    stat(p) {
      try {
        const s = fs.statSync(p);
        return { mode: s.mode & 0o777, isDir: s.isDirectory(), mtimeMs: s.mtimeMs, size: s.size };
      } catch { return null; }
    },
    realpath(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } },
    which(name) {
      for (const dir of String(env.PATH ?? '').split(':').filter(Boolean)) {
        const p = path.join(dir, name);
        try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
      }
      return null;
    },
  };
}

/** Parse the command line; throws a usage error as { usage: message }. */
export function parseArgs(argv) {
  const o = { fix: false, list: false, json: false, only: null, role: null, skip: null, reason: '', unskip: null };
  const want = (i, flag) => {
    const v = argv[i + 1];
    if (v == null || v.startsWith('--')) throw { usage: `${flag} needs a value` };
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--fix': o.fix = true; break;
      case '--list': o.list = true; break;
      case '--json': o.json = true; break;
      case '--only': o.only = want(i, a).split(',').map((s) => s.trim()).filter(Boolean); i++; break;
      case '--role': o.role = want(i, a); i++; break;
      case '--skip': o.skip = want(i, a); i++; break;
      case '--reason': o.reason = want(i, a); i++; break;
      case '--unskip': o.unskip = want(i, a); i++; break;
      case '-h': case '--help': o.help = true; break;
      default: throw { usage: `unknown argument: ${a}` };
    }
  }
  if (o.role && !['active', 'standby'].includes(o.role)) throw { usage: '--role is active or standby' };
  for (const id of [...(o.only ?? []), o.skip, o.unskip].filter(Boolean)) {
    if (!byId(id)) throw { usage: `no routine called "${id}" (node tools/routines.mjs --list)` };
  }
  if (o.skip && !o.reason.trim()) throw { usage: '--skip needs --reason "<why this box does without it>"' };
  if ((o.skip || o.unskip) && o.fix) throw { usage: '--skip and --unskip are on their own, not with --fix' };
  return o;
}

/** Write data/routines-skip.json with `id` skipped (reason) or not (null). */
export function writeSkip(dir, id, reason, now = new Date()) {
  const file = path.join(dir, SKIP_FILE);
  const skips = readSkips(realSys(), dir);
  if (reason == null) delete skips[id];
  else skips[id] = { reason: String(reason).slice(0, 300), at: now.toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(skips, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const USAGE = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(3, 16)
  .map((l) => l.replace(/^ \* ?/, '')).join('\n');

export async function main(argv, { sys = realSys(), appDir = APP_DIR, out = console.log, err = console.error, uid = process.getuid?.() ?? 1 } = {}) {
  let o;
  try { o = parseArgs(argv); } catch (e) {
    if (!e?.usage) throw e;
    err(e.usage);
    err(USAGE);
    return 2;
  }
  if (o.help) { out(USAGE); return 0; }
  if (o.list) { out(formatRegistry()); return 0; }

  const ctx = await inspectBox(sys, { appDir, role: o.role });

  if (o.skip || o.unskip) {
    const why = skipRefusal(ctx, { uid });
    if (why) { err(`Not recorded: ${why}.`); return 2; }
    writeSkip(ctx.liveDir, o.skip ?? o.unskip, o.skip ? o.reason : null);
    out(o.skip ? `Recorded: this box does without ${o.skip} (${o.reason.trim()}). --unskip ${o.skip} undoes it.`
      : `${o.unskip} is checked on this box again.`);
    return 0;
  }

  if (ctx.role === 'dev') {
    // Nothing on a development clone is a routine's business; saying what
    // they are is still the point, for a session that has just arrived.
    if (o.json) out(JSON.stringify({ host: ctx.host, checkout: ctx.appDir, role: 'dev', roleWhy: ctx.roleWhy, routines: [] }, null, 2));
    else {
      out(`${ctx.roleWhy}.`);
      out('Nothing is checked here. On a box that runs the bot, or stands by for it, tools/bootstrap.sh installs every routine');
      out('below (--dry-run first); on one set up by hand, node tools/routines.mjs --role standby checks them.\n');
      out(formatRegistry());
    }
    if (o.fix) { err(`\nNot fixing: ${fixRefusal(ctx, { uid })}.`); return 2; }
    return 0;
  }

  let results = await checkAll(sys, ctx, { only: o.only });
  if (o.fix) {
    const why = fixRefusal(ctx, { uid });
    if (why) {
      if (!o.json) out(formatReport(results, ctx));
      err(`\nNot fixing: ${why}.`);
      return 2;
    }
    const todo = results.filter((r) => r.state === 'missing' && r.fix);
    if (todo.length) {
      if (!o.json) out(`Activating ${todo.map((r) => r.id).join(', ')} ...`);
      await applyFixes(results, sys, { log: (l) => { if (!o.json) out(`  ${l}`); } });
      // Everything is looked at again: a fix changes the crontab and the
      // units other probes read, and what is reported must be what is there.
      const again = await inspectBox(sys, { appDir, role: o.role });
      results = await checkAll(sys, again, { only: o.only });
      if (!o.json) out('');
      Object.assign(ctx, again);
    } else if (!o.json) {
      out('Nothing to activate without a person.\n');
    }
  }
  out(o.json ? JSON.stringify(jsonReport(results, ctx), null, 2) : formatReport(results, ctx));
  return exitCode(results);
}

if (import.meta.url === `file://${process.argv[1]}` || fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  // Exit once what was printed has gone: process.exit() straight after a
  // console.log drops what a pipe has not taken yet (--json | jq).
  const flushed = (code) => { process.exitCode = code; process.stdout.write('', () => process.exit(code)); };
  main(process.argv.slice(2)).then(flushed, (e) => {
    console.error(`routines: ${e?.stack ?? e}`);
    process.exit(2);
  });
}

export { ROUTINES };
