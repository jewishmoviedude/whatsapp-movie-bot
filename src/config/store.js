import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DEFAULT_CONFIG, SECRET_PATHS, mergeDefaults, getPath, setPath } from './schema.js';
import { encrypt, decrypt, isEncrypted, randomToken } from '../util/crypto.js';
import log from '../util/logger.js';

const logger = log.scope('config');
export const MASK = '••••••••';

/**
 * Loads/saves data/config.json, transparently encrypting secret fields.
 * In-memory the config is always plaintext; encryption happens on write.
 */
export class ConfigStore {
  constructor({ dataDir, masterKey }) {
    this.dataDir = dataDir;
    this.masterKey = masterKey;
    this.file = path.join(dataDir, 'config.json');
    this.config = null;
    this.listeners = new Set();
  }

  load() {
    let stored = {};
    // A config.json an earlier start wrote, as against a new install's first
    // start (or a file so broken that this start falls back to the defaults).
    let saved = false;
    if (fs.existsSync(this.file)) {
      try {
        stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        saved = isPlainObject(stored);
      } catch (err) {
        logger.error(`config.json is not valid JSON, falling back to defaults: ${err.message}`);
        const backup = `${this.file}.corrupt-${Date.now()}`;
        try { fs.copyFileSync(this.file, backup); logger.warn(`saved copy to ${backup}`); } catch {}
        stored = {};
      }
    }

    const merged = mergeDefaults(stored, DEFAULT_CONFIG);
    // Decrypt secrets into memory
    for (const p of SECRET_PATHS) {
      const v = getPath(merged, p);
      if (isEncrypted(v)) setPath(merged, p, decrypt(v, this.masterKey));
    }

    this.config = merged;

    // First-run bootstrap
    let dirty = false;
    // gemini-2.0-flash was the default model until Google retired it on
    // 2026-09-22, so an install holding it is holding a dead default, not a
    // choice. Blank is Automatic now: the newest Flash the key can see.
    if (this.config.gemini?.model === 'gemini-2.0-flash') {
      this.config.gemini.model = '';
      dirty = true;
    }
    if (dropRetiredReactions(this.config)) dirty = true;
    if (saved) {
      const kept = keepSavedChoices(stored, this.config);
      if (kept.length) {
        logger.info(`kept what this install chose before the defaults changed on 2026-10-12: ${kept.join('; ')}`);
        dirty = true;
      }
    }
    if (!this.config.web.sessionSecret) {
      this.config.web.sessionSecret = randomToken(32);
      dirty = true;
    }
    if (!this.config.media.workDir) {
      this.config.media.workDir = path.join(this.dataDir, 'media');
      dirty = true;
    }
    if (dirty) this.save();

    fs.mkdirSync(this.config.media.workDir, { recursive: true });
    return this.config;
  }

  save() {
    const out = JSON.parse(JSON.stringify(this.config));
    for (const p of SECRET_PATHS) {
      const v = getPath(out, p);
      if (v) setPath(out, p, encrypt(v, this.masterKey));
    }
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);   // atomic; avoids a truncated config on crash
    return this.config;
  }

  get() {
    return this.config;
  }

  /**
   * Apply a partial update (deep merge). Values equal to MASK are treated as
   * "unchanged" so the UI can round-trip a form without leaking real secrets.
   */
  update(patch) {
    applyPatch(this.config, patch, JSON.parse(JSON.stringify(this.config)));
    this.save();
    for (const fn of this.listeners) {
      try { fn(this.config); } catch (err) { logger.error(`config listener failed: ${err.message}`); }
    }
    return this.config;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Config safe to hand to the browser: secrets replaced with a mask. */
  redacted() {
    const out = JSON.parse(JSON.stringify(this.config));
    for (const p of SECRET_PATHS) {
      if (getPath(out, p)) setPath(out, p, MASK);
    }
    // Password hashes never leave the server, masked or not.
    setPath(out, 'web.adminPasswordHash', getPath(this.config, 'web.adminPasswordHash') ? MASK : '');
    if (Array.isArray(out.web?.admins)) {
      out.web.admins = out.web.admins.map(({ passwordHash, ...a }) => a);   // strip hashes
    }
    delete out.web.sessionSecret;
    return out;
  }
}

