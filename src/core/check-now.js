/**
 * The hourly check, asked for at once: the file the bot writes when a library
 * keeper reports an #issue, and the check takes when it runs.
 *
 * The operator, 2026-10-12: "Needless to say #issue tickets submitted by
 * head admin 5558100180 get top priority" and "Meaning it should activate bot
 * to send yo a notification to check right away". Head Admin looks after the
 * Jellyfin library, and an #issue she wrote in the discussions group waited
 * for the top of the hour like anybody's (library-news.js).
 *
 * The bot cannot start the check itself. Its unit sets NoNewPrivileges, and
 * the check restarts the bot with sudo, which no_new_privs breaks; and a
 * child of the bot's service is killed with the bot's cgroup when the check
 * restarts the bot. So the bot only writes <dataDir>/check-now.json, and
 * cron's line - a tick every minute (deploy/hourly-debug/tick.sh) -
 * runs the check when the file is there, with cron's environment and the
 * token from the settings file, exactly as on the hour.
 *
 * The file is { v: 1, asked: [{ at, id, sender, name, group, groupName,
 * text, askedAt }], notBefore }. `at` is the #issue's own time, the `at` of
 * its row in library-news.jsonl, and `askedAt` the bot's clock when it wrote
 * the ask, after the row: a run takes the asks its scan covered, which is
 * the rows it read (tools/hourly-debug.mjs). `notBefore` lets a ticket
 * written over two or three messages be read whole: two minutes after the
 * latest ask, but never more than ten after the first one still waiting, so
 * a stream of messages cannot put the check off for ever.
 *
 * Two processes write the file - the bot adding an ask, the check taking
 * what it covered and putting the rest back - and neither may lose what the
 * other wrote. A read-modify-write would: the bot reads no file, the check
 * puts its remainder back, the bot's rename lands on top. So nothing here is
 * rewritten in place. A writer takes the file whole by renaming it to a name
 * of its own, which only one rename can win, and puts its content back with
 * link(), which - unlike rename - fails when a file is already there: one the
 * other process wrote meanwhile, which is then taken in turn and merged, and
 * the put tried again. At every moment an ask is in the file, or in the hands
 * of a process that is putting it back. An ask the check takes twice costs an
 * extra run; one lost would leave Head Admin's #issue waiting for the hour.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MIN = 60_000;
/** How long after the latest ask the check waits, for the rest of a ticket. */
export const SETTLE_MS = 2 * MIN;
/** And never longer than this after the first ask still waiting. */
export const MAX_SETTLE_MS = 10 * MIN;
/** What an ask keeps of the message: enough to say what it was about. */
export const ASK_TEXT_MAX = 300;

export const checkNowFile = (dataDir) => path.join(dataDir, 'check-now.json');

/** When the check may run for these asks, or null for none. */
export function notBeforeOf(asked = []) {
  const ats = asked.map((a) => Number(a?.at)).filter(Number.isFinite);
  if (!ats.length) return null;
  return Math.min(Math.max(...ats) + SETTLE_MS, Math.min(...ats) + MAX_SETTLE_MS);
}

/** The ask for a library-news row (library-news.js record()), written at `askedAt`. */
export function askOf(row, askedAt = Date.now()) {
  return {
    at: row.at,
    id: row.id ?? null,
    sender: row.sender ?? null,
    name: row.name ?? null,
    group: row.group ?? null,
    groupName: row.groupName ?? null,
    text: String(row.text ?? '').slice(0, ASK_TEXT_MAX),
    askedAt,
  };
}

/**
 * One message, however many times it was asked for: a message id is the
 * sender's, so it is paired with the sender; without one, its time.
 */
export const askKey = (a) => (a?.id ? `id:${a.id}:${a.sender ?? ''}` : `at:${a?.at}:${a?.sender ?? ''}`);

/** Every ask once, oldest first. */
export function mergeAsks(...lists) {
  const byKey = new Map();
  for (const a of lists.flat()) if (a && Number.isFinite(Number(a.at)) && !byKey.has(askKey(a))) byKey.set(askKey(a), a);
  return [...byKey.values()].sort((x, y) => x.at - y.at);
}

const unique = (file, what) => `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.${what}`;

/**
 * What a file of asks holds; null for one that does not parse. Its
 * notBefore is worked out from the asks, not taken from the file: the bot
 * writes the same figure, and nothing else gets to put the check off.
 */
function parse(text) {
  try {
    const j = JSON.parse(text);
    if (!j || !Array.isArray(j.asked)) return null;
    const asked = mergeAsks(j.asked);
    return { asked, notBefore: notBeforeOf(asked) };
  } catch { return null; }
}

/**
 * The file as it is now, without touching it: { asked, notBefore }, null
 * when there is none, or { corrupt: true } when it does not parse.
 */
