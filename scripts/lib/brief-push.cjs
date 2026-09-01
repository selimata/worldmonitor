'use strict';

/**
 * AI World Brief push — tells users a freshly published brief is ready.
 *
 * WHY THIS IS NOT scripts/lib/broadcast-push.cjs
 * ----------------------------------------------
 * That module answers "something happened in the world"; this one answers "your
 * digest refreshed". They differ on every axis that matters:
 *
 *   - Audience. Broadcast maps an event's severity onto the threshold the user
 *     picked in Settings. A brief has no severity — it is a schedule, not an
 *     event — so it goes ONLY to the `low` cohort ("All breaking news
 *     updates"). Sending it to someone who asked for "only critical events —
 *     direct military strikes, major attacks" would break the promise that
 *     setting makes, no matter how interesting the brief is.
 *   - Copy. A broadcast body is a headline that only exists at send time.
 *     A brief body is fixed, so it ships fully translated (TITLE_BY_LANG /
 *     BODY_BY_LANG below) instead of paying an LLM per send.
 *   - Cadence. The brief cron runs HOURLY (Dockerfile.seed-insights: the client
 *     treats a snapshot older than 60 min as stale). Pushing every refresh
 *     would be ~24 notifications a day, so MIN_GAP defaults to 24h and the
 *     cron's own rhythm is deliberately NOT the notification rhythm.
 *   - APNs priority 5, not 10. A digest is not time-critical; 5 lets iOS batch
 *     the delivery for battery.
 *
 * WHERE IT RUNS
 * -------------
 * Inside the `seed-insights` Railway cron, hooked to runSeed's `afterPublish`
 * and fired only for outcome PUBLISHED. A degraded or last-known-good-preserved
 * run means the brief did NOT refresh, and announcing one that did not happen
 * is worse than staying silent.
 *
 * Config (env):
 *   BRIEF_PUSH_ENABLED    "1" to arm. Anything else = disabled no-op.
 *   BRIEF_PUSH_DRY_RUN    "1" (DEFAULT) matches the audience without sending.
 *   BRIEF_PUSH_BASE_URL   default https://world-monitor-app.vercel.app
 *   PUSH_ADMIN_SECRET     bearer for pages/api/push/send.ts
 *   BRIEF_PUSH_MIN_GAP_S  default 86400 (once a day)
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
const KEY_PREFIX = 'wm:brief-push:v1';

/** The brief cron is hourly; this is what stops that becoming 24 pushes a day. */
const DEFAULT_MIN_GAP_S = 24 * 60 * 60;
const DEFAULT_PAGE_SIZE = 5_000;
const DEFAULT_MAX_PAGES = 20;
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

