/* A download cut off goes on from the byte it reached, and only for the same file.
   Run: node test/download-resume.test.mjs

   The Parent Trap (1998), 2026-09-29: 2.62 GB, downloaded 18:42-18:44 UTC,
   then fetched again from the first byte when a restart resumed it - and
   again after a second restart 11 seconds later. A download now writes to
   <file>.part, and one cut off - by a restart, a dropped connection, a movie
   taking an episode's slot - asks for the rest with Range, and with If-Range
   so a library file replaced in between is sent whole instead of spliced
   onto the old one's first half. Jellyfin's download endpoint serves ranges,
   sends Last-Modified and no ETag, and honours If-Range with a date; the
   server here does the same (test/fixtures/restart-kit.mjs). A download that
   ends short of its length used to be taken as whole, with a warning: it is
   an error now, and its partial is kept to go on from. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { downloadToFile } from '../src/media/download.js';
import { isTransient } from '../src/media/resume.js';
import { makeKit } from './fixtures/restart-kit.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const kit = await makeKit('download-resume', { filmBytes: 512 * 1024 });
const { server, TMP } = kit;
const url = `${kit.base}/Items/pt/Download`;
let n = 0;
const dest = () => path.join(TMP, `film-${++n}.mkv`);
const HALF = 200 * 1024;
/** A partial download of the library's file as it is now, `bytes` long. */
function partial(file, bytes = HALF) { fs.writeFileSync(`${file}.part`, server.body.subarray(0, bytes)); }
const same = (file) => fs.existsSync(file) && Buffer.compare(fs.readFileSync(file), server.body) === 0;
const asNow = () => ({ total: server.body.length, lastModified: server.lastModified, etag: null });

console.log('=== a partial download goes on with Range and If-Range, and the file comes out whole ===');
{
  const f = dest();
  partial(f);
  server.requests.length = 0;
  const seen = [];
  const r = await downloadToFile(url, f, { resume: asNow(), onProgress: (pct, info) => seen.push(info.receivedBytes) });
  const q = server.requests[0];
  ok(server.requests.length === 1 && q.range === `bytes=${HALF}-` && q.ifRange === server.lastModified,
    `one request, for the rest, if the file is still the same (${q.range}, If-Range ${q.ifRange})`);
  ok(r.resumed && r.from === HALF && same(f) && !fs.existsSync(`${f}.part`), 'the file is byte-identical to the library\'s, and the partial is gone');
  ok(seen.every((b) => b >= HALF), 'progress counts from what it had');
}

console.log('=== a server that ignores Range sends the whole file, which replaces the partial ===');
{
  const f = dest();
  partial(f);
  server.ranges = false;
  const r = await downloadToFile(url, f, { resume: asNow() });
  server.ranges = true;
  ok(!r.resumed && same(f) && fs.statSync(f).size === server.body.length,
    `not appended to the partial: ${fs.statSync(f).size} bytes, the file's own length`);
}

console.log('=== a file changed on the server is fetched whole again ===');
{
  const f = dest();
  partial(f);
  const before = asNow();
  server.body = crypto.randomBytes(server.body.length + 4096);
  server.lastModified = new Date(Date.UTC(2026, 8, 29, 18, 0, 0)).toUTCString();
  server.requests.length = 0;
  let told = null;
  const r = await downloadToFile(url, f, { resume: before, onResponse: (x) => { told = x; } });
  ok(server.requests.length === 1 && server.requests[0].range && !r.resumed && same(f),
    'the If-Range no longer matches: the server sends the new file, all of it, and that is what is kept');
  ok(told?.total === server.body.length && told.lastModified === server.lastModified && !told.resumed,
    'and the caller is told it is a new file, to record');
}

