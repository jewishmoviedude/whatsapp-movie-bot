/* A bot box that is WSL2 on a Windows laptop. Run: node test/wsl.test.mjs

   2026-09-29: the operator moved the bot from the Hyper-V VM bot-box2 to WSL2
   on the same laptop "so we can utilize the GPU" (Hyper-V GPU partitioning
   refused CUDA and NVENC to the VM; WSL runs NVENC), and then asked: "Why
   don't you teach the repo?" What was done by hand there is now
   src/core/wsl.js (reading), deploy/wsl-setup.sh (the Linux side),
   tools/wsl-config.mjs (the settings files, and the Windows-side PowerShell)
   and bootstrap.sh's WSL step. The routines themselves are tested in
   routines.test.mjs.

   Two things went wrong by hand that these pin: .wslconfig had no line
   ending after its last line, and the setting appended to it was glued on
   ("ipv6=falsevmIdleTimeout=-1"); and a check that looked only at
   /proc/sys/kernel/osrelease or only at WSL_DISTRO_NAME would miss WSL under
   systemd or cron, where the second is not set.

   Nothing here touches the real /etc or the Windows side: every script runs
   under a fake root, with sudo and systemctl stubbed. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  detectWsl, iniGet, iniSet, iniMissing, winToWsl, windowsHome, autostartPowerShell, listensOn, VM_UNITS,
  WSL_CONF_WANT, WSLCONFIG_WANT, TASK_NAME,
} from '../src/core/wsl.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wsl-test-'));
const put = (p, text, mode) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); if (mode) fs.chmodSync(p, mode); };
const fakeSys = (files = {}, env = {}, run = async () => ({ code: 127, stdout: '', stderr: '' }), dirs = {}) => ({
  env, readFile: (p) => files[p] ?? null, exists: (p) => p in files || p in dirs, readdir: (p) => dirs[p] ?? null,
  which: () => null, run,
});

console.log('=== which box is WSL ===');
{
  ok(detectWsl(fakeSys({ '/proc/sys/kernel/osrelease': '6.18.33.2-microsoft-standard-WSL2\n' }))?.release === '6.18.33.2-microsoft-standard-WSL2',
    'the kernel\'s release names Microsoft: WSL, even with no WSL_DISTRO_NAME (systemd, cron)');
  ok(detectWsl(fakeSys({}, { WSL_DISTRO_NAME: 'bot-box2' }))?.distro === 'bot-box2', 'WSL_DISTRO_NAME alone: WSL, and the distro\'s name');
  ok(detectWsl(fakeSys({ '/proc/sys/kernel/osrelease': '6.8.0-45-generic\n' })) === null, 'a VM\'s kernel: not WSL');
}

console.log('=== the settings files: set what is asked, keep everything else ===');
{
  // The laptop's .wslconfig on 2026-09-29: CRLF, and no line ending at the end.
  const laptop = '[wsl2]\r\nnetworkingMode=mirrored\r\nvmSwitch=VS1-WLAN\r\nipv6=false';
  const out = iniSet(laptop, WSLCONFIG_WANT);
  ok(out === '[wsl2]\r\nnetworkingMode=mirrored\r\nvmSwitch=VS1-WLAN\r\nipv6=false\r\nvmIdleTimeout=-1\r\n',
    `the missing setting goes on a line of its own, never glued onto the last one (${JSON.stringify(out)})`);
  ok(iniSet(out, WSLCONFIG_WANT) === out, 'run again, nothing changes');
  ok(iniMissing(laptop, WSLCONFIG_WANT).join() === 'vmIdleTimeout=-1' && !iniMissing(out, WSLCONFIG_WANT).length, 'what is missing, and then nothing');
  ok(iniMissing('[wsl2]\r\nnetworkingMode=mirrored\r\nipv6=falsevmIdleTimeout=-1', WSLCONFIG_WANT).join() === 'vmIdleTimeout=-1',
    'the glued line reads as the setting missing - which is what WSL makes of it');
  ok(iniSet('[wsl2]\nnetworkingMode=nat\nNetworkingMode=bridged\n', { 'wsl2.networkingMode': 'mirrored' }) === '[wsl2]\nnetworkingMode=mirrored\n',
    'a key already there is rewritten in place, once, whatever its case');
  ok(iniSet('[user]\ndefault=bot\n', WSL_CONF_WANT) === '[user]\ndefault=bot\n\n[boot]\nsystemd=true\n', 'a missing section is added at the end');
  ok(iniSet('', WSLCONFIG_WANT) === '[wsl2]\nnetworkingMode=mirrored\nvmIdleTimeout=-1\n', 'and a missing file is made whole');
  ok(iniSet('[boot]\nsystemd=false\n\n[user]\ndefault=bot\n', WSL_CONF_WANT) === '[boot]\nsystemd=true\n\n[user]\ndefault=bot\n',
    'the laptop\'s /etc/wsl.conf layout: [boot] set, [user] kept');
  ok(iniGet('# [wsl2]\n[WSL2]\n; vmIdleTimeout=5\nvmIdleTimeout = -1\n', 'wsl2', 'vmidletimeout') === '-1', 'comments are not settings; case is not a difference');
}

console.log('=== the Windows profile, found from inside WSL ===');
{
  ok(winToWsl('C:\\Users\\mommy\r') === '/mnt/c/Users/mommy' && winToWsl('nothing') === null, 'C:\\Users\\mommy is /mnt/c/Users/mommy');
  const users = { '/mnt/c/Users': ['All Users', 'mommy', 'Default', 'Default User', 'desktop.ini', 'EveryonesMom', 'Boss', 'Public'] };
  const asked = fakeSys({ '/mnt/c/Windows/System32/cmd.exe': '', '/mnt/c/Users/mommy': '' }, {},
    async (cmd, args, o) => (/cmd\.exe$/.test(cmd) && args.join(' ') === '/d /c echo %USERPROFILE%' && o.cwd === '/mnt/c'
      ? { code: 0, stdout: 'C:\\Users\\mommy\r\n' } : { code: 1, stdout: '' }), users);
  ok((await windowsHome(asked, 'mommy'))?.dir === '/mnt/c/Users/mommy', 'Windows is asked first, for %USERPROFILE%');
  const byConfig = fakeSys({ '/mnt/c/Users/Boss/.wslconfig': '' }, {}, undefined, users);
  ok((await windowsHome(byConfig, 'mommy'))?.dir === '/mnt/c/Users/Boss', 'else the one profile with a .wslconfig');
  const byName = fakeSys({}, {}, undefined, users);
  ok((await windowsHome(byName, 'mommy'))?.dir === '/mnt/c/Users/mommy', 'else, of three people on the laptop, the one named like the Linux user');
  ok(await windowsHome(byName, 'bot') === null, 'and none at all rather than a guess');
  ok((await windowsHome(fakeSys({}, { WSL_WINDOWS_HOME: '/x' }), 'bot'))?.dir === '/x', 'WSL_WINDOWS_HOME says it outright');
}

console.log('=== the rest of the reading ===');
{
  ok(listensOn('LISTEN 0 128 0.0.0.0:2222 0.0.0.0:*\nLISTEN 0 128 [::]:2222 [::]:*\n', 2222) && !listensOn('LISTEN 0 128 0.0.0.0:22222 0.0.0.0:*\n', 2222),
    'sshd on 2222 is told from 22222');
  const ps = autostartPowerShell('bot-box2');
  ok(/wsl\.exe" -Argument "-d bot-box2 --exec \/bin\/sleep infinity"/.test(ps) && /-AtStartup/.test(ps) && /-AtLogOn/.test(ps)
    && /ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/.test(ps) && ps.includes(`-TaskName '${TASK_NAME}'`) && /-Force$/.test(ps),
  'the scheduled task: this distro, at startup and logon, held open, with no time limit, made again safely');
  ok(/-d <distro> /.test(autostartPowerShell(null)), 'with no distro name, a placeholder, never a wrong name');
  const setup = fs.readFileSync(path.join(REPO, 'deploy/wsl-setup.sh'), 'utf8');
  const listed = /local units=\(([^)]*)\)/.exec(setup)?.[1].split(/\s+/).filter(Boolean) ?? [];
  ok(listed.join() === Object.keys(VM_UNITS).join(), `deploy/wsl-setup.sh turns off exactly the units the check looks at (${listed.length})`);
}

/* ------------------------------------------------ the scripts, on a fake root */