/**
 * The config as ConfigStore.update(patch) would leave `current`, without
 * touching it. PUT /config judges a settings save by what it would do before
 * it does it (filmGroupClashes, postsGroupEmptied, sweepingChange below): the
 * save of 2026-10-12 21:00 was only readable as harm once it had been made.
 * The patch's own lists end up in the result, as they would in the store.
 */
export function previewPatch(current, patch) {
  const before = JSON.parse(JSON.stringify(current ?? {}));
  return applyPatch(JSON.parse(JSON.stringify(current ?? {})), patch, before);
}

/**
 * Merge a settings patch into `target` the way update() saves it: a deep
 * merge, the retired reactions taken out, and a secret sent as the mask kept
 * as it was in `before`. Shared with previewPatch(), so what a save is judged
 * on is exactly what it would store.
 */
function applyPatch(target, patch, before) {
  deepAssign(target, patch);
  // A panel tab opened before the redo field went still sends it with Save.
  dropRetiredReactions(target);
  for (const p of SECRET_PATHS) {
    if (getPath(target, p) === MASK) setPath(target, p, getPath(before, p));
  }
  return target;
}

/**
 * Reactions no code sends any more, by section. `redo` (🔄, "resumed after a
 * restart / retried") went on 2026-10-11: a restart put it on Ethan
 * Adams's "Iron Man 3 2013", he read it as "send it again", did, and was
 * answered 🤥 (src/media/stage-reaction.js). Every install's config.json
 * holds one, saved by the panel's old "Redo / resumed" field.
 */
const RETIRED_REACTIONS = ['redo'];

/**
 * Take the retired reactions out of a loaded config, and say whether any
 * was there. Harmless left in place, since nothing reads them - but a key
 * left in config.json is inherited by any new reaction that is ever given
 * its name, as a retired beta key's mode would be (CLAUDE.md, "Never reuse a
 * retired key"), so it goes, and the file is saved without it once.
 */
export function dropRetiredReactions(config) {
  let dropped = false;
  for (const section of ['movieRequests', 'tvRequests']) {
    const r = config?.[section]?.reactions;
    if (!r || typeof r !== 'object') continue;
    for (const key of RETIRED_REACTIONS) {
      if (Object.prototype.hasOwnProperty.call(r, key)) { delete r[key]; dropped = true; }
    }
  }
  return dropped;
}

/**
 * Keep what a config.json saved before 2026-10-12 had, where a default that
 * changed that day would otherwise change it on upgrade. Returns what it
 * kept, in words, for the log; the caller saves the file once, after which
 * every key below is in it and this finds nothing to do.
 *
 * The operator's live settings became the defaults that day ("I just
 * updated most of the settings, please set these in the repo coding as
 * default"). A setting a config.json holds is kept over any default
 * (mergeDefaults), so for almost all of them a new default reaches only a
 * new install. Two are different, and a review of that change found both:
 *
 * - A beta feature's mode is a key in a map the panel writes only when the
 *   Beta tab is saved, so an install that never saved it holds
 *   `beta.features: {}`, and mergeDefaults filled that with the three new
 *   'on' modes: an upgrade switched them on in every group, the main ones
 *   included, past the confirmation the panel asks for On. The operator
 *   runs a second bot from this repo, on another number and machine, and
 *   a change in what its groups are told is not something to make there
 *   unseen. A feature such a file does not name is kept Off, as it was.
 *   One it names, Off or not, was chosen and stands; the operator's own
 *   box, which saved all three On, keeps them On.
 * - The lockdown waits on a new install until somebody has looked at its
 *   always-locked list (scheduleHeld in src/core/lockdown.js). A file that
 *   saved the lockdown switched on, when it was off by default, is somebody
 *   who did: it locks and opens every group as it always has.
 *
 * Only a file an earlier start wrote is a saved choice. A new install's
 * first start writes every one of these keys with the new defaults, so it
 * gets the three features On and its lockdown waits for a look.
 */
