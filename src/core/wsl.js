/**
 * A bot box that is WSL2 on a Windows laptop, not a VM of its own.
 *
 * The operator moved the bot from the Hyper-V VM bot-box2 to WSL2 on the same
 * laptop (2026-09-29) "so we can utilize the GPU": Hyper-V GPU partitioning
 * refused CUDA and NVENC to the VM, and WSL runs NVENC fine. The distro was
 * cloned from the VM, and everything that then had to be done by hand - and
 * that a fresh session would not have known to do - is here, checked by
 * src/core/routines.js and set up by deploy/wsl-setup.sh:
 *
 *   - systemd, which WSL does not start unless /etc/wsl.conf asks for it:
 *     without it `systemctl restart whatsapp-bot` failed with "System has not
 *     been booted with systemd as init system", and nothing started the bot.
 *   - %UserProfile%\.wslconfig on the Windows side: networkingMode=mirrored,
 *     so the panel is on the laptop's own LAN and Tailscale addresses, and
 *     vmIdleTimeout=-1, so WSL does not shut down when no window is open.
 *   - the units the clone brought from the VM that fight WSL: systemd-networkd
 *     and networkd-dispatcher would apply the VM's static netplan address,
 *     grow-root-disk and eth0-no-offload are for a Hyper-V disk and NIC, and
 *     a second tailscaled beside the Windows client fights it for the 100.x
 *     routes in mirrored networking.
 *   - sshd on port 2222, since Windows holds 22 in mirrored networking.
 *   - a Windows scheduled task that starts the distro when Windows starts:
 *     WSL does not start by itself, so after a reboot nothing ran the bot.
 *
 * Everything here only reads or computes; nothing changes the machine.
 */
import path from 'node:path';

/** The scheduled task wsl-autostart looks for, and the PowerShell makes. */
export const TASK_NAME = 'whatsapp-bot WSL';
/** sshd's port on a WSL box: Windows holds 22 in mirrored networking. */
export const SSH_PORT = 2222;
export const SSHD_PORT_FILE = '/etc/ssh/sshd_config.d/10-wsl-port.conf';
// Built, not written out: the unit scan in test/routines.test.mjs reads a
// literal path under /etc/systemd/system as a unit installed; this drop-in
// belongs to ssh.socket, and deploy/wsl-setup.sh (the wsl-ssh routine's) writes it.
export const SSH_SOCKET_DROPIN = path.join('/etc/systemd/system', 'ssh.socket.d', '10-wsl-port.conf');

/**
 * The units a distro cloned from the Hyper-V VM brings with it, each with why
 * it must be off on WSL. Disabled, and stopped, by deploy/wsl-setup.sh vm-units.
 */
export const VM_UNITS = Object.freeze({
  'systemd-networkd.service': 'would apply the VM\'s netplan address (99-static-lan.yaml) and fight WSL\'s networking',
  'systemd-networkd.socket': 'starts systemd-networkd on demand',
  'systemd-networkd-wait-online.service': 'waits at every boot for a network systemd-networkd does not run',
  'networkd-dispatcher.service': 'runs the VM\'s network hooks',
  'grow-root-disk.service': 'grows an LVM root on a Hyper-V disk; WSL\'s disk is a VHDX Windows manages',
  'eth0-no-offload.service': 'the Hyper-V NIC fix; WSL\'s NIC is not the VM\'s',
  'open-vm-tools.service': 'VMware guest tools, from the VM\'s install',
  'tailscaled.service': 'the Windows Tailscale client is the tailnet node for this laptop; a second one in mirrored '
    + 'networking fights it over the 100.x routes',
});

/** What `systemctl is-enabled` says of a unit that will start at boot. */
export const STARTS_AT_BOOT = new Set(['enabled', 'enabled-runtime', 'alias', 'linked', 'linked-runtime']);

/**
 * Whether this is WSL, and which distro. The kernel's release names it
 * ("6.18.33.2-microsoft-standard-WSL2") in every process, systemd's included;
 * WSL_DISTRO_NAME is only in shells WSL itself started, not under systemd or
 * cron, so it names the distro but does not decide.
 */