console.log('=== a 206 that does not start where the partial ends starts over ===');
{
  const f = dest();
  partial(f);
  const calls = [];
  const fetchImpl = async (u, init) => {
    calls.push(init.headers.Range ?? null);
    if (init.headers.Range) {
      return new Response(server.body.subarray(0, 1000), { status: 206, headers: {
        'content-range': `bytes 0-999/${server.body.length}`, 'content-length': '1000', 'last-modified': server.lastModified,
      } });
    }
    return new Response(server.body, { status: 200, headers: { 'content-length': String(server.body.length), 'last-modified': server.lastModified } });
  };
  const r = await downloadToFile(url, f, { resume: asNow(), fetchImpl });
  ok(calls.join() === `bytes=${HALF}-,` && !r.resumed && same(f), `asked for the rest, sent the start: asked again for all of it (${calls.join(' then ')})`);
  const g = dest();
  partial(g);
  const r416 = await downloadToFile(url, g, { resume: { ...asNow(), total: server.body.length }, fetchImpl: async (u, init) => (init.headers.Range
    ? new Response(null, { status: 416, headers: { 'content-range': `bytes */${server.body.length}` } })
    : new Response(server.body, { status: 200, headers: { 'content-length': String(server.body.length) } })) });
  ok(!r416.resumed && same(g), 'a 416 starts over too');
}

console.log('=== a download cut short is an error and not a finished file, and its partial is kept ===');
{
  const f = dest();
  server.cutAt = 300 * 1024;
  let err = null;
  try { await downloadToFile(url, f, {}); } catch (e) { err = e; }
  server.cutAt = null;
  ok(err && isTransient(err) && !fs.existsSync(f), `the connection dropping mid-body is a transient failure, with no file (${err?.message})`);
  const kept = fs.existsSync(`${f}.part`) ? fs.statSync(`${f}.part`).size : 0;
  ok(kept > 0 && kept <= 300 * 1024, `and what came is kept, to go on from (${kept} bytes)`);
  const r = await downloadToFile(url, f, { resume: asNow() });
  ok(r.resumed && r.from === kept && same(f), 'which the next attempt does');

  // A body that simply ends, without an error, short of its length.
  const g = dest();
  err = null;
  try {
    await downloadToFile(url, g, { fetchImpl: async () => new Response(server.body.subarray(0, 1000), {
      status: 200, headers: { 'content-length': String(server.body.length), 'last-modified': server.lastModified },
    }) });
  } catch (e) { err = e; }
  ok(err && /download ended early: 1000 B of 516\.00 KB/.test(err.message) && isTransient(err) && !fs.existsSync(g)
    && fs.statSync(`${g}.part`).size === 1000, `ended early: an error, transient, and its partial kept (${err?.message})`);
}

console.log('=== the validators are handed over before the first byte is written ===');
{
  const f = dest();
  let at = null;
  await downloadToFile(url, f, {
    onResponse: (x) => { at = { ...x, part: fs.existsSync(`${f}.part`) ? fs.statSync(`${f}.part`).size : null }; },
  });
  ok(at && at.part === null && at.total === server.body.length && at.lastModified === server.lastModified && at.etag === null,
    'a fresh download: length and Last-Modified, with nothing written yet');
  const g = dest();
  partial(g);
  await downloadToFile(url, g, {
    resume: asNow(),
    onResponse: (x) => { at = { ...x, part: fs.statSync(`${g}.part`).size }; },
  });
  ok(at.resumed && at.part === HALF, 'a resumed one: with only what it had before on the disk');
  const h = dest();
  let err = null;
  try { await downloadToFile(url, h, { onResponse: () => { throw new Error('the manifest could not be written'); } }); } catch (e) { err = e; }
  ok(/manifest could not be written/.test(err?.message ?? '') && !fs.existsSync(`${h}.part`) && !fs.existsSync(h),
    'and if the caller cannot record them, nothing is written at all');
}

