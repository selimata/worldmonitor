'use strict';

/**
 * AI World Brief push — two notifications a day, in the reader's own morning
 * and evening.
 *
 * WHY THIS IS NOT scripts/lib/broadcast-push.cjs
 * ----------------------------------------------
 * That module answers "something happened in the world"; this one answers
 * "here is your twice-daily read". They differ on every axis that matters:
 *
 *   - Audience. Broadcast maps an event's severity onto the threshold the user
 *     picked in Settings. A brief has no severity — it is a schedule — so it
 *     goes ONLY to the `low` cohort ("All breaking news updates"). Sending it
 *     to someone who asked for "only critical events — direct military strikes,
 *     major attacks" would break the promise that setting makes.
 *   - Copy. A broadcast body is a headline that exists only at send time.
 *     These bodies are fixed, so they ship fully translated instead of paying
 *     an LLM per send.
 *   - Timing. Broadcast fires the moment news breaks. This fires at a LOCAL
 *     wall-clock hour, so the same notification reaches Istanbul and São Paulo
 *     at each reader's 10:00, not simultaneously.
 *   - APNs priority 5, not 10. A digest is not time-critical; 5 lets iOS batch
 *     the delivery for battery.
 *
 * HOW LOCAL TIME WORKS WITHOUT ANY OFFSET MATHS
 * ---------------------------------------------
 * Devices already store their IANA zone (`timezone: "Europe/Istanbul"`, written
 * by NotificationService.registerDeviceWithBackend). So the cron does not
 * compute offsets: on each hourly run it asks which zones are AT the slot hour
 * right now, and hands that list to the send endpoint as `audience.timezone`.
 * Mongo does the rest with a `$in`.
 *
 * This is why the slot is matched on the HOUR and not on hour+minute. Zones at
 * :30 and :45 offsets (Asia/Kolkata, Asia/Kathmandu, Australia/Eucla) are never
 * at exactly 10:00 when a UTC-aligned cron fires — they are at 10:30 or 10:45,
 * and matching the hour is what includes them instead of silently skipping
 * every half-hour-offset country on earth.
 *
 * WHERE IT RUNS
 * -------------
 * Inside the `seed-insights` Railway cron, hooked to runSeed's `afterPublish`
 * and fired only for outcome PUBLISHED. That cron runs HOURLY, which is exactly
 * what makes local-hour targeting work: every hour it catches the next band of
 * zones rolling into 10:00 or 19:00. A degraded or last-known-good-preserved
 * run means the brief did NOT refresh, and announcing one that did not happen
 * is worse than staying silent.
 *
 * Config (env):
 *   BRIEF_PUSH_ENABLED    "1" to arm. Anything else = disabled no-op.
 *   BRIEF_PUSH_DRY_RUN    "1" (DEFAULT) matches the audience without sending.
 *   BRIEF_PUSH_BASE_URL   default https://world-monitor-app.vercel.app
 *   PUSH_ADMIN_SECRET     bearer for pages/api/push/send.ts
 *   BRIEF_PUSH_MORNING_HOUR  local hour for the overnight recap, default 10
 *   BRIEF_PUSH_EVENING_HOUR  local hour for the day's close, default 19
 *   BRIEF_PUSH_COHORTS    comma list, default "low"
 *   BRIEF_PUSH_PAGE_SIZE  devices per request, default 5000
 *   BRIEF_PUSH_MAX_PAGES  runaway guard, default 20
 *   APNS_ENVIRONMENT      "sandbox" routes to the APNs sandbox
 *
 * Resolves, never rejects: a push failure must not fail the seed run that
 * produced a perfectly good brief.
 */

const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_BASE_URL = 'https://world-monitor-app.vercel.app';
const SEND_PATH = '/api/push/send';
const KEY_PREFIX = 'wm:brief-push:v2';

const DEFAULT_MORNING_HOUR = 10;
const DEFAULT_EVENING_HOUR = 19;
const DEFAULT_PAGE_SIZE = 5_000;
const DEFAULT_MAX_PAGES = 20;
/**
 * A slot fires once per zone per day, so the dedup key only has to survive one
 * hourly tick. 6h gives a stalled or retried cron plenty of room without ever
 * reaching the next day's slot.
 */
const SLOT_DEDUP_TTL_S = 6 * 60 * 60;
/**
 * `low` = "All breaking news updates" — the only tier whose wording admits a
 * scheduled digest. `medium` and `high` both promise event severity filtering,
 * which a brief cannot satisfy.
 */
