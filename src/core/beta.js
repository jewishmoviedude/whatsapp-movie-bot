/**
 * Beta testing: feature flags, and a test group that is walled off from the
 * real ones.
 *
 * The bot serves a movie posts group of nearly 800 people. A group-facing
 * change that misbehaves there is seen by all of them at once, and some
 * mistakes (a film posted to the wrong group, a notification that tags the
 * wrong person) cannot be taken back. So a new behaviour is switched on in a
 * small test group first - the operator's "Testing things" group - and only
 * reaches the main groups once it has been watched working on the real flow.
 *
 * Two pieces, deliberately independent:
 *
 *   1. A REGISTRY of features that can be staged. Each has a mode: 'off'
 *      (nowhere), 'beta' (only in beta groups) or 'on' (everywhere). Code asks
 *      isEnabled(config, key, groupJid) at the point where it decides.
 *
 *   2. ISOLATION. A request that starts in a beta group is handled as a full
 *      request - movies and TV - but everything it produces stays inside the
 *      beta groups: the replies, the play-by-play, the tags. That is the whole
 *      point. A test that can leak into the 800-member group is not a test.
 *
 *   3. TEST MODE (2026-09-29). A message in a beta group is a test only when
 *      it starts with the code of a feature being tested - "$beta001 #request
 *      harry potter" - and anything else there is ignored: "if someone
 *      requests a regular movie like captain Phillips it should be ignored
 *      because it's not the beta" (the operator). And a test never downloads
 *      anything. It runs every check a real request would, and where a real
 *      request would be queued it answers "✅ Test passed" instead: "as soon
 *      as bot can confirm it will download it should basically be like "test
 *      passed" and not actually queue a download of the file interrupting
 *      actual requests". So nothing is delivered from a beta group any more;
 *      the beta posts group and the delivery half of a route (resolveRoute,
 *      safeRoute) are kept only for jobs journalled before that, and for the
 *      config.json that still names them.
 *
 * Everything here is pure: no WhatsApp, no disk. With an untouched config
 * (no beta groups, no features) every function answers the way the bot behaved
 * before this existed. The three features in the registry are On by default
 * since 2026-10-12, the operator's live modes, but only on a new install: a
 * config.json saved before then gets every feature it never named as Off
 * when it is loaded (keepSavedChoices in src/config/store.js), which is what
 * keeps the upgrade a no-op.
 */
import { parseTvRequest } from '../plugins/tv-requests/parse.js';
import { readStamTest, STAM_CODE } from './stam-test.js';

/**
 * Features that can be staged through the beta group.
 *
 * Nothing existing was moved behind a flag. A new group-facing feature adds
 * itself here, reads isEnabled() where it decides, and is promoted
 * Off -> Beta -> On from the panel. Once it has been On for a while its entry
 * and the dead branch are deleted - a flag nobody will ever turn off again is
 * just a second code path to keep working.
 *
 * Give every feature a key of its own and never reuse a retired one: the
 * retired key's last mode stays in config.json until the next beta save clears
 * it (see normalizeBetaPatch), and a reused key would inherit it.
 *
 * Every feature also has a number, beta001, beta002 and so on: the operator
 * names features to the testers by it, and it is on the testers' guide the
 * panel downloads (testersGuide below). Give a new feature the next number
 * after the highest ever used, which RETIRED_CODES remembers once a feature
 * is deleted - a reused number would make an old guide in a group chat
 * describe the wrong feature.
 *
 * `howTo` is written for the group members testing it, not for the operator:
 * what to send, and what they should see. `description` is the operator's.
 * `example` is a request to try it with, which the testers' guide puts after
 * the code and the group's prefix ("$beta004 #request minority report 2002").
 *
 * Shape: { key, code, label, description, howTo, example, scope: 'movie' | 'tv' | 'all' }
 */
export const RETIRED_CODES = [
  // TV place in line, key 'tv-queue-positions'. It was put on Beta without
  // the operator asking, when all it did was bring the movie group's number
  // reactions to the TV group: "if it's always worked in the movie group why
  // would it need to go to beta? I didn't instruct you to make that a beta"
  // (2026-09-29). It is always on now. Neither the number nor the key may be
  // used again: an old testers' guide in a group chat still names beta002,
  // and config.json can still hold the key's last mode (see above).
  'beta002',
  // "Movies with series", the "which one?" pick list, key 'movie-pick-list'
  // (src/plugins/movie-requests/pick-list.js). The operator had moved it out
  // of beta, On for everyone, but on 2026-10-10 the live config.json held
  // `beta.features: {}` - a mode a rebuilt box or a restored config does not
  // keep - so it was Off, and Heat (1995, 2013), Insomnia (1997, 2002),
  // Casino Royale (1967, 2006), The Girl Next Door (2004, 2007) and Venom
  // (1981, 2005, 2011, 2018) were each answered "which year?" instead of
  // with the list. The operator, 2026-10-11: "for insomnia and heat (and all
  // others with same name different years) we already moved that the bot
  // should respond listing all out of beta, so why didn't it work for
  // those?" It is no longer a setting at all: every request group gets the
  // list. The number stays retired - testers' guides in group chats still
  // name beta001 - and so does the key, whose mode config.json can still hold.
  'beta001',
];