export function detectWsl(sys) {
  const release = String(sys.readFile('/proc/sys/kernel/osrelease') ?? '').trim();
  const env = sys.env ?? {};
  const wsl = /microsoft/i.test(release) || !!env.WSL_DISTRO_NAME || !!env.WSL_INTEROP;
  if (!wsl) return null;
  return { release, distro: env.WSL_DISTRO_NAME || null };
}

/* ------------------------------------------------------ ini-style files --- */

/**
 * The value of `key` in `[section]` of an ini-style file (wsl.conf,
 * .wslconfig), or null. Keys and sections are matched without case, as WSL
 * reads them; a `#` or `;` line is a comment.
 */
export function iniGet(text, section, key) {
  let cur = null;
  let found = null;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) { cur = sec[1].trim().toLowerCase(); continue; }
    const kv = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (kv && cur === section.toLowerCase() && kv[1].toLowerCase() === key.toLowerCase()) found = kv[2].trim();
  }
  return found;
}

/**
 * `text` with each `section.key = value` of `values` set, and nothing else
 * changed: a key already there is rewritten in place, a missing one goes at
 * the end of its section, a missing section at the end of the file.
 *
 * Its line endings are kept (Windows writes .wslconfig with CRLF), and it
 * always ends with one. On 2026-09-29 .wslconfig had no line ending after its
 * last line, and a line appended by hand was glued onto it
 * ("ipv6=falsevmIdleTimeout=-1"), which WSL reads as neither setting.
 */
export function iniSet(text, values) {
  const src = String(text ?? '');
  const eol = /\r\n/.test(src) ? '\r\n' : '\n';
  const lines = src.length ? src.replace(/\r?\n$/, '').split(/\r?\n/) : [];
  // [{ section, key, value }]
  const want = [];
  for (const [dotted, value] of Object.entries(values)) {
    const i = dotted.indexOf('.');
    want.push({ section: dotted.slice(0, i), key: dotted.slice(i + 1), value: String(value), done: false });
  }
  let cur = null;
  const out = [];
  const flush = (section) => {
    // Missing keys of the section that is ending, before its trailing blank lines.
    if (section == null) return;
    const add = want.filter((w) => !w.done && w.section.toLowerCase() === section);
    if (!add.length) return;
    let at = out.length;
    while (at > 0 && out[at - 1].trim() === '') at--;
    out.splice(at, 0, ...add.map((w) => `${w.key}=${w.value}`));
    for (const w of add) w.done = true;
  };
  for (const raw of lines) {
    const line = raw.trim();
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) {
      flush(cur);
      cur = sec[1].trim().toLowerCase();
      out.push(raw);
      continue;
    }
    const kv = !line.startsWith('#') && !line.startsWith(';') ? /^([^=]+?)\s*=/.exec(line) : null;
    const w = kv && want.find((x) => x.section.toLowerCase() === cur && x.key.toLowerCase() === kv[1].toLowerCase());
    if (w) {
      // A key set twice: the first is rewritten, the rest dropped, so the
      // file says one thing.
      if (!w.done) out.push(`${w.key}=${w.value}`);
      w.done = true;
      continue;
    }
    out.push(raw);
  }
  flush(cur);
  for (const section of [...new Set(want.filter((w) => !w.done).map((w) => w.section))]) {
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push(`[${section}]`);
    for (const w of want.filter((x) => !x.done && x.section === section)) { out.push(`${w.key}=${w.value}`); w.done = true; }
  }
  return out.join(eol) + eol;
}

/** What /etc/wsl.conf and .wslconfig must say on a bot box. */
export const WSL_CONF_WANT = Object.freeze({ 'boot.systemd': 'true' });
export const WSLCONFIG_WANT = Object.freeze({ 'wsl2.networkingMode': 'mirrored', 'wsl2.vmIdleTimeout': '-1' });

/** The settings of `want` that `text` does not have, as "key=value" words. */
export function iniMissing(text, want) {
  return Object.entries(want).filter(([dotted, value]) => {
    const i = dotted.indexOf('.');
    return String(iniGet(text, dotted.slice(0, i), dotted.slice(i + 1)) ?? '').toLowerCase() !== value.toLowerCase();
  }).map(([dotted, value]) => `${dotted.slice(dotted.indexOf('.') + 1)}=${value}`);
}

/* ------------------------------------------------- the Windows side --- */

