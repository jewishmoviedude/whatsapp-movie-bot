/**
 * The hourly check's record: one row per run, the report each run wrote, and
 * the scanner's memory between runs. All of it lives in data/hourly-debug/.
 *
 * The check runs from cron (tools/hourly-debug.mjs), outside the bot's
 * process, and the panel reads what it left behind (the Logs tab's "Hourly
 * checks" card). Neither writes data/state.json: the bot holds that file in
 * memory and rewrites it whole every half second, so anything another process
 * put there would be lost on the bot's next write - or would clobber it.
 *
 * Everything that leaves this directory - an email, the panel, a report
 * handed to a person - goes through sanitize() first: no phone number, no
 * API key, no token, whatever an AI session or a log line put in the text.
 * The one thing put back afterwards, and only in what the operator sees (the
 * panel and the email to their own address), is a member's number where the
 * text names them by its mask: expandNumbers(), below.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { redactPersonal } from '../util/mailer.js';
import { fmtTime } from './content-check-health.js';
import { betaReportSection } from './beta-scan.js';

export const RUNS_KEPT = 500;
// A run id is its start time, UTC, to the second: sortable, and safe to use
// as a directory name and in a URL.
export const RUN_ID = /^\d{8}T\d{6}Z$/;

export const hourlyDir = (dataDir) => path.join(dataDir, 'hourly-debug');
export const runDir = (dataDir, id) => path.join(hourlyDir(dataDir), 'runs', id);

export function runIdFor(ts) {
  return new Date(ts).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** Written whole or not at all, and readable only by the bot's user. */
export function writeJson(file, value) {
  writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Written whole or not at all, and readable only by the bot's user - and
 * never through a link somebody else put there. The check writes into the
 * run folder (report.md, ship-result.json, claude-output.json...) while and
 * after the research session runs in it, and the session can write there.
 * The temporary file was `<file>.<pid>.tmp`, opened by writeFileSync, which
 * follows a symlink: a session that read the check's pid from /proc and put
 * a link by that name had the check, outside the sandbox, overwrite
 * whatever the link named with the session's own report - ~/.ssh's
 * authorized_keys, ~/.bashrc, the crontab, or data/check-now.json, which
 * starts a run (found in review, 2026-10-12). So the name cannot be guessed,
 * and it is created new (O_EXCL), which no existing name - a link, a hard
 * link, a file - can stand in for. The rename then replaces whatever is at
 * `file` itself, a link included, without following it.
 */
export function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* never made */ }
    throw err;
  }
}

/**
 * A file the research session may have written (the run folder is its to
 * write), read the way writeText() writes: never through a link, never a
 * hard link to a file elsewhere, never a FIFO or a device (whose open would
 * hang the check or read something else), and at most `max` bytes. Its
 * text, or null. Without this, a session that made report.md a link to
 * data/session/creds.json or ~/.ssh/id_ed25519 had the check read that into
 * the report it emails and keeps in data/, where the next session can read
 * it.
 */
export function readOwnFile(file, max = 4 * 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) return null;
    const buf = Buffer.alloc(Math.min(st.size, max));
    const n = buf.length ? fs.readSync(fd, buf, 0, buf.length, 0) : 0;
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

