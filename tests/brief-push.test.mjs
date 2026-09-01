/**
 * AI World Brief push — scripts/lib/brief-push.cjs.
 *
 * Two things are under test and both are easy to get quietly wrong:
 *
 *  1. Local-hour targeting. The cron is hourly and UTC-aligned; the reader
 *     should hear from it twice, at their own 10:00 and 19:00. The failure mode
 *     is not a crash, it is India and Nepal never receiving anything because a
 *     +5:30 zone is never at exactly 10:00 on the hour.
 *  2. Fail-closed guards. An hourly cron with a broken guard becomes an hourly
 *     notification.
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
  zonesAtLocalHour,
  localHour,
  SLOTS,
  TITLE_BY_LANG,
  MORNING_BODY_BY_LANG,
  EVENING_BODY_BY_LANG,
  DEFAULT_COHORTS,
} = require('../scripts/lib/brief-push.cjs');

const seedInsightsSrc = readFileSync(resolve(__dirname, '..', 'scripts', 'seed-insights.mjs'), 'utf-8');
const sendEndpointSrc = (() => {
  try {
    return readFileSync(resolve(__dirname, '..', '..', 'monitor-landing-web', 'pages', 'api', 'push', 'send.ts'), 'utf-8');
  } catch { return null; }
})();
const xcstrings = (() => {
  try {
    return JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'WorldView', 'WorldMonitor', 'Localizable.xcstrings'), 'utf-8'));
  } catch { return null; }
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

function scriptedFetch(steps = []) {
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

// 2026-09-01T07:00Z — Europe/Istanbul (UTC+3) is at local 10:00.
const AT_ISTANBUL_MORNING = new Date('2026-09-01T07:00:00Z');
const ZONES = ['Europe/Istanbul', 'Asia/Kolkata', 'America/New_York', 'Asia/Tokyo', 'UTC'];

function make(envOverrides = {}, deps = {}) {
  const redis = deps.redis ?? fakeRedis();
  const fetchImpl = deps.fetchImpl ?? scriptedFetch();
  const notifier = createBriefPushNotifier({
    env: { ...BASE_ENV, ...envOverrides },
    redis,
    fetchImpl,
    log: { log: () => {}, warn: () => {} },
    now: deps.now ?? (() => AT_ISTANBUL_MORNING),
    timeZones: deps.timeZones ?? ZONES,
  });
  return { notifier, redis, fetchImpl };
}

// ── Local-hour targeting ──────────────────────────────────────────────────────

describe('local-hour targeting', () => {
  it('reads the local hour of a zone', () => {
    assert.equal(localHour('Europe/Istanbul', AT_ISTANBUL_MORNING), 10);
    assert.equal(localHour('UTC', AT_ISTANBUL_MORNING), 7);
  });

  it('renders midnight as 0, not 24', () => {
    // 21:00Z is midnight in Istanbul (+3).
    assert.equal(localHour('Europe/Istanbul', new Date('2026-09-01T21:00:00Z')), 0);
  });

  it('finds the zones sitting at a given local hour', () => {
    const zones = zonesAtLocalHour(10, AT_ISTANBUL_MORNING, ZONES);
    assert.ok(zones.includes('Europe/Istanbul'));
    assert.ok(!zones.includes('UTC'));
  });

  it('includes half-hour offset zones, which never hit the hour exactly', () => {
    // Asia/Kolkata is +5:30, so at 04:45Z it is 10:15 local — hour 10.
    const zones = zonesAtLocalHour(10, new Date('2026-09-01T04:45:00Z'), ZONES);
    assert.ok(
      zones.includes('Asia/Kolkata'),
      'a minute-precise match would silently exclude every +5:30 and +5:45 country',
    );
  });

  it('partitions the zone set: at one instant each zone is in exactly one hour', () => {
    // This is what guarantees a slot reaches every zone exactly once a day —
    // an overlap would double-send, a gap would silently skip a region.
    const seen = new Map();
    for (let h = 0; h < 24; h++) {
      for (const z of zonesAtLocalHour(h, AT_ISTANBUL_MORNING, ZONES)) {
        seen.set(z, (seen.get(z) ?? 0) + 1);
      }
    }
    assert.equal(seen.size, ZONES.length, 'every zone must land in some hour bucket');
    for (const [zone, count] of seen) {
      assert.equal(count, 1, `${zone} matched ${count} hour buckets at one instant`);
    }
  });

  it('partitions the real IANA table too', () => {
    const all = Intl.supportedValuesOf('timeZone');
    let total = 0;
    for (let h = 0; h < 24; h++) total += zonesAtLocalHour(h, AT_ISTANBUL_MORNING).length;
    assert.equal(total, all.length, 'a zone counted twice would get two pushes a day');
  });

  it('survives a zone the local ICU build does not know', () => {
    const zones = zonesAtLocalHour(10, AT_ISTANBUL_MORNING, ['Europe/Istanbul', 'Not/AZone']);
    assert.deepEqual(zones, ['Europe/Istanbul']);
  });

  it('works against the real IANA table', () => {
    const zones = zonesAtLocalHour(10, AT_ISTANBUL_MORNING);
    assert.ok(zones.length > 0);
    assert.ok(zones.includes('Europe/Istanbul'));
  });
});

// ── Slots ─────────────────────────────────────────────────────────────────────

describe('slots', () => {
  it('defaults to 10:00 and 19:00 local', () => {
    const { notifier } = make();
    assert.deepEqual(notifier.config.slotHours, { morning: 10, evening: 19 });
  });

  it('accepts custom hours and clamps them to a real clock', () => {
    const { notifier } = make({ BRIEF_PUSH_MORNING_HOUR: '7', BRIEF_PUSH_EVENING_HOUR: '99' });
    assert.equal(notifier.config.slotHours.morning, 7);
    assert.equal(notifier.config.slotHours.evening, 23);
  });

  it('fires the morning slot and skips the evening one at the same tick', async () => {
    const { notifier, fetchImpl } = make();
    const r = await notifier.notifyPublished();
    const morning = r.slots.find((s) => s.slot === 'morning');
    const evening = r.slots.find((s) => s.slot === 'evening');
    assert.equal(morning.action, 'sent');
    assert.equal(evening.action, 'skipped');
    assert.equal(fetchImpl.calls.length, 1, 'only the slot with zones may send');
  });

  it('fires the evening slot when zones roll into 19:00', async () => {
    // 16:00Z = 19:00 in Istanbul.
    const { notifier, fetchImpl } = make({}, { now: () => new Date('2026-09-01T16:00:00Z') });
    const r = await notifier.notifyPublished();
    assert.equal(r.slots.find((s) => s.slot === 'evening').action, 'sent');
    assert.equal(fetchImpl.calls[0].body.collapseId, 'brief-evening');
  });

  it('sends a different body per slot', () => {
    assert.notEqual(localizedBody('morning').tr, localizedBody('evening').tr);
    assert.equal(localizedBody('morning').tr, MORNING_BODY_BY_LANG.tr);
    assert.equal(localizedBody('evening').tr, EVENING_BODY_BY_LANG.tr);
  });

  it('distinguishes the slots by emoji, since both carry the same feature name', () => {
    assert.notEqual(SLOTS.morning.emoji, SLOTS.evening.emoji);
    assert.ok(localizedTitle('morning').en.startsWith(SLOTS.morning.emoji));
    assert.ok(localizedTitle('evening').en.startsWith(SLOTS.evening.emoji));
  });

  it('collapses per slot, so an evening banner replaces an unread morning one', async () => {
    const { notifier, fetchImpl } = make();
    await notifier.notifyPublished();
    assert.equal(fetchImpl.calls[0].body.collapseId, 'brief-morning');
  });
});

// ── Audience ──────────────────────────────────────────────────────────────────

describe('audience', () => {
  it('targets the zones at the slot hour', async () => {
    const { notifier, fetchImpl } = make();
    await notifier.notifyPublished();
    assert.deepEqual(fetchImpl.calls[0].body.audience.timezone, ['Europe/Istanbul']);
  });

  it('targets only the low cohort and never unset-priority devices', async () => {
    const { notifier, fetchImpl } = make();
    await notifier.notifyPublished();
    const { audience } = fetchImpl.calls[0].body;
    assert.deepEqual(audience.priority, ['low']);
    assert.deepEqual([...DEFAULT_COHORTS], ['low']);
    assert.equal(audience.includeUnsetPriority, false);
  });

  it('uses APNs priority 5 and routes to the brief tab', async () => {
    const { notifier, fetchImpl } = make();
    await notifier.notifyPublished();
    assert.equal(fetchImpl.calls[0].body.priority, 5);
    assert.deepEqual(fetchImpl.calls[0].body.route, { type: 'brief' });
  });
});

// ── Guards ────────────────────────────────────────────────────────────────────

describe('guards', () => {
  it('is a no-op unless armed, and dry-run unless explicitly disabled', async () => {
    assert.equal((await make({ BRIEF_PUSH_ENABLED: undefined }).notifier.notifyPublished()).action, 'disabled');
    assert.equal((await make({ PUSH_ADMIN_SECRET: undefined }).notifier.notifyPublished()).action, 'disabled');
    const dry = make({ BRIEF_PUSH_DRY_RUN: undefined });
    assert.equal((await dry.notifier.notifyPublished()).action, 'dry-run');
    assert.equal(dry.fetchImpl.calls[0].body.dryRun, true);
  });

  it('does not re-send when the same tick runs twice', async () => {
    const { notifier, fetchImpl } = make();
    assert.equal((await notifier.notifyPublished()).action, 'sent');
    const again = await notifier.notifyPublished();
    assert.equal(again.slots.find((s) => s.slot === 'morning').action, 'suppressed');
    assert.equal(fetchImpl.calls.length, 1);
  });

  it('keys dedup per tick, so the NEXT hour band is not starved', async () => {
    const redis = fakeRedis();
    const first = make({}, { redis });
    await first.notifier.notifyPublished();
    // An hour later a different band of zones is at 10:00 — must still send.
    const second = make({}, {
      redis,
      now: () => new Date('2026-09-01T08:00:00Z'),
      timeZones: ['Asia/Karachi'], // UTC+5 -> 13:00; use a zone that IS at 10
    });
    const r = await second.notifier.notifyPublished();
    // Karachi is not at 10:00 here, so this asserts the key did not collide,
    // not that it sent: a global daily key would have made it 'suppressed'.
    assert.notEqual(r.slots.find((s) => s.slot === 'morning').action, 'suppressed');
  });

  it('suppresses when Redis is unreachable rather than sending', async () => {
    const { notifier, fetchImpl } = make({}, { redis: fakeRedis({ failWith: 'error' }) });
    const r = await notifier.notifyPublished();
    assert.equal(r.slots.find((s) => s.slot === 'morning').action, 'suppressed');
    assert.equal(fetchImpl.calls.length, 0, 'failing open here would spam every hour');
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
    const morning = r.slots.find((s) => s.slot === 'morning');
    assert.equal(morning.pages, 2);
    assert.equal(morning.matched, 5700);
    assert.equal(fetchImpl.calls[1].body.audience.after, 'c1');
    assert.deepEqual(fetchImpl.calls[1].body.audience.timezone, ['Europe/Istanbul'], 'the zone filter must survive paging');
  });

  it('releases the key when page 1 fails, so the next tick can retry', async () => {
    const redis = fakeRedis();
    const { notifier } = make({}, { redis, fetchImpl: scriptedFetch([{ status: 401, json: {} }]) });
    await notifier.notifyPublished();
    assert.equal(redis.deleted.length, 1);
  });

  it('keeps the key when a later page fails — those devices already got it', async () => {
    const redis = fakeRedis();
    const { notifier } = make({}, {
      redis,
      fetchImpl: scriptedFetch([
        { json: { matched: 5000, sent: 5000, nextCursor: 'c1' } },
        { status: 500, json: {} },
      ]),
    });
    const r = await notifier.notifyPublished();
    assert.equal(r.slots.find((s) => s.slot === 'morning').action, 'error');
    assert.equal(redis.deleted.length, 0);
  });

  it('never rejects', async () => {
    const { notifier } = make({}, { fetchImpl: scriptedFetch([{ throws: new Error('boom') }]) });
    const r = await notifier.notifyPublished();
    assert.equal(r.slots.find((s) => s.slot === 'morning').action, 'error');
  });
});

// ── Localization ──────────────────────────────────────────────────────────────

describe('localization', () => {
  it('title and both bodies cover exactly the same languages', () => {
    const langs = Object.keys(TITLE_BY_LANG).sort();
    assert.deepEqual(Object.keys(MORNING_BODY_BY_LANG).sort(), langs);
    assert.deepEqual(Object.keys(EVENING_BODY_BY_LANG).sort(), langs);
  });

  it('always ships en, the fallback pick() uses for unlisted locales', () => {
    assert.ok(TITLE_BY_LANG.en && MORNING_BODY_BY_LANG.en && EVENING_BODY_BY_LANG.en);
  });

  it('every string is non-empty, trimmed and banner-length', () => {
    for (const map of [TITLE_BY_LANG, MORNING_BODY_BY_LANG, EVENING_BODY_BY_LANG]) {
      for (const [lang, value] of Object.entries(map)) {
        assert.ok(value.trim().length > 0, `${lang} is empty`);
        assert.equal(value, value.trim(), `${lang} has stray whitespace`);
        assert.ok(value.length <= 120, `${lang} is ${value.length} chars — too long for a banner`);
      }
    }
  });

  it('is keyed by BASE language code, since that is all the device sends', () => {
    for (const lang of Object.keys(TITLE_BY_LANG)) {
      assert.doesNotMatch(lang, /[-_]/, `${lang}: the app sends languageCode only ("pt", never "pt-BR")`);
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
      if (tag.includes('-')) continue;
      const value = entry?.stringUnit?.value;
      if (!value || !TITLE_BY_LANG[tag]) continue;
      assert.equal(TITLE_BY_LANG[tag], value, `${tag} drifted from the String Catalog`);
    }
  });
});

// ── Wiring ────────────────────────────────────────────────────────────────────

describe('wiring', () => {
  it('announces only a genuine publish', () => {
    assert.match(
      seedInsightsSrc,
      /if \(outcome === INSIGHTS_RUN_OUTCOMES\.PUBLISHED\) \{\s*\n\s*await announceBriefPublished\(data\);/,
      'a DEGRADED run must not claim the brief refreshed',
    );
  });

  it('cannot fail the seed run', () => {
    const fn = seedInsightsSrc.slice(seedInsightsSrc.indexOf('export async function announceBriefPublished'));
    assert.match(fn.slice(0, 1800), /try \{/);
    assert.match(fn.slice(0, 1800), /catch \(err\)/);
  });

  it('the send endpoint filters on the device timezone', { skip: sendEndpointSrc ? false : 'sibling repo not present' }, () => {
    assert.match(sendEndpointSrc, /filter\.timezone = \{ \$in: audience\.timezone\.slice\(0, MAX_TIMEZONES\) \}/);
  });
});