const NOT_PEOPLE = new Set(['all users', 'default', 'default user', 'public', 'defaultuser0', 'desktop.ini', 'wdagutilityaccount']);

/** C:\Users\mommy -> /mnt/c/Users/mommy, or null. */
export function winToWsl(p) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(String(p ?? '').trim());
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/').replace(/\/+$/, '')}` : null;
}

/**
 * The Windows profile folder of the user WSL runs for, as a path in here, and
 * how it was found; null when it cannot be. Windows itself is asked first
 * (cmd.exe, through WSL's interop, for %USERPROFILE%). Under systemd or cron
 * that is often not on PATH, so the profiles in /mnt/c/Users are the
 * fallback: the one with a .wslconfig, else the only one, else the one whose
 * name the Linux user's starts with (mommy for mommy, on the laptop).
 */
export async function windowsHome(sys, user) {
  const env = sys.env ?? {};
  if (env.WSL_WINDOWS_HOME) return { dir: env.WSL_WINDOWS_HOME, how: 'WSL_WINDOWS_HOME' };
  const cmd = sys.which('cmd.exe') ?? (sys.exists('/mnt/c/Windows/System32/cmd.exe') ? '/mnt/c/Windows/System32/cmd.exe' : null);
  if (cmd) {
    // /mnt/c as the working directory: from a Linux one cmd.exe warns that
    // UNC paths are not supported, on the same output.
    const r = await sys.run(cmd, ['/d', '/c', 'echo %USERPROFILE%'], { cwd: '/mnt/c', timeoutMs: 15_000 });
    const dir = r.code === 0 ? winToWsl(String(r.stdout).split(/\r?\n/).map((l) => l.trim()).find((l) => /^[A-Za-z]:\\/.test(l))) : null;
    if (dir && sys.exists(dir)) return { dir, how: '%USERPROFILE%' };
  }
  const people = (sys.readdir('/mnt/c/Users') ?? []).filter((n) => !NOT_PEOPLE.has(n.toLowerCase()));
  const withConfig = people.filter((n) => sys.exists(`/mnt/c/Users/${n}/.wslconfig`));
  if (withConfig.length === 1) return { dir: `/mnt/c/Users/${withConfig[0]}`, how: 'the only profile with a .wslconfig' };
  if (people.length === 1) return { dir: `/mnt/c/Users/${people[0]}`, how: 'the only profile' };
  const named = people.filter((n) => String(user ?? '').toLowerCase().startsWith(n.toLowerCase()) || n.toLowerCase().startsWith(String(user ?? '').toLowerCase()));
  if (named.length === 1) return { dir: `/mnt/c/Users/${named[0]}`, how: `the profile named like ${user}` };
  return null;
}

/**
 * The PowerShell, run once as administrator on Windows, that starts the
 * distro whenever Windows starts, and again at the user's logon if it is not
 * running. WSL does not start by itself; systemd, once the distro is up,
 * starts whatsapp-bot.service if it is enabled (start-at-boot).
 *
 * The task holds `sleep infinity` rather than running `/bin/true`: WSL may
 * stop a distro no Windows process is attached to, and a task that stays
 * running keeps one attached. So its time limit is none, rather than the
 * default three days, after which Windows would end it.
 */
export function autostartPowerShell(distro) {
  const d = distro || '<distro>';
  return `$a = New-ScheduledTaskAction -Execute "$env:SystemRoot\\System32\\wsl.exe" -Argument "-d ${d} --exec /bin/sleep infinity"; `
    + '$t = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME)); '
    + '$p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Highest; '
    + '$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries '
    + '-MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1); '
    + `Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $a -Trigger $t -Principal $p -Settings $s -Force`;
}

/** Where schtasks.exe is, through WSL's interop, or null. */
export function schtasks(sys) {
  return sys.which('schtasks.exe') ?? (sys.exists('/mnt/c/Windows/System32/schtasks.exe') ? '/mnt/c/Windows/System32/schtasks.exe' : null);
}

/** Whether `ss -ltnH` output has something listening on `port`. */
export function listensOn(ssOutput, port) {
  return String(ssOutput ?? '').split('\n').some((l) => new RegExp(`[:\\]]${port}\\s`).test(`${l.trim().split(/\s+/)[3] ?? ''} `));
}