export function readCheckNow(dataDir) {
  let text;
  try { text = fs.readFileSync(checkNowFile(dataDir), 'utf8'); } catch { return null; }
  return parse(text) ?? { corrupt: true, asked: [], notBefore: null };
}

/**
 * Whether the file is to be looked at, at `now`: 'absent' (a run since took
 * it), 'waiting' (a ticket may still be being written), or 'due'. A file the
 * bot cannot have written as it is - one that does not parse, holds no ask,
 * or would put the check off longer than any settle the bot sets - is due at
 * once: not for a run, but for the check to drop what in it names no
 * library keeper's #issue (keeperIssueTest), so that it neither starts a run
 * nor waits there for ever, starting node every minute.
 */
export function checkNowDue(dataDir, now = Date.now()) {
  const f = readCheckNow(dataDir);
  if (!f) return 'absent';
  if (f.corrupt || f.notBefore == null || f.notBefore > now + MAX_SETTLE_MS) return 'due';
  return now < f.notBefore ? 'waiting' : 'due';
}

/**
 * The check's own test that an ask is a library keeper's #issue, which alone
 * may start a run between the hours: a row in library-news.jsonl (`rows`)
 * for the ask's message, at the ask's time, an #issue, marked a keeper's by
 * the bot or from a number the settings name a keeper (`keepers`,
 * newsSettings().senders) - the test the scan makes (incident-scan.js
 * newsFindings). The request file is only the bot's word for it. A review
 * (2026-10-12) found that a file of any content there was a run: the
 * research session could make the check write one (hourly-checks.js
 * writeText), and so start itself again every minute instead of once an
 * hour. The bot appends the row before it asks, so a real ask always has
 * one.
 */
export function keeperIssueTest(rows = [], keepers = new Set()) {
  const issues = new Map();
  for (const r of rows) {
    if (r?.kind === 'issue' && (r.keeper === true || keepers.has(String(r.sender ?? '')))) issues.set(askKey(r), r);
  }
  return (a) => {
    const r = issues.get(askKey(a));
    return !!r && Number(r.at) === Number(a?.at);
  };
}

/** Take the file whole, if it is there: its asks, or null when another process took it first. */
function grab(file) {
  const mine = unique(file, 'taking');
  try { fs.renameSync(file, mine); } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let text = '';
  try { text = fs.readFileSync(mine, 'utf8'); } finally { fs.rmSync(mine, { force: true }); }
  return parse(text) ?? { asked: [], corrupt: true };
}

/** Put `asked` back, merged with whatever another process put there meanwhile. */
function put(file, asked) {
  let pending = mergeAsks(asked);
  for (let i = 0; i < 50 && pending.length; i++) {
    const tmp = unique(file, 'tmp');
    fs.writeFileSync(tmp, `${JSON.stringify({ v: 1, asked: pending, notBefore: notBeforeOf(pending) }, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.linkSync(tmp, file);
      fs.rmSync(tmp, { force: true });
      return pending;
    } catch (err) {
      if (err.code !== 'EEXIST') {
        // A filesystem without hard links: renamed into place instead. Only
        // a put that lands in the same instant as the other process's can
        // then lose its asks; every disk this bot has run on links.
        if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'].includes(err.code)) {
          fs.renameSync(tmp, file);
          return pending;
        }
        fs.rmSync(tmp, { force: true });
        throw err;
      }
      fs.rmSync(tmp, { force: true });
      const there = grab(file);
      if (there) pending = mergeAsks(pending, there.asked);
    }
  }
  if (pending.length) throw new Error('the request file kept changing under the put');
  return pending;
}

/**
 * The bot's side: ask for a check now, for this row (or rows). Asks already
 * waiting are kept, and the settle starts again from the latest - within
 * its cap. Returns what the file now holds. Throws on a write that fails;
 * the caller logs it and goes on (library-news.js).
 */
export function askForCheck(dataDir, rows, { now = Date.now() } = {}) {
  const file = checkNowFile(dataDir);
  const asks = (Array.isArray(rows) ? rows : [rows]).map((r) => askOf(r, now));
  const there = grab(file);
  const asked = put(file, mergeAsks(there?.asked ?? [], asks));
  return { asked, notBefore: notBeforeOf(asked) };
}

/**
 * The check's side: take the asks `covers` says this run covered, and put
 * the rest back for a later tick. Returns those taken, oldest first, and
 * whether the file was unreadable (`corrupt`, consumed all the same).
 */
export function takeAsks(dataDir, covers) {
  const file = checkNowFile(dataDir);
  const there = grab(file);
  if (!there) return { taken: [], corrupt: false };
  const taken = there.asked.filter((a) => covers(a));
  const rest = there.asked.filter((a) => !taken.includes(a));
  if (rest.length) put(file, rest);
  return { taken, corrupt: !!there.corrupt };
}
