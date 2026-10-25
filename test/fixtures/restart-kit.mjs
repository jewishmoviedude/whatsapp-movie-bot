/* What the restart tests share: a library to download from, stub encoders,
   a journal on the disk, and a way to kill a job the way a restart does.

   The Parent Trap (1998), 2026-09-29: 2.62 GB downloaded 18:42-18:44 UTC,
   23 minutes into its encode when the bot restarted at 19:07 - and it was
   downloaded again from the first byte, and again after a second restart
   11 seconds later. These tests kill a job at the step they name (see
   killable-job.mjs) and then run it again, in this process, as the next
   start would: the start-up sweep first, then the job.

   The "library" is a local HTTP server standing in for Jellyfin's
   /Items/{id}/Download: Content-Length, Last-Modified and no ETag, ranges
   honoured with If-Range as a date (Jellyfin's PhysicalFile does). It logs
   every request, can serve slowly (so a download can be killed half way),
   cut a body short, ignore ranges, or change the file; and it answers the
   library's search (/search, the "http" provider), or never answers it. The stub ffmpeg
   copies its input to its output, or - while SLOW is there - writes part of
   it and then sleeps, so it can be killed mid-encode. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');
const HARNESS = path.join(HERE, 'killable-job.mjs');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function makeKit(name, { filmBytes = 3 * 1024 * 1024 } = {}) {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  const WORK = path.join(TMP, 'work');
  const LIB = path.join(TMP, 'lib');
  fs.mkdirSync(WORK);
  fs.mkdirSync(LIB);
  const flag = (n) => path.join(TMP, n);

  /* ------------------------------------------------ the library server */
  const server = {
    body: crypto.randomBytes(filmBytes),
    lastModified: new Date(Date.UTC(2026, 8, 20, 12, 0, 0)).toUTCString(),
    ranges: true,
    slow: false,               // bytes per 20 ms tick, or false
    cutAt: null,               // end the connection after this many bytes of a body
    missing: new Set(),        // paths that answer 404
    requests: [],
    // The library's search (the "http" provider, library.js HttpProvider):
    // what /search answers, and the titles whose search never answers - a
    // lookup in flight when a restart comes.
    catalog: [],
    hangSearch: new Set(),
    searches: [],
  };
  const srv = http.createServer((req, res) => {
    const range = req.headers.range ?? null;
    const ifRange = req.headers['if-range'] ?? null;
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/search') {
      const q = url.searchParams.get('q') ?? '';
      server.searches.push(q);
      if (server.hangSearch.has(q)) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(server.catalog.filter((c) => c.title.toLowerCase() === q.toLowerCase())));
      return;
    }
    server.requests.push({ url: req.url, range, ifRange });
    if (server.missing.has(url.pathname)) { res.writeHead(404); res.end(); return; }
    const body = server.body;
    let start = 0;
    let end = body.length - 1;
    let status = 200;
    const m = /^bytes=(\d+)-(\d*)$/.exec(range ?? '');
    if (m && server.ranges && (!ifRange || ifRange === server.lastModified)) {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
      if (start >= body.length) {
        res.writeHead(416, { 'content-range': `bytes */${body.length}` });
        res.end();
        return;
      }
      status = 206;
    }
    const headers = {
      'content-length': String(end - start + 1), 'last-modified': server.lastModified, 'accept-ranges': 'bytes',
      'content-type': 'video/x-matroska',
    };
    if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${body.length}`;
    res.writeHead(status, headers);
    const slice = body.subarray(start, end + 1);
    const cut = server.cutAt != null && status === 200 ? server.cutAt : null;
    if (!server.slow && cut == null) { res.end(slice); return; }
    let at = 0;
    const tick = () => {
      if (res.destroyed) return;
      const step = server.slow || slice.length;
      const next = Math.min(slice.length, at + step, cut ?? Infinity);
      res.write(slice.subarray(at, next));
      at = next;
      // Dropped once what came has had time to arrive, as a connection that dies mid-body does.
      if (cut != null && at >= cut) { setTimeout(() => res.socket?.destroy(), 50); return; }
      if (at >= slice.length) { res.end(); return; }
      setTimeout(tick, 20);
    };
    tick();
  });
  srv.on('connection', (s) => s.unref());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  /** Requests for the file itself, not the one-byte question a resumed job asks first. */
  const downloads = () => server.requests.filter((r) => r.range !== 'bytes=0-0');
  const probes = () => server.requests.filter((r) => r.range === 'bytes=0-0');

  /* ------------------------------------------------------ the encoders */
  const FFPROBE = path.join(TMP, 'ffprobe');
  fs.writeFileSync(FFPROBE, `#!/bin/sh
