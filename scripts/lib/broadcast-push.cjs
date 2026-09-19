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
 *   BROADCAST_PUSH_MIN_GAP_S   default 900 (15min between any two broadcasts);
 *                              `critical` is never held by it, but still sets it
 *   BROADCAST_PUSH_HOURLY_CAP  default 4; `critical` is exempt, the daily cap
 *                              still bounds it
 *   BROADCAST_PUSH_NEAR_DUP_WINDOW_S default 86400 — a headline that reads as
 *                              a story already broadcast in this window only
 *                              reaches cohorts that story did not reach
 *   BROADCAST_PUSH_DAILY_CAP   default 8
 *   BROADCAST_PUSH_MIN_SOURCES_HIGH  default 2 — an uncorroborated high
 *                              narrows to the `low` cohort instead of sending
 *                              to medium+low; critical exempt
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

/**
 * Localized banner titles, lifted verbatim from the app's own String Catalog
 * ("WORLD ALERT" and "Breaking News" entries, human-reviewed, 41 locales) and
 * collapsed to base language codes — the device registers languageCode only.
 * Static, so titles cost no LLM call; resolved server-side by pick() in
 * pages/api/push/send.ts, so no APNs loc-key is involved (the loc-key path is
 * the one documented as silently breaking rendering).
 * Critical inherits the catalog's uppercase — the same chrome the Live
 * Activity card shows, so the two surfaces name the moment identically.
 */
