import { hashPassword, verifyPassword } from '../util/crypto.js';
import log from '../util/logger.js';
import { ownIdleMinutes, parseIdleMinutes } from './idle.js';

const logger = log.scope('auth');

const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

const clientKey = (req) => req.ip ?? req.socket.remoteAddress ?? 'unknown';

export function isRateLimited(req) {
  const rec = attempts.get(clientKey(req));
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) { attempts.delete(clientKey(req)); return false; }
  return rec.count >= MAX_ATTEMPTS;
}
export function recordFailure(req) {
  const key = clientKey(req);
  const rec = attempts.get(key);
  if (!rec || Date.now() - rec.first > WINDOW_MS) attempts.set(key, { count: 1, first: Date.now() });
  else rec.count += 1;
  logger.warn(`failed login from ${key} (${attempts.get(key).count}/${MAX_ATTEMPTS})`);
}
export function clearFailures(req) { attempts.delete(clientKey(req)); }

const SUPER = 'superadmin';   // fixed username for the shared super-admin

function admins(cs) { return cs.get().web.admins ?? []; }
const norm = (u) => String(u ?? '').trim().toLowerCase();

/**
 * One-time upgrade: fold the legacy single password into a super-admin account
 * so nobody is locked out after the multi-account change.
 */
export function migrateIfNeeded(cs) {
  const web = cs.get().web;
  if ((web.admins?.length ?? 0) === 0 && web.adminPasswordHash) {
    cs.update({ web: {
      admins: [{ username: SUPER, passwordHash: web.adminPasswordHash, role: 'superadmin', createdAt: Date.now(), lastLogin: null }],
      adminPasswordHash: '',
    } });
    logger.warn(`migrated legacy password into the "${SUPER}" super-admin account`);
  }
}

/** No accounts and no legacy password -> first-run setup screen. */
export function needsSetup(cs) {
  const web = cs.get().web;
  return (web.admins?.length ?? 0) === 0 && !web.adminPasswordHash;
}

export function setupSuperAdmin(cs, password) {
  if (!password || password.length < 8) throw new Error('Password must be at least 8 characters');
  cs.update({ web: {
    admins: [{ username: SUPER, passwordHash: hashPassword(password), role: 'superadmin', createdAt: Date.now(), lastLogin: null }],
    adminPasswordHash: '',
  } });
  logger.info('super-admin account created');
}

export function findAdmin(cs, username) {
  return admins(cs).find((a) => norm(a.username) === norm(username)) ?? null;
}

/** Returns { username, role } on success, else null. Records lastLogin. */
export function authenticate(cs, username, password) {
  migrateIfNeeded(cs);
  const user = norm(username) || SUPER;     // blank username defaults to the super-admin
  const admin = findAdmin(cs, user);
  if (!admin || !verifyPassword(password, admin.passwordHash)) return null;
  const list = admins(cs).map((a) => (norm(a.username) === norm(user) ? { ...a, lastLogin: Date.now() } : a));
  cs.update({ web: { admins: list } });
  return { username: admin.username, role: admin.role, ...(admin.mustChangePassword ? { mustChangePassword: true } : {}) };
}

/**
 * Must this account choose its own password before it can do anything?
 *
 * True after a super-admin gave it one: a new account, or a reset. The
 * operator, 2026-10-08: "when I assign an admin a temp password they should be
 * prompted to change it on first login". Read from the account list on every
 * request rather than the copy in the session, so a reset reaches a session
 * that is already open.
 */
export function mustChangePassword(cs, username) {
  return !!findAdmin(cs, username)?.mustChangePassword;
}

/** What a must-change session may still reach: the change itself. Sign-in,
    sign-out and the status check are not behind the guard at all. */
const ALLOWED_BEFORE_CHANGE = new Set(['/auth/password']);

export function listAdmins(cs) {
  const web = cs.get().web;
  // idleTimeoutMinutes is what the idle guard will actually apply for this
  // account (null = the global default), not merely what is stored, so the
  // Admins tab cannot show a value the server is quietly ignoring.
  return admins(cs).map(({ username, role, createdAt, lastLogin, mustChangePassword: mcp }) => ({
    username, role, createdAt, lastLogin, mustChangePassword: !!mcp,
    idleTimeoutMinutes: ownIdleMinutes(web, username),
  }));
}

/**
 * Is this signed-in user a super-admin right now?
 *
 * The role in a session is a copy taken at sign-in. The account list is the
 * truth, so anything that decides who may change sign-out timeouts checks both:
 * a session that says "superadmin" for an account that no longer exists, or is
 * no longer one, gets nothing.
 */
