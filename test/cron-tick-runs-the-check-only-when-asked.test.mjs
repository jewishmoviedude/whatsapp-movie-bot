/* cron's tick, every minute: the hourly run on the hour, the check at once
   when the bot asked for it, and nothing - not a line - otherwise.
   Run: node test/cron-tick-runs-the-check-only-when-asked.test.mjs

   The operator, 2026-10-12: "Needless to say #issue tickets submitted by
   head admin 5558100180 get top priority" and "Meaning it should activate bot
   to send yo a notification to check right away". The bot cannot start the
   check (NoNewPrivileges; a restart kills its children), so it writes
   check-now.json in its data folder, and the installer's cron line became
   `* * * * * ... tick.sh`, which is run.sh --tick. What must hold, since it
   runs 1,440 times a day:
   - with no request and not on the hour, it ends at once, prints nothing
     (cron.log would grow by a line a minute) and starts no node - before it
     reads the settings file or anything else;
   - with a request, it runs `hourly-debug.mjs run --asked`, and --tick is
     never passed on;
   - a tick that finds a run going exits 0 silently, the request left for a
     later minute;
   - on the hour it is the hourly run exactly as before, its messages
     included; and run.sh by hand, --dry-run and verify-token are unchanged.
   And from a review of it (2026-10-12):
   - cron's line runs tick.sh, a file no older checkout has: an older run.sh
     passed --tick on to a check that ignored it, a whole run every minute;
   - a 00 tick cron runs late (woken up to five minutes late, at 01 to 04)
     is still the hour's run, as the "0 * * * *" line's was - once;
   - an asked run that failed is not tried again every minute: the request
     waits for the bot to ask again, or for the hour - and an ask the bot
     made while that run went on is asking again;
   - the night the clocks go back, the hour that comes twice is run at each
     00, as the "0 * * * *" line ran it, and not at 01 to 04 too.
   run.sh is driven with HOURLY_DEBUG_NODE at a stub that records its
   arguments, and HOURLY_DEBUG_NOW (the tests' clock, in seconds; cron never
   sets it), in UTC. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const REPO = fileURLToPath(new URL('..', import.meta.url));
const RUN_SH = path.join(REPO, 'deploy/hourly-debug/run.sh');
const TICK_SH = path.join(REPO, 'deploy/hourly-debug/tick.sh');
/** 2026-10-12, 14:<minute>:30 UTC, in seconds; `hours` later or earlier. */
const at = (minute, hours = 0) => String(Math.floor(Date.UTC(2026, 9, 12, 14 + hours, minute, 30) / 1000));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-tick-'));
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

