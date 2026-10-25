/* Persistent debug log: rotation, retention, gzip, and filename safety.
   Run: node test/logging.test.mjs */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { FileLogger } from '../src/util/filelog.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logtest-'));
const entry = (level, msg, extra) => ({ ts: new Date().toISOString(), level, scope: 'test', msg, ...(extra ? { extra } : {}) });

console.log('=== writing ===');
{
  const fl = new FileLogger({ dir });
  fl.write(entry('info', 'hello world'));
  fl.write(entry('error', 'something broke'));
  fl.write(entry('debug', 'with extra', { a: 1 }));
  fl.close();

  const day = FileLogger.dayStamp();
  const f = path.join(dir, `debug-${day}.log`);
  ok(fs.existsSync(f), 'writes a dated file');
  const body = fs.readFileSync(f, 'utf8');
  ok(body.includes('hello world'), 'message written');
  ok(body.includes('[ERROR]'), 'level recorded');
  ok(body.includes('{"a":1}'), 'structured extra serialised');
  ok(body.split('\n').filter(Boolean).length === 3, 'one line per entry');
}

console.log('\n=== appends rather than truncating on restart ===');
{
  const fl = new FileLogger({ dir });
  fl.write(entry('info', 'second run'));
  fl.close();
  const body = fs.readFileSync(path.join(dir, `debug-${FileLogger.dayStamp()}.log`), 'utf8');
  ok(body.includes('hello world') && body.includes('second run'), 'earlier lines survive a restart');
}

console.log('\n=== rolls over when a file gets large ===');
{
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'logroll-'));
  const fl = new FileLogger({ dir: d2, maxBytes: 2000 });
  for (let i = 0; i < 200; i++) fl.write(entry('info', `line ${i} ${'x'.repeat(40)}`));
  fl.close();
  const files = fs.readdirSync(d2).filter((f) => f.endsWith('.log'));
  ok(files.length > 1, `split into ${files.length} parts at the size limit`);
  fs.rmSync(d2, { recursive: true, force: true });
}

console.log('\n=== gzips yesterday, keeps today ===');
{
  const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'loggz-'));
  const old = path.join(d3, 'debug-2020-01-01.log');
  fs.writeFileSync(old, 'old log content\n');
  const fl = new FileLogger({ dir: d3 });
  fl.write(entry('info', 'today'));
  fl.compressOlder();
  ok(!fs.existsSync(old), 'the original of an old file is removed');
  ok(fs.existsSync(`${old}.gz`), 'replaced by a .gz');
  ok(zlib.gunzipSync(fs.readFileSync(`${old}.gz`)).toString() === 'old log content\n', 'gzip round-trips');
  ok(fs.existsSync(path.join(d3, `debug-${FileLogger.dayStamp()}.log`)), "today's file left uncompressed");
  ok(fl.read('debug-2020-01-01.log.gz').includes('old log content'), 'reads a gzipped log transparently');
  fl.close();
  fs.rmSync(d3, { recursive: true, force: true });
}

console.log('\n=== retention prunes old files ===');
{
  const d4 = fs.mkdtempSync(path.join(os.tmpdir(), 'logret-'));
  const stale = path.join(d4, 'debug-2020-01-01.log.gz');
  fs.writeFileSync(stale, zlib.gzipSync('x'));
  const longAgo = Date.now() - 40 * 86400_000;
  fs.utimesSync(stale, longAgo / 1000, longAgo / 1000);
  const fl = new FileLogger({ dir: d4, retentionDays: 14 });
  fl.prune();
  ok(!fs.existsSync(stale), 'a 40-day-old file is pruned at 14-day retention');
  fl.close();
  fs.rmSync(d4, { recursive: true, force: true });
}

console.log('\n=== filename safety (these become URL parameters) ===');
{
  const fl = new FileLogger({ dir });
  for (const bad of [
    '../../../etc/passwd',
    '../config.json',
    '/etc/passwd',
    'debug-2026-01-01.log/../../../etc/passwd',
    'notalog.txt',
    '.env',
    'debug-../-01-01.log',
  ]) {
    let threw = false;
    try { fl.read(bad); } catch { threw = true; }
    ok(threw, `refused ${JSON.stringify(bad)}`);
  }
  let okName = false;
  try { fl.read(`debug-${FileLogger.dayStamp()}.log`); okName = true; } catch {}
  ok(okName, 'accepts a legitimate log filename');
  fl.close();
}

console.log('\n=== listing ===');
{
  const fl = new FileLogger({ dir });
  const list = fl.list();
  ok(Array.isArray(list) && list.length > 0, `lists ${list.length} file(s)`);
  ok(list.every((f) => typeof f.size === 'number' && f.name), 'entries carry name and size');
  ok(fl.today().includes('hello world'), "today() returns today's content");
  fl.close();
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${'='.repeat(50)}\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
