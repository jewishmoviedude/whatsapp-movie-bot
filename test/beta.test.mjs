/* Beta testing: feature flags, and a beta group walled off from the real ones.
   Run: node test/beta.test.mjs

   The operator wants new group-facing features tried in the "Testing things"
   group before they reach "MOVIE POSTS ONLY", which has 783 members. The
   failure that matters is a test LEAKING: a request made in the beta group
   that posts a film to, notifies, tags or reacts in a main group. Everything
   below drives the real plugins with a fake WhatsApp that records every
   outbound action, and checks where each one went.

   The other half is that nothing changes for an install that never touches
   the beta settings - so the same flows are run with an empty beta config and
   must route exactly as they always have.

   Review of the first version found the route fixed at request time was
   trusted blindly at send time. A beta film waiting in the queue (uploads here
   take hours) was posted into "#test movie posts" after the operator had made
   it a real TV posts group, and into "Testing things" after it had been
   promoted to a real request group - with its play-by-play. The "a queued
   beta job whose destination became a main group" cases below pin the fix
   (safeRoute), and the PUT /api/config cases pin the refusal of the main-side
   save that set it up. The same review found "Ocean's 12" and "Star Wars
   Episode 4" sent to the TV plugin in a beta group, and a retired feature's
   "on" left in config.json to come back if its key were reused.

   On 2026-09-29 the operator made the beta group a place for tests only: a
   request there counts only after a test code, and a test downloads and
   sends nothing - "as soon as bot can confirm it will download it should
   basically be like "test passed"". The cases that followed a beta film to
   the beta posts group are replaced by ones pinning that nothing leaves a
   test, and that a beta job an older bot journalled is not resumed.

   No network: OMDb and Jellyfin are answered by a stubbed fetch, the library
   is a temp directory, and ffprobe is a shell script that describes a file
   which is already WhatsApp-ready, so "conversion" is a hard link. */
import './fixtures/roomy-disk.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import {
  FEATURES, featureMode, isEnabled, isEnabledForJob, isBetaGroup, resolveRoute, safeRoute,
  betaRequestKind, betaConflicts, addedConflicts, normalizeBetaPatch, mainGroupRoles,
  describeFeatures, betaConfig,
} from '../src/core/beta.js';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';
import { functionalGroups } from '../src/core/failover.js';
import { buildDigest } from '../src/core/daily-digest.js';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import tvPlugin from '../src/plugins/tv-requests/index.js';
import { createApiRouter } from '../src/web/api.js';
import { JobQueue } from '../src/core/queue.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

// Example groups, used here as fixtures - nothing in src/ names them.
const TESTING = '120363900000000013@g.us';        // "Testing things"
const BETA_POSTS = '120363900000000014@g.us';     // "#test movie posts"
const MAIN_REQ = 'movie-requests@g.us';
const MAIN_POSTS = 'movie-posts@g.us';
const MAIN_NOTIFY = 'movie-notify@g.us';
const TV_REQ = 'tv-requests@g.us';
const TV_POSTS = 'tv-posts@g.us';
const TV_POSTS2 = 'tv-posts-2@g.us';
const MAIN = [MAIN_REQ, MAIN_POSTS, MAIN_NOTIFY, TV_REQ, TV_POSTS, TV_POSTS2];

const REG = [
  { key: 'smart-replies', label: 'Smarter replies', description: 'Explains a refusal in words', scope: 'movie' },
  { key: 'season-picker', label: 'Season picker', description: 'Buttons for seasons', scope: 'tv' },
];

const MODES_BEFORE = { 'tv-rating-notice': 'off', 'movie-duplicate-notice': 'off', 'tv-duplicate-notice': 'off' };

function config(beta = {}, extra = {}) {
  return mergeDefaults({
    movieRequests: {
      requestGroups: [MAIN_REQ], postsGroup: MAIN_POSTS,
      notify: { group: MAIN_NOTIFY },
      // The request rules this was written against, the defaults until 2026-10-12
      // (request-rule-defaults): no prefix needed, react only, 50 waiting.
      requirePrefix: false, replyOnBlock: false, maxQueueLength: 50, cooldownSecondsPerUser: 30,
      ...extra.movieRequests,
    },
    tvRequests: {
      enabled: true, requestGroups: [TV_REQ], postsGroups: [TV_POSTS, TV_POSTS2], cooldownSecondsPerUser: 0,
      // No TV prefix needed, the default until 2026-10-12 (live-settings-defaults).
      requirePrefix: false,
      ...extra.tvRequests,
    },
    // The beta modes this was written against, the defaults until 2026-10-12
    // (live-settings-defaults): every feature Off unless a case sets its own.
    beta: { ...beta, features: { ...MODES_BEFORE, ...beta.features } },
  }, DEFAULT_CONFIG);
}

/* ============================== pure logic ============================== */

console.log('=== the schema: no beta groups, and the operator\'s three features On ===');
{
  // Every feature started at Off until 2026-10-12, when the operator's live
  // modes became the defaults ("I just updated most of the settings, please
  // set these in the repo coding as default"): the three in the registry On,
  // everywhere, which needs no beta group - and still no beta group.
  ok(JSON.stringify(DEFAULT_CONFIG.beta) === JSON.stringify({ groups: [], postsGroup: '',
    features: { 'tv-rating-notice': 'on', 'movie-duplicate-notice': 'on', 'tv-duplicate-notice': 'on' } }),
  'defaults are no beta groups, no beta posts group, and the three features On');
  const merged = mergeDefaults({}, DEFAULT_CONFIG);
  ok(Array.isArray(merged.beta.groups) && merged.beta.groups.length === 0, 'an old config.json upgrades to an empty beta section');
  const kept = mergeDefaults({ beta: { features: { 'smart-replies': 'beta' } } }, DEFAULT_CONFIG);
  ok(kept.beta.features['smart-replies'] === 'beta', 'feature modes survive a reload (the map is open-ended)');
  // Nothing existing was moved behind a flag: the entries are TV's
  // withheld-on-rating wording and the answers to a film and to TV episodes
  // asked for twice, all new, each started at Off like every feature, and
  // each is On by default now that the operator runs it On.
  // TV's place-in-line numbers are not here: they are the movie group's
  // numbers brought to TV, which the operator said never needed beta
  // (2026-09-29), so they are always on. Nor is the "which one?" list
  // (beta001): it left beta for every group on 2026-10-11, after a config
  // with no modes in it had it Off (see test/pick-list.test.mjs).
  ok(FEATURES.map((f) => `${f.key}:${f.scope}`).join() === 'tv-rating-notice:tv,movie-duplicate-notice:movie,tv-duplicate-notice:tv',
    'the registry holds only new features: the duplicate notice for movies, the rating notice and the duplicate notice for TV');
  ok(!FEATURES.some((f) => f.key === 'tv-queue-positions'), 'TV place in line is not a beta feature');
  ok(!FEATURES.some((f) => f.key === 'movie-pick-list'), 'nor is the "which one?" list: every group has it, whatever the config says');
  ok(FEATURES.every((f) => featureMode(mergeDefaults({}, DEFAULT_CONFIG), f.key) === 'on'),
    'each is On in the defaults a new install starts from');
  // The merge fills an empty map as well. A config.json saved before
  // 2026-10-12 holds one wherever the Beta tab was never saved, and there the
  // store keeps every feature it does not name Off, so an upgrade switches
  // nothing on (keepSavedChoices, pinned in live-settings-defaults).
  ok(FEATURES.every((f) => featureMode(mergeDefaults({ beta: { features: {} } }, DEFAULT_CONFIG), f.key) === 'on'),
    'mergeDefaults fills beta.features: {} too: what a saved file had is the store\'s to keep');
  ok(FEATURES.every((f) => featureMode({}, f.key) === 'off' && !isEnabled({}, f.key, MAIN_REQ)),
    'while a config with no beta section at all is still Off everywhere: an empty beta config is a bot without one');
  const saved = mergeDefaults({ beta: { features: { 'tv-rating-notice': 'off' } } }, DEFAULT_CONFIG);
  ok(featureMode(saved, 'tv-rating-notice') === 'off' && featureMode(saved, 'tv-duplicate-notice') === 'on',
    'a mode saved Off in the panel stays Off; the others keep their default');
}

