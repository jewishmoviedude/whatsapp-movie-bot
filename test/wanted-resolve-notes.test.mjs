/* A film on the Wanted list can be marked resolved, and carries admins' notes.
   Run: node test/wanted-resolve-notes.test.mjs

   The operator, 2026-10-11, looking at the panel's Wanted list: "give me a
   mark as resolved so other admins and you know as well as a box to add notes
   for you to review on the hour". Until then an entry could only vanish -
   when somebody asked again and the film was found, or the whole list was
   cleared - so no admin could tell another "I have dealt with this one", and
   nobody could leave word about a film for the hourly check.

   Pinned here (src/core/wanted.js, src/web/api.js, server.js, the digest):
   - resolving stores who and when on the entry, takes it off the open list
     and puts it on the resolved one; reopening puts it back;
   - a note is { id, by, at, text }, at most 2000 characters, at most 20 to a
     film (the 21st is refused, never an old one dropped); its author can
     delete it, the super-admin any;
   - a resolved entry is kept 30 days, then pruned;
   - a resolved film asked for again, still not on the server, is open again,
     counted, with the bot's note "asked again after it was resolved by ...";
   - the daily summary lists only the open films, and says how many were
     resolved since the last summary; the activity record counts them apart;
   - POST /api/wanted/:key/resolve and /reopen, POST and DELETE notes: signed
     in only, audited by the admin's name, a key URL-encoded (an IMDb id, or
     "title|year", slashes and all), 404 for a key not on the list, and every
     change pushed over SSE as 'wanted' so another admin's open card reloads. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import {
  recordWanted, resolveWanted, reopenWanted, addWantedNote, deleteWantedNote, pruneWanted, listWanted,
  listResolvedWanted, findWanted, wantedKey, formatWanted, wantedEvents, MAX_NOTES, MAX_NOTE_CHARS, RESOLVED_KEEP_MS,
} from '../src/core/wanted.js';
import { DailyDigest, buildDigest } from '../src/core/daily-digest.js';
import { summarise } from '../src/core/activity-backup.js';
import { JobQueue } from '../src/core/queue.js';
import { createServer } from '../src/web/server.js';
import { ConfigStore } from '../src/config/store.js';
import { hashPassword } from '../src/util/crypto.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wanted-resolve-notes-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-11T14:05:00Z');
const DUNE = { title: 'Dune', year: 1984, imdbId: 'tt0087182', rated: 'PG-13' };
const WICKED = { title: 'Wicked', year: 2024, imdbId: 'tt1262426', rated: 'PG' };
const BAREFOOT = { title: 'Barefoot', year: 2014 };                      // no IMDb id: keyed "barefoot|2014"
const ACDC = { title: 'AC/DC: Let There Be Rock', year: 1980 };         // a slash in its key

function memStore(data = {}) {
  return {
    data,
    get: (k, d = null) => (k in data ? data[k] : d),
    set: (k, v) => { data[k] = v; return v; },
    delete: (k) => { delete data[k]; },
    push: (k, v, cap = 200) => { (data[k] ??= []).unshift(v); if (data[k].length > cap) data[k].length = cap; },
    flush: () => true,
  };
}

/* ------------------------------ wanted.js ------------------------------ */