const stubs = path.join(T, 'bin');
const calls = path.join(T, 'calls.log');
// sudo runs what writes the fake root (mkdir, tee) and only records the rest;
// systemctl says tailscaled is enabled and everything else is off.
put(path.join(stubs, 'sudo'), `#!/bin/bash\necho "sudo $*" >> '${calls}'\n[[ $1 == -n ]] && shift\ncase $1 in mkdir|tee) exec "$@" ;; esac\nexit 0\n`, 0o755);
put(path.join(stubs, 'systemctl'), `#!/bin/bash\necho "systemctl $*" >> '${calls}'\ncase "$1 $2" in\n  "is-enabled tailscaled.service") echo enabled ;;\n  "is-enabled ssh.socket") echo enabled ;;\n  is-enabled*) echo disabled; exit 1 ;;\n  is-active*) echo inactive; exit 3 ;;\nesac\n`, 0o755);
const wslRoot = path.join(T, 'wsl');
const WIN = '/mnt/c/Users/mommy';
put(path.join(wslRoot, 'proc/sys/kernel/osrelease'), '6.18.33.2-microsoft-standard-WSL2\n');
put(path.join(wslRoot, 'etc/wsl.conf'), '[user]\ndefault=bot\n');
put(path.join(wslRoot, WIN, '.wslconfig'), '[wsl2]\r\nnetworkingMode=mirrored\r\nvmSwitch=VS1-WLAN\r\nipv6=false');
const env = { ...process.env, PATH: `${stubs}:${process.env.PATH}`, WSL_SETUP_ROOT: wslRoot, WSL_WINDOWS_HOME: WIN };
const setup = (...a) => spawnSync('bash', [path.join(REPO, 'deploy/wsl-setup.sh'), ...a], { encoding: 'utf8', env });
const log = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '');

