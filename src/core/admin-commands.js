/**
 * Local admin command channel.
 *
 * Privileged, one-off group operations (backing up descriptions, rewriting them
 * in bulk, seeding per-group rule sets) need to be driven by whoever runs the
 * box, without the web-panel password. index.js polls a single JSON file in the
 * data dir and hands each command here. Everything is local to the server, only
 * whitelisted ops run, and every execution is logged by the caller.
 */
import fs from 'node:fs';
import path from 'node:path';
import { runningCommit, processStartedAt } from './auto-update-status.js';
import { redactPersonal } from '../util/mailer.js';
import { rerunRefusal } from './hourly-policy.js';
import { parseJellyfinUrl } from './jellyfin-url.js';
import { libraryItemById, tvItemRefusal } from '../plugins/movie-requests/library.js';
import { nextAsk } from '../plugins/tv-requests/next-part.js';
import { addWantedNote } from './wanted.js';
import { markExtras } from './mark-extras.js';
import log from '../util/logger.js';

const logger = log.scope('admin-commands');

// Read once, when the process starts: the hourly check compares it with the
// commit it just pushed to see whether the restart really brought the fix in.
// Reading HEAD later would report a checkout moved under a running process as
// if the code in memory had moved with it.
const STARTED_COMMIT = runningCommit();

function writeJson(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Snapshot every group's description into data/backups/. The "original" file is
 * write-once per group: a description is only recorded the first time we see it,
 * so the pre-edit text is preserved even after we rewrite descriptions later.
 * A rolling "latest" snapshot is always refreshed for convenience.
 */
export function backupOriginalDescriptions(bot, dataDir, now = Date.now()) {
  const backupsDir = path.join(dataDir, 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });
  const originalFile = path.join(backupsDir, 'original-descriptions.json');

  let original = {};
  if (fs.existsSync(originalFile)) {
    try { original = JSON.parse(fs.readFileSync(originalFile, 'utf8')) || {}; }
    catch { original = {}; }
  }

  const snap = bot.groupDescriptionsSnapshot();
  let added = 0;
  for (const g of snap) {
    if (!(g.jid in original)) {
      original[g.jid] = { subject: g.subject, desc: g.desc, savedAt: now };
      added++;
    }
  }
  writeJson(originalFile, original);
  writeJson(path.join(backupsDir, 'descriptions-latest.json'), { at: now, groups: snap });
  return { total: snap.length, newlyBackedUp: added, originalFile };
}

/**
 * Ops that CHANGE something. The rest only read, and flooding the audit log
 * with reads buries the changes - which is the opposite of what it is for.
 */
const MUTATING_OPS = new Set([
  'apply-descriptions', 'post-descriptions', 'set-rule-sets', 'backup-descriptions', 'requeue', 'queue', 'queue-item',
  'pause-requests', 'resume-requests', 'trim-tv-requests', 'mark-extras', 'import-drive-links', 'post-drive-links',
]);

