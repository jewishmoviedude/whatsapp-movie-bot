/* deploy/install-cloudflared.sh: the Cloudflare tunnel as a service on the
   box, its token in a root-only file and in .env, never on a command line.
   Run: node test/install-cloudflared.test.mjs

   2026-09-30, bot-box2: the tunnel for the panel was started with the Docker
   command the Cloudflare Zero Trust dashboard offers, `docker run
   cloudflare/cloudflared tunnel run --token ...`. It registered four
   connections and every check passed, but every visit failed with "Unable to
   reach the origin service ... dial tcp [::1]:8080: connect: connection
   refused": on Docker's default bridge network the ingress rule's
   http://localhost:8080 is the container's own loopback, not the VM's. The
   container also had restart=no and no unit, so a reboot would have ended it,
   and the tunnel was "the one piece set up by hand", so a rebuilt box would
   not have had it at all.

   The script moves the tunnel into cloudflared.service with --token-file,
   retires the containers only once the service has registered, and records
   the token in .env as CLOUDFLARE_TUNNEL_TOKEN, where the sealed backup
   carries it (encrypted) to the next box, which installs it with --from-env.

   The same day's review of the first version found that it could lose the
   panel's tunnel: --from-docker, which the routines check runs with nobody
   watching, took any cloudflared container's token over a healthy service's
   and replaced it in the token file and .env; it removed every container
   whose image name held "cloudflared" (a DNS proxy, another tunnel's stopped
   container); --from-unit left the token in a world-readable drop-in; a new
   token could not be handed to it once one was on the box; a token file left
   0644 was reused as it was; a masked unit was written through; and --status
   printed wrong facts where sudo would not run. Each has a case here.

   Every command it could change a machine with is a stub here, run under a
   temporary root: nothing real is installed, restarted or removed, and the
   stubs log their arguments so the token can be shown to be in none of them. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'deploy/install-cloudflared.sh');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'install-cloudflared-'));
const REAL_PYTHON = spawnSync('bash', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim();
const REAL_INSTALL = spawnSync('bash', ['-c', 'command -v install'], { encoding: 'utf8' }).stdout.trim();

/** A tunnel token shaped like Cloudflare's: base64 of {a, t, s}. */
const makeToken = (secret) => Buffer.from(JSON.stringify({
  a: '0f1e2d3c4b5a69788796a5b4c3d2e1f0', t: '6ad1c0de-7b2f-4c61-9d3e-2f5a8b9c0d1e', s: Buffer.from(secret).toString('base64'),
})).toString('base64');
const TOKEN = makeToken('the-tunnel-secret-of-bot-box2-000001');
const OTHER = makeToken('a-different-tunnel-secret-0000000002');
const ROTATED = makeToken('the-rotated-tunnel-secret-000000003');
const TOKENS = [TOKEN, OTHER, ROTATED];
const CID = 'c0ffee'.padEnd(64, '0');
const CID2 = 'beef'.padEnd(64, '1');
const DNS = 'd0d0'.padEnd(64, '2');
const EXP = 'e4e4'.padEnd(64, '3');
const OLD = 'a1d0'.padEnd(64, '4');

const put = (p, text, mode = 0o644) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, { mode });
  fs.chmodSync(p, mode);
};

/**
 * A container, as `docker inspect` describes it: { id, image, args, env,
 * state ('running'), entry ('cloudflared'), net ('default'), restart ('no') }.
 */
const ctr = (id, image, args, env = [], o = {}) => ({ id, image, args, env, state: 'running', entry: 'cloudflared', net: 'default', restart: 'no', ...o });

/**
 * A box to run the script on. `o`: { cloudflared: installed?, env: .env text
 * or null, containers: [ctr], unit: unit text, dropins: {name: text}, active,
 * enabled, register, updateTimer, tokenFile, tokenMode, etcMode, exposed,
 * sudoFails, dockerNeedsRoot }.
 */