export const FEATURES = [
  {
    // src/plugins/tv-requests/withheld.js, and the rating gate in
    // tv-requests/index.js. A member asked for Fullmetal Alchemist:
    // Brotherhood season 1, got 61 of 64 episodes with no word about 14, 19
    // and 26 (rated TV-MA), and read it as a fault. New and reworded text in
    // the notifications group, and new replies in the request group, so it
    // goes through the beta group first. History names the withheld episodes
    // whatever the mode.
    key: 'tv-rating-notice',
    code: 'beta003',
    label: 'TV episodes withheld on rating',
    howTo: 'Ask for a season where some episodes are rated too high to be posted. The ✅ Test passed answer '
      + 'says how many episodes would be sent, and which were left out and why - for example "Episodes 14, '
      + '19 and 26 are rated TV-MA, which can\'t be posted" - instead of just counting fewer episodes. A '
      + 'request where nothing can be posted gets ⛔ and a line saying the rating.',
    example: 'Fullmetal Alchemist Brotherhood season 1',
    description: 'When the rating filter leaves episodes out of a TV request, the "added to the queue" line '
      + 'names them and the rating ("61 of 64 episodes added to the queue. Episodes 14, 19 and 26 are rated '
      + 'TV-MA, which can\'t be posted, so they were left out."). A request with nothing left to send - one '
      + 'TV-MA episode, or a show rated as a whole - gets "⛔ ... rated TV-MA, can\'t be posted" where a refused '
      + 'film\'s goes, as well as the ⛔. With "Also send a text reply when blocking" on, both are also quoted '
      + 'replies in the request group. Off: the bare line, which names only the episodes queued ("S01E01–E13, '
      + 'E15–E18, E20–E25, E27–E64 — 61 of season 1"), and a bare ⛔. Reaches a main group only when a queue '
      + 'notifications group is set or that reply is on.',
    scope: 'tv',
  },
  {
    // src/plugins/movie-requests/index.js, _duplicateFilm. "minority report
    // 2002" was asked for three times on 2026-09-28 while the first copy was
    // still being made, and every one was queued. A film already waiting is
    // no longer queued again whatever the mode - that is the fix - and History
    // says "duplicate"; only the reworded line in the notifications group is
    // staged here.
    key: 'movie-duplicate-notice',
    code: 'beta004',
    label: 'Film asked for twice',
    howTo: 'Ask for a film that is already waiting in the real queue or being made (the queue on the '
      + 'bot\'s status, or one a member asked for a moment ago). It is not added a second time: your '
      + 'message gets 🤥 and the group is told it is already in the queue. Anything else gets ✅ Test passed.',
    example: 'minority report 2002',
    // The member it is waiting for, asking again, is not a duplicate since
    // 2026-10-11 (_resentFilm: Iron Man 3, a restart's 🔄 read as "send it
    // again", then 🤥 for doing so), and the card says so.
    description: 'A film asked for while it is already waiting or in progress for the same group is not queued '
      + 'a second time, whatever this is set to; the requester gets 🤥 and History marks the request "duplicate" - '
      + 'unless it is their own request, sent again, which shows where it is and is marked "resent". '
      + 'This decides what the notifications group is told: "🤥 Minority Report (2002) — already in the queue, '
      + 'not added again". Off: the "— added to the queue" line an accepted film gets, as before.',
    scope: 'movie',
  },
  {
    // src/plugins/tv-requests/index.js, the duplicate check in onMessage.
    // "Loki season 1" and "the mentalist S03E05" were each queued twice on
    // 2026-09-28. Episodes already waiting are no longer queued again
    // whatever the mode - that is the fix - and History says "duplicate";
    // only the new wording in the notifications group is staged here, as the
    // film's is (movie-duplicate-notice).
    key: 'tv-duplicate-notice',
    code: 'beta005',
    label: 'TV asked for twice',
    howTo: 'Ask for a TV season or episode that is already waiting in the real queue or being sent. It is '
      + 'not added a second time: your message gets 🤥. If only part of what you asked for is already '
      + 'waiting, the ✅ Test passed answer counts only the rest, and says how many more are waiting.',
    example: 'Loki season 1',
    description: 'Episodes asked for while they are already waiting or in progress for the same group are not queued '
      + 'a second time, whatever this is set to; a request with nothing new gets 🤥 and History marks it "duplicate" - '
      + 'unless it is the member\'s own request, sent again, which shows where it is and is marked "resent". '
      + 'This decides what the notifications group is told: "🤥 Loki season 1 — already in the queue, not added '
      + 'again", and for a request that is partly waiting "… — 23 episode(s) — added to the queue (1 more already '
      + 'waiting)". Off: the "— N episode(s) — added to the queue" line the whole request would have got, as before.',
    scope: 'tv',
  },
];