console.log('=== mark resolved, and reopen ===');
{
  const s = memStore();
  recordWanted(s, DUNE, { requester: 'Mia', request: 'dune 1984', now: T0 - DAY });
  const w = resolveWanted(s, 'tt0087182', { by: 'mommy', at: T0 });
  ok(w?.resolved?.by === 'mommy' && w.resolved.at === T0 && !w.resolved.auto, 'stored on the entry: who and when');
  ok(listWanted(s).length === 0, 'off the open list');
  ok(listResolvedWanted(s, { now: T0 }).map((x) => x.key).join() === 'tt0087182', 'and on the resolved one');
  ok(findWanted(s, 'tt0087182')?.count === 1, 'kept, with what it was');
  ok(resolveWanted(s, 'tt0087182', { by: 'david' }) === null && findWanted(s, 'tt0087182').resolved.by === 'mommy',
    'resolving it again changes nothing');
  ok(resolveWanted(s, 'tt9999999', { by: 'mommy' }) === null, 'a key not on the list resolves nothing');
  ok(reopenWanted(s, 'tt0087182')?.resolved === undefined && listWanted(s).length === 1, 'Reopen puts it back on the open list');
  ok(reopenWanted(s, 'tt0087182') === null, 'and an open entry cannot be reopened');

  recordWanted(s, WICKED, { requester: 'Sara', now: T0 });
  resolveWanted(s, 'tt0087182', { by: 'mommy', at: T0 + 1000 });
  resolveWanted(s, 'tt1262426', { by: 'the bot (found on the server as "Wicked")', at: T0 + 2000, auto: true, as: { title: 'Wicked' } });
  ok(listResolvedWanted(s, { now: T0 + 3000 }).map((x) => x.title).join() === 'Wicked,Dune', 'the resolved list is newest first');
  ok(findWanted(s, 'tt1262426').resolved.auto === true && findWanted(s, 'tt1262426').resolved.as.title === 'Wicked',
    'the bot\'s resolution is marked as its own, with the library\'s copy');
}

console.log('=== notes ===');
{
  const s = memStore();
  recordWanted(s, DUNE, { requester: 'Mia', now: T0 });
  const r = addWantedNote(s, 'tt0087182', { by: 'mommy', text: '  It is on the 4K drive, as "Dune 1984 remaster"  ', at: T0 });
  ok(r.note?.by === 'mommy' && r.note.at === T0 && r.note.text === 'It is on the 4K drive, as "Dune 1984 remaster"' && /^[0-9a-f]{12}$/.test(r.note.id),
    `a note: id, by, at, text, trimmed (${JSON.stringify(r.note)})`);
  ok(findWanted(s, 'tt0087182').notes.length === 1, 'kept on the entry');
  ok(addWantedNote(s, 'tt0087182', { by: 'mommy', text: '   ' }).status === 400, 'an empty note is refused');
  ok(addWantedNote(s, 'tt0087182', { by: 'mommy', text: 'x'.repeat(MAX_NOTE_CHARS + 1) }).status === 400, `over ${MAX_NOTE_CHARS} characters is refused`);
  ok(!!addWantedNote(s, 'tt0087182', { by: 'mommy', text: 'y'.repeat(MAX_NOTE_CHARS) }).note, `${MAX_NOTE_CHARS} exactly is kept`);
  ok(addWantedNote(s, 'nope', { by: 'mommy', text: 'hi' }).status === 404, 'a film not on the list: 404');
  ok(addWantedNote(s, 'tt0087182', { by: 'david', text: 'line one\r\nline two' }).note.text === 'line one\nline two', 'line breaks kept, as one kind');

  for (let i = findWanted(s, 'tt0087182').notes.length; i < MAX_NOTES; i++) addWantedNote(s, 'tt0087182', { by: 'mommy', text: `note ${i}` });
  const full = addWantedNote(s, 'tt0087182', { by: 'mommy', text: 'one too many' });
  ok(MAX_NOTES === 20 && findWanted(s, 'tt0087182').notes.length === 20, 'twenty notes to a film');
  ok(full.status === 409 && /20 notes/.test(full.error), `the twenty-first is refused, saying why (${full.error})`);
  ok(findWanted(s, 'tt0087182').notes[0].text.startsWith('It is on the 4K drive'), 'and no older note was dropped for it');

  const first = findWanted(s, 'tt0087182').notes[0];
  ok(deleteWantedNote(s, 'tt0087182', first.id, { by: 'david' }).status === 403, 'another admin cannot delete it');
  ok(deleteWantedNote(s, 'tt0087182', first.id, { by: 'Mommy' }).note?.id === first.id, 'its author can, whatever the case of the name');
  ok(!findWanted(s, 'tt0087182').notes.some((n) => n.id === first.id), 'and it is gone');
  const dovids = findWanted(s, 'tt0087182').notes.find((n) => n.by === 'david');
  ok(deleteWantedNote(s, 'tt0087182', dovids.id, { by: 'superadmin', superAdmin: true }).note?.by === 'david', 'the super-admin can delete anyone\'s');
  ok(deleteWantedNote(s, 'tt0087182', 'nosuchnote', { by: 'mommy' }).status === 404, 'a note not there: 404');
}

