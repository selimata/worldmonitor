/**
 * POST /api/live-activity/register — auth gate, body validation, Redis writes,
 * rate limiting, and storage-failure handling. Upstash is mocked through
 * globalThis.fetch (same approach as api/wm-session.test.mjs).
 *
 * Run: node --test tests/live-activity-register.test.mjs
 */

import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';

const SECRET = 'test-secret-must-be-at-least-32-chars-long-xxx';
const ENTERPRISE_KEY = 'enterprise-live-activity-key';
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

const {
  default: handler,
  parseRegisterBody,
  buildRegisterCommands,
  PUSH_TO_START_KEY,
  UPDATE_KEY_PREFIX,
  PUSH_TO_START_TTL_SECONDS,
  UPDATE_TOKEN_TTL_SECONDS,
} = await import('../api/live-activity/register.js');
const { issueSessionToken } = await import('../api/_session.js');
const { __resetRateLimitForTest } = await import('../api/_rate-limit.js');

const PTS_TOKEN = 'AB'.repeat(80); // 160 hex chars, mixed case on purpose
const UPDATE_TOKEN = 'cd'.repeat(80);

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

/**
 * Upstash mock. Register writes (pipelines whose first command is ZADD/HSET)
 * are recorded; everything else is the rate limiter and gets an "allowed"
 * sliding-window reply.
 */
