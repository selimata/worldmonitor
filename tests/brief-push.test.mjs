/**
 * AI World Brief push — scripts/lib/brief-push.cjs.
 *
 * The invariant under test: the brief cron runs HOURLY, and none of that
 * rhythm may reach a user's lock screen. Every guard fails closed, and the
 * audience is limited to the one cohort whose Settings wording admits a
 * scheduled digest.
 *
 * Run: node --test tests/brief-push.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const {
  createBriefPushNotifier,
  localizedTitle,
  localizedBody,
  TITLE_BY_LANG,
  BODY_BY_LANG,
  TITLE_EMOJI,
  DEFAULT_COHORTS,
} = require('../scripts/lib/brief-push.cjs');

const seedInsightsSrc = readFileSync(resolve(__dirname, '..', 'scripts', 'seed-insights.mjs'), 'utf-8');
const xcstrings = (() => {
  try {
    return JSON.parse(readFileSync(
      resolve(__dirname, '..', '..', 'WorldView', 'WorldMonitor', 'Localizable.xcstrings'), 'utf-8',
    ));
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
    async del(key) { deleted.push(key); store.delete(key); return 1; },
  };
}

function scriptedFetch(steps) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const step = steps[calls.length - 1] ?? { json: { matched: 10, sent: 10, nextCursor: null } };
    if (step.throws) throw step.throws;
    return { status: step.status ?? 200, json: async () => step.json ?? {} };
  };
  fn.calls = calls;
  return fn;
}

const BASE_ENV = {
  BRIEF_PUSH_ENABLED: '1',
  BRIEF_PUSH_DRY_RUN: '0',
  PUSH_ADMIN_SECRET: 'test-secret',
  BRIEF_PUSH_BASE_URL: 'https://example.test',
};

function make(envOverrides = {}, deps = {}) {
  const redis = deps.redis ?? fakeRedis();
  const fetchImpl = deps.fetchImpl ?? scriptedFetch([]);
  const notifier = createBriefPushNotifier({
    env: { ...BASE_ENV, ...envOverrides },
    redis,
    fetchImpl,
    log: { log: () => {}, warn: () => {} },
  });
  return { notifier, redis, fetchImpl };
}

// ── Localization ──────────────────────────────────────────────────────────────

describe('localization', () => {
  it('title and body cover exactly the same languages', () => {
    assert.deepEqual(Object.keys(TITLE_BY_LANG).sort(), Object.keys(BODY_BY_LANG).sort());
  });

  it('always ships en, the fallback pick() uses for unlisted locales', () => {
    assert.ok(TITLE_BY_LANG.en, 'send.ts pick() falls back to .en');
    assert.ok(BODY_BY_LANG.en);
  });

  it('every language has non-empty, trimmed copy', () => {
    for (const [lang, value] of Object.entries({ ...TITLE_BY_LANG, ...BODY_BY_LANG })) {
      assert.ok(typeof value === 'string' && value.trim().length > 0, `${lang} is empty`);
      assert.equal(value, value.trim(), `${lang} has stray whitespace`);
    }
  });

  it('is keyed by BASE language code, since that is all the device sends', () => {
    for (const lang of Object.keys(TITLE_BY_LANG)) {
      assert.doesNotMatch(
        lang, /[-_]/,
        `${lang} is a regional tag; NotificationService.swift sends languageCode only ("pt", never "pt-BR")`,
      );
    }
  });

  it('prefixes every title with the emoji and leaves the catalog string intact', () => {
    const titles = localizedTitle();
    for (const [lang, value] of Object.entries(titles)) {
      assert.ok(value.startsWith(`${TITLE_EMOJI} `), `${lang} missing the emoji prefix`);
      assert.equal(value.slice(TITLE_EMOJI.length + 1), TITLE_BY_LANG[lang]);
    }
  });

  it('bodies stay inside a sane banner length', () => {
    for (const [lang, value] of Object.entries(localizedBody())) {
      assert.ok(value.length <= 120, `${lang} body is ${value.length} chars — too long for a banner`);
    }
  });

  it('covers every base language the iOS app ships', { skip: xcstrings ? false : 'app not present' }, () => {
    const shipped = new Set();
    for (const entry of Object.values(xcstrings.strings)) {
      for (const tag of Object.keys(entry.localizations ?? {})) shipped.add(tag.split('-')[0]);
    }
    const missing = [...shipped].filter((l) => !TITLE_BY_LANG[l]).sort();
    assert.deepEqual(missing, [], `no localized brief copy for: ${missing.join(', ')}`);
  });

  it('reuses the app\'s own "AI World Brief" catalog strings', { skip: xcstrings ? false : 'app not present' }, () => {
    const locs = xcstrings.strings['AI World Brief']?.localizations ?? {};
    for (const [tag, entry] of Object.entries(locs)) {
      // Regional variants collapse to a primary, so only check the ones we kept.
      if (tag.includes('-')) continue;
      const value = entry?.stringUnit?.value;
      if (!value || !TITLE_BY_LANG[tag]) continue;
      assert.equal(TITLE_BY_LANG[tag], value, `${tag} drifted from the String Catalog`);
    }
  });
});

// ── Arming ────────────────────────────────────────────────────────────────────

describe('arming', () => {
  it('is a no-op unless BRIEF_PUSH_ENABLED=1', async () => {
    const { notifier, fetchImpl } = make({ BRIEF_PUSH_ENABLED: undefined });
    assert.equal((await notifier.notifyPublished()).action, 'disabled');
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('is inert without the admin secret', async () => {
    const { notifier, fetchImpl } = make({ PUSH_ADMIN_SECRET: undefined });
    assert.equal((await notifier.notifyPublished()).action, 'disabled');
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('defaults to dry-run', async () => {
    const { notifier, fetchImpl } = make({ BRIEF_PUSH_DRY_RUN: undefined });
    assert.equal((await notifier.notifyPublished()).action, 'dry-run');
    assert.equal(fetchImpl.calls[0].body.dryRun, true);
  });
});

// ── Cadence: the whole point ──────────────────────────────────────────────────

describe('cadence', () => {
  it('defaults to once a day, not once an hour like the cron', () => {
    const { notifier } = make({ BRIEF_PUSH_MIN_GAP_S: undefined });
    assert.equal(notifier.config.minGapS, 86_400);
  });

  it('sends the first publish and suppresses the next hourly run', async () => {
    const { notifier, fetchImpl } = make();
    assert.equal((await notifier.notifyPublished({ generatedAt: 1 })).action, 'sent');
    const second = await notifier.notifyPublished({ generatedAt: 2 });
    assert.equal(second.action, 'suppressed');
    assert.match(second.reason, /min-gap/);
    assert.equal(fetchImpl.calls.length, 1, 'an hourly cron must not become an hourly notification');
  });

  it('suppresses when Redis is unreachable rather than sending', async () => {
    const { notifier, fetchImpl } = make({}, { redis: fakeRedis({ failWith: 'error' }) });
    const r = await notifier.notifyPublished();
    assert.equal(r.action, 'suppressed');
    assert.equal(fetchImpl.calls.length, 0, 'failing open here would spam every hour');
  });
});

// ── Audience ──────────────────────────────────────────────────────────────────

describe('audience', () => {
  it('targets only the low cohort by default', async () => {
    const { notifier, fetchImpl } = make();
    await notifier.notifyPublished();
    assert.deepEqual(fetchImpl.calls[0].body.audience.priority, ['low']);
    assert.deepEqual([...DEFAULT_COHORTS], ['low']);
  });

  it('never claims unset-priority devices', async () => {
    const { notifier, fetchImpl } = make();
    await notifier.notifyPublished();
    assert.equal(
      fetchImpl.calls[0].body.audience.includeUnsetPriority, false,
      'unset means the iOS default "medium", which promises severity filtering a digest cannot meet',
    );
  });

  it('is overridable for a deliberate wider send', async () => {
    const { notifier, fetchImpl } = make({ BRIEF_PUSH_COHORTS: 'low,medium' });
    await notifier.notifyPublished();
    assert.deepEqual(fetchImpl.calls[0].body.audience.priority, ['low', 'medium']);
  });
});

// ── Payload ───────────────────────────────────────────────────────────────────

describe('payload', () => {
  it('routes to the brief tab', async () => {
    const { notifier, fetchImpl } = make();
    await notifier.notifyPublished();
    assert.deepEqual(fetchImpl.calls[0].body.route, { type: 'brief' });
  });

  it('collapses older unread brief banners instead of stacking them', async () => {
    const { notifier, fetchImpl } = make();
    await notifier.notifyPublished();
    assert.equal(fetchImpl.calls[0].body.collapseId, 'brief');
  });

  it('uses APNs priority 5 — a digest is not time-critical', async () => {
    const { notifier, fetchImpl } = make();
    await notifier.notifyPublished();
    assert.equal(fetchImpl.calls[0].body.priority, 5);
  });

  it('sends the localized maps, not a bare string', async () => {
    const { notifier, fetchImpl } = make();
    await notifier.notifyPublished();
    const { alert } = fetchImpl.calls[0].body;
    assert.equal(typeof alert.title, 'object');
    assert.equal(alert.body.tr, BODY_BY_LANG.tr);
    assert.ok(alert.title.tr.startsWith(TITLE_EMOJI));
  });
});

// ── Paging and failure ────────────────────────────────────────────────────────

describe('paging', () => {
  it('follows nextCursor and accumulates', async () => {
    const fetchImpl = scriptedFetch([
      { json: { matched: 5000, sent: 5000, nextCursor: 'c1' } },
      { json: { matched: 700, sent: 690, nextCursor: null } },
    ]);
    const { notifier } = make({}, { fetchImpl });
    const r = await notifier.notifyPublished();
    assert.equal(r.pages, 2);
    assert.equal(r.matched, 5700);
    assert.equal(r.sent, 5690);
    assert.equal(fetchImpl.calls[1].body.audience.after, 'c1');
  });

  it('releases the gap when page 1 fails, so the next hour can retry', async () => {
    const redis = fakeRedis();
    const { notifier } = make({}, { redis, fetchImpl: scriptedFetch([{ status: 401, json: {} }]) });
    assert.equal((await notifier.notifyPublished()).action, 'error');
    assert.equal(redis.deleted.length, 1);
  });

  it('keeps the gap when a later page fails — those devices already got it', async () => {
    const redis = fakeRedis();
    const { notifier } = make({}, {
      redis,
      fetchImpl: scriptedFetch([
        { json: { matched: 5000, sent: 5000, nextCursor: 'c1' } },
        { status: 500, json: {} },
      ]),
    });
    const r = await notifier.notifyPublished();
    assert.equal(r.action, 'error');
    assert.equal(redis.deleted.length, 0);
  });

  it('never rejects', async () => {
    const { notifier } = make({}, { fetchImpl: scriptedFetch([{ throws: new Error('boom') }]) });
    const r = await notifier.notifyPublished();
    assert.equal(r.action, 'error');
  });
});

// ── Wiring ────────────────────────────────────────────────────────────────────

describe('seed-insights.mjs wiring', () => {
  it('announces only a genuine publish', () => {
    assert.match(
      seedInsightsSrc,
      /if \(outcome === INSIGHTS_RUN_OUTCOMES\.PUBLISHED\) \{\s*\n\s*await announceBriefPublished\(data\);/,
      'a DEGRADED run must not claim the brief refreshed',
    );
  });

  it('cannot fail the seed run', () => {
    const fn = seedInsightsSrc.slice(seedInsightsSrc.indexOf('export async function announceBriefPublished'));
    assert.match(fn.slice(0, 1600), /try \{/);
    assert.match(fn.slice(0, 1600), /catch \(err\)/);
  });

  it('maps Upstash SET NX results, treating anything unexpected as error', () => {
    const fn = seedInsightsSrc.slice(seedInsightsSrc.indexOf('export async function announceBriefPublished'));
    assert.match(fn.slice(0, 1600), /res === 'OK'\) return 'new'/);
    assert.match(fn.slice(0, 1600), /res === null\) return 'duplicate'/);
    assert.match(fn.slice(0, 1600), /return 'error'/);
  });
});