console.log('=== a new file\'s identity is never recorded beside the old file\'s partial ===');
{
  // Found in review, 2026-09-29: the caller was told of the new file (and
  // recorded it, synced) before the old partial was removed. A kill between
  // the two left a manifest vouching for the new file beside the old one's
  // first bytes; the next start asked for the rest of the new file after
  // them, If-Range matching the new validator, and got a spliced source of
  // exactly the new length that passed every check. The partial goes first
  // now. Here the caller is killed the moment it is told - it throws.
  const f = dest();
  partial(f);
  const before = asNow();
  server.body = crypto.randomBytes(server.body.length + 2048);
  server.lastModified = new Date(Date.UTC(2026, 8, 29, 19, 7, 0)).toUTCString();
  let partAtResponse = null;
  let err = null;
  try {
    await downloadToFile(url, f, {
      resume: before,
      onResponse: () => { partAtResponse = fs.existsSync(`${f}.part`); throw new Error('killed'); },
    });
  } catch (e) { err = e; }
  ok(/killed/.test(err?.message ?? '') && partAtResponse === false && !fs.existsSync(`${f}.part`),
    'the file changed on the server: the old partial is gone before the new file is recorded');
  // A 416, and a range that does not fit, are refusals too.
  for (const [how, answer] of [
    ['416', () => new Response(null, { status: 416, headers: { 'content-range': `bytes */${server.body.length}` } })],
    ['a range from elsewhere', () => new Response(server.body.subarray(0, 1000), { status: 206, headers: {
      'content-range': `bytes 0-999/${server.body.length}`, 'content-length': '1000', 'last-modified': server.lastModified,
    } })],
  ]) {
    const g = dest();
    partial(g);
    let seen = null;
    try {
      await downloadToFile(url, g, {
        resume: asNow(),
        fetchImpl: async (u, init) => (init.headers.Range ? answer()
          : new Response(server.body, { status: 200, headers: { 'content-length': String(server.body.length), 'last-modified': server.lastModified } })),
        onResponse: () => { seen = fs.existsSync(`${g}.part`); throw new Error('killed'); },
      });
    } catch { /* killed */ }
    ok(seen === false && !fs.existsSync(`${g}.part`), `${how}: the partial is gone before the file is recorded`);
  }
}

console.log('=== there is no Range request without a validator ===');
{
  const f = dest();
  partial(f);
  server.requests.length = 0;
  const r = await downloadToFile(url, f, { resume: { total: server.body.length, lastModified: null, etag: null } });
  ok(server.requests[0].range === null && !r.resumed && same(f), 'nothing to tell it is the same file: all of it is fetched again');
  const g = dest();
  partial(g);
  server.requests.length = 0;
  await downloadToFile(url, g, {});
  ok(server.requests[0].range === null && same(g), 'nor without anything recorded at all');
}

console.log('=== a hard-linked partial is never appended to ===');
{
  // A partial that has another name - say a library file linked in by a
  // bug - must not grow, or be cut, through this one.
  const f = dest();
  const other = path.join(TMP, 'library-original.mkv');
  fs.writeFileSync(other, server.body.subarray(0, HALF));
  fs.linkSync(other, `${f}.part`);
  server.requests.length = 0;
  await downloadToFile(url, f, { resume: asNow() });
  ok(server.requests[0].range === null && same(f), 'it is fetched whole, into a file of its own');
  ok(fs.statSync(other).size === HALF && Buffer.compare(fs.readFileSync(other), server.body.subarray(0, HALF)) === 0,
    'and the other name\'s bytes are untouched');
}

console.log('=== a partial with every byte, never renamed, is checked by its last byte ===');
{
  const f = dest();
  fs.writeFileSync(`${f}.part`, server.body);
  server.requests.length = 0;
  const r = await downloadToFile(url, f, { resume: asNow() });
  ok(server.requests[0].range === `bytes=${server.body.length - 1}-` && r.resumed && same(f),
    'killed between the last byte and the rename: one byte is fetched again, and the file is whole');
}

kit.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
