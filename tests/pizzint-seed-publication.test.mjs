import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { __testing__ as health } from '../api/health.js';

const relay = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
const envelopeWriter = relay.slice(relay.indexOf('function buildEnvelope('), relay.indexOf('// Envelope-aware read.'));
const producer = relay.slice(relay.indexOf('const PIZZINT_SEED_INTERVAL_MS'), relay.indexOf('function startPizzintSeedLoop()'));
const emptyResponse = {
  success: true, data: [], events: [], overall_index: 0, defcon_level: 5,
  active_spikes: 0, has_active_spikes: false, timestamp: '2026-09-25T12:09:33.653Z',
  method: 'serverless', data_freshness: 'old',
};
const validResponse = { success: true, data: [{
  place_id: 'test-location', name: 'Test location', current_popularity: 75,
  percentage_of_usual: 150, data_freshness: 'fresh', recorded_at: '2026-09-25T11:39:00Z',
}] };

// Unmatched by design: pentagonpizzaalert.com fallback parsing must throw on
// this, so tests that never configure `state.ppa` keep the pre-fallback
// "preserving last good observation" behavior.
const PPA_NO_MATCH_HTML = '<html><body>maintenance</body></html>';
const PPA_FIXTURE_HTML = '<html><body>'
  + '<h2 class="text-[200px]">ELEVATED</h2>'
  + '<div class="eyebrow">Composite</div><div class="fig text-[216px]">63</div>'
  + '<a aria-label="District Pizza Palace, 82 percent, VERY BUSY" href="/locations/district-pizza-palace">x</a>'
  + '<a aria-label="Domino&#x27;s Pizza, 4 percent, QUIET" href="/locations/dominos-pizza">x</a>'
  + '</body></html>';

function harness() {
  const state = {
    source: validResponse, writes: [], warnings: [], cache: new Map(), now: 1_790_335_140_000, failPayload: false,
    urls: [], gdelt: { ok: true, status: 200, json: async () => ({}) },
    ppa: { ok: true, status: 200, text: async () => PPA_NO_MATCH_HTML },
  };
  class Clock extends Date { static now() { return state.now; } }
  const context = vm.createContext({
    Date: Clock, AbortSignal, CHROME_UA: 'test', console: { log() {}, warn: (...args) => state.warnings.push(args) },
    fetch: async (url) => {
      state.urls.push(url);
      if (url.includes('dashboard-data')) return { ok: true, json: async () => state.source };
      if (url.includes('pentagonpizzaalert.com')) return state.ppa;
      return state.gdelt;
    },
    upstashSet: async (key, data, ttl) => {
      if (key === payloadKey && state.failPayload) return false;
      state.writes.push(key);
      state.cache.set(key, { data: structuredClone(data), expiresAt: state.now + ttl * 1000 });
      return true;
    },
  });
  vm.runInContext(envelopeWriter + producer, context);
  return { state, seed: () => vm.runInContext('seedPizzint()', context) };
}

const payloadKey = 'intelligence:pizzint:seed:v1';
const metaKey = 'seed-meta:intelligence:pizzint';

for (const [reason, response] of [
  ['unsuccessful_response', { success: false, data: [] }],
  ['non_array_data', { success: true, data: { token: 'synthetic-secret' } }],
  ['empty_array', { success: true, data: [] }],
]) {
  test(`classifies ${reason} without logging response content or changing publication`, async () => {
    const { state, seed } = harness();
    await seed();
    const previous = structuredClone(state.cache);
    state.now += 600_000;
    state.source = {
      ...response,
      message: 'https://example.invalid/?token=synthetic-secret',
      token: 'synthetic-secret',
      reason: 'synthetic-secret\nforged log entry',
    };
    await seed();
    assert.deepEqual(state.warnings, [[
      `[PizzINT] No data in API response (${reason}); preserving last good observation`,
    ]], 'only the fixed category is logged; no payload fields or extra arguments');
    assert.deepEqual(state.cache, previous);
    assert.equal(state.writes.length, 2);
  });
}

test('empty upstream response preserves the last observation and its original expiry', async () => {
  const { state, seed } = harness();
  await seed();
  assert.equal(state.cache.get(payloadKey).data.data.pizzint.defconLevel, 2);
  const previous = structuredClone(state.cache);
  state.now += 600_000;
  state.source = emptyResponse;
  await seed();
  assert.deepEqual(state.cache, previous);
  assert.equal(state.writes.length, 2);
});

test('first-run emptiness publishes no normal activity and a later valid response recovers', async () => {
  const { state, seed } = harness();
  state.source = emptyResponse;
  await seed();
  assert.equal(state.cache.size, 0);
  state.source = validResponse;
  await seed();
  assert.equal(state.cache.get(payloadKey).data.data.pizzint.locationsMonitored, 1);
  assert.equal(state.cache.get(metaKey).data.recordCount, 1);
});

test('failed payload publication does not advance success metadata', async () => {
  const { state, seed } = harness();
  await seed();
  const previous = structuredClone(state.cache);
  state.now += 600_000;
  state.failPayload = true;
  await seed();
  assert.deepEqual(state.cache, previous);
  assert.equal(state.writes.length, 2);
});