console.log('=== featureMode / isEnabled, every mode against every kind of group ===');
{
  const cfg = config({ groups: [TESTING], features: { 'smart-replies': 'beta', 'season-picker': 'on' } });
  ok(featureMode(cfg, 'smart-replies', REG) === 'beta', 'a configured mode is read back');
  ok(featureMode(cfg, 'nope', REG) === 'off', 'an unknown key is off');
  ok(featureMode(config(), 'smart-replies', REG) === 'off', 'a registered key with no setting is off');
  ok(featureMode(config({ features: { 'smart-replies': 'yes' } }), 'smart-replies', REG) === 'off',
    'a mode that is not off/beta/on is off');
  ok(featureMode(config({ features: { ghost: 'on' } }), 'ghost', REG) === 'off',
    'a key left in config.json after its feature was deleted switches nothing on');

  const matrix = [
    // mode,  group,     expected
    ['off',  TESTING,   false],
    ['off',  MAIN_REQ,  false],
    ['off',  undefined, false],
    ['beta', TESTING,   true],
    ['beta', MAIN_REQ,  false],
    ['beta', 'other@g.us', false],
    ['beta', undefined, false],
    ['on',   TESTING,   true],
    ['on',   MAIN_REQ,  true],
    ['on',   undefined, true],
  ];
  for (const [mode, group, want] of matrix) {
    const c = config({ groups: [TESTING], features: { 'smart-replies': mode } });
    ok(isEnabled(c, 'smart-replies', group, REG) === want,
      `mode ${mode.padEnd(4)} in ${String(group ?? '(no group)').padEnd(24)} -> ${want}`);
  }
  ok(isEnabled(cfg, 'smart-replies', TESTING) === false,
    'against the real (empty) registry, nothing is enabled anywhere');
}

console.log('=== which groups are beta ===');
{
  ok(!isBetaGroup(config(), TESTING), 'with an empty config no group is beta');
  ok(resolveRoute(config(), MAIN_REQ) === null, 'and nothing gets a beta route');
  const cfg = config({ groups: [TESTING] });
  ok(isBetaGroup(cfg, TESTING), 'a listed group is beta');
  ok(!isBetaGroup(cfg, BETA_POSTS), 'the beta POSTS group is not a request group unless listed');
  ok(!isBetaGroup(cfg, ''), 'blank is never beta');

  const clash = config({ groups: [TESTING, MAIN_REQ] });
  ok(!isBetaGroup(clash, MAIN_REQ), 'a main request group ticked as beta is still treated as MAIN');
  ok(isEnabled(config({ groups: [MAIN_REQ], features: { 'smart-replies': 'beta' } }), 'smart-replies', MAIN_REQ, REG) === false,
    'so a beta feature never switches on in it');
  ok(betaConflicts(clash).some((c) => c.jid === MAIN_REQ && /movie request/.test(c.role)),
    'and the overlap is reported, naming what the group is used for');
  ok(betaConflicts(config({ groups: [TESTING], postsGroup: MAIN_POSTS }))[0]?.as === 'beta posts group',
    'a main posts group picked as the beta posts group is reported too');
  ok(betaConflicts(config({ groups: [TESTING], postsGroup: BETA_POSTS })).length === 0, 'a clean setup has no conflicts');

  const roles = mainGroupRoles(config({}, { tvRequests: { enabled: false } }));
  ok(roles.has(TV_POSTS), 'a DISABLED TV section still counts - its posts group is still full of people');
  ok(roles.get(MAIN_NOTIFY) === 'queue notifications group', 'the notifications group is a main group');
}

console.log('=== where a beta request goes ===');
{
  const r = resolveRoute(config({ groups: [TESTING], postsGroup: BETA_POSTS }), TESTING);
  ok(r?.beta === true && r.postsGroup === BETA_POSTS, 'to the beta posts group when one is set');
  ok(r.notifyGroup === TESTING, 'with its updates in the group it was asked in');
  const back = resolveRoute(config({ groups: [TESTING] }), TESTING);
  ok(back.postsGroup === TESTING, 'and straight back into that group when no beta posts group is set');
  const bad = resolveRoute(config({ groups: [TESTING], postsGroup: MAIN_POSTS }), TESTING);
  ok(bad.postsGroup === TESTING, 'a beta posts group that is really a main group is never used - it falls back');
}

console.log('=== each beta message is claimed by exactly one plugin ===');
{
  const cfg = config({ groups: [TESTING] });
  ok(betaRequestKind(cfg, 'The Boys season 1') === 'tv', '"The Boys season 1" is TV');
  ok(betaRequestKind(cfg, 'Breaking Bad S05E14') === 'tv', '"Breaking Bad S05E14" is TV');
  ok(betaRequestKind(cfg, 'Dune 2021') === 'movie', '"Dune 2021" is a movie');
  ok(betaRequestKind(cfg, 'Rick and Morty') === 'movie', 'a bare show name is a movie request (the series check redirects it)');
  ok(betaRequestKind(cfg, undefined) === 'movie', 'a picture (no text) goes to the movie side, which moderates it');
  ok(betaRequestKind(config({ groups: [TESTING] }, { tvRequests: { enabled: false } }), 'The Boys season 1') === 'movie',
    'with TV switched off, everything is the movie plugin\'s - as in a main movie group');

  // The TV parser reads "'s 12" as season 12 and "Episode 4" as an episode, so
  // these films went to the TV plugin and failed as "📭 Ocean' - no series
  // matching". In a main movie group they are films, and the beta group only
  // tests the real flow if it agrees.
  for (const film of ["Ocean's 11", "Ocean's 12", 'Ocean’s 8', "Bill & Ted's 3", 'Star Wars Episode 4',
    'Apollo 13', 'Rocky 2', 'Season of the Witch', 'Series 7: The Contenders']) {
    ok(betaRequestKind(cfg, film) === 'movie', `"${film}" is a film, not a season of something`);
  }
  for (const show of ["Grey's Anatomy season 2", "Grey's Anatomy S02", "Schitt's Creek S01E03", 'Friends 2x05', 'Friends s2']) {
    ok(betaRequestKind(cfg, show) === 'tv', `"${show}" still names a season, so it is TV`);
  }
  ok(betaRequestKind(cfg, 'The Office episode 4') === 'movie',
    'an episode with no season is the movie plugin\'s, whose series check asks for a season');
}

