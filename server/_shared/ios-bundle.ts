/**
 * One-shot reference-data bundle for the WorldView iOS client.
 *
 * The app used to call eleven `/api/v8/*` endpoints plus `/api/youtube/sources`,
 * none of which exist here. Every one of those datasets already lives in this
 * repo as an exported constant — it was just build-time-inlined into the web
 * bundle and never served. This module imports those same constants and adapts
 * them to the shapes the iOS models decode, so there is exactly one source of
 * truth per dataset and no hand-copied tables.
 *
 * Adaptation is deliberately thin: renames, coordinate-order swaps, date
 * parsing, and a handful of derivations that are honest functions of the
 * upstream record (see the `derive*` helpers). Fields the upstream tables
 * simply do not carry are omitted — the client hides those rows rather than
 * showing invented content.
 *
 * Lives in `server/` because `api/**` may import `server/` but not `src/`, and
 * `server/` may import `src/config/` (see AGENTS.md → Architecture Invariants).
 */

import {
  CRITICAL_MINERALS,
  ECONOMIC_CENTERS,
  NUCLEAR_FACILITIES,
  SPACEPORTS,
  UNDERSEA_CABLES,
} from '../../src/config/geo-map';
import { APT_GROUPS } from '../../src/config/apt-groups';
import { MILITARY_BASES } from '../../src/config/military-bases';
import {
  CONFLICT_ZONES,
  INTEL_HOTSPOTS,
  STRATEGIC_WATERWAYS,
} from '../../shared/geo-data';
import { PIPELINES } from '../../shared/pipelines-data';
import { CHOKEPOINT_THREAT_LEVELS } from '../../shared/chokepoint-threat-levels.js';
import {
  DIRECT_HLS_MAP,
  OPTIONAL_CHANNEL_REGIONS,
  OPTIONAL_LIVE_CHANNELS,
  WEBCAM_FEEDS,
} from '../../shared/live-channels-data';

/**
 * Bumped only on a breaking change to the payload shape. Additive fields do
 * not bump it — the client decodes unknown keys away.
 */
export const IOS_BUNDLE_VERSION = 1;

// ── Geometry helpers ────────────────────────────────────────────────────────