function box(o = {}) {
  const dir = fs.mkdtempSync(path.join(T, 'box-'));
  const bin = path.join(dir, 'bin');
  const root = path.join(dir, 'root');
  const state = path.join(dir, 'state');
  const app = path.join(dir, 'app');
  const calls = path.join(dir, 'calls.log');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(app, { recursive: true });
  const stub = (name, body) => put(path.join(bin, name), `#!/usr/bin/env bash\nprintf '%s\\n' "${name} $*" >> "$CF_CALLS"\n${body}\n`, 0o755);
  // sudo runs what it is given, as this user, and says -n when it was asked;
  // or, with CF_SUDO_FAIL, refuses as sudo does with no password and no terminal.
  stub('sudo', '[ "$CF_SUDO_FAIL" = 1 ] && { echo "sudo: a password is required" >&2; exit 1; }\n[ "$1" = -n ] && shift\nexec env CF_VIA_SUDO=1 "$@"');
  // install, without the -o/-g only root may give; everything else real.
  stub('install', `args=()\nwhile (( $# )); do case $1 in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac; done\nexec ${REAL_INSTALL} "\${args[@]}"`);
  stub('chown', 'exit 0');
  stub('python3', `exec ${REAL_PYTHON} "$@"`);
  stub('docker', `[ "$CF_DOCKER_NEEDS_ROOT" = 1 ] && [ "$CF_VIA_SUDO" != 1 ] && { echo "permission denied while trying to connect to the Docker daemon socket" >&2; exit 1; }
case $1 in
  ps) [ -f "$CF_STATE/docker-ids" ] && cat "$CF_STATE/docker-ids"; exit 0 ;;
  inspect) shift; [ "$1" = -f ] && shift 2; for id in "$@"; do cat "$CF_STATE/inspect-$id"; done; exit 0 ;;
  rm) id=\${@: -1}; sed -i "/^$id$/d" "$CF_STATE/docker-ids"; rm -f "$CF_STATE/inspect-$id"; exit 0 ;;
esac
exit 0`);
  stub('systemctl', `case $1 in
  is-active) s=$(cat "$CF_STATE/active" 2>/dev/null || echo inactive); echo "$s"; [ "$s" = active ]; exit ;;
  is-enabled) s=$(cat "$CF_STATE/enabled" 2>/dev/null || echo not-found); echo "$s"; [ "$s" = enabled ]; exit ;;
  restart) echo active > "$CF_STATE/active" ;;
  enable) echo enabled > "$CF_STATE/enabled" ;;
esac
exit 0`);
  stub('journalctl', '[ "$CF_REGISTER" = 1 ] && echo "INF Registered tunnel connection connIndex=0 event=0 ip=198.41.200.13 location=ewr08 protocol=quic"\nexit 0');
  stub('curl', 'case "$*" in *cloudflare-main.gpg*) echo "-----BEGIN PGP PUBLIC KEY BLOCK-----" ;; esac\nexit 0');
  stub('apt-get', `case "$*" in *" install "*) mkdir -p "$CLOUDFLARED_ROOT/usr/bin"; printf '#!/bin/sh\\necho "cloudflared version 2026.9.3 (stub)"\\n' > "$CLOUDFLARED_ROOT/usr/bin/cloudflared"; chmod 755 "$CLOUDFLARED_ROOT/usr/bin/cloudflared" ;; esac\nexit 0`);
  stub('sysctl', 'exit 0');

  if (o.cloudflared ?? true) put(path.join(root, 'usr/bin/cloudflared'), '#!/bin/sh\necho "cloudflared version 2026.9.3 (stub)"\n', 0o755);
  const envText = o.env === undefined ? 'MASTER_KEY=0123456789abcdef\nBACKUP_PASSPHRASE=\'a long enough passphrase\'\n' : o.env;
  if (envText != null) put(path.join(app, '.env'), envText, 0o600);
  const cs = o.containers ?? [];
  if (cs.length) put(path.join(state, 'docker-ids'), cs.map((c) => `${c.id}\n`).join(''));
  const J = JSON.stringify;
  for (const c of cs) put(path.join(state, `inspect-${c.id}`), `${[c.id, c.image, c.entry, c.state, c.net, c.restart, c.args, c.env].map(J).join(' ')}\n`);
  if (o.unit) put(path.join(root, 'etc/systemd/system/cloudflared.service'), o.unit);
  for (const [name, text] of Object.entries(o.dropins ?? {})) put(path.join(root, 'etc/systemd/system/cloudflared.service.d', name), text);
  if (o.updateTimer) put(path.join(root, 'etc/systemd/system/cloudflared-update.timer'), '[Timer]\nOnCalendar=daily\n');
  if (o.active) put(path.join(state, 'active'), `${o.active}\n`);
  if (o.enabled) put(path.join(state, 'enabled'), `${o.enabled}\n`);
  if (o.etcMode != null) { fs.mkdirSync(path.join(root, 'etc/cloudflared'), { recursive: true }); fs.chmodSync(path.join(root, 'etc/cloudflared'), o.etcMode); }
  if (o.tokenFile) put(path.join(root, 'etc/cloudflared/tunnel-token'), `${o.tokenFile}\n`, o.tokenMode ?? 0o600);
  if (o.exposed) put(path.join(root, 'etc/cloudflared/token-exposed'), 'taken from a container\'s command line on 2026-09-30 14:01 UTC\n');

  const run = (args = [], { input = '', env = {} } = {}) => {
    fs.rmSync(calls, { force: true });
    const r = spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8', input, timeout: 60_000,
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, CF_CALLS: calls, CF_STATE: state,
        CF_REGISTER: (o.register ?? true) ? '1' : '0', CLOUDFLARED_ROOT: root, CLOUDFLARED_ENV_FILE: path.join(app, '.env'),
        CLOUDFLARED_WAIT_SECONDS: '2', CF_SUDO_FAIL: o.sudoFails ? '1' : '0', CF_DOCKER_NEEDS_ROOT: o.dockerNeedsRoot ? '1' : '0', ...env,
      },
    });
    const log = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
    return { ...r, out: `${r.stdout}\n${r.stderr}`, log, lines: log.split('\n').filter(Boolean) };
  };
  const file = (p) => { try { return fs.readFileSync(path.join(root, p), 'utf8'); } catch { return null; } };
  const mode = (p) => fs.statSync(p).mode & 0o777;
  return {
    dir, root, app, run, file, mode,
    envText: () => { try { return fs.readFileSync(path.join(app, '.env'), 'utf8'); } catch { return null; } },
    tokenPath: path.join(root, 'etc/cloudflared/tunnel-token'),
    token: () => { try { return fs.readFileSync(path.join(root, 'etc/cloudflared/tunnel-token'), 'utf8').trim(); } catch { return null; } },
    exposed: () => fs.existsSync(path.join(root, 'etc/cloudflared/token-exposed')),
    containers: () => { try { return fs.readFileSync(path.join(state, 'docker-ids'), 'utf8').split('\n').filter(Boolean); } catch { return []; } },
  };
}

const at = (lines, re) => lines.findIndex((l) => re.test(l));
const leaks = (r) => TOKENS.some((t) => r.out.includes(t) || r.log.includes(t));
const envTokens = (text) => String(text ?? '').split('\n').filter((l) => /^\s*(export\s+)?CLOUDFLARE_TUNNEL_TOKEN\s*=/.test(l));
const DOCKER_ARGS = ['--no-autoupdate', 'tunnel', '--no-autoupdate', 'run', '--token', TOKEN];
const CF_UNIT = `[Unit]\nDescription=cloudflared\nAfter=network-online.target\n\n[Service]\nTimeoutStartSec=0\nType=notify\nExecStart=/usr/bin/cloudflared --no-autoupdate tunnel run --token ${TOKEN}\nRestart=on-failure\nRestartSec=5s\n\n[Install]\nWantedBy=multi-user.target\n`;
const OUR_UNIT = 'ExecStart=/usr/bin/cloudflared --no-autoupdate tunnel run --token-file /etc/cloudflared/tunnel-token\n';
/** The panel's tunnel already in place as the script leaves it: the service, the token file and .env. */
const HEALTHY = { tokenFile: TOKEN, env: `MASTER_KEY=k\nCLOUDFLARE_TUNNEL_TOKEN=${TOKEN}\n`, unit: OUR_UNIT, active: 'active', enabled: 'enabled' };