console.log('=== a feature decided after queueing reads the job, not today\'s beta list ===');
{
  const route = resolveRoute(config({ groups: [TESTING] }), TESTING);
  for (const [mode, r, want] of [['off', route, false], ['off', null, false], ['beta', route, true],
    ['beta', null, false], ['on', route, true], ['on', null, true]]) {
    const c = config({ features: { 'smart-replies': mode } });
    ok(isEnabledForJob(c, 'smart-replies', r, REG) === want,
      `mode ${mode.padEnd(4)} for a ${r ? 'beta' : 'main'} job -> ${want}`);
  }
  // A main request group moved onto the beta list while its main jobs wait:
  // they still post to the real posts group, so a Beta feature must not run
  // on them. isEnabled() would say yes, because it only sees the group.
  const X = 'x@g.us';
  const atRequest = config({ features: { 'smart-replies': 'beta' } }, { movieRequests: { requestGroups: [X] } });
  const jobRoute = resolveRoute(atRequest, X);
  const atDelivery = config({ groups: [X], features: { 'smart-replies': 'beta' } }, { movieRequests: { requestGroups: [] } });
  ok(jobRoute === null && isEnabled(atDelivery, 'smart-replies', X, REG) === true,
    'isEnabled() on the group would switch the feature on for a job queued as main');
  ok(isEnabledForJob(atDelivery, 'smart-replies', jobRoute, REG) === false,
    'isEnabledForJob() on the job\'s route does not - it is still a main job');
  ok(isEnabledForJob(config({ features: { 'smart-replies': 'off' } }), 'smart-replies', route, REG) === false,
    'and Off, read live, still stops a feature on jobs already waiting');
}

console.log('=== a stored route is re-checked against today\'s main groups ===');
{
  const route = resolveRoute(config({ groups: [TESTING], postsGroup: BETA_POSTS }), TESTING);
  ok(safeRoute(config(), null) === null && safeRoute(config(), { postsGroup: MAIN_POSTS }) === null,
    'a main job has no beta route to check');
  const same = safeRoute(config({ groups: [TESTING], postsGroup: BETA_POSTS }), route);
  ok(same.postsGroup === BETA_POSTS && same.notifyGroup === TESTING && !same.originIsMain && !same.withheld,
    'nothing changed, nothing moves');
  const over = safeRoute(config({}), route);
  ok(over.postsGroup === BETA_POSTS && over.notifyGroup === TESTING,
    'a test that is merely over (beta list emptied) still goes where it was going');

  const postsTaken = safeRoute(config({ groups: [TESTING] }, { tvRequests: { postsGroups: [TV_POSTS, BETA_POSTS] } }), route);
  ok(postsTaken.postsGroup === TESTING && postsTaken.notifyGroup === TESTING,
    'a beta posts group that became a main posts group falls back into the group it was asked in');

  const originTaken = safeRoute(config({}, { movieRequests: { requestGroups: [MAIN_REQ, TESTING] } }),
    resolveRoute(config({ groups: [TESTING] }), TESTING));
  ok(originTaken.postsGroup === null && originTaken.notifyGroup === null && originTaken.originIsMain,
    'when the beta group itself became a main group there is nowhere isolated left: nothing is posted or said');
  ok(/movie request group/.test(originTaken.withheld) && /never posts to a main group/.test(originTaken.withheld),
    `and the reason names what it became: "${originTaken.withheld}"`);

  const both = safeRoute(config({}, { movieRequests: { requestGroups: [MAIN_REQ, TESTING] }, tvRequests: { postsGroups: [BETA_POSTS] } }), route);
  ok(both.postsGroup === null && /beta posts group has since become the TV posts group/.test(both.withheld),
    `both taken: withheld, naming both ("${both.withheld}")`);

  const onlyOrigin = safeRoute(config({}, { movieRequests: { requestGroups: [MAIN_REQ, TESTING] } }), route);
  ok(onlyOrigin.postsGroup === BETA_POSTS && onlyOrigin.notifyGroup === null && onlyOrigin.originIsMain,
    'the beta group became main but the beta posts group did not: the file still goes there, silently');

  const handEdited = safeRoute(config({ groups: [TESTING] }), { ...route, postsGroup: '15551112222@s.whatsapp.net' });
  ok(handEdited.postsGroup === TESTING, 'a destination that is not a group is never posted to');
}

console.log('=== a save from the panel is cleaned before it is stored ===');
{
  const out = normalizeBetaPatch({ groups: [TESTING, ` ${TESTING} `, ''], postsGroup: ` ${BETA_POSTS}`,
    features: { 'smart-replies': 'beta', ghost: 'on' } }, REG);
  ok(out.groups.length === 1 && out.groups[0] === TESTING, 'groups are trimmed and de-duplicated');
  ok(out.postsGroup === BETA_POSTS, 'the posts group is trimmed');
  ok(out.features['smart-replies'] === 'beta' && !('ghost' in out.features), 'a key the registry does not know is dropped');
  let err = null;
  try { normalizeBetaPatch({ features: { 'smart-replies': 'maybe' } }, REG); } catch (e) { err = e; }
  ok(/off, beta or on/.test(err?.message ?? ''), `a bad mode is refused with the choices: "${err?.message}"`);
  err = null;
  try { normalizeBetaPatch({ groups: TESTING }); } catch (e) { err = e; }
  ok(/list/.test(err?.message ?? ''), 'a group list that is not a list is refused');
  ok(Object.keys(normalizeBetaPatch({ postsGroup: '' })).join() === 'postsGroup', 'only what was sent is patched');
  const shown = describeFeatures(config({ features: { 'season-picker': 'on' } }), REG);
  ok(shown.length === 2 && shown[1].mode === 'on' && shown[0].mode === 'off', 'the panel is told each feature\'s mode');
  ok(betaConfig({}).groups.length === 0 && betaConfig(null).postsGroup === '', 'a missing section reads as empty, never throws');
}

