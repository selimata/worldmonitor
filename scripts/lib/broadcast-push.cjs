'use strict';

/**
 * Broadcast push dispatcher — turns an LLM-classified headline into an APNs
 * alert on every registered iOS device.
 *
 * WHY THIS LIVES IN THE RELAY AND NOT IN A CRON
 * ---------------------------------------------
 * scripts/ais-relay.cjs already classifies every ingested headline into
 * critical/high/medium/low/info (CLASSIFY_VALID_LEVELS) and already applies the
 * source-tier and recency gates before it publishes anything. The instant the
 * level is known is the instant the push should go out: a cron would poll for a
 * fact the relay computed synchronously, and would add its whole interval as
 * latency to a breaking-news alert. The relay is already a long-running Railway
 * service (scripts/railway-services.json, service "ais-relay"), so an in-process
 * hook needs no new deployment target, no new scheduler and no new container.
 *
 * WHY IT POSTS TO VERCEL INSTEAD OF SPEAKING APNs DIRECTLY
 * -------------------------------------------------------
 * Device tokens live in the MongoDB `devices` collection owned by
 * monitor-landing-web, which the relay holds no credentials for. Reusing
 * pages/api/push/send.ts keeps token storage, audience filtering and dead-token
 * pruning in exactly one place — this module only decides WHETHER and WHAT to
 * send. scripts/lib/apns-live-activity.cjs stays a direct-APNs path because
 * Live Activity tokens live in Redis, which the relay does own.
 *
 * SAFETY POSTURE
 * --------------
 * A broadcast reaches the entire install base and cannot be recalled, so every
 * guard here fails CLOSED — the opposite of scripts/shared/notification-dedup.cjs,
 * which fails open because a missed per-user alert is cheaper than a missed
 * delivery. Here a duplicate blast to every device is the expensive outcome, so
 * an unreachable Redis suppresses the push rather than letting it through.
 *
 * Config (env):
 *   BROADCAST_PUSH_ENABLED     "1" to arm. Anything else = disabled no-op.
 *   BROADCAST_PUSH_DRY_RUN     "1" (DEFAULT) asks Vercel to match the audience
 *                              and return the count WITHOUT sending. Set to "0"
 *                              only after the dry-run counts look right.
 *   BROADCAST_PUSH_BASE_URL    default https://world-monitor-app.vercel.app
 *                              (must match AppConfig.landingBaseURL in the app)
 *   PUSH_ADMIN_SECRET          bearer token for pages/api/push/send.ts
 *   BROADCAST_PUSH_MIN_LEVEL   "high" (DEFAULT, inert) — raise to "critical"
 *                              only as a temporary volume brake; it overrides
 *                              the user's own priority choice while set.
 *   BROADCAST_PUSH_DEDUP_TTL_S default 21600 (6h)
 *   BROADCAST_PUSH_MIN_GAP_S   default 900 (15min between any two broadcasts)
 *   BROADCAST_PUSH_HOURLY_CAP  default 4
 *   BROADCAST_PUSH_AUDIENCE_LIMIT devices per page, default 5000
 *   BROADCAST_PUSH_MAX_PAGES   runaway guard on the paging loop, default 20
 *   BROADCAST_PUSH_I18N        "1" to translate the headline per language
 *   BROADCAST_PUSH_LANGS       comma list, used only when I18N is on
 *   APNS_ENVIRONMENT           "sandbox" routes the send to APNs sandbox
 *
 * Every public method resolves and never rejects, so the relay hook stays a
 * one-liner that cannot take down the classify loop.
 */

const { createHash } = require('node:crypto');

/**
 * A device's stored `priority` is the THRESHOLD its user picked in Settings,
 * not the severity of an event. NotificationService.swift promises:
 *
 *   high   -> "Only critical events — direct military strikes, major attacks"
 *   medium -> "Significant developments and critical events"
 *   low    -> "All breaking news updates"
 *
 * Inverting that promise gives, for each event level, the set of device
 * thresholds that must receive it. Changing this table changes what the
 * shipped Settings copy means, so it is the one place that mapping lives.
 */
const AUDIENCE_BY_LEVEL = Object.freeze({
  critical: Object.freeze(['high', 'medium', 'low']),
  high: Object.freeze(['medium', 'low']),
  medium: Object.freeze(['low']),
});