/** ~11 m precision. Halves the payload with no visible difference on a map. */
function r(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** Upstream stores GeoJSON `[lon, lat]`; the iOS polyline decoders want `[lat, lon]`. */
function toLatLonPairs(points: readonly (readonly [number, number])[]): [number, number][] {
  return points.map(([lon, lat]) => [r(lat), r(lon)]);
}

// ── Country / region derivations ────────────────────────────────────────────

/**
 * ISO-3166 alpha-2 → the country names the iOS copy already uses (e.g. `USA`,
 * not `United States`), so risk derivation and on-screen labels match the
 * app's bundled fallback data exactly.
 */
const COUNTRY_NAME: Record<string, string> = {
  AE: 'UAE', AM: 'Armenia', AR: 'Argentina', BD: 'Bangladesh', BE: 'Belgium',
  BG: 'Bulgaria', BR: 'Brazil', BY: 'Belarus', CA: 'Canada', CH: 'Switzerland',
  CN: 'China', CZ: 'Czechia', DE: 'Germany', DZ: 'Algeria', EG: 'Egypt',
  ES: 'Spain', FI: 'Finland', FR: 'France', GB: 'United Kingdom', HU: 'Hungary',
  IL: 'Israel', IN: 'India', IR: 'Iran', IT: 'Italy', JP: 'Japan',
  KP: 'North Korea', KR: 'South Korea', KZ: 'Kazakhstan', LT: 'Lithuania',
  MX: 'Mexico', NL: 'Netherlands', PK: 'Pakistan', RO: 'Romania', RU: 'Russia',
  SE: 'Sweden', SI: 'Slovenia', SK: 'Slovakia', TR: 'Turkey', TW: 'Taiwan',
  UA: 'Ukraine', US: 'USA', UZ: 'Uzbekistan', ZA: 'South Africa',
};

/** ISO-3166 alpha-2 → continent, covering every cable landing-point country. */
const CONTINENT: Record<string, string> = {};
function assignContinent(name: string, codes: string): void {
  for (const code of codes.split(' ')) CONTINENT[code] = name;
}
assignContinent('Africa',
  'AO BJ CD CG CI CM CV DJ DZ EG GA GH GM GN GQ GW KE KM LR LY MA MG MR MU MZ NA NG RE SC SD SH SL SN SO ST TG TN TZ ZA');
assignContinent('Asia',
  'BD BN CN CX ID IN JP KH KR LK MM MV MY PH PK SG TH TW VN');
assignContinent('Middle East',
  'AE BH CY IL IQ IR JO KW LB OM QA SA TR YE');
assignContinent('Europe',
  'DE DK ES FI FO FR GB GI GR IE IS IT MC MT NL NO PL PT SE');
assignContinent('North America',
  'BM BS BZ CA CR CW DO GL GT HN MX NI PA TC US');
assignContinent('South America',
  'AR BR CL CO EC GF PE UY VE');
assignContinent('Oceania',
  'AS AU FJ FM GU KI NZ PW TK TO');

/**
 * Names a cable's corridor from the continents it lands on. Upstream carries
 * no `region` field; the landing points are the honest source for one.
 */
function deriveCableRegion(countries: string[]): string {
  const parts = [...new Set(countries.map((c) => CONTINENT[c]).filter(Boolean) as string[])].sort();
  if (parts.length === 0) return 'International';
  if (parts.length === 1) return parts[0]!;

  const has = (name: string) => parts.includes(name);
  const americas = has('North America') || has('South America');
  const pacificRim = has('Asia') || has('Oceania');
  if (parts.length === 2) {
    if (has('North America') && has('South America')) return 'Americas';
    if (has('North America') && has('Europe')) return 'Trans-Atlantic';
  }
  if (americas && pacificRim) return 'Trans-Pacific';
  if (has('Asia') && has('Europe')) return 'Asia-Europe';
  return parts.join(' – ');
}

/**
 * Coarse region label for point features (economic hubs, chokepoints). Emits
 * only the five buckets the client's bundled tables already use, and the tests
 * are ordered because they overlap. Verified to reproduce the client's own
 * labels for all 41 economic centres.
 */
function deriveRegionFromCoords(lat: number, lon: number): string {
  if (lon < -25) return 'Americas';
  if (lat >= 35 && lon <= 45) return 'Europe';
  if (lon >= 25 && lon <= 65 && lat >= 12) return 'Middle East';
  if (lon > 60) return 'Asia-Pacific';
  return 'Africa';
}

// ── Dataset adapters ────────────────────────────────────────────────────────

/**
 * Mirrors the `nuclearRisk` helper in the iOS bundled copy so a facility that
 * appears in both sources gets the same badge. `test-site` is the one addition:
 * the client's table has no test sites, upstream has 17.
 */
function deriveNuclearRisk(type: string, status: string, country: string): string {
  if (status === 'contested') return 'critical';
  switch (type) {
    case 'weapons':
      return ['USA', 'Russia', 'China', 'Israel', 'North Korea', 'Pakistan', 'India'].includes(country)
        ? 'critical' : 'high';
    case 'enrichment':
      return country === 'Iran' ? 'critical' : 'high';
    case 'reprocessing':
    case 'test-site':
      return 'high';
    case 'plant':
      if (status === 'inactive' || status === 'decommissioned') return 'low';
      return country === 'Ukraine' ? 'critical' : 'medium';
    default:
      return 'medium';
  }
}

function buildNuclearSites() {
  return NUCLEAR_FACILITIES.map((f) => {
    const country = (f.operator && COUNTRY_NAME[f.operator]) || f.operator || 'Unknown';
    return {
      id: f.id,
      name: f.name,
      siteType: f.type,
      country,
      status: f.status,
      lat: r(f.lat),
      lon: r(f.lon),
      riskLevel: deriveNuclearRisk(f.type, f.status, country),
    };
  });
}

function buildUnderseaCables() {
  return UNDERSEA_CABLES.map((c) => {
    const landings = c.landingPoints ?? [];
    const countries = [...new Set(landings.map((p) => p.country))];
    const owners = c.owners ?? [];

    const sentences: string[] = [];
    if (c.major) sentences.push('Major trunk route.');
    if (owners.length) sentences.push(`Owners: ${owners.join(', ')}.`);
    if (c.rfsYear) sentences.push(`Ready for service ${c.rfsYear}.`);
    if (landings.length) {
      sentences.push(`${landings.length} landing points across ${countries.length} countries.`);
    }

    return {
      id: c.id,
      name: c.name,
      region: deriveCableRegion(countries),
      ...(c.capacityTbps != null ? { capacityTbps: c.capacityTbps } : {}),
      owners,
      landingPoints: landings.map((p) => `${p.city}, ${p.countryName}`),
      description: sentences.join(' '),
      path: toLatLonPairs(c.points),
    };
  });
}

function buildEconomicHubs() {
  return ECONOMIC_CENTERS.map((c) => {
    const hours = c.marketHours;
    return {
      id: c.id,
      name: c.name,
      hubType: c.type.replace(/-/g, '_'),
      country: c.country,
      region: deriveRegionFromCoords(c.lat, c.lon),
      lat: r(c.lat),
      lon: r(c.lon),
      description: c.description ?? '',
      ...(hours ? { metric: `${hours.open}–${hours.close} ${hours.timezone}` } : {}),
      keyIndicators: [],
    };
  });
}

function buildSpaceports() {
  return SPACEPORTS.map((s) => ({
    id: s.id,
    name: s.name,
    country: s.country,
    operatorName: s.operator,
    lat: r(s.lat),
    lon: r(s.lon),
    launchActivity: s.launches.toLowerCase(),
    notablePrograms: [],
  }));
}

function buildCriticalMinerals() {
  return CRITICAL_MINERALS.map((m) => ({
    id: m.id,
    name: m.name,
    mineral: m.mineral,
    country: m.country,
    operatorName: m.operator,
    lat: r(m.lat),
    lon: r(m.lon),
    significance: m.significance,
  }));
}

function buildAptGroups() {
  return APT_GROUPS.map((g) => ({
    id: g.id,
    name: g.name,
    aka: g.aka,
    sponsor: g.sponsor,
    // `sponsor` is "<attribution> (<unit / detail>)" throughout the table, so
    // the leading segment is the sponsoring state (or "Criminal" / "Unknown").
    country: g.sponsor.split(' (')[0]!.trim(),
    lat: r(g.lat),
    lon: r(g.lon),
    description: g.description ?? '',
    capabilities: g.tactics ?? [],
    primaryTargets: g.targetSectors ?? [],
    recentOperations: [],
  }));
}

/** Upstream `type` is the operating power; the client shows it as "NATION". */
const BASE_NATION: Record<string, string> = {
  'us-nato': 'USA / NATO', china: 'China', russia: 'Russia', uk: 'United Kingdom',
  france: 'France', india: 'India', italy: 'Italy', uae: 'UAE', turkey: 'Turkey',
  japan: 'Japan', other: 'Other',
};

/** Upstream records the service branch as free text in `arm`. */
function deriveBaseType(text: string): string {
  if (/nav(y|al)|fleet|submarine|maritime/i.test(text)) return 'naval';
  if (/air ?force|airbase|air base|\bafb\b|aviation/i.test(text)) return 'air_force';
  if (/space/i.test(text)) return 'space';
  if (/radar|intelligence|listening|signals|surveillance/i.test(text)) return 'intelligence';
  if (/army|combined arms|ground|infantry|marine/i.test(text)) return 'army';
  return 'strategic';
}

function buildMilitaryBases() {
  return MILITARY_BASES.map((b) => ({
    id: b.id,
    name: b.name,
    lat: r(b.lat),
    lon: r(b.lon),
    baseType: deriveBaseType(`${b.arm ?? ''} ${b.name}`),
    nation: BASE_NATION[b.type] ?? b.type,
    description: b.description ?? '',
  }));
}

function buildPipelines() {
  return PIPELINES.map((p) => ({
    id: p.id,
    name: p.name,
    type: p.type,
    status: p.status,
    points: p.points.map(([lon, lat]) => [r(lon), r(lat)]),
    capacity: p.capacity ?? '',
    length: p.length ?? '',
    operatorName: p.operator ?? '',
    countries: p.countries ?? [],
  }));
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** `"Feb 24, 2022"` → `"2022-02-24"`. The client appends `T00:00:00Z`. */
function toIsoDate(input: string | undefined): string {
  if (!input) return '1970-01-01';
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  const m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})$/.exec(input.trim());
  if (!m) return '1970-01-01';
  const month = MONTHS[m[1]!.toLowerCase()];
  if (!month) return '1970-01-01';
  return `${m[3]}-${month}-${m[2]!.padStart(2, '0')}`;
}

