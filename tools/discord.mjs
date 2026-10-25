#!/usr/bin/env node
/**
 * Read the operator's Discord, from this box, on demand - read-only.
 *
 *   node tools/discord.mjs whoami                      who the connected account is, and how the reader is doing
 *   node tools/discord.mjs guilds                      the account's servers, with their ids
 *   node tools/discord.mjs channels <guildId>          a server's text channels; * marks the ones the reader watches
 *   node tools/discord.mjs read <channelId> [--limit N]  a channel's latest messages (20 by default, 100 at most)
 *   node tools/discord.mjs tickets [--days N] [--live] what the reader has kept, ticket by ticket (14 days by default);
 *                                                      --live also lists the watched servers' ticket channels now
 *
 * The operator, 2026-10-11: "create from scratch a way I can connect my
 * discord account to the ubuntu so you can access it". The account is
 * connected in the panel (Settings -> Connection -> Discord (read-only)); this
 * reads it the way the bot's reader does, through the same client
 * (src/core/discord-reader.js), which can only GET a short list of paths -
 * it cannot post, react, edit, mark read or type, whatever is asked of it.
 * `tickets` without --live asks Discord nothing: it reads
 * data/discord-tickets.jsonl.
 *
 * Reads data/config.json with MASTER_KEY from .env, as
 * tools/diagnose-library.mjs does, and never writes it - nor state.json, which
 * belongs to the running bot. Never prints the token. Times are New York
 * time, on the 24-hour clock. Exit status: 0 done, 1 not set up or a usage
 * mistake, 2 Discord refused the token (now, or before: then nothing is
 * sent), 3 any other Discord failure, or stopped before it had finished.
 *
 * A 401 means the token is dead, and a dead token is never sent again, from
 * here or from the bot. So nothing that asks Discord runs while the bot's
 * reader says it is broken (state.json), or while this tool has itself been
 * refused since the last Connect; and when Discord refuses it here first, the
 * one file this tool writes, data/discord-refused.json (when, and which
 * connection - never the token), tells the bot's reader to stop as well
 * without asking again. The first version did neither: every `whoami` or
 * `read` sent the revoked token once more, and the hourly check's research
 * session runs `read` unattended (2026-10-11, review).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DiscordReader, scrubToken, SNOWFLAKE, displayName } from '../src/core/discord-reader.js';
import {
  readDiscordTickets, watchSettings, visibleToMe, timeOfSnowflake, embedText, rowText, NAMESPACE,
  readRefused, writeRefused, refusedSince,
} from '../src/core/discord-watch.js';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TZ = 'America/New_York';

const USAGE = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(3, 10)
  .map((l) => l.replace(/^ \* ?/, '')).join('\n');

/** "2026-10-11 14:05", New York time, 24-hour. */
export function when(ms) {
  if (!Number.isFinite(ms)) return '????-??-?? ??:??';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** The bot's settings, decrypted as the bot decrypts them, never saved. */
export async function loadSettings(appDir, dataDir, env = process.env) {
  let key = '';
  try { key = fs.readFileSync(path.join(appDir, '.env'), 'utf8').match(/^MASTER_KEY=(.+)$/m)?.[1]?.trim() ?? ''; } catch { /* none */ }
  key ||= env.MASTER_KEY ?? '';
  if (!key) return { config: null, why: 'No MASTER_KEY in .env or the environment - cannot read the saved settings.' };
  const { ConfigStore } = await import('../src/config/store.js');
  const store = new ConfigStore({ dataDir, masterKey: key });
  store.save = () => store.config;
  try { return { config: store.load() }; } catch (err) { return { config: null, why: err.message }; }
}

function readState(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'))?.[NAMESPACE] ?? {}; } catch { return {}; }
}

const oneLine = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

export async function main(argv, {
  appDir = APP_DIR, dataDir = null, env = process.env, fetch = globalThis.fetch, out = console.log, err = console.error,
} = {}) {
  const data = dataDir ?? (env.DATA_DIR || path.join(appDir, 'data'));
  const [cmd, ...rest] = argv;
  const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const args = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--') && rest[i - 1] !== '--live'));
  if (!cmd || cmd === '--help' || cmd === '-h' || !['whoami', 'guilds', 'channels', 'read', 'tickets'].includes(cmd)) {
    (cmd && !['--help', '-h'].includes(cmd) ? err : out)(USAGE);
    return cmd && !['--help', '-h'].includes(cmd) ? 1 : 0;
  }

  const st = readState(data);
  const status = st.status ?? {};

  // Kept tickets need no token and no Discord.
  if (cmd === 'tickets' && !rest.includes('--live')) return printTickets(data, Number(flag('--days') ?? 14), out, err);

  const { config, why } = await loadSettings(appDir, data, env);
  if (!config) { err(why); return 1; }
  const token = config.discord?.token ?? '';
  if (!token) {
    err('No Discord account is connected. The super-admin connects one in the panel: Settings -> Connection -> Discord (read-only).');
    err('If one is connected and this says otherwise, MASTER_KEY in .env does not match data/config.json.');
    return 1;
  }
  const scrub = (t) => scrubToken(t, token);
  const deadSince = refusedSince(status, readRefused(data));
  if (deadSince) {
    err(`Discord refused the token saved${status.user?.username ? ` for ${status.user.username}` : ''} at ${when(deadSince)} (HTTP 401), `
      + 'so it is not sent again: the Discord password was changed, or the account logged out of all devices.');
    err('Reconnect in the panel: Settings -> Connection -> Discord (read-only). `tickets` without --live still prints what was kept.');
    return 2;
  }
  let client;
  try {
    client = new DiscordReader({ token, fetch });
  } catch (e) {
    err(scrub(e.message));
    return 1;
  }

  try {
    switch (cmd) {
      case 'whoami': {
        const u = await client.me();
        out(`Signed in as ${u.username}${u.global_name ? ` (${u.global_name})` : ''}, id ${u.id}`);
        out(`Reader: ${status.brokenSince ? `STOPPED since ${when(status.brokenSince)} - ${status.brokenWhy ?? 'the token was refused'}`
          : status.lastReadAt ? `last read ${when(status.lastReadAt)}` : 'has not read yet'}`
          + `${status.lastError ? `; last problem: ${scrub(status.lastError)}` : ''}`);
        const w = watchSettings(config);
        out(`Watching: ${w.guilds.length} server(s), channels named /${w.patternText}/${w.channels.length ? `, and ${w.channels.length} channel id(s)` : ''}`);
        return 0;
      }
      case 'guilds': {
        const list = await client.guilds();
        const w = new Set(watchSettings(config).guilds);
        for (const g of list ?? []) out(`${w.has(String(g.id)) ? '*' : ' '} ${g.id}  ${g.name}`);
        out(`${(list ?? []).length} server(s); * = watched by the reader`);
        return 0;
      }
      case 'channels': {
        const guild = args[0];
        if (!SNOWFLAKE.test(guild ?? '')) { err('usage: node tools/discord.mjs channels <guildId>   (node tools/discord.mjs guilds lists them)'); return 1; }
        const list = await client.guildChannels(guild);
        const w = watchSettings(config);
        const me = status.user?.id ?? null;
        const text = (list ?? []).filter((c) => c.type === 0 || c.type === 5).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
        for (const c of text) {
          const watched = (w.guilds.includes(guild) && w.pattern.test(c.name ?? '')) || w.channels.includes(String(c.id));
          const last = c.last_message_id ? when(timeOfSnowflake(c.last_message_id)) : 'no messages';
          out(`${watched ? '*' : ' '} ${c.id}  #${c.name}  (last message ${last})${me && !visibleToMe(c, me, guild) ? '  [hidden from this account]' : ''}`);
        }
        out(`${text.length} text channel(s); * = read by the reader`);
        return 0;
      }
      case 'read': {
        const channel = args[0];
        if (!SNOWFLAKE.test(channel ?? '')) { err('usage: node tools/discord.mjs read <channelId> [--limit N]'); return 1; }
        const limit = Math.max(1, Math.min(100, Number(flag('--limit') ?? 20) || 20));
        const msgs = await client.messages(channel, { limit });
        const sorted = [...(msgs ?? [])].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
        for (const m of sorted) printMessage(m, status.user?.id, out);
        out(`${sorted.length} message(s), oldest first, New York time`);
        return 0;
      }
      case 'tickets': {
        const w = watchSettings(config);
        for (const g of w.guilds) {
          const list = await client.guildChannels(g);
          const hits = (list ?? []).filter((c) => (c.type === 0 || c.type === 5) && w.pattern.test(c.name ?? ''));
          out(`Server ${g}: ${hits.length} channel(s) named /${w.patternText}/`);
          for (const c of hits) {
            out(`  ${c.id}  #${c.name}  (last message ${c.last_message_id ? when(timeOfSnowflake(c.last_message_id)) : 'none'})`
              + `${status.user?.id && !visibleToMe(c, status.user.id, g) ? '  [hidden from this account]' : ''}`);
          }
        }
        out('');
        return printTickets(data, Number(flag('--days') ?? 14), out, err);
      }
      default:
        return 1;
    }
  } catch (e) {
    if (e?.code === 'unauthorized') {
      err('Discord refused the saved token (HTTP 401): it has been revoked - the Discord password was changed, or the account');
      err('logged out of all devices. Reconnect in the panel: Settings -> Connection -> Discord (read-only).');
      const why = writeRefused(data, { at: Date.now(), connectedAt: status.connectedAt ?? null });
      err(why ? `Could not leave word for the bot's reader (${why}); it finds out on its next run, with one request. Do not run this again until it is reconnected.`
        : `Word is left for the bot's reader in ${path.join(data, 'discord-refused.json')}: neither it nor this tool will send that token again.`);
      return 2;
    }
    err(`Discord: ${scrub(e?.message ?? String(e))}`);
    return 3;
  }
}

function printMessage(m, me, out) {
  const who = `${displayName(m.author) ?? 'someone'}${m.author?.id && m.author.id === me ? ' (you)' : m.author?.bot ? ' (bot)' : ''}`;
  const at = Date.parse(m.timestamp) || timeOfSnowflake(m.id);
  out(`${when(at)}  ${who}: ${oneLine(m.content)}`);
  for (const e of m.embeds ?? []) { const t = embedText(e); if (t) out(`    [embed] ${oneLine(t)}`); }
  for (const a of m.attachments ?? []) out(`    [file] ${a.filename ?? '?'} ${a.url ?? ''}`.trimEnd());
}

function printTickets(dataDir, days, out, err) {
  const since = Date.now() - Math.max(1, Number.isFinite(days) ? days : 14) * 24 * 3600_000;
  const rows = readDiscordTickets(dataDir, { since });
  if (!rows.length) {
    err(`Nothing kept from the last ${days} day(s) in ${path.join(dataDir, 'discord-tickets.jsonl')}.`);
    return 0;
  }
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.channel)) by.set(r.channel, []);
    by.get(r.channel).push(r);
  }
  for (const [channel, list] of by) {
    const h = list[list.length - 1];
    out(`=== #${h.channelName ?? channel}${h.guildName ? ` on ${h.guildName}` : ''} (channel ${channel}) ===`);
    for (const r of list) {
      const who = `${r.author?.name ?? r.author?.username ?? 'someone'}${r.fromMe ? ' (you)' : r.author?.bot ? ' (bot)' : ''}`;
      out(`${when(r.at)}  ${who}: ${oneLine(rowText(r))}`);
      for (const a of r.attachments ?? []) out(`    [file] ${a.name ?? '?'} ${a.url ?? ''}`.trimEnd());
    }
    out('');
  }
  out(`${rows.length} message(s) in ${by.size} channel(s), last ${days} day(s), New York time`);
  return 0;
}

/**
 * The command as a shell runs it. Should the event loop ever empty before
 * main() has answered, that is said, with exit status 3, rather than passing
 * for a short answer: a rate-limit wait that held nothing open did exactly
 * that, and `whoami` printed nothing and exited 0 (2026-10-11, review; the
 * wait itself is fixed in discord-reader.js).
 */
export function runCli(argv, opts = {}) {
  let done = false;
  process.once('beforeExit', () => {
    if (done) return;
    done = true;
    console.error('tools/discord.mjs stopped before it had finished: nothing was left for it to wait on. What it printed is incomplete.');
    process.exitCode = 3;
  });
  return main(argv, opts).then((code) => { done = true; process.exitCode = code; }, (e) => {
    done = true;
    console.error(e?.message ?? e);
    process.exitCode = 1;
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) runCli(process.argv.slice(2));