echo x >> '${flag('PROBES')}'
cat <<JSON
{"streams":[{"codec_type":"video","codec_name":"h264","width":1280,"height":720},{"codec_type":"audio","codec_name":"aac","channels":2}],"format":{"format_name":"matroska,webm","duration":"60","size":"${filmBytes}"}}
JSON
`, { mode: 0o755 });
  const FFMPEG = path.join(TMP, 'ffmpeg');
  fs.writeFileSync(FFMPEG, `#!/bin/sh
echo x >> '${flag('RUNS')}'
prev=""; in=""; out=""
for a in "$@"; do
  [ "$prev" = "-i" ] && in="$a"
  [ "$a" = "-progress" ] && out="$prev"
  prev="$a"
done
if [ -f '${flag('SLOW')}' ]; then head -c 1000 "$in" > "$out"; touch '${flag('STARTED')}'; sleep 60; fi
cat "$in" > "$out"
`, { mode: 0o755 });
  const count = (n) => (fs.existsSync(flag(n)) ? fs.readFileSync(flag(n), 'utf8').split('\n').filter(Boolean).length : 0);

  /* -------------------------------------------------- the journal on disk */
  const STORE = path.join(TMP, 'store.json');
  const EVENTS = path.join(TMP, 'events.log');
  /** The journal the next process reads: the file, as the killed one left it. */
  function loadStore() {
    const data = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, 'utf8')) : {};
    const save = () => fs.writeFileSync(STORE, JSON.stringify(data));
    return {
      data,
      get: (k, d = null) => (k in data ? data[k] : d),
      set: (k, v) => { data[k] = v; save(); },
      push: (k, v) => { (data[k] ??= []).unshift(v); save(); },
      delete: (k) => { delete data[k]; save(); },
    };
  }
  const events = () => (fs.existsSync(EVENTS) ? fs.readFileSync(EVENTS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

  /** Every file under the work directory bar the jobs' manifests. */
  const listWork = (dir = WORK) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return listWork(p);
    return e.name === 'manifest.json' ? [] : [path.relative(WORK, p)];
  }) : []);

  let specs = 0;
  /**
   * Run the job in a process of its own. `killWhen` is polled; once it says
   * so the whole process group - the job and its ffmpeg - is killed with
   * SIGKILL, as a restart that does not wait kills it. Without one the job
   * runs to its end.
   */
  async function runChild(spec, { killWhen = null, timeoutMs = 30_000 } = {}) {
    const file = path.join(TMP, `spec-${++specs}.json`);
    fs.writeFileSync(file, JSON.stringify({ repo: REPO, store: STORE, events: EVENTS, ...spec }));
    const child = spawn(process.execPath, [HARNESS, file], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const exited = new Promise((r) => child.on('exit', (code, sig) => r({ code, sig })));
    let killed = false;
    if (killWhen) {
      const started = Date.now();
      for (;;) {
        if (await killWhen()) break;
        if (Date.now() - started > timeoutMs) { out += '\n[the moment to kill it never came]'; break; }
        if (child.exitCode != null) break;
        await sleep(10);
      }
      try { process.kill(-child.pid, 'SIGKILL'); killed = true; } catch { /* gone already */ }
    }
    const how = await exited;
    fs.rmSync(flag('STARTED'), { force: true });
    return { ...how, killed, out };
  }

  return {
    TMP, WORK, LIB, FFPROBE, FFMPEG, STORE, base, server, downloads, probes, count, flag, events, listWork,
    loadStore, runChild,
    slowEncode: (on) => (on ? fs.writeFileSync(flag('SLOW'), '') : fs.rmSync(flag('SLOW'), { force: true })),
    encoding: () => fs.existsSync(flag('STARTED')),
    close() {
      srv.close();
      fs.rmSync(TMP, { recursive: true, force: true });
    },
  };
}