const DEFAULT_COHORTS = Object.freeze(['low']);

const RELEASABLE_STATUSES = new Set([400, 401, 403, 404, 405, 413, 422]);

/**
 * Lifted verbatim from the app's own String Catalog entry "AI World Brief"
 * (WorldView/WorldMonitor/Localizable.xcstrings), so the banner names the
 * feature exactly as the UI the user is about to open does.
 *
 * Keyed by BASE language code, not BCP-47: the device sends
 * `Locale.current.language.languageCode?.identifier`, which is "pt" and "zh",
 * never "pt-BR" or "zh-Hans". Regional variants collapsed to their primary.
 */
const TITLE_BY_LANG = Object.freeze({
  ar: 'موجز العالم بالذكاء الاصطناعي',
  ca: 'Informe mundial IA',
  cs: 'AI souhrn světa',
  da: 'AI-verdensbriefing',
  de: 'KI-Weltbriefing',
  el: 'Παγκόσμια Ενημέρωση AI',
  en: 'AI World Brief',
  es: 'Resumen Mundial con IA',
  fi: 'Tekoälyn maailmankatsaus',
  fr: 'Bilan mondial IA',
  he: 'תדריך עולם (AI)',
  hi: 'AI विश्व ब्रीफ',
  hr: 'AI svjetski sažetak',
  hu: 'AI világjelentés',
  id: 'Ringkasan Dunia AI',
  it: 'Bollettino Mondiale AI',
  ja: 'AIワールドブリーフ',
  ko: 'AI 월드 브리프',
  ms: 'Ringkasan Dunia AI',
  nb: 'AI-verdensrapport',
  nl: 'AI-wereldbriefing',
  pl: 'Światowy raport AI',
  pt: 'Resumo Mundial de IA',
  ro: 'Raportul Mondial IA',
  ru: 'Мировая сводка ИИ',
  sk: 'Svetový prehľad AI',
  sl: 'AI Svetovni pregled',
  sv: 'AI-världsbriefing',
  th: 'AI สรุปโลก',
  tr: 'YZ Dünya Özeti',
  uk: 'Світовий брифінг ШІ',
  vi: 'Tóm Tắt Thế Giới AI',
  zh: 'AI 全球简报',
});

/** Morning slot: what the reader slept through. */
const MORNING_BODY_BY_LANG = Object.freeze({
  ar: 'إليك ما حدث في العالم خلال الليل.',
  ca: 'Mira què ha passat al món durant la nit.',
  cs: 'Podívejte se, co se ve světě stalo přes noc.',
  da: 'Se hvad der skete i verden i nat.',
  de: 'Das ist über Nacht in der Welt passiert.',
  el: 'Δες τι συνέβη στον κόσμο μέσα στη νύχτα.',
  en: "Here's what happened around the world overnight.",
  es: 'Mira qué pasó en el mundo durante la noche.',
  fi: 'Katso, mitä maailmalla tapahtui yön aikana.',
  fr: 'Voici ce qui s’est passé dans le monde cette nuit.',
  he: 'הנה מה שקרה בעולם במהלך הלילה.',
  hi: 'देखें रात भर दुनिया में क्या हुआ।',
  hr: 'Pogledajte što se u svijetu dogodilo tijekom noći.',
  hu: 'Nézd meg, mi történt a világban az éjjel.',
  id: 'Lihat apa yang terjadi di dunia semalam.',
  it: 'Ecco cosa è successo nel mondo durante la notte.',
  ja: '夜のあいだに世界で起きたことをまとめました。',
  ko: '밤사이 세계에서 일어난 일을 확인하세요.',
  ms: 'Lihat apa yang berlaku di dunia semalaman.',
  nb: 'Se hva som skjedde i verden i natt.',
  nl: 'Dit is er vannacht in de wereld gebeurd.',
  pl: 'Zobacz, co wydarzyło się na świecie w nocy.',
  pt: 'Veja o que aconteceu no mundo durante a noite.',
  ro: 'Vezi ce s-a întâmplat în lume peste noapte.',
  ru: 'Вот что произошло в мире за ночь.',
  sk: 'Pozrite, čo sa vo svete stalo cez noc.',
  sl: 'Poglejte, kaj se je ponoči zgodilo po svetu.',
  sv: 'Se vad som hände i världen i natt.',
  th: 'ดูว่าเมื่อคืนเกิดอะไรขึ้นบ้างทั่วโลก',
  tr: 'Dün gece dünyada neler olduğuna bak.',
  uk: 'Ось що сталося у світі за ніч.',
  vi: 'Xem những gì đã xảy ra trên thế giới đêm qua.',
  zh: '看看昨夜世界发生了什么。',
});