export function isSuperAdmin(cs, user) {
  if (user?.role !== 'superadmin') return false;
  return findAdmin(cs, user.username)?.role === 'superadmin';
}

/**
 * Set how long one admin may stay signed in without doing anything. null puts
 * them back on the global default; 0 means they are never signed out.
 *
 * The super-admin check lives here as well as on the route. The owner asked
 * that only he can set these - above all 0, which switches the protection off
 * for an account - so the function that writes the value refuses on its own
 * rather than trusting every caller to have remembered the guard.
 *
 * @returns {{ username: string, before: number|null, after: number|null }}
 */
export function setAdminTimeout(cs, actor, username, minutes) {
  if (!isSuperAdmin(cs, actor)) {
    throw Object.assign(new Error('Only the super-admin can set sign-out timeouts.'), { status: 403 });
  }
  const target = findAdmin(cs, username);
  if (!target) throw Object.assign(new Error('no such account'), { status: 404 });
  const after = parseIdleMinutes(minutes, { allowNull: true });
  const before = ownIdleMinutes(cs.get().web, target.username);

  // Back to the default removes the field rather than storing null, so the
  // account is byte-for-byte what it was before per-admin timeouts existed.
  const list = admins(cs).map((a) => {
    if (norm(a.username) !== norm(target.username)) return a;
    const { idleTimeoutMinutes: _replaced, ...rest } = a;
    return after === null ? rest : { ...rest, idleTimeoutMinutes: after };
  });
  cs.update({ web: { admins: list } });
  logger.info(`sign-out timeout for "${target.username}": ${before ?? 'default'} -> ${after ?? 'default'}`);
  return { username: target.username, before, after };
}

export function addAdmin(cs, username, password, role = 'admin') {
  const u = String(username ?? '').trim();
  if (!/^[a-zA-Z0-9._-]{2,32}$/.test(u)) throw new Error('Username must be 2-32 chars: letters, numbers, . _ -');
  if (!password || password.length < 8) throw new Error('Password must be at least 8 characters');
  if (!['admin', 'superadmin'].includes(role)) throw new Error('invalid role');
  if (findAdmin(cs, u)) throw new Error(`"${u}" already exists`);
  const list = [...admins(cs), { username: u, passwordHash: hashPassword(password), role, createdAt: Date.now(), lastLogin: null, mustChangePassword: true }];
  cs.update({ web: { admins: list } });
  logger.info(`added ${role} "${u}" with a temporary password`);
}

export function removeAdmin(cs, username) {
  const target = findAdmin(cs, username);
  if (!target) throw new Error('no such account');
  const supers = admins(cs).filter((a) => a.role === 'superadmin');
  if (target.role === 'superadmin' && supers.length <= 1) throw new Error('cannot remove the last super-admin');
  cs.update({ web: { admins: admins(cs).filter((a) => norm(a.username) !== norm(username)) } });
  logger.info(`removed account "${target.username}"`);
}

/**
 * @param temporary true when someone else chose the password (a super-admin's
 *   reset): its holder must change it at their next sign-in. False - their
 *   own change - clears that.
 */
export function resetPassword(cs, username, newPassword, { temporary = false } = {}) {
  if (!findAdmin(cs, username)) throw new Error('no such account');
  if (!newPassword || newPassword.length < 8) throw new Error('Password must be at least 8 characters');
  const list = admins(cs).map((a) => {
    if (norm(a.username) !== norm(username)) return a;
    const { mustChangePassword: _cleared, ...rest } = a;
    return { ...rest, passwordHash: hashPassword(newPassword), ...(temporary ? { mustChangePassword: true } : {}) };
  });
  cs.update({ web: { admins: list } });
  logger.info(`${temporary ? 'set a temporary password' : 'reset password'} for "${username}"`);
}

export function requireAuth(cs) {
  return (req, res, next) => {
    if (needsSetup(cs)) return res.status(428).json({ error: 'setup-required' });
    const user = req.session?.user;
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    if (mustChangePassword(cs, user.username) && !ALLOWED_BEFORE_CHANGE.has(req.path)) {
      return res.status(403).json({ error: 'password-change-required' });
    }
    return next();
  };
}

export function requireSuperAdmin(cs) {
  return (req, res, next) => {
    if (req.session?.user?.role === 'superadmin') return next();
    return res.status(403).json({ error: 'super-admin only' });
  };
}