/** One audit line describing what an admin command actually did. */
export function summariseAdminCommand(cmd, result, err = null) {
  const op = cmd?.op ?? '(unparsed)';
  if (err) return { action: `admin command "${op}" FAILED`, detail: err.message };

  const rs = Array.isArray(result?.results) ? result.results : [];
  const ok = rs.filter((r) => r.ok);
  const failed = rs.filter((r) => r.ok === false);
  const names = (list) => list.map((r) => r.subject ?? r.jid).join(' · ');

  switch (op) {
    case 'apply-descriptions':
      return {
        action: `rewrote the description of ${ok.length} group(s)`,
        detail: names(ok) + (failed.length ? ` — FAILED: ${names(failed)}` : ''),
      };
    case 'post-descriptions': {
      const pinned = ok.filter((r) => r.pinned);
      return {
        action: `posted the description into ${ok.length} group(s), pinned ${pinned.length}`,
        detail: names(ok) + (failed.length ? ` — FAILED: ${names(failed)}` : ''),
      };
    }
    case 'set-rule-sets':
      return {
        action: 'updated the rule sets',
        detail: Array.isArray(cmd.ruleSets)
          ? cmd.ruleSets.map((r) => r.command).filter(Boolean).join(' · ')
          : null,
      };
    case 'backup-descriptions':
      return {
        action: `backed up ${result?.total ?? 0} group description(s)`,
        detail: result?.newlyBackedUp ? `${result.newlyBackedUp} newly recorded` : 'no new originals',
      };
    case 'requeue':
      return {
        action: `${cmd.repost === true ? 're-posted' : 're-ran'} "${result?.queued ?? '?'}" for ${result?.original?.requester ?? 'a member'}`,
        detail: `${cmd.by ? `${String(cmd.by).slice(0, 80)} - ` : ''}the ${cmd.plugin} request ${cmd.id} had ${result?.original?.status ?? '?'}`
          + (result?.original?.detail ? ` (${result.original.detail})` : ''),
      };
    case 'queue-item':
      // The id only: a pasted Download link carries the server's api_key.
      return {
        action: `queued "${result?.queued ?? '?'}" from the box`,
        detail: `${cmd.by ? `${String(cmd.by).slice(0, 80)} - ` : ''}Jellyfin item ${result?.id ?? '?'}`
          + (result?.note ? ` (${String(result.note).slice(0, 200)})` : ''),
      };
    case 'queue':
      return {
        action: `queued "${result?.queued ?? '?'}" from the box`,
        detail: `${cmd.by ? `${String(cmd.by).slice(0, 80)} - ` : ''}asked as "${String(cmd.text ?? '').slice(0, 120)}"`
          + (result?.note ? ` (${String(result.note).slice(0, 200)})` : ''),
      };
    case 'pause-requests':
      return {
        action: result?.already ? 'paused requests from the box (they already were)'
          : `paused requests from the box${result?.pausedQueue ? ', and the queue' : ' (the queue was already paused)'}`,
        detail: cmd.by ? String(cmd.by).slice(0, 80) : null,
      };
    case 'resume-requests':
      return {
        action: result?.already ? 'resumed requests from the box (they were not paused)'
          : `resumed requests from the box${result?.resumedQueue ? ', and the queue' : ''}`,
        detail: `${cmd.by ? `${String(cmd.by).slice(0, 80)} - ` : ''}`
          + `${result?.ran ? `running the ${result.ran} held request(s), in the order they came` : 'none were held'}`,
      };
    case 'trim-tv-requests': {
      // A dry run changed nothing, and is not a change to audit. The names
      // of what was trimmed, never the members' numbers.
      if (!result?.applied) return null;
      const list = Array.isArray(result.requests) ? result.requests : [];
      return {
        action: `trimmed ${list.length} queued TV request(s) to at most ${result.max ?? '?'} episodes each`,
        detail: `${cmd.by ? `${String(cmd.by).slice(0, 80)} - ` : ''}`
          + (list.length
            ? list.map((r) => `${r.request}: ${r.takenOff} taken off, ${r.episodes?.after ?? '?'} kept`).join(' · ')
            : 'none was over the limit'),
      };
    }
    case 'import-drive-links':
      return {
        action: `kept ${result?.added ?? 0} new Drive link(s) from ${cmd.source === 'list' ? 'a member\'s link list' : 'a chat export'}`,
        detail: `${cmd.by ? `${String(cmd.by).slice(0, 80)} - ` : ''}${result?.total ?? '?'} in the archive`,
      };
    case 'post-drive-links':
      return {
        action: `posted the Google Drive Links document (${result?.links ?? '?'} links) to ${cmd.to}`,
        detail: cmd.by ? String(cmd.by).slice(0, 80) : null,
      };
    case 'mark-extras': {
      // A dry run changes nothing, so it is a read like any other.
      if (!result?.applied) return null;
      const marked = (result.requests ?? []).filter((r) => r.changed);
      return {
        action: `made ${marked.length} waiting request(s) extras: asked for inside their member's cooldown`,
        detail: `${cmd.by ? `${String(cmd.by).slice(0, 80)} - ` : ''}`
          + (marked.length
            ? marked.map((r) => `${r.label} (${r.gap} after "${r.previous?.request ?? r.previous?.title ?? '?'}")`).join(' · ')
            : 'none needed it'),
      };
    }
    case 'wanted-note':
      return {
        action: `added a note to ${result?.title ?? cmd.key}${result?.year ? ` (${result.year})` : ''} on the wanted list`,
        detail: redactPersonal(String(result?.note?.text ?? cmd.text ?? '')).slice(0, 500),
      };
    default:
      return null;                       // a read - not an audit event
  }
}