console.log('=== a resolved entry is kept 30 days, then pruned ===');
{
  const s = memStore();
  recordWanted(s, DUNE, { now: T0 - 40 * DAY });
  recordWanted(s, WICKED, { now: T0 - 40 * DAY });
  resolveWanted(s, 'tt0087182', { by: 'mommy', at: T0 - 31 * DAY });
  resolveWanted(s, 'tt1262426', { by: 'mommy', at: T0 - 29 * DAY });
  ok(RESOLVED_KEEP_MS === 30 * DAY, 'thirty days');
  ok(listResolvedWanted(s, { now: T0 }).map((w) => w.title).join() === 'Wicked', 'one resolved 31 days ago is no longer shown');
  ok(pruneWanted(s, { now: T0 }) === 1 && !findWanted(s, 'tt0087182') && !!findWanted(s, 'tt1262426'), 'and is pruned; 29 days is kept');
  recordWanted(s, DUNE, { now: T0 + 2 * DAY });
  resolveWanted(s, 'tt0087182', { by: 'mommy', at: T0 + 2 * DAY });
  recordWanted(s, BAREFOOT, { now: T0 + 2 * DAY });
  ok(!findWanted(s, 'tt1262426'), 'a request writing the list prunes too');
  ok(listWanted(s).map((w) => w.key).join() === 'barefoot|2014', 'an open entry is never pruned, however old');
}

console.log('=== a resolved film asked for again, still not on the server, opens again ===');
{
  const s = memStore();
  recordWanted(s, DUNE, { requester: 'Mia', request: 'dune 1984', now: T0 - DAY });
  resolveWanted(s, 'tt0087182', { by: 'mommy', at: T0 - 3600_000 });
  recordWanted(s, DUNE, { requester: 'Avi', request: 'Dune 1984 please', now: T0 });
  const w = findWanted(s, 'tt0087182');
  ok(!w.resolved && listWanted(s).length === 1, 'open again');
  ok(w.count === 2 && w.lastAt === T0 && w.requesters.join() === 'Mia,Avi', 'the request counted, and who asked');
  const n = w.notes?.at(-1);
  ok(n?.by === 'the bot' && n.auto === true && n.text === 'asked again after it was resolved by mommy' && n.at === T0,
    `with the bot's note saying so: "${n?.text}"`);
  recordWanted(s, DUNE, { requester: 'Avi', now: T0 + 1 });
  ok(findWanted(s, 'tt0087182').notes.length === 1, 'and only once: asked a third time while open adds no note');
}

console.log('=== the list keeps 300, dropping a resolved entry before an open one ===');
{
  const s = memStore();
  const many = Array.from({ length: 300 }, (_, i) => ({ key: `tt${1000000 + i}`, title: `Film ${i}`, year: 2000, count: 1, firstAt: T0, lastAt: T0, requesters: [] }));
  many[7].resolved = { by: 'mommy', at: T0 };
  s.set('wanted', many);
  recordWanted(s, DUNE, { now: T0 + 1 });
  ok(s.get('wanted').length === 300 && !findWanted(s, 'tt1000007') && !!findWanted(s, 'tt1000299') && !!findWanted(s, 'tt0087182'),
    'the resolved one went, every open one stayed');
}