console.log('=== it parses, and says how it is used ===');
{
  ok(spawnSync('bash', ['-n', SCRIPT]).status === 0, 'bash -n');
  const help = spawnSync('bash', [SCRIPT, '--help'], { encoding: 'utf8' });
  ok(help.status === 0 && ['--from-env', '--from-docker', '--from-unit', '--new-token', '--replace', '--record-env', '--non-interactive', '--status']
    .every((f) => help.stdout.includes(f)) && !/^#/m.test(help.stdout) && !/Why this exists/.test(help.stdout),
  '--help prints every mode, without the comment marks or the history');
  ok(spawnSync('bash', [SCRIPT, '--bogus'], { encoding: 'utf8' }).status === 2, 'an unknown option is exit 2');
  const src = read('deploy/install-cloudflared.sh');
  ok(/EUID -eq 0[\s\S]{0,120}not root/.test(src), 'it refuses to run as root, so .env stays the bot user\'s');
  // Every use of a variable that holds a token - fed to a pipe by printf, a
  // bash builtin that no process list shows, given as a here-string, or
  // compared inside [[ ]] - never an argument of a command.
  const VARS = 'TOKEN|FILE_TOKEN|ENV_TOKEN|tok|known|envtok|lines|out|text';
  const ref = new RegExp(`\\$\\{?(?:${VARS})\\}?(?![A-Za-z_])`);
  const uses = src.split('\n').filter((l) => ref.test(l) && !/^\s*#/.test(l));
  const bad = uses.filter((l) => ref.test(l
    .replace(new RegExp(`printf '%s\\\\n' "\\$(?:${VARS})"\\s*[|;]`, 'g'), '')
    .replace(new RegExp(`<<<"\\$(?:${VARS})"`, 'g'), '')
    .replace(/\[\[[^\]]*\]\]/g, '')));
  ok(uses.length >= 10 && bad.length === 0, `a token only ever reaches a command through a pipe (${uses.length} uses)${bad.length ? ` - not: ${bad.join(' | ')}` : ''}`);
}

console.log('=== the incident: a cloudflared container, moved into the service ===');
{
  const b = box({ containers: [ctr(CID, 'cloudflare/cloudflared:latest', DOCKER_ARGS), ctr(CID2, 'cloudflare/cloudflared:latest', DOCKER_ARGS, [], { state: 'exited', restart: 'unless-stopped' })] });
  const r = b.run(['--from-docker']);
  ok(r.status === 0, `exits 0${r.status ? `: ${r.out.slice(-600)}` : ''}`);
  ok(b.token() === TOKEN && b.mode(b.tokenPath) === 0o600, 'the container\'s token is in /etc/cloudflared/tunnel-token, mode 600');
  ok(r.lines.some((l) => /^sudo install -m 0600 -o root -g root \/dev\/stdin \S+\/etc\/cloudflared\/tunnel-token$/.test(l))
    && r.lines.some((l) => /^chown root:root \S+tunnel-token$/.test(l)), 'written root:root 0600, from stdin');
  const unit = b.file('etc/systemd/system/cloudflared.service');
  ok(/^ExecStart=\/usr\/bin\/cloudflared --no-autoupdate tunnel run --token-file \/etc\/cloudflared\/tunnel-token$/m.test(unit) && !unit.includes(TOKEN),
    'the unit reads it with --token-file, and does not carry it');
  const env = b.envText();
  ok(envTokens(env).length === 1 && env.includes(`CLOUDFLARE_TUNNEL_TOKEN=${TOKEN}\n`), '.env holds it as CLOUDFLARE_TUNNEL_TOKEN, once');
  ok(/^MASTER_KEY=0123456789abcdef$/m.test(env) && /^BACKUP_PASSPHRASE='a long enough passphrase'$/m.test(env) && b.mode(path.join(b.app, '.env')) === 0o600,
    'with every other line kept, and still mode 600');
  ok(!/^TUNNEL_TOKEN=/m.test(env), 'never as TUNNEL_TOKEN, the name cloudflared itself reads');
  ok(!leaks(r), 'the token is never printed, nor on the command line of anything it ran');
  const restart = at(r.lines, /^systemctl restart cloudflared\.service$/);
  const registered = at(r.lines, /^journalctl -u cloudflared\.service /);
  const removed = at(r.lines, new RegExp(`^docker rm -f ${CID}$`));
  ok(restart >= 0 && registered > restart && removed > registered,
    `the container is removed only after the service registered (restart ${restart}, journal ${registered}, rm ${removed})`);
  ok(r.lines.includes(`docker rm -f ${CID2}`), 'and a stopped one with the same token goes too, since a restart policy would bring it back');
  ok(r.lines.some((l) => /^systemctl enable cloudflared\.service$/.test(l)), 'the service is enabled at boot');
  ok(/net\.core\.rmem_max = 7500000/.test(b.file('etc/sysctl.d/60-cloudflared-quic.conf') ?? ''), 'the UDP buffers are raised for QUIC');
  ok(!r.lines.some((l) => /^apt-get /.test(l)), 'with cloudflared installed, apt is left alone');
  ok(/retired container c0ffee000000/.test(r.stdout) && /the panel answers on localhost:8080/.test(r.stdout), 'and it says what it did');
  ok(/Only one box may run this tunnel/.test(r.stdout) && /sudo systemctl disable --now cloudflared/.test(r.stdout),
    'with the reminder that another box running it would be a replica');
  // The token was on the container's command line, so on `sudo docker run`'s
  // line in sudo's log too: moving it does not take it back out of there.
  ok(/sudo's log .*auth\.log[\s\S]*Rotate token[\s\S]*--new-token/.test(r.stderr) && b.exposed(),
    'it says to rotate the token, which sudo logged on the command that started the container, and leaves a note of it');
}

