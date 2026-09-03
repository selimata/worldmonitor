/**
 * Broadcast push dispatcher — scripts/lib/broadcast-push.cjs.
 *
 * Unlike the relay scripts (runtime side-effect modules with no exports, tested
 * by source-grep in tests/notification-relay-*.test.mjs), this module is a pure
 * factory, so everything below drives the real code with fakes for Redis, fetch
 * and the clock.
 *
 * The invariant every test here defends: a broadcast reaches the entire install
 * base and cannot be recalled, so each guard must fail CLOSED.
 *
 * Run: node --test tests/broadcast-push.test.mjs
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const {
  createBroadcastPushDispatcher,
  audienceForLevel,
  normalizeHeadline,
  dedupHash,
  hourBucket,
  APP_DEFAULT_PRIORITY,
  BODY_MAX_CHARS,
} = require('../scripts/lib/broadcast-push.cjs');

const aisRelaySrc = readFileSync(resolve(__dirname, '..', 'scripts', 'ais-relay.cjs'), 'utf-8');
const sendEndpointSrc = (() => {
  try {
    return readFileSync(
      resolve(__dirname, '..', '..', 'monitor-landing-web', 'pages', 'api', 'push', 'send.ts'),
      'utf-8',
    );
  } catch {
    return null; // sibling repo not checked out — those tests self-skip
  }
})();
const apnsLibSrc = (() => {
  try {
    return readFileSync(resolve(__dirname, '..', '..', 'monitor-landing-web', 'lib', 'apns.ts'), 'utf-8');
  } catch {
    return null;
  }
})();

// ── Fakes ─────────────────────────────────────────────────────────────────────

function fakeRedis({ failWith = null } = {}) {
  const store = new Map();
  const deleted = [];
  return {
    store,
    deleted,
    async setNx(key, value, ttl) {
      if (failWith) return failWith;
      if (store.has(key)) return 'duplicate';
      store.set(key, { value, ttl });
      return 'new';
    },
    async del(key) {
      deleted.push(key);
      store.delete(key);
      return 1;
    },
  };
}

function fakeFetch({ status = 200, json = { matched: 42, sent: 42, nextCursor: null }, throws = null } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (throws) throw throws;
    return { status, json: async () => json };
  };
  fn.calls = calls;
  return fn;
}

/** Replays a scripted sequence of responses, one per call. */
function scriptedFetch(steps) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const step = steps[calls.length - 1];
    if (!step) throw new Error(`unexpected call #${calls.length}`);
    if (step.throws) throw step.throws;
    return { status: step.status ?? 200, json: async () => step.json ?? {} };
  };
  fn.calls = calls;
  return fn;
}

const BASE_ENV = {
  BROADCAST_PUSH_ENABLED: '1',
  BROADCAST_PUSH_DRY_RUN: '0',
  PUSH_ADMIN_SECRET: 'test-secret',
  BROADCAST_PUSH_BASE_URL: 'https://example.test',
  BROADCAST_PUSH_MIN_LEVEL: 'high',
};

function makeDispatcher(envOverrides = {}, deps = {}) {
  const redis = deps.redis ?? fakeRedis();
  const fetchImpl = deps.fetchImpl ?? fakeFetch();
  const silent = { log: () => {}, warn: () => {} };
  const dispatcher = createBroadcastPushDispatcher({
    env: { ...BASE_ENV, ...envOverrides },
    redis,
    fetchImpl,
    log: silent,
    now: deps.now ?? (() => 1_800_000_000_000),
    translate: deps.translate,
  });
  return { dispatcher, redis, fetchImpl };
}

const CRITICAL = { title: 'Major strike reported near the strait', level: 'critical', link: 'https://n.test/a', source: 'Reuters' };

// ── Audience mapping ──────────────────────────────────────────────────────────

describe('audienceForLevel — device threshold, not event severity', () => {
  it('critical reaches every threshold, including users who asked for critical-only', () => {
    assert.deepEqual([...audienceForLevel('critical')], ['high', 'medium', 'low']);
  });

  it('high skips the critical-only cohort', () => {
    assert.deepEqual([...audienceForLevel('high')], ['medium', 'low']);
    assert.ok(!audienceForLevel('high').includes('high'), 'a "high" device asked for critical events ONLY');
  });

  it('medium reaches only the all-breaking-news cohort', () => {
    assert.deepEqual([...audienceForLevel('medium')], ['low']);
  });

  it('low and info never broadcast', () => {
    assert.deepEqual([...audienceForLevel('low')], []);
    assert.deepEqual([...audienceForLevel('info')], []);
    assert.deepEqual([...audienceForLevel(undefined)], []);
  });

  it('is case- and whitespace-insensitive', () => {
    assert.deepEqual([...audienceForLevel(' CRITICAL ')], ['high', 'medium', 'low']);
  });
});

// ── Headline handling ─────────────────────────────────────────────────────────

describe('normalizeHeadline', () => {
  it('collapses whitespace', () => {
    assert.equal(normalizeHeadline('  a\n\tb   c '), 'a b c');
  });

  it('truncates to the APNs banner budget with an ellipsis', () => {
    const out = normalizeHeadline('x'.repeat(500));
    assert.equal(out.length, BODY_MAX_CHARS);
    assert.ok(out.endsWith('…'));
  });

  it('leaves a short headline untouched', () => {
    assert.equal(normalizeHeadline('Short one'), 'Short one');
  });
});

