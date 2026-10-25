/* The sealed settings backup and the one-command rebuild.
   Run: node test/sealed-backup.test.mjs

   Every rebuild of this bot's Ubuntu box meant retyping every API key,
   re-linking the number from a phone, and redoing the machine by hand from
   memory - on 2026-09-22 alone: the installed unit's ExecStart pointed at
   /usr/local/bin/node, which does not exist on a NodeSource box (203/EXEC);
   the installer had left / at 14.5 GB of a 28.9 GB disk; and TCP segmentation
   offload on the Hyper-V NIC was dropping 29% of uploaded segments. The
   sealed-backup branch keeps all of it so the next box is one script and one
   passphrase.

   The assertions that matter most are the negative ones. Commit c4a0fe7 set
   the policy that nothing secret enters git in plaintext, and git history is
   permanent: so the gh token and ~/.claude.json must never be bundled even
   when present, and no sentinel secret from .env, config.json, the session or
   hosts.yml may appear anywhere in the remote repository or a commit message.
   The branch must stay at exactly one commit, and a push that races this one
   must never be overwritten. No network: the "GitHub" here is a bare repo in
   a temp directory, and the crontab is a fake.

   The second half pins what a review of the first version found on
   2026-09-22: bootstrap.sh enabled the unit at boot before asking whether the
   old machine was stopped, and ran --take-over on a box that had kept its own
   .env (replacing another bot's only backup); a backup taken while the old
   bot ran was restored without a word; Ctrl-C left the plaintext staging copy
   in $TMPDIR; the home bundle restored as the app bundle put ~/.ssh keys in
   the git working tree; ./-prefixed names slipped past HOME_NEVER; escaped
   names were silently skipped; authorized_keys was replaced by an empty one;
   grow-root-disk died on LVM-on-LUKS. bootstrap.sh is run for real here, with
   every command that could change the machine replaced by a stub, and the
   stubs checked before it runs.

   The last part pins the one paste (2026-09-29: "one script I can copy and
   paste into the ssh and all steps will be done at once"), as built on
   bot-box2 and then reviewed: every answer from the environment with nobody
   at a terminal, OLD_BOT_STOPPED=yes being the rule-3 gate; the paste's
   PASSWORDLESS_SUDO=yes re-widening sudo a box had narrowed; the installer's
   featured snaps, SABnzbd on 8080 among them, which left the bot stopped and
   disabled after the paste; a box with no git identity; the hourly check's
   token lost to a run that died after it was pasted, or asked for a second
   time twenty minutes into the part that runs by itself; and the LAN
   address, in each of its four answers. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-test-'));

// Hermetic git: never the real ~/.gitconfig (it holds the gh credential
// helper), never a real crontab, never an inherited passphrase.
fs.writeFileSync(path.join(T, 'gitconfig'), '');
process.env.GIT_CONFIG_GLOBAL = path.join(T, 'gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
delete process.env.BACKUP_PASSPHRASE;
const CRONTAB_FILE = path.join(T, 'crontab.txt');
const FAKE_CRONTAB = path.join(T, 'fake-crontab');
fs.writeFileSync(FAKE_CRONTAB, `#!/bin/sh
case "$1" in
  -l) [ -f '${CRONTAB_FILE}' ] || { echo "no crontab for tester" >&2; exit 1; }; cat '${CRONTAB_FILE}' ;;
  -) cat > '${CRONTAB_FILE}' ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
process.env.SEALED_BACKUP_CRONTAB = FAKE_CRONTAB;
// And never the real systemd: a machine taking the branch over asks it
// whether the bot runs here. This one has no whatsapp-bot unit at all.
const FAKE_SYSTEMCTL = path.join(T, 'fake-systemctl');
fs.writeFileSync(FAKE_SYSTEMCTL, '#!/bin/sh\n[ "$1" = show ] && echo LoadState=not-found && echo ActiveState=inactive\nexit 0\n', { mode: 0o755 });
process.env.SEALED_BACKUP_SYSTEMCTL = FAKE_SYSTEMCTL;

const {
  runSealedBackup, snapshotApp, snapshotHome, homeBundlePaths, assertHomePathsAllowed, isForbiddenHomePath,
  restoreHomeBundle, restoreAppBundle, writeEnvPassphrase, readEnvPassphrase, resolvePassphrase, cronLine, installCron,
  removeCron, listTar, canonicalMember, botProcessRunning, describeSealedBackup, BRANCH, CRON_TAG,
} = await import('../src/core/sealed-backup.js');
const {
  APP_BUNDLE_PATHS, appBundlePaths, snapshotBundle, openSecrets, sealSecrets, writeSecretsBundle, sweepStaleStaging,
} = await import('../src/core/activity-backup.js');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const rejects = async (fn, re) => {
  try { await fn(); return false; } catch (err) { return re.test(err.message) ? true : (console.log(`    (got: ${err.message})`), false); }
};

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (file, data, mode) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  if (mode) fs.chmodSync(file, mode);
};
/** Every file under root, relative path -> Buffer. */
function walk(root, rel = '') {
  const out = {};
  const abs = path.join(root, rel);
  const st = fs.lstatSync(abs);
  if (st.isDirectory()) {
    for (const n of fs.readdirSync(abs)) Object.assign(out, walk(root, path.join(rel, n)));
  } else {
    out[rel] = fs.readFileSync(abs);
  }
  return out;
}

const PASSPHRASE = 'SENTINEL-PASSPHRASE correct horse #battery';
const SENTINELS = {
  masterKey: 'SENTINEL-MASTER-KEY-7f3a9c0e',
  omdb: 'SENTINEL-OMDB-KEY-51d2e8aa',
  noise: 'SENTINEL-NOISE-KEY-44aa19',
  ghToken: 'SENTINEL-GH-TOKEN-gho_a1b2c3',
  claudeJson: 'SENTINEL-CLAUDE-JSON-9e8d7c',
  sshKey: 'SENTINEL-SSH-PRIVATE-KEY-0b1c',
  transcript: 'SENTINEL-TRANSCRIPT-5f5f',
  // The YouTube login yt-dlp signs in with (media/yt-dlp-cookies.js).
  ytCookie: 'SENTINEL-YT-SAPISID-c00k1e',
  passphrase: PASSPHRASE,
};

/* ------------------------------------------------ the fake world ------ */

// "GitHub": a bare repo with main and an activity-backups branch that must
// never be touched.
const remote = path.join(T, 'remote.git');
git(['init', '-q', '--bare', '-b', 'main', remote]);
const seed = path.join(T, 'seed');
git(['init', '-q', '-b', 'main', seed]);
fs.copyFileSync(path.join(REPO, '.gitignore'), path.join(seed, '.gitignore'));
put(path.join(seed, 'README.md'), '# bot\n');
put(path.join(seed, 'certs/README.txt'), 'drop CA certs here\n');
git(['add', '-A'], seed);
git(['-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', 'commit', '-q', '-m', 'seed'], seed);
git(['push', '-q', remote, 'main'], seed);
git(['push', '-q', remote, 'main:activity-backups'], seed);
const mainSha = git(['rev-parse', 'main'], remote);
const activitySha = git(['rev-parse', 'activity-backups'], remote);

// The live app checkout.
const app = path.join(T, 'app');
git(['clone', '-q', remote, app]);
git(['config', 'user.name', 'Test Owner'], app);
git(['config', 'user.email', 'owner@example.test'], app);
put(path.join(app, '.env'), `MASTER_KEY=${SENTINELS.masterKey}\nBACKUP_PASSPHRASE='${PASSPHRASE}'\n`, 0o600);
put(path.join(app, 'data/config.json'), JSON.stringify({ omdb: { apiKey: SENTINELS.omdb } }), 0o600);
put(path.join(app, 'data/session/creds.json'), JSON.stringify({ noiseKey: SENTINELS.noise }));
put(path.join(app, 'data/session/pre-key-1.json'), '{"k":1}');
put(path.join(app, 'data/sessions/acct2/creds.json'), '{"x":2}');
put(path.join(app, 'data/state.json'), '{"history":[1]}');
put(path.join(app, 'data/outbound-budget.json'), '{"sent":3}');
put(path.join(app, 'data/backups/original-descriptions.json'), '{"g":"desc"}');
// Copied in by hand at 0644: the restore must still leave it 0600.
put(path.join(app, 'data/yt-dlp-cookies.txt'), `# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1893456000\tSAPISID\t${SENTINELS.ytCookie}\n`, 0o644);
put(path.join(app, 'certs/filter.crt'), '-----BEGIN CERTIFICATE-----\nMIIfake\n-----END CERTIFICATE-----\n');
// Things that must stay out.
put(path.join(app, 'data/sessions.json'), '{"web":"login"}');
put(path.join(app, 'data/logs/debug-2026-09-22.log'), 'log\n');
put(path.join(app, 'data/media/film.mp4'), 'binary');
put(path.join(app, 'data/activity-backup/records/x.json'), '{}');
put(path.join(app, 'data/bot-cmd.json'), '{}');
const appHead = git(['rev-parse', 'HEAD'], app);

// The user's home.
const home = path.join(T, 'home');
put(path.join(home, '.claude/settings.json'), '{"theme":"dark"}');
put(path.join(home, '.claude/CLAUDE.md'), '# my rules\n');
put(path.join(home, '.claude/keybindings.json'), '[]');
put(path.join(home, '.claude/agents/reviewer.md'), 'agent\n');
put(path.join(home, '.claude/commands/deploy.md'), 'cmd\n');
put(path.join(home, '.claude/skills/x/SKILL.md'), 'skill\n');
put(path.join(home, '.claude/projects/-/memory/MEMORY.md'), '- index\n');
put(path.join(home, '.claude/projects/-/memory/note.md'), 'a memory\n');
put(path.join(home, '.claude/projects/-home-u-bot/memory/MEMORY.md'), '- other\n');
put(path.join(home, '.claude/projects/-/abc123.jsonl'), `{"text":"${SENTINELS.transcript}"}\n`);
for (const d of ['sessions', 'cache', 'shell-snapshots', 'backups', 'session-env', 'remote']) {
  put(path.join(home, `.claude/${d}/x`), 'machine-local\n');
}
put(path.join(home, '.claude.json'), JSON.stringify({ userID: SENTINELS.claudeJson }), 0o600);
put(path.join(home, '.config/gh/hosts.yml'), `github.com:\n  oauth_token: ${SENTINELS.ghToken}\n`, 0o600);
put(path.join(home, '.config/other/thing'), 'x');
put(path.join(home, '.gitconfig'), '[credential "https://github.com"]\n\thelper = !gh auth git-credential\n');
put(path.join(home, '.ssh/id_ed25519'), `${SENTINELS.sshKey}\n`, 0o600);
put(path.join(home, '.ssh/config'), 'Host *\n');
fs.chmodSync(path.join(home, '.ssh'), 0o700);
put(path.join(home, '.bashrc'), 'not allowlisted\n');

const NOW = Date.UTC(2026, 8, 22, 5, 17);
const base = { appRoot: app, homeDir: home, passphrase: PASSPHRASE, now: NOW, machine: 'machine-A' };

/* ----------------------------------------------------------- tests ---- */

