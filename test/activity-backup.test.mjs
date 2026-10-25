/* The daily activity backup. Run: node test/activity-backup.test.mjs

   Runtime state under data/ is the only record of what happened here - who
   asked for what, what was refused, what each admin did - and it is capped and
   rotated: history at 500 rows, debug logs pruned after fourteen days. So the
   record of a dispute expires before anybody looks for it. This writes the day
   into git once, at midnight New York, and git keeps it.

   The assertion that matters most is the negative one: credentials never go in
   as plaintext. data/session/creds.json holds the private keys that let anyone
   send as this number, and data/config.json holds every API key and admin
   password hash. They are backed up - a new machine needs them to avoid a full
   re-setup - but sealed under a passphrase, because MASTER_KEY and the data it
   encrypts must not sit in one repository, and git history is permanent. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectActivity, summarise, writeDay, sealSecrets, openSecrets,
  isDue, nyDayKey, nyHour,
} from '../src/core/activity-backup.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

/** The slice of the state store the collector uses. */
function fakeStore(data) {
  return {
    namespace: (n) => ({ get: (k, d) => (data[n] && k in data[n] ? data[n][k] : d) }),
  };
}

const STATE = {
  'movie-requests': {
    history: [
      { id: 'm1', title: 'Dune', year: 2021, status: 'sent', requester: 'Avi', requesterNumberDisplay: '+1 555 111 2222' },
      { id: 'm2', title: 'Saw', status: 'blocked-rating' },
      { id: 'm3', title: 'Wicked', status: 'not-in-library' },
    ],
    wanted: [{ title: 'Wicked', count: 2 }],
    'library-misses': [{ kind: 'movie', title: 'Wicked' }],
    'cooldown:123@lid': 1700000000,
  },
  'tv-requests': {
    history: [{ id: 't1', title: 'The Boys', season: 1, status: 'sent' }],
    'library-misses': [{ kind: 'tv', title: 'Kitchen Nightmares' }],
    'cooldown:456@lid': 1700000001,
  },
  audit: { events: [{ ts: 1, user: 'superadmin', action: 'login' }] },
  'member-activity': { members: { 'a@lid': { messages: 12 } } },
  'group-activity': { events: [{ action: 'join' }] },
  'msg-index': { entries: [{ id: 'x' }] },
  catalogue: { at: 1, clean: 5152, scanned: 10000, skipped: 2 },
};

console.log('=== it collects both plugins, not just movies ===');
{
  const a = collectActivity(fakeStore(STATE), { bannedNumbers: ['15551234567'], lockdown: { alwaysLocked: ['g@g.us'] } });
  ok(a.movies.history.length === 3, 'movie history');
  // Forgetting the TV half is the recurring bug in this codebase.
  ok(a.tv.history.length === 1, 'TV history too');
  ok(a.audit.length === 1, 'portal audit log');
  ok(a.bannedNumbers.length === 1 && a.alwaysLocked.length === 1, 'moderation state travels with it');
  ok(a.messageIndex.length === 1 && Object.keys(a.members).length === 1, 'members and message index');
}

console.log('=== full detail is kept, including numbers ===');
{
  // A record with the identities stripped cannot answer the questions it
  // exists to answer, so nothing is redacted.
  const a = collectActivity(fakeStore(STATE), {});
  const dune = a.movies.history.find((h) => h.title === 'Dune');
  ok(dune.requester === 'Avi', 'requester name kept');
  ok(dune.requesterNumberDisplay === '+1 555 111 2222', 'and their number');
}

console.log('=== per-user cooldowns are dropped ===');
{
  // Keyed by JID and pure noise: they say when somebody last spoke, not what
  // happened.
  const a = collectActivity(fakeStore(STATE), {});
  const keys = Object.keys(a.movies).concat(Object.keys(a.tv));
  ok(!keys.some((k) => k.startsWith('cooldown:')), 'no cooldown keys in the record');
}