console.log('=== only groups can be beta groups ===');
{
  // A non-text entry used to be dropped and a numeric posts group silently
  // turned into '' - quietly moving every beta delivery back into the beta
  // group. One naming a person would have delivered films into a PM.
  const refused = (patch) => { try { normalizeBetaPatch(patch, REG); return null; } catch (e) { return e.message; } };
  ok(/group id/.test(refused({ groups: [123] }) ?? ''), `a number in the group list is refused: "${refused({ groups: [123] })}"`);
  ok(/group id/.test(refused({ groups: [{ a: 1 }] }) ?? ''), 'so is an object');
  ok(/not a WhatsApp group/.test(refused({ groups: ['15551112222@s.whatsapp.net'] }) ?? ''),
    `a person is not a beta group: "${refused({ groups: ['15551112222@s.whatsapp.net'] })}"`);
  ok(/not a WhatsApp group/.test(refused({ groups: ['garbage'] }) ?? ''), 'nor is garbage');
  ok(/beta posts group/.test(refused({ postsGroup: 12345 }) ?? ''), 'a numeric posts group is refused, not turned into ""');
  ok(/not a WhatsApp group/.test(refused({ postsGroup: '15551112222@s.whatsapp.net' }) ?? ''),
    'a person as the beta posts group is refused');
  ok(normalizeBetaPatch({ postsGroup: '' }).postsGroup === '' && normalizeBetaPatch({ postsGroup: null }).postsGroup === '',
    '"back into the beta group" is still a choice');

  const edited = config({ groups: ['15551112222@s.whatsapp.net', TESTING], postsGroup: '15551112222@s.whatsapp.net' });
  ok(betaConfig(edited).groups.join() === TESTING && betaConfig(edited).postsGroup === '',
    'a hand-edited config.json naming a person is ignored at runtime as well');
  ok(resolveRoute(edited, TESTING).postsGroup === TESTING, 'so films go back into the beta group, never to a PM');
}

console.log('=== a retired feature\'s mode does not come back ===');
{
  const current = config({ features: { ghost: 'on', 'smart-replies': 'beta' } });
  const out = normalizeBetaPatch({ features: { 'smart-replies': 'beta' } }, REG, { current });
  ok(out.features.ghost === null, 'a beta save clears the mode of a feature that has left the registry');
  const after = mergeDefaults({ beta: out }, current);
  ok(featureMode(after, 'ghost', [...REG, { key: 'ghost', label: 'Ghost' }]) === 'off',
    'so re-registering the key starts at Off, not at its old On');
  ok(!('ghost' in normalizeBetaPatch({ groups: [TESTING] }, REG, { current })),
    'a save that carries no feature modes leaves them alone');
}

console.log('=== a main-side save cannot take over a beta group ===');
{
  const before = config({ groups: [TESTING], postsGroup: BETA_POSTS });
  const promote = mergeDefaults({ movieRequests: { requestGroups: [MAIN_REQ, TESTING] } }, before);
  ok(addedConflicts(before, promote)[0]?.jid === TESTING, 'making the beta group a movie request group is an overlap');
  const tvPosts = mergeDefaults({ tvRequests: { postsGroups: [TV_POSTS, BETA_POSTS] } }, before);
  ok(addedConflicts(before, tvPosts)[0]?.as === 'beta posts group', 'so is making the beta posts group a TV posts group');
  const legacy = config({ groups: [TESTING, MAIN_REQ] });
  ok(addedConflicts(legacy, mergeDefaults({ movieRequests: { cooldownSecondsPerUser: 5 } }, legacy)).length === 0,
    'an overlap that was already there is not blamed on an unrelated save');
}

console.log('=== failover coverage does not count a test group ===');
{
  const need = functionalGroups(config({ groups: [TESTING], postsGroup: BETA_POSTS }));
  ok(!need.has(TESTING) && !need.has(BETA_POSTS),
    'a spare that is not admin in the test group is not reported as unable to serve members');
  ok(need.has(MAIN_REQ) && need.has(MAIN_POSTS), 'the real groups are still required');
}

console.log('=== the daily digest keeps tests out of the service figures ===');
{
  const now = Date.now();
  const body = buildDigest({ now, history: [
    { at: now - 1000, status: 'sent' },
    { at: now - 1000, status: 'failed', beta: true },
    { at: now - 1000, status: 'sent', beta: true },
  ] });
  ok(/Requests handled : 1\b/.test(body), 'only the real request is counted as handled');
  ok(/Failed\s+: 0\b/.test(body), 'a deliberate test failure is not reported as a failure');
  ok(/Beta tests\s+: 2 \(not counted above\)/.test(body), 'the tests get a line of their own');
  ok(!/Beta tests/.test(buildDigest({ now, history: [{ at: now, status: 'sent' }] })),
    'and with no beta traffic the digest reads exactly as before');
}

/* ======================= driving the real plugins ======================= */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'beta-test-'));
const LIB = path.join(TMP, 'library');
const WORK = path.join(TMP, 'work');
fs.mkdirSync(LIB);
fs.mkdirSync(WORK);
fs.writeFileSync(path.join(LIB, 'Inception (2010).mp4'), 'not really a film');
// An ffprobe that says every file is a small h264/aac mp4, so the conversion
// step takes its "already compatible" branch and just hard-links the file.
const FFPROBE = path.join(TMP, 'ffprobe');
fs.writeFileSync(FFPROBE, `#!/bin/sh
cat <<'JSON'
{"streams":[{"codec_type":"video","codec_name":"h264","width":1280,"height":720},{"codec_type":"audio","codec_name":"aac","channels":2}],"format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"60","size":"17"}}
JSON
`, { mode: 0o755 });

const SERIES = { Items: [{ Id: 'SER1', Name: 'The Boys', ProductionYear: 2019, OfficialRating: 'TV-14' }] };
const SEASONS = { Items: [{ Id: 'S1', IndexNumber: 1 }] };
const EPISODES = { Items: [
  { Id: 'E1', SeriesName: 'The Boys', ParentIndexNumber: 1, IndexNumber: 1, Name: 'Pilot', MediaSources: [{ Path: '/a.mkv', Size: 1 }] },
] };

const netCalls = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  netCalls.push(u);
  const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.includes('omdbapi.com')) {
    return json({ Response: 'True', Title: 'Inception', Year: '2010', Rated: 'PG-13', imdbID: 'tt1375666', Type: 'movie' });
  }
  if (u.startsWith('http://jf.test')) {
    if (u.includes('/Download')) return new Response('episode bytes', { status: 200 });
    if (u.includes('/Seasons')) return json(SEASONS);
    if (u.includes('/Episodes')) return json(EPISODES);
    if (u.includes('/Items')) return json(SERIES);
  }
  return new Response('{}', { status: 404, statusText: 'not stubbed' });
};