console.log('=== the app bundle carries exactly the allowlist ===');
{
  for (const p of ['.env', 'data/config.json', 'data/session', 'data/sessions', 'data/state.json',
    'data/outbound-budget.json', 'data/backups', 'data/yt-dlp-cookies.txt']) {
    ok(APP_BUNDLE_PATHS.includes(p), `${p} is on the shared list`);
  }
  const paths = appBundlePaths(app);
  ok(paths.includes('certs/filter.crt'), 'a filter CA in certs/ is expanded in JS and included');
  ok(!paths.includes('certs/README.txt'), 'but not the README that is already in git');

  const snap = await snapshotApp(app);
  const names = await listTar(snap.tar);
  for (const f of ['.env', 'data/config.json', 'data/session/creds.json', 'data/session/pre-key-1.json',
    'data/sessions/acct2/creds.json', 'data/state.json', 'data/outbound-budget.json',
    'data/backups/original-descriptions.json', 'data/yt-dlp-cookies.txt', 'certs/filter.crt']) {
    ok(names.includes(f), `bundled: ${f}`);
  }
  for (const f of ['data/sessions.json', 'data/logs', 'data/media', 'data/activity-backup', 'data/bot-cmd.json', 'data/sealed-backup']) {
    ok(!names.some((n) => n === f || n.startsWith(`${f}/`)), `left out: ${f}`);
  }
  const again = await snapshotApp(app);
  ok(again.digest === snap.digest, 'the content digest is stable when nothing changed (not a tar-bytes hash)');
}

console.log('=== a torn JSON read is retried, and one that stays torn fails loudly ===');
{
  // Baileys writes data/session/*.json in place; a copy taken mid-write is
  // truncated, and a backup of a truncated creds.json restores a dead session.
  const tmpParent = fs.mkdtempSync(path.join(T, 'staging-'));
  let torn = 0;
  const flaky = (src, dst) => {
    if (src.endsWith('state.json') && torn < 2) { torn++; fs.writeFileSync(dst, '{"hist'); return; }
    fs.copyFileSync(src, dst);
  };
  const snap = await snapshotBundle(app, ['data/state.json', 'data/config.json'], { copyFile: flaky, retryDelayMs: 1, tmpParent });
  ok(torn === 2, 'the torn copy was read twice');
  const out = fs.mkdtempSync(path.join(T, 'x-'));
  execFileSync('tar', ['-xzf', '-', '-C', out], { input: snap.tar });
  ok(fs.readFileSync(path.join(out, 'data/state.json'), 'utf8') === '{"history":[1]}', 'and the whole file is what got bundled');

  const alwaysTorn = (src, dst) => {
    if (src.endsWith('state.json')) fs.writeFileSync(dst, '{"hist'); else fs.copyFileSync(src, dst);
  };
  ok(await rejects(() => snapshotBundle(app, ['data/state.json'], { copyFile: alwaysTorn, retryDelayMs: 1, tmpParent }),
    /data\/state\.json is not valid JSON after 5 reads/), 'a file that never parses fails the snapshot, naming it');
  ok(fs.readdirSync(tmpParent).length === 0, 'the plaintext staging copy is removed on success and on failure');
}

console.log('=== an empty session key file, empty for a while, is left out rather than failing the backup ===');
{
  // bot-box2, 2026-09-30: pre-key-37.json and pre-key-38.json were left at 0
  // bytes by the restart at 04:23 UTC, and every backup after it refused "a
  // torn copy" - with the bot stopped too - so the box had no backup at all.
  // Baileys reads a file that will not parse as no key, so it is left out
  // as a missing one is. creds.json empty is a dead session: still fatal.
  const tmpParent = fs.mkdtempSync(path.join(T, 'staging-'));
  const old = new Date(Date.now() - 10 * 60_000);
  put(path.join(app, 'data/session/pre-key-37.json'), '');
  fs.utimesSync(path.join(app, 'data/session/pre-key-37.json'), old, old);
  const snap = await snapshotBundle(app, ['data/session'], { retryDelayMs: 1, tmpParent });
  const names = await listTar(snap.tar);
  ok(!names.includes('data/session/pre-key-37.json'), 'the long-empty pre-key is left out');
  ok(names.includes('data/session/pre-key-1.json') && names.includes('data/session/creds.json'), 'and the rest of the session is sealed');

  put(path.join(app, 'data/session/pre-key-37.json'), '');
  ok(await rejects(() => snapshotBundle(app, ['data/session'], { retryDelayMs: 1, tmpParent }),
    /pre-key-37\.json is not valid JSON after 5 reads/), 'one emptied a moment ago may be mid-write: still refused');
  fs.rmSync(path.join(app, 'data/session/pre-key-37.json'));

  const creds = fs.readFileSync(path.join(app, 'data/session/creds.json'));
  put(path.join(app, 'data/session/creds.json'), '');
  fs.utimesSync(path.join(app, 'data/session/creds.json'), old, old);
  ok(await rejects(() => snapshotBundle(app, ['data/session'], { retryDelayMs: 1, tmpParent }),
    /creds\.json is not valid JSON/), 'an empty creds.json still fails the snapshot, however old');
  fs.writeFileSync(path.join(app, 'data/session/creds.json'), creds);

  put(path.join(app, 'data/state.json.bak.json'), '');
  fs.utimesSync(path.join(app, 'data/state.json.bak.json'), old, old);
  ok(await rejects(() => snapshotBundle(app, ['data/state.json.bak.json'], { retryDelayMs: 1, tmpParent }),
    /not valid JSON/), 'outside the session directories an empty JSON file is still refused');
  fs.rmSync(path.join(app, 'data/state.json.bak.json'));
  ok(fs.readdirSync(tmpParent).length === 0, 'no plaintext staging copy is left behind');
}

console.log('=== the home allowlist, and what never goes in even when present ===');
{
  const paths = homeBundlePaths(home);
  ok(JSON.stringify(paths) === JSON.stringify([
    '.claude/settings.json', '.claude/CLAUDE.md', '.claude/keybindings.json', '.claude/agents',
    '.claude/commands', '.claude/skills', '.claude/projects/-/memory', '.claude/projects/-home-u-bot/memory',
    '.gitconfig', '.ssh',
  ]), `home paths: ${paths.join(' ')}`);
  ok(!paths.some((p) => p.startsWith('.config')), '~/.config/gh/hosts.yml (the gh token) is not bundled');
  ok(!paths.includes('.claude.json'), '~/.claude.json (machine identity) is not bundled');

  const snap = await snapshotHome(home);
  const names = await listTar(snap.tar);
  ok(names.includes('.claude/projects/-/memory/note.md'), 'Claude Code memory is bundled');
  ok(names.includes('.ssh/id_ed25519'), '~/.ssh is bundled');
  ok(!names.some((n) => n.endsWith('.jsonl')), 'transcripts are not');
  ok(!names.some((n) => /^\.claude\/(sessions|cache|shell-snapshots|backups|session-env|remote)\b/.test(n)), 'nor Claude Code caches and sessions');

  let threw = 0;
  for (const bad of ['.config', '.config/gh/hosts.yml', '.claude.json', '.claude', '../etc/passwd']) {
    try { assertHomePathsAllowed([bad]); } catch { threw++; }
  }
  ok(threw === 5, 'an allowlist entry that is, or contains, a forbidden path is refused');
  ok(isForbiddenHomePath('.claude/projects/-/abc.jsonl'), 'a transcript is forbidden by name');

  // And on the way out: a bundle that somehow holds .claude.json is refused.
  const evil = fs.mkdtempSync(path.join(T, 'evil-'));
  put(path.join(evil, '.claude.json'), '{}');
  const evilTar = execFileSync('tar', ['-czf', '-', '-C', evil, '.claude.json']);
  ok(await rejects(() => restoreHomeBundle({ homeDir: fs.mkdtempSync(path.join(T, 'h-')), tar: evilTar }),
    /must never be restored/), 'restore refuses a home bundle containing ~/.claude.json');
}

console.log('=== first backup: sealed, verified, one commit, only on sealed-backup ===');
let firstSha;
{
  const r = await runSealedBackup(base);
  firstSha = r.sha;
  ok(r.changed && r.committed && r.pushed, 'committed and pushed');
  ok(git(['rev-parse', BRANCH], remote) === r.sha, 'the remote branch is at the new commit');
  ok(git(['rev-list', '--count', BRANCH], remote) === '1', 'exactly one commit on the branch');
  ok(git(['rev-parse', 'main'], remote) === mainSha, 'main was not touched');
  ok(git(['rev-parse', 'activity-backups'], remote) === activitySha, 'activity-backups was not touched');
  ok(git(['rev-parse', 'HEAD'], app) === appHead && git(['branch', '--show-current'], app) === 'main',
    'the live app checkout is still on main at the same commit');
  ok(fs.existsSync(path.join(app, 'data/sealed-backup/HEAD')), 'commits are made in data/sealed-backup, a repo of its own');
  ok((fs.statSync(path.join(app, 'data/sealed-backup')).mode & 0o777) === 0o700, 'which is 0700');

  const tree = git(['ls-tree', '--name-only', BRANCH], remote).split('\n').sort();
  ok(JSON.stringify(tree) === JSON.stringify(['README.md', 'app.tar.gz.enc', 'home.tar.gz.enc', 'manifest.json']),
    `branch holds ${tree.join(', ')}`);
  const commit = git(['cat-file', '-p', BRANCH], remote);
  ok(!/^parent /m.test(commit), 'the commit has no parent');
  ok(/^author Test Owner <owner@example\.test>/m.test(commit), 'committed as the app checkout\'s identity');

  const manifest = JSON.parse(git(['show', `${BRANCH}:manifest.json`], remote));
  ok(manifest.createdAt === new Date(NOW).toISOString(), 'manifest: createdAt');
  ok(manifest.source.host === os.hostname() && manifest.source.node === process.version, 'manifest: source host and node');
  ok(manifest.bundles.app.paths.includes('data/session') && manifest.bundles.home.paths.includes('.ssh'), 'manifest: per-bundle paths');
  ok(/^[0-9a-f]{64}$/.test(manifest.bundles.app.sha256), 'manifest: plaintext sha256');

  // The whole remote object store, every branch, every blob and commit.
  const everything = execFileSync('git', ['cat-file', '--batch-all-objects', '--batch'], { cwd: remote, maxBuffer: 64 << 20 });
  for (const [name, value] of Object.entries(SENTINELS)) {
    ok(!everything.includes(Buffer.from(value)), `${name} appears nowhere in the remote repository`);
  }
  const msg = git(['log', '-1', '--format=%B', BRANCH], remote);
  ok(!Object.values(SENTINELS).some((v) => msg.includes(v)), 'nor in the commit message');

  const blob = execFileSync('git', ['cat-file', 'blob', `${BRANCH}:app.tar.gz.enc`], { cwd: remote });
  ok(blob.subarray(0, 6).toString() === 'WABKP1', 'the app bundle is a sealSecrets() blob');
  ok(await rejects(async () => openSecrets(blob, 'not the right passphrase'), /wrong passphrase, or the bundle is corrupt/),
    'a wrong passphrase gets a clear error');
}