console.log('=== every change is told to the panel ===');
{
  const s = memStore();
  const heard = [];
  const on = (ev) => heard.push(`${ev.what}:${ev.key ?? ''}`);
  wantedEvents.on('change', on);
  recordWanted(s, DUNE);
  resolveWanted(s, 'tt0087182', { by: 'mommy' });
  reopenWanted(s, 'tt0087182');
  const { note } = addWantedNote(s, 'tt0087182', { by: 'mommy', text: 'hi' });
  deleteWantedNote(s, 'tt0087182', note.id, { by: 'mommy' });
  addWantedNote(s, 'tt0087182', { by: 'mommy', text: '' });
  wantedEvents.off('change', on);
  ok(heard.join(' ') === 'asked:tt0087182 resolved:tt0087182 reopened:tt0087182 note:tt0087182 note-deleted:tt0087182',
    `asked, resolved, reopened, a note added and deleted - and nothing for a refused one (${heard.join(' ')})`);
  const boom = () => { throw new Error('a broken listener'); };
  wantedEvents.on('change', boom);
  ok(!!resolveWanted(s, 'tt0087182', { by: 'mommy' }), 'a listener that throws does not undo the change');
  wantedEvents.off('change', boom);
}

/* ------------------------------ the daily summary ------------------------------ */

console.log('=== the daily summary lists only open films, and counts what was resolved ===');
{
  const s = memStore();
  recordWanted(s, DUNE, { requester: 'Mia', now: T0 - 2 * DAY });
  recordWanted(s, WICKED, { requester: 'Sara', now: T0 - 2 * DAY });
  recordWanted(s, BAREFOOT, { requester: 'Avi', now: T0 - 2 * DAY });
  resolveWanted(s, 'tt0087182', { by: 'mommy', at: T0 - 3 * 3600_000 });
  resolveWanted(s, 'tt1262426', { by: 'the bot (found on the server as "Wicked")', at: T0 - 2 * 3600_000, auto: true });
  const all = s.get('wanted');
  const text = formatWanted(all, { now: T0, since: T0 - 12 * 3600_000 });
  ok(/1 film\(s\) people asked for that are not on the server/.test(text) && /Barefoot \(2014\)/.test(text), 'the open film is listed');
  const listed = text.split('\n\n')[1] ?? '';
  ok(!/Dune|Wicked/.test(listed), `the resolved ones are not listed as wanted (${JSON.stringify(listed)})`);
  ok(/2 resolved since the last summary \(1 by an admin, 1 found on the server by the bot\):/.test(text), 'and how many were resolved since the last summary');
  ok(/ {2}Dune \(1984\) - mommy/.test(text) && /Wicked \(2024\) - the bot \(found on the server as "Wicked"\)/.test(text), 'each with who resolved it');
  ok(!/resolved/.test(formatWanted(all, { now: T0, since: T0 - 3600_000 })), 'one resolved before the last summary is not counted');
  ok(/2 resolved in the last 24 hours/.test(formatWanted(all, { now: T0 })), 'with no summary sent yet, the last day is counted');
  resolveWanted(s, 'barefoot|2014', { by: 'mommy', at: T0 - 3600_000 });
  ok(/^Nothing was requested that the server does not already have\.\n\n3 resolved/.test(formatWanted(all, { now: T0, since: T0 - DAY })),
    'nothing open: it says so, and still counts the resolved');
  ok(/WANTED[\s\S]*3 resolved since the last summary/.test(buildDigest({ wanted: all, now: T0, lastSummaryAt: T0 - DAY })), 'buildDigest passes the last summary on');
}