export function keepSavedChoices(stored, config) {
  const kept = [];
  const saved = isPlainObject(stored?.beta?.features) ? stored.beta.features : {};
  const off = Object.entries(DEFAULT_CONFIG.beta.features)
    .filter(([key, mode]) => mode !== 'off' && !Object.hasOwn(saved, key)).map(([key]) => key);
  if (off.length && isPlainObject(config?.beta?.features)) {
    for (const key of off) config.beta.features[key] = 'off';
    kept.push(`beta feature${off.length === 1 ? '' : 's'} ${off.join(', ')} Off (never switched on here; On by default only on a new install)`);
  }
  const lockdown = isPlainObject(stored?.lockdown) ? stored.lockdown : {};
  if (!Object.hasOwn(lockdown, 'alwaysLockedReviewed') && lockdown.enabled === true && isPlainObject(config?.lockdown)) {
    config.lockdown.alwaysLockedReviewed = true;
    kept.push('the lockdown it switched on, locking and opening its groups as before');
  }
  return kept;
}

/**
 * Keys a merge must never follow.
 *
 * JSON.parse turns "__proto__" into an ordinary own key, and target["__proto__"]
 * is Object.prototype itself - so merging {"__proto__": {...}} wrote onto the
 * prototype of every object in the process. A review of the per-admin sign-out
 * timeout found a plain admin could do exactly that with one settings save:
 * {"__proto__": {"idleTimeoutMinutes": 0}} gave every account without a value
 * of its own a timeout of "never", and {"web": {"__proto__": {"user": ...}}}
 * made a visitor with no cookie at all look signed in as the super-admin. The
 * config itself did not change, so the save was logged as "no effective
 * change" and left no audit row. "constructor" and "prototype" are the other
 * well-known way to the same place, and no setting is called either.
 */
export const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Why a settings patch from the panel must not be merged, or null if it may.
 *
 * Two shapes are refused, anywhere in the body. A key from UNSAFE_KEYS, for the
 * reason above. And a section of settings - anything the current config holds
 * as a plain object - sent as something else: deepAssign assigns a non-object
 * wholesale, so {"web": []} replaced the whole web section, admin accounts and
 * session secret included, and saved it. With no accounts left the panel
 * offered first-run setup to whoever asked next, and they chose the new
 * super-admin's password. {"web": null} made every route answer 500 until a
 * restart, which came back with no accounts and the same open setup. The
 * panel only ever sends sections as objects, so nothing it sends lands here.
 */
export function patchProblem(current, patch) {
  if (!isPlainObject(patch)) return `the body was ${describeShape(patch)}, not a set of settings`;
  return shapeProblem(current, patch, '');
}

function shapeProblem(current, patch, at) {
  for (const [k, v] of Object.entries(patch)) {
    const where = clip(at ? `${at}.${k}` : k);
    if (UNSAFE_KEYS.has(k)) return `"${where}" is not a setting`;
    const was = isPlainObject(current) && Object.hasOwn(current, k) ? current[k] : undefined;
    if (isPlainObject(was) && !isPlainObject(v)) {
      return `"${where}" was sent as ${describeShape(v)}, where a section of settings belongs`;
    }
    // Arrays are walked too: they are stored wholesale, but an unsafe key
    // inside one is still nothing the panel would send.
    if (v !== null && typeof v === 'object') {
      const inner = shapeProblem(isPlainObject(v) ? was : undefined, v, where);
      if (inner) return inner;
    }
  }
  return null;
}

/**
 * Every setting that names WhatsApp groups, by path. Emptying one stops
 * something reaching people - the posts, the play-by-play, the TV service, a
 * lock - so a settings save may empty a stored one only when it says it means
 * to (holdGroupClears).
 */
export const GROUP_SETTINGS = [
  'movieRequests.requestGroups', 'movieRequests.postsGroup', 'movieRequests.notify.group',
  'tvRequests.requestGroups', 'tvRequests.postsGroups', 'directLinks.groups',
  'beta.groups', 'beta.postsGroup', 'lockdown.alwaysLocked',
];

/** No group at all: a blank or missing JID, or a list without one. */
const noGroup = (v) => (Array.isArray(v)
  ? !v.some((j) => typeof j === 'string' && j.trim())
  : v == null || (typeof v === 'string' && !v.trim()));

