// POST /api/live-activity/register — iOS Live Activity (APNs) push-token
// registration for the World Monitor app.
//
// Body: { "token": "<hex>", "kind": "push-to-start" | "update", "activityId"?: string }
//   - push-to-start tokens go into the sorted set `live-activity:push-to-start:v1`
//     (score = registration time, pruned after 30 days).
//   - update tokens go into the hash `live-activity:update:v1:<activityId>`
//     (field = token, value = registration time, 24h TTL). `activityId` MUST be
//     the `alertId` from the activity's `WorldAlertAttributes` so the relay can
//     find the tokens for the alert it is updating.
//
// The relay (scripts/ais-relay.cjs + scripts/lib/live-activity-dispatch.cjs)
// reads these keys verbatim; changing a key here means changing it there.
//
// Auth: same anonymous gate as the other iOS edge routes — a valid `wms_`
// session token (X-WorldMonitor-Key) or an enterprise key. Not premium-gated.

import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';
import { validateApiKey } from '../_api-key.js';
import { checkRateLimit } from '../_rate-limit.js';
import { jsonResponse } from '../_json-response.js';
import { redisPipeline } from '../_upstash-json.js';
import { captureSilentError } from '../_sentry-edge.js';

export const config = { runtime: 'edge' };

export const PUSH_TO_START_KEY = 'live-activity:push-to-start:v1';
export const UPDATE_KEY_PREFIX = 'live-activity:update:v1:';
export const PUSH_TO_START_TTL_SECONDS = 30 * 24 * 60 * 60;
export const UPDATE_TOKEN_TTL_SECONDS = 24 * 60 * 60;
export const REGISTER_KINDS = Object.freeze(['push-to-start', 'update']);

// Per-IP budget, enforced in-handler like api/wm-session.js. A device
// registers at most a handful of tokens per launch; 30/min is generous.
const RATE_LIMIT_SCOPE = 'live-activity-register';
const RATE_LIMIT_PER_MINUTE = 30;
const RATE_LIMIT_WINDOW = '60 s';
const BODY_READ_TIMEOUT_MS = 5_000;

// APNs device / Live Activity push tokens are hex. Classic device tokens are
// 64 hex chars; ActivityKit push-to-start / update tokens are longer (160+).
const TOKEN_RE = /^[0-9a-f]{32,512}$/;
const ACTIVITY_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Validate the register body. Pure — unit-tested directly.
 * @param {unknown} body
 * @returns {{ ok: true, value: { token: string, kind: string, activityId: string | null } } | { ok: false, error: string }}
 */
export function parseRegisterBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Body must be a JSON object' };
  }
  const token = typeof body.token === 'string' ? body.token.trim().toLowerCase() : '';
  if (!TOKEN_RE.test(token)) {
    return { ok: false, error: 'token must be a hex string (32-512 chars)' };
  }
  const kind = typeof body.kind === 'string' ? body.kind.trim() : '';
  if (!REGISTER_KINDS.includes(kind)) {
    return { ok: false, error: `kind must be one of: ${REGISTER_KINDS.join(', ')}` };
  }
  let activityId = null;
  if (body.activityId !== undefined && body.activityId !== null) {
    if (typeof body.activityId !== 'string' || !ACTIVITY_ID_RE.test(body.activityId.trim())) {
      return { ok: false, error: 'activityId must be a short identifier ([A-Za-z0-9_.:-], 1-128 chars)' };
    }
    activityId = body.activityId.trim();
  }
  if (kind === 'update' && !activityId) {
    return { ok: false, error: 'activityId is required for kind "update"' };
  }
  return { ok: true, value: { token, kind, activityId } };
}

/**
 * Redis commands that persist one registration. Pure — unit-tested directly.
 * @param {{ token: string, kind: string, activityId: string | null }} value
 * @param {number} nowMs
 * @returns {string[][]}
 */
export function buildRegisterCommands({ token, kind, activityId }, nowMs) {
  if (kind === 'push-to-start') {
    const cutoff = nowMs - PUSH_TO_START_TTL_SECONDS * 1000;
    return [
      ['ZADD', PUSH_TO_START_KEY, String(nowMs), token],
      ['ZREMRANGEBYSCORE', PUSH_TO_START_KEY, '-inf', String(cutoff)],
      ['EXPIRE', PUSH_TO_START_KEY, String(PUSH_TO_START_TTL_SECONDS)],
    ];
  }
  const key = `${UPDATE_KEY_PREFIX}${activityId}`;
  return [
    ['HSET', key, token, String(nowMs)],
    ['EXPIRE', key, String(UPDATE_TOKEN_TTL_SECONDS)],
  ];
}

async function readJsonBody(req) {
  const contentType = (req.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json')) return null;
  try {
    return await Promise.race([
      req.json(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('request body read timeout')), BODY_READ_TIMEOUT_MS)),
    ]);
  } catch {
    return null;
  }
}

function respond(body, status, cors) {
  return jsonResponse(body, status, { ...cors, 'Cache-Control': 'no-store' });
}

export default async function handler(req, ctx) {
  if (isDisallowedOrigin(req)) {
    return jsonResponse({ error: 'Origin not allowed' }, 403, getCorsHeaders(req, 'POST, OPTIONS'));
  }
  const cors = getCorsHeaders(req, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'POST') {
    return respond({ error: 'Method not allowed' }, 405, cors);
  }

  const auth = await validateApiKey(req);
  if (!auth.valid) {
    return respond({ error: auth.error || 'API key required' }, 401, cors);
  }

  const limited = await checkRateLimit(req, cors, {
    ctx,
    scope: RATE_LIMIT_SCOPE,
    limit: RATE_LIMIT_PER_MINUTE,
    window: RATE_LIMIT_WINDOW,
  });
  if (limited) return limited;

  const parsed = parseRegisterBody(await readJsonBody(req));
  if (!parsed.ok) {
    return respond({ error: parsed.error }, 400, cors);
  }

  const results = await redisPipeline(buildRegisterCommands(parsed.value, Date.now()));
  const failed = results === null || results.some((entry) => !entry || typeof entry !== 'object' || 'error' in entry);
  if (failed) {
    captureSilentError(new Error('live-activity register: Redis pipeline failed'), {
      tags: { surface: 'api', component: 'live-activity-register', kind: parsed.value.kind },
      fingerprint: ['live-activity-register', 'redis-pipeline-failed'],
      ctx,
      level: 'warning',
    });
    return respond({ error: 'Registration storage unavailable' }, 503, cors);
  }

  return respond({ ok: true }, 200, cors);
}