console.log('=== the daily mail counts from the last one sent ===');
{
  const day = (d, h) => new Date(2026, 9, d, h, 0, 0).getTime();
  const spaces = new Map();
  const stateStore = { namespace: (n) => { if (!spaces.has(n)) spaces.set(n, memStore()); return spaces.get(n); } };
  const movies = stateStore.namespace('movie-requests');
  recordWanted(movies, DUNE, { requester: 'Mia', now: day(9, 10) });
  recordWanted(movies, WICKED, { requester: 'Sara', now: day(9, 10) });
  const sent = [];
  const digest = new DailyDigest({
    // With an account to send through: none is "not set up", and never due,
    // since email is on by default (2026-10-12, emailReady).
    configStore: { get: () => ({ email: { enabled: true, dailySummary: true, dailySummaryHour: 8, user: 'bot@b.c', appPassword: 'app-pw' } }) },
    stateStore, alerts: { notify: async (n) => { sent.push(n.note); return { sent: true }; } },
  });
  await digest.tick(day(10, 9));
  ok(stateStore.namespace('digest').get('lastSentAt') === day(10, 9), 'the instant the summary went is kept');
  ok(/2 film\(s\) people asked for/.test(sent[0]) && /resolved in the last 24 hours/.test(sent[0]) === false, 'the first lists both, nothing resolved');
  resolveWanted(movies, 'tt0087182', { by: 'mommy', at: day(10, 15) });
  await digest.tick(day(11, 9));
  ok(/1 film\(s\) people asked for that are not on the server:\n\n {2}1x {2}Wicked/.test(sent[1]), 'the next lists only the open film');
  ok(/1 resolved since the last summary \(1 by an admin\):\n\n {2}Dune \(1984\) - mommy/.test(sent[1]), 'and says one was resolved since, by whom');
}

console.log('=== the activity record counts the open films, and the resolved apart ===');
{
  const md = summarise({
    day: '2026-10-11', generatedAt: 'x', movies: { history: [], wanted: [{ title: 'A', count: 1 }, { title: 'B', count: 2, resolved: { by: 'mommy', at: T0 } }] },
    tv: { history: [] },
  });
  ok(/\| Wanted \(asked for, not on the server\) \| 1 \|/.test(md) && /resolved in the last 30 days \(not counted above\) \| 1 \|/.test(md),
    'one wanted, one resolved, on lines of their own');
}

/* ------------------------------ the API ------------------------------ */

const fakeBot = () => Object.assign(new EventEmitter(), {
  groupCache: new Map(), groups: () => [], state: 'connected', status: () => ({ state: 'connected' }),
});

async function boot() {
  const dir = path.join(TMP, 'api');
  fs.mkdirSync(dir, { recursive: true });
  const cs = new ConfigStore({ dataDir: dir, masterKey: 'test-master-key-0123456789abcdef' });
  cs.load();
  cs.update({
    web: {
      admins: [
        { username: 'alice', role: 'superadmin', passwordHash: hashPassword('alice-secret-1'), createdAt: 1, lastLogin: null },
        { username: 'bob', role: 'admin', passwordHash: hashPassword('bob-secret-22'), createdAt: 1, lastLogin: null },
      ],
    },
    media: { workDir: path.join(dir, 'media') },
  });
  const spaces = new Map();
  const stateStore = { namespace(n) { if (!spaces.has(n)) spaces.set(n, memStore()); return spaces.get(n); } };
  const queue = new JobQueue({ concurrency: 1 });
  queue.pause();
  const server = await new Promise((r) => {
    const sv = createServer({
      configStore: cs, bot: fakeBot(), queue, linkQueue: new JobQueue({ concurrency: 1 }),
      pluginManager: { plugins: new Map(), notifyConfigChange: async () => {} },
      stateStore, fileLogger: { tail: () => [] }, alerts: {}, lockScheduler: {}, failover: null,
    }).listen(0, '127.0.0.1', () => r(sv));
  });
  const port = server.address().port;
  /** A browser of its own: its own cookie. */
  const browser = () => {
    let cookie = '';
    const call = (method, p, body) => new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const headers = cookie ? { cookie } : {};
      if (data !== null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
      const rq = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          if (res.headers['set-cookie']) cookie = res.headers['set-cookie'].map((x) => x.split(';')[0]).join('; ');
          let json = null;
          try { json = JSON.parse(buf); } catch { /* not JSON */ }
          resolve({ status: res.statusCode, json });
        });
      });
      rq.on('error', reject);
      if (data !== null) rq.write(data);
      rq.end();
    });
    const events = () => new Promise((resolve) => {
      const got = [];
      const rq = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/events', headers: { cookie } }, (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = /^event: (.+)$/m.exec(block)?.[1];
            const d = /^data: (.+)$/m.exec(block)?.[1];
            if (ev) got.push({ ev, data: d ? JSON.parse(d) : null });
          }
        });
        resolve({ got, close: () => rq.destroy() });
      });
      rq.on('error', () => {});
      rq.end();
    });
    return { call, events };
  };
  return { browser, stateStore, close: () => server.close() };
}

