/* tools/port-holder.sh, and bootstrap.sh asking it before it starts the bot.
   Run: node test/port-holder.test.mjs

   2026-09-29: the Ubuntu installer's "featured snaps" had been ticked on a new
   box, SABnzbd held 8080, and the bot crashed at every start with
   EADDRINUSE - a crash loop that deploy/auto-update.sh blames on the newest
   commit and takes back out. The script names what holds the port and the
   command that would free it, and never stops anything itself. `ss` and
   `sudo` are stubs and /proc is a scratch folder. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'tools/port-holder.sh');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'port-holder-'));
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

function holder({ ss = '', cgroup = null, sudoWorks = true } = {}) {
  const dir = fs.mkdtempSync(path.join(ROOT, 'box-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(path.join(bin, 'ss'), `#!/usr/bin/env bash\necho "ss $*" >> "${log}"\ncat <<'EOF'\n${ss}\nEOF\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'sudo'), `#!/usr/bin/env bash\necho "sudo $*" >> "${log}"\n${sudoWorks ? 'shift; "$@"' : 'exit 1'}\n`, { mode: 0o755 });
  if (cgroup) {
    fs.mkdirSync(path.join(dir, 'proc', '4242'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'proc', '4242', 'cgroup'), `0::${cgroup}\n`);
  }
  const r = spawnSync('bash', [SCRIPT, '8080'], {
    encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, PORT_HOLDER_PROC: path.join(dir, 'proc') },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}
const LISTEN = (name) => `LISTEN 0      511    0.0.0.0:8080 0.0.0.0:* users:(("${name}",pid=4242,fd=5))`;

console.log('=== a free port ===');
{
  const r = holder();
  ok(r.code === 0 && /port 8080 is free/.test(r.out), 'exits 0 and says so');
  ok(/^sudo -n ss -Hltnp sport = :8080$/m.test(r.calls), 'asked with sudo -n, which never waits on a password');
}

console.log('=== a snap holds it (SABnzbd, 2026-09-29) ===');
{
  const r = holder({ ss: LISTEN('python3'), cgroup: '/system.slice/snap.sabnzbd.sabnzbd.service' });
  ok(r.code === 1, 'exits 1');
  ok(/held by python3 \(pid 4242\), from the snap "sabnzbd"/.test(r.out), 'names the process and the snap');
  ok(/sudo snap stop --disable sabnzbd/.test(r.out) && /sudo snap remove sabnzbd/.test(r.out), 'and the commands that would free it');
  ok(/tools\/remove-installer-snaps\.sh/.test(r.out), 'and, since SABnzbd is one of the installer\'s extras, the script that removes them all');
  ok(!/^sudo (snap|systemctl|kill)/m.test(r.calls), 'but runs none of them');
  const other = holder({ ss: LISTEN('python3'), cgroup: '/system.slice/snap.mytool.web.service' });
  ok(other.code === 1 && /the snap "mytool"/.test(other.out) && !/remove-installer-snaps/.test(other.out),
    'a snap the installer does not offer is not blamed on it');
  const part = holder({ ss: LISTEN('python3'), cgroup: '/system.slice/snap.cli.web.service' });
  ok(!/remove-installer-snaps/.test(part.out), 'nor is one whose name is only part of one on the list (cli, in aws-cli)');
}

console.log('=== a service, a process started by hand, and one it cannot see ===');
{
  const s = holder({ ss: LISTEN('nginx'), cgroup: '/system.slice/nginx.service' });
  ok(s.code === 1 && /sudo systemctl disable --now nginx\.service/.test(s.out), 'a service: systemctl disable --now');
  const h = holder({ ss: LISTEN('node'), cgroup: '/user.slice/user-1000.slice/session-3.scope' });
  ok(h.code === 1 && /started by hand/.test(h.out) && /sudo kill 4242/.test(h.out), 'by hand: its pid');
  const u = holder({ ss: 'LISTEN 0      511    0.0.0.0:8080 0.0.0.0:*', sudoWorks: false });
  ok(u.code === 1 && /cannot see/.test(u.out) && /sudo ss -ltnp/.test(u.out), 'without sudo, it still says the port is taken');
}

console.log('=== the bot itself is not in its own way ===');
{
  const r = holder({ ss: LISTEN('node'), cgroup: '/system.slice/whatsapp-bot.service' });
  ok(r.code === 0 && /held by the bot itself/.test(r.out), 'whatsapp-bot.service holding it counts as free');
}

console.log('=== bootstrap.sh asks it, and never starts the bot onto a taken port ===');
{
  const boot = fs.readFileSync(path.join(REPO, 'tools/bootstrap.sh'), 'utf8');
  ok(/port-holder\.sh/.test(boot) && /port_free/.test(boot.slice(boot.indexOf('step "Preflight"'), boot.indexOf('step "Passwordless sudo'))),
    'the preflight warns about a taken port at once, before anything is installed');
  ok(/port_free[\s\S]{0,400}REPLY=''/.test(boot), 'and a taken port turns a "yes" to starting the bot into a checklist line');
  ok(!/snap (stop|remove|disable)/.test(boot.split('\n').filter((l) => !/^\s*#/.test(l) && !/echo|info|warn|todo/.test(l)).join('\n')),
    'it stops or removes no snap by name itself');
  // What it may remove is the installer's extras, through the script that
  // knows exactly which, and only on a yes (test/sealed-backup.test.mjs runs
  // it both ways).
  ok(/\(\( SNAPS_REMOVE \)\)[\s\S]{0,40}run bash "\$SNAPS_TOOL"/.test(boot) && /case \$SNAPS_ANSWER in y\|yes\) SNAPS_REMOVE=1/.test(boot),
    'the installer\'s extras go only through tools/remove-installer-snaps.sh, and only on a yes');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