function buildConflictZones() {
  return CONFLICT_ZONES.map((z) => ({
    id: z.id,
    name: z.name,
    intensity: z.intensity ?? 'medium',
    centerLat: r(z.center[1]),
    centerLon: r(z.center[0]),
    parties: z.parties ?? [],
    ...(z.casualties ? { casualties: z.casualties } : {}),
    ...(z.displaced ? { displaced: z.displaced } : {}),
    description: z.description ?? '',
    startDateISO: toIsoDate(z.startDate),
    ...(z.location ? { location: z.location } : {}),
    keyDevelopments: z.keyDevelopments ?? [],
    polygon: toLatLonPairs(z.coords),
  }));
}

function buildIntelHotspots() {
  return INTEL_HOTSPOTS.map((h) => {
    const history = h.history;
    // The client's `HotspotHistory` requires all four fields, so a partial
    // upstream record is dropped rather than padded with empty strings.
    const fullHistory = history
      && history.lastMajorEvent && history.lastMajorEventDate
      && history.precedentDescription && history.cyclicalRisk
      ? {
        lastMajorEvent: history.lastMajorEvent,
        lastMajorEventDate: history.lastMajorEventDate,
        precedentDescription: history.precedentDescription,
        cyclicalRisk: history.cyclicalRisk,
      }
      : undefined;

    return {
      id: h.id,
      name: h.name,
      subtext: h.subtext ?? '',
      lat: r(h.lat),
      lon: r(h.lon),
      ...(h.description ? { description: h.description } : {}),
      agencies: h.agencies ?? [],
      ...(h.escalationScore ? { escalationScore: h.escalationScore } : {}),
      ...(h.escalationTrend ? { escalationTrend: h.escalationTrend } : {}),
      escalationIndicators: h.escalationIndicators ?? [],
      ...(fullHistory ? { history: fullHistory } : {}),
      ...(h.whyItMatters ? { whyItMatters: h.whyItMatters } : {}),
    };
  });
}

