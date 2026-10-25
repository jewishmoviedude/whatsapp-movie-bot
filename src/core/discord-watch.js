/**
 * The Discord ticket reader: what the host's staff answer in the operator's
 * support tickets, kept for the hourly check.
 *
 * The operator, 2026-10-11: "create from scratch a way I can connect my
 * discord account to the ubuntu so you can access it". The tickets are
 * private channels the Ticket Tool bot makes in the Jellyfin host's Discord
 * server (ticket-0001, closed-0001 once closed), and the answers in them -
 * "renamed it to Sorcerer's Stone", "Star Wars is Episode IV now" - are what
 * the hourly check needs to follow a fix up. See discord-reader.js for how
 * the account is reached, read-only, and why so carefully.
 *
 * What is watched is `discord.watch` in the settings (Settings -> Connection
 * -> Discord (read-only), super-admin only): servers, a channel-name pattern
 * ('^ticket-' by default) and channel ids. Every 30 minutes, and once soon
 * after the bot starts, this lists the channels of each watched server - one
 * request each - and reads only a channel whose last message is newer than
 * the last one it read: on a quiet day that is the whole of it, a request per
 * server per half hour. New messages are appended to
 * <dataDir>/discord-tickets.jsonl, one JSON object each, kept 90 days (pruned
 * as library-news.js prunes its file). The last message read in each channel
 * is kept in the state store (namespace 'discord-reader', key 'hw'), so a
 * restart - or a rebuild, since state.json travels in the sealed backup -
 * reads on from there. A channel never read before is read back 7 days and
 * no further.
 *
 * Once a channel has been read it stays watched while it exists, under any
 * name: Ticket Tool renames ticket-0001 to closed-0001 when the ticket
 * closes, and the last answer is often written just before that. A channel
 * Discord will not let the account read (403: somebody else's ticket, or one
 * closed with the operator taken off it) is left alone for a week. A
 * pattern-matched channel whose permissions plainly hide it from the account
 * - @everyone denied, nothing for the account itself - is not tried at all:
 * in a busy server most ticket-NNNN channels are other people's, and asking
 * for each would be hundreds of refused requests.
 *
 * Never more than MAX_REQUESTS_PER_RUN requests in one run, and no run within
 * MIN_GAP_MS of the last: a bot restarting over and over must not become a
 * client hammering Discord.
 *
 * A token Discord refuses (401) stops the reader until somebody reconnects:
 * the status says "broken since", the panel shows it, an audit row records
 * it, and the hourly check lists it once a day (incident-scan.js
 * discordFindings). "Stops" covers every use of the token, not only the
 * half-hourly run: the panel's server list and channel preview are refused
 * too (client() checks deadSince()), and so is tools/discord.mjs. A 401 the
 * CLI gets first is left in discord-refused.json, which the reader takes up
 * as its own without asking Discord again. The first version kept the 401
 * only inside one client, and each panel button built a new one, so "Load my
 * servers" pressed after "disconnected - reconnect" sent the revoked token
 * again (2026-10-11, review).
 */
import fs from 'node:fs';
import path from 'node:path';
import log from '../util/logger.js';
import { DiscordReader, DiscordError, displayName, scrubToken, SNOWFLAKE } from './discord-reader.js';

const logger = log.scope('discord');

export const NAMESPACE = 'discord-reader';
export const EVERY_MS = 30 * 60_000;
// The first run waits this long after the bot starts: long enough that a
// start that crashes straight away never reaches Discord.
export const START_DELAY_MS = 90_000;
export const MIN_GAP_MS = 10 * 60_000;
export const BACKFILL_DAYS = 7;
export const KEEP_DAYS = 90;
export const DENIED_RETRY_MS = 7 * 24 * 3600_000;
export const MAX_PAGES = 5;
export const MAX_REQUESTS_PER_RUN = 25;
export const DEFAULT_PATTERN = '^ticket-';
const DAY = 24 * 3600_000;

export const ticketsFile = (dataDir) => path.join(dataDir, 'discord-tickets.jsonl');

