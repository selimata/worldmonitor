#!/usr/bin/env node
// PizzINT seed — Pentagon Pizza Index + GDELT tension pairs.
//
// The seed loop for this key lives in scripts/ais-relay.cjs (seedPizzint), which
// only runs inside the always-on relay process. This script is the same fetch and
// projection driven by runSeed instead, so the key can be published by a plain
// cron on deployments that do not run the relay. Both writers target the SAME
// canonical key and produce the same `{pizzint, tensionPairs}` payload shape —
// keep them in step if either side changes.
//
// pizzint.watch blocks datacenter ranges from Vercel Edge, which is why the
// fetch happens out here and the handler
// (server/worldmonitor/intelligence/v1/get-pizzint-status.ts) only ever reads
// the seeded key.
//
// Cadence: api/health.js pins pizzint at maxStaleMin 30 (3x the relay's 10-min
// loop), so this must run on `*/10 * * * *` to stay inside the same contract.
// CACHE_TTL matches the relay's PIZZINT_SEED_TTL.

import { CHROME_UA, loadEnvFile, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'intelligence:pizzint:seed:v1';
const CACHE_TTL = 1800; // 30 min — mirrors PIZZINT_SEED_TTL in ais-relay.cjs
const PIZZINT_API = 'https://www.pizzint.watch/api/dashboard-data';
const GDELT_BATCH_API = 'https://www.pizzint.watch/api/gdelt/batch';
const DEFAULT_GDELT_PAIRS = 'usa_russia,russia_ukraine,usa_china,china_taiwan,usa_iran,usa_venezuela';

function projectLocations(rows) {
  return rows.map((d) => ({
    placeId: d.place_id || '',
    name: d.name || '',
    address: d.address || '',
    currentPopularity: typeof d.current_popularity === 'number' ? d.current_popularity : 0,
    percentageOfUsual: typeof d.percentage_of_usual === 'number' ? d.percentage_of_usual : 0,
    isSpike: !!d.is_spike,
    spikeMagnitude: typeof d.spike_magnitude === 'number' ? d.spike_magnitude : 0,
    dataSource: d.data_source || '',
    recordedAt: d.recorded_at || '',
    dataFreshness: d.data_freshness === 'fresh' ? 'DATA_FRESHNESS_FRESH' : 'DATA_FRESHNESS_STALE',
    isClosedNow: !!d.is_closed_now,
    lat: d.lat ?? 0,
    lng: d.lng ?? 0,
  }));
}

// Activity is averaged over OPEN locations only — a closed store reports 0
// popularity and would otherwise drag the index down overnight. Spikes add a
// flat bonus per spiking location before the DEFCON banding.
function deriveDefcon(locations, openLocations, activeSpikes) {
  const avgPop = openLocations.length > 0
    ? openLocations.reduce((s, l) => s + l.currentPopularity, 0) / openLocations.length
    : 0;

  let adjusted = avgPop;
  if (activeSpikes > 0) adjusted += activeSpikes * 10;
  adjusted = Math.min(100, adjusted);

  let defconLevel = 5;
  let defconLabel = 'Normal Activity';
  if (adjusted >= 85) { defconLevel = 1; defconLabel = 'Maximum Activity'; }
  else if (adjusted >= 70) { defconLevel = 2; defconLabel = 'High Activity'; }
  else if (adjusted >= 50) { defconLevel = 3; defconLabel = 'Elevated Activity'; }
  else if (adjusted >= 25) { defconLevel = 4; defconLabel = 'Above Normal'; }

  return { defconLevel, defconLabel, aggregateActivity: Math.round(avgPop) };
}

// Non-fatal by contract: the handler serves tensionPairs only when the caller
// asks for GDELT, so a pizzint payload without them is still publishable. An
// upstream GDELT outage must not fail the whole seed.
async function fetchTensionPairs() {
  try {
    const url = `${GDELT_BATCH_API}?pairs=${encodeURIComponent(DEFAULT_GDELT_PAIRS)}&method=gpr`;
    const resp = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return [];
    const raw = await resp.json();
    return Object.entries(raw).map(([pairKey, dataPoints]) => {
      const countries = pairKey.split('_');
      const latest = dataPoints[dataPoints.length - 1];
      const prev = dataPoints.length > 1 ? dataPoints[dataPoints.length - 2] : latest;
      const change = prev && prev.v > 0 ? ((latest.v - prev.v) / prev.v) * 100 : 0;
      const trend = change > 5
        ? 'TREND_DIRECTION_RISING'
        : change < -5 ? 'TREND_DIRECTION_FALLING' : 'TREND_DIRECTION_STABLE';
      return {
        id: pairKey,
        countries,
        label: countries.map((c) => c.toUpperCase()).join(' - '),
        score: latest?.v ?? 0,
        trend,
        changePercent: Math.round(change * 10) / 10,
        region: 'global',
      };
    });
  } catch {
    return [];
  }
}

async function fetchPizzint() {
  const resp = await fetch(PIZZINT_API, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`pizzint.watch HTTP ${resp.status}`);

  const raw = await resp.json();
  if (!raw.success || !Array.isArray(raw.data)) {
    throw new Error('pizzint.watch returned no data array');
  }

  const locations = projectLocations(raw.data);
  const openLocations = locations.filter((l) => !l.isClosedNow);
  const activeSpikes = locations.filter((l) => l.isSpike).length;
  const { defconLevel, defconLabel, aggregateActivity } = deriveDefcon(
    locations, openLocations, activeSpikes,
  );

  return {
    pizzint: {
      defconLevel,
      defconLabel,
      aggregateActivity,
      activeSpikes,
      locationsMonitored: locations.length,
      locationsOpen: openLocations.length,
      updatedAt: Date.now(),
      dataFreshness: locations.some((l) => l.dataFreshness === 'DATA_FRESHNESS_FRESH')
        ? 'DATA_FRESHNESS_FRESH'
        : 'DATA_FRESHNESS_STALE',
      locations,
    },
    tensionPairs: await fetchTensionPairs(),
  };
}

runSeed('intelligence', 'pizzint', CANONICAL_KEY, fetchPizzint, {
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'pizzint',
  schemaVersion: 1,
  declareRecords: (data) => data?.pizzint?.locations?.length ?? 0,
  maxStaleMin: 30,
}).catch((err) => {
  const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + cause);
  process.exit(1);
});
