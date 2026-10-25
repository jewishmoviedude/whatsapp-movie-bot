/* The systemd unit. Run: node test/service-unit.test.mjs

   The README told people to `sudo cp whatsapp-bot.service /etc/systemd/system/`
   and the file was never in the repo, so the documented install failed with
   "No such file or directory". This keeps the two in step.

   2026-09-29: copied as it is, the file still fails on a NodeSource box such
   as bot-box2, whose node is /usr/bin/node, not the /usr/local/bin/node it
   names (203/EXEC) - and the README's recipe enabled the bot with no word
   about the old machine (CLAUDE.md, rule 3). The README now installs it
   through deploy/install-units.sh, which renders this same file for the
   machine and never enables it. */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const unit = fs.readFileSync(new URL('../whatsapp-bot.service', import.meta.url), 'utf8');
const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');

console.log('=== the file the README installs exists, and is rendered for the machine ===');
{
  ok(unit.length > 0, 'whatsapp-bot.service is in the repo');
  const render = fs.readFileSync(new URL('../deploy/render-whatsapp-bot-unit.sh', import.meta.url), 'utf8');
  ok(/deploy\/install-units\.sh whatsapp-bot/.test(readme) && /\/whatsapp-bot\.service"$/m.test(render),
    'the README installs it with deploy/install-units.sh, whose renderer reads this file');
  ok(!/sudo cp whatsapp-bot\.service/.test(readme), 'and no longer copies it as it is, with a node path this machine may not have');
}

console.log('=== it can actually start the bot ===');
{
  ok(/ExecStart=\/usr\/local\/bin\/node src\/index\.js/.test(unit),
    'an ABSOLUTE node path — systemd does not use the login shell PATH');
  ok(/WorkingDirectory=\/home\/mommy\/whatsapp-bot/.test(unit),
    'and the working directory, which is where dotenv looks for .env');
  ok(/^User=mommy$/m.test(unit), 'runs as the owning user, not root');
}

console.log('=== no secret is copied into a world-readable file ===');
{
  // /etc/systemd/system is readable by everyone; .env is 0600.
  // The word appears in a comment explaining why it is NOT here; what must
  // not appear is an assignment.
  ok(!/^\s*(Environment=)?MASTER_KEY=/m.test(unit), 'MASTER_KEY is not assigned anywhere');
  ok(!/Environment=.*=.{16,}/.test(unit), 'and no long literal value is set as an env var');
  ok(/dotenv reads \.env from the working directory/.test(unit),
    'the comment says how the key is picked up instead');
}

console.log('=== it survives the failures this bot actually has ===');
{
  ok(/Restart=always/.test(unit), 'it restarts on exit');
  ok(/StartLimitIntervalSec=0/.test(unit),
    'and never gives up — a WhatsApp outage easily produces five failures in a row');

  // StartLimitIntervalSec is a [Unit] key. Under [Service] systemd ignores it
  // with a warning, and the rate limit silently stays in force.
  const unitSection = unit.split('[Service]')[0];
  ok(/StartLimitIntervalSec/.test(unitSection), 'declared in [Unit], where systemd reads it');
}

console.log('=== a mid-encode job is not killed instantly ===');
{
  const stop = Number(unit.match(/TimeoutStopSec=(\d+)/)?.[1] ?? 0);
  ok(stop >= 60, `${stop}s to shut down — long enough not to orphan an ffmpeg mid-file`);
  ok(/KillSignal=SIGTERM/.test(unit), 'and it is asked to stop, not shot');
}

console.log('=== every start pulls updates first, and a failed pull never stops it ===');
{
  // Boxes used to stay on the commit they were cloned at until somebody
  // pulled by hand. See test/auto-update.test.mjs for what the script does.
  const pre = unit.match(/^ExecStartPre=(.*)$/m)?.[1] ?? '';
  ok(/deploy\/auto-update\.sh/.test(pre), `ExecStartPre runs deploy/auto-update.sh (${pre})`);
  ok(pre.startsWith('-'), 'prefixed "-", so even a crash of the updater leaves the bot to start');
  ok(/^-\/(usr\/)?bin\/bash deploy\/auto-update\.sh$/.test(pre),
    'through bash and relative to WorkingDirectory, so it needs no per-machine edit and no executable bit');
  ok(unit.indexOf('ExecStartPre=') < unit.indexOf('ExecStart=/'), 'and it is declared next to ExecStart, before it');

  // A dependency install inside ExecStartPre counts against the start
  // timeout. Killed at the default 90s, it would be retried every 10s forever.
  const t = unit.match(/^TimeoutStartSec=(\d+)(min|s)?$/m);
  const secs = t ? Number(t[1]) * (t[2] === 'min' ? 60 : 1) : 0;
  const script = fs.readFileSync(new URL('../deploy/auto-update.sh', import.meta.url), 'utf8');
  const npmCap = Number(script.match(/NPM_TIMEOUT=\$\{AUTO_UPDATE_NPM_TIMEOUT:-(\d+)\}/)?.[1] ?? Infinity);
  const attempts = Number(script.match(/FETCH_ATTEMPTS=\$\{AUTO_UPDATE_FETCH_ATTEMPTS:-(\d+)\}/)?.[1] ?? Infinity);
  const fetchCap = Number(script.match(/FETCH_TIMEOUT=\$\{AUTO_UPDATE_FETCH_TIMEOUT:-(\d+)\}/)?.[1] ?? Infinity);
  const delays = (script.match(/AUTO_UPDATE_RETRY_DELAYS:-([\d ]+)\}/)?.[1] ?? '').trim().split(/\s+/).map(Number);
  const worst = npmCap + 10 + attempts * (fetchCap + 5) + delays.reduce((a, b) => a + b, 0) + 60;
  ok(secs >= worst, `TimeoutStartSec=${secs}s outlasts the updater's own worst case (${worst}s)`);

  const rendered = spawnSync('bash', [fileURLToPath(new URL('../deploy/render-whatsapp-bot-unit.sh', import.meta.url)),
    'someone', 'staff', '/srv/bot', '/usr/bin/node'], { encoding: 'utf8' }).stdout;
  ok(/^ExecStartPre=-\/(usr\/)?bin\/bash deploy\/auto-update\.sh$/m.test(rendered) && /^WorkingDirectory=\/srv\/bot$/m.test(rendered),
    'the unit rendered for another machine keeps the update step, pointed at that machine\'s checkout');
}

console.log('=== it does not lock the bot out of its own files ===');
{
  // ProtectHome would hide /home/mommy/whatsapp-bot from the service.
  ok(!/ProtectHome=(yes|read-only)/.test(unit), 'ProtectHome is not set');
  ok(/NoNewPrivileges=true/.test(unit), 'but privileges cannot be escalated');
}

console.log('=== the README explains restarting safely ===');
{
  ok(/## Starting, stopping and rebooting/.test(readme), 'there is a section for it');
  ok(/queue-status/.test(readme), 'it shows how to ask whether a restart is safe');
  ok(/safeToRestart/.test(readme), 'and what to look for in the answer');
  ok(/also matches the shell you are typing it in/.test(readme),
    'it warns about pkill -f matching your own shell, which has killed the bot here');
  ok(/there is nothing to start it/.test(readme),
    'and that without the service a reboot leaves the bot down');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
