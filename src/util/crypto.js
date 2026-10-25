import crypto from 'node:crypto';

/**
 * Secrets (API keys, Jellyfin tokens, the admin password hash) live in
 * data/config.json. We encrypt the secret values at rest with a key derived
 * from MASTER_KEY in .env, so a leaked config file alone is not enough.
 */
const ALGO = 'aes-256-gcm';

function keyFromMaster(master) {
  // Fixed salt: the master key is already high-entropy and generated per-install.
  return crypto.scryptSync(master, 'wa-bot-config-v1', 32);
}

export function encrypt(plaintext, master) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, keyFromMaster(master), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${Buffer.concat([iv, tag, enc]).toString('base64')}`;
}

export function decrypt(value, master) {
  if (typeof value !== 'string' || !value.startsWith('enc:v1:')) return value;
  try {
    const raw = Buffer.from(value.slice(7), 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const enc = raw.subarray(28);
    const decipher = crypto.createDecipheriv(ALGO, keyFromMaster(master), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    // Wrong/rotated MASTER_KEY. Surface as empty rather than crashing the app.
    return '';
  }
}

export function isEncrypted(v) {
  return typeof v === 'string' && v.startsWith('enc:v1:');
}

/** Password hashing for the web UI login (scrypt, no native dependency). */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt:')) return false;
  const [, saltHex, hashHex] = stored.split(':');
  try {
    const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
    return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
  } catch {
    return false;
  }
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}