console.log('=== deploy/wsl-setup.sh ===');
{
  ok(spawnSync('bash', ['-n', path.join(REPO, 'deploy/wsl-setup.sh')]).status === 0, 'it parses');
  const vm = spawnSync('bash', [path.join(REPO, 'deploy/wsl-setup.sh'), 'systemd'], { encoding: 'utf8', env: { ...env, WSL_SETUP_ROOT: path.join(T, 'empty') } });
  ok(vm.status === 4 && /not WSL/.test(vm.stdout), 'on a VM: exit 4, and nothing done');
  ok(setup('bogus').status === 2, 'an unknown piece is a usage error');

  const dry = setup('--dry-run', 'systemd', 'wslconfig');
  ok(dry.status === 0 && /\+ write \/etc\/wsl\.conf/.test(dry.stdout) && /\+ write \/mnt\/c\/Users\/mommy\/\.wslconfig/.test(dry.stdout)
    && fs.readFileSync(path.join(wslRoot, 'etc/wsl.conf'), 'utf8') === '[user]\ndefault=bot\n', `a dry run says what it would write, and writes nothing (${dry.stderr.trim()})`);

  const r = setup('systemd', 'wslconfig');
  ok(r.status === 0 && fs.readFileSync(path.join(wslRoot, 'etc/wsl.conf'), 'utf8') === '[user]\ndefault=bot\n\n[boot]\nsystemd=true\n',
    `/etc/wsl.conf asks for systemd, the rest kept (${r.stderr.trim()})`);
  ok(/wsl\.exe --shutdown/.test(r.stdout) && !/^(sudo )?(-n )?wsl/m.test(log()), 'and it says WSL must restart, which it never does itself');
  const cfg = fs.readFileSync(path.join(wslRoot, WIN, '.wslconfig'), 'utf8');
  ok(cfg === '[wsl2]\r\nnetworkingMode=mirrored\r\nvmSwitch=VS1-WLAN\r\nipv6=false\r\nvmIdleTimeout=-1\r\n',
    `.wslconfig: the setting on its own line, CRLF kept, every other line kept (${JSON.stringify(cfg)})`);
  ok(fs.readFileSync(path.join(wslRoot, WIN, '.wslconfig.before-wsl-setup'), 'utf8').endsWith('ipv6=false'), 'with what was there kept beside it');
  ok(!/^sudo .*wslconfig/m.test(log()), 'written without sudo: it is the user\'s own file on Windows');
  const again = setup('systemd', 'wslconfig');
  ok(again.status === 0 && (again.stdout.match(/already up to date/g) ?? []).length === 2, 'run again: nothing to write');

  fs.writeFileSync(calls, '');
  const u = setup('--non-interactive', 'vm-units', 'ssh');
  ok(u.status === 0 && /^sudo -n systemctl disable --now tailscaled\.service$/m.test(log())
    && !/disable --now (systemd-networkd|grow-root-disk)/.test(log()), `only the units that are on are turned off, with sudo -n (${u.stderr.trim()})`);
  ok(/^Port 2222$/m.test(fs.readFileSync(path.join(wslRoot, 'etc/ssh/sshd_config.d/10-wsl-port.conf'), 'utf8'))
    && fs.readFileSync(path.join(wslRoot, 'etc/systemd/system/ssh.socket.d/10-wsl-port.conf'), 'utf8') === '[Socket]\nListenStream=\nListenStream=0.0.0.0:2222\nListenStream=[::]:2222\n',
  'sshd on 2222, in sshd_config.d and in the ssh.socket drop-in that clears 22');
  ok(/^sudo -n systemctl daemon-reload$/m.test(log()) && /^sudo -n systemctl restart ssh\.socket$/m.test(log()), 'then the socket is reloaded and restarted');
}