/**
 * Take out of a settings patch every group setting it would empty without
 * naming it in `confirmed`, and say which. The stored group stands; the rest
 * of the patch is saved as usual.
 *
 * The panel's group pickers used to be filled only once the group list
 * arrived, and drew only the groups the connected number is in. A save before
 * the list came - or of a card whose saved group this number is not in -
 * therefore sent "no group" for pickers nobody had touched, and the store,
 * which merges whatever it is given, saved it. The request groups were already
 * kept this way (?allowEmptyGroups=1); the posts group, the queue
 * notifications group, the TV, direct-links, beta and always-locked groups
 * were not. The panel now names a group setting in ?clearGroups= only when it
 * showed a saved group and somebody chose "none" or unticked the last box.
 * Holding the rest here covers a copy of the panel loaded before that change,
 * still open in somebody's browser, and anything else that sends a whole form.
 *
 * Stripped rather than refused, like the request groups before: the save is
 * otherwise what somebody meant, and refusing it whole would turn an ordinary
 * save in an old tab into "Nothing was saved".
 *
 * @param {object} current   the config as it is now
 * @param {object} patch     the settings save; the held fields are deleted from it
 * @param {Iterable<string>} confirmed  paths the sender says were emptied on purpose
 * @returns {{path: string, was: any}[]}
 */
export function holdGroupClears(current, patch, confirmed = []) {
  const meant = new Set(confirmed);
  const held = [];
  for (const path of GROUP_SETTINGS) {
    const keys = path.split('.');
    const leaf = keys.pop();
    let at = patch;
    for (const k of keys) at = isPlainObject(at) && Object.hasOwn(at, k) ? at[k] : undefined;
    if (!isPlainObject(at) || !Object.hasOwn(at, leaf) || !noGroup(at[leaf])) continue;
    const was = getPath(current, path);
    if (noGroup(was) || meant.has(path)) continue;
    delete at[leaf];
    held.push({ path, was });
  }
  return held;
}

/*
 * Saves that make no sense, judged on the config a save would leave
 * (previewPatch) against the config as it is.
 *
 * On 2026-10-12 at 21:00 UTC one "Save settings" by the super-admin changed 22
 * settings in the film, Gemini, email and other sections. The operator had
 * changed the film cooldown and the text reply; the save also made every group
 * but five a film request group - both posts groups, the TV request group and
 * the queue notifications group among them - emptied the posts and
 * notifications groups, and switched off the theatrical check, Gemini, the
 * nudity check and the email alerts. At 21:32 the film plugin answered "Drake &
 * Josh is a TV series, not a film" in the TV request group, to a member asking
 * it for episodes. At 22:10 a page left open since then put the
 * theatrical check, Gemini and email back off over the hand restore. The
 * panel now saves only what was edited on the page (FORM_FIELDS in app.js);
 * these are for anything that still sends more - a page loaded before that
 * change, open in somebody's browser, above all.
 *
 * Each is judged on what the save ADDS: a config that already holds the
 * problem (put there by hand) does not block a save of something else.
 */

const jidsOf = (v) => (Array.isArray(v) ? v : [v]).filter((j) => typeof j === 'string' && j.trim()).map((j) => j.trim());

/**
 * Every film request group that is also a group a film request must never be
 * taken in, with what that group is: a posts group (film or TV) is where the
 * bot posts and members may not, the TV request group is the TV plugin's (the
 * film plugin answered "is a TV series, not a film" there), and the queue
 * notifications group is the play-by-play.
 *
 * @returns {{jid: string, as: string}[]}
 */
export function filmGroupClashes(config) {
  const mr = config?.movieRequests ?? {};
  const tv = config?.tvRequests ?? {};
  const roles = [
    ['the film posts group', [...jidsOf(mr.postsGroup), ...jidsOf(mr.postsGroups)]],
    ['a TV posts group', [...jidsOf(tv.postsGroup), ...jidsOf(tv.postsGroups)]],
    ['the TV request group', jidsOf(tv.requestGroups)],
    ['the queue notifications group', jidsOf(mr.notify?.group)],
  ];
  const out = [];
  for (const jid of new Set(jidsOf(mr.requestGroups))) {
    for (const [as, jids] of roles) {
      if (jids.includes(jid)) { out.push({ jid, as }); break; }
    }
  }
  return out;
}

/** The clashes a save would make that the config does not already hold. */
export function addedFilmGroupClashes(current, next) {
  const had = new Set(filmGroupClashes(current).map((c) => `${c.jid} ${c.as}`));
  return filmGroupClashes(next).filter((c) => !had.has(`${c.jid} ${c.as}`));
}