/* ------------------------------ a dead token -------------------------- */

/** What every use of a token Discord has refused is answered with, instead of a request. */
export const BROKEN_MESSAGE = 'Discord refused the saved token (HTTP 401), so it is not sent again: paste a new token in '
  + 'Settings -> Connection -> Discord (read-only) and press Connect';

/**
 * Where tools/discord.mjs leaves word that Discord refused the token. The CLI
 * may not write state.json, which belongs to the running bot (whose next save
 * would overwrite it), so it writes this small file instead: when, and which
 * connection it was (the connectedAt it saw), never the token.
 */
export const refusedFile = (dataDir) => path.join(dataDir, 'discord-refused.json');

/** The CLI's note of a 401, or null. */
export function readRefused(dataDir) {
  try {
    const j = JSON.parse(fs.readFileSync(refusedFile(dataDir), 'utf8'));
    return Number.isFinite(j?.at) ? { at: j.at, connectedAt: Number.isFinite(j.connectedAt) ? j.connectedAt : null } : null;
  } catch {
    return null;
  }
}

/**
 * Leave the note. Returns null, or why it could not be written: the hourly
 * check's research session sees data/ read-only, and then the reader finds
 * out on its next run, with one request.
 */
export function writeRefused(dataDir, { at, connectedAt = null }) {
  const file = refusedFile(dataDir);
  try {
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify({ at, connectedAt, by: 'tools/discord.mjs' })}\n`, { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    return null;
  } catch (err) {
    return err.code ?? err.message;
  }
}

/**
 * Since when the saved token is known to be dead, or null: the reader's own
 * 401 (status.brokenSince), or one the CLI noted while this same connection
 * was in place. A note from before the last Connect is about a token that
 * has since been replaced, and counts for nothing.
 */
export function refusedSince(status, refused) {
  if (status?.brokenSince) return status.brokenSince;
  if (refused && (refused.connectedAt ?? null) === (status?.connectedAt ?? null)) return refused.at;
  return null;
}

/* ------------------------------ snowflakes ---------------------------- */

const DISCORD_EPOCH = 1420070400000n;
/** The smallest id Discord could have given a message at `ms`. */
export function snowflakeAt(ms) {
  return ((BigInt(Math.max(0, Math.floor(ms))) - DISCORD_EPOCH) << 22n).toString();
}
/** When a snowflake was made. */
export function timeOfSnowflake(id) {
  try { return Number((BigInt(id) >> 22n) + DISCORD_EPOCH); } catch { return null; }
}
const isNewer = (a, b) => { try { return BigInt(a) > BigInt(b); } catch { return false; } };
const byId = (a, b) => { const x = BigInt(a.id), y = BigInt(b.id); return x < y ? -1 : x > y ? 1 : 0; };

/* ------------------------------ the settings -------------------------- */

/** Why a channel-name pattern cannot be used, or null. */
export function patternProblem(text) {
  if (typeof text !== 'string') return 'the channel pattern must be text';
  if (text.length > 200) return 'the channel pattern is longer than 200 characters';
  try { new RegExp(text, 'i'); } catch (err) { return `the channel pattern is not a valid regular expression: ${err.message}`; }
  return null;
}

/** The watch settings, cleaned: { guilds, channels, pattern (RegExp), patternText }. */
export function watchSettings(config) {
  const w = config?.discord?.watch ?? {};
  const ids = (xs) => [...new Set((Array.isArray(xs) ? xs : []).map((x) => String(x ?? '').trim()).filter((x) => SNOWFLAKE.test(x)))];
  const patternText = typeof w.channelPattern === 'string' && w.channelPattern.trim() ? w.channelPattern.trim() : DEFAULT_PATTERN;
  const pattern = patternProblem(patternText) ? new RegExp(DEFAULT_PATTERN, 'i') : new RegExp(patternText, 'i');
  return { guilds: ids(w.guilds), channels: ids(w.channels), pattern, patternText };
}

/* ------------------------------ visibility ---------------------------- */

const VIEW_CHANNEL = 1n << 10n;
// Text channels and announcement channels; voice, categories and the rest
// hold no ticket.
const TEXT_TYPES = new Set([0, 5]);

/**
 * Whether the channel's own permissions let this account see it, as far as
 * they say: a grant to the account itself, else not hidden from @everyone.
 * Roles are not known here, so a channel open to a role the account holds
 * reads as hidden; an explicit channel id is always tried.
 */
export function visibleToMe(ch, me, guildId) {
  const ow = Array.isArray(ch?.permission_overwrites) ? ch.permission_overwrites : [];
  const has = (o, k) => { try { return (BigInt(o?.[k] ?? 0) & VIEW_CHANNEL) !== 0n; } catch { return false; } };
  const mine = me ? ow.find((o) => String(o.id) === String(me) && (o.type === 1 || o.type === 'member')) : null;
  if (mine && has(mine, 'allow')) return true;
  if (mine && has(mine, 'deny')) return false;
  const everyone = ow.find((o) => String(o.id) === String(guildId));
  return !(everyone && has(everyone, 'deny'));
}

/* ------------------------------ the record ---------------------------- */

const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n)}…` : t; };

