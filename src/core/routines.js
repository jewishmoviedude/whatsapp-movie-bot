/**
 * The routines every bot box runs: one registry, checked by one command.
 *
 * The owner asked, of every change that is not temporary: "If I point a brand
 * new claude session at the GitHub repo will it know to activate these routine
 * workflows?" Until this file the answer was no. The hourly check was built,
 * reviewed and merged, and ran nowhere: tools/bootstrap.sh never installed it,
 * nothing told a new session it should exist, and the two one-time steps it
 * needs (passwordless sudo, a `claude setup-token` token in a file) had been
 * done by hand on bot-box and were written down only in a chat. bot-box itself
 * had its Hyper-V offload turned off by hand with no unit to turn it off again
 * after a reboot.
 *
 * So everything a box must have for longer than one session - a cron line, a
 * systemd unit, a token file, a sudo rule, a login, and the jobs the bot runs
 * on a timer inside its own process - is an entry here, with what it is and
 * why, how to check it, how to install it, and the exact command for any step
 * only a person can do (a password, a browser login, a passphrase).
 *
 *   tools/routines.mjs          checks every entry on this box (--fix
 *                               activates what needs no person)
 *   tools/bootstrap.sh          installs every entry: each has a step marked
 *                               "# routine: <id>"
 *   CLAUDE.md                   lists every entry, and tells a new session to
 *                               run the check first
 *   test/routines.test.mjs      fails when an entry is missing from any of
 *                               those, or a new cron line, unit or timer in
 *                               the bot is missing from here
 *
 * The one rule (docs/operations.md; CLAUDE.md, rule 3): two machines on one
 * WhatsApp number is connectionReplaced. Nothing here starts, stops,
 * restarts or enables the bot. A box whose bot is not running is a standby,
 * and the routines that belong to the box running the bot - the hourly check,
 * the nightly sealed backup, starting at boot - are reported there, never
 * installed.
 *
 * Everything outside this process goes through `sys` (see realSys() in
 * tools/routines.mjs), so the tests run every probe against a fake box and
 * never call the real crontab, systemctl or sudo.
 */
import path from 'node:path';
import {
  detectWsl, iniMissing, windowsHome, autostartPowerShell, schtasks, listensOn,
  VM_UNITS, STARTS_AT_BOOT, WSL_CONF_WANT, WSLCONFIG_WANT, TASK_NAME, SSH_PORT, SSHD_PORT_FILE, SSH_SOCKET_DROPIN,
} from './wsl.js';
import { ytDlpPaths, versionAtLeast, MIN_DENO } from '../media/yt-dlp.js';
import { releaseAgeDays, STALE_AFTER_MS, MAX_RELEASE_AGE_DAYS } from '../media/yt-dlp-install.js';
import { emailReady } from '../util/mailer.js';
import { scheduleHeld } from './lockdown.js';

/** deploy/install-hourly-debug.sh's TAG; the test holds the two together. */
export const HOURLY_TAG = '# whatsapp-bot-hourly-check';
/** src/core/sealed-backup.js's CRON_TAG; the test holds the two together. */
export const BACKUP_TAG = '# whatsapp-bot:sealed-backup';
/** Where the yt-dlp routine looks (media/yt-dlp.js ytDlpPaths), as a person would type them. */
const YTDLP_HOME_BIN = '~/.local/bin/yt-dlp';
const DENO_HOME_BIN = '~/.deno/bin/deno';
/** Where tools/routines.mjs --skip records a routine this box does without. */
export const SKIP_FILE = path.join('data', 'routines-skip.json');

export const SCOPES = Object.freeze({
  every: 'Every bot box',
  active: 'Only the box that runs the bot',
  'in-process': 'Inside the bot: nothing to install, it runs whenever the bot runs',
  wsl: 'Only on a WSL box (the bot in WSL2 on a Windows laptop, for its GPU)',
  optional: 'Optional, per box',
});

/**
 * What a check can find. Only `missing` and `needs-user` make the check
 * exit non-zero: `standby` is an active-box routine correctly absent from a
 * box that does not run the bot, and `skipped` is somebody's decision.
 */
export const STATES = Object.freeze({
  ok: 'in place',
  missing: 'missing - --fix activates it',
  'needs-user': 'needs you',
  standby: 'not on a standby box',
  'n/a': 'does not apply here',
  skipped: 'skipped on this box',
  'in-process': 'runs inside the bot',
  optional: 'optional, not set up',
});
export const FAILING = new Set(['missing', 'needs-user']);

// The exact command in docs/server-setup.md, "Give Claude Code sudo"; the test
// holds the two together, so the check never tells somebody something else.
export const SUDO_COMMAND = 'T=$(mktemp) && echo "$USER ALL=(ALL) NOPASSWD:ALL" > "$T" && sudo visudo -cf "$T" && '
  + 'sudo install -m 0440 -o root -g root "$T" /etc/sudoers.d/90-claude-nopasswd && rm -f "$T" && sudo -k && '
  + 'sudo -n true && echo "OK: Claude Code has passwordless sudo"';

/* ------------------------------------------------------------ helpers --- */

const parseJson = (text) => { try { return text == null ? null : JSON.parse(text); } catch { return null; } };
/** 24-hour, UTC - the box's own clock, and the operator's rule. */
export const fmtAt = (ts) => {
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'an unknown time';
};
const ago = (ms) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 90 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
const q = (s) => (/^[\w@%+=:,./-]+$/.test(String(s)) ? String(s) : `'${String(s).replace(/'/g, "'\\''")}'`);

/** A step --fix runs. `display` is how a person would type it. */
const step = (argv, { display = argv.map(q).join(' '), sudo = false, cwd, timeoutMs = 120_000 } = {}) => (
  { argv, display, sudo, cwd, timeoutMs });

const ok = (detail = []) => ({ state: 'ok', detail });
const missing = (detail, fix, next = []) => ({ state: 'missing', detail, fix, next });
const needsUser = (detail, next) => ({ state: 'needs-user', detail, next });

/** The one line of this account's crontab that carries `tag`, or null. */
export function cronLineWith(crontab, tag) {
  return String(crontab ?? '').split('\n').find((l) => l.includes(tag) && !l.trimStart().startsWith('#')) ?? null;
}

/** KEY=VALUE lines from `systemctl show -p ...`. */
export function parseShow(text) {
  const out = {};
  for (const line of String(text ?? '').split('\n')) {
    const m = /^(\w+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Whether a KEY=value line with a value is in env-file text, never the value. */
export function hasEnvKey(text, keys) {
  const re = new RegExp(`^[ \\t]*(export[ \\t]+)?(${keys.join('|')})[ \\t]*=[ \\t]*\\S`, 'm');
  return re.test(String(text ?? ''));
}

/** `systemctl is-enabled` output, as words. */
const enabledWord = (en) => (!en || en === 'not-found' ? 'not installed' : en);
const sameText = (a, b) => String(a ?? '').replace(/\s+$/, '') === String(b ?? '').replace(/\s+$/, '');

/* ------------------------------------------------------------ the box --- */

/**
 * Which box this is, and the facts every probe shares. Reads only.
 *
 * role:
 *   active   whatsapp-bot.service is running here: this box runs the bot
 *   standby  a bot box whose bot is not running (the unit or .env is here)
 *   dev      neither: a development clone, where nothing is checked
 */
export async function inspectBox(sys, { appDir, role: forcedRole = null } = {}) {
  const shown = parseShow((await sys.run('systemctl', ['show', 'whatsapp-bot.service',
    '-p', 'LoadState', '-p', 'ActiveState', '-p', 'UnitFileState', '-p', 'FragmentPath',
    '-p', 'WorkingDirectory', '-p', 'ExecStart'], { timeoutMs: 15_000 })).stdout);
  const loaded = shown.LoadState === 'loaded';
  const text = loaded && shown.FragmentPath ? sys.readFile(shown.FragmentPath) : null;
  const unit = {
    loaded,
    // An empty unit file, or one linked to /dev/null, is "masked": systemd
    // will not start it, even by hand. bot-box2 had an empty, root-owned
    // whatsapp-bot.service (2026-09-29), and this check called it "not
    // installed", which sent everybody looking for a file that was there.
    masked: shown.LoadState === 'masked' || shown.UnitFileState === 'masked',
    activeState: shown.ActiveState || 'unknown',
    active: ['active', 'activating', 'reloading'].includes(shown.ActiveState),
    enabled: shown.UnitFileState || 'unknown',
    fragment: shown.FragmentPath || null,
    workdir: loaded ? (shown.WorkingDirectory || null) : null,
    node: /path=([^ ;]+)/.exec(shown.ExecStart ?? '')?.[1] ?? null,
    user: /^User=(.*)$/m.exec(text ?? '')?.[1]?.trim() ?? null,
    group: /^Group=(.*)$/m.exec(text ?? '')?.[1]?.trim() ?? null,
    text,
  };
  const liveDir = unit.workdir || appDir;
  const isLive = sys.realpath(appDir) === sys.realpath(liveDir);

  let role;
  let roleWhy;
  if (forcedRole) {
    role = forcedRole;
    roleWhy = `given with --role ${forcedRole}`;
  } else if (unit.active) {
    role = 'active';
    roleWhy = `whatsapp-bot.service is ${unit.activeState} here, so this box RUNS the bot`;
  } else if (unit.loaded || unit.masked || sys.exists(path.join(liveDir, '.env'))) {
    role = 'standby';
    roleWhy = unit.loaded
      ? `whatsapp-bot.service is installed here but ${unit.activeState}: a standby box, as far as the routines go`
      : unit.masked
        ? 'whatsapp-bot.service is masked here, so it cannot run: a standby box, as far as the routines go'
        : 'this checkout has a .env but no whatsapp-bot.service: a standby box, as far as the routines go';
  } else {
    role = 'dev';
    roleWhy = 'no whatsapp-bot.service and no .env: a development clone, not a bot box';
  }

  const cron = await sys.run('crontab', ['-l'], { timeoutMs: 15_000 });
  const crontab = cron.code === 0 ? cron.stdout : /no crontab for/i.test(cron.stderr) ? '' : null;
  const sudoOk = (await sys.run('sudo', ['-n', 'true'], { timeoutMs: 15_000 })).code === 0;
  // The one rule deploy/install-hourly-debug.sh keeps when it narrows sudo
  // (its step 3): all the hourly check needs, and an accepted choice.
  const restartCmd = [(sys.env ?? {}).HOURLY_DEBUG_SYSTEMCTL || '/usr/bin/systemctl', 'restart', (sys.env ?? {}).HOURLY_DEBUG_UNIT || 'whatsapp-bot'];
  const sudoRestartOk = sudoOk || (await sys.run('sudo', ['-n', '-l', ...restartCmd], { timeoutMs: 15_000 })).code === 0;

  return {
    appDir, liveDir, isLive, role, roleWhy, unit, crontab, sudoOk, sudoRestartOk, restartCmd,
    // { release, distro } on WSL, null elsewhere (src/core/wsl.js).
    wsl: detectWsl(sys),
    config: parseJson(sys.readFile(path.join(liveDir, 'data', 'config.json'))),
    skips: readSkips(sys, liveDir),
    user: sys.user, home: sys.home, host: sys.host, env: sys.env ?? {}, now: sys.now(),
  };
}

export function readSkips(sys, dir) {
  const raw = parseJson(sys.readFile(path.join(dir, SKIP_FILE)));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [id, v] of Object.entries(raw)) {
    if (v && typeof v === 'object') out[id] = { reason: String(v.reason ?? '').slice(0, 300), at: v.at ?? null };
  }
  return out;
}

/* ------------------------------------------------------- the registry --- */

const hourlyEnvFile = (ctx) => ctx.env.HOURLY_DEBUG_ENV_FILE || path.join(ctx.home, '.config', 'whatsapp-bot', 'hourly-debug.env');
const claudeBin = (ctx) => ctx.env.HOURLY_DEBUG_CLAUDE_BIN || path.join(ctx.home, '.local', 'bin', 'claude');
const unitsFix = (ctx, piece) => step(['bash', path.join(ctx.liveDir, 'deploy', 'install-units.sh'), '--non-interactive', piece],
  { display: `deploy/install-units.sh ${piece}`, sudo: true, timeoutMs: 300_000 });

const wslFix = (ctx, piece, { sudo = true } = {}) => step(['bash', path.join(ctx.liveDir, 'deploy', 'wsl-setup.sh'), '--non-interactive', piece],
  { display: `deploy/wsl-setup.sh ${piece}`, sudo, timeoutMs: 300_000 });
const notWsl = () => ({ state: 'n/a', detail: ['not WSL: this box is a machine or VM of its own'] });

/**
 * tailscale-ssh on WSL. The Windows Tailscale client is the tailnet node for
 * the laptop, and in mirrored networking WSL shares its addresses, so what
 * this box must have is an sshd those addresses reach - on 2222, since
 * Windows holds 22. A Linux tailscaled as well fights the Windows one over
 * the 100.x routes (wsl-vm-units turns it off).
 */
async function wslSsh(sys, ctx) {
  const off = [];
  if (!/^\s*Port\s+2222\s*$/m.test(sys.readFile(SSHD_PORT_FILE) ?? '')) off.push(`${SSHD_PORT_FILE} does not set Port ${SSH_PORT}`);
  if (!new RegExp(`ListenStream=\\S*:${SSH_PORT}\\s*$`, 'm').test(sys.readFile(SSH_SOCKET_DROPIN) ?? '')) {
    off.push(`${SSH_SOCKET_DROPIN} does not move ssh.socket to ${SSH_PORT}`);
  }
  const ss = await sys.run('ss', ['-ltnH'], { timeoutMs: 15_000 });
  const listening = ss.code === 0 && listensOn(ss.stdout, SSH_PORT);
  if (!listening) off.push(`nothing listens on port ${SSH_PORT}: the box cannot be reached over SSH`);
  const how = `ssh -p ${SSH_PORT} ${ctx.user}@<the laptop's Tailscale name or LAN address>   (the Windows Tailscale client is the tailnet node; `
    + `Windows' own firewall may need: New-NetFirewallHyperVRule -Name wsl-ssh -DisplayName "WSL SSH" -Direction Inbound `
    + `-VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -Protocol TCP -LocalPorts ${SSH_PORT})`;
  if (off.length) return missing(off, [wslFix(ctx, 'ssh')], [how]);
  return ok([`WSL: sshd listens on ${SSH_PORT}, as ${SSHD_PORT_FILE} and the ssh.socket drop-in set; reach it with ${how}`]);
}

/* ------------------------------------------------ the Cloudflare tunnel --- */

/**
 * The name the tunnel's token has in .env, where the sealed backup carries it
 * (deploy/install-cloudflared.sh writes it). Not TUNNEL_TOKEN: cloudflared
 * reads that from its own environment.
 */
export const TUNNEL_ENV_KEY = 'CLOUDFLARE_TUNNEL_TOKEN';
export const TUNNEL_TOKEN_FILE = '/etc/cloudflared/tunnel-token';
/**
 * deploy/install-cloudflared.sh's note that the token it adopted had been on
 * a command line - a container's, or the unit Cloudflare's service install
 * writes - and so is in sudo's log of that command. It stays until
 * --new-token brings a different token.
 */
export const TUNNEL_EXPOSED_FILE = '/etc/cloudflared/token-exposed';
const tunnelFix = (ctx, ...args) => step(['bash', path.join(ctx.liveDir, 'deploy', 'install-cloudflared.sh'), '--non-interactive', ...args],
  { display: ['deploy/install-cloudflared.sh', ...args].join(' '), sudo: true, timeoutMs: 600_000 });

/**
 * How a cloudflared unit gets its token, from its ExecStart and Environment:
 * 'inline' (on its command line, as Cloudflare's own `cloudflared service
 * install <token>` writes it), 'file' (--token-file, as
 * deploy/install-cloudflared.sh does) or 'config' (a locally-managed tunnel,
 * with a config file and a credentials file). Never the token itself: the
 * text it reads holds it, and nothing of that text is ever reported.
 */
export function tunnelTokenStyle(text) {
  const t = String(text ?? '');
  if (/(^|\s)--token(\s+|=)[^\s-]|(^|[^\w])TUNNEL_TOKEN=\S/.test(t)) return 'inline';
  if (/--token-file/.test(t)) return 'file';
  return 'config';
}

/**
 * The token in a list of words - a command line, or a unit's ExecStart and
 * Environment split on spaces - or null. Only ever compared with .env's,
 * inside the function that asked: never kept in what a probe returns, and
 * never reported.
 */
function tokenIn(words) {
  let t = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if ((w === '--token' || w === '-token') && i + 1 < words.length) t = words[i + 1];
    else if (/^--?token=/.test(w)) t = w.slice(w.indexOf('=') + 1);
    else if (w.startsWith('TUNNEL_TOKEN=')) t = w.slice('TUNNEL_TOKEN='.length);
  }
  return t || null;
}

/** A KEY's value in env-file text, as dotenv reads it (the last line wins, one pair of quotes off), or null. */
function envValue(text, key) {
  let val = null;
  for (const line of String(text ?? '').split('\n')) {
    const m = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*?)\\s*$`).exec(line);
    if (m) val = /^(['"`]).*\1$/.test(m[1]) && m[1].length >= 2 ? m[1].slice(1, -1) : m[1];
  }
  return val || null;
}