/** Evening slot: where things stand as the day closes. */
const EVENING_BODY_BY_LANG = Object.freeze({
  ar: 'مع نهاية اليوم — إليك حال العالم الآن.',
  ca: 'A punt d’acabar el dia: així està el món ara.',
  cs: 'Den se chýlí ke konci — takhle na tom svět je.',
  da: 'Dagen slutter – sådan står verden nu.',
  de: 'Der Tag geht zu Ende – so steht die Welt gerade.',
  el: 'Η μέρα κλείνει — δες πού βρίσκεται ο κόσμος.',
  en: "The day is closing — here's where the world stands.",
  es: 'Termina el día: así está el mundo ahora.',
  fi: 'Päivä kääntyy iltaan – tässä maailman tilanne.',
  fr: 'La journée se termine — voici où en est le monde.',
  he: 'היום מסתיים — הנה מצב העולם עכשיו.',
  hi: 'दिन खत्म हो रहा है — देखें दुनिया कहाँ खड़ी है।',
  hr: 'Dan se bliži kraju — evo gdje je svijet sada.',
  hu: 'Véget ér a nap – így áll most a világ.',
  id: 'Hari hampir berakhir — begini keadaan dunia sekarang.',
  it: 'La giornata si chiude: ecco come sta il mondo.',
  ja: '一日の終わりに、いまの世界の状況をどうぞ。',
  ko: '하루가 저물어요 — 지금 세계의 상황입니다.',
  ms: 'Hari hampir berakhir — beginilah keadaan dunia kini.',
  nb: 'Dagen er over – slik står verden nå.',
  nl: 'De dag loopt ten einde – zo staat de wereld ervoor.',
  pl: 'Dzień się kończy — oto jak wygląda świat.',
  pt: 'O dia está acabando — veja como está o mundo agora.',
  ro: 'Ziua se încheie — iată cum stă lumea acum.',
  ru: 'День подходит к концу — вот положение дел в мире.',
  sk: 'Deň sa končí — takto je na tom svet.',
  sl: 'Dan se izteka — takšno je stanje v svetu.',
  sv: 'Dagen är slut – så ser världen ut nu.',
  th: 'วันกำลังจะจบ — มาดูสถานการณ์โลกตอนนี้',
  tr: 'Gün biterken dünyada durum ne, özetine göz at.',
  uk: 'День добігає кінця — ось стан справ у світі.',
  vi: 'Ngày sắp khép lại — thế giới đang ra sao.',
  zh: '一天将尽 — 看看此刻的世界。',
});

/**
 * Prefixed onto the title rather than baked into TITLE_BY_LANG, so the strings
 * stay byte-identical to the String Catalog and a re-extraction is a clean
 * diff. The emoji is also what tells the two slots apart at a glance, since
 * both carry the same feature name.
 */
const SLOTS = Object.freeze({
  morning: Object.freeze({ emoji: '🌅', bodies: MORNING_BODY_BY_LANG, envKey: 'BRIEF_PUSH_MORNING_HOUR', defaultHour: DEFAULT_MORNING_HOUR }),
  evening: Object.freeze({ emoji: '🌆', bodies: EVENING_BODY_BY_LANG, envKey: 'BRIEF_PUSH_EVENING_HOUR', defaultHour: DEFAULT_EVENING_HOUR }),
});

function envFlag(env, key, fallback = false) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw === 'true';
}

function envInt(env, key, fallback, min, max) {
  const n = Number(env[key]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Local hour in an IANA zone, 0-23. */
function localHour(timeZone, at) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hour12: false }).format(at);
  // hour12:false renders midnight as "24" in some ICU versions.
  return Number(parts) % 24;
}

/**
 * Every IANA zone whose local clock currently reads `hour`.
 *
 * Matching the hour and not hour+minute is deliberate: a UTC-aligned cron never
 * observes Asia/Kolkata (+5:30) or Asia/Kathmandu (+5:45) at exactly 10:00, so
 * a minute-precise match would silently exclude every half-hour-offset country.
 */
function zonesAtLocalHour(hour, at = new Date(), zones = null) {
  const all = zones ?? (typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []);
  const out = [];
  for (const zone of all) {
    try {
      if (localHour(zone, at) === hour) out.push(zone);
    } catch { /* an ICU build without this zone simply cannot have devices in it */ }
  }
  return out;
}

