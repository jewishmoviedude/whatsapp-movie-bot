import log from '../../util/logger.js';

const logger = log.scope('jellyfin-auth');

/**
 * Jellyfin authentication.
 *
 * Three ways in, all ending at the same place - an AccessToken used as the
 * X-Emby-Token header:
 *
 *   apikey       - a key made in Dashboard -> API Keys. Never expires,
 *                  but you have to go and create it.
 *   password     - username + password. Simplest to set up; the token is
 *                  cached and silently renewed if the server invalidates it.
 *   quickconnect - Jellyfin shows a 6-digit code, you approve it from an
 *                  already-signed-in Jellyfin client. No password ever
 *                  touches this box.
 */

const CLIENT = 'WhatsApp Bot Platform';
const DEVICE = 'ubuntu-server';
const VERSION = '1.0.0';

/** Jellyfin requires an identifying Authorization header on auth calls. */
function authHeader(deviceId = DEVICE) {
  return `MediaBrowser Client="${CLIENT}", Device="${DEVICE}", DeviceId="${deviceId}", Version="${VERSION}"`;
}

/** Turn an opaque fetch rejection into something worth reading. */
function describeNetworkError(err, url) {
  const cause = err.cause ?? err;
  const code = cause.code ?? '';
  let host = url;
  try { host = new URL(url).host; } catch { /* keep the raw string */ }

  switch (code) {
    case 'ECONNREFUSED':
      return `Nothing is listening at ${host} - check the address and port`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Could not resolve ${host} - check the hostname`;
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return `Timed out connecting to ${host} - is it reachable from this server?`;
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `No route to ${host} from this server`;
    case 'CERT_HAS_EXPIRED':
      return `${host} has an expired TLS certificate`;
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
      return `${host} uses a certificate this server does not trust - put its CA in certs/, or use http:// on your LAN`;
    default:
      return cause.message ? `${host}: ${cause.message}` : `Could not reach ${host}`;
  }
}

function base(url) {
  return String(url || '').replace(/\/+$/, '');
}

/**
 * Combine an external abort signal with a timeout, so a slow server is
 * given time to answer but a hung one does not block the queue forever.
 */