const CF_SUBCOMMANDS = ['tunnel', 'proxy-dns', 'access', 'update', 'service', 'version', 'login'];
/** What cloudflared does as a tunnel connector: a tunnel, or a process whose command line could not be read. */
const CONNECTOR_KINDS = new Set(['tunnel', 'unknown']);

/**
 * What a cloudflared process is, from its command line (argv, or null when
 * it cannot be read): 'tunnel' (a connector), 'proxy-dns' (a DNS-over-HTTPS
 * proxy), 'access' (a client, an ssh ProxyCommand), 'update', 'service',
 * 'version', 'login', 'other', or 'unknown'. The first version took every
 * cloudflared for a tunnel connector, so a Pi-hole's DNS proxy beside the
 * service was "the incident" and a --fix that could never succeed, and an
 * `ssh` through Cloudflare Access was a stray connector to kill (review,
 * 2026-09-30).
 */
export function cloudflaredKind(argv) {
  if (!argv || !argv.length) return 'unknown';
  const sub = argv.slice(1).find((a) => CF_SUBCOMMANDS.includes(a));
  if (sub) return sub;
  // cloudflared's old way: a tunnel from flags alone (--hostname, --url).
  return argv.some((a) => /^--?(hostname|url)(=|$)/.test(a)) ? 'tunnel' : 'other';
}

/**
 * The interface names in /proc/<pid>/net/dev, which any user may read: which
 * network a process is on. A container on Docker's bridge has lo and eth0 of
 * its own, while the box has docker0 and a veth for it besides; one run with
 * --network host sees exactly the box's. (/proc/<pid>/ns/net would say it
 * outright, but only to root.)
 */
const netIfaces = (text) => (text == null ? null
  : String(text).split('\n').slice(2).map((l) => /^\s*([^:\s]+):/.exec(l)?.[1]).filter(Boolean).sort().join(','));

/**
 * Every cloudflared running on this box, from /proc: its comm, its cgroup,
 * which says whether it runs in a container (and which), in
 * cloudflared.service, or anywhere else, and its command line, for what it
 * does. All three are readable by any user, so this needs no root - `docker
 * ps` does. A container's command line holds its token: it is compared with
 * `known` (.env's) and then dropped, so what comes back says only whether the
 * two are the same (sameAsEnv: null when either is not known) and whether
 * the token is on the command line at all.
 */
export function cloudflaredProcesses(sys, { known = null } = {}) {
  const out = [];
  for (const pid of (sys.readdir('/proc') ?? []).filter((d) => /^\d+$/.test(d))) {
    if (String(sys.readFile(`/proc/${pid}/comm`) ?? '').trim() !== 'cloudflared') continue;
    const cgroup = String(sys.readFile(`/proc/${pid}/cgroup`) ?? '');
    const leaf = cgroup.split('\n').map((l) => l.split(':').slice(2).join(':')).find(Boolean) ?? '';
    const raw = sys.readFile(`/proc/${pid}/cmdline`);
    const argv = raw == null ? null : String(raw).split('\0').filter(Boolean);
    const tok = argv ? tokenIn(argv) : null;
    const docker = /docker[-/]([0-9a-f]{12,64})/.exec(cgroup);
    const contained = !!docker || /containerd|libpod|kubepods|\/lxc[./]/.test(cgroup);
    let hostNet = null;
    if (contained) {
      const mine = netIfaces(sys.readFile(`/proc/${pid}/net/dev`));
      const host = netIfaces(sys.readFile('/proc/self/net/dev'));
      if (mine && host) hostNet = mine === host;
    }
    out.push({
      pid, kind: cloudflaredKind(argv), docker: !!docker, id: docker ? docker[1].slice(0, 12) : null, hostNet, unit: path.basename(leaf),
      where: contained ? 'container' : /\/cloudflared\.service$/m.test(cgroup) ? 'service' : 'other',
      tokenOnArgv: !!tok, sameAsEnv: tok && known ? tok === known : null,
    });
  }
  return out;
}

/** What the tunnel routine looks at, on any box. */
async function inspectTunnel(sys, ctx) {
  const shown = parseShow((await sys.run('systemctl', ['show', 'cloudflared.service', '-p', 'LoadState', '-p', 'ActiveState',
    '-p', 'SubState', '-p', 'UnitFileState', '-p', 'ExecStart', '-p', 'Environment'], { timeoutMs: 15_000 })).stdout);
  const loaded = shown.LoadState === 'loaded';
  const envText = sys.readFile(path.join(ctx.liveDir, '.env'));
  const envTok = envValue(envText, TUNNEL_ENV_KEY);
  const unitText = `${shown.ExecStart ?? ''}\n${shown.Environment ?? ''}`;
  const unitTok = loaded ? tokenIn(unitText.split(/\s+/)) : null;
  const unit = {
    loaded,
    // Masked: somebody's decision that it must not run, which --fix does
    // not overrule; the script would write through the mask to /dev/null
    // and fail at enable (review, 2026-09-30).
    masked: shown.LoadState === 'masked' || /^masked/.test(shown.UnitFileState ?? ''),
    active: shown.ActiveState === 'active',
    state: shown.ActiveState || 'unknown',
    sub: shown.SubState || '',
    enabled: shown.UnitFileState || 'unknown',
    style: loaded ? tunnelTokenStyle(unitText) : null,
    bin: /path=([^ ;]+)/.exec(shown.ExecStart ?? '')?.[1] ?? null,
    sameAsEnv: unitTok && envTok ? unitTok === envTok : null,
  };
  // cloudflared doing something other than serving a tunnel - a DNS proxy,
  // an Access client, the updater Cloudflare's service install adds - is
  // none of this routine's business.
  const procs = cloudflaredProcesses(sys, { known: envTok })
    .filter((p) => CONNECTOR_KINDS.has(p.kind) && p.unit !== 'cloudflared-update.service');
  const st = sys.stat(TUNNEL_TOKEN_FILE);
  const exposed = sys.exists(TUNNEL_EXPOSED_FILE) ? (String(sys.readFile(TUNNEL_EXPOSED_FILE) ?? '').split('\n')[0].trim() || 'taken from a command line') : null;
  return {
    unit,
    containers: procs.filter((p) => p.where === 'container'),
    // In cloudflared.service's cgroup while systemd knows no such unit is
    // no service anyone can see either.
    loose: procs.filter((p) => p.where === 'other' || (p.where === 'service' && !loaded)),
    envExists: envText != null,
    envToken: !!envTok,
    tokenFile: !!st,
    // /etc/cloudflared is 0755, so its mode can be seen without reading it.
    tokenFileMode: st && (st.mode & 0o077) ? st.mode : null,
    exposed,
  };
}

/**
 * The claude-session routine's pieces, read as the user with no root:
 * { linger, tmux, enabled, running, renderFailed, off[] (what --fix puts
 * right), detail[] }. The unit and the hook are compared with what this
 * checkout's deploy/claude-session.sh prints, as the installer writes them,
 * so an older copy of either counts as missing.
 */
async function claudeSessionState(sys, ctx) {
  const launcher = path.join(ctx.liveDir, 'deploy', 'claude-session.sh');
  const configHome = ctx.env.XDG_CONFIG_HOME || path.join(ctx.home, '.config');
  const unitDir = path.join(configHome, 'systemd', 'user');
  const unitFile = path.join(unitDir, 'claude-session.service');
  const off = [];
  const detail = [];
  let renderFailed = false;

  const tmux = !!sys.which('tmux');
  if (!tmux) off.push('tmux is not installed');

  const lingerShow = await sys.run('loginctl', ['show-user', ctx.user, '-p', 'Linger'], { timeoutMs: 15_000 });
  const linger = /^Linger=yes$/m.test(lingerShow.stdout ?? '') || sys.exists(path.join('/var/lib/systemd/linger', ctx.user));
  if (!linger) off.push(`linger is off for ${ctx.user}: after a reboot the user's units wait for somebody to log in`);

  const unit = await sys.run('bash', [launcher, 'unit'], { timeoutMs: 15_000 });
  const have = sys.readFile(unitFile);
  if (unit.code !== 0 || !unit.stdout.trim()) {
    renderFailed = true;
    off.push(`deploy/claude-session.sh unit failed: ${String(unit.stderr ?? '').trim().split('\n').pop() || `exit ${unit.code}`}`);
  } else if (have == null) off.push(`${unitFile} is not there`);
  else if (!sameText(have, unit.stdout)) off.push(`${unitFile} differs from what this checkout writes`);

  // What `systemctl --user enable` makes for WantedBy=default.target, read
  // without a user bus to ask (cron and a bare `sudo -u` have none).
  const enabled = sys.exists(path.join(unitDir, 'default.target.wants', 'claude-session.service'));
  if (!enabled) off.push('not enabled at boot');

  const hook = await sys.run('bash', [launcher, 'hook'], { timeoutMs: 15_000 });
  const rc = sys.readFile(path.join(ctx.home, '.bashrc')) ?? '';
  const begin = String(hook.stdout ?? '').split('\n')[0];
  if (hook.code !== 0 || !begin) off.push('deploy/claude-session.sh hook failed');
  else if (!rc.includes(String(hook.stdout).replace(/\n+$/, ''))) {
    off.push(rc.includes(begin) ? 'the hook in ~/.bashrc differs from this checkout\'s' : 'no hook in ~/.bashrc: an SSH login is not told about the session, and there is no claude-attach');
  }

  if (!sys.exists(path.join(ctx.home, '.local', 'bin', 'claude'))) detail.push('Claude Code is not at ~/.local/bin/claude (see claude-code)');
  const running = tmux && (await sys.run('tmux', ['has-session', '-t', '=claude'], { timeoutMs: 15_000 })).code === 0;
  if (!off.length) detail.push(`linger on, enabled at boot, SSH logins are told about it; ${running ? 'running now (claude-attach, or tmux attach -t claude)' : 'not running now'}`);
  const log = sys.readFile(path.join(ctx.env.XDG_STATE_HOME || path.join(ctx.home, '.local', 'state'), 'whatsapp-bot', 'claude-session.log'));
  const last = String(log ?? '').trim().split('\n').pop();
  if (last) detail.push(`its log, last line: ${last.slice(0, 240)}`);
  return { linger, tmux, enabled, running, renderFailed, off, detail };
}

const idsOf = (list) => list.map((p) => p.id ?? `pid ${p.pid}`).join(', ');
const REPLICAS = 'two connectors on one token are replicas of one tunnel, and Cloudflare sends each visit to either';
const ROTATE = 'rotate it: in the Cloudflare dashboard, Networking -> Tunnels -> the tunnel -> Rotate token; then '
  + 'deploy/install-cloudflared.sh --new-token, and paste the new one (docs/server-setup.md, section 7)';

/** What an in-process routine reports: it runs with the bot, and its switch. */
function inProcess(describe = () => null) {
  return async (sys, ctx) => {
    const detail = [ctx.unit.active ? 'runs inside the bot, which is running here' : 'runs inside the bot, which is not running on this box'];
    const setting = ctx.config ? describe(ctx.config) : null;
    if (setting) detail.push(setting);
    return { state: 'in-process', detail };
  };
}

