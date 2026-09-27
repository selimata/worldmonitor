import type {
  ServerContext,
  GetPizzintStatusRequest,
  GetPizzintStatusResponse,
  PizzintStatus,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';

const SEED_KEY = 'intelligence:pizzint:seed:v1';

// Fork-only: when there is no reading (pizzint.watch down, key expired, Redis
// unreachable) answer the DEFCON-5 baseline instead of dropping `pizzint`, so
// the iOS screen shows its gauge rather than "Could not load". No locations are
// invented — the list stays empty. Marked no-store so a real reading shows up
// on the very next request once the relay publishes one; /api/health reads the
// seed key directly and still reports the outage.
function baselineResponse(ctx: ServerContext): GetPizzintStatusResponse {
  const pizzint: PizzintStatus = {
    defconLevel: 5,
    defconLabel: 'Normal Activity',
    aggregateActivity: 0,
    activeSpikes: 0,
    locationsMonitored: 0,
    locationsOpen: 0,
    updatedAt: Date.now(),
    dataFreshness: 'DATA_FRESHNESS_STALE',
    locations: [],
  };
  return markNoStoreFallbackResponse(ctx.request, { pizzint, tensionPairs: [] });
}

export async function getPizzintStatus(
  ctx: ServerContext,
  req: GetPizzintStatusRequest,
): Promise<GetPizzintStatusResponse> {
  try {
    const result = await getCachedJson(SEED_KEY, true) as GetPizzintStatusResponse | null;
    if (!result?.pizzint?.locations?.length) return baselineResponse(ctx);
    return req.includeGdelt ? result : { pizzint: result.pizzint, tensionPairs: [] };
  } catch {
    return baselineResponse(ctx);
  }
}
