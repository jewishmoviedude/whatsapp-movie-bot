/* The one paste that builds a new VM, and the documents that lead to it.
   Run: node test/one-paste-setup.test.mjs

   2026-09-29, the operator: "the repo setup guide for a new vm should have
   one script I can copy and paste into the ssh and all steps will be done at
   once, only things that need to be separate are the gh and claude logins".
   The block went into docs/server-setup.md, and a review of it found: the
   README's Install section and CLAUDE.md still sent a new box down the old
   manual path (the README's `sudo cp whatsapp-bot.service` fails with
   203/EXEC on a NodeSource box, and enables the bot with no rule-3 check);
   under the block's `set -e`, a failed `apt-get update && apt-get install`
   was ignored and a failed `curl | sudo dd` left an empty apt key; apt-get
   fails at once while the boot-time apt jobs hold the lock, which on bot-box2
   they did five seconds after the first boot; and the setup guide said six
   suites fail on a production install where CLAUDE.md, rightly, says twelve.

   This checks the block itself (it parses, stops at the first failure,
   waits for apt, clones where the service expects), that every answer it
   tells the reader to set is one bootstrap.sh reads, and that the documents
   a new session or a person reads first point at it. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const setup = read('docs/server-setup.md');
const HEADING = '## One paste: a new VM in one go';
const ANCHOR = 'docs/server-setup.md#one-paste-a-new-vm-in-one-go';

const at = setup.indexOf(`\n${HEADING}\n`);
const section = at < 0 ? '' : setup.slice(at + 1, setup.indexOf('\n## ', at + HEADING.length + 2));
const block = /```bash\n([\s\S]*?)\n```/.exec(section)?.[1] ?? '';
const code = block.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

console.log('=== the block ===');
{
  ok(at > 0 && at < setup.indexOf('## Fast path'), 'the one-paste section comes first in docs/server-setup.md');
  ok(block.length > 200, 'and has a bash block');
  const parse = spawnSync('bash', ['-n'], { input: block, encoding: 'utf8' });
  ok(parse.status === 0, `the block parses${parse.status ? `: ${parse.stderr}` : ''}`);
  ok(/^\(\n/.test(block) && /\n\)$/.test(block), 'it is one ( ... ) command, so the shell reads the whole paste before anything runs');
  ok(/^\s*set -eo pipefail$/m.test(block), 'it stops at the first failure, one inside a pipe included');
  // Under set -e, a failure on the left of && is ignored: the install that
  // failed went unnoticed until `gh: command not found`.
  ok(!/apt-get[^\n]*&&/.test(code), 'no apt-get is hidden on the left of an &&');
  ok(!/\|\s*sudo dd\b/.test(code) && /\[ -s "\$K" \]/.test(code), 'the apt key is downloaded to a file and checked, not piped into dd');
  const aptLines = code.split('\n').filter((l) => /\bapt-get\b/.test(l));
  ok(aptLines.length >= 4 && aptLines.every((l) => /-o DPkg::Lock::Timeout=\d+/.test(l)),
    `every apt-get waits for the lock (${aptLines.length} of them)`);
  ok(/while sudo fuser \/var\/lib\/dpkg\/lock-frontend/.test(code) && code.indexOf('fuser') < code.indexOf('apt-get'),
    'and it waits for the boot-time apt jobs before the first one');
  ok(/gh repo clone your-github-user\/whatsapp-bot ~\/whatsapp-bot/.test(code) && /cd ~\/whatsapp-bot/.test(code),
    'it clones to ~/whatsapp-bot, the path the service expects');
  ok(/gh auth login --hostname github\.com --git-protocol https --web/.test(code) && (code.match(/gh auth login/g) ?? []).length === 1,
    'the GitHub login is the one login in the block itself');
  ok(/^\s*PASSWORDLESS_SUDO=yes tools\/bootstrap\.sh$/m.test(code) && /^\s*node tools\/routines\.mjs$/m.test(code),
    'then bootstrap does the rest, and the routines are checked last');
  ok(!/OLD_BOT_STOPPED=yes/.test(code), 'and it never answers "is the old bot stopped?" for the reader (CLAUDE.md, rule 3)');
}

console.log('=== every answer the section names is one bootstrap reads ===');
{
  const help = spawnSync('bash', [path.join(REPO, 'tools/bootstrap.sh'), '--help'], { encoding: 'utf8' });
  ok(help.status === 0, 'tools/bootstrap.sh --help works');
  const named = new Set([
    ...[...section.matchAll(/\b([A-Z][A-Z0-9_]{4,})=/g)].map((m) => m[1]),
    ...[...section.matchAll(/\bexport ([A-Z][A-Z0-9_]{4,})\b/g)].map((m) => m[1]),
  ]);
  const unknown = [...named].filter((v) => !help.stdout.includes(v));
  ok(unknown.length === 0, `each variable it tells the reader to set is in --help (${[...named].join(', ')})${unknown.length ? ` - not: ${unknown.join(', ')}` : ''}`);
  const answers = ['BACKUP_PASSPHRASE', 'REMOVE_INSTALLER_SNAPS', 'OLD_BOT_STOPPED', 'LAN_ADDRESS', 'PASSWORDLESS_SUDO', 'TS_AUTHKEY'];
  const missing = answers.filter((v) => !section.includes(v) || !help.stdout.includes(v));
  ok(missing.length === 0, `and every question can be answered in advance, documented in both${missing.length ? ` - not: ${missing.join(', ')}` : ''}`);
  ok(/\bforce\b/.test(help.stdout) && /PASSWORDLESS_SUDO=force/.test(section), 'the narrowed-sudo exception is in both too');
}

console.log('=== bootstrap and install.sh wait for apt as well ===');
{
  const boot = read('tools/bootstrap.sh');
  const bootCode = boot.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  ok(/^APT=\(sudo apt-get -o DPkg::Lock::Timeout=600\)$/m.test(boot), 'bootstrap has one apt-get that waits for the lock');
  ok(!/\bsudo apt-get\b/.test(bootCode.replace(/^APT=\(sudo apt-get [^\n]*$/m, '')), 'and uses it for every apt-get');
  ok(/wait_for_apt\nrun env BOOTSTRAP=1 "\$APP_DIR\/install\.sh"/.test(boot), 'and waits for the boot-time jobs before install.sh');
  const inst = read('install.sh');
  const instApt = inst.split('\n').filter((l) => /apt-get/.test(l) && !/^\s*#/.test(l));
  ok(instApt.length >= 1 && instApt.every((l) => /APT=\(sudo apt-get -o DPkg::Lock::Timeout=\d+\)/.test(l)) && /"\$\{APT\[@\]\}" install -y nodejs/.test(inst),
    'install.sh\'s apt-get calls wait for the lock too');
}

console.log('=== what a new session or a person reads first points at it ===');
{
  const readme = read('README.md');
  const install = /^## Install\n([\s\S]*?)\n## /m.exec(readme)?.[1] ?? '';
  ok(install.includes(`(${ANCHOR})`) && install.indexOf(ANCHOR) < install.indexOf('./install.sh'),
    'README\'s Install section opens with the one paste');
  ok(!/sudo cp whatsapp-bot\.service/.test(readme) && /deploy\/install-units\.sh whatsapp-bot/.test(install),
    'and no longer copies the checked-in unit (/usr/local/bin/node: 203/EXEC on a NodeSource box); it renders it');
  ok(/only once no other machine runs this WhatsApp\s+number/.test(install) && /rule 3/.test(install),
    'and enables the bot only after saying why that waits for the old machine');
  ok(read('CLAUDE.md').includes(`(${ANCHOR})`), 'CLAUDE.md links the one paste');
  ok(/One paste: a new VM in one go/.test(read('install.sh')) && !/render-whatsapp-bot-unit\.sh[^\n]*\n[^\n]*\| sudo tee/.test(read('install.sh')),
    'install.sh points at it too, and no longer suggests a render | sudo tee that can leave an empty (masked) unit');
}

console.log('=== the suites expected to fail on a production box: one list ===');
{
  // CLAUDE.md's table is the one kept current; server-setup.md said six.
  const listed = (text) => {
    const row = text.split('\n').find((l) => /^\| `npm install --omit=dev`/.test(l)) ?? '';
    return [...row.matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1])
      .filter((n) => !['content-export', 'rules-freshness', 'linkedom'].includes(n)).sort();
  };
  const claude = listed(read('CLAUDE.md'));
  const docs = listed(setup);
  // Thirteen since the Wanted card's own panel suite (wanted-panel, 2026-10-11).
  ok(claude.length === 13 && docs.join() === claude.join(), `server-setup.md lists the same thirteen as CLAUDE.md (${docs.length})`);
  // A static import, or an await import() outside a try: either fails the
  // suite outright without linkedom (rating-override-panel's is in a try).
  const needs = (t) => /^import [^\n]*from 'linkedom'/m.test(t) || /^\s*const [^\n]*= await import\('linkedom'\)/m.test(t);
  const onDisk = fs.readdirSync(path.join(REPO, 'test')).filter((f) => f.endsWith('.test.mjs') && f !== 'one-paste-setup.test.mjs')
    .filter((f) => needs(fs.readFileSync(path.join(REPO, 'test', f), 'utf8')))
    .map((f) => f.replace('.test.mjs', '')).sort();
  ok(onDisk.join() === claude.join(), `and they are the suites that import linkedom (${onDisk.length})`);
  ok(/expect 15 failures/.test(setup), 'with the count to match');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