const THREAT_LABEL: Record<string, string> = {
  elevated: 'Elevated risk',
  high: 'High risk — Lloyd’s JWC Listed Area',
  critical: 'Critical — active attacks on shipping',
  war_zone: 'War zone — active conflict',
};

function buildStrategicWaterways() {
  const levels = CHOKEPOINT_THREAT_LEVELS as Record<string, string>;
  return STRATEGIC_WATERWAYS.map((w) => {
    const level = levels[w.chokepointId];
    const threat = level && level !== 'normal' ? THREAT_LABEL[level] : undefined;
    return {
      id: w.id,
      name: w.name,
      region: deriveRegionFromCoords(w.lat, w.lon),
      lat: r(w.lat),
      lon: r(w.lon),
      description: w.description ?? '',
      activeThreats: threat ? [threat] : [],
    };
  });
}

function buildYoutubeSources() {
  const regionOf = new Map<string, string>();
  for (const group of OPTIONAL_CHANNEL_REGIONS) {
    for (const id of group.channelIds) regionOf.set(id, group.key);
  }

  return {
    newsChannels: OPTIONAL_LIVE_CHANNELS.map((c) => {
      const hls = c.hlsUrl ?? DIRECT_HLS_MAP[c.id];
      return {
        id: c.id,
        name: c.name,
        ...(regionOf.has(c.id) ? { region: regionOf.get(c.id) } : {}),
        ...(c.fallbackVideoId ? { videoId: c.fallbackVideoId } : {}),
        ...(hls ? { hlsUrl: hls } : {}),
      };
    }),
    webcamFeeds: WEBCAM_FEEDS.map((f) => ({
      id: f.id,
      city: f.city,
      country: f.country,
      region: f.region,
      videoId: f.fallbackVideoId,
    })),
  };
}

// ── Payload ─────────────────────────────────────────────────────────────────

/**
 * Every dataset is a compile-time constant, so the payload and its ETag are
 * built once per isolate rather than per request.
 */
function buildBundle() {
  return {
    version: IOS_BUNDLE_VERSION,
    nuclearSites: buildNuclearSites(),
    underseaCables: buildUnderseaCables(),
    economicHubs: buildEconomicHubs(),
    spaceports: buildSpaceports(),
    criticalMinerals: buildCriticalMinerals(),
    aptGroups: buildAptGroups(),
    militaryBases: buildMilitaryBases(),
    pipelines: buildPipelines(),
    conflictZones: buildConflictZones(),
    intelHotspots: buildIntelHotspots(),
    strategicWaterways: buildStrategicWaterways(),
    youtube: buildYoutubeSources(),
  };
}

export type IosBundle = ReturnType<typeof buildBundle>;

/** FNV-1a. Enough to detect a redeploy that changed the tables; not a digest. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

let cached: { body: string; etag: string } | null = null;

/** Serialized bundle plus its strong ETag, memoized for the isolate's lifetime. */
export function getIosBundleResponse(): { body: string; etag: string } {
  if (!cached) {
    const body = JSON.stringify(buildBundle());
    cached = { body, etag: `"ios-${IOS_BUNDLE_VERSION}-${fnv1a(body)}"` };
  }
  return cached;
}