/** An embed as text: its title, description and fields, which is where Ticket Tool says everything. */
export function embedText(e) {
  if (!e || typeof e !== 'object') return '';
  const parts = [e.author?.name, e.title, e.description,
    ...(Array.isArray(e.fields) ? e.fields.map((f) => [f?.name, f?.value].filter(Boolean).join(': ')) : []),
    e.footer?.text].filter((x) => typeof x === 'string' && x.trim());
  return clip(parts.join('\n'), 2000);
}

/** One line of discord-tickets.jsonl for Discord message `m`. */
export function messageRow(m, { guild = null, guildName = null, channel, channelName = null, me = null, readAt }) {
  return {
    at: Date.parse(m.timestamp) || timeOfSnowflake(m.id),
    readAt,
    guild: guild ?? m.guild_id ?? null,
    guildName,
    channel: channel ?? m.channel_id,
    channelName,
    messageId: m.id,
    author: { id: m.author?.id ?? null, username: m.author?.username ?? null, name: displayName(m.author), bot: !!m.author?.bot },
    fromMe: !!me && m.author?.id === me,
    content: clip(m.content, 4000),
    embeds: (Array.isArray(m.embeds) ? m.embeds : []).map(embedText).filter(Boolean),
    attachments: (Array.isArray(m.attachments) ? m.attachments : []).map((a) => ({ name: a?.filename ?? null, url: a?.url ?? null })),
  };
}

/** A row's words: its text and its embeds. */
export const rowText = (r) => [r?.content, ...(r?.embeds ?? [])].filter(Boolean).join('\n');

function readLines(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* a torn last line is skipped */ }
  }
  return out;
}

/**
 * What the reader has kept, written between `since` and `until` (by message
 * time), oldest first. The hourly check takes all of it: a ticket's earlier
 * messages are the evidence for its newest one.
 */
export function readDiscordTickets(dataDir, { since = 0, until = Infinity } = {}) {
  return readLines(ticketsFile(dataDir)).filter((r) => r.at >= since && r.at <= until).sort((a, b) => a.at - b.at);
}

/* ------------------------------ the watcher --------------------------- */

export class DiscordWatch {
  /**
   * @param store  the state store's 'discord-reader' namespace
   * @param audit  the state store's 'audit' namespace, for the rows a person should find later
   * @param fetch  injectable: the tests answer as a fake Discord
   */
  constructor({ dataDir, configStore, store, audit = null, fetch = globalThis.fetch, now = Date.now, sleep = undefined }) {
    this.dataDir = dataDir;
    this.configStore = configStore;
    this.store = store;
    this.audit = audit;
    this.fetch = fetch;
    this.now = now;
    this.sleep = sleep;
    this.busy = null;
    this.prunedDay = null;
    this._timer = null;
    this._first = null;
  }

