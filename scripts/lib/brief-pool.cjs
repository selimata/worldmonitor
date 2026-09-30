'use strict';

/**
 * Every headline the `full` digest has shown, kept for the daily brief.
 *
 * The digest is a snapshot capped at 20 items per category, so in a busy
 * category (us, europe) a story falls out of it within 7-10 hours. The daily
 * brief covers a 12-hour window and must see everything that came in, so the
 * relay records each digest it fetches (every 15 min, the classify loop) into
 * one Redis hash per UTC day of publication: field = link, value = the item.
 * HSET overwrites, so a story keeps its latest corroboration and threat.
 *
 * The brief reads the last two days' hashes (HGETALL) and filters by time.
 */

const BRIEF_POOL_PREFIX = 'news:brief-pool:v1:';
const BRIEF_POOL_TTL_SECONDS = 3 * 24 * 60 * 60;
/** Items older than this are not news for a 12-hour brief; don't store them. */
const BRIEF_POOL_MAX_AGE_MS = 36 * 60 * 60 * 1000;
const SNIPPET_MAX = 400;

function briefPoolKey(ms) {
  return BRIEF_POOL_PREFIX + new Date(ms).toISOString().slice(0, 10);
}

function poolItem(item, category) {
  return {
    title: item.title,
    link: item.link,
    source: item.source || '',
    category,
    publishedAt: item.publishedAt,
    importanceScore: item.importanceScore ?? null,
    corroborationCount: item.corroborationCount ?? 1,
    threat: item.threat?.level ? { level: item.threat.level, category: item.threat.category || '' } : null,
    locationName: item.locationName || '',
    snippet: String(item.snippet || '').slice(0, SNIPPET_MAX),
  };
}

/** Redis commands that record a digest into the pool (empty when nothing qualifies). */
function buildBriefPoolCommands(digest, now = Date.now()) {
  const byKey = new Map();
  for (const [category, bucket] of Object.entries(digest?.categories || {})) {
    for (const item of bucket?.items || []) {
      const publishedAt = Number(item?.publishedAt);
      if (!item?.title || !item?.link || !Number.isFinite(publishedAt)) continue;
      if (now - publishedAt > BRIEF_POOL_MAX_AGE_MS || publishedAt - now > 60 * 60 * 1000) continue;
      const key = briefPoolKey(publishedAt);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(item.link, JSON.stringify(poolItem(item, category)));
    }
  }
  const commands = [];
  for (const [key, pairs] of byKey) {
    commands.push(['HSET', key, ...pairs]);
    commands.push(['EXPIRE', key, String(BRIEF_POOL_TTL_SECONDS)]);
  }
  return commands;
}

module.exports = { BRIEF_POOL_PREFIX, BRIEF_POOL_TTL_SECONDS, briefPoolKey, buildBriefPoolCommands };
