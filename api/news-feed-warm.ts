/**
 * Background feed warming for the news digest.
 *
 * POST /api/news-feed-warm?variant=full&lang=en
 * Authorization: Bearer $RELAY_SHARED_SECRET
 *
 * The relay calls this every couple of minutes. Each call re-fetches the
 * feeds whose parse cache is older than FEED_WARM_MAX_AGE_S and rewrites
 * the rows list-feed-digest reads, so a build finds fresh feeds instead of
 * hour-old ones. See warmFeedCache in server/worldmonitor/news/v1/list-feed-digest.ts.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { jsonResponse } from './_json-response.js';
import { timingSafeEqual } from '../server/_shared/internal-auth';
import { warmFeedCache } from '../server/worldmonitor/news/v1/list-feed-digest';

const VARIANTS = new Set(['full', 'tech', 'finance', 'happy', 'commodity']);
const LANG = /^[a-z]{2}$/;

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const secret = process.env.RELAY_SHARED_SECRET;
  const auth = req.headers.get('authorization') || '';
  if (!secret || !(await timingSafeEqual(auth, `Bearer ${secret}`))) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const url = new URL(req.url);
  const variant = url.searchParams.get('variant') || 'full';
  const lang = url.searchParams.get('lang') || 'en';
  if (!VARIANTS.has(variant) || !LANG.test(lang)) {
    return jsonResponse({ error: 'Invalid variant or lang' }, 400);
  }

  const result = await warmFeedCache(variant, lang);
  return jsonResponse(result, result.redis ? 200 : 503, { 'Cache-Control': 'no-store' });
}