  get token() { return this.configStore.get()?.discord?.token || ''; }

  status() { return { ...(this.store.get('status', {}) ?? {}) }; }

  _setStatus(patch) {
    const next = { ...this.status(), ...patch };
    this.store.set('status', next);
    return next;
  }

  /**
   * Since when the saved token is known to be dead, or null. A 401 the CLI
   * noted is taken up here as the reader's own - broken since then, with the
   * log line and the audit row - so the panel and the hourly check say so,
   * and nobody asks Discord to find it out again.
   */
  deadSince() {
    const st = this.status();
    if (st.brokenSince) return st.brokenSince;
    if (!this.token) return null;
    const since = refusedSince(st, readRefused(this.dataDir));
    if (since) {
      this.markBroken('Discord refused the saved token (HTTP 401) when tools/discord.mjs used it: the password was changed, '
        + 'or the account logged out of all devices', since);
    }
    return since;
  }

  /**
   * A read-only client for `token` (the saved one by default). Refused, with
   * no request made, once the saved token is known to be dead: a client keeps
   * its own 401 only for itself, and every caller here builds a new one.
   */
  client(token = this.token) {
    if (this.deadSince()) throw new DiscordError(BROKEN_MESSAGE, { code: 'broken', status: 401 });
    return new DiscordReader({
      token, fetch: this.fetch, now: this.now, ...(this.sleep ? { sleep: this.sleep } : {}),
      onUnauthorized: () => this.markBroken('Discord refused the saved token (HTTP 401): the password was changed, or the account logged out of all devices'),
    });
  }

  /** Every 30 minutes, and once shortly after start. */
  start() {
    this._first = setTimeout(() => { this.run().catch(() => {}); }, START_DELAY_MS);
    this._first.unref?.();
    this._timer = setInterval(() => { this.run().catch(() => {}); }, EVERY_MS);
    this._timer.unref?.();
  }

  stop() {
    clearTimeout(this._first);
    clearInterval(this._timer);
  }

  /** The token was refused: stop, and say so where a person will see it. */
  markBroken(why, at = this.now()) {
    const st = this.status();
    if (st.brokenSince) return;
    this._setStatus({ brokenSince: at, brokenWhy: why });
    logger.warn(`${why}. The reader has stopped and will not try that token again - reconnect in Settings -> Connection -> Discord (read-only).`);
    this.audit?.push('events', {
      ts: this.now(), user: 'discord-reader', role: 'system',
      action: 'Discord refused the saved token - the reader stopped', detail: `${why}. Reconnect in Settings -> Connection -> Discord (read-only).`,
    }, 2000);
  }

  /**
   * Check a token by asking Discord who it is. Returns { id, username, name }.
   * Throws a DiscordError (code 'unauthorized' for a token Discord refuses).
   */
  async verify(token) {
    const c = new DiscordReader({ token, fetch: this.fetch, now: this.now, ...(this.sleep ? { sleep: this.sleep } : {}) });
    const u = await c.me();
    if (!u?.id) throw new DiscordError('Discord did not say who the token belongs to', { code: 'http' });
    return { id: String(u.id), username: u.username ?? null, name: displayName(u) };
  }

  /** After a successful connect: who, and nothing broken. */
  connected(user, by = null) {
    this._setStatus({ user, connectedAt: this.now(), connectedBy: by, brokenSince: null, brokenWhy: null, lastError: null, lastErrorAt: null });
    this._forgetRefused();
  }

  /** After a disconnect. The read positions stay, so a reconnect reads on rather than back. */
  disconnected() {
    this._setStatus({ user: null, connectedAt: null, connectedBy: null, brokenSince: null, brokenWhy: null, lastError: null, lastErrorAt: null });
    this._forgetRefused();
  }

  // The CLI's note is about the token just replaced or wiped. refusedSince()
  // would ignore it anyway (another connectedAt); this keeps data/ tidy.
  _forgetRefused() {
    try { fs.rmSync(refusedFile(this.dataDir), { force: true }); } catch { /* not there, or not ours to remove */ }
  }

