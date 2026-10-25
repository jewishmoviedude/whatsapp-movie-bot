/* The hourly check never writes, or reads, through a link somebody put in
   its run folder.
   Run: node test/hourly-check-never-follows-a-link-in-the-run-folder.test.mjs

   Found in review (2026-10-12), while the operator's request of that day
   ("Needless to say #issue tickets submitted by head admin 5558100180 get top
   priority" and "Meaning it should activate bot to send yo a notification
   to check right away") was being built. The research session runs
   sandboxed, but its run folder is its to write, and the check - outside
   the sandbox - writes there while and after it runs: report.md,
   ship-result.json, claude-output.json. writeText() wrote
   `<file>.<pid>.tmp` with writeFileSync, which follows a symlink; a session
   that read the check's pid from /proc and put a link by that name had the
   check overwrite whatever it named with the session's own report:
   ~/.ssh/authorized_keys, ~/.bashrc, the crontab, or data/check-now.json -
   a run every minute. And report.md, read with readFileSync, could be a link
   to data/session/creds.json or a key, which the check then put in the
   report it emails and keeps in data/, where the next session reads.
   What must hold:
   - a link, or a hard link, at any name the write once used is never
     written through, and `file` itself, a link, is replaced, not followed;
   - a file the session could have written is read only when it is a plain
     file of its own: not a link, not a hard link, not a FIFO (whose open
     would hang the check), not a directory;
   - through a whole run, with all of them planted: nothing outside the run
     folder changes, and nothing it names reaches the report or the email. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeText, writeJson, readOwnFile, readOwnJson, readReport, runDir, runIdFor } from '../src/core/hourly-checks.js';
import { settings, hourlyRun } from '../tools/hourly-debug.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'run-folder-links-'));
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));
const fresh = () => fs.mkdtempSync(path.join(ROOT, 'd-'));
const read = (f) => fs.readFileSync(f, 'utf8');

console.log('=== writeText and writeJson never write through a link ===');
{
  const dir = fresh();
  const outside = path.join(dir, 'authorized_keys');
  fs.writeFileSync(outside, 'ssh-ed25519 AAAA the owner\n');
  const runFolder = path.join(dir, 'run');
  fs.mkdirSync(runFolder);
  const report = path.join(runFolder, 'report.md');
  // The name the write used to use, as a link and as a hard link.
  fs.symlinkSync(outside, `${report}.${process.pid}.tmp`);
  writeText(report, '# Hourly check\n\nssh-ed25519 AAAA the session\n');
  ok(read(outside) === 'ssh-ed25519 AAAA the owner\n', 'a link at the old temporary name: the file it names is not written');
  ok(read(report).includes('the session') && fs.lstatSync(report).isFile(), 'and the report is written where it belongs');

  const hard = path.join(runFolder, 'ship-result.json');
  fs.linkSync(outside, `${hard}.${process.pid}.tmp`);
  writeJson(hard, { state: 'done' });
  ok(read(outside) === 'ssh-ed25519 AAAA the owner\n' && JSON.parse(read(hard)).state === 'done', 'a hard link there: the same');

  // `file` itself a link: replaced, not followed.
  const victim = path.join(dir, 'bashrc');
  fs.writeFileSync(victim, 'the owner\'s\n');
  const out = path.join(runFolder, 'claude-output.json');
  fs.symlinkSync(victim, out);
  writeText(out, '{"result":"x"}');
  ok(read(victim) === 'the owner\'s\n' && !fs.lstatSync(out).isSymbolicLink() && read(out) === '{"result":"x"}',
    'the file a link: the link is replaced by the file, what it named left alone');
  ok(fs.readdirSync(runFolder).filter((n) => /\.[0-9a-f]{12}\.tmp$/.test(n)).length === 0, 'and no temporary file is left behind');
  ok((fs.statSync(report).mode & 0o077) === 0, 'readable only by the bot\'s user, as before');
}

console.log('=== readOwnFile reads a plain file of its own, and nothing else ===');
{
  const dir = fresh();
  const secret = path.join(dir, 'creds.json');
  fs.writeFileSync(secret, '{"summary":"noiseKey: the WhatsApp session"}');
  const plain = path.join(dir, 'report.md');
  fs.writeFileSync(plain, '# the session\'s report\n');
  ok(readOwnFile(plain) === '# the session\'s report\n', 'a plain file: read');
  const link = path.join(dir, 'result.json');
  fs.symlinkSync(secret, link);
  ok(readOwnFile(link) === null && readOwnJson(link, 'none') === 'none', 'a link: not read, not followed');
  const hard = path.join(dir, 'restart.json');
  fs.linkSync(secret, hard);
  ok(readOwnFile(hard) === null, 'a hard link to a file elsewhere: not read');
  const fifo = path.join(dir, 'fifo.md');
  const mk = spawnSync('mkfifo', [fifo]);
  if (mk.status === 0) {
    const t = Date.now();
    ok(readOwnFile(fifo) === null && Date.now() - t < 2000, 'a FIFO: not read, and the check does not hang on it');
  } else {
    console.log('  skip no mkfifo here');
  }
  ok(readOwnFile(dir) === null && readOwnFile(path.join(dir, 'none')) === null, 'a directory, or nothing: null');
  ok(readOwnFile(plain, 4) === '# th', 'and no more than it is asked for');
  ok(readOwnJson(path.join(dir, 'report.md'), 'bad') === 'bad', 'readOwnJson: text that does not parse is the fallback');

  // The panel's view of a report: a run that ended before writing its own
  // leaves what the session put there.
  const data = fresh();
  const id = '20261012T140000Z';
  fs.mkdirSync(runDir(data, id), { recursive: true });
  fs.symlinkSync(secret, path.join(runDir(data, id), 'report.md'));
  ok(readReport(data, id) === null, 'the panel does not show a report that is a link');
}

console.log('=== a whole run, with links planted in its folder ===');
{
  const dir = fresh();
  const app = path.join(dir, 'app'), data = path.join(app, 'data');
  fs.mkdirSync(path.join(data, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(app, '.env'), 'MASTER_KEY=test-master-key-0123456789\n');
  const HEAD = '15558100180';
  const DISCUSSIONS = '120363900000000002@g.us';
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
    web: { sessionSecret: 's' }, media: { workDir: path.join(dir, 'media') },
    email: { enabled: true, provider: 'gmail', user: 'owner@example.com', appPassword: 'app-password-xyz' },
    libraryNews: { senders: [HEAD], groups: [DISCUSSIONS] },
  }));
  fs.writeFileSync(path.join(data, 'state.json'), '{}');
  const T0 = Date.parse('2026-10-12T14:00:00Z');
  fs.appendFileSync(path.join(data, 'library-news.jsonl'), `${JSON.stringify({
    kind: 'issue', keeper: true, at: T0 - 5 * 60_000, id: 'R1', group: DISCUSSIONS, groupName: '06 MOVIE DISCUSSIONS', sender: HEAD, name: 'Head Admin', text: '#issue the encode on X2 is green',
  })}\n`);
  const s = settings({ HOME: dir, HOURLY_DEBUG_APP_DIR: app, HOURLY_DEBUG_STATE_DIR: path.join(dir, 'state'), HOURLY_DEBUG_CLAUDE_BIN: path.join(dir, 'no-claude') });

  // What a session leaves for the check, in the folder of the run to come.
  const folder = runDir(data, runIdFor(T0));
  fs.mkdirSync(folder, { recursive: true });
  const victim = path.join(dir, 'authorized_keys');
  fs.writeFileSync(victim, 'ssh-ed25519 AAAA the owner\n');
  const secret = path.join(dir, 'id_ed25519');
  fs.writeFileSync(secret, '-----BEGIN OPENSSH PRIVATE KEY----- the owner\'s key\n');
  fs.symlinkSync(victim, path.join(folder, `report.md.${process.pid}.tmp`));
  fs.symlinkSync(path.join(data, 'check-now.json'), path.join(folder, `dossier.json.${process.pid}.tmp`));
  fs.symlinkSync(secret, path.join(folder, 'report.md'));
  fs.symlinkSync(secret, path.join(folder, 'result.json'));

  const mails = [];
  const r = await hourlyRun(s, {
    now: () => T0, out: () => {},
    exec: async (cmd) => ({ code: cmd === 'sudo' ? 1 : 0, stdout: '', stderr: '' }),
    gitExec: async () => ({ code: 0, stdout: '' }),
    ask: async () => null,
    mail: async (cfg, m) => { mails.push(m); },
  });
  const report = readReport(data, r.id) ?? '';
  ok(!r.skipped && r.result.incidents.length > 0, 'the run runs, with something to report');
  ok(read(victim) === 'ssh-ed25519 AAAA the owner\n', 'nothing outside the run folder is written through a planted link');
  ok(!fs.existsSync(path.join(data, 'check-now.json')), 'nor a request for a check at once made, which would start a run');
  ok(!report.includes('PRIVATE KEY') && !mails.some((m) => String(m.text).includes('PRIVATE KEY')),
    'what a planted report.md names is in neither the report nor the email');
  ok(fs.lstatSync(path.join(folder, 'report.md')).isFile() && /TOP PRIORITY|Head Admin/.test(report), 'the report is the check\'s own, written in place of the link');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