function fullConfig(beta = {}, extra = {}) {
  const c = config(beta, extra);
  c.omdb.apiKey = 'test-key';
  c.library = mergeDefaults({
    provider: 'local',
    local: { roots: [LIB], extensions: ['.mp4'] },
    jellyfin: { baseUrl: 'http://jf.test', accessToken: 'TOK', userId: 'U1' },
  }, DEFAULT_CONFIG.library);
  Object.assign(c.media, { workDir: WORK, ffprobePath: FFPROBE, ffmpegPath: '/bin/false', deleteAfterSend: true });
  c.whatsapp.broadcastPacingMs = 0;
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

/** A WhatsApp that records every outbound action and where it went. */
function fakeBot(out) {
  return {
    isConnected: () => true,
    react: async (msg, emoji) => { out.push({ op: 'react', jid: msg.chatJid, emoji }); return true; },
    sendText: async (jid, body) => { out.push({ op: 'text', jid, body }); return { key: { id: 'sent' } }; },
    sendDocument: async (jid, file, opts) => { out.push({ op: 'document', jid, file: opts?.fileName }); return {}; },
    deleteMessage: async (m) => { out.push({ op: 'delete', jid: m.chatJid }); },
    archiveChat: async () => {},
    isGroupAdmin: () => false,
    groupMemberInfo: () => ({ isMember: true, mentionJid: 'tester@lid', mentionText: '15551112222' }),
    groups: () => [],
    groupCache: new Map([
      [BETA_POSTS, { subject: '#test movie posts' }], [TESTING, { subject: 'Testing things' }],
      [MAIN_POSTS, { subject: 'MOVIE POSTS ONLY' }], [TV_POSTS, { subject: 'TV POSTS' }],
    ]),
    sameCommunity: () => true,
    groupMentionToken: (jid) => `@${jid.split('@')[0]}`,
    on() {}, off() {},
  };
}

function harness(cfg, store = fakeStore()) {
  const out = [];
  const jobs = [];
  const ctx = {
    config: cfg,
    store,
    bot: fakeBot(out),
    log: { info() {}, warn() {}, error() {}, debug() {} },
    configStore: { update() {} },
    queue: {
      maxLength: 50, pending: [],
      add: (j) => { jobs.push(j); return `job-${jobs.length}`; },
      snapshot: () => ({ pending: [], active: [] }),
    },
  };
  return { ctx, out, jobs, store };
}

let seq = 0;
const mkMsg = (text, chatJid) => {
  const id = `msg-${++seq}`;
  return {
    id, key: { id, remoteJid: chatJid }, text, chatJid, isGroup: true, fromMe: false,
    messageType: 'conversation', senderJid: 'tester@lid', senderNumber: '15551112222',
    senderNumberDisplay: '+1 555 111 2222', pushName: 'Tester', timestamp: Date.now(),
  };
};

const fakeJob = () => ({ id: `j${++seq}`, progress() {}, isCancelled: () => false, cancelReason: () => null });
async function runAll(jobs) {
  for (const j of jobs.splice(0)) await j.run(fakeJob());
  await new Promise((r) => setTimeout(r, 20));      // TV notifications are fire-and-forget
}
const where = (out, op) => [...new Set(out.filter((e) => e.op === op).map((e) => e.jid))];
const touchedMain = (out) => out.filter((e) => MAIN.includes(e.jid));

moviePlugin._reactors = new Map();                    // normally created by setup()

console.log('=== REGRESSION: an empty beta config routes a movie exactly as before ===');
{
  const { ctx, out, jobs, store } = harness(fullConfig());
  await moviePlugin.onMessage(mkMsg('Inception', MAIN_REQ), ctx);
  ok(jobs.length === 1, 'the request is queued');
  await runAll(jobs);
  ok(where(out, 'document').join() === MAIN_POSTS, 'the film goes to the main posts group');
  ok(where(out, 'text').join() === MAIN_NOTIFY, 'every update goes to the main notifications group');
  ok(where(out, 'react').join() === MAIN_REQ, 'every reaction is on the request itself');
  const row = store.get('history')[0];
  ok(row.status === 'sent', 'history says sent');
  ok(!('beta' in row) && !('route' in row), 'and the record has no beta fields at all - it is what it always was');
}

// Since 2026-09-29 a request in the beta group is a test: it counts only
// after its code, and it never downloads, converts, uploads or queues
// anything - where it would be queued it answers "✅ Test passed" (beta.js,
// and test/beta-test-mode.test.mjs for the operator's cases). So the
// delivery cases that used to follow here - a beta film posted to the beta
// posts group, journalled with its route, re-checked by safeRoute when its
// destination became a main group - have nothing to deliver any more.
// safeRoute itself is pinned in the pure cases above, and a beta job
// journalled before the change is dropped at recovery, below.
//
// The film tests are asked under $beta004, the duplicate notice: beta001,
// the "which one?" list these cases were first written with, left beta for
// every group on 2026-10-11, and its code is answered ❓ now.
const BETA_ON = { 'movie-duplicate-notice': 'beta', 'tv-rating-notice': 'beta' };

console.log('=== a movie test in the beta group answers there, and delivers nothing ===');
{
  const { ctx, out, jobs, store } = harness(fullConfig({ groups: [TESTING], postsGroup: BETA_POSTS, features: BETA_ON }));
  const m = mkMsg('$beta004 Inception', TESTING);
  await moviePlugin.onMessage(m, ctx);
  ok(jobs.length === 0 && !(store.get('pending') ?? []).length, 'nothing is queued or journalled');
  ok(!out.some((e) => e.op === 'document'), 'nothing is posted, to the beta posts group or anywhere');
  ok(where(out, 'text').join() === TESTING && where(out, 'react').join() === TESTING, 'every word and reaction is in the beta group');
  ok(out.some((e) => e.op === 'react' && e.emoji === '✅')
    && out.some((e) => e.op === 'text' && /^✅ \*Test passed\* \(\$beta004\)\n\nThe bot would send \*Inception\* \(2010\)/.test(e.body)),
  'with ✅ and "Test passed"');
  ok(touchedMain(out).length === 0, `NOTHING was sent, posted or reacted in a main group (${touchedMain(out).length})`);
  const row = store.get('history')[0];
  ok(row.beta === true && row.status === 'test-passed' && row.test === 'beta004', 'history marks the row a passed beta004 test');
}

console.log('=== a beta film journalled before tests stopped downloading is not resumed ===');
{
  const store = fakeStore();
  const before = harness(fullConfig({ groups: [TESTING], postsGroup: BETA_POSTS, features: BETA_ON }), store);
  await moviePlugin.onMessage(mkMsg('Inception', MAIN_REQ), before.ctx);
  // Made to look like what an older bot journalled for the beta group.
  const [p] = store.get('pending');
  Object.assign(p, { chatJid: TESTING, msgKey: { ...p.msgKey, remoteJid: TESTING } });
  p.record.route = resolveRoute(before.ctx.config, TESTING);
  store.set('pending', [p]);
  before.jobs.length = 0;                             // --- the process dies here ---

  const after = harness(fullConfig({ groups: [TESTING], postsGroup: BETA_POSTS, features: BETA_ON }), store);
  await moviePlugin.recoverPending(after.ctx);
  ok(after.jobs.length === 0 && !(store.get('pending') ?? []).length, 'it is not re-queued, and leaves the journal');
  const row = store.get('history').find((r) => r.id === p.record.id);
  ok(row?.status === 'cancelled' && /beta test queued before tests stopped downloading/.test(row.detail ?? ''),
    `History says why: "${row?.detail}"`);
  ok(after.out.some((e) => e.op === 'react' && e.jid === TESTING && e.emoji === '❌'), 'and its message gets ❌');
  ok(!after.out.some((e) => e.op === 'document') && touchedMain(after.out).length === 0, 'nothing is posted anywhere');
}

console.log('=== a MAIN job still follows the live posts group, as it always did ===');
{
  const cfg = fullConfig({ groups: [TESTING], postsGroup: BETA_POSTS });
  const { ctx, out, jobs } = harness(cfg);
  await moviePlugin.onMessage(mkMsg('Inception', MAIN_REQ), ctx);
  cfg.movieRequests.postsGroup = 'new-movie-posts@g.us';
  await runAll(jobs);
  ok(where(out, 'document').join() === 'new-movie-posts@g.us', 'moving the posts group still moves the waiting main jobs');
}

console.log('=== a main group ticked as beta by mistake is still a main group ===');
{
  const { ctx, out, jobs, store } = harness(fullConfig({ groups: [MAIN_REQ], postsGroup: BETA_POSTS }));
  await moviePlugin.onMessage(mkMsg('Inception', MAIN_REQ), ctx);
  await runAll(jobs);
  ok(where(out, 'document').join() === MAIN_POSTS, 'its films still go to the main posts group, not the beta one');
  ok(!store.get('history')[0].beta, 'and its requests are not marked as tests');
}

console.log('=== a main group ticked as beta by mistake is still a main group ===');
{
  const { ctx, out, jobs, store } = harness(fullConfig({ groups: [MAIN_REQ], postsGroup: BETA_POSTS, features: BETA_ON }));
  await moviePlugin.onMessage(mkMsg('Inception', MAIN_REQ), ctx);
  await runAll(jobs);
  ok(where(out, 'document').join() === MAIN_POSTS, 'its films still go to the main posts group, not the beta one');
  ok(!store.get('history')[0].beta, 'and its requests are not marked as tests');
}

console.log('=== the two plugins split a beta group between them ===');
{
  const { ctx, out, jobs } = harness(fullConfig({ groups: [TESTING], features: BETA_ON }));
  await moviePlugin.onMessage(mkMsg('$beta003 The Boys S01E01', TESTING), ctx);
  ok(jobs.length === 0 && out.length === 0, 'the movie plugin leaves a TV test alone - no reaction, no lookup');
  await tvPlugin.onMessage(mkMsg('$beta004 Inception', TESTING), ctx);
  ok(jobs.length === 0 && out.length === 0, 'the TV plugin leaves a film test alone');
  await moviePlugin.onMessage(mkMsg('Inception', TESTING), ctx);
  await tvPlugin.onMessage(mkMsg('The Boys S01E01', TESTING), ctx);
  ok(out.length === 0, 'and neither answers a request with no code');
  await moviePlugin.onMessage(mkMsg('Inception', 'random@g.us'), ctx);
  ok(jobs.length === 0, 'and a group that is neither main nor beta is still ignored');
}

console.log('=== testing never throttles a real request ===');
{
  const { ctx, store } = harness(fullConfig({ groups: [TESTING], features: BETA_ON }));
  await moviePlugin.onMessage(mkMsg('Inception', TESTING), ctx);
  ok(store.get('cooldown:beta:tester@lid', 0) === 0, 'a message with no code starts no clock at all');
  await moviePlugin.onMessage(mkMsg('$beta004 Inception', TESTING), ctx);
  // A test started the beta clock until 2026-10-01. A test queues nothing,
  // and since the operator's rule of that day ("cooldown is only if the
  // members first request actually puts an item in queue") nothing that
  // queues nothing starts a clock. What it does count towards is the beta
  // group's own flood backstop (src/core/request-cooldown.js).
  ok(store.get('cooldown:beta:tester@lid', 0) === 0, 'a test starts no clock, not even the beta one');
  ok(store.get('cooldown-answers:beta:tester@lid', []).length === 1, 'it counts towards the beta backstop');
  ok(store.get('cooldown:tester@lid', 0) === 0 && store.get('cooldown-answers:tester@lid', []).length === 0,
    'and nothing of the main one - otherwise the tester\'s next real request could get 🚫 in a main group');
}

console.log('=== REGRESSION: an empty beta config routes a TV episode exactly as before ===');
{
  const { ctx, out, jobs, store } = harness(fullConfig());
  await tvPlugin.onMessage(mkMsg('The Boys S01E01', TV_REQ), ctx);
  ok(jobs.length === 1, 'the episode is queued');
  await runAll(jobs);
  ok(where(out, 'document').join() === `${TV_POSTS},${TV_POSTS2}`, 'it goes to every TV posts group');
  ok(where(out, 'text').join() === MAIN_NOTIFY, 'updates go to the main notifications group');
  ok(!('beta' in store.get('history')[0]), 'the history row carries no beta marker');
}

console.log('=== a TV test in the beta group answers there, and delivers nothing ===');
{
  const { ctx, out, jobs, store } = harness(fullConfig({ groups: [TESTING], postsGroup: BETA_POSTS, features: BETA_ON }));
  await tvPlugin.onMessage(mkMsg('$beta003 The Boys S01E01', TESTING), ctx);
  await new Promise((r) => setTimeout(r, 20));
  ok(jobs.length === 0 && !(store.get('pending') ?? []).length, 'nothing is queued or journalled');
  ok(!out.some((e) => e.op === 'document') && touchedMain(out).length === 0, `NOTHING reached a main group (${touchedMain(out).length})`);
  ok(out.some((e) => e.op === 'text' && e.jid === TESTING && /^✅ \*Test passed\* \(\$beta003\)\n\nThe bot would queue/.test(e.body)),
    'the tester is told the test passed, in the beta group');
  const row = store.get('history')[0];
  ok(row.beta === true && row.status === 'test-passed' && row.test === 'beta003', 'history marks the TV row a passed test');
}

console.log('=== a beta TV request journalled before tests stopped downloading is not resumed ===');
{
  const store = fakeStore();
  const before = harness(fullConfig({ groups: [TESTING], postsGroup: BETA_POSTS, features: BETA_ON }), store);
  await tvPlugin.onMessage(mkMsg('The Boys S01E01', TV_REQ), before.ctx);
  const [r] = store.get('pending');
  Object.assign(r, { chatJid: TESTING, msgKey: { ...r.msgKey, remoteJid: TESTING }, route: resolveRoute(before.ctx.config, TESTING) });
  store.set('pending', [r]);
  before.jobs.length = 0;                             // --- the process dies here ---

  const after = harness(fullConfig({ groups: [TESTING], postsGroup: BETA_POSTS, features: BETA_ON }), store);
  await tvPlugin.recoverPending(after.ctx);
  await new Promise((res) => setTimeout(res, 20));
  ok(after.jobs.length === 0, 'the episode is not re-queued');
  ok(!after.out.some((e) => e.op === 'document') && touchedMain(after.out).length === 0, 'and nothing is posted anywhere');
  const row = (store.get('history') ?? []).find((h) => h.id === r.baseRow?.id);
  ok(row?.status === 'cancelled' && /beta test queued before tests stopped downloading/.test(row.detail ?? ''),
    `History says why: "${row?.detail}"`);
}

async function runCatching(jobs) {
  for (const j of jobs.splice(0)) { try { await j.run(fakeJob()); } catch { /* a failed job rejects */ } }
  await new Promise((r) => setTimeout(r, 20));
}
{
  // A main TV failure keeps its counts-only History detail, exactly as before.
  const { ctx, jobs, store } = harness(fullConfig());
  ctx.bot.sendDocument = async () => { throw new Error('boom'); };
  await tvPlugin.onMessage(mkMsg('The Boys S01E01', TV_REQ), ctx);
  await runCatching(jobs);
  ok(store.get('history')[0].detail === '0 of 1 posted, 1 failed', `a main row is unchanged: "${store.get('history')[0].detail}"`);
}

/* ============================ the panel's API =========================== */
// The card itself is exercised in beta-panel.test.mjs (it needs linkedom);
// this is the server side of it, mounted for real and called over HTTP.

const GROUPS = [
  { jid: TESTING, subject: 'Testing things', size: 30 },
  { jid: BETA_POSTS, subject: '#test movie posts', size: 29 },
  { jid: MAIN_REQ, subject: 'MOVIE REQUESTS ONLY!', size: 800 },
  { jid: MAIN_POSTS, subject: 'MOVIE POSTS ONLY', size: 783 },
];

function makeStateStore() {
  const spaces = new Map();
  return {
    namespace(name) {
      if (!spaces.has(name)) spaces.set(name, { data: {} });
      const sp = spaces.get(name);
      return {
        get: (k, d) => sp.data[k] ?? d,
        set: (k, v) => { sp.data[k] = v; },
        push: (k, v) => { (sp.data[k] ??= []).unshift(v); },
      };
    },
  };
}

function makeConfigStore(initial) {
  let cfg = JSON.parse(JSON.stringify(initial));
  const merge = (a, b) => {
    for (const [k, v] of Object.entries(b)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) merge(a[k] ??= {}, v);
      else a[k] = v;
    }
    return a;
  };
  return {
    get: () => cfg,
    update: (patch) => { cfg = merge(JSON.parse(JSON.stringify(cfg)), patch); return cfg; },
    redacted: () => JSON.parse(JSON.stringify(cfg)),
    onChange: () => {},
  };
}

