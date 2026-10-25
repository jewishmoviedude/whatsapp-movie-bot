/* The routines every bot box runs: one registry, one check, bootstrap and
   CLAUDE.md in step with both. Run: node test/routines.test.mjs

   The owner's rule, for every change that is not temporary: "If I point a
   brand new claude session at the GitHub repo will it know to activate these
   routine workflows?" On 2026-09-28 the answer was no. The hourly check had
   been built, reviewed and merged, and ran nowhere: tools/bootstrap.sh never
   installed it and nothing told a session it should exist. Its two one-time
   steps - passwordless sudo, a `claude setup-token` token in a file - had been
   done by hand on bot-box and were written down only in a chat, and bot-box's
   Hyper-V offload had been turned off by hand with no unit to turn it off
   again after a reboot.

   So src/core/routines.js lists every routine, tools/routines.mjs checks them
   (--fix activates what needs no person), bootstrap.sh installs each one in a
   step marked "# routine: <id>", and CLAUDE.md lists them and tells a new
   session to run the check first. This suite holds those four together - a
   routine wired into only some of them fails it, and so does a new cron line,
   systemd unit, deploy/ file or timer in the bot that no routine claims - and
   runs every probe against a fake box: nothing here calls the real crontab,
   systemctl or sudo.

   The check must be safe on a box that does not run the bot (a standby
   laptop, a rebuilt server before the hand-over): two machines on one number
   is connectionReplaced (CLAUDE.md, rule 3). The standby cases pin that it
   never starts, stops, restarts or enables the bot, and never installs the
   running box's routines there. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ROUTINES, SCOPES, STATES, HOURLY_TAG, BACKUP_TAG, SUDO_COMMAND, byId, inspectBox, checkAll, checkRoutine,
  exitCode, fixRefusal, skipRefusal, applyFixes, formatReport, formatRegistry, jsonReport, cronLineWith, parseShow, hasEnvKey,
  tunnelTokenStyle, cloudflaredKind, cloudflaredProcesses, TUNNEL_ENV_KEY,
} from '../src/core/routines.js';
import { main, parseArgs } from '../tools/routines.mjs';
import { CRON_TAG } from '../src/core/sealed-backup.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'routines-test-'));

/* ------------------------------------------------------------ the fake box */

const LIVE = '/srv/bot';
const HOME = '/home/bot';
const NOW = Date.parse('2026-09-28T18:10:00Z');
const UNIT_FILE = '/etc/systemd/system/whatsapp-bot.service';
const RENDERED = read('whatsapp-bot.service')
  .replace(/^User=.*$/m, 'User=bot').replace(/^Group=.*$/m, 'Group=bot')
  .replace(/^WorkingDirectory=.*$/m, `WorkingDirectory=${LIVE}`).replace(/^ExecStart=.*$/m, 'ExecStart=/usr/bin/node src/index.js');
// A tick every minute: on the hour the hourly check, and at once for a
// library keeper's #issue (the operator, 2026-10-12).
const HOURLY_LINE = `* * * * * mkdir -p ${HOME}/.local/share/whatsapp-bot-debug && /bin/bash ${LIVE}/deploy/hourly-debug/tick.sh >> ${HOME}/.local/share/whatsapp-bot-debug/cron.log 2>&1 ${HOURLY_TAG}`;
const BACKUP_LINE = `17 5 * * * cd ${LIVE} && /usr/bin/node tools/backup-secrets.mjs --cron >> data/logs/backup-secrets.log 2>&1 ${BACKUP_TAG}`;
const ENV_FILE = `${HOME}/.config/whatsapp-bot/hourly-debug.env`;
const DEPS = Object.keys(JSON.parse(read('package.json')).dependencies);
// The Cloudflare tunnel's token, shaped like one (base64 of {a, t, s}), so
// that a probe which let any of it through would be caught.
const TUNNEL_TOKEN = Buffer.from(JSON.stringify({ a: 'acc0unt7a9', t: '6ad1c0de-7b2f-4c61-9d3e-2f5a8b9c0d1e', s: 'dHVubmVsLXNlY3JldC1vZi10aGUtdGVzdA==' })).toString('base64');
const CF_SERVICE_SHOW = 'LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n'
  + 'ExecStart={ path=/usr/bin/cloudflared ; argv[]=/usr/bin/cloudflared --no-autoupdate tunnel run --token-file /etc/cloudflared/tunnel-token ; '
  + 'ignore_errors=no ; start_time=[Wed 2026-09-30 14:01:32 UTC] ; stop_time=[n/a] ; pid=4100 ; code=(null) ; status=0/0 }\nEnvironment=\n';
const SERVICE_CMDLINE = '/usr/bin/cloudflared\0--no-autoupdate\0tunnel\0run\0--token-file\0/etc/cloudflared/tunnel-token\0';
const CF_NO_UNIT = 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nUnitFileState=\nExecStart=\nEnvironment=\n';
// /proc/<pid>/net/dev: the box with Docker's bridge (docker0, and a veth for
// each container on it), and a container on that bridge, which has its own
// lo and eth0 and nothing else.
const HOST_NET = 'Inter-|   Receive\n face |bytes\n    lo: 1 2 0 0 0 0 0 0 1 2 0 0 0 0 0 0\n  eth0: 9 9 0 0 0 0 0 0 9 9 0 0 0 0 0 0\n'
  + 'docker0: 5 5 0 0 0 0 0 0 5 5 0 0 0 0 0 0\nveth3f2a1b0: 5 5 0 0 0 0 0 0 5 5 0 0 0 0 0 0\n';
const BRIDGE_NET = 'Inter-|   Receive\n face |bytes\n    lo: 1 2 0 0 0 0 0 0 1 2 0 0 0 0 0 0\n  eth0: 3 3 0 0 0 0 0 0 3 3 0 0 0 0 0 0\n';
// The claude-session routine's unit and hook, as this checkout's launcher
// prints them for a checkout at LIVE.
const CS_LAUNCHER = path.join(REPO, 'deploy', 'claude-session.sh');
const CS_UNIT = spawnSync('bash', [CS_LAUNCHER, 'unit'], { encoding: 'utf8' }).stdout.split(REPO).join(LIVE);
const CS_HOOK = spawnSync('bash', [CS_LAUNCHER, 'hook'], { encoding: 'utf8' }).stdout;
const CS_UNIT_FILE = `${HOME}/.config/systemd/user/claude-session.service`;
const CS_WANTS = `${HOME}/.config/systemd/user/default.target.wants/claude-session.service`;
// The yt-dlp routine's files, where media/yt-dlp.js ytDlpPaths puts them for HOME.
const YTDLP_BIN = `${HOME}/.local/bin/yt-dlp`;
const DENO_BIN = `${HOME}/.deno/bin/deno`;
const YTDLP_STAMP = `${HOME}/.local/state/whatsapp-bot/yt-dlp.json`;

/**
 * A box where every routine is in place and the bot runs. `o` changes it:
 * { active, loaded, masked ('empty' | 'dev-null'), enabled, crontab, sudo, hyperv,
 *   unitText, files, modes, drop: [paths], commands: [[regex, result]] (checked first),
 *   tunnel ('service' | 'none'; the box that runs the bot has cloudflared.service),
 *   cfShow (systemctl show cloudflared.service), procs: [{ pid, cgroup, net, cmdline }] (cloudflared in /proc; cmdline
 *   null: unreadable, as with hidepid; by default a tunnel run with --token on its command line) }.
 */
function fakeBox(o = {}) {
  const active = o.active ?? true;
  const loaded = o.loaded ?? true;
  const tunnel = o.tunnel ?? (active ? 'service' : 'none');
  const procs = o.procs ?? (tunnel === 'service' ? [{ pid: '4100', cgroup: '0::/system.slice/cloudflared.service\n', cmdline: SERVICE_CMDLINE }] : []);
  const files = {
    // Every process has a command line, and a container's holds the token:
    // the probe reads it to tell a tunnel from a DNS proxy, and must never
    // keep or report the token.
    ...Object.fromEntries(procs.flatMap((p) => [[`/proc/${p.pid}/comm`, `${p.comm ?? 'cloudflared'}\n`], [`/proc/${p.pid}/cgroup`, p.cgroup],
      ...(p.cmdline === null ? [] : [[`/proc/${p.pid}/cmdline`, p.cmdline ?? `cloudflared\0tunnel\0run\0--token\0${TUNNEL_TOKEN}\0`]]),
      ...(p.net ? [[`/proc/${p.pid}/net/dev`, p.net]] : [])])),
    '/proc/1/comm': 'systemd\n', '/proc/1/cgroup': '0::/init.scope\n', '/proc/self/net/dev': HOST_NET,
    ...(tunnel === 'service' ? { '/usr/bin/cloudflared': '', '/etc/cloudflared/tunnel-token': '' } : {}),
    // Every file a routine installs from, as in a current checkout.
    ...Object.fromEntries(ROUTINES.flatMap((r) => r.files ?? []).map((f) => [`${LIVE}/${f}`, 'x'])),
    [`${LIVE}/deploy/hourly-debug/sandbox.py`]: 'x',
    '/usr/bin/node': '',
    [UNIT_FILE]: o.unitText ?? RENDERED,
    [`${LIVE}/package.json`]: JSON.stringify({ dependencies: Object.fromEntries(DEPS.map((d) => [d, '*'])) }),
    '/usr/local/sbin/grow-root-disk': read('deploy/grow-root-disk'),
    [`${LIVE}/deploy/grow-root-disk`]: read('deploy/grow-root-disk'),
    '/etc/systemd/system/grow-root-disk.service': read('deploy/grow-root-disk.service'),
    [`${LIVE}/deploy/grow-root-disk.service`]: read('deploy/grow-root-disk.service'),
    [ENV_FILE]: '# settings\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-secret-value\n',
    [`${HOME}/.local/bin/claude`]: '',
    // yt-dlp and deno, checked two hours ago by the bot (the yt-dlp routine).
    [YTDLP_BIN]: '', [DENO_BIN]: '',
    [YTDLP_STAMP]: JSON.stringify({ at: new Date(NOW - 2 * 3600_000).toISOString(), ok: true, version: '2026.09.20', updated: false, by: 'the bot' }),
    [`${LIVE}/.env`]: `MASTER_KEY=abc\nBACKUP_PASSPHRASE=a long enough passphrase\n${TUNNEL_ENV_KEY}=${TUNNEL_TOKEN}\n`,
    [`${LIVE}/data/sealed-backup-status.json`]: JSON.stringify({ ok: true, at: new Date(NOW - 5 * 3600_000).toISOString() }),
    [`${LIVE}/data/hourly-debug/runs.json`]: JSON.stringify([{ id: '20260928T180002Z', at: NOW - 10 * 60_000, result: 'all-clear', found: 0 }]),
    [`${LIVE}/data/config.json`]: JSON.stringify({ email: { enabled: true, dailySummary: true, dailySummaryHour: 8 },
      backup: { enabled: true, hour: 0 }, lockdown: { enabled: true }, whatsapp: { failover: { enabled: true } },
      logging: { retentionDays: 14 }, media: { workDir: `${LIVE}/data/media` } }),
    '/etc/systemd/network/10-netplan-eth0.network.d/10-request-address.conf': '[DHCPv4]\nRequestAddress=192.168.20.37\n',
    // claude-session: set up, on the box that runs the bot and only there.
    ...(active ? { [CS_UNIT_FILE]: CS_UNIT, [CS_WANTS]: CS_UNIT, [`${HOME}/.bashrc`]: `# ~/.bashrc\n\n${CS_HOOK}` } : {}),
    ...Object.fromEntries(DEPS.map((d) => [`${LIVE}/node_modules/${d}/package.json`, '{}'])),
    ...o.files,
  };
  for (const p of o.drop ?? []) delete files[p];
  const modes = { [ENV_FILE]: 0o600, [path.dirname(ENV_FILE)]: 0o700, '/etc/cloudflared/tunnel-token': 0o600, ...o.modes };
  const dirs = { '/etc/systemd/network': ['10-netplan-eth0.network.d'], [path.dirname(ENV_FILE)]: [], '/proc': ['1', 'self', ...procs.map((p) => p.pid)] };
  // null: crontab -l fails; '': "no crontab for bot".
  let crontab = 'crontab' in o ? o.crontab : `MAILTO=""\n${HOURLY_LINE}\n${BACKUP_LINE}\n`;
  const show = o.masked
    ? `LoadState=masked\nActiveState=inactive\nUnitFileState=masked\nFragmentPath=${UNIT_FILE}\nWorkingDirectory=\nExecStart=\n`
    : loaded
    ? `LoadState=loaded\nActiveState=${active ? 'active' : 'inactive'}\nUnitFileState=${o.enabled ?? (active ? 'enabled' : 'disabled')}\n`
      + `FragmentPath=${UNIT_FILE}\nWorkingDirectory=${LIVE}\nExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node src/index.js ; ignore_errors=no }\n`
    : 'LoadState=not-found\nActiveState=inactive\nUnitFileState=\nFragmentPath=\nWorkingDirectory=\nExecStart=\n';
  const hyperv = o.hyperv ?? true;
  const calls = [];
  const commands = [
    ...(o.commands ?? []),
    [/^systemctl show whatsapp-bot\.service /, { stdout: show }],
    [/^systemctl show cloudflared\.service /, { stdout: o.cfShow ?? (tunnel === 'service' ? CF_SERVICE_SHOW : CF_NO_UNIT) }],
    [/^crontab -l$/, () => (crontab == null ? { code: 1, stderr: 'crontab: cannot open' } : crontab === '' ? { code: 1, stderr: 'no crontab for bot' } : { stdout: crontab })],
    [/^sudo -n true$/, { code: (o.sudo ?? true) ? 0 : 1, stderr: 'sudo: a password is required' }],
    [/^sudo -n -l /, { code: (o.sudo ?? true) ? 0 : 1, stderr: 'sudo: a password is required' }],
    [/^gh auth status$/, { code: 0 }],
    [/^git config --global --get-all credential/, { stdout: '!/usr/bin/gh auth git-credential\n' }],
    [/^git -C \S+ config --get user\.name$/, { stdout: 'Test Owner\n' }],
    [/^git -C \S+ config --get user\.email$/, { stdout: 'owner@example.test\n' }],
    [/^\/usr\/bin\/node --version$/, { stdout: 'v20.20.2\n' }],
    [/^systemctl is-active cron$/, { stdout: 'active\n' }],
    [/\/\.local\/bin\/claude --version$/, { stdout: '2.1.281 (Claude Code)\n' }],
    [/\/\.local\/bin\/yt-dlp --version$/, { stdout: '2026.09.20\n' }],
    [/\/\.deno\/bin\/deno --version$/, { stdout: 'deno 2.9.7 (stable, release, x86_64-unknown-linux-gnu)\nv8 15.0.245.2-rusty\n' }],
    [/^tailscale status$/, { code: 0 }],
    [/^tailscale debug prefs$/, { stdout: JSON.stringify({ RunSSH: true, OperatorUser: 'bot', AutoUpdate: { Check: true, Apply: true } }) }],
    [/^bash \S+\/render-whatsapp-bot-unit\.sh bot bot \/srv\/bot \/usr\/bin\/node$/, { stdout: RENDERED }],
    [/^systemctl is-enabled (grow-root-disk|eth0-no-offload)\.service$/, { stdout: 'enabled\n' }],
    [/^ip route show default$/, { stdout: 'default via 192.168.20.1 dev eth0 proto dhcp src 192.168.20.37 metric 100\n' }],
    [/ethtool -k eth0$/, { stdout: 'tcp-segmentation-offload: off\ngeneric-segmentation-offload: off\n' }],
    [/sandbox\.py --abi$/, { stdout: '4\n' }],
    [/^loginctl show-user bot -p Linger$/, { stdout: `Linger=${(o.linger ?? active) ? 'yes' : 'no'}\n` }],
    [/^bash \S+\/deploy\/claude-session\.sh unit$/, { stdout: CS_UNIT }],
    [/^bash \S+\/deploy\/claude-session\.sh hook$/, { stdout: CS_HOOK }],
    [/^tmux has-session -t =claude$/, { code: o.claudeRunning ? 0 : 1 }],
    // --fix: each installer "works", and the hourly one puts its line in cron.
    [/install-hourly-debug\.sh$/, () => { crontab = `${crontab ?? ''}${HOURLY_LINE}\n`; return { code: 0, stdout: 'Installed' }; }],
    [/./, { code: 0 }],
  ];
  const reads = [];
  const sys = {
    env: { PATH: '/usr/bin:/bin', ...o.env },
    home: HOME, user: 'bot', host: 'testbox', execPath: '/usr/bin/node', now: () => NOW,
    calls, reads,
    get crontab() { return crontab; },
    async run(cmd, args = []) {
      const line = [cmd, ...args].join(' ');
      calls.push(line);
      for (const [re, out] of commands) {
        if (re.test(line)) {
          const r = typeof out === 'function' ? out(line) : out;
          return { code: 0, stdout: '', stderr: '', ...r };
        }
      }
      return { code: 127, stdout: '', stderr: 'not in the fake' };
    },
    readFile: (p) => { reads.push(p); return files[p] ?? null; },
    readdir: (p) => dirs[p] ?? null,
    exists: (p) => p in files || p in dirs,
    stat: (p) => (p in files || p in dirs ? { mode: modes[p] ?? 0o644, isDir: p in dirs, mtimeMs: 0, size: 1 } : null),
    realpath: (p) => (/^\/sys\/class\/net\/eth\d\/device\/driver$/.test(p)
      ? (hyperv ? '/sys/bus/vmbus/drivers/hv_netvsc' : '/sys/bus/virtio/drivers/virtio_net')
      : p === UNIT_FILE && o.masked === 'dev-null' ? '/dev/null' : p),
    which: (name) => (['gh', 'ffmpeg', 'ffprobe', 'git', 'python3', 'flock', 'crontab', 'curl', 'tailscale', 'ethtool', 'tmux'].includes(name)
      && !(o.missingBins ?? []).includes(name) ? `/usr/bin/${name}` : null),
  };
  return sys;
}