  /** The account's servers, by name; remembered for the panel. */
  async guildList() {
    const list = await this.client().guilds();
    const guilds = (Array.isArray(list) ? list : []).map((g) => ({ id: String(g.id), name: g.name ?? String(g.id) }));
    this.store.set('guildNames', { ...(this.store.get('guildNames', {}) ?? {}), ...Object.fromEntries(guilds.map((g) => [g.id, g.name])) });
    return guilds;
  }

  /** The channels of `guildId` that match `pattern`, and whether each can be read. One request. */
  async matchingChannels(guildId, pattern) {
    const st = this.status();
    const list = await this.client().guildChannels(guildId);
    const hw = this.store.get('hw', {}) ?? {};
    return (Array.isArray(list) ? list : [])
      .filter((ch) => TEXT_TYPES.has(ch.type) && (pattern.test(ch.name ?? '') || hw[ch.id]))
      .map((ch) => ({
        id: String(ch.id), name: ch.name, matches: pattern.test(ch.name ?? ''), read: !!hw[ch.id],
        visible: visibleToMe(ch, st.user?.id, guildId), lastMessageAt: ch.last_message_id ? timeOfSnowflake(ch.last_message_id) : null,
      }));
  }

  /**
   * Read what is new. Returns what it did; never throws. `force` skips the
   * gap since the last run (the panel's Read now, itself rate-limited).
   */
  async run({ force = false } = {}) {
    if (this.busy) return this.busy;
    this.busy = this._run({ force }).finally(() => { this.busy = null; });
    return this.busy;
  }