console.log('=== an unchanged rerun is a no-op; a change is still one commit ===');
{
  const again = await runSealedBackup(base);
  ok(!again.changed && !again.committed && again.sha === firstSha, 'nothing changed: no new commit');
  ok(git(['rev-parse', BRANCH], remote) === firstSha, 'the remote did not move');

  put(path.join(app, 'data/state.json'), '{"history":[1,2]}');
  const changed = await runSealedBackup({ ...base, now: NOW + 86_400_000 });
  ok(changed.changed && changed.sha !== firstSha, 'a changed file makes a new commit');
  ok(git(['rev-list', '--count', BRANCH], remote) === '1', 'and the branch is STILL exactly one commit');
  firstSha = changed.sha;

  // Same contents, new passphrase: the old blobs would no longer open with
  // what this machine holds, so it must reseal rather than call it a no-op.
  const rekeyed = await runSealedBackup({ ...base, passphrase: 'a brand new passphrase 2026' });
  ok(rekeyed.changed, 'a new passphrase reseals even though no file changed');
  const blob = execFileSync('git', ['cat-file', 'blob', `${BRANCH}:app.tar.gz.enc`], { cwd: remote });
  ok(await rejects(async () => openSecrets(blob, PASSPHRASE), /wrong passphrase/), 'and the old passphrase no longer opens it');
  const back = await runSealedBackup(base);
  ok(back.changed, 'switching back reseals again');
  firstSha = back.sha;
}