const requeued = [];
const stateStore = makeStateStore();
const configStore = makeConfigStore({
  web: { adminPasswordHash: 'x', users: [{ username: 'admin', role: 'superadmin', passwordHash: 'x' }] },
  movieRequests: { requestGroups: [MAIN_REQ], postsGroup: MAIN_POSTS, notify: { group: '' }, reactions: {} },
  tvRequests: {}, directLinks: {}, queue: {}, lockdown: {}, media: {},
  whatsapp: { activeAccount: 'main', accounts: [{ id: 'main', label: 'Main', phoneNumber: '1' }], failover: {} },
  beta: { groups: [], postsGroup: '', features: {} },
});
const queue = new JobQueue({ concurrency: 1 });
queue.pause();
const server = await new Promise((resolve) => {
  const ex = express();
  ex.use(express.json());
  ex.use((req, _res, next) => { req.session = { user: { username: 'mommy', role: 'superadmin' } }; next(); });
  ex.use('/api', createApiRouter({
    configStore,
    bot: { groupCache: new Map(), groups: () => GROUPS, on: () => {}, state: 'connected' },
    queue, linkQueue: queue,
    pluginManager: {
      notifyConfigChange: async () => {},
      plugins: new Map([['movie-requests', {
        ctx: {},
        plugin: { requeue: async (text) => { requeued.push(text); return { title: text, year: 2010 }; } },
      }]]),
    },
    stateStore, fileLogger: { tail: () => [] }, alerts: {}, lockScheduler: {},
  }));
  const s = ex.listen(0, () => resolve(s));
});
const port = server.address().port;
const call = (method, path, body) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const r = http.request({ host: '127.0.0.1', port, method, path,
    headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
  (res) => {
    let buf = '';
    res.on('data', (ch) => { buf += ch; });
    res.on('end', () => resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null }));
  });
  r.on('error', reject);
  if (data) r.write(data);
  r.end();
});

