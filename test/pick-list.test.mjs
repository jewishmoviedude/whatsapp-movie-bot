/* "Which one?" lists for remakes, and the two need-year fixes that ship with
   them. Run: node test/pick-list.test.mjs

   2026-09-22: of 32 movie requests that morning, two were bounced with 📅
   "add a year". A bare "venom" was one - the server holds Venom from 1981,
   2005, 2011 and 2018 - and its answer went to the notifications group,
   which about half of the requesters are not in; they saw an emoji and
   nothing else, and recovered 80 to 177 seconds later by retyping. The other
   was "ocean's 11 (2001)", told to add a year it already had (log 06:34:22).

   The operator chose the narrow fix: behind the beta flag 'movie-pick-list',
   a title with no year that the server holds in 2 to 5 sendable versions gets
   ONE quoted reply listing them, and the requester answers with a digit. And,
   unflagged, the "add a year" note lists the years we hold that could be sent
   (not a misleading "(2018)"), and a request with a year is never asked for
   one.

   What must not happen, and is pinned below: a list in a main group while the
   flag is Beta; a list offering something the bot would refuse (John Wick is
   all R); anyone but the requester answering it; a pick being moderated or
   throttled; any change at all with the flag Off - the Off cases are compared
   against outbound captured from origin/main before this change.

   A review of the branch the same day found the list could still offer a
   version the bot then refused (no Jellyfin rating; an override by link),
   that a refused pick left the member stuck behind a ✔, that a restart
   mid-pick or mid-expiry lost the outcome, that a History Re-run of a picked
   row sent a different Venom, and - older than this branch - that a missing
   file could be replaced by a same-titled remake with another rating. Those
   are the "[review]" blocks near the end.

   Later that day, in the beta group, "#request harry potter" got no list at
   all (log 16:58:03): no film is called plain "Harry Potter", so there were
   no versions of one title to offer, OMDb resolved the words to its best
   search hit, "...the Deathly Hallows: Part 2" [search 0.94], and the bot
   queued that; an admin cancelled it. The operator's rule since: a bare
   title offers every sendable film whose title STARTS WITH the words typed,
   even when one film has exactly that title ("cars" is Cars, Cars 2, Cars
   3), up to nine; more than nine gets one reply asking for another word or
   the year. Those are the "[franchise]" blocks at the very end, and the
   flag-Off cases for them are compared against origin/main like the rest.

   On 2026-09-29 the operator made the beta group a place for tests only: a
   request there counts only after its code ("$beta001 #request harry
   potter") and a test never downloads - where it would be queued it answers
   "✅ Test passed" (beta.js, test/beta-test-mode.test.mjs). So the beta-group
   cases below send their requests with the code, a pick is read from its
   'test-passed' row rather than from a queued job, and the flag-Off cases in
   the beta group expect nothing at all.

   On 2026-10-01 the operator asked: "for beta001 users should be able to
   react with a number emoji instead of replying". The "[reaction]" blocks at
   the end run a keycap reacted on the list through the whole pipeline; the
   rest of it is test/reaction-pick.test.mjs.

   On 2026-10-10 the live config.json held `beta.features: {}`, so the flag
   was Off although the operator had taken the list out of beta, and real
   requests for Heat (1995, 2013), Insomnia (1997, 2002), Casino Royale
   (1967, 2006), The Girl Next Door (2004, 2007) and Venom (1981, 2005, 2011,
   2018) were each answered "which year?" (need-year) instead of with the
   list. The operator, 2026-10-11: "for insomnia and heat (and all others
   with same name different years) we already moved that the bot should
   respond listing all out of beta, so why didn't it work for those?" The
   flag is gone: every request group gets the list, whatever the beta config
   says, and beta001 is a retired code. So the cases that pinned the flag -
   Off matching origin/main, Beta keeping the list out of the main groups,
   Off as a kill switch for open lists - are gone or turned round (a stale
   Off left in config.json stops nothing), the "add a year" note is pinned
   where it is still said (when step 0 could not search the library), and
   the incident itself is the "2026-10-10" block near the end. In the beta
   group the requests are sent under $beta004, a film test still running,
   and get the list as any request does.

   Everything runs the real movie plugin with a fake WhatsApp that records
   every outbound action, and OMDb and Jellyfin answered by a stubbed fetch. */
import './fixtures/roomy-disk.mjs';
import './fixtures/omdb-no-wait.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';
import { FEATURES, RETIRED_CODES } from '../src/core/beta.js';
import { buildDigest } from '../src/core/daily-digest.js';
import { WhatsAppBot } from '../src/core/bot.js';
import { PluginManager } from '../src/core/plugin-manager.js';
import { stamIntercept } from '../src/core/stam-test.js';
import {
  listableVersions, parsePick, sameSender, formatPickList, needYearNote, summarisePickLists,
  pickListSettings, EDIT_WINDOW_MS, formatPicked, formatPickFailed, formatExpired, answersList,
  MAX_CLOSE_ATTEMPTS, CLOSE_RETRY_MS, decidePickList, narrowDownText, hasSignificantWord, offeredLabels, plainText,
} from '../src/plugins/movie-requests/pick-list.js';
import { libraryVersions } from '../src/plugins/movie-requests/library.js';
import { clearPlotCache, listPlots, shortenPlot } from '../src/plugins/movie-requests/omdb.js';
import { startsWithWords, cleanRequestText } from '../src/util/fuzzy.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const TESTING = '120363900000000013@g.us';     // "Testing things", a beta group
const MAIN_REQ = 'movie-requests@g.us';
const MAIN_POSTS = 'movie-posts@g.us';
const MAIN_NOTIFY = 'movie-notify@g.us';
const MAIN = [MAIN_REQ, MAIN_POSTS, MAIN_NOTIFY];

/* ============================ fixtures ============================ */

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/&/g, ' and ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(the|a|an)\s+/, '');

let fid = 0;
const film = (Name, ProductionYear, OfficialRating, Type = 'Movie') => ({
  Id: `jf${++fid}`, Name, ProductionYear, OfficialRating, Type,
  MediaSources: [{ Path: `/nowhere/${Name}.mkv`, Size: 17, Container: 'mp4' }],
});
// The live server's same-title sets (Cinderella x5, A Christmas Carol x4,
// Godzilla x3, Dune x2, Venom x4), with the ratings arranged to exercise the
// "sendable" rule: Venom 1981 is R, Godzilla 1954 is Not Rated.
const LIBRARY = [
  film('Inception', 2010, 'PG-13'),
  film('Venom', 1981, 'R'), film('Venom', 2005, 'PG-13'), film('Venom', 2011, 'PG'), film('Venom', 2018, 'PG-13'),
  film('Dune', 1984, 'PG-13'), film('Dune', 2021, 'PG-13'), film('Dune: Part Two', 2024, 'PG-13'),
  film('Cinderella', 1950, 'G'), film('Cinderella', 1965, 'G'), film('Cinderella', 1997, 'PG'),
  film('Cinderella', 2015, 'PG'), film('Cinderella', 2021, 'PG'),
  // Seven more titles start with "cinderella", which takes the franchise over
  // a list of nine and exercises the remakes-are-the-point rule below.
  film('A Cinderella Story', 2004, 'PG'), film('Cinderella II: Dreams Come True', 2002, 'G'),
  film('Cinderella III: A Twist in Time', 2007, 'G'), film('Cinderella Man', 2005, 'PG-13'),
  film('Cinderella Liberty', 1973, 'PG'), film('Cinderella and the Secret Prince', 2018, 'G'),
  film('Cinderella: After Ever After', 2019, 'G'),
  film('A Christmas Carol', 1938, 'G'), film('A Christmas Carol', 1984, 'PG'),
  film('A Christmas Carol', 1999, 'PG'), film('A Christmas Carol', 2009, 'PG'),
  film('Godzilla', 1954, 'Not Rated'), film('Godzilla', 1998, 'PG-13'), film('Godzilla', 2014, 'PG-13'),
  film('Hamlet', 1948, 'PG'), film('Hamlet', 1964, 'PG'), film('Hamlet', 1969, 'PG'),
  film('Hamlet', 1990, 'PG'), film('Hamlet', 1996, 'PG'), film('Hamlet', 2000, 'PG'),
  film('John Wick', 2014, 'R'), film('John Wick', 2014, 'TV-MA'), film('John Wick: Chapter 2', 2017, 'R'),
  film('Cosmos', 1980, 'G'), film('Cosmos', 2019, 'PG'), film('Cosmos', 2014, 'TV-PG', 'Series'),
  film('Frozen', 2010, 'R'), film('Frozen', 2013, 'PG'),
  film("Ocean's Eleven", 2001, 'PG-13'), film("Ocean's 11", 1960, 'Approved'),
  film('21', 2008, 'PG-13'),
  // Added for the review fixes, at the end so the ids above do not move.
  // Carrie 1976: PG in Jellyfin, R in OMDb - a list offers it, the request
  // refuses it. Solaris 2002: OMDb files it a year later. Scarface: no rating
  // in Jellyfin at all, R in OMDb. Hairspray 2016: no Jellyfin rating either.
  // Total Recall 2012: held twice (one copy's file gone), next to the R 1990.
  film('Carrie', 1976, 'PG'), film('Carrie', 2002, 'PG-13'), film('Carrie', 2013, 'PG-13'),
  film('Solaris', 1972, 'PG'), film('Solaris', 2002, 'PG-13'),
  film('Scarface', 1932, null), film('Scarface', 1983, null),
  film('Hairspray', 1988, 'PG'), film('Hairspray', 2007, 'PG'), film('Hairspray', 2016, null),
  film('Total Recall', 1990, 'R'), film('Total Recall', 2012, 'PG-13'), film('Total Recall', 2012, 'PG-13'),
  // Added for the franchise lists, again at the end. Harry Potter is held out
  // of release order, with one film twice and a series of the same name, so
  // the list's own sorting, collapsing and film-only rule are what put it
  // right. Carson City starts with the letters of "cars" but not the word.
  // John Wick's chapters are all R, like the first. Batman is 23 films, one
  // of them R: 22 sendable, more than a list offers. Paddington 2 is the only
  // "paddington" held, and OMDb files it a year later than Jellyfin. Alien is
  // R, and Alien Xmas is the only sendable film starting with "alien".
  film('Harry Potter and the Deathly Hallows: Part 2', 2011, 'PG-13'),
  film('Harry Potter and the Chamber of Secrets', 2002, 'PG'),
  film('Harry Potter and the Goblet of Fire', 2005, 'PG-13'),
  film("Harry Potter and the Sorcerer's Stone", 2001, 'PG'),
  film('Harry Potter and the Half-Blood Prince', 2009, 'PG'),
  film('Harry Potter and the Prisoner of Azkaban', 2004, 'PG'),
  film('Harry Potter and the Goblet of Fire', 2005, 'PG-13'),
  film('Harry Potter and the Order of the Phoenix', 2007, 'PG-13'),
  film('Harry Potter and the Deathly Hallows: Part 1', 2010, 'PG-13'),
  film('Harry Potter: Hogwarts Tournament of Houses', 2021, 'TV-G', 'Series'),
  film('Cars', 2006, 'G'), film('Cars 2', 2011, 'G'), film('Cars 3', 2017, 'G'),
  film('Carson City', 1952, 'Approved'), film('Cars on the Road', 2022, 'TV-G', 'Series'),
  film('John Wick: Chapter 3 - Parabellum', 2019, 'R'), film('John Wick: Chapter 4', 2023, 'R'),
  film('Toy Story', 1995, 'G'), film('Toy Story 2', 1999, 'G'), film('Toy Story 3', 2010, 'G'), film('Toy Story 4', 2019, 'G'),
  film('The Hobbit: The Desolation of Smaug', 2013, 'PG-13'), film('The Hobbit: An Unexpected Journey', 2012, 'PG-13'),
  film('The Hobbit: The Battle of the Five Armies', 2014, 'PG-13'),
  film('Star Wars: Episode I - The Phantom Menace', 1999, 'PG'), film('Star Wars: Episode II - Attack of the Clones', 2002, 'PG'),
  film('Star Wars: Episode III - Revenge of the Sith', 2005, 'PG-13'), film('Star Wars: Episode IV - A New Hope', 1977, 'PG'),
  film('Star Wars: Episode V - The Empire Strikes Back', 1980, 'PG'), film('Star Wars: Episode VI - Return of the Jedi', 1983, 'PG'),
  film('Star Wars: Episode VII - The Force Awakens', 2015, 'PG-13'), film('Star Wars: Episode VIII - The Last Jedi', 2017, 'PG-13'),
  film('Star Wars: Episode IX - The Rise of Skywalker', 2019, 'PG-13'),
  film('Batman', 1966, 'PG'), film('Batman', 1989, 'PG-13'), film('Batman Returns', 1992, 'PG-13'),
  film('Batman: Mask of the Phantasm', 1993, 'PG'), film('Batman Forever', 1995, 'PG-13'), film('Batman & Robin', 1997, 'PG-13'),
  film('Batman Begins', 2005, 'PG-13'), film('Batman: Under the Red Hood', 2010, 'PG-13'), film('Batman: Year One', 2011, 'PG-13'),
  film('Batman: The Dark Knight Returns, Part 1', 2012, 'PG-13'), film('Batman: The Dark Knight Returns, Part 2', 2013, 'PG-13'),
  film('Batman: Assault on Arkham', 2014, 'PG-13'), film('Batman vs. Robin', 2015, 'PG-13'), film('Batman: Bad Blood', 2016, 'PG-13'),
  film('Batman v Superman: Dawn of Justice', 2016, 'PG-13'), film('Batman: The Killing Joke', 2016, 'R'),
  film('Batman: Return of the Caped Crusaders', 2016, 'PG'), film('Batman vs. Two-Face', 2017, 'PG'),
  film('Batman: Gotham by Gaslight', 2018, 'PG-13'), film('Batman: Death in the Family', 2020, 'PG-13'),
  film('Batman: Soul of the Dragon', 2021, 'PG-13'), film('Batman: The Long Halloween, Part One', 2021, 'PG-13'),
  film('The Batman', 2022, 'PG-13'),
  film('Paddington 2', 2017, 'PG'),
  film('Alien', 1979, 'R'), film('Alien Xmas', 2020, 'PG'),
  // Added for the review fix to which words a list matches on. "Movie" is a
  // word in real titles: Garfield is held both as the 2004 film and as The
  // Garfield Movie, and the only Muppet film on the server is one the member
  // asking for "the muppet movie" did not name.
  film('Garfield', 2004, 'PG'), film('The Garfield Movie', 2024, 'PG'),
  film('The Muppet Christmas Carol', 1992, 'G'),
  // Added for 2026-10-10, the requests answered "which year?" while a config
  // with no beta modes had the list Off: the copies of each title the live
  // server held, R where the films are, so the AI check is what lets them
  // be listed, as on the live bot.
  film('Heat', 1995, 'R'), film('Heat', 2013, 'R'),
  film('Insomnia', 1997, 'Not Rated'), film('Insomnia', 2002, 'R'),
  film('Casino Royale', 1967, 'Approved'), film('Casino Royale', 2006, 'PG-13'),
  film('The Girl Next Door', 2004, 'R'), film('The Girl Next Door', 2007, 'R'),
];
const OMDB = LIBRARY.filter((f) => f.Type === 'Movie').map((f, i) => ({
  Title: f.Name, Year: String(f.ProductionYear), Rated: f.OfficialRating, imdbID: `tt${1000000 + i}`, Type: 'movie',
  Released: 'N/A', DVD: 'N/A', Response: 'True',
}));
const omdbOf = (title, year) => OMDB.find((m) => m.Title === title && m.Year === String(year));
omdbOf('Carrie', 1976).Rated = 'R';
omdbOf('Solaris', 2002).Year = '2003';
omdbOf('Scarface', 1932).Rated = 'Not Rated';
omdbOf('Scarface', 1983).Rated = 'R';
// OMDb lists a film once; the second Total Recall 2012 is a Jellyfin duplicate.
OMDB.splice(OMDB.lastIndexOf(omdbOf('Total Recall', 2012)), 1);
OMDB.splice(OMDB.lastIndexOf(omdbOf('Harry Potter and the Goblet of Fire', 2005)), 1);
omdbOf('Paddington 2', 2017).Year = '2018';
// The Muppet Movie is known to OMDb and NOT on the server, which is what the
// member who typed "the muppet movie" was asking for.
OMDB.push({
  Title: 'The Muppet Movie', Year: '1979', Rated: 'G', imdbID: 'tt0079588', Type: 'movie',
  Released: 'N/A', DVD: 'N/A', Response: 'True',
});
const libItem = (name, year, nth = 0) => LIBRARY.filter((f) => f.Name === name && f.ProductionYear === year)[nth];

const netCalls = [];
let onLibrarySearch = null;          // lets a test change the config mid-search
let libraryHold = null;              // a promise the library search waits on (a "hang")
const GONE = new Set();              // library items whose file is gone: download 404
const downloads = [];                // every item id a download was attempted for
let omdbDown = false;                // OMDb answering 503
const aiAsks = [];                   // every question put to the AI check
let aiVerdict = () => ({ nudity: false, confidence: 0.9, basis: 'violence only' });
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  netCalls.push(String(url));
  const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  const miss = (e = 'Movie not found!') => json({ Response: 'False', Error: e });
  if (u.hostname === 'www.omdbapi.com') {
    if (omdbDown) return new Response('', { status: 503, statusText: 'Service Unavailable' });
    const p = u.searchParams;
    const y = p.get('y') ? Number(p.get('y')) : null;
    if (p.get('i')) return json(OMDB.find((m) => m.imdbID === p.get('i')) ?? miss());
    if (p.get('t')) {
      const hits = OMDB.filter((m) => norm(m.Title) === norm(p.get('t')) && (!y || Number(m.Year) === y));
      return hits.length ? json(hits.sort((a, b) => Number(b.Year) - Number(a.Year))[0]) : miss();
    }
    if (p.get('s')) {
      const s = norm(p.get('s'));
      // What OMDb really answered on 2026-09-22 06:34, even with y=2001.
      if (s === 'ocean s 11' || s === '11') return miss('Too many results.');
      const hits = OMDB.filter((m) => norm(m.Title).includes(s) && (!y || Number(m.Year) === y));
      return hits.length
        ? json({ Response: 'True', Search: hits.map(({ Title, Year, imdbID, Type }) => ({ Title, Year, imdbID, Type })) })
        : miss();
    }
    return miss();
  }
  // The AI content check, for the lists that offer films it could clear. Its
  // answer is aiVerdict's for the question asked; every question is kept.
  if (u.hostname === 'generativelanguage.googleapis.com') {
    const asked = String(init?.body ?? '');
    aiAsks.push(asked);
    return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(aiVerdict(asked)) }] }, finishReason: 'STOP' }] });
  }
  if (u.hostname === 'jf.test') {
    if (u.pathname.includes('/Download')) {
      const id = u.pathname.split('/')[2];
      downloads.push(id);
      return GONE.has(id) ? new Response('', { status: 404, statusText: 'Not Found' }) : new Response('film bytes', { status: 200 });
    }
    if (u.pathname === '/Items') {
      const term = u.searchParams.get('searchTerm');
      if (!term || u.searchParams.get('IncludeItemTypes') === 'Series') return json({ Items: [] });
      onLibrarySearch?.(term);
      if (libraryHold) await libraryHold;
      // Deliberately not filtered by type: a list must not rely on the
      // server to keep a series of the same name out of it. The limit is
      // honoured, as the real server does, so a search that fills it can be
      // told apart from one that did not.
      const limit = Number(u.searchParams.get('Limit')) || Infinity;
      return json({ Items: LIBRARY.filter((f) => norm(f.Name).includes(norm(term))).slice(0, limit) });
    }
    return json({ Items: [] });
  }
  return new Response('{}', { status: 404, statusText: 'not stubbed' });
};
const omdbCalls = () => netCalls.filter((u) => u.includes('omdbapi.com')).length;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-list-test-'));
const WORK = path.join(TMP, 'work');
fs.mkdirSync(WORK);
const FFPROBE = path.join(TMP, 'ffprobe');
fs.writeFileSync(FFPROBE, `#!/bin/sh
cat <<'JSON'
{"streams":[{"codec_type":"video","codec_name":"h264","width":1280,"height":720},{"codec_type":"audio","codec_name":"aac","channels":2}],"format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"60","size":"17"}}
JSON
`, { mode: 0o755 });

