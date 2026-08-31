'use strict';

/**
 * APNs Live Activity sender (HTTP/2 + ES256 provider token).
 *
 * Node builtins only — this file ships inside the relay container
 * (Dockerfile.relay) where the only installed packages are scripts/package.json.
 *
 * Wire contract (mirrored by the iOS `WorldAlertAttributes` ActivityKit type):
 *   attributes    { alertId: string, startedAt: number }   startedAt = UNIX SECONDS
 *   content-state { title, source, location|null, level: 'critical', reports, updatedAt }
 *                                                          updatedAt = UNIX SECONDS
 *
 * Config (env):
 *   APNS_TEAM_ID      Apple Developer Team ID (JWT `iss`)
 *   APNS_KEY_ID       APNs Auth Key ID (JWT header `kid`)
 *   APNS_AUTH_KEY     Contents of the .p8 file. Literal `\n` sequences are
 *                     accepted (Railway single-line variables); a base64-encoded
 *                     PEM is accepted as well.
 *   APNS_BUNDLE_ID    default `com.worldmonitor`
 *   APNS_ENVIRONMENT  `production` (default) -> api.push.apple.com
 *                     `sandbox`              -> api.sandbox.push.apple.com
 *
 * When the env is incomplete the sender logs ONCE and becomes a dry-run no-op:
 * `send()` resolves `{ ok: false, dryRun: true }` and never throws.
 */

const http2 = require('http2');
const crypto = require('crypto');

const APNS_HOSTS = Object.freeze({
  production: 'api.push.apple.com',
  sandbox: 'api.sandbox.push.apple.com',
});
const DEFAULT_BUNDLE_ID = 'com.worldmonitor';
const ATTRIBUTES_TYPE = 'WorldAlertAttributes';
const CONTENT_LEVEL = 'critical';
// Localized by iOS against the app bundle's compiled strings. The key is the
// String Catalog's English source string, which carries all 41 translations
// (WorldView/WorldMonitor/Localizable.xcstrings). A locale missing the entry
// falls back to the key itself, which is already correct English.
const START_ALERT_TITLE_LOC_KEY = 'WORLD ALERT';
// Apple accepts provider tokens for up to 60 minutes; refresh at 50 so a token
// minted just before the boundary is never presented stale.
const JWT_TTL_MS = 50 * 60 * 1000;
const END_DISMISSAL_DELAY_S = 30 * 60;
const REQUEST_TIMEOUT_MS = 10_000;
const SESSION_IDLE_TIMEOUT_MS = 60_000;
const TITLE_MAX_CHARS = 200;

// APNs reasons that mean "this token will never work again" — the caller must
// drop it from its store. 410 carries `Unregistered`; 400 carries the
// token-shape failures.
const REMOVE_TOKEN_REASONS = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered', 'ExpiredToken']);
const REFRESH_JWT_REASONS = new Set(['ExpiredProviderToken', 'InvalidProviderToken']);

function toUnixSeconds(value, fallbackMs) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n >= 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  return Math.floor((Number.isFinite(fallbackMs) ? fallbackMs : Date.now()) / 1000);
}

function normalizePem(raw) {
  if (typeof raw !== 'string') return '';
  let pem = raw.replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trim();
  if (pem && !pem.includes('-----BEGIN')) {
    // Operators sometimes base64 the whole file to survive single-line env UIs.
    try {
      const decoded = Buffer.from(pem, 'base64').toString('utf8');
      if (decoded.includes('-----BEGIN')) pem = decoded.trim();
    } catch {
      /* not base64 — fall through to the shape check below */
    }
  }
  return pem.includes('-----BEGIN') && pem.includes('-----END') ? pem : '';
}