/**
 * What the bot writes to data/bot-cmd.result.json for a command: its op, when,
 * the result, and the command's `ref` when it came with one. The channel runs
 * one command at a time, so one that outlasts its asker's wait answers late,
 * and the hourly check, matching by op and time alone, read a re-run still
 * waiting out OMDb's retries as the answer to its next re-run (found in
 * review, 2026-10-12). The ref says which command an answer is to.
 */
export function answerFor(cmd, fields, now = Date.now()) {
  const ref = typeof cmd?.ref === 'string' && cmd.ref ? { ref: cmd.ref.slice(0, 80) } : {};
  return { op: cmd?.op ?? null, at: now, ...fields, ...ref };
}

/**
 * Record an admin command in the audit log. These run from the box rather than
 * the portal, so there is no session behind them - the actor is the operator
 * with shell access, recorded as such. The description rollout previously left
 * no trace at all: fifteen groups rewritten, posted into and pinned, with
 * nothing in the audit log to show it happened.
 */
export function auditAdminCommand(stateStore, cmd, result, err = null) {
  try {
    if (!err && !MUTATING_OPS.has(cmd?.op)) return;
    const s = summariseAdminCommand(cmd, result, err);
    if (!s) return;
    stateStore.namespace('audit').push('events', {
      ts: Date.now(),
      user: 'admin-command (local shell)',
      role: 'operator',
      ip: 'local',
      action: s.action,
      detail: s.detail ?? `op: ${cmd?.op ?? '?'}`,
    }, 2000);
  } catch {
    /* the audit log must never break the command it is recording */
  }
}

/** One queue as `health` reports it: what runs, since when, and how recently it moved. */
function queueHealth(q) {
  if (!q) return { active: 0, waiting: 0, retrying: 0, paused: false, running: [] };
  return {
    active: q.active?.size ?? 0,
    waiting: q.pending?.length ?? 0,
    // Waiting for a retry, in no queue: see queue-status.
    retrying: q.retrying?.size ?? 0,
    paused: !!q.paused,
    running: [...(q.active ?? new Map()).entries()].map(([id, e]) => {
      // A job waiting in line for a stage slot reports no progress until the
      // slot frees, which can take the best part of an hour behind two
      // encodes. Without this the hourly check took such a film for stuck
      // and restarted the bot, throwing away the encode it was waiting for.
      // A TV episode waiting for the encoder does not even say "wait": its
      // stage still reads "download" from the download it finished.
      const waiting = q.stageWaits?.where?.(e.id ?? id) ?? null;
      return {
        label: e.label ?? '?',
        kind: e.kind ?? null,
        startedAt: e.startedAt ?? null,
        progressAt: e.progress?.at ?? null,
        stage: e.progress?.stage ?? null,
        ...(waiting ? { waitingFor: { stage: waiting.stage, position: waiting.position, of: waiting.of } } : {}),
      };
    }),
  };
}

/** Whether requests are paused, for health and queue-status: nothing at all when the process cannot pause them. */
function requestsPaused(requestPause) {
  if (!requestPause) return {};
  const s = requestPause.snapshot();
  return {
    requests: {
      paused: s.paused, since: s.since, by: s.by, held: s.held, replaying: s.replaying,
      queuePaused: !!s.queue?.paused,
    },
  };
}

/** Are held requests being run now (request-pause.js replay)? */
function heldReplaying(requestPause) {
  return !!requestPause?.snapshot?.().replaying;
}

// rerunRefusal is the hourly check's policy for what the `requeue` op may
// re-run, and lives with the rest of it in a file a fix from the check may
// not change (hourly-policy.js); re-exported here, where it always was.
export { rerunRefusal };

const NAMESPACE = { movie: 'movie-requests', tv: 'tv-requests' };

