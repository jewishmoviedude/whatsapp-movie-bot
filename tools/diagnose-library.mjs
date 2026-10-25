#!/usr/bin/env node
/**
 * Ask the live Jellyfin the same questions the bot asks, and print what each
 * one answers.
 *
 *   node tools/diagnose-library.mjs "Kitchen Nightmares"
 *   node tools/diagnose-library.mjs --movie "Dune"
 *
 * Run it on the machine the bot runs on, with the bot's own configuration.
 * That is the point: "it is right there in Jellyfin" and "the bot cannot find
 * it" are both true surprisingly often, because the bot searches as its own
 * account, through an endpoint the Jellyfin web UI does not use. This prints
 * the difference instead of leaving it to be argued about.
 *
 * Reads data/config.json using MASTER_KEY from .env. Sends nothing to
 * WhatsApp, changes nothing, and never prints the token.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from '../src/config/store.js';
import { bestMatch, similarity, cleanRequestText } from '../src/util/fuzzy.js';
import { listSeasons, listEpisodes } from '../src/plugins/tv-requests/jellyfin-tv.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

const args = process.argv.slice(2);
const wantMovie = args.includes('--movie');
const query = args.filter((a) => !a.startsWith('--')).join(' ').trim();

if (!query) {
  console.error('usage: node tools/diagnose-library.mjs [--movie] "<title>"');
  process.exit(1);
}

/* MASTER_KEY lives in .env, and the file is the authority - the same rule
   src/index.js follows, so this reads exactly what the bot reads. */
function masterKey() {
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) {
    const m = fs.readFileSync(envPath, 'utf8').match(/^MASTER_KEY=(.+)$/m);
    if (m) return m[1].trim();
  }
  return process.env.MASTER_KEY ?? '';
}

const key = masterKey();
if (!key) {
  console.error('No MASTER_KEY in .env or the environment - cannot read the saved settings.');
  process.exit(1);
}

const cfg = new ConfigStore({ dataDir: DATA_DIR, masterKey: key }).load();
const jf = cfg.library?.jellyfin ?? {};
const base = String(jf.baseUrl ?? '').replace(/\/+$/, '');
const token = jf.accessToken || jf.apiKey;
const userId = jf.userId;

if (!base || !token) {
  console.error(`Jellyfin is not configured (baseUrl=${base || 'unset'}, token=${token ? 'set' : 'MISSING'}).`);
  console.error('If the token looks missing but you know you set one, MASTER_KEY does not match data/config.json.');
  process.exit(1);
}

const H = { 'X-Emby-Token': token, Accept: 'application/json' };
const line = (s = '') => console.log(s);
const rule = (t) => { line(); line(`--- ${t} ${'-'.repeat(Math.max(0, 64 - t.length))}`); };

async function get(url, label) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: H, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return { error: `HTTP ${res.status} ${res.statusText}`, ms: Date.now() - t0 };
    return { body: await res.json(), ms: Date.now() - t0 };
  } catch (err) {
    return { error: err.message, ms: Date.now() - t0 };
  }
}

const names = (items = []) => items.map((i) => `${i.Name}${i.ProductionYear ? ` (${i.ProductionYear})` : ''}`
  + `${i.OriginalTitle && i.OriginalTitle !== i.Name ? ` [orig: ${i.OriginalTitle}]` : ''}`
  + `${i.OfficialRating ? ` — ${i.OfficialRating}` : ''}`);

const show = (r, extract = (b) => b.Items ?? []) => {
  if (r.error) { line(`  ERROR: ${r.error}  (${r.ms}ms)`); return []; }
  const items = extract(r.body) ?? [];
  line(`  ${items.length} result(s)  (${r.ms}ms)`);
  for (const n of names(items).slice(0, 12)) line(`    · ${n}`);
  if (items.length > 12) line(`    … and ${items.length - 12} more`);
  return items;
};

line(`Jellyfin : ${base}`);
line(`As user  : ${userId || '(none — server-wide API key scope)'}`);
line(`Auth     : ${jf.authMethod ?? (jf.apiKey ? 'apikey' : 'token')}`);
line(`Looking for: "${query}"${wantMovie ? '  [as a MOVIE]' : '  [as a SERIES]'}`);

const cleaned = cleanRequestText(query) || query;
if (cleaned !== query) line(`After stripping request noise: "${cleaned}"`);

const TYPE = wantMovie ? 'Movie' : 'Series';
const FIELDS = 'ProductionYear,OfficialRating,OriginalTitle,SortName';