/** readOwnFile(), parsed; `fallback` for none, or one that does not parse. */
export function readOwnJson(file, fallback = null) {
  const text = readOwnFile(file);
  if (text == null) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

/** Every run, newest first. */
export function readRuns(dataDir) {
  const runs = readJson(path.join(hourlyDir(dataDir), 'runs.json'), []);
  return Array.isArray(runs) ? runs.filter((r) => r && RUN_ID.test(String(r.id))) : [];
}

export function appendRun(dataDir, run) {
  const runs = readRuns(dataDir).filter((r) => r.id !== run.id);
  runs.unshift(run);
  runs.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  writeJson(path.join(hourlyDir(dataDir), 'runs.json'), runs.slice(0, RUNS_KEPT));
}

export function readMemory(dataDir) {
  return readJson(path.join(hourlyDir(dataDir), 'memory.json'), null);
}

export function writeMemory(dataDir, memory) {
  writeJson(path.join(hourlyDir(dataDir), 'memory.json'), memory);
}

/**
 * A run's report, or null. The id is checked, since it comes from a URL; and
 * the file is read as readOwnFile() reads, since a run that ended before it
 * wrote its report leaves whatever the session put in its place.
 */
export function readReport(dataDir, id) {
  if (!RUN_ID.test(String(id))) return null;
  return readOwnFile(path.join(runDir(dataDir, id), 'report.md'));
}

/**
 * Old run directories go, and with them each run's key to its masked numbers
 * (data/hourly-numbers/<run>.json); their rows stay in runs.json until it is
 * capped.
 */
export function pruneRunDirs(dataDir, { keepDays = 30, now = Date.now() } = {}) {
  const old = (id) => {
    const at = Date.parse(id.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z'));
    return Number.isFinite(at) && now - at > keepDays * 86_400_000;
  };
  const list = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
  const root = path.join(hourlyDir(dataDir), 'runs');
  let removed = 0;
  for (const name of list(root)) {
    if (!RUN_ID.test(name) || !old(name)) continue;
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
    removed += 1;
  }
  const keys = path.join(dataDir, NUMBERS_DIR);
  for (const name of list(keys)) {
    const id = name.replace(/\.json$/, '');
    if (RUN_ID.test(id) && name === `${id}.json` && old(id)) fs.rmSync(path.join(keys, name), { force: true });
  }
  return removed;
}

/* ------------------------------ scrubbing ---------------------------- */

// Shapes of credential that must never leave the box, whoever wrote the text.
const TOKEN_SHAPES = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bgsk_[A-Za-z0-9]{20,}\b/g,
  /\bcsk-[A-Za-z0-9]{20,}\b/g,
  // OpenRouter's keys: sk-or-v1-<hex>. Not covered by sk-ant- above.
  /\bsk-or-(?:v\d+-)?[A-Za-z0-9]{20,}\b/g,
  /\bMASTER_KEY=\S+/g,
  /\bCLAUDE_CODE_OAUTH_TOKEN=\S+/g,
  // .env's other secrets, as a line of it would be quoted: the tunnel's
  // token (and cloudflared's own name for it), the backup passphrase, which
  // may hold spaces, so the rest of the line goes.
  /\b(?:CLOUDFLARE_)?TUNNEL_TOKEN=\S+/g,
  /\bBACKUP_PASSPHRASE=.*/g,
  // A Cloudflare tunnel token by its shape - base64 of {"a":"<account>",...} -
  // wherever it turns up: a container's `docker run ... --token`, a unit's
  // ExecStart, sudo's log of either (2026-09-30).
  /\beyJhIjoi[A-Za-z0-9+/_=-]{40,}/g,
  // A Discord account token by its shape (the user id in base64, a stamp, an
  // HMAC; or the older mfa. form). The saved one is masked by value as a
  // secret; this is for one pasted anywhere else (2026-10-11, the Discord
  // ticket reader: src/core/discord-reader.js).
  /(?:\bmfa\.[A-Za-z0-9_-]{20,}|\b[MNO][A-Za-z0-9_-]{22,27}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{25,45})(?![A-Za-z0-9_-])/g,
];

/** Every known secret value in `text` replaced: the first step of sanitize(). */
function maskSecrets(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets ?? []) {
    if (typeof s === 'string' && s.length >= 6) out = out.split(s).join('***');
  }
  return out;
}

/**
 * Text fit to leave the box: every known secret value replaced, anything
 * shaped like a token replaced, credentials out of URLs, phone numbers masked.
 * `numbers` (a numberLog()) is told of each number masked.
 */