function mockUpstash({ remaining = 29, limit = 30, registerStatus = 200, registerBody } = {}) {
  const pipelines = [];
  globalThis.fetch = async (input, init) => {
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
    if (!url.includes('fake.upstash.io')) return originalFetch(input, init);
    let body = null;
    try { body = init?.body ? JSON.parse(init.body) : null; } catch { body = null; }
    const isRegister = Array.isArray(body) && Array.isArray(body[0]) && ['ZADD', 'HSET'].includes(body[0][0]);
    if (isRegister) {
      pipelines.push({ url, body });
      if (registerStatus !== 200) return new Response('{}', { status: registerStatus });
      const reply = registerBody ?? body.map(() => ({ result: 1 }));
      return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify([{ result: [remaining, limit] }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return pipelines;
}

function makeReq({ method = 'POST', key, origin, body, contentType = 'application/json', rawBody } = {}) {
  const headers = new Headers();
  if (key) headers.set('x-worldmonitor-key', key);
  if (origin) headers.set('origin', origin);
  const init = { method, headers };
  if (method === 'POST') {
    headers.set('content-type', contentType);
    init.body = rawBody ?? JSON.stringify(body ?? {});
  }
  return new Request('https://api.worldmonitor.app/api/live-activity/register', init);
}

async function sessionKey() {
  const { token } = await issueSessionToken();
  return token;
}

beforeEach(() => {
  process.env.WM_SESSION_SECRET = SECRET;
  process.env.WORLDMONITOR_VALID_KEYS = ENTERPRISE_KEY;
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
  delete process.env.SENTRY_DSN;
  __resetRateLimitForTest();
  mockUpstash();
});

afterEach(() => {
  __resetRateLimitForTest();
  globalThis.fetch = originalFetch;
  restoreEnv();
});

describe('parseRegisterBody', () => {
  it('accepts push-to-start and update registrations, lowercasing the token', () => {
    assert.deepEqual(parseRegisterBody({ token: PTS_TOKEN, kind: 'push-to-start' }), {
      ok: true, value: { token: PTS_TOKEN.toLowerCase(), kind: 'push-to-start', activityId: null },
    });
    assert.deepEqual(parseRegisterBody({ token: UPDATE_TOKEN, kind: 'update', activityId: 'abc123def456' }), {
      ok: true, value: { token: UPDATE_TOKEN, kind: 'update', activityId: 'abc123def456' },
    });
  });

  it('rejects malformed bodies with a specific error', () => {
    assert.equal(parseRegisterBody(null).ok, false);
    assert.equal(parseRegisterBody([]).ok, false);
    assert.match(parseRegisterBody({ kind: 'update' }).error, /token/);
    assert.match(parseRegisterBody({ token: 'zz'.repeat(40), kind: 'update' }).error, /hex/);
    assert.match(parseRegisterBody({ token: 'ab'.repeat(8), kind: 'update' }).error, /hex/);
    assert.match(parseRegisterBody({ token: PTS_TOKEN, kind: 'start' }).error, /kind/);
    assert.match(parseRegisterBody({ token: PTS_TOKEN, kind: 'update' }).error, /activityId is required/);
    assert.match(parseRegisterBody({ token: PTS_TOKEN, kind: 'update', activityId: 'has space' }).error, /activityId/);
    assert.match(parseRegisterBody({ token: PTS_TOKEN, kind: 'update', activityId: 'x'.repeat(129) }).error, /activityId/);
  });
});

describe('buildRegisterCommands', () => {
  it('push-to-start: ZADD by time, prune older than 30 days, refresh key TTL', () => {
    const now = 1_800_000_000_000;
    assert.deepEqual(buildRegisterCommands({ token: 'ab', kind: 'push-to-start', activityId: null }, now), [
      ['ZADD', PUSH_TO_START_KEY, String(now), 'ab'],
      ['ZREMRANGEBYSCORE', PUSH_TO_START_KEY, '-inf', String(now - PUSH_TO_START_TTL_SECONDS * 1000)],
      ['EXPIRE', PUSH_TO_START_KEY, String(PUSH_TO_START_TTL_SECONDS)],
    ]);
    assert.equal(PUSH_TO_START_KEY, 'live-activity:push-to-start:v1');
    assert.equal(PUSH_TO_START_TTL_SECONDS, 30 * 24 * 60 * 60);
  });

  it('update: HSET token under the activity hash with a 24h TTL', () => {
    assert.deepEqual(buildRegisterCommands({ token: 'cd', kind: 'update', activityId: 'alert1' }, 5), [
      ['HSET', `${UPDATE_KEY_PREFIX}alert1`, 'cd', '5'],
      ['EXPIRE', `${UPDATE_KEY_PREFIX}alert1`, String(UPDATE_TOKEN_TTL_SECONDS)],
    ]);
    assert.equal(UPDATE_KEY_PREFIX, 'live-activity:update:v1:');
  });
});

describe('POST /api/live-activity/register', () => {
  it('returns 401 without a credential, and for bogus / malformed session credentials', async () => {
    const none = await handler(makeReq({ body: { token: PTS_TOKEN, kind: 'push-to-start' } }));
    assert.equal(none.status, 401);
    assert.equal((await none.json()).error, 'API key required');

    const bogus = await handler(makeReq({ key: 'nope', body: { token: PTS_TOKEN, kind: 'push-to-start' } }));
    assert.equal(bogus.status, 401);

    const forged = await handler(makeReq({ key: 'wms_forged.sig', body: { token: PTS_TOKEN, kind: 'push-to-start' } }));
    assert.equal(forged.status, 401);
    assert.equal((await forged.json()).error, 'Invalid session token');
  });

  it('stores a push-to-start token for a valid wms_ session (no Origin header, like the iOS app)', async () => {
    const pipelines = mockUpstash();
    const resp = await handler(makeReq({ key: await sessionKey(), body: { token: PTS_TOKEN, kind: 'push-to-start' } }));
    assert.equal(resp.status, 200);
    assert.deepEqual(await resp.json(), { ok: true });
    assert.equal(resp.headers.get('cache-control'), 'no-store');
    assert.equal(pipelines.length, 1);
    assert.equal(pipelines[0].url, 'https://fake.upstash.io/pipeline');
    const [zadd, prune, expire] = pipelines[0].body;
    assert.equal(zadd[0], 'ZADD');
    assert.equal(zadd[1], 'live-activity:push-to-start:v1');
    assert.equal(zadd[3], PTS_TOKEN.toLowerCase());
    assert.equal(prune[0], 'ZREMRANGEBYSCORE');
    assert.deepEqual(expire, ['EXPIRE', 'live-activity:push-to-start:v1', String(30 * 24 * 60 * 60)]);
  });

  it('stores an update token under live-activity:update:v1:<activityId>', async () => {
    const pipelines = mockUpstash();
    const resp = await handler(makeReq({ key: await sessionKey(), body: { token: UPDATE_TOKEN, kind: 'update', activityId: '0123456789abcdef01234567' } }));
    assert.equal(resp.status, 200);
    const [hset, expire] = pipelines[0].body;
    assert.deepEqual(hset.slice(0, 3), ['HSET', 'live-activity:update:v1:0123456789abcdef01234567', UPDATE_TOKEN]);
    assert.deepEqual(expire, ['EXPIRE', 'live-activity:update:v1:0123456789abcdef01234567', String(24 * 60 * 60)]);
  });

  it('accepts an enterprise key', async () => {
    const resp = await handler(makeReq({ key: ENTERPRISE_KEY, body: { token: PTS_TOKEN, kind: 'push-to-start' } }));
    assert.equal(resp.status, 200);
  });

  it('returns 400 for invalid bodies and never touches Redis', async () => {
    const pipelines = mockUpstash();
    const key = await sessionKey();
    const cases = [
      { body: { kind: 'push-to-start' } },
      { body: { token: 'not-hex', kind: 'push-to-start' } },
      { body: { token: PTS_TOKEN, kind: 'bogus' } },
      { body: { token: UPDATE_TOKEN, kind: 'update' } },
      { body: { token: UPDATE_TOKEN, kind: 'update', activityId: 'bad id' } },
      { rawBody: '{not json', body: undefined },
      { body: { token: PTS_TOKEN, kind: 'push-to-start' }, contentType: 'text/plain' },
    ];
    for (const c of cases) {
      const resp = await handler(makeReq({ key, ...c }));
      assert.equal(resp.status, 400, JSON.stringify(c));
      assert.equal(typeof (await resp.json()).error, 'string');
    }
    assert.equal(pipelines.length, 0);
  });

  it('rejects non-POST methods, answers preflight, and blocks disallowed origins', async () => {
    const get = await handler(makeReq({ method: 'GET', key: await sessionKey() }));
    assert.equal(get.status, 405);

    const preflight = await handler(makeReq({ method: 'OPTIONS', origin: 'https://worldmonitor.app' }));
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST, OPTIONS');

    const evil = await handler(makeReq({ key: await sessionKey(), origin: 'https://evil.example.com', body: { token: PTS_TOKEN, kind: 'push-to-start' } }));
    assert.equal(evil.status, 403);
  });

  it('returns 429 when the per-IP budget is exhausted', async () => {
    const pipelines = mockUpstash({ remaining: -1, limit: 30 });
    const resp = await handler(makeReq({ key: await sessionKey(), body: { token: PTS_TOKEN, kind: 'push-to-start' } }));
    assert.equal(resp.status, 429);
    assert.equal(resp.headers.get('X-RateLimit-Limit'), '30');
    assert.equal(pipelines.length, 0);
  });

  it('returns 503 when the Redis write fails', async () => {
    mockUpstash({ registerStatus: 500 });
    const resp = await handler(makeReq({ key: await sessionKey(), body: { token: PTS_TOKEN, kind: 'push-to-start' } }));
    assert.equal(resp.status, 503);
    assert.match((await resp.json()).error, /storage unavailable/i);

    mockUpstash({ registerBody: [{ result: 1 }, { error: 'WRONGTYPE' }, { result: 1 }] });
    const partial = await handler(makeReq({ key: await sessionKey(), body: { token: PTS_TOKEN, kind: 'push-to-start' } }));
    assert.equal(partial.status, 503);
  });
});