  async _run({ force }) {
    const token = this.token;
    if (!token) return { ok: false, skipped: 'not connected' };
    if (this.deadSince()) return { ok: false, skipped: 'broken' };
    const st = this.status();
    const watch = watchSettings(this.configStore.get());
    if (!watch.guilds.length && !watch.channels.length) return { ok: false, skipped: 'nothing to watch' };
    const t0 = this.now();
    if (!force && st.lastRunAt && t0 - st.lastRunAt < MIN_GAP_MS) return { ok: false, skipped: 'ran recently' };
    this._setStatus({ lastRunAt: t0 });

    const client = this.client(token);
    const summary = { ok: true, at: t0, requests: 0, guilds: 0, channels: 0, read: 0, appended: 0, private: 0, denied: 0, errors: [] };
    const hw = { ...(this.store.get('hw', {}) ?? {}) };
    const denied = { ...(this.store.get('denied', {}) ?? {}) };
    const known = { ...(this.store.get('channels', {}) ?? {}) };
    const guildNames = { ...(this.store.get('guildNames', {}) ?? {}) };
    const rows = [];
    const budget = () => client.requests < MAX_REQUESTS_PER_RUN;
    const save = () => {
      this.store.set('hw', hw);
      this.store.set('denied', denied);
      this.store.set('channels', known);
      this.store.set('guildNames', guildNames);
    };

    try {
      let me = st.user?.id ?? null;
      if (!me) {
        const u = await client.me();
        me = String(u.id);
        this._setStatus({ user: { id: me, username: u.username ?? null, name: displayName(u) } });
      }

      // Which channels, with what each says its last message is.
      const todo = [];
      const covered = new Set();
      for (const guild of watch.guilds) {
        if (!budget()) break;
        let list;
        try {
          list = await client.guildChannels(guild);
        } catch (err) {
          if (err.code === 'forbidden' || err.code === 'not-found') { summary.errors.push(`server ${guildNames[guild] ?? guild}: ${err.message}`); continue; }
          throw err;
        }
        summary.guilds += 1;
        if (!guildNames[guild] && budget()) {
          try { guildNames[guild] = (await client.guild(guild))?.name ?? null; } catch (err) { if (err.code === 'unauthorized' || err.code === 'rate-limited') throw err; }
        }
        const here = new Set();
        for (const ch of Array.isArray(list) ? list : []) {
          if (!TEXT_TYPES.has(ch.type)) continue;
          const id = String(ch.id);
          here.add(id);
          const matches = watch.pattern.test(ch.name ?? '');
          const asked = watch.channels.includes(id);
          if (!matches && !hw[id] && !asked) continue;
          if (!hw[id] && !asked && !visibleToMe(ch, me, guild)) { summary.private += 1; continue; }
          covered.add(id);
          todo.push({ id, name: ch.name ?? null, guild, last: ch.last_message_id ?? null });
        }
        // A channel the server no longer has (a deleted ticket) is forgotten.
        for (const [id, k] of Object.entries(known)) {
          if (k.guild === guild && !here.has(id)) { delete known[id]; delete hw[id]; delete denied[id]; }
        }
      }
      for (const id of watch.channels) {
        if (covered.has(id) || !budget()) continue;
        try {
          const ch = await client.channel(id);
          todo.push({ id, name: ch?.name ?? null, guild: ch?.guild_id ? String(ch.guild_id) : null, last: ch?.last_message_id ?? null });
        } catch (err) {
          if (err.code === 'forbidden' || err.code === 'not-found') { summary.errors.push(`channel ${id}: ${err.message}`); continue; }
          throw err;
        }
      }

      for (const ch of todo) {
        known[ch.id] = { name: ch.name, guild: ch.guild, guildName: ch.guild ? guildNames[ch.guild] ?? null : null };
        summary.channels += 1;
        const d = denied[ch.id];
        if (d && t0 - d < DENIED_RETRY_MS) { summary.denied += 1; continue; }
        if (!ch.last) continue;                                    // never a message
        if (hw[ch.id] && !isNewer(ch.last, hw[ch.id])) continue;   // nothing new: no request
        let after = hw[ch.id] ?? snowflakeAt(t0 - BACKFILL_DAYS * DAY);
        if (!isNewer(ch.last, after)) { hw[ch.id] = ch.last; continue; }   // its last message is older than the backfill
        let gotAny = false;
        // Whether an answer reached the end of the channel: a page shorter
        // than the 100 asked for, an empty one included.
        let reachedEnd = false;
        for (let page = 0; page < MAX_PAGES && budget(); page += 1) {
          let batch;
          try {
            batch = await client.messages(ch.id, { after, limit: 100 });
          } catch (err) {
            if (err.code === 'forbidden') { denied[ch.id] = t0; summary.denied += 1; break; }
            if (err.code === 'not-found') { delete hw[ch.id]; delete known[ch.id]; break; }
            throw err;
          }
          delete denied[ch.id];
          const all = Array.isArray(batch) ? batch : [];
          if (all.length < 100) reachedEnd = true;
          const msgs = all.filter((m) => m && SNOWFLAKE.test(String(m.id))).sort(byId);
          if (!msgs.length) break;
          gotAny = true;
          for (const m of msgs) {
            if (!m.content && !(m.embeds ?? []).length && !(m.attachments ?? []).length) continue;
            rows.push(messageRow(m, { guild: ch.guild, guildName: ch.guild ? guildNames[ch.guild] ?? null : null,
              channel: ch.id, channelName: ch.name, me, readAt: t0 }));
          }
          after = msgs[msgs.length - 1].id;
          hw[ch.id] = after;
          if (reachedEnd) break;
        }
        if (gotAny) summary.read += 1;
        // An answer that reached the end has shown every message up to the
        // last id the channel list gave, so the read position moves up to
        // that id even when nothing came back. Discord leaves last_message_id
        // on a message that has been deleted (its docs: it "may not point to
        // an existing or valid message"), and without this a ticket whose
        // newest message was deleted was asked for on every run, two requests
        // each half hour for as long as the ticket existed (2026-10-11,
        // review). It also covers a ticket read for the first time whose
        // last week turns out empty.
        if (reachedEnd && isNewer(ch.last, hw[ch.id] ?? '0')) hw[ch.id] = ch.last;
      }
    } catch (err) {
      summary.ok = false;
      summary.errors.push(scrubToken(err?.message ?? String(err), token));
      if (err?.code !== 'unauthorized') logger.warn(`Discord reader: ${summary.errors[summary.errors.length - 1]}`);
    } finally {
      summary.requests = client.requests;
      // Whatever was read is kept, even when the run stopped part way.
      if (rows.length) summary.appended = this._append(rows);
      save();
    }

    const at = this.now();
    if (summary.ok) {
      this._setStatus({ lastReadAt: at, lastError: summary.errors.length ? summary.errors.join('; ').slice(0, 400) : null,
        lastErrorAt: summary.errors.length ? at : null, lastRun: summary });
    } else {
      this._setStatus({ lastError: summary.errors.join('; ').slice(0, 400), lastErrorAt: at, lastRun: summary });
    }
    const said = `${summary.requests} request(s), ${summary.channels} channel(s) watched, ${summary.appended} new message(s)`;
    if (summary.appended) logger.info(`📨 Discord tickets: ${said}`);
    else logger.debug(`Discord tickets: ${said}`);
    return summary;
  }