// The film test the beta group's requests are sent under. It was $beta001,
// the list itself, until the list left beta (2026-10-11); any film test that
// is running gets the list now, as every request does.
const CODE = 'beta004';

function config({ movie = {}, beta = {} } = {}) {
  const c = mergeDefaults({
    movieRequests: {
      requestGroups: [MAIN_REQ], postsGroup: MAIN_POSTS, notify: { group: MAIN_NOTIFY },
      requirePrefix: true, prefix: '#request', cooldownSecondsPerUser: 0,
      // React only, and 50 waiting: the defaults this was written against,
      // until 2026-10-12 (request-rule-defaults).
      replyOnBlock: false, announceRated: true, notifyRefusals: true, maxQueueLength: 50, ...movie,
    },
    beta: { groups: [TESTING], features: { 'movie-duplicate-notice': 'beta' }, ...beta },
  }, DEFAULT_CONFIG);
  c.omdb.apiKey = 'test-key';
  c.library = mergeDefaults({
    provider: 'jellyfin',
    jellyfin: { baseUrl: 'http://jf.test', authMethod: 'apikey', apiKey: 'KEY', accessToken: 'TOK', userId: 'U1' },
  }, DEFAULT_CONFIG.library);
  Object.assign(c.media, { workDir: WORK, ffprobePath: FFPROBE, ffmpegPath: '/bin/false', deleteAfterSend: true });
  return c;
}

function fakeStore(data = {}) {
  return {
    _data: data,
    get: (k, d = null) => (k in data ? data[k] : d),
    set: (k, v) => { data[k] = v; },
    push: (k, v, cap = 200) => { (data[k] ??= []).unshift(v); if (data[k].length > cap) data[k].length = cap; },
  };
}

/** A WhatsApp that records every outbound action, where it went and at what priority. */
function fakeBot(out, { admins = [] } = {}) {
  let sent = 0;
  return {
    paced: 0,
    isConnected: () => true,
    react: async (msg, emoji, opts = {}) => {
      out.push({ op: 'react', jid: msg.chatJid, on: msg.id, emoji, kind: opts.kind ?? 'normal' });
      return true;
    },
    sendText: async (jid, body, opts = {}) => {
      out.push({ op: 'text', jid, body, quoted: opts.quoted?.id ?? null, kind: opts.kind ?? 'critical' });
      return { key: { remoteJid: jid, fromMe: true, id: `BOT${++sent}` } };
    },
    editText: async (jid, key, body, opts = {}) => {
      out.push({ op: 'edit', jid, key: key.id, body, kind: opts.kind ?? 'low' });
      return true;
    },
    sendDocument: async (jid, file, opts) => { out.push({ op: 'document', jid, file: opts?.fileName }); return {}; },
    deleteMessage: async (m) => { out.push({ op: 'delete', jid: m.chatJid, on: m.id }); },
    archiveChat: async () => {},
    isGroupAdmin: (g, who) => admins.includes(who?.jid),
    groupMemberInfo: () => ({ isMember: false, mentionJid: null, mentionText: null }),
    groups: () => [],
    groupCache: new Map(),
    sameCommunity: () => false,
    groupMentionToken: (jid) => `@${jid.split('@')[0]}`,
    async _bulkPace() { this.paced += 1; },
    on() {}, off() {},
  };
}

function harness(cfg, store = fakeStore(), opts = {}) {
  const out = [];
  const jobs = [];
  const logs = [];
  const log = (lvl) => (m) => logs.push(`${lvl} ${m}`);
  const ctx = {
    config: cfg,
    store,
    bot: fakeBot(out, opts),
    log: { info: log('info'), warn: log('warn'), error: log('error'), debug() {} },
    configStore: { update() {} },
    queue: {
      maxLength: 50, pending: [],
      add: (j) => { jobs.push(j); return `job-${jobs.length}`; },
      snapshot: () => ({ pending: [], active: [] }),
    },
  };
  return { ctx, out, jobs, store, logs };
}