/* 1. Exactly what the bot asks first. */
rule('1. /Items?searchTerm  (the bot\'s first query, scoped to its own user)');
const u1 = new URL(`${base}/Items`);
u1.searchParams.set('searchTerm', cleaned);
u1.searchParams.set('IncludeItemTypes', TYPE);
u1.searchParams.set('Recursive', 'true');
u1.searchParams.set('Limit', '25');
u1.searchParams.set('Fields', FIELDS);
if (userId) u1.searchParams.set('UserId', userId);
const scoped = show(await get(u1.toString()));

/* 2. The endpoint the Jellyfin WEB UI uses. If this finds it and (1) does not,
      that difference is the whole bug. */
rule('2. /Search/Hints  (what the Jellyfin web UI itself uses)');
const u2 = new URL(`${base}/Search/Hints`);
u2.searchParams.set('searchTerm', cleaned);
u2.searchParams.set('includeItemTypes', TYPE);
u2.searchParams.set('limit', '25');
if (userId) u2.searchParams.set('userId', userId);
const hints = show(await get(u2.toString()), (b) => (b.SearchHints ?? []));

/* 3. The same query with no UserId. If this finds it and (1) does not, the
      bot's Jellyfin account cannot see the library. */
rule('3. The same query WITHOUT UserId  (is it a permissions problem?)');
const u3 = new URL(u1.toString());
u3.searchParams.delete('UserId');
const unscoped = userId ? show(await get(u3.toString())) : (line('  skipped — no UserId configured'), []);

/* 4. Everything, matched here rather than on the server. */
rule(`4. Each word alone  (what the bot tries before listing the library)`);
const words = [...new Set(cleaned.split(/\s+/).filter((w) => w.length >= 4))]
  .sort((a, b) => b.length - a.length).slice(0, 3);
let wordHit = null;
for (const w of words) {
  const uw = new URL(`${base}/Items`);
  uw.searchParams.set('searchTerm', w);
  uw.searchParams.set('IncludeItemTypes', TYPE);
  uw.searchParams.set('Recursive', 'true');
  uw.searchParams.set('Limit', '25');
  uw.searchParams.set('Fields', FIELDS);
  if (userId) uw.searchParams.set('UserId', userId);
  line(`  searchTerm="${w}"`);
  const got = show(await get(uw.toString()));
  const m = bestMatch(cleaned, got, { threshold: 0.72, getTitle: (i) => i.Name, getYear: (i) => i.ProductionYear });
  if (m && !wordHit) wordHit = { word: w, ...m };
}
if (!words.length) line('  (no word long enough to search on its own)');