export function sanitize(text, secrets = [], numbers = null) {
  let out = maskSecrets(text, secrets);
  for (const re of TOKEN_SHAPES) out = out.replace(re, '***');
  out = out.replace(/(:\/\/)[^/@\s]+@/g, '$1***@');
  // A commit id or a message id is hex, and about one commit in a hundred
  // ends in ten digits - which the phone mask would take for a number and
  // cut out of the link. Anything hex with a letter in it is set aside first.
  // So are the other identifiers the dossier hands the model, none of which
  // is a phone number: a request made from the panel ("manual-1790571829880",
  // "tv-manual-…-9e9d19", a millisecond timestamp) and a group id
  // ("120363900000000006@g.us" - more digits than any phone number has).
  // Masked, the model's requeue of a panel request was refused as "no such
  // request in the history", and no row could be looked up by its group.
  const kept = [];
  const keep = (m) => `\u0000${kept.push(m) - 1}\u0000`;
  out = out.replace(/\b(?:tv-)?(?:manual|panel)-\d{10,}(?:-[0-9a-z]{1,12})?\b/gi, keep);
  out = out.replace(/\b\d{16,}@g\.us\b/g, keep);
  // A Discord id (a server, a ticket channel, a message: 17 to 20 digits) is
  // longer than any phone number - E.164 stops at 15 - and the research
  // session looks tickets up by it (discord-watch.js).
  out = out.replace(/\b\d{17,20}\b/g, keep);
  out = out.replace(/\b[0-9a-f]{7,40}\b/gi, (m) => (/[a-f]/i.test(m) ? keep(m) : m));
  return redactPersonal(out, numbers).replace(/\u0000(\d+)\u0000/g, (_m, i) => kept[Number(i)]);
}

/**
 * The same, for a structure: every string in it, and nothing else. Run over
 * serialised JSON instead, the phone-number mask took the millisecond
 * timestamps for numbers and broke the JSON.
 */
export function sanitizeDeep(value, secrets = [], numbers = null) {
  if (typeof value === 'string') return sanitize(value, secrets, numbers);
  if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v, secrets, numbers));
  if (value && typeof value === 'object') {
    if (numbers?.link) linkLids(value, numbers);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeDeep(v, secrets, numbers)]));
  }
  return value;
}

/* ------------------------------ members' numbers --------------------- */

/*
 * The operator (2026-10-01): "i see a few hourly logs aren't specifying the
 * number of the group member". A member with no WhatsApp name is their number
 * (src/core/members.js formatPhone), and the dossier the research session
 * reads has it masked, +1555***0191, like every number that leaves the box:
 * so the reports said "the member", "the same member", "a member asked for
 * Outer Banks S5 a second time", and nobody could tell who.
 *
 * The session is still never handed a number. So, as the dossier is masked,
 * the check keeps a key of its own - each handle and the number it was made
 * from - in data/hourly-numbers/<run>.json, which the research sandbox does
 * not let the session read (tools/hourly-debug.mjs, PRIVATE_DATA). The session
 * names a member by the masked number; the report keeps it masked on disk,
 * where the next hour's session can read it; and only what the operator sees
 * - the panel and the email - has each handle put back as the full +digits,
 * after the scrub, so a secret stays masked.
 *
 * Handed, not hidden from: the sandbox lets the session read data/logs/,
 * data/state.json and the journal, which hold members' numbers in full, and
 * only its prompt's rule 6 keeps one out of what it writes - where the scrub
 * masks it anyway, and numberLog() makes sure such a mask is never filled in
 * with somebody else's number.
 */
export const NUMBERS_DIR = 'hourly-numbers';
export const numbersFile = (dataDir, id) => path.join(dataDir, NUMBERS_DIR, `${id}.json`);

/**
 * A record of what a scrub masked, handed to redactPersonal (through
 * sanitize, sanitizeDeep or withMaskLog). map() is the key: each handle to
 * the number it was made from, and the handles two different numbers (or
 * lids) made - "+1212***0147" is both +12125550147 and +12129990147 - which
 * are never filled in.
 *
 * An @lid id is not a phone number; its handle is filled in only when the
 * same object gives the number beside it (requesterJid with requesterNumber),
 * and only when that is one number. Ten bare digits are not one either, as
 * far as the key goes: "9735552861" masks to +973***2861, and that member's
 * number was +19735552861, so it is never filled in as +9735552861.
 */
