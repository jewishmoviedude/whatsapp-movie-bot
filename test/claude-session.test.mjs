/* The Claude Code session that comes back after a reboot: deploy/claude-session.sh
   (what runs at boot, and the ~/.bashrc hook) and deploy/install-claude-session.sh.
   Run: node test/claude-session.test.mjs

   The operator, 2026-09-30: "How do I set in the vm that this session ...
   should automatically resume after a reboot?" The session ran as `claude
   --resume <id>`, typed into a plain SSH login on bot-box2, so a reboot ended
   it for good. Now a user unit (linger on, so it starts at boot with nobody
   logged in) runs `claude --continue` - or --resume <a pinned id> - in a
   detached tmux session "claude", and an interactive SSH login is told it is
   there (claude-attach opens it; attaching at every login, the first design,
   left the operator no plain shell, 2026-10-07).

   Why each guard is here:
   - Two processes on one conversation write into one transcript with no lock,
     and their messages interleave. So the start refuses while tmux session
     "claude" exists, or while an interactive claude works in the checkout (or
     has the pinned id on its command line), and the installer never starts
     it unless asked: the session to resume was running, in a plain SSH
     login, when this was written.
   - Print-mode claude (-p) is not in the way: interactive --continue passes
     over its conversations, and the hourly check's research session is one.
   - The hook attaches only an interactive shell on an SSH terminal. Anything
     else - scp, rsync, `ssh host cmd`, the Claude desktop app's and the hourly
     check's commands - must pass straight through: a byte of output breaks
     scp, and an attach would hang a command nobody is watching.
   - Not exec, so Ctrl-b d comes back to a shell; tmux's "=claude", so a
     session called "claude-notes" is never taken for it; KillMode=process, so
     stopping the unit ends that one session and not the tmux server's others.

   Every command either script could change a machine with - sudo, loginctl,
   systemctl, tmux, apt-get, getent - is a stub here, in a temporary HOME;
   the suite checks that before it runs anything, and never touches the real
   linger, units, ~/.bashrc or tmux. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const skip = (m) => console.log(`  skip ${m}`);

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-session-test-')));
const USER = os.userInfo().username;
const put = (p, text, mode = 0o644) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, { mode });
  fs.chmodSync(p, mode);
};
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
const SEED = "# my own bashrc\nalias ll='ls -l'\nexport EDITOR=vi\n";
const STUBBED = ['sudo', 'loginctl', 'systemctl', 'tmux', 'apt-get', 'getent'];

/**
 * A box: a copy of the two scripts in a checkout, a HOME, and stubs for every
 * command that could change the machine. `o`: { linger, session (tmux session
 * "claude" exists), noBus (systemctl --user fails), net ('down'), noClaude,
 * bashrc (text, or null for none) }.
 */