export const MODES = ['off', 'beta', 'on'];

const SCOPES = ['movie', 'tv', 'all'];

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * A WhatsApp group id. Beta testing only ever deals in groups: a beta posts
 * group that named a person would deliver films into a private chat, and
 * unsolicited PMs are the clearest ban signal there is (docs/whatsapp-ban-risk.md).
 */
const isGroupJid = (j) => /@g\.us$/.test(j);

/**
 * The beta section of the config, always in a usable shape.
 *
 * Anything that is not a group id is ignored here as well as refused on save,
 * because config.json can be edited by hand and this is what every routing
 * decision reads.
 */
export function betaConfig(config) {
  const b = config?.beta ?? {};
  const posts = str(b.postsGroup);
  return {
    groups: [...new Set((Array.isArray(b.groups) ? b.groups : []).map(str).filter(isGroupJid))],
    postsGroup: isGroupJid(posts) ? posts : '',
    features: (b.features && typeof b.features === 'object' && !Array.isArray(b.features)) ? b.features : {},
  };
}

/**
 * Every group the MAIN service uses, with what it is used for.
 *
 * Read regardless of whether a section is switched on: a disabled TV section's
 * posts group is still a room full of real people, and switching TV on later
 * is a checkbox, not a config review. Direct-links groups are here for the
 * same reason, even though that plugin has no beta path of its own.
 */
export function mainGroupRoles(config) {
  const out = new Map();
  const add = (jid, role) => {
    const j = str(jid);
    if (j && !out.has(j)) out.set(j, role);
  };
  const mr = config?.movieRequests ?? {};
  const tv = config?.tvRequests ?? {};
  const dl = config?.directLinks ?? {};
  for (const j of mr.requestGroups ?? []) add(j, 'movie request group');
  add(mr.postsGroup, 'movie posts group');
  for (const j of mr.postsGroups ?? []) add(j, 'movie posts group');
  add(mr.notify?.group, 'queue notifications group');
  for (const j of tv.requestGroups ?? []) add(j, 'TV request group');
  add(tv.postsGroup, 'TV posts group');
  for (const j of tv.postsGroups ?? []) add(j, 'TV posts group');
  for (const j of dl.groups ?? []) add(j, 'direct-links group');
  return out;
}

/**
 * Is this chat a beta group?
 *
 * A group that is ALSO used by the main service is never treated as beta, even
 * if it was ticked in the beta list. Which way round a conflict resolves is a
 * safety decision: treating a main request group as beta would send its films
 * to the beta posts group (or back into the request group itself) and trial
 * unfinished features on hundreds of people. Treating it as main costs only
 * the test. The panel refuses to save that overlap and warns if the main side
 * later creates it; this is the belt to that pair of braces.
 */
export function isBetaGroup(config, jid) {
  const j = str(jid);
  if (!j) return false;
  if (!betaConfig(config).groups.includes(j)) return false;
  return !mainGroupRoles(config).has(j);
}

/** Registry lookup. Tests pass their own registry; the bot uses FEATURES. */
function findFeature(key, registry = FEATURES) {
  return (registry ?? []).find((f) => f?.key === key) ?? null;
}

/**
 * 'off' | 'beta' | 'on' for a feature.
 *
 * Anything not in the registry is 'off', whatever the config says. A key left
 * behind in config.json after its feature was deleted, or typed wrongly, must
 * not switch anything on.
 */
export function featureMode(config, key, registry = FEATURES) {
  if (!findFeature(key, registry)) return 'off';
  const mode = betaConfig(config).features[key];
  return MODES.includes(mode) ? mode : 'off';
}

/**
 * Should this feature run for a message in this group?
 *
 * Call it at INTAKE - in onMessage, while the message is being handled - with
 * the chat the request CAME FROM, not the group the result will be posted to.
 * 'on' is everywhere; 'beta' is only in a beta group; 'off' is nowhere.
 *
 * Anything decided after the request is queued (in deliver(), a caption, a
 * post format) uses isEnabledForJob instead.
 */
export function isEnabled(config, key, groupJid, registry = FEATURES) {
  const mode = featureMode(config, key, registry);
  if (mode === 'on') return true;
  if (mode === 'beta') return isBetaGroup(config, groupJid);
  return false;
}