console.log('=== grow-root-disk does nothing on WSL; the NIC fix is not exempt ===');
{
  const g = spawnSync('bash', [path.join(REPO, 'deploy/install-units.sh'), '--dry-run', 'grow-root-disk'], { encoding: 'utf8', env: { ...env, INSTALL_UNITS_ROOT: wslRoot } });
  ok(g.status === 4 && /WSL/.test(g.stdout) && !/\+ /.test(g.stdout), 'install-units.sh grow-root-disk: exit 4 on WSL, nothing done');
  // 2026-09-30: uploads from WSL ran at 162 KB/s until tso/gso were turned off
  // on eth1, then 5,176 KB/s; the WSL exemption had left it on.
  const n = spawnSync('bash', [path.join(REPO, 'deploy/install-units.sh'), '--dry-run', 'nic-offload'], { encoding: 'utf8', env: { ...env, INSTALL_UNITS_ROOT: wslRoot } });
  ok(!/WSL: the network is WSL/.test(n.stdout), 'install-units.sh nic-offload: not skipped for being WSL (it goes by the NIC\'s driver)');
}

console.log('=== tools/wsl-config.mjs ===');
{
  const edit = spawnSync(process.execPath, [path.join(REPO, 'tools/wsl-config.mjs'), '--edit', path.join(T, 'none.conf'), 'boot.systemd=true'], { encoding: 'utf8' });
  ok(edit.status === 0 && edit.stdout === '[boot]\nsystemd=true\n', 'it prints the edited file, a missing one taken as empty');
  const ps = spawnSync(process.execPath, [path.join(REPO, 'tools/wsl-config.mjs'), '--autostart', 'bot-box2'], { encoding: 'utf8' });
  ok(ps.status === 0 && ps.stdout.trim() === autostartPowerShell('bot-box2'), 'and the PowerShell the routine prints');
  ok(spawnSync(process.execPath, [path.join(REPO, 'tools/wsl-config.mjs'), '--bogus'], { encoding: 'utf8' }).status === 2, 'a usage error is exit 2');
}