/** Ranked loosest-last, so MIN_LEVEL can be compared numerically. */
const LEVEL_RANK = Object.freeze({ critical: 3, high: 2, medium: 1 });

/**
 * NotificationPriority.medium is the iOS default, so a device row written
 * before the app started sending `priority` (or by a client that omits it)
 * means "medium" — not "no preference". The send endpoint needs telling,
 * because a Mongo `$in` never matches a null.
 */
const APP_DEFAULT_PRIORITY = 'medium';

/**
 * English literals, deliberately. scripts/lib/apns-live-activity.cjs documents
 * the 2026-08-31 finding that a `title-loc-key` made APNs answer 200 while iOS
 * silently dropped the push. The headline in `body` carries the meaning and can
 * be translated per-language (BROADCAST_PUSH_I18N); this banner word cannot be
 * localized the same way without re-testing that failure mode.
 */
const TITLE_BY_LEVEL = Object.freeze({
  critical: 'World Alert',
  high: 'Breaking News',
  medium: 'Breaking News',
});

const BODY_MAX_CHARS = 220;
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_BASE_URL = 'https://world-monitor-app.vercel.app';
const SEND_PATH = '/api/push/send';
const KEY_PREFIX = 'wm:broadcast-push:v1';

const DEFAULT_DEDUP_TTL_S = 6 * 60 * 60;
const DEFAULT_MIN_GAP_S = 15 * 60;
const DEFAULT_HOURLY_CAP = 4;
/** Page size per call to the send endpoint, NOT a cap on the audience. */
const DEFAULT_AUDIENCE_LIMIT = 5_000;
/** Runaway guard on the paging loop: 20 x 5k = 100k devices. */
const DEFAULT_MAX_PAGES = 20;
/** An hour bucket plus slack, so a slot key always outlives its own bucket. */
const CAP_SLOT_TTL_S = 3900;

/**
 * Statuses that prove pages/api/push/send.ts rejected the request BEFORE it
 * opened an APNs session, so releasing the dedup key cannot cause a double
 * send. A timeout or a 5xx is deliberately absent: the handler may already be
 * mid-fan-out, and re-sending to the whole install base is worse than dropping
 * one alert.
 */
const RELEASABLE_STATUSES = new Set([400, 401, 403, 404, 405, 413, 422]);

function envFlag(env, key, fallback = false) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw === 'true';
}

function envInt(env, key, fallback, min) {
  const n = Number(env[key]);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.trunc(n));
}

function normalizeLevel(level) {
  return String(level ?? '').trim().toLowerCase();
}

/** @returns {readonly string[]} device priority cohorts, empty when the level never pushes. */
function audienceForLevel(level) {
  return AUDIENCE_BY_LEVEL[normalizeLevel(level)] ?? [];
}

