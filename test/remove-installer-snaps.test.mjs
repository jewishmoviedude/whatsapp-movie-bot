/* The installer's extra snaps are removed, and Ubuntu's own are not.
   Run: node test/remove-installer-snaps.test.mjs

   bot-box2 was installed with most of Ubuntu Server's "featured snaps" ticked.
   microk8s, Nextcloud, Rocket.Chat, Wekan and the rest held ~3 GB of RAM and
   CPU that ffmpeg needed, and SABnzbd took port 8080 so the bot could not
   start. The operator asked for a script to remove them. These tests run it
   against a stub `snap`, so nothing real is listed or removed. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'tools/remove-installer-snaps.sh');

/** Run the script with a stub `snap` listing `installed`, and a stub sudo that just runs its command. */
function run(installed, args = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snaps-'));
  const log = path.join(dir, 'calls');
  const snap = path.join(dir, 'snap');
  fs.writeFileSync(snap, `#!/usr/bin/env bash
if [ "$1" = list ]; then echo "Name Version Rev Tracking Publisher Notes"; ${installed.map((s) => `echo "${s} 1 1 latest/stable x -"`).join('; ') || ':'}; exit 0; fi
echo "$*" >> "${log}"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'sudo'), '#!/usr/bin/env bash\n"$@"\n', { mode: 0o755 });
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SNAP_BIN: snap, PATH: `${dir}:${process.env.PATH}` },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...r, calls };
}

const VIA_VM2 = ['aws-cli', 'canonical-livepatch', 'core18', 'core20', 'core22', 'core24', 'doctl', 'etcd', 'keepalived',
  'lxd', 'microk8s', 'mosquitto', 'nextcloud', 'powershell', 'prometheus', 'rocketchat-server', 'sabnzbd', 'slcli',
  'snapd', 'wekan', 'wormhole'];

console.log('=== bot-box2\'s snaps ===');
{
  const r = run(VIA_VM2);
  const removed = r.calls.map((c) => c.replace(/^remove --purge /, ''));
  ok(r.status === 0, `it succeeds (${r.stderr.trim() || 'no errors'})`);
  ok(['microk8s', 'nextcloud', 'rocketchat-server', 'wekan', 'sabnzbd', 'prometheus', 'mosquitto'].every((s) => removed.includes(s)),
    'the ones that were running are removed');
  ok(removed[0] === 'microk8s', 'microk8s first, the heaviest');
  ok(!removed.some((s) => /^core|^snapd$|^canonical-livepatch$/.test(s)), 'Ubuntu\'s base snaps and Livepatch are left alone');
  ok(r.calls.every((c) => c.startsWith('remove --purge ')), 'every removal is --purge, so no data snapshot is kept');
}

console.log('=== a dry run removes nothing ===');
{
  const r = run(VIA_VM2, ['--dry-run']);
  ok(r.status === 0 && r.calls.length === 0, 'no removal was run');
  ok(/would run: sudo .*snap remove --purge microk8s/.test(r.stdout), 'and it says what would be');
}

console.log('=== a clean box ===');
{
  const r = run(['core24', 'snapd']);
  ok(r.status === 0 && r.calls.length === 0 && /nothing to remove/.test(r.stdout), 'nothing to do, and it says so');
}

console.log('=== a box without snapd, and a snap list that fails ===');
{
  // tools/bootstrap.sh asks this on every box it builds. Without snapd the
  // script used to stop with exit 127 and nothing said (set -e, pipefail).
  const none = spawnSync('bash', [SCRIPT, '--dry-run'], {
    encoding: 'utf8', env: { ...process.env, SNAP_BIN: '/nonexistent/snap' },
  });
  ok(none.status === 0 && /snap is not installed here - nothing to remove/.test(none.stdout), 'no snap command: exit 0, and it says so');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snaps-'));
  const broken = path.join(dir, 'snap');
  fs.writeFileSync(broken, '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
  const r = spawnSync('bash', [SCRIPT, '--dry-run'], { encoding: 'utf8', env: { ...process.env, SNAP_BIN: broken } });
  fs.rmSync(dir, { recursive: true, force: true });
  ok(r.status === 2 && /snap list failed/.test(r.stderr), 'snap list failing: exit 2, with a reason, and nothing removed');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