console.log('=== GET /api/beta ===');
{
  const r = await call('GET', '/api/beta');
  ok(r.status === 200, 'answers');
  ok(Array.isArray(r.json.features) && r.json.features.map((f) => `${f.key}:${f.mode}`).join() === 'tv-rating-notice:off,movie-duplicate-notice:off,tv-duplicate-notice:off',
    'with the real registry, every feature Off - and no "which one?" list on Settings → Beta to switch Off again');
  ok(r.json.pickList?.shown === 0, 'and the pick-list counters, empty');
  ok(r.json.modes.join() === 'off,beta,on', 'the three modes');
  ok(r.json.mainGroups[MAIN_POSTS] === 'movie posts group', 'and which groups the main service already uses');
}

console.log('=== PUT /api/config refuses a beta setup that could reach real members ===');
{
  let r = await call('PUT', '/api/config', { beta: { groups: [TESTING, MAIN_REQ] } });
  ok(r.status === 400, 'a main request group as a beta group is refused');
  ok(/MOVIE REQUESTS ONLY!/.test(r.json.error) && /movie request group/.test(r.json.error),
    `naming the group and what it is: "${r.json.error}"`);
  ok(configStore.get().beta.groups.length === 0, 'and nothing was saved');

  r = await call('PUT', '/api/config', { beta: { groups: [TESTING], postsGroup: MAIN_POSTS } });
  ok(r.status === 400 && /beta posts group/.test(r.json.error), 'a main posts group as the beta posts group is refused');

  r = await call('PUT', '/api/config', { beta: { features: { x: 'maybe' }, groups: 'nope' } });
  ok(r.status === 400, 'a malformed patch is refused rather than stored');

  r = await call('PUT', '/api/config', { beta: { postsGroup: '15551112222@s.whatsapp.net' } });
  ok(r.status === 400 && /not a WhatsApp group/.test(r.json.error), `a person as the beta posts group is refused: "${r.json.error}"`);

  // The refusal is the safety event the whole feature exists for, so it must
  // leave a trace; a plain 400 left none.
  const refusals = stateStore.namespace('audit').get('events', []).filter((e) => /^refused:/.test(e.action));
  ok(refusals.length === 4, `every refusal is in the audit log (${refusals.length})`);
  ok(refusals.some((e) => /MOVIE REQUESTS ONLY!/.test(e.detail) && /movie request group/.test(e.detail)),
    'naming the group and what it is');
}