/** Collapses whitespace and trims to the APNs banner budget. */
function normalizeHeadline(title) {
  const clean = String(title ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > BODY_MAX_CHARS ? `${clean.slice(0, BODY_MAX_CHARS - 1).trimEnd()}…` : clean;
}

/**
 * Dedup identity. Case- and punctuation-insensitive so the same story arriving
 * from two feeds with different capitalisation collapses to one broadcast. The
 * level is NOT in the material: a story re-classified from high to critical
 * must not earn a second blast.
 */
function dedupHash(title) {
  const material = String(title ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

function hourBucket(nowMs) {
  return Math.floor(nowMs / 3_600_000);
}

/**
 * @param {object} deps
 * @param {Record<string,string|undefined>} deps.env
 * @param {{setNx:(key:string,value:string,ttl:number)=>Promise<'new'|'duplicate'|'error'|'disabled'>,
 *          del:(key:string)=>Promise<unknown>}} deps.redis
 * @param {(title:string,langs:string[])=>Promise<Record<string,string>>} [deps.translate]
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {{log:Function,warn:Function}} [deps.log]
 * @param {()=>number} [deps.now]
 */
function createBroadcastPushDispatcher({ env, redis, translate, fetchImpl, log = console, now = Date.now }) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const secret = env.PUSH_ADMIN_SECRET ?? '';
  const baseUrl = (env.BROADCAST_PUSH_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const armed = envFlag(env, 'BROADCAST_PUSH_ENABLED');
  // Dry-run is the DEFAULT, not the exception. An operator has to take an
  // explicit action to point the first real blast at the install base.
  const dryRun = env.BROADCAST_PUSH_DRY_RUN !== '0';
  // Defaults to `high`, which is the LOOSEST level the relay hook actually
  // emits (both call sites gate on critical|high), so this global floor is
  // inert by default and AUDIENCE_BY_LEVEL — the user's own Settings choice —
  // is the only thing that decides who hears about a story.
  //
  // It defaulted to `critical` during rollout as a volume brake, and that brake
  // silently voided the Settings copy: a `high` story was dropped before the
  // audience table ran, so "All breaking news updates" and "Only critical
  // events" delivered byte-identical notifications. A throttle belongs in the
  // min-gap and hourly cap, which drop events without lying about preferences.
  const minLevelRank = LEVEL_RANK[normalizeLevel(env.BROADCAST_PUSH_MIN_LEVEL)] ?? LEVEL_RANK.high;
  const dedupTtlS = envInt(env, 'BROADCAST_PUSH_DEDUP_TTL_S', DEFAULT_DEDUP_TTL_S, 60);
  const minGapS = envInt(env, 'BROADCAST_PUSH_MIN_GAP_S', DEFAULT_MIN_GAP_S, 0);
  const hourlyCap = envInt(env, 'BROADCAST_PUSH_HOURLY_CAP', DEFAULT_HOURLY_CAP, 1);
  const audienceLimit = envInt(env, 'BROADCAST_PUSH_AUDIENCE_LIMIT', DEFAULT_AUDIENCE_LIMIT, 1);
  const maxPages = envInt(env, 'BROADCAST_PUSH_MAX_PAGES', DEFAULT_MAX_PAGES, 1);
  const sandbox = String(env.APNS_ENVIRONMENT ?? '').toLowerCase() === 'sandbox';
  const i18n = envFlag(env, 'BROADCAST_PUSH_I18N');
  const langs = String(env.BROADCAST_PUSH_LANGS ?? '')
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);

  const enabled = armed && !!secret && typeof doFetch === 'function';

  const config = Object.freeze({
    enabled, armed, dryRun, sandbox, i18n, langs,
    baseUrl, minLevelRank, dedupTtlS, minGapS, hourlyCap, audienceLimit, maxPages,
    hasSecret: !!secret,
  });

  /**
   * Rate limit as N single-use slots per wall-clock hour, claimed with SET NX.
   * A counter would need INCR plus a separate EXPIRE — two round trips with a
   * window where a crash leaves an immortal counter. Claiming the first free
   * slot key is atomic per attempt and self-expiring, at the cost of at most
   * `hourlyCap` round trips. `error`/`disabled` are treated as taken: an
   * unreachable Redis must not unlock the firehose.
   */
  async function claimHourlySlot(bucket) {
    for (let i = 0; i < hourlyCap; i++) {
      const key = `${KEY_PREFIX}:cap:${bucket}:${i}`;
      // eslint-disable-next-line no-await-in-loop -- slots must be claimed in order; cap is small
      const result = await redis.setNx(key, '1', CAP_SLOT_TTL_S);
      if (result === 'new') return key;
      if (result !== 'duplicate') return null;
    }
    return null;
  }

  /** Best-effort unwind; a failure here only costs one suppressed broadcast. */
  async function release(keys) {
    for (const key of keys) {
      try {
        // eslint-disable-next-line no-await-in-loop -- at most 3 keys
        await redis.del(key);
      } catch { /* the TTL will clear it */ }
    }
  }

  async function localizedBody(headline) {
    if (!i18n || !translate || langs.length === 0) return headline;
    try {
      const translated = await translate(headline, langs);
      if (!translated || typeof translated !== 'object') return headline;
      // `en` must exist: pick() in pages/api/push/send.ts falls back to it when
      // a device's language is not in the map.
      const map = { en: headline };
      for (const lang of langs) {
        const value = translated[lang];
        if (typeof value === 'string' && value.trim()) map[lang] = normalizeHeadline(value);
      }
      return Object.keys(map).length > 1 ? map : headline;
    } catch (e) {
      log.warn?.(`[BroadcastPush] translate failed, sending English: ${e?.message || e}`);
      return headline;
    }
  }

  function buildBody({ level, headline, body, link, source, hash }) {
    const audience = audienceForLevel(level);
    return {
      audience: {
        priority: [...audience],
        // Legacy rows carry priority:null and would match no $in. They are
        // devices whose user never moved off the iOS default.
        includeUnsetPriority: audience.includes(APP_DEFAULT_PRIORITY),
        limit: audienceLimit,
      },
      alert: {
        title: TITLE_BY_LEVEL[normalizeLevel(level)] ?? TITLE_BY_LEVEL.high,
        body,
        ...(source ? { subtitle: source } : {}),
      },
      // Omitted rather than faked when there is no link: PushRoute.init?
      // returns nil for an article route without a url, and a nil route makes
      // the tap open the app normally instead of an empty article sheet.
      ...(link ? { route: { type: 'article', url: link, title: headline } } : {}),
      collapseId: hash,
      priority: 10,
      sound: 'default',
      sandbox,
      dryRun,
    };
  }

  async function post(payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await doFetch(`${baseUrl}${SEND_PATH}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
          'User-Agent': 'worldmonitor-relay/1.0',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      let json = null;
      try { json = await res.json(); } catch { /* non-JSON error page */ }
      return { status: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Drive the send endpoint one page at a time until it stops handing back a
   * cursor.
   *
   * The endpoint is a Vercel function with a hard wall-clock ceiling; the relay
   * is a long-running process with none. Putting the loop on this side is what
   * makes the audience size independent of that ceiling — every individual
   * request stays short, and a large broadcast becomes many bounded calls
   * instead of one that gets killed halfway with no record of who was reached.
   *
   * `pages` is reported even on failure because it decides whether the caller
   * may unwind its guards: once page 1 has landed, some devices have the push,
   * and re-running the story later would deliver it to them twice.
   */
  async function pageThrough(basePayload) {
    let cursor = null;
    let pages = 0;
    let matched = 0;
    let sent = 0;
    for (;;) {
      const payload = cursor
        ? { ...basePayload, audience: { ...basePayload.audience, after: cursor } }
        : basePayload;
      let result;
      try {
        result = await post(payload);
      } catch (e) {
        return { ok: false, pages, matched, sent, reason: e?.message || String(e) };
      }
      if (result.status !== 200) {
        return { ok: false, pages, matched, sent, status: result.status, json: result.json };
      }
      matched += Number(result.json?.matched ?? 0);
      sent += Number(result.json?.sent ?? 0);
      pages += 1;
      cursor = result.json?.nextCursor ?? null;
      if (!cursor) {
        // A truncated page with nothing to resume from means the endpoint ran
        // out of budget without making progress. Reporting that as `complete`
        // would claim a reach the run never had.
        const complete = !result.json?.truncated;
        if (!complete) {
          log.warn?.('[BroadcastPush] endpoint truncated with no resume cursor — the tail was NOT sent');
        }
        return { ok: true, pages, matched, sent, complete };
      }
      if (pages >= maxPages) {
        // A silent stop would read as "everyone got it". Say so out loud.
        log.warn?.(
          `[BroadcastPush] stopped at BROADCAST_PUSH_MAX_PAGES=${maxPages} with a cursor still open — ` +
          `${matched} devices reached, the rest were NOT sent`,
        );
        return { ok: true, pages, matched, sent, complete: false };
      }
    }
  }

  /**
   * Consider one classified headline for a broadcast.
   *
   * @param {{title:string, level:string, link?:string, source?:string, publishedAt?:number}} alert
   * @returns {Promise<{action:string, reason?:string, matched?:number, sent?:number}>}
   */
  async function observe(alert) {
    try {
      if (!enabled) {
        return { action: 'disabled', reason: !armed ? 'BROADCAST_PUSH_ENABLED not set' : 'PUSH_ADMIN_SECRET not set' };
      }

      const level = normalizeLevel(alert?.level);
      const rank = LEVEL_RANK[level];
      if (!rank) return { action: 'skipped', reason: `level ${level || '(none)'} never broadcasts` };
      if (rank < minLevelRank) return { action: 'skipped', reason: `level ${level} below BROADCAST_PUSH_MIN_LEVEL` };

      const headline = normalizeHeadline(alert?.title);
      if (!headline) return { action: 'skipped', reason: 'empty title' };

      const audience = audienceForLevel(level);
      if (audience.length === 0) return { action: 'skipped', reason: `no audience for level ${level}` };

      // Guard order is deliberate and cheapest-first: a duplicate must not burn
      // the min-gap window or an hourly slot that a genuinely new story needs.
      const hash = dedupHash(alert?.title);
      const dedupKey = `${KEY_PREFIX}:seen:${hash}`;
      const dedupResult = await redis.setNx(dedupKey, '1', dedupTtlS);
      if (dedupResult === 'duplicate') return { action: 'suppressed', reason: 'already broadcast' };
      if (dedupResult !== 'new') return { action: 'suppressed', reason: `dedup unavailable (${dedupResult})` };

      const claimed = [dedupKey];

      if (minGapS > 0) {
        const gapKey = `${KEY_PREFIX}:gap`;
        const gapResult = await redis.setNx(gapKey, hash, minGapS);
        if (gapResult !== 'new') {
          // The dedup key stays: this story lost the race but is still "seen",
          // and re-broadcasting it after the gap expires would deliver stale news.
          return { action: 'suppressed', reason: gapResult === 'duplicate' ? 'inside min-gap window' : `gap unavailable (${gapResult})` };
        }
        claimed.push(gapKey);
      }

      const slotKey = await claimHourlySlot(hourBucket(now()));
      if (!slotKey) return { action: 'suppressed', reason: 'hourly cap reached' };
      claimed.push(slotKey);

      const body = await localizedBody(headline);
      const payload = buildBody({
        level,
        headline,
        body,
        link: alert?.link ?? '',
        source: alert?.source ?? '',
        hash,
      });

      const result = await pageThrough(payload);

      if (!result.ok) {
        // Unwinding is only safe while NOTHING has gone out. Once a page has
        // landed, releasing the dedup key would let this story blast the
        // already-notified devices a second time — worse than dropping the tail.
        const nothingSent = result.pages === 0;
        const releasable = result.status === undefined || RELEASABLE_STATUSES.has(result.status);
        if (nothingSent && releasable) {
          await release(claimed);
          log.warn?.(`[BroadcastPush] failed before any page landed, released guards: ${result.reason ?? `HTTP ${result.status}`}`);
        } else {
          log.warn?.(
            `[BroadcastPush] PARTIAL — ${result.matched} devices reached over ${result.pages} page(s), ` +
            `then ${result.reason ?? `HTTP ${result.status}`}. Guards kept: a retry would double-send.`,
          );
        }
        return {
          action: 'error',
          reason: result.reason ?? `HTTP ${result.status}`,
          status: result.status,
          pages: result.pages,
          matched: result.matched,
          sent: result.sent,
        };
      }

      log.log?.(
        `[BroadcastPush] ${dryRun ? 'DRY-RUN' : 'SENT'} ${level} -> priority[${audience.join(',')}] ` +
        `matched=${result.matched}${dryRun ? '' : ` sent=${result.sent}`} over ${result.pages} page(s)` +
        `${result.complete ? '' : ' (TRUNCATED)'} — ${headline.slice(0, 60)}`,
      );
      return {
        action: dryRun ? 'dry-run' : 'sent',
        matched: result.matched,
        sent: result.sent,
        pages: result.pages,
        complete: result.complete,
        level,
        audience: [...audience],
      };
    } catch (e) {
      log.warn?.(`[BroadcastPush] observe failed: ${e?.message || e}`);
      return { action: 'error', reason: e?.message || String(e) };
    }
  }

  return { observe, config };
}

module.exports = {
  createBroadcastPushDispatcher,
  audienceForLevel,
  normalizeHeadline,
  dedupHash,
  hourBucket,
  AUDIENCE_BY_LEVEL,
  LEVEL_RANK,
  TITLE_BY_LEVEL,
  APP_DEFAULT_PRIORITY,
  RELEASABLE_STATUSES,
  BODY_MAX_CHARS,
};