export const ROUTINES = [
  /* ---------------------------------------------------- every bot box --- */
  {
    id: 'sudo',
    scope: 'every',
    title: 'Passwordless sudo for the bot\'s user',
    why: 'Claude Code manages the box as this user and cannot type a password: without it every package install, unit change '
      + 'and restart waits for a person, and a sudo that asks hangs the session.',
    check: 'sudo -n true',
    install: 'tools/bootstrap.sh offers it; by hand, the one command in docs/server-setup.md, "Give Claude Code sudo"',
    userStep: `once, with your password: ${SUDO_COMMAND}`,
    bootstrap: true,
    files: [],
    async probe(sys, ctx) {
      if (ctx.sudoOk) return ok([`sudo -n works for ${ctx.user}`]);
      // Narrowed by deploy/install-hourly-debug.sh (step 3) to the one
      // restart the hourly check makes. That is a choice the installer
      // offers, not a fault: asking for NOPASSWD:ALL back here undid it,
      // and full sudo is what makes a way out of the check's sandbox root.
      if (ctx.sudoRestartOk) {
        return ok([`sudo is narrowed to the one rule the hourly check needs (${ctx.restartCmd.join(' ')}) - `
          + 'an accepted choice; anything else that takes sudo waits for a person']);
      }
      return needsUser([`sudo asks ${ctx.user} for a password, which Claude Code cannot type`],
        [`${SUDO_COMMAND}   (once, as ${ctx.user}; it asks for the password one last time)`]);
    },
  },
  {
    id: 'gh-auth',
    scope: 'every',
    title: 'GitHub CLI logged in, git using its login, and an identity to commit with',
    why: 'The repository is private: the auto-updater, the hourly check\'s pushes and the sealed backup all reach GitHub '
      + 'through gh\'s login. The token itself is never backed up. And every fix a session makes lands as a commit, '
      + 'which fails with "Author identity unknown" on a box with no git identity, as bot-box2\'s first one did.',
    check: 'gh auth status && git config --global --get-all credential.https://github.com.helper && '
      + 'git -C <checkout> config user.name && git -C <checkout> config user.email',
    install: 'gh auth setup-git, and git config --global user.name/user.email from the last commit on origin/main '
      + '(tools/bootstrap.sh does both)',
    userStep: 'gh auth login   (GitHub.com, HTTPS, authenticate git: Yes, web browser)',
    bootstrap: true,
    files: [],
    async probe(sys, ctx) {
      if (!sys.which('gh')) {
        return needsUser(['gh is not installed'],
          ['tools/bootstrap.sh installs it; by hand, docs/server-setup.md "Fast path" step 1, then: gh auth login']);
      }
      if ((await sys.run('gh', ['auth', 'status'], { timeoutMs: 20_000 })).code !== 0) {
        return needsUser(['gh is not logged in: nothing can pull, push or back up to the private repository'],
          ['gh auth login   (GitHub.com, HTTPS, authenticate git: Yes, web browser)']);
      }
      const off = [];
      const fix = [];
      const helper = await sys.run('git', ['config', '--global', '--get-all', 'credential.https://github.com.helper']);
      if (!/gh auth git-credential/.test(helper.stdout)) {
        off.push('gh is logged in, but git does not use its login yet');
        fix.push(step(['gh', 'auth', 'setup-git']));
      }
      // Global or in the checkout, either will do: bot-box's was in the
      // checkout's own .git/config. None at all is bot-box2 on 2026-09-29.
      const get = async (k) => (await sys.run('git', ['-C', ctx.liveDir, 'config', '--get', k])).stdout.trim();
      const [name, email] = [await get('user.name'), await get('user.email')];
      if (!name || !email) {
        // The repository owner, as tools/hourly-debug.mjs sets for its clone.
        const who = await sys.run('git', ['-C', ctx.liveDir, 'log', '-1', '--format=%an%n%ae', 'origin/main']);
        const [an, ae] = who.code === 0 ? who.stdout.trim().split('\n') : [];
        const detail = 'git has no identity here, so a commit on this box fails with "Author identity unknown"';
        if (!an || !ae) {
          return needsUser([...off, detail],
            ['git config --global user.name "<name>" && git config --global user.email "<address>"   (the repository owner\'s)']);
        }
        off.push(`${detail}; it takes the repository owner's, ${an} <${ae}>, from the last commit on main`);
        fix.push(step(['git', 'config', '--global', 'user.name', an]), step(['git', 'config', '--global', 'user.email', ae]));
      }
      if (off.length) return missing(off, fix);
      return ok([`gh is logged in, git uses its login, and commits as ${name} <${email}>`]);
    },
  },
  {
    id: 'packages',
    scope: 'every',
    title: 'Node 20+, ffmpeg, the npm dependencies, and cron running',
    why: 'Every film is probed and encoded with ffmpeg/ffprobe; the hourly check and the nightly backup are cron lines, '
      + 'which do nothing while cron is stopped; the sandbox needs python3.',
    check: 'node --version; command -v ffmpeg ffprobe git python3 flock crontab curl; systemctl is-active cron',
    install: './install.sh (tools/bootstrap.sh runs it); a missing apt package: sudo apt-get install -y <package>',
    userStep: 'only when Node or the npm dependencies are missing: ./install.sh',
    bootstrap: true,
    files: ['install.sh'],
    async probe(sys, ctx) {
      const detail = [];
      const next = [];
      const apt = new Set();
      for (const [bin, pkg] of [['ffmpeg', 'ffmpeg'], ['ffprobe', 'ffmpeg'], ['git', 'git'], ['python3', 'python3'],
        ['flock', 'util-linux'], ['crontab', 'cron'], ['curl', 'curl']]) {
        if (!sys.which(bin)) { apt.add(pkg); detail.push(`${bin} is not installed`); }
      }
      const node = ctx.unit.node || sys.execPath;
      const v = await sys.run(node, ['--version']);
      const major = Number(/^v(\d+)/.exec(v.stdout.trim())?.[1]);
      if (v.code !== 0 || !(major >= 20)) {
        detail.push(v.code !== 0 ? `${node} does not run` : `${node} is ${v.stdout.trim()}; the bot needs Node 20 or newer`);
        next.push('./install.sh   (Node 20 from NodeSource, ffmpeg, the npm dependencies)');
      }
      const pkg = parseJson(sys.readFile(path.join(ctx.liveDir, 'package.json')));
      const absent = Object.keys(pkg?.dependencies ?? {})
        .filter((d) => !sys.exists(path.join(ctx.liveDir, 'node_modules', d, 'package.json')));
      if (absent.length) {
        detail.push(`npm dependencies missing from ${ctx.liveDir}/node_modules: ${absent.join(', ')}`);
        // Not --fix: replacing node_modules under a running bot gives it a
        // mix of old and new code at its next require.
        next.push(`cd ${q(ctx.liveDir)} && npm ci --omit=dev${ctx.unit.active ? ', then restart the bot at a quiet moment' : ''}`);
      }
      const cronUp = (await sys.run('systemctl', ['is-active', 'cron'])).stdout.trim() === 'active';
      const fix = [];
      if (apt.size) fix.push(step(['sudo', '-n', 'apt-get', 'install', '-y', ...apt], { display: `sudo apt-get install -y ${[...apt].join(' ')}`, sudo: true, timeoutMs: 900_000 }));
      if (!cronUp) {
        detail.push('cron is not running: no cron line on this box ever fires');
        fix.push(step(['sudo', '-n', 'systemctl', 'enable', '--now', 'cron'], { display: 'sudo systemctl enable --now cron', sudo: true }));
      }
      if (fix.length) return missing(detail, fix, next);
      if (next.length) return needsUser(detail, next);
      return ok([`${node} ${v.stdout.trim()}, ffmpeg and ffprobe, the npm dependencies, cron running`]);
    },
  },
  {
    id: 'claude-code',
    scope: 'every',
    title: 'Claude Code on the box',
    why: 'So a session can work on the box directly, and because the hourly check researches with headless Claude Code '
      + 'from ~/.local/bin/claude.',
    check: '~/.local/bin/claude --version',
    install: 'curl -fsSL https://claude.ai/install.sh | bash   (docs/server-setup.md, section 8; no root)',
    userStep: null,
    bootstrap: true,
    files: [],
    async probe(sys, ctx) {
      const bin = claudeBin(ctx);
      if (sys.exists(bin)) {
        const v = await sys.run(bin, ['--version'], { timeoutMs: 20_000 });
        return ok([`${bin}${v.code === 0 ? ` (${v.stdout.trim().split('\n')[0]})` : ''}`]);
      }
      const other = sys.which('claude');
      return missing([other
        ? `Claude Code is at ${other}, not ${bin} where the hourly check runs it`
        : 'Claude Code is not installed'],
      [step(['bash', '-c', 'set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash'],
        { display: 'curl -fsSL https://claude.ai/install.sh | bash', timeoutMs: 600_000 })]);
    },
  },
  {
    id: 'yt-dlp',
    scope: 'every',
    title: 'yt-dlp and deno, for public links that are video pages (YouTube)',
    why: '"Queue a public link" reads the video out of a YouTube page with yt-dlp: on 2026-10-11 a YouTube link was refused '
      + 'as "a web page (text/html)", and the operator asked to "add ytdlp and whatever else needed to the bot system". '
      + 'yt-dlp needs a JavaScript runtime for YouTube - deno, since it takes node only from 22 and the bot runs on 20 - and '
      + 'YouTube breaks an old yt-dlp within weeks, so the bot updates it daily (yt-dlp-update) and this flags one whose last '
      + 'update check is three days old, or whose release is four months old.',
    check: `${YTDLP_HOME_BIN} --version; ${DENO_HOME_BIN} --version (${MIN_DENO} or newer); the last update check in `
      + '~/.local/state/whatsapp-bot/yt-dlp.json no more than 3 days old',
    install: 'node tools/install-yt-dlp.mjs   (no root: the official yt-dlp zipapp into ~/.local/bin/yt-dlp, run by python3, and '
      + 'deno into ~/.deno/bin, each checked against its release\'s SHA-256; --update updates yt-dlp, never under a running download)',
    userStep: null,
    bootstrap: true,
    files: ['tools/install-yt-dlp.mjs'],
    async probe(sys, ctx) {
      const paths = ytDlpPaths({ home: ctx.home, env: ctx.env });
      const node = ctx.unit.node || sys.execPath;
      const fix = (...args) => [step([node, path.join(ctx.liveDir, 'tools', 'install-yt-dlp.mjs'), ...args],
        { display: ['node tools/install-yt-dlp.mjs', ...args].join(' '), timeoutMs: 600_000 })];
      if (!sys.exists(paths.bin)) {
        return missing([`yt-dlp is not installed (${paths.bin}): a YouTube link on "Queue a public link" is refused`], fix());
      }
      const v = await sys.run(paths.bin, ['--version'], { timeoutMs: 60_000 });
      const version = v.code === 0 ? v.stdout.trim().split('\n')[0] : null;
      if (!/^\d{4}\.\d{2}\.\d{2}/.test(version ?? '')) {
        return missing([`${paths.bin} does not run (${String(v.stderr ?? '').trim().split('\n').pop() || `exit ${v.code}`}): `
          + 'python3 missing, or a damaged file'], fix());
      }
      const dv = sys.exists(paths.deno) ? await sys.run(paths.deno, ['--version'], { timeoutMs: 60_000 }) : null;
      const deno = dv?.code === 0 ? /^deno (\d+\.\d+\.\d+)/m.exec(dv.stdout)?.[1] ?? null : null;
      if (!deno || !versionAtLeast(deno, MIN_DENO)) {
        return missing([deno ? `deno ${deno} is older than the ${MIN_DENO} yt-dlp needs` : `deno is not installed (${paths.deno}): `
          + 'without a JavaScript runtime yt-dlp warns that YouTube formats may be missing'], fix());
      }
      const stamp = parseJson(sys.readFile(paths.stamp));
      const at = Date.parse(stamp?.at ?? '');
      const age = releaseAgeDays(version, ctx.now);
      const head = `yt-dlp ${version}${age != null ? ` (released ${age} days ago)` : ''} at ${paths.bin}, deno ${deno} at ${paths.deno}`;
      const off = [];
      if (!Number.isFinite(at)) off.push('no update check has been recorded');
      else if (ctx.now - at > STALE_AFTER_MS) off.push(`the last update check was ${ago(ctx.now - at)} (${fmtAt(at)}): the bot updates it daily while it runs`);
      else if (!stamp.ok) off.push(`the last update check, ${fmtAt(at)}, failed: ${String(stamp.error ?? '?').slice(0, 200)}`);
      if (age != null && age > MAX_RELEASE_AGE_DAYS) off.push(`its release is ${age} days old: YouTube will have changed since`);
      if (off.length) return missing([head, ...off], fix('--update'));
      return ok([head, `last update check ${fmtAt(at)}${stamp.updated ? ', which updated it' : ', up to date'} (by ${stamp.by ?? '?'})`]);
    },
  },
  {
    id: 'tailscale-ssh',
    scope: 'every',
    title: 'Tailscale SSH, operator set, auto-update on',
    why: 'Tailscale SSH is how the Claude desktop app reaches the box. The node\'s identity is never backed up: '
      + 'a new box joins as a new node.',
    check: 'tailscale status && tailscale debug prefs   (RunSSH, OperatorUser, AutoUpdate.Apply); on WSL, sshd listening on '
      + `port ${SSH_PORT} (ss -ltn), from ${SSHD_PORT_FILE} and the ssh.socket drop-in`,
    install: 'sudo tailscale set --ssh --operator=$USER --auto-update   (tools/bootstrap.sh also installs Tailscale and logs in); '
      + 'on WSL: deploy/wsl-setup.sh ssh',
    userStep: 'the login: sudo tailscale up --ssh --operator=$USER   (prints a link to open on any device)',
    bootstrap: true,
    files: [],
    async probe(sys, ctx) {
      if (ctx.wsl) return wslSsh(sys, ctx);
      const up = `sudo tailscale up --ssh --operator=${ctx.user}   (prints a login link to open on any device)`;
      if (!sys.which('tailscale')) {
        return needsUser(['Tailscale is not installed'],
          ['tools/bootstrap.sh installs it from Tailscale\'s apt repository; or: curl -fsSL https://tailscale.com/install.sh | sh', up]);
      }
      if ((await sys.run('tailscale', ['status'], { timeoutMs: 20_000 })).code !== 0) {
        return needsUser(['Tailscale is installed but not logged in (or not running)'], [up]);
      }
      const prefs = parseJson((await sys.run('tailscale', ['debug', 'prefs'], { timeoutMs: 20_000 })).stdout);
      if (!prefs) return ok(['logged in (its SSH setting could not be read: tailscale debug prefs)']);
      const off = [];
      if (prefs.RunSSH !== true) off.push('Tailscale SSH is off');
      if (prefs.OperatorUser !== ctx.user) off.push(`the operator is ${prefs.OperatorUser || 'nobody'}, not ${ctx.user}`);
      if (prefs.AutoUpdate?.Apply !== true) off.push('auto-update is off');
      if (off.length) {
        return missing(off, [step(['sudo', '-n', 'tailscale', 'set', '--ssh', `--operator=${ctx.user}`, '--auto-update'],
          { display: `sudo tailscale set --ssh --operator=${ctx.user} --auto-update`, sudo: true })]);
      }
      return ok([`logged in, SSH on, operator ${ctx.user}, auto-update on`]);
    },
  },
  {
    id: 'service-unit',
    scope: 'every',
    title: 'whatsapp-bot.service, updating itself before every start',
    why: 'systemd keeps the bot up and brings it back after a crash or reboot; the unit\'s ExecStartPre runs '
      + 'deploy/auto-update.sh, which is how every fix pushed to main reaches this box.',
    check: 'systemctl cat whatsapp-bot | grep -q deploy/auto-update.sh, and the installed unit matches '
      + 'deploy/render-whatsapp-bot-unit.sh\'s rendering of the repo\'s whatsapp-bot.service',
    install: 'deploy/install-units.sh whatsapp-bot   (renders it for this machine and installs it; never enables or starts it)',
    userStep: null,
    bootstrap: true,
    files: ['whatsapp-bot.service', 'deploy/render-whatsapp-bot-unit.sh', 'deploy/auto-update.sh', 'deploy/install-units.sh'],
    async probe(sys, ctx) {
      const u = ctx.unit;
      const fix = [unitsFix(ctx, 'whatsapp-bot')];
      if (u.masked) {
        const file = '/etc/systemd/system/whatsapp-bot.service';
        // `systemctl mask` leaves a link to /dev/null: somebody's decision
        // that this box must not run the bot, and undoing it is theirs.
        if (sys.realpath(file) === '/dev/null') {
          return needsUser([`whatsapp-bot.service is masked (${file} is a link to /dev/null, as systemctl mask leaves it): `
            + 'systemd will not start the bot, even by hand'],
          ['if that was not deliberate: sudo systemctl unmask whatsapp-bot, then deploy/install-units.sh whatsapp-bot   (installed disabled)']);
        }
        // An empty file is no decision - bot-box2's was, most likely left by a
        // `render | sudo tee` whose renderer failed, since tee empties the
        // file whatever it is given - and the installer simply writes over it.
        return missing([`whatsapp-bot.service is masked: ${file} is empty, and systemd will not start the bot, even by hand `
          + '(--fix writes the unit, disabled)'], fix);
      }
      if (!u.loaded) return missing(['whatsapp-bot.service is not installed on this box (--fix installs it disabled)'], fix);
      if (!u.text) return needsUser([`the installed unit (${u.fragment}) could not be read`], [`systemctl cat whatsapp-bot`]);
      if (u.node && !sys.exists(u.node)) {
        return needsUser([`the unit runs ${u.node}, which does not exist: the next start fails with 203/EXEC`],
          ['deploy/install-units.sh whatsapp-bot --node "$(command -v node)"', 'sudo systemctl restart whatsapp-bot   (at a quiet moment)']);
      }
      const later = ctx.unit.active ? ['it takes effect at the next start; --fix never restarts the bot'] : [];
      if (!/^ExecStartPre=-\/bin\/bash deploy\/auto-update\.sh\s*$/m.test(u.text)) {
        return missing(['the installed unit has no ExecStartPre= line for deploy/auto-update.sh: this box never updates itself', ...later], fix);
      }
      if (u.user && u.group && u.workdir && u.node) {
        const r = await sys.run('bash', [path.join(ctx.liveDir, 'deploy', 'render-whatsapp-bot-unit.sh'), u.user, u.group, u.workdir, u.node]);
        if (r.code === 0 && !sameText(r.stdout, u.text)) {
          return missing(['the installed unit differs from the repo\'s whatsapp-bot.service (a pulled commit changed it; '
            + 'docs/operations.md, "When the unit itself changes")', ...later], fix);
        }
      }
      const detail = [`installed, runs ${u.node ?? 'node'} from ${u.workdir}, updates itself before every start`];
      const au = parseJson(sys.readFile(path.join(ctx.liveDir, 'data', 'auto-update.json')));
      if (au?.result) detail.push(`last update check: ${au.result}${au.checkedAt ? ` at ${fmtAt(au.checkedAt)}` : ''}${au.reason ? ` - ${String(au.reason).slice(0, 160)}` : ''}`);
      return ok(detail);
    },
  },
  {
    id: 'grow-root-disk',
    scope: 'every',
    title: 'grow-root-disk: / grows into free disk space at every boot',
    why: 'The Ubuntu installer gave / half the disk on the first VM, and a film mid-encode needs room for the source and '
      + 'the output. Enlarging the virtual disk then needs nothing typed. A no-op on a root that is not on LVM.',
    check: 'systemctl is-enabled grow-root-disk.service, and /usr/local/sbin/grow-root-disk is deploy/grow-root-disk',
    install: 'deploy/install-units.sh grow-root-disk   (then, to grow now: sudo /usr/local/sbin/grow-root-disk)',
    userStep: null,
    bootstrap: true,
    files: ['deploy/grow-root-disk', 'deploy/grow-root-disk.service', 'deploy/install-units.sh'],
    async probe(sys, ctx) {
      // WSL's disk is a VHDX that Windows grows; a distro cloned from the VM
      // still has the unit, which wsl-vm-units turns off.
      if (ctx.wsl) return { state: 'n/a', detail: ['WSL: / is a VHDX Windows manages, not an LVM volume on a Hyper-V disk (see wsl-vm-units)'] };
      const off = [];
      if (!sameText(sys.readFile('/usr/local/sbin/grow-root-disk'), sys.readFile(path.join(ctx.liveDir, 'deploy', 'grow-root-disk')))) {
        off.push('/usr/local/sbin/grow-root-disk is missing or differs from deploy/grow-root-disk');
      }
      if (!sameText(sys.readFile('/etc/systemd/system/grow-root-disk.service'), sys.readFile(path.join(ctx.liveDir, 'deploy', 'grow-root-disk.service')))) {
        off.push('grow-root-disk.service is missing or differs from deploy/grow-root-disk.service');
      }
      const en = (await sys.run('systemctl', ['is-enabled', 'grow-root-disk.service'])).stdout.trim();
      if (en !== 'enabled') off.push(`grow-root-disk.service is ${enabledWord(en)}, not enabled at boot`);
      if (off.length) return missing(off, [unitsFix(ctx, 'grow-root-disk')], ['then, to grow / now: sudo /usr/local/sbin/grow-root-disk']);
      return ok(['installed, and enabled at boot']);
    },
  },
  {
    id: 'nic-offload',
    scope: 'every',
    title: 'Hyper-V NIC: segmentation offload off, at every boot',
    why: 'On a Hyper-V NIC (hv_netvsc) offload gave 29% TCP retransmits and 1.5 Mbit/s uploads; off gave 86 Mbit/s. '
      + 'ethtool\'s setting is lost at reboot, so a unit turns it off at every boot. Only on Hyper-V.',
    check: 'ethtool -k <nic> (tcp-/generic-segmentation-offload: off) and systemctl is-enabled <nic>-no-offload.service',
    install: 'deploy/install-units.sh nic-offload',
    userStep: null,
    bootstrap: true,
    files: ['deploy/eth0-no-offload.service', 'deploy/install-units.sh'],
    async probe(sys, ctx) {
      // WSL runs on the same Hyper-V NIC driver, and has the same fault: on
      // 2026-09-30 La La Land uploaded at 162 KB/s from WSL until tso and gso
      // were turned off on eth1 (the mirrored Wi-Fi), then at 5,176 KB/s. It
      // had been marked "not needed on WSL", which left uploads at the VM's old
      // 1.5 Mbit/s. So WSL is checked like any Hyper-V box: the default-route
      // NIC (eth1 there, not the VM's eth0) and its own -no-offload unit.
      const route = (await sys.run('ip', ['route', 'show', 'default'])).stdout;
      const iface = /\bdev\s+(\S+)/.exec(route)?.[1] ?? null;
      const driver = iface ? path.basename(sys.realpath(`/sys/class/net/${iface}/device/driver`) ?? '') : '';
      if (driver !== 'hv_netvsc') {
        return { state: 'n/a', detail: [`${iface ?? 'no default-route NIC'}${driver ? ` uses ${driver}` : ''}: not a Hyper-V NIC`] };
      }
      const unit = `${iface}-no-offload.service`;
      const off = [];
      const en = (await sys.run('systemctl', ['is-enabled', unit])).stdout.trim();
      if (en !== 'enabled') off.push(`${unit} is ${enabledWord(en)}: offload comes back on at the next boot, and uploads drop to ~1.5 Mbit/s`);
      const k = (await sys.run(sys.which('ethtool') ?? '/usr/sbin/ethtool', ['-k', iface])).stdout;
      if (/^(tcp|generic)-segmentation-offload: on/m.test(k)) off.push(`offload is on right now on ${iface}`);
      if (off.length) return missing(off, [unitsFix(ctx, 'nic-offload')]);
      return ok([`${iface} offload off, and ${unit} turns it off at every boot`]);
    },
  },

  /* --------------------------------------- the box that runs the bot --- */
  {
    id: 'start-at-boot',
    scope: 'active',
    title: 'The bot starts at boot - on the box that runs it, and only there',
    why: 'The box that runs the bot must come back after a reboot by itself. Any other box must NOT be enabled: its next '
      + 'reboot would start a second bot on the same number (connectionReplaced; CLAUDE.md, rule 3).',
    check: 'systemctl is-enabled whatsapp-bot, against whether it is running here',
    install: 'on the box that runs it: sudo systemctl enable whatsapp-bot   (it is running already; this only brings it back after a reboot)',
    userStep: 'a box enabled at boot while another runs the number: sudo systemctl disable whatsapp-bot',
    bootstrap: true,
    files: [],
    async probe(sys, ctx) {
      if (ctx.unit.enabled === 'enabled') return ok(['enabled at boot']);
      return missing([`running, but ${ctx.unit.enabled} at boot: after the next reboot it stays down`],
        [step(['sudo', '-n', 'systemctl', 'enable', 'whatsapp-bot.service'], { display: 'sudo systemctl enable whatsapp-bot', sudo: true })]);
    },
    async standby(sys, ctx) {
      if (ctx.unit.masked) {
        return { state: 'standby', detail: ['masked, so it cannot start at boot or by hand (see service-unit): '
          + 'nothing here would start a second bot, and this box cannot take the bot over until it is unmasked'] };
      }
      if (ctx.unit.enabled !== 'enabled') return { state: 'standby', detail: ['not enabled at boot, as a box that does not run the bot should be'] };
      return needsUser([`enabled at boot but ${ctx.unit.activeState} here: the next reboot starts it`,
        'if another machine runs this number, that is two bots on one session (CLAUDE.md, rule 3)'],
      ['sudo systemctl disable whatsapp-bot   (if another machine runs this number)',
        'journalctl -u whatsapp-bot -n 50   (if this is the box that runs it, and it stopped by itself)',
        'if THIS box should take over: docs/operations.md, "Handing the bot over to another machine"']);
    },
  },
  {
    id: 'hourly-check',
    scope: 'active',
    title: 'The hourly check: failed requests researched and fixed, every hour',
    why: 'A cron line runs tools/hourly-debug.mjs on the hour: it finds requests that failed or went unanswered, has headless '
      + 'Claude Code fix the code, ships what passes the suite, restarts the bot into it and emails a report. '
      + 'The line is a tick every minute, which runs the check at once when the bot asks for it - for a library keeper\'s '
      + '#issue, top priority by the operator\'s word (2026-10-12) - and otherwise does nothing. '
      + 'It needs a Claude token from `claude setup-token`.',
    check: 'crontab -l | grep whatsapp-bot-hourly-check; a token in ~/.config/whatsapp-bot/hourly-debug.env (600, folder 700); '
      + 'deploy/install-hourly-debug.sh --status',
    install: 'deploy/install-hourly-debug.sh   (the cron line and the settings file; with a token, one tiny test call in the sandbox)',
    userStep: '~/.local/bin/claude setup-token (a browser login), then deploy/install-hourly-debug.sh --set-token (reads the token hidden)',
    bootstrap: true,
    files: ['deploy/install-hourly-debug.sh', 'deploy/hourly-debug/', 'tools/hourly-debug.mjs'],
    async probe(sys, ctx) {
      const installer = step(['bash', path.join(ctx.liveDir, 'deploy', 'install-hourly-debug.sh')],
        { display: 'deploy/install-hourly-debug.sh', timeoutMs: 600_000 });
      if (ctx.crontab == null) return needsUser(['could not read this account\'s crontab (crontab -l failed)'], ['crontab -l']);
      const fixable = [];
      const user = [];
      const detail = [];
      const line = cronLineWith(ctx.crontab, HOURLY_TAG);
      const runSh = path.join(ctx.liveDir, 'deploy', 'hourly-debug', 'run.sh');
      const tickSh = path.join(ctx.liveDir, 'deploy', 'hourly-debug', 'tick.sh');
      const everyMinute = (l) => /^\*\s+\*\s+\*\s+\*\s+\*\s/.test(l.trim());
      if (!line) fixable.push('not in cron');
      else if (!line.includes(runSh) && !line.includes(tickSh)) fixable.push(`the cron line runs another checkout, not ${ctx.liveDir}`);
      // An older line opened its log before anything made the folder for
      // it: with the folder gone, every run failed at the redirect, silently.
      else if (!/mkdir -p \S+ && /.test(line)) fixable.push('the cron line does not make its log folder first, so it stops if that folder is removed');
      // The operator, 2026-10-12: "Needless to say #issue tickets submitted by
      // head admin 5558100180 get top priority" and "Meaning it should
      // activate bot to send yo a notification to check right away". The bot
      // asks by writing a file (src/core/check-now.js); only a tick every
      // minute sees it before the hour.
      else if (!everyMinute(line) || !/\/run\.sh --tick\b|\/tick\.sh\b/.test(line)) {
        fixable.push('the cron line runs on the hour only, so a library keeper\'s #issue waits for it');
      // Through tick.sh, which no checkout from before the tick has: an
      // older run.sh passed --tick on to a check that ignored it, a whole
      // run every minute (deploy/hourly-debug/tick.sh says more).
      } else if (!line.includes(tickSh)) {
        fixable.push('the cron line ticks through run.sh, which a checkout from before the tick would take for a whole run every minute');
      } else detail.push('in cron, every minute a tick: on the hour, and at once for a library keeper\'s #issue');

      const envFile = hourlyEnvFile(ctx);
      const st = sys.stat(envFile);
      const dirSt = sys.stat(path.dirname(envFile));
      if (!st) fixable.push(`${envFile} does not exist`);
      else if (st.mode !== 0o600) fixable.push(`${envFile} is mode ${st.mode.toString(8)}, not 600, and holds a login token`);
      if (dirSt && dirSt.mode !== 0o700) fixable.push(`${path.dirname(envFile)} is mode ${dirSt.mode.toString(8)}, not 700`);

      const bin = claudeBin(ctx);
      const tokenNext = [`${bin} setup-token   (a browser login; on this box, or any computer where you use Claude Code)`,
        `${path.join(ctx.liveDir, 'deploy', 'install-hourly-debug.sh')} --set-token   (paste the token: read hidden, saved mode 600, then one tiny test call)`];
      const hasToken = hasEnvKey(sys.readFile(envFile), ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
      // The installer's record of its last test call (install-hourly-debug.sh).
      // A failed test counts only until the settings file changes after it.
      const record = parseJson(sys.readFile(path.join(ctx.liveDir, 'data', 'hourly-debug', 'install.json')));
      const tokenFailed = hasToken && record?.verify === 'failed' && Date.parse(record.at) >= (st?.mtimeMs ?? 0);
      // 'no-sandbox': the installer could not test the token at all, because
      // the sandbox would not start (WSL, 2026-09-29). That is the sandbox's
      // problem, reported below, and not a reason to mint a new token.
      const tokenOk = hasToken && !tokenFailed;
      if (!hasToken) {
        user.push('no Claude token for cron: without it the check scans and reports, but never researches or fixes');
      } else if (tokenFailed) {
        user.push(`the token did not work when it was tested (${fmtAt(record.at)})`);
      } else {
        detail.push(`a Claude token is in ${envFile}${record?.verify === 'ok' ? `, tested ${fmtAt(record.at)}`
          : record?.verify === 'no-sandbox' ? ', not tested: the sandbox it is tested in would not start' : ''}`);
      }
      if (!sys.exists(bin)) detail.push(`Claude Code is not at ${bin} (see claude-code)`);

      const sandboxPy = path.join(ctx.liveDir, 'deploy', 'hourly-debug', 'sandbox.py');
      const abi = sys.exists(sandboxPy) ? await sys.run(sys.which('python3') ?? '/usr/bin/python3', [sandboxPy, '--abi']) : null;
      const sandboxNext = [];
      if (abi && !(Number(abi.stdout.trim()) >= 1)) {
        user.push('no Landlock sandbox here (python3 or the kernel): the research session is never started without it');
        sandboxNext.push(`HOURLY_DEBUG_FS_SANDBOX=0 in ${envFile} runs it with no_new_privs only - your call (docs/operations.md, "How far the sandbox goes")`);
      }
      // The doors Landlock leaves open - a UNIX socket (systemd-run --user),
      // a signal to the bot - tried from inside the sandbox, as every run does.
      const probe = sys.exists(sandboxPy) ? await sys.run(sys.which('python3') ?? '/usr/bin/python3', [sandboxPy, '--probe', String(process.pid)]) : null;
      const said = String(probe?.stdout ?? '').trim().split('\n').pop();
      if (probe?.code === 0 && said && said !== 'closed') {
        user.push(`the sandbox leaves ${said} open: the research session is never started while it does`);
        sandboxNext.push('docs/operations.md, "How far the sandbox goes"');
      } else if (probe?.code === 0 && said === 'closed') {
        // Which of the two: WSL gets the namespace one (2026-09-29).
        const kind = String((await sys.run(sys.which('python3') ?? '/usr/bin/python3', [sandboxPy, '--mode']))?.stdout ?? '').trim();
        if (kind === 'namespaces') {
          detail.push('sandbox: its own user, PID and mount namespaces (the seccomp listener is taken here, by WSL\'s init) - tried from inside it');
        } else if (kind === 'listener') {
          detail.push('sandbox: no_new_privs, Landlock and its seccomp supervisor - tried from inside it');
        }
      } else if (probe && probe.code !== 0) {
        // The sandbox did not start at all. This read as fine until WSL
        // (2026-09-29): the probe died with "could not install the seccomp
        // filter: Device or resource busy" and printed nothing, and only a
        // non-zero exit with "closed" missing was ever looked at - while the
        // check itself, rightly, refused every research session.
        const why = String(probe.stderr ?? '').trim().split('\n').pop()?.replace(/^sandbox: /, '').slice(0, 240) || `exit ${probe.code}`;
        user.push(`the sandbox does not start here (${why}): every hour the check scans and reports, but never researches or fixes`);
        if (/namespace sandbox cannot start/.test(why)) {
          // WSL, where the seccomp listener is taken, and the namespaces the
          // sandbox falls back to (2026-09-29) are refused as well.
          user.push('the seccomp listener the usual sandbox needs is taken (WSL\'s init holds one), and this user may not make the user, '
            + 'PID and mount namespaces sandbox.py uses instead');
          sandboxNext.push('unshare -Ur -p -m --fork true   (must work as this user; an AppArmor or sysctl rule against unprivileged '
            + 'user namespaces stops it - docs/operations.md, "How far the sandbox goes")');
        } else if (ctx.wsl && /busy/i.test(why)) {
          // A sandbox.py from before the namespace sandbox: WSL's init holds
          // the one seccomp listener a process may have, and it knew no other way.
          user.push('this is WSL: its own init (PID 1) holds a seccomp listener that every process inherits, and the kernel allows '
            + 'one listener per process - and this checkout\'s sandbox.py predates the namespace sandbox it now uses there');
          sandboxNext.push(`git -C ${ctx.liveDir} pull --ff-only   (or the bot's next start, which updates it): a newer sandbox.py `
            + 'runs the session in namespaces of its own on WSL');
        } else {
          sandboxNext.push(`python3 ${path.join(ctx.liveDir, 'deploy', 'hourly-debug', 'sandbox.py')} --probe $$   (to see it fail)`);
        }
      }

      const runs = parseJson(sys.readFile(path.join(ctx.liveDir, 'data', 'hourly-debug', 'runs.json')));
      const last = Array.isArray(runs) ? runs[0] : null;
      if (last?.at) {
        detail.push(`last run ${fmtAt(last.at)} (${ago(ctx.now - last.at)}): ${last.result ?? 'unknown'}${last.found ? `, ${last.found} finding(s)` : ''}`);
        if (line && ctx.now - last.at > 2 * 3600_000 + 15 * 60_000) {
          user.push(`in cron, but no run since ${fmtAt(last.at)}`);
          sandboxNext.push(`tail ${path.join(ctx.env.HOURLY_DEBUG_STATE_DIR || path.join(ctx.home, '.local', 'share', 'whatsapp-bot-debug'), 'cron.log')}; deploy/install-hourly-debug.sh --status`);
        }
      } else if (line) {
        detail.push('no run recorded yet: the first is at the top of the hour');
      }

      const next = [...(tokenOk ? [] : tokenNext), ...sandboxNext];
      if (fixable.length) return missing([...fixable, ...user, ...detail], [installer], next);
      if (user.length) return needsUser([...user, ...detail], next);
      return ok(detail);
    },
    async standby(sys, ctx) {
      const line = cronLineWith(ctx.crontab, HOURLY_TAG);
      if (!line) return { state: 'standby', detail: ['installed on the box that runs the bot (node tools/routines.mjs --fix there)'] };
      return needsUser(['in cron on a box that does not run the bot: it would research a bot that is not here, and push fixes for it'],
        ['deploy/install-hourly-debug.sh --remove   (keeps the token and the reports)']);
    },
  },
  {
    id: 'sealed-backup',
    scope: 'active',
    title: 'The nightly sealed backup, 05:17 UTC',
    why: 'Every setting, login, key and the linked session go to the sealed-backup branch every night, encrypted, so a new '
      + 'box is tools/bootstrap.sh and one passphrase. The top of the branch is the backup of the box that runs the bot; '
      + 'when that box changes, the previous box\'s last backup moves to archive/ on the branch, one folder per machine.',
    check: 'crontab -l | grep "whatsapp-bot:sealed-backup"; BACKUP_PASSPHRASE in .env; data/sealed-backup-status.json',
    install: 'node tools/backup-secrets.mjs --install-cron   (only once .env holds BACKUP_PASSPHRASE)',
    userStep: 'node tools/backup-secrets.mjs --set-passphrase --install-cron   (the passphrase is asked twice, hidden). '
      + 'The box that runs the bot takes the branch over from the box it replaced by itself; --take-over by hand only where '
      + 'it cannot tell',
    bootstrap: true,
    files: ['tools/backup-secrets.mjs', 'tools/restore-secrets.mjs', 'src/core/sealed-backup.js'],
    async probe(sys, ctx) {
      if (ctx.crontab == null) return needsUser(['could not read this account\'s crontab (crontab -l failed)'], ['crontab -l']);
      const hasPass = hasEnvKey(sys.readFile(path.join(ctx.liveDir, '.env')), ['BACKUP_PASSPHRASE']);
      if (!hasPass) {
        return needsUser(['no BACKUP_PASSPHRASE in .env: nothing on this box is backed up, and a rebuild would start from nothing'],
          [`cd ${q(ctx.liveDir)} && node tools/backup-secrets.mjs --set-passphrase --install-cron   (asks twice, hidden; keep it in your password manager too)`]);
      }
      const line = cronLineWith(ctx.crontab, BACKUP_TAG);
      const node = ctx.unit.node || sys.execPath;
      const fix = [step([node, path.join(ctx.liveDir, 'tools', 'backup-secrets.mjs'), '--install-cron'],
        { display: 'node tools/backup-secrets.mjs --install-cron', cwd: ctx.liveDir, timeoutMs: 60_000 })];
      if (!line) return missing(['the nightly line is not in cron'], fix);
      if (!line.includes(`cd ${ctx.liveDir} `) && !line.includes(`cd ${q(ctx.liveDir)} `)) {
        return missing([`the nightly line backs up another checkout, not ${ctx.liveDir}`], fix);
      }
      const status = parseJson(sys.readFile(path.join(ctx.liveDir, 'data', 'sealed-backup-status.json')));
      // Which other machines' backups the branch keeps in archive/, as the
      // last run found them - or, after a refusal, as it found the branch.
      const archived = Array.isArray(status?.archive) && status.archive.length
        ? [`archived on the branch: ${status.archive.slice(0, 8).map((a) => `${a?.host ?? 'unknown host'} (${fmtAt(a?.createdAt)}, `
          + `archive/${a?.folder}/)`).join('; ')}${status.archive.length > 8 ? `; and ${status.archive.length - 8} more` : ''} - `
          + 'node tools/restore-secrets.mjs --list-archive']
        : [];
      if (status && status.ok === false) {
        const why = String(status.error ?? 'unknown').slice(0, 400);
        // `refused` names every refusal the code makes; the message test is
        // for a status file an older version wrote.
        if (status.refused || /another machine/.test(why)) {
          // Refused, so the backup at the top is still the current one. The
          // box that runs the bot takes it over by itself when it can tell
          // it is the same bot; this is when it could not - another machine,
          // this machine's backup of a different bot, or a manifest that
          // cannot be read.
          const next = ['only if THIS box now runs the bot that backup is of, and whatever ran it before is retired: '
            + 'node tools/backup-secrets.mjs --take-over   (the backup at the top moves to archive/ on the branch; nothing is lost)'];
          if (status.refused === 'other-bot') {
            next.push('if this box runs another number: node tools/routines.mjs --skip sealed-backup --reason "runs another number"');
          }
          return needsUser([`the last backup (${fmtAt(status.at)}) was refused: ${why}`, ...archived], next);
        }
        return needsUser([`the last backup failed (${fmtAt(status.at)}): ${why}`, ...archived],
          [`cd ${q(ctx.liveDir)} && node tools/backup-secrets.mjs   (by hand, to see why)`]);
      }
      if (status?.ok && ctx.now - Date.parse(status.at) > 36 * 3600_000) {
        return needsUser([`in cron, but the last good backup was ${fmtAt(status.at)}`, ...archived],
          [`tail ${q(path.join(ctx.liveDir, 'data', 'logs', 'backup-secrets.log'))}`]);
      }
      const took = status?.ok && status.archived?.folder
        ? [`that backup took the branch over: ${status.archived.host ?? 'another machine'}'s (${fmtAt(status.archived.createdAt)}) `
          + `was moved to archive/${status.archived.folder}/`]
        : [];
      return ok([`in cron, nightly at 05:17 UTC; ${status?.at ? `last backup ${fmtAt(status.at)}` : 'no backup has run yet'}`,
        ...took, ...archived]);
    },
    async standby(sys, ctx) {
      const detail = ['belongs to the box that runs the bot: the top of the sealed-backup branch is that box\'s backup'];
      if (cronLineWith(ctx.crontab, BACKUP_TAG)) {
        detail.push('its nightly line is in cron here all the same: a box that does not run the bot never replaces the top of '
          + 'the branch, so it is refused while another machine owns it; on a retired box, node tools/backup-secrets.mjs --remove-cron');
      }
      return { state: 'standby', detail };
    },
  },
  {
    id: 'cloudflare-tunnel',
    scope: 'active',
    title: 'The Cloudflare tunnel to the panel: cloudflared.service, its token kept in .env',
    why: 'The tunnel is how the panel is reached from outside. On 2026-09-30 it was started on bot-box2 with the Docker command '
      + 'the Cloudflare dashboard offers: it connected, and every visit failed with "dial tcp [::1]:8080: connection refused", '
      + 'because on Docker\'s bridge network the ingress rule\'s localhost is the container, not the box - and it had no unit, '
      + 'so a reboot would have ended it. It had been "the one piece set up by hand", so a rebuilt box had no tunnel either. '
      + 'So it runs as cloudflared.service with --token-file, and the token is kept in .env, which the sealed backup carries. '
      + 'Only the box that runs the bot runs it: a second connector on the same token gets half the visits.',
    check: 'systemctl show cloudflared (active, enabled, ExecStart with --token-file, not masked); cloudflared processes in /proc: '
      + `their cgroup (a container?) and what they run (a tunnel, or a DNS proxy); ${TUNNEL_TOKEN_FILE} there and 600; `
      + `${TUNNEL_ENV_KEY} in .env; deploy/install-cloudflared.sh --status`,
    install: 'deploy/install-cloudflared.sh --from-env (the token in .env: a rebuilt box; tools/bootstrap.sh runs it), '
      + '--from-docker (adopts a container\'s token and retires the containers that carry it), --from-unit (Cloudflare\'s own '
      + 'service install), --record-env (copies the service\'s token into .env), --new-token (a rotated token). None of them '
      + 'replaces a different token already recorded here without --replace',
    userStep: 'the first time only: deploy/install-cloudflared.sh, and paste the tunnel\'s token (Networking -> Tunnels -> the '
      + 'tunnel -> Add a replica; read hidden) - never the dashboard\'s docker run command. A token that was on a command line: '
      + 'Rotate token in the dashboard, then deploy/install-cloudflared.sh --new-token',
    bootstrap: true,
    files: ['deploy/install-cloudflared.sh'],
    async probe(sys, ctx) {
      const t = await inspectTunnel(sys, ctx);
      const u = t.unit;
      const firstTime = 'deploy/install-cloudflared.sh   (asks for the tunnel\'s token, hidden: Networking -> Tunnels -> the tunnel -> '
        + 'Add a replica; never the dashboard\'s docker run command - docs/server-setup.md, section 7)';
      const fromWhere = t.envToken ? 'deploy/install-cloudflared.sh --from-env' : firstTime;
      // What is worth saying whatever else is found.
      const notes = [];
      // A container of another tunnel (its token is not .env's) is somebody
      // else's: the first version offered --from-docker for it, which put its
      // token in place of the panel's (review, 2026-09-30).
      const others = t.containers.filter((p) => p.sameAsEnv === false);
      const ours = t.containers.filter((p) => p.sameAsEnv !== false);
      if (others.length) notes.push(`cloudflared runs in container ${idsOf(others)} with another tunnel's token: not the panel's tunnel, and left alone`);
      if (t.exposed) notes.push(`the token was ${t.exposed}, and sudo's log of that command keeps it: ${ROTATE}`);
      const withNotes = (r) => ({ ...r, detail: [...r.detail, ...notes] });

      if (u.masked) {
        const detail = ['cloudflared.service is masked here: somebody decided it must not run, so no tunnel reaches this box\'s panel'];
        if (!t.envToken) return withNotes({ state: 'optional', detail, next: [`sudo systemctl unmask cloudflared, then ${firstTime}`] });
        return withNotes(needsUser([...detail, `.env holds a tunnel token (${TUNNEL_ENV_KEY}), so one was meant to run`],
          ['sudo systemctl unmask cloudflared && deploy/install-cloudflared.sh --from-env   (if it should run here)',
            'node tools/routines.mjs --skip cloudflare-tunnel --reason "<why>"   (if it should not)']));
      }

      // The incident: a container, which on Docker's default bridge network
      // cannot reach the panel at all, and which no unit brings back.
      if (ours.length) {
        const c = ours[0];
        const ids = idsOf(ours);
        const detail = [c.hostNet === true
          ? `cloudflared runs in a container (${ids}) on this box's network: it reaches the panel, but it is no service - whether it `
            + 'comes back after a reboot is up to a restart policy the dashboard\'s docker run does not set'
          : `cloudflared runs in a container (${ids})${c.hostNet === false ? ' on a network of its own' : ''}: on Docker's default bridge `
            + 'network the ingress rule\'s http://localhost:8080 is the container\'s own loopback, not this box, so the tunnel connects '
            + 'and every visit fails with "dial tcp [::1]:8080: connect: connection refused" (bot-box2, 2026-09-30); and no unit brings it back after a reboot'];
        if (ours.some((p) => p.tokenOnArgv)) {
          detail.push('its token is on its command line, which every user of this box can read in ps - and in sudo\'s log of the docker run that started it');
        }
        if (u.active) detail.push(`cloudflared.service runs as well: ${REPLICAS}`);
        if (!ours.every((p) => p.docker)) {
          return withNotes(needsUser([...detail, 'and it is not a Docker container, which is all deploy/install-cloudflared.sh can adopt'],
            [`stop that container, then ${fromWhere}`]));
        }
        // --fix adopts it with nobody watching only where there is nothing to
        // decide: no tunnel set up here yet (the incident), or the container
        // runs the very token .env holds (a second connector of it).
        const nothingHere = !u.loaded && !t.tokenFile && !t.envToken;
        if (nothingHere || ours.every((p) => p.sameAsEnv === true)) {
          return withNotes(missing(detail, [tunnelFix(ctx, '--from-docker')],
            ['--from-docker takes the token from the container, starts cloudflared.service with it, and retires the containers that carry '
              + `it only once the service has registered; then ${ROTATE}`]));
        }
        return withNotes(needsUser([...detail, 'a tunnel is set up here already (cloudflared.service, the token file or .env), and '
          + 'whether the container runs the same one cannot be told from here'],
        ['deploy/install-cloudflared.sh --from-docker   (it refuses if the container\'s token is not the one already here: then it is '
          + 'another tunnel, to leave alone - or, if it is the panel\'s, add --replace)']));
      }

      // Cloudflare's own `cloudflared service install <token>`: it works, and
      // the token is in a world-readable file and in ps.
      if (u.loaded && u.style === 'inline') {
        const detail = ['cloudflared.service carries the tunnel\'s token on its command line, as Cloudflare\'s own `cloudflared service '
          + 'install <token>` writes it: the unit file is world-readable, the token is in ps for every user of this box, and whoever '
          + 'holds it can serve the panel\'s hostname'];
        if (u.sameAsEnv === false) {
          return withNotes(needsUser([...detail, `and it is not the token .env holds (${TUNNEL_ENV_KEY}): two tunnels, and which is the `
            + 'panel\'s is yours to say'],
          ['deploy/install-cloudflared.sh --from-unit --replace   (if the unit\'s tunnel is the panel\'s)',
            'deploy/install-cloudflared.sh --from-env --replace   (if .env\'s is)']));
        }
        return withNotes(missing(detail, [tunnelFix(ctx, '--from-unit')], [`then ${ROTATE}`]));
      }

      if (t.loose.length) {
        const pids = t.loose.map((p) => p.pid).join(' ');
        return withNotes(needsUser([`cloudflared runs a tunnel outside cloudflared.service and outside any container (pid ${pids}, in `
          + `${t.loose.map((p) => p.unit || 'no cgroup').join(', ')}): a reboot ends it, and nothing brings it back`],
        [`sudo kill ${pids}, then ${fromWhere}`]));
      }

      if (u.loaded) {
        const byFile = u.style === 'file';
        if (u.bin && !sys.exists(u.bin)) {
          const detail = [`cloudflared.service runs ${u.bin}, which is not there: the package is gone, and the tunnel with it`];
          if (byFile && (t.tokenFile || t.envToken)) return withNotes(missing(detail, [tunnelFix(ctx, ...(t.tokenFile ? [] : ['--from-env']))]));
          return withNotes(needsUser(detail, ['sudo apt-get install -y cloudflared   (from pkg.cloudflare.com: docs/server-setup.md, section 7)']));
        }
        if (u.state === 'failed' || u.sub === 'auto-restart') {
          return withNotes(needsUser([`cloudflared.service ${u.state === 'failed' ? 'has failed' : 'keeps failing and restarting'}: the panel `
            + 'cannot be reached through the tunnel'],
          ['journalctl -u cloudflared -n 50   (a token rotated or revoked in the dashboard: deploy/install-cloudflared.sh --new-token, '
            + 'and paste the new one)']));
        }
        if (byFile && !t.tokenFile) {
          const detail = [`cloudflared.service reads its token from ${TUNNEL_TOKEN_FILE}, which is not there`];
          return withNotes(t.envToken ? missing(detail, [tunnelFix(ctx, '--from-env')]) : needsUser(detail, [firstTime]));
        }
        const bootWord = STARTS_AT_BOOT.has(u.enabled) ? 'enabled at boot' : `${enabledWord(u.enabled)} at boot`;
        if (!u.active) {
          // The script, run with the token it has, also puts the token
          // file's owner and mode right.
          return withNotes(missing([`cloudflared.service is ${u.state} (${bootWord}): the panel cannot be reached through the tunnel`],
            [byFile ? tunnelFix(ctx) : step(['sudo', '-n', 'systemctl', 'enable', '--now', 'cloudflared.service'],
              { display: 'sudo systemctl enable --now cloudflared', sudo: true })]));
        }
        if (byFile && t.tokenFileMode != null) {
          // One written by hand (`echo ... | sudo tee`) is 0644: every user of
          // the box can read the tunnel (review, 2026-09-30).
          return withNotes(missing([`${TUNNEL_TOKEN_FILE} is mode ${t.tokenFileMode.toString(8)}: every user of this box can read the tunnel's token`],
            [step(['sudo', '-n', 'chown', 'root:root', TUNNEL_TOKEN_FILE], { display: `sudo chown root:root ${TUNNEL_TOKEN_FILE}`, sudo: true }),
              step(['sudo', '-n', 'chmod', '600', TUNNEL_TOKEN_FILE], { display: `sudo chmod 600 ${TUNNEL_TOKEN_FILE}`, sudo: true })]));
        }
        if (!STARTS_AT_BOOT.has(u.enabled)) {
          return withNotes(missing([`cloudflared.service runs, but is ${enabledWord(u.enabled)} at boot: after the next reboot the tunnel stays down`],
            [step(['sudo', '-n', 'systemctl', 'enable', 'cloudflared.service'], { display: 'sudo systemctl enable cloudflared', sudo: true })]));
        }
        if (!byFile) {
          return withNotes(ok(['cloudflared.service runs from a config file (a locally-managed tunnel), enabled at boot',
            'its config and credentials under /etc/cloudflared are not in the sealed backup: a rebuilt box sets it up again '
            + '(docs/server-setup.md, section 7)']));
        }
        if (t.envExists && !t.envToken) {
          return withNotes(missing([`cloudflared.service runs, but .env has no ${TUNNEL_ENV_KEY}: the sealed backup does not carry the tunnel, `
            + 'and a rebuilt box would come up without it'], [tunnelFix(ctx, '--record-env')]));
        }
        return withNotes(ok([`cloudflared.service runs, enabled at boot, reading its token from ${TUNNEL_TOKEN_FILE}`
          + `${t.envToken ? `; .env holds it too (${TUNNEL_ENV_KEY}), so the sealed backup carries the tunnel` : ''}`]));
      }

      if (t.envToken) {
        return withNotes(missing([`.env holds the tunnel's token (${TUNNEL_ENV_KEY}) but no cloudflared.service runs it: a rebuilt box whose `
          + 'tunnel is not back yet (stop cloudflared on the box this one replaced first: two connectors are replicas)'],
        [tunnelFix(ctx, '--from-env')]));
      }
      if (t.tokenFile) {
        return withNotes(missing([`${TUNNEL_TOKEN_FILE} is here but cloudflared.service is not`], [tunnelFix(ctx)]));
      }
      return withNotes({ state: 'optional', detail: ['no Cloudflare tunnel on this box: the panel is reached over Tailscale or the LAN only'],
        next: [firstTime] });
    },
    async standby(sys, ctx) {
      // Two connectors on one token are replicas, and Cloudflare splits the
      // visits between them: half would go to a box whose panel is not the
      // live bot's. Reported, never stopped from here - this box may be about
      // to take the bot over.
      const t = await inspectTunnel(sys, ctx);
      const ours = t.containers.filter((p) => p.sameAsEnv !== false);
      const running = [];
      const next = [];
      if (ours.length) {
        running.push(`in a container (${idsOf(ours)})`);
        next.push(`sudo docker rm -f ${ours.map((p) => p.id ?? '<id: sudo docker ps>').join(' ')}`);
      }
      if (t.unit.loaded && t.unit.active) {
        running.push('as cloudflared.service');
        next.push('sudo systemctl disable --now cloudflared');
      }
      if (t.loose.length) {
        running.push(`by hand (pid ${t.loose.map((p) => p.pid).join(' ')})`);
        next.push(`sudo kill ${t.loose.map((p) => p.pid).join(' ')}`);
      }
      const enabledHere = t.unit.loaded && STARTS_AT_BOOT.has(t.unit.enabled);
      // whatsapp-bot enabled at boot here but not running: most likely this
      // IS the box that runs the bot, with the bot down for the moment - and
      // then the tunnel is its, and is exactly what the operator needs to
      // reach the panel. The first version told them to disable it (review,
      // 2026-09-30). start-at-boot flags the box itself; this only orders
      // the choices, the likelier one first.
      if ((running.length || enabledHere) && STARTS_AT_BOOT.has(ctx.unit.enabled) && !ctx.unit.masked) {
        return { state: 'standby', detail: [`a Cloudflare tunnel connector ${running.length ? `runs here: ${running.join(', ')}` : 'starts at boot here'}, `
          + `and whatsapp-bot is ${ctx.unit.enabled} at boot here but ${ctx.unit.activeState}: most likely this is the box that runs `
          + 'the bot, with the bot down, and the tunnel is its (start-at-boot says more)'],
        next: ['journalctl -u whatsapp-bot -n 50   (if this box runs the bot and it stopped by itself: leave the tunnel running)',
          ...(next.length ? next : ['sudo systemctl disable cloudflared']).map((n) => `${n}   (only if another machine runs the bot: ${REPLICAS})`)] };
      }
      const takeOver = 'unless THIS box is taking the bot over: docs/operations.md, "Handing the bot over to another machine"';
      if (running.length) {
        return needsUser([`a Cloudflare tunnel connector runs on this box, which does not run the bot: ${running.join(', ')}`,
          `if it is the bot's tunnel, ${REPLICAS} - and half would reach a panel that is not the live bot's`], [...next, takeOver]);
      }
      if (enabledHere) {
        return needsUser([`cloudflared.service is ${t.unit.enabled} at boot here: the next reboot starts a second connector`],
          ['sudo systemctl disable cloudflared', takeOver]);
      }
      const detail = ['belongs to the box that runs the bot: a second connector with the same token would take half the visits'];
      if (t.envToken) {
        detail.push(`.env holds the tunnel's token (${TUNNEL_ENV_KEY}): the box that runs the bot installs it with `
          + 'deploy/install-cloudflared.sh --from-env (node tools/routines.mjs --fix there does)');
      }
      return { state: 'standby', detail };
    },
  },
  {
    // The operator, 2026-09-30: "How do I set in the vm that this session
    // ... should automatically resume after a reboot?" The Claude Code
    // session that looks after the bot ran in a plain SSH login on the bot's
    // box, so every reboot ended it. It belongs with the bot: that is the
    // box the operator works on through Claude. On a standby box it is not
    // wanted, but not harmful either - a Claude session is not the bot and
    // holds no WhatsApp session, and each box's conversations are its own -
    // so there it is reported, never flagged.
    id: 'claude-session',
    scope: 'active',
    title: 'The Claude Code session comes back after a reboot, in tmux session "claude"',
    why: 'A user unit (linger on, so it starts at boot with nobody logged in) runs `claude --continue` in the checkout - or '
      + '--resume <a pinned id> - in a detached tmux session "claude", and an interactive SSH login is told it is there (claude-attach opens it). It never '
      + 'starts while an interactive claude already runs on the checkout: two processes on one conversation interleave it.',
    check: 'deploy/install-claude-session.sh --status (linger, ~/.config/systemd/user/claude-session.service, enabled at boot, '
      + 'the ~/.bashrc hook, tmux)',
    install: 'deploy/install-claude-session.sh   (enables it at boot, never starts it; --start-now starts it, once no other '
      + 'claude runs on the checkout)',
    userStep: null,
    bootstrap: true,
    files: ['deploy/install-claude-session.sh', 'deploy/claude-session.sh'],
    async probe(sys, ctx) {
      const s = await claudeSessionState(sys, ctx);
      // --fix runs the installer, which enables and never starts: the
      // session to resume may be running right now in a plain SSH login.
      const installer = step(['bash', path.join(ctx.liveDir, 'deploy', 'install-claude-session.sh'), '--non-interactive'],
        { display: 'deploy/install-claude-session.sh', sudo: !s.linger || !s.tmux, timeoutMs: 600_000 });
      if (s.renderFailed) {
        return needsUser([...s.off, ...s.detail], [`bash ${path.join(ctx.liveDir, 'deploy', 'claude-session.sh')} unit   (to see why)`]);
      }
      if (s.off.length) return missing([...s.off, ...s.detail], [installer]);
      return ok(s.detail);
    },
    async standby(sys, ctx) {
      const s = await claudeSessionState(sys, ctx);
      if (s.enabled) {
        return { state: 'standby', detail: ['enabled at boot here too: a Claude session starts here after a reboot. Harmless to '
          + 'WhatsApp (it is not the bot), but not needed on a box that does not run the bot', ...s.detail],
        next: ['deploy/install-claude-session.sh --remove   (if it is not wanted here)'] };
      }
      return { state: 'standby', detail: ['set up on the box that runs the bot (node tools/routines.mjs --fix there)'] };
    },
  },

  /* ------------------------------------------------ inside the bot --- */
  {
    id: 'temp-sweeps',
    scope: 'in-process',
    title: 'Start-up and hourly sweeps of leftover work files',
    why: 'A process that dies mid-send leaves Baileys\' encrypted upload copies in the temp directory, and a job cut short '
      + 'leaves gigabytes in the work directory; on a small disk that stops the next encode.',
    check: 'nothing to install: src/index.js sweeps the temp directory at start, and the work directory at start and '
      + 'every hour, sparing every job a journal still holds: a job\'s files stay until it is sent, so it resumes where it stopped',
    install: 'nothing: it runs whenever the bot runs',
    userStep: null,
    bootstrap: false,
    code: [
      { file: 'src/index.js', contains: 'sweepUploadLeftovers(os.tmpdir())' },
      { file: 'src/index.js', contains: 'const sweeper = setInterval(() => sweepWorkDir(' },
      { file: 'src/index.js', contains: 'sweepWorkDir(config.media.workDir' },
    ],
    files: [],
    probe: inProcess((c) => (c.media?.workDir ? `work directory ${c.media.workDir}` : null)),
  },
  {
    id: 'drive-links',
    scope: 'in-process',
    title: 'The Google Drive Links group\'s document: kept, posted nightly, and sent to members who join',
    why: 'The Google Drive Links group has hundreds of links posted over three years and a new member sees none of them '
      + '(the operator, 2026-10-23: an organized docx file at 00:00 New York time daily, and history for whoever joins). '
      + 'The bot keeps every Drive link posted there, builds the document from them, posts it every night at 00:00 New York '
      + 'time and, tagging them, after members join; it never posts while the groups are locked for Shabbos or yom tov.',
    check: 'nothing to install: src/index.js starts it (src/core/drive-links-job.js); Settings are driveLinks.group (the group), '
      + 'driveLinks.enabled (keep its links) and driveLinks.post (post the document). The past comes from the group\'s Export chat: '
      + 'node tools/import-whatsapp-export.mjs "<the .txt>"',
    install: 'nothing: it runs whenever the bot runs',
    userStep: null,
    bootstrap: false,
    code: [
      { file: 'src/index.js', contains: 'bot.driveLinksJob.start()' },
      { file: 'src/core/drive-links-job.js', contains: 'this._timer = setInterval(' },
      { file: 'src/index.js', contains: 'bot.driveLinks.observe(msg)' },
    ],
    files: [],
    probe: inProcess((c) => (c.driveLinks?.enabled && c.driveLinks?.group
      ? `keeping its links${c.driveLinks.post ? ', posting nightly at 00:00 New York time' : ', not posting yet (driveLinks.post is off)'}`
      : 'off: no group chosen (driveLinks.group)')),
  },
  {
    id: 'daily-digest',
    scope: 'in-process',
    title: 'The daily summary email',
    why: 'Once a day, what the bot did, by email - the setting had existed with nothing behind it.',
    check: 'nothing to install: src/index.js starts it (src/core/daily-digest.js); Settings -> Email alerts switches it',
    install: 'nothing: it runs whenever the bot runs',
    userStep: null,
    bootstrap: false,
    code: [{ file: 'src/index.js', contains: 'digest.start()' }, { file: 'src/core/daily-digest.js', contains: 'this._timer = setInterval(' }],
    files: [],
    // On by default since 2026-10-12, and not due without an account to
    // send through (emailReady), which a new install does not have.
    probe: inProcess((c) => (c.email?.enabled && c.email?.dailySummary
      ? `on, at ${String(c.email.dailySummaryHour ?? 0).padStart(2, '0')}:00 box time`
        + (emailReady(c.email) ? '' : ', waiting for an address and an app password in Settings -> Email alerts')
      : 'switched off in Settings -> Email alerts')),
  },
  {
    id: 'activity-backup',
    scope: 'in-process',
    title: 'The nightly activity record, committed to git',
    why: 'Runtime state under data/ is capped and rotated; this commits each day\'s activity to its own branch at '
      + 'midnight New York, so the record of a dispute outlives the rotation.',
    check: 'nothing to install: src/index.js starts it (src/core/activity-backup.js); Settings -> Backups switches it',
    install: 'nothing: it runs whenever the bot runs',
    userStep: null,
    bootstrap: false,
    code: [{ file: 'src/index.js', contains: 'activityBackup.start()' }, { file: 'src/core/activity-backup.js', contains: 'this._timer = setInterval(' }],
    files: [],
    probe: inProcess((c) => (c.backup?.enabled
      ? `on, at ${String(c.backup.hour ?? 0).padStart(2, '0')}:00 New York${c.backup.push === false ? ', committed but not pushed' : ''}`
      : 'switched off in the settings (backup.enabled)')),
  },
  {
    id: 'lockdown-schedule',
    scope: 'in-process',
    title: 'The Shabbos and yom tov lockdown schedule',
    why: 'Locks every group at candle-lighting and opens it at havdalah, week after week, once WhatsApp is connected.',
    check: 'nothing to install: src/index.js starts it on connect (src/core/lockdown.js); the Groups tab switches it',
    install: 'nothing: it runs whenever the bot runs',
    userStep: null,
    bootstrap: false,
    code: [{ file: 'src/index.js', contains: 'lockScheduler.start()' }, { file: 'src/core/lockdown.js', contains: 'this.timer = setInterval(' }],
    files: [],
    // On by default since 2026-10-12; on a new install the schedule locks
    // nothing until somebody has looked at the always-locked list
    // (scheduleHeld in src/core/lockdown.js).
    probe: inProcess((c) => (!c.lockdown?.enabled ? 'switched off on the Groups tab'
      : !scheduleHeld(c.lockdown) ? 'on'
        : 'on, waiting: nothing is locked until a group is always-locked (Groups -> Sync from WhatsApp),'
          + ' or the lockdown card is saved')),
  },
  {
    id: 'failover',
    scope: 'in-process',
    title: 'Failover between numbers',
    why: 'Watches the number in use and moves to a linked spare when it dies, so the bot does not go quiet.',
    check: 'nothing to install: src/index.js starts it (src/core/failover.js); Settings -> Connection switches it',
    install: 'nothing: it runs whenever the bot runs',
    userStep: null,
    bootstrap: false,
    code: [{ file: 'src/index.js', contains: 'failover.start()' }, { file: 'src/core/failover.js', contains: 'this._timer = setInterval(' }],
    files: [],
    // On by default since 2026-10-12; with one number it stands aside
    // (_hasSpare in src/core/failover.js).
    probe: inProcess((c) => (!c.whatsapp?.failover?.enabled ? 'automatic failover is off'
      : (c.whatsapp.accounts ?? []).length > 1 ? 'automatic failover is on'
        : 'automatic failover is on, standing aside: only one number is set up')),
  },
  {
    id: 'bot-cmd',
    scope: 'in-process',
    title: 'The local command channel (data/bot-cmd.json)',
    why: 'Every 3 s the bot takes one whitelisted op from data/bot-cmd.json: how an operator on the box, and the hourly '
      + 'check, ask it for queue-status, health or a requeue (or, for a file WhatsApp would not open, a re-post) '
      + 'without the panel.',
    check: 'nothing to install: src/index.js polls it',
    install: 'nothing: it runs whenever the bot runs',
    userStep: null,
    bootstrap: false,
    code: [{ file: 'src/index.js', contains: 'const cmdPoll = setInterval(' }],
    files: [],
    probe: inProcess(),
  },
  {
    id: 'log-rotation',
    scope: 'in-process',
    title: 'Debug log rotation',
    why: 'The debug log is written in full and would fill the disk; it is split by size and pruned by age.',
    check: 'nothing to install: src/index.js attaches it (src/util/filelog.js)',
    install: 'nothing: it runs whenever the bot runs',
    userStep: null,
    bootstrap: false,
    code: [{ file: 'src/index.js', contains: 'new FileLogger(' }],
    files: [],
    probe: inProcess((c) => `logs kept ${c.logging?.retentionDays ?? 14} days`),
  },
  {
    id: 'beta-transcript',
    scope: 'in-process',
    title: 'The beta groups\' transcript (data/beta-transcript/)',
    why: 'Every beta group\'s conversation, every edit of a bot message included, written as it happens and pruned with the '
      + 'logs, so the hourly check can read the tests as the testers saw them - the operator (2026-09-30): "I need it all '
      + 'logged somewhere for you to check on the hourly debug so I don\'t have to manually report to you".',
    check: 'nothing to install: src/core/bot.js writes it at every send, edit and reaction in a beta group '
      + '(src/core/beta-transcript.js), and prunes it at start and each new day',
    install: 'nothing: it runs whenever the bot runs',
    userStep: null,
    bootstrap: false,
    code: [
      { file: 'src/core/bot.js', contains: 'this.transcript = new BetaTranscript(' },
      { file: 'src/core/beta-transcript.js', contains: 'export function pruneTranscript(' },
      { file: 'tools/hourly-debug.mjs', contains: 'betaEvents: readTranscript(' },
    ],
    files: [],
    probe: inProcess((c) => {
      const n = Array.isArray(c.beta?.groups) ? c.beta.groups.length : 0;
      return `${n ? `${n} beta group(s) transcribed` : 'no beta groups set, so nothing is transcribed'}, `
        + `kept ${c.logging?.retentionDays ?? 14} days`;
    }),
  },

  {
    id: 'decrypt-watch',
    scope: 'in-process',
    title: 'Whose messages this number cannot decrypt',
    why: 'A message that cannot be decrypted is dropped before any plugin sees it, so a request in it gets no answer and '
      + 'leaves no trace; on 2026-10-08 the journal held about a thousand libsignal errors naming nobody. Baileys names the '
      + 'chat and sender, and the bot logs them (src/core/decrypt-watch.js), writing out what is pending every ten minutes '
      + 'so the hourly check counts every one - the operator: "add decrypt failures to the hourly check report".',
    check: 'nothing to install: src/core/bot.js gives Baileys the logger and runs the flush timer; '
      + '{"op":"decrypt-failures"} on the bot-cmd channel lists every sender since the bot started',
    install: 'nothing: it runs whenever the bot runs',
    userStep: null,
    bootstrap: false,
    code: [
      { file: 'src/core/bot.js', contains: 'this.decryptWatch.flush()' },
      { file: 'src/core/decrypt-watch.js', contains: 'export class DecryptWatch' },
      { file: 'src/core/incident-scan.js', contains: 'function decryptFindings(' },
    ],
    files: [],
    probe: inProcess(() => 'logged by sender, flushed every 10 minutes, reported by the hourly check'),
  },
  {
    id: 'wanted-recheck',
    scope: 'in-process',
    title: 'The wanted list checked against the library',
    why: 'A film left the wanted list only when somebody asked for it again and it was found, so one added later, or one '
      + 'the lookup had missed, stayed listed as missing: on 2026-10-11 the panel listed "X2: X-Men United", held as "X2" '
      + 'since before it was asked for, and "Harry Potter and the Sorcerer\'s Stone", held under its IMDb id as "...the '
      + 'Philosopher\'s Stone". The bot looks every open entry up as a request would (src/core/wanted-recheck.js) and '
      + 'marks resolved, and logs, the ones the server has, so the admins see it was found (the operator, 2026-10-11: '
      + '"mark as resolved so other admins ... know"); an entry resolved over 30 days ago is pruned on the same timer. '
      + 'And what a run finds is the trigger for telling the members who asked (the operator, 2026-10-11): after each run, '
      + 'every film it has just found on the server - by its IMDb id across a year gap too, as "A Snapshot of Forever" '
      + '(2025 to OMDb, 2022 on the server) - is re-run for every member told "not in the library" for it in the last 60 '
      + 'days, as their original request, on their own message, once, paced (src/core/wanted-arrival.js); a film resolved '
      + 'before that began on the box is left to "Re-run requests" on its Wanted card. Nothing of it depends on Discord. '
      + 'Every six hours until then: "A Snapshot of Forever" was on the server six hours before it was found.',
    check: 'nothing to install: src/index.js starts it, three minutes after start and every 30 minutes, one lookup at a '
      + 'time; POST /api/wanted/recheck (the Wanted card\'s Refresh) runs it on demand, and POST /api/wanted/:key/rerun '
      + '(the card\'s "Re-run requests") re-runs a resolved film\'s requests by hand',
    install: 'nothing: it runs whenever the bot runs',
    userStep: null,
    bootstrap: false,
    code: [
      { file: 'src/index.js', contains: 'wantedRecheck.start()' },
      { file: 'src/core/wanted-recheck.js', contains: 'this._timer = setInterval(' },
      { file: 'src/web/api.js', contains: "router.post('/wanted/recheck'" },
      { file: 'src/index.js', contains: 'new ArrivalReruns(' },
      { file: 'src/index.js', contains: 'arrivals.begin()' },
      { file: 'src/web/api.js', contains: "router.post('/wanted/:key/rerun'" },
    ],
    files: [],
    probe: inProcess((c) => (['jellyfin', 'plex', 'http', 'local'].includes(c.library?.provider)
      ? `every 30 minutes against the ${c.library.provider} library; arrivals ${c.wanted?.rerunOnArrival === false
        ? 'only marked resolved (re-runs switched off on the Wanted card)' : 'found are re-run for the members who asked'}`
      : 'waiting for a library to be set up (Settings -> Library)')),
  },
  {
    id: 'discord-reader',
    scope: 'in-process',
    title: 'The Discord ticket reader (data/discord-tickets.jsonl)',
    why: 'The operator opens support tickets with the Jellyfin host in the host\'s Discord server, and the answers came back '
      + 'where nothing on the box could see them - the operator, 2026-10-11: "create from scratch a way I can connect my discord '
      + 'account to the ubuntu so you can access it". With the account connected, every 30 minutes and once at start it reads '
      + 'the new messages in the watched ticket channels, read-only (src/core/discord-reader.js), so the hourly check sees '
      + 'how each ticket ended.',
    check: 'nothing to install: src/index.js starts it (src/core/discord-watch.js); the super-admin connects the account in '
      + 'Settings -> Connection -> Discord (read-only), and the token travels in the sealed backup with the other settings',
    install: 'nothing: it runs whenever the bot runs, and reads nothing until an account is connected',
    userStep: null,
    bootstrap: false,
    code: [
      { file: 'src/index.js', contains: 'discordWatch.start()' },
      { file: 'src/core/discord-watch.js', contains: 'this._timer = setInterval(' },
      { file: 'tools/hourly-debug.mjs', contains: 'tickets: readDiscordTickets(' },
    ],
    files: [],
    probe: inProcess((c) => (c.discord?.token
      ? 'connected (read-only), read every 30 minutes'
      : 'not connected: the super-admin connects it in Settings -> Connection -> Discord (read-only), if it is wanted')),
  },
  {
    id: 'yt-dlp-update',
    scope: 'in-process',
    title: 'yt-dlp updated daily, between its own downloads',
    why: 'YouTube breaks an old yt-dlp within weeks. The zipapp\'s own -U rewrites the file a running yt-dlp is reading its '
      + 'code from, so the bot, which alone knows when its yt-dlp is running, runs -U on a copy once a day and swaps it in '
      + 'whole when none is (src/media/yt-dlp-install.js); a cron line could not know. Installing it is the yt-dlp routine\'s.',
    check: 'nothing to install: src/index.js starts it; each check is recorded in ~/.local/state/whatsapp-bot/yt-dlp.json, '
      + 'which the yt-dlp routine reads',
    install: 'nothing: it runs whenever the bot runs',
    userStep: null,
    bootstrap: false,
    code: [
      { file: 'src/index.js', contains: 'ytDlpUpdater.start()' },
      { file: 'src/media/yt-dlp-install.js', contains: 'this._timer = setInterval(' },
    ],
    files: [],
    probe: inProcess(() => 'checks hourly; updates once the last good check is a day old, never while a yt-dlp download runs'),
  },

  /* ------------------------------------------------------- WSL boxes --- */
  {
    id: 'wsl-systemd',
    scope: 'wsl',
    title: 'WSL: systemd as init (/etc/wsl.conf)',
    why: 'WSL does not run systemd unless /etc/wsl.conf asks for it, and without it nothing starts whatsapp-bot.service or '
      + 'cron: on the laptop (2026-09-29) `systemctl restart whatsapp-bot` failed with "System has not been booted with systemd '
      + 'as init system".',
    check: '/etc/wsl.conf has [boot] systemd=true, and systemctl is-system-running answers',
    install: 'deploy/wsl-setup.sh systemd   (then, from Windows: wsl.exe --shutdown, and open the distro again)',
    userStep: 'once the file is right, from Windows at a quiet moment: wsl.exe --shutdown, then start the distro again',
    bootstrap: true,
    files: ['deploy/wsl-setup.sh', 'tools/wsl-config.mjs'],
    async probe(sys, ctx) {
      if (!ctx.wsl) return notWsl();
      const want = iniMissing(sys.readFile('/etc/wsl.conf'), WSL_CONF_WANT);
      if (want.length) {
        return missing(['/etc/wsl.conf does not ask for systemd: WSL starts without it, and nothing starts the bot'],
          [wslFix(ctx, 'systemd')], ['then, from Windows at a quiet moment: wsl.exe --shutdown, and open the distro again']);
      }
      const r = await sys.run('systemctl', ['is-system-running'], { timeoutMs: 15_000 });
      const state = String(r.stdout ?? '').trim();
      if (!state || /offline|not been booted/i.test(`${state} ${r.stderr ?? ''}`)) {
        return needsUser(['/etc/wsl.conf asks for systemd, but it is not running: WSL has not been restarted since'],
          ['from Windows, at a quiet moment: wsl.exe --shutdown, then open the distro again (the scheduled task of wsl-autostart does too)']);
      }
      return ok([`systemd runs (${state})`]);
    },
  },
  {
    id: 'wsl-config',
    scope: 'wsl',
    title: 'WSL: .wslconfig on Windows - mirrored networking, never idle',
    why: 'networkingMode=mirrored puts the panel on the laptop\'s own LAN address and its Tailscale address; vmIdleTimeout=-1 '
      + 'keeps WSL, and the bot in it, running when no window is open. It is a Windows file, %UserProfile%\\.wslconfig.',
    check: '/mnt/c/Users/<you>/.wslconfig: [wsl2] networkingMode=mirrored and vmIdleTimeout=-1',
    install: 'deploy/wsl-setup.sh wslconfig   (keeps every other line, and the file\'s line endings; then wsl.exe --shutdown)',
    userStep: 'when the file cannot be written from here, in Windows: notepad %UserProfile%\\.wslconfig, with [wsl2] '
      + 'networkingMode=mirrored and vmIdleTimeout=-1 on lines of their own; then wsl.exe --shutdown at a quiet moment',
    bootstrap: true,
    files: ['deploy/wsl-setup.sh', 'tools/wsl-config.mjs'],
    async probe(sys, ctx) {
      if (!ctx.wsl) return notWsl();
      const home = await windowsHome(sys, ctx.user);
      const by = 'notepad %UserProfile%\\.wslconfig   (in Windows: [wsl2], then networkingMode=mirrored and vmIdleTimeout=-1, each on its own line)';
      if (!home) {
        return needsUser(['cannot tell which Windows profile this is, so .wslconfig cannot be read'],
          ['WSL_WINDOWS_HOME=/mnt/c/Users/<name> node tools/routines.mjs --only wsl-config', by]);
      }
      const file = path.join(home.dir, '.wslconfig');
      const text = sys.readFile(file);
      const want = iniMissing(text ?? '', WSLCONFIG_WANT);
      if (!want.length) return ok([`${file} (${home.how}): mirrored networking, never idle`]);
      const detail = [`${file} ${text == null ? 'does not exist' : `lacks ${want.join(', ')}`}${sys.exists(`${file}.bak`) ? ` (a ${file}.bak is there)` : ''}`];
      const restart = 'then, from Windows at a quiet moment: wsl.exe --shutdown (it stops the bot), and start the distro again';
      const dirSt = sys.stat(home.dir);
      if (!dirSt || (text != null && !((sys.stat(file)?.mode ?? 0) & 0o200))) return needsUser([...detail, 'and it cannot be written from here'], [by, restart]);
      return missing(detail, [wslFix(ctx, 'wslconfig', { sudo: false })], [restart]);
    },
  },
  {
    id: 'wsl-vm-units',
    scope: 'wsl',
    title: 'WSL: the Hyper-V VM\'s units turned off',
    why: 'A distro cloned from the VM keeps its units: systemd-networkd and networkd-dispatcher would apply the VM\'s static '
      + 'netplan address and fight WSL\'s networking, grow-root-disk and eth0-no-offload are for the VM\'s disk and NIC, and a '
      + 'Linux tailscaled fights the Windows client over the 100.x routes.',
    check: `systemctl is-enabled / is-active: ${Object.keys(VM_UNITS).join(', ')}`,
    install: 'deploy/wsl-setup.sh vm-units   (sudo systemctl disable --now each one that is on)',
    userStep: null,
    bootstrap: true,
    files: ['deploy/wsl-setup.sh'],
    async probe(sys, ctx) {
      if (!ctx.wsl) return notWsl();
      const on = [];
      for (const [unit, why] of Object.entries(VM_UNITS)) {
        const en = (await sys.run('systemctl', ['is-enabled', unit])).stdout.trim();
        const act = (await sys.run('systemctl', ['is-active', unit])).stdout.trim();
        if (STARTS_AT_BOOT.has(en) || act === 'active') on.push(`${unit} is ${[STARTS_AT_BOOT.has(en) ? en : null, act === 'active' ? 'running' : null].filter(Boolean).join(' and ')}: ${why}`);
      }
      if (on.length) return missing(on, [wslFix(ctx, 'vm-units')]);
      return ok(['none of the VM\'s units is on']);
    },
  },
  {
    id: 'wsl-autostart',
    scope: 'wsl',
    title: 'WSL: started with Windows (a scheduled task)',
    why: 'WSL does not start by itself: after a Windows reboot nothing ran the bot until somebody opened the distro. A '
      + 'scheduled task starts it with Windows; systemd then starts whatsapp-bot.service where it is enabled (start-at-boot).',
    check: `schtasks.exe /Query /TN "${TASK_NAME}", through WSL's interop`,
    install: 'only from Windows, as administrator: the PowerShell that node tools/wsl-config.mjs --autostart prints',
    userStep: 'in PowerShell as administrator, once: the command node tools/wsl-config.mjs --autostart prints',
    bootstrap: true,
    files: ['tools/wsl-config.mjs'],
    async probe(sys, ctx) {
      if (!ctx.wsl) return notWsl();
      const ps = `in PowerShell as administrator: ${autostartPowerShell(ctx.wsl.distro)}`;
      const distro = ctx.wsl.distro ? [] : ['this check could not tell the distro\'s name (no WSL_DISTRO_NAME): wsl.exe -l -v lists it'];
      const bin = schtasks(sys);
      if (!bin) {
        return needsUser(['Windows\' scheduled tasks cannot be seen from here (no schtasks.exe through WSL\'s interop)', ...distro],
          [ps, `to see whether it is there, in PowerShell: Get-ScheduledTask -TaskName '${TASK_NAME}'`]);
      }
      const r = await sys.run(bin, ['/Query', '/TN', TASK_NAME, '/FO', 'LIST'], { cwd: '/mnt/c', timeoutMs: 20_000 });
      if (r.code === 0) {
        const status = /Status:\s*(.+)/.exec(String(r.stdout))?.[1]?.trim();
        return ok([`the scheduled task "${TASK_NAME}" is there${status ? ` (${status})` : ''}: WSL starts with Windows`]);
      }
      return needsUser([`no scheduled task "${TASK_NAME}": after a Windows reboot, nothing starts WSL or the bot`, ...distro], [ps]);
    },
  },

  /* ---------------------------------------------------------- optional --- */
  {
    id: 'lan-address',
    scope: 'optional',
    title: 'Keeping the same LAN address',
    why: 'The panel is reached at http://<address>:8080, and bot-box\'s DHCP address kept moving. The operator chose a static '
      + 'address (2026-09-29, 192.168.20.45): a netplan file with DHCP off, cloud-init kept off the network config, and the '
      + 'same address reserved on the router for this MAC. The older DHCP pin, asking the router for the address as this MAC, '
      + 'still counts.',
    check: 'ls /etc/netplan/99-static-lan.yaml   (or, the DHCP pin: /etc/systemd/network/*.network.d/10-request-address.conf)',
    install: 'deploy/pin-lan-address.sh --static <address> --apply   (--static --print first; undone by itself in 3 min '
      + 'if the box loses the network)',
    userStep: 'which address to keep is your decision (tools/bootstrap.sh asks, or LAN_ADDRESS=), and it should be reserved '
      + 'for this MAC on the router too (docs/server-setup.md, "Keeping the same LAN address")',
    bootstrap: true,
    files: ['deploy/pin-lan-address.sh'],
    async probe(sys, ctx) {
      if (ctx.wsl) {
        // In mirrored networking WSL has the laptop's own addresses: the
        // address to keep is the laptop's, reserved on the router. A netplan
        // file brought from the VM would fight that; wsl-vm-units keeps
        // systemd-networkd, which applies it, off.
        const home = await windowsHome(sys, ctx.user);
        const text = home ? sys.readFile(path.join(home.dir, '.wslconfig')) : null;
        const leftover = sys.exists('/etc/netplan/99-static-lan.yaml')
          ? ['/etc/netplan/99-static-lan.yaml is the VM\'s, and is never applied here while systemd-networkd stays off (wsl-vm-units)'] : [];
        if (text != null && !iniMissing(text, { 'wsl2.networkingMode': 'mirrored' }).length) {
          return ok(['WSL, mirrored networking: the panel is on the laptop\'s own LAN address (reserve that one for the laptop on the router)', ...leftover]);
        }
        return { state: 'optional', detail: ['WSL without mirrored networking: the panel is behind WSL\'s own address, which moves', ...leftover],
          next: ['see wsl-config: networkingMode=mirrored in .wslconfig, then reserve the laptop\'s address on the router'] };
      }
      // The netplan file is mode 600, so the check - run as the bot's user -
      // usually cannot read the address out of it; that it exists is enough.
      const staticFile = '/etc/netplan/99-static-lan.yaml';
      if (sys.exists(staticFile)) {
        const addr = /^\s*-\s*(\d+\.\d+\.\d+\.\d+\/\d+)\s*$/m.exec(sys.readFile(staticFile) ?? '')?.[1];
        const cloudOff = sys.exists('/etc/cloud/cloud.cfg.d/99-disable-network-config.cfg');
        return ok([`static address: ${staticFile}${addr ? ` sets ${addr}` : ''}`,
          ...(cloudOff ? [] : ['cloud-init may still rewrite the network config: deploy/pin-lan-address.sh --static writes the file that stops it'])]);
      }
      const dir = '/etc/systemd/network';
      const pinned = (sys.readdir(dir) ?? []).filter((d) => d.endsWith('.network.d'))
        .map((d) => path.join(dir, d, '10-request-address.conf')).find((f) => sys.exists(f));
      if (pinned) {
        const addr = /^RequestAddress=(.*)$/m.exec(sys.readFile(pinned) ?? '')?.[1];
        return ok([`${pinned}${addr ? `: asks for ${addr}` : ''}`]);
      }
      return { state: 'optional', detail: ['no static address, and nothing asks the router to keep this box\'s address'],
        next: ['deploy/pin-lan-address.sh --static --print   (then --static <address> --apply; and reserve it on the router)'] };
    },
  },
];

export const byId = (id) => ROUTINES.find((r) => r.id === id) ?? null;

/* ----------------------------------------------------- running checks --- */

/**
 * One routine on this box: { id, scope, title, state, detail[], next[], fix }.
 * A fix that needs sudo on a box without passwordless sudo is the person's
 * to run, so it is reported as needs-user with the command, not as missing.
 */
export async function checkRoutine(routine, sys, ctx) {
  const base = { id: routine.id, scope: routine.scope, title: routine.title };
  const skip = ctx.skips[routine.id];
  if (skip) {
    return { ...base, state: 'skipped', detail: [`${skip.reason || 'no reason given'}${skip.at ? ` (${fmtAt(skip.at)})` : ''}`],
      next: [`node tools/routines.mjs --unskip ${routine.id}   (to check it again)`], fix: null };
  }
  let r;
  try {
    if (routine.scope === 'active' && ctx.role !== 'active') {
      r = routine.standby ? await routine.standby(sys, ctx) : { state: 'standby', detail: ['belongs to the box that runs the bot'] };
    } else {
      r = await routine.probe(sys, ctx);
    }
  } catch (err) {
    r = needsUser([`the check itself failed: ${err.message}`], [`node tools/routines.mjs --only ${routine.id}`]);
  }
  const out = { ...base, state: r.state, detail: r.detail ?? [], next: [...(r.next ?? [])], fix: r.fix ?? null };
  // The installers run from the checkout the service runs. One that predates
  // a routine does not have its installer yet - bot-box's did not, the day the
  // hourly check and this registry were merged - and gets it with its next
  // update, which happens at the next start of the bot.
  const absent = out.fix ? (routine.files ?? []).filter((f) => !sys.exists(path.join(ctx.liveDir, f))) : [];
  if (out.state === 'missing' && absent.length) {
    out.state = 'needs-user';
    out.detail.push(`${ctx.liveDir} does not have ${absent.join(', ')} yet: it predates this routine`);
    out.next = [`update that checkout first: it pulls main at the next start of the bot (docs/operations.md, "Upgrading"), then node tools/routines.mjs --fix`, ...out.next];
    out.fix = null;
  }
  if (out.state === 'missing' && out.fix) {
    const human = out.fix.map((s) => s.display);
    if (out.fix.some((s) => s.sudo) && !ctx.sudoOk) {
      out.state = 'needs-user';
      out.next = [...human.map((c) => `${c}   (needs sudo, which asks ${ctx.user} for a password)`), ...out.next];
      out.fix = null;
    } else {
      out.next = [`node tools/routines.mjs --fix   (runs: ${human.join('; ')})`, ...out.next];
    }
  }
  return out;
}

export async function checkAll(sys, ctx, { only = null } = {}) {
  const list = only ? ROUTINES.filter((r) => only.includes(r.id)) : ROUTINES;
  const results = [];
  for (const r of list) results.push(await checkRoutine(r, sys, ctx));
  return results;
}

export const exitCode = (results) => (results.some((r) => FAILING.has(r.state)) ? 1 : 0);

/**
 * Why --fix must not run here, or null. It runs only from the checkout the
 * service runs, because the cron lines and units it installs point at the
 * checkout that installs them - a worktree's cron line would run the hourly
 * check from a scratch copy.
 */
export function fixRefusal(ctx, { uid = 1 } = {}) {
  if (uid === 0) return 'run it as the bot\'s user, not root: the cron lines and tokens are that user\'s';
  if (ctx.role === 'dev') return `${ctx.roleWhy}. tools/bootstrap.sh makes a bot box; or say which this is with --role standby|active`;
  if (!ctx.isLive) return `this is not the checkout the service runs (${ctx.liveDir}): run it from there`;
  return null;
}

/**
 * Why --skip / --unskip must not write here, or null. A decision is this
 * checkout's to record even before it is a bot box (tools/bootstrap.sh
 * --new-number records one before the bot has ever started), but never
 * another checkout's.
 */
export function skipRefusal(ctx, { uid = 1 } = {}) {
  if (uid === 0) return 'run it as the bot\'s user, not root';
  if (!ctx.isLive) return `this is not the checkout the service runs (${ctx.liveDir}): run it from there`;
  return null;
}

/**
 * Run the fix steps of every result that has them, in registry order. Each
 * routine stops at its first failing step; the others still run. Returns
 * [{ id, ok, step, output }].
 */
export async function applyFixes(results, sys, { log = () => {} } = {}) {
  const done = [];
  for (const r of results) {
    if (r.state !== 'missing' || !r.fix) continue;
    for (const s of r.fix) {
      log(`${r.id}: + ${s.display}`);
      const [cmd, ...args] = s.argv;
      const res = await sys.run(cmd, args, { cwd: s.cwd, timeoutMs: s.timeoutMs });
      const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
      done.push({ id: r.id, ok: res.code === 0, step: s.display, output });
      if (res.code !== 0) {
        log(`${r.id}: failed (exit ${res.code})${output ? `\n${output.split('\n').slice(-12).map((l) => `      ${l}`).join('\n')}` : ''}`);
        break;
      }
    }
  }
  return done;
}

/* ------------------------------------------------------------ reports --- */

const PAD = Math.max(...Object.keys(STATES).map((s) => s.length)) + 2;
const ID_PAD = Math.max(...ROUTINES.map((r) => r.id.length)) + 2;

/** The plain-text report tools/routines.mjs prints. */
export function formatReport(results, ctx) {
  const L = [];
  L.push(`Routines on ${ctx.host}, checkout ${ctx.liveDir}`);
  L.push(`${ctx.roleWhy}.`);
  if (!ctx.isLive) L.push(`(Run from ${ctx.appDir}, which is not the checkout the service runs: this checked ${ctx.liveDir}.)`);
  for (const [scope, heading] of Object.entries(SCOPES)) {
    const rows = results.filter((r) => r.scope === scope);
    if (!rows.length) continue;
    L.push('', heading);
    for (const r of rows) {
      L.push(`  ${r.state.padEnd(PAD)}${r.id.padEnd(ID_PAD)}${r.title}`);
      for (const d of r.detail) L.push(`${' '.repeat(PAD + 2)}${d}`);
      for (const n of r.next) L.push(`${' '.repeat(PAD + 2)}-> ${n}`);
    }
  }
  const count = (s) => results.filter((r) => r.state === s).length;
  const miss = count('missing');
  const user = count('needs-user');
  L.push('');
  if (!miss && !user) {
    L.push('Every routine that applies to this box is in place.');
  } else {
    const bits = [];
    if (miss) bits.push(`${miss} to activate with: node tools/routines.mjs --fix`);
    if (user) bits.push(`${user} need${user === 1 ? 's' : ''} you: run the command after "->" (a password, a login or a passphrase)`);
    L.push(bits.join('; '));
  }
  if (ctx.role !== 'active') {
    L.push('This box does not run the bot, so the routines of the box that does are not installed here, and nothing here starts it.');
  }
  return L.join('\n');
}

/** The registry itself, for --list and a development clone. */
export function formatRegistry() {
  const L = ['The routines every bot box runs (src/core/routines.js):'];
  for (const [scope, heading] of Object.entries(SCOPES)) {
    L.push('', heading);
    for (const r of ROUTINES.filter((x) => x.scope === scope)) {
      L.push(`  ${r.id.padEnd(ID_PAD)}${r.title}`, `      why:     ${r.why}`, `      check:   ${r.check}`, `      install: ${r.install}`);
      if (r.userStep) L.push(`      you:     ${r.userStep}`);
    }
  }
  return L.join('\n');
}

/** For --json: the results without the fix closures' argv. */
export function jsonReport(results, ctx) {
  return {
    host: ctx.host, checkout: ctx.liveDir, runFrom: ctx.appDir, role: ctx.role, roleWhy: ctx.roleWhy,
    failing: exitCode(results) !== 0,
    routines: results.map(({ fix, ...r }) => ({ ...r, fix: fix ? fix.map((s) => s.display) : null })),
  };
}
