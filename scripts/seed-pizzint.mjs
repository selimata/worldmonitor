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
// gdelt/batch rejects requests without dateStart/dateEnd (YYYYMMDD). Same
// 30-day window as the relay's GDELT_WINDOW_MS.
const GDELT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function gdeltYmd(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

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

const DEFCON_LABELS = { 1: 'Maximum Activity', 2: 'High Activity', 3: 'Elevated Activity', 4: 'Above Normal', 5: 'Normal Activity' };
function defconBand(score) {
  const defconLevel = score >= 85 ? 1 : score >= 70 ? 2 : score >= 50 ? 3 : score >= 25 ? 4 : 5;
  return { defconLevel, defconLabel: DEFCON_LABELS[defconLevel] };
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

  const { defconLevel, defconLabel } = defconBand(adjusted);
  return { defconLevel, defconLabel, aggregateActivity: Math.round(avgPop) };
}

// Non-fatal by contract: the handler serves tensionPairs only when the caller
// asks for GDELT, so a pizzint payload without them is still publishable. An
// upstream GDELT outage must not fail the whole seed.
async function fetchTensionPairs() {
  try {
    const now = new Date();
    const url = `${GDELT_BATCH_API}?pairs=${encodeURIComponent(DEFAULT_GDELT_PAIRS)}&method=gpr`
      + `&dateStart=${gdeltYmd(new Date(now.getTime() - GDELT_WINDOW_MS))}&dateEnd=${gdeltYmd(now)}`;
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

// ─────────────────────────────────────────────────────────────
// PizzINT fallback — pentagonpizzaalert.com
// Free, public, no login/API key. Used only when pizzint.watch has no usable
// reading (down, Supabase outage, or an empty data array — observed
// 2026-09-29). Its homepage is server-rendered with the data as plain HTML
// and its robots.txt allows all bots, ClaudeBot included. One GET per run.
//
// Per-venue address/lat/lng are a static table, crawled once on 2026-09-29
// from each venue's own page (schema.org GeoCoordinates) — the 11 Pentagon-
// area venues don't move; re-crawl only if pentagonpizzaalert.com adds,
// removes, or renames one. Keep this table in step with the copy in
// scripts/ais-relay.cjs (seedPizzint).
// ─────────────────────────────────────────────────────────────
const PENTAGON_PIZZA_ALERT_URL = 'https://pentagonpizzaalert.com/';
const PENTAGON_PIZZA_ALERT_VENUES = {
  'district-pizza-palace': { address: '2325 S Eads St, Arlington, VA', lat: 38.8527414, lng: -77.0531408 },
  'pizza-hut': { address: '1049 W Glebe Rd, Arlington, VA', lat: 38.8430983, lng: -77.0762855 },
  'pizzato-pizza': { address: '2626 N Pershing Dr, Arlington, VA', lat: 38.8806865, lng: -77.089827 },
  'crystal-city-sports-pub': { address: '529 23rd St S, Arlington, VA', lat: 38.8535379, lng: -77.0543326 },
  'nighthawk-brewery-pizza': { address: '4225 S 28th St, Arlington, VA', lat: 38.8631637, lng: -77.0624806 },
  'extreme-pizza': { address: '1419 S Fern St, Arlington, VA', lat: 38.8602396, lng: -77.0559854 },
  'papa-johns': { address: '2440 Wilson Blvd, Arlington, VA 22201', lat: 38.8903112, lng: -77.0883773 },
  'freddies-beach-bar': { address: '555 23rd St S, Arlington, VA', lat: 38.8535485, lng: -77.0549009 },
  'wiseguy-pizza': { address: '710 12th St S, Arlington, VA 22202', lat: 38.862657, lng: -77.0588418 },
  'we-the-pizza': { address: '2100 Crystal Dr, Arlington, VA', lat: 38.8551791, lng: -77.049733 },
  'dominos-pizza': { address: '3535 S Ball St, Arlington, VA', lat: 38.8430908, lng: -77.0507832 },
};
const PPA_LEVEL_TO_DEFCON = { CRITICAL: 1, HIGH: 2, ELEVATED: 3, GUARDED: 4, NORMAL: 5 };
const PPA_LEVEL_RE = /<h2[^>]*>(CRITICAL|HIGH|ELEVATED|GUARDED|NORMAL)<\/h2>/;
const PPA_COMPOSITE_RE = /Composite<\/div><div class="fig[^"]*"[^>]*>(\d+)<\/div>/;
const PPA_VENUE_RE = /aria-label="([^"]+), (\d+) percent, ([A-Z ]+)"[^>]*href="\/locations\/([a-z0-9-]+)"/g;

function decodePpaEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

async function fetchPentagonPizzaAlert() {
  const resp = await fetch(PENTAGON_PIZZA_ALERT_URL, {
    headers: { Accept: 'text/html', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`pentagonpizzaalert.com HTTP ${resp.status}`);
  const html = await resp.text();

  const levelMatch = html.match(PPA_LEVEL_RE);
  const compositeMatch = html.match(PPA_COMPOSITE_RE);
  const venueMatches = [...html.matchAll(PPA_VENUE_RE)];
  if (!levelMatch || !compositeMatch || venueMatches.length === 0) {
    throw new Error('pentagonpizzaalert.com markup did not match (possible site redesign)');
  }

  const recordedAt = new Date().toISOString();
  const locations = venueMatches.map(([, rawName, percentStr, rawState, slug]) => {
    const meta = PENTAGON_PIZZA_ALERT_VENUES[slug] || {};
    const state = rawState.trim();
    return {
      // No Google Place ID from this source, but placeId is what the iOS
      // client keys Identifiable/ForEach identity on (PizzIntLocation.id) —
      // an empty string for every venue collapses all 11 rows into one
      // SwiftUI identity and the list renders the same row repeatedly
      // (observed 2026-09-29). The slug is stable and unique per venue.
      placeId: `ppa:${slug}`,
      name: decodePpaEntities(rawName),
      address: meta.address || '',
      currentPopularity: Number(percentStr),
      percentageOfUsual: 0, // not published on the homepage
      isSpike: state === 'VERY BUSY', // pentagonpizzaalert.com's own threshold
      spikeMagnitude: 0, // not published on the homepage
      dataSource: 'pentagonpizzaalert.com',
      recordedAt,
      dataFreshness: 'DATA_FRESHNESS_FRESH',
      isClosedNow: state === 'CLOSED',
      lat: meta.lat ?? 0,
      lng: meta.lng ?? 0,
    };
  });

  const defconLevel = PPA_LEVEL_TO_DEFCON[levelMatch[1]] || 5;
  return {
    pizzint: {
      defconLevel,
      defconLabel: DEFCON_LABELS[defconLevel] || 'Normal Activity',
      aggregateActivity: Number(compositeMatch[1]),
      activeSpikes: locations.filter((l) => l.isSpike).length,
      locationsMonitored: locations.length,
      locationsOpen: locations.filter((l) => !l.isClosedNow).length,
      updatedAt: Date.now(),
      dataFreshness: 'DATA_FRESHNESS_FRESH',
      locations,
    },
    tensionPairs: await fetchTensionPairs(),
  };
}

async function fetchPizzint() {
  let raw = null;
  try {
    const resp = await fetch(PIZZINT_API, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (resp.ok) {
      const body = await resp.json();
      if (body.success && Array.isArray(body.data) && body.data.length > 0) raw = body;
    }
  } catch { /* fall through to the fallback below */ }

  if (!raw) {
    // pizzint.watch is down, erroring, or answering an empty data array
    // (observed 2026-09-29) — try the free pentagonpizzaalert.com fallback
    // before giving up.
    return fetchPentagonPizzaAlert();
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