/** A film plugin taking requests with nowhere to post what it finds. */
function postsless(config) {
  const mr = config?.movieRequests ?? {};
  const on = Array.isArray(config?.plugins?.enabled) && config.plugins.enabled.includes('movie-requests');
  return on && jidsOf(mr.requestGroups).length > 0 && !jidsOf(mr.postsGroup).length && !jidsOf(mr.postsGroups).length;
}

/**
 * True when the save would leave the film plugin switched on, with request
 * groups, and no posts group at all (postsGroup and postsGroups both empty),
 * where it had one before - or where it had no request groups before. Every
 * film found would then be found for nobody.
 */
export function postsGroupEmptied(current, next) {
  return postsless(next) && !postsless(current);
}

/**
 * The sections "Save settings" sent every time until 2026-10-12, each one
 * whole, whatever had been edited. A body holding all of them is that form.
 */
const WHOLE_FORM_SECTIONS = ['whatsapp', 'movieRequests', 'gemini', 'library', 'media', 'web', 'logging', 'email', 'plugins'];

/**
 * Is this the whole Settings form, as a page loaded before 2026-10-12 sends
 * it with every save? Such a page wrote back whatever it still showed - at
 * 22:10 that day, the theatrical check, Gemini and email it had shown off
 * since 21:00, over a restore made on the box in between. The panel since
 * sends only what was edited, and says so (?edited=1), so a whole form
 * without that mark is a page that has not been reloaded since, and nothing
 * in it can be told from what somebody changed on purpose.
 */
export function isWholeSettingsForm(patch) {
  return isPlainObject(patch) && WHOLE_FORM_SECTIONS.every((k) => isPlainObject(patch[k]));
}

/** Changes in this many sections, or this many changes, are more than an edit. */
const SWEEP_SECTIONS = 3;
const SWEEP_CHANGES = 10;

/**
 * A save that changes many settings across sections at once, or null.
 *
 * The panel sends only the settings somebody edited, and an edit is a card or
 * two. A save that would change settings in three sections or more, or ten
 * settings or more, is what a whole form sends from a page that no longer
 * shows what is saved - the 21:00 and 22:10 saves above - so it is made only
 * when the sender confirms it, with the fingerprint of exactly these changes
 * (changesFingerprint): the panel shows the list and asks, a page from before
 * the panel could ask is refused. Secret changes are listed but not counted:
 * a key is sent only when one is typed, and the API keys card may well take
 * three at once.
 *
 * @param {{path: string, secret: boolean}[]} changes  changedPaths() of the save
 * @returns {{sections: string[], count: number} | null}
 */
export function sweepingChange(changes) {
  const plain = changes.filter((c) => !c.secret);
  const sections = [...new Set(plain.map((c) => c.path.split('.')[0]))];
  if (sections.length < SWEEP_SECTIONS && plain.length < SWEEP_CHANGES) return null;
  return { sections, count: changes.length };
}

/** A short fingerprint of a list of changes, to confirm exactly those and no others. */
export function changesFingerprint(changes) {
  const h = createHash('sha256');
  for (const c of changes) h.update(`${c.path}\u0000${c.secret ? '' : JSON.stringify(c.from ?? null)}\u0000${c.secret ? '' : JSON.stringify(c.to ?? null)}\u0001`);
  return h.digest('hex').slice(0, 16);
}

/** Key names come from whoever sent the body, and end up in the audit log. */
const clip = (s) => (s.length > 80 ? `${s.slice(0, 80)}…` : s);

function describeShape(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'a list';
  return typeof v === 'string' ? 'text' : `a ${typeof v}`;
}

function deepAssign(target, patch) {
  for (const [k, v] of Object.entries(patch ?? {})) {
    // The route refuses these before they get here (patchProblem); this is
    // for every other caller of update(), which is also trusted not to need
    // them. Skipped loudly, so a caller that trips it can be found.
    if (UNSAFE_KEYS.has(k)) {
      logger.warn(`ignored "${k}" in a config update - it is not a setting, and following it would change every object in the process`);
      continue;
    }
    if (isPlainObject(v)) {
      // Only an OWN value is merged into. An inherited one is not part of the
      // config, and descending into it would write to whatever it belongs to.
      if (!Object.hasOwn(target, k) || !isPlainObject(target[k])) target[k] = {};
      deepAssign(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}