const check = async (o = {}, { appDir = LIVE, role = null } = {}) => {
  const sys = fakeBox(o);
  const ctx = await inspectBox(sys, { appDir, role });
  const results = await checkAll(sys, ctx);
  return { sys, ctx, results, by: Object.fromEntries(results.map((r) => [r.id, r])) };
};

/* ------------------------------------------------- the registry is whole */

console.log('=== every routine says what it is, why, how to check it and how to install it ===');
{
  const ids = ROUTINES.map((r) => r.id);
  ok(new Set(ids).size === ids.length && ids.every((id) => /^[a-z][a-z0-9-]+$/.test(id)), `${ids.length} routines, each with its own id`);
  const bad = ROUTINES.filter((r) => !SCOPES[r.scope] || !r.title || !r.why || !r.check || !r.install || typeof r.probe !== 'function');
  ok(bad.length === 0, `each has a scope, a title, why, check and install text, and a probe${bad.length ? ` - not: ${bad.map((r) => r.id).join(', ')}` : ''}`);
  ok(ROUTINES.every((r) => r.userStep === null || (typeof r.userStep === 'string' && r.userStep.length > 10)),
    'a step only a person can do is spelled out as a command, or there is none');
  const need = ['sudo', 'gh-auth', 'tailscale-ssh', 'service-unit', 'grow-root-disk', 'nic-offload', 'hourly-check', 'sealed-backup',
    'temp-sweeps', 'daily-digest', 'drive-links', 'activity-backup', 'wsl-systemd', 'wsl-config', 'wsl-vm-units', 'wsl-autostart'];
  ok(need.every((id) => byId(id)), `the ones asked for are all there: ${need.join(', ')}`);
  ok(['hourly-check', 'sealed-backup', 'start-at-boot'].every((id) => byId(id).scope === 'active'),
    'the hourly check, the nightly backup and starting at boot belong to the box that runs the bot');
  ok(ROUTINES.filter((r) => r.scope === 'active').every((r) => typeof r.standby === 'function'),
    'and each says what it looks like on a box that does not');
  const missingFiles = ROUTINES.flatMap((r) => (r.files ?? []).filter((f) => !fs.existsSync(path.join(REPO, f))).map((f) => `${r.id}: ${f}`));
  ok(missingFiles.length === 0, `every file a routine names exists${missingFiles.length ? ` - not: ${missingFiles.join(', ')}` : ''}`);
}