describe('dedupHash', () => {
  it('collapses casing and punctuation so one story cannot blast twice', () => {
    assert.equal(dedupHash('Strike Near Hormuz!'), dedupHash('strike near hormuz'));
  });

  it('separates genuinely different stories', () => {
    assert.notEqual(dedupHash('Strike near Hormuz'), dedupHash('Strike near Taiwan'));
  });

  it('ignores the level, so a re-classification does not earn a second push', () => {
    // The level is not an input at all — same title, same key.
    assert.equal(dedupHash('Story A'), dedupHash('Story A'));
  });
});

describe('hourBucket', () => {
  it('advances once per wall-clock hour', () => {
    assert.equal(hourBucket(3_600_000) - hourBucket(0), 1);
    assert.equal(hourBucket(3_599_999), hourBucket(0));
  });
});

// ── Arming ────────────────────────────────────────────────────────────────────

describe('arming', () => {
  it('is a no-op when BROADCAST_PUSH_ENABLED is unset', async () => {
    const { dispatcher, fetchImpl } = makeDispatcher({ BROADCAST_PUSH_ENABLED: undefined });
    const r = await dispatcher.observe(CRITICAL);
    assert.equal(r.action, 'disabled');
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('is inert without PUSH_ADMIN_SECRET even when armed', async () => {
    const { dispatcher, fetchImpl } = makeDispatcher({ PUSH_ADMIN_SECRET: undefined });
    const r = await dispatcher.observe(CRITICAL);
    assert.equal(r.action, 'disabled');
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('defaults to dry-run when BROADCAST_PUSH_DRY_RUN is unset', async () => {
    const { dispatcher, fetchImpl } = makeDispatcher({ BROADCAST_PUSH_DRY_RUN: undefined });
    const r = await dispatcher.observe(CRITICAL);
    assert.equal(r.action, 'dry-run');
    assert.equal(fetchImpl.calls[0].body.dryRun, true, 'dry-run must be the default posture');
  });

  it('only leaves dry-run for the exact string "0"', async () => {
    for (const value of ['false', 'no', '', 'off']) {
      const { dispatcher, fetchImpl } = makeDispatcher({ BROADCAST_PUSH_DRY_RUN: value });
      await dispatcher.observe(CRITICAL);
      assert.equal(fetchImpl.calls[0].body.dryRun, true, `"${value}" must not arm a live send`);
    }
  });
});

// ── Level gate ────────────────────────────────────────────────────────────────

describe('BROADCAST_PUSH_MIN_LEVEL', () => {
  it('is inert by default, so the user\'s own priority decides', async () => {
    // The relay hook only ever emits critical|high, so a default of `high`
    // means this global floor never overrides AUDIENCE_BY_LEVEL.
    const { dispatcher, fetchImpl } = makeDispatcher({ BROADCAST_PUSH_MIN_LEVEL: undefined });
    assert.equal((await dispatcher.observe({ ...CRITICAL, level: 'high', sources: 2 })).action, 'sent');
    assert.deepEqual(fetchImpl.calls[0].body.audience.priority, ['medium', 'low'],
      'a high story reaches everyone EXCEPT the critical-only cohort');
  });

  it('an unrecognised value falls back to the inert default, not to a brake', async () => {
    const { dispatcher } = makeDispatcher({ BROADCAST_PUSH_MIN_LEVEL: 'everything' });
    assert.equal((await dispatcher.observe({ ...CRITICAL, level: 'high', sources: 2 })).action, 'sent');
  });

  it('can still be raised to critical as a deliberate temporary brake', async () => {
    const { dispatcher, fetchImpl } = makeDispatcher({ BROADCAST_PUSH_MIN_LEVEL: 'critical' });
    assert.equal((await dispatcher.observe({ ...CRITICAL, level: 'high' })).action, 'skipped');
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal((await dispatcher.observe(CRITICAL)).action, 'sent');
  });

  it('drops empty titles', async () => {
    const { dispatcher } = makeDispatcher();
    assert.equal((await dispatcher.observe({ ...CRITICAL, title: '   ' })).action, 'skipped');
  });
});

// ── Dedup, gap and cap all fail closed ────────────────────────────────────────

describe('dedup', () => {
  it('sends once and suppresses the repeat', async () => {
    const { dispatcher, fetchImpl } = makeDispatcher();
    assert.equal((await dispatcher.observe(CRITICAL)).action, 'sent');
    assert.equal((await dispatcher.observe(CRITICAL)).action, 'suppressed');
    assert.equal(fetchImpl.calls.length, 1);
  });

  it('suppresses when Redis is unreachable — a duplicate blast is worse than a miss', async () => {
    const { dispatcher, fetchImpl } = makeDispatcher({}, { redis: fakeRedis({ failWith: 'error' }) });
    const r = await dispatcher.observe(CRITICAL);
    assert.equal(r.action, 'suppressed');
    assert.match(r.reason, /dedup unavailable/);
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('suppresses when Redis is disabled entirely', async () => {
    const { dispatcher, fetchImpl } = makeDispatcher({}, { redis: fakeRedis({ failWith: 'disabled' }) });
    assert.equal((await dispatcher.observe(CRITICAL)).action, 'suppressed');
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('does not burn the min-gap window on a duplicate', async () => {
    const { dispatcher, redis } = makeDispatcher({ BROADCAST_PUSH_MIN_GAP_S: '900' });
    await dispatcher.observe(CRITICAL);
    redis.store.delete('wm:broadcast-push:v1:gap'); // simulate the gap expiring
    await dispatcher.observe(CRITICAL);             // same story again
    // A fresh story must still be able to claim the gap.
    const r = await dispatcher.observe({ ...CRITICAL, title: 'A different story entirely' });
    assert.equal(r.action, 'sent');
  });
});

describe('min-gap', () => {
  it('suppresses a second distinct story inside the window', async () => {
    const { dispatcher, fetchImpl } = makeDispatcher({ BROADCAST_PUSH_MIN_GAP_S: '900' });
    assert.equal((await dispatcher.observe(CRITICAL)).action, 'sent');
    const r = await dispatcher.observe({ ...CRITICAL, title: 'Second unrelated story' });
    assert.equal(r.action, 'suppressed');
    assert.match(r.reason, /min-gap/);
    assert.equal(fetchImpl.calls.length, 1);
  });

  it('is skippable with 0 for a controlled backfill', async () => {
    const { dispatcher, fetchImpl } = makeDispatcher({ BROADCAST_PUSH_MIN_GAP_S: '0', BROADCAST_PUSH_HOURLY_CAP: '5' });
    await dispatcher.observe(CRITICAL);
    await dispatcher.observe({ ...CRITICAL, title: 'Second unrelated story' });
    assert.equal(fetchImpl.calls.length, 2);
  });
});

describe('hourly cap', () => {
  it('stops at the configured number of broadcasts per wall-clock hour', async () => {
    const { dispatcher, fetchImpl } = makeDispatcher({
      BROADCAST_PUSH_MIN_GAP_S: '0',
      BROADCAST_PUSH_HOURLY_CAP: '2',
    });
    assert.equal((await dispatcher.observe({ ...CRITICAL, title: 'Story one' })).action, 'sent');
    assert.equal((await dispatcher.observe({ ...CRITICAL, title: 'Story two' })).action, 'sent');
    const third = await dispatcher.observe({ ...CRITICAL, title: 'Story three' });
    assert.equal(third.action, 'suppressed');
    assert.match(third.reason, /hourly cap/);
    assert.equal(fetchImpl.calls.length, 2);
  });

  it('refills on the next hour bucket', async () => {
    let clock = 1_800_000_000_000;
    const redis = fakeRedis();
    const fetchImpl = fakeFetch();
    const { dispatcher } = makeDispatcher(
      { BROADCAST_PUSH_MIN_GAP_S: '0', BROADCAST_PUSH_HOURLY_CAP: '1' },
      { redis, fetchImpl, now: () => clock },
    );
    assert.equal((await dispatcher.observe({ ...CRITICAL, title: 'Story one' })).action, 'sent');
    assert.equal((await dispatcher.observe({ ...CRITICAL, title: 'Story two' })).action, 'suppressed');
    clock += 3_600_000;
    assert.equal((await dispatcher.observe({ ...CRITICAL, title: 'Story three' })).action, 'sent');
  });
});

// ── Payload contract with pages/api/push/send.ts and PushRoute.swift ──────────

describe('payload', () => {
  let body;
  beforeEach(async () => {
    const { dispatcher, fetchImpl } = makeDispatcher();
    await dispatcher.observe(CRITICAL);
    body = fetchImpl.calls[0].body;
  });

  it('targets the audience for the level', () => {
    assert.deepEqual(body.audience.priority, ['high', 'medium', 'low']);
    assert.equal(body.audience.includeUnsetPriority, true, 'critical includes the iOS default cohort');
  });

  it('does not claim unset-priority devices for a level the default cohort did not ask for', async () => {
    const { dispatcher, fetchImpl } = makeDispatcher({ BROADCAST_PUSH_MIN_LEVEL: 'medium' });
    await dispatcher.observe({ ...CRITICAL, level: 'medium' });
    const sent = fetchImpl.calls[0].body;
    assert.deepEqual(sent.audience.priority, ['low']);
    assert.equal(
      sent.audience.includeUnsetPriority, false,
      `unset priority means ${APP_DEFAULT_PRIORITY}, which a medium event does not reach`,
    );
  });

  it('carries an article route matching PushRoute.init?(userInfo:)', () => {
    assert.deepEqual(body.route, { type: 'article', url: 'https://n.test/a', title: CRITICAL.title });
  });

  it('omits the route entirely when there is no link', async () => {
    const { dispatcher, fetchImpl } = makeDispatcher();
    await dispatcher.observe({ ...CRITICAL, link: '' });
    assert.equal('route' in fetchImpl.calls[0].body, false, 'PushRoute returns nil for an article route with no url');
  });

  it('uses the collapse id to coalesce a repeat of the same story on the lock screen', () => {
    assert.equal(body.collapseId, dedupHash(CRITICAL.title));
    assert.ok(body.collapseId.length <= 64, 'APNs truncates apns-collapse-id at 64 bytes');
  });

  it('sends the source as the subtitle and the headline as the body', () => {
    assert.equal(body.alert.body, CRITICAL.title);
    assert.equal(body.alert.subtitle, 'Reuters');
    assert.equal(body.alert.title.en, 'WORLD ALERT');
  });

  it('omits the subtitle when the source is unknown', async () => {
    const { dispatcher, fetchImpl } = makeDispatcher();
    await dispatcher.observe({ ...CRITICAL, source: '' });
    assert.equal('subtitle' in fetchImpl.calls[0].body.alert, false);
  });

  it('routes to the sandbox host only when APNS_ENVIRONMENT says so', async () => {
    const prod = makeDispatcher();
    await prod.dispatcher.observe(CRITICAL);
    assert.equal(prod.fetchImpl.calls[0].body.sandbox, false);

    const sand = makeDispatcher({ APNS_ENVIRONMENT: 'sandbox' });
    await sand.dispatcher.observe(CRITICAL);
    assert.equal(sand.fetchImpl.calls[0].body.sandbox, true);
  });
});

describe('request', () => {
  it('posts to /api/push/send with the bearer secret', async () => {
    const { dispatcher, fetchImpl } = makeDispatcher();
    await dispatcher.observe(CRITICAL);
    const call = fetchImpl.calls[0];
    assert.equal(call.url, 'https://example.test/api/push/send');
    assert.equal(call.init.headers.Authorization, 'Bearer test-secret');
    assert.equal(call.init.method, 'POST');
  });

  it('strips a trailing slash from the configured base url', async () => {
    const { dispatcher, fetchImpl } = makeDispatcher({ BROADCAST_PUSH_BASE_URL: 'https://example.test///' });
    await dispatcher.observe(CRITICAL);
    assert.equal(fetchImpl.calls[0].url, 'https://example.test/api/push/send');
  });
});

// ── Paging: what keeps the Vercel wall-clock ceiling out of the picture ───────

describe('paging', () => {
  it('follows nextCursor until the endpoint stops handing one back', async () => {
    const fetchImpl = scriptedFetch([
      { json: { matched: 5000, sent: 4990, nextCursor: 'aaa' } },
      { json: { matched: 5000, sent: 5000, nextCursor: 'bbb' } },
      { json: { matched: 1200, sent: 1200, nextCursor: null } },
    ]);
    const { dispatcher } = makeDispatcher({}, { fetchImpl });
    const r = await dispatcher.observe(CRITICAL);

    assert.equal(r.action, 'sent');
    assert.equal(r.pages, 3);
    assert.equal(r.matched, 11_200, 'counts accumulate across pages');
    assert.equal(r.sent, 11_190);
    assert.equal(r.complete, true);
  });

  it('passes the previous cursor as audience.after and omits it on page 1', async () => {
    const fetchImpl = scriptedFetch([
      { json: { matched: 1, sent: 1, nextCursor: 'cursor-1' } },
      { json: { matched: 1, sent: 1, nextCursor: null } },
    ]);
    const { dispatcher } = makeDispatcher({}, { fetchImpl });
    await dispatcher.observe(CRITICAL);

    assert.equal('after' in fetchImpl.calls[0].body.audience, false, 'page 1 starts at the beginning');
    assert.equal(fetchImpl.calls[1].body.audience.after, 'cursor-1');
  });

  it('keeps the rest of the audience filter identical on every page', async () => {
    const fetchImpl = scriptedFetch([
      { json: { matched: 1, sent: 1, nextCursor: 'c1' } },
      { json: { matched: 1, sent: 1, nextCursor: null } },
    ]);
    const { dispatcher } = makeDispatcher({}, { fetchImpl });
    await dispatcher.observe(CRITICAL);

    const [first, second] = fetchImpl.calls.map((c) => c.body);
    assert.deepEqual(second.audience.priority, first.audience.priority);
    assert.equal(second.audience.includeUnsetPriority, first.audience.includeUnsetPriority);
    assert.equal(second.collapseId, first.collapseId);
    assert.deepEqual(second.alert, first.alert);
  });

  it('sends a single page without a second call when there is no cursor', async () => {
    const { dispatcher, fetchImpl } = makeDispatcher();
    const r = await dispatcher.observe(CRITICAL);
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(r.pages, 1);
  });

  it('stops at BROADCAST_PUSH_MAX_PAGES and reports the run as incomplete', async () => {
    const fetchImpl = scriptedFetch([
      { json: { matched: 10, sent: 10, nextCursor: 'c1' } },
      { json: { matched: 10, sent: 10, nextCursor: 'c2' } },
      { json: { matched: 10, sent: 10, nextCursor: 'c3' } },
    ]);
    const { dispatcher } = makeDispatcher({ BROADCAST_PUSH_MAX_PAGES: '2' }, { fetchImpl });
    const r = await dispatcher.observe(CRITICAL);

    assert.equal(fetchImpl.calls.length, 2, 'must not keep paging past the guard');
    assert.equal(r.complete, false, 'a truncated run must not report as complete');
    assert.equal(r.matched, 20);
  });

  it('does not claim completion when the endpoint truncated with no resume cursor', async () => {
    const fetchImpl = scriptedFetch([
      { json: { matched: 0, sent: 0, truncated: true, remaining: 5000, nextCursor: null } },
    ]);
    const { dispatcher } = makeDispatcher({}, { fetchImpl });
    const r = await dispatcher.observe(CRITICAL);
    assert.equal(r.action, 'sent');
    assert.equal(r.complete, false, 'no forward progress must not read as audience exhausted');
  });

  it('follows the cursor in dry-run too, so the matched count is the real audience size', async () => {
    const fetchImpl = scriptedFetch([
      { json: { dryRun: true, matched: 5000, nextCursor: 'c1' } },
      { json: { dryRun: true, matched: 300, nextCursor: null } },
    ]);
    const { dispatcher } = makeDispatcher({ BROADCAST_PUSH_DRY_RUN: undefined }, { fetchImpl });
    const r = await dispatcher.observe(CRITICAL);
    assert.equal(r.action, 'dry-run');
    assert.equal(r.matched, 5300);
  });
});

describe('paging failure', () => {
  it('releases the guards when page 1 itself fails — nothing went out', async () => {
    const redis = fakeRedis();
    const fetchImpl = scriptedFetch([{ status: 401, json: {} }]);
    const { dispatcher } = makeDispatcher({}, { redis, fetchImpl });
    const r = await dispatcher.observe(CRITICAL);
    assert.equal(r.pages, 0);
    assert.ok(redis.deleted.length > 0, 'a retry is safe and desirable here');
  });

  it('KEEPS the guards when a later page fails — those devices already have it', async () => {
    const redis = fakeRedis();
    const fetchImpl = scriptedFetch([
      { json: { matched: 5000, sent: 5000, nextCursor: 'c1' } },
      { status: 500, json: {} },
    ]);
    const { dispatcher } = makeDispatcher({}, { redis, fetchImpl });
    const r = await dispatcher.observe(CRITICAL);

    assert.equal(r.action, 'error');
    assert.equal(r.pages, 1);
    assert.equal(r.matched, 5000, 'the partial reach is reported, not swallowed');
    assert.equal(redis.deleted.length, 0, 'releasing here would re-blast the first 5000 devices');
  });

  it('keeps the guards when a later page times out at the transport level', async () => {
    const redis = fakeRedis();
    const fetchImpl = scriptedFetch([
      { json: { matched: 5000, sent: 5000, nextCursor: 'c1' } },
      { throws: new Error('AbortError') },
    ]);
    const { dispatcher } = makeDispatcher({}, { redis, fetchImpl });
    const r = await dispatcher.observe(CRITICAL);
    assert.equal(r.action, 'error');
    assert.equal(redis.deleted.length, 0);
  });
});

// ── Failure unwind ────────────────────────────────────────────────────────────

describe('failure handling', () => {
  it('releases every guard when the request never reached Vercel', async () => {
    const redis = fakeRedis();
    const { dispatcher } = makeDispatcher(
      { BROADCAST_PUSH_MIN_GAP_S: '900' },
      { redis, fetchImpl: fakeFetch({ throws: new Error('ECONNREFUSED') }) },
    );
    const r = await dispatcher.observe(CRITICAL);
    assert.equal(r.action, 'error');
    assert.equal(redis.deleted.length, 4, 'dedup + gap + hourly and daily slots must all be released');
    assert.ok(redis.deleted.some((k) => k.includes(':seen:')));
    assert.ok(redis.deleted.some((k) => k.endsWith(':gap')));
    assert.ok(redis.deleted.some((k) => k.includes(':cap:')));
  });

  it('releases on a 401, which proves nothing was sent', async () => {
    const redis = fakeRedis();
    const { dispatcher } = makeDispatcher({}, { redis, fetchImpl: fakeFetch({ status: 401, json: {} }) });
    assert.equal((await dispatcher.observe(CRITICAL)).action, 'error');
    assert.ok(redis.deleted.length > 0);
  });

  it('KEEPS the dedup key on a 500 — the handler may already be mid-fan-out', async () => {
    const redis = fakeRedis();
    const { dispatcher } = makeDispatcher({}, { redis, fetchImpl: fakeFetch({ status: 500, json: {} }) });
    assert.equal((await dispatcher.observe(CRITICAL)).action, 'error');
    assert.equal(redis.deleted.length, 0, 'a retry after a partial send would double-blast the install base');
  });

  it('never rejects, whatever the caller passes', async () => {
    const { dispatcher } = makeDispatcher();
    for (const input of [null, undefined, {}, { title: 1, level: {} }]) {
      const r = await dispatcher.observe(input);
      assert.ok(typeof r.action === 'string');
    }
  });
});

// ── Localization ──────────────────────────────────────────────────────────────

describe('i18n', () => {
  it('sends a plain English string when i18n is off', async () => {
    const { dispatcher, fetchImpl } = makeDispatcher({}, { translate: async () => ({ tr: 'X' }) });
    await dispatcher.observe(CRITICAL);
    assert.equal(typeof fetchImpl.calls[0].body.alert.body, 'string');
  });

  it('sends a per-language map with an en fallback when i18n is on', async () => {
    const { dispatcher, fetchImpl } = makeDispatcher(
      { BROADCAST_PUSH_I18N: '1', BROADCAST_PUSH_LANGS: 'tr,de' },
      { translate: async () => ({ tr: 'Boğaz yakınında saldırı', de: 'Angriff nahe der Meerenge' }) },
    );
    await dispatcher.observe(CRITICAL);
    const alertBody = fetchImpl.calls[0].body.alert.body;
    assert.equal(alertBody.en, CRITICAL.title, 'pick() in send.ts falls back to .en');
    assert.equal(alertBody.tr, 'Boğaz yakınında saldırı');
    assert.equal(alertBody.de, 'Angriff nahe der Meerenge');
  });

  it('falls back to English rather than dropping the push when the translator throws', async () => {
    const { dispatcher, fetchImpl } = makeDispatcher(
      { BROADCAST_PUSH_I18N: '1', BROADCAST_PUSH_LANGS: 'tr' },
      { translate: async () => { throw new Error('llm down'); } },
    );
    const r = await dispatcher.observe(CRITICAL);
    assert.equal(r.action, 'sent');
    assert.equal(fetchImpl.calls[0].body.alert.body, CRITICAL.title);
  });
});

// ── Wiring into the relay ─────────────────────────────────────────────────────

describe('ais-relay.cjs wiring', () => {
  it('requires the dispatcher', () => {
    assert.match(aisRelaySrc, /require\('\.\/lib\/broadcast-push\.cjs'\)/);
  });

  it('gates construction on BROADCAST_PUSH_ENABLED and Upstash', () => {
    assert.match(aisRelaySrc, /UPSTASH_ENABLED && process\.env\.BROADCAST_PUSH_ENABLED === '1'/);
  });

  it('observes from both the cached and the freshly-classified paths', () => {
    const hooks = aisRelaySrc.match(/broadcastPushObserve\(/g) ?? [];
    // 1 declaration + 2 call sites.
    assert.ok(hooks.length >= 3, `expected the hook at both classify paths, found ${hooks.length}`);
  });

  it('applies the same source-tier gate as the Live Activity hook', () => {
    const fn = aisRelaySrc.slice(aisRelaySrc.indexOf('function broadcastPushObserve'));
    assert.match(fn.slice(0, 900), /shouldDropRelaySourceForTier\(RELAY_GATES_READY/);
  });

  it('applies its own recency gate, wider than the 15min relay one', () => {
    const fn = aisRelaySrc.slice(aisRelaySrc.indexOf('function broadcastPushObserve'));
    assert.match(fn.slice(0, 1400), /BROADCAST_PUSH_RECENCY_MS/);
    assert.match(
      aisRelaySrc,
      /BROADCAST_PUSH_RECENCY_MS \|\| 60 \* 60 \* 1000/,
      'a 15min publish-age wall dropped most stories: the classify sweep itself is ~15min behind publish',
    );
  });

  it('logs every drop — a silent no-op reads exactly like "no news today"', () => {
    const fn = aisRelaySrc.slice(aisRelaySrc.indexOf('function broadcastPushObserve'));
    assert.match(fn.slice(0, 2200), /skip stale/);
    assert.match(fn.slice(0, 2200), /suppressed.*\|\|.*skipped|action === 'suppressed'/);
  });
});

// ── Contract with the sibling Next.js endpoint ────────────────────────────────

describe('pages/api/push/send.ts contract', { skip: sendEndpointSrc ? false : 'sibling repo not present' }, () => {
  it('honours includeUnsetPriority so default-priority devices are reachable', () => {
    assert.match(sendEndpointSrc, /includeUnsetPriority/);
    assert.match(sendEndpointSrc, /\$in:\s*\[\.\.\.audience\.priority,\s*null\]/);
  });

  it('has no committed admin-secret fallback', () => {
    assert.doesNotMatch(
      sendEndpointSrc,
      /PUSH_ADMIN_SECRET\s*\|\|\s*["'][0-9a-f]{16,}/,
      'a default admin secret makes the endpoint world-writable to anyone with repo access',
    );
  });

  it('compares the bearer in constant time', () => {
    assert.match(sendEndpointSrc, /timingSafeEqual/);
  });

  it('derives the reported env from the host it actually addressed', () => {
    assert.match(sendEndpointSrc, /env:\s*isSandbox\s*\?\s*"sandbox"\s*:\s*"production"/);
  });

  it('pages with a stable _id cursor rather than a skip/offset window', () => {
    assert.match(sendEndpointSrc, /filter\._id\s*=\s*\{\s*\$gt:\s*new ObjectId\(audience\.after\)\s*\}/);
    assert.match(sendEndpointSrc, /\.sort\(\{\s*_id:\s*1\s*\}\)/, 'a cursor is meaningless without a matching sort');
    assert.doesNotMatch(sendEndpointSrc, /\.skip\(/, 'skip/offset double-sends when a device registers mid-run');
  });

  it('rejects a malformed cursor instead of throwing a 500', () => {
    assert.match(sendEndpointSrc, /ObjectId\.isValid\(audience\.after\)/);
  });

  it('reserves budget for the slowest in-flight stream and the cleanup', () => {
    assert.match(sendEndpointSrc, /MAX_DURATION_MS\s*-\s*REQUEST_TIMEOUT_MS\s*-\s*[\d_]+/);
    assert.match(sendEndpointSrc, /maxDuration:\s*300/, 'Vercel Pro ceiling');
  });

  it('resumes from the last ATTEMPTED device, not the last fetched one', () => {
    assert.match(sendEndpointSrc, /const attempted = messages\.length - unsent\.length/);
    assert.match(sendEndpointSrc, /attempted > 0 \? cursorAt\(attempted - 1\)/);
    assert.match(
      sendEndpointSrc,
      /attempted > 0 \? cursorAt\(attempted - 1\) : \(audience\.after \?\? null\)/,
      'zero progress must hand back the incoming cursor, not null',
    );
  });
});

describe('lib/apns.ts hardening', { skip: apnsLibSrc ? false : 'sibling repo not present' }, () => {
  it('bounds every stream, so one hung request cannot retire a worker', () => {
    assert.match(apnsLibSrc, /REQUEST_TIMEOUT_MS/);
    assert.match(apnsLibSrc, /reason:\s*"RequestTimeout"/);
    assert.match(apnsLibSrc, /NGHTTP2_CANCEL/, 'the stream must be cancelled, not just abandoned');
  });

  it('settles each stream exactly once', () => {
    assert.match(apnsLibSrc, /if \(done\) return;/, 'end + error + timeout can all fire on one stream');
  });

  it('bounds the connect handshake', () => {
    assert.match(apnsLibSrc, /CONNECT_TIMEOUT_MS/);
    assert.match(apnsLibSrc, /client\.once\("connect"/);
  });

  it('stops dequeuing at the deadline and returns the untouched tail', () => {
    assert.match(apnsLibSrc, /if \(deadline !== undefined && Date\.now\(\) >= deadline\) return;/);
    assert.match(apnsLibSrc, /return \{ results, unsent: queue \}/);
  });

  it('closes the session even when a worker throws', () => {
    assert.match(apnsLibSrc, /\} finally \{[\s\S]*client\.close\(\)/);
  });
});

describe('variant scoping', () => {
  const relaySrc = readFileSync(resolve(__dirname, '..', 'scripts', 'ais-relay.cjs'), 'utf-8');

  it('only the world variant may broadcast', () => {
    assert.match(
      relaySrc,
      /BROADCAST_PUSH_VARIANTS = new Set\(\s*\n?\s*\(process\.env\.BROADCAST_PUSH_VARIANTS \|\| 'full'\)/,
      'the relay classifies each variant against its OWN feeds, so "high" for tech is noise for everyone else',
    );
    assert.match(relaySrc, /if \(!BROADCAST_PUSH_VARIANTS\.has\(variant\)\) return;/);
  });

  it('threads the variant through from both classify call sites', () => {
    // Nested parens in the arguments defeat a regex, so match the exact lines.
    assert.match(
      relaySrc,
      /observeCriticalSurfaces\(titleArr\[i\], allTitles\.get\(titleArr\[i\]\), level, variant\);/,
      'cached-classification path must route through the coordinator',
    );
    assert.match(
      relaySrc,
      /observeCriticalSurfaces\(chunk\[idx\], meta, level, variant\);/,
      'freshly-classified path must route through the coordinator',
    );
    // 1 declaration + 4 coordinator-internal calls; classify paths call the
    // coordinator, never broadcastPushObserve directly.
    const direct = (relaySrc.match(/broadcastPushObserve\(titleArr|broadcastPushObserve\(chunk/g) ?? []).length;
    assert.equal(direct, 0, 'classify paths must not bypass observeCriticalSurfaces');
  });
});

describe('one loud surface per critical', () => {
  it('cedes the banner when the activity owns the story, fires it when held', () => {
    const fn = aisRelaySrc.slice(aisRelaySrc.indexOf('function observeCriticalSurfaces'));
    assert.match(fn.slice(0, 1400), /action === 'started'/);
    assert.match(fn.slice(0, 1400), /action === 'updated'/);
    assert.match(aisRelaySrc, /LA_CEDE_NOOP_REASONS = new Set\(\['already-started', 'no-new-reports'\]\)/);
    assert.match(fn.slice(0, 1400), /ceded to live activity/);
    assert.match(fn.slice(0, 1400), /\.catch\(\(\) => broadcastPushObserve/, 'an LA failure must not swallow the banner');
  });

  it('high stories keep their banner without touching the activity path', () => {
    const fn = aisRelaySrc.slice(aisRelaySrc.indexOf('function observeCriticalSurfaces'));
    assert.match(fn.slice(0, 500), /if \(level !== 'critical'\) \{\s*\n\s*broadcastPushObserve/);
  });
});

describe('localized banner titles', () => {
  const { TITLE_MAP_BY_LEVEL } = require('../scripts/lib/broadcast-push.cjs');

  it('sends a per-language title map, resolved server-side (no APNs loc-key)', async () => {
    const { dispatcher, fetchImpl } = makeDispatcher();
    await dispatcher.observe(CRITICAL);
    const { title } = fetchImpl.calls[0].body.alert;
    assert.equal(typeof title, 'object');
    assert.equal(title.tr, 'KÜRESEL UYARI');
    assert.equal(title.en, 'WORLD ALERT');
  });

  it('high uses the catalog Breaking News strings', async () => {
    const { dispatcher, fetchImpl } = makeDispatcher();
    await dispatcher.observe({ ...CRITICAL, level: 'high', sources: 2 });
    assert.equal(fetchImpl.calls[0].body.alert.title.tr, 'Son Dakika');
  });

  it('every level map ships en and only base language codes', () => {
    for (const [level, map] of Object.entries(TITLE_MAP_BY_LEVEL)) {
      assert.ok(map.en, `${level} missing en fallback`);
      for (const lang of Object.keys(map)) {
        assert.doesNotMatch(lang, /[-_]/, `${level}.${lang}: devices send languageCode only`);
      }
    }
  });

  it('titles match the app catalog verbatim', () => {
    const { readFileSync } = require('node:fs');
    let cat;
    try {
      cat = JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'WorldView', 'WorldMonitor', 'Localizable.xcstrings'), 'utf-8'));
    } catch { return; }
    const tr = cat.strings['Breaking News']?.localizations?.tr?.stringUnit?.value;
    if (tr) assert.equal(TITLE_MAP_BY_LEVEL.high.tr, tr, 'drifted from the String Catalog');
  });
});

describe('corroboration maps onto user tolerance', () => {
  it('an uncorroborated high reaches ONLY the low cohort — they asked for the firehose', async () => {
    const { dispatcher, fetchImpl } = makeDispatcher();
    const r = await dispatcher.observe({ ...CRITICAL, level: 'high', sources: 1 });
    assert.equal(r.action, 'sent');
    assert.deepEqual(r.audience, ['low']);
    const { audience } = fetchImpl.calls[0].body;
    assert.deepEqual(audience.priority, ['low']);
    assert.equal(audience.includeUnsetPriority, false, 'unset means the medium default, which did not ask for unconfirmed news');
  });

  it('a corroborated high reaches medium + low', async () => {
    const { dispatcher, fetchImpl } = makeDispatcher();
    assert.equal((await dispatcher.observe({ ...CRITICAL, level: 'high', sources: 2 })).action, 'sent');
    assert.deepEqual(fetchImpl.calls[0].body.audience.priority, ['medium', 'low']);
  });

  it('critical is exempt — single-source critical still reaches everyone', async () => {
    const { dispatcher, fetchImpl } = makeDispatcher();
    assert.equal((await dispatcher.observe({ ...CRITICAL, sources: 1 })).action, 'sent');
    assert.deepEqual(fetchImpl.calls[0].body.audience.priority, ['high', 'medium', 'low']);
  });

  it('missing sources counts as 1, not as a free pass to medium', async () => {
    const { dispatcher, fetchImpl } = makeDispatcher();
    await dispatcher.observe({ ...CRITICAL, level: 'high' });
    assert.deepEqual(fetchImpl.calls[0].body.audience.priority, ['low']);
  });
});

describe('daily cap', () => {
  it('stops at the configured broadcasts per UTC day, across hours', async () => {
    let clock = 1_800_000_000_000;
    const redis = fakeRedis();
    const { dispatcher, fetchImpl } = makeDispatcher(
      { BROADCAST_PUSH_MIN_GAP_S: '0', BROADCAST_PUSH_HOURLY_CAP: '10', BROADCAST_PUSH_DAILY_CAP: '2' },
      { redis, now: () => clock },
    );
    assert.equal((await dispatcher.observe({ ...CRITICAL, title: 'S1' })).action, 'sent');
    clock += 3_600_000; // hourly cap resets, daily must not
    assert.equal((await dispatcher.observe({ ...CRITICAL, title: 'S2' })).action, 'sent');
    clock += 3_600_000;
    const third = await dispatcher.observe({ ...CRITICAL, title: 'S3' });
    assert.equal(third.action, 'suppressed');
    assert.match(third.reason, /daily cap/);
    assert.equal(fetchImpl.calls.length, 2);
  });

  it('refills on the next UTC day', async () => {
    let clock = 1_800_000_000_000;
    const redis = fakeRedis();
    const { dispatcher } = makeDispatcher(
      { BROADCAST_PUSH_MIN_GAP_S: '0', BROADCAST_PUSH_HOURLY_CAP: '10', BROADCAST_PUSH_DAILY_CAP: '1' },
      { redis, now: () => clock },
    );
    assert.equal((await dispatcher.observe({ ...CRITICAL, title: 'D1' })).action, 'sent');
    clock += 86_400_000;
    assert.equal((await dispatcher.observe({ ...CRITICAL, title: 'D2' })).action, 'sent');
  });

  it('releases the daily slot too when the transport fails before any page lands', async () => {
    const redis = fakeRedis();
    const { dispatcher } = makeDispatcher(
      { BROADCAST_PUSH_MIN_GAP_S: '900' },
      { redis, fetchImpl: scriptedFetch([{ throws: new Error('ECONNREFUSED') }]) },
    );
    await dispatcher.observe(CRITICAL);
    assert.ok(redis.deleted.some((k) => k.includes(':daycap:')), 'a failed send must not burn a daily slot');
  });
});
