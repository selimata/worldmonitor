/**
 * APNs Live Activity sender — JWT, payload shapes, transport outcome handling,
 * and the no-config dry-run contract. Network is mocked via the injectable
 * transport; no socket is ever opened.
 *
 * Run: node --test tests/live-activity-apns.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const apns = require('../scripts/lib/apns-live-activity.cjs');

function makeKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

function makeEnv(privatePem, extra = {}) {
  return {
    APNS_TEAM_ID: 'TEAM123456',
    APNS_KEY_ID: 'KEYID12345',
    // Railway-style single-line variable: literal backslash-n sequences.
    APNS_AUTH_KEY: privatePem.replace(/\n/g, '\\n'),
    ...extra,
  };
}

function captureLog() {
  const lines = [];
  return {
    lines,
    log: (msg) => lines.push(['log', String(msg)]),
    warn: (msg) => lines.push(['warn', String(msg)]),
  };
}

function decodeJwtPart(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

const CONTENT_STATE = {
  title: 'Iran closes Strait of Hormuz',
  source: 'Reuters',
  location: 'Strait of Hormuz',
  level: 'critical',
  reports: 3,
  updatedAt: 1_800_000_000,
};

describe('readApnsConfig', () => {
  const { privatePem } = makeKeyPair();

  it('restores literal \\n newlines and applies defaults (production, com.worldmonitor)', () => {
    const cfg = apns.readApnsConfig(makeEnv(privatePem));
    assert.equal(cfg.configured, true);
    assert.equal(cfg.privateKeyPem, privatePem.trim());
    assert.equal(cfg.bundleId, 'com.worldmonitor');
    assert.equal(cfg.environment, 'production');
    assert.equal(cfg.host, 'api.push.apple.com');
    assert.equal(cfg.topic, 'com.worldmonitor.push-type.liveactivity');
  });

  it('routes sandbox to api.sandbox.push.apple.com and honours APNS_BUNDLE_ID', () => {
    const cfg = apns.readApnsConfig(makeEnv(privatePem, { APNS_ENVIRONMENT: 'sandbox', APNS_BUNDLE_ID: 'com.example.wm' }));
    assert.equal(cfg.host, 'api.sandbox.push.apple.com');
    assert.equal(cfg.topic, 'com.example.wm.push-type.liveactivity');
  });

  it('accepts a base64-encoded PEM', () => {
    const cfg = apns.readApnsConfig(makeEnv(privatePem, { APNS_AUTH_KEY: Buffer.from(privatePem).toString('base64') }));
    assert.equal(cfg.configured, true);
    assert.equal(cfg.privateKeyPem, privatePem.trim());
  });

  it('reports every missing variable instead of guessing', () => {
    const cfg = apns.readApnsConfig({ APNS_KEY_ID: 'x' });
    assert.equal(cfg.configured, false);
    assert.deepEqual(cfg.missing, ['APNS_TEAM_ID', 'APNS_AUTH_KEY']);
  });

  it('treats an unknown APNS_ENVIRONMENT as not configured (never silently production)', () => {
    const cfg = apns.readApnsConfig(makeEnv(privatePem, { APNS_ENVIRONMENT: 'staging' }));
    assert.equal(cfg.configured, false);
    assert.ok(cfg.missing.some((m) => m.startsWith('APNS_ENVIRONMENT')));
  });

  it('rejects a non-PEM APNS_AUTH_KEY', () => {
    const cfg = apns.readApnsConfig(makeEnv(privatePem, { APNS_AUTH_KEY: 'not-a-key' }));
    assert.equal(cfg.configured, false);
    assert.ok(cfg.missing.includes('APNS_AUTH_KEY'));
  });
});

describe('buildApnsJwt', () => {
  const { privatePem, publicPem } = makeKeyPair();
  const cfg = apns.readApnsConfig(makeEnv(privatePem));

  it('produces an ES256 JOSE token with kid/iss/iat that verifies against the public key', () => {
    const token = apns.buildApnsJwt(cfg, 1_800_000_000);
    const [h, p, s] = token.split('.');
    assert.deepEqual(decodeJwtPart(h), { alg: 'ES256', kid: 'KEYID12345' });
    assert.deepEqual(decodeJwtPart(p), { iss: 'TEAM123456', iat: 1_800_000_000 });
    const signature = Buffer.from(s, 'base64url');
    assert.equal(signature.length, 64, 'P-256 ieee-p1363 signature is r||s = 64 bytes');
    assert.equal(
      crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicPem, dsaEncoding: 'ieee-p1363' }, signature),
      true,
    );
  });

  it('caches the token for ~50 minutes and mints a fresh one afterwards', () => {
    let nowMs = 1_800_000_000_000;
    const provider = apns.createJwtProvider(cfg, { now: () => nowMs });
    const first = provider.get();
    nowMs += 49 * 60 * 1000;
    assert.equal(provider.get(), first, 'same token inside the cache window');
    nowMs += 2 * 60 * 1000;
    const second = provider.get();
    assert.notEqual(second, first, 'new token after 50 minutes');
    assert.equal(decodeJwtPart(second.split('.')[1]).iat, Math.floor(nowMs / 1000));
    provider.invalidate();
    assert.notEqual(provider.get(), second, 'invalidate() forces a re-mint');
  });
});

describe('payload builders', () => {
  it('start payload matches the contract exactly', () => {
    const payload = apns.buildStartPayload({ alertId: 'abc123', startedAt: 1_800_000_000, contentState: CONTENT_STATE, nowSeconds: 1_800_000_010 });
    assert.deepEqual(payload, {
      aps: {
        timestamp: 1_800_000_010,
        event: 'start',
        'content-state': CONTENT_STATE,
        'attributes-type': 'WorldAlertAttributes',
        attributes: { alertId: 'abc123', startedAt: 1_800_000_000 },
        alert: { title: 'World Alert', body: 'Iran closes Strait of Hormuz' },
      },
    });
  });

  it('start payload converts a millisecond startedAt to unix seconds', () => {
    const payload = apns.buildStartPayload({ alertId: 'a', startedAt: 1_800_000_000_500, contentState: CONTENT_STATE, nowSeconds: 1 });
    assert.equal(payload.aps.attributes.startedAt, 1_800_000_000);
  });

  it('update payload carries only timestamp/event/content-state', () => {
    assert.deepEqual(apns.buildUpdatePayload({ contentState: CONTENT_STATE, nowSeconds: 7 }), {
      aps: { timestamp: 7, event: 'update', 'content-state': CONTENT_STATE },
    });
  });

  it('end payload defaults dismissal-date to now + 30 minutes', () => {
    const payload = apns.buildEndPayload({ contentState: CONTENT_STATE, nowSeconds: 1_000 });
    assert.deepEqual(payload, {
      aps: { timestamp: 1_000, event: 'end', 'content-state': CONTENT_STATE, 'dismissal-date': 1_000 + 30 * 60 },
    });
    assert.equal(apns.buildEndPayload({ contentState: CONTENT_STATE, nowSeconds: 1_000, dismissalDate: 5_000 }).aps['dismissal-date'], 5_000);
  });

  it('content state normalizes fields, pins level=critical, and uses unix seconds', () => {
    const state = apns.buildContentState({ title: '  Big news  ', source: 'AP', location: '', reports: '4', updatedAt: 1_800_000_000_999 }, 0);
    assert.deepEqual(state, { title: 'Big news', source: 'AP', location: null, link: null, level: 'critical', reports: 4, updatedAt: 1_800_000_000 });
    const fallback = apns.buildContentState({ title: 'x', reports: 0 }, 1_800_000_000_000);
    assert.equal(fallback.reports, 1);
    assert.equal(fallback.updatedAt, 1_800_000_000);
  });

  it('deriveAlertId is stable, whitespace/case-insensitive on the title, and falls back to the link', () => {
    const a = apns.deriveAlertId('https://a.example/1', 'Iran closes  Strait of Hormuz');
    const b = apns.deriveAlertId('https://b.example/2', 'iran closes strait of hormuz ');
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{24}$/);
    assert.notEqual(a, apns.deriveAlertId('', 'Different headline'));
    assert.equal(apns.deriveAlertId('https://a.example/1', ''), apns.deriveAlertId('https://a.example/1', undefined));
    assert.equal(apns.deriveAlertId('', ''), '');
  });
});

describe('createApnsLiveActivitySender — transport outcomes', () => {
  const { privatePem } = makeKeyPair();
  const TOKEN = 'ab'.repeat(40);

  function makeSender(responses, { env = {} } = {}) {
    const calls = [];
    let nowMs = 1_800_000_000_000;
    const transport = async (req) => {
      calls.push(req);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    };
    const log = captureLog();
    const sender = apns.createApnsLiveActivitySender({
      env: makeEnv(privatePem, env),
      log,
      now: () => (nowMs += 60 * 60 * 1000),
      transport,
    });
    return { sender, calls, log };
  }

  it('sends start to /3/device/<token> with the liveactivity headers and a bearer JWT', async () => {
    const { sender, calls } = makeSender([{ status: 200, body: '' }]);
    assert.equal(sender.enabled, true);
    const result = await sender.sendStart(TOKEN, { alertId: 'id1', startedAt: 1_800_000_000, contentState: CONTENT_STATE });
    assert.deepEqual(result, { ok: true, dryRun: false, status: 200, reason: null, removeToken: false });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, `/3/device/${TOKEN}`);
    assert.equal(calls[0].headers['apns-topic'], 'com.worldmonitor.push-type.liveactivity');
    assert.equal(calls[0].headers['apns-push-type'], 'liveactivity');
    assert.equal(calls[0].headers['apns-priority'], '10');
    assert.match(calls[0].headers.authorization, /^bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const body = JSON.parse(calls[0].body);
    assert.equal(body.aps.event, 'start');
    assert.equal(body.aps['attributes-type'], 'WorldAlertAttributes');
    assert.equal(body.aps.attributes.alertId, 'id1');
  });

  it('flags 410 Unregistered and 400 BadDeviceToken for removal, but not other 400s', async () => {
    const { sender } = makeSender([
      { status: 410, body: JSON.stringify({ reason: 'Unregistered' }) },
      { status: 400, body: JSON.stringify({ reason: 'BadDeviceToken' }) },
      { status: 400, body: JSON.stringify({ reason: 'PayloadTooLarge' }) },
      { status: 429, body: JSON.stringify({ reason: 'TooManyRequests' }) },
    ]);
    const gone = await sender.sendUpdate(TOKEN, CONTENT_STATE);
    assert.equal(gone.ok, false);
    assert.equal(gone.status, 410);
    assert.equal(gone.removeToken, true);
    const bad = await sender.sendUpdate(TOKEN, CONTENT_STATE);
    assert.equal(bad.reason, 'BadDeviceToken');
    assert.equal(bad.removeToken, true);
    const large = await sender.sendUpdate(TOKEN, CONTENT_STATE);
    assert.equal(large.removeToken, false);
    const throttled = await sender.sendEnd(TOKEN, CONTENT_STATE, 1);
    assert.equal(throttled.status, 429);
    assert.equal(throttled.removeToken, false);
  });

  it('refreshes the JWT and retries exactly once on 403 ExpiredProviderToken', async () => {
    const { sender, calls } = makeSender([
      { status: 403, body: JSON.stringify({ reason: 'ExpiredProviderToken' }) },
      { status: 200, body: '' },
    ]);
    const result = await sender.sendUpdate(TOKEN, CONTENT_STATE);
    assert.equal(result.ok, true);
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].headers.authorization, calls[1].headers.authorization, 'retry must carry a freshly minted token');
  });

  it('does not loop on a second provider-token failure', async () => {
    const { sender, calls } = makeSender([
      { status: 403, body: JSON.stringify({ reason: 'InvalidProviderToken' }) },
      { status: 403, body: JSON.stringify({ reason: 'InvalidProviderToken' }) },
    ]);
    const result = await sender.sendUpdate(TOKEN, CONTENT_STATE);
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.equal(calls.length, 2);
  });

  it('never throws on transport errors', async () => {
    const { sender, log } = makeSender([new Error('ECONNRESET')]);
    const result = await sender.sendStart(TOKEN, { alertId: 'x', startedAt: 1, contentState: CONTENT_STATE });
    assert.equal(result.ok, false);
    assert.equal(result.removeToken, false);
    assert.match(result.reason, /ECONNRESET/);
    assert.ok(log.lines.some(([lvl, msg]) => lvl === 'warn' && msg.includes('transport error')));
  });

  it('rejects a malformed token locally without calling APNs', async () => {
    const { sender, calls } = makeSender([]);
    const result = await sender.sendUpdate('not-hex!', CONTENT_STATE);
    assert.equal(result.removeToken, true);
    assert.equal(calls.length, 0);
  });
});

describe('createApnsLiveActivitySender — dry-run when APNs is not configured', () => {
  it('logs once, resolves dryRun results for every event, and never throws', async () => {
    const log = captureLog();
    const sender = apns.createApnsLiveActivitySender({
      env: {},
      log,
      transport: async () => { throw new Error('transport must not be called in dry-run'); },
    });
    assert.equal(sender.enabled, false);
    assert.equal(sender.config.host, null);
    assert.equal(sender.config.topic, 'com.worldmonitor.push-type.liveactivity');

    const start = await sender.sendStart('ab'.repeat(40), { alertId: 'x', startedAt: 1, contentState: CONTENT_STATE });
    const update = await sender.sendUpdate('ab'.repeat(40), CONTENT_STATE);
    const end = await sender.sendEnd('ab'.repeat(40), CONTENT_STATE, 1);
    for (const result of [start, update, end]) {
      assert.equal(result.ok, false);
      assert.equal(result.dryRun, true);
      assert.equal(result.removeToken, false);
      assert.equal(result.reason, 'not_configured');
    }
    const warnings = log.lines.filter(([lvl]) => lvl === 'warn');
    assert.equal(warnings.length, 1, 'the not-configured warning is emitted exactly once');
    assert.match(warnings[0][1], /APNS_TEAM_ID, APNS_KEY_ID, APNS_AUTH_KEY/);
    assert.match(warnings[0][1], /dry-run/);
    assert.equal(log.lines.filter(([lvl, msg]) => lvl === 'log' && msg.includes('dry-run')).length, 3);
  });
});
