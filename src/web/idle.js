/**
 * Sign an idle admin out.
 *
 * The obvious implementation - "no request for N minutes" - does not work here.
 * The portal polls /queue every five seconds while anything is running and
 * holds an /events stream open for as long as the tab exists, so a browser left
 * open on the super-admin's screen would refresh the timer forever. That is
 * exactly the situation this is meant to protect against.
 *
 * So activity means a DELIBERATE action: anything that changes something, or a
 * read the operator asked for by navigating. Background polling keeps working
 * and keeps getting answers, but it does not extend the session.
 *
 * The limit is per admin. The super-admin asked to decide how long each admin
 * may stay signed in, because one global number either nags the owner on his
 * own screen or leaves a helper's shared laptop signed in for an hour. An admin
 * with no value of their own gets the global web.idleTimeoutMinutes, which is
 * exactly how every account behaved before per-admin values existed.
 */

/** The global default when config carries none. Matches DEFAULT_CONFIG. */
export const DEFAULT_IDLE_MINUTES = 15;

/** A day. Anything longer is "never" in all but name, and 0 already says that. */
export const MAX_IDLE_MINUTES = 1440;

/**
 * Reads the page makes on its own, without anyone touching the keyboard.
 * The guard is mounted app-wide, so paths arrive with the /api prefix; the
 * stream at /events has none. Both forms are accepted.
 */
const PASSIVE_GETS = [
  /^\/queue(\/links)?$/,
  /^\/status$/,
  /^\/wa\/failover$/,
  /^\/auth\/status$/,
  /^\/events$/,          // the SSE stream: open for as long as the tab is
];

export function isPassive(req) {
  if (req.method !== 'GET') return false;
  const path = String(req.path ?? '').replace(/^\/api(?=\/|$)/, '');
  return PASSIVE_GETS.some((re) => re.test(path));
}

/** A value the middleware will honour: a whole number of minutes, 0 to a day. */
export function isIdleMinutes(v) {
  return Number.isInteger(v) && v >= 0 && v <= MAX_IDLE_MINUTES;
}

/**
 * Validate a timeout typed into the portal. Returns the number, or null for
 * "use the global default" when that is allowed; throws a message fit to show
 * the admin otherwise.
 *
 * Strings are refused rather than coerced. The portal sends numbers, and the
 * reason the settings form is careful here at all is that +'' is 0 - a blank
 * box silently coerced would DISABLE the timeout, which is the one value only
 * the super-admin may choose.
 */
export function parseIdleMinutes(v, { allowNull = false } = {}) {
  if (v === null && allowNull) return null;
  if (!isIdleMinutes(v)) {
    throw new Error(`The sign-out timeout must be a whole number of minutes from 0 to ${MAX_IDLE_MINUTES}`
      + `${allowNull ? ', or empty for the default' : ''} (0 means never).`);
  }
  return v;
}

const norm = (u) => String(u ?? '').trim().toLowerCase();

/**
 * How long this admin may sit idle, read from the CURRENT config on every
 * request rather than from anything copied into the session at sign-in - so a
 * change the super-admin makes applies to a session that is already open, the
 * way the global value always has.
 *
 * A stored value the middleware would not accept (hand-edited config, a
 * string, a negative) falls back to the global default rather than being
 * guessed at: guessing wrong in one direction disables the timeout.
 */
export function effectiveIdleMinutes(web, username) {
  const own = ownIdleMinutes(web, username);
  if (own !== null) return own;
  return (web && Object.hasOwn(web, 'idleTimeoutMinutes') ? web.idleTimeoutMinutes : null) ?? DEFAULT_IDLE_MINUTES;
}

/**
 * This admin's own override, or null when they use the global default.
 *
 * Only a value the account itself carries counts. A plain property read also
 * finds one inherited from Object.prototype, and a review found a settings save
 * that put idleTimeoutMinutes: 0 there - which every account without a value of
 * its own, i.e. nearly all of them, then read as "never sign out". The config
 * store no longer lets that key through, but the one value that switches this
 * protection off should not depend on nothing else in the process ever having
 * been polluted.
 */
export function ownIdleMinutes(web, username) {
  const who = norm(username);
  if (!who) return null;
  const me = (web?.admins ?? []).find((a) => norm(a?.username) === who);
  if (!me || !Object.hasOwn(me, 'idleTimeoutMinutes')) return null;
  return isIdleMinutes(me.idleTimeoutMinutes) ? me.idleTimeoutMinutes : null;
}

/**
 * @param {(user: object) => number} minutes  how long the signed-in admin may
 *        sit idle; 0 disables. Called with the session's user on every request.
 * @param {() => number} now      injectable clock, for tests
 */
export function idleTimeout(minutes, now = () => Date.now()) {
  return function idleGuard(req, res, next) {
    const user = req.session?.user;
    if (!user) return next();                       // not signed in; nothing to expire

    const mins = Number(minutes(user)) || 0;
    if (mins > 0) {
      const limit = mins * 60_000;
      const last = req.session.lastActive ?? now();
      if (now() - last > limit) {
        // Destroy rather than just refuse: the cookie must stop working, or the
        // next click would be authorised again by the same session.
        const done = () => res.status(440).json({
          error: 'session-expired',
          message: `Signed out after ${mins} minutes without activity.`,
        });
        if (typeof req.session.destroy === 'function') req.session.destroy(done);
        else { req.session.user = null; done(); }
        return undefined;
      }
    }

    // Only a deliberate action pushes the deadline out. This is recorded even
    // while the timeout is off (0), because the super-admin can turn it back on
    // for a session that is already open: measured from a lastActive frozen at
    // the moment it was switched off, an admin who had been clicking away all
    // afternoon would be thrown out on the very next request.
    if (!isPassive(req)) req.session.lastActive = now();
    return next();
  };
}