/**
 * The group a request's feature questions are asked for (isEnabled): the one
 * it came from, except for a $stamtest, which is asked as a main group asks -
 * no group, so a feature on Beta does not apply and one that is On does
 * (stam-test.js). Everything else about it stays a test: its route, and
 * that nothing is sent.
 */
export function featureGroup(msg) {
  return msg?.stam ? null : (msg?.chatJid ?? null);
}

/**
 * The same question for a job that is already queued, answered from the route
 * it was given on arrival rather than from which groups are beta NOW.
 *
 * A job can wait hours. If the operator moves a main request group onto the
 * beta list in that time, isEnabled() would call its waiting main jobs beta
 * and run an unfinished feature on a delivery to the real posts group - while
 * the job itself still posts there, because main jobs follow the live main
 * config. The route on the record is what says where a job is going, so it is
 * also what says whether it is a test. A panel-queued job has no message and
 * no route, and is main.
 *
 * The MODE is still read live, on purpose: Off is the kill switch, and it has
 * to stop a misbehaving feature on jobs that are already waiting.
 */
export function isEnabledForJob(config, key, route, registry = FEATURES) {
  const mode = featureMode(config, key, registry);
  if (mode === 'on') return true;
  if (mode === 'beta') return !!route?.beta;
  return false;
}

/**
 * A beta group takes movie AND TV requests, so each message has to be claimed
 * by exactly one plugin - both answering "The Boys season 1" would look it up
 * as a film and as a show, react twice and possibly send twice.
 *
 * TV takes a message only when it names a SEASON ("season 2", "S02",
 * "S01E03", "1x03"); everything else is a movie. A bare show name is therefore
 * a movie request, and the movie plugin's "that is a series" check tells the
 * requester to name a season. That is also the answer "The Office episode 4"
 * gets in the beta group; the TV plugin can only place an episode with no
 * season in a show that has a single season, so little is lost there.
 *
 * Two film shapes are why it is that strict. The TV parser reads "s 12" as
 * season 12, so "Ocean's 12", "Ocean's 8" and "Bill & Ted's 3" came out as
 * seasons of a show called "Ocean'" - the possessive is folded away first. And
 * "Star Wars Episode 4" is an episode marker with no season, which sent a film
 * request to the TV plugin to fail as "no series matching". In a main movie
 * group both are films and work, and the beta group is only a test of the
 * real flow if it does the same.
 *
 * With the TV section switched off every message is the movie plugin's,
 * exactly as in a main movie group.
 */
export function betaRequestKind(config, text) {
  if (!config?.tvRequests?.enabled) return 'movie';
  return namesSeason(text) ? 'tv' : 'movie';
}