console.log('=== a push that lands mid-run is never overwritten ===');
{
  put(path.join(app, 'data/outbound-budget.json'), '{"sent":4}');
  let intruder;
  const r = await rejects(() => runSealedBackup({
    ...base,
    hooks: {
      beforePush: () => {
        const empty = execFileSync('git', ['mktree'], { cwd: remote, input: '' }).toString().trim();
        intruder = execFileSync('git', ['commit-tree', empty, '-m', 'somebody else'], {
          cwd: remote, env: { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x' },
        }).toString().trim();
        git(['update-ref', `refs/heads/${BRANCH}`, intruder], remote);
      },
    },
  }), /git push: .*stale info.* - somebody else pushed to sealed-backup while this ran/);
  ok(r, 'the push is rejected, and says why: the lease was pinned to the sha fetched at the start');
  ok(git(['rev-parse', BRANCH], remote) === intruder, 'and the other push is still there');
  const next = await runSealedBackup(base);
  ok(next.pushed && git(['rev-list', '--count', BRANCH], remote) === '1', 'the next run recovers, still one commit');
  firstSha = next.sha;
}

console.log('=== another machine\'s backup is not overwritten without --take-over ===');
{
  ok(await rejects(() => runSealedBackup({ ...base, machine: 'machine-B' }), /another machine/),
    'machine B refuses to overwrite machine A\'s backup');
  ok(git(['rev-parse', BRANCH], remote) === firstSha, 'and the branch did not move');
  const taken = await runSealedBackup({ ...base, machine: 'machine-B', takeOver: true });
  ok(taken.pushed && taken.manifest.source.machine === 'machine-B', '--take-over claims it, with no content change needed');
  ok(taken.archived?.machine === 'machine-A'
    && git(['rev-parse', `${BRANCH}:archive/${taken.archived.folder}/app.tar.gz.enc`], remote) === git(['rev-parse', `${firstSha}:app.tar.gz.enc`], remote),
  'and machine A\'s backup is kept under archive/, the same blob (test/sealed-backup-archive.test.mjs has the rest)');
  const again = await runSealedBackup({ ...base, machine: 'machine-B' });
  ok(!again.changed, 'after which machine B\'s nightly run is a normal no-op');
  await runSealedBackup({ ...base, takeOver: true });
}

console.log('=== refusals ===');
{
  const bare = path.join(T, 'bare-app');
  git(['clone', '-q', remote, bare]);
  put(path.join(bare, 'data/config.json'), '{}');
  ok(await rejects(() => runSealedBackup({ ...base, appRoot: bare }), /\.env is missing/), 'no .env: refused');
  fs.rmSync(path.join(bare, 'data/config.json'));
  put(path.join(bare, '.env'), 'MASTER_KEY=x\n');
  ok(await rejects(() => runSealedBackup({ ...base, appRoot: bare }), /data\/config\.json is missing/), 'no config.json: refused');
  ok(await rejects(() => runSealedBackup({ ...base, passphrase: 'short' }), /at least 12 characters/), 'a short passphrase: refused');

  const cli = spawnSync(process.execPath, [path.join(REPO, 'tools/backup-secrets.mjs'), 'hunter2hunter2'], { encoding: 'utf8' });
  ok(cli.status === 2 && /never put the passphrase on the command line/.test(cli.stderr),
    'the CLI refuses a positional argument rather than take a passphrase from argv');
}

console.log('=== full round trip onto a fresh machine ===');
{
  const app2 = path.join(T, 'app2');
  git(['clone', '-q', remote, app2]);
  const home2 = path.join(T, 'home2');
  put(path.join(home2, '.gitconfig'), '[user]\n\tname = fresh box\n');
  put(path.join(home2, '.claude/settings.json'), '{"theme":"dark"}');
  const env = { ...process.env, HOME: home2, BACKUP_PASSPHRASE: PASSPHRASE };
  const restore = (args, extra = {}) => spawnSync(process.execPath,
    [path.join(REPO, 'tools/restore-secrets.mjs'), ...args, '--app-root', app2], { encoding: 'utf8', env: { ...env, ...extra } });

  const wrong = restore(['--from-branch'], { BACKUP_PASSPHRASE: 'definitely the wrong one' });
  ok(wrong.status === 3 && /wrong passphrase, or the bundle is corrupt\. Nothing was restored/.test(wrong.stderr),
    'wrong passphrase: a clear error, and its own exit code so bootstrap.sh can ask again');
  ok(!fs.existsSync(path.join(app2, '.env')) && !fs.existsSync(path.join(home2, '.ssh')), 'and nothing was touched');

  const r = restore(['--from-branch']);
  ok(r.status === 0, `restore --from-branch exits 0${r.status ? `: ${r.stderr}` : ''}`);
  ok(/Before starting: make sure the OLD machine is stopped/.test(r.stdout), 'and warns to stop the old machine');

  const original = {};
  for (const p of appBundlePaths(app)) Object.assign(original, walk(app, p));
  const restored = {};
  for (const p of appBundlePaths(app2)) Object.assign(restored, walk(app2, p));
  ok(Object.keys(original).length > 8 && Object.keys(original).sort().join() === Object.keys(restored).sort().join(),
    `the same ${Object.keys(original).length} app files came back`);
  ok(Object.keys(original).every((k) => original[k].equals(restored[k])), 'byte-identical');
  ok((fs.statSync(path.join(app2, '.env')).mode & 0o777) === 0o600, '.env is 0600');
  ok((fs.statSync(path.join(app2, 'data')).mode & 0o777) === 0o700, 'data/ is 0700');
  ok((fs.statSync(path.join(app2, 'data/yt-dlp-cookies.txt')).mode & 0o777) === 0o600,
    'the yt-dlp cookies (a Google login) are 0600, though the copy backed up was 0644');
  ok(!fs.existsSync(path.join(app2, 'data/sessions.json')) && !fs.existsSync(path.join(app2, 'data/logs')),
    'the disposable files did not come across');

  for (const f of ['.claude/settings.json', '.claude/CLAUDE.md', '.claude/agents/reviewer.md',
    '.claude/projects/-/memory/note.md', '.claude/projects/-home-u-bot/memory/MEMORY.md', '.ssh/id_ed25519', '.ssh/config']) {
    ok(fs.existsSync(path.join(home2, f)) && fs.readFileSync(path.join(home2, f)).equals(fs.readFileSync(path.join(home, f))),
      `home: ${f} is byte-identical`);
  }
  ok(fs.readFileSync(path.join(home2, '.gitconfig')).equals(fs.readFileSync(path.join(home, '.gitconfig'))), 'home: .gitconfig restored');
  ok(fs.readFileSync(path.join(home2, '.gitconfig.~1~'), 'utf8').includes('fresh box'),
    'and the fresh box\'s own .gitconfig is kept as .gitconfig.~1~ (tar --backup=numbered)');
  ok(!fs.existsSync(path.join(home2, '.claude/settings.json.~1~')), 'an identical file is left alone, not backed up');
  ok((fs.statSync(path.join(home2, '.ssh/id_ed25519')).mode & 0o777) === 0o600, '~/.ssh/id_ed25519 is 0600');
  ok((fs.statSync(path.join(home2, '.ssh')).mode & 0o777) === 0o700, '~/.ssh is 0700');
  for (const f of ['.claude.json', '.config/gh/hosts.yml', '.claude/projects/-/abc123.jsonl', '.claude/sessions', '.bashrc']) {
    ok(!fs.existsSync(path.join(home2, f)), `home: ${f} did not come across`);
  }

  const rerun = restore(['--from-branch', '--only', 'home']);
  ok(rerun.status === 0 && /already identical/.test(rerun.stdout), 're-running the home restore changes nothing');
  ok(!fs.existsSync(path.join(home2, '.gitconfig.~2~')), 'and piles up no second backup copy');

  const clobber = restore(['--from-branch']);
  ok(clobber.status === 1 && /already has/.test(clobber.stderr), 'the app restore refuses to clobber a set-up checkout');
}

console.log('=== the passphrase in .env ===');
{
  const dir = fs.mkdtempSync(path.join(T, 'envtest-'));
  ok(await rejects(async () => writeEnvPassphrase(dir, 'long enough passphrase'), /no \.env/),
    'refuses to create .env, which would block a later restore');
  put(path.join(dir, '.env'), 'MASTER_KEY=abc\n# a comment\nOTHER=1\nBACKUP_PASSPHRASE=old one here\n', 0o644);
  for (const p of ['has a # hash and spaces', "it's got 'single' quotes", 'mixed "double" and \'single\' q']) {
    writeEnvPassphrase(dir, p);
    ok(readEnvPassphrase(dir) === p, `round trips through dotenv: ${p}`);
  }
  const text = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  ok(text.startsWith('MASTER_KEY=abc\n# a comment\nOTHER=1\n'), 'every other line is kept exactly');
  ok((text.match(/BACKUP_PASSPHRASE/g) ?? []).length === 1, 'and there is exactly one passphrase line');
  ok((fs.statSync(path.join(dir, '.env')).mode & 0o777) === 0o600, '.env ends up 0600');
  ok(await rejects(async () => writeEnvPassphrase(dir, 'short'), /at least 12/), 'a short passphrase is refused');
  ok(await rejects(async () => writeEnvPassphrase(dir, 'line one\nline two'), /line break/), 'as is a line break');

  const never = () => { throw new Error('prompted'); };
  ok((await resolvePassphrase({ appRoot: dir, env: { BACKUP_PASSPHRASE: 'from the environment' }, prompt: never })).source === 'BACKUP_PASSPHRASE',
    'BACKUP_PASSPHRASE wins');
  ok((await resolvePassphrase({ appRoot: dir, env: {}, prompt: never })).source === '.env', 'then .env');
  const none = await resolvePassphrase({ appRoot: T, env: {}, interactive: false, prompt: never });
  ok(none.passphrase === '' && none.source === null, 'and a non-interactive caller (cron) is never prompted');
}

console.log('=== the nightly cron line ===');
{
  ok(cronLine({ appRoot: '/home/u/whatsapp-bot', nodePath: '/usr/bin/node' })
    === `17 5 * * * cd /home/u/whatsapp-bot && /usr/bin/node tools/backup-secrets.mjs --cron >> data/logs/backup-secrets.log 2>&1 ${CRON_TAG}`,
  'the exact line, at 05:17 UTC');
  ok(cronLine({ appRoot: '/home/u/my bot%', nodePath: '/usr/bin/node' }).includes("cd '/home/u/my bot\\%'"),
    'a path with a space is quoted and % is escaped for cron');

  const noPass = fs.mkdtempSync(path.join(T, 'nopass-'));
  put(path.join(noPass, '.env'), 'MASTER_KEY=abc\n');
  ok(await rejects(() => installCron({ appRoot: noPass }), /no BACKUP_PASSPHRASE/),
    'refuses to install a job that could only ever fail');
  ok(!fs.existsSync(CRONTAB_FILE), 'and wrote no crontab');

  put(CRONTAB_FILE, '# mine\n0 * * * * echo hourly\n5 5 * * * cd /old && /usr/local/bin/node tools/backup-secrets.mjs --cron\n');
  const first = await installCron({ appRoot: app, nodePath: '/usr/bin/node' });
  const second = await installCron({ appRoot: app, nodePath: '/usr/bin/node' });
  const tab = fs.readFileSync(CRONTAB_FILE, 'utf8');
  ok(first.changed && !second.changed, 'installing twice changes nothing the second time');
  ok(tab.split('\n').filter((l) => l.includes('backup-secrets.mjs')).length === 1, 'exactly one backup line, the stale one replaced');
  ok(tab.startsWith('# mine\n0 * * * * echo hourly\n'), 'other lines are kept');
  ok(tab.includes(cronLine({ appRoot: app, nodePath: '/usr/bin/node' })), 'the new line is there');

  const cli = spawnSync(process.execPath, [path.join(REPO, 'tools/backup-secrets.mjs'), '--install-cron', '--app-root', app],
    { encoding: 'utf8', env: { ...process.env, HOME: home } });
  ok(cli.status === 0, `--install-cron from the CLI exits 0${cli.status ? `: ${cli.stderr}` : ''}`);
  // Any backup attempt, successful or refused, leaves a status record.
  ok(!fs.existsSync(path.join(app, 'data/sealed-backup-status.json')),
    'and on its own it installs the line without running a backup');

  const removed = await removeCron();
  ok(removed.changed && !fs.readFileSync(CRONTAB_FILE, 'utf8').includes('backup-secrets'), '--remove-cron takes it out');
  ok(fs.readFileSync(CRONTAB_FILE, 'utf8').includes('echo hourly'), 'and nothing else');
}

console.log('=== the CLI end to end, and the status record ===');
{
  const env = { ...process.env, HOME: home, BACKUP_PASSPHRASE: PASSPHRASE };
  put(path.join(app, 'data/state.json'), '{"history":[1,2,3]}');
  const r = spawnSync(process.execPath, [path.join(REPO, 'tools/backup-secrets.mjs'), '--take-over', '--app-root', app],
    { encoding: 'utf8', env });
  ok(r.status === 0 && /pushed to sealed-backup/.test(r.stdout), `node tools/backup-secrets.mjs --take-over backs up${r.status ? `: ${r.stderr}` : ''}`);
  const status = JSON.parse(fs.readFileSync(path.join(app, 'data/sealed-backup-status.json'), 'utf8'));
  ok(status.ok === true && status.pushed === true, 'and leaves a durable record of the run');
  ok(!JSON.stringify(status).includes(PASSPHRASE), 'with no passphrase in it');

  const c = spawnSync(process.execPath, [path.join(REPO, 'tools/backup-secrets.mjs'), '--cron', '--app-root', app],
    { encoding: 'utf8', env: { ...env, BACKUP_PASSPHRASE: '' } });
  ok(c.status === 0 && /Nothing changed/.test(c.stdout), '--cron reads the passphrase from .env and no-ops when nothing changed');
  ok(/^\d{4}-\d\d-\d\dT/.test(c.stdout), 'its log lines are timestamped');
}

console.log('=== ActivityBackup\'s secrets bundle uses the widened list ===');
{
  const repoDir = fs.mkdtempSync(path.join(T, 'activity-'));
  const w = await writeSecretsBundle(repoDir, app, PASSPHRASE);
  ok(w.changed && w.files.includes('restore/secrets.tar.gz.enc'), 'the bundle is written');
  const names = await listTar(openSecrets(fs.readFileSync(path.join(repoDir, 'restore/secrets.tar.gz.enc')), PASSPHRASE));
  ok(names.includes('data/state.json') && names.includes('data/outbound-budget.json') && names.includes('certs/filter.crt'),
    'and carries state, the outbound budget and the CA');
  ok(!(await writeSecretsBundle(repoDir, app, PASSPHRASE)).changed, 'unchanged contents are not resealed');
}

console.log('=== deploy/ and tools/bootstrap.sh ===');
{
  const render = spawnSync(path.join(REPO, 'deploy/render-whatsapp-bot-unit.sh'), ['botuser', 'botgroup', '/srv/bot', '/usr/bin/node'], { encoding: 'utf8' });
  ok(render.status === 0, 'the unit renders');
  ok(/^ExecStart=\/usr\/bin\/node src\/index\.js$/m.test(render.stdout), 'ExecStart is the real node, not /usr/local/bin/node');
  ok(/^User=botuser$/m.test(render.stdout) && /^Group=botgroup$/m.test(render.stdout) && /^WorkingDirectory=\/srv\/bot$/m.test(render.stdout),
    'User, Group and WorkingDirectory are this machine\'s');
  ok(/^Restart=always$/m.test(render.stdout) && /StartLimitIntervalSec=0/.test(render.stdout), 'and the reviewed rest of the unit is kept');
  ok(spawnSync(path.join(REPO, 'deploy/render-whatsapp-bot-unit.sh'), ['u', 'g', '/srv/bot', 'node']).status === 2,
    'a relative node path is refused - systemd does not use PATH');
  ok(/^ExecStart=\/usr\/local\/bin\/node/m.test(fs.readFileSync(path.join(REPO, 'whatsapp-bot.service'), 'utf8')),
    'the repo copy is left as test/service-unit.test.mjs pins it');
  ok(spawnSync('sh', ['-n', path.join(REPO, 'deploy/grow-root-disk')]).status === 0, 'grow-root-disk parses');

  ok(spawnSync('bash', ['-n', path.join(REPO, 'tools/bootstrap.sh')]).status === 0, 'bootstrap.sh passes bash -n');

  // Dry run with every command that could change the machine replaced by a
  // stub that records the call and fails - so even a dry-run bug cannot touch
  // this box - and the read-only probes answered as on a fresh machine.
  const stubs = fs.mkdtempSync(path.join(T, 'stubs-'));
  const calls = path.join(stubs, 'calls.log');
  for (const c of ['sudo', 'apt-get', 'curl', 'crontab', 'npm', 'visudo', 'ethtool', 'tailscale', 'gh', 'systemctl', 'snap']) {
    put(path.join(stubs, c), `#!/bin/sh
echo "${c} $*" >> '${calls}'
case "${c} $1 $2" in
  "gh auth status") exit 0 ;;
  "systemctl is-enabled "*) echo disabled; exit 1 ;;
  "systemctl show "*) echo inactive; exit 0 ;;
  "snap list "*) echo "Name Version Rev Tracking Publisher Notes"; echo "sabnzbd 4.3 1 latest/stable x -"; exit 0 ;;
esac
exit 1
`, 0o755);
  }
  // The unit files are read as well as written; an empty root makes this box
  // look fresh even when it runs the bot (bot-box2 failed "the unit written").
  const freshRoot = fs.mkdtempSync(path.join(T, 'root-'));
  const dry = spawnSync('bash', [path.join(REPO, 'tools/bootstrap.sh'), '--dry-run'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, HOME: home, INSTALL_UNITS_ROOT: freshRoot },
    detached: true, // no controlling terminal: nothing may be asked
  });
  const out = dry.stdout;
  ok(dry.status === 0, `--dry-run exits 0${dry.status ? `: ${dry.stderr}` : ''}`);
  for (const [what, re] of [
    ['refuses root / preflight', /Preflight/],
    ['passwordless sudo, checked with visudo', /visudo -cf/],
    ['gh auth setup-git', /\+ gh auth setup-git/],
    ['./install.sh', /install\.sh/],
    ['tailscale up --ssh --operator', /tailscale up --ssh --operator=/],
    ['tailscale auto-update', /tailscale set .*--auto-update/],
    ['grow-root-disk installed and run', /grow-root-disk\.service[\s\S]*\+ sudo \/usr\/local\/sbin\/grow-root-disk/],
    ['the Hyper-V NIC step', /Hyper-V NIC/],
    ['the passphrase prompt', /ask ONCE for the passphrase/],
    ['restore from the branch', /restore-secrets\.mjs --from-branch/],
    ['the archived backups of other machines, before the restore', /archived backups of other machines \(node tools\/restore-secrets\.mjs --list-archive\)/],
    ['the passphrase kept out of the printed command', /BACKUP_PASSPHRASE=<hidden>/],
    ['BACKUP_PASSPHRASE saved to .env', /--save-passphrase-from-env/],
    ['the unit written', /write \/etc\/systemd\/system\/whatsapp-bot\.service/],
    ['daemon-reload', /systemctl daemon-reload/],
    ['enable at boot, together with the start', /systemctl enable --now whatsapp-bot\.service/],
    ['the old-machine question before any start', /Is the bot stopped on the old machine\?/],
    ['the nightly cron', /backup-secrets\.mjs --install-cron/],
    ['Claude Code, from its official installer', /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/],
    ['the hourly check', /install-hourly-debug\.sh\n/],
    ['its token, asked for with no echo and handed over on stdin', /install-hourly-debug\.sh --set-token/],
    ['the routines check a new session runs', /\+ node \S+tools\/routines\.mjs/],
    // 2026-10-11: YouTube links on "Queue a public link" need yt-dlp, and
    // deno for it; installed as the bot's user, after install.sh brings node.
    ['yt-dlp and deno, without root, after install.sh', /System packages and the app[\s\S]*yt-dlp and deno, for YouTube links[\s\S]*\+ \S*node \S+tools\/install-yt-dlp\.mjs ?\n/],
    // 2026-09-29, the operator: one paste, every step at once. So every
    // question and login comes before install.sh, and the panel's port is
    // checked (SABnzbd, a "featured snap", held 8080 and the bot crash-looped).
    ['the questions, all asked before install.sh', /Questions: everything that needs an answer[\s\S]*Claude Code[\s\S]*Tailscale[\s\S]*install\.sh/],
    ['the Claude Code login', /claude auth login/],
    ['the hourly check\'s token collected with the logins, and saved at once', /setup-token, read the token it prints, hidden, and save it at once[\s\S]*--set-token --no-verify[\s\S]*Tailscale/],
    ['the panel\'s port, checked', /port \d+|port_free|panel's port/],
    ['the start only on a yes and a free port', /answered 'yes' and port \d+ is free/],
    ['the LAN address step', /LAN address/],
    // bot-box2, 2026-09-29: the installer's featured snaps held 8080 and 3 GB
    // of RAM; its first commit failed with "Author identity unknown"; and
    // twelve suites failed there for want of the dev dependencies.
    ['the installer\'s extra snaps found, and asked about with the questions', /extra snaps are installed here: sabnzbd\n\s+would ask \[Y\/n\] whether to remove them \(or take REMOVE_INSTALLER_SNAPS\)[\s\S]*Is the bot stopped on the old machine/],
    ['their removal, after the logins and before install.sh', /Tailscale[\s\S]*The Ubuntu installer's extra snaps\n[\s\S]*\+ bash \S+remove-installer-snaps\.sh\n[\s\S]*System packages and the app: \.\/install\.sh/],
    ['the dev dependencies, so the whole suite runs on the box', /\+ npm --prefix \S+ install --include=dev/],
    ['a git identity, after the restore', /restore-secrets\.mjs --from-branch[\s\S]*Git: gh's login again, and who commits here[\s\S]*git config --global user\.name/],
    ['a checklist', /Checklist[\s\S]*\[ \] would:/],
  ]) ok(re.test(out), `dry run mentions: ${what}`);
  const log = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
  ok(!/^(sudo|apt-get|curl|crontab|npm|visudo|ethtool) /m.test(log) && !/^snap (remove|stop|disable)/m.test(log), 'and ran nothing that changes the machine');
  ok(!/^systemctl (start|enable|daemon-reload|restart)/m.test(log), 'not even a systemctl enable');
  ok(!/^tailscale (up|set)/m.test(log), 'nor a tailscale up');
  ok(!out.includes(PASSPHRASE), 'and never prints a passphrase');

  const asRoot = fs.readFileSync(path.join(REPO, 'tools/bootstrap.sh'), 'utf8');
  ok(/EUID -eq 0[\s\S]{0,80}die "Run this as the user/.test(asRoot), 'bootstrap refuses to run as root');
  ok(/\[\[ \$REPLY == yes \]\][\s\S]{0,60}systemctl enable --now whatsapp-bot/.test(asRoot),
    'and only starts the bot, or enables it at boot, on a typed "yes"');
  ok(/rc == 3 && attempt < 3/.test(asRoot), 'a mistyped passphrase is asked for again, not a reason to start over');
}

/* ---------------- what the review on 2026-09-22 found, each pinned ---- */

console.log('=== Ctrl-C or SIGTERM mid-snapshot leaves no plaintext staging copy ===');
{
  // Node's default SIGINT/SIGTERM exits without running `finally`; an
  // interrupted run left .env, config.json and the session in $TMPDIR.
  const tmpParent = fs.mkdtempSync(path.join(T, 'sig-'));
  const marker = path.join(T, 'sig-staged.txt');
  const child = path.join(T, 'sig-child.mjs');
  put(child, `
import fs from 'node:fs';
const { snapshotBundle, exitCleanlyOnSignals } = await import(${JSON.stringify(path.join(REPO, 'src/core/activity-backup.js'))});
exitCleanlyOnSignals();
await snapshotBundle(${JSON.stringify(app)}, ['.env', 'data/state.json'], {
  tmpParent: ${JSON.stringify(tmpParent)},
  retryDelayMs: 30000,
  copyFile: (src, dst) => {
    fs.copyFileSync(src, dst);
    if (src.endsWith('state.json')) {
      fs.writeFileSync(dst, '{"torn');
      fs.writeFileSync(${JSON.stringify(marker)}, dst);
      process.kill(process.pid, process.env.SIG);
    }
  },
});
console.log('finished, which it must not');
`);
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    fs.rmSync(marker, { force: true });
    const r = spawnSync(process.execPath, [child], { encoding: 'utf8', env: { ...process.env, SIG: sig }, timeout: 20_000 });
    const staged = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
    ok(staged.startsWith(tmpParent) && r.status === code, `${sig} arrived while the plaintext was staged, and the process exited ${code}`);
    ok(fs.readdirSync(tmpParent).length === 0, `after ${sig}, the staging directory holding .env is gone`);
  }

  const stale = fs.mkdtempSync(path.join(T, 'stale-'));
  const old = path.join(stale, 'wa-bkp-old');
  const fresh = path.join(stale, 'wa-home-fresh');
  const other = path.join(stale, 'something-else');
  for (const d of [old, fresh, other]) put(path.join(d, '.env'), 'MASTER_KEY=x\n');
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
  for (const d of [old, other]) fs.utimesSync(d, twoHoursAgo, twoHoursAgo);
  sweepStaleStaging(stale);
  ok(!fs.existsSync(old), 'a staging directory left by a SIGKILL is swept at the next run');
  ok(fs.existsSync(fresh), 'but not one a concurrent run may be using right now');
  ok(fs.existsSync(other), 'and nothing that is not a staging directory');
}

console.log('=== the app restore unpacks only an app bundle ===');
{
  // `restore-secrets.mjs home.tar.gz.enc` put ~/.ssh/id_ed25519 into the git
  // working tree, where the next `git add -A` commits it in the clear.
  const homeSnap = await snapshotHome(home);
  const target = path.join(T, 'wrong-bundle');
  git(['clone', '-q', remote, target]);
  ok(await rejects(() => restoreAppBundle({ appRoot: target, tar: homeSnap.tar }), /this is the HOME bundle/),
    'the home bundle, given as the app bundle, is refused and named');
  ok(!fs.existsSync(path.join(target, '.ssh')) && !fs.existsSync(path.join(target, '.gitconfig')), 'and nothing was unpacked');

  const stray = fs.mkdtempSync(path.join(T, 'stray-'));
  put(path.join(stray, '.env'), 'MASTER_KEY=x\n');
  put(path.join(stray, 'data/config.json'), '{}');
  put(path.join(stray, 'src/index.js'), 'replaced code\n');
  const strayTar = execFileSync('tar', ['-czf', '-', '-C', stray, '.env', 'data/config.json', 'src/index.js']);
  ok(await rejects(() => restoreAppBundle({ appRoot: target, tar: strayTar }), /src\/index\.js.*not part of an app backup/),
    'a member outside the app allowlist is refused');
  const partial = execFileSync('tar', ['-czf', '-', '-C', stray, 'data/config.json']);
  ok(await rejects(() => restoreAppBundle({ appRoot: target, tar: partial }), /has no \.env/),
    'and so is a bundle without .env');
  ok(!fs.existsSync(path.join(target, '.env')) && !fs.existsSync(path.join(target, 'data')), 'with nothing unpacked either time');

  const sealedHome = path.join(T, 'home.tar.gz.enc');
  fs.writeFileSync(sealedHome, sealSecrets(homeSnap.tar, PASSPHRASE));
  const cli = spawnSync(process.execPath, [path.join(REPO, 'tools/restore-secrets.mjs'), sealedHome, '--app-root', target],
    { encoding: 'utf8', env: { ...process.env, BACKUP_PASSPHRASE: PASSPHRASE } });
  ok(cli.status === 1 && /--home/.test(cli.stderr), 'from the CLI: exit 1, pointing at --home');
  ok(git(['status', '--porcelain'], target) === '', 'and the working tree is still clean');
}

console.log('=== the home restore: names in canonical form, symlinks, escaped names ===');
{
  ok(canonicalMember('.ssh/') === '.ssh' && canonicalMember('.claude/settings.json') === '.claude/settings.json',
    'our own member names are canonical');
  ok(['./.claude.json', '.config//gh/hosts.yml', '.config/./gh', '../x', '/etc/passwd', '.'].every((n) => canonicalMember(n) === null),
    'a ./ prefix, a doubled slash, . and .. segments and absolute names are not');

  // HOME_NEVER compared plain strings, so ./.claude.json slipped past it and
  // tar extracted it to ~/.claude.json.
  const dotted = fs.mkdtempSync(path.join(T, 'dotted-'));
  put(path.join(dotted, '.claude.json'), '{}');
  put(path.join(dotted, '.config/gh/hosts.yml'), `oauth_token: ${SENTINELS.ghToken}\n`);
  const dottedTar = execFileSync('tar', ['-czf', '-', '-C', dotted, './.claude.json', './.config/gh/hosts.yml']);
  const h1 = fs.mkdtempSync(path.join(T, 'h-'));
  ok(await rejects(() => restoreHomeBundle({ homeDir: h1, tar: dottedTar }), /not a plain relative path/),
    'a ./-prefixed ~/.claude.json is refused');
  ok(fs.readdirSync(h1).length === 0, 'and neither it nor hosts.yml was restored');

  // `.x -> .config`, then `.x/gh/hosts.yml`: every name looks innocent, and
  // the file lands in ~/.config/gh.
  const linky = fs.mkdtempSync(path.join(T, 'linky-'));
  fs.mkdirSync(path.join(linky, '.config'));
  fs.symlinkSync('.config', path.join(linky, '.x'));
  put(path.join(linky, 'real/gh/hosts.yml'), 'tok\n');
  const linkyTar = execFileSync('tar', ['-czf', '-', '-C', linky, '--no-recursion', '--transform', 's,^real/,.x/,',
    '.config', '.x', 'real/gh', 'real/gh/hosts.yml']);
  const h2 = fs.mkdtempSync(path.join(T, 'h-'));
  ok(await rejects(() => restoreHomeBundle({ homeDir: h2, tar: linkyTar }), /which the bundle makes a symlink/),
    'a member under a symlink the bundle itself makes is refused');
  ok(!fs.existsSync(path.join(h2, '.config/gh')), 'and ~/.config/gh was not written');

  // tar -t escapes a backslash always, and non-ASCII under a C locale; the
  // escaped name matched no staged file and was skipped as "unchanged".
  const odd = fs.mkdtempSync(path.join(T, 'odd-'));
  const oddNames = ['a\\b.md', 'סרט.md', 'with space.md'];
  for (const n of oddNames) put(path.join(odd, '.claude/projects/-/memory', n), `memory ${n}\n`);
  const oddSnap = await snapshotHome(odd);
  const saved = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL };
  process.env.LANG = 'C';
  process.env.LC_ALL = 'C';
  try {
    const h3 = fs.mkdtempSync(path.join(T, 'h-'));
    const r = await restoreHomeBundle({ homeDir: h3, tar: oddSnap.tar });
    ok(oddNames.every((n) => fs.readFileSync(path.join(h3, '.claude/projects/-/memory', n), 'utf8') === `memory ${n}\n`),
      'under LC_ALL=C, memory files named with a backslash, in Hebrew and with a space all come back');
    ok(r.added.length === 3, `and all three are reported as restored (${r.added.length})`);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

console.log('=== ~/.ssh/authorized_keys and known_hosts are merged, not replaced ===');
{
  // bot-box4's authorized_keys is empty; restoring it over a new box's
  // replaced the key its installer imported, with the original kept only as
  // authorized_keys.~1~, which sshd never reads.
  const oldHome = fs.mkdtempSync(path.join(T, 'oldhome-'));
  put(path.join(oldHome, '.ssh/authorized_keys'), '');
  put(path.join(oldHome, '.ssh/known_hosts'), 'github.com ssh-ed25519 AAAAgithub\n');
  const newHome = fs.mkdtempSync(path.join(T, 'newhome-'));
  put(path.join(newHome, '.ssh/authorized_keys'), 'ssh-ed25519 AAAAnewboxkey user@laptop\n', 0o600);
  put(path.join(newHome, '.ssh/known_hosts'), 'gitlab.com ssh-ed25519 AAAAgitlab\n');
  const r = await restoreHomeBundle({ homeDir: newHome, tar: (await snapshotHome(oldHome)).tar });
  ok(fs.readFileSync(path.join(newHome, '.ssh/authorized_keys'), 'utf8') === 'ssh-ed25519 AAAAnewboxkey user@laptop\n',
    'an empty authorized_keys from the old box leaves the new box\'s key in place');
  ok(!fs.existsSync(path.join(newHome, '.ssh/authorized_keys.~1~')), 'with no numbered copy');
  ok(fs.readFileSync(path.join(newHome, '.ssh/known_hosts'), 'utf8') === 'gitlab.com ssh-ed25519 AAAAgitlab\ngithub.com ssh-ed25519 AAAAgithub\n',
    'known_hosts gains the old box\'s hosts and keeps its own');
  ok(r.merged.length === 1 && r.merged[0] === '.ssh/known_hosts' && !r.replaced.length, 'and it is reported as merged, not replaced');

  put(path.join(oldHome, '.ssh/authorized_keys'), 'ssh-ed25519 AAAAoldkey me@phone\n');
  await restoreHomeBundle({ homeDir: newHome, tar: (await snapshotHome(oldHome)).tar });
  ok(fs.readFileSync(path.join(newHome, '.ssh/authorized_keys'), 'utf8')
    === 'ssh-ed25519 AAAAnewboxkey user@laptop\nssh-ed25519 AAAAoldkey me@phone\n', 'a key only the old box had is appended');
  ok((fs.statSync(path.join(newHome, '.ssh/authorized_keys')).mode & 0o777) === 0o600, 'and the file keeps its mode');
  const again = await restoreHomeBundle({ homeDir: newHome, tar: (await snapshotHome(oldHome)).tar });
  ok(!again.merged.length && !again.added.length && !again.replaced.length, 'a re-run adds nothing twice');
}

console.log('=== the manifest says whether the bot was running ===');
{
  const proc = fs.mkdtempSync(path.join(T, 'proc-'));
  put(path.join(proc, '4242/cmdline'), '/usr/bin/node\0src/index.js\0');
  fs.symlinkSync(app, path.join(proc, '4242/cwd'));
  put(path.join(proc, '77/cmdline'), 'node\0src/index.js\0');
  fs.symlinkSync(home, path.join(proc, '77/cwd'));
  put(path.join(proc, 'self/cmdline'), 'x');
  ok(botProcessRunning(app, { procDir: proc }) === true, 'a node src/index.js whose cwd is the checkout counts as running');
  ok(botProcessRunning(path.join(T, 'app2'), { procDir: proc }) === false, 'one in another directory does not');
  ok(botProcessRunning(app, { procDir: path.join(T, 'no-such-proc') }) === null, 'and with no /proc the answer is "unknown"');

  const running = await runSealedBackup({ ...base, botRunning: true, takeOver: true });
  ok(running.manifest.source.botRunning === true, 'a backup taken while the bot runs says so');
  // The hand-over backup: bot stopped, often not a byte changed since the
  // night before. It must still replace the "taken while running" copy.
  const stopped = await runSealedBackup({ ...base, botRunning: false });
  ok(stopped.changed && stopped.manifest.source.botRunning === false, 'the same files with the bot stopped is a new backup, not a no-op');
  const d = await describeSealedBackup({ appRoot: app, now: NOW + 5 * 60_000, machine: 'machine-A' });
  ok(d.botRunning === false && d.thisMachine === true && d.ageMinutes === 5 && d.host === os.hostname(),
    'describeSealedBackup reads when, where and whether the bot ran, with no passphrase');
  const info = spawnSync(process.execPath, [path.join(REPO, 'tools/restore-secrets.mjs'), '--from-branch', '--info', '--app-root', app],
    { encoding: 'utf8', env: { ...process.env, BACKUP_PASSPHRASE: '' } });
  ok(info.status === 0 && /^present=yes$/m.test(info.stdout) && /^botRunning=false$/m.test(info.stdout) && /^thisMachine=no$/m.test(info.stdout),
    'restore-secrets.mjs --info prints it for bootstrap.sh');
}

console.log('=== a failure before the backup starts is still recorded ===');
{
  // A nightly run that found no passphrase in .env exited before the status
  // was written, so the file went on saying the last run was fine.
  const noPass = path.join(T, 'status-app');
  git(['clone', '-q', remote, noPass]);
  put(path.join(noPass, '.env'), 'MASTER_KEY=x\n');
  put(path.join(noPass, 'data/config.json'), '{}');
  put(path.join(noPass, 'data/sealed-backup-status.json'), '{"ok":true,"trigger":"cron"}\n');
  const c = spawnSync(process.execPath, [path.join(REPO, 'tools/backup-secrets.mjs'), '--cron', '--app-root', noPass],
    { encoding: 'utf8', env: { ...process.env, HOME: home, BACKUP_PASSPHRASE: '' } });
  const status = JSON.parse(fs.readFileSync(path.join(noPass, 'data/sealed-backup-status.json'), 'utf8'));
  ok(c.status === 1 && status.ok === false && status.trigger === 'cron' && /no BACKUP_PASSPHRASE in \.env/.test(status.error),
    'no passphrase in .env: the status file now says the run failed, and why');
}

console.log('=== grow-root-disk leaves a PV that is not a partition alone ===');
{
  // LVM on LUKS (/dev/mapper/...) or a whole-disk PV: the script died on
  // /sys/class/block/<pv>/partition under set -e, which aborted bootstrap.
  const stubs = fs.mkdtempSync(path.join(T, 'grow-'));
  const calls = path.join(stubs, 'calls.log');
  for (const c of ['findmnt', 'lvs', 'pvs', 'vgs', 'growpart', 'pvresize', 'lvextend', 'lsblk']) {
    put(path.join(stubs, c), `#!/bin/sh
echo "${c} $*" >> '${calls}'
case ${c} in
  findmnt) echo /dev/mapper/ubuntu--vg-ubuntu--lv ;;
  lvs) case "$*" in *vg_name*) echo "  ubuntu-vg" ;; esac ;;
  pvs) echo "  /dev/mapper/dm_crypt-wa-test-0" ;;
esac
exit 0
`, 0o755);
  }
  const r = spawnSync('sh', [path.join(REPO, 'deploy/grow-root-disk')], { encoding: 'utf8', env: { ...process.env, PATH: `${stubs}:${process.env.PATH}` } });
  ok(r.status === 0 && /not a disk partition/.test(r.stdout), `exits 0 and says why${r.status ? `: ${r.stderr}` : ''}`);
  ok(!/^(growpart|pvresize|lvextend) /m.test(fs.readFileSync(calls, 'utf8')), 'and resizes nothing');
}

console.log('=== bootstrap.sh for real (every command that changes a machine stubbed) ===');
{
  // The branch belongs to machine A, and its bot was stopped for this copy.
  await runSealedBackup({ ...base, botRunning: false, takeOver: true });
  const stubs = fs.mkdtempSync(path.join(T, 'boot-stubs-'));
  const calls = path.join(stubs, 'calls.log');
  const stub = (name, body = '') => put(path.join(stubs, name), `#!/bin/sh
echo "${name} $*" >> '${calls}'
${body}
exit 0
`, 0o755);
  // Drains what `| sudo tee` is given, but never waits on a terminal. What
  // it answers, each only when a run asks for it: `sudo -l` (FAKE_SUDO_L);
  // no boot-time apt job holding the lock; SABnzbd on 8080 (FAKE_SS_HELD)
  // until `snap remove --purge sabnzbd` goes through it; a `tailscale up`
  // that fails (FAKE_TS_FAIL).
  stub('sudo', `case "$1 $2" in
  "-n -l") printf '%s\\n' "$FAKE_SUDO_L" ;;
  "-n fuser") exit 1 ;;
  "-n ss") [ "$FAKE_SS_HELD" = 1 ] && [ ! -e '${stubs}/sabnzbd-gone' ] \\
    && echo 'LISTEN 0      511    127.0.0.1:8080 0.0.0.0:* users:(("python3",pid=4242,fd=5))' ;;
esac
case "$*" in
  *"snap remove --purge sabnzbd") touch '${stubs}/sabnzbd-gone' ;;
  "tailscale up"*) [ "$FAKE_TS_FAIL" = 1 ] && exit 1 ;;
esac
[ -t 0 ] || cat > /dev/null 2>&1`);
  stub('systemctl', 'case "$1" in is-enabled) echo disabled; exit 1 ;; show) echo "$FAKE_ACTIVE" ;; esac');
  // crontab too: the box that says the bot runs here installs the hourly
  // check, whose installer calls crontab itself (SEALED_BACKUP_CRONTAB is only
  // the backup tool's), and the routines check reads it.
  const STUBBED = ['sudo', 'systemctl', 'gh', 'tailscale', 'dpkg', 'ip', 'apt-get', 'curl', 'visudo', 'ethtool', 'npm', 'crontab', 'snap', 'ss'];
  for (const c of STUBBED.slice(2)) stub(c);
  // The Ubuntu installer's snaps, as FAKE_SNAPS lists them.
  stub('snap', '[ "$1" = list ] && { echo "Name Version Rev Tracking Publisher Notes"; for s in $FAKE_SNAPS; do echo "$s 1 1 latest/stable x -"; done; }');
  // Not logged in (FAKE_TS_DOWN), or not logged in and unable to (FAKE_TS_FAIL).
  stub('tailscale', '[ "$1" = status ] && [ -n "$FAKE_TS_DOWN$FAKE_TS_FAIL" ] && exit 1');
  // A box on a LAN (FAKE_IP=1), on an interface /sys has never heard of, so
  // the Hyper-V NIC fix leaves it alone.
  stub('ip', `[ "$FAKE_IP" = 1 ] || exit 0
case "$*" in
  "route show default") echo "default via 192.168.20.1 dev fake0 proto dhcp src 192.168.20.37 metric 100" ;;
  "-4 -o addr show dev fake0 scope global") echo "2: fake0    inet 192.168.20.37/24 brd 192.168.20.255 scope global dynamic fake0" ;;
esac`);
  // Whose process holds 8080, for tools/port-holder.sh: SABnzbd's snap.
  const fakeProc = path.join(stubs, 'proc');
  put(path.join(fakeProc, '4242/cgroup'), '0::/system.slice/snap.sabnzbd.sabnzbd.service\n');
  // Takes the new table from stdin like the real one: the hourly installer
  // pipes its crontab into `crontab -`, and a pipe nobody reads fails.
  stub('crontab', '[ "$1" = - ] && cat > /dev/null');
  const vmRoot = fs.mkdtempSync(path.join(T, 'vm-root-'));
  // Each box has its own global git config, in its own home, where the
  // restore puts ~/.gitconfig and bootstrap puts the identity.
  const bootEnv = (b, extra) => ({
    ...process.env, PATH: `${stubs}:${process.env.PATH}`, HOME: b.home, BACKUP_PASSPHRASE: PASSPHRASE,
    GIT_CONFIG_GLOBAL: path.join(b.home, '.gitconfig'), PORT_HOLDER_PROC: fakeProc,
    // A VM's root, empty, whatever box runs this. On the WSL laptop
    // (2026-09-29) these runs took bootstrap's WSL branch, and its .wslconfig
    // step - which needs no sudo, so no stub stopped it - wrote the real
    // Windows file. Under this root bootstrap reads no WSL kernel, and
    // deploy/wsl-setup.sh (WSL_SETUP_ROOT) could only write beneath it.
    INSTALL_UNITS_ROOT: vmRoot, ...extra,
  });
  // These runs are not dry runs. On the box that runs the tests, sudo is
  // passwordless and the live bot's unit is real, so every one of these
  // commands must resolve to its stub, and the crontab to the fake, BEFORE
  // bootstrap.sh is let anywhere near them.
  const probe = spawnSync('bash', ['-c', `for c in ${STUBBED.join(' ')}; do command -v "$c"; done`],
    { encoding: 'utf8', env: bootEnv({ home: T }, {}) });
  const safe = probe.stdout.trim().split('\n').every((l) => l.startsWith(`${stubs}/`))
    && probe.stdout.trim().split('\n').length === STUBBED.length && process.env.SEALED_BACKUP_CRONTAB === FAKE_CRONTAB;
  ok(safe, 'every command bootstrap.sh could change the machine with resolves to a stub');
  if (!safe) throw new Error('refusing to run bootstrap.sh for real without its stubs');

  const box = (name, own = null) => {
    const dir = path.join(T, name);
    git(['clone', '-q', remote, dir]);
    for (const d of ['src', 'tools', 'deploy']) fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
    for (const f of ['whatsapp-bot.service', 'package.json']) fs.copyFileSync(path.join(REPO, f), path.join(dir, f));
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'));
    put(path.join(dir, 'install.sh'), `#!/bin/sh\necho "install.sh" >> '${calls}'\n`, 0o755);
    // Never the real netplan: the LAN step's script only says what it was asked.
    put(path.join(dir, 'deploy/pin-lan-address.sh'), `#!/bin/sh\necho "pin-lan-address.sh $*" >> '${calls}'\n`, 0o755);
    if (own) {
      put(path.join(dir, '.env'), own, 0o600);
      put(path.join(dir, 'data/config.json'), '{"own":true}', 0o600);
    }
    const boxHome = path.join(T, `${name}-home`);
    fs.mkdirSync(boxHome);
    return { dir, home: boxHome };
  };
  // With `answers`, run under a pseudo-terminal (util-linux `script`) and
  // type them, one per line; without, with no controlling terminal at all.
  const bootstrap = (b, { active = 'inactive', args = [], answers = null, env: extra = {} } = {}) => {
    fs.rmSync(calls, { force: true });
    fs.rmSync(path.join(stubs, 'sabnzbd-gone'), { force: true });
    const env = bootEnv(b, { FAKE_ACTIVE: active, ...extra });
    const cmd = [path.join(b.dir, 'tools/bootstrap.sh'), ...args];
    const r = answers === null
      ? spawnSync('bash', cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, detached: true, timeout: 120_000 })
      : spawnSync('script', ['-qec', `bash ${cmd.map((a) => `'${a}'`).join(' ')}`, '/dev/null'],
        { encoding: 'utf8', input: `${answers.join('\n')}\n`, env, timeout: 120_000, killSignal: 'SIGKILL' });
    return { ...r, out: `${r.stdout}\n${r.stderr}`, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '' };
  };
  const branchSha = () => git(['rev-parse', BRANCH], remote);

  // A second bot on its own number, already running: it must never claim
  // machine A's backup. It did, with --take-over, and A's nightly job then
  // refused for good.
  const before = branchSha();
  const b = box('box-b', 'MASTER_KEY=MACHINE_B_OWN_KEY\n');
  const rb = bootstrap(b, { active: 'active' });
  ok(rb.status === 0, `a box with its own .env, bot running: exits 0${rb.status ? `: ${rb.out.slice(-600)}` : ''}`);
  ok(/restoring the home bundle only/.test(rb.out), 'restores the home bundle only');
  ok(!/\+ node \S+backup-secrets\.mjs --take-over/.test(rb.out), 'and does NOT run --take-over');
  ok(branchSha() === before, 'so machine A\'s backup is still the branch');
  ok(/MASTER_KEY=MACHINE_B_OWN_KEY/.test(fs.readFileSync(path.join(b.dir, '.env'), 'utf8')), 'and box B keeps its own MASTER_KEY');
  // The bot runs on box B, so the hourly check goes on it - with the
  // installer's crontab stubbed - and with no terminal to ask on, the token
  // is a checklist line that says how, never "echo it into the file". The
  // line is a tick every minute: on the hour, and at once for a library
  // keeper's #issue (the operator, 2026-10-12).
  const tick = /Installed: \* \* \* \* \* mkdir -p \S+ && \/bin\/bash \S+\/deploy\/hourly-debug\/tick\.sh /;
  ok(tick.test(rb.out) && /^crontab -$/m.test(rb.calls),
    `the box running the bot gets the hourly check in cron${tick.test(rb.out) ? '' : `: ${rb.out.split('hourly check (cron')[1]?.slice(0, 900)}`}`);
  ok(/\[ \] the hourly check's Claude token: \S+ setup-token .*--set-token/.test(rb.out) && !/echo 'CLAUDE_CODE_OAUTH_TOKEN/.test(rb.out),
    'no terminal: the token is left on the checklist, with claude setup-token and --set-token');
  ok(/Routines on /.test(rb.out) && /hourly-check/.test(rb.out), 'and the last step is the routines check a new session runs');

  // A fresh box, no terminal: restored, but neither started nor enabled at
  // boot. Enabled, the first reboot would start a second copy on the session.
  const c = box('box-c');
  const rc = bootstrap(c);
  ok(rc.status === 0, `a fresh box with no terminal: exits 0${rc.status ? `: ${rc.out.slice(-600)}` : ''}`);
  ok(/taken with the bot on .* stopped: restoring it/.test(rc.out) && fs.existsSync(path.join(c.dir, '.env')),
    'a backup taken with the old bot stopped is restored without a question');
  ok(/write \/etc\/systemd\/system\/whatsapp-bot\.service/.test(rc.out), 'the unit is installed');
  ok(!/^sudo systemctl (enable|start)\b.*whatsapp-bot/m.test(rc.calls), 'but NOT enabled at boot, and not started');
  ok(/\[ \] sudo systemctl enable --now whatsapp-bot \(only once the old machine is stopped/.test(rc.out),
    'the checklist says to enable and start it once the old machine is stopped');
  ok(branchSha() === before, 'and the branch is not claimed by a machine that is not running the bot');
  ok(/\[-\] the hourly check \(the bot does not run here/.test(rc.out) && !/^crontab -$/m.test(rc.calls),
    'nor does a box whose bot is not running get the hourly check');

  // At a terminal: "no" leaves it disabled, "yes" enables and starts it
  // together, and only then is the branch claimed for this machine.
  if (spawnSync('script', ['--version']).status === 0) {
    const c2 = box('box-c2');
    const no = bootstrap(c2, { answers: ['n', 'no'] });
    ok(no.status === 0 && /Is the bot stopped on the old machine\?/.test(no.out), `at a terminal the gate is asked${no.status ? `: ${no.out.slice(-600)}` : ''}`);
    ok(!/^sudo systemctl (enable|start)\b.*whatsapp-bot/m.test(no.calls), 'answered "no": not started, and NOT enabled at boot');
    ok(branchSha() === before, 'and the branch is left alone');
    const skips2 = JSON.parse(fs.readFileSync(path.join(c2.dir, 'data/routines-skip.json'), 'utf8'));
    ok(/declined/.test(skips2.sudo?.reason ?? ''), 'passwordless sudo declined at the prompt is recorded, so a later session does not ask again');
    const c3 = box('box-c3');
    const yes = bootstrap(c3, { answers: ['n', 'yes'] });
    ok(/^sudo systemctl enable --now whatsapp-bot\.service$/m.test(yes.calls), 'answered "yes": enabled at boot and started in one step');
    ok(/\+ node \S+backup-secrets\.mjs --take-over/.test(yes.out) && branchSha() !== before
      && JSON.parse(git(['show', `${BRANCH}:manifest.json`], remote)).source.appRoot === c3.dir,
    'and the box that restored the branch and now runs the bot claims it');
    await runSealedBackup({ ...base, botRunning: false, takeOver: true });
  } else {
    console.log('  skip the terminal runs: util-linux `script` is not installed');
  }

  // The hand-over run the wrong way round: the backup was taken while the old
  // bot still ran, so it is not restored silently.
  await runSealedBackup({ ...base, botRunning: true, takeOver: true });
  const d = box('box-d');
  const rd = bootstrap(d);
  ok(rd.status === 0, `a backup taken while the old bot ran, no terminal: exits 0${rd.status ? `: ${rd.out.slice(-600)}` : ''}`);
  ok(/was still RUNNING/.test(rd.out) && !fs.existsSync(path.join(d.dir, '.env')),
    'it warns, and does not restore the app bundle without somebody saying so');
  ok(fs.existsSync(path.join(d.home, '.claude/settings.json')), 'the home bundle is restored all the same');
  ok(/stop the bot \(sudo systemctl disable --now whatsapp-bot\) and run node tools\/backup-secrets\.mjs/.test(rd.out),
    'and the checklist says how to take a final backup');

  // A box for another number: never A's session, never A's branch.
  const e = box('box-e');
  const re = bootstrap(e, { args: ['--new-number'] });
  ok(re.status === 0 && !fs.existsSync(path.join(e.dir, '.env'))
    && /gh auth git-credential/.test(fs.readFileSync(path.join(e.home, '.gitconfig'), 'utf8')),
  '--new-number restores the home bundle and not the app bundle');
  ok(/--new-number: the sealed-backup branch belongs to/.test(re.out), 'and installs no nightly job that could only be refused');
  const skipsE = JSON.parse(fs.readFileSync(path.join(e.dir, 'data/routines-skip.json'), 'utf8'));
  ok(/another number/.test(skipsE['sealed-backup']?.reason ?? ''),
    'and records it, so the routines check never suggests the --take-over that would replace the other bot\'s backup');
  await runSealedBackup({ ...base, botRunning: false, takeOver: true });

  /* ---- the one paste (2026-09-29): every answer from the environment ---- */
  // The branch back with machine A, its bot stopped, before each run that
  // could restore it: a run that starts the bot here claims it.
  const resetBranch = () => runSealedBackup({ ...base, botRunning: false, takeOver: true });
  const enabled = (r) => /^sudo systemctl enable --now whatsapp-bot\.service$/m.test(r.calls);
  const hourlyInstalled = (r) => /^crontab -$/m.test(r.calls) && /Installed: \* \* \* \* \* .*\/tick\.sh /.test(r.out);
  const SUDO_L = (rule) => `User tester may run the following commands on box:\n    (ALL : ALL) ALL\n    ${rule}`;

  // The paste's own answers, with no terminal at all: passwordless sudo, and
  // the old bot stopped. The rule-3 gate is OLD_BOT_STOPPED=yes here, so this
  // is what decides whether a second bot starts.
  await resetBranch();
  const p1 = box('box-paste');
  const rp = bootstrap(p1, { env: { PASSWORDLESS_SUDO: 'yes', OLD_BOT_STOPPED: 'yes', LAN_ADDRESS: 'skip', FAKE_IP: '1' } });
  ok(rp.status === 0, `every answer from the environment, no terminal: exits 0${rp.status ? `: ${rp.out.slice(-600)}` : ''}`);
  ok(/^sudo visudo -cf \S+$/m.test(rp.calls) && /^sudo install -m 0440 -o root -g root \S+ \/etc\/sudoers\.d\/90-claude-nopasswd$/m.test(rp.calls),
    'PASSWORDLESS_SUDO=yes: the rule is checked with visudo, then installed');
  ok(enabled(rp), 'OLD_BOT_STOPPED=yes: enabled at boot and started, with nobody at a terminal');
  ok(hourlyInstalled(rp), 'and the hourly check goes on the box that now runs the bot');
  ok(/\[-\] LAN address \(left as it is, as asked\)/.test(rp.out) && !/^pin-lan-address\.sh/m.test(rp.calls), 'LAN_ADDRESS=skip: the address is left alone');
  // bot-box2's first commit failed with "Author identity unknown".
  const gc = fs.readFileSync(path.join(p1.home, '.gitconfig'), 'utf8');
  ok(/email = seed@example\.test/.test(gc) && /name = Seed/.test(gc) && /gh auth git-credential/.test(gc),
    'git gets the author of the last commit on main as its identity, after the restore, which kept gh\'s login');
  ok(/^npm --prefix \S+ install --include=dev /m.test(rp.calls), 'and the dev dependencies, so the whole test suite runs there');

  // OLD_BOT_STOPPED=no: nothing starts, and nothing is enabled at boot. The
  // box here has its own identity in the checkout, as bot-box had: it is kept.
  // (The branch back first: box-paste took it over, identity and all.)
  await resetBranch();
  const p2 = box('box-paste-no');
  git(['config', 'user.name', 'Local Person'], p2.dir);
  git(['config', 'user.email', 'local@example.test'], p2.dir);
  const rn = bootstrap(p2, { env: { OLD_BOT_STOPPED: 'no', LAN_ADDRESS: 'dhcp', FAKE_IP: '1', PASSWORDLESS_SUDO: 'no' } });
  ok(rn.status === 0 && !enabled(rn) && !/^sudo systemctl (enable|start)\b.*whatsapp-bot/m.test(rn.calls),
    `OLD_BOT_STOPPED=no: not started, and NOT enabled at boot${rn.status ? `: ${rn.out.slice(-600)}` : ''}`);
  ok(/^pin-lan-address\.sh\s*$/m.test(rn.calls), 'LAN_ADDRESS=dhcp: only the router is asked to keep the address');
  ok(!/visudo/.test(rn.calls) && /declined/.test(JSON.parse(fs.readFileSync(path.join(p2.dir, 'data/routines-skip.json'), 'utf8')).sudo?.reason ?? ''),
    'PASSWORDLESS_SUDO=no: nothing installed, and recorded, so a later session does not ask again');
  ok(/= git commits here as Local Person <local@example\.test>/.test(rn.out)
    && !/email =/.test(fs.existsSync(path.join(p2.home, '.gitconfig')) ? fs.readFileSync(path.join(p2.home, '.gitconfig'), 'utf8') : ''),
  'an identity the checkout already has is kept, and no global one is added');

  // Sudo narrowed to the hourly check's one rule (install-hourly-debug.sh,
  // step 3): the paste's PASSWORDLESS_SUDO=yes must not widen it again. A
  // re-paste did, silently. The installer's snaps are here too, with nobody
  // to ask: they stay, and the checklist says how.
  await resetBranch();
  const p3 = box('box-narrowed');
  const TS_KEY = 'tskey-auth-SENTINEL-kxyz';
  const rw = bootstrap(p3, { args: ['--new-number'], env: {
    PASSWORDLESS_SUDO: 'yes', FAKE_SUDO_L: SUDO_L('(root) NOPASSWD: /usr/bin/systemctl restart whatsapp-bot'),
    FAKE_SNAPS: 'core24 snapd microk8s sabnzbd', LAN_ADDRESS: '192.168.20.37', FAKE_IP: '1', FAKE_TS_DOWN: '1', TS_AUTHKEY: TS_KEY } });
  ok(rw.status === 0 && !/visudo|90-claude-nopasswd/.test(rw.calls) && /narrowed to the hourly check's restart rule/.test(rw.out),
    `narrowed sudo and PASSWORDLESS_SUDO=yes: left narrowed, no visudo, no 90-claude-nopasswd${rw.status ? `: ${rw.out.slice(-600)}` : ''}`);
  ok(!/snap remove/.test(rw.calls) && /\[ \] the installer's extra snaps are still here \(microk8s sabnzbd\): \S+remove-installer-snaps\.sh --dry-run/.test(rw.out),
    'the installer\'s snaps with no terminal and no REMOVE_INSTALLER_SNAPS: kept, and the checklist names the script');
  ok(/^pin-lan-address\.sh --static 192\.168\.20\.37 --apply$/m.test(rw.calls),
    'LAN_ADDRESS at the address the box has: made static and applied at once, since nothing moves');
  const keyFile = /^sudo tailscale up --ssh --operator=\S+ --auth-key=file:(\S+)$/m.exec(rw.calls)?.[1];
  ok(keyFile && !fs.existsSync(keyFile) && !rw.calls.includes(TS_KEY) && !rw.out.includes(TS_KEY),
    'TS_AUTHKEY: tailscale up reads it from a file, which is gone afterwards; the key is on no command line and in no output');
  const p4 = box('box-force');
  const rf = bootstrap(p4, { args: ['--new-number'], env: {
    PASSWORDLESS_SUDO: 'force', FAKE_SUDO_L: SUDO_L('(root) NOPASSWD: /usr/bin/systemctl restart whatsapp-bot'),
    LAN_ADDRESS: '192.168.20.45', FAKE_IP: '1' } });
  ok(/^sudo install -m 0440 -o root -g root \S+ \/etc\/sudoers\.d\/90-claude-nopasswd$/m.test(rf.calls),
    'PASSWORDLESS_SUDO=force: widened again, on purpose');
  const lanCalls = rf.calls.split('\n').filter((l) => l.startsWith('pin-lan-address.sh'));
  ok(lanCalls.join('|') === 'pin-lan-address.sh --static 192.168.20.45|pin-lan-address.sh --static 192.168.20.45 --apply'
    && rf.out.indexOf('Applying the static LAN address 192.168.20.45') > rf.out.indexOf('Checklist'),
  `LAN_ADDRESS at a new address: written and checked, then applied after the checklist, when the SSH session may drop (${lanCalls.join('|')})`);

  // bot-box2: the installer's featured snaps, SABnzbd on 8080. Removed on a
  // yes before install.sh, so the bot starts; kept on a no, and the start
  // waits with the script named.
  await resetBranch();
  const p5 = box('box-snaps-yes');
  const ry = bootstrap(p5, { env: { REMOVE_INSTALLER_SNAPS: 'yes', OLD_BOT_STOPPED: 'yes', FAKE_SS_HELD: '1',
    FAKE_SNAPS: 'core24 snapd canonical-livepatch microk8s sabnzbd' } });
  ok(/^sudo snap remove --purge microk8s$/m.test(ry.calls) && /^sudo snap remove --purge sabnzbd$/m.test(ry.calls)
    && !/snap remove --purge (core24|snapd|canonical-livepatch)/.test(ry.calls),
  `REMOVE_INSTALLER_SNAPS=yes: the installer's extras are removed, Ubuntu's own snaps are not${ry.status ? `: ${ry.out.slice(-600)}` : ''}`);
  ok(/snap remove --purge sabnzbd\n[\s\S]*^install\.sh$/m.test(ry.calls), 'before install.sh');
  ok(enabled(ry) && hourlyInstalled(ry), 'so 8080 is free at the start: the bot is enabled, started, and gets the hourly check');
  await resetBranch();
  const p6 = box('box-snaps-no');
  const rs = bootstrap(p6, { env: { REMOVE_INSTALLER_SNAPS: 'no', OLD_BOT_STOPPED: 'yes', FAKE_SS_HELD: '1', FAKE_SNAPS: 'microk8s sabnzbd' } });
  ok(rs.status === 0 && !/snap remove/.test(rs.calls) && /\[-\] the installer's extra snaps \(kept, as answered/.test(rs.out),
    `REMOVE_INSTALLER_SNAPS=no: they stay${rs.status ? `: ${rs.out.slice(-600)}` : ''}`);
  ok(!enabled(rs) && /not starting the bot: port 8080 is taken/.test(rs.out), 'and the bot is not started onto the taken port, even on a yes');
  ok(/\[ \] free port 8080 \(port 8080 is held by python3 \(pid 4242\), from the snap "sabnzbd"[^\n]*remove-installer-snaps\.sh removes it with the installer's other extra snaps\), then: sudo systemctl enable --now whatsapp-bot/.test(rs.out),
    'the checklist names what holds it, and the script that removes it');

  // At a terminal: the Claude token is asked for with the logins and saved at
  // once, and never asked for a second time.
  if (spawnSync('script', ['--version']).status === 0) {
    const claudeStub = (b) => put(path.join(b.home, '.local/bin/claude'), `#!/bin/sh
case "$1" in
  auth) echo '{"loggedIn": true}' ;;
  setup-token) echo 'Your OAuth token: sk-ant-oat01-PRINTED' ;;
  --version) echo '2.0.0 (Claude Code)' ;;
esac
exit 0
`, 0o755);
    // A tailscale up that fails, three steps after the token was pasted: the
    // run dies, and before this, the fresh one-year token died with it.
    const t1 = box('box-token-kept');
    claudeStub(t1);
    const rk = bootstrap(t1, { answers: ['n', 'sk-ant-oat01-TESTTOKEN'], env: { OLD_BOT_STOPPED: 'yes', FAKE_TS_FAIL: '1' } });
    const envFile = path.join(t1.home, '.config/whatsapp-bot/hourly-debug.env');
    ok(rk.status !== 0 && /tailscale up failed/.test(rk.out), `the run stops at a failed tailscale up (exit ${rk.status})`);
    ok(fs.existsSync(envFile) && /^CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-TESTTOKEN$/m.test(fs.readFileSync(envFile, 'utf8'))
      && (fs.statSync(envFile).mode & 0o777) === 0o600, 'but the token pasted before it is already saved, mode 600');

    // Enter at the token prompt: no second prompt twenty minutes later.
    await resetBranch();
    const t2 = box('box-token-skipped');
    claudeStub(t2);
    const rt = bootstrap(t2, { answers: ['n', ''], env: { OLD_BOT_STOPPED: 'yes' } });
    ok(rt.status === 0 && /Paste the token it printed/.test(rt.out) && enabled(rt) && hourlyInstalled(rt),
      `the token is asked for with the logins, and the bot still starts without one${rt.status ? `: ${rt.out.slice(-600)}` : ''}`);
    ok(!/Paste the token here/.test(rt.out) && /no token was given at the start/.test(rt.out),
      'skipped there, it is not asked for again in the part that runs by itself');
    ok((rt.out.match(/\[ \] the hourly check's Claude token: \S+ setup-token/g) ?? []).length === 1, 'it is on the checklist, once');
  } else {
    console.log('  skip the token runs: util-linux `script` is not installed');
  }
  await resetBranch();

  const src = fs.readFileSync(path.join(REPO, 'tools/bootstrap.sh'), 'utf8');
  const reads = src.split('\n').filter((l) => /\bread -rs\b/.test(l));
  ok(reads.length >= 2 && reads.every((l) => /\bIFS= read -rs\b/.test(l)),
    'every hidden passphrase read keeps leading and trailing spaces (IFS=), as backup-secrets.mjs does');
  const code = src.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
  ok(!/BACKUP_PASSPHRASE=\.\.\. tools\/bootstrap/.test(code), 'and it never suggests typing the passphrase into a command line');
  ok(/trap cleanup EXIT/.test(src) && /new_tmp\n\s+keyfile=\$NEW_TMP/.test(src), 'the Tailscale auth-key temp file is removed however the script ends');
}

fs.rmSync(T, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