console.log('=== bootstrap.sh installs every routine that has anything to install ===');
{
  const boot = read('tools/bootstrap.sh');
  const marked = [...boot.matchAll(/^# routine: ([a-z0-9-]+)$/gm)].map((m) => m[1]);
  const unmarked = ROUTINES.filter((r) => r.bootstrap && !marked.includes(r.id)).map((r) => r.id);
  ok(unmarked.length === 0, `each has a step marked "# routine: <id>"${unmarked.length ? ` - not: ${unmarked.join(', ')}` : ''}`);
  const stray = marked.filter((id) => !byId(id));
  ok(stray.length === 0, `and every marker names a routine${stray.length ? ` - not: ${stray.join(', ')}` : ''}`);
  const excused = ROUTINES.filter((r) => !r.bootstrap);
  ok(excused.every((r) => r.scope === 'in-process' || (typeof r.noBootstrap === 'string' && r.noBootstrap.length > 10)),
    `the rest are in-process, or say why bootstrap leaves them (${excused.filter((r) => r.scope !== 'in-process').map((r) => r.id).join(', ')})`);
  ok(ROUTINES.filter((r) => r.scope === 'in-process').every((r) => !r.bootstrap && !marked.includes(r.id)),
    'nothing inside the bot has an install step');
  const steps = (boot.match(/^step "/gm) ?? []).length;
  ok(Number(/^TOTAL=(\d+)$/m.exec(boot)?.[1]) === steps, `TOTAL counts every step (${steps})`);
  ok(/\+ node|\$NODE_BIN" "\$APP_DIR\/tools\/routines\.mjs"/.test(boot) && /step "Routines/.test(boot),
    'and its last real step is the routines check a new session runs');
  ok(/HOURLY" --set-token/.test(boot) && /IFS= read -rs -p "[^"]*token/i.test(boot),
    'the hourly check\'s token is read with no echo and handed to the installer on stdin');
  ok(!/--set-token [^|\n]*\$HTOKEN/.test(boot) && /printf '%s\\n' "\$HTOKEN" \| bash "\$HOURLY" --set-token/.test(boot),
    'never on a command line');
}

console.log('=== CLAUDE.md lists every routine, and tells a new session to check them first ===');
{
  const md = read('CLAUDE.md');
  const sec = /^## Routines every box runs\n([\s\S]*?)\n## /m.exec(md)?.[1] ?? '';
  ok(sec.length > 0 && md.indexOf('## Routines every box runs') < md.indexOf('## Rules that are not style preferences'),
    'a "Routines every box runs" section, near the top');
  ok(/node tools\/routines\.mjs\b/.test(sec) && /node tools\/routines\.mjs --fix/.test(sec), 'saying to run the check, and --fix');
  const listed = [...sec.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1]);
  const notListed = ROUTINES.map((r) => r.id).filter((id) => !listed.includes(id));
  ok(notListed.length === 0, `its table lists every routine${notListed.length ? ` - not: ${notListed.join(', ')}` : ''}`);
  const unknown = listed.filter((id) => !byId(id));
  ok(unknown.length === 0, `and nothing that is not one${unknown.length ? ` - ${unknown.join(', ')}` : ''}`);
  ok(/registry, `tools\/bootstrap\.sh` and this list, in the same commit/.test(sec.replace(/\s+/g, ' ')),
    'the rule: a new routine goes into the registry, bootstrap and the list together');
  ok(/lands as code in this repo, with a\s+test/.test(sec) && /any bugs that are fixed or requests I make for\s+permanent changes need to reflect in the repo coding/.test(sec),
    'and the owner\'s rule that every fix and permanent change lands as code with a test, in their words');

  // 2026-09-29, the operator: "the repo setup guide for a new vm should have
  // one script I can copy and paste". The block went into server-setup.md,
  // but CLAUDE.md, what a new session reads first, still sent it down the
  // step-by-step "Fast path".
  ok(/\(docs\/server-setup\.md#one-paste-a-new-vm-in-one-go\)/.test(md), 'CLAUDE.md sends a new VM to the one paste');
  ok(/^## One paste: a new VM in one go$/m.test(read('docs/server-setup.md')), 'and that heading is in docs/server-setup.md, so the link lands');
  ok(/systemctl is-enabled whatsapp-bot/.test(md) && /user\.email/.test(md),
    '"Which machine is this?" shows enabled/masked at boot and the git identity, the two bot-box2 was missing');
}

console.log('=== nothing a box runs is left out of the registry ===');
/*
 * What a box could be made to run, found in the repository, each claimed by a
 * routine or named here with why it is not one. A review found shapes the
 * first version of this missed - a bare setInterval( in src/index.js, a timer
 * in a plugin, spawnSync('crontab', ['-']), a .timer at the root, a unit
 * bootstrap.sh writes inline - so the scans are functions of a repository
 * view, run on the real tree and on copies with each of those added.
 */
// Timers that recur but are not routines, file and the text on the line.
const NOT_ROUTINE_TIMERS = {
  'src/web/server.js:const ping = setInterval(': 'the panel\'s event stream keeps each open tab\'s connection alive',
  'src/core/bot.js:this._budgetTimer = setInterval(': 'the outbound budget\'s own bookkeeping, part of the WhatsApp connection',
  'src/plugins/movie-requests/index.js:const upTicker = setInterval(': 'progress for one upload while it runs',
};
const NOT_ROUTINE_STARTS = { 'bot.start()': 'connects WhatsApp: the bot itself, not a routine' };
// Files in deploy/ that are not run on the box at all.
const NOT_ROUTINE_FILES = {
  'deploy/gpu-p-copy-drivers.ps1': 'runs on the Windows Hyper-V host, by hand after each NVIDIA driver update; nothing on the box runs it',
};
// A stale name here would quietly exempt whatever file takes it next.
{
  const gone = Object.keys(NOT_ROUTINE_FILES).filter((f) => !fs.existsSync(path.join(REPO, f)));
  ok(gone.length === 0, `every file exempted from the deploy/ scan still exists${gone.length ? ` - not: ${gone.join(', ')}` : ''}`);
}
// Units a routine installs or enables (cron: the packages routine).
const KNOWN_UNITS = new Set(['whatsapp-bot', 'grow-root-disk', 'eth0-no-offload', 'cron', 'cloudflared']);

function repoView(overlay = {}) {
  const real = (f) => { try { return fs.readFileSync(path.join(REPO, f), 'utf8'); } catch { return null; } };
  const walk = (dir) => {
    let out = [];
    try {
      for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
        // .claude holds Claude Code's own files, and its worktrees are whole
        // copies of this repo: scanned, every unit in them was reported twice.
        if (['node_modules', '.git', 'data', '.claude'].includes(e.name)) continue;
        const rel = dir ? `${dir}/${e.name}` : e.name;
        out = e.isDirectory() ? out.concat(walk(rel)) : out.concat(rel);
      }
    } catch { /* gone */ }
    return out;
  };
  const files = new Set([...walk(''), ...Object.keys(overlay)].filter((f) => overlay[f] !== null));
  return { files: [...files].sort(), read: (f) => (f in overlay ? overlay[f] : real(f)) };
}

function unclaimed(view) {
  const claimed = new Set(ROUTINES.flatMap((r) => r.files ?? []));
  const isClaimed = (f) => [...claimed].some((c) => f === c || (c.endsWith('/') && f.startsWith(c)));
  const code = ROUTINES.flatMap((r) => r.code ?? []);
  const out = [];
  const source = view.files.filter((f) => /\.(m?js|sh)$/.test(f) && !/^test\//.test(f) && !/^src\/web\/public\//.test(f));
  // Files in deploy/, and systemd units anywhere.
  for (const f of view.files) {
    if (/^deploy\//.test(f) && !isClaimed(f) && !NOT_ROUTINE_FILES[f]) out.push(`${f}: a file in deploy/`);
    if (/\.(service|timer|path|socket)$/.test(f) && !isClaimed(f)) out.push(`${f}: a systemd unit`);
  }
  for (const f of source) {
    const text = view.read(f) ?? '';
    // A crontab written, by a pipe or by a spawn given "-".
    if ((/\|\s*crontab\s+-(\s|$|")/m.test(text) || /crontab\w*\(\s*\[\s*'-'\s*\]/.test(text)
      || /['"]crontab['"]\s*,\s*\[\s*['"]-['"]/.test(text)) && !isClaimed(f)) out.push(`${f}: writes a crontab`);
    // A unit written into /etc/systemd/system or enabled: a routine's unit, or
    // (a name in a variable) from a file a routine owns, or bootstrap.
    for (const m of text.matchAll(/\/etc\/systemd\/system\/([\w.@${}-]+)|systemctl\s+(?:-\S+\s+)*enable\s+(?:--now\s+)?"?([\w.@${}-]+)/g)) {
      const unit = (m[1] ?? m[2]).replace(/\.(service|timer|path|socket)$/, '');
      if (KNOWN_UNITS.has(unit)) continue;
      if (/\$/.test(unit) && (isClaimed(f) || f === 'tools/bootstrap.sh')) continue;
      out.push(`${f}: installs or enables the unit ${unit}`);
    }
    // Timers: every setInterval, claimed by a routine's code or named above.
    // Not in the registry itself, whose `code` entries quote them.
    if (/^src\//.test(f) && f !== 'src/core/routines.js') {
      for (const line of text.split('\n')) {
        if (!/setInterval\(/.test(line) || /^\s*(\/\/|\*)/.test(line)) continue;
        const known = Object.keys(NOT_ROUTINE_TIMERS).some((k) => k.startsWith(`${f}:`) && line.includes(k.slice(f.length + 1)));
        const mine = code.some((c) => c.file === f && line.includes(c.contains.trim()));
        if (!known && !mine) out.push(`${f}: setInterval( not claimed - ${line.trim().slice(0, 80)}`);
      }
    }
  }
  // The bot's .start() calls in src/index.js: each a routine, bar the connection.
  const index = view.read('src/index.js') ?? '';
  for (const m of new Set([...index.matchAll(/\b(\w+)\.start\(\)/g)].map((x) => `${x[1]}.start()`))) {
    if (NOT_ROUTINE_STARTS[m] || code.some((c) => c.contains.includes(m))) continue;
    out.push(`src/index.js: ${m} is not a routine`);
  }
  return out;
}

{
  const view = repoView();
  const found = unclaimed(view);
  ok(found.length === 0, `everything a box runs belongs to a routine${found.length ? ` - not: ${found.join('; ')}` : ''}`);
  const walkAll = view.files.filter((f) => /\.(m?js|sh)$/.test(f) && !/^test\//.test(f));
  const writers = walkAll.filter((f) => /\|\s*crontab\s+-(\s|$|")|crontab\w*\(\s*\[\s*'-'\s*\]/im.test(view.read(f)));
  ok(writers.length >= 2, `the crontab writers are found (${writers.join(', ')})`);
  const stale = ROUTINES.flatMap((r) => (r.code ?? []).filter((c) => !read(c.file).includes(c.contains)).map((c) => `${r.id}: ${c.file}`));
  ok(ROUTINES.filter((r) => r.scope === 'in-process').every((r) => r.code?.length) && stale.length === 0,
    `and every in-process routine points at code that is still there${stale.length ? ` - gone: ${stale.join(', ')}` : ''}`);

  // The review's mutations, each on its own copy: every one is caught.
  const indexJs = read('src/index.js');
  const tvPlugin = read('src/plugins/tv-requests/index.js');
  const bootstrap = read('tools/bootstrap.sh');
  for (const [what, overlay] of [
    ['a bare setInterval( in src/index.js', { 'src/index.js': `${indexJs}\nsetInterval(() => pruneLibraryCache(), 6 * 3600_000);\n` }],
    ['a timer in a plugin', { 'src/plugins/tv-requests/index.js': `${tvPlugin}\nconst __nightly = setInterval(() => {}, 86_400_000);\n` }],
    ['a tool that writes cron through spawnSync', { 'tools/nightly-prune.mjs': "import { spawnSync } from 'node:child_process';\nspawnSync('crontab', ['-'], { input: '0 3 * * * prune' });\n" }],
    ['a .timer at the repo root', { 'whatsapp-bot-prune.timer': '[Timer]\nOnCalendar=daily\n' }],
    ['a unit bootstrap.sh writes inline', { 'tools/bootstrap.sh': `${bootstrap}\nsudo tee /etc/systemd/system/bot-prune.timer >/dev/null <<'U'\n[Timer]\nU\nsudo systemctl enable --now bot-prune.timer\n` }],
    ['a stray file in deploy/', { 'deploy/prune.sh': '#!/bin/sh\n' }],
    ['a new .start() in src/index.js', { 'src/index.js': `${indexJs}\nprune.start();\n` }],
  ]) {
    const got = unclaimed(repoView(overlay)).filter((x) => !found.includes(x));
    ok(got.length > 0, `caught: ${what} (${got[0] ?? 'nothing found'})`);
  }
}

console.log('=== the check says what the installers and the docs say ===');
{
  ok(read('deploy/install-hourly-debug.sh').includes(`TAG='${HOURLY_TAG}'`), 'the hourly cron tag is the installer\'s');
  ok(CRON_TAG === BACKUP_TAG, 'the nightly backup\'s is sealed-backup.js\'s');
  ok(read('docs/server-setup.md').includes(SUDO_COMMAND), 'the sudo command it prints is the one in docs/server-setup.md');
  for (const doc of ['docs/server-setup.md', 'docs/operations.md']) {
    const d = read(doc);
    ok(/node tools\/routines\.mjs --fix/.test(d) && /--set-token/.test(d), `${doc} has the check, --fix and the token step`);
  }
  ok(/'--set-token'|--set-token\) MODE=token/.test(read('deploy/install-hourly-debug.sh')), 'and --set-token is a flag the installer takes');
  const { forbiddenChanges } = await import('../tools/hourly-debug.mjs');
  ok(!!forbiddenChanges('M\tsrc/core/routines.js') && !!forbiddenChanges('M\ttools/routines.mjs'),
    'the hourly check\'s fixes may not change the registry or the check');
}

/* ---------------------------------------------------------- the probes */

console.log('=== a box where everything is in place ===');
{
  const { ctx, results, by, sys } = await check();
  ok(ctx.role === 'active' && ctx.isLive && ctx.liveDir === LIVE, `the box running the bot is "active" (${ctx.roleWhy})`);
  const notOk = results.filter((r) => !['ok', 'in-process'].includes(r.state) && !(r.scope === 'wsl' && r.state === 'n/a'))
    .map((r) => `${r.id}=${r.state}`);
  ok(notOk.length === 0, `every routine is ok or runs in the bot${notOk.length ? ` - not: ${notOk.join(', ')}` : ''}`);
  ok(results.filter((r) => r.scope === 'wsl').every((r) => r.state === 'n/a' && /not WSL/.test(r.detail[0])),
    'and the WSL ones say they do not apply to a VM');
  ok(exitCode(results) === 0, 'and the check exits 0');
  ok(/on, at 08:00/.test(by['daily-digest'].detail.join()) && /running here/.test(by['daily-digest'].detail.join()),
    'an in-process routine says the bot is running and how it is set');
  ok(/last run 2026-09-28 18:00 UTC/.test(by['hourly-check'].detail.join()), `the hourly check's last run, 24-hour (${by['hourly-check'].detail.join(' | ')})`);
  ok(!JSON.stringify(results).includes('secret-value') && !JSON.stringify(results).includes('long enough passphrase')
    && !JSON.stringify(results).includes(TUNNEL_TOKEN), 'no token or passphrase ever reaches the report');
  ok(!sys.calls.some((c) => /systemctl (start|stop|restart|enable|disable)|install-|--install-cron|apt-get/.test(c)),
    'a plain check changes nothing');
  const report = formatReport(results, ctx);
  ok(/RUNS the bot/.test(report) && /Every routine that applies to this box is in place/.test(report), 'and says so');
}

console.log('=== the hourly check: missing, fixed, and needing the user ===');
{
  const none = await check({ crontab: `${BACKUP_LINE}\n` });
  const h = none.by['hourly-check'];
  ok(h.state === 'missing' && /not in cron/.test(h.detail[0]) && h.fix?.[0].display === 'deploy/install-hourly-debug.sh',
    'not in cron: missing, and --fix runs the installer');
  ok(/node tools\/routines\.mjs --fix/.test(h.next[0]), `with the next command (${h.next[0]})`);
  const done = await applyFixes(none.results, none.sys);
  ok(done.length === 1 && done[0].id === 'hourly-check' && done[0].ok, 'applyFixes runs exactly that');
  const again = await checkAll(none.sys, await inspectBox(none.sys, { appDir: LIVE }));
  ok(again.find((r) => r.id === 'hourly-check').state === 'ok', 'and the check after it finds it in place');

  const other = await check({ crontab: `${HOURLY_LINE.replace(LIVE, '/tmp/worktree')}\n${BACKUP_LINE}\n` });
  ok(other.by['hourly-check'].state === 'missing' && /another checkout/.test(other.by['hourly-check'].detail[0]),
    'a cron line that runs another checkout is not the live one\'s');

  const noToken = await check({ files: { [ENV_FILE]: '# CLAUDE_CODE_OAUTH_TOKEN=\nHOURLY_DEBUG_PUSH=1\n' } });
  const t = noToken.by['hourly-check'];
  ok(t.state === 'needs-user' && /no Claude token/.test(t.detail[0]), 'no token: it needs the user');
  ok(t.next.some((n) => /claude setup-token/.test(n)) && t.next.some((n) => /install-hourly-debug\.sh --set-token/.test(n))
    && !t.next.some((n) => /echo/.test(n)), 'and says: claude setup-token, then --set-token (never an echo into the file)');
  ok(exitCode(noToken.results) === 1, 'which makes the check exit 1');

  const loose = await check({ modes: { [ENV_FILE]: 0o644 } });
  ok(loose.by['hourly-check'].state === 'missing' && /mode 644, not 600/.test(loose.by['hourly-check'].detail[0]),
    'a token file others can read is fixed by the installer, which chmods it');

  const failed = await check({ files: { [`${LIVE}/data/hourly-debug/install.json`]: JSON.stringify({ at: '2026-09-28T17:00:00Z', event: 'token', cron: true, token: true, verify: 'failed' }) } });
  ok(failed.by['hourly-check'].state === 'needs-user' && /did not work/.test(failed.by['hourly-check'].detail[0])
    && failed.by['hourly-check'].next.some((n) => /setup-token/.test(n)), 'a token that failed its test needs a new one');

  const stopped = await check({ files: { [`${LIVE}/data/hourly-debug/runs.json`]: JSON.stringify([{ id: '20260928T120002Z', at: NOW - 6 * 3600_000, result: 'all-clear' }]) } });
  ok(stopped.by['hourly-check'].state === 'needs-user' && /no run since 2026-09-28 12:10 UTC/.test(stopped.by['hourly-check'].detail.join()),
    'in cron but not running for hours: says since when, and where to look');

  const noLandlock = await check({ commands: [[/sandbox\.py --abi$/, { stdout: '0\n' }]] });
  ok(noLandlock.by['hourly-check'].state === 'needs-user' && noLandlock.by['hourly-check'].next.some((n) => /HOURLY_DEBUG_FS_SANDBOX=0/.test(n)),
    'no Landlock: the choice is the user\'s, and the setting is named');

  // Tried from inside the sandbox, as every run does: an open door is the
  // user's to know about, and no session runs while it is open.
  const open = await check({ commands: [[/sandbox\.py --probe \d+$/, { stdout: 'UNIX sockets (systemd-run --user, the lxd socket)\n' }]] });
  ok(open.by['hourly-check'].state === 'needs-user' && /leaves UNIX sockets .* open: the research session is never started/.test(open.by['hourly-check'].detail.join()),
    `a sandbox that lets a UNIX socket through is reported (${open.by['hourly-check'].detail[0]})`);
  const shut = await check({ commands: [[/sandbox\.py --probe \d+$/, { stdout: 'closed\n' }]] });
  ok(!/leaves/.test(shut.by['hourly-check'].detail.join()), 'and one that keeps them shut is not');

  // The line before it made its folder first: the installer rewrites it.
  const oldLine = `0 * * * * /bin/bash ${LIVE}/deploy/hourly-debug/run.sh >> ${HOME}/.local/share/whatsapp-bot-debug/cron.log 2>&1 ${HOURLY_TAG}`;
  const stale = await check({ crontab: `${BACKUP_LINE}\n${oldLine}\n` });
  ok(stale.by['hourly-check'].state === 'missing' && /does not make its log folder first/.test(stale.by['hourly-check'].detail.join()),
    'an old cron line that cannot survive its log folder going is rewritten by --fix');
  // The line from before the tick (the operator, 2026-10-12: a library
  // keeper's #issue "get[s] top priority" and the check runs "right away"):
  // on the hour only, so the bot's request waited for it.
  const hourOnly = `0 * * * * mkdir -p ${HOME}/.local/share/whatsapp-bot-debug && /bin/bash ${LIVE}/deploy/hourly-debug/run.sh >> ${HOME}/.local/share/whatsapp-bot-debug/cron.log 2>&1 ${HOURLY_TAG}`;
  const hourly = await check({ crontab: `${BACKUP_LINE}\n${hourOnly}\n` });
  ok(hourly.by['hourly-check'].state === 'missing'
    && hourly.by['hourly-check'].detail.includes('the cron line runs on the hour only, so a library keeper\'s #issue waits for it')
    && hourly.by['hourly-check'].fix?.[0].display === 'deploy/install-hourly-debug.sh',
  `a cron line on the hour only is rewritten by --fix (${hourly.by['hourly-check'].detail[0]})`);
  const tickOnTheHour = await check({ crontab: `${BACKUP_LINE}\n${HOURLY_LINE.replace('* * * * *', '0 * * * *')}\n` });
  ok(tickOnTheHour.by['hourly-check'].state === 'missing', 'and so is a tick that cron starts only on the hour');
  // A review (2026-10-12): cron calling run.sh --tick itself is a whole run
  // every minute in a checkout from before the tick, whose run.sh passes
  // --tick on to a check that ignores it. tick.sh is a file no such
  // checkout has.
  const viaRunSh = await check({ crontab: `${BACKUP_LINE}\n${HOURLY_LINE.replace('tick.sh', 'run.sh --tick')}\n` });
  ok(viaRunSh.by['hourly-check'].state === 'missing'
    && viaRunSh.by['hourly-check'].detail.includes('the cron line ticks through run.sh, which a checkout from before the tick would take for a whole run every minute'),
  `a tick through run.sh --tick is rewritten by --fix to go through tick.sh (${viaRunSh.by['hourly-check'].detail[0]})`);
  const ticking = await check();
  ok(ticking.by['hourly-check'].state === 'ok'
    && ticking.by['hourly-check'].detail.includes('in cron, every minute a tick: on the hour, and at once for a library keeper\'s #issue'),
  'the tick every minute is in place, and says what it is for');
  // And the installer's line, as cron's /bin/sh runs it, with the folder gone.
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cronline-'));
    const app = path.join(tmp, 'app');
    fs.mkdirSync(path.join(app, 'deploy', 'hourly-debug'), { recursive: true });
    fs.writeFileSync(path.join(app, 'deploy', 'hourly-debug', 'tick.sh'), `touch ${tmp}/ran\necho ran\n`);
    const state = path.join(tmp, 'state-cleared');
    const tmpl = /^LINE="\* \* \* \* \* (.*) \$TAG"$/m.exec(read('deploy/install-hourly-debug.sh'))[1];
    const cmd = tmpl.replaceAll('$APP_DIR', app).replaceAll('$STATE_DIR', state);
    const r = spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' });
    ok(r.status === 0 && fs.existsSync(path.join(tmp, 'ran')) && /ran/.test(fs.readFileSync(path.join(state, 'cron.log'), 'utf8')),
      `with its state folder removed, the cron line still runs, and logs (${r.stderr.trim() || 'ok'})`);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const old = await check({ crontab: `${BACKUP_LINE}\n`, drop: [`${LIVE}/deploy/install-hourly-debug.sh`] });
  ok(old.by['hourly-check'].state === 'needs-user' && /predates this routine/.test(old.by['hourly-check'].detail.join())
    && !old.by['hourly-check'].fix, 'a live checkout that predates the installer is updated first, not "fixed" with a script it lacks');
}

console.log('=== sudo narrowed to the hourly check\'s restart rule is an accepted state ===');
{
  // install-hourly-debug.sh (step 3) offers to keep only
  // "NOPASSWD: /usr/bin/systemctl restart whatsapp-bot" and remove the full
  // rule; this check then asked for NOPASSWD:ALL back, undoing it.
  const narrowed = await check({ sudo: false, commands: [[/^sudo -n -l \/usr\/bin\/systemctl restart whatsapp-bot$/, { code: 0 }]] });
  ok(narrowed.by.sudo.state === 'ok' && /narrowed to the one rule the hourly check needs/.test(narrowed.by.sudo.detail.join()),
    `ok, with a note on what needs a person (${narrowed.by.sudo.state}: ${narrowed.by.sudo.detail.join()})`);
  ok(!(narrowed.by.sudo.next ?? []).some((n) => /NOPASSWD:ALL/.test(n)), 'and it does not print the command that puts NOPASSWD:ALL back');
  const none = await check({ sudo: false, commands: [[/^sudo -n -l /, { code: 1 }]] });
  ok(none.by.sudo.state === 'needs-user', 'with neither, the user still has the one command to run');
}

console.log('=== a fix that needs sudo, on a box without it, is the user\'s ===');
{
  const r = await check({ sudo: false, commands: [[/^systemctl is-enabled eth0-no-offload\.service$/, { code: 1, stdout: 'not-found\n' }]] });
  ok(r.by.sudo.state === 'needs-user' && r.by.sudo.next[0].includes(SUDO_COMMAND), 'no passwordless sudo: the exact command from the docs');
  const nic = r.by['nic-offload'];
  ok(nic.state === 'needs-user' && !nic.fix && /deploy\/install-units\.sh nic-offload .*needs sudo/.test(nic.next[0]),
    `the NIC fix is printed for a person, not attempted (${nic.next[0]})`);
  const done = await applyFixes(r.results, r.sys);
  ok(!done.some((d) => d.id === 'nic-offload'), 'and --fix leaves it alone');
}

console.log('=== yt-dlp: installed, runnable, deno beside it, and updated within three days ===');
{
  // 2026-10-11: a YouTube link on "Queue a public link" was refused as "a web
  // page (text/html)", and the operator asked for yt-dlp on the bot system.
  const fine = await check();
  ok(fine.by['yt-dlp'].state === 'ok' && /yt-dlp 2026\.09\.20 \(released 8 days ago\) at \/home\/bot\/\.local\/bin\/yt-dlp, deno 2\.9\.7/.test(fine.by['yt-dlp'].detail[0])
    && /last update check 2026-09-28 16:10 UTC, up to date \(by the bot\)/.test(fine.by['yt-dlp'].detail[1]),
  `in place: the version, deno, and the last check, 24-hour (${fine.by['yt-dlp'].detail.join(' | ')})`);
  ok(byId('yt-dlp').scope === 'every' && byId('yt-dlp').bootstrap && byId('yt-dlp').files.includes('tools/install-yt-dlp.mjs'),
    'on every bot box, installed by bootstrap, from tools/install-yt-dlp.mjs');
  ok(byId('yt-dlp-update').scope === 'in-process' && byId('yt-dlp-update').code.some((c) => c.contains === 'ytDlpUpdater.start()'),
    'and kept current by the bot itself (yt-dlp-update, in-process)');

  const none = await check({ drop: [YTDLP_BIN] });
  const y = none.by['yt-dlp'];
  ok(y.state === 'missing' && /yt-dlp is not installed/.test(y.detail[0]) && y.fix[0].display === 'node tools/install-yt-dlp.mjs'
    && y.fix[0].argv.join(' ') === '/usr/bin/node /srv/bot/tools/install-yt-dlp.mjs' && !y.fix[0].sudo,
  `not installed: --fix runs the installer from the live checkout, without sudo (${y.fix?.[0]?.argv.join(' ')})`);
  const done = await applyFixes(none.results, none.sys);
  ok(done.length === 1 && done[0].id === 'yt-dlp' && done[0].ok, 'and applyFixes runs exactly that');

  const broken = await check({ commands: [[/\/\.local\/bin\/yt-dlp --version$/, { code: 127, stderr: '/usr/bin/env: \'python3\': No such file or directory' }]] });
  ok(broken.by['yt-dlp'].state === 'missing' && /does not run \(\/usr\/bin\/env: 'python3'/.test(broken.by['yt-dlp'].detail[0]),
    `there but not running: says why (${broken.by['yt-dlp'].detail[0]})`);

  const noDeno = await check({ drop: [DENO_BIN] });
  ok(noDeno.by['yt-dlp'].state === 'missing' && /deno is not installed/.test(noDeno.by['yt-dlp'].detail[0])
    && noDeno.by['yt-dlp'].fix[0].display === 'node tools/install-yt-dlp.mjs', 'no deno: missing, the installer brings it');
  const oldDeno = await check({ commands: [[/\/\.deno\/bin\/deno --version$/, { stdout: 'deno 2.1.4 (stable)\n' }]] });
  ok(oldDeno.by['yt-dlp'].state === 'missing' && /deno 2\.1\.4 is older than the 2\.3\.0 yt-dlp needs/.test(oldDeno.by['yt-dlp'].detail[0]),
    'a deno older than yt-dlp\'s minimum: missing');

  const stale = await check({ files: { [YTDLP_STAMP]: JSON.stringify({ at: new Date(NOW - 4 * 86_400_000).toISOString(), ok: true, version: '2026.09.20' }) } });
  ok(stale.by['yt-dlp'].state === 'missing' && /the last update check was 4 days ago \(2026-09-24 18:10 UTC\)/.test(stale.by['yt-dlp'].detail.join())
    && stale.by['yt-dlp'].fix[0].display === 'node tools/install-yt-dlp.mjs --update', 'not checked for three days: --fix updates it');
  const never = await check({ drop: [YTDLP_STAMP] });
  ok(never.by['yt-dlp'].state === 'missing' && /no update check has been recorded/.test(never.by['yt-dlp'].detail.join()), 'never checked: missing');
  const failed = await check({ files: { [YTDLP_STAMP]: JSON.stringify({ at: new Date(NOW - 3600_000).toISOString(), ok: false, error: 'yt-dlp -U failed (exit 1): HTTP Error 503' }) } });
  ok(failed.by['yt-dlp'].state === 'missing' && /failed: yt-dlp -U failed \(exit 1\): HTTP Error 503/.test(failed.by['yt-dlp'].detail.join()),
    'a failed check says what failed');
  // Stable releases came 84 days apart in 2026 (03.17 -> 06.09): an old
  // version alone is no fault while the checks say it is the latest, but four
  // months is.
  const gap = await check({ commands: [[/\/\.local\/bin\/yt-dlp --version$/, { stdout: '2026.07.04\n' }]] });
  ok(gap.by['yt-dlp'].state === 'ok', 'a release 86 days old, checked today and still the latest: in place');
  const ancient = await check({ commands: [[/\/\.local\/bin\/yt-dlp --version$/, { stdout: '2026.03.17\n' }]] });
  ok(ancient.by['yt-dlp'].state === 'missing' && /release is 195 days old/.test(ancient.by['yt-dlp'].detail.join()), 'one 195 days old: missing');

  const standby = await check({ active: false });
  ok(standby.by['yt-dlp'].state === 'ok', 'a standby box has it too: every bot box can become the one that runs the bot');
}

console.log('=== each probe reads its routine right ===');
{
  const nic = await check({ commands: [[/^systemctl is-enabled eth0-no-offload\.service$/, { code: 1, stdout: 'not-found\n' }]] });
  ok(nic.by['nic-offload'].state === 'missing' && /not installed: offload comes back on at the next boot/.test(nic.by['nic-offload'].detail[0])
    && nic.by['nic-offload'].fix[0].display === 'deploy/install-units.sh nic-offload',
  'bot-box today: offload off by hand, no unit - missing, and installed through deploy/install-units.sh');
  const vio = await check({ hyperv: false });
  ok(vio.by['nic-offload'].state === 'n/a' && /virtio_net: not a Hyper-V NIC/.test(vio.by['nic-offload'].detail[0]), 'not Hyper-V: does not apply');

  const noPre = await check({ unitText: RENDERED.replace(/^ExecStartPre=.*\n/m, '') });
  ok(noPre.by['service-unit'].state === 'missing' && /never updates itself/.test(noPre.by['service-unit'].detail[0])
    && /next start; --fix never restarts/.test(noPre.by['service-unit'].detail.join()), 'a unit without the updater: missing, re-rendered, and nothing restarted');
  const drift = await check({ commands: [[/render-whatsapp-bot-unit\.sh/, { stdout: `${RENDERED}# a newer line\n` }]] });
  ok(drift.by['service-unit'].state === 'missing' && /differs from the repo/.test(drift.by['service-unit'].detail[0]), 'a unit that differs from the repo\'s rendering: missing');
  const gone = await check({ commands: [[/^systemctl is-enabled grow-root-disk\.service$/, { code: 1, stdout: 'disabled\n' }]], files: { '/usr/local/sbin/grow-root-disk': 'old' } });
  ok(gone.by['grow-root-disk'].state === 'missing' && gone.by['grow-root-disk'].detail.length === 2, 'grow-root-disk out of date and not enabled');

  const ts = await check({ commands: [[/^tailscale debug prefs$/, { stdout: JSON.stringify({ RunSSH: false, OperatorUser: '', AutoUpdate: { Apply: false } }) }]] });
  ok(ts.by['tailscale-ssh'].state === 'missing' && ts.by['tailscale-ssh'].detail.length === 3
    && ts.by['tailscale-ssh'].fix[0].argv.join(' ') === 'sudo -n tailscale set --ssh --operator=bot --auto-update', 'Tailscale SSH off: tailscale set, with sudo -n');
  const noTs = await check({ missingBins: ['tailscale'] });
  ok(noTs.by['tailscale-ssh'].state === 'needs-user' && noTs.by['tailscale-ssh'].next.some((n) => /tailscale up --ssh --operator=bot/.test(n)),
    'Tailscale not installed: its login is a browser link, so it is the user\'s');

  const gh = await check({ commands: [[/^git config --global/, { code: 1, stdout: '' }]] });
  ok(gh.by['gh-auth'].state === 'missing' && gh.by['gh-auth'].fix[0].display === 'gh auth setup-git', 'git not using gh: gh auth setup-git');
  const ghOut = await check({ commands: [[/^gh auth status$/, { code: 1 }]] });
  ok(ghOut.by['gh-auth'].state === 'needs-user' && /gh auth login/.test(ghOut.by['gh-auth'].next[0]), 'gh logged out: gh auth login is the user\'s');

  // bot-box2, 2026-09-29: no git identity anywhere, and the first commit on
  // the box failed with "Author identity unknown". The check now says so, and
  // --fix gives it the repository owner's, from the last commit on main.
  const noId = await check({ commands: [[/^git -C \S+ config --get user\./, { code: 1 }],
    [/^git -C \/srv\/bot log -1 --format=%an%n%ae origin\/main$/, { stdout: 'Repo Owner\nowner@example.test\n' }]] });
  const id = noId.by['gh-auth'];
  ok(id.state === 'missing' && /Author identity unknown/.test(id.detail.join()) && /Repo Owner <owner@example\.test>/.test(id.detail.join()),
    `no git identity: missing, naming the owner it would take (${id.detail.join()})`);
  ok(id.fix.map((f) => f.display).join(' | ') === "git config --global user.name 'Repo Owner' | git config --global user.email owner@example.test"
    && !id.fix.some((f) => f.sudo), `and --fix sets it globally, without sudo (${id.fix.map((f) => f.display).join(' | ')})`);
  const noMain = await check({ commands: [[/^git -C \S+ config --get user\./, { code: 1 }], [/^git -C \S+ log /, { code: 128 }]] });
  ok(noMain.by['gh-auth'].state === 'needs-user' && /git config --global user\.name/.test(noMain.by['gh-auth'].next[0]),
    'with no main to take it from, the commands are the user\'s');
  ok(noId.by['gh-auth'].detail.length === 1 && gh.by['gh-auth'].detail.length === 1,
    'the helper and the identity are reported apart');
  const both = await check({ commands: [[/^git config --global/, { code: 1, stdout: '' }], [/^git -C \S+ config --get user\.email$/, { code: 1 }],
    [/^git -C \S+ log /, { stdout: 'Repo Owner\nowner@example.test\n' }]] });
  ok(both.by['gh-auth'].fix.length === 3 && both.by['gh-auth'].fix[0].display === 'gh auth setup-git', 'and both at once are fixed together');
  const idOk = await check();
  ok(idOk.by['gh-auth'].state === 'ok' && /commits as Test Owner <owner@example\.test>/.test(idOk.by['gh-auth'].detail[0]), 'with one: ok, and says whose');

  // bot-box2, 2026-09-29: /etc/systemd/system/whatsapp-bot.service was an
  // empty, root-owned file, which systemd reads as masked. This check called
  // it "not installed".
  const empty = await check({ masked: 'empty', active: false, crontab: '' });
  ok(empty.ctx.role === 'standby' && /masked/.test(empty.ctx.roleWhy), `a masked unit is a standby box, not a clone (${empty.ctx.roleWhy})`);
  ok(empty.by['service-unit'].state === 'missing' && /is masked: \S+ is empty/.test(empty.by['service-unit'].detail[0])
    && !/not installed/.test(empty.by['service-unit'].detail[0]) && empty.by['service-unit'].fix[0].display === 'deploy/install-units.sh whatsapp-bot',
  `an empty unit file: masked, not "not installed", and --fix writes the unit (${empty.by['service-unit'].detail[0]})`);
  ok(empty.by['start-at-boot'].state === 'standby' && /masked/.test(empty.by['start-at-boot'].detail[0])
    && !/as a box that does not run the bot should be/.test(empty.by['start-at-boot'].detail[0]),
  'and start-at-boot says masked, rather than calling it the right standby state');
  const nulled = await check({ masked: 'dev-null', active: false, crontab: '' });
  ok(nulled.by['service-unit'].state === 'needs-user' && /link to \/dev\/null/.test(nulled.by['service-unit'].detail[0])
    && /sudo systemctl unmask whatsapp-bot/.test(nulled.by['service-unit'].next[0]) && !nulled.by['service-unit'].fix,
  'masked with systemctl mask (a link to /dev/null): somebody\'s decision, so the user\'s to undo, never --fix\'s');

  const pk = await check({ missingBins: ['ffprobe'], commands: [[/^systemctl is-active cron$/, { stdout: 'inactive\n' }]] });
  ok(pk.by.packages.state === 'missing' && pk.by.packages.fix.map((s) => s.display).join(' | ') === 'sudo apt-get install -y ffmpeg | sudo systemctl enable --now cron',
    'no ffprobe and cron stopped: apt-get and cron, with sudo');
  const noDeps = await check({ drop: [`${LIVE}/node_modules/express/package.json`] });
  ok(noDeps.by.packages.state === 'needs-user' && /npm ci --omit=dev/.test(noDeps.by.packages.next[0]),
    'missing npm dependencies are the user\'s: node_modules is not replaced under a running bot');

  const cc = await check({ drop: [`${HOME}/.local/bin/claude`] });
  ok(cc.by['claude-code'].state === 'missing' && /claude\.ai\/install\.sh/.test(cc.by['claude-code'].fix[0].display), 'no Claude Code: its installer');

  const noPass = await check({ files: { [`${LIVE}/.env`]: 'MASTER_KEY=abc\n' }, crontab: `${HOURLY_LINE}\n` });
  ok(noPass.by['sealed-backup'].state === 'needs-user' && /--set-passphrase --install-cron/.test(noPass.by['sealed-backup'].next[0]),
    'no backup passphrase: --set-passphrase is the user\'s (asked twice, hidden)');
  const noLine = await check({ crontab: `${HOURLY_LINE}\n` });
  ok(noLine.by['sealed-backup'].state === 'missing' && noLine.by['sealed-backup'].fix[0].display === 'node tools/backup-secrets.mjs --install-cron',
    'a passphrase but no nightly line: --install-cron');
  const owned = await check({ files: { [`${LIVE}/data/sealed-backup-status.json`]: JSON.stringify({ ok: false, at: '2026-09-28T05:17:00Z',
    error: 'the sealed-backup branch holds the backup of another machine (old-box, ...)' }) } });
  ok(owned.by['sealed-backup'].state === 'needs-user' && /only if THIS box now runs the bot/.test(owned.by['sealed-backup'].next[0]),
    'a branch another machine owns: --take-over is offered only with its warning');
  ok(/moves to archive\/ on the branch; nothing is lost/.test(owned.by['sealed-backup'].next[0]),
    'and it says the other machine\'s backup is archived, not replaced');

  // bot-box on 2026-09-29: its backup refused because the branch held
  // bot-box4's. Once the box running the bot has taken the branch over, the
  // check is ok, and names what the branch keeps in archive/.
  const archive = [{ folder: 'bot-box4-00000000', host: 'bot-box4', createdAt: '2026-09-23T05:17:01.784Z' }];
  const tookOver = await check({ files: { [`${LIVE}/data/sealed-backup-status.json`]: JSON.stringify({ ok: true,
    at: new Date(NOW - 3600_000).toISOString(), archived: { ...archive[0], why: 'this machine runs the bot now' }, archive }) } });
  const sb = tookOver.by['sealed-backup'];
  ok(sb.state === 'ok', 'the backup at the top of the branch is this box\'s: ok');
  ok(sb.detail.some((d) => /took the branch over: bot-box4's \(2026-09-23 05:17 UTC\) was moved to archive\/bot-box4-00000000\//.test(d)),
    'it says that run took the branch over, and where the old backup went');
  ok(sb.detail.some((d) => /archived on the branch: bot-box4 \(2026-09-23 05:17 UTC, archive\/bot-box4-00000000\/\) - node tools\/restore-secrets\.mjs --list-archive/.test(d)),
    'and lists the archived machines, with how to see them');
  const nightly = await check({ files: { [`${LIVE}/data/sealed-backup-status.json`]: JSON.stringify({ ok: true,
    at: new Date(NOW - 3600_000).toISOString(), archived: null, archive }) } });
  ok(nightly.by['sealed-backup'].state === 'ok' && nightly.by['sealed-backup'].detail.some((d) => /archived on the branch: bot-box4/.test(d))
    && !nightly.by['sealed-backup'].detail.some((d) => /took the branch over/.test(d)), 'a later night: still listed, no take-over claimed');
  const otherBot = await check({ files: { [`${LIVE}/data/sealed-backup-status.json`]: JSON.stringify({ ok: false, at: '2026-09-28T05:17:00Z',
    refused: 'other-bot', archive, error: 'the sealed-backup branch holds the backup of another machine (bot-box, ...), and that is a different bot' }) } });
  ok(otherBot.by['sealed-backup'].state === 'needs-user' && otherBot.by['sealed-backup'].next.some((n) => /--skip sealed-backup/.test(n))
    && otherBot.by['sealed-backup'].detail.some((d) => /archived on the branch: bot-box4/.test(d)),
  'refused as a different bot: the skip for a second number is offered too, and the archive still listed');
  // The review of 2026-09-29 added a refusal whose message names no "other
  // machine": a root whose manifest cannot be read. It is still a refusal,
  // with the by-hand way out - not "run it by hand to see why".
  const unreadable = await check({ files: { [`${LIVE}/data/sealed-backup-status.json`]: JSON.stringify({ ok: false, at: '2026-09-28T05:17:00Z',
    refused: 'unreadable', archive, error: 'the sealed-backup branch has a backup at its root whose manifest.json is missing or is not valid JSON' }) } });
  ok(unreadable.by['sealed-backup'].state === 'needs-user' && /was refused/.test(unreadable.by['sealed-backup'].detail[0])
    && /--take-over/.test(unreadable.by['sealed-backup'].next[0]) && !unreadable.by['sealed-backup'].next.some((n) => /--skip/.test(n)),
  'a root nobody can name: refused, --take-over offered with its warning, no skip');

  const unread = await check({ crontab: null });
  ok(unread.by['hourly-check'].state === 'needs-user' && /could not read/.test(unread.by['hourly-check'].detail[0]), 'an unreadable crontab is said, not guessed at');
  const lan = await check({ drop: ['/etc/systemd/network/10-netplan-eth0.network.d/10-request-address.conf'] });
  ok(lan.by['lan-address'].state === 'optional' && exitCode(lan.results) === 0, 'an optional routine not set up does not fail the check');
  ok(/--static/.test(lan.by['lan-address'].next[0]), 'and it suggests the static address the operator chose');
  // 2026-09-29, "assign ubuntu static 192.168.20.45": a box with the static
  // netplan file is ok, even when the file (mode 600) cannot be read.
  const staticLan = await check({ drop: ['/etc/systemd/network/10-netplan-eth0.network.d/10-request-address.conf'],
    files: { '/etc/netplan/99-static-lan.yaml': null, '/etc/cloud/cloud.cfg.d/99-disable-network-config.cfg': 'network: {config: disabled}\n' } });
  ok(staticLan.by['lan-address'].state === 'ok' && /static address: \/etc\/netplan\/99-static-lan\.yaml$/.test(staticLan.by['lan-address'].detail[0]),
    'a static netplan file counts, read or not');
  const readable = await check({ files: { '/etc/netplan/99-static-lan.yaml': 'network:\n  ethernets:\n    eth0:\n      addresses:\n        - 192.168.20.45/24\n' } });
  ok(/sets 192\.168\.20\.45\/24/.test(readable.by['lan-address'].detail[0]) && /cloud-init may still rewrite/.test(readable.by['lan-address'].detail[1] ?? ''),
    'and names its address when it can, and a cloud-init that could still rewrite it');
}

console.log('=== the Cloudflare tunnel ===');
/*
 * 2026-09-30, bot-box2: the tunnel was started with the dashboard's `docker run
 * cloudflare/cloudflared ... --token ...`. It connected, and every visit
 * failed with "dial tcp [::1]:8080: connect: connection refused" - on
 * Docker's bridge network the ingress rule's localhost is the container - and
 * no unit would have brought it back after a reboot. The tunnel had been "the
 * one piece set up by hand", so nothing checked it and a rebuilt box would not
 * have had it. Each state it can be in is read here, and the token - in a
 * container's command line, or a unit Cloudflare's own installer wrote - is
 * compared with .env's and never kept or reported.
 *
 * The same day's review: --fix offered --from-docker for any cloudflared
 * container, a healthy service's neighbour of another tunnel included, and
 * for a DNS proxy, which it could never adopt; an Access client was a stray
 * connector to kill; a masked unit got a --fix that could only fail; a
 * token file anybody could read passed; and on the bot's own box with the bot
 * down, the check said to disable the tunnel.
 */
{
  const CID = 'c0ffee'.padEnd(64, '0');
  const OTHER_TOKEN = Buffer.from(JSON.stringify({ a: 'acc0unt7a9', t: '0ther000-7b2f-4c61-9d3e-2f5a8b9c0d1e', s: 'YW5vdGhlci10dW5uZWwtc2VjcmV0' })).toString('base64');
  const noToken = `MASTER_KEY=abc\nBACKUP_PASSPHRASE=a long enough passphrase\n`;
  const leak = (r) => [JSON.stringify(r.results), formatReport(r.results, r.ctx)].some((t) => [TUNNEL_TOKEN, OTHER_TOKEN, 'dHVubmVsLXNlY3JldC1vZi10aGUtdGVzdA', 'YW5vdGhlci10dW5uZWwtc2VjcmV0']
    .some((x) => t.includes(x)));
  // What the probe keeps of /proc: never a token, whatever the command lines hold.
  const procsClean = (r) => !JSON.stringify(cloudflaredProcesses(r.sys, { known: TUNNEL_TOKEN })).match(/eyJ|dHVubmVs|YW5vdGhl/);
  const cf = byId('cloudflare-tunnel');
  ok(cf?.scope === 'active' && typeof cf.standby === 'function' && cf.files.includes('deploy/install-cloudflared.sh'),
    'a routine of the box that runs the bot, installed by deploy/install-cloudflared.sh');

  const good = await check();
  const g = good.by['cloudflare-tunnel'];
  ok(g.state === 'ok' && /runs, enabled at boot, reading its token from \/etc\/cloudflared\/tunnel-token/.test(g.detail[0])
    && /sealed backup carries the tunnel/.test(g.detail[0]) && g.detail.length === 1, `in place: ok, and says the backup carries it (${g.detail[0]})`);
  ok(procsClean(good) && !leak(good), 'the token is in nothing the probe keeps, and in no report');

  // What a cloudflared process is doing, from its command line.
  ok(cloudflaredKind(['cloudflared', '--no-autoupdate', 'tunnel', '--no-autoupdate', 'run', '--token', TUNNEL_TOKEN]) === 'tunnel'
    && cloudflaredKind(['cloudflared', 'proxy-dns', '--port', '5053']) === 'proxy-dns'
    && cloudflaredKind(['cloudflared', 'access', 'ssh', '--hostname', 'ssh.example.com']) === 'access'
    && cloudflaredKind(['cloudflared', 'update']) === 'update' && cloudflaredKind(['cloudflared', '--url', 'http://localhost:8080']) === 'tunnel'
    && cloudflaredKind(null) === 'unknown' && cloudflaredKind([]) === 'unknown',
  'a tunnel, a DNS proxy, an Access client, the updater and an unreadable command line are told apart');

  // The incident: a container on Docker's bridge network, no unit, no token in .env.
  const dockerProc = { pid: '5120', cgroup: `0::/system.slice/docker-${CID}.scope\n`, net: BRIDGE_NET,
    cmdline: `cloudflared\0--no-autoupdate\0tunnel\0--no-autoupdate\0run\0--token\0${TUNNEL_TOKEN}\0` };
  const inc = await check({ tunnel: 'none', procs: [dockerProc], files: { [`${LIVE}/.env`]: noToken } });
  const d = inc.by['cloudflare-tunnel'];
  ok(d.state === 'missing' && /runs in a container \(c0ffee000000\) on a network of its own/.test(d.detail[0])
    && /container's own loopback/.test(d.detail[0]) && /connection refused/.test(d.detail[0]),
  `the dashboard's docker run: missing, and says why every visit fails (${d.detail[0].slice(0, 120)}...)`);
  ok(d.fix?.length === 1 && d.fix[0].display === 'deploy/install-cloudflared.sh --from-docker' && d.fix[0].sudo
    && d.fix[0].argv.join(' ') === `bash ${LIVE}/deploy/install-cloudflared.sh --non-interactive --from-docker`,
  '--fix moves it into the service with --from-docker, non-interactive, with sudo');
  ok(/every user of this box can read in ps - and in sudo's log/.test(d.detail.join()) && /Rotate token/.test(d.next.join()) && procsClean(inc) && !leak(inc),
    'it says the token is on the container\'s command line and in sudo\'s log, to rotate it, and never what it is');
  const done = await applyFixes(inc.results, inc.sys);
  ok(done.some((x) => x.id === 'cloudflare-tunnel' && x.ok) && inc.sys.calls.includes(`bash ${LIVE}/deploy/install-cloudflared.sh --non-interactive --from-docker`),
    'and applyFixes runs exactly that');
  const hostNet = await check({ tunnel: 'none', procs: [{ ...dockerProc, net: HOST_NET }], files: { [`${LIVE}/.env`]: noToken } });
  ok(hostNet.by['cloudflare-tunnel'].state === 'missing' && /on this box's network: it reaches the panel, but it is no service/.test(hostNet.by['cloudflare-tunnel'].detail[0]),
    'a container on the host\'s network reaches the panel, and is still no service');
  const blind = await check({ tunnel: 'none', procs: [{ ...dockerProc, cmdline: null }], files: { [`${LIVE}/.env`]: noToken } });
  ok(blind.by['cloudflare-tunnel'].state === 'missing' && !/can read in ps/.test(blind.by['cloudflare-tunnel'].detail.join()),
    'a command line that cannot be read (hidepid) is still taken for a tunnel, without claiming the token is on it');
  const envTok = await check({ tunnel: 'none', procs: [dockerProc] });
  ok(envTok.by['cloudflare-tunnel'].state === 'missing' && envTok.by['cloudflare-tunnel'].fix[0].display === 'deploy/install-cloudflared.sh --from-docker',
    'a container running the very token .env holds: --fix, since there is nothing to decide');

  // Beside the service.
  const both = await check({ procs: [{ pid: '4100', cgroup: '0::/system.slice/cloudflared.service\n', cmdline: SERVICE_CMDLINE }, dockerProc] });
  ok(both.by['cloudflare-tunnel'].state === 'missing' && /runs as well: two connectors on one token are replicas/.test(both.by['cloudflare-tunnel'].detail.join())
    && both.by['cloudflare-tunnel'].fix?.[0].display === 'deploy/install-cloudflared.sh --from-docker',
  'a container of the same tunnel beside the service is a second connector: retired by --fix');
  const otherTunnel = await check({ procs: [{ pid: '4100', cgroup: '0::/system.slice/cloudflared.service\n', cmdline: SERVICE_CMDLINE },
    { ...dockerProc, cmdline: `cloudflared\0tunnel\0run\0--token\0${OTHER_TOKEN}\0` }] });
  const ot = otherTunnel.by['cloudflare-tunnel'];
  ok(ot.state === 'ok' && !ot.fix && /container c0ffee000000 with another tunnel's token: not the panel's tunnel, and left alone/.test(ot.detail.join()) && !leak(otherTunnel),
    `a container of ANOTHER tunnel beside the healthy service: ok, noted, and no --fix that would put its token in the panel's place (${ot.state})`);
  const envOnly = await check({ procs: [{ pid: '4100', cgroup: '0::/system.slice/cloudflared.service\n', cmdline: SERVICE_CMDLINE },
    { ...dockerProc, cmdline: 'cloudflared\0tunnel\0run\0' }] });
  const eo = envOnly.by['cloudflare-tunnel'];
  ok(eo.state === 'needs-user' && !eo.fix && /cannot be told from here/.test(eo.detail.join()) && /it refuses if the container's token is not the one already here[\s\S]*--replace/.test(eo.next[0]),
    'a container whose token cannot be seen, beside a tunnel set up here: the user\'s, with a command that refuses rather than replaces');
  const dns = await check({ procs: [{ pid: '4100', cgroup: '0::/system.slice/cloudflared.service\n', cmdline: SERVICE_CMDLINE },
    { ...dockerProc, cmdline: 'cloudflared\0proxy-dns\0--port\x005053\0' }] });
  ok(dns.by['cloudflare-tunnel'].state === 'ok' && dns.by['cloudflare-tunnel'].detail.length === 1, 'a DNS-over-HTTPS proxy container is no tunnel: ok, and not mentioned');
  const access = await check({ procs: [{ pid: '4100', cgroup: '0::/system.slice/cloudflared.service\n', cmdline: SERVICE_CMDLINE },
    { pid: '6002', cgroup: '0::/user.slice/user-1000.slice/session-3.scope\n', cmdline: 'cloudflared\0access\0ssh\0--hostname\0ssh.example.com\0' },
    { pid: '6003', cgroup: '0::/system.slice/cloudflared-update.service\n', cmdline: '/usr/bin/cloudflared\0update\0' }] });
  ok(access.by['cloudflare-tunnel'].state === 'ok', 'nor an ssh through Cloudflare Access, nor the updater: nothing to kill');
  const podman = await check({ tunnel: 'none', procs: [{ pid: '5121', cgroup: '0::/user.slice/libpod-deadbeef.scope\n' }] });
  ok(podman.by['cloudflare-tunnel'].state === 'needs-user' && !podman.by['cloudflare-tunnel'].fix,
    'a container that is not Docker\'s is the user\'s: the script adopts only Docker ones');
  const noSudo = await check({ tunnel: 'none', procs: [dockerProc], sudo: false, commands: [[/^sudo -n -l /, { code: 1 }]] });
  ok(noSudo.by['cloudflare-tunnel'].state === 'needs-user' && /install-cloudflared\.sh --from-docker .*needs sudo/.test(noSudo.by['cloudflare-tunnel'].next[0]),
    'without passwordless sudo the same command is printed for a person');

  // Cloudflare's own `cloudflared service install <token>`.
  const inline = await check({ cfShow: CF_SERVICE_SHOW.replace('--token-file /etc/cloudflared/tunnel-token', `--token ${TUNNEL_TOKEN}`) });
  const i = inline.by['cloudflare-tunnel'];
  ok(i.state === 'missing' && /carries the tunnel's token on its command line/.test(i.detail[0]) && i.fix[0].display === 'deploy/install-cloudflared.sh --from-unit'
    && /Rotate token/.test(i.next.join()), 'a unit with --token <token>: missing, --fix moves the token into the root-only file (--from-unit), then rotate it');
  ok(!leak(inline), 'and the token the unit carries is in no report');
  const envVar = await check({ cfShow: CF_SERVICE_SHOW.replace('--token-file /etc/cloudflared/tunnel-token', '').replace('Environment=', `Environment=TUNNEL_TOKEN=${TUNNEL_TOKEN}`) });
  ok(envVar.by['cloudflare-tunnel'].state === 'missing' && /--from-unit/.test(envVar.by['cloudflare-tunnel'].fix[0].display) && !leak(envVar),
    'nor as TUNNEL_TOKEN in its Environment=');
  const inlineOther = await check({ cfShow: CF_SERVICE_SHOW.replace('--token-file /etc/cloudflared/tunnel-token', `--token ${OTHER_TOKEN}`) });
  const io = inlineOther.by['cloudflare-tunnel'];
  ok(io.state === 'needs-user' && !io.fix && /not the token \.env holds/.test(io.detail.join()) && /--from-unit --replace/.test(io.next[0]) && /--from-env --replace/.test(io.next[1]) && !leak(inlineOther),
    'a unit carrying a different token from .env\'s: two tunnels, the user\'s to choose - never replaced by --fix');
  ok(tunnelTokenStyle('run --token-file /x') === 'file' && tunnelTokenStyle('--config /etc/cloudflared/config.yml tunnel run') === 'config'
    && tunnelTokenStyle(`run --token=${TUNNEL_TOKEN}`) === 'inline' && tunnelTokenStyle(`CLOUDFLARE_TUNNEL_TOKEN=${TUNNEL_TOKEN}`) === 'config',
  'the three styles are told apart, and the .env key is not taken for cloudflared\'s TUNNEL_TOKEN');

  // The service, but not all there.
  const stopped = await check({ cfShow: CF_SERVICE_SHOW.replace('ActiveState=active', 'ActiveState=inactive').replace('SubState=running', 'SubState=dead') });
  ok(stopped.by['cloudflare-tunnel'].state === 'missing' && /is inactive \(enabled at boot\)/.test(stopped.by['cloudflare-tunnel'].detail[0])
    && stopped.by['cloudflare-tunnel'].fix[0].display === 'deploy/install-cloudflared.sh', 'stopped: the script again, with the token it has');
  const disabled = await check({ cfShow: CF_SERVICE_SHOW.replace('UnitFileState=enabled', 'UnitFileState=disabled') });
  ok(disabled.by['cloudflare-tunnel'].state === 'missing' && /disabled at boot: after the next reboot the tunnel stays down/.test(disabled.by['cloudflare-tunnel'].detail[0])
    && disabled.by['cloudflare-tunnel'].fix[0].argv.join(' ') === 'sudo -n systemctl enable cloudflared.service', 'running but not enabled: enabled, nothing restarted');
  const failing = await check({ cfShow: CF_SERVICE_SHOW.replace('ActiveState=active', 'ActiveState=activating').replace('SubState=running', 'SubState=auto-restart') });
  ok(failing.by['cloudflare-tunnel'].state === 'needs-user' && /keeps failing/.test(failing.by['cloudflare-tunnel'].detail[0])
    && /journalctl -u cloudflared.*install-cloudflared\.sh --new-token/.test(failing.by['cloudflare-tunnel'].next[0]) && !failing.by['cloudflare-tunnel'].fix,
  'crash-looping: the user\'s, with where to look, and --new-token for a rotated token - restarting it again fixes nothing');
  const noBin = await check({ drop: ['/usr/bin/cloudflared'] });
  ok(noBin.by['cloudflare-tunnel'].state === 'missing' && /which is not there/.test(noBin.by['cloudflare-tunnel'].detail[0]), 'the package gone: reinstalled by the script');
  const config = await check({ cfShow: CF_SERVICE_SHOW.replace('tunnel run --token-file /etc/cloudflared/tunnel-token', '--config /etc/cloudflared/config.yml tunnel run'),
    files: { [`${LIVE}/.env`]: noToken } });
  ok(config.by['cloudflare-tunnel'].state === 'ok' && /locally-managed/.test(config.by['cloudflare-tunnel'].detail[0])
    && /not in the sealed backup/.test(config.by['cloudflare-tunnel'].detail[1]), 'a locally-managed tunnel is ok, and not backed up - said so');
  const open = await check({ modes: { '/etc/cloudflared/tunnel-token': 0o644 } });
  const op = open.by['cloudflare-tunnel'];
  ok(op.state === 'missing' && /mode 644: every user of this box can read the tunnel's token/.test(op.detail[0])
    && op.fix.map((x) => x.argv.join(' ')).join('; ') === 'sudo -n chown root:root /etc/cloudflared/tunnel-token; sudo -n chmod 600 /etc/cloudflared/tunnel-token',
  'a token file anybody can read: made root\'s and 600, with nothing restarted');
  const masked = await check({ cfShow: 'LoadState=masked\nActiveState=inactive\nSubState=dead\nUnitFileState=masked\nExecStart=\nEnvironment=\n' });
  ok(masked.by['cloudflare-tunnel'].state === 'needs-user' && !masked.by['cloudflare-tunnel'].fix && /masked here/.test(masked.by['cloudflare-tunnel'].detail[0])
    && /unmask cloudflared && deploy\/install-cloudflared\.sh --from-env/.test(masked.by['cloudflare-tunnel'].next[0]) && /--skip cloudflare-tunnel/.test(masked.by['cloudflare-tunnel'].next[1]),
  'masked, with a token in .env: somebody\'s decision - the user\'s, and no --from-env that could only fail');
  const maskedNone = await check({ tunnel: 'none', cfShow: 'LoadState=masked\nActiveState=inactive\nUnitFileState=masked\n', files: { [`${LIVE}/.env`]: noToken } });
  ok(maskedNone.by['cloudflare-tunnel'].state === 'optional' && exitCode([maskedNone.by['cloudflare-tunnel']]) === 0, 'masked with no token anywhere: optional');
  const exposed = await check({ files: { '/etc/cloudflared/token-exposed': 'taken from a container\'s command line on 2026-09-30 14:01 UTC\n' } });
  const ex = exposed.by['cloudflare-tunnel'];
  ok(ex.state === 'ok' && /the token was taken from a container's command line on 2026-09-30 14:01 UTC, and sudo's log of that command keeps it: rotate it.*Rotate token.*--new-token/.test(ex.detail.join()),
    'an adopted token not yet rotated: still ok, and said until it is');

  // bot-box2 right after the move: the service in place, .env without the token.
  const unrecorded = await check({ files: { [`${LIVE}/.env`]: noToken } });
  const u = unrecorded.by['cloudflare-tunnel'];
  ok(u.state === 'missing' && /\.env has no CLOUDFLARE_TUNNEL_TOKEN: the sealed backup does not carry the tunnel/.test(u.detail[0])
    && u.fix[0].display === 'deploy/install-cloudflared.sh --record-env', 'the token not in .env: --record-env, so the backup carries it');

  // A rebuilt box: .env restored with the token, no service yet.
  const rebuilt = await check({ tunnel: 'none' });
  const r = rebuilt.by['cloudflare-tunnel'];
  ok(r.state === 'missing' && r.fix[0].display === 'deploy/install-cloudflared.sh --from-env' && /stop cloudflared on the box this one replaced/.test(r.detail[0]),
    'the token in .env and no service: --from-env, with the old box to stop');
  const loose = await check({ tunnel: 'none', procs: [{ pid: '6001', cgroup: '0::/user.slice/user-1000.slice/session-3.scope\n' }] });
  ok(loose.by['cloudflare-tunnel'].state === 'needs-user' && /outside cloudflared\.service and outside any container \(pid 6001, in session-3\.scope\)/.test(loose.by['cloudflare-tunnel'].detail[0])
    && /sudo kill 6001, then deploy\/install-cloudflared\.sh --from-env/.test(loose.by['cloudflare-tunnel'].next[0]), 'a tunnel started by hand: the user\'s, with how to replace it');
  const none = await check({ tunnel: 'none', files: { [`${LIVE}/.env`]: noToken } });
  ok(none.by['cloudflare-tunnel'].state === 'optional' && exitCode(none.results) === 0 && /never the dashboard's docker run/.test(none.by['cloudflare-tunnel'].next[0]),
    'no tunnel anywhere and no token: optional, the check still passes, and the way to set one up is named');

  // A box that does not run the bot.
  const sb = (o) => check({ active: false, enabled: 'disabled', crontab: '', ...o });
  const idle = await sb({});
  ok(idle.by['cloudflare-tunnel'].state === 'standby' && /the box that runs the bot installs it with deploy\/install-cloudflared\.sh --from-env/.test(idle.by['cloudflare-tunnel'].detail.join()),
    'standby, nothing running: belongs to the box that runs the bot');
  const replica = await sb({ tunnel: 'service' });
  const rp = replica.by['cloudflare-tunnel'];
  ok(rp.state === 'needs-user' && /runs on this box, which does not run the bot: as cloudflared\.service/.test(rp.detail[0]) && /replicas/.test(rp.detail[1])
    && rp.next[0] === 'sudo systemctl disable --now cloudflared' && !rp.fix, 'standby running the tunnel: flagged as a replica, the command to stop it printed, never run');
  const sbDocker = await sb({ procs: [dockerProc] });
  ok(sbDocker.by['cloudflare-tunnel'].state === 'needs-user' && /sudo docker rm -f c0ffee000000/.test(sbDocker.by['cloudflare-tunnel'].next[0]), 'a container there: docker rm, for a person');
  const sbEnabled = await sb({ cfShow: CF_SERVICE_SHOW.replace('ActiveState=active', 'ActiveState=inactive'), procs: [] });
  ok(sbEnabled.by['cloudflare-tunnel'].state === 'needs-user' && /next reboot starts a second connector/.test(sbEnabled.by['cloudflare-tunnel'].detail[0]),
    'enabled at boot there: flagged before a reboot starts it');
  // The bot's own box with the bot down: whatsapp-bot still enabled at boot.
  const down = await check({ active: false, enabled: 'enabled', tunnel: 'service' });
  const dn = down.by['cloudflare-tunnel'];
  ok(dn.state === 'standby' && /most likely this is the box that runs the bot, with the bot down/.test(dn.detail[0])
    && /^journalctl -u whatsapp-bot -n 50 .*leave the tunnel running/.test(dn.next[0]) && /only if another machine runs the bot/.test(dn.next[1]),
  `the bot's box with the bot down: the tunnel is its - the likelier choice first, and nothing failing on its account (${dn.state})`);
  const bare = fakeBox({ active: false, enabled: 'disabled', crontab: '', tunnel: 'service', procs: [dockerProc] });
  const lines = [];
  await main(['--fix'], { sys: bare, appDir: LIVE, out: (l) => lines.push(l), err: (l) => lines.push(l) });
  ok(!bare.calls.some((c) => /install-cloudflared|systemctl (stop|disable|restart|enable)[^\n]*cloudflared|docker|kill/.test(c)),
    '--fix on a standby leaves its tunnel alone: nothing installed, stopped or removed');
}

/*
 * The operator, 2026-09-30: "How do I set in the vm that this session ...
 * should automatically resume after a reboot?" The routine checks what
 * deploy/install-claude-session.sh sets up (linger, the user unit, enabled at
 * boot, the ~/.bashrc hook, tmux), and --fix runs that installer, which
 * enables and never starts: the conversation to resume may be running right
 * then in a plain SSH login, and two processes on one conversation
 * interleave it. deploy/ itself is tested in test/claude-session.test.mjs.
 */
console.log('=== the Claude session that comes back after a reboot ===');
{
  const cs = byId('claude-session');
  ok(cs.scope === 'active' && cs.bootstrap && cs.files.includes('deploy/install-claude-session.sh') && cs.files.includes('deploy/claude-session.sh'),
    'it belongs to the box that runs the bot, bootstrap sets it up, and it owns both scripts');
  const good = await check();
  const g = good.by['claude-session'];
  ok(g.state === 'ok' && /linger on, enabled at boot, SSH logins are told about it; not running now/.test(g.detail.join()), `all in place: ok (${g.detail.join(' | ')})`);
  ok(!good.sys.calls.some((c) => /claude-session|tmux (new|kill|attach)|loginctl enable|systemctl --user/.test(c) && !/claude-session\.sh (unit|hook)$/.test(c)),
    'the check only asks: it never starts, enables or attaches');
  const running = await check({ claudeRunning: true });
  ok(/running now \(claude-attach, or tmux attach -t claude\)/.test(running.by['claude-session'].detail.join()), 'a running session is said, with how to reach it');

  const INSTALL = `bash ${LIVE}/deploy/install-claude-session.sh --non-interactive`;
  for (const [why, o, re] of [
    ['linger off', { linger: false }, /linger is off for bot/],
    ['no unit', { drop: [CS_UNIT_FILE] }, /claude-session\.service is not there/],
    ['an older unit', { files: { [CS_UNIT_FILE]: CS_UNIT.replace('KillMode=process\n', '') } }, /differs from what this checkout writes/],
    ['not enabled', { drop: [CS_WANTS] }, /not enabled at boot/],
    ['no hook', { files: { [`${HOME}/.bashrc`]: '# ~/.bashrc\n' } }, /no hook in ~\/\.bashrc/],
    ['an older hook', { files: { [`${HOME}/.bashrc`]: CS_HOOK.replace('Ctrl-b d detaches', 'Ctrl-b d leaves') } }, /the hook in ~\/\.bashrc differs/],
    ['no tmux', { missingBins: ['tmux'] }, /tmux is not installed/],
  ]) {
    const r = (await check(o)).by['claude-session'];
    ok(r.state === 'missing' && re.test(r.detail.join()) && r.fix?.length === 1 && r.fix[0].argv.join(' ') === INSTALL,
      `${why}: missing, and --fix runs the installer (${r.state}: ${r.detail[0]})`);
  }
  ok((await check({ drop: [CS_WANTS] })).by['claude-session'].fix[0].sudo === false
    && (await check({ linger: false })).by['claude-session'].fix[0].sudo === true,
  'it needs sudo only for linger (or tmux), so a box without it is told the one command');
  const noSudo = (await check({ linger: false, sudo: false })).by['claude-session'];
  ok(noSudo.state === 'needs-user' && /install-claude-session\.sh .*needs sudo/.test(noSudo.next[0]), 'linger off, no passwordless sudo: the user\'s, with the command');

  // --fix: the installer, and never a start - whatever else is missing.
  const fixBox = fakeBox({ drop: [CS_WANTS] });
  const lines = [];
  await main(['--fix', '--only', 'claude-session'], { sys: fixBox, appDir: LIVE, out: (l) => lines.push(l), err: (l) => lines.push(l) });
  ok(fixBox.calls.includes(INSTALL) && !fixBox.calls.some((c) => /--start-now|tmux new-session|claude-session\.sh start|systemctl --user (start|restart)/.test(c)),
    `--fix enables it and starts nothing (${fixBox.calls.filter((c) => /claude-session/.test(c)).join('; ')})`);

  const broken = (await check({ commands: [[/claude-session\.sh unit$/, { code: 1, stderr: 'claude-session: /srv/bot has a character a unit\'s ExecStart would misread' }]] })).by['claude-session'];
  ok(broken.state === 'needs-user' && /would misread/.test(broken.detail[0]) && !broken.fix, 'a checkout the unit cannot name: the user\'s, not a fix that would fail');

  const standby = (await check({ active: false, enabled: 'disabled', crontab: '' })).by['claude-session'];
  ok(standby.state === 'standby' && !standby.fix && /box that runs the bot/.test(standby.detail[0]), 'a standby box: not set up there, and not flagged');
  const standbyOn = (await check({ active: false, enabled: 'disabled', crontab: '', files: { [CS_WANTS]: CS_UNIT } })).by['claude-session'];
  ok(standbyOn.state === 'standby' && /Harmless to WhatsApp/.test(standbyOn.detail[0]) && /--remove/.test(standbyOn.next[0]),
    'enabled on a standby box: said, with how to take it out, but not flagged - a Claude session is not the bot');
}

console.log('=== a WSL box: the bot in WSL2 on the Windows laptop ===');
/*
 * 2026-09-29: the operator moved the bot from the Hyper-V VM bot-box2 to WSL2
 * on the same laptop, for the GPU, and asked "Why don't you teach the repo?"
 * Everything done there by hand - systemd in /etc/wsl.conf, .wslconfig on
 * the Windows side, the VM's units turned off, sshd on 2222, a scheduled task
 * to start WSL with Windows - is a routine, and each is read right here on a
 * fake WSL box.
 */
{
  const WIN = '/win';
  const wslBox = (o = {}) => ({
    ...o,
    env: { WSL_DISTRO_NAME: 'bot-box2', WSL_WINDOWS_HOME: WIN, ...o.env },
    files: {
      '/proc/sys/kernel/osrelease': '6.18.33.2-microsoft-standard-WSL2\n',
      '/etc/wsl.conf': '[boot]\nsystemd=true\n\n[user]\ndefault=bot\n',
      '/etc/ssh/sshd_config.d/10-wsl-port.conf': '# WSL\nPort 2222\n',
      '/etc/systemd/system/ssh.socket.d/10-wsl-port.conf': '[Socket]\nListenStream=\nListenStream=0.0.0.0:2222\nListenStream=[::]:2222\n',
      [WIN]: '',
      [`${WIN}/.wslconfig`]: '[wsl2]\r\nnetworkingMode=mirrored\r\nvmIdleTimeout=-1\r\n',
      '/mnt/c/Windows/System32/schtasks.exe': '',
      ...o.files,
    },
    commands: [
      ...(o.commands ?? []),
      // Mirrored networking: the Wi-Fi is eth1 and carries the default route,
      // with its own -no-offload unit (the VM's eth0 unit stays off).
      [/^ip route show default$/, { stdout: 'default via 192.168.20.1 dev eth1 proto kernel metric 25\n' }],
      [/ethtool -k eth1$/, { stdout: 'tcp-segmentation-offload: off\ngeneric-segmentation-offload: off\n' }],
      [/^systemctl is-enabled eth1-no-offload\.service$/, { stdout: 'enabled\n' }],
      [/^ss -ltnH$/, { stdout: 'LISTEN 0 128 0.0.0.0:2222 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:8080 0.0.0.0:*\n' }],
      [/^systemctl is-system-running$/, { stdout: 'running\n' }],
      [/^systemctl is-enabled \S+$/, { code: 1, stdout: 'disabled\n' }],
      [/^systemctl is-active (?!cron$)\S+$/, { code: 3, stdout: 'inactive\n' }],
      [/schtasks\.exe \/Query \/TN whatsapp-bot WSL \/FO LIST$/, { stdout: 'TaskName: \\whatsapp-bot WSL\r\nStatus: Running\r\n' }],
    ],
  });

  const good = await check(wslBox());
  ok(good.ctx.wsl?.distro === 'bot-box2' && /microsoft/.test(good.ctx.wsl.release), 'the kernel\'s release says WSL, and the distro is named');
  const wslIds = ['wsl-systemd', 'wsl-config', 'wsl-vm-units', 'wsl-autostart'];
  ok(wslIds.every((id) => good.by[id].state === 'ok'), `set up as on the laptop: every WSL routine in place (${wslIds.map((id) => `${id}=${good.by[id].state}`).join(', ')})`);
  // 2026-09-30: WSL's NIC is hv_netvsc with the Hyper-V upload fault - La La
  // Land went at 162 KB/s until offload was turned off on eth1, then 5,176 KB/s.
  ok(good.by['grow-root-disk'].state === 'n/a', 'grow-root-disk does not apply on WSL');
  ok(good.by['nic-offload'].state === 'ok' && /eth1 offload off/.test(good.by['nic-offload'].detail[0]),
    `the NIC fix applies on WSL too, on the default-route NIC eth1 (${good.by['nic-offload'].state}: ${good.by['nic-offload'].detail[0]})`);
  ok(good.by['tailscale-ssh'].state === 'ok' && /listens on 2222/.test(good.by['tailscale-ssh'].detail[0])
    && !good.sys.calls.some((c) => /^tailscale /.test(c)), 'SSH is sshd on 2222, and no Linux tailscale is asked anything');
  ok(good.by['lan-address'].state === 'ok' && /mirrored networking/.test(good.by['lan-address'].detail[0]),
    'the LAN address is the laptop\'s own, through mirrored networking');
  ok(exitCode(good.results) === 0, `and the check exits 0${exitCode(good.results) ? ` - not: ${good.results.filter((r) => ['missing', 'needs-user'].includes(r.state)).map((r) => `${r.id}: ${r.detail[0]}`).join('; ')}` : ''}`);
  ok(!good.sys.calls.some((c) => /wsl\.exe|systemctl (disable|enable|start|stop|restart)|wsl-setup/.test(c)), 'a plain check changes nothing, and never runs wsl.exe');

  const noSystemd = await check(wslBox({ files: { '/etc/wsl.conf': '[user]\ndefault=bot\n' } }));
  ok(noSystemd.by['wsl-systemd'].state === 'missing' && noSystemd.by['wsl-systemd'].fix[0].display === 'deploy/wsl-setup.sh systemd'
    && /wsl\.exe --shutdown/.test(noSystemd.by['wsl-systemd'].next.join()),
  'no systemd in /etc/wsl.conf (the laptop, at first): --fix writes it, and says WSL has to restart');
  const offline = await check(wslBox({ commands: [[/^systemctl is-system-running$/, { code: 1, stdout: 'offline\n' }]] }));
  ok(offline.by['wsl-systemd'].state === 'needs-user' && /wsl\.exe --shutdown/.test(offline.by['wsl-systemd'].next[0]),
    'asked for but not running: WSL has not restarted, which is the user\'s to do');

  // 2026-09-29: the file had no line ending after its last line, and the
  // setting appended to it was glued on: "ipv6=falsevmIdleTimeout=-1".
  const glued = await check(wslBox({ files: { [`${WIN}/.wslconfig`]: '[wsl2]\r\nnetworkingMode=mirrored\r\nvmSwitch=VS1-WLAN\r\nipv6=falsevmIdleTimeout=-1' } }));
  const g = glued.by['wsl-config'];
  ok(g.state === 'missing' && /lacks vmIdleTimeout=-1/.test(g.detail[0]) && g.fix[0].display === 'deploy/wsl-setup.sh wslconfig' && !g.fix[0].sudo,
    `a setting glued onto the line before counts as missing, and --fix rewrites it, without sudo (${g.detail[0]})`);
  const none = await check(wslBox({ drop: [`${WIN}/.wslconfig`], files: { [`${WIN}/.wslconfig.bak`]: 'x' } }));
  ok(none.by['wsl-config'].state === 'missing' && /does not exist \(a \S+\.wslconfig\.bak is there\)/.test(none.by['wsl-config'].detail[0]),
    'no .wslconfig at all: missing, and a .bak beside it is mentioned');
  const noHome = await check(wslBox({ env: { WSL_WINDOWS_HOME: '' } }));
  ok(noHome.by['wsl-config'].state === 'needs-user' && /WSL_WINDOWS_HOME/.test(noHome.by['wsl-config'].next[0]),
    'no way to tell the Windows profile: the user is asked, with the setting that says it');

  const units = await check(wslBox({ commands: [[/^systemctl is-enabled tailscaled\.service$/, { stdout: 'enabled\n' }],
    [/^systemctl is-active systemd-networkd\.service$/, { stdout: 'active\n' }]] }));
  const u = units.by['wsl-vm-units'];
  ok(u.state === 'missing' && u.detail.length === 2 && /tailscaled\.service is enabled: the Windows Tailscale client/.test(u.detail.join())
    && /systemd-networkd\.service is running/.test(u.detail.join()) && u.fix[0].display === 'deploy/wsl-setup.sh vm-units',
  `the VM's units still on: each said, with why, and --fix turns them off (${u.detail.join(' | ')})`);
  const fixed = await applyFixes(units.results, units.sys);
  ok(fixed.some((d) => d.id === 'wsl-vm-units' && d.step === 'deploy/wsl-setup.sh vm-units')
    && units.sys.calls.includes(`bash ${LIVE}/deploy/wsl-setup.sh --non-interactive vm-units`), 'through deploy/wsl-setup.sh, with sudo -n');

  const noTask = await check(wslBox({ commands: [[/schtasks\.exe \/Query/, { code: 1, stderr: 'ERROR: The system cannot find the file specified.' }]] }));
  const t = noTask.by['wsl-autostart'];
  ok(t.state === 'needs-user' && /Register-ScheduledTask -TaskName 'whatsapp-bot WSL'/.test(t.next[0]) && /-d bot-box2 --exec \/bin\/sleep infinity/.test(t.next[0])
    && /ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/.test(t.next[0]), 'no scheduled task: the PowerShell, for this distro, that makes it');
  ok(!t.fix, 'which --fix never tries: it needs an administrator on Windows');
  const noInterop = await check(wslBox({ drop: ['/mnt/c/Windows/System32/schtasks.exe'] }));
  ok(noInterop.by['wsl-autostart'].state === 'needs-user' && /Get-ScheduledTask/.test(noInterop.by['wsl-autostart'].next.join()),
    'no interop to look with: the user is asked to look, and given the command');

  const noSsh = await check(wslBox({ commands: [[/^ss -ltnH$/, { stdout: 'LISTEN 0 511 0.0.0.0:8080 0.0.0.0:*\n' }]] }));
  ok(noSsh.by['tailscale-ssh'].state === 'missing' && /nothing listens on port 2222/.test(noSsh.by['tailscale-ssh'].detail.join())
    && noSsh.by['tailscale-ssh'].fix[0].display === 'deploy/wsl-setup.sh ssh', 'sshd not on 2222: --fix moves it there');

  // The hourly check's sandbox on WSL: the probe dies before printing
  // anything, and this check used to read that as fine.
  const busy = 'sandbox: could not install the seccomp filter: Device or resource busy - a seccomp listener is already on this process (WSL\'s init holds one), and the kernel allows one';
  const sb = await check(wslBox({ commands: [[/sandbox\.py --probe \d+$/, { code: 97, stdout: '', stderr: `${busy}\n` }]] }));
  const h = sb.by['hourly-check'];
  ok(h.state === 'needs-user' && /the sandbox does not start here .*Device or resource busy/.test(h.detail.join())
    && /never researches or fixes/.test(h.detail.join()), `WSL: a sandbox that cannot start is reported, not passed over (${h.detail[0]})`);
  ok(/WSL: its own init \(PID 1\) holds a seccomp listener/.test(h.detail.join()) && /predates the namespace sandbox/.test(h.detail.join())
    && /pull --ff-only/.test(h.next.join()), 'with why - a sandbox.py from before the namespace sandbox - and how to update it');

  // The namespace sandbox (2026-09-29): on WSL the probe runs in it, keeps
  // every door shut, and the routine is ok - the check researches again.
  const nsOk = await check(wslBox({ commands: [
    [/sandbox\.py --probe \d+$/, { code: 0, stdout: 'closed\n' }],
    [/sandbox\.py --mode$/, { code: 0, stdout: 'namespaces\n' }],
  ] }));
  ok(nsOk.by['hourly-check'].state === 'ok' && /its own user, PID and mount namespaces/.test(nsOk.by['hourly-check'].detail.join()),
    `WSL, the namespace sandbox working: ok, and says which sandbox (${nsOk.by['hourly-check'].detail.find((d) => /sandbox/.test(d))})`);
  // Neither: the listener taken, and user namespaces refused too.
  const neither = 'sandbox: a seccomp listener is already on this process (WSL\'s init holds one), and the namespace sandbox cannot start: could not make user, mount and PID namespaces: Operation not permitted';
  const nsNo = await check(wslBox({ commands: [[/sandbox\.py --probe \d+$/, { code: 97, stdout: '', stderr: `${neither}\n` }]] }));
  const hn = nsNo.by['hourly-check'];
  ok(hn.state === 'needs-user' && /may not make the user, PID and mount namespaces/.test(hn.detail.join()) && /unshare -Ur -p -m --fork true/.test(hn.next.join()),
    `WSL, neither sandbox possible: reported, with the command that shows why (${hn.detail[0]})`);
  const vmBroken = await check({ commands: [[/sandbox\.py --probe \d+$/, { code: 97, stderr: 'sandbox: no seccomp filter for riscv64\n' }]] });
  ok(vmBroken.by['hourly-check'].state === 'needs-user' && /does not start here \(no seccomp filter for riscv64\)/.test(vmBroken.by['hourly-check'].detail.join())
    && /sandbox\.py --probe/.test(vmBroken.by['hourly-check'].next.join()), 'and anywhere else, with how to see it fail');
  const untested = await check(wslBox({ files: { [`${LIVE}/data/hourly-debug/install.json`]: JSON.stringify({ at: '2026-09-28T17:00:00Z', event: 'token', cron: true, token: true, verify: 'no-sandbox' }) } }));
  ok(untested.by['hourly-check'].state === 'ok' && /not tested: the sandbox it is tested in would not start/.test(untested.by['hourly-check'].detail.join())
    && !untested.by['hourly-check'].next.some((n) => /setup-token/.test(n)), 'a token the installer could not test is not a token that failed: no new one is asked for');
}

console.log('=== on a box that does not run the bot ===');
{
  const { ctx, by, results, sys } = await check({ active: false, enabled: 'disabled', crontab: '' });
  ok(ctx.role === 'standby' && /installed here but inactive/.test(ctx.roleWhy), `the unit installed but not running: standby (${ctx.roleWhy})`);
  ok(['hourly-check', 'sealed-backup', 'start-at-boot'].every((id) => by[id].state === 'standby'),
    'the running box\'s routines are reported as belonging there');
  ok(exitCode(results) === 0, 'and do not fail the check');
  ok(!results.some((r) => r.fix && ['hourly-check', 'sealed-backup', 'start-at-boot'].includes(r.id)), 'none of them has a fix here');
  const report = formatReport(results, ctx);
  ok(/does not run the bot/.test(report) && /nothing here starts it/.test(report), 'and the report says what it will not do');

  const enabled = await check({ active: false, enabled: 'enabled', crontab: `${HOURLY_LINE}\n${BACKUP_LINE}\n` });
  ok(enabled.by['start-at-boot'].state === 'needs-user' && /next reboot starts it/.test(enabled.by['start-at-boot'].detail[0])
    && /sudo systemctl disable whatsapp-bot/.test(enabled.by['start-at-boot'].next[0]),
  'enabled at boot but not running: flagged - its next reboot would start a second bot');
  ok(enabled.by['hourly-check'].state === 'needs-user' && /--remove/.test(enabled.by['hourly-check'].next[0]),
    'the hourly check in cron on a standby: flagged, with how to take it out');
  ok(enabled.by['sealed-backup'].state === 'standby' && /--remove-cron/.test(enabled.by['sealed-backup'].detail.join()),
    'the nightly line there is noted: the branch refuses it anyway');

  // --fix on a standby box with everything missing: the every-box routines
  // are installed; nothing starts, enables or schedules the bot.
  const bare = fakeBox({ active: false, enabled: 'disabled', crontab: '', loaded: false,
    files: { [`${LIVE}/.env`]: 'MASTER_KEY=abc\n' }, commands: [[/^systemctl is-enabled/, { code: 1, stdout: 'not-found\n' }]] });
  const lines = [];
  const code = await main(['--fix'], { sys: bare, appDir: LIVE, out: (l) => lines.push(l), err: (l) => lines.push(l) });
  ok(bare.calls.some((c) => /install-units\.sh --non-interactive whatsapp-bot/.test(c)),
    'the unit is installed - disabled, as bootstrap leaves it');
  const bad = bare.calls.filter((c) => /systemctl (start|restart|stop|enable|disable)( --now)? whatsapp-bot|install-hourly-debug|--install-cron|--take-over/.test(c));
  ok(bad.length === 0, `and nothing starts, enables or schedules the bot here${bad.length ? ` - ran: ${bad.join('; ')}` : ''}`);
  ok(code === 0 || code === 1, `it exits 0 or 1 (${code})`);
}

console.log('=== which box, and when --fix refuses ===');
{
  const dev = fakeBox({ loaded: false, active: false, drop: [`${LIVE}/.env`] });
  const devCtx = await inspectBox(dev, { appDir: LIVE });
  ok(devCtx.role === 'dev' && /development clone/.test(devCtx.roleWhy), 'no unit and no .env: a development clone');
  ok(/tools\/bootstrap\.sh/.test(fixRefusal(devCtx)), '--fix refuses there, and names bootstrap');
  const out = [];
  const code = await main([], { sys: dev, appDir: LIVE, out: (l) => out.push(l), err: (l) => out.push(l) });
  ok(code === 0 && /Nothing is checked here/.test(out.join('\n')) && /hourly-check/.test(out.join('\n')),
    'the plain check on a clone lists the routines and exits 0');
  ok(!dev.calls.some((c) => /^(gh|tailscale|bash|python3)/.test(c)), 'without probing anything');

  const wt = await check({}, { appDir: '/tmp/worktree' });
  ok(!wt.ctx.isLive && wt.ctx.liveDir === LIVE, 'run from a worktree, it checks the checkout the service runs');
  ok(/not the checkout the service runs/.test(fixRefusal(wt.ctx)), '--fix refuses: its cron lines would point at the worktree');
  ok(/not the checkout/.test(skipRefusal(wt.ctx)) && skipRefusal({ ...wt.ctx, isLive: true, role: 'dev' }) === null,
    'so does --skip; but a clone may record a decision about itself');
  const noLine = fakeBox({ crontab: `${BACKUP_LINE}\n` });
  const lines = [];
  const code2 = await main(['--fix'], { sys: noLine, appDir: '/tmp/worktree', out: (l) => lines.push(l), err: (l) => lines.push(l) });
  ok(code2 === 2 && !noLine.calls.some((c) => /install-hourly-debug/.test(c)), 'and runs nothing, exit 2');
  ok(/root/.test(fixRefusal(wt.ctx, { uid: 0 })), 'never as root');

  const forced = await inspectBox(fakeBox({ active: false }), { appDir: LIVE, role: 'active' });
  ok(forced.role === 'active' && /--role active/.test(forced.roleWhy), '--role says what the box is, when systemd cannot');
}

console.log('=== skips, --json and the command line ===');
{
  const dir = path.join(T, 'live');
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const box = fakeBox({ files: { [`${LIVE}/.env`]: 'MASTER_KEY=abc\n' } });
  // The skip file is written for real, into a temporary checkout.
  const real = { ...box, readFile: (p) => (p.startsWith(dir) ? (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null) : box.readFile(p)),
    realpath: (p) => p };
  const liveShow = (s) => s.replace(`WorkingDirectory=${LIVE}`, `WorkingDirectory=${dir}`);
  const orig = real.run;
  real.run = async (cmd, args) => { const r = await orig(cmd, args); return cmd === 'systemctl' && args[0] === 'show' ? { ...r, stdout: liveShow(r.stdout) } : r; };
  const out = [];
  const say = (l) => out.push(l);
  ok(await main(['--skip', 'sealed-backup'], { sys: real, appDir: dir, out: say, err: say }) === 2 && /--reason/.test(out.join()),
    '--skip without a reason is refused');
  ok(await main(['--skip', 'sealed-backup', '--reason', 'second number; the branch is bot-box\'s'], { sys: real, appDir: dir, out: say, err: say }) === 0,
    '--skip with a reason is recorded');
  const skips = JSON.parse(fs.readFileSync(path.join(dir, 'data/routines-skip.json'), 'utf8'));
  ok(/second number/.test(skips['sealed-backup'].reason) && (fs.statSync(path.join(dir, 'data/routines-skip.json')).mode & 0o777) === 0o600,
    'in data/routines-skip.json, mode 600');
  const ctx = await inspectBox(real, { appDir: dir });
  const sb = await checkRoutine(byId('sealed-backup'), real, ctx);
  ok(sb.state === 'skipped' && /second number/.test(sb.detail[0]) && /--unskip sealed-backup/.test(sb.next[0]),
    'and then reported as skipped, with how to undo it - not as needing a passphrase');
  ok(await main(['--unskip', 'sealed-backup'], { sys: real, appDir: dir, out: say, err: say }) === 0
    && !('sealed-backup' in JSON.parse(fs.readFileSync(path.join(dir, 'data/routines-skip.json'), 'utf8'))), '--unskip takes it back');

  const j = [];
  const code = await main(['--json'], { sys: fakeBox(), appDir: LIVE, out: (l) => j.push(l), err: () => {} });
  const parsed = JSON.parse(j.join('\n'));
  ok(code === 0 && parsed.role === 'active' && parsed.routines.length === ROUTINES.length && parsed.failing === false,
    '--json: every routine, the role, and whether anything fails');
  ok(parsed.routines.every((r) => Object.keys(STATES).includes(r.state)), 'each in a known state');

  for (const [argv, why] of [[['--bogus'], 'an unknown flag'], [['--only', 'nope'], 'an unknown routine'], [['--role', 'boss'], 'an unknown role'],
    [['--skip', 'sudo', '--reason', 'x', '--fix'], '--skip with --fix']]) {
    let threw = null;
    try { parseArgs(argv); } catch (e) { threw = e; }
    ok(threw?.usage, `refused: ${why} (${threw?.usage})`);
  }
  ok(parseArgs(['--only', 'hourly-check,sudo', '--fix']).only.join() === 'hourly-check,sudo', '--only takes a list');
  const list = spawnSync(process.execPath, [path.join(REPO, 'tools/routines.mjs'), '--list'], { encoding: 'utf8' });
  ok(list.status === 0 && ROUTINES.every((r) => list.stdout.includes(r.id)) && /why:/.test(list.stdout), 'the real CLI prints the registry with --list');
  const badCli = spawnSync(process.execPath, [path.join(REPO, 'tools/routines.mjs'), '--nope'], { encoding: 'utf8' });
  ok(badCli.status === 2 && /unknown argument/.test(badCli.stderr), 'and exits 2 on a usage error');
  ok(formatRegistry().split('\n').length > ROUTINES.length * 3, 'the registry text has each routine\'s why, check and install');
  ok(jsonReport([{ id: 'x', fix: [{ display: 'y', argv: ['z'] }] }], { host: 'h' }).routines[0].fix[0] === 'y', '--json shows a fix as a person would type it');
}

console.log('=== small parsers ===');
{
  ok(cronLineWith(`# ${HOURLY_TAG} commented\n${HOURLY_LINE}\n`, HOURLY_TAG) === HOURLY_LINE, 'a commented-out line is not the cron line');
  ok(parseShow('LoadState=loaded\nExecStart={ path=/x ; a=b }\njunk').ExecStart === '{ path=/x ; a=b }', 'systemctl show lines, values kept whole');
  ok(hasEnvKey('export BACKUP_PASSPHRASE = long one\n', ['BACKUP_PASSPHRASE']) && !hasEnvKey('BACKUP_PASSPHRASE=\n', ['BACKUP_PASSPHRASE'])
    && !hasEnvKey('# BACKUP_PASSPHRASE=x\n', ['BACKUP_PASSPHRASE']), 'a key with a value, not an empty or commented one');
}

console.log('=== deploy/install-units.sh, the installer bootstrap and --fix share ===');
{
  const units = read('deploy/install-units.sh');
  ok(spawnSync('bash', ['-n', path.join(REPO, 'deploy/install-units.sh')]).status === 0, 'it parses');
  ok(!/systemctl (start|restart|enable --now)[^\n]*whatsapp-bot|enable_unit whatsapp-bot/.test(units),
    'it never enables or starts the bot');
  ok(/--non-interactive\) SUDO=\(sudo -n\)/.test(units), '--non-interactive never waits on a password');
  const r = spawnSync('bash', [path.join(REPO, 'deploy/install-units.sh'), 'bogus'], { encoding: 'utf8' });
  ok(r.status === 2, 'an unknown piece is a usage error');
  // A dry run with every command that could change the machine stubbed to
  // fail: it must print and not call them.
  const stubs = fs.mkdtempSync(path.join(T, 'stubs-'));
  const calls = path.join(stubs, 'calls');
  for (const c of ['sudo', 'systemctl', 'ethtool', 'ip']) {
    fs.writeFileSync(path.join(stubs, c), `#!/bin/sh\necho "${c} $*" >> '${calls}'\n[ "${c} $1" = "ip route" ] && echo "default via 10.0.0.1 dev eth9"\n[ "${c} $1" = "systemctl is-enabled" ] && echo disabled\nexit 1\n`, { mode: 0o755 });
  }
  // An empty root: a VM's, whatever box runs this - on WSL both Hyper-V
  // pieces say they do not apply (exit 4), which is tested in wsl.test.mjs.
  const vmRoot = fs.mkdtempSync(path.join(T, 'vmroot-'));
  const dry = spawnSync('bash', [path.join(REPO, 'deploy/install-units.sh'), '--dry-run', '--node', '/usr/bin/node', 'whatsapp-bot', 'grow-root-disk'],
    { encoding: 'utf8', env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, INSTALL_UNITS_ROOT: vmRoot } });
  ok(dry.status === 0 && /\+ (write|= )?.*grow-root-disk/.test(dry.stdout) && /whatsapp-bot\.service/.test(dry.stdout), `a dry run prints what it would do (exit ${dry.status})`);
  const log = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
  ok(!/^sudo /m.test(log), 'and runs no sudo');
  const nic = spawnSync('bash', [path.join(REPO, 'deploy/install-units.sh'), '--dry-run', 'nic-offload'],
    { encoding: 'utf8', env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, INSTALL_UNITS_ROOT: vmRoot } });
  ok(nic.status === 4 && /not hv_netvsc/.test(nic.stdout), 'not a Hyper-V NIC: exit 4, and nothing done');
}

fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