function withTimeout(signal, ms) {
  if (!ms) return { signal, done: () => {} };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timed out after ${Math.round(ms / 1000)}s`)), ms);
  const onAbort = () => ctrl.abort(signal.reason);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

async function jfFetch(url, { method = 'GET', body, token, deviceId, signal, timeoutMs = 30000 } = {}) {
  const headers = {
    Accept: 'application/json',
    Authorization: authHeader(deviceId),
  };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['X-Emby-Token'] = token;

  const t = withTimeout(signal, timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: t.signal,
    });
  } catch (err) {
    t.done();
    if (t.signal.aborted && !signal?.aborted) {
      throw new Error(`Jellyfin did not respond within ${Math.round(timeoutMs / 1000)}s`);
    }
    // Node buries the useful part in err.cause, and "fetch failed" tells the
    // operator nothing while they are trying to get a server URL right.
    throw new Error(describeNetworkError(err, url));
  }

  const text = await res.text().finally(() => t.done());
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }

  if (!res.ok) {
    const err = new Error(data?.raw?.slice?.(0, 200) || `Jellyfin HTTP ${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Username + password -> access token. */
export async function authenticateByPassword(baseUrl, username, password, { deviceId, signal } = {}) {
  if (!baseUrl) throw new Error('Jellyfin server URL is not set');
  if (!username) throw new Error('Jellyfin username is not set');

  const data = await jfFetch(`${base(baseUrl)}/Users/AuthenticateByName`, {
    method: 'POST',
    body: { Username: username, Pw: password ?? '' },
    deviceId,
    signal,
  });

  if (!data?.AccessToken) throw new Error('Jellyfin did not return an access token');
  logger.info(`authenticated as ${data.User?.Name ?? username}`);
  return {
    accessToken: data.AccessToken,
    userId: data.User?.Id ?? null,
    userName: data.User?.Name ?? username,
    serverId: data.ServerId ?? null,
  };
}

/** Is Quick Connect switched on for this server? */
export async function quickConnectEnabled(baseUrl, { signal } = {}) {
  try {
    const data = await jfFetch(`${base(baseUrl)}/QuickConnect/Enabled`, { signal });
    return data === true || data?.raw === 'true';
  } catch (err) {
    logger.warn(`could not read Quick Connect state: ${err.message}`);
    return false;
  }
}

/**
 * Start a Quick Connect request. Returns the code to show the operator and
 * the secret used to poll for approval.
 */
export async function quickConnectInitiate(baseUrl, { deviceId, signal } = {}) {
  if (!baseUrl) throw new Error('Jellyfin server URL is not set');

  // Older Jellyfin exposes this as POST, newer as GET. Try GET, fall back.
  let data;
  try {
    data = await jfFetch(`${base(baseUrl)}/QuickConnect/Initiate`, { deviceId, signal });
  } catch (err) {
    if (err.status === 404 || err.status === 405) {
      data = await jfFetch(`${base(baseUrl)}/QuickConnect/Initiate`, { method: 'POST', deviceId, signal });
    } else {
      throw err;
    }
  }

  if (!data?.Secret || !data?.Code) {
    throw new Error('Quick Connect is not available on this server (enable it in Dashboard -> Quick Connect)');
  }
  logger.info(`Quick Connect initiated, code ${data.Code}`);
  return { secret: data.Secret, code: data.Code };
}

/**
 * Check whether the operator has approved the code yet.
 * Returns { authenticated, accessToken?, userId? }.
 */
export async function quickConnectPoll(baseUrl, secret, { deviceId, signal } = {}) {
  const state = await jfFetch(
    `${base(baseUrl)}/QuickConnect/Connect?Secret=${encodeURIComponent(secret)}`,
    { deviceId, signal },
  );

  if (!state?.Authenticated) return { authenticated: false };

  // Approved - exchange the secret for a real token.
  const data = await jfFetch(`${base(baseUrl)}/Users/AuthenticateWithQuickConnect`, {
    method: 'POST',
    body: { Secret: secret },
    deviceId,
    signal,
  });

  if (!data?.AccessToken) throw new Error('Quick Connect approved but no access token was issued');
  logger.info(`Quick Connect authenticated as ${data.User?.Name ?? 'unknown user'}`);
  return {
    authenticated: true,
    accessToken: data.AccessToken,
    userId: data.User?.Id ?? null,
    userName: data.User?.Name ?? null,
  };
}

/** Confirm a token still works, and find out who it belongs to. */
export async function verifyToken(baseUrl, token, { deviceId, signal } = {}) {
  const me = await jfFetch(`${base(baseUrl)}/Users/Me`, { token, deviceId, signal });
  return { userId: me?.Id ?? null, userName: me?.Name ?? null };
}

/**
 * Resolve whatever is configured into a usable token.
 * For password auth the cached token is reused until it stops working, at
 * which point it re-authenticates once - so a Jellyfin restart does not
 * require a visit to the settings page.
 */
export async function resolveToken(jfCfg, { onTokenRefreshed, signal } = {}) {
  const method = jfCfg.authMethod ?? 'apikey';

  if (method === 'apikey') {
    if (!jfCfg.apiKey) throw new Error('Jellyfin API key is not set');
    return jfCfg.apiKey;
  }

  // password / quickconnect both work from a cached access token.
  if (jfCfg.accessToken) {
    try {
      await verifyToken(jfCfg.baseUrl, jfCfg.accessToken, { deviceId: jfCfg.deviceId, signal });
      return jfCfg.accessToken;
    } catch (err) {
      if (err.status !== 401 && err.status !== 403) throw err;
      logger.warn('cached Jellyfin token was rejected, re-authenticating');
    }
  }

  if (method === 'password') {
    const auth = await authenticateByPassword(jfCfg.baseUrl, jfCfg.username, jfCfg.password, {
      deviceId: jfCfg.deviceId, signal,
    });
    onTokenRefreshed?.(auth);
    return auth.accessToken;
  }

  throw new Error('Jellyfin Quick Connect is not linked yet - open Settings and link it');
}
