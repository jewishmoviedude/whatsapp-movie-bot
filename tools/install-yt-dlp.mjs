#!/usr/bin/env node
/**
 * yt-dlp and deno on this box: the `yt-dlp` routine's installer.
 *
 *   node tools/install-yt-dlp.mjs           install what is missing, and update yt-dlp
 *                                           when its last check is a day old
 *   node tools/install-yt-dlp.mjs --update  update yt-dlp now
 *   node tools/install-yt-dlp.mjs --check   say what is installed; change nothing
 *
 * Run by tools/bootstrap.sh and by `node tools/routines.mjs --fix`, as the
 * bot's user - no root: yt-dlp goes to ~/.local/bin/yt-dlp (the official
 * zipapp, run by python3) and deno, its JavaScript runtime for YouTube, to
 * ~/.deno/bin/deno, each checked against the SHA-256 its release publishes.
 * Why these two, and why updated this way: src/media/yt-dlp-install.js.
 *
 * The bot updates yt-dlp itself, daily, between its own downloads. This
 * script does it too when asked, or when the last check is stale, but never
 * while any yt-dlp is running on the box - the bot's or anybody's - since
 * the swap would change the file under it. It then says so and exits 1, and
 * the routine stays "missing" until it is run again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ytDlpPaths } from '../src/media/yt-dlp.js';
import { ensureYtDlp, readStamp, releaseAgeDays, ytDlpVersion, denoVersion, UPDATE_EVERY_MS } from '../src/media/yt-dlp-install.js';

const USAGE = 'usage: node tools/install-yt-dlp.mjs [--update | --check]';

/** pids of running processes whose command line names `bin` (python3 <bin> ..., or <bin> ...). */
export function runningYtDlp(bin, { procDir = '/proc', self = process.pid } = {}) {
  let real = bin;
  try { real = fs.realpathSync(bin); } catch { /* not there */ }
  const found = [];
  let pids = [];
  try { pids = fs.readdirSync(procDir).filter((n) => /^\d+$/.test(n)); } catch { return found; }
  for (const pid of pids) {
    if (Number(pid) === self) continue;
    try {
      const argv = fs.readFileSync(path.join(procDir, pid, 'cmdline'), 'utf8').split('\0');
      if (argv.slice(0, 3).some((a) => a === bin || a === real)) found.push(Number(pid));
    } catch { /* gone, or not ours */ }
  }
  return found;
}

export async function main(argv = process.argv.slice(2), { paths = ytDlpPaths(), out = console.log, err = console.error, ensure = ensureYtDlp, now = Date.now } = {}) {
  const flags = new Set(argv);
  for (const a of flags) {
    if (!['--update', '--check', '-h', '--help'].includes(a)) { err(`unknown argument: ${a}\n${USAGE}`); return 2; }
  }
  if (flags.has('-h') || flags.has('--help')) { out(USAGE); return 0; }
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    err('run this as the bot\'s user, not root: yt-dlp and deno go in that user\'s home');
    return 1;
  }
  const stamp = readStamp(paths.stamp);
  if (flags.has('--check')) {
    const v = await ytDlpVersion(paths.bin);
    const d = await denoVersion(paths.deno);
    out(`yt-dlp: ${v ? `${v} (${releaseAgeDays(v, now())} days old) at ${paths.bin}` : `not installed (${paths.bin})`}`);
    out(`deno:   ${d ? `${d} at ${paths.deno}` : `not installed (${paths.deno})`}`);
    out(`last update check: ${stamp?.at ? `${stamp.at}${stamp.ok ? '' : ` - failed: ${stamp.error}`}` : 'never'}`);
    return v && d ? 0 : 1;
  }
  const due = flags.has('--update') || !stamp?.ok || !(now() - Date.parse(stamp.at) < UPDATE_EVERY_MS);
  const busy = () => runningYtDlp(paths.bin).length > 0;
  try {
    const r = await ensure({ paths, update: due, busy, out: (m) => out(`   ${m}`) });
    out(`yt-dlp ${r.ytdlp} at ${paths.bin}; deno ${r.deno} at ${paths.deno}`);
    if (r.installed.length) out(`installed: ${r.installed.join(', ')}`);
    if (r.update?.skipped) {
      err(`not updated: ${r.update.skipped} (pids ${runningYtDlp(paths.bin).join(', ')}). The bot updates it itself once the download is done; or run this again then.`);
      return 1;
    }
    if (r.update) out(r.update.updated ? `updated: ${r.update.before} -> ${r.update.after}` : `${r.update.after} is the latest`);
    return 0;
  } catch (e) {
    err(`failed: ${e.message}`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  // Exit once what was printed has gone, as tools/routines.mjs does.
  const flushed = (code) => { process.exitCode = code; process.stdout.write('', () => process.exit(code)); };
  main().then(flushed, (e) => { console.error(`install-yt-dlp: ${e?.stack ?? e}`); process.exit(1); });
}
