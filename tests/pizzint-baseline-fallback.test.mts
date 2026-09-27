// Fork-only: get-pizzint-status answers a no-store DEFCON-5 baseline (no
// locations) whenever there is no real reading, and passes real ones through.
import assert from 'node:assert/strict';
import { test } from 'node:test';
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 't';
const { getPizzintStatus } = await import('../server/worldmonitor/intelligence/v1/get-pizzint-status.ts');
const { drainResponseHeaders } = await import('../server/_shared/response-headers.ts');
let stored: unknown = null; let fail = false;
globalThis.fetch = (async () => {
  if (fail) throw new Error('boom');
  return new Response(JSON.stringify({ result: stored == null ? null : JSON.stringify(stored) }), { status: 200 });
}) as typeof fetch;
const real = { pizzint: { defconLevel: 3, defconLabel: 'Elevated Activity', aggregateActivity: 55, activeSpikes: 1, locationsMonitored: 1, locationsOpen: 1, updatedAt: 1, dataFreshness: 'DATA_FRESHNESS_FRESH', locations: [{ placeId: 'x' }] }, tensionPairs: [{ id: 'usa_russia' }] };
async function call(includeGdelt = false) {
  const request = new Request('https://api.test/api/intelligence/v1/get-pizzint-status');
  const body = await getPizzintStatus({ request } as never, { includeGdelt } as never);
  return { body, headers: drainResponseHeaders(request) };
}
test('real reading passes through, cacheable', async () => {
  stored = real;
  const a = await call(); assert.deepEqual(a.body, { pizzint: real.pizzint, tensionPairs: [] }); assert.equal(a.headers, undefined);
  const b = await call(true); assert.deepEqual(b.body, real);
});
for (const [name, value] of [['missing key', null], ['empty locations', { pizzint: { ...real.pizzint, locations: [] }, tensionPairs: [] }], ['no pizzint', { tensionPairs: [] }]] as const) {
  test(`${name} → DEFCON-5 baseline, no-store`, async () => {
    stored = value;
    const { body, headers } = await call(true);
    assert.equal(body.pizzint.defconLevel, 5); assert.equal(body.pizzint.defconLabel, 'Normal Activity');
    assert.deepEqual(body.pizzint.locations, []); assert.deepEqual(body.tensionPairs, []);
    assert.equal(headers?.['X-No-Cache'], '1');
  });
}
test('redis error → baseline, no-store', async () => {
  fail = true;
  const { body, headers } = await call();
  fail = false;
  assert.equal(body.pizzint.defconLevel, 5); assert.equal(headers?.['X-No-Cache'], '1');
});