/** "It's ready — go look at what the world is doing." */
const BODY_BY_LANG = Object.freeze({
  ar: 'موجز جديد جاهز — اطّلع على ما يجري في العالم الآن.',
  ca: 'Nou resum a punt: mira què passa al món ara mateix.',
  cs: 'Nový souhrn je tu — podívejte se, co se právě děje ve světě.',
  da: 'Ny briefing er klar – se hvad der sker i verden lige nu.',
  de: 'Neues Briefing ist da – sieh, was gerade in der Welt passiert.',
  el: 'Νέα ενημέρωση — δες τι συμβαίνει τώρα στον κόσμο.',
  en: "Fresh brief is live — see what's happening in the world right now.",
  es: 'Nuevo resumen listo: mira qué está pasando en el mundo ahora.',
  fi: 'Uusi katsaus on valmis – katso, mitä maailmassa tapahtuu juuri nyt.',
  fr: 'Nouveau bilan disponible — voyez ce qui se passe dans le monde.',
  he: 'תדריך חדש מוכן — ראו מה קורה בעולם עכשיו.',
  hi: 'नया ब्रीफ़ तैयार — देखें दुनिया में अभी क्या हो रहा है।',
  hr: 'Novi sažetak je spreman — pogledajte što se događa u svijetu.',
  hu: 'Elkészült az új összefoglaló – nézd meg, mi történik a világban.',
  id: 'Ringkasan baru siap — lihat apa yang terjadi di dunia sekarang.',
  it: 'Nuovo bollettino pronto: guarda cosa sta succedendo nel mondo.',
  ja: '最新ブリーフが公開。今、世界で何が起きているか確認しましょう。',
  ko: '새 브리프가 준비됐어요 — 지금 세계에서 무슨 일이 일어나는지 확인하세요.',
  ms: 'Ringkasan baharu sedia — lihat apa yang berlaku di dunia sekarang.',
  nb: 'Ny briefing er klar – se hva som skjer i verden nå.',
  nl: 'Nieuwe briefing staat klaar – zie wat er nu in de wereld gebeurt.',
  pl: 'Nowy raport gotowy — zobacz, co dzieje się teraz na świecie.',
  pt: 'Novo resumo disponível — veja o que está acontecendo no mundo agora.',
  ro: 'Noul rezumat este gata — vezi ce se întâmplă acum în lume.',
  ru: 'Новая сводка готова — посмотрите, что происходит в мире.',
  sk: 'Nový prehľad je pripravený — pozrite, čo sa deje vo svete.',
  sl: 'Novi pregled je pripravljen — poglejte, kaj se dogaja po svetu.',
  sv: 'Ny briefing är klar – se vad som händer i världen just nu.',
  th: 'สรุปใหม่พร้อมแล้ว — ดูว่าตอนนี้เกิดอะไรขึ้นในโลก',
  tr: 'Yeni özet hazır — dünyada olup bitenlere hemen göz at.',
  uk: 'Новий брифінг готовий — подивіться, що зараз коїться у світі.',
  vi: 'Bản tóm tắt mới đã có — xem thế giới đang diễn ra điều gì.',
  zh: '最新简报已就绪 — 看看世界正在发生什么。',
});

/**
 * Prefixed onto the title, not baked into TITLE_BY_LANG, so the strings stay
 * byte-identical to the String Catalog and a re-extraction stays a clean diff.
 */
const TITLE_EMOJI = '🌍';

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

/**
 * `pick()` in pages/api/push/send.ts looks the device's language up in these
 * maps and falls back to `.en`, so `en` must always be present — it is the
 * fallback for every locale the app ships that is not listed here.
 */
function localizedTitle() {
  const out = {};
  for (const [lang, value] of Object.entries(TITLE_BY_LANG)) out[lang] = `${TITLE_EMOJI} ${value}`;
  return out;
}

function localizedBody() {
  return { ...BODY_BY_LANG };
}

/**
 * @param {object} deps
 * @param {Record<string,string|undefined>} deps.env
 * @param {{setNx:(k:string,v:string,ttl:number)=>Promise<'new'|'duplicate'|'error'|'disabled'>,
 *          del:(k:string)=>Promise<unknown>}} deps.redis
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {{log:Function,warn:Function}} [deps.log]
 */