console.log('=== --from-docker takes only this tunnel\'s containers ===');
{
  // A DNS-over-HTTPS proxy, a stopped container of another tunnel, an
  // exporter whose image merely has "cloudflared" in its name, and the
  // tunnel's own container run from an image the tag has since moved off
  // (`docker ps` would show sha256:...; its configuration still names it).
  const b = box({ containers: [
    ctr(CID, 'cloudflare/cloudflared@sha256:4f5e6d', DOCKER_ARGS),
    ctr(DNS, 'crazymax/cloudflared:latest', ['proxy-dns', '--port', '5053']),
    ctr(OLD, 'cloudflare/cloudflared:2026.1.0', ['tunnel', 'run', '--token', OTHER], [], { state: 'exited' }),
    ctr(EXP, 'example/cloudflared-exporter:1', ['--metrics', ':9100'], [], { entry: '/exporter' }),
  ] });
  const r = b.run(['--from-docker']);
  ok(r.status === 0 && b.token() === TOKEN, `the tunnel's container is adopted, whatever its image reference${r.status ? `: ${r.out.slice(-400)}` : ''}`);
  ok(r.lines.includes(`docker rm -f ${CID}`) && !r.lines.some((l) => /^docker rm/.test(l) && !l.endsWith(CID)),
    `only it is removed (${r.lines.filter((l) => /^docker rm/.test(l)).join(', ')})`);
  ok(b.containers().includes(DNS) && b.containers().includes(OLD) && b.containers().includes(EXP), 'the DNS proxy, the other tunnel\'s container and the exporter are all still there');
  ok(/container d0d022222222 \(running\) is left as it is: it carries no tunnel token/.test(r.stderr)
    && /container a1d044444444 \(exited\) is left as it is: it carries another tunnel's token/.test(r.stderr), 'and the ones left are named, with why');
  ok(!/e4e433333333/.test(r.out), 'the exporter is not cloudflared\'s, and not even mentioned');
  ok(!leaks(r), 'no token printed');

  const none = box();
  const rn = none.run(['--from-docker']);
  ok(rn.status === 1 && /no running cloudflared container/.test(rn.stderr) && !rn.lines.some((l) => /^systemctl restart/.test(l)),
    'no container: exit 1, and nothing restarted');
  const two = box({ containers: [ctr(CID, 'cloudflare/cloudflared:latest', DOCKER_ARGS), ctr(CID2, 'cloudflare/cloudflared:2026.9.3', ['tunnel', 'run', '--token', OTHER])] });
  const r2 = two.run(['--from-docker']);
  ok(r2.status === 1 && /different tokens/.test(r2.stderr) && !fs.existsSync(two.tokenPath) && !r2.lines.some((l) => /^(systemctl restart|docker rm)/.test(l)),
    'two running containers with two different tokens: two tunnels, a person\'s call - nothing written, restarted or removed');
  ok(!leaks(r2), 'and neither token is printed');
  const envOnly = box({ containers: [ctr(CID, 'cloudflare/cloudflared:latest', ['tunnel', 'run'], ['PATH=/usr/bin', `TUNNEL_TOKEN=${TOKEN}`])] });
  const r3 = envOnly.run(['--from-docker']);
  ok(r3.status === 0 && envOnly.token() === TOKEN, 'a container given the token as TUNNEL_TOKEN is adopted too');
}

console.log('=== a container never takes the panel\'s tunnel over ===');
{
  // Review, 2026-09-30: with the service healthy on token T, a container of
  // another tunnel beside it made --fix run --from-docker, which put the other
  // token in the token file and .env (and so the next backup) and restarted
  // the service onto the other tunnel.
  const b = box({ ...HEALTHY, containers: [ctr(CID, 'cloudflare/cloudflared:latest', ['tunnel', 'run', '--token', OTHER])] });
  const before = b.envText();
  const r = b.run(['--from-docker', '--non-interactive']);
  ok(r.status === 1 && /not the one in \/etc\/cloudflared\/tunnel-token and .env's CLOUDFLARE_TUNNEL_TOKEN/.test(r.stderr) && /--replace/.test(r.stderr),
    `another tunnel's container beside the service: refused, saying why and how to overrule (${r.stderr.trim().split('\n').pop().slice(0, 140)})`);
  ok(b.token() === TOKEN && b.envText() === before, 'the token file and .env still hold the panel\'s token');
  ok(!r.lines.some((l) => /^(systemctl (restart|enable|daemon-reload)|docker rm|sudo (-n )?(install -m|tee ))/.test(l)) && b.containers().includes(CID),
    'nothing restarted, written or removed');
  ok(!leaks(r), 'and neither token printed');
  const envDiffers = box({ env: `CLOUDFLARE_TUNNEL_TOKEN=${TOKEN}\n`, containers: [ctr(CID, 'cloudflare/cloudflared:latest', ['tunnel', 'run', '--token', OTHER])] });
  const re = envDiffers.run(['--from-docker']);
  ok(re.status === 1 && /\.env's CLOUDFLARE_TUNNEL_TOKEN/.test(re.stderr) && !fs.existsSync(envDiffers.tokenPath), '.env holding another token is refused the same way');
  const replaced = b.run(['--from-docker', '--replace']);
  ok(replaced.status === 0 && b.token() === OTHER && envTokens(b.envText()).length === 1 && b.envText().includes(`CLOUDFLARE_TUNNEL_TOKEN=${OTHER}`),
    'with --replace, a person\'s decision, the container\'s token is taken - in the token file and in .env');
  const same = box({ ...HEALTHY, containers: [ctr(CID, 'cloudflare/cloudflared:latest', DOCKER_ARGS)] });
  const rs = same.run(['--from-docker', '--non-interactive']);
  ok(rs.status === 0 && same.token() === TOKEN && rs.lines.includes(`docker rm -f ${CID}`), 'a container of the same tunnel is a second connector: retired, with nothing to decide');
  const fileRun = box({ ...HEALTHY, containers: [ctr(CID, 'cloudflare/cloudflared:latest', DOCKER_ARGS)] });
  const rf = fileRun.run(['--non-interactive']);
  ok(rf.status === 0 && /a cloudflared container with this tunnel's token still runs here \(c0ffee000000\)/.test(rf.stderr), 'a run from the token file names a container of the same tunnel');
  const otherOnly = box({ ...HEALTHY, containers: [ctr(CID, 'cloudflare/cloudflared:latest', ['tunnel', 'run', '--token', OTHER])] });
  ok(!/still runs here/.test(otherOnly.run(['--non-interactive']).stderr), 'but not another tunnel\'s, which is none of its business');
}

console.log('=== a service that never registers: nothing is retired, nothing recorded ===');
{
  const b = box({ containers: [ctr(CID, 'cloudflare/cloudflared:latest', DOCKER_ARGS)], register: false });
  const r = b.run(['--from-docker']);
  ok(r.status === 1 && /registered no tunnel connection/.test(r.stderr) && /journalctl -u cloudflared/.test(r.stderr),
    `exit 1, with where to look (${r.stderr.trim().split('\n').pop()})`);
  ok(!r.lines.some((l) => /^docker rm/.test(l)) && /containers were left/.test(r.stderr), 'the container, the only connector that ran, is kept');
  ok(!/CLOUDFLARE_TUNNEL_TOKEN/.test(b.envText()), 'and a token that registered nothing is not put in the backup');
  ok(!leaks(r), 'and the token is still printed nowhere');
}

console.log('=== a rebuilt box: --from-env ===');
{
  const b = box({ env: `MASTER_KEY=k\nCLOUDFLARE_TUNNEL_TOKEN=${TOKEN}\nBACKUP_PASSPHRASE=p\n` });
  const before = b.envText();
  const r = b.run(['--from-env', '--non-interactive']);
  ok(r.status === 0, `exits 0${r.status ? `: ${r.out.slice(-600)}` : ''}`);
  ok(b.token() === TOKEN, 'the token file is written from .env');
  ok(b.envText() === before && /already holds this token/.test(r.stdout), '.env is left exactly as it was');
  ok(r.lines.filter((l) => /^sudo /.test(l)).every((l) => /^sudo -n /.test(l)), '--non-interactive: every sudo is sudo -n');
  ok(!leaks(r), 'and the token is in no output and no argument list');
  ok(!b.exposed() && !/Rotate token/.test(r.out), 'a token from .env was on no command line: no rotation asked for');
  const noKey = box();
  const r2 = noKey.run(['--from-env']);
  ok(r2.status === 1 && /has no CLOUDFLARE_TUNNEL_TOKEN/.test(r2.stderr) && !fs.existsSync(noKey.tokenPath), 'no key in .env: exit 1, nothing written');
  const quoted = box({ env: `CLOUDFLARE_TUNNEL_TOKEN="${TOKEN}"\n` });
  ok(quoted.run(['--from-env']).status === 0 && quoted.token() === TOKEN, 'a quoted value is read as dotenv reads it');
  const fileDiffers = box({ tokenFile: OTHER, env: `CLOUDFLARE_TUNNEL_TOKEN=${TOKEN}\n` });
  const rd = fileDiffers.run(['--from-env', '--non-interactive']);
  ok(rd.status === 1 && /\.env's token is not the one in \/etc\/cloudflared\/tunnel-token/.test(rd.stderr) && fileDiffers.token() === OTHER,
    'a token file holding another token is not overwritten from .env without --replace');
}

console.log('=== --record-env: the token the service uses, into .env ===');
{
  const b = box({ tokenFile: TOKEN, unit: 'x', active: 'active', enabled: 'enabled' });
  const r = b.run(['--record-env']);
  ok(r.status === 0 && b.envText().endsWith(`CLOUDFLARE_TUNNEL_TOKEN=${TOKEN}\n`) && /recorded the token in \.env/.test(r.stdout),
    'recorded, at the end of .env');
  ok(!r.lines.some((l) => /^(systemctl (restart|enable|daemon-reload)|apt-get|sudo (-n )?tee )/.test(l)), 'and nothing else is touched: no restart, no unit, no package');
  const again = b.run(['--record-env']);
  ok(again.status === 0 && /already holds this token/.test(again.stdout) && envTokens(b.envText()).length === 1, 'run again: unchanged, still one line');
  const staleText = `MASTER_KEY=k\n  export CLOUDFLARE_TUNNEL_TOKEN = ${OTHER}\nBACKUP_PASSPHRASE=p\n`;
  const stale = box({ tokenFile: TOKEN, env: staleText });
  const kept = stale.run(['--record-env']);
  ok(kept.status === 1 && stale.envText() === staleText && /DIFFERENT CLOUDFLARE_TUNNEL_TOKEN[\s\S]*--record-env --replace/.test(kept.stderr),
    'a different token in .env is left as it was without --replace, and it says how');
  const r2 = stale.run(['--record-env', '--replace']);
  ok(r2.status === 0 && stale.envText() === `MASTER_KEY=k\nCLOUDFLARE_TUNNEL_TOKEN=${TOKEN}\nBACKUP_PASSPHRASE=p\n` && /replaced the different token/.test(r2.stdout),
    'with --replace it is replaced in its own place, not appended as a second line');
  ok(!leaks(kept) && !leaks(r2), 'naming neither');
  const noEnv = box({ tokenFile: TOKEN, env: null });
  const r3 = noEnv.run(['--record-env']);
  ok(r3.status === 1 && /no \.env/.test(r3.stderr) && noEnv.envText() === null, 'no .env: exit 1, and no .env is made (it would block the restore)');
  const noFile = box();
  ok(noFile.run(['--record-env']).status === 1, 'no token file: nothing to record, exit 1');
}

console.log('=== Cloudflare\'s own service install: --from-unit ===');
{
  const b = box({ unit: CF_UNIT, active: 'active', enabled: 'enabled', updateTimer: true });
  const r = b.run(['--from-unit']);
  ok(r.status === 0, `exits 0${r.status ? `: ${r.out.slice(-600)}` : ''}`);
  ok(b.token() === TOKEN && !b.file('etc/systemd/system/cloudflared.service').includes(TOKEN),
    'the token moves from the world-readable unit into the root-only file');
  ok(r.lines.some((l) => /^systemctl disable --now --quiet cloudflared-update\.timer$/.test(l)), 'and the timer that replaced the binary in place is off');
  ok(!leaks(r) && b.envText().includes(`CLOUDFLARE_TUNNEL_TOKEN=${TOKEN}`), 'printed nowhere, recorded in .env');
  ok(b.exposed() && /Rotate token/.test(r.stderr), '`sudo cloudflared service install <token>` is in sudo\'s log too: rotate it');

  // Review, 2026-09-30: the token read out of a drop-in stayed in it,
  // world-readable, and a drop-in's ExecStart= went on overriding the unit's.
  const d = box({ unit: OUR_UNIT, active: 'active', enabled: 'enabled', dropins: {
    'token.conf': `[Service]\nEnvironment=TUNNEL_TOKEN=${TOKEN} TUNNEL_METRICS=localhost:2000\n`,
    'override.conf': `# by hand\n[Service]\nExecStart=\nExecStart=/usr/bin/cloudflared --no-autoupdate tunnel run --token ${TOKEN}\n`,
  } });
  const rd = d.run(['--from-unit']);
  const dropDir = path.join(d.root, 'etc/systemd/system/cloudflared.service.d');
  const left = fs.existsSync(dropDir) ? fs.readdirSync(dropDir).map((f) => fs.readFileSync(path.join(dropDir, f), 'utf8')).join('\n') : '';
  ok(rd.status === 0 && d.token() === TOKEN, `a drop-in's token is adopted${rd.status ? `: ${rd.out.slice(-400)}` : ''}`);
  ok(!left.includes(TOKEN) && !/ExecStart=/.test(left), 'and no drop-in keeps it, or an ExecStart= of its own');
  ok(/Environment=TUNNEL_METRICS=localhost:2000/.test(left) && !fs.existsSync(path.join(dropDir, 'override.conf')),
    'what else a drop-in set is kept; one that only carried the token is removed');
  const cleanedAt = at(rd.lines, /^(sudo (-n )?)?(tee|rm -f) \S+cloudflared\.service\.d\//);
  ok(cleanedAt >= 0 && cleanedAt < at(rd.lines, /^systemctl daemon-reload$/), 'before the daemon-reload and restart, so the new ExecStart is the one that runs');
  ok(/^unit: reads the token from \/etc\/cloudflared\/tunnel-token$/m.test(d.run(['--status']).stdout), '--status then says it reads the token from the file');
  ok(!leaks(rd), 'the token printed nowhere');
}

console.log('=== a new token: --new-token ===');
{
  // Review, 2026-09-30: the token file, then .env, always won over what a
  // person handed over, so a rotated token could not be installed at all.
  const b = box({ ...HEALTHY, exposed: true });
  const r = b.run(['--new-token'], { input: `${ROTATED}\n` });
  ok(r.status === 0 && b.token() === ROTATED, `the token piped in replaces the one in the file${r.status ? `: ${r.out.slice(-400)}` : ''}`);
  ok(envTokens(b.envText()).length === 1 && b.envText().includes(`CLOUDFLARE_TUNNEL_TOKEN=${ROTATED}`) && /replaced the different token/.test(r.stdout),
    'and in .env: a person handed it over');
  ok(!b.exposed() && /the note that the old one was on a command line is gone/.test(r.stdout), 'a rotated token is no longer the exposed one');
  ok(!leaks(r), 'printed nowhere');
  const pasted = box({ ...HEALTHY });
  ok(pasted.run(['--new-token'], { input: `sudo cloudflared service install ${ROTATED}\n` }).status === 0 && pasted.token() === ROTATED,
    'the dashboard\'s whole install command will do');
  const sameAgain = box({ ...HEALTHY, exposed: true });
  sameAgain.run(['--new-token'], { input: `${TOKEN}\n` });
  ok(sameAgain.exposed(), 'the same token handed over again is still the exposed one');
  const nothing = box({ ...HEALTHY });
  const rn = nothing.run(['--new-token', '--non-interactive'], { input: '' });
  ok(rn.status === 1 && /no token on stdin/.test(rn.stderr) && nothing.token() === TOKEN && !rn.lines.some((l) => /^systemctl restart/.test(l)),
    'nothing piped in and --non-interactive: exit 1, the old token kept, nothing restarted');
}

console.log('=== a token pasted, piped or refused ===');
{
  const b = box({ env: null });
  const r = b.run([], { input: `sudo cloudflared service install ${TOKEN}\n` });
  ok(r.status === 0 && b.token() === TOKEN, 'the dashboard\'s whole install command pasted in: the token is taken out of it');
  ok(/no \.env at .*not recorded/.test(r.stderr) && b.envText() === null, 'with no .env it says the token is not recorded, and makes none');
  const d = box();
  const rd = d.run([], { input: `docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token ${TOKEN}\n` });
  ok(rd.status === 0 && d.token() === TOKEN, 'and so is the dashboard\'s docker command, which is then not run');
  const bad = box();
  const rb = bad.run([], { input: 'eyJhIjoibm90IGEgdG9rZW4ifQ-not-really-a-tunnel-token-at-all\n' });
  ok(rb.status === 1 && /not a Cloudflare tunnel token/.test(rb.stderr) && !fs.existsSync(bad.tokenPath)
    && !rb.lines.some((l) => /^systemctl restart/.test(l)), 'something that is not a tunnel token: refused before anything is written or restarted');
  const empty = box();
  const re = empty.run(['--non-interactive'], { input: '' });
  ok(re.status === 1 && /no token/.test(re.stderr) && !re.lines.some((l) => /^systemctl restart/.test(l)),
    'no token anywhere and nothing piped in: exit 1, never a prompt');
  const kept = box({ tokenFile: TOKEN, unit: 'x' });
  const rk = kept.run(['--non-interactive']);
  ok(rk.status === 0 && /using the token already in \/etc\/cloudflared\/tunnel-token/.test(rk.stdout) && kept.envText().includes(`CLOUDFLARE_TUNNEL_TOKEN=${TOKEN}`),
    'with no source named, the token already in the file is used again - and recorded in .env');
  ok(!rk.lines.some((l) => /^sudo (-n )?install -m 0600 .*tunnel-token/.test(l)), 'without rewriting the file');
  const envOther = box({ tokenFile: TOKEN, unit: 'x', env: `CLOUDFLARE_TUNNEL_TOKEN=${OTHER}\n` });
  const ro = envOther.run(['--non-interactive']);
  ok(ro.status === 0 && envOther.envText() === `CLOUDFLARE_TUNNEL_TOKEN=${OTHER}\n` && /DIFFERENT CLOUDFLARE_TUNNEL_TOKEN/.test(ro.stderr),
    'the service restarted from its file, while a different token in .env is left for a person');
}

console.log('=== the token file and its directory ===');
{
  // Review, 2026-09-30: a token file written by hand (`echo ... | sudo tee`,
  // 0644) was reused as it was, and `install -d -m 0755` opened a tighter
  // /etc/cloudflared back up.
  const loose = box({ tokenFile: TOKEN, tokenMode: 0o644, unit: OUR_UNIT, active: 'active', enabled: 'enabled', env: `CLOUDFLARE_TUNNEL_TOKEN=${TOKEN}\n` });
  ok(/^token file: \/etc\/cloudflared\/tunnel-token, mode 644: readable beyond root/m.test(loose.run(['--status']).stdout), '--status says a token file anybody can read');
  const r = loose.run(['--non-interactive']);
  ok(r.status === 0 && loose.mode(loose.tokenPath) === 0o600 && r.lines.some((l) => /chmod 0600 \S+tunnel-token$/.test(l)), 'and reusing it makes it 600');
  const tight = box({ etcMode: 0o700, env: `CLOUDFLARE_TUNNEL_TOKEN=${TOKEN}\n` });
  const rt = tight.run(['--from-env']);
  ok(rt.status === 0 && tight.mode(path.join(tight.root, 'etc/cloudflared')) === 0o700 && !rt.lines.some((l) => /install -d/.test(l)),
    'an /etc/cloudflared that is there keeps its mode');
  const fresh = box({ env: `CLOUDFLARE_TUNNEL_TOKEN=${TOKEN}\n` });
  fresh.run(['--from-env']);
  ok(fresh.mode(path.join(fresh.root, 'etc/cloudflared')) === 0o755, 'one that is not is made 0755, so the routines check can see the file is there');
}

console.log('=== a masked unit ===');
{
  const b = box({ enabled: 'masked', env: `CLOUDFLARE_TUNNEL_TOKEN=${TOKEN}\n` });
  const r = b.run(['--from-env', '--non-interactive']);
  ok(r.status === 1 && /masked here[\s\S]*sudo systemctl unmask cloudflared/.test(r.stderr), 'refused, with the command that undoes the mask');
  ok(!fs.existsSync(b.tokenPath) && !r.lines.some((l) => /^(sudo (-n )?tee|systemctl (enable|restart|daemon-reload))/.test(l)), 'before anything is written or enabled');
  ok(/^service: masked, so it cannot start/m.test(b.run(['--status']).stdout), '--status says it is masked');
}

console.log('=== no cloudflared yet: from Cloudflare\'s apt repository ===');
{
  const b = box({ cloudflared: false, env: `CLOUDFLARE_TUNNEL_TOKEN=${TOKEN}\n` });
  const r = b.run(['--from-env']);
  ok(r.status === 0 && r.lines.some((l) => /apt-get .*install -y -qq cloudflared/.test(l)), `apt-get installs it${r.status ? `: ${r.out.slice(-400)}` : ''}`);
  ok((b.file('etc/apt/sources.list.d/cloudflared.list') ?? '').trim() === 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main'
    && /PGP PUBLIC KEY/.test(b.file('usr/share/keyrings/cloudflare-main.gpg') ?? ''), 'from pkg.cloudflare.com, signed by its key');
  ok(r.lines.some((l) => /DPkg::Lock::Timeout=600/.test(l)), 'waiting for the lock a first boot\'s apt jobs hold');
}

console.log('=== --status ===');
{
  // The bug the first version had: `systemctl is-enabled` prints
  // "not-found" and exits non-zero, so its `|| echo 'no unit'` printed both.
  const none = box({ env: null, cloudflared: false });
  const r = none.run(['--status']);
  const lines = r.stdout.trim().split('\n');
  ok(r.status === 0 && lines.includes('service: no unit') && !lines.includes('no unit') && !lines.some((l) => /not-found/.test(l)),
    `no unit: one line, "service: no unit" (${lines.join(' | ')})`);
  ok(lines[0] === 'cloudflared: not installed' && lines.includes('token file: none'), 'and says what is not there');
  ok(lines.includes('containers: no cloudflared container'), 'docker answering with no cloudflared container is said, not left as silence');
  ok(!r.lines.some((l) => /^(systemctl (restart|enable|daemon-reload)|docker rm|sudo (-n )?(install -m|tee )|chmod|chown)/.test(l)), 'it changes nothing');

  const g = box(HEALTHY).run(['--status']).stdout;
  ok(/^service: active, enabled$/m.test(g) && /^unit: reads the token from \/etc\/cloudflared\/tunnel-token$/m.test(g)
    && /^token file: \/etc\/cloudflared\/tunnel-token$/m.test(g) && /^\.env: CLOUDFLARE_TUNNEL_TOKEN, the same token as the token file$/m.test(g),
  'in place: active, enabled, the token file, and the same token in .env');
  const diff = box({ ...HEALTHY, env: `CLOUDFLARE_TUNNEL_TOKEN=${OTHER}\n` });
  ok(/DIFFERENT token[\s\S]*--record-env --replace/.test(diff.run(['--status']).stdout), 'a different token in .env is said');
  const inline = box({ unit: CF_UNIT, active: 'active', enabled: 'enabled', tokenFile: TOKEN,
    containers: [ctr(CID, 'cloudflare/cloudflared:latest', DOCKER_ARGS), ctr(DNS, 'crazymax/cloudflared', ['proxy-dns']),
      ctr(OLD, 'cloudflare/cloudflared', ['tunnel', 'run', '--token', OTHER], [], { state: 'exited', restart: 'always' })] });
  const ri = inline.run(['--status']);
  ok(/^unit: carries the token on its command line/m.test(ri.stdout) && /no CLOUDFLARE_TUNNEL_TOKEN/.test(ri.stdout), 'Cloudflare\'s own unit is named');
  ok(/^container c0ffee000000: running, default network, restart=no, this box's tunnel \(the token file's token\)$/m.test(ri.stdout)
    && /^container d0d022222222: running, default network, restart=no, no tunnel token/m.test(ri.stdout)
    && /^container a1d044444444: exited, default network, restart=always, another tunnel's token$/m.test(ri.stdout),
  'and each container: whose tunnel it is, or that it is none');
  ok(!leaks(ri), 'and the token, in both of them, is printed by neither');
  const exposed = box({ ...HEALTHY, exposed: true }).run(['--status']).stdout;
  ok(/^token: taken from a container's command line on 2026-09-30 14:01 UTC: rotate it in the dashboard, then --new-token$/m.test(exposed), 'an adopted token not yet rotated is said');

  // Review, 2026-09-30: with sudo refused (no terminal, no password) it said
  // "runs from a config file", "token file: none" and no container at all.
  const blind = box({ ...HEALTHY, tokenMode: 0o000, sudoFails: true, dockerNeedsRoot: true, containers: [ctr(CID, 'cloudflare/cloudflared:latest', DOCKER_ARGS)] });
  const rb = blind.run(['--status']);
  ok(rb.status === 0 && /^unit: reads the token from \/etc\/cloudflared\/tunnel-token$/m.test(rb.stdout), `sudo refused: the world-readable unit is still read (${rb.stdout.trim().split('\n').join(' | ')})`);
  ok(/^token file: \/etc\/cloudflared\/tunnel-token$/m.test(rb.stdout) && /^\.env: CLOUDFLARE_TUNNEL_TOKEN \(not compared with the token file: reading it needs sudo/m.test(rb.stdout),
    'the token file is seen without being read, and what could not be compared is said');
  ok(/^containers: unknown \(docker ps needs sudo/m.test(rb.stdout), 'and "unknown" for the containers, never "none"');
  fs.chmodSync(blind.tokenPath, 0o600);
}

console.log('=== tools/bootstrap.sh restores it, and the docs say how ===');
{
  const boot = read('tools/bootstrap.sh');
  const sec = /# routine: cloudflare-tunnel\n([\s\S]*?)\n# -{20,}/.exec(boot)?.[1] ?? '';
  ok(sec.length > 0, 'bootstrap has a step marked "# routine: cloudflare-tunnel"');
  ok(/CLOUDFLARED="\$DEPLOY\/install-cloudflared\.sh"/.test(sec) && /run bash "\$CLOUDFLARED" --from-env/.test(sec)
    && /\(\( ! STARTED \)\)/.test(sec) && /CLOUDFLARE_TUNNEL_TOKEN/.test(sec),
    'it runs --from-env, only on the box that now runs the bot, and only with the token in .env');
  ok(!/\bask\b|read -r/.test(sec), 'and asks nothing: every question comes first');
  // Review, 2026-09-30: a running cloudflared.service was ticked off as done
  // before STARTED was looked at, so a clone or standby's replica was hidden.
  const notHere = sec.indexOf('elif (( ! STARTED ))');
  ok(notHere >= 0 && notHere < sec.indexOf('elif [[ $CF_ACTIVE == active ]]') && /\(\( ! STARTED \)\)[\s\S]*?CF_ACTIVE == active[\s\S]*?todo "sudo systemctl disable --now cloudflared/.test(sec),
    'whether the bot runs here is decided before a running cloudflared is counted as done - and where it does not, a running one is to stop');
  ok(/On the OLD machine[\s\S]*sudo systemctl disable --now cloudflared/.test(boot), 'the checklist says to stop cloudflared on the old machine');
  const setup = read('docs/server-setup.md');
  const s7 = /## 7\. Reaching the panel from outside([\s\S]*?)\n## 8\./.exec(setup)?.[1] ?? '';
  ok(/deploy\/install-cloudflared\.sh/.test(s7) && /docker run/.test(s7) && /\[::1\]:8080/.test(s7),
    'section 7 makes the script the way, and says why not the dashboard\'s docker run');
  ok(/Rotate token/.test(s7) && /--new-token/.test(s7), 'and how to rotate a token that was on a command line');
  ok(!/sudo cloudflared service install <THE_LONG_TOKEN>/.test(setup), 'and no longer says to run Cloudflare\'s service install with the token');
  ok(!/The Cloudflare tunnel is the one piece set up by hand/.test(read('CLAUDE.md')), 'CLAUDE.md no longer calls the tunnel the one piece set up by hand');
  const ops = read('docs/operations.md');
  ok(/systemctl disable --now cloudflared/.test(ops), 'the hand-over stops cloudflared on the old box');
  // Review, 2026-09-30: a box that set its tunnel up before .env carried the
  // token (bot-box2) would hand over a backup without it.
  const handover = /## Handing the bot over to another machine([\s\S]*?)\n## /.exec(ops)?.[1] ?? '';
  ok(/install-cloudflared\.sh --record-env[\s\S]*backup-secrets\.mjs/.test(handover)
    && /--record-env[\s\S]*disable --now cloudflared/.test(handover.slice(handover.indexOf('On the machine giving it up'))),
    'and records the token in .env before the last backup, and before it stops cloudflared');
  ok(/install-cloudflared\.sh --record-env[\s\S]{0,400}backup-secrets\.mjs/.test(/```bash\n[^`]*disable --now whatsapp-bot[^`]*```/.exec(setup)?.[0] ?? ''),
    'so does the fast path\'s hand-over block');

  // A dry run, with every command that could change the machine a stub that
  // fails, as in sealed-backup.test.mjs: the step is there, in its place.
  const stubs = path.join(T, 'boot-stubs');
  const calls = path.join(T, 'boot-calls.log');
  for (const c of ['sudo', 'apt-get', 'curl', 'crontab', 'npm', 'visudo', 'ethtool', 'tailscale', 'gh', 'systemctl', 'snap', 'docker', 'journalctl']) {
    put(path.join(stubs, c), `#!/bin/sh\necho "${c} $*" >> '${calls}'\ncase "${c} $1 $2" in\n  "gh auth status") exit 0 ;;\n  "systemctl is-enabled "*) echo disabled; exit 1 ;;\n  "systemctl show "*) echo inactive; exit 0 ;;\nesac\nexit 1\n`, 0o755);
  }
  const home = fs.mkdtempSync(path.join(T, 'home-'));
  const dry = spawnSync('bash', [path.join(REPO, 'tools/bootstrap.sh'), '--dry-run'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], detached: true, timeout: 120_000,
    env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, HOME: home, INSTALL_UNITS_ROOT: fs.mkdtempSync(path.join(T, 'root-')) },
  });
  ok(dry.status === 0, `bootstrap --dry-run exits 0${dry.status ? `: ${dry.stderr.slice(-400)}` : ''}`);
  ok(/The hourly check \(cron[\s\S]*The Cloudflare tunnel to the panel\n[\s\S]*\+ bash \S+\/deploy\/install-cloudflared\.sh --from-env\n[\s\S]*LAN address/.test(dry.stdout),
    'and says it would run --from-env, after the hourly check and before the LAN address');
  ok(/On the OLD machine[\s\S]*sudo systemctl disable --now cloudflared/.test(dry.stdout), 'with cloudflared to stop on the old machine');
  const log = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
  ok(!/^(sudo|apt-get|curl|docker|journalctl) /m.test(log) && !/^systemctl (start|enable|restart)/m.test(log), 'and ran none of it');
}

fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
