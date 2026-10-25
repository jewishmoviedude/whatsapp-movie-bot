/* deploy/pin-lan-address.sh. Run: node test/pin-lan-address.test.mjs

   bot-box's address kept moving (.25, .36, .37, .38) behind a home router. The
   instructions before this script ended in `networkctl reload`, which resets
   the link at once and released the lease with the old settings: each run
   moved the box one address along. The script writes one networkd drop-in
   and must never touch the live network. Everything here runs against
   stubbed `ip` and `networkctl` and a scratch /etc.

   2026-09-29, the operator: "assign ubuntu static 192.168.20.45". --static
   writes a netplan file and turns cloud-init's network config off, and
   --apply puts it live behind an undo timer, because a wrong static address
   over SSH cuts the box off. Here `netplan`, `systemd-run`, `systemctl`,
   `ping` and `resolvectl` are stubs too, and /etc/netplan, cloud.cfg.d and
   the undo's state folder are scratch folders: nothing touches the network. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const SCRIPT = fileURLToPath(new URL('../deploy/pin-lan-address.sh', import.meta.url));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-lan-'));
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

function box({ addr = '192.168.20.38/24', mac = '00:15:5d:00:00:01', netfile = '/run/systemd/network/10-netplan-eth0.network',
  env = {}, search = 'lan' } = {}) {
  const dir = fs.mkdtempSync(path.join(ROOT, 'box-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(dir, 'sys', 'eth0'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sys', 'eth0', 'address'), `${mac}\n`);
  for (const d of ['etc', 'netplan', 'cloud', 'var']) fs.mkdirSync(path.join(dir, d));
  const log = path.join(dir, 'calls.log');
  // What `netplan apply` last put live: the static address, or empty for DHCP.
  const applied = path.join(dir, 'applied');
  const put = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\n${body}`, { mode: 0o755 });
  put('ip', `a="${addr}"; proto=dhcp
if [[ -s "${applied}" ]]; then a=$(cat "${applied}"); proto=static; fi
case "$*" in
  "route show default") echo "default via 192.168.20.1 dev eth0 proto $proto src \${a%/*} metric 100" ;;
  *"addr show dev eth0"*) echo "2: eth0    inet $a metric 100 brd 192.168.20.255 scope global dynamic eth0" ;;
esac
`);
  put('networkctl', `if [[ "$1" == status ]]; then
  echo "● 2: eth0"
  ${netfile ? `echo "                Network File: ${netfile}"` : 'echo "                Network File: n/a"'}
  # a long status, so a reader that stops early would SIGPIPE this
  for i in $(seq 1 2000); do echo "Sep 25 16:35:55 bot-box systemd-networkd[1]: eth0: line $i"; done
fi
`);
  put('resolvectl', `case "$1" in
  dns) echo "Link 2 (eth0): 192.168.20.1 fe80::1%eth0" ;;
  domain) echo "Link 2 (eth0): ${search} ~." ;;
esac
`);
  put('netplan', `case "$1" in
  generate) exit \${FAKE_GENERATE_RC:-0} ;;
  apply)
    f="${path.join(dir, 'netplan', '99-static-lan.yaml')}"
    if [[ -f $f ]]; then grep -oE '[0-9.]+/[0-9]+' "$f" | head -n1 > "${applied}"; else : > "${applied}"; fi ;;
esac
`);
  // The undo timer is only recorded; the apply unit is run, as systemd would.
  put('systemd-run', `[[ "$*" == *--on-active=* ]] && exit 0
bash "\${@: -1}"
`);
  put('systemctl', '');
  put('ping', `t="\${@: -1}"
if [[ $t == 192.168.20.1 ]]; then [[ -z "$FAKE_GW_DOWN" ]]; exit; fi
[[ " $FAKE_TAKEN " == *" $t "* ]]
`);
  const run = (...args) => {
    const r = spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:/usr/bin:/bin`, HOME: dir, PIN_LAN_SYSFS: path.join(dir, 'sys'), PIN_LAN_ETC: path.join(dir, 'etc'),
        PIN_LAN_NETPLAN: path.join(dir, 'netplan'), PIN_LAN_CLOUD: path.join(dir, 'cloud'), PIN_LAN_STATE: path.join(dir, 'var', 'pin'),
        PIN_LAN_CONFIRM_TRIES: '2', PIN_LAN_CONFIRM_SLEEP: '0', ...env,
      },
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const at = (...p) => path.join(dir, ...p);
  const readAt = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
  return {
    run, at,
    read: () => readAt(at('etc', '10-netplan-eth0.network.d', '10-request-address.conf')),
    calls: () => readAt(log) ?? '',
    yaml: () => readAt(at('netplan', '99-static-lan.yaml')),
    cloud: () => readAt(at('cloud', '99-disable-network-config.cfg')),
    applied: () => (readAt(applied) ?? '').trim(),
  };
}

console.log('=== it pins the address the box has now, as its MAC ===');
{
  const b = box();
  const r = b.run();
  const f = b.read() ?? '';
  ok(r.code === 0, `exits 0 (${r.out.split('\n').find((l) => /written|FAIL|pin-lan/.test(l)) ?? ''})`);
  ok(/^\[DHCPv4\]$/m.test(f) && /^RequestAddress=192\.168\.20\.38$/m.test(f), 'the drop-in asks for the current address');
  ok(/^ClientIdentifier=mac$/m.test(f), 'as the MAC - what a router reservation is keyed on');
  ok(/^SendRelease=no$/m.test(f), 'and never hands the lease back - some routers give a released address away');
  ok(/MAC 00:15:5d:00:00:01/.test(f), 'the file says which MAC it was written for');
  ok(/next boot/.test(r.out) && /nothing on the network changed/.test(r.out), 'it says it takes effect at the next boot');
  ok(!/networkctl (reload|reconfigure|renew|down|up)/.test(b.calls()), 'and it never touches the live network');
  ok(!/netplan|systemd-run/.test(b.calls()) && b.yaml() === null, 'nor netplan: the DHCP mode is as it was');
  ok(/Hyper-V/.test(r.out) && /Static/.test(r.out), 'a Hyper-V MAC gets the advice to make it static');
  ok(/DHCP reservation/.test(r.out), 'and it points at the reservation, the only real guarantee');

  const again = b.run();
  ok(again.code === 0 && /already pinned to 192\.168\.20\.38/.test(again.out), 'run twice, it says so rather than rewrite it');
}

console.log('=== a given address, on the same network only ===');
{
  const b = box();
  const r = b.run('192.168.20.25');
  ok(r.code === 0 && /^RequestAddress=192\.168\.20\.25$/m.test(b.read() ?? ''), 'pins the address given');
  const other = box();
  const r2 = other.run('192.168.1.30');
  ok(r2.code === 1 && /not on eth0's network/.test(r2.out) && other.read() === null,
    'refuses another subnet - bot-box asked for 192.168.1.30 for a month after it moved, and the router ignored it');
  ok(box().run('999.1.2.3').code === 1 && box().run('--frobnicate').code === 1, 'and nonsense');
}

console.log('=== --print writes nothing ===');
{
  const b = box();
  const r = b.run('--print');
  ok(r.code === 0 && /RequestAddress=192\.168\.20\.38/.test(r.out) && b.read() === null, 'shows the file and leaves /etc alone');
}

console.log('=== a box that is not on systemd-networkd is left alone ===');
{
  const b = box({ netfile: null });
  const r = b.run();
  ok(r.code === 1 && /NetworkManager/.test(r.out) && b.read() === null, 'says why, writes nothing');
}

console.log('=== --static writes a netplan file and turns cloud-init networking off ===');
{
  const b = box({ addr: '192.168.20.45/24', mac: '00:15:5d:00:00:02' });
  const r = b.run('--static');
  const y = b.yaml() ?? '';
  ok(r.code === 0, `exits 0${r.code ? `: ${r.out}` : ''}`);
  ok(y.includes(`network:
  version: 2
  ethernets:
    eth0:
      dhcp4: false
      addresses:
        - 192.168.20.45/24
      routes:
        - to: default
          via: 192.168.20.1
      nameservers:
        addresses:
          - 192.168.20.1
        search:
          - lan
`), 'the address, the current gateway, and the DNS servers and search domain DHCP gave it (not the %zone one, not ~.)');
  ok((fs.statSync(b.at('netplan', '99-static-lan.yaml')).mode & 0o777) === 0o600, 'the netplan file is mode 600, as netplan wants');
  ok(/^network: \{config: disabled\}$/m.test(b.cloud() ?? ''), 'cloud-init is told to leave the network config alone');
  ok(/^netplan generate$/m.test(b.calls()), 'netplan generate checks it');
  ok(!/netplan apply|systemd-run/.test(b.calls()) && b.applied() === '', 'without --apply nothing goes live');
  ok(/next boot/.test(r.out) && /--static 192\.168\.20\.45 --apply/.test(r.out), 'it says so, and how to apply it with the undo');
  ok(/reserve 192\.168\.20\.45 for MAC 00:15:5d:00:00:02/.test(r.out) && /hand it to another device/.test(r.out),
    'and says to reserve the address on the router too');
  const again = b.run('--static');
  ok(again.code === 0 && /already sets 192\.168\.20\.45/.test(again.out), 'run twice, it does not rewrite it');

  const p = box({ addr: '192.168.20.45/24' });
  const rp = p.run('--static', '--print');
  ok(rp.code === 0 && /- 192\.168\.20\.45\/24/.test(rp.out) && p.yaml() === null && p.cloud() === null, '--print shows it and writes nothing');
  const n = box({ addr: '192.168.20.45/24', search: '' });
  n.run('--static');
  ok(!/search:/.test(n.yaml() ?? 'search:'), 'no search domain from DHCP: no search list');
}

console.log('=== --static --apply: live, behind an undo timer, confirmed by the gateway ===');
{
  const b = box({ addr: '192.168.20.38/24' });
  const r = b.run('--static', '192.168.20.45', '--apply');
  const calls = b.calls();
  ok(r.code === 0 && /static 192\.168\.20\.45 is in force/.test(r.out), `applied and confirmed${r.code ? `: ${r.out}` : ''}`);
  const arm = calls.indexOf('--on-active=180');
  const apply = calls.indexOf('netplan apply');
  ok(arm > -1 && apply > arm, 'the undo timer is armed before anything goes live');
  ok(/systemd-run .*--unit=pin-lan-apply/.test(calls), 'the apply runs as its own unit, so a dropped SSH session cannot cut it off');
  ok(/^ping -c 1 -W 2 192\.168\.20\.1$/m.test(calls), 'it is confirmed by the gateway answering');
  ok(calls.lastIndexOf('systemctl stop pin-lan-revert.timer') > apply, 'and only then is the undo cancelled');
  ok(b.applied() === '192.168.20.45/24', 'the new address is the one in force');
  ok(/SSH session to 192\.168\.20\.38 drops/.test(r.out), 'it warns that an SSH session to the old address drops');
  ok(!fs.existsSync(b.at('var', 'pin', 'before')), 'a confirmed config leaves no undo behind');
  ok(!/networkctl (reload|reconfigure)/.test(calls), 'and it never resets the link with networkctl');
  const again = b.run('--static', '192.168.20.45', '--apply');
  ok(again.code === 0 && /already static at 192\.168\.20\.45, and in force/.test(again.out), 'applied twice: nothing to change');
}

console.log('=== a static config that does not work is taken back ===');
{
  // The gateway never answers from the new config: the previous files go back
  // and are applied again, at once.
  const b = box({ addr: '192.168.20.38/24', env: { FAKE_GW_DOWN: '1' } });
  fs.writeFileSync(b.at('cloud', '99-disable-network-config.cfg'), 'network: {config: disabled}  # the admin\'s own\n');
  const r = b.run('--static', '192.168.20.45', '--apply');
  ok(r.code === 1 && /did not answer/.test(r.out) && /previous config is back/.test(r.out), `it fails, and says so (${r.out.trim().split('\n').pop()})`);
  ok(b.yaml() === null, 'the netplan file it wrote is gone');
  ok(/the admin's own/.test(b.cloud() ?? ''), 'a file that was there before is put back as it was');
  ok(b.applied() === '', 'and the previous (DHCP) config is live again');
  ok((b.calls().match(/netplan apply/g) ?? []).length === 2, 'applied again after the failed one');

  const g = box({ addr: '192.168.20.38/24', env: { FAKE_GENERATE_RC: '1' } });
  const rg = g.run('--static', '192.168.20.45', '--apply');
  ok(rg.code === 1 && /netplan generate refused/.test(rg.out) && g.yaml() === null && g.cloud() === null,
    'a file netplan generate refuses is taken back out');
  ok(!/netplan apply|systemd-run/.test(g.calls()), 'and nothing is applied');

  // Written now, applied later: the undo still goes back to before the write.
  const w = box({ addr: '192.168.20.38/24' });
  w.run('--static', '192.168.20.45');
  const rw = w.run('--static', '192.168.20.45', '--apply');
  ok(rw.code === 0 && w.applied() === '192.168.20.45/24', 'a file written earlier is applied by a later --apply');
}

console.log('=== --static refuses what would cut the box off ===');
{
  const t = box({ env: { FAKE_TAKEN: '192.168.20.45' } });
  const rt = t.run('--static', '192.168.20.45');
  ok(rt.code === 1 && /already answers at 192\.168\.20\.45/.test(rt.out) && t.yaml() === null, 'an address another device answers at');
  const o = box();
  ok(o.run('--static', '192.168.1.45').code === 1 && o.yaml() === null, 'an address on another network');
  ok(box().run('--static', '192.168.20.1').code === 1, 'the router\'s own address');
  ok(box().run('--static', '192.168.20.255').code === 1, 'the broadcast address');
  ok(box().run('--apply').code === 1, '--apply without --static: the DHCP settings wait for the next boot, on purpose');
  ok(box({ netfile: null }).run('--static').code === 1, 'a box that is not on systemd-networkd');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