export function numberLog() {
  const made = new Map();   // handle -> what made it: '+<digits>', 'nat:<digits>' or 'lid:<digits>'
  const links = new Map();  // lid digits -> the numbers given beside it
  const add = (map, key, v) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(v); };
  const SOURCE = { lid: 'lid:', national: 'nat:' };
  const log = (handle, kind, digits) => add(made, String(handle), `${SOURCE[kind] ?? '+'}${digits}`);
  log.link = (lid, number) => add(links, String(lid), String(number));
  log.made = made;
  /**
   * The key, kept to the handles in `shown` (the masked dossier's text) when
   * given. `also` is another log whose masks count against a handle - the
   * report's scrub: a number the session copied from the logs into its report
   * can mask to a handle the dossier already uses (any jid ending in the same
   * four digits does), and that handle is then two numbers, never filled in.
   * A number that contains a known secret, or is contained in one, is left
   * out: the scanner masks before it knows the secrets, so an all-digit
   * password in a quoted log line comes out looking like a phone number.
   */
  log.map = (shown = null, { also = null, secrets = [] } = {}) => {
    const numbers = {}, ambiguous = [];
    const secret = (number) => {
      const d = number.replace(/\D/g, '');
      return (secrets ?? []).some((s) => typeof s === 'string' && s.length >= 6
        && (s.includes(d) || d.includes(s) || s.replace(/[\s().+-]/g, '').includes(d)));
    };
    for (const [handle, mine] of made) {
      if (shown != null && !String(shown).includes(handle)) continue;
      const from = new Set([...mine, ...(also?.made?.get(handle) ?? [])]);
      const to = new Set([...from].flatMap((f) => (f.startsWith('lid:') ? [...(links.get(f.slice(4)) ?? [])] : f.startsWith('nat:') ? [] : [f])));
      if (from.size > 1 || to.size > 1) ambiguous.push(handle);
      else if (to.size === 1 && !secret([...to][0])) numbers[handle] = [...to][0];
    }
    return { numbers, ambiguous };
  };
  return log;
}

const LID = /^(\d{6,})@lid$/;
const PHONE_VALUE = /^\+?[0-9 ().-]+$/;

/** An object that gives a lid and a number side by side: requesterJid and requesterNumber, jid and number. */
function linkLids(obj, numbers) {
  for (const [k, v] of Object.entries(obj)) {
    const lid = LID.exec(String(v ?? '').trim());
    const m = /^(.*)(?:jid|Jid|JID)$/.exec(k);
    if (!lid || !m) continue;
    const beside = obj[m[1] ? `${m[1]}Number` : 'number'];
    if (beside == null || !PHONE_VALUE.test(String(beside).trim())) continue;
    const digits = String(beside).replace(/\D/g, '');
    if (digits.length >= 7 && digits.length <= 15) numbers.link(lid[1], `+${digits}`);
  }
}

/** Keep a run's key, private: the bot's user only, and outside what the research session may read. */
export function writeNumbers(dataDir, id, { numbers = {}, ambiguous = [] } = {}) {
  writeJson(numbersFile(dataDir, id), { v: 1, run: id, numbers, ambiguous });
}

/** Whether `handle` is what redactPersonal makes of `number`: the key is never taken on trust. */
function madeFrom(handle, number) {
  const digits = number.slice(1);
  if (handle.endsWith('@s.whatsapp.net')) return redactPersonal(`${digits}@s.whatsapp.net`) === handle;
  if (handle.endsWith('@lid')) return /^\*\*\*\d{4}@lid$/.test(handle);
  return redactPersonal(number) === handle;
}

/**
 * A run's key, { handle: '+digits' }, or null for a run without one (every
 * run before 2026-10-01, and an all-clear hour). The id is checked, since it
 * comes from a URL. A handle marked ambiguous, or one its number could not
 * have made, is left out.
 */
