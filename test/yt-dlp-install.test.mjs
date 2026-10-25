/* yt-dlp installed, and kept current daily by the bot, never under a running download.
   Run: node test/yt-dlp-install.test.mjs

   2026-10-11: YouTube links on "Queue a public link" go through yt-dlp, and
   YouTube breaks an old yt-dlp within weeks. The zipapp's own -U writes the
   new release over the file in place, while a running yt-dlp is still
   reading its code out of that file. So the bot (YtDlpUpdater, the
   `yt-dlp-update` routine) runs -U on a copy once a day and renames the copy
   over the original, only when none of its own yt-dlp runs, and records
   each check where the `yt-dlp` routine reads it; tools/install-yt-dlp.mjs
   installs yt-dlp and deno, each checked against its release's SHA-256, and
   will not swap while any yt-dlp process runs on the box.

   Nothing here touches the network: curl is a fake that serves made-up
   releases, and yt-dlp a script that updates itself as the zipapp does. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  YtDlpUpdater, updateYtDlp, installYtDlp, installDeno, ensureYtDlp, readStamp, writeStamp, releaseAgeDays, sumFor,
  runProgram, YTDLP_URL, YTDLP_SUMS_URL, denoUrl, RETRY_FAILED_MS,
} from '../src/media/yt-dlp-install.js';
import { asTheUpdate, downloadPage } from '../src/media/yt-dlp.js';
import { main, runningYtDlp } from '../tools/install-yt-dlp.mjs';
import { makeFakeYtDlp } from './fixtures/fake-yt-dlp.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const attempt = async (fn) => { try { return { r: await fn() }; } catch (err) { return { err }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-dlp-install-test-'));
process.on('exit', () => fs.rmSync(T, { recursive: true, force: true }));

/* A yt-dlp that knows its version and updates itself in place, as the zipapp
   does: -U rewrites its own file with UPDATE_TO's version (from a file next
   to the test), or says it is up to date, or fails. */
const UPDATE_TO = path.join(T, 'update-to');
const selfUpdating = (version) => `#!${process.execPath}
const fs = require('fs');
const V = '${version}';
const a = process.argv.slice(2);
if (a.includes('--version')) { console.log(V); process.exit(0); }
if (a.includes('-U')) {
  const to = fs.readFileSync(${JSON.stringify(UPDATE_TO)}, 'utf8').trim();
  if (to === 'fail') { console.error('ERROR: Unable to fetch updates: HTTP Error 503'); process.exit(1); }
  if (to === V) { console.log('yt-dlp is up to date (stable@' + V + ')'); process.exit(0); }
  const me = process.argv[1];
  fs.writeFileSync(me, fs.readFileSync(me, 'utf8').replace("const V = '" + V + "'", "const V = '" + to + "'"));
  console.log('Updated yt-dlp to stable@' + to);
  process.exit(0);
}
`;
const box = (name, version = '2026.07.04') => {
  const dir = path.join(T, name);
  const paths = { bin: path.join(dir, 'bin', 'yt-dlp'), deno: path.join(dir, 'deno', 'deno'), stamp: path.join(dir, 'state', 'yt-dlp.json') };
  fs.mkdirSync(path.dirname(paths.bin), { recursive: true });
  if (version) fs.writeFileSync(paths.bin, selfUpdating(version), { mode: 0o755 });
  return paths;
};
const quiet = () => { const lines = []; return { lines, info: (m) => lines.push(`info ${m}`), warn: (m) => lines.push(`warn ${m}`) }; };
const NOW = Date.parse('2026-10-11T12:00:00Z');

console.log('=== the bot\'s daily update: -U on a copy, swapped in whole ===');
{
  const paths = box('daily');
  fs.writeFileSync(UPDATE_TO, '2026.08.19');
  const log = quiet();
  const u = new YtDlpUpdater({ paths, log, now: () => NOW });
  writeStamp(paths.stamp, { at: new Date(NOW - 3 * 3600_000).toISOString(), ok: true, version: '2026.07.04' });
  ok(await u.tick() === 'recent', 'checked three hours ago: nothing to do');
  writeStamp(paths.stamp, { at: new Date(NOW - 25 * 3600_000).toISOString(), ok: true, version: '2026.07.04' });
  const before = fs.statSync(paths.bin).ino;
  const oldText = fs.readFileSync(paths.bin, 'utf8');
  ok(await u.tick() === 'updated', 'a day since the last check: updated');
  const v = spawnSync(paths.bin, ['--version'], { encoding: 'utf8' }).stdout.trim();
  ok(v === '2026.08.19' && fs.statSync(paths.bin).ino !== before, `the new release is in place, as a new file swapped in (${v})`);
  ok(oldText.includes("const V = '2026.07.04'"), 'the file a running yt-dlp had open was never written to');
  ok(fs.readdirSync(path.dirname(paths.bin)).join() === 'yt-dlp', 'no copy left beside it');
  const s = readStamp(paths.stamp);
  ok(s.ok && s.version === '2026.08.19' && s.updated === true && s.by === 'the bot' && s.at === new Date(NOW).toISOString(),
    `the check is recorded for the routine (${JSON.stringify(s)})`);
  ok(log.lines.includes('info yt-dlp updated: 2026.07.04 -> 2026.08.19'), 'and logged');

  writeStamp(paths.stamp, { at: new Date(NOW - 25 * 3600_000).toISOString(), ok: true });
  const ino = fs.statSync(paths.bin).ino;
  ok(await u.tick() === 'current' && fs.statSync(paths.bin).ino === ino && readStamp(paths.stamp).updated === false,
    'already the latest: recorded as checked, the file left as it is');

  fs.writeFileSync(UPDATE_TO, 'fail');
  writeStamp(paths.stamp, { at: new Date(NOW - 25 * 3600_000).toISOString(), ok: true });
  ok(await u.tick() === 'failed' && /yt-dlp -U failed \(exit 1\): ERROR: Unable to fetch updates: HTTP Error 503/.test(readStamp(paths.stamp).error)
    && readStamp(paths.stamp).ok === false, `a failed update is recorded with why (${readStamp(paths.stamp).error})`);
  ok(spawnSync(paths.bin, ['--version'], { encoding: 'utf8' }).stdout.trim() === '2026.08.19', 'and the version it had is kept');
  const later = new YtDlpUpdater({ paths, log, now: () => NOW + RETRY_FAILED_MS - 60_000 });
  ok(await later.tick() === 'recent', 'tried again six hours on, not at every hourly tick');
}