/** Does this request name a season? Possessives folded first - see betaRequestKind. */
function namesSeason(text) {
  const unpossessed = String(text ?? '').replace(/(\w)['’‘`´]s\b/gi, '$1s');
  return parseTvRequest(unpossessed).season != null;
}

/**
 * The features a tester can name now: those on Beta or On. A feature that is
 * Off, or retired, is not being tested, and its code gets ❓ with this list.
 */
export function runningTests(config, registry = FEATURES) {
  return (registry ?? []).filter((f) => f?.key && f.code && !RETIRED_CODES.includes(f.code)
    && featureMode(config, f.key, registry) !== 'off');
}

/** "Running tests: $beta003, $beta004", or that nothing is. */
export function runningTestsLine(config, registry = FEATURES) {
  const codes = runningTests(config, registry).map((f) => `$${f.code}`);
  return codes.length ? `Running tests: ${codes.join(', ')}` : 'No tests are running right now.';
}

/**
 * A message in a beta group, read as a test - or as nothing.
 *
 * The operator (2026-09-29): "people on the group should need to prefix
 * $beta001 #request-movie harry potter if someone requests a regular movie
 * like captain Phillips it should be ignored because it's not the beta". So
 * a message is a test only when its first word is `$betaNNN` (any case) and
 * names a feature on Beta or On. The rest is the request as a member would
 * type it anywhere - the group's own prefix rules apply to it - or one of the
 * operator's two explicit forms, `#request-movie <title>` and `#request-tv
 * <show and season>`, which say which kind it is and count as the prefix.
 *
 * The kind: what the explicit form says; else the feature's scope when it is
 * movies or TV; else, for a feature of both, betaRequestKind (a season named
 * is TV). A request that plainly asks for the other kind than the feature
 * tests - "$beta004 The Office S01" - is told so, not looked up as a film.
 *
 * Every plugin sees every message, so this is pure and each asks it: TV takes
 * outcome 'tv', and the movie plugin everything else - including the answers
 * that are not requests, so a message is answered once.
 *
 *   { outcome: 'ignore' }                                no code: not a test
 *   { outcome: 'unknown', typed, why, running }          a code nothing is tested under
 *   { outcome: 'wrong-kind', code, feature, running }    the other kind than the feature's
 *   { outcome: 'tv-off', code, feature }                 a TV test with TV switched off
 *   { outcome: 'movie' | 'tv', code, feature, body, forced }
 */
export function readBetaTest(config, text, registry = FEATURES) {
  const said = String(text ?? '').trim();
  // One test per message, $stamtest lines counted with the $beta ones (see
  // below, and stam-test.js).
  const lines = said.split(/\r?\n/).filter((l) => /^\s*\$(?:beta|stamtest(?!\w))/i.test(l));
  // $stamtest: any request, judged as a main group would judge it, with the
  // features that are On and no other (stam-test.js). It belongs to no
  // feature, so it is never "not a test"; like any test it sends nothing.
  const stam = readStamTest(said);
  if (stam) {
    if (lines.length > 1) return { outcome: 'several', count: lines.length, running: runningTests(config, registry) };
    const f = /^#request-(movie|tv)\b\s*([\s\S]*)$/i.exec(stam.body);
    const forced = f ? f[1].toLowerCase() : null;
    const body = f ? f[2].trim() : stam.body;
    const kind = forced ?? betaRequestKind(config, body);
    if (kind === 'tv' && !config?.tvRequests?.enabled) return { outcome: 'tv-off', code: STAM_CODE, feature: null, stam: true };
    return { outcome: kind, code: STAM_CODE, feature: null, stam: true, body, forced: !!forced };
  }
  // The digits first, with any punctuation stuck to them dropped: a tester
  // who typed "$beta001: harry potter" used to be told "❓ $beta001: is not a
  // test. Running tests: $beta001, ..." - the code they typed, listed as
  // running. The loose form is only for naming a code that is not one.
  const m = /^\$beta(\d{1,6})(?!\w)[\s:,.;-]*([\s\S]*)$/i.exec(said)
    ?? /^\$beta(\S*)\s*([\s\S]*)$/i.exec(said);
  // Only "$beta..." is a try at a code: "$20 for the lot?" is chatter.
  if (!m) return { outcome: 'ignore' };
  // One test per message. 2026-09-30, 05:27: a tester pasted three example
  // lines as one message ("$beta001 #request harry potter" and two more), it
  // was read as one request for all of them, the AI title lookup guessed John
  // Wick from the jumble, and none of the three tests ran. A second line that
  // starts with a code is answered, not guessed at.
  if (lines.length > 1) return { outcome: 'several', count: lines.length, running: runningTests(config, registry) };
  const typed = `$beta${m[1]}`;
  const n = /^0*(\d{1,6})$/.exec(m[1]);
  const code = n ? `beta${n[1].padStart(3, '0')}` : null;
  const feature = code ? (registry ?? []).find((f) => f?.code === code) ?? null : null;
  const retired = !!code && RETIRED_CODES.includes(code);
  if (!feature || retired || featureMode(config, feature.key, registry) === 'off') {
    return {
      outcome: 'unknown', typed: code ? `$${code}` : typed, code,
      why: retired ? 'retired' : feature ? 'off' : 'unknown',
      running: runningTests(config, registry),
    };
  }
  const rest = m[2].trim();
  const f = /^#request-(movie|tv)\b\s*([\s\S]*)$/i.exec(rest);
  const forced = f ? f[1].toLowerCase() : null;
  const body = f ? f[2].trim() : rest;
  const scope = SCOPES.includes(feature.scope) ? feature.scope : 'all';
  const asked = forced ?? (namesSeason(body) ? 'tv' : null);
  if (scope !== 'all' && asked && asked !== scope) {
    return { outcome: 'wrong-kind', code, feature, running: runningTests(config, registry) };
  }
  const kind = scope !== 'all' ? scope : (forced ?? betaRequestKind(config, body));
  if (kind === 'tv' && !config?.tvRequests?.enabled) return { outcome: 'tv-off', code, feature };
  return { outcome: kind, code, feature, body, forced: !!forced };
}

/**
 * The request text of a test, for the plugin that takes it: the words after
 * the code, with the plugin's own prefix in front whenever the group needs
 * one and the tester left it out, so the prefix rule, moderation and the pick
 * list's "#request 2" all read it as they would in a main group.
 *
 * An explicit `#request-movie` / `#request-tv` stands for that prefix, and so
 * does the code itself: "$beta001 harry potter" is plainly a request. Before
 * that was so, the prefix rule dropped it without a word, and with
 * "delete non-requests" on, moderation deleted it and sent the tester a DM
 * quoting "harry potter" and saying to send "#request harry potter" - which
 * has no code, so the beta group then ignored it too.
 */
export function testRequestText(test, pluginCfg) {
  const body = String(test?.body ?? '').trim();
  const p = pluginCfg?.requirePrefix ? String(pluginCfg.prefix ?? '').trim() : '';
  if (!p) return body;
  if (!test?.forced && body.toLowerCase().startsWith(p.toLowerCase())) return body;
  return `${p} ${body}`;
}

/**
 * The code to suggest for a test of the other kind: `preferred` when its
 * feature covers `kind`, else the first test running that does, else null.
 * A film test answered "that is a series, ask for a season" needs a TV code
 * in its example - "$beta004 The Office season 1" is answered "$beta004
 * tests movies", a dead end of its own.
 */
export function testCodeFor(config, kind, preferred = null, registry = FEATURES) {
  const running = runningTests(config, registry);
  const fits = (f) => f.scope === kind || !SCOPES.includes(f.scope) || f.scope === 'all';
  const mine = running.find((f) => f.code === preferred);
  if (mine && fits(mine)) return mine.code;
  return running.find(fits)?.code ?? null;
}

/**
 * The prefix to put in a line the bot suggests sending - "Send #request Venom
 * 2018", "e.g. #request John Wick Chapter 2", "which season? Send e.g.
 * #request The Office season 1" - with the test's code in front when the
 * request is a test. A tester who copied the line as it was worded for a main
 * group sent a message with no code, which the beta group ignores: the
 * operator's own rule, turned against a tester doing what the bot said.
 *
 * A test asked under a code that has since been retired - a "$beta001" list
 * still open when beta001 left beta on 2026-10-11, whose expiry says what to
 * send - would be answered ❓ "has finished" under that code. Its line names
 * $stamtest instead, the one code that always runs: it judges a request as
 * the main groups would, and a retired feature is either theirs now or gone.
 */
export function suggestPrefix(route, prefix) {
  const p = String(prefix ?? '').trim();
  if (!isTestRoute(route)) return p;
  const asked = testCodeOf(route);
  const code = asked && RETIRED_CODES.includes(asked) ? STAM_CODE : asked;
  return code ? `$${code}${p ? ` ${p}` : ''}` : p;
}

/**
 * Is this request a test? Every request from a beta group is, since the
 * operator's "test passed" rule (2026-09-29), and its route says so: it is
 * fixed when the request arrives and journalled with it, and a pick from a
 * "which one?" list re-uses its list's. A test is looked up and checked like
 * any request and never downloaded, converted, sent or queued.
 */
export function isTestRoute(route) {
  return !!route?.beta;
}

/**
 * The code a test was asked under, for its answer and its History row, or
 * null. A list journalled before tests had codes (2026-09-29) once fell back
 * to the pick list's own code, beta001; that feature has left the registry,
 * and lists live minutes, so there is nothing left for a fallback to name.
 */
export function testCodeOf(route) {
  return route?.test || null;
}

/**
 * Where a request's output goes, decided ONCE, when the request arrives.
 *
 * Tests no longer deliver anything (see the top of this file), so for a
 * request made now only `notifyGroup` is used - a test's refusals and
 * questions are said in the group it was asked in, never in the main
 * notifications group - and `beta` marks it a test (isTestRoute). The posts
 * group is still worked out, for the jobs journalled before that change,
 * which are delivered the way this describes.
 *
 * The answer is stored on the job (the movie record, the TV journal entry) and
 * read back at delivery and after a restart. It is never recomputed from the
 * config at send time. Otherwise a beta job still queued when its group is
 * taken off the beta list - an entirely ordinary thing to do when a test is
 * over - would be re-classified as a main job at upload and posted to the
 * real posts group.
 *
 * Main-origin jobs return null and keep following the live main config, as
 * they always have, so an untouched install routes exactly as before.
 *
 * A beta job goes to the beta posts group when one is set, and otherwise back
 * into the group it was asked in. Its notifications always go to the group it
 * was asked in. Neither is a main group at the moment this runs - a beta posts
 * group that the main side already uses falls back to the origin. That can
 * change while the job waits, so whatever sends reads the route through
 * safeRoute(), never raw.
 */
export function resolveRoute(config, originJid) {
  if (!isBetaGroup(config, originJid)) return null;
  const origin = str(originJid);
  const { postsGroup } = betaConfig(config);
  const safePosts = postsGroup && !mainGroupRoles(config).has(postsGroup) ? postsGroup : origin;
  return { beta: true, origin, postsGroup: safePosts, notifyGroup: origin };
}

/**
 * A stored beta route, checked against the config as it is NOW - called at
 * the moment something is about to be sent, reacted or posted.
 *
 * resolveRoute keeps a beta job out of the main groups as they were when the
 * request arrived. But a job can wait for hours (uploads on this box run at
 * about 2 Mbit/s, so one film holds the queue for a long time), and in that
 * time the operator can make the stored destination a main group: clear the
 * beta posts group and add it to TV's posts groups, or promote "Testing
 * things" to a real request group once the test is over. Posting to the stored
 * route then puts a test in front of real members. So every send re-checks:
 *
 *   - a posts group that is now a main group falls back to the group the
 *     request was asked in, which is what resolveRoute would choose today;
 *   - if that is now a main group too, there is nowhere isolated left:
 *     `postsGroup` is null and `withheld` says why, and the caller fails the
 *     job with that reason rather than post;
 *   - updates and reactions belong in the group the request was asked in, so
 *     once THAT is a main group `notifyGroup` is null and `originIsMain` is
 *     true, and nothing more is said or reacted there.
 *
 * A group that has merely left the beta list, without joining the main side,
 * is still somewhere only testers are, and the job still goes there - see
 * resolveRoute for why a finished test must not be re-classified as main.
 *
 * Null for a main job (no route, or not a beta one), which follows the live
 * main config exactly as it always has.
 */
export function safeRoute(config, route) {
  if (!route?.beta) return null;
  const roles = mainGroupRoles(config);
  const usable = (j) => isGroupJid(j) && !roles.has(j);
  const origin = str(route.origin);
  const posts = str(route.postsGroup);
  const notify = str(route.notifyGroup) || origin;
  const postsGroup = usable(posts) ? posts : (usable(origin) ? origin : null);

  let withheld = null;
  if (!postsGroup) {
    const became = (j) => (roles.has(j) ? `has since become the ${roles.get(j)}` : 'is not a group');
    const where = !posts || posts === origin
      ? `the group it was asked in ${became(origin)}`
      : `its beta posts group ${became(posts)}, and the group it was asked in ${became(origin)}`;
    withheld = `not posted: ${where} - a beta test never posts to a main group`;
  }
  return {
    ...route,
    postsGroup,
    notifyGroup: usable(notify) ? notify : null,
    originIsMain: roles.has(origin),
    withheld,
  };
}

/**
 * The problems with a beta configuration, one per offending group.
 *
 * Used to refuse a save and to warn on the card. Overlap between the beta and
 * main groups is the only thing that can break isolation, so it is the only
 * thing checked.
 */
export function betaConflicts(config) {
  const roles = mainGroupRoles(config);
  const b = betaConfig(config);
  const out = [];
  for (const jid of b.groups) {
    if (roles.has(jid)) out.push({ jid, as: 'beta group', role: roles.get(jid) });
  }
  if (b.postsGroup && roles.has(b.postsGroup)) {
    out.push({ jid: b.postsGroup, as: 'beta posts group', role: roles.get(b.postsGroup) });
  }
  return out;
}

/**
 * The overlaps a save would CREATE, from the main side's point of view.
 *
 * Saving the Movies, TV or direct-links card can tick a beta group as a main
 * group just as easily as the beta card can tick a main group as beta, and
 * that direction was not checked at all. An overlap that already existed
 * before the save is left to the beta card, where it is shown and can be
 * removed; refusing it here would block every unrelated save of those cards.
 */
export function addedConflicts(before, after) {
  const had = new Set(betaConflicts(before).map((c) => `${c.as}|${c.jid}`));
  return betaConflicts(after).filter((c) => !had.has(`${c.as}|${c.jid}`));
}

/** Throws unless `v` is a group id, with a reason the operator can act on. */
function groupIdOrThrow(v, what) {
  if (typeof v !== 'string') throw new Error(`${what} must be a group id, not ${JSON.stringify(v)}`);
  const j = v.trim();
  if (!isGroupJid(j)) {
    throw new Error(`"${j}" is not a WhatsApp group (a group id ends in @g.us), so it cannot be the ${what}`);
  }
  return j;
}

/**
 * Clean a `beta` patch from the panel before it is saved.
 *
 * Throws with a message an operator can act on when a mode is not one of the
 * three, or when a group is not a group id. Nothing is quietly coerced: a
 * posts group that silently became '' would move every beta delivery back into
 * the beta group without anyone having chosen that, and one that named a
 * person would deliver films into a private chat.
 *
 * Unknown feature keys are dropped rather than stored: the registry is the
 * source of truth, and a stale page must not write keys for features that no
 * longer exist. And when the patch carries feature modes, a mode still in
 * `current` for a feature that has left the registry is cleared (set to null,
 * which reads as Off). The store merges and never deletes, so without this a
 * retired feature's "on" would sit in config.json and come straight back -
 * On, everywhere - if its key were ever registered again.
 */
export function normalizeBetaPatch(patch, registry = FEATURES, { current = null } = {}) {
  if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('beta settings must be an object');
  }
  const out = {};
  if ('groups' in patch) {
    if (!Array.isArray(patch.groups)) throw new Error('beta.groups must be a list of group ids');
    const ids = patch.groups
      .filter((g) => !(typeof g === 'string' && !g.trim()))       // a blank row is not a choice
      .map((g) => groupIdOrThrow(g, 'beta group'));
    out.groups = [...new Set(ids)];
  }
  if ('postsGroup' in patch) {
    const p = patch.postsGroup;
    out.postsGroup = (p == null || (typeof p === 'string' && !p.trim())) ? '' : groupIdOrThrow(p, 'beta posts group');
  }
  if ('features' in patch) {
    const f = patch.features;
    if (f == null || typeof f !== 'object' || Array.isArray(f)) throw new Error('beta.features must be an object');
    out.features = {};
    for (const [key, mode] of Object.entries(f)) {
      if (!findFeature(key, registry)) continue;
      if (!MODES.includes(mode)) {
        throw new Error(`"${mode}" is not a mode for ${key} - use off, beta or on`);
      }
      out.features[key] = mode;
    }
    for (const [key, mode] of Object.entries(betaConfig(current).features)) {
      if (mode != null && !findFeature(key, registry)) out.features[key] = null;
    }
  }
  return out;
}

/** "beta003 — TV episodes withheld on rating": a feature as the operator and testers name it. */
export function featureTitle(f) {
  const label = f?.label ?? f?.key ?? '';
  return f?.code ? `${f.code} — ${label}` : label;
}

/** The registry as the panel shows it. */
export function describeFeatures(config, registry = FEATURES) {
  return (registry ?? []).filter((f) => f?.key).map((f) => ({
    key: f.key,
    code: f.code ?? null,
    label: featureTitle(f),
    description: f.description ?? '',
    scope: SCOPES.includes(f.scope) ? f.scope : 'all',
    mode: featureMode(config, f.key, registry),
  }));
}

/**
 * The testers' guide: plain text, in WhatsApp's own formatting, for the
 * operator to paste or forward into a beta group. It covers the features on
 * Beta - what the testers can actually try - or the one feature asked for by
 * number, whatever its mode.
 *
 * @returns {{ok: true, text, filename, codes} | {ok: false, error}}
 */
export function testersGuide(config, { code = null, registry = FEATURES } = {}) {
  // Each feature's example is written as its testers would send it: the code,
  // then the prefix of the section that takes it, then the request.
  const prefixOf = (f) => {
    const c = f.scope === 'tv' ? config?.tvRequests : config?.movieRequests;
    return c?.requirePrefix ? String(c.prefix ?? '').trim() : '';
  };
  const tryLine = (f) => (f.example
    ? `Try: $${f.code} ${[prefixOf(f), f.example].filter(Boolean).join(' ')}`
    : `Start with: $${f.code}`);
  const all = (registry ?? []).filter((f) => f?.key);
  let feats;
  if (code) {
    const f = all.find((x) => x.code === code);
    if (!f) return { ok: false, error: `no feature is numbered ${code}` };
    feats = [f];
  } else {
    feats = all.filter((f) => featureMode(config, f.key, registry) === 'beta');
    if (!feats.length) return { ok: false, error: 'no feature is on Beta, so there is nothing for testers to try' };
  }
  const first = feats[0];
  const lines = [
    '*🧪 What we are testing*',
    '',
    'This group gets new bot features before everybody else. Please try them, and tell an admin if anything looks wrong or confusing - a screenshot helps.',
    '',
    // The operator's two rules for the group (2026-09-29): a message counts
    // only with the code of a test, and a test downloads nothing.
    `*Start every request with the code of the test*, then ask the way you normally would - for example ${tryLine(first).replace(/^(Try|Start with): /, '')}. A message without a code is ignored here; a line the bot asks you to send back already has the code in it.`,
    '',
    'Nothing is downloaded or sent from this group. When the bot would have sent it, it answers *✅ Test passed* and says what it would have sent. Anything it turns down (⛔ 📬 📅 and so on) is answered exactly as it would be in the real groups.',
  ];
  for (const f of feats) {
    lines.push('', `*${featureTitle(f)}*`, f.howTo || f.description || '', tryLine(f));
  }
  // The operator's $stamtest (2026-09-30, stam-test.js): any request, judged
  // as the real groups would judge it, answered in one message to paste on.
  lines.push('', '*Any request, as the real groups would see it*',
    'Start a request with $stamtest instead of a test number, and the bot answers in one message: what you asked, whether it would work in the real groups, and exactly what the bot would reply and react there. Handy to copy and paste to someone outside this group.',
    `Try: $stamtest ${[prefixOf({ scope: 'tv' }), 'friends s03 e06, e08'].filter(Boolean).join(' ')}`);
  lines.push('', 'When you report something, say the number (for example ' + feats[0].code + ') so we know which test it was.');
  return {
    ok: true,
    text: lines.join('\n') + '\n',
    filename: code ? `${code}-testers-guide.txt` : 'beta-testers-guide.txt',
    codes: feats.map((f) => f.code),
  };
}