export function readNumbers(dataDir, id) {
  if (!RUN_ID.test(String(id))) return null;
  const raw = readJson(numbersFile(dataDir, id), null);
  if (!raw || typeof raw.numbers !== 'object' || raw.numbers === null) return null;
  const ambiguous = new Set(Array.isArray(raw.ambiguous) ? raw.ambiguous.map(String) : []);
  const out = {};
  for (const [handle, number] of Object.entries(raw.numbers)) {
    if (ambiguous.has(handle) || typeof number !== 'string' || !/^\+\d{6,20}$/.test(number)) continue;
    if (madeFrom(handle, number)) out[handle] = number;
  }
  return out;
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Text for the operator's eyes - the panel, the email - with each masked
 * number in `numbers` (readNumbers) put back as the full number. Run on text
 * already scrubbed: only a whole handle is replaced, only by the number that
 * made it, and nothing else in the text changes. A handle not in the key (one
 * the session made up, or an ambiguous one) stays as it is. Each of
 * `secrets` is masked again afterwards: the key is a record of digits, and
 * one a secret's scrub never saw - masked by the scanner before the secrets
 * were known, or a key saved in Settings since - must not come back in it.
 */
export function expandNumbers(text, numbers, secrets = []) {
  const handles = Object.keys(numbers ?? {});
  if (text == null || !handles.length) return text;
  // Not inside a longer number. A jid's handle may follow other stars or an
  // underscore - markdown bold or italics around its own three stars - since
  // redactPersonal never writes more than three.
  const alt = handles.sort((a, b) => b.length - a.length)
    .map((h) => (h.startsWith('+') ? `(?<![\\d+])${escapeRe(h)}(?!\\d)` : `(?<![A-Za-z0-9])${escapeRe(h)}(?![A-Za-z0-9-])`))
    .join('|');
  return maskSecrets(String(text).replace(new RegExp(alt, 'g'), (h) => numbers[h] ?? h), secrets);
}

/* ------------------------------ the record --------------------------- */

const RESTART_WORDS = {
  'not-needed': 'not needed',
  healthy: 'restarted, back and connected',
  'not-connected': 'restarted, not connected yet',
  'rolled-back': 'restarted - the updater rolled the fix back',
  'not-updated': 'restarted, but not onto the new commit',
  'crash-restarting': 'restarted, then crashed',
  down: 'restarted, and did not come back',
  'needs-sudo': 'needed: no sudo to restart with',
  failed: 'restart failed',
  skipped: 'skipped',
  off: 'turned off',
};

export function restartWords(outcome) {
  return RESTART_WORDS[outcome] ?? String(outcome ?? 'unknown');
}

/**
 * A run as the panel shows it: only what the card needs, scrubbed again.
 * `numbers` is the run's key (readNumbers): a member the session named by
 * their masked number - in the summary, a re-run, a thing to do - is shown
 * to the operator by the full one.
 */
export function panelRun(run, secrets = [], numbers = null) {
  const clean = (s, max = 400) => (s == null ? null : expandNumbers(sanitize(String(s), secrets).slice(0, max), numbers, secrets));
  return {
    id: run.id,
    at: run.at ?? null,
    finishedAt: run.finishedAt ?? null,
    result: run.result ?? 'unknown',
    found: Number(run.found ?? 0),
    notices: Number(run.notices ?? 0),
    // What was noted, by title: the rating digest, a settings note, a disk
    // getting full. An all-clear hour can carry them, and "2 noted" alone
    // tells the owner nothing.
    noted: (Array.isArray(run.noted) ? run.noted : []).slice(0, 10).map((n) => clean(n, 300)),
    headline: clean(run.headline, 200),
    // A run started between the hours for a library keeper's #issue
    // (check-now.js), and whose: the operator, 2026-10-12, "Needless to say
    // #issue tickets submitted by head admin ... get top priority".
    trigger: run.trigger === 'asked' ? 'asked' : 'hourly',
    asked: (Array.isArray(run.asked) ? run.asked : []).slice(0, 5).map((a) => ({
      at: clean(a?.at, 40), who: clean(a?.who, 80), group: clean(a?.group, 120), text: clean(a?.text, 300),
    })),
    summary: clean(run.summary, 600),
    claude: run.claude ? { outcome: run.claude.outcome ?? null, detail: clean(run.claude.detail, 200) } : null,
    commits: (Array.isArray(run.commits) ? run.commits : []).slice(0, 10).map((c) => ({
      sha: /^[0-9a-f]{7,40}$/.test(String(c.sha)) ? c.sha : null,
      subject: clean(c.subject, 120),
      url: /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/commit\/[0-9a-f]{7,40}$/.test(String(c.url)) ? c.url : null,
    })).filter((c) => c.sha),
    pushedTo: clean(run.pushedTo, 80),
    restart: run.restart ? {
      outcome: run.restart.outcome ?? null,
      words: restartWords(run.restart.outcome),
      detail: clean(run.restart.detail, 300),
    } : null,
    refused: (Array.isArray(run.refused) ? run.refused : []).slice(0, 5).map((r) => clean(r, 300)),
    alerts: (Array.isArray(run.alerts) ? run.alerts : []).slice(0, 5).map((r) => clean(r, 400)),
    reruns: (Array.isArray(run.reruns) ? run.reruns : []).slice(0, 10).map((r) => clean(r, 160)),
    userActions: (Array.isArray(run.userActions) ? run.userActions : []).slice(0, 10).map((r) => clean(r, 300)),
    emailed: run.emailed ?? null,
    hasReport: !!run.hasReport,
  };
}

/**
 * Whether the check is running at all, as far as the panel can tell: it is
 * a cron job the bot cannot see, so "the last run was hours ago" is the only
 * sign that it has stopped, or was never installed.
 */
export function checkStatus(runs, now = Date.now()) {
  const last = runs[0] ?? null;
  const lastAt = last?.at ?? null;
  return {
    lastRunAt: lastAt,
    overdue: !lastAt || now - lastAt > 2 * 3600_000,
    lastFoundAt: runs.find((r) => r.found > 0)?.at ?? null,
    runsToday: runs.filter((r) => now - (r.at ?? 0) < 86_400_000).length,
    claudeReady: last?.env?.claude ?? null,
    sudoReady: last?.env?.sudo ?? null,
  };
}

/**
 * What deploy/install-hourly-debug.sh last did: data/hourly-debug/install.json,
 * { at, event: install|remove|token, cron, token, verify: ok|failed|not-run }.
 * The bot cannot look at the crontab itself (NoNewPrivileges takes away the
 * setgid bit crontab needs), so this and the runs are all it knows.
 */
export function readInstallRecord(dataDir) {
  const raw = readJson(path.join(hourlyDir(dataDir), 'install.json'), null);
  const at = Date.parse(raw?.at);
  if (!raw || !Number.isFinite(at)) return null;
  return {
    at,
    event: ['install', 'remove', 'token'].includes(raw.event) ? raw.event : 'unknown',
    cron: raw.cron === true,
    token: raw.token === true,
    // no-sandbox: not tested, because the sandbox would not start (WSL).
    verify: ['ok', 'failed', 'not-run', 'no-sandbox'].includes(raw.verify) ? raw.verify : 'not-run',
  };
}

/**
 * The hourly check as the fresh-install checklist shows it (GET /diagnostics):
 * installed or not, whether it has a Claude token, and how the last run went.
 * `skipped` is tools/routines.mjs --skip's reason, when this box does without
 * it. Read-only, from files the bot's user already owns.
 */
export function hourlyCheckSummary(dataDir, { now = Date.now(), secrets = [], skipped = null } = {}) {
  const runs = readRuns(dataDir);
  const last = runs[0] ?? null;
  return {
    skipped: skipped ? sanitize(String(skipped), secrets).slice(0, 200) : null,
    install: readInstallRecord(dataDir),
    status: checkStatus(runs, now),
    lastRun: last ? {
      at: last.at ?? null,
      result: last.result ?? 'unknown',
      found: Number(last.found ?? 0),
      headline: last.headline == null ? null : sanitize(String(last.headline), secrets).slice(0, 160),
      claude: last.env?.claude == null ? null : sanitize(String(last.env.claude), secrets).slice(0, 200),
      alerts: Array.isArray(last.alerts) ? last.alerts.length : 0,
    } : null,
  };
}

/* ------------------------------ the report --------------------------- */

const fence = (s) => String(s ?? '').replace(/`/g, "'");

/**
 * The report a run leaves when no AI session wrote one - not set up, turned
 * off, timed out, or failed - so the operator still hears what was found.
 */
export function fallbackReport({ id, scanResult, claude, healthRestart = null, ships = [], others = [], alerts = [], asked = null }) {
  const r = scanResult;
  const out = [];
  out.push(`# Hourly check ${id}`);
  out.push('');
  out.push(`Checked ${fmtTime(r.now)}, looking back to ${fmtTime(r.since)}.`);
  out.push('');
  // Whose #issue the run was started or taken for (check-now.js), as the
  // check itself says it: a library keeper's, top priority.
  if (asked) out.push(asked, '');
  for (const a of alerts) out.push(`**ALERT:** ${a}`, '');
  if (claude && claude.outcome !== 'finished') {
    out.push(`**No AI research this run:** ${claude.detail ?? claude.outcome}. These are the findings as the scanner saw them.`);
    out.push('');
  }
  // The beta groups' tests are listed apart, under their own heading, with
  // the conversation: a test is not a member let down (beta-scan.js).
  const members = r.incidents.filter((f) => !f.beta);
  out.push(`## Found (${members.length})`);
  out.push('');
  if (!members.length) out.push('Nothing new.');
  for (const f of members) out.push(...incidentLines(f));
  const beta = betaReportSection([...r.incidents, ...r.notices]);
  if (beta.length) out.push('', ...beta);
  if (r.notices.length) {
    out.push('');
    out.push(`## Also noted (${r.notices.length})`);
    out.push('');
    for (const f of r.notices.filter((n) => !n.beta)) {
      out.push(`- ${f.ref} ${fence(f.title)}`);
      if (f.remedy) out.push(`  - what to do: ${fence(f.remedy)}`);
    }
  }
  if (r.overflow) out.push('', `…and ${r.overflow} more, not listed.`);
  out.push('');
  out.push('## Restart');
  out.push('');
  out.push(`For the bot's health: ${restartParagraph(r.restart, healthRestart)}`);
  for (const x of ships) {
    if (x.outcome === 'shipped') {
      out.push('', `## Shipped to ${x.pushedTo}`, '');
      for (const c of x.commits ?? []) out.push(`- ${c.short ?? c.sha?.slice(0, 7)} ${fence(c.subject)}${c.url ? ` — ${c.url}` : ''}`);
      out.push('', `Restart: ${x.restart ? restartParagraph(null, x.restart) : 'none - nothing is deployed from a branch.'}`);
    } else {
      out.push('', `Refused to ship ${x.asked ? String(x.asked).slice(0, 7) : 'a request'}: ${fence(x.why)}`);
    }
  }
  // A restart into a fix deploys whatever else was on main by then; the
  // report said otherwise once, and with several branches landing on main in
  // a day it will happen.
  const deployed = others.filter((c) => c.deployed);
  const waiting = others.filter((c) => !c.deployed);
  if (deployed.length) {
    out.push('', 'Also on main from elsewhere, and deployed by this check\'s restart:', '');
    for (const c of deployed) out.push(`- ${c.short ?? c.sha?.slice(0, 7)} ${fence(c.subject)}`);
  }
  if (waiting.length) {
    out.push('', 'Also new on main from elsewhere, not deployed by this check (they go live at the next restart):', '');
    for (const c of waiting) out.push(`- ${c.short ?? c.sha?.slice(0, 7)} ${fence(c.subject)}`);
  }
  return `${out.join('\n')}\n`;
}

function incidentLines(f) {
  const lines = [`- **${f.ref}** ${fence(f.title)}`];
  const q = f.request;
  if (q) {
    const who = [q.requester && `from ${q.requester}`, q.group && `in ${q.group}`].filter(Boolean).join(' ');
    if (q.text) lines.push(`  - asked: \`${fence(q.text).slice(0, 200)}\`${who ? ` ${who}` : ''}`);
    else if (who) lines.push(`  - ${who}`);
    if (q.detail) lines.push(`  - detail: ${fence(q.detail)}`);
  }
  for (const e of (f.evidence ?? []).slice(0, 4)) lines.push(`  - \`${fence(e).slice(0, 240)}\``);
  // The scanner's own remedy, where it knows one (a full disk, a duplicate
  // in the queue, a member refused and asking again): the report must say
  // what to do even when no research session ran.
  if (f.remedy) lines.push(`  - what to do: ${fence(f.remedy)}`);
  if (f.needsPerson) lines.push(`  - needs a person: ${f.needsPerson}`);
  return lines;
}

export function restartParagraph(advice, restart) {
  if (restart) {
    return `${restartWords(restart.outcome)}${restart.detail ? ` — ${restart.detail}` : ''}${restart.reason ? ` (why: ${restart.reason})` : ''}.`;
  }
  if (advice?.advised) return `Advised (${advice.reasons.join('; ')}), not done.`;
  if (advice?.blockedBy?.length) return `Not restarted: ${advice.blockedBy.join('; ')}.`;
  return 'Not needed - nothing a restart would cure, and restarting throws away every encode in progress.';
}