  _append(rows) {
    try {
      this._prune();
      fs.appendFileSync(ticketsFile(this.dataDir), rows.map((r) => `${JSON.stringify(r)}\n`).join(''), { mode: 0o600 });
      return rows.length;
    } catch (err) {
      logger.warn(`could not record Discord ticket messages: ${err.message}`);
      return 0;
    }
  }

  /** Once a day, drop what is older than KEEP_DAYS. */
  _prune() {
    const day = Math.floor(this.now() / DAY);
    if (this.prunedDay === day) return;
    this.prunedDay = day;
    const file = ticketsFile(this.dataDir);
    if (!fs.existsSync(file)) return;
    const cutoff = this.now() - KEEP_DAYS * DAY;
    const keep = readLines(file).filter((r) => r.at >= cutoff);
    fs.writeFileSync(file, keep.map((r) => `${JSON.stringify(r)}\n`).join(''), { mode: 0o600 });
  }

  /**
   * What the panel shows. Never the token: whether one is saved, who it is,
   * and how the reader is doing. `full` (the super-admin) adds the latest
   * messages read.
   */
  panelStatus({ full = false } = {}) {
    const cfg = this.configStore.get();
    // A 401 the CLI noted shows as "broken since" now, not at the next run.
    this.deadSince();
    const st = this.status();
    const w = watchSettings(cfg);
    const saved = cfg?.discord?.watch ?? {};
    const out = {
      connected: !!this.token,
      user: st.user ?? null,
      connectedAt: st.connectedAt ?? null,
      brokenSince: st.brokenSince ?? null,
      brokenWhy: st.brokenWhy ?? null,
      lastRunAt: st.lastRunAt ?? null,
      lastReadAt: st.lastReadAt ?? null,
      lastError: st.lastError ?? null,
      lastErrorAt: st.lastErrorAt ?? null,
      lastRun: st.lastRun ? { ...st.lastRun, errors: (st.lastRun.errors ?? []).slice(0, 5) } : null,
      everyMinutes: EVERY_MS / 60_000,
      watch: { guilds: w.guilds, channelPattern: typeof saved.channelPattern === 'string' ? saved.channelPattern : DEFAULT_PATTERN, channels: w.channels },
      guildNames: this.store.get('guildNames', {}) ?? {},
      channels: Object.entries(this.store.get('channels', {}) ?? {}).map(([id, c]) => ({ id, ...c })),
    };
    if (full) {
      out.recent = readDiscordTickets(this.dataDir).slice(-10).reverse().map((r) => ({
        at: r.at, channelName: r.channelName, guildName: r.guildName, who: r.author?.name ?? r.author?.username ?? null,
        fromMe: !!r.fromMe, bot: !!r.author?.bot, text: clip(rowText(r).replace(/\s+/g, ' '), 300),
      }));
    }
    return out;
  }
}