rule(`5. Every ${TYPE}, matched locally with the bot's fuzzy matcher`);
const u4 = new URL(`${base}/Items`);
u4.searchParams.set('IncludeItemTypes', TYPE);
u4.searchParams.set('Recursive', 'true');
u4.searchParams.set('Limit', '1000');
u4.searchParams.set('Fields', FIELDS);
if (userId) u4.searchParams.set('UserId', userId);
const allRes = await get(u4.toString());
let ranked = [];
if (allRes.error) {
  line(`  ERROR: ${allRes.error}`);
} else {
  const all = allRes.body.Items ?? [];
  const grand = allRes.body.TotalRecordCount ?? all.length;
  line(`  showing ${all.length} of ${grand} ${TYPE.toLowerCase()}(s) visible to this account  (${allRes.ms}ms)`);
  if (grand > all.length) line(`  NOTE: this is only the first page — the bot pages through all ${grand}.`);
  ranked = all
    .map((i) => ({ i, score: Math.max(...[i.Name, i.OriginalTitle, i.SortName].filter(Boolean).map((n) => similarity(cleaned, n))) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  line('  closest by title similarity (the bot needs 0.72):');
  for (const { i, score } of ranked) {
    line(`    ${score.toFixed(3)}  ${score >= 0.72 ? '✓' : ' '} ${names([i])[0]}`);
  }
}

/* The account itself: the usual culprit when everything above is empty. */
rule('6. The Jellyfin account the bot searches as');
let policy = null;
if (userId) {
  const who = await get(`${base}/Users/${userId}`);
  if (who.error) line(`  ERROR: ${who.error}`);
  else {
    policy = who.body.Policy ?? {};
    line(`  Name                : ${who.body.Name}`);
    line(`  Sees all libraries  : ${policy.EnableAllFolders === true ? 'yes' : 'NO'}`);
    if (policy.EnableAllFolders !== true) {
      line(`  Enabled folder ids  : ${(policy.EnabledFolders ?? []).join(', ') || '(none)'}`);
      line('  ^ if the TV library is not in that list, the bot cannot see any show in it.');
    }
    line(`  Max parental rating : ${policy.MaxParentalRating ?? '(none)'}`);
    line(`  Blocked tags        : ${(policy.BlockedTags ?? []).join(', ') || '(none)'}`);
  }
} else {
  line('  No UserId configured — queries run at the API key\'s scope.');
}

/* The verdict, in the terms the bug report was made in. */
rule('VERDICT');
const found = (list) => list.length > 0;
const bestLocal = ranked[0];

// Ordered by ROOT cause, not by which query happened to answer first. A
// permissions problem outranks a search-endpoint mismatch: if the bot's account
// cannot see the library, fixing the search only papers over it, and every
// other title in that library is wrong too.
if (found(scoped)) {
  const m = bestMatch(cleaned, scoped, { threshold: 0.72, getTitle: (i) => i.Name, getYear: (i) => i.ProductionYear });
  if (m) line(`The bot finds this on its first query, as "${m.item.Name}" (score ${m.score.toFixed(3)}).`);
  else line('Jellyfin returns rows but none score 0.72 — the fallbacks below decide it.');
} else if (found(unscoped) || (policy && policy.EnableAllFolders !== true)) {
  line('It is on the server, and INVISIBLE to the account the bot searches as.');
  line(`FIX: Jellyfin → Dashboard → Users → ${userId} → Access — tick the library it is in,`);
  line('and check Max Parental Rating is not excluding it.');
  if (found(hints)) line('(The web UI also finds it, but fix the permissions first — that is the root cause.)');
} else if (found(hints)) {
  line('The web UI finds it and the bot\'s first query does not.');
  line('CAUSE: /Items?searchTerm is a plain filter and cannot match this title.');
  line('The layered lookup now recovers this via /Search/Hints.');
} else if (bestLocal && bestLocal.score >= 0.72) {
  line(`Only a full listing finds it, as "${bestLocal.i.Name}" (score ${bestLocal.score.toFixed(3)}).`);
  line('The layered lookup now recovers this by matching locally.');
} else if (bestLocal) {
  line(`Nothing reaches 0.72. The closest is "${bestLocal.i.Name}" at ${bestLocal.score.toFixed(3)}.`);
  line('Either it genuinely is not there, or it is stored under a name too different');
  line('to match — in which case ask for it by the name shown above.');
} else {
  line('Nothing at all came back. Check the server URL and the token first.');
}
line();

/* What the bot would send, season by season - for a show it finds.
   "Not enough episodes" is often not the library's fault: on 2026-10-06 the
   bot sent 3 of Frieren's 28 season-1 files, Jellyfin having numbered only 3,
   and the hourly check, which ran this tool, saw only that the show was
   found and called it a content gap. This lists, per season, what the folder
   holds against what the bot's own listing (listEpisodes) would send, and the
   files Jellyfin could not number, so a wrong answer about a season shows. */
if (!wantMovie) {
  const pick = [...scoped, ...unscoped, ...hints.map((h) => ({ Id: h.ItemId ?? h.Id, Name: h.Name }))].filter((i) => i?.Id);
  const m = pick.length ? bestMatch(cleaned, pick, { threshold: 0.72, getTitle: (i) => i.Name, getYear: (i) => i.ProductionYear }) : null;
  if (m) {
    rule(`7. Season by season: "${m.item.Name}" - what the bot would send`);
    const o = { base, token, userId, fetchImpl: (url, init) => fetch(url, { ...init, headers: { ...(init?.headers ?? {}), ...H } }) };
    const ranges = (ns) => {
      const out = [];
      for (const n of [...new Set(ns)].sort((a, b) => a - b)) {
        const last = out[out.length - 1];
        if (last && n === last[1] + 1) last[1] = n; else out.push([n, n]);
      }
      return out.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ') || 'none';
    };
    try {
      const seasons = await listSeasons(m.item.Id, o);
      if (!seasons.length) line('  No numbered seasons at all.');
      for (const se of seasons) {
        const eps = await listEpisodes(m.item.Id, { ...o, season: se.season });
        const nums = eps.map((e) => e.episode).filter((n) => Number.isFinite(n));
        const fromName = eps.filter((e) => e.numberedFromName).length;
        const max = Math.max(0, ...nums);
        const gaps = [...Array(max).keys()].map((i) => i + 1).filter((n) => !nums.includes(n));
        line(`  Season ${se.season}: folder holds ${se.episodes ?? '?'} file(s); the bot sends ${eps.length} - episodes ${ranges(nums)}`
          + `${fromName ? ` (${fromName} numbered from the file name: Jellyfin could not number them)` : ''}`
          + `${gaps.length ? `; missing ${ranges(gaps)}` : ''}`);
        if (se.episodes != null && se.episodes > eps.length) {
          line(`    ${se.episodes - eps.length} file(s) in the folder are not sent: no number Jellyfin or the file name gives, or a copy.`);
        }
      }
    } catch (err) {
      line(`  Could not list the seasons: ${err.message}`);
    }
    line();
  }
}