function createBriefPushNotifier({ env, redis, fetchImpl, log = console }) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const secret = env.PUSH_ADMIN_SECRET ?? '';
  const baseUrl = (env.BRIEF_PUSH_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const armed = envFlag(env, 'BRIEF_PUSH_ENABLED');
  const dryRun = env.BRIEF_PUSH_DRY_RUN !== '0';
  const minGapS = envInt(env, 'BRIEF_PUSH_MIN_GAP_S', DEFAULT_MIN_GAP_S, 0);
  const pageSize = envInt(env, 'BRIEF_PUSH_PAGE_SIZE', DEFAULT_PAGE_SIZE, 1);
  const maxPages = envInt(env, 'BRIEF_PUSH_MAX_PAGES', DEFAULT_MAX_PAGES, 1);
  const sandbox = String(env.APNS_ENVIRONMENT ?? '').toLowerCase() === 'sandbox';
  const cohorts = String(env.BRIEF_PUSH_COHORTS ?? '')
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
  const audienceCohorts = cohorts.length ? cohorts : [...DEFAULT_COHORTS];

  const enabled = armed && !!secret && typeof doFetch === 'function';
  const config = Object.freeze({
    enabled, armed, dryRun, sandbox, baseUrl, minGapS, pageSize, maxPages,
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
   * its audience; this cron has no such ceiling, so the loop belongs here.
   * `pages` is reported on failure because it decides whether the caller may
   * release its gap key: once a page has landed, retrying double-sends.
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
        return { ok: false, pages, matched, sent, status: result.status };
      }
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

  function buildPayload() {
    return {
      audience: {
        priority: [...audienceCohorts],
        // Deliberately false: an unset priority means the iOS default
        // (`medium`), and `medium` promises severity filtering a digest cannot
        // meet. Those users are not opted in to this.
        includeUnsetPriority: false,
        limit: pageSize,
      },
      alert: { title: localizedTitle(), body: localizedBody() },
      // PushRoute.brief -> the World Report tab with the AI brief opened, so the
      // tap lands on the thing the banner is talking about.
      route: { type: 'brief' },
      // Collapses an older unread brief banner instead of stacking them: only
      // the newest brief is worth opening.
      collapseId: 'brief',
      // 5, not 10: a digest is not time-critical, and this lets iOS batch the
      // delivery rather than waking the device.
      priority: 5,
      sound: 'default',
      sandbox,
      dryRun,
    };
  }

  /**
   * Announce a freshly published brief.
   *
   * @param {{generatedAt?: number|string}} [brief] identity of the published
   *   snapshot; only used to make the log line traceable.
   * @returns {Promise<{action:string, reason?:string, matched?:number, sent?:number}>}
   */
  async function notifyPublished(brief = {}) {
    try {
      if (!enabled) {
        return { action: 'disabled', reason: !armed ? 'BRIEF_PUSH_ENABLED not set' : 'PUSH_ADMIN_SECRET not set' };
      }

      const claimed = [];
      if (minGapS > 0) {
        const gapKey = `${KEY_PREFIX}:gap`;
        const gap = await redis.setNx(gapKey, String(brief.generatedAt ?? ''), minGapS);
        if (gap !== 'new') {
          // Fails closed like the broadcast guards: an unreachable Redis must
          // not turn an hourly cron into an hourly notification.
          return {
            action: 'suppressed',
            reason: gap === 'duplicate' ? 'inside min-gap window' : `gap unavailable (${gap})`,
          };
        }
        claimed.push(gapKey);
      }

      const result = await pageThrough(buildPayload());

      if (!result.ok) {
        const nothingSent = result.pages === 0;
        const releasable = result.status === undefined || RELEASABLE_STATUSES.has(result.status);
        if (nothingSent && releasable) {
          for (const key of claimed) {
            try { await redis.del(key); } catch { /* the TTL will clear it */ }
          }
          log.warn?.(`[BriefPush] failed before any page landed, gap released: ${result.reason ?? `HTTP ${result.status}`}`);
        } else {
          log.warn?.(`[BriefPush] PARTIAL — ${result.matched} reached over ${result.pages} page(s), then ${result.reason ?? `HTTP ${result.status}`}`);
        }
        return { action: 'error', reason: result.reason ?? `HTTP ${result.status}`, pages: result.pages, matched: result.matched };
      }

      log.log?.(
        `[BriefPush] ${dryRun ? 'DRY-RUN' : 'SENT'} -> priority[${audienceCohorts.join(',')}] ` +
        `matched=${result.matched}${dryRun ? '' : ` sent=${result.sent}`} over ${result.pages} page(s)` +
        `${result.complete ? '' : ' (TRUNCATED)'}`,
      );
      return {
        action: dryRun ? 'dry-run' : 'sent',
        matched: result.matched,
        sent: result.sent,
        pages: result.pages,
        complete: result.complete,
      };
    } catch (e) {
      log.warn?.(`[BriefPush] notify failed: ${e?.message || e}`);
      return { action: 'error', reason: e?.message || String(e) };
    }
  }

  return { notifyPublished, config };
}

module.exports = {
  createBriefPushNotifier,
  localizedTitle,
  localizedBody,
  TITLE_BY_LANG,
  BODY_BY_LANG,
  TITLE_EMOJI,
  DEFAULT_COHORTS,
  DEFAULT_MIN_GAP_S,
  RELEASABLE_STATUSES,
};