/** A box: an app folder, its data folder, a state folder, a settings file and a node that only says what it was asked. */
function box({ envMode = 0o600 } = {}) {
  const dir = fs.mkdtempSync(path.join(ROOT, 'box-'));
  const app = path.join(dir, 'app'), data = path.join(app, 'data'), st = path.join(dir, 'st');
  fs.mkdirSync(data, { recursive: true });
  const argv = path.join(dir, 'argv');
  const node = path.join(dir, 'node');
  // STUB_ASK: the bot asks again while the check runs - the file written
  // anew, as askForCheck puts it in place.
  fs.writeFileSync(node, `#!/bin/sh\necho "$*" >> "${argv}"\n`
    + `[ -n "$STUB_ASK" ] && echo '{"v":1,"asked":[],"notBefore":null}' > "$STUB_ASK.new" && mv "$STUB_ASK.new" "$STUB_ASK"\n`
    + `echo "node: $*"\nexit \${STUB_RC:-0}\n`, { mode: 0o755 });
  const envFile = path.join(dir, 'hourly-debug.env');
  fs.writeFileSync(envFile, 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-test\n', { mode: envMode });
  fs.chmodSync(envFile, envMode);
  const env = {
    HOME: dir, PATH: '/usr/bin:/bin', HOURLY_DEBUG_APP_DIR: app, HOURLY_DEBUG_STATE_DIR: st,
    HOURLY_DEBUG_ENV_FILE: envFile, HOURLY_DEBUG_NODE: node, HOURLY_DEBUG_NOW: at(17), TZ: 'UTC',
  };
  // As cron runs it: tick.sh. `args` instead: run.sh with those.
  const tick = (extra = {}, args = null) => spawnSync('bash', args ? [RUN_SH, ...args] : [TICK_SH], { encoding: 'utf8', env: { ...env, ...extra } });
  // Holding run.lock as a run does (flock on its own open of the file), and
  // ticking meanwhile.
  const tickLocked = (extra = {}) => {
    fs.mkdirSync(st, { recursive: true });
    return spawnSync('bash', ['-c', `exec 9>"${path.join(st, 'run.lock')}"; flock -n 9 || exit 99; bash "${TICK_SH}"`],
      { encoding: 'utf8', env: { ...env, ...extra } });
  };
  const ran = () => (fs.existsSync(argv) ? fs.readFileSync(argv, 'utf8').trim().split('\n') : []);
  const ask = (where = data) => { fs.mkdirSync(where, { recursive: true }); fs.writeFileSync(path.join(where, 'check-now.json'), '{"v":1,"asked":[],"notBefore":null}\n'); };
  return { dir, app, data, st, env, tick, tickLocked, ran, ask };
}
const silent = (r) => r.stdout === '' && r.stderr === '';
const CHECK = (app) => `${app}/tools/hourly-debug.mjs`;

console.log('=== not on the hour, nothing asked: nothing at all ===');
{
  // A settings file others can read makes run.sh warn as soon as it reads
  // it: silence proves it was not read.
  const b = box({ envMode: 0o644 });
  const r = b.tick();
  ok(r.status === 0 && silent(r), `exit 0, not a byte of output (${JSON.stringify(r.stdout + r.stderr)})`);
  ok(b.ran().length === 0, 'node is not started');
  ok(!fs.existsSync(b.st), 'nor the state folder touched, nor the settings file read: it ends before anything costly');
  const sixty = Array.from({ length: 59 }, (_, i) => b.tick({ HOURLY_DEBUG_NOW: at(i + 1) }));
  ok(sixty.every((x) => x.status === 0 && silent(x)) && b.ran().length === 0, 'every minute from 01 to 59 alike');
  // The real clock, as cron runs it - unless this happens to run at the top
  // of the hour, when it would rightly be the hourly run.
  const m = new Date().getMinutes();
  if (m !== 59 && m !== 0) {
    const real = b.tick({ HOURLY_DEBUG_NOW: '', TZ: '' });
    ok(real.status === 0 && silent(real) && b.ran().length === 0, 'and on the real clock, off the hour');
  }
  const viaRunSh = b.tick({}, ['--tick']);
  ok(viaRunSh.status === 0 && silent(viaRunSh) && b.ran().length === 0, 'run.sh --tick, which tick.sh is, alike');
}

console.log('=== asked: the check runs, told it was asked ===');
{
  const b = box();
  b.ask();
  const r = b.tick();
  ok(r.status === 0 && b.ran().length === 1 && b.ran()[0] === `${CHECK(b.app)} run --asked`,
    `it runs \`hourly-debug.mjs run --asked\` (${b.ran()[0]})`);
  ok(!/--tick/.test(b.ran().join()), '--tick is never passed on');
  ok(r.stdout === 'node: ' + `${CHECK(b.app)} run --asked\n` && r.stderr === '',
    'with no line of its own: until the request is due the check is started every minute, and says something only when it runs');
  const failed = b.tick({ STUB_RC: '3' });
  ok(failed.status === 3 && /\[hourly-check\] exited 3/.test(failed.stdout), 'a check that fails is still said');

  const other = box();
  const elsewhere = path.join(other.dir, 'elsewhere');
  other.ask(elsewhere);
  ok(other.tick().status === 0 && other.ran().length === 0, 'a request in another folder is not this box\'s');
  ok(other.tick({ DATA_DIR: elsewhere }).status === 0 && other.ran().length === 1, 'the data folder is found as the check finds it: DATA_DIR');
  const third = path.join(other.dir, 'third');
  ok(other.tick({ DATA_DIR: elsewhere, HOURLY_DEBUG_DATA_DIR: third }).status === 0 && other.ran().length === 1,
    'and HOURLY_DEBUG_DATA_DIR before it');
}

console.log('=== asked while a run is going: silent, left for later ===');
{
  const b = box();
  b.ask();
  const r = b.tickLocked();
  ok(r.status === 0 && silent(r), `exit 0, nothing said (${JSON.stringify(r.stdout + r.stderr)})`);
  ok(b.ran().length === 0 && fs.existsSync(path.join(b.data, 'check-now.json')), 'no check started, and the request is still there');
}

console.log('=== on the hour: the hourly run, as before ===');
{
  const b = box();
  const r = b.tick({ HOURLY_DEBUG_NOW: at(0) });
  ok(r.status === 0 && b.ran()[0] === `${CHECK(b.app)} run`, `at minute 00, \`run\` and nothing else (${b.ran()[0]})`);
  ok(/^\[hourly-check\] \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ start\n/.test(r.stdout), `with its start line, as before (${r.stdout.split('\n')[0]})`);
  b.ask();
  b.tick({ HOURLY_DEBUG_NOW: at(0) });
  ok(b.ran()[1] === `${CHECK(b.app)} run`, 'a request waiting at the hour is the hourly run\'s to take: still `run`');
  const held = b.tickLocked({ HOURLY_DEBUG_NOW: at(0) });
  ok(held.status === 75 && /the previous run is still going - this hour is left to it/.test(held.stdout),
    'and a run still going at the hour is said, as before');
}

console.log('=== by hand: unchanged ===');
{
  const b = box();
  const plain = b.tick({}, []);
  ok(plain.status === 0 && b.ran()[0] === `${CHECK(b.app)} run` && /start\n/.test(plain.stdout), 'run.sh: the check now, whatever the minute');
  const dry = b.tick({}, ['--dry-run']);
  ok(dry.status === 0 && b.ran()[1] === `${CHECK(b.app)} run --dry-run` && /start \(--dry-run\)/.test(dry.stdout), 'run.sh --dry-run: as before');
  b.tick({}, ['verify-token']);
  ok(b.ran()[2] === `${CHECK(b.app)} verify-token`, 'run.sh verify-token: as before');
}

console.log('=== the 00 tick, run late by cron: still the hour\'s run, once ===');
{
  // cron, woken up to five minutes late (a VM or WSL paused across the
  // hour), runs the missed minutes' ticks late: the 00 tick reads 01 to 04.
  const b = box();
  b.tick({ HOURLY_DEBUG_NOW: at(0, -1) });
  ok(b.ran().length === 1, 'the hour before: its run, at 00');
  const late = b.tick({ HOURLY_DEBUG_NOW: at(3) });
  ok(late.status === 0 && b.ran()[1] === `${CHECK(b.app)} run` && /start\n/.test(late.stdout),
    `this hour's 00 tick, run at 03: the hourly run, as the "0 * * * *" line's was (${b.ran()[1]})`);
  b.tick({ HOURLY_DEBUG_NOW: at(4) });
  ok(b.ran().length === 2, 'and only once: the next tick is an ordinary minute again');
  b.tick({ HOURLY_DEBUG_NOW: at(0, 1) });
  const after = b.tick({ HOURLY_DEBUG_NOW: at(1, 1) });
  ok(b.ran().length === 3 && silent(after), 'an hour whose 00 tick came on time: 01 is an ordinary minute');

  const missed = box();
  missed.tick({ HOURLY_DEBUG_NOW: at(0, -1) });
  missed.tick({ HOURLY_DEBUG_NOW: at(5) });
  ok(missed.ran().length === 1, 'at 05 or later it is not: cron catches up only within five minutes, and so did the old line');
  const fresh = box();
  fresh.tick({ HOURLY_DEBUG_NOW: at(2) });
  ok(fresh.ran().length === 0, 'a box just installed, with no hour begun, waits for the hour as before');
  const old = box();
  old.tick({ HOURLY_DEBUG_NOW: at(0, -3) });
  old.tick({ HOURLY_DEBUG_NOW: at(2) });
  ok(old.ran().length === 1, 'nor is a run owed when the last began hours ago: cron was not running then (a reboot)');

  // A review (2026-10-12): the hours were told apart by the clock's name for
  // them, and the night the clocks go back 01:00 comes twice - so at 01:01
  // to 01:04 of the second pass the stamp read "the hour before", and each
  // tick was a whole hourly run more. In a zone that changes its clocks, as
  // a WSL box takes Windows' (the operator is in New York).
  const ny = (iso) => ({ TZ: 'America/New_York', HOURLY_DEBUG_NOW: String(Date.parse(iso) / 1000) });
  const back = box();
  for (const utc of ['05', '06']) {
    for (let m = 0; m <= 5; m++) back.tick(ny(`2026-11-01T${utc}:0${m}:30Z`));
  }
  ok(back.ran().length === 2 && back.ran().every((a) => a === `${CHECK(back.app)} run`),
    `01:00 EDT to 01:05, then 01:00 EST to 01:05: the hour's run at each 00, as the "0 * * * *" line ran it, and no more (${back.ran().length})`);
  const backLate = box();
  backLate.tick(ny('2026-11-01T05:00:30Z'));
  backLate.tick(ny('2026-11-01T06:02:30Z'));
  ok(backLate.ran().length === 2, 'the second 01:00\'s tick, run late at 01:02 EST, is still that hour\'s run');
  const forward = box();
  forward.tick(ny('2026-03-08T06:00:30Z'));
  forward.tick(ny('2026-03-08T07:02:30Z'));
  ok(forward.ran().length === 2, 'the night they go forward: 03:00 EDT\'s tick run late at 03:02, an hour after 01:00 EST\'s, is the hour\'s run');
  // Half an hour off UTC: the clock's 00 to 04 are 30 to 34 past a UTC hour.
  const india = box();
  const ist = (iso) => ({ TZ: 'Asia/Kolkata', HOURLY_DEBUG_NOW: String(Date.parse(iso) / 1000) });
  india.tick(ist('2026-10-12T04:30:30Z'));
  india.tick(ist('2026-10-12T05:31:30Z'));
  india.tick(ist('2026-10-12T05:32:30Z'));
  ok(india.ran().length === 2, 'half an hour off UTC (11:01 IST run late after 10:00): the hour\'s run, once');
  const onTime = box();
  onTime.tick(ist('2026-10-12T04:30:30Z'));
  onTime.tick(ist('2026-10-12T04:31:30Z'));
  ok(onTime.ran().length === 1, 'and 10:01 IST, after 10:00 on time, is an ordinary minute');
}

console.log('=== an asked run that failed is not tried again every minute ===');
{
  const b = box();
  b.ask();
  // Written a little before, so the comparison holds on a clock of whole
  // seconds too.
  const earlier = Date.now() / 1000 - 10;
  fs.utimesSync(path.join(b.data, 'check-now.json'), earlier, earlier);
  const failed = b.tick({ STUB_RC: '1' });
  ok(failed.status === 1 && b.ran().length === 1 && /exited 1/.test(failed.stdout), 'it fails, and says so, once');
  const next = b.tick({ HOURLY_DEBUG_NOW: at(18) });
  ok(next.status === 0 && silent(next) && b.ran().length === 1, 'the next minute: nothing at all, the request left as it is');
  ok(fs.existsSync(path.join(b.data, 'check-now.json')), 'and the request is still there, for the hour');
  // The bot asks again: it writes the file anew.
  const later = Date.now() / 1000 + 5;
  fs.utimesSync(path.join(b.data, 'check-now.json'), later, later);
  b.tick({ HOURLY_DEBUG_NOW: at(19) });
  ok(b.ran().length === 2 && b.ran()[1] === `${CHECK(b.app)} run --asked`, 'a new ask from the bot: tried again');
  ok(!fs.existsSync(path.join(b.st, 'asked-failed')), 'and a run that worked forgets the failure');

  // A review (2026-10-12): the failure was dated when the run ended, so an
  // #issue the bot asked for while the run went on - the file written anew
  // before the failure - was held back with the one that failed, until the
  // hour. The failure bears the time the request had when the run began.
  const during = box();
  during.ask();
  const req = path.join(during.data, 'check-now.json');
  fs.utimesSync(req, earlier, earlier);
  const midRun = during.tick({ STUB_RC: '1', STUB_ASK: req });
  ok(midRun.status === 1 && during.ran().length === 1 && fs.statSync(req).mtimeMs > earlier * 1000,
    'a run fails after the bot asked again while it ran');
  during.tick({ HOURLY_DEBUG_NOW: at(18), STUB_RC: '1' });
  ok(during.ran().length === 2 && during.ran()[1] === `${CHECK(during.app)} run --asked`,
    'the next minute runs for the new ask: it is not held back with the one that failed');
  const again = during.tick({ HOURLY_DEBUG_NOW: at(19) });
  ok(during.ran().length === 2 && silent(again), 'and that run failing too, with no new ask, holds the request back as before');

  const hourly = box();
  hourly.ask();
  hourly.tick({ STUB_RC: '1' });
  hourly.tick({ HOURLY_DEBUG_NOW: at(0, 1) });
  ok(hourly.ran().length === 2 && hourly.ran()[1] === `${CHECK(hourly.app)} run`, 'the hour\'s run goes ahead regardless');
  const byHand = box();
  byHand.tick({ STUB_RC: '1' }, []);
  ok(!fs.existsSync(path.join(byHand.st, 'asked-failed')), 'a run by hand that fails holds nothing up');
}

console.log('=== the installer writes the tick, through a file no older checkout has ===');
{
  const line = /^LINE="(.*)"$/m.exec(fs.readFileSync(path.join(REPO, 'deploy/install-hourly-debug.sh'), 'utf8'))?.[1] ?? '';
  ok(line === '* * * * * mkdir -p $STATE_DIR && /bin/bash $APP_DIR/deploy/hourly-debug/tick.sh >> $STATE_DIR/cron.log 2>&1 $TAG',
    `every minute, tick.sh, the same tag (${line})`);
  // An older run.sh passed --tick on to a check that ignored it: a whole run
  // every minute. An older checkout has no tick.sh, so the line runs nothing
  // there; and its routines check, which wants run.sh in the line, puts its
  // own line back.
  ok(!line.includes('run.sh'), 'the line does not name run.sh, so an older routines check sees it is not its own');
  const b = box();
  fs.mkdirSync(path.join(b.app, 'deploy', 'hourly-debug'), { recursive: true });
  fs.copyFileSync(RUN_SH, path.join(b.app, 'deploy', 'hourly-debug', 'run.sh'));
  const gone = spawnSync('bash', [path.join(b.app, 'deploy', 'hourly-debug', 'tick.sh')], { encoding: 'utf8', env: { ...b.env, HOURLY_DEBUG_NOW: at(0) } });
  ok(gone.status === 127 && b.ran().length === 0, 'in a checkout without tick.sh, the line starts no check at all');
  ok((fs.statSync(TICK_SH).mode & 0o111) !== 0, 'tick.sh is executable, as run.sh is');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