/** Execute one admin command against the live bot. Throws on unknown ops. */
export async function runAdminCommand(cmd, {
  bot, dataDir, configStore, stateStore = null, queue = null, linkQueue = null, pluginManager = null,
  requestPause = null, lookupItem = libraryItemById,
} = {}) {
  switch (cmd?.op) {
    case 'dump-descriptions': {
      const groups = bot.groupDescriptionsSnapshot();
      return { ok: true, count: groups.length, groups };
    }

    case 'wanted-note': {
      // A note on a Wanted entry, written by the bot itself - as the panel's
      // note box does, into the same store, with the same limits. The
      // operator, 2026-10-11, of films asked for from the Jellyfin host: "make
      // a note on those items in the panel". The box needs a signed-in admin
      // and the state file must never be edited under the running bot, so an
      // operator on the box writes them through here. Audited like every
      // change (summariseAdminCommand).
      if (!stateStore) throw new Error('stateStore unavailable');
      const key = String(cmd.key ?? '').trim();
      if (!key) throw new Error('key required - the Wanted entry\'s IMDb id, or "title|year"');
      const r = addWantedNote(stateStore.namespace('movie-requests'), key, {
        by: String(cmd.by ?? 'local shell').slice(0, 80), text: cmd.text,
        // auto: a fact the bot itself knows (found on the server, not told),
        // shown quieter and never an hourly incident - only an admin's note
        // asks the hourly check for something (incident-scan.js wantedFindings).
        auto: cmd.auto === true,
      });
      if (r.error) throw new Error(r.error);
      return { ok: true, title: r.entry.title ?? null, year: r.entry.year ?? null, note: r.note };
    }

    case 'decrypt-failures': {
      // Whose messages this number could not decrypt since it started, most
      // first (decrypt-watch.js). A message that fails is dropped unread.
      return { ok: true, senders: bot.decryptWatch?.summary() ?? [] };
    }

    case 'dump-groups': {
      // Includes the community each group is linked to, which decides whether
      // a group @-mention will actually render for members.
      return { ok: true, groups: bot.groups() };
    }

    case 'queue-status': {
      // Ask the process, do not parse the log. Both queues log through the
      // same scope, so a short link-queue job finishing prints "0 still
      // active" while three feature films are mid-encode on the media queue -
      // which read as "safe to restart" three separate times.
      //
      // Counted in requests, as the panel shows them: a TV season is one,
      // named with the episode(s) in hand. A season between two episodes,
      // or held behind a movie, still counts as running, so "busy" cannot
      // read as idle while any of it is left.
      const inFlight = (e) => (e.current?.length
        ? `${e.label ?? '?'} (${e.current.map((c) => c.label ?? '?').join(', ')})`
        : e.label ?? '?');
      const snap = (q) => {
        if (!q) return { active: 0, waiting: 0, retrying: 0, running: [] };
        if (typeof q.snapshot !== 'function') {
          return {
            active: q.active?.size ?? 0,
            waiting: q.pending?.length ?? 0,
            retrying: q.retrying?.size ?? 0,
            running: [...(q.active ?? new Map()).values()].map((e) => e.label ?? '?'),
          };
        }
        const s = q.snapshot();
        return {
          active: s.active.length, waiting: s.pending.length, retrying: s.retrying?.length ?? 0,
          running: [...s.active.map(inFlight)],
          // In no queue between a failure and its retry, and about to be
          // posted: a restart then replays it from the journal, later.
          ...(s.retrying?.length ? { retryingNow: s.retrying.map((r) => r.label ?? '?') } : {}),
        };
      };
      const media = snap(queue);
      const links = snap(linkQueue);
      const busy = media.active + media.waiting + media.retrying + links.active + links.waiting + links.retrying > 0;
      // Held requests survive a restart (request-pause.js), so they do not
      // make it unsafe; they are said, so nobody reads ⏸️ as a stuck bot.
      // Running them does: each is taken off the disk as it is handed over,
      // and a film request mid-lookup has no History row or journal entry
      // yet, so a restart then lost it without a trace (found in review,
      // 2026-10-01).
      const replaying = heldReplaying(requestPause);
      return { ok: true, busy, safeToRestart: !busy && !replaying, media, links, ...requestsPaused(requestPause) };
    }

    case 'health': {
      // Read only. What the hourly check asks before deciding anything, and
      // after a restart to confirm the bot came back on the right commit: the
      // connection as the bot sees it, and each running job with the time it
      // last reported progress - the log only says when a job started, which
      // cannot tell a slow encode from a stuck one.
      const st = bot.status?.() ?? {};
      const media = queueHealth(queue);
      const links = queueHealth(linkQueue);
      return {
        ok: true,
        pid: process.pid,
        startedAt: processStartedAt(),
        commit: STARTED_COMMIT,
        connection: {
          state: st.state ?? null,
          lastError: st.lastError ? redactPersonal(String(st.lastError)).slice(0, 300) : null,
          reconnectAttempts: st.reconnectAttempts ?? 0,
          nextReconnectAt: st.nextReconnectAt ?? null,
          linking: !!st.linking,
        },
        queues: { media, links },
        // Not while held requests are being run, as for queue-status.
        safeToRestart: media.active + media.waiting + media.retrying + links.active + links.waiting + links.retrying === 0
          && !heldReplaying(requestPause),
        ...requestsPaused(requestPause),
      };
    }

    case 'requeue': {
      // The one op here that queues work, so the rules are strict: a failed
      // request, from a main group, not re-run before, not asked for again
      // since - see rerunRefusal. Audited like every change.
      const kind = cmd.plugin === 'tv' ? 'tv' : cmd.plugin === 'movie' ? 'movie' : null;
      if (!kind) throw new Error('plugin must be "movie" or "tv"');
      const id = String(cmd.id ?? '').trim();
      if (!id) throw new Error('id required - the history row\'s id');
      const loaded = pluginManager?.plugins?.get(NAMESPACE[kind]);
      if (!loaded?.plugin?.requeue || !loaded.ctx?.store) throw new Error(`the ${kind} plugin is not loaded`);
      if (!stateStore) throw new Error('stateStore unavailable');
      const history = loaded.ctx.store.get('history', []) ?? [];
      const row = history.find((r) => r?.id === id);
      const ledgerNs = stateStore.namespace('hourly-checks');
      const ledger = ledgerNs.get('requeued', {}) ?? {};
      const journal = loaded.ctx.store.get('pending', []) ?? [];
      const repost = cmd.repost === true;
      const refusal = rerunRefusal({ plugin: kind, row, history, ledger, journal, repost });
      if (refusal) throw new Error(`not re-run: ${refusal}`);

      // A TV request the episode limit cut, or trimmed to it, is re-run as
      // the run of episodes it queued: "Arrow s1" asked again would be the
      // whole season, past the part its member has since asked for and been
      // sent (hourly-policy.js shareEpisodes lets that re-run through) the
      // moment the limit is raised. One run only; anything else, and a row
      // without a `cut`, is asked for as the member asked.
      const [run, more] = kind === 'tv' && Array.isArray(row.cut?.queued) ? row.cut.queued : [];
      const part = run && !more && row.title && row.season != null
        ? nextAsk({ season: row.season, from: Number(run[0]), to: Number(run[1]) }, { name: row.title }) : null;
      const text = part ?? row.request ?? row.title;
      const res = await loaded.plugin.requeue(text, loaded.ctx, {
        requester: `${row.requester ?? 'a member'} (${repost ? 're-posted' : 're-run'} by the hourly check)`,
      });
      const queued = res?.series
        ? `${res.series} ${res.scope ?? `season ${res.season}`} (${res.queued} episode(s))`
        : res?.title ? `${res.title}${res.year ? ` (${res.year})` : ''}` : String(text);
      // Written only once something was queued: a re-run refused by a full
      // queue has not used up the one attempt.
      ledger[`${kind}:${id}`] = { at: Date.now(), by: String(cmd.by ?? 'local shell').slice(0, 80), queued };
      const keys = Object.keys(ledger);
      if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete ledger[k];
      ledgerNs.set('requeued', ledger);
      return {
        ok: true,
        queued,
        // A season the episode limit cut says what it left out (tv-requests
        // cap-cut.js), as its History row does.
        ...(res?.cutNote ? { note: res.cutNote } : {}),
        ...(repost ? { repost: true } : {}),
        original: {
          id, status: row.status, requester: row.requester ?? null,
          detail: row.detail ? redactPersonal(String(row.detail)).slice(0, 200) : null,
        },
      };
    }

    case 'queue': {
      // Queue a request by its text, exactly as the panel's queue box does -
      // for an operator on the box when there is no History row to re-run.
      // Brotherhood's S01E14, E19 and E26 were refused on rating on
      // 2026-09-28 by a build that wrote no row for a refusal, so once the
      // owner put the show on the override list there was nothing for
      // 'requeue' to point at. Every check the panel's box gets still applies:
      // what is already queued, room, the rating, the override list and its
      // AI check. The hourly check never writes bot-cmd.json (its research
      // session cannot write data/), so this is the operator's alone.
      const kind = cmd.plugin === 'tv' ? 'tv' : cmd.plugin === 'movie' ? 'movie' : null;
      if (!kind) throw new Error('plugin must be "movie" or "tv"');
      const text = String(cmd.text ?? '').trim().slice(0, 200);
      if (!text) throw new Error('text required - what a member would type');
      const loaded = pluginManager?.plugins?.get(NAMESPACE[kind]);
      if (!loaded?.plugin?.requeue || !loaded.ctx) throw new Error(`the ${kind} plugin is not loaded`);
      const by = String(cmd.by ?? 'local shell').slice(0, 80);
      const res = await loaded.plugin.requeue(text, loaded.ctx, { requester: `${by} (queued on the box)` });
      // One episode is named by its own label, which already carries the
      // show ("Fullmetal Alchemist Brotherhood S01E14"); a season by the show.
      const queued = res?.series
        ? (res.queued === 1 && res.episodes?.[0] ? res.episodes[0] : `${res.series} season ${res.season} (${res.queued} episode(s))`)
        : res?.title ? `${res.title}${res.year ? ` (${res.year})` : ''}` : text;
      const notes = [res?.cutNote, res?.withheldNote ?? res?.overrideNote].filter(Boolean);
      return { ok: true, queued, note: notes.length ? notes.join(' · ') : null };
    }

    case 'trim-tv-requests': {
      // Every queued TV request kept to at most `max` episodes (by default
      // tvRequests.maxEpisodesPerRequest), the operator's request of
      // 2026-10-12: "fix the current queue that only 10 epsiodes max per
      // req" - the limit applies as a request is made, and Arrow season 1
      // was waiting with 23 episodes, Hunter x Hunter season 1 with 148.
      // A dry run unless `apply` is true; `tell` (true unless false) replies
      // to each member. The TV plugin does it (trimQueued, trim-queued.js),
      // and it is audited like every change (summariseAdminCommand).
      const loaded = pluginManager?.plugins?.get(NAMESPACE.tv);
      if (!loaded?.plugin?.trimQueued || !loaded.ctx) throw new Error('the tv plugin is not loaded');
      const res = await loaded.plugin.trimQueued(loaded.ctx, {
        max: cmd.max ?? null, apply: cmd.apply === true, tell: cmd.tell !== false,
      });
      return { ok: true, ...res };
    }

    case 'queue-item': {
      // Queue one library film by its Jellyfin item id, exactly as the panel's
      // Queue link button does (POST /queue/from-url): the same lookup, the
      // same TV refusal, and queueLibraryItem with every check it applies -
      // the rating, the bypass list, what is already waiting. Mr. 365 (2018),
      // 2026-09-29: OMDb does not know it, so no text request or 'queue' by
      // title could ever resolve it, and the operator asked for it to be
      // queued from its library link. Pass the id, not the link: a pasted
      // Download link carries the server's api_key, and nothing here stores,
      // logs or audits more than the id.
      const parsed = parseJellyfinUrl(String(cmd.id ?? cmd.url ?? ''));
      if (!parsed) throw new Error('id required - a Jellyfin item id or link');
      const item = await lookupItem(parsed.id, configStore?.get?.()?.library);
      if (!item) throw new Error(`nothing on the server has the id ${parsed.id}`);
      const tv = tvItemRefusal(item);
      if (tv) throw new Error(tv);
      const loaded = pluginManager?.plugins?.get(NAMESPACE.movie);
      if (!loaded?.plugin?.queueLibraryItem || !loaded.ctx) throw new Error('the movie plugin is not loaded');
      const by = String(cmd.by ?? 'local shell').slice(0, 80);
      const res = await loaded.plugin.queueLibraryItem(item, loaded.ctx, { requester: `${by} (queued on the box)` });
      return {
        ok: true, id: parsed.id,
        queued: `${item.title}${item.year ? ` (${item.year})` : ''}`,
        note: res?.overrideNote ?? null,
      };
    }

    case 'check-number': {
      // Which groups a number is in, and whether it is an admin there. The
      // point of a standby number is that it can take over - which it cannot
      // do in a group it is not an admin of, or not even a member of.
      const want = String(cmd.number ?? '').replace(/[^0-9]/g, '');
      if (!want) throw new Error('number required');
      const out = [];
      for (const g of bot.groupsWithMembers()) {
        const member = (g.members ?? []).find((p) => {
          const n = String(p.number ?? '').replace(/[^0-9]/g, '');
          return n && (n === want || n.endsWith(want) || want.endsWith(n));
        });
        out.push({
          jid: g.jid,
          subject: g.subject,
          member: !!member,
          admin: member ? !!member.admin : false,
        });
      }
      const inGroups = out.filter((g) => g.member);
      return {
        ok: true,
        // As every number the bot shows is written: +<digits>.
        number: `+${want}`,
        total: out.length,
        memberOf: inGroups.length,
        adminOf: inGroups.filter((g) => g.admin).length,
        groups: out,
      };
    }

    case 'dump-invites': {
      // Resolve each group's invite code so a description that links to a
      // group can be checked against the group it claims to link to. Read
      // only - fetching the code never rotates it. Paced: 15 lookups back to
      // back is the kind of burst that gets noticed.
      const out = [];
      const groups = bot.groups();
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        try {
          const code = await bot.groupInviteCode(g.jid);
          out.push({ jid: g.jid, subject: g.subject, code, url: `https://chat.whatsapp.com/${code}` });
        } catch (err) {
          out.push({ jid: g.jid, subject: g.subject, error: err.message });
        }
        if (i < groups.length - 1) await bot._bulkPace();
      }
      return { ok: true, count: out.length, invites: out };
    }

    case 'check-invites': {
      // Resolve invite CODES that appear in descriptions. WhatsApp keeps one
      // live code per group, so a code that no longer resolves is a dead link
      // sitting in a pinned description where members will click it.
      const codes = Array.isArray(cmd.codes) ? cmd.codes : [];
      const out = [];
      for (let i = 0; i < codes.length; i++) {
        try {
          const info = await bot.groupInviteInfo(codes[i]);
          out.push({ code: codes[i], ok: true, jid: info?.id ?? null, subject: info?.subject ?? null });
        } catch (err) {
          out.push({ code: codes[i], ok: false, error: err.message });
        }
        if (i < codes.length - 1) await bot._bulkPace();
      }
      return { ok: true, results: out };
    }

    case 'scan-mentions': {
      // Everything we have captured so far, plus what each sample proves.
      const { deduceTokenConvention } = await import('./mention-scan.js');
      const samples = bot.mentionSamples ?? [];
      return {
        ok: true,
        count: samples.length,
        samples: samples.map((s) => ({ ...s, convention: deduceTokenConvention(s) })),
      };
    }

    case 'catch-up': {
      // {"op":"catch-up","chatJid":"…@g.us","since":"2026-10-05T06:37:00Z"}
      // lists the unanswered requests; add "run":true to process them.
      const sinceMs = Date.parse(cmd.since ?? '');
      const res = await bot.catchUp({ chatJid: cmd.chatJid, sinceMs, run: cmd.run === true });
      return { ok: true, ...res };
    }

    case 'request-history': {
      const res = await bot.requestHistory({
        chatJid: cmd.chatJid ?? null,
        count: cmd.count ?? 50,
      });
      return { ok: true, ...res };
    }

    case 'backup-descriptions': {
      const res = backupOriginalDescriptions(bot, dataDir);
      return { ok: true, ...res };
    }

    case 'apply-descriptions': {
      if (!Array.isArray(cmd.plan)) throw new Error('plan must be an array of { jid, desc }');
      // Snapshot originals before editing, so we never overwrite without a backup.
      backupOriginalDescriptions(bot, dataDir);
      const results = await bot.applyDescriptions(cmd.plan);
      return { ok: true, results };
    }

    case 'post-descriptions': {
      // Post each group's description INTO that group and pin it. Outward
      // facing and visible to every member, so it is an explicit, separate
      // step from writing the description itself.
      if (!Array.isArray(cmd.plan)) throw new Error('plan must be an array of { jid, desc }');
      const seconds = Number(cmd.pinSeconds ?? 2592000);
      const results = [];
      for (const item of cmd.plan) {
        const subject = bot.groupCache.get(item.jid)?.subject ?? item.jid;
        try {
          const sent = await bot.sendText(item.jid, String(item.desc ?? ''));
          let pinned = false;
          let pinError = null;
          if (cmd.pin !== false && sent?.key) {
            try { await bot.pinMessage(item.jid, sent.key, seconds); pinned = true; }
            catch (err) { pinError = err.message; }
          }
          results.push({ jid: item.jid, subject, ok: true, pinned, ...(pinError ? { pinError } : {}) });
        } catch (err) {
          results.push({ jid: item.jid, subject, ok: false, error: err.message });
        }
        // Two visible actions per group - a post and a pin - across every
        // group at once. Paced like a broadcast, and paced on the failure
        // paths too, so a bad run never turns into a fast run.
        await bot._bulkPace('broadcast');
      }
      return { ok: true, results };
    }

    case 'import-drive-links': {
      // The Google Drive Links group's past, from its "Export chat" (the bot kept
      // only message ids there): entries as importExport() makes them
      // (tools/import-whatsapp-export.mjs). New links only; nothing is posted.
      if (!bot.driveLinks) throw new Error('the Drive links archive is not available in this process');
      const entries = Array.isArray(cmd.entries) ? cmd.entries.filter((e) => e && /^https?:\/\//.test(String(e.url))) : [];
      if (!entries.length) throw new Error('entries: the links to keep');
      const added = bot.driveLinks.add(entries.map((e) => ({
        url: String(e.url), kind: e.kind, title: e.title ?? null, label: e.label ?? null, note: e.note ?? null,
        date: String(e.date ?? '').slice(0, 10), time: e.time ?? null,
        section: e.section ? String(e.section).slice(0, 80) : null, source: e.source === 'list' ? 'list' : null,
      })));
      return { ok: true, added, total: bot.driveLinks.items().length };
    }

    case 'post-drive-links': {
      // The document sent to one group: "to" is the group's jid, the beta group
      // first (CLAUDE.md "beta first"). No night's post, and no archive change.
      if (!bot.driveLinksJob) throw new Error('the Drive links job is not available in this process');
      const to = String(cmd.to ?? '');
      if (!/^\d+(-\d+)?@g\.us$/.test(to)) throw new Error('to: a group jid, 1203...@g.us');
      const r = await bot.driveLinksJob.postTo(to, cmd.caption ? String(cmd.caption).slice(0, 300) : undefined);
      return { ok: true, ...r, to };
    }

    case 'mark-extras': {
      // The waiting requests asked for inside their member's cooldown, made
      // the extras they are - once, for what was waiting before the queue
      // began marking them as they are queued (the operator, 2026-10-12;
      // src/core/mark-extras.js). A dry run without `apply: true`.
      if (!queue) throw new Error('the queue is not available in this process');
      const res = markExtras({
        queue, pluginManager, bot, apply: cmd.apply === true,
        config: configStore?.get?.() ?? {},
      });
      return { ok: true, ...res };
    }

    case 'pause-requests': {
      // The panel's "⏸️ Pause requests", for an operator or a session on the
      // box (request-pause.js): every request from a request group gets ⏸️
      // and waits; the queue stops starting new jobs, and what runs finishes.
      if (!requestPause) throw new Error('pausing requests is not available in this process');
      const r = requestPause.pause(String(cmd.by ?? 'local shell').slice(0, 80));
      return { ok: true, already: !!r.already, pausedQueue: !!r.pausedQueue, ...requestsPaused(requestPause).requests };
    }

    case 'resume-requests': {
      // And "▶️ Resume requests": the queue too if the pause paused it, then
      // the held requests, in the order they came, paced. Not waited for -
      // the result says how many there are to run.
      if (!requestPause) throw new Error('pausing requests is not available in this process');
      const ran = requestPause.heldCount();
      const r = requestPause.resume(String(cmd.by ?? 'local shell').slice(0, 80));
      // replay() logs its own failure and never rejects; this is the belt.
      r.replay?.catch?.((err) => logger.error(`held requests: ${err.message}`));
      return { ok: true, already: !!r.already, resumedQueue: !!r.resumedQueue, ran, ...requestsPaused(requestPause).requests };
    }

    case 'set-rule-sets': {
      if (!configStore) throw new Error('configStore unavailable');
      const patch = { movieRequests: {} };
      if (Array.isArray(cmd.ruleSets)) patch.movieRequests.ruleSets = cmd.ruleSets;
      if (cmd.groupRuleSet && typeof cmd.groupRuleSet === 'object') patch.movieRequests.groupRuleSet = cmd.groupRuleSet;
      if (typeof cmd.rules === 'string') patch.movieRequests.rules = cmd.rules;
      configStore.update(patch);
      const mr = configStore.get().movieRequests;
      return { ok: true, ruleSets: mr.ruleSets, groupRuleSet: mr.groupRuleSet };
    }

    default:
      throw new Error(`unknown op: ${cmd?.op ?? '(none)'}`);
  }
}
