/**
 * GET /api/ios-bundle — every static reference dataset the WorldView iOS app
 * needs, in one conditional request.
 *
 * Replaces the eleven `/api/v8/*` calls plus `/api/youtube/sources` the client
 * used to make against the previous backend. The datasets are compile-time
 * constants (see server/_shared/ios-bundle.ts), so the response only changes on
 * a deploy: it carries a strong ETag and the client revalidates with
 * `If-None-Match`, making the steady-state cost a 304.
 *
 * Auth: `X-WorldMonitor-Key` must be listed in `WORLDMONITOR_VALID_KEYS`.
 * The AI World Brief deliberately does NOT live here — it is LLM output, not
 * reference data, and keeps its own endpoint.
 */

export const config = { runtime: 'edge', regions: ['iad1', 'fra1'] };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
// @ts-expect-error — JS module, no declaration file
import { validateApiKey } from './_api-key.js';
import { getIosBundleResponse } from '../server/_shared/ios-bundle';

// A deploy is the only thing that can change this payload, so the CDN may hold
// it for a day and serve stale while it revalidates.
const CACHE_CONTROL = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800';

export default async function handler(request: Request): Promise<Response> {
  const cors = getCorsHeaders(request);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...cors, 'Content-Type': 'application/json', Allow: 'GET, HEAD, OPTIONS' },
    });
  }
  if (isDisallowedOrigin(request)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const auth = await validateApiKey(request);
  if (!auth.valid) {
    return new Response(JSON.stringify({ error: auth.error ?? 'Unauthorized' }), {
      status: 401,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const { body, etag } = getIosBundleResponse();

  // Vercel can append a weak-validator prefix to a cached response's ETag, so
  // match on the entity tag itself rather than the raw header string.
  const ifNoneMatch = request.headers.get('If-None-Match') ?? '';
  const matches = ifNoneMatch
    .split(',')
    .some((candidate) => candidate.trim().replace(/^W\//, '') === etag);
  if (matches) {
    return new Response(null, {
      status: 304,
      headers: { ...cors, ETag: etag, 'Cache-Control': CACHE_CONTROL },
    });
  }

  return new Response(request.method === 'HEAD' ? null : body, {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'application/json',
      ETag: etag,
      'Cache-Control': CACHE_CONTROL,
    },
  });
}