const TITLE_MAP_BY_LEVEL = Object.freeze({
  critical: Object.freeze({
      ar: "تنبيه عالمي",
      ca: "ALERTA MUNDIAL",
      cs: "SVĚTOVÁ VÝSTRAHA",
      da: "VERDENSVARSEL",
      de: "WELTALARM",
      el: "ΠΑΓΚΟΣΜΙΟΣ ΣΥΝΑΓΕΡΜΟΣ",
      en: "WORLD ALERT",
      es: "ALERTA MUNDIAL",
      fi: "MAAILMANHÄLYTYS",
      fr: "ALERTE MONDIALE",
      he: "התרעה עולמית",
      hi: "विश्व अलर्ट",
      hr: "SVJETSKO UPOZORENJE",
      hu: "VILÁGRIASZTÁS",
      id: "PERINGATAN DUNIA",
      it: "ALLERTA MONDIALE",
      ja: "ワールド警報",
      ko: "월드 경보",
      ms: "AMARAN DUNIA",
      nb: "VERDENSALARM",
      nl: "WERELDALARM",
      pl: "ALERT ŚWIATOWY",
      pt: "ALERTA MUNDIAL",
      ro: "ALERTĂ MONDIALĂ",
      ru: "МИРОВОЕ ОПОВЕЩЕНИЕ",
      sk: "SVETOVÁ VÝSTRAHA",
      sl: "SVETOVNO OPOZORILO",
      sv: "VÄRLDSLARM",
      th: "เหตุด่วนทั่วโลก",
      tr: "KÜRESEL UYARI",
      uk: "СВІТОВА ТРИВОГА",
      vi: "CẢNH BÁO TOÀN CẦU",
      zh: "全球警报",
    }),
  high: Object.freeze({
      ar: "أخبار عاجلة",
      ca: "Notícia d'última hora",
      cs: "Nejnovější zprávy",
      da: "Breaking news",
      de: "Eilmeldung",
      el: "Έκτακτη Είδηση",
      en: "Breaking News",
      es: "Última hora",
      fi: "Pikauutinen",
      fr: "Dernière minute",
      he: "מבזק",
      hi: "ब्रेकिंग न्यूज़",
      hr: "Najnovije vijesti",
      hu: "Legfrissebb hírek",
      id: "Berita Terkini",
      it: "Notizia dell'ultima ora",
      ja: "速報",
      ko: "속보",
      ms: "Berita Terkini",
      nb: "Siste nytt",
      nl: "Laatste nieuws",
      pl: "Wiadomości z ostatniej chwili",
      pt: "Notícias de Última Hora",
      ro: "Ultima Oră",
      ru: "Срочные новости",
      sk: "Najnovšie správy",
      sl: "Najnovejše novice",
      sv: "Senaste nytt",
      th: "ข่าวด่วน",
      tr: "Son Dakika",
      uk: "Термінові новини",
      vi: "Tin nóng",
      zh: "突发新闻",
    }),
  medium: Object.freeze({
      ar: "أخبار عاجلة",
      ca: "Notícia d'última hora",
      cs: "Nejnovější zprávy",
      da: "Breaking news",
      de: "Eilmeldung",
      el: "Έκτακτη Είδηση",
      en: "Breaking News",
      es: "Última hora",
      fi: "Pikauutinen",
      fr: "Dernière minute",
      he: "מבזק",
      hi: "ब्रेकिंग न्यूज़",
      hr: "Najnovije vijesti",
      hu: "Legfrissebb hírek",
      id: "Berita Terkini",
      it: "Notizia dell'ultima ora",
      ja: "速報",
      ko: "속보",
      ms: "Berita Terkini",
      nb: "Siste nytt",
      nl: "Laatste nieuws",
      pl: "Wiadomości z ostatniej chwili",
      pt: "Notícias de Última Hora",
      ro: "Ultima Oră",
      ru: "Срочные новости",
      sk: "Najnovšie správy",
      sl: "Najnovejše novice",
      sv: "Senaste nytt",
      th: "ข่าวด่วน",
      tr: "Son Dakika",
      uk: "Термінові новини",
      vi: "Tin nóng",
      zh: "突发新闻",
    }),
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
/**
 * `high` needs independent corroboration before it may interrupt anyone.
 * Observed 2026-09-02: a single Ghanaian outlet's FDA consumer-recall story
 * went out as breaking news. A story one outlet carries is that outlet's
 * story; two carrying it is an event. `critical` is exempt — a war headline's
 * first minutes are often single-source and critical is rare by definition.
 */
const DEFAULT_MIN_SOURCES_HIGH = 2;
/** Volume ceiling per UTC day, on top of the hourly cap. */
const DEFAULT_DAILY_CAP = 8;
/** A day bucket plus slack. */
const DAILY_SLOT_TTL_S = 26 * 60 * 60;

/**
 * Near-duplicate memory. The exact-title dedup cannot see a rewrite: on
 * 2026-09-18/19 eleven of twenty-nine broadcasts were the same five stories
 * re-headlined by other outlets — the Greenland deal went out five times,
 * "Trump bans CNN" four. The store remembers what went out, to whom, so a
 * rewrite reaches only the cohorts the original did not.
 */
const DEFAULT_NEAR_DUP_WINDOW_S = 24 * 60 * 60;
const RECENT_MAX_ENTRIES = 200;

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

// Words that carry no story identity. Headline boilerplate ("says", "live
// updates") is in here too: two outlets framing one event differently share
// the nouns, not the verbs of attribution.
const FINGERPRINT_STOPWORDS = new Set((
  'a an the and or but of to in on at by for from with into onto over under after before amid as is are was ' +
  'were be been being has have had its it his her their this that these those says said say will would could ' +
  'may might can new live update updates breaking news urgent report reports reported latest just more than ' +
  'least about against during while who what when where why how not no yes via per up down out off us u s'
).split(' '));
const FINGERPRINT_LABEL = /^(?:breaking(?: news)?|urgent|live(?: updates?)?|updates?|just in|watch|exclusive|alert|flash)\s*[:|\-–—]\s*/i;

/** Crude English stemmer — enough to make "bans"/"banning" and "gives"/"giving" meet. */
function stemWord(word) {
  let w = word;
  if (w.length > 5 && w.endsWith('ing')) {
    w = w.slice(0, -3);
    if (/(.)\1$/.test(w)) w = w.slice(0, -1);
  } else if (w.length > 4 && w.endsWith('ed')) {
    w = w.slice(0, -2);
    if (/(.)\1$/.test(w)) w = w.slice(0, -1);
  } else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) {
    w = w.slice(0, -1);
  }
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/**
 * @returns {{t:string[], n:string[]}} content words, and the proper nouns
 *   among them (capitalised past the first word).
 */
function headlineFingerprint(title) {
  const words = String(title ?? '')
    .replace(FINGERPRINT_LABEL, '')
    .replace(/['’]s\b/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const keep = (w) => w.length > 1 && !FINGERPRINT_STOPWORDS.has(w.toLowerCase());
  const norm = (w) => stemWord(w.toLowerCase());
  return {
    t: [...new Set(words.filter(keep).map(norm))],
    n: [...new Set(words.slice(1).filter((w) => keep(w) && /^\p{Lu}/u.test(w)).map(norm))],
  };
}

/**
 * Same story? At least three shared content words covering half the shorter
 * headline — unless each side names something the other never mentions,
 * which is how "quake hits Japan" stays apart from "quake hits Turkey".
 * Calibrated on the 2026-09-19 log: all eleven rewrites caught, no distinct
 * story merged.
 */
function sameStory(a, b) {
  if (!a?.t?.length || !b?.t?.length) return false;
  const bSet = new Set(b.t);
  let shared = 0;
  for (const w of a.t) if (bSet.has(w)) shared++;
  if (shared < 3 || shared / Math.min(a.t.length, b.t.length) < 0.5) return false;
  const aSet = new Set(a.t);
  const aNamesUnseen = (a.n ?? []).some((w) => !bSet.has(w));
  const bNamesUnseen = (b.n ?? []).some((w) => !aSet.has(w));
  return !(aNamesUnseen && bNamesUnseen);
}

/**
 * @param {object} deps
 * @param {Record<string,string|undefined>} deps.env
 * @param {{setNx:(key:string,value:string,ttl:number)=>Promise<'new'|'duplicate'|'error'|'disabled'>,
 *          del:(key:string)=>Promise<unknown>,
 *          getJson:(key:string)=>Promise<{ok:boolean, value?:unknown}>,
 *          setJson:(key:string,value:unknown,ttl:number)=>Promise<boolean>}} deps.redis
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
  const minSourcesHigh = envInt(env, 'BROADCAST_PUSH_MIN_SOURCES_HIGH', DEFAULT_MIN_SOURCES_HIGH, 1);
  const dailyCap = envInt(env, 'BROADCAST_PUSH_DAILY_CAP', DEFAULT_DAILY_CAP, 1);
  const nearDupWindowS = envInt(env, 'BROADCAST_PUSH_NEAR_DUP_WINDOW_S', DEFAULT_NEAR_DUP_WINDOW_S, 60);
  const sandbox = String(env.APNS_ENVIRONMENT ?? '').toLowerCase() === 'sandbox';
  const i18n = envFlag(env, 'BROADCAST_PUSH_I18N');
  const langs = String(env.BROADCAST_PUSH_LANGS ?? '')
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);

  const enabled = armed && !!secret && typeof doFetch === 'function';

  const config = Object.freeze({
    enabled, armed, dryRun, sandbox, i18n, langs,
    baseUrl, minLevelRank, dedupTtlS, minGapS, hourlyCap, dailyCap, minSourcesHigh, audienceLimit, maxPages,
    nearDupWindowS, hasSecret: !!secret,
  });

  /**
   * Claim one single-use slot out of `cap` under `keyBase`.
   *
   * A counter would need INCR plus a separate EXPIRE — two round trips with a
   * window where a crash leaves an immortal counter. Claiming the first free
   * slot key is atomic per attempt and self-expiring, at the cost of at most
   * `cap` round trips. `error`/`disabled` count as taken: an unreachable Redis
   * must not unlock the firehose.
   */
  async function claimSlot(keyBase, cap, ttlSeconds) {
    for (let i = 0; i < cap; i++) {
      const key = `${keyBase}:${i}`;
      // eslint-disable-next-line no-await-in-loop -- slots must be claimed in order; cap is small
      const result = await redis.setNx(key, '1', ttlSeconds);
      if (result === 'new') return key;
      if (result !== 'duplicate') return null;
    }
    return null;
  }

  /**
   * Budgets are PER COHORT, because notification fatigue is per reader.
   *
   * A global budget let one cohort starve the others: on 2026-09-04 eight
   * overnight single-source stories going to the 13-device `low` cohort
   * consumed the whole day's quota by 06:00 UTC, so a critical story breaking
   * later could not have reached the 200+ devices in `high`/`medium` at all.
   * A send now claims a slot in each cohort it actually addresses — a
   * `low`-only story spends only `low`'s budget.
   *
   * A full cohort is DROPPED from the audience, not treated as a veto. It was
   * all-or-nothing until 2026-09-18, which handed `low` a power no per-cohort
   * budget was meant to give it: `low` sits in the audience of EVERY level, so
   * the moment its quota ran out nothing could be broadcast at all. Measured
   * that day — `low` 20/20 by 09:58 Istanbul, `medium` 2/20, `high` 0/20, and
   * fourteen waking hours of silence while two thirds of the day's budget sat
   * unspent. A story now reaches whichever cohorts still have room.
   *
   * @returns {Promise<{byCohort:Map<string,string>, kept:string[], full:string[]}>}
   */
  async function claimCohortSlots(namespace, bucket, cap, cohorts, ttlSeconds) {
    const byCohort = new Map();
    const full = [];
    for (const cohort of cohorts) {
      // eslint-disable-next-line no-await-in-loop -- at most three cohorts
      const key = await claimSlot(`${KEY_PREFIX}:${namespace}:${cohort}:${bucket}`, cap, ttlSeconds);
      if (key) byCohort.set(cohort, key);
      else full.push(cohort);
    }
    return { byCohort, kept: [...byCohort.keys()], full };
  }

  const recentKey = `${KEY_PREFIX}:recent`;

  /** Live entries in the near-dup window, or null when the store is unreadable. */
  async function loadRecent() {
    const res = await redis.getJson(recentKey);
    if (!res?.ok) return null;
    const cutoff = now() - nearDupWindowS * 1000;
    return (Array.isArray(res.value) ? res.value : []).filter((e) => e && Number(e.at) >= cutoff);
  }

  /** Re-reads before appending so nothing written since the check is lost. */
  async function rememberSent(fingerprint, audience, headline, fallback) {
    const base = (await loadRecent()) ?? fallback;
    const next = [...base, { f: fingerprint, a: [...audience], at: now(), h: headline.slice(0, 80) }]
      .slice(-RECENT_MAX_ENTRIES);
    const ok = await redis.setJson(recentKey, next, nearDupWindowS + 3600);
    if (!ok) log.warn?.(`[BroadcastPush] could not record sent story — a rewrite of it may repeat: ${headline.slice(0, 60)}`);
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
      // The translator shares provider quotas with the classify sweep that just
      // produced this headline, so "every provider declined" is usually a burst
      // of contention, not an outage — one short-delay retry rides it out.
      // Observed 2026-09-03: an all-provider miss shipped a raw English body
      // with nothing in the logs.
      let translated = await translate(headline, langs);
      const usable = (t) => t && typeof t === 'object' && langs.some((l) => typeof t[l] === 'string' && t[l].trim());
      if (!usable(translated)) {
        await new Promise((r) => setTimeout(r, 3000));
        translated = await translate(headline, langs);
      }
      if (!usable(translated)) {
        log.warn?.(`[BroadcastPush] i18n returned no languages after retry, sending source text: ${headline.slice(0, 60)}`);
        return headline;
      }
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

  function buildBody({ level, audience, headline, body, link, source, hash }) {
    return {
      audience: {
        priority: [...audience],
        // Legacy rows carry priority:null and would match no $in. They are
        // devices whose user never moved off the iOS default.
        includeUnsetPriority: audience.includes(APP_DEFAULT_PRIORITY),
        limit: audienceLimit,
      },
      alert: {
        title: TITLE_MAP_BY_LEVEL[normalizeLevel(level)] ?? TITLE_MAP_BY_LEVEL.high,
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

      let audience = audienceForLevel(level);
      if (audience.length === 0) return { action: 'skipped', reason: `no audience for level ${level}` };

      // Source confidence maps onto user tolerance instead of binning the
      // story: an uncorroborated `high` reaches ONLY the `low` cohort, whose
      // Settings wording ("All breaking news updates") is precisely a request
      // for the unconfirmed firehose. It joins medium once a second outlet
      // carries it — usually under a different headline, so dedup does not
      // block the corroborated wave; the min-gap and caps bound the near-dupe
      // the low cohort may see from that.
      const sources = Math.max(1, Number(alert?.sources) || 1);
      const uncorroborated = level === 'high' && sources < minSourcesHigh;
      if (uncorroborated) audience = ['low'];

      // Guard order is deliberate and cheapest-first: a duplicate must not burn
      // the min-gap window or an hourly slot that a genuinely new story needs.
      const hash = dedupHash(alert?.title);
      const dedupKey = `${KEY_PREFIX}:seen:${hash}`;
      const dedupResult = await redis.setNx(dedupKey, '1', dedupTtlS);
      if (dedupResult === 'duplicate') return { action: 'suppressed', reason: 'already broadcast' };
      if (dedupResult !== 'new') return { action: 'suppressed', reason: `dedup unavailable (${dedupResult})` };

      let claimed = [dedupKey];

      // A rate limiter must DEFER a story, never consume it. Releasing the
      // dedup key on every rate-limited exit is what makes that true: the
      // classify sweep re-observes the same headline every 15min, so a story
      // that loses one window is simply reconsidered in the next.
      //
      // Keeping the key here (as this did until 2026-09-04) meant a story was
      // burned for the full 6h dedup TTL the instant it lost a race it never
      // had a chance at: each sweep classifies dozens of stories, exactly one
      // can hold the gap, and the winner is whichever the loop reached first —
      // not the most important. Observed that morning: "Iran war latest" and
      // the Nepal flood toll were permanently discarded while a drone-tariff
      // item went out, and 150 of 553 hook calls were "already broadcast" for
      // stories nobody had ever received.
      //
      // Staleness is not this guard's job — BROADCAST_PUSH_RECENCY_MS already
      // drops anything too old to be worth announcing, so a deferred story is
      // either still timely when its turn comes or gets dropped there.
      // Releases everything claimed so far, not just the dedup key: the min-gap
      // means "15min between two actual broadcasts", so a gap held by a story
      // the caps then rejected would silence the next 15min for nothing.
      const deferAndRelease = async (reason) => {
        await release(claimed);
        return { action: 'suppressed', reason };
      };

      // A critical never waits behind the gap — it exists to space out the
      // routine flow, not to hold back the story the whole surface is for.
      // It still SETS the gap when free, so the routine flow keeps its
      // distance from it.
      const isCritical = level === 'critical';
      if (minGapS > 0) {
        const gapKey = `${KEY_PREFIX}:gap`;
        const gapResult = await redis.setNx(gapKey, hash, minGapS);
        if (gapResult === 'new') {
          claimed.push(gapKey);
        } else if (!(isCritical && gapResult === 'duplicate')) {
          return deferAndRelease(gapResult === 'duplicate' ? 'inside min-gap window' : `gap unavailable (${gapResult})`);
        }
      }

      // Near-duplicates reach only the cohorts the earlier telling did not.
      // Fails closed like every other guard here: an unreadable store could
      // hide a repeat, and a repeat is what this exists to prevent.
      const fingerprint = headlineFingerprint(alert?.title);
      const recent = await loadRecent();
      if (!recent) return deferAndRelease('recent-broadcast store unavailable');
      const reached = new Set();
      for (const entry of recent) {
        if (sameStory(fingerprint, entry.f)) for (const cohort of entry.a ?? []) reached.add(cohort);
      }
      if (reached.size) {
        const unreached = audience.filter((cohort) => !reached.has(cohort));
        if (unreached.length === 0) return deferAndRelease('near-duplicate of a recent broadcast');
        audience = unreached;
      }

      // Critical is exempt from the hourly cap for the same reason as the gap;
      // the daily cap below still bounds a classifier that over-calls it.
      const hourly = isCritical
        ? { byCohort: new Map(), kept: [...audience], full: [] }
        : await claimCohortSlots('cap', hourBucket(now()), hourlyCap, audience, CAP_SLOT_TTL_S);
      if (hourly.kept.length === 0) return deferAndRelease(`hourly cap reached (${hourly.full.join(',')})`);
      claimed.push(...hourly.byCohort.values());

      // Only the cohorts that cleared the hour are billed for the day; the
      // rest are not receiving this story, so charging them would be a leak.
      const daily = await claimCohortSlots('daycap', Math.floor(now() / 86_400_000), dailyCap, hourly.kept, DAILY_SLOT_TTL_S);
      if (daily.kept.length === 0) return deferAndRelease(`daily cap reached (${daily.full.join(',')})`);
      claimed.push(...daily.byCohort.values());

      // An hourly slot held by a cohort the DAY then rejected is a slot that
      // will never carry a message — hand it back so the next story can have it.
      const strandedHourly = daily.full.map((cohort) => hourly.byCohort.get(cohort)).filter(Boolean);
      if (strandedHourly.length) {
        await release(strandedHourly);
        claimed = claimed.filter((key) => !strandedHourly.includes(key));
      }

      const dropped = [...hourly.full, ...daily.full];
      if (dropped.length) {
        audience = daily.kept;
        log.log?.(`[BroadcastPush] cohort(s) at cap, narrowed to [${audience.join(',')}] (dropped ${dropped.join(',')}): ${headline.slice(0, 60)}`);
      }

      const body = await localizedBody(headline);
      const payload = buildBody({
        level,
        audience,
        headline,
        body,
        link: alert?.link ?? '',
        source: alert?.source ?? '',
        hash,
      });

      const result = await pageThrough(payload);
      // Any landed page means devices have it, so a rewrite must now respect it.
      if (result.ok || result.pages > 0) await rememberSent(fingerprint, audience, headline, recent);

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
  headlineFingerprint,
  sameStory,
  AUDIENCE_BY_LEVEL,
  LEVEL_RANK,
  TITLE_BY_LEVEL,
  TITLE_MAP_BY_LEVEL,
  APP_DEFAULT_PRIORITY,
  RELEASABLE_STATUSES,
  BODY_MAX_CHARS,
};