let seq = 0;
const ALICE = { sender: 'alice@lid', number: '15550000001' };
const BOB = { sender: 'bob@lid', number: '15550000002' };
function mkMsg(text, chatJid, { sender = ALICE.sender, number = ALICE.number, id = null } = {}) {
  const mid = id ?? `M${++seq}`;
  return {
    id: mid, key: { id: mid, remoteJid: chatJid, participant: sender, fromMe: false }, text, chatJid,
    isGroup: true, fromMe: false, messageType: 'conversation', senderJid: sender, senderNumber: number,
    senderNumberDisplay: `+${number}`, pushName: sender.split('@')[0], timestamp: 1_700_000_000_000,
    raw: { key: { id: mid } },
  };
}
const fakeJob = () => ({ id: `j${++seq}`, progress() {}, isCancelled: () => false, cancelReason: () => null });
const settle = () => new Promise((r) => setTimeout(r, 20));
// In the beta group a request counts only after its test code (2026-09-29,
// beta.js readBetaTest), so a request sent there here is written as a tester
// writes it, "$beta004 #request Venom". A number answering a list is sent as
// it is: it continues a test already started, and needs no code.
const coded = (h, text, chat) => (chat === TESTING && typeof text === 'string' && !text.startsWith('$')
  && !/^\s*(#request\s*)?\d+\s*$/i.test(text)
  ? `$${CODE} ${text}` : text);
// What the bot sent, or would have: a queued job's label, or, for a test in
// the beta group - which queues nothing since the operator's "test passed"
// rule (2026-09-29) - the film its 'test-passed' History row names.
const passedRows = (h) => (h.store.get('history', []) ?? []).filter((r) => r.status === 'test-passed');
const sent = (h) => h.jobs[0]?.label ?? (passedRows(h).length ? `${passedRows(h).at(-1).title} (${passedRows(h).at(-1).year})` : undefined);
const sentCount = (h) => h.jobs.length + passedRows(h).length;
const send = async (h, text, chat = TESTING, who = ALICE, id = null) => {
  const m = mkMsg(coded(h, text, chat), chat, { ...who, id });
  await moviePlugin.onMessage(m, h.ctx);
  await settle();
  return m;
};
const texts = (out) => out.filter((e) => e.op === 'text');
const since = (out, n) => out.slice(n);
// A posted list starts with this header (the paragraphed layout of
// 2026-09-30), and listFilms reads its numbered films back as "N Title (Year)",
// struck-through ones included, so a test can say which films were offered
// without restating the whole layout.
const LIST_HEAD = /^🔍 \*Search results/;
const listFilms = (body) => String(body ?? '').split('\n\n')
  .map((b) => b.match(/^\*(\d+)\.\* (.+)/) ?? b.match(/^~(\d+)\. (.+?)~/)).filter(Boolean).map((m) => `${m[1]} ${m[2]}`);
// The whole text of a list as the bot posts it, for the tests that pin it.
const listText = (query, films, { test = true, minutes = 10 } = {}) => [
  `🔍 *Search results for "${query}"*`, ...films.map((f, i) => `*${i + 1}.* ${f}`),
  (films.length <= 10
    ? `Reply with a number (1–${films.length}), or react with it, to ${test ? 'test' : 'get'} it.`
    : `Reply with a number (1–${films.length}) to ${test ? 'test' : 'get'} it, or react 1️⃣–🔟 for one of the first ten.`)
    + `${test ? ' Nothing is downloaded.' : ''} This list expires in ${minutes} minutes.`,
].join('\n\n');
const row = (store, id) => (store.get('history', []) ?? []).find((r) => r.id === id);
const openLists = (store) => (store.get('pickLists', []) ?? []).filter((l) => l.state === 'open');

moviePlugin._reactors = new Map();                  // normally created by setup()

/* ============================ pure logic ============================ */

console.log('=== no flag: the list left beta, and its code is retired ===');
{
  ok(!FEATURES.some((x) => x.key === 'movie-pick-list' || x.code === 'beta001'),
    'not in the beta registry, so no config.json - an empty one included - can switch it off');
  ok(RETIRED_CODES.includes('beta001'), 'and beta001 is retired, never handed to another feature');
  const s = pickListSettings(DEFAULT_CONFIG.movieRequests);
  ok(s.expiryMinutes === 10 && s.maxOptions === 20 && s.maxOpenPerGroup === 5, 'expiry 10 minutes, at most 20 options, 5 open per group');
  ok(pickListSettings({ pickList: { maxOptions: 40 } }).maxOptions === 20,
    'a list never runs past 20 - the whole series, but a ceiling on one message into a request group');
  // The live config.json has maxOptions: 5 SAVED - ConfigStore.save() writes
  // the defaults back - and the panel has no control for it, so nobody chose it.
  ok(pickListSettings({ pickList: { expiryMinutes: 10, maxOptions: 5, maxOpenPerGroup: 5 } }).maxOptions === 20
    && pickListSettings({ pickList: { expiryMinutes: 10, maxOptions: 9, maxOpenPerGroup: 5 } }).maxOptions === 20,
    'the old defaults of 5 and 9, saved into config.json by every settings save (the live one holds 9), are read as the new 20');
  ok(pickListSettings({ pickList: { maxOptions: 4 } }).maxOptions === 4 && pickListSettings({ pickList: { maxOptions: 6 } }).maxOptions === 6,
    'any other value is honoured');
}

console.log('=== only sendable films are listable ===');
{
  const cfg = DEFAULT_CONFIG.movieRequests;
  const v = (year, rated, extra = {}) => ({ id: `v${year}`, title: 'Venom', year, rated, ratings: [rated], ...extra });
  const venom = [v(1981, 'R'), v(2005, 'PG-13'), v(2011, 'PG'), v(2018, 'PG-13')];
  ok(listableVersions(venom, cfg).map((x) => x.year).join() === '2005,2011,2018', 'a blocked rating is left off (Venom 1981 is R)');
  ok(listableVersions([v(2014, 'R'), v(2016, 'TV-MA')], cfg).length === 0, 'John Wick: nothing to offer');
  ok(listableVersions([v(1954, 'Not Rated'), v(2014, 'PG-13')], cfg).length === 2,
    'an unrated film is offered while blockUnrated is off - the pipeline\'s own policy');
  ok(listableVersions([v(1954, 'Not Rated'), v(2014, 'PG-13')], { ...cfg, blockUnrated: true }).length === 1,
    'and left off when the operator blocks unrated films');
  ok(listableVersions([v(1954, null), v(2014, 'PG-13')], { ...cfg, blockUnrated: true }).length === 1,
    'a version with no rating at all counts as unrated');
  // Review, 2026-09-22: Scarface 1983 with an empty Jellyfin rating was
  // listed, picked, and refused on OMDb's R - the list offered what the bot
  // then turned down. queueLibraryItem already refuses an empty rating.
  ok(listableVersions([v(1983, null), v(2014, 'PG-13')], cfg).map((x) => x.year).join() === '2014',
    'a version with NO library rating is never offered, even while unrated films are allowed');
  ok(listableVersions([v(1983, '  '), v(2014, 'PG-13')], cfg).length === 1, 'a blank rating is no rating');
  ok(listableVersions([v(2014, 'PG', { ratings: ['PG', null] })], cfg).length === 0,
    'nor a year where one copy of it has no rating');
  ok(listableVersions([v(2014, 'PG', { ratings: ['PG', 'R'] })], cfg).length === 0,
    'a year is offered only when every copy of it is sendable');
  ok(listableVersions([v(2014, 'PG', { types: ['Series'] }), v(2019, 'PG')], cfg).map((x) => x.year).join() === '2019',
    'a series of the same name is never offered as a film');
  ok(listableVersions([v(null, 'PG'), v(2019, 'PG')], cfg).length === 1, 'a version with no year cannot be picked by year');
  ok(listableVersions([{ title: 'Dune: Part Two', year: 2024, rated: 'PG-13' }, { title: 'Dune', year: 2021, rated: 'PG-13' }],
    cfg, { title: 'Dune' }).map((x) => x.title).join() === 'Dune', 'a sequel is a different title, never a version');
  const store = fakeStore({ 'rating-overrides': [{ key: 't:venom|1981', title: 'Venom', year: 1981 }] });
  ok(listableVersions(venom, cfg, { store }).length === 4, 'a rating override makes a blocked film sendable here too');
  // An override added by Jellyfin link was once matched by the request only
  // AFTER its rating gate had refused the film, so a list offering it got ⛔.
  // Since film-gate.js (2026-09-29) the request waits for the library and
  // honours the link on the copy it names, so a version whose every blocked
  // copy is linked is listed; one copy's link is not enough, since a pick
  // can land on another copy.
  const linked = fakeStore({ 'rating-overrides': [{ key: 'jf:v1981', jellyfinId: 'v1981', title: null, year: null }] });
  ok(listableVersions(venom, cfg, { store: linked }).map((x) => `${x.year}${x.via ? `:${x.via}` : ''}`).join() === '1981:bypass,2005,2011,2018',
    'an override by Jellyfin link makes the copy it names listable, marked as the bypass list\'s');
  ok(listableVersions([v(1981, 'R', { ids: ['v1981', 'other'], ratings: ['R', 'R'] })], cfg, { store: linked }).length === 0,
    'but not a film held twice with only one copy linked');
  ok(listableVersions(venom, cfg, { aiClears: true }).map((x) => `${x.year}${x.via ? `:${x.via}` : ''}`).join() === '1981:ai,2005,2011,2018',
    'a blocked film is listable when the AI check could clear it, marked so');
  ok(listableVersions([v(1983, null)], cfg, { aiClears: true }).length === 0,
    'while one with no library rating stays off, AI or not');
}

console.log('=== what counts as an answer ===');
{
  const list = { title: 'Venom', items: [{ title: 'Venom', year: 2005 }, { title: 'Venom', year: 2011 }, { title: 'Venom', year: 2018 }] };
  const P = (t) => parsePick(t, list, '#request');
  ok(P('2')?.index === 1 && P(' 3 ')?.index === 2, 'a single digit on the list');
  ok(P('7')?.invalid && P('0')?.invalid, 'a single digit off the list is a wrong number, not a request');
  ok(P('#request 1')?.index === 0 && P('#REQUEST 3')?.form === 'prefixed', '"#request N" with N on the list');
  ok(P('#request 9') === null && P('#request 21') === null && P('#request 1984') === null,
    '"#request 9", "#request 21", "#request 1984" are films, not picks');
  ok(P('#request Venom 2018')?.index === 2 && P('#request venom (2005)')?.form === 'title-year',
    'the list\'s own suggestion typed back is the pick it names');
  ok(P('#request Venom 1981') === null, 'but not a year the list did not offer - that is a request like any other');
  ok(P('12')?.invalid && P('2.') === null && P('two') === null && P('') === null && P('2014') === null,
    'two digits off the list are a wrong number; a year, "2." or a word are not answers at all');
  const long = { title: 'Saw', items: Array.from({ length: 12 }, (_, i) => ({ title: `Saw ${i + 1}`, year: 2004 + i })) };
  ok(parsePick('12', long, '#request')?.index === 11 && parsePick('10', long, '#request')?.form === 'digit',
    'a series longer than nine is picked with two digits (a list offers the whole series)');
  ok(parsePick('#request 2', list, '') === null && parsePick('2', list, '')?.index === 1,
    'with no prefix required, only the bare digit counts');
}

console.log('=== the same person, however WhatsApp names them ===');
{
  ok(sameSender({ jid: 'abc@lid' }, { jid: 'abc@lid' }), 'same LID');
  ok(sameSender({ jid: '15550000001:12@s.whatsapp.net' }, { jid: '15550000001@s.whatsapp.net' }), 'a device suffix does not make a new person');
  ok(sameSender({ jid: 'abc@lid', number: '15550000001' }, { jid: '15550000001@s.whatsapp.net', number: null }),
    'an @lid with a known number matches that number\'s phone JID');
  ok(!sameSender({ jid: 'abc@lid', number: '15550000001' }, { jid: 'xyz@lid', number: '15550000002' }), 'different people are different');
  ok(!sameSender({ jid: 'abc@lid' }, { jid: 'xyz@lid' }), 'two LIDs with no numbers are not assumed to match');
}

console.log('=== the words ===');
{
  const items = [
    { title: 'Venom', year: 1981, rated: 'PG' }, { title: 'Venom', year: 2005, rated: 'PG-13' },
    { title: 'Venom', year: 2011, rated: 'PG' }, { title: 'Venom', year: 2018, rated: 'PG-13' },
  ];
  // The operator, 2026-09-30, of the one-line-per-film list in the testing
  // group: "the response from bot is in messy format, message needs to be
  // neater paragraphed". So a bold header with the words typed, a block per
  // film, and the reply line apart, blank lines between.
  const want = '🔍 *Search results for "venom"*\n\n*1.* Venom (1981)\n\n*2.* Venom (2005)\n\n*3.* Venom (2011)\n\n'
    + '*4.* Venom (2018)\n\nReply with a number (1–4), or react with it, to get it. This list expires in 10 minutes.';
  ok(formatPickList(items, { prefix: '#request', minutes: 10, query: 'venom' }) === want,
    'the list reads exactly as the operator specified for beta001, paragraphed as they asked on 2026-09-30');
  const withPlots = formatPickList([{ ...items[3], plot: 'A reporter is bonded to an alien symbiote.' }, items[2]],
    { minutes: 10, query: 'venom' });
  ok(withPlots === '🔍 *Search results for "venom"*\n\n*1.* Venom (2018)\n_A reporter is bonded to an alien symbiote._\n\n'
    + '*2.* Venom (2011)\n\nReply with a number (1–2), or react with it, to get it. This list expires in 10 minutes.',
  `each film carries its plot in italics, and one OMDb had none for is listed without:\n${withPlots}`);
  ok(needYearNote('Venom', [1981, 2005, 2011, 2018], '#request') === '📅 Venom — we have 1981, 2005, 2011, 2018. Send #request Venom 2018',
    'the "add a year" note lists the years, with a line to copy (quick fix A)');
  ok(!/\(2018\)/.test(needYearNote('Venom', [2005, 2018], '#request')), 'and no longer labels the title with one film\'s year');
  ok(formatPickList(items, { prefix: '#request', minutes: 7, refused: [3], query: 'venom' }) === '🔍 *Search results for "venom"*\n\n'
    + '*1.* Venom (1981)\n\n*2.* Venom (2005)\n\n*3.* Venom (2011)\n\n~4. Venom (2018)~ — can\'t be sent\n\n'
    + 'Reply with a number (1–4), or react with it, to get it. This list expires in 7 minutes.',
  'a version turned down after a pick is struck through, and the rest stay open');
}

console.log('=== the pick list is laid out as paragraphs: a bold header, one numbered block per film with its plot in italics, and the reply line apart ===');
{
  // The operator, 2026-09-30, reading beta001's lists in the testing group:
  // "the response from bot is in messy format, message needs to be neater
  // paragraphed". This is the layout they were shown and agreed.
  const mi = [
    { title: 'Mission: Impossible', year: 1996, plot: 'An American agent, under false suspicion of disloyalty, must discover and expose the real spy.' },
    { title: 'Mission: Impossible II', year: 2000, plot: 'IMF agent Ethan Hunt is sent to Sydney to find and destroy a genetically modified disease.' },
    { title: 'Mission: Impossible - Ghost Protocol', year: 2011 },
  ];
  const body = formatPickList(mi, { minutes: 10, query: 'mission impossible' });
  ok(body === [
    '🔍 *Search results for "mission impossible"*',
    '*1.* Mission: Impossible (1996)\n_An American agent, under false suspicion of disloyalty, must discover and expose the real spy._',
    '*2.* Mission: Impossible II (2000)\n_IMF agent Ethan Hunt is sent to Sydney to find and destroy a genetically modified disease._',
    '*3.* Mission: Impossible - Ghost Protocol (2011)',
    'Reply with a number (1–3), or react with it, to get it. This list expires in 10 minutes.',
  ].join('\n\n'), `the header, a block per film, and the reply line, a blank line between each:\n${body}`);

  // OMDb's text goes between the italics markers, so its own markers must
  // not close them early or open a bold.
  const odd = formatPickList([{ title: 'Venom', year: 2018, plot: 'A *failed* reporter meets snake_case and ~tildes~_' },
    { title: 'Venom', year: 2011 }], { query: 'venom' });
  ok(odd.split('\n\n')[1] === '*1.* Venom (2018)\n_A failed reporter meets snake case and tildes_',
    `a plot's own * _ ~ are taken out, and nothing breaks the italics: ${odd.split('\n\n')[1]}`);
  ok(plainText('  _Mr_Robot_ ') === 'Mr Robot', 'an underscore joining two words becomes a space, and the ends are trimmed');

  // The header quotes the words typed, and only those.
  ok(formatPickList(mi, { query: 'mission *impossible*' }).startsWith('🔍 *Search results for "mission impossible"*\n\n'),
    'markers typed into the request cannot break the bold header');
  ok(formatPickList(mi).startsWith('🔍 *Search results*\n\n*1.*'), 'a list journalled before the words were kept has a plain header');

  // Every other shape of the list keeps its meaning in the new layout.
  const more = formatPickList(mi, { query: 'mission impossible', moreStartWith: 7 }).split('\n\n');
  ok(more.at(-2) === '7 other films start with that too — send its full name for one of those.',
    `the "others start with it too" line is a paragraph of its own: "${more.at(-2)}"`);
  const test = formatPickList(mi, { query: 'mission impossible', test: true, refused: [1] }).split('\n\n');
  ok(test.at(-1) === 'Reply with a number (1–3), or react with it, to test it. Nothing is downloaded. This list expires in 10 minutes.',
    'a test list says nothing is downloaded');
  ok(test[2] === "~2. Mission: Impossible II (2000)~ — can't be sent", `a refused film is struck through, without its plot: ${test[2]}`);

  // Nothing a member sends is read off the list's text, so the new
  // characters change no pick.
  const list = { items: mi, request: 'mission impossible', title: 'mission impossible' };
  ok(parsePick('3', list)?.index === 2 && parsePick('#request 3', list, '#request')?.index === 2
    && parsePick('4', list)?.invalid === true, 'a bare number and "#request 3" pick as before, and 4 is still a wrong number');
  ok(body.length < 1000, 'and it stays short');
}
{
  const items = [
    { title: 'Venom', year: 1981, rated: 'PG' }, { title: 'Venom', year: 2005, rated: 'PG-13' },
    { title: 'Venom', year: 2011, rated: 'PG' }, { title: 'Venom', year: 2018, rated: 'PG-13' },
  ];
  ok(formatPicked(2, items[1], { title: 'Venom', year: 2005 }) === '✔ 2 · Venom (2005) — on its way', 'the pick, queued');
  ok(formatPicked(3, items[2], { title: 'Venom', year: 2012 }) === '✔ 3 · Venom (2011) — on its way',
    'OMDb a year off the library is the same film - the list\'s words are kept');
  ok(formatPicked(3, items[2], { title: 'Venom', year: 2005 }) === '✔ Venom (2005) — on its way',
    'another version queued in its place is named, without the number');
  ok(formatPickFailed(1, items[0], 'blocked-rating') === "1 · Venom (1981) — can't be sent"
    && !/✔/.test(formatPickFailed(1, items[0], 'error')), 'a pick that was not queued gets no ✔');
  ok(formatExpired(items, { prefix: '#request', refused: [3] }) === 'expired — send #request Venom 2011',
    'an expired list never suggests a version it turned down');
}

/* ============ nothing to ask: exactly what origin/main does ============ */
// Captured by running these same messages through origin/main's plugin
// (scratch differential run, 2026-09-22), back when they were the flag-Off
// cases. The flag is gone (2026-10-11), and a title the server holds in
// several versions gets the list in every group now - Venom and Godzilla in
// the main group were here, and are the "2026-10-10" block below instead.
// What is left is everything the list has nothing to say about: a title
// held once, a request with a year, a refusal, a digit with no list open,
// and a message in the beta group with no test code. Those must not have
// changed at all. "ocean's 11 (2001)" is left out here (quick fix B).

console.log('=== where there is nothing to ask, every outbound action matches origin/main ===');
{
  const GOLDEN = {
    'Inception, main': ['#request Inception', MAIN_REQ, [['react', MAIN_REQ, '🔍', 'normal'], ['react', MAIN_REQ, '🎬', 'normal'],
      ['text', MAIN_NOTIFY, '🎬 Inception (2010) — added to the queue', 'critical']]],
    // A request in the beta group with no test code is ignored since
    // 2026-09-29 (beta.js readBetaTest): "if someone requests a regular
    // movie like captain Phillips it should be ignored because it's not the
    // beta" (the operator). Before, these got 🔍 📅.
    'Venom, beta group': ['#request Venom', TESTING, []],
    'Venom 2005': ['#request Venom 2005', MAIN_REQ, [['react', MAIN_REQ, '🔍', 'normal'], ['react', MAIN_REQ, '🎬', 'normal'],
      ['text', MAIN_NOTIFY, '🎬 Venom (2005) — added to the queue', 'critical']]],
    'John Wick': ['#request John Wick', MAIN_REQ, [['react', MAIN_REQ, '🔍', 'normal'],
      ['text', MAIN_NOTIFY, "⛔ John Wick (2014) — rated R, can't be posted", 'critical'], ['react', MAIN_REQ, '⛔', 'critical']]],
    'bare digit, main': ['2', MAIN_REQ, []],
    'bare digit, beta': ['2', TESTING, []],
    '#request 2, beta': ['#request 2', TESTING, []],
    '#request 21': ['#request 21', MAIN_REQ, [['react', MAIN_REQ, '🔍', 'normal'], ['react', MAIN_REQ, '🎬', 'normal'],
      ['text', MAIN_NOTIFY, '🎬 21 (2008) — added to the queue', 'critical']]],
    'not found': ['#request Zzzqx Nothing', MAIN_REQ, [['react', MAIN_REQ, '🔍', 'normal'],
      ['text', MAIN_NOTIFY, '❓ "Zzzqx Nothing" — couldn\'t find that title', 'critical'], ['react', MAIN_REQ, '❓', 'critical']]],
    'Dune, beta': ['#request Dune', TESTING, []],
    'Cinderella, beta': ['#request Cinderella', TESTING, []],
    'Hamlet, beta': ['#request Hamlet', TESTING, []],
  };
  for (const [name, [text, chat, want]] of Object.entries(GOLDEN)) {
    const h = harness(config());
    // Sent as typed: in the beta group that means with no test code.
    await moviePlugin.onMessage(mkMsg(text, chat), h.ctx);
    await settle();
    const got = h.out.map((e) => [e.op, e.jid, e.emoji ?? e.body, e.kind]);
    ok(JSON.stringify(got) === JSON.stringify(want), `${name}: identical to origin/main (${want.length} outbound)`);
    ok(!('pickLists' in h.store._data), `   and no list journal for "${text}"`);
  }
  // The operator, 2026-10-21: "if something gets denied it gets denied simple
  // reaction is enough" - the notifications group is for what is downloaded
  // and sent. With the defaults (notifyRefusals and announceRated off), a
  // refusal is its reaction and nothing else; the cases above turn both on.
  for (const [name, text, emoji] of [['John Wick', '#request John Wick', '⛔'], ['not found', '#request Zzzqx Nothing', '❓']]) {
    const c = config();
    c.movieRequests.notifyRefusals = false;
    c.movieRequests.announceRated = false;
    const h = harness(c);
    await moviePlugin.onMessage(mkMsg(text, MAIN_REQ), h.ctx);
    await settle();
    const got = h.out.map((e) => [e.op, e.jid, e.emoji ?? e.body]);
    ok(JSON.stringify(got) === JSON.stringify([['react', MAIN_REQ, '🔍'], ['react', MAIN_REQ, emoji]]),
      `${name}, by default: ${emoji} and no line in the notifications group (${JSON.stringify(got)})`);
  }
  ok(DEFAULT_CONFIG.movieRequests.notifyRefusals === false, 'refusal lines are off by default');
  {
    // Moderation and the cooldown, unchanged too.
    const h = harness(config({ movie: { enforcement: { enabled: true } } }));
    await send(h, '2', MAIN_REQ);
    ok(JSON.stringify(h.out.map((e) => e.op)) === '["delete"]', 'a bare digit with no list open is still deleted as chatter when moderation is on');
    const c = harness(config({ movie: { cooldownSecondsPerUser: 30 } }));
    await send(c, '#request Inception', MAIN_REQ);
    await send(c, '#request Dune 2021', MAIN_REQ);
    ok(c.out.at(-1).emoji === '🚫', 'and a second request inside the cooldown still gets 🚫');
  }
}

/* ============================ showing a list ============================ */

console.log('=== a bare title held in several sendable versions gets ONE list ===');
{
  const h = harness(config());
  clearPlotCache();
  const omdb = omdbCalls();
  const m = await send(h, '#request Venom', TESTING);
  const list = texts(h.out);
  ok(list.length === 1 && list[0].jid === TESTING, 'one text, in the beta group it was asked in');
  ok(list[0].quoted === m.id, 'as a quoted reply to the request');
  ok(list[0].kind === 'critical', "at 'critical' - the member is waiting for it");
  ok(list[0].body === listText('Venom', ['Venom (2005)', 'Venom (2011)', 'Venom (2018)']),
  `the R-rated 1981 Venom is not offered:\n${list[0].body}`);
  ok(h.out.length === 2 && h.out[0].emoji === '🔍', `🔍 then the list: 2 outbound in all (today's 📅 answer is 3)`);
  // beta001's plots are OMDb's, as the operator chose: one lookup per listed
  // film, made only once the list is certain to be posted. Deciding it still
  // costs nothing.
  ok(omdbCalls() - omdb === 3, `OMDb was asked only for the three listed films' plots (${omdbCalls() - omdb})`);
  ok(sentCount(h) === 0, 'nothing is queued yet');
  const r = row(h.store, m.id);
  ok(r?.status === 'pick-list' && r.pickList.offered.join() === '2005,2011,2018' && r.pickList.units === 1,
    'History shows the list, what it offered, and the one message it cost');
  ok(openLists(h.store).length === 1, 'the open list is journalled');
  ok(h.logs.some((l) => /pick list shown for "Venom".*1=2005 2=2011 3=2018 \(held: 1981, 2005, 2011, 2018\)/.test(l)),
    'the log says what was held and what was offered');
}

console.log('=== a test\'s list is never posted in a group that has since become a main one ===');
{
  // The library search can take a minute. If the beta group is promoted to a
  // main request group meanwhile, the test's list must not go out there: a
  // test never speaks in a main group (safeRoute). This is not the flag that
  // went on 2026-10-11, and it stays.
  const cfg = config();
  const h = harness(cfg);
  onLibrarySearch = () => { cfg.beta.groups = []; cfg.movieRequests.requestGroups = [MAIN_REQ, TESTING]; };
  await send(h, '#request Venom', TESTING);
  onLibrarySearch = null;
  ok(texts(h.out).length === 0, 'a beta group made main during the search gets no list (and nothing else said)');
  ok(!openLists(h.store).length, 'and no list is left open');
  ok(h.logs.some((l) => /pick list: not shown for "Venom" - .* has become a main group since this test was asked there/.test(l)),
    'the log says why');
}

console.log('=== beta001: a line of plot next to each film, from OMDb ===');
{
  // The operator's spec: a header, then each film with a line about it,
  // then "Reply with a number (1–N)". The line is OMDb's
  // short plot, as they chose, cut to its first sentence and about a line.
  ok(shortenPlot('An ex-hit-man comes out of retirement to track down the gangsters that killed his dog. It goes badly.')
    === 'An ex-hit-man comes out of retirement to track down the gangsters that killed his dog.', 'the first sentence');
  ok(shortenPlot('Dr. Strange loses the use of his hands, and goes looking for a cure.')
    === 'Dr. Strange loses the use of his hands, and goes looking for a cure.', 'not cut at an abbreviation');
  const long = shortenPlot(`${'word '.repeat(60)}end.`);
  ok(long.length <= 121 && long.endsWith('…') && !/\s…$/.test(long), `a long one is cut at a word, with an ellipsis (${long.length})`);
  ok(shortenPlot('N/A') === null && shortenPlot('') === null, "OMDb's N/A is no plot");

  const venom = omdbOf('Venom', 2018);
  venom.Plot = 'A failed reporter is bonded to an alien entity, one of many symbiotes who have invaded Earth. It goes on.';
  clearPlotCache();
  const plots = await listPlots([{ title: 'Venom', year: 2018 }, { title: 'Venom', year: 2011 }, { title: 'Not A Film', year: 2001 }],
    { apiKey: 'k' });
  ok(plots[0] === 'A failed reporter is bonded to an alien entity, one of many symbiotes who have invaded Earth.',
    `the film's own plot, shortened: "${plots[0]}"`);
  ok(plots[1] === null && plots[2] === null, 'a film OMDb has no plot for, or does not have, gets none');
  ok((await listPlots([{ title: 'Venom', year: 2018 }], { apiKey: '' }))[0] === null, 'no OMDb key: no plots, and no call');

  const calls = omdbCalls();
  await listPlots([{ title: 'Venom', year: 2018 }], { apiKey: 'k' });
  ok(omdbCalls() === calls, 'a plot already fetched is not fetched again');
  clearPlotCache();
  omdbDown = true;
  const down = await listPlots([{ title: 'Venom', year: 2018 }], { apiKey: 'k' });
  omdbDown = false;
  ok(down[0] === null, 'OMDb down: no plot, and nothing thrown');
  ok((await listPlots([{ title: 'Venom', year: 2018 }], { apiKey: 'k' }))[0]?.startsWith('A failed reporter'),
    'and an outage is not remembered as "no plot" - the next list asks again');

  const h = harness(config());
  clearPlotCache();
  await send(h, '#request Venom', TESTING);
  const body = texts(h.out).find((e) => LIST_HEAD.test(e.body))?.body ?? '';
  ok(body.split('\n\n')[3] === '*3.* Venom (2018)\n_A failed reporter is bonded to an alien entity, one of many symbiotes who have invaded Earth._'
    && body.split('\n\n')[1] === '*1.* Venom (2005)', `the posted list carries it, in italics under the film:\n${body}`);
  ok(openLists(h.store)[0]?.items[2]?.plot?.startsWith('A failed reporter'),
    'and it is kept on the journalled list, so an edit after a refused pick or a restart still shows it');
  delete venom.Plot;
  clearPlotCache();
}

console.log('=== which titles get a list ===');
{
  const cases = [
    // Before franchises were listed, Dune: Part Two was left off as "a sequel,
    // not a version". It starts with "Dune", so it is offered now.
    ['Dune', '1984,2021,2024', 'Dune: Part Two starts with "Dune" and is offered too'],
    // Twelve start with it, and a list now runs to 20, so all are offered in
    // release order. The five called exactly Cinderella alone are what a list
    // past the limit falls back to (see "[franchise] too many" below).
    ['Cinderella', '1950,1965,1973,1997,2002,2004,2005,2007,2015,2018,2019,2021', 'all twelve that start with it'],
    ['A Christmas Carol', '1938,1984,1999,2009', ''],
    ['Godzilla', '1954,1998,2014', 'Not Rated is offered while unrated films are allowed'],
    ['Cosmos', '1980,2019', 'the series of the same name is left out'],
  ];
  for (const [title, years, why] of cases) {
    const h = harness(config());
    const m = await send(h, `#request ${title}`, TESTING);
    const offered = row(h.store, m.id)?.pickList?.offered?.join();
    ok(offered === years && texts(h.out).length === 1, `${title} -> list of ${years}${why ? ` (${why})` : ''}`);
  }
}
{
  // Six was past the old limit of five; a list now offers up to twenty.
  const h = harness(config());
  clearPlotCache();
  const omdb = omdbCalls();
  const m = await send(h, '#request Hamlet', TESTING);
  ok(row(h.store, m.id)?.pickList?.offered.join() === '1948,1964,1969,1990,1996,2000' && texts(h.out).length === 1,
    'Hamlet (6 sendable versions) gets a list of all six');
  ok(omdbCalls() - omdb === 6, `deciding it spent no OMDb quota; the six calls are its plots (${omdbCalls() - omdb})`);
}
{
  // An operator who sets the limit below that is still obeyed, and the
  // request is answered where it was asked, as a list would have been, not
  // with the notifications-group line most requesters never saw.
  const h = harness(config({ movie: { pickList: { maxOptions: 4 } } }));
  const omdb = omdbCalls();
  const m = await send(h, '#request Hamlet', TESTING);
  ok(!texts(h.out).some((e) => LIST_HEAD.test(e.body)) && row(h.store, m.id)?.status === 'need-year'
    && h.out.at(-1).emoji === '📅', 'with maxOptions 4, Hamlet gets no list, and 📅');
  ok(texts(h.out).length === 1 && texts(h.out)[0].quoted === m.id
    && texts(h.out)[0].body === '6 films start with "Hamlet" — add a word or the year, e.g. $beta004 #request Hamlet 2000',
  `but one quoted reply that can be answered: "${texts(h.out)[0]?.body}"`);
  ok(omdbCalls() === omdb, 'and without spending OMDb quota on it');
}
{
  const h = harness(config());
  const m = await send(h, '#request Frozen', TESTING);
  ok(!texts(h.out).some((e) => LIST_HEAD.test(e.body)) && sent(h) === 'Frozen (2013)',
    'Frozen (the 2010 one is R): one sendable version, so it is simply sent');
  const fr = row(h.store, m.id);
  ok(fr?.request === 'Frozen 2013' && fr.typed === 'Frozen',
    'the History row keeps what was typed, and what was looked up (Re-run sends that)');
}
{
  const h = harness(config());
  await send(h, '#request Inception', TESTING);
  // A test answers where a real request is queued: ✅ and "Test passed"
  // instead of 🎬 and "added to the queue" (2026-09-29).
  ok(sent(h) === 'Inception (2010)' && JSON.stringify(h.out.map((e) => e.emoji ?? 'text')) === '["🔍","✅","text"]'
    && /^✅ \*Test passed\* \(\$beta004\)\n\nThe bot would send \*Inception\* \(2010\)/.test(texts(h.out)[0]?.body),
    'a title held once passes as a request would be sent, with no list');
}
{
  const h = harness(config());
  await send(h, '#request John Wick', TESTING);
  ok(!texts(h.out).some((e) => LIST_HEAD.test(e.body)) && h.out.at(-1).emoji === '⛔',
    'John Wick (every version R or TV-MA): no list, the refusal it always got');
}
{
  const h = harness(config());
  await send(h, '#request Dune 2021', TESTING);
  ok(!texts(h.out).some((e) => LIST_HEAD.test(e.body)) && sent(h) === 'Dune (2021)', 'a request WITH a year never gets a list');
}
{
  const h = harness(config({ movie: { requireYearWhenAmbiguous: false } }));
  await send(h, '#request Venom', TESTING);
  ok(!texts(h.out).some((e) => LIST_HEAD.test(e.body)), 'nor does anything when the operator has turned the year question off');
}

/* ============================ Beta: answering it ============================ */

async function withList(opts = {}, title = 'Venom') {
  const h = harness(config(opts));
  const req = await send(h, `#request ${title}`, TESTING);
  return { ...h, req, mark: h.out.length };
}

console.log('=== a digit runs the normal pipeline on the ORIGINAL request ===');
{
  const h = await withList();
  const digit = await send(h, '2', TESTING);
  const after = since(h.out, h.mark);
  ok(sentCount(h) === 1 && sent(h) === 'Venom (2011)' && h.jobs.length === 0,
    'the 2nd version passes - Venom (2011) - and, a test, nothing is queued');
  ok(after.filter((e) => e.op === 'react').every((e) => e.on === h.req.id), 'every reaction lands on the original request');
  ok(!after.some((e) => e.on === digit.id), 'the digit itself gets nothing');
  ok(!after.some((e) => e.emoji === '🔍'), 'and 🔍 is not sent again - the request is already showing it');
  const edit = after.filter((e) => e.op === 'edit');
  ok(edit.length === 1 && edit[0].body === '✔ 2 · Venom (2011) — test passed, nothing sent' && edit[0].kind === 'low' && edit[0].key === 'BOT1',
    `the list is edited, at 'low': "${edit[0]?.body}"`);
  ok(!after.some((e) => e.op === 'delete'), 'nothing is ever deleted');
  const r = row(h.store, h.req.id);
  ok(r.status === 'test-passed' && r.year === 2011 && r.typed === 'Venom' && r.request === 'Venom 2011' && r.test === 'beta004',
    'History: test-passed, the 2011 film, "Venom" as typed and "Venom 2011" as looked up');
  ok(r.pickList.outcome === 'picked' && r.pickList.picked === 2 && r.pickList.form === 'digit' && Number.isFinite(r.pickList.pickMs),
    'with the pick recorded: which number, how, and how long it took');
  ok(r.pickList.units === 2, 'and the two messages the list cost in all (the list, the edit)');
  ok(!(h.store.get('pending') ?? []).length, 'nothing is journalled to be downloaded');

  // Units: the pick costs exactly what "#request Venom 2011" would, minus the
  // 🔍 already on the request, plus the low-priority edit.
  const plain = harness(config());
  await send(plain, '#request Venom 2011', TESTING);
  const shape = (xs) => xs.filter((e) => e.op !== 'edit').map((e) => `${e.op}:${e.emoji ?? e.body}:${e.kind}`).join('|');
  ok(shape(after) === shape(plain.out.slice(1)), `a pick = the ordinary request's outbound minus 🔍 (${after.length - 1}) + 1 low edit`);

  ok(!h.out.some((e) => e.op === 'document'), 'nothing is delivered: a test sends nothing');
  ok(after.some((e) => e.on === h.req.id && e.emoji === '✅'), '✅ on the original request');
  ok(texts(after).some((e) => e.quoted === h.req.id && /^✅ \*Test passed\* \(\$beta004\)\n\nThe bot would send \*Venom\* \(2011\)/.test(e.body)),
    'and "Test passed", quoting it');
  ok(!h.out.some((e) => MAIN.includes(e.jid)), 'no main group heard any of it');
}
{
  const h = await withList();
  await send(h, '#request 3', TESTING);
  ok(sent(h) === 'Venom (2018)' && row(h.store, h.req.id).pickList.form === 'prefixed', '"#request 3" picks the 3rd');
}
{
  const h = await withList();
  await send(h, '#request Venom 2005', TESTING);
  ok(sent(h) === 'Venom (2005)' && row(h.store, h.req.id).pickList.form === 'title-year',
    'the list\'s own suggestion, typed back, is that pick');
}

console.log('=== the answer is only ever the requester\'s ===');
{
  const h = await withList();
  await send(h, '2', TESTING, BOB);
  ok(h.out.length === h.mark && sentCount(h) === 0, 'someone else\'s digit: ignored, 0 outbound');
  ok(openLists(h.store).length === 1, 'and the list stays open for its owner');
  await send(h, '2', MAIN_REQ);
  ok(h.out.length === h.mark && sentCount(h) === 0, 'the owner\'s digit in ANOTHER group is not an answer either');
  await send(h, '1', TESTING, { sender: '15550000001@s.whatsapp.net', number: '15550000001' });
  ok(sent(h) === 'Venom (2005)', 'the owner seen under their phone JID instead of their LID still counts');
}

console.log('=== films called 9 and 21, and wrong numbers ===');
{
  const h = await withList();
  await send(h, '#request 9', TESTING);
  ok(h.out.length === h.mark && openLists(h.store).length === 1,
    '"#request 9" off a 3-item list is a title request - here too short to look up, as today - and the list stays open');
  // With its code: a number off the list is a new request, and a request
  // in the beta group counts only with one (2026-09-29).
  await send(h, '$beta004 #request 21', TESTING);
  ok(sent(h) === '21 (2008)', '"$beta004 #request 21" is the film 21');
  ok(openLists(h.store).length === 1, 'and the list is still open');
}
{
  const h = await withList();
  const seven = await send(h, '7', TESTING);
  const after = since(h.out, h.mark);
  ok(after.length === 1 && after[0].op === 'react' && after[0].on === seven.id && after[0].emoji === '❓',
    'a 7 on a 3-item list gets one ❓, on the 7');
  ok(openLists(h.store).length === 1 && row(h.store, h.req.id).pickList.invalid === 1, 'the list stays open; History counts it');
  await send(h, '0', TESTING);
  await send(h, '8', TESTING);
  await send(h, '9', TESTING);
  ok(since(h.out, h.mark).length === 3, 'after three wrong numbers the bot stops reacting to them');
  ok(row(h.store, h.req.id).pickList.invalid === 4, 'but still counts them');
  await send(h, '1', TESTING);
  ok(sent(h) === 'Venom (2005)', 'and a right number still works');
}

console.log('=== first pick wins ===');
{
  const h = await withList();
  await Promise.all([
    moviePlugin.onMessage(mkMsg('2', TESTING), h.ctx),
    moviePlugin.onMessage(mkMsg('3', TESTING), h.ctx),
  ]);
  await settle();
  ok(sentCount(h) === 1 && sent(h) === 'Venom (2011)', 'two digits at once: only the first is taken');
  ok(since(h.out, h.mark).filter((e) => e.op === 'edit').length === 1, 'and the list is edited once');
  const n = h.out.length;
  await send(h, '1', TESTING);
  ok(h.out.length === n && sentCount(h) === 1, 'a later digit from the owner is ignored: 0 outbound');
}

console.log('=== a pick is neither throttled nor moderated ===');
{
  const h = await withList({ movie: { cooldownSecondsPerUser: 30 } });
  await send(h, '2', TESTING);
  ok(!h.out.some((e) => e.emoji === '🚫') && sentCount(h) === 1, 'the pick goes through inside the 30 s cooldown');
}
{
  const h = await withList({ movie: { enforcement: { enabled: true } } });
  await send(h, '2', TESTING);
  ok(!h.out.some((e) => e.op === 'delete') && sentCount(h) === 1, 'moderation does not delete the owner\'s digit');
  const n = h.out.length;
  await send(h, '2', TESTING, BOB);
  // Chatter in the beta group is ignored rather than moderated since tests
  // need a code (2026-09-29): moderation starts at the code.
  ok(h.out.length === n, 'once the list is answered, someone else\'s digit is a message with no code: ignored');
}

console.log('=== one list per member, and a cap per group ===');
{
  const h = await withList();
  const dune = await send(h, '#request Dune', TESTING);
  const after = since(h.out, h.mark);
  ok(texts(after).length === 1 && /Dune \(1984\)/.test(texts(after)[0].body), 'a newer bare title gets its own list');
  const edit = after.find((e) => e.op === 'edit');
  ok(edit?.key === 'BOT1' && edit.body === 'replaced — see the newer list' && edit.kind === 'low', 'the old list is edited to say so, at low');
  ok(row(h.store, h.req.id).status === 'pick-replaced', 'History records the old one as replaced');
  ok(openLists(h.store).length === 1 && openLists(h.store)[0].id === dune.id, 'only the newer list is open');
  await send(h, '2', TESTING);
  ok(sent(h) === 'Dune (2021)', 'and a digit answers the newer one');
}
{
  const h = await withList({ movie: { pickList: { maxOpenPerGroup: 1 } } });
  const m = await send(h, '#request Dune', TESTING, BOB);
  ok(!texts(since(h.out, h.mark)).some((e) => LIST_HEAD.test(e.body)) && row(h.store, m.id).status === 'need-year',
    'a group already at its cap of open lists gets the "add a year" answer instead');
}

console.log('=== expiry ===');
{
  const h = await withList();
  await moviePlugin._expirePickList(h.ctx, h.req.id);
  const after = since(h.out, h.mark);
  ok(!texts(after).length, 'no new message');
  ok(after[0]?.op === 'react' && after[0].on === h.req.id && after[0].emoji === '📅' && after[0].kind === 'normal',
    'one final 📅 on the original request');
  ok(after[1]?.op === 'edit' && after[1].body === 'expired — send $beta004 #request Venom 2018' && after[1].kind === 'low',
    `and the list edited, at low: "${after[1]?.body}"`);
  const r = row(h.store, h.req.id);
  ok(r.status === 'pick-expired' && /no pick within 10 min \(offered 2005, 2011, 2018\)/.test(r.detail), `History: ${r.status} - ${r.detail}`);
  ok(!openLists(h.store).length, 'the list is closed');
  const n = h.out.length;
  await send(h, '2', TESTING);
  ok(h.out.length === n && !sentCount(h), 'a digit after expiry is an ordinary message again');
}
{
  // The real timer, with a very short expiry.
  const h = harness(config({ movie: { pickList: { expiryMinutes: 0.01 } } }));
  const m = await send(h, '#request Venom', TESTING);
  ok(/This list expires in 1 second\./.test(texts(h.out)[0]?.body ?? ''), 'the list says when it expires');
  await new Promise((r) => setTimeout(r, 900));
  ok(row(h.store, m.id)?.status === 'pick-expired' && h.out.some((e) => e.emoji === '📅'), 'the timer closes the list by itself');
}

console.log('=== a restart with lists open ===');
{
  const store = fakeStore();
  const before = harness(config(), store);
  const young = await send(before, '#request Venom', TESTING);
  const old1 = await send(before, '#request Dune', TESTING, BOB);
  const old2 = await send(before, '#request Godzilla', TESTING, { sender: 'carol@lid', number: '15550000003' });
  moviePlugin.teardown();                             // --- the process dies here ---
  const lists = store.get('pickLists');
  for (const l of lists) {
    if (l.id === old1.id) { l.shownAt -= 12 * 60_000; l.expiresAt -= 12 * 60_000; }
    if (l.id === old2.id) { l.shownAt -= 40 * 60_000; l.expiresAt -= 40 * 60_000; }
  }

  const after = harness(config(), store);
  await moviePlugin.recoverPickLists(after.ctx);
  await settle();
  ok(row(store, old1.id).status === 'pick-expired' && row(store, old2.id).status === 'pick-expired',
    'lists that ran out while the bot was down are expired');
  const r1 = after.out.filter((e) => e.on === old1.id);
  ok(r1.length === 1 && r1[0].emoji === '📅' && r1[0].kind === 'normal', 'each gets its final 📅, at normal');
  ok(after.out.filter((e) => e.op === 'edit').length === 1,
    'the 12-minute-old list is edited; the 40-minute-old one is past WhatsApp\'s edit window and left alone');
  ok(after.ctx.bot.paced === 1, 'the two are paced apart with _bulkPace (rule 1)');
  ok(openLists(store).length === 1 && openLists(store)[0].id === young.id, 'the young list is still open');
  ok(moviePlugin._pickTimers.has(young.id), 'and re-armed with the time it has left');

  const n = after.out.length;
  await moviePlugin.onMessage(mkMsg('3', TESTING), after.ctx);
  await settle();
  ok(sent(after) === 'Venom (2018)', 'a digit after the restart still picks');
  ok(since(after.out, n).filter((e) => e.op === 'react').every((e) => e.on === young.id),
    'and its reactions land on the original request, rebuilt from the journal');
  moviePlugin.teardown();
}
ok(EDIT_WINDOW_MS === 15 * 60_000, 'edits are skipped past WhatsApp\'s 15-minute window');

console.log('=== no kill switch: a list already open is answered whatever config.json says ===');
{
  // Off used to stop lists already in the journal. The flag left on
  // 2026-10-11, and a config.json restored from before can still hold its
  // Off: that must not leave a member's open list deaf to their number.
  const h = await withList();
  h.ctx.config.beta.features['movie-pick-list'] = 'off';
  await send(h, '2', TESTING);
  ok(sent(h) === 'Venom (2011)', 'a stale Off in config.json: the digit is still the pick');
}
{
  // A beta group promoted to a main request group while its list is open.
  const h = await withList();
  h.ctx.config.beta.groups = [];
  h.ctx.config.movieRequests.requestGroups = [MAIN_REQ, TESTING];
  await moviePlugin._expirePickList(h.ctx, h.req.id);
  ok(h.out.length === h.mark && row(h.store, h.req.id).status === 'pick-expired',
    'a beta list whose group became a main group says nothing more there, and closes in History');
}

console.log('=== the main groups too, with no beta flag ===');
{
  const h = harness(config());
  const m = await send(h, '#request Venom', MAIN_REQ);
  const list = texts(h.out);
  ok(list.length === 1 && list[0].jid === MAIN_REQ && list[0].quoted === m.id, 'the list is a quoted reply in the main request group');
  ok(list[0].body === listText('Venom', ['Venom (2005)', 'Venom (2011)', 'Venom (2018)'], { test: false }),
    `and says a number gets the film:\n${list[0].body}`);
  await send(h, '1', MAIN_REQ);
  ok(sent(h) === 'Venom (2005)' && h.out.some((e) => e.op === 'edit' && e.jid === MAIN_REQ), 'and answered there');
  ok(!('beta' in row(h.store, m.id)), 'the request is a main one, not marked beta');
}
{
  // The operator's own switch for the question still decides whether it is
  // asked at all, in the main groups as in the beta one.
  const h = harness(config({ movie: { requireYearWhenAmbiguous: false } }));
  await send(h, '#request Venom', MAIN_REQ);
  ok(!texts(h.out).some((e) => LIST_HEAD.test(e.body)) && !('pickLists' in h.store._data),
    'with "ask which one" turned off, a main group gets no list either');
}

/* ============================ the quick fixes ============================ */

// Step 0's library search fails, and the next one does not: the request goes
// on without a list, as it does when Jellyfin times out on that search, and
// meets the year question at 4a, which is where the notifications-group
// note and the "Which year?" reply are still said.
const failStep0Search = () => {
  let first = true;
  onLibrarySearch = () => {
    if (!first) return;
    first = false;
    throw new Error('Jellyfin did not answer in time');
  };
};

console.log('=== quick fix A: the "add a year" note, where a list could not be shown ===');
{
  const h = harness(config());
  failStep0Search();
  await send(h, '#request Venom', MAIN_REQ);
  onLibrarySearch = null;
  ok(h.logs.some((l) => /pick list: could not search the library for "Venom"/.test(l)), 'step 0 could not search (the log says so)');
  ok(texts(h.out)[0]?.body === '📅 Venom — we have 2005, 2011, 2018. Send #request Venom 2018',
    `the note lists only the sendable years, with a line to send: "${texts(h.out)[0]?.body}"`);
  const d = harness(config());
  failStep0Search();
  await send(d, '#request Dune', MAIN_REQ);
  onLibrarySearch = null;
  ok(texts(d.out)[0]?.body === '📅 Dune — we have 1984, 2021. Send #request Dune 2021', `"${texts(d.out)[0]?.body}"`);
  const n = harness(config({ movie: { requirePrefix: false } }));
  failStep0Search();
  await send(n, 'Venom', MAIN_REQ);
  onLibrarySearch = null;
  ok(texts(n.out)[0]?.body === '📅 Venom — we have 2005, 2011, 2018. Send Venom 2018', 'with no prefix required, none is suggested');
}

console.log('=== quick fix B: a request with a year is never asked for one ===');
{
  // The exact text from the log, 2026-09-22 06:34:22.
  const h = harness(config());
  const m = await send(h, "#request ocean's 11 (2001)", MAIN_REQ);
  ok(!h.out.some((e) => e.emoji === '📅'), `"ocean's 11 (2001)" is not bounced with 📅`);
  ok(sent(h) === "Ocean's Eleven (2001)", 'it is found within its year and queued: Ocean\'s Eleven (2001)');
  ok(row(h.store, m.id).status === 'queued', 'History: queued');
  ok(!h.jobs.some((j) => /1960/.test(j.label)), 'and not "Ocean\'s 11" (1960), which wins on the title alone');
}
{
  const h = harness(config());
  const m = await send(h, "#request ocean's 11 (1999)", MAIN_REQ);
  ok(!h.out.some((e) => e.emoji === '📅') && h.out.at(-1).emoji === '❓' && row(h.store, m.id).status === 'not-found',
    'nothing in that year either: "not found", never "add a year" to a request that has one');
}
{
  const h = harness(config());
  await send(h, '#request 11', MAIN_REQ);
  ok(h.out.at(-1).emoji === '📅', 'with NO year, "too many results" still asks for one, as before');
  // Review: this was the one "add a year" line quick fix A left alone, and it
  // still gave "(e.g. Dune 2021)" - a different film - as its example.
  ok(texts(h.out)[0]?.body === '📅 "11" — too many films by that name; send it again with the year',
    `in words that do not name some other film: "${texts(h.out)[0]?.body}"`);
}

/* ============================ the operator's numbers ============================ */

console.log('=== counters for the operator ===');
{
  const now = Date.now();
  const rows = [
    { at: now, beta: true, status: 'queued', pickList: { shownAt: now - 5000, outcome: 'picked', pickMs: 20_000, invalid: 1, units: 3 } },
    { at: now, beta: true, status: 'sent', pickList: { shownAt: now - 4000, outcome: 'picked', pickMs: 40_000, invalid: 0, units: 2 } },
    { at: now, beta: true, status: 'pick-expired', pickList: { shownAt: now - 3000, outcome: 'expired', invalid: 0, units: 3 } },
    { at: now, status: 'sent' },
  ];
  const s = summarisePickLists(rows);
  ok(s.shown === 3 && s.picked === 2 && s.expired === 1 && s.invalid === 1 && s.units === 8, 'shown, picked, expired, wrong numbers, outbound');
  ok(s.medianPickSec === 30, 'median time to pick');
  const body = buildDigest({ now, history: rows });
  ok(/Pick lists\s+: 3 shown, 2 picked, 1 expired, 1 wrong number, median 30s to pick \(8 outbound/.test(body),
    'the daily digest has a line for it');
  ok(!/Pick lists/.test(buildDigest({ now, history: [{ at: now, status: 'sent' }] })), 'and none when no list was shown');
}

console.log('=== the list is edited through the gate, at low priority ===');
{
  const mk = (budget) => {
    const b = new WhatsAppBot({ configStore: { get: () => ({ whatsapp: { budget } }) }, dataDir: TMP });
    b.state = 'connected';
    b.sent = [];
    b.sock = { sendMessage: async (jid, content) => { b.sent.push({ jid, content }); return {}; } };
    return b;
  };
  const b = mk({ perHour: 1000, perDay: 8000 });
  const key = { remoteJid: TESTING, fromMe: true, id: 'BOT1' };
  ok(await b.editText(TESTING, key, '✔ 2 · Venom (2005) — on its way') === true, 'an edit goes out');
  ok(b.sent[0]?.content.edit === key && b.sent[0].content.text === '✔ 2 · Venom (2005) — on its way',
    'as a Baileys edit of the list\'s own key');
  const full = mk({ perHour: 10, perDay: 8000 });
  for (let i = 0; i < 20; i += 1) full.budget.record();
  ok(await full.editText(TESTING, key, 'x') === false && full.sent.length === 0,
    'and is the first thing dropped when the hour\'s budget is spent');
  let threw = null;
  try { await b.editText(TESTING, null, 'x'); } catch (e) { threw = e; }
  ok(/no message key/.test(threw?.message ?? ''), 'an edit with nothing to edit is refused, not sent');
}

/* ============================ review fixes ============================ */
// Each block below pins a finding from the review of this branch
// (2026-09-22), reproduced first against the real plugin and then fixed.

console.log('=== [review] a missing file falls back only to another copy of the SAME film ===');
{
  // Pre-existing, but the pick list sends remakes straight down this path:
  // the download fallback took any same-titled item as a spare copy, so a
  // picked Venom 2011 (PG) whose file was gone was replaced by the R-rated
  // 1981 Venom and posted under the 2011 name.
  const [a, b] = [libItem('Total Recall', 2012, 0), libItem('Total Recall', 2012, 1)];
  const r90 = libItem('Total Recall', 1990);
  GONE.add(a.Id);
  const h = harness(config());
  await send(h, '#request Total Recall 2012', MAIN_REQ);
  downloads.length = 0;
  await h.jobs[0].run(fakeJob());
  await settle();
  ok(downloads.join() === `${a.Id},${b.Id}`, 'a gone file falls back to the other copy of the 2012 film');
  ok(h.out.some((e) => e.op === 'document' && e.file === 'Total Recall (2012).mp4'), 'which is posted');
  GONE.add(b.Id);
  const h2 = harness(config());
  await send(h2, '#request Total Recall 2012', MAIN_REQ);
  downloads.length = 0;
  let err = null;
  try { await h2.jobs[0].run(fakeJob()); } catch (e) { err = e; }
  await settle();
  ok(downloads.length === 2 && !downloads.includes(r90.Id),
    'with both 2012 files gone, the R-rated 1990 remake is never downloaded in their place');
  ok(!h2.out.some((e) => e.op === 'document') && /HTTP 404/.test(err?.message ?? ''), 'nothing is posted; the job fails on the 404');
  GONE.clear();
}

console.log('=== [review] a version with no library rating is never offered ===');
{
  const h = harness(config());
  const m = await send(h, '#request Scarface', TESTING);
  ok(!texts(h.out).some((e) => LIST_HEAD.test(e.body)), 'Scarface, unrated in Jellyfin (OMDb: R): no list');
  ok(h.out.at(-1).emoji === '⛔' && row(h.store, m.id).status === 'blocked-rating', 'but the refusal it always got');
}
{
  const h = harness(config());
  const m = await send(h, '#request Hairspray', MAIN_REQ);
  ok(row(h.store, m.id)?.pickList?.offered.join() === '1988,2007',
    'in a main group, the list leaves out the 2016 copy with no rating');
  const n = harness(config());
  failStep0Search();
  await send(n, '#request Hairspray', MAIN_REQ);
  onLibrarySearch = null;
  ok(texts(n.out)[0]?.body === '📅 Hairspray — we have 1988, 2007. Send #request Hairspray 2007',
    `and so does the "add a year" note, where a list could not be shown: "${texts(n.out)[0]?.body}"`);
}
{
  const id = libItem('Venom', 1981).Id;
  const store = fakeStore({ 'rating-overrides': [{ key: `jf:${id}`, jellyfinId: id, title: null, year: null }] });
  const h = harness(config(), store);
  const m = await send(h, '#request Venom', TESTING);
  ok(row(store, m.id)?.pickList?.offered.join() === '1981,2005,2011,2018',
    'an override by Jellyfin link puts the R-rated 1981 Venom on the list');
  const mark = h.out.length;
  await send(h, '1', TESTING);
  ok(sent(h) === 'Venom (1981)' && since(h.out, mark).some((e) => e.op === 'react' && e.emoji === '✅'),
    `and picking it passes, the link honoured by the request's own gate (${sent(h)})`);
}

console.log('=== [review] the replyOnBlock reply to "which year?" is worded as it always was ===');
{
  // It was left alone because changing group-facing text belonged behind the
  // flag. The flag is gone, and the reply is still only said where step 0
  // could not show a list - in the words a list that cannot be shown uses
  // for remakes (askForYear).
  const h = harness(config({ movie: { replyOnBlock: true } }));
  failStep0Search();
  await send(h, '#request Frozen', MAIN_REQ);
  onLibrarySearch = null;
  const reply = texts(h.out).find((e) => e.jid === MAIN_REQ);
  ok(reply?.body === 'There is more than one "Frozen" on the server (2010, 2013). Which year?',
    `the request-group reply reads exactly as on origin/main: "${reply?.body}"`);
  ok(texts(h.out).some((e) => e.jid === MAIN_NOTIFY && e.body === '📅 Frozen — we have 2013. Send #request Frozen 2013'),
    'only the notifications-group line changed');
  // With step 0 working, Frozen 2010 is R and 2013 is the one film that can
  // be sent: there is nothing to ask, and it is queued by title and year.
  const s = harness(config({ movie: { replyOnBlock: true } }));
  await send(s, '#request Frozen', MAIN_REQ);
  ok(sent(s) === 'Frozen (2013)' && !texts(s.out).some((e) => e.jid === MAIN_REQ), 'and where step 0 can see the library, nothing is asked');
}

console.log('=== [review] a Re-run of a picked row asks for the version that was picked ===');
{
  const h = await withList();
  await send(h, '2', TESTING);
  const r = row(h.store, h.req.id);
  const again = await moviePlugin.requeue(r.request, h.ctx);
  ok(again.year === 2011 && h.jobs.at(-1).label === 'Venom (2011)',
    `Re-run sends "${r.request}", and queues Venom (2011) - not whichever Venom OMDb returns first`);
}

console.log('=== a full queue refuses a hand-queued film BEFORE writing anything; an admin add goes past it ===');
{
  // requeue() journalled the job and put it in History as "queued", and only
  // then did queue.add refuse it as full: a History row for a film that never
  // ran, and a journal entry the next restart would have queued after all.
  const h = harness(config());
  const addOpts = [];
  h.ctx.queue.add = (j, o) => { h.jobs.push(j); addOpts.push(o); return `job-${h.jobs.length}`; };
  h.ctx.queue.hasRoom = () => false;
  h.ctx.queue.fullError = () => Object.assign(new Error('Queue is full (50 waiting)'), { code: 'QUEUE_FULL' });
  const journal = JSON.stringify(h.store.get('pending', []));
  const history = JSON.stringify(h.store.get('history', []));
  let err = null;
  try { await moviePlugin.requeue('Venom 2018', h.ctx); } catch (e) { err = e; }
  ok(err?.code === 'QUEUE_FULL' && sentCount(h) === 0, `refused as full (${err?.message})`);
  ok(JSON.stringify(h.store.get('pending', [])) === journal, 'with nothing journalled for a restart to queue later');
  ok(JSON.stringify(h.store.get('history', [])) === history, 'and no History row claiming it was queued');
  const r = await moviePlugin.requeue('Venom 2018', h.ctx, { overLimit: true });
  ok(r.year === 2018 && sentCount(h) === 1 && addOpts[0]?.overLimit === true, 'an admin\'s own add goes in past the limit');
  let nf = null;
  try { await moviePlugin.requeue('Not A Film At All', h.ctx, { overLimit: true }); } catch (e) { nf = e; }
  ok(nf?.code === 'NO_MATCH', `"not a film we can find" is coded, so the panel may try TV (${nf?.code})`);
}

console.log('=== [review] a pick interrupted by a restart is finished, once ===');
{
  const h = await withList();
  let release;
  libraryHold = new Promise((r) => { release = r; });
  const pending = moviePlugin.onMessage(mkMsg('2', TESTING), h.ctx);
  await settle();
  const mid = row(h.store, h.req.id);
  ok(mid.status === 'checking' && mid.pickList.outcome === 'picked',
    'while the pick is being looked up, History already has it as picked - not as an open list');
  const snap = JSON.parse(JSON.stringify(h.store._data));        // --- the process dies here ---
  libraryHold = null;
  release();
  await pending;
  await settle();
  moviePlugin.teardown();

  const store = fakeStore(snap);
  const after = harness(config(), store);
  moviePlugin.reconcileHistory(after.ctx);
  ok(row(store, h.req.id).status === 'lost', 'on start, reconcileHistory marks the half-done row lost');
  await moviePlugin.recoverPickLists(after.ctx);
  await settle();
  ok(sentCount(after) === 1 && sent(after) === 'Venom (2011)', 'and recovery runs the pick again: Venom (2011) queued');
  const r = row(store, h.req.id);
  ok(r.status === 'test-passed' && r.pickList.picked === 2 && r.pickList.resumed === true, 'History: test-passed, marked as resumed');
  ok(after.out.filter((e) => e.op === 'react').every((e) => e.on === h.req.id) && after.out.some((e) => e.emoji === '✅'),
    'its reactions land on the original request');
  ok(summarisePickLists(store.get('history')).open === 0, 'and the digest no longer counts it as an open list');
  moviePlugin.teardown();
}
{
  // Reached the queue before the restart: the job journal has it.
  const h = await withList();
  await send(h, '2', TESTING);
  const store = fakeStore(JSON.parse(JSON.stringify(h.store._data)));
  store.get('pickLists')[0].state = 'picked';            // the settle was cut short
  moviePlugin.teardown();
  const after = harness(config(), store);
  await moviePlugin.recoverPickLists(after.ctx);
  ok(after.jobs.length === 0 && after.out.length === 0 && store.get('pickLists')[0].state === 'answered',
    'a pick that had already passed is not run twice');
}
{
  // Resumed once and interrupted again: given up, not replayed on every boot.
  const h = await withList();
  const store = h.store;
  const [l] = store.get('pickLists');
  store.set('pickLists', [{ ...l, state: 'picked', pickedAt: Date.now(), pickedIndex: 1, pickForm: 'digit', resumes: 1 }]);
  moviePlugin.upsertHistory(h.ctx, { ...row(store, h.req.id), status: 'checking' });
  moviePlugin.teardown();
  const after = harness(config(), store);
  moviePlugin.reconcileHistory(after.ctx);
  await moviePlugin.recoverPickLists(after.ctx);
  ok(after.jobs.length === 0 && row(store, h.req.id).status === 'lost', 'interrupted twice: given up, and History says lost');
  ok(after.out.length === 1 && after.out[0].emoji === '⚠️' && after.out[0].on === h.req.id,
    'with ⚠️ on the request, so the member is not left looking at 🔍');
}

console.log('=== [review] a listed version OMDb files a year off is still found ===');
{
  const h = await withList({}, 'Solaris');
  await send(h, '2', TESTING);
  ok(sent(h) === 'Solaris (2003)', 'listed as Solaris (2002) from Jellyfin, filed by OMDb as 2003: picked and queued');
  ok(!h.out.some((e) => e.emoji === '❓'), 'not ❓ "couldn\'t find that title" for a film the bot has just offered');
  ok(since(h.out, h.mark).find((e) => e.op === 'edit')?.body === '✔ 2 · Solaris (2002) — test passed, nothing sent', 'the edit keeps the list\'s words');
  ok(h.logs.some((l) => /library's year is one off/.test(l)), 'and the log says why');
}

console.log('=== [review] a pick the bot refuses gives the list back ===');
{
  const h = await withList({}, 'Carrie');
  ok(row(h.store, h.req.id).pickList.offered.join() === '1976,2002,2013', 'Carrie 1976 is PG in the library, so it is offered');
  await send(h, '1', TESTING);
  const after = since(h.out, h.mark);
  ok(after.some((e) => e.op === 'react' && e.on === h.req.id && e.emoji === '⛔'),
    'OMDb has it as R: ⛔ on the request, as "#request Carrie 1976" would get');
  const edit = after.find((e) => e.op === 'edit');
  ok(edit?.kind === 'low' && edit.body === '🔍 *Search results for "Carrie"*\n\n~1. Carrie (1976)~ — can\'t be sent\n\n'
    + '*2.* Carrie (2002)\n\n*3.* Carrie (2013)\n\n'
    + 'Reply with a number (1–3), or react with it, to test it. Nothing is downloaded. This list expires in 9 minutes.',
  `the list is edited with 1 struck through, and no ✔:\n${edit?.body}`);
  ok(openLists(h.store).length === 1 && openLists(h.store)[0].refused.join() === '0', 'the list is open again, minus 1');
  const r = row(h.store, h.req.id);
  ok(r.status === 'pick-list' && r.pickList.outcome === null && r.pickList.refusals[0].status === 'blocked-rating',
    'History: open again, with the refusal recorded');
  ok(h.logs.some((l) => /offered as PG on the library's rating, but the request was refused as R/.test(l)),
    'the log names the rating disagreement');
  const m1 = h.out.length;
  const again = await send(h, '1', TESTING);
  ok(since(h.out, m1).length === 1 && h.out.at(-1).on === again.id && h.out.at(-1).emoji === '❓',
    'picking 1 again: one ❓, on the digit');
  await send(h, '2', TESTING);
  ok(sent(h) === 'Carrie (2002)', 'and 2 still works: Carrie (2002) queued');
  ok(h.out.filter((e) => e.op === 'edit').at(-1)?.body === '✔ 2 · Carrie (2002) — test passed, nothing sent', 'the list says so');
  const q = row(h.store, h.req.id);
  ok(q.status === 'test-passed' && q.pickList.picked === 2 && q.pickList.refusals.length === 1,
    'History: test-passed, and still shows that 1 was refused');
}
{
  // With under a minute left, a reopened list would expire at once, and its
  // 📅 would replace the ⛔ before it was read. It closes instead.
  const h = await withList({}, 'Carrie');
  h.store.get('pickLists')[0].expiresAt = Date.now() + 30_000;
  await send(h, '1', TESTING);
  const edit = since(h.out, h.mark).find((e) => e.op === 'edit');
  ok(edit?.body === "1 · Carrie (1976) — can't be sent", `with under a minute left it closes, without a ✔: "${edit?.body}"`);
  const n = h.out.length;
  await send(h, '2', TESTING);
  ok(h.out.length === n && !sentCount(h) && row(h.store, h.req.id).status === 'blocked-rating',
    'a later number is swallowed, and History keeps the refusal');
}
{
  // OMDb down is about the moment, not the version: nothing is struck out.
  const h = await withList();
  omdbDown = true;
  try { await send(h, '2', TESTING); } finally { omdbDown = false; }
  const after = since(h.out, h.mark);
  ok(after.some((e) => e.emoji === '⚠️' && e.on === h.req.id) && !after.some((e) => e.op === 'edit'),
    'OMDb down: ⚠️ on the request, and the list is left as it is');
  ok(openLists(h.store).length === 1 && !openLists(h.store)[0].refused.length, 'open again, nothing refused');
  await send(h, '2', TESTING);
  ok(sent(h) === 'Venom (2011)', 'so the same number works once OMDb is back');
}

console.log('=== [review] a picked version gone from the library is not replaced by another year\'s ===');
{
  // This block once pinned the opposite: with Venom 2011 gone after the list
  // was shown, the pipeline adopted the 2005 copy, as it then did for
  // "#request Venom 2011", and the edit named Venom (2005). On 2026-09-29 the
  // operator ruled that the year asked for makes it a different film ("Dune
  // 1984" with only Dune 2021 on the server: "Not in library"), and a pick
  // asks for its year as surely as a typed one does. So the 2011 pick is not
  // in the library, nothing is queued in its place, and the list is the
  // member's again with 2011 struck out.
  const h = await withList();
  const removed = [libItem('Venom', 1981), libItem('Venom', 2011)];
  const at = removed.map((f) => LIBRARY.indexOf(f));
  for (let i = at.length - 1; i >= 0; i -= 1) LIBRARY.splice(at[i], 1);
  try {
    await send(h, '2', TESTING);
  } finally {
    at.forEach((i, k) => LIBRARY.splice(i, 0, removed[k]));
  }
  const refusal = row(h.store, h.req.id)?.pickList?.refusals?.at(-1);
  ok(h.jobs.length === 0 && refusal?.year === 2011 && refusal?.status === 'not-in-library',
    `Venom 2011 left the library after the list: not in the library, and no other Venom is queued in its place (${JSON.stringify(refusal)})`);
  const edit = since(h.out, h.mark).find((e) => e.op === 'edit');
  ok(/~2\. Venom \(2011\)~ — can't be sent/.test(edit?.body ?? '') && !/on its way/.test(edit?.body ?? ''),
    `and the list strikes 2011 out, promising nothing: "${edit?.body}"`);
}

console.log('=== [review] numbers after the pick ===');
{
  const h = await withList({ movie: { enforcement: { enabled: true } } });
  await send(h, '1', TESTING);
  const n = h.out.length;
  await send(h, '#request 3', TESTING);
  ok(h.out.length === n && sentCount(h) === 1,
    'after the pick, "#request 3" from the owner is swallowed like a bare digit - not deleted as an empty request');
  await send(h, '5', TESTING);
  ok(h.out.length === n, 'as is a bare digit that was never on the list');
  // A message with no test code in the beta group is ignored, not
  // moderated, since 2026-09-29 (beta.js readBetaTest).
  await send(h, '#request 9', TESTING);
  ok(since(h.out, n).length === 0, '"#request 9" answers nothing on a 3-item list, and with no code it is ignored');
  await send(h, '$beta004 #request 9', TESTING);
  ok(since(h.out, n).map((e) => e.op).join() === 'delete', 'with its code, it is moderated as an empty request, as today');
}
{
  const h = await withList({ movie: { enforcement: { enabled: true } } });
  await send(h, '1', TESTING);
  h.ctx.config.beta.groups = [];
  h.ctx.config.movieRequests.requestGroups = [MAIN_REQ, TESTING];
  const m = h.out.length;
  await send(h, '5', TESTING);
  ok(since(h.out, m).map((e) => e.op).join() === 'delete', 'the beta group made a main one: the same');
}

console.log('=== [review] someone else\'s number is left alone, not deleted ===');
{
  const h = await withList({ movie: { enforcement: { enabled: true, warnByDm: true } } });
  for (const t of ['2', '7', '#request 2']) await send(h, t, TESTING, BOB);
  ok(h.out.length === h.mark && sentCount(h) === 0,
    'BOB answering ALICE\'s open list ("2", "7", "#request 2"): 0 outbound - nothing acted on, deleted or DMed');
  ok(openLists(h.store).length === 1, 'and the list is still ALICE\'s');
  await send(h, 'hello', TESTING, BOB);
  ok(!since(h.out, h.mark).some((e) => e.op === 'delete'),
    'anything else from BOB after a code is a request of his own, never deleted: the code says it is one');
  ok(answersList('#request 9', openLists(h.store)[0], '#request') === false, '"#request 9" is not an answer to a 3-item list');
}

console.log('=== [review] closing several replaced lists is paced (rule 1) ===');
{
  const h = await withList();
  const lists = h.store.get('pickLists');
  const [first] = lists;
  lists.push({ ...first, id: 'OLDER', listKey: { ...first.listKey, id: 'BOTX' }, record: { ...first.record, id: 'OLDER' } });
  const n = h.out.length;
  await send(h, '#request Dune', TESTING);
  const edits = since(h.out, n).filter((e) => e.op === 'edit');
  ok(edits.length === 2 && edits.every((e) => e.body === 'replaced — see the newer list'), 'both older lists are edited to say so');
  ok(h.ctx.bot.paced === 1, 'with _bulkPace between the two');
  ok(row(h.store, 'OLDER')?.status === 'pick-replaced' && row(h.store, h.req.id).status === 'pick-replaced', 'both recorded');
}

console.log('=== [review] an expiry is recorded first, and its reaction is owed until sent ===');
{
  const h = await withList();
  const react = h.ctx.bot.react;
  h.ctx.bot.react = async () => { throw new Error('WhatsApp is not connected'); };
  await moviePlugin._expirePickList(h.ctx, h.req.id);
  ok(row(h.store, h.req.id).status === 'pick-expired', 'History says expired although the reaction could not go');
  const j = h.store.get('pickLists');
  ok(j.length === 1 && j[0].state === 'expiring' && j[0].attempts === 1, 'the list stays journalled, owing its reaction');
  ok(moviePlugin._pickTimers.has(h.req.id), `and a retry is armed (${CLOSE_RETRY_MS / 60_000} minutes)`);
  ok(since(h.out, h.mark).length === 0, 'nothing was sent - the edit waits for the reaction');
  h.ctx.bot.react = react;
  await moviePlugin._expirePickList(h.ctx, h.req.id);                     // the retry
  const after = since(h.out, h.mark);
  ok(after[0]?.emoji === '📅' && after[0].on === h.req.id && after[1]?.op === 'edit', 'the retry sends the 📅, then the edit');
  ok(!h.store.get('pickLists').length && row(h.store, h.req.id).pickList.units === 3, 'then lets the list go, counting both');
  const s = summarisePickLists(h.store.get('history'));
  ok(s.open === 0 && s.expired === 1, 'counted as expired, not open');
}
{
  const h = await withList();
  h.ctx.bot.react = async () => { throw new Error('WhatsApp is not connected'); };
  for (let i = 0; i < MAX_CLOSE_ATTEMPTS; i += 1) await moviePlugin._expirePickList(h.ctx, h.req.id);
  ok(!h.store.get('pickLists').length && !moviePlugin._pickTimers.has(h.req.id)
    && row(h.store, h.req.id).status === 'pick-expired', `given up after ${MAX_CLOSE_ATTEMPTS} attempts; History still says expired`);
  ok(h.logs.some((l) => /giving up on the final reaction/.test(l)), 'and the log says so');
}
{
  // The process dies while the reaction waits in the pacer.
  const h = await withList();
  h.ctx.bot.react = () => new Promise(() => {});
  moviePlugin._expirePickList(h.ctx, h.req.id);
  await settle();
  const store = fakeStore(JSON.parse(JSON.stringify(h.store._data)));
  moviePlugin.teardown();
  ok(row(store, h.req.id).status === 'pick-expired', 'a restart while the final reaction is queued: History already says expired');
  const after = harness(config(), store);
  await moviePlugin.recoverPickLists(after.ctx);
  ok(after.out.some((e) => e.op === 'react' && e.emoji === '📅' && e.on === h.req.id), 'and recovery sends the reaction it still owed');
  ok(!store.get('pickLists').length && summarisePickLists(store.get('history')).open === 0, 'then lets it go');
}

/* ============================ franchises ============================ */
// "#request harry potter", 2026-09-22 16:58 in the beta group: no list, and
// OMDb's best search hit - the Deathly Hallows: Part 2 - queued for a member
// who had not chosen it. See the header comment.

const HP = [
  "Harry Potter and the Sorcerer's Stone (2001) · PG",
  'Harry Potter and the Chamber of Secrets (2002) · PG',
  'Harry Potter and the Prisoner of Azkaban (2004) · PG',
  'Harry Potter and the Goblet of Fire (2005) · PG-13',
  'Harry Potter and the Order of the Phoenix (2007) · PG-13',
  'Harry Potter and the Half-Blood Prince (2009) · PG',
  'Harry Potter and the Deathly Hallows: Part 1 (2010) · PG-13',
  'Harry Potter and the Deathly Hallows: Part 2 (2011) · PG-13',
];
const HP_LIST = listText('harry potter', HP.map((l) => l.replace(/ · [^·]+$/, '')));
const SW = [
  'Star Wars: Episode IV - A New Hope (1977)', 'Star Wars: Episode V - The Empire Strikes Back (1980)',
  'Star Wars: Episode VI - Return of the Jedi (1983)', 'Star Wars: Episode I - The Phantom Menace (1999)',
  'Star Wars: Episode II - Attack of the Clones (2002)', 'Star Wars: Episode III - Revenge of the Sith (2005)',
  'Star Wars: Episode VII - The Force Awakens (2015)', 'Star Wars: Episode VIII - The Last Jedi (2017)',
  'Star Wars: Episode IX - The Rise of Skywalker (2019)',
];
const jfCalls = (from) => netCalls.slice(from).filter((u) => u.includes('jf.test'));
const listBody = (h) => texts(h.out).find((e) => LIST_HEAD.test(e.body))?.body ?? null;

console.log('=== [franchise] the words: whole-word prefixes, and a word worth matching on ===');
{
  ok(startsWithWords('Harry Potter and the Prisoner of Azkaban', 'harry potter'), '"harry potter" starts "Harry Potter and the Prisoner of Azkaban"');
  ok(startsWithWords('Cars 2', 'cars') && startsWithWords('Cars', 'cars') && !startsWithWords('Carson City', 'cars'),
    '"cars" starts Cars and Cars 2, but not Carson City - a different word');
  ok(startsWithWords('The Hobbit: An Unexpected Journey', 'hobbit') && startsWithWords('The Hobbit: An Unexpected Journey', 'the hobbit'),
    'a leading "The" is ignored on both sides');
  ok(startsWithWords('Batman & Robin', 'batman and robin') && startsWithWords('Rocky II', 'rocky 2'),
    '"&" is "and", and a roman numeral is its digit, as everywhere else titles are compared');
  ok(!startsWithWords('Harry Potter', 'harry potter and the'), 'a title shorter than what was typed does not start with it');
  // Worth pinning because of what it costs: ignoring the article on the TITLE
  // side is what puts the five "A Cinderella Story" films on the Cinderella
  // set, taking it to 14 and past a list. See docs/operations.md.
  ok(startsWithWords('A Cinderella Story', 'cinderella') && startsWithWords('The Batman', 'batman'),
    'and the article ignored on the title side means "A Cinderella Story" starts with "cinderella"');
  ok(!hasSignificantWord('the') && !hasSignificantWord('a') && !hasSignificantWord('The One') && !hasSignificantWord('it')
    && !hasSignificantWord('21'), '"the", "a", "the one", "it" and "21" have no word worth matching the start of titles on');
  ok(hasSignificantWord('cars') && hasSignificantWord('the hobbit') && hasSignificantWord('Ted'), 'but "cars", "the hobbit" and "Ted" do');
}

console.log('=== [franchise] what step 0 decides, from the library alone ===');
{
  const cfg = DEFAULT_CONFIG.movieRequests;
  const f = (title, year, rated = 'PG', extra = {}) => ({ id: `${title}${year}`, title, year, rated, ratings: [rated], types: ['Movie'], ...extra });
  const found = (versions, full = false) => ({ versions, full });
  const D = (q, fnd, opts) => decidePickList(q, fnd, cfg, opts);
  ok(D('cars', found([f('Cars', 2006), f('Cars 2', 2011), f('Carson City', 1952)])).items.map((v) => v.title).join() === 'Cars,Cars 2',
    'a list of Cars and Cars 2, not Carson City');
  ok(D('the', found([f('The', 2001), f('The Thing', 1982)])).kind === 'none', '"the" never lists, whatever the library holds');
  ok(D('it', found([f('It', 1990), f('It', 2017), f('It Chapter Two', 2019)])).items.map((v) => v.year).join() === '1990,2017',
    'a title with no significant word still offers its same-title remakes, as before - and only those');
  ok(D('inception', found([f('Inception', 2010)])).kind === 'none', 'held once under exactly that title: nothing to ask, carry on as before');
  // beta001's rule, as the operator approved it for every group: it went
  // there with the list on 2026-10-11, unchanged (review of that change).
  const only = D('paddington', found([f('Paddington 2', 2017)]));
  ok(only.kind === 'only' && only.item.title === 'Paddington 2', 'the only film starting with the words: go ahead with it');
  ok(D('frozen', found([f('Frozen', 2010, 'R'), f('Frozen', 2013)])).kind === 'only', 'one of two sendable: go ahead with that one, as before');
  ok(D('the garfield movie', found([f('The Garfield Movie', 2024)]), { searchTerm: 'the garfield' }).kind === 'only',
    'and the one film called exactly what was typed, which the pipeline would look up by shorter words, still goes ahead');
  ok(D('john wick', found([f('John Wick', 2014, 'R'), f('John Wick: Chapter 2', 2017, 'R')])).kind === 'none',
    'none sendable: carry on, to the refusal it always got');
  ok(D('alien', found([f('Alien', 1979, 'R'), f('Alien Xmas', 2020)])).kind === 'none',
    'the film named exactly is held but R, and one OTHER title could be sent: not gone ahead with unasked');
  ok(D('alien', found([f('Alien', 1979, 'R'), f('Alien Xmas', 2020), f('Alien Nation', 1988, 'PG-13')])).kind === 'list',
    'though two or more are offered as a list - a list is a question, not a send');
  const ten = Array.from({ length: 10 }, (_, i) => f(`Saw ${i + 1}`, 2004 + i));
  const many = Array.from({ length: 21 }, (_, i) => f(`Saw ${i + 1}`, 1990 + i));
  ok(D('saw', found(many)).kind === 'narrow' && D('saw', found(many.slice(0, 20))).kind === 'list'
    && D('saw', found(ten)).kind === 'list', 'ten are listed now, and twenty; twenty-one are too many');
  ok(D('saw', found(ten.slice(0, 5)), { maxOptions: 4 }).kind === 'narrow', 'and a lower maxOptions is obeyed');
  const full = D('saw', found(ten.slice(0, 3), true));
  ok(full.kind === 'narrow' && full.atLeast, 'a search that came back full is never listed: there may be more it did not see');
  ok(D('saw', found(ten.slice(0, 1), true)).kind === 'none', 'nor is its one match taken as the only one');
  ok(D('it', found([f('It', 1990), f('It', 2017)], true)).kind === 'list',
    'remakes of one title are matched exactly and do not care whether the search filled up, as before');
  const twice = D('potter', found([f('Potter 2', 2001), f('Potter 1', 2001), f('Potter 1', 2001)]));
  ok(twice.items.map((v) => v.title).join() === 'Potter 1,Potter 2', 'two copies of one film are one choice; two films of one year are two');
  ok(D('dune', found([f('Dune', 2021), f('Dune: Part Two', 2024), f('Dune', 1984)])).items.map((v) => `${v.title} ${v.year}`).join()
    === 'Dune 1984,Dune 2021,Dune: Part Two 2024', 'oldest first');
}

console.log('=== [franchise] the reply when too many films start with it ===');
{
  const items = [{ title: 'Batman', year: 1966 }, { title: 'Batman Returns', year: 1992 }, { title: 'Batman Begins', year: 2005 },
    { title: 'The Batman', year: 2022 }];
  ok(narrowDownText('Batman', items, { prefix: '#request' }) === '4 films start with "Batman" — add a word or the year, e.g. #request Batman Begins',
    'the count, and the shortest title that says more than what was typed');
  ok(narrowDownText('hamlet', [{ title: 'Hamlet', year: 1948 }, { title: 'Hamlet', year: 2000 }], { prefix: '#request' })
    === '2 films start with "hamlet" — add a word or the year, e.g. #request Hamlet 2000', 'all one title: that title with its latest year');
  ok(/^At least 4 films/.test(narrowDownText('Batman', items, { atLeast: true })), '"At least" when the search came back full');
}

console.log('=== [franchise] answering a franchise list ===');
{
  const items = [{ title: 'Toy Story', year: 1995 }, { title: 'Toy Story 2', year: 1999 }, { title: 'Toy Story 3', year: 2010 }];
  const list = { title: 'toy story', request: 'toy story', items };
  ok(parsePick('#request Toy Story 2 1999', list, '#request')?.index === 1, 'a listed title with its year is that pick');
  ok(parsePick('#request toy story 2010', list, '#request')?.index === 2, 'the words first typed, with a year only one film has, too');
  ok(parsePick('#request toy story 2 2010', list, '#request') === null, 'but not a title and a year that do not go together');
  const nine = { title: 'saw', request: 'saw', items: Array.from({ length: 9 }, (_, i) => ({ title: `Saw ${i + 1}`, year: 2004 + i })) };
  ok(parsePick('#request 9', nine, '#request')?.index === 8 && parsePick('9', nine, '#request')?.index === 8,
    'with a nine-item list open, "9" and "#request 9" are both picks');
  ok(parsePick('#request 9', { ...nine, items: nine.items.slice(0, 3) }, '#request') === null, 'with a shorter one, "#request 9" is not');
  ok(offeredLabels(items).join('|') === 'Toy Story (1995)|Toy Story 2 (1999)|Toy Story 3 (2010)'
    && offeredLabels([{ title: 'Venom', year: 2005 }, { title: 'VENOM', year: 2018 }]).join() === '2005,2018',
  'History and the log name the titles of a franchise, and keep the years alone for remakes');
}

console.log('=== [franchise] what origin/main did: in the beta group, with no code, nothing now ===');
// Captured by running these messages through origin/main's plugin, with this
// file's fixture and stubs (scratch differential run, 2026-09-22). The first
// case is the incident itself: origin/main queues the Deathly Hallows. They
// pinned the flag Off until it went (2026-10-11); they are kept as the record
// of what the list replaced, and the main-group rows are checked against it
// below.
const FRANCHISE_GOLDEN = [
  ['#request harry potter', TESTING, [['react', TESTING, '🔍', 'normal'], ['react', TESTING, '🎬', 'normal'],
    ['text', TESTING, '🎬 Harry Potter and the Deathly Hallows: Part 2 (2011) — added to the queue', 'critical']],
  ['Harry Potter and the Deathly Hallows: Part 2 (2011)']],
  ['#request harry potter', MAIN_REQ, [['react', MAIN_REQ, '🔍', 'normal'], ['react', MAIN_REQ, '🎬', 'normal'],
    ['text', MAIN_NOTIFY, '🎬 Harry Potter and the Deathly Hallows: Part 2 (2011) — added to the queue', 'critical']],
  ['Harry Potter and the Deathly Hallows: Part 2 (2011)']],
  ['#request cars', TESTING, [['react', TESTING, '🔍', 'normal'], ['react', TESTING, '🎬', 'normal'],
    ['text', TESTING, '🎬 Cars (2006) — added to the queue', 'critical']], ['Cars (2006)']],
  ['#request cars', MAIN_REQ, [['react', MAIN_REQ, '🔍', 'normal'], ['react', MAIN_REQ, '🎬', 'normal'],
    ['text', MAIN_NOTIFY, '🎬 Cars (2006) — added to the queue', 'critical']], ['Cars (2006)']],
  ['#request toy story', TESTING, [['react', TESTING, '🔍', 'normal'], ['react', TESTING, '🎬', 'normal'],
    ['text', TESTING, '🎬 Toy Story (1995) — added to the queue', 'critical']], ['Toy Story (1995)']],
  ['#request the hobbit', TESTING, [['react', TESTING, '🔍', 'normal'], ['react', TESTING, '🎬', 'normal'],
    ['text', TESTING, '🎬 The Hobbit: An Unexpected Journey (2012) — added to the queue', 'critical']],
  ['The Hobbit: An Unexpected Journey (2012)']],
  ['#request hobbit', TESTING, [['react', TESTING, '🔍', 'normal'], ['react', TESTING, '🎬', 'normal'],
    ['text', TESTING, '🎬 The Hobbit: An Unexpected Journey (2012) — added to the queue', 'critical']],
  ['The Hobbit: An Unexpected Journey (2012)']],
  ['#request batman', TESTING, [['react', TESTING, '🔍', 'normal'],
    ['text', TESTING, '📅 The Batman — we have 1966, 1989, 2022. Send #request The Batman 2022', 'critical'],
    ['react', TESTING, '📅', 'critical']], []],
  ['#request batman', MAIN_REQ, [['react', MAIN_REQ, '🔍', 'normal'],
    ['text', MAIN_NOTIFY, '📅 The Batman — we have 1966, 1989, 2022. Send #request The Batman 2022', 'critical'],
    ['react', MAIN_REQ, '📅', 'critical']], []],
  ['#request star wars', TESTING, [['react', TESTING, '🔍', 'normal'], ['react', TESTING, '🎬', 'normal'],
    ['text', TESTING, '🎬 Star Wars: Episode I - The Phantom Menace (1999) — added to the queue', 'critical']],
  ['Star Wars: Episode I - The Phantom Menace (1999)']],
  ['#request star wars', MAIN_REQ, [['react', MAIN_REQ, '🔍', 'normal'], ['react', MAIN_REQ, '🎬', 'normal'],
    ['text', MAIN_NOTIFY, '🎬 Star Wars: Episode I - The Phantom Menace (1999) — added to the queue', 'critical']],
  ['Star Wars: Episode I - The Phantom Menace (1999)']],
  ['#request the', TESTING, [['react', TESTING, '🔍', 'normal'],
    ['text', TESTING, "⛔ Batman: The Killing Joke (2016) — rated R, can't be posted", 'critical'],
    ['react', TESTING, '⛔', 'critical']], []],
  ['#request harry potter and the prisoner', TESTING, [['react', TESTING, '🔍', 'normal'], ['react', TESTING, '🎬', 'normal'],
    ['text', TESTING, '🎬 Harry Potter and the Prisoner of Azkaban (2004) — added to the queue', 'critical']],
  ['Harry Potter and the Prisoner of Azkaban (2004)']],
  ['#request paddington', TESTING, [['react', TESTING, '🔍', 'normal'], ['react', TESTING, '🎬', 'normal'],
    ['text', TESTING, '🎬 Paddington 2 (2018) — added to the queue', 'critical']], ['Paddington 2 (2018)']],
  ['#request john wick', TESTING, [['react', TESTING, '🔍', 'normal'],
    ['text', TESTING, "⛔ John Wick (2014) — rated R, can't be posted", 'critical'], ['react', TESTING, '⛔', 'critical']], []],
  ['#request alien', TESTING, [['react', TESTING, '🔍', 'normal'],
    ['text', TESTING, "⛔ Alien (1979) — rated R, can't be posted", 'critical'], ['react', TESTING, '⛔', 'critical']], []],
  ['#request 9', TESTING, [], []],
  ['9', TESTING, [], []],
  // "Movie" is a title word, so these three were here to pin that keeping it
  // changed nothing at all with the flag Off. Note what origin/main does with
  // the middle one: it strips "movie", looks up "the garfield", and queues
  // the 2004 film rather than the one the member named.
  ['#request the muppet movie', TESTING, [['react', TESTING, '🔍', 'normal'],
    ['text', TESTING, '📬 The Muppet Movie (1979) — not in the library', 'critical'],
    ['react', TESTING, '📬', 'critical']], []],
  ['#request the garfield movie', TESTING, [['react', TESTING, '🔍', 'normal'], ['react', TESTING, '🎬', 'normal'],
    ['text', TESTING, '🎬 Garfield (2004) — added to the queue', 'critical']], ['Garfield (2004)']],
  ['#request garfield', TESTING, [['react', TESTING, '🔍', 'normal'], ['react', TESTING, '🎬', 'normal'],
    ['text', TESTING, '🎬 Garfield (2004) — added to the queue', 'critical']], ['Garfield (2004)']],
];
const shapeOf = (h) => JSON.stringify([h.out.map((e) => [e.op, e.jid, e.emoji ?? e.body, e.kind]), h.jobs.map((j) => j.label)]);
for (const [text] of FRANCHISE_GOLDEN.filter(([, c]) => c === TESTING)) {
  // The beta-group rows are what origin/main did there then. Since
  // 2026-09-29 a message in the beta group without a test code is ignored
  // (beta.js readBetaTest): no outbound, nothing queued.
  const h = harness(config());
  await moviePlugin.onMessage(mkMsg(text, TESTING), h.ctx);
  await settle();
  ok(shapeOf(h) === JSON.stringify([[], []]), `"${text}" in the beta group with no code: ignored`);
  ok(!('pickLists' in h.store._data), `   and no list journal for "${text}"`);
}

console.log('=== [franchise] the main group asks which one, where origin/main queued a film nobody chose ===');
// The flag kept the main group exactly as origin/main until 2026-10-11, when
// the list left beta for every group (see the top of this file). These rows
// are now the cases the list was made for: origin/main queued the Deathly
// Hallows for "harry potter", and Cars, and Episode I, and asked "which
// year?" of a Batman with 22 films starting with it.
for (const [text, chat, golden, goldenJobs] of FRANCHISE_GOLDEN.filter(([, c]) => c === MAIN_REQ)) {
  const h = harness(config());
  const m = await send(h, text, chat);
  const answer = texts(h.out).filter((e) => e.jid === MAIN_REQ && e.quoted === m.id);
  const asked = answer.length === 1 && (LIST_HEAD.test(answer[0].body) || /^\d+ films start with ".+" — add a word or the year/.test(answer[0].body));
  ok(shapeOf(h) !== JSON.stringify([golden, goldenJobs]) && h.jobs.length === 0 && asked && !texts(h.out).some((e) => e.jid === MAIN_NOTIFY),
    `"${text}" in the main group: nothing queued${goldenJobs.length ? ` (origin/main queued ${goldenJobs[0]})` : ''}, one quoted `
    + `${LIST_HEAD.test(answer[0]?.body ?? '') ? 'list' : '"add a word or the year"'} instead`);
}

console.log('=== [franchise] "harry potter" lists all eight films, in release order ===');
{
  const h = harness(config());
  clearPlotCache();
  const omdb = omdbCalls();
  const jf = netCalls.length;
  const m = await send(h, '#request harry potter', TESTING);
  ok(sentCount(h) === 0, 'nothing is queued - not the Deathly Hallows, not anything');
  const list = texts(h.out);
  ok(list.length === 1 && list[0].jid === TESTING && list[0].quoted === m.id && list[0].kind === 'critical',
    'one text: a quoted reply in the beta group, at critical');
  ok(list[0].body === HP_LIST, `one line per film, oldest first:\n${list[0].body}`);
  ok(!/Hogwarts Tournament/.test(list[0].body), 'the series of the same name is never offered');
  ok(list[0].body.match(/Goblet of Fire/g).length === 1, 'the film held twice is offered once');
  ok(h.out.length === 2 && h.out[0].emoji === '🔍', '🔍 then the list: 2 outbound');
  ok(omdbCalls() - omdb === 8, `decided with no OMDb call; the only ones are the eight plots (${omdbCalls() - omdb})`);
  const searches = jfCalls(jf);
  ok(searches.length === 1 && new URL(searches[0]).searchParams.get('Limit') === '60',
    'one library search, asking for 60 results so the whole franchise is seen');
  const r = row(h.store, m.id);
  ok(r.status === 'pick-list' && r.title === 'harry potter' && r.pickList.offered.join() === '2001,2002,2004,2005,2007,2009,2010,2011'
    && r.pickList.titles.length === 8 && r.pickList.held === 9,
  'History: the list, named as typed, with the titles it offered (held: the eight films and the series)');
  ok(/^asked which one: Harry Potter and the Sorcerer's Stone \(2001\), /.test(r.detail), `and a detail that names them: ${r.detail.slice(0, 70)}...`);
  ok(h.logs.some((l) => /pick list shown for "harry potter".*3=Harry Potter and the Prisoner of Azkaban \(2004\)/.test(l)),
    'the log names each number\'s film');

  const mark = h.out.length;
  await send(h, '3', TESTING);
  ok(sentCount(h) === 1 && sent(h) === 'Harry Potter and the Prisoner of Azkaban (2004)' && h.jobs.length === 0,
    'a 3 passes with the Prisoner of Azkaban, and nothing is queued');
  const q = row(h.store, m.id);
  ok(q.status === 'test-passed' && q.title === 'Harry Potter and the Prisoner of Azkaban' && q.year === 2004
    && q.request === 'Harry Potter and the Prisoner of Azkaban 2004' && q.typed === 'harry potter',
  'History: test-passed, the 2004 film, "harry potter" as typed and the film and year as looked up');
  ok(q.pickList.picked === 3 && q.pickList.outcome === 'picked', 'with the pick recorded');
  const after = since(h.out, mark);
  ok(after.filter((e) => e.op === 'react').every((e) => e.on === m.id) && after.some((e) => e.emoji === '✅'),
    'through the normal pipeline, reacting ✅ on the original request');
  ok(after.find((e) => e.op === 'edit')?.body === '✔ 3 · Harry Potter and the Prisoner of Azkaban (2004) — test passed, nothing sent',
    'and the list edited to say so');
  ok(!(h.store.get('pending') ?? []).length && !h.out.some((e) => e.op === 'document'), 'nothing journalled, nothing delivered');
  ok(!h.out.some((e) => MAIN.includes(e.jid)), 'no main group heard any of it');
}
{
  const h = await withList({}, 'harry potter');
  await send(h, '#request harry potter 2010', TESTING);
  ok(sent(h) === 'Harry Potter and the Deathly Hallows: Part 1 (2010)' && row(h.store, h.req.id).pickList.form === 'title-year',
    '"#request harry potter 2010" while the list is open is the pick of the 2010 film');
}
{
  const h = await withList({}, 'harry potter');
  await send(h, '#request Harry Potter and the Deathly Hallows: Part 2 2011', TESTING);
  ok(sent(h) === 'Harry Potter and the Deathly Hallows: Part 2 (2011)', 'the list\'s own suggestion, typed back, is that pick');
}

console.log('=== [franchise] exact title and sequels ===');
{
  const cases = [
    ['cars', ['Cars (2006) · G', 'Cars 2 (2011) · G', 'Cars 3 (2017) · G']],
    ['toy story', ['Toy Story (1995) · G', 'Toy Story 2 (1999) · G', 'Toy Story 3 (2010) · G', 'Toy Story 4 (2019) · G']],
    ['the hobbit', ['The Hobbit: An Unexpected Journey (2012) · PG-13', 'The Hobbit: The Desolation of Smaug (2013) · PG-13',
      'The Hobbit: The Battle of the Five Armies (2014) · PG-13']],
  ];
  for (const [title, lines] of cases) {
    const h = harness(config());
    await send(h, `#request ${title}`, TESTING);
    const want = lines.map((l, i) => `${i + 1} ${l.replace(/ · [^·]+$/, '')}`).join('\n');
    ok(listFilms(listBody(h)).join('\n') === want && sentCount(h) === 0, `"${title}" -> ${lines.length} films, the one called exactly that included`);
  }
  const hobbit = harness(config());
  await send(hobbit, '#request hobbit', TESTING);
  const theHobbit = harness(config());
  await send(theHobbit, '#request the hobbit', TESTING);
  ok(listBody(hobbit) && listFilms(listBody(hobbit)).join() === listFilms(listBody(theHobbit)).join(), '"hobbit" gets the same list as "the hobbit"');
  const cars = harness(config());
  await send(cars, '#request cars', TESTING);
  ok(!/Carson City|Cars on the Road/.test(listBody(cars)), 'Carson City (another word) and Cars on the Road (a series) are not on it');
}

console.log('=== [franchise] more than nine: one reply asking to narrow it down ===');
{
  const h = harness(config());
  const omdb = omdbCalls();
  const m = await send(h, '#request batman', TESTING);
  const t = texts(h.out);
  ok(t.length === 1 && t[0].jid === TESTING && t[0].quoted === m.id && t[0].kind === 'critical', 'one quoted reply, in the beta group');
  ok(t[0].body === '22 films start with "batman" — add a word or the year, e.g. $beta004 #request Batman Begins',
    `naming the count - 22, the R-rated Killing Joke not counted - and an example: "${t[0].body}"`);
  ok(JSON.stringify(h.out.map((e) => e.emoji ?? e.op)) === '["🔍","text","📅"]', '🔍, the reply, then 📅 on the request: 3 outbound');
  ok(omdbCalls() === omdb, 'and no OMDb call');
  ok(!openLists(h.store).length && !(h.store.get('pickLists') ?? []).length && sentCount(h) === 0, 'no list is opened and nothing queued');
  const r = row(h.store, m.id);
  ok(r.status === 'need-year' && r.pickNarrow?.matches === 22 && !r.pickList, 'History: need-year, with the reply recorded');
  const s = summarisePickLists(h.store.get('history'));
  ok(s.narrowed === 1 && s.shown === 0 && s.units === 1, 'counted apart from the lists');
  ok(/Pick lists\s+: 0 shown, .*1 too broad for a list/.test(buildDigest({ now: Date.now(), history: h.store.get('history') })),
    'and on the daily digest');
}
console.log('=== too many start with it, but several are the same film remade ===');
{
  // "cinderella" starts 12 sendable films, past a list of nine. Answering "add
  // a word" would throw away the five films actually called Cinderella, which
  // is what a bare title most often means - and what this list offered before
  // franchises were added. Batman is the other way round (3 of 22), and still
  // gets the narrow-it-down reply above.
  // A list offers the whole series, up to 20, so the twelve are listed now;
  // the exact-remakes answer is for a list longer than the limit, and a
  // limit of 8 stands in for that here.
  const all = harness(config());
  await send(all, '#request cinderella', TESTING);
  ok(listFilms(listBody(all)).length === 12 && /^12 /.test(listFilms(listBody(all))[11]),
    `with the default limit of 20, all twelve films starting with "cinderella" are listed`);
  const h = harness(config({ movie: { pickList: { maxOptions: 8 } } }));
  await send(h, '#request cinderella', TESTING);
  const body = listBody(h) ?? '(no list was shown)';
  const lines = listFilms(body);
  ok(/^1 Cinderella \(1950\)/.test(lines[0]) && /^5 Cinderella \(2021\)/.test(lines[4]) && lines.length === 5,
    `the five films called exactly that are listed, oldest first: "${lines.join(' | ')}"`);
  ok(!/Cinderella Man|A Cinderella Story|Twist in Time/.test(body), 'and the other titles are not in the numbered options');
  ok(body.split('\n\n').includes('7 other films start with that too — send its full name for one of those.'),
    `the list says they exist: "${body.split('\n\n').at(-2)}"`);
  ok(sentCount(h) === 0 && openLists(h.store).length === 1, 'nothing is queued until a number comes back');

  const g = harness(config());
  await send(g, '#request godzilla', TESTING);
  ok(/^1 Godzilla \(1954\)/.test(listFilms(listBody(g))[0] ?? ''), 'godzilla lists its three remakes the same way');
}
{
  const h = harness(config({ movie: { pickList: { maxOptions: 4 } } }));
  const m = await send(h, '#request harry potter', TESTING);
  ok(texts(h.out)[0]?.body === '8 films start with "harry potter" — add a word or the year, e.g. $beta004 #request Harry Potter and the Goblet of Fire'
    && row(h.store, m.id).status === 'need-year', `with maxOptions 4, eight films are too many: "${texts(h.out)[0]?.body}"`);
}
{
  // Nine Star Wars films and nothing else: nine is a list.
  const h = harness(config());
  await send(h, '#request star wars', TESTING);
  ok(listFilms(listBody(h)).length === 9 && listFilms(listBody(h))[8] === '9 Star Wars: Episode IX - The Rise of Skywalker (2019)',
    'nine films are listed, 1 to 9');
}
{
  // The search came back full (a lower limit stands in for 60 here).
  const cfg = config();
  const some = await libraryVersions('batman', cfg.library, { limit: 10 });
  const all = await libraryVersions('batman', cfg.library);
  ok(some.full === true && all.full === false && all.versions.length === 23,
    'libraryVersions says when its search filled up, and at 60 sees all 23 Batman films');
}
{
  const cfg = config();
  cfg.movieRequests.replyOnBlock = true;
  const h = harness(cfg);
  await send(h, '#request batman', TESTING);
  ok(texts(h.out).length === 1, 'with replyOnBlock on, still one reply - it is not sent twice');
}

console.log('=== [franchise] one film: sent directly, by title and year ===');
{
  const h = harness(config());
  const m = await send(h, '#request harry potter and the prisoner', TESTING);
  ok(!listBody(h) && sent(h) === 'Harry Potter and the Prisoner of Azkaban (2004)', 'the only film starting with the words is queued');
  const r = row(h.store, m.id);
  ok(r.request === 'Harry Potter and the Prisoner of Azkaban 2004' && r.typed === 'harry potter and the prisoner',
    'asked for by title and year, with what was typed kept beside it');
}
{
  const h = harness(config());
  await send(h, '#request paddington', TESTING);
  ok(sent(h) === 'Paddington 2 (2018)' && !h.out.some((e) => e.emoji === '❓'),
    'Paddington 2, the only "paddington": Jellyfin says 2017 and OMDb 2018, and it is still found');
}
{
  // The same in a main group, with an empty beta config: the rule is no
  // longer the beta group's alone (2026-10-11).
  const h = harness(config({ beta: { features: {} } }));
  const m = await send(h, '#request harry potter and the prisoner', MAIN_REQ);
  const r = row(h.store, m.id);
  ok(!listBody(h) && h.jobs.length === 1 && r.status === 'queued' && r.request === 'Harry Potter and the Prisoner of Azkaban 2004',
    `in a main group too: the one film starting with the words is queued, by title and year (${r.status}, "${r.request}")`);
}

console.log('=== [franchise] never a list of what cannot be sent ===');
{
  const h = harness(config());
  const m = await send(h, '#request john wick', TESTING);
  ok(!listBody(h) && h.out.at(-1).emoji === '⛔' && row(h.store, m.id).status === 'blocked-rating',
    'John Wick: every chapter is R, so no list - the ⛔ it always got');
  ok(h.logs.some((l) => /pick list: "john wick" matches 4 film\(s\).*sendable: none -> none/.test(l)),
    'and the log says what step 0 saw and why it stood aside');
}
{
  const h = harness(config());
  await send(h, '#request alien', TESTING);
  const off = FRANCHISE_GOLDEN.find(([t]) => t === '#request alien');
  ok(!sentCount(h) && shapeOf(h) === JSON.stringify([off[2], off[3]]),
    '"#request alien" (R) is refused as it always was - Alien Xmas, the one sendable film starting with it, is not sent instead');
}
{
  const h = harness(config());
  await send(h, '#request the', TESTING);
  const off = FRANCHISE_GOLDEN.find(([t]) => t === '#request the');
  ok(!listBody(h) && shapeOf(h) === JSON.stringify([off[2], off[3]]), '"#request the": no list, no reply - exactly origin/main');
}

console.log('=== [franchise] "movie" and "film" are title words, and a list matches on them ===');
// Review of this branch, 2026-09-23: step 0 matched on cleanRequestText(text),
// which drops "movie" and "film" because they are usually noise in a search.
// Once a bare title listed every film whose title STARTS WITH it, that made
// "#request the muppet movie" a request for "the muppet" - and with only The
// Muppet Christmas Carol held, the 'only' path queued that for a member who
// had never named it. Which is the Deathly Hallows incident over again.
{
  ok(cleanRequestText('the muppet movie 1979 please') === 'the muppet'
    && cleanRequestText('the muppet movie 1979 please', { keepMediaWords: true }) === 'the muppet movie',
    'the search term drops "movie"; the words a title is matched against keep it');
  ok(!startsWithWords('The Muppet Christmas Carol', 'the muppet movie')
    && startsWithWords('The Muppet Christmas Carol', 'the muppet'),
    'and only the shorter one counts The Muppet Christmas Carol as a match');
}
{
  const h = harness(config());
  const m = await send(h, '#request the muppet movie', TESTING);
  const off = FRANCHISE_GOLDEN.find(([t]) => t === '#request the muppet movie');
  ok(!listBody(h) && !sentCount(h) && shapeOf(h) === JSON.stringify([off[2], off[3]]),
    '"#request the muppet movie" is answered 📬 exactly as origin/main - the Muppet film we DO hold is not queued');
  ok(row(h.store, m.id).request === 'the muppet movie',
    'and History still says what was asked for, not what the server happens to hold');
}
{
  // "Movie" is also just how people talk. Refusing to look past it would send
  // "the new spiderman movie" back to OMDb's best guess, which is how the
  // Deathly Hallows got queued - so the shorter words get a second look, and
  // only a question may come of it.
  const h = harness(config());
  await send(h, '#request harry potter movie', TESTING);
  ok(listBody(h) === HP_LIST && !sentCount(h),
    '"#request harry potter movie" gets the same list as "#request harry potter"');
  ok(h.logs.some((l) => /nothing starts with "harry potter movie"; asking about "harry potter" instead/.test(l)),
    'and the log says it looked past the word rather than matching on it');

  const b = harness(config());
  await send(b, '#request batman film', TESTING);
  ok(texts(b.out)[0]?.body === '22 films start with "batman" — add a word or the year, e.g. $beta004 #request Batman Begins'
    && !sentCount(b), '"#request batman film" gets the narrow-it-down reply, in the shorter words');

  const w = harness(config());
  await send(w, '#request john wick movie', TESTING);
  ok(!listBody(w) && w.out.at(-1).emoji === '⛔' && !sentCount(w),
    'and looking past it never offers what cannot be sent: "john wick movie" is still ⛔');
}
{
  // The film the member named IS held, under exactly those words. Standing
  // aside would hand the request to a pipeline that strips "movie" and lands
  // on Garfield (2004), so this one is asked for by title and year instead.
  const h = harness(config());
  await send(h, '#request the garfield movie', TESTING);
  ok(!listBody(h) && sent(h) === 'The Garfield Movie (2024)',
    '"#request the garfield movie" queues the 2024 film it names, with no list - origin/main queues Garfield (2004)');
  const g = harness(config());
  await send(g, '#request garfield', TESTING);
  ok(listBody(g) === listText('garfield', ['Garfield (2004)', 'The Garfield Movie (2024)']),
    '   while the bare "garfield" still lists both, the 2024 film included');
}
{
  // The line a list tells the member to send has to come back as that pick,
  // or it is run as a fresh request and meets the 30-second cooldown the
  // original has just started. Stripping "movie" left "scary 2", which
  // matched no listed title.
  const list = {
    title: 'scary movie', request: 'scary movie',
    items: [{ title: 'Scary Movie', year: 2000 }, { title: 'Scary Movie 2', year: 2001 }],
  };
  ok(parsePick('#request Scary Movie 2 2001', list, '#request')?.index === 1
    && parsePick('#request Scary Movie 2000', list, '#request')?.index === 0,
    'a listed title that contains "Movie", sent back with its year, is read as that pick');
}

console.log('=== [franchise] picks 1 to 9 on a nine-item list ===');
{
  const got = [];
  for (let d = 1; d <= 9; d += 1) {
    const h = await withList({}, 'star wars');
    await send(h, String(d), TESTING);
    got.push(sent(h) ?? '-');
  }
  ok(JSON.stringify(got) === JSON.stringify(SW), `each digit 1-9 queues its film:\n    ${got.join('\n    ')}`);
}
{
  const h = await withList({}, 'star wars');
  await send(h, '#request 9', TESTING);
  ok(sent(h) === SW[8] && row(h.store, h.req.id).pickList.form === 'prefixed',
    '"#request 9" with a nine-item list open is the pick of the 9th');
}
{
  const h = await withList({}, 'star wars');
  const zero = await send(h, '0', TESTING);
  ok(h.out.at(-1)?.on === zero.id && h.out.at(-1).emoji === '❓' && !sentCount(h), '"0" is a wrong number: ❓, and the list stays open');
}

/* ===================== rated films the AI check could clear ===================== */
// 2026-09-30 02:17 UTC, the testing group: "$beta001 ... john wick" logged
// 'matches 4 film(s) on the server ...; sendable: none -> none', all four
// being R, and the request fell through to a single-film request that the AI
// check cleared ("nudity=false by Groq -> cleared") and passed. The list
// judged by the rating alone, against the operator's rule that the AI only
// helps a rated film through (content-check.js). Films the check could clear
// are listed now, and only the one picked is put to it.

// The AI check switched on, with the operator's leave to clear a rated film.
const withAi = (cfg) => {
  cfg.gemini = { ...cfg.gemini, enabled: true, apiKey: 'GEMINI-KEY', model: 'gemini-test', contentCheck: true,
    minContentConfidence: 0.7, allowCleanRatedFilms: true };
  return cfg;
};
const WICKS = ['1 John Wick (2014)', '2 John Wick: Chapter 2 (2017)', '3 John Wick: Chapter 3 - Parabellum (2019)',
  '4 John Wick: Chapter 4 (2023)'];

console.log('=== an R-rated series the AI may clear is listed, and the film picked is checked then (cleared -> sent / test passed; refused -> struck through, the list stays open) ===');
{
  aiAsks.length = 0;
  // Chapter 2 is the one the check will not clear.
  aiVerdict = (asked) => (/Chapter 2/.test(asked)
    ? { nudity: true, confidence: 0.95, basis: 'a sex scene' }
    : { nudity: false, confidence: 0.9, basis: 'violence only' });
  const h = harness(withAi(config()));
  const req = await send(h, '#request john wick', TESTING);
  ok(listFilms(listBody(h)).join('|') === WICKS.join('|'), `all four R films are listed:\n${listBody(h)}`);
  ok(aiAsks.length === 0, 'and the AI was asked nothing while the list was made');
  ok(openLists(h.store)[0]?.items.every((it) => it.via === 'ai'), 'each is journalled as offered for the AI check to clear');

  let mark = h.out.length;
  await send(h, '2', TESTING);
  let after = since(h.out, mark);
  ok(aiAsks.length === 1 && /Chapter 2/.test(aiAsks[0]), 'picking 2 asks the AI about that one film');
  ok(after.some((e) => e.op === 'react' && e.on === req.id && e.emoji === '⛔') && sentCount(h) === 0,
    'it does not clear it: ⛔ on the request, and nothing passes');
  const r = row(h.store, req.id);
  ok(r?.pickList?.refusals?.[0]?.status === 'blocked-rating' && /AI check did not clear it/.test(r.pickList.refusals[0].detail ?? ''),
    `History records the refusal with the AI's reason: "${r?.pickList?.refusals?.[0]?.detail}"`);
  const edit = after.find((e) => e.op === 'edit');
  ok(edit?.body?.split('\n\n')[2] === "~2. John Wick: Chapter 2 (2017)~ — can't be sent" && /\*3\.\* John Wick: Chapter 3/.test(edit.body),
    `the list strikes it through and keeps the rest:\n${edit?.body}`);
  ok(openLists(h.store).length === 1 && openLists(h.store)[0].refused.join() === '1', 'and stays open for another pick');
  ok(h.logs.some((l) => /^info pick list: John Wick: Chapter 2 \(2017\), rated R, was offered for the AI check to clear, and it did not/.test(l))
    && !h.logs.some((l) => /they disagree/.test(l)), 'logged as expected, not as a disagreement');

  mark = h.out.length;
  await send(h, '3', TESTING);
  after = since(h.out, mark);
  ok(aiAsks.length === 2 && /Parabellum/.test(aiAsks[1]), 'picking 3 asks about that film');
  ok(sent(h) === 'John Wick: Chapter 3 - Parabellum (2019)' && after.some((e) => e.op === 'react' && e.emoji === '✅')
    && texts(after).some((e) => /^✅ \*Test passed\* \(\$beta004\)\n\nThe bot would send \*John Wick: Chapter 3 - Parabellum\* \(2019\)/.test(e.body)),
  `it is cleared, and the test passes (${sent(h)})`);
  ok(row(h.store, req.id)?.aiCleared, 'History says the AI check cleared it');
  aiVerdict = () => ({ nudity: false, confidence: 0.9, basis: 'violence only' });
}
{
  // A film its rating allows is listed and sent as before: nothing is asked.
  aiAsks.length = 0;
  const h = harness(withAi(config()));
  await send(h, '#request cars', TESTING);
  ok(listFilms(listBody(h)).join('|') === '1 Cars (2006)|2 Cars 2 (2011)|3 Cars 3 (2017)'
    && openLists(h.store)[0]?.items.every((it) => !it.via), 'with the AI check on, a G-rated series is listed as it always was');
  await send(h, '2', TESTING);
  ok(sent(h) === 'Cars 2 (2011)' && aiAsks.length === 0, 'and the pick passes with no question to the AI');
}
{
  // The AI check off: the rating decides, as before, and only the bypass
  // list can put a rated film on a list.
  const h = harness(config());
  await send(h, '#request john wick', TESTING);
  ok(!listBody(h) && h.out.at(-1).emoji === '⛔', 'AI off: four R films, no list, and the refusal the request always got');
  const store = fakeStore({ 'rating-overrides': [
    { key: 't:john wick|2014', title: 'John Wick', year: 2014 },
    { key: 't:john wick chapter 4|2023', title: 'John Wick: Chapter 4', year: 2023 },
  ] });
  const b = harness(config(), store);
  await send(b, '#request john wick', TESTING);
  ok(listFilms(listBody(b)).join('|') === '1 John Wick (2014)|2 John Wick: Chapter 4 (2023)'
    && openLists(store)[0]?.items.every((it) => it.via === 'bypass'), `AI off: the two on the bypass list are listed:\n${listBody(b)}`);
  await send(b, '2', TESTING);
  ok(sent(b) === 'John Wick: Chapter 4 (2023)' && aiAsks.length === 0, 'and one picked passes with no AI check');
}

/* ============ 2026-10-10: the list was Off because a setting was lost ============ */
// The live config.json held `beta.features: {}` - what a rebuilt box or a
// restored config has - so the flag 'movie-pick-list' read Off, although the
// operator had taken the list out of beta. These real requests were each
// answered "which year?" (need-year, the 📅 of step 4a) instead of the list:
//
//   "Heat"                2 copies: 1995, 2013               20:16:53
//   "Insomnia"            2 copies: 1997, 2002               20:12:28
//   "Casino Royale"       2 copies: 1967, 2006               06:42:15
//   "The girl next door"  2 copies: 2004, 2007               16:03:05
//   "venom"               4 copies: 1981, 2005, 2011, 2018   17:41:54
//
// The operator, 2026-10-11: "for insomnia and heat (and all others with same
// name different years) we already moved that the bot should respond listing
// all out of beta, so why didn't it work for those?" The list is no longer a
// setting. The live bot runs the AI check with leave to clear a rated film,
// which is how the R copies reached the year question at all, so it is on
// here too.

console.log('=== 2026-10-10: with an EMPTY beta config, a title the library holds in several versions gets the list, not need-year ===');
{
  const empty = (features = {}) => withAi(config({ beta: { groups: [], postsGroup: '', features } }));
  ok(JSON.stringify(empty().beta) === JSON.stringify(DEFAULT_CONFIG.beta),
    'the beta section is exactly an untouched install\'s: no groups, no posts group, no features');
  const CASES = [
    ['Heat', ['Heat (1995)', 'Heat (2013)']],
    ['Insomnia', ['Insomnia (1997)', 'Insomnia (2002)']],
    ['Casino Royale', ['Casino Royale (1967)', 'Casino Royale (2006)']],
    ['The girl next door', ['The Girl Next Door (2004)', 'The Girl Next Door (2007)']],
    ['venom', ['Venom (1981)', 'Venom (2005)', 'Venom (2011)', 'Venom (2018)']],
  ];
  const offered = (h, m) => listFilms(texts(h.out).find((e) => e.jid === MAIN_REQ && e.quoted === m.id)?.body)
    .map((f) => f.replace(/^\d+ /, ''));
  for (const [typed, films] of CASES) {
    const h = harness(empty());
    const m = await send(h, `#request ${typed}`, MAIN_REQ);
    ok(row(h.store, m.id)?.status === 'pick-list' && offered(h, m).join('|') === films.join('|'),
      `"${typed}": a list of all ${films.length} in the request group (${offered(h, m).join(', ')}), not need-year`);
    ok(!h.out.some((e) => e.emoji === '📅') && !texts(h.out).some((e) => e.jid === MAIN_NOTIFY) && !h.jobs.length,
      '   no 📅, no "add a year" note, and nothing queued until a number is given');
  }
  {
    // What the incident's rows were, word for word: step 4a, reached when
    // step 0 does not run. It still is the answer when step 0 cannot search
    // the library, which pins that this - and only this - is what changed.
    const h = harness(empty());
    failStep0Search();
    const m = await send(h, '#request Heat', MAIN_REQ);
    onLibrarySearch = null;
    ok(row(h.store, m.id)?.status === 'need-year' && row(h.store, m.id)?.detail === '2 copies: 1995, 2013',
      `without step 0, "Heat" ends as the incident's row did: need-year, "${row(h.store, m.id)?.detail}"`);
  }
  {
    // Answered in the main group, the pick is a real request: the AI check is
    // asked about the one film picked, and it is queued.
    aiAsks.length = 0;
    const h = harness(empty());
    const m = await send(h, '#request Heat', MAIN_REQ);
    await send(h, '1', MAIN_REQ);
    ok(h.jobs.length === 1 && h.jobs[0].label === 'Heat (1995)' && aiAsks.length === 1 && /Heat/.test(aiAsks[0]),
      `"1" queues Heat (1995), the AI check asked about it alone (${h.jobs.map((j) => j.label).join()})`);
    ok(row(h.store, m.id)?.pickList?.outcome === 'picked' && !row(h.store, m.id)?.beta, 'History: picked, a main request');
  }
  // A config.json from before the flag went can still hold a mode for it.
  // Neither of the two that kept the list out of a main group does now.
  for (const mode of ['off', 'beta']) {
    const h = harness(empty({ 'movie-pick-list': mode }));
    const m = await send(h, '#request Insomnia', MAIN_REQ);
    ok(row(h.store, m.id)?.status === 'pick-list' && offered(h, m).join('|') === 'Insomnia (1997)|Insomnia (2002)',
      `with a stale 'movie-pick-list': '${mode}' left in config.json, Insomnia still gets the list`);
  }
}

/* ===================== picks by reaction (2026-10-01) ===================== */
// The operator: "for beta001 users should be able to react with a number
// emoji instead of replying". A keycap reacted on the list's own message is
// the number typed - first pick wins, a wrong or refused number gets ❓, and
// form 'reaction' in History. These run the whole pipeline; the rest (bot.js,
// the transcript, the pause, who and where) is test/reaction-pick.test.mjs.
const reactTo = async (h, emoji, targetId, who = ALICE, chat = TESTING) => {
  const m = { ...mkMsg('', chat, who), messageType: 'reactionMessage', reaction: { emoji, targetId, targetFromMe: true } };
  await moviePlugin.onMessage(m, h.ctx);
  await settle();
  return m;
};
const listIdOf = (h) => (h.store.get('pickLists', []) ?? [])[0]?.listKey?.id;

console.log('=== [reaction] a number reacted on the list runs the pick on the ORIGINAL request ===');
{
  const h = await withList();
  ok(/Reply with a number \(1–3\), or react with it, to test it\./.test(listBody(h) ?? ''), 'the list says a number can be reacted');
  const r = await reactTo(h, '2️⃣', listIdOf(h));
  const after = since(h.out, h.mark);
  ok(sent(h) === 'Venom (2011)' && h.jobs.length === 0, '2️⃣ passes the 2nd version - Venom (2011) - and, a test, nothing is queued');
  ok(after.filter((e) => e.op === 'react').every((e) => e.on === h.req.id) && !after.some((e) => e.on === r.id),
    'every reaction lands on the original request, none on the reaction');
  ok(after.find((e) => e.op === 'edit')?.body === '✔ 2 · Venom (2011) — test passed, nothing sent', 'the list is ticked');
  const q = row(h.store, h.req.id);
  ok(q.status === 'test-passed' && q.pickList.picked === 2 && q.pickList.form === 'reaction', 'History: test-passed, picked 2, by reaction');
  ok(h.logs.some((l) => /picked 2 \(reacted 2️⃣, reaction\)/.test(l)), 'and the log says how it was picked');
  const n = h.out.length;
  await reactTo(h, '3️⃣', listIdOf(h));
  await send(h, '1', TESTING);
  ok(h.out.length === n && sentCount(h) === 1, 'a later reaction or number is ignored: the first pick won');
}
{
  // A main group, with no beta flag at all: the film is queued for real.
  const h = harness(config());
  const req = await send(h, '#request Venom', MAIN_REQ);
  await reactTo(h, '3⃣', listIdOf(h), ALICE, MAIN_REQ);
  ok(h.jobs.length === 1 && h.jobs[0].label === 'Venom (2018)', 'in a main group 3⃣ (no variation selector) queues Venom (2018)');
  ok(h.out.filter((e) => e.op === 'react').every((e) => e.on === req.id), 'its reactions on the request');
  ok(!h.out.some((e) => e.jid === TESTING), 'nothing in the beta group');
}

// The ❓ went on the request at first, where the groups' legend says it
// means "Couldn't match that title" and the beta scan read a code not taken
// (review, 2026-10-01): it goes on the list, beside the reacted number.
console.log('=== [reaction] a refused version, and a wrong number, get ❓ on the list, beside it ===');
{
  const h = await withList({}, 'Carrie');
  await reactTo(h, '1️⃣', listIdOf(h));
  ok(since(h.out, h.mark).some((e) => e.op === 'react' && e.on === h.req.id && e.emoji === '⛔')
    && openLists(h.store)[0]?.refused.join() === '0', 'Carrie 1976 is refused (⛔ on the request) and struck through; the list stays open');
  const m1 = h.out.length;
  const again = await reactTo(h, '1️⃣', listIdOf(h));
  const said = since(h.out, m1);
  ok(said.length === 1 && said[0].on === listIdOf(h) && said[0].emoji === '❓' && !said.some((e) => e.on === again.id || e.on === h.req.id),
    'reacting 1️⃣ again: one ❓, on the list - never on the reaction, and not on the request, whose ⛔ stands');
  const m2 = h.out.length;
  await reactTo(h, '7️⃣', listIdOf(h));
  ok(since(h.out, m2).map((e) => `${e.on}:${e.emoji}`).join() === `${listIdOf(h)}:❓` && openLists(h.store).length === 1,
    '7️⃣ on a 3-item list: ❓ on the list, the list stays open');
  const m3 = h.out.length;
  await reactTo(h, '2️⃣', listIdOf(h));
  ok(sent(h) === 'Carrie (2002)' && row(h.store, h.req.id).pickList.form === 'reaction', 'and 2️⃣ still works: Carrie (2002)');
  ok(since(h.out, m3).some((e) => e.op === 'react' && e.on === listIdOf(h) && e.emoji === ''), 'taking the ❓ back off the list');
}

console.log('=== [reaction] a list longer than ten: 1️⃣ to 🔟 react, 11 on are typed ===');
{
  const h = harness(config());
  const req = await send(h, '#request cinderella', TESTING);
  const body = listBody(h) ?? '';
  ok(body.endsWith('Reply with a number (1–12) to test it, or react 1️⃣–🔟 for one of the first ten. Nothing is downloaded. '
    + 'This list expires in 10 minutes.'), `the footer says reacting covers the first ten:\n${body.split('\n\n').at(-1)}`);
  const tenth = listFilms(body)[9]?.replace(/^10 /, '');
  await reactTo(h, '🔟', listIdOf(h));
  ok(sent(h) === tenth && row(h.store, req.id).pickList.picked === 10, `🔟 picks the 10th: ${tenth}`);
  const g = harness(config());
  await send(g, '#request cinderella', TESTING);
  await send(g, '11', TESTING);
  ok(row(g.store, (g.store.get('pickLists') ?? [])[0]?.id)?.pickList.picked === 11, '11 is typed, as ever');
}

console.log('=== [reaction] a $stamtest\'s list is answered by reacting on its one answer ===');
{
  // A $stamtest opens its list inside the capture (stam-test.js), so the list
  // is never posted: what the tester sees is the one answer the plugin
  // manager sends, with the list in it, and that is where they react.
  //
  // With no beta feature switched on: a $stamtest judges as a main group
  // would, and since 2026-10-11 every main group gets the list, so the list
  // is in the answer with no mode set for it anywhere.
  const h = harness(config({ beta: { features: {} } }));
  const b = h.ctx.bot;
  for (const [name, kind] of [['sendText', 'text'], ['react', 'react'], ['editText', 'edit']]) {
    const real = b[name];
    b[name] = async (...a) => stamIntercept(kind, { jid: a[0]?.chatJid ?? a[0], text: typeof a[1] === 'string' ? a[1] : a[2], emoji: a[1] })
      ?? real.apply(b, a);
  }
  const pm = new PluginManager({ bot: b, configStore: { get: () => h.ctx.config }, stateStore: null });
  pm.plugins.set('movie-requests', { plugin: moviePlugin, ctx: h.ctx });
  const req = mkMsg('$stamtest #request venom', TESTING);
  await pm.dispatchMessage(req);
  await settle();
  const answer = texts(h.out).find((e) => /Stam test/.test(e.body));
  const list = (h.store.get('pickLists', []) ?? [])[0];
  ok(answer && /Search results for "venom"/.test(answer.body) && /or react with it/.test(answer.body),
    'the $stamtest\'s one answer carries the list, and says a number can be reacted');
  // The answer is the only message really sent, so the fake WhatsApp gave it the first id.
  ok(list?.id === req.id && /^stam-/.test(list.listKey.id) && list.listIds?.join() === 'BOT1',
    `the list journalled under the tester's message takes the answer as one of its own (${JSON.stringify(list?.listIds)})`);
  await reactTo(h, '2️⃣', list?.listIds?.[0]);
  ok(sent(h) === 'Venom (2011)' && row(h.store, req.id)?.pickList?.form === 'reaction', '2️⃣ on that answer picks Venom (2011), by reaction');
}

console.log('=== no real network was touched ===');
ok(netCalls.every((u) => u.includes('omdbapi.com') || u.startsWith('http://jf.test')
  || u.startsWith('https://generativelanguage.googleapis.com/')), 'every call went to a stubbed host');

moviePlugin.teardown();
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