test('a sustained empty source still expires the payload and fails the real health classifier', async () => {
  const { state, seed } = harness();
  await seed();
  const classify = () => health.classifyKey('pizzint', payloadKey, { allowOnDemand: false }, {
    keyStrens: new Map([[payloadKey, state.now < state.cache.get(payloadKey).expiresAt ? 100 : 0]]),
    keyErrors: new Map(), keyMetaErrors: new Map(),
    keyMetaValues: new Map([[metaKey, JSON.stringify(state.cache.get(metaKey).data)]]),
    now: state.now,
  });
  assert.equal(classify().status, 'OK');
  state.source = emptyResponse;
  state.now += 31 * 60_000;
  await seed();
  const expired = classify();
  assert.notEqual(expired.status, 'OK');
  assert.equal(expired.seedAgeMin, 31);
  assert.ok(['warn', 'crit'].includes(health.STATUS_COUNTS[expired.status]));
});

// The GDELT batch endpoint rejects a request without a window (400 "Missing
// required query parameters: pairs, method, dateStart, dateEnd") and validates
// "Invalid date format. Expected YYYYMMDD." — observed live 2026-09-26.
test('requests GDELT tensions with the YYYYMMDD window the endpoint requires', async () => {
  const { state, seed } = harness();
  state.gdelt = { ok: true, status: 200, json: async () => ({
    usa_iran: [{ t: '20260924', v: 2 }, { t: '20260925', v: 3 }],
  }) };
  await seed();
  const gdeltUrl = new URL(state.urls.find((url) => url.includes('gdelt/batch')));
  assert.equal(gdeltUrl.searchParams.get('method'), 'gpr');
  assert.equal(gdeltUrl.searchParams.get('dateEnd'), '20260925');
  assert.equal(gdeltUrl.searchParams.get('dateStart'), '20260826');
  const payload = JSON.stringify(state.cache.get(payloadKey).data);
  assert.match(payload, /"id":"usa_iran"/);
  assert.match(payload, /"changePercent":50/);
});

test('reports a rejected GDELT request by status without logging its body', async () => {
  const { state, seed } = harness();
  state.gdelt = { ok: false, status: 400, json: async () => ({ error: 'synthetic-secret' }) };
  await seed();
  assert.deepEqual(state.warnings, [['[PizzINT] GDELT tensions request rejected (HTTP 400)']]);
  assert.ok(state.writes.includes(payloadKey), 'a GDELT failure never blocks the PizzINT publication');
});

test('falls back to pentagonpizzaalert.com when pizzint.watch has no data, and publishes it', async () => {
  const { state, seed } = harness();
  state.source = emptyResponse;
  state.ppa = { ok: true, status: 200, text: async () => PPA_FIXTURE_HTML };
  await seed();
  const pizzint = state.cache.get(payloadKey).data.data.pizzint;
  assert.equal(pizzint.defconLevel, 3, 'ELEVATED maps to DEFCON 3');
  assert.equal(pizzint.defconLabel, 'Elevated Activity');
  assert.equal(pizzint.aggregateActivity, 63);
  assert.equal(pizzint.locationsMonitored, 2);
  assert.equal(pizzint.activeSpikes, 1, 'only the VERY BUSY venue counts as a spike');
  assert.deepEqual(
    pizzint.locations.map((l) => [l.name, l.currentPopularity, l.dataSource]),
    [
      ['District Pizza Palace', 82, 'pentagonpizzaalert.com'],
      ["Domino's Pizza", 4, 'pentagonpizzaalert.com'],
    ],
    'entity-decoded name and static address/lat/lng carried through',
  );
  assert.equal(pizzint.locations[0].address, '2325 S Eads St, Arlington, VA');
  assert.equal(pizzint.locations[0].lat, 38.8527414);
  // Distinct, non-empty placeIds — the iOS client keys Identifiable/ForEach
  // identity on placeId (PizzIntLocation.id); an empty string for every
  // venue collapsed all rows into one SwiftUI identity (regression, 2026-09-29).
  const placeIds = pizzint.locations.map((l) => l.placeId);
  assert.ok(placeIds.every((id) => id.length > 0), 'every venue has a non-empty placeId');
  assert.equal(new Set(placeIds).size, placeIds.length, 'placeIds are unique per venue');
  assert.ok(state.writes.includes(payloadKey), 'the fallback reading is actually published');
});

test('a pentagonpizzaalert.com fallback failure still preserves the last good observation', async () => {
  const { state, seed } = harness();
  await seed(); // seeds a valid pizzint.watch reading first
  const previous = structuredClone(state.cache);
  state.now += 600_000;
  state.source = emptyResponse;
  state.ppa = { ok: false, status: 503, text: async () => '' };
  await seed();
  assert.deepEqual(state.cache, previous);
  assert.deepEqual(state.warnings, [[
    '[PizzINT] No data in API response (empty_array); preserving last good observation',
  ]]);
});