console.log('=== a day is written as readable files ===');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wabkp-'));
  const a = collectActivity(fakeStore(STATE), { bannedNumbers: ['15551234567'] });
  const logFile = path.join(dir, `debug-${a.day}.log`);
  fs.writeFileSync(logFile, 'a log line\n');

  const files = writeDay(dir, a, { logFile });
  const at = (n) => path.join(dir, 'records', a.day, n);

  ok(fs.existsSync(at('movie-requests.json')), 'movie-requests.json');
  ok(fs.existsSync(at('tv-requests.json')), 'tv-requests.json');
  ok(fs.existsSync(at('audit.json')), 'audit.json');
  ok(fs.existsSync(at('library-misses.json')), 'library-misses.json');
  ok(fs.existsSync(at('moderation.json')), 'moderation.json');
  ok(fs.existsSync(at(`debug-${a.day}.log.gz`)), "the day's debug log, gzipped");
  ok(files.every((f) => f.startsWith(`records/${a.day}/`)), 'all under records/<day>/');

  const misses = JSON.parse(fs.readFileSync(at('library-misses.json'), 'utf8'));
  ok(misses.length === 2, 'movie and TV misses are merged into one file');

  const sum = fs.readFileSync(at('summary.md'), 'utf8');
  ok(/Movie requests on record \| 3/.test(sum), 'the summary counts requests');
  ok(/not in library \| 1/.test(sum), 'and breaks them down by outcome');

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('=== NO credential ever lands in the record as plaintext ===');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wabkp-'));
  // A config carrying every kind of secret this bot holds.
  const config = {
    bannedNumbers: ['15551234567'],
    omdb: { apiKey: 'OMDBSECRET123' },
    library: { jellyfin: { accessToken: 'JELLYFINTOKEN456' } },
    web: { admins: [{ username: 'superadmin', passwordHash: 'scrypt:aaa:bbb' }], sessionSecret: 'SESSIONSECRET789' },
    email: { appPassword: 'MAILPASS000' },
  };
  const a = collectActivity(fakeStore(STATE), config);
  writeDay(dir, a);

  const blob = fs.readdirSync(path.join(dir, 'records', a.day))
    .map((f) => fs.readFileSync(path.join(dir, 'records', a.day, f), 'utf8')).join('\n');

  for (const secret of ['OMDBSECRET123', 'JELLYFINTOKEN456', 'SESSIONSECRET789', 'MAILPASS000', 'scrypt:aaa:bbb']) {
    ok(!blob.includes(secret), `${secret.slice(0, 12)}… is not in the record`);
  }
  // The banned list IS a moderation record and is meant to be there.
  ok(blob.includes('15551234567'), 'but the banned-number list is, deliberately');

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('=== the secrets bundle is sealed, not stored ===');
{
  const plain = Buffer.from('noiseKey signedIdentityKey advSecretKey MASTER_KEY=deadbeef');
  const blob = sealSecrets(plain, 'correct horse battery staple');

  ok(blob.subarray(0, 6).toString() === 'WABKP1', 'tagged so restore can recognise it');
  ok(!blob.includes(plain), 'the plaintext does not survive in the ciphertext');
  ok(openSecrets(blob, 'correct horse battery staple').equals(plain), 'round trips with the right passphrase');

  let refused = false;
  try { openSecrets(blob, 'not the passphrase'); } catch { refused = true; }
  ok(refused, 'and refuses the wrong one');

  // Tampering must fail too - GCM authenticates, it does not just decrypt.
  const bent = Buffer.from(blob); bent[bent.length - 1] ^= 0xff;
  let caught = false;
  try { openSecrets(bent, 'correct horse battery staple'); } catch { caught = true; }
  ok(caught, 'a modified bundle is rejected rather than silently mangled');

  // Two seals of the same input must differ, or the ciphertext leaks equality.
  ok(!sealSecrets(plain, 'correct horse battery staple').equals(blob), 'a fresh salt and IV each time');

  let weak = false;
  try { sealSecrets(plain, 'hunter2'); } catch { weak = true; }
  ok(weak, 'a short passphrase is refused outright');
}

console.log('=== midnight, measured in New York ===');
{
  // The box runs UTC. Using the server clock would fire at 8pm local.
  ok(/^\d{4}-\d{2}-\d{2}$/.test(nyDayKey()), 'day key is YYYY-MM-DD');
  const t = Date.UTC(2026, 8, 10, 3, 30);      // 03:30 UTC = 23:30 the previous day in NY
  ok(nyDayKey(t) === '2026-09-09', 'an early-hours UTC timestamp is still yesterday in New York');
  ok(nyHour(t) === 23, `and 23:00 there (${nyHour(t)})`);

  ok(isDue({ enabled: true, hour: 0 }, { now: t, lastRun: null }) === true, 'due when it has never run');
  ok(isDue({ enabled: true, hour: 0 }, { now: t, lastRun: '2026-09-09' }) === false, 'not twice in one day');
  ok(isDue({ enabled: false, hour: 0 }, { now: t, lastRun: null }) === false, 'never when disabled');
  // A restart at 6am must still write the day rather than losing it.
  const sixAm = Date.UTC(2026, 8, 10, 10, 0);
  ok(isDue({ enabled: true, hour: 0 }, { now: sixAm, lastRun: null }) === true,
    'a bot asleep at midnight still writes the day when it wakes');
}

console.log('=== the summary survives an empty day ===');
{
  const a = collectActivity(fakeStore({}), {});
  const s = summarise(a);
  ok(/Movie requests on record \| 0/.test(s), 'zeroes rather than throwing');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