function box(o = {}) {
  const dir = fs.mkdtempSync(path.join(T, 'box-'));
  const app = path.join(dir, o.appName ?? 'app');
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  const state = path.join(dir, 'state');
  const calls = path.join(dir, 'calls.log');
  for (const d of [home, state, path.join(dir, 'run'), path.join(dir, 'proc'), path.join(dir, 'linger'), path.join(dir, 'tmux')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  for (const f of ['deploy/claude-session.sh', 'deploy/install-claude-session.sh']) put(path.join(app, f), read(path.join(REPO, f)), 0o755);
  const stub = (name, body) => put(path.join(bin, name), `#!/usr/bin/env bash\nprintf '%s\\n' "${name} $*" >> "$CS_CALLS"\n${body}\n`, 0o755);
  // sudo runs what it is given, as this user; -n is noted in the log line.
  stub('sudo', '[ "$1" = -n ] && shift\nexec "$@"');
  stub('loginctl', `case "$1" in
  show-user) if [ -e "$CS_STATE/linger" ]; then echo Linger=yes; else echo Linger=no; fi ;;
  enable-linger) touch "$CS_STATE/linger" ;;
esac
exit 0`);
  // systemctl --user: what enable and disable do to the unit directory, or,
  // with CS_NO_BUS, the error a box with no user manager gives.
  stub('systemctl', `[ "$CS_NO_BUS" = 1 ] && { echo "Failed to connect to bus: No medium found" >&2; exit 1; }
if [ "$1" = --user ]; then
  w="$HOME/.config/systemd/user/default.target.wants"
  case "$2" in
    enable) mkdir -p "$w" && ln -sfn "$HOME/.config/systemd/user/$3" "$w/$3" ;;
    disable) rm -f "$w/$3" ;;
  esac
fi
exit 0`);
  stub('tmux', `case "$1" in
  -V) echo "tmux 3.4" ;;
  has-session) [ -e "$CS_STATE/tmux-claude" ]; exit $? ;;
  new-session) touch "$CS_STATE/tmux-claude"; shift; printf '%s\\n' "$@" > "$CS_STATE/new-session" ;;
  kill-session) rm -f "$CS_STATE/tmux-claude" ;;
  attach-session) echo ATTACHED ;;
esac
exit 0`);
  stub('apt-get', 'exit 0');
  stub('getent', '[ "$CS_NET" = down ] && exit 2\necho "160.79.104.10   STREAM api.anthropic.com"\nexit 0');
  if (!o.noClaude) put(path.join(home, '.local/bin/claude'), '#!/bin/sh\nexit 0\n', 0o755);
  if (o.bashrc !== null) put(path.join(home, '.bashrc'), o.bashrc ?? SEED);
  put(path.join(home, '.hushlogin'), '');
  if (o.linger) put(path.join(state, 'linger'), '');
  if (o.session) put(path.join(state, 'tmux-claude'), '');

  const env = { ...process.env };
  for (const k of ['SSH_TTY', 'SSH_CONNECTION', 'SSH_CLIENT', 'TMUX', 'TMUX_PANE', 'CLAUDE_NO_ATTACH', 'DBUS_SESSION_BUS_ADDRESS',
    'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'CLAUDE_SESSION_ID', 'CLAUDE_SESSION_BIN', 'CLAUDE_SESSION_CONFIG', 'CLAUDE_SESSION_LOG']) delete env[k];
  Object.assign(env, {
    PATH: `${bin}:${process.env.PATH}`, HOME: home, USER,
    // A user manager of its own that answers nothing, and a tmux socket
    // directory of its own: if a stub were ever missed, the real ones
    // could not reach the real manager or the real tmux server.
    XDG_RUNTIME_DIR: path.join(dir, 'run'), TMUX_TMPDIR: path.join(dir, 'tmux'),
    CS_CALLS: calls, CS_STATE: state, CS_NET: o.net ?? 'up', CS_NO_BUS: o.noBus ? '1' : '0',
    CLAUDE_SESSION_LINGER_DIR: path.join(dir, 'linger'), CLAUDE_SESSION_PROC: path.join(dir, 'proc'), CLAUDE_SESSION_NET_WAIT: '4',
  });
  const b = { dir, app, home, bin, state, env,
    unitFile: path.join(home, '.config/systemd/user/claude-session.service'),
    wants: path.join(home, '.config/systemd/user/default.target.wants/claude-session.service'),
    bashrc: path.join(home, '.bashrc'),
    log: path.join(home, '.local/state/whatsapp-bot/claude-session.log'),
    pinFile: path.join(home, '.config/whatsapp-bot/claude-session.env'),
    claude: path.join(home, '.local/bin/claude'),
  };
  const go = (script, args, extra = {}, opts = {}) => {
    fs.rmSync(calls, { force: true });
    const r = spawnSync('bash', [path.join(app, 'deploy', script), ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, cwd: opts.cwd ?? dir, env: { ...env, ...extra },
    });
    return { ...r, out: `${r.stdout}${r.stderr}`, calls: read(calls) ?? '' };
  };
  b.install = (args = [], extra) => go('install-claude-session.sh', args, extra);
  b.launch = (args = ['start'], extra) => go('claude-session.sh', args, extra);
  /** A process in the fake /proc: { pid, comm, argv, cwd }. */
  b.proc = ({ pid, comm = 'claude', argv, cwd }) => {
    const d = path.join(dir, 'proc', String(pid));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'comm'), `${comm}\n`);
    fs.writeFileSync(path.join(d, 'cmdline'), `${argv.join('\0')}\0`);
    fs.symlinkSync(cwd, path.join(d, 'cwd'));
  };
  b.newSession = () => (read(path.join(state, 'new-session')) ?? '').split('\n').filter(Boolean);
  return b;
}

/* ---------------------------------------------------- safety, then basics */

console.log('=== every command that could change this machine is a stub ===');
{
  const b = box();
  const probe = spawnSync('bash', ['-c', `for c in ${STUBBED.join(' ')}; do command -v "$c"; done`], { encoding: 'utf8', env: b.env });
  const found = probe.stdout.trim().split('\n');
  const safe = found.length === STUBBED.length && found.every((l) => l.startsWith(`${b.bin}/`));
  ok(safe, `${STUBBED.join(', ')} all resolve to stubs in a temporary directory`);
  if (!safe) throw new Error('refusing to run the scripts without their stubs');
}

console.log('=== the scripts ===');
{
  for (const f of ['deploy/claude-session.sh', 'deploy/install-claude-session.sh']) {
    ok(spawnSync('bash', ['-n', path.join(REPO, f)]).status === 0, `${f} parses`);
  }
  const b = box();
  ok(b.install(['--help']).status === 0 && b.launch(['--help']).status === 0, '--help works on both');
  const bad = b.install(['--bogus']);
  ok(bad.status === 2 && /unknown argument/.test(bad.out), 'an unknown argument to the installer is a usage error');
  ok(b.launch(['bogus']).status === 2 && b.launch([]).status === 2, 'and to the launcher');
  ok(!/^(sudo|loginctl|systemctl|tmux) /m.test(b.install(['--help']).calls), '--help runs nothing');
}

/* ------------------------------------------------------------- the unit */

console.log('=== the unit ===');
{
  const b = box();
  const r = b.launch(['unit']);
  const u = r.stdout;
  ok(r.status === 0 && /^Type=oneshot$/m.test(u) && /^RemainAfterExit=yes$/m.test(u),
    'Type=oneshot with RemainAfterExit: a start that rightly starts nothing is not a daemon that died, as it would be under forking');
  ok(u.includes(`ExecStart=/bin/bash ${b.app}/deploy/claude-session.sh start\n`) && u.includes(`ExecStop=/bin/bash ${b.app}/deploy/claude-session.sh stop\n`),
    'it runs the launcher of the checkout it was written from, to start and to stop');
  ok(/^KillMode=process$/m.test(u), 'KillMode=process: stopping it ends tmux session "claude" and no other session of the tmux server');
  ok(!/^Restart=/m.test(u), 'no Restart=: a session ended with /exit stays ended until the next boot');
  ok(/^WantedBy=default\.target$/m.test(u) && /^TimeoutStartSec=(\d+)$/m.test(u) && Number(/^TimeoutStartSec=(\d+)$/m.exec(u)[1]) > 120,
    'wanted by default.target (the user manager\'s boot, with linger), with time enough for the two-minute wait for the network');
  const sa = spawnSync('bash', ['-c', 'command -v systemd-analyze'], { encoding: 'utf8' }).stdout.trim();
  if (sa) {
    const f = path.join(b.dir, 'claude-session.service');
    fs.writeFileSync(f, u);
    const v = spawnSync(sa, ['--user', 'verify', f], { encoding: 'utf8', env: b.env });
    ok(v.status === 0 && !v.stderr.includes('claude-session.service'), `systemd-analyze --user verify finds nothing wrong with it${v.stderr ? ` (${v.stderr.trim().slice(0, 200)})` : ''}`);
  } else {
    skip('systemd-analyze is not installed here');
  }
  const spaced = box({ appName: 'my app' });
  const s = spaced.launch(['unit']);
  ok(s.status === 1 && /character a unit's ExecStart would misread/.test(s.stderr),
    'a checkout whose path systemd would misread gets no unit at all, rather than a wrong one');
}

/* ----------------------------------------------------------- the install */

console.log('=== installing: linger, the unit enabled but not started, the hook ===');
{
  const b = box();
  const r = b.install(['--non-interactive']);
  ok(r.status === 0, `a fresh box: exit 0${r.status ? `: ${r.out.slice(-600)}` : ''}`);
  ok(new RegExp(`^sudo -n loginctl enable-linger ${USER}$`, 'm').test(r.calls),
    'linger is turned on, with sudo -n: the user manager then starts at boot with nobody logged in');
  ok(read(b.unitFile) === `${b.launch(['unit']).stdout}`, 'the unit written is exactly what the launcher prints for this checkout');
  ok(/^systemctl --user daemon-reload$/m.test(r.calls) && /^systemctl --user enable claude-session\.service$/m.test(r.calls)
    && fs.readlinkSync(b.wants) === b.unitFile, 'reloaded, and enabled at boot');
  ok(!/^systemctl --user (start|restart)\b/m.test(r.calls) && !/^tmux new-session/m.test(r.calls) && !fs.existsSync(path.join(b.state, 'tmux-claude')),
    'and NOT started: the conversation to resume may be running right now in a plain SSH login');
  ok(/not started now: it starts at the next boot/.test(r.out) && /--start-now/.test(r.out), 'it says so, and how to start it later');
  const rc = read(b.bashrc);
  const hook = b.launch(['hook']).stdout;
  ok(rc.startsWith(SEED) && rc.includes(hook) && rc.split('# >>> whatsapp-bot: claude-session >>>').length === 2,
    '~/.bashrc keeps what it had, and has the hook once, at the end');
  ok(!/apt-get/.test(r.calls), 'tmux is here already, so nothing is installed');

  const unitBefore = read(b.unitFile);
  const again = b.install(['--non-interactive']);
  ok(again.status === 0 && !/enable-linger|daemon-reload|--user enable/.test(again.calls) && read(b.bashrc) === rc && read(b.unitFile) === unitBefore,
    'run again: nothing changes - no linger call, no reload, no enable, ~/.bashrc byte for byte');
  ok(/= linger is on/.test(again.out) && /up to date/.test(again.out) && /= claude-session\.service is enabled at boot/.test(again.out), 'and it says each is in place');

  // An older hook: replaced where it is, what follows it kept.
  const old = rc.replace(/echo 'Attaching[^\n]*\n/, "echo 'an older hook'\n") + 'export AFTER_HOOK=1\n';
  fs.writeFileSync(b.bashrc, old);
  const up = b.install(['--non-interactive']);
  const now = read(b.bashrc);
  ok(up.status === 0 && now.includes(hook) && !now.includes('an older hook') && now.endsWith('export AFTER_HOOK=1\n')
    && now.split('# >>> whatsapp-bot: claude-session >>>').length === 2 && now.startsWith(SEED),
  'an older hook is replaced in place: once, with what came after it still after it');

  // A begin marker with no end: the rest of the file would look like the
  // block, and would go with it.
  const torn = `${SEED}# >>> whatsapp-bot: claude-session >>>\nexport KEEP_ME=1\n`;
  fs.writeFileSync(b.bashrc, torn);
  const t = b.install(['--non-interactive']);
  ok(t.status === 1 && /with no "# <<< whatsapp-bot: claude-session <<<" after it/.test(t.out) && read(b.bashrc) === torn,
    'a hook whose end marker is gone: refused, and ~/.bashrc left exactly as it was');

  // The unit written for another checkout is rewritten for this one.
  fs.writeFileSync(b.unitFile, read(b.unitFile).replaceAll(b.app, '/somewhere/else'));
  fs.writeFileSync(b.bashrc, rc);
  const moved = b.install(['--non-interactive']);
  ok(moved.status === 0 && read(b.unitFile).includes(`${b.app}/deploy/claude-session.sh start`) && /^systemctl --user daemon-reload$/m.test(moved.calls),
    'a unit that runs another checkout is rewritten for this one, and reloaded');
}

console.log('=== installing where things are missing or odd ===');
{
  const dry = box();
  const d = dry.install(['--dry-run']);
  ok(d.status === 0 && /\+ sudo loginctl enable-linger/.test(d.out) && /\+ write \S+claude-session\.service/.test(d.out) && /\+ systemctl --user enable/.test(d.out),
    '--dry-run prints what it would do');
  ok(!fs.existsSync(dry.unitFile) && !fs.existsSync(dry.wants) && read(dry.bashrc) === SEED
    && !/^(sudo|systemctl|tmux new-session)/m.test(d.calls), 'and does none of it');

  const noBus = box({ noBus: true, linger: true });
  const n = noBus.install(['--non-interactive']);
  ok(n.status === 0 && fs.readlinkSync(noBus.wants) === noBus.unitFile && /linking it by hand/.test(n.out),
    'no user manager to ask: enabled all the same, with the link systemctl would have made');

  const none = box({ bashrc: null, linger: true });
  const nr = none.install(['--non-interactive']);
  ok(nr.status === 0 && read(none.bashrc) === `${none.launch(['hook']).stdout}`, 'no ~/.bashrc at all: one with just the hook');

  // A ~/.bashrc that is a link into a dotfiles checkout stays a link.
  const linked = box({ bashrc: null, linger: true });
  put(path.join(linked.home, 'dotfiles/bashrc'), SEED);
  fs.symlinkSync(path.join(linked.home, 'dotfiles/bashrc'), linked.bashrc);
  linked.install(['--non-interactive']);
  ok(fs.lstatSync(linked.bashrc).isSymbolicLink() && read(path.join(linked.home, 'dotfiles/bashrc')).includes('whatsapp-bot: claude-session'),
    'a ~/.bashrc that links elsewhere stays a link, and the file it links to gets the hook');

  const noClaude = box({ noClaude: true, linger: true });
  const nc = noClaude.install(['--non-interactive']);
  ok(nc.status === 0 && /Claude Code is not at \S+ yet/.test(nc.out) && fs.existsSync(noClaude.unitFile),
    'Claude Code not installed yet: set up all the same, with a warning (the claude-code routine installs it)');

  // tmux missing: a PATH with everything but tmux.
  const noTmux = box({ linger: true });
  const farm = path.join(noTmux.dir, 'sysbin');
  fs.mkdirSync(farm);
  for (const dir of String(process.env.PATH).split(':').filter((p) => p && fs.existsSync(p) && !p.startsWith(T))) {
    for (const f of fs.readdirSync(dir)) {
      if (f === 'tmux' || fs.existsSync(path.join(farm, f))) continue;
      try { fs.symlinkSync(path.join(dir, f), path.join(farm, f)); } catch { /* a name taken */ }
    }
  }
  fs.renameSync(path.join(noTmux.bin, 'tmux'), path.join(noTmux.dir, 'tmux.off'));
  const nt = noTmux.install(['--non-interactive'], { PATH: `${noTmux.bin}:${farm}` });
  ok(/^sudo -n apt-get -o DPkg::Lock::Timeout=600 install -y tmux$/m.test(nt.calls), `no tmux: installed with apt-get, waiting for the lock (${nt.status})`);
}

console.log('=== --start-now, --status, --remove, --pin ===');
{
  const b = box({ linger: true });
  const s = b.install(['--non-interactive', '--start-now']);
  ok(s.status === 0 && /^systemctl --user restart claude-session\.service$/m.test(s.calls),
    '--start-now starts it through the unit (restart: a unit whose claude has exited is still "active (exited)")');
  const running = box({ linger: true, session: true });
  const sr = running.install(['--non-interactive', '--start-now']);
  ok(sr.status === 0 && !/--user restart/.test(sr.calls) && /running already: tmux attach -t claude/.test(sr.out),
    'with the session running already, --start-now leaves it alone: a restart would end it');

  const fresh = box();
  const st0 = fresh.install(['--status']);
  ok(st0.status === 1 && /linger: OFF/.test(st0.out) && /NOT there/.test(st0.out) && /NOT told about the session/.test(st0.out) && !/^sudo/m.test(st0.calls),
    '--status on a fresh box: exit 1, and what is missing, changing nothing');
  fresh.install(['--non-interactive']);
  const st1 = fresh.install(['--status']);
  ok(st1.status === 0 && /linger: on/.test(st1.out) && /at boot: enabled/.test(st1.out) && /SSH login: told about the session, claude-attach opens it/.test(st1.out)
    && /resumes: the most recent conversation/.test(st1.out), '--status once installed: exit 0, and what it resumes');

  // --remove, with the session running: the unit and the hook go, the
  // session does not - it could be the one running the command.
  put(path.join(fresh.state, 'tmux-claude'), '');
  const rm = fresh.install(['--remove']);
  ok(rm.status === 0 && !fs.existsSync(fresh.unitFile) && !fs.existsSync(fresh.wants) && /^systemctl --user disable claude-session\.service$/m.test(rm.calls),
    '--remove disables and deletes the unit');
  ok(read(fresh.bashrc) === SEED, 'and takes the hook out of ~/.bashrc, leaving it exactly as it was');
  ok(!/kill-session|disable-linger/.test(rm.calls) && /tmux kill-session -t claude ends it/.test(rm.out),
    'the session running now is left running, and linger on, each with the command that would end it');
  const rm2 = fresh.install(['--remove']);
  ok(rm2.status === 0 && read(fresh.bashrc) === SEED, 'and run again, it finds nothing to do');

  const p = box({ linger: true });
  ok(p.install(['--pin', 'not an id']).status === 2 && p.install(['--pin']).status === 2 && !fs.existsSync(p.pinFile), '--pin refuses what is not a session id');
  const ID = '00000000-0000-4000-8000-000000000001';
  const pw = p.install(['--pin', ID]);
  ok(pw.status === 0 && /^CLAUDE_SESSION_ID=00000000-0000-4000-8000-000000000001$/m.test(read(p.pinFile)) && (fs.statSync(p.pinFile).mode & 0o777) === 0o600,
    '--pin <id> writes the setting, mode 600');
  ok(/no conversation 00000000\S* under ~\/\.claude\/projects/.test(pw.out), 'and warns when this box has no such conversation');
  put(path.join(p.home, `.claude/projects/-srv-bot/${ID}.jsonl`), '{}\n');
  ok(!/no conversation/.test(p.install(['--pin', ID]).out), 'and does not when it has');
  const pu = p.install(['--unpin']);
  ok(pu.status === 0 && !fs.existsSync(p.pinFile) && /most recent conversation/.test(pu.out), '--unpin goes back to the most recent one');
}

/* ------------------------------------------------------- starting at boot */

console.log('=== the start: tmux session "claude", claude --continue in the checkout ===');
{
  const b = box();
  const r = b.launch(['start']);
  const args = b.newSession();
  ok(r.status === 0 && args.slice(0, 5).join(' ') === `-d -s claude -c ${b.app}`,
    `a detached tmux session "claude", started in the checkout${r.status ? `: ${r.out}` : ''}`);
  ok(args[5] === 'bash' && args[6] === '-lc' && args.slice(8).join(' ') === `claude-session ${b.app} ${b.claude} --continue`,
    'running a login bash that execs claude --continue, its arguments passed as arguments');
  ok(/^tmux set-option -w -t =claude: remain-on-exit failed$/m.test(r.calls), 'a start that fails at once stays on screen, with why');
  ok(/started: \S+ --continue in /.test(read(b.log)) && /started:/.test(r.stdout), 'and it is logged, for the journal and the routines check');

  // What tmux would run, run: it lands in the checkout, as a login shell,
  // with claude as the process itself.
  const trace = path.join(b.dir, 'trace');
  put(b.claude, `#!/bin/bash\nprintf '%s|%s\\n' "$PWD" "$*" > '${trace}'\n`, 0o755);
  const pane = spawnSync(args[5], args.slice(6), { encoding: 'utf8', cwd: '/', env: b.env });
  const [pwd, argv] = (read(trace) ?? '').trim().split('|');
  ok(pane.status === 0 && pwd === b.app && argv === '--continue', `the pane's command runs claude --continue in the checkout, from wherever tmux starts it (${pwd}|${argv})`);

  const again = b.launch(['start']);
  ok(again.status === 0 && !/^tmux new-session/m.test(again.calls) && /is there already: nothing started/.test(again.out),
    'tmux session "claude" there already: nothing is started');
}

console.log('=== the start refuses a second process on the conversation ===');
{
  const APP_CLAUDE = (b) => ({ pid: 4242, argv: ['claude', '--resume', '00000000-0000-4000-8000-000000000001'], cwd: b.app });
  const b1 = box();
  b1.proc(APP_CLAUDE(b1));
  const r1 = b1.launch(['start']);
  ok(r1.status === 0 && !/^tmux new-session/m.test(r1.calls) && /not started: Claude Code already runs on this conversation/.test(r1.out)
    && /pid 4242: claude --resume 00000000\S* \(in \S+\/app\)/.test(read(b1.log)),
  'an interactive claude working in the checkout (the operator\'s plain SSH session): refused, and the log names it');

  const b2 = box();
  b2.proc({ pid: 4243, argv: ['claude'], cwd: path.join(b2.app, 'deploy') });
  ok(/not started/.test(b2.launch(['start']).out), 'in a folder of the checkout: refused too');

  const b3 = box();
  b3.proc({ pid: 4244, comm: 'node', argv: ['node', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js', '-c'], cwd: b3.app });
  ok(/not started/.test(b3.launch(['start']).out), 'an npm install of Claude Code, run by node: refused too');

  const b4 = box();
  b4.proc({ pid: 4245, argv: ['/home/bot/.local/bin/claude', '-p', '--permission-mode', 'bypassPermissions', '--output-format', 'json'], cwd: b4.app });
  b4.proc({ pid: 4246, argv: ['claude', '--print', 'hello'], cwd: b4.app });
  b4.proc({ pid: 4247, argv: ['claude'], cwd: '/home/bot/.local/share/whatsapp-bot-debug/clone' });
  b4.proc({ pid: 4248, comm: 'bash', argv: ['bash'], cwd: b4.app });
  const r4 = b4.launch(['start']);
  ok(/^tmux new-session/m.test(r4.calls) && /started:/.test(r4.out),
    'print-mode claude (-p, --print: the hourly check\'s shape), claude in another folder, and other programs in the checkout are not in the way');

  // A pinned conversation: resumed by id, and refused while anything holds
  // that id, wherever it runs.
  const ID = '00000000-0000-4000-8000-000000000001';
  const p1 = box();
  put(p1.pinFile, `# pinned\nCLAUDE_SESSION_ID=${ID}\n`, 0o600);
  const rp = p1.launch(['start']);
  ok(rp.status === 0 && p1.newSession().slice(-2).join(' ') === `--resume ${ID}`, 'pinned: claude --resume <id>, not --continue');
  const p2 = box();
  put(p2.pinFile, `CLAUDE_SESSION_ID="${ID}"\n`, 0o600);
  p2.proc({ pid: 5151, argv: ['claude', '--resume', ID], cwd: '/tmp' });
  ok(/not started/.test(p2.launch(['start']).out) && /pid 5151/.test(read(p2.log)), 'and refused while a claude elsewhere holds that id');
  const p3 = box();
  put(p3.pinFile, 'CLAUDE_SESSION_ID=$(touch /tmp/pwned)\n', 0o600);
  const r3 = p3.launch(['start']);
  ok(r3.status === 1 && /is not a session id/.test(r3.out) && !/^tmux new-session/m.test(r3.calls),
    'a pin that is not a session id: nothing started - "the most recent one" would be a conversation nobody chose - and the file is never run');
  const p4 = box();
  put(p4.pinFile, `CLAUDE_SESSION_ID=${ID}\n`, 0o600);
  p4.launch(['start'], { CLAUDE_SESSION_ID: '0badc0de-0000-4000-8000-000000000000' });
  ok(p4.newSession().slice(-1)[0] === '0badc0de-0000-4000-8000-000000000000', 'a CLAUDE_SESSION_ID in the unit\'s environment (a drop-in) wins over the file');

  // The real /proc: a process called claude, working in the checkout.
  const real = box();
  const fake = path.join(real.dir, 'fakebin', 'claude');
  put(fake, '#!/bin/bash\nsleep 30 &\nwait\n', 0o755);
  const child = spawn(fake, ['--resume', 'abcdef12'], { cwd: real.app, stdio: 'ignore', detached: true });
  let seen = false;
  for (let i = 0; i < 100 && !seen; i++) {
    try { seen = fs.readFileSync(`/proc/${child.pid}/comm`, 'utf8').trim() === 'claude' && fs.readlinkSync(`/proc/${child.pid}/cwd`) === real.app; } catch { /* not yet */ }
    if (!seen) spawnSync('sleep', ['0.05']);
  }
  if (seen) {
    const rr = real.launch(['start'], { CLAUDE_SESSION_PROC: '/proc' });
    ok(/not started/.test(rr.out) && new RegExp(`pid ${child.pid}: `).test(read(real.log) ?? '') && !/^tmux new-session/m.test(rr.calls),
      `in the real /proc too: a running claude in the checkout (pid ${child.pid}) is found, and nothing is started`);
  } else {
    skip('the real /proc: this box would not show a test process\'s name and folder');
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  const clear = box();
  const rc = clear.launch(['start'], { CLAUDE_SESSION_PROC: '/proc' });
  ok(/^tmux new-session/m.test(rc.calls), 'and with no claude in its checkout, the real /proc lets it start (this session\'s own claude is in another folder)');
}

console.log('=== the start waits for the network, a bounded while ===');
{
  const b = box({ net: 'down' });
  const t0 = Date.now();
  const r = b.launch(['start'], { CLAUDE_SESSION_NET_WAIT: '2' });
  const took = Date.now() - t0;
  ok(/waiting up to 2s for the network \(api\.anthropic\.com\)/.test(r.out) && /still does not resolve after 2s: starting all the same/.test(r.out)
    && /^tmux new-session/m.test(r.calls), 'no DNS: it waits, then starts all the same - the conversation is on disk');
  ok(took < 15_000, `and the wait is bounded (${took} ms)`);
  const up = box();
  const ru = up.launch(['start']);
  ok(!/waiting/.test(ru.out) && /^getent ahosts api\.anthropic\.com$/m.test(ru.calls), 'with the network up, no waiting');
  const noC = box({ noClaude: true });
  const rn = noC.launch(['start']);
  ok(rn.status === 1 && /not started: Claude Code is not at/.test(rn.out) && !/^tmux new-session/m.test(rn.calls), 'no Claude Code: exit 1, said, nothing started');
}

console.log('=== the stop ends that one session ===');
{
  const b = box({ session: true });
  const r = b.launch(['stop']);
  ok(r.status === 0 && r.calls.split('\n').filter((l) => /^tmux (kill|stop)/.test(l)).join('|') === 'tmux kill-session -t =claude',
    'tmux kill-session -t =claude, exactly: never kill-server, never another session');
  const none = box();
  const rn = none.launch(['stop']);
  ok(rn.status === 0 && !/kill-session/.test(rn.calls), 'with no session, nothing to end, and still exit 0 (the unit does not fail its stop)');
  const st = b.launch(['status']);
  ok(st.status === 0 && /not running/.test(st.stdout) && /resumes: the most recent conversation/.test(st.stdout) && /last: .*stopped/.test(st.stdout),
    'status says whether it runs, what it resumes, and the last thing it did');
}

/* --------------------------------------------------------- the SSH hook */

console.log('=== the ~/.bashrc hook: an SSH login is a plain shell that is told about the session ===');
{
  const b = box({ linger: true, session: true });
  b.install(['--non-interactive']);
  const havePty = /PTY-OK/.test(spawnSync('script', ['-qec', 'test -t 0 && test -t 1 && echo PTY-OK', '/dev/null'],
    { encoding: 'utf8', input: '', timeout: 20_000 }).stdout ?? '');
  const withPty = (cmd, extra = {}) => {
    fs.rmSync(path.join(b.dir, 'calls.log'), { force: true });
    const r = spawnSync('script', ['-qec', cmd, '/dev/null'], { encoding: 'utf8', input: '', timeout: 30_000, env: { ...b.env, ...extra } });
    return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, calls: read(path.join(b.dir, 'calls.log')) ?? '' };
  };
  const noPty = (args, extra = {}) => {
    fs.rmSync(path.join(b.dir, 'calls.log'), { force: true });
    const r = spawnSync('bash', args, { encoding: 'utf8', input: '', timeout: 30_000, env: { ...b.env, ...extra } });
    return { stdout: r.stdout ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}`, calls: read(path.join(b.dir, 'calls.log')) ?? '' };
  };
  const SSH = { SSH_TTY: '/dev/pts/7', SSH_CONNECTION: '100.64.0.2 51234 100.64.0.3 22' };
  if (havePty) {
    // The operator, 2026-10-07: every SSH login landed in Claude, so none could
    // get a plain shell. Now it is told, and claude-attach is one word away.
    const a = withPty("bash -ic 'echo AFTER-HINT'", SSH);
    ok(/The Claude session is running \(tmux session "claude"\): type claude-attach/.test(a.out)
      && !/attach-session/.test(a.calls) && /AFTER-HINT/.test(a.out),
      `an interactive SSH login, the session there: one line, and a plain shell - not attached${/ATTACHED/.test(a.out) ? ' (it attached)' : ''}`);
    const ca = withPty("bash -ic 'claude-attach; echo AFTER-DETACH'", SSH);
    ok(/^tmux attach-session -t =claude$/m.test(ca.calls) && /ATTACHED[\s\S]*AFTER-DETACH/.test(ca.out),
      'claude-attach steps into the session, and detaching comes back to the login\'s own shell');
    const old = withPty("bash -ic 'echo AFTER-DETACH'", { ...SSH, CLAUDE_ATTACH: '1' });
    ok(/Attaching to the Claude session/.test(old.out) && /^tmux attach-session -t =claude$/m.test(old.calls)
      && /ATTACHED[\s\S]*AFTER-DETACH/.test(old.out),
      'CLAUDE_ATTACH=1 brings back attaching at login, and detaching still returns to the shell');

    fs.rmSync(path.join(b.state, 'tmux-claude'));
    const gone = withPty("bash -ic 'echo AFTER-DETACH'", SSH);
    ok(/^tmux has-session -t =claude$/m.test(gone.calls) && !/attach-session/.test(gone.calls) && !/Claude session/.test(gone.out),
      'no session: it looks, says nothing, and the login is an ordinary shell');
    put(path.join(b.state, 'tmux-claude'), '');

    for (const [why, extra] of [
      ['not an SSH login (no SSH_TTY: a console, or a terminal the desktop app opened)', {}],
      ['inside tmux already', { ...SSH, TMUX: '/tmp/tmux-1000/default,1234,0' }],
      ['CLAUDE_NO_ATTACH=1', { ...SSH, CLAUDE_NO_ATTACH: '1' }],
    ]) {
      const r = withPty("bash -ic 'echo AFTER-DETACH'", extra);
      ok(!/tmux /.test(r.calls) && !/Claude session/.test(r.out) && /AFTER-DETACH/.test(r.out), `${why}: tmux is not even asked`);
    }
    // `ssh -t host cmd`: a terminal, but bash -c is not interactive - even
    // when something sources ~/.bashrc for it.
    const t = withPty(`bash -c '. "$HOME/.bashrc"; echo AFTER-DETACH'`, SSH);
    ok(!/tmux /.test(t.calls) && /AFTER-DETACH/.test(t.out), '`ssh -t host cmd` sourcing ~/.bashrc: not interactive, so no attach');
  } else {
    skip('the attach cases: no pseudo-terminal can be made here (util-linux script)');
  }
  // scp, rsync, `ssh host cmd`, the desktop app and the hourly check: no
  // terminal. Their output must be theirs alone - a byte more breaks scp.
  const scp = noPty(['-c', '. "$HOME/.bashrc"; echo PROTOCOL'], SSH);
  ok(scp.stdout === 'PROTOCOL\n' && !/tmux /.test(scp.calls), 'no terminal (scp, rsync, `ssh host cmd`): not a byte of output, tmux never asked');
  const inter = noPty(['-ic', 'echo AFTER-DETACH'], SSH);
  ok(!/attach-session/.test(inter.calls) && !/Claude session/.test(inter.out), 'interactive but with no terminal on stdin: no attach');
}

fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