console.log('=== never while a yt-dlp download runs ===');
{
  const paths = box('busy');
  fs.writeFileSync(UPDATE_TO, '2026.08.19');
  writeStamp(paths.stamp, { at: new Date(NOW - 48 * 3600_000).toISOString(), ok: true });
  const fake = makeFakeYtDlp(path.join(T, 'busy-fake'));
  fake.set({ download: 'hang' });
  const ac = new AbortController();
  const lookup = (_h, _o, cb) => cb(null, [{ address: '142.250.180.14', family: 4 }]);
  const dl = attempt(() => downloadPage('https://www.youtube.com/watch?v=abc', { bin: fake.bin, deno: null, nodeVersion: '20.0.0', lookup, dir: path.join(T, 'busy-job'), signal: ac.signal }));
  for (let i = 0; i < 200 && !fake.pid(); i++) await sleep(20);
  const log = quiet();
  const u = new YtDlpUpdater({ paths, log, now: () => NOW });
  ok(await u.tick() === 'deferred' && /put off: a yt-dlp download is running/.test(log.lines.join()), 'a download running: put off, and said');
  ok(spawnSync(paths.bin, ['--version'], { encoding: 'utf8' }).stdout.trim() === '2026.07.04', 'the file under it untouched');
  ac.abort();
  await dl;
  ok(await u.tick() === 'updated', 'the next tick, with nothing running, updates it');

  // An update already under way (asTheUpdate) holds the next one off too.
  let release;
  const holding = asTheUpdate(() => new Promise((r) => { release = r; }));
  writeStamp(paths.stamp, { at: new Date(NOW - 48 * 3600_000).toISOString(), ok: true });
  ok(await u.tick() === 'deferred', 'and so does an update already running');
  release();
  await holding;

  const none = box('none', null);
  const l2 = quiet();
  const u2 = new YtDlpUpdater({ paths: none, log: l2, now: () => NOW });
  ok(await u2.tick() === 'missing' && await u2.tick() === 'missing' && l2.lines.filter((x) => /not installed/.test(x)).length === 1,
    'not installed: said once a day, and left to the routine (node tools/routines.mjs --fix)');
}