console.log('=== the API: resolve, reopen and notes, signed in, audited, pushed ===');
{
  const s = await boot();
  const movies = s.stateStore.namespace('movie-requests');
  recordWanted(movies, DUNE, { requester: '15551230001@s.whatsapp.net', request: 'dune 1984' });
  recordWanted(movies, BAREFOOT, { requester: 'Avi' });
  recordWanted(movies, ACDC, { requester: 'Avi' });
  const auditRows = () => s.stateStore.namespace('audit').get('events', []);
  const key = (k) => encodeURIComponent(k);

  const stranger = s.browser();
  const anon = await stranger.call('POST', '/api/wanted/tt0087182/resolve');
  ok(anon.status === 401 && !findWanted(movies, 'tt0087182').resolved, 'not signed in: 401, and nothing changes');
  ok((await stranger.call('POST', '/api/wanted/tt0087182/notes', { text: 'hi' })).status === 401, 'nor a note');
  ok((await stranger.call('DELETE', '/api/wanted/tt0087182/notes/abc')).status === 401, 'nor a deletion');
  ok((await stranger.call('POST', '/api/wanted/tt0087182/reopen')).status === 401, 'nor a reopen');

  const bob = s.browser();
  const alice = s.browser();
  ok((await bob.call('POST', '/api/auth/login', { username: 'bob', password: 'bob-secret-22' })).status === 200, 'bob signs in');
  ok((await alice.call('POST', '/api/auth/login', { username: 'alice', password: 'alice-secret-1' })).status === 200, 'alice signs in');
  const aliceSees = await alice.events();
  await settle(30);

  const r = await bob.call('POST', '/api/wanted/tt0087182/resolve');
  ok(r.status === 200 && r.json.entry.resolved.by === 'bob', `bob marks Dune resolved (${r.status})`);
  ok(r.json.entry.requesters[0] === '+15551230001', 'answered with requesters as the panel shows them');
  let row = auditRows()[0];
  ok(row?.user === 'bob' && row.action === 'marked "Dune (1984)" resolved on the wanted list'
    && /tt0087182 · asked for 1 time · by \+15551230001/.test(row.detail), `audited by name (${row?.action} - ${row?.detail})`);
  ok(!auditRows().some((e) => /^POST /.test(e.action)), 'once, without a second contentless row');
  await settle(30);
  ok(aliceSees.got.some((e) => e.ev === 'wanted' && e.data.what === 'resolved' && e.data.key === 'tt0087182'),
    'alice\'s open panel is told, so her card reloads');
  const list = await alice.call('GET', '/api/wanted');
  ok(!list.json.wanted.some((w) => w.key === 'tt0087182') && list.json.resolved[0]?.key === 'tt0087182'
    && list.json.resolved[0].resolved.by === 'bob', 'GET /wanted: off the open list, under resolved, saying who');
  const again = await alice.call('POST', '/api/wanted/tt0087182/resolve');
  ok(again.status === 409 && /resolved already, by bob/.test(again.json.error), `resolving it twice: 409 (${again.json?.error})`);

  const re = await alice.call('POST', '/api/wanted/tt0087182/reopen');
  ok(re.status === 200 && !re.json.entry.resolved, 'alice reopens it');
  row = auditRows()[0];
  ok(row?.user === 'alice' && row.action === 'reopened "Dune (1984)" on the wanted list' && row.detail === 'it had been resolved by bob',
    `audited (${row?.action} - ${row?.detail})`);
  ok((await alice.call('POST', '/api/wanted/tt0087182/reopen')).status === 409, 'reopening an open film: 409');

  const n1 = await bob.call('POST', '/api/wanted/tt0087182/notes', { text: 'Check the remaster folder, it may be named Dune.1984.REMASTERED' });
  ok(n1.status === 200 && n1.json.note.by === 'bob' && n1.json.entry.notes.length === 1, 'bob writes a note');
  row = auditRows()[0];
  ok(row?.user === 'bob' && row.action === 'added a note to "Dune (1984)" on the wanted list' && /remaster folder/.test(row.detail),
    `audited, with what it says (${row?.action})`);
  ok((await bob.call('POST', '/api/wanted/tt0087182/notes', { text: '' })).status === 400, 'an empty note: 400');
  ok((await bob.call('POST', '/api/wanted/tt0087182/notes', { text: 'z'.repeat(2001) })).status === 400, 'an over-long one: 400');
  const n2 = await alice.call('POST', '/api/wanted/tt0087182/notes', { text: 'Ask Head Admin' });
  const bobsId = n1.json.note.id;
  const alicesId = n2.json.note.id;
  const no = await bob.call('DELETE', `/api/wanted/tt0087182/notes/${alicesId}`);
  ok(no.status === 403 && /alice or the super-admin/.test(no.json.error), `bob cannot delete alice's note (${no.status})`);
  ok((await bob.call('DELETE', `/api/wanted/tt0087182/notes/${bobsId}`)).status === 200, 'bob deletes his own');
  ok(auditRows()[0].action === 'deleted their note on "Dune (1984)" on the wanted list', `audited (${auditRows()[0].action})`);
  const n3 = await bob.call('POST', '/api/wanted/tt0087182/notes', { text: 'one more' });
  ok((await alice.call('DELETE', `/api/wanted/tt0087182/notes/${n3.json.note.id}`)).status === 200, 'alice, the super-admin, deletes bob\'s');
  ok(auditRows()[0].action === 'deleted bob\'s note on "Dune (1984)" on the wanted list', `audited as bob's (${auditRows()[0].action})`);
  await settle(30);
  const kinds = aliceSees.got.filter((e) => e.ev === 'wanted').map((e) => e.data.what);
  ok(['reopened', 'note', 'note-deleted'].every((k) => kinds.includes(k)), `every change pushed (${kinds.join(', ')})`);
  aliceSees.close();

  // Keys, URL-encoded: a film OMDb gave no id is "title|year", slashes and all.
  const bf = await bob.call('POST', `/api/wanted/${key('barefoot|2014')}/resolve`);
  ok(bf.status === 200 && findWanted(movies, 'barefoot|2014').resolved.by === 'bob', `a "title|year" key, URL-encoded (${bf.status})`);
  const ac = await bob.call('POST', `/api/wanted/${key(wantedKey(ACDC))}/notes`, { text: 'live film' });
  ok(ac.status === 200 && findWanted(movies, 'ac/dc: let there be rock|1980').notes.length === 1, `one with a slash in it (${ac.status})`);

  const bad = [
    await bob.call('POST', '/api/wanted/tt0000000/resolve'),
    await bob.call('POST', '/api/wanted/tt0000000/reopen'),
    await bob.call('POST', '/api/wanted/tt0000000/notes', { text: 'x' }),
    await bob.call('DELETE', '/api/wanted/tt0000000/notes/abc'),
    await bob.call('DELETE', '/api/wanted/tt0087182/notes/nosuchnote'),
    await bob.call('POST', `/api/wanted/${key('dune|1984')}/resolve`),
  ];
  ok(bad.every((x) => x.status === 404), `a key or note not on the list: 404 every time (${bad.map((x) => x.status).join(' ')})`);
  ok(/not on the wanted list/.test(bad[0].json.error), `saying so (${bad[0].json.error})`);
  s.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