/**
 * `pick()` in pages/api/push/send.ts looks the device's language up in these
 * maps and falls back to `.en`, so `en` must always be present — it is the
 * fallback for every locale the app ships that is not listed here.
 */
function localizedTitle(slot) {
  const { emoji } = SLOTS[slot];
  const out = {};
  for (const [lang, value] of Object.entries(TITLE_BY_LANG)) out[lang] = `${emoji} ${value}`;
  return out;
}

function localizedBody(slot) {
  return { ...SLOTS[slot].bodies };
}

/**
 * @param {object} deps
 * @param {Record<string,string|undefined>} deps.env
 * @param {{setNx:(k:string,v:string,ttl:number)=>Promise<'new'|'duplicate'|'error'|'disabled'>,
 *          del:(k:string)=>Promise<unknown>}} deps.redis
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {{log:Function,warn:Function}} [deps.log]
 * @param {()=>Date} [deps.now]
 * @param {string[]} [deps.timeZones] override the zone universe, for tests
 */
function createBriefPushNotifier({ env, redis, fetchImpl, log = console, now = () => new Date(), timeZones = null }) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const secret = env.PUSH_ADMIN_SECRET ?? '';
  const baseUrl = (env.BRIEF_PUSH_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const armed = envFlag(env, 'BRIEF_PUSH_ENABLED');
  const dryRun = env.BRIEF_PUSH_DRY_RUN !== '0';
  const pageSize = envInt(env, 'BRIEF_PUSH_PAGE_SIZE', DEFAULT_PAGE_SIZE, 1, 20_000);
  const maxPages = envInt(env, 'BRIEF_PUSH_MAX_PAGES', DEFAULT_MAX_PAGES, 1, 1000);
  const sandbox = String(env.APNS_ENVIRONMENT ?? '').toLowerCase() === 'sandbox';
  const cohorts = String(env.BRIEF_PUSH_COHORTS ?? '')
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
  const audienceCohorts = cohorts.length ? cohorts : [...DEFAULT_COHORTS];
  const slotHours = Object.freeze({
    morning: envInt(env, SLOTS.morning.envKey, SLOTS.morning.defaultHour, 0, 23),
    evening: envInt(env, SLOTS.evening.envKey, SLOTS.evening.defaultHour, 0, 23),
  });

  const enabled = armed && !!secret && typeof doFetch === 'function';
  const config = Object.freeze({
    enabled, armed, dryRun, sandbox, baseUrl, pageSize, maxPages, slotHours,
    cohorts: audienceCohorts, hasSecret: !!secret,
  });

  async function post(payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await doFetch(`${baseUrl}${SEND_PATH}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
          'User-Agent': 'worldmonitor-brief-push/1.0',
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
   * The send endpoint is a Vercel function with a wall-clock ceiling and pages
   * its audience; this cron has none, so the loop belongs here. `pages` is
   * reported on failure because it decides whether the caller may release its
   * dedup key: once a page has landed, retrying double-sends.
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
      if (result.status !== 200) return { ok: false, pages, matched, sent, status: result.status };
      matched += Number(result.json?.matched ?? 0);
      sent += Number(result.json?.sent ?? 0);
      pages += 1;
      cursor = result.json?.nextCursor ?? null;
      if (!cursor) {
        const complete = !result.json?.truncated;
        if (!complete) log.warn?.('[BriefPush] endpoint truncated with no resume cursor — tail NOT sent');
        return { ok: true, pages, matched, sent, complete };
      }
      if (pages >= maxPages) {
        log.warn?.(`[BriefPush] stopped at BRIEF_PUSH_MAX_PAGES=${maxPages}; ${matched} reached, rest NOT sent`);
        return { ok: true, pages, matched, sent, complete: false };
      }
    }
  }

  function buildPayload(slot, zones) {
    return {
      audience: {
        priority: [...audienceCohorts],
        // Deliberately false: an unset priority means the iOS default
        // (`medium`), which promises severity filtering a digest cannot meet.
        includeUnsetPriority: false,
        timezone: zones,
        limit: pageSize,
      },
      alert: { title: localizedTitle(slot), body: localizedBody(slot) },
      // PushRoute.brief -> World Report with the AI brief opened, so the tap
      // lands on the thing the banner is talking about.
      route: { type: 'brief' },
      // Per slot, so the evening banner replaces an unread morning one rather
      // than stacking two digests on the lock screen.
      collapseId: `brief-${slot}`,
      // 5, not 10: a digest is not time-critical, and this lets iOS batch the
      // delivery rather than waking the device.
      priority: 5,
      sound: 'default',
      sandbox,
      dryRun,
    };
  }

  async function runSlot(slot, at) {
    const hour = slotHours[slot];
    const zones = zonesAtLocalHour(hour, at, timeZones);
    if (zones.length === 0) return { slot, action: 'skipped', reason: `no zone at local ${hour}:00` };

    // Keyed on the UTC hour, not the slot alone: each hourly tick serves a
    // DIFFERENT band of zones, so a global daily key would let the first band
    // through and silently starve the other 23. This only has to stop the same
    // tick running twice.
    const utcStamp = `${at.toISOString().slice(0, 13)}`;
    const dedupKey = `${KEY_PREFIX}:${slot}:${utcStamp}`;
    const claim = await redis.setNx(dedupKey, String(zones.length), SLOT_DEDUP_TTL_S);
    if (claim !== 'new') {
      // Fails closed like every other guard here: an unreachable Redis must not
      // turn an hourly cron into an hourly notification.
      return {
        slot,
        action: 'suppressed',
        reason: claim === 'duplicate' ? 'already sent this tick' : `dedup unavailable (${claim})`,
      };
    }

    const result = await pageThrough(buildPayload(slot, zones));

    if (!result.ok) {
      const nothingSent = result.pages === 0;
      const releasable = result.status === undefined || RELEASABLE_STATUSES.has(result.status);
      if (nothingSent && releasable) {
        try { await redis.del(dedupKey); } catch { /* the TTL will clear it */ }
        log.warn?.(`[BriefPush] ${slot}: failed before any page landed, key released: ${result.reason ?? `HTTP ${result.status}`}`);
      } else {
        log.warn?.(`[BriefPush] ${slot}: PARTIAL — ${result.matched} reached over ${result.pages} page(s), then ${result.reason ?? `HTTP ${result.status}`}`);
      }
      return { slot, action: 'error', reason: result.reason ?? `HTTP ${result.status}`, pages: result.pages, matched: result.matched };
    }

    log.log?.(
      `[BriefPush] ${dryRun ? 'DRY-RUN' : 'SENT'} ${slot} (local ${hour}:00, ${zones.length} zones) ` +
      `-> priority[${audienceCohorts.join(',')}] matched=${result.matched}` +
      `${dryRun ? '' : ` sent=${result.sent}`}${result.complete ? '' : ' (TRUNCATED)'}`,
    );
    return {
      slot,
      action: dryRun ? 'dry-run' : 'sent',
      hour,
      zones: zones.length,
      matched: result.matched,
      sent: result.sent,
      pages: result.pages,
      complete: result.complete,
    };
  }

  /**
   * Announce a freshly published brief to whichever zones have just rolled into
   * a slot hour. Usually neither slot matches and this is a cheap no-op; that
   * is the normal case, since only 2 of 24 hourly ticks reach a given zone.
   *
   * @returns {Promise<{action:string, slots?:object[]}>}
   */
  async function notifyPublished() {
    try {
      if (!enabled) {
        return { action: 'disabled', reason: !armed ? 'BRIEF_PUSH_ENABLED not set' : 'PUSH_ADMIN_SECRET not set' };
      }
      const at = now();
      const slots = [];
      for (const slot of Object.keys(SLOTS)) {
        // Sequential on purpose: the two slots share the send endpoint's
        // capacity, and at most one of them normally has any zones at all.
        slots.push(await runSlot(slot, at));
      }
      const delivered = slots.filter((s) => s.action === 'sent' || s.action === 'dry-run');
      return {
        action: delivered.length ? delivered[0].action : 'skipped',
        slots,
        matched: delivered.reduce((n, s) => n + (s.matched ?? 0), 0),
        sent: delivered.reduce((n, s) => n + (s.sent ?? 0), 0),
      };
    } catch (e) {
      log.warn?.(`[BriefPush] notify failed: ${e?.message || e}`);
      return { action: 'error', reason: e?.message || String(e) };
    }
  }

  return { notifyPublished, runSlot, config };
}

module.exports = {
  createBriefPushNotifier,
  localizedTitle,
  localizedBody,
  zonesAtLocalHour,
  localHour,
  SLOTS,
  TITLE_BY_LANG,
  MORNING_BODY_BY_LANG,
  EVENING_BODY_BY_LANG,
  DEFAULT_COHORTS,
  DEFAULT_MORNING_HOUR,
  DEFAULT_EVENING_HOUR,
  RELEASABLE_STATUSES,
};