console.log('=== bootstrap.sh on WSL, dry run ===');
{
  // Every command that could change a machine is a stub that fails, as in
  // sealed-backup.test.mjs, and the root is the fake WSL one.
  const bstubs = path.join(T, 'bstubs');
  const bcalls = path.join(T, 'bcalls.log');
  for (const c of ['sudo', 'apt-get', 'curl', 'crontab', 'npm', 'visudo', 'ethtool', 'tailscale', 'gh', 'systemctl', 'snap', 'wsl.exe', 'schtasks.exe']) {
    put(path.join(bstubs, c), `#!/bin/sh\necho "${c} $*" >> '${bcalls}'\ncase "${c} $1 $2" in\n  "gh auth status") exit 0 ;;\n  "systemctl is-enabled "*) echo disabled; exit 1 ;;\n  "systemctl show "*) echo inactive; exit 0 ;;\nesac\nexit 1\n`, 0o755);
  }
  const home = path.join(T, 'home');
  fs.mkdirSync(home, { recursive: true });
  const r = spawnSync('bash', [path.join(REPO, 'tools/bootstrap.sh'), '--dry-run'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    env: { ...process.env, PATH: `${bstubs}:${process.env.PATH}`, HOME: home, INSTALL_UNITS_ROOT: wslRoot, WSL_WINDOWS_HOME: WIN, WSL_DISTRO_NAME: 'bot-box2' },
  });
  const out = r.stdout;
  ok(r.status === 0, `exits 0${r.status ? `: ${r.stderr.slice(-400)}` : ''}`);
  ok(/WSL: systemd, the VM's leftover units, and starting with Windows/.test(out) && /wsl-setup\.sh --dry-run systemd/.test(out)
    && /wsl-setup\.sh --dry-run vm-units/.test(out) && /wsl-setup\.sh --dry-run wslconfig/.test(out), 'the WSL step runs the Linux side');
  ok(/\[ \] WSL: start it with Windows - in PowerShell as administrator, once: .*Register-ScheduledTask/.test(out) && /-d bot-box2 /.test(out),
    'and puts the scheduled task on the checklist, for this distro');
  ok(/AutomaticStartAction Nothing/.test(out), 'with keeping the old VM from ever starting a second bot');
  ok(!/tailscale up/.test(out) && /wsl-setup\.sh --dry-run ssh/.test(out) && /New-NetFirewallHyperVRule/.test(out),
    'no Linux Tailscale: sshd on 2222, and the firewall rule if it is refused');
  ok(/\[-\] grow-root-disk \(WSL/.test(out) && /\[-\] LAN address \(WSL: mirrored/.test(out),
    'grow-root-disk and the static address are skipped, and say why');
  const blog = fs.existsSync(bcalls) ? fs.readFileSync(bcalls, 'utf8') : '';
  ok(!/^(sudo|apt-get|visudo|wsl\.exe|schtasks\.exe) /m.test(blog) && fs.readFileSync(path.join(wslRoot, WIN, '.wslconfig'), 'utf8') === cfgNow(),
    'and it ran nothing that changes the machine, on either side');
}
function cfgNow() { return '[wsl2]\r\nnetworkingMode=mirrored\r\nvmSwitch=VS1-WLAN\r\nipv6=false\r\nvmIdleTimeout=-1\r\n'; }

fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