console.log('=== installing: checked against the published SHA-256, or not at all ===');
{
  const ytBytes = Buffer.from(selfUpdating('2026.08.19'));
  const zipDir = path.join(T, 'zip');
  fs.mkdirSync(zipDir);
  fs.writeFileSync(path.join(zipDir, 'deno'), '#!/bin/sh\necho "deno 2.9.7 (stable, release, x86_64-unknown-linux-gnu)"\n');
  const zipFile = path.join(T, 'deno.zip');
  spawnSync('python3', ['-I', '-c', 'import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1], "w")\nz.write(sys.argv[2], "deno")\nz.close()',
    zipFile, path.join(zipDir, 'deno')]);
  const zipBytes = fs.readFileSync(zipFile);
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const denoZip = path.basename(denoUrl('x64'));
  let served = {};
  const fetched = [];
  // curl, faked: what the made-up releases hold. Everything else runs for real.
  const run = async (cmd, args, o) => {
    if (cmd !== 'curl') return runProgram(cmd, args, o);
    const url = args.at(-1);
    fetched.push(url);
    if (!(url in served)) return { code: 22, stdout: '', stderr: 'curl: (22) The requested URL returned error: 404' };
    fs.writeFileSync(args[args.indexOf('-o') + 1], served[url]);
    return { code: 0, stdout: '', stderr: '' };
  };
  const good = () => ({
    [YTDLP_SUMS_URL]: `${sha(Buffer.from('other'))}  yt-dlp.exe\n${sha(ytBytes)}  yt-dlp\n`,
    [YTDLP_URL]: ytBytes,
    [`${denoUrl('x64')}.sha256sum`]: `${sha(zipBytes)}  ${denoZip}\n`,
    [denoUrl('x64')]: zipBytes,
  });

  const paths = box('fresh', null);
  served = { ...good(), [YTDLP_URL]: Buffer.from('tampered') };
  const bad = await attempt(() => installYtDlp({ bin: paths.bin, run }));
  ok(/does not match its published SHA-256 - not installed/.test(bad.err?.message ?? '') && !fs.existsSync(paths.bin),
    `a download that is not the release is refused, and nothing is installed (${bad.err?.message})`);
  ok(fs.readdirSync(path.dirname(paths.bin)).length === 0, 'and nothing is left behind');
  served = good();
  const v = await installYtDlp({ bin: paths.bin, run });
  ok(v === '2026.08.19' && (fs.statSync(paths.bin).mode & 0o777) === 0o755, `the zipapp, 0755, and it runs (${v})`);
  const d = await installDeno({ bin: paths.deno, run, arch: 'x64' });
  ok(d === '2.9.7' && (fs.statSync(paths.deno).mode & 0o777) === 0o755, `deno, unpacked with python3 (there may be no unzip), 0755 (${d})`);
  ok(fetched.every((u) => u.startsWith('https://github.com/yt-dlp/yt-dlp/releases/latest/download/') || u.startsWith('https://github.com/denoland/deno/releases/latest/download/')),
    'only from the projects\' own releases');
  ok((await attempt(() => installDeno({ bin: paths.deno, run, arch: 'mips' }))).err?.message.includes('no Linux build for mips'), 'an architecture deno does not build for is said plainly');

  // The routine's whole job, on an empty box.
  const empty = box('empty', null);
  served = good();
  const all = await ensureYtDlp({ paths: empty, run, update: true });
  ok(all.ytdlp === '2026.08.19' && all.deno === '2.9.7' && all.installed.join() === 'yt-dlp 2026.08.19,deno 2.9.7' && readStamp(empty.stamp)?.ok,
    `an empty box gets both, and the fresh install counts as a check (${JSON.stringify(all)})`);
  const busy = await ensureYtDlp({ paths: empty, run, update: true, busy: () => true });
  ok(/a yt-dlp download is running/.test(busy.update?.skipped ?? ''), 'asked to update while one runs: not swapped');
  ok(sumFor('abc  x\n' + 'a'.repeat(64) + ' *yt-dlp\n', 'yt-dlp') === 'a'.repeat(64) && sumFor('', 'yt-dlp') === null, 'the sums file read as sha256sum writes it');
  ok(releaseAgeDays('2026.08.19', NOW) === 53 && releaseAgeDays('nonsense') === null, 'a release\'s age from its version');
}

console.log('=== tools/install-yt-dlp.mjs ===');
{
  const paths = box('cli');
  const asked = [];
  const ensure = async (o) => { asked.push(o.update); return { ytdlp: '2026.08.19', deno: '2.9.7', installed: [], update: o.update ? { before: 'a', after: 'b', updated: true } : null }; };
  const out = [];
  const opts = { paths, out: (m) => out.push(m), err: (m) => out.push(`ERR ${m}`), ensure, now: () => NOW };
  writeStamp(paths.stamp, { at: new Date(NOW - 3600_000).toISOString(), ok: true });
  ok(await main([], opts) === 0 && asked.at(-1) === false, 'checked an hour ago: installs what is missing, no update');
  ok(await main(['--update'], opts) === 0 && asked.at(-1) === true && out.includes('updated: a -> b'), '--update: updates now');
  writeStamp(paths.stamp, { at: new Date(NOW - 30 * 3600_000).toISOString(), ok: true });
  ok(await main([], opts) === 0 && asked.at(-1) === true, 'a day since the last check: updates');
  const skip = { ...opts, ensure: async () => ({ ytdlp: 'x', deno: 'y', installed: [], update: { skipped: 'a yt-dlp download is running on this box: not swapped under it' } }) };
  ok(await main(['--update'], skip) === 1 && out.some((l) => /^ERR not updated: a yt-dlp download is running/.test(l)), 'one running: exit 1, saying so (the routine stays missing)');
  ok(await main(['--frobnicate'], opts) === 2, 'an unknown argument: exit 2');

  // Which processes are yt-dlp, from /proc.
  const proc = path.join(T, 'proc');
  const put = (pid, argv) => { fs.mkdirSync(path.join(proc, pid), { recursive: true }); fs.writeFileSync(path.join(proc, pid, 'cmdline'), `${argv.join('\0')}\0`); };
  put('101', ['/usr/bin/python3', paths.bin, '--ignore-config', '-J', '--', 'https://youtu.be/x']);
  put('102', [paths.bin, '-P', '/w']);
  put('103', ['/usr/bin/node', 'src/index.js']);
  put('104', ['grep', 'yt-dlp']);
  ok(runningYtDlp(paths.bin, { procDir: proc }).sort().join() === '101,102', 'yt-dlp run by python3, or by itself, is found; a grep for it is not');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