function readApnsConfig(env = process.env) {
  const teamId = String(env.APNS_TEAM_ID || '').trim();
  const keyId = String(env.APNS_KEY_ID || '').trim();
  const privateKeyPem = normalizePem(env.APNS_AUTH_KEY);
  const bundleId = String(env.APNS_BUNDLE_ID || '').trim() || DEFAULT_BUNDLE_ID;
  const environment = String(env.APNS_ENVIRONMENT || 'production').trim().toLowerCase();
  const host = APNS_HOSTS[environment];

  const missing = [];
  if (!teamId) missing.push('APNS_TEAM_ID');
  if (!keyId) missing.push('APNS_KEY_ID');
  if (!privateKeyPem) missing.push('APNS_AUTH_KEY');
  if (!host) missing.push('APNS_ENVIRONMENT (expected production|sandbox)');

  const topic = `${bundleId}.push-type.liveactivity`;
  if (missing.length > 0) {
    return { configured: false, missing, bundleId, environment, topic };
  }
  return { configured: true, missing, teamId, keyId, privateKeyPem, bundleId, environment, host, topic };
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

/** ES256 JOSE compact token: header {alg, kid}, payload {iss, iat}. */
function buildApnsJwt({ teamId, keyId, privateKeyPem }, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const payload = base64url(JSON.stringify({ iss: teamId, iat: nowSeconds }));
  const signingInput = `${header}.${payload}`;
  // ieee-p1363 = raw r||s (64 bytes for P-256), which is what JOSE expects;
  // Node's default is ASN.1 DER and Apple rejects that with InvalidProviderToken.
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: privateKeyPem,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${signature.toString('base64url')}`;
}

function createJwtProvider(config, { now = Date.now, ttlMs = JWT_TTL_MS } = {}) {
  let cached = null;
  return {
    get() {
      const t = now();
      if (!cached || t - cached.issuedAt >= ttlMs) {
        cached = { token: buildApnsJwt(config, Math.floor(t / 1000)), issuedAt: t };
      }
      return cached.token;
    },
    invalidate() {
      cached = null;
    },
  };
}

function buildContentState({ title, source, location, reports, updatedAt, link } = {}, nowMs = Date.now()) {
  const reportCount = Math.floor(Number(reports));
  return {
    title: String(title || '').trim().slice(0, TITLE_MAX_CHARS),
    source: String(source || '').trim(),
    location: typeof location === 'string' && location.trim() ? location.trim() : null,
    link: typeof link === 'string' && link.trim() ? link.trim() : null,
    level: CONTENT_LEVEL,
    reports: Number.isFinite(reportCount) && reportCount > 0 ? reportCount : 1,
    updatedAt: toUnixSeconds(updatedAt, nowMs),
  };
}

function buildStartPayload({ alertId, startedAt, contentState, nowSeconds = Math.floor(Date.now() / 1000) }) {
  return {
    aps: {
      timestamp: nowSeconds,
      event: 'start',
      'content-state': contentState,
      'attributes-type': ATTRIBUTES_TYPE,
      attributes: { alertId: String(alertId), startedAt: toUnixSeconds(startedAt, nowSeconds * 1000) },
      alert: { 'title-loc-key': START_ALERT_TITLE_LOC_KEY, body: contentState.title },
    },
  };
}

function buildUpdatePayload({ contentState, nowSeconds = Math.floor(Date.now() / 1000) }) {
  return {
    aps: {
      timestamp: nowSeconds,
      event: 'update',
      'content-state': contentState,
    },
  };
}

function buildEndPayload({ contentState, nowSeconds = Math.floor(Date.now() / 1000), dismissalDate }) {
  return {
    aps: {
      timestamp: nowSeconds,
      event: 'end',
      'content-state': contentState,
      'dismissal-date': Number.isFinite(dismissalDate) ? Math.floor(dismissalDate) : nowSeconds + END_DISMISSAL_DELAY_S,
    },
  };
}

/**
 * Stable alert identity. The classify pipeline keys stories by title (the
 * digest merges corroborating feeds under one title), so the lowercased title
 * is the identity; the link is only used when there is no title at all.
 */
function deriveAlertId(link, title) {
  const normalizedTitle = String(title || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const material = normalizedTitle || String(link || '').trim();
  if (!material) return '';
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 24);
}

function maskToken(token) {
  const s = String(token || '');
  return s.length <= 12 ? s : `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function parseReason(body) {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    return typeof parsed?.reason === 'string' ? parsed.reason : null;
  } catch {
    return null;
  }
}

/** Minimal HTTP/2 client with one lazily-(re)opened session per host. */
function createHttp2Transport({ host, timeoutMs = REQUEST_TIMEOUT_MS, connect = http2.connect } = {}) {
  let session = null;

  function getSession() {
    if (session && !session.closed && !session.destroyed) return session;
    const next = connect(`https://${host}:443`);
    next.setTimeout(SESSION_IDLE_TIMEOUT_MS, () => {
      try { next.close(); } catch { /* already gone */ }
    });
    next.on('error', () => { if (session === next) session = null; });
    next.on('close', () => { if (session === next) session = null; });
    session = next;
    return next;
  }

  return function request({ path, headers, body }) {
    return new Promise((resolve, reject) => {
      let stream;
      try {
        stream = getSession().request({ ':method': 'POST', ':path': path, ...headers });
      } catch (e) {
        reject(e);
        return;
      }
      let status = 0;
      let data = '';
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const timer = setTimeout(() => {
        try { stream.close(http2.constants.NGHTTP2_CANCEL); } catch { /* stream already closed */ }
        finish(reject, new Error(`APNs request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      stream.on('response', (h) => { status = Number(h[':status']) || 0; });
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => { data += chunk; });
      stream.on('end', () => finish(resolve, { status, body: data }));
      stream.on('error', (e) => finish(reject, e));
      stream.end(body);
    });
  };
}

/**
 * @param {object} opts
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {{ log: Function, warn: Function }} [opts.log]
 * @param {() => number} [opts.now]
 * @param {Function} [opts.transport]  ({ path, headers, body }) => Promise<{ status, body }>
 */
function createApnsLiveActivitySender({ env = process.env, log = console, now = Date.now, transport } = {}) {
  const config = readApnsConfig(env);
  const dryRun = !config.configured;
  let warnedDryRun = false;

  const warnDryRunOnce = () => {
    if (warnedDryRun) return;
    warnedDryRun = true;
    log.warn(`[LiveActivity] APNs not configured (missing ${config.missing.join(', ')}) — dry-run mode: pushes are logged, not sent`);
  };

  const jwt = dryRun ? null : createJwtProvider(config, { now });
  const request = dryRun ? null : (transport || createHttp2Transport({ host: config.host }));

  async function send(token, payload, { retryOnAuthFailure = true } = {}) {
    const event = payload?.aps?.event || 'unknown';
    if (dryRun) {
      warnDryRunOnce();
      log.log(`[LiveActivity] dry-run ${event} → ${maskToken(token)}`);
      return { ok: false, dryRun: true, status: 0, reason: 'not_configured', removeToken: false };
    }
    if (typeof token !== 'string' || !/^[0-9a-fA-F]{16,}$/.test(token)) {
      return { ok: false, dryRun: false, status: 0, reason: 'InvalidTokenShape', removeToken: true };
    }

    let response;
    try {
      response = await request({
        path: `/3/device/${token}`,
        headers: {
          'apns-topic': config.topic,
          'apns-push-type': 'liveactivity',
          'apns-priority': '10',
          authorization: `bearer ${jwt.get()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      log.warn(`[LiveActivity] APNs ${event} transport error for ${maskToken(token)}: ${e?.message || e}`);
      return { ok: false, dryRun: false, status: 0, reason: e?.message || String(e), removeToken: false };
    }

    const status = Number(response?.status) || 0;
    const reason = parseReason(response?.body);
    if (status === 200) return { ok: true, dryRun: false, status, reason: null, removeToken: false };

    if (status === 403 && REFRESH_JWT_REASONS.has(reason) && retryOnAuthFailure) {
      jwt.invalidate();
      return send(token, payload, { retryOnAuthFailure: false });
    }

    const removeToken = status === 410 || (status === 400 && REMOVE_TOKEN_REASONS.has(reason)) || reason === 'Unregistered';
    log.warn(`[LiveActivity] APNs ${event} rejected for ${maskToken(token)}: HTTP ${status}${reason ? ` ${reason}` : ''}${removeToken ? ' (token removed)' : ''}`);
    return { ok: false, dryRun: false, status, reason, removeToken };
  }

  return {
    enabled: !dryRun,
    config: { bundleId: config.bundleId, environment: config.environment, host: config.host || null, topic: config.topic },
    send,
    sendStart(token, { alertId, startedAt, contentState }) {
      return send(token, buildStartPayload({ alertId, startedAt, contentState, nowSeconds: Math.floor(now() / 1000) }));
    },
    sendUpdate(token, contentState) {
      return send(token, buildUpdatePayload({ contentState, nowSeconds: Math.floor(now() / 1000) }));
    },
    sendEnd(token, contentState, dismissalDate) {
      return send(token, buildEndPayload({ contentState, nowSeconds: Math.floor(now() / 1000), dismissalDate }));
    },
  };
}

module.exports = {
  APNS_HOSTS,
  ATTRIBUTES_TYPE,
  DEFAULT_BUNDLE_ID,
  END_DISMISSAL_DELAY_S,
  JWT_TTL_MS,
  buildApnsJwt,
  buildContentState,
  buildEndPayload,
  buildStartPayload,
  buildUpdatePayload,
  createApnsLiveActivitySender,
  createHttp2Transport,
  createJwtProvider,
  deriveAlertId,
  maskToken,
  normalizePem,
  readApnsConfig,
  toUnixSeconds,
};