console.log('=== PUT /api/config saves a clean beta setup ===');
{
  const r = await call('PUT', '/api/config', { beta: { groups: [TESTING, TESTING], postsGroup: BETA_POSTS, features: { ghost: 'on' } } });
  ok(r.status === 200, 'accepted');
  const b = configStore.get().beta;
  ok(b.groups.join() === TESTING, 'the group is stored once, by JID');
  ok(b.postsGroup === BETA_POSTS, 'the posts group is stored');
  ok(!('ghost' in b.features), 'a feature the registry does not know is not stored');
  const again = await call('PUT', '/api/config', { movieRequests: { cooldownSecondsPerUser: 10 } });
  ok(again.status === 200 && configStore.get().beta.groups.join() === TESTING,
    'saving another card leaves the beta settings alone');
  const audit = stateStore.namespace('audit').get('events', []);
  ok(audit.some((e) => /beta\.groups/.test(e.detail ?? '')), 'the change is in the audit log, by setting name');
}

console.log('=== PUT /api/config refuses a main-side save that takes over a beta group ===');
{
  // Beta is now "Testing things" -> "#test movie posts" (saved above). Only the
  // beta card's save was checked before; any other card could make either of
  // them a main group without a word.
  const audited = () => stateStore.namespace('audit').get('events', []).filter((e) => /^refused:/.test(e.action)).length;
  const was = audited();
  let r = await call('PUT', '/api/config', { movieRequests: { requestGroups: [MAIN_REQ, TESTING] } });
  ok(r.status === 400 && /"Testing things" is a beta group/.test(r.json.error) && /movie request group/.test(r.json.error),
    `the beta group cannot be made a movie request group: "${r.json.error}"`);
  ok(/Beta 🧪/.test(r.json.error), 'and it says where to go to release it');
  ok(configStore.get().movieRequests.requestGroups.join() === MAIN_REQ, 'nothing was saved');
  r = await call('PUT', '/api/config', { tvRequests: { postsGroups: [BETA_POSTS] } });
  ok(r.status === 400 && /beta posts group/.test(r.json.error) && /TV posts group/.test(r.json.error),
    'the beta posts group cannot be made a TV posts group');
  r = await call('PUT', '/api/config', { directLinks: { groups: [TESTING] } });
  ok(r.status === 400 && /direct-links group/.test(r.json.error), 'nor a direct-links group');
  r = await call('PUT', '/api/config', { movieRequests: { notify: { group: BETA_POSTS } } });
  ok(r.status === 400 && /queue notifications group/.test(r.json.error), 'nor the notifications group');
  ok(audited() - was === 4, 'each refusal is audited');

  // An overlap that predates this check is shown on the beta card; it must not
  // block every unrelated save of the Movies card until someone finds it.
  configStore.get().beta.groups = [TESTING, MAIN_REQ];
  r = await call('PUT', '/api/config', { movieRequests: { cooldownSecondsPerUser: 12 } });
  ok(r.status === 200, 'an unrelated save goes through despite an old overlap');
  configStore.get().beta.groups = [TESTING];
}

console.log('=== a beta save clears a retired feature\'s mode ===');
{
  configStore.get().beta.features = { ghost: 'on' };      // left behind by a feature since deleted
  const r = await call('PUT', '/api/config', { beta: { features: {} } });
  ok(r.status === 200 && configStore.get().beta.features.ghost === null,
    'the stale "on" is cleared, so a reused key could not inherit it');
}
{
  // beta001 left the registry on 2026-10-11. The live config.json can hold
  // its key's mode, and a panel page loaded before the upgrade still sends
  // it with every save of the beta card: it is neither stored nor kept.
  configStore.get().beta.features = { 'movie-pick-list': 'on' };
  const r = await call('PUT', '/api/config', { beta: { features: { 'movie-pick-list': 'off', 'movie-duplicate-notice': 'off' } } });
  ok(r.status === 200 && configStore.get().beta.features['movie-pick-list'] === null
    && configStore.get().beta.features['movie-duplicate-notice'] === 'off',
  'a stale page\'s mode for the "which one?" list is dropped, and the one left in config.json cleared');
  configStore.get().beta.features = {};
}

console.log('=== bulk re-run leaves a film sent since alone ===');
{
  // Minority Report and Charlie failed on the full disk and were then sent
  // (2026-09-28); a bulk re-run would have posted each once more.
  requeued.length = 0;
  stateStore.namespace('movie-requests').set('history', [
    { id: '4', at: 4, title: 'Heat', year: 1995, request: 'heat', status: 'sent' },
    { id: '3', at: 3, title: 'Heat', year: 1995, request: 'heat 1995', status: 'failed' },
    { id: '2', at: 2, title: 'Dune', request: 'dune', status: 'failed' },
  ]);
  const r = await call('POST', '/api/requeue-all');
  ok(requeued.join() === 'dune' && r.json.skipped.some((x) => /^Heat: sent since$/.test(x)),
    `only what nobody was sent since is re-run (${requeued.join()}; ${r.json.skipped.join(' | ')})`);
  requeued.length = 0;
}

console.log('=== bulk re-run leaves beta rows alone ===');
{
  stateStore.namespace('movie-requests').set('history', [
    { id: '1', title: 'Inception', request: 'inception', status: 'failed', beta: true },
    { id: '2', title: 'Dune', request: 'dune', status: 'failed' },
  ]);
  const r = await call('POST', '/api/requeue-all');
  ok(r.status === 200, 'answers');
  ok(requeued.join() === 'dune', `only the main request is re-run (${requeued.join()})`);
  ok(r.json.betaSkipped === 1, 'and the skipped beta row is reported, not silently dropped');
  // Folded into `skipped`, three beta rows read "skipped 1 (blocked / not
  // found / not in library)" - the wrong count and the wrong reason.
  ok(!r.json.skipped.some((s) => /beta/.test(s)), 'counted on its own, not as a blocked / not-found skip');
  const last = stateStore.namespace('audit').get('events', [])[0];
  ok(/1 beta test\(s\) left for the beta group/.test(last.detail) && !/skipped/.test(last.detail),
    `the audit line says so too: "${last.detail}"`);
}

server.close();

console.log('=== no real network was touched ===');
ok(netCalls.every((u) => u.includes('omdbapi.com') || u.startsWith('http://jf.test')),
  'every call went to a stubbed host');

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
