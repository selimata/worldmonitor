#!/usr/bin/env node

import {
  loadEnvFile,
  CHROME_UA,
  getRedisCredentials,
  runSeed,
  withRetry,
  httpRetryError,
  createLlmBudgetError,
  extendExistingTtl,
  isLlmBudgetError,
  readExistingSeedMeta,
  redisCommand,
  writeExtraKey,
} from './_seed-utils.mjs';
// AI World Brief "it's ready" push — see scripts/lib/brief-push.cjs.
import briefPush from './lib/brief-push.cjs';
import {
  clusterItems,
  computeEntityCorroboration,
  selectTopStories,
  DIPLOMACY_KEYWORDS,
  ENTITY_BIGRAMS,
} from './_clustering.mjs';
import { MIN_CORROBORATING_PUBLISHERS } from './shared/publisher-families.js';
import { extractCountryCode } from './shared/geo-extract.mjs';
import { buildChinaNewsCoverage } from './_china-news-coverage.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';
import {
  pickBriefCluster,
  briefSystemPrompt,
  briefUserPrompt,
  synthesisSystemPrompt,
  synthesisUserPrompt,
} from './_insights-brief.mjs';
import {
  INSIGHTS_COMPOSER_THREW,
  INSIGHTS_SYNTHESIS_FAILURE_CODES,
  classifyInsightsSynthesisFailure,
  composeInsightsSynthesis,
  resolveInsightsSynthesis,
} from './_insights-synthesis-diagnostics.mjs';
export {
  INSIGHTS_COMPOSER_THREW,
  INSIGHTS_SYNTHESIS_FAILURE_CODES,
  classifyInsightsSynthesisFailure,
  composeInsightsSynthesis,
  resolveInsightsSynthesis,
};
import { buildLlmCallEvent, emitLlmEvents, flushPendingLlmEvents } from './lib/llm-telemetry.cjs';
import {
  GROQ_DEFAULT_MODEL,
  OPENROUTER_PROVIDER_ROUTING,
} from './_llm-model-timeouts.mjs';
// Import from the scripts mirror (`scripts/shared/`) — NOT the repo-root
// `shared/`. Railway services with nixpacks `rootDirectory=scripts` only
// package files under scripts/; a `../shared/` import resolves to
// `/shared/...` at runtime which is absent in the container and crashes
// the seeder on startup. The local pattern is the `./shared/geo-extract.mjs`
// line above. PR #3836 review caught this. See skill
// railway-deploy-gotchas/reference/nixpacks-root-dir-scripts-cross-dir-import-escape.
import { validateNoHallucinatedProperNouns } from './shared/brief-llm-core.js';

// Hallucination validator rollout mode (PR-2 of brief-content-quality
// regressions). `shadow` = log violations to Sentry but ship the LLM
// output unchanged (default, safe). `enforce` = on violation, replace
// the LLM summary with the source headline. Flip via Railway env after
// the 7-day shadow window confirms <5% violation rate.
// #4921: enforce is the DEFAULT — the shadow window measured its
// false-positive rate; shipping detected hallucinations was the residual
// risk. Set BRIEF_VALIDATOR_MODE=shadow to revert during an incident.
const BRIEF_VALIDATOR_MODE =
  process.env.BRIEF_VALIDATOR_MODE === 'shadow' ? 'shadow' : 'enforce';

// True only when run directly as a cron entry (node seed-insights.mjs), false
// when imported by tests — so importing the module doesn't load .env or fire a
// live seed. Mirrors seed-forecasts.mjs.
const _isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (_isDirectRun) loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'news:insights:v1';
const DIGEST_KEY = 'news:digest:v1:full:en';
const CHINA_COVERAGE_KEY = 'news:insights:v1:CN';
const CHINA_NEWS_DIGEST_LANGUAGE = 'zh';

// Defense-in-depth auth — see seed-infra.mjs for the same pattern + rationale.
// Set WORLDMONITOR_RELAY_KEY on the Railway service (must match a value in
// Vercel's WORLDMONITOR_VALID_KEYS). Origin alone is no longer reliable
// because CF/Vercel intermediaries may strip it and CF can cache the 401.
const RELAY_API_KEY = process.env.WORLDMONITOR_RELAY_KEY || '';

// Digest items store proto enum strings (THREAT_LEVEL_HIGH etc.) from toProtoItem().
// Normalize to client-side lowercase values before propagating into insights output.
const PROTO_TO_LEVEL = {
  THREAT_LEVEL_CRITICAL: 'critical',
  THREAT_LEVEL_HIGH: 'high',
  THREAT_LEVEL_MEDIUM: 'medium',
  THREAT_LEVEL_LOW: 'low',
  THREAT_LEVEL_UNSPECIFIED: 'info',
};

function normalizeThreat(threat) {
  if (!threat) return undefined;
  const level = PROTO_TO_LEVEL[threat.level] ?? threat.level;
  return { ...threat, level };
}

const CACHE_TTL = 10800; // 3h — 6x the 30 min cron interval. Shorter = key expires on any missed
                         // cron tick and /api/bootstrap loses insights entirely. Bad brief content
                         // is gated at brief-selection time (see pickBriefCluster + briefSystemPrompt
                         // in _insights-brief.mjs), not by aging out fast.
const MAX_HEADLINE_LEN = 500;
const INSIGHTS_SOURCE_VERSION = 'digest-clustering-v2-importance-diversity';
const INSIGHTS_MAX_CONSECUTIVE_FAILURES = 100;
const INSIGHTS_RUN_OUTCOMES = Object.freeze({
  LKG_PRESERVED: 'lkg_preserved',
  PUBLISHED: 'published',
  DEGRADED: 'degraded',
});

const INSIGHTS_SYNTHESIS_FAILURE_CODE_SET = new Set(Object.values(INSIGHTS_SYNTHESIS_FAILURE_CODES));
const INSIGHTS_RUN_META = Symbol('worldmonitor.insightsRunMeta');

function normalizeInsightsFailureCode(code) {
  return INSIGHTS_SYNTHESIS_FAILURE_CODE_SET.has(code)
    ? code
    : INSIGHTS_SYNTHESIS_FAILURE_CODES.PROVIDER;
}

function attachInsightsRunMeta(payload, runMeta) {
  const decorated = { ...(payload || {}) };
  Object.defineProperty(decorated, INSIGHTS_RUN_META, {
    value: Object.freeze({ ...(runMeta || {}) }),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return decorated;
}

/**
 * Attach non-serialized run state to an insights payload. The marker lets the
 * runSeed validation seam distinguish a true LKG preservation from a fresh
 * payload without ever writing the marker to Redis.
 */
export function decorateInsightsRun(payload, runMeta) {
  return attachInsightsRunMeta(payload, runMeta);
}

function insightsRunMeta(payload) {
  return payload?.[INSIGHTS_RUN_META] || null;
}

/**
 * Strip audit-only China coverage while retaining the non-serialized run
 * marker for validation and afterPublish hooks.
 */
export function publishInsightsPayload(data) {
  const { chinaNewsCoverage: _chinaNewsCoverage, ...payload } = data || {};
  const runMeta = insightsRunMeta(data);
  return runMeta ? attachInsightsRunMeta(payload, runMeta) : payload;
}

export function validateInsightsPayload(data) {
  if (insightsRunMeta(data)?.outcome === INSIGHTS_RUN_OUTCOMES.LKG_PRESERVED) return false;
  return declareRecords(data) > 0;
}

/**
 * How stale the last good snapshot may get before a single-headline brief
 * becomes worth more than preserving it.
 *
 * The normal rule is that a synthesis failure must not clear: an L2 headline
 * is thinner than an L1 synthesis, and letting it publish would advance
 * `generatedAt` and hide that the real brief is failing. That reasoning holds
 * only while the preserved snapshot is still servable.
 *
 * Past this it inverts. The iOS client refuses any snapshot older than three
 * hours (`InsightsSnapshot.maxAge`), so a preserved LKG beyond that is not the
 * better brief — it is no brief, and the World Brief card goes dark. Observed
 * 2026-09-01: every provider's sample was gate-rejected for four hours
 * straight, the seeder dutifully preserved a snapshot no reader would accept,
 * and the card was empty the whole time. A grounded single headline beats an
 * empty card.
 *
 * Set below the client's ceiling so the degraded brief lands while there is
 * still margin, rather than exactly as the card blanks.
 */
export const INSIGHTS_LKG_DEGRADED_PUBLISH_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * @param {{ synthesisFailureCode: string|null, legacyStatus: string, lkgAgeMs?: number|null }} args
 */
export function resolveInsightsFallbackStatus({ synthesisFailureCode, legacyStatus, lkgAgeMs = null }) {
  if (!synthesisFailureCode) return legacyStatus;
  // Long outage: let the fallback keep whatever status it earned — see above.
  if (typeof lkgAgeMs === 'number' && Number.isFinite(lkgAgeMs)
      && lkgAgeMs >= INSIGHTS_LKG_DEGRADED_PUBLISH_AFTER_MS) {
    return legacyStatus;
  }
  return 'degraded';
}

/**
 * Age of the published snapshot, or null when there is none to measure or its
 * stamp is unreadable. Null keeps the strict rule: never let an unparseable
 * timestamp argue for publishing a thinner brief.
 */
export function insightsLkgAgeMs(existing, now = Date.now()) {
  const stamp = Date.parse(existing?.generatedAt ?? '');
  if (!Number.isFinite(stamp)) return null;
  return Math.max(0, now - stamp);
}

/**
 * #5947: how many corroborated (brief-eligible) clusters the corpus held on
 * this run. Bounded and numeric so it is safe for seed-meta/health/logs, and
 * it is the field that separates the two very different worlds behind a
 * MISSING_CLUSTER rejection: 0 means the corpus genuinely had nothing to lead
 * with (legitimately degraded), while >0 means selection failed to surface a
 * cluster that existed — the production incident this issue tracked. Absent
 * stats normalize to null, never 0, so a telemetry failure cannot impersonate
 * a bare corpus.
 */
const INSIGHTS_MAX_BRIEF_ELIGIBLE_CLUSTERS = 1000;

function normalizeBriefEligibleClusters(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return Math.min(INSIGHTS_MAX_BRIEF_ELIGIBLE_CLUSTERS, value);
}

/**
 * Build only the diagnostic patch owned by the insights seeder. `fetchedAt`
 * remains under runSeed's control: on a rejected LKG attempt it is mirrored
 * from the old canonical envelope, while a successful publish gets `now`.
 */
export function buildInsightsFreshnessMetaPatch({
  previousMeta,
  outcome,
  failureCode = null,
  nowMs = Date.now(),
  servedGeneratedAt = null,
  briefEligibleClusters = null,
} = {}) {
  const previous = previousMeta && typeof previousMeta === 'object' ? previousMeta : {};
  const now = Number.isFinite(nowMs) && nowMs > 0 ? Math.floor(nowMs) : Date.now();
  const previousFailures = Number.isInteger(previous.consecutiveFailures) && previous.consecutiveFailures > 0
    ? previous.consecutiveFailures
    : 0;
  const servedAt = typeof servedGeneratedAt === 'string' && servedGeneratedAt.length <= 64
    ? servedGeneratedAt
    : (typeof previous.servedGeneratedAt === 'string' ? previous.servedGeneratedAt : null);
  const normalizedFailureCode = failureCode == null ? null : normalizeInsightsFailureCode(failureCode);
  const eligibleClusters = normalizeBriefEligibleClusters(briefEligibleClusters);

  if (outcome === INSIGHTS_RUN_OUTCOMES.PUBLISHED) {
    return {
      lastAttemptAt: now,
      lastSuccessAt: now,
      servedGeneratedAt: servedAt,
      consecutiveFailures: 0,
      lastSynthesisFailureCode: normalizedFailureCode,
      briefEligibleClusters: eligibleClusters,
    };
  }

  return {
    lastAttemptAt: now,
    lastSuccessAt: Number.isFinite(previous.lastSuccessAt) ? previous.lastSuccessAt : null,
    servedGeneratedAt: servedAt,
    consecutiveFailures: Math.min(INSIGHTS_MAX_CONSECUTIVE_FAILURES, previousFailures + 1),
    lastSynthesisFailureCode: normalizedFailureCode || INSIGHTS_SYNTHESIS_FAILURE_CODES.PROVIDER,
    briefEligibleClusters: eligibleClusters,
  };
}

const TASK_NARRATION = /^(we need to|i need to|let me|i'll |i should|i will |the task is|the instructions|according to the rules|so we need to|okay[,.]\s*(i'll|let me|so|we need|the task|i should|i will)|sure[,.]\s*(i'll|let me|so|we need|the task|i should|i will|here)|first[, ]+(i|we|let)|to summarize (the headlines|the task|this)|my task (is|was|:)|step \d)/i;
const PROMPT_ECHO = /^(summarize the top story|summarize the key|rules:|here are the rules|the top story is likely)/i;

function stripReasoningPreamble(text) {
  const trimmed = text.trim();
  if (TASK_NARRATION.test(trimmed) || PROMPT_ECHO.test(trimmed)) {
    const lines = trimmed.split('\n').filter(l => l.trim());
    const clean = lines.filter(l => !TASK_NARRATION.test(l.trim()) && !PROMPT_ECHO.test(l.trim()));
    return clean.join('\n').trim() || trimmed;
  }
  return trimmed;
}

function sanitizeTitle(title) {
  if (typeof title !== 'string') return '';
  return title
    .replace(/<[^>]*>/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .slice(0, MAX_HEADLINE_LEN)
    .trim();
}

function clipText(value, maxLen) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > maxLen ? `${text.slice(0, maxLen - 1).trim()}...` : text;
}

function normalizeBriefSourceUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function normalizePublishedAt(value) {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function briefSourceFromStory(story) {
  const url = normalizeBriefSourceUrl(story?.primaryLink);
  const title = clipText(story?.primaryTitle, 160);
  const source = clipText(story?.primarySource, 80);
  if (!url || !title || !source) return null;
  const publishedAt = normalizePublishedAt(story?.pubDate);
  return publishedAt ? { title, source, url, publishedAt } : { title, source, url };
}

/**
 * #4928: the legacy single-headline brief, extracted intact from the main
 * flow (L2 of the fallback chain). Corroboration-gated via
 * pickBriefCluster; enforce/shadow semantics unchanged.
 */
async function generateLegacySingleHeadlineBrief(topStories, { callBudgetMs } = {}) {
  const briefCluster = pickBriefCluster(topStories);
  const topHeadline = briefCluster ? sanitizeTitle(briefCluster.primaryTitle) : '';
  const worldBriefSources = briefCluster ? [briefSourceFromStory(briefCluster)].filter(Boolean) : [];

  if (!topHeadline) {
    console.warn('  No multi-source cluster available — publishing degraded (stories without brief)');
    return { worldBrief: '', briefProvider: '', briefModel: '', worldBriefSources, status: 'degraded' };
  }

  const llmResult = await callLLM(topHeadline, Number.isFinite(callBudgetMs) ? { callBudgetMs } : {});
  if (!llmResult) {
    console.warn('  No LLM available — publishing degraded (stories without brief)');
    return { worldBrief: '', briefProvider: '', briefModel: '', worldBriefSources, status: 'degraded' };
  }

  // Hallucination check: did the LLM invent proper nouns not in the
  // headline? (May 19 incident: "Lebanese President Michel Aoun pledged…"
  // against a nameless headline. docs/plans/2026-05-19-001 U2.)
  const validation = validateNoHallucinatedProperNouns(llmResult.text, topHeadline);
  if (!validation.ok) {
    const hallucinated = (validation.hallucinated || []).join(' ');
    if (BRIEF_VALIDATOR_MODE === 'enforce') {
      console.warn(`  [brief_hallucination ENFORCE] dropped LLM summary: invented "${hallucinated}" not in headline; fell back to headline`);
      return {
        worldBrief: topHeadline,
        briefProvider: `${llmResult.provider}+headline-fallback`,
        briefModel: llmResult.model,
        worldBriefSources,
        status: 'ok',
      };
    }
    console.warn(`  [brief_hallucination SHADOW] would have dropped LLM summary: invented "${hallucinated}" not in headline`);
  }
  return {
    worldBrief: llmResult.text,
    briefProvider: llmResult.provider,
    briefModel: llmResult.model,
    worldBriefSources,
    status: 'ok',
  };
}

function digestKeyForLanguage(language) {
  return `news:digest:v1:full:${language}`;
}

/**
 * A digest shape the caller can actually read items out of.
 *
 * `unwrapEnvelope` hands back the raw value when it cannot parse it, so a key
 * holding anything but the expected object — a half-written warm, a plain
 * string, whatever the RPC left behind — arrives here as a STRING. A string is
 * truthy, so `fetchInsights`'s `if (!digest)` guard did not fire: the run
 * skipped the last-known-good reuse that exists for exactly this case and threw
 * `Digest has no items (shape: string)` instead, losing the whole cycle.
 * Observed 2026-09-01 at 02:41 and 09:00.
 *
 * Treat unusable as absent. The caller already knows how to degrade.
 */
export function usableDigest(value) {
  if (Array.isArray(value)) return value.length > 0 ? value : null;
  if (!value || typeof value !== 'object') return null;
  return value;
}

async function readDigestFromRedis(key = DIGEST_KEY) {
  const { url, token } = getRedisCredentials();
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data.result) return null;
  let unwrapped;
  try {
    unwrapped = unwrapEnvelope(JSON.parse(data.result)).data;
  } catch {
    // A key that is not JSON at all is absent as far as this seeder cares.
    return null;
  }
  return usableDigest(unwrapped);
}

async function readExistingInsights() {
  const { url, token } = getRedisCredentials();
  const resp = await fetch(`${url}/get/${encodeURIComponent(CANONICAL_KEY)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.result ? unwrapEnvelope(JSON.parse(data.result)).data : null;
}

// Provider config — mirrors server/_shared/llm.ts getProviderCredentials()
// Order: Ollama → paid OpenRouter → two fixed free OpenRouter models → Groq.
// Each free model stays a separate application-validated attempt.
// The two mid-chain fallbacks, overridden for this seeder only.
//
// The shared policy still names the `:free` Gemma variants, and on 2026-09-01
// those answered "temporarily rate-limited upstream" on every call for hours.
// That pool is shared across all OpenRouter users, so no amount of credit on
// this account reaches it — two of this chain's four providers were simply
// dead. Every run spent its real attempts on the two that were left, the
// grounding gate rejected both (a routine outcome the chain is sized to
// absorb), and news:insights went three hours without a write. Past three
// hours the iOS client refuses the snapshot outright and the World Brief card
// goes dark.
//
// Overridden here rather than in scripts/lib/llm-model-policy.cjs because that
// policy also feeds forecasts, regional weekly briefs and the relay's classify
// loop — none of which are failing — and its model names are pinned by parity
// tests and published methodology docs in two languages. This seeder is the one
// on fire; widening the blast radius under time pressure is how the next
// outage starts.
//
// Both were chosen by running the real synthesis prompt through them with
// OPENROUTER_PROVIDER_ROUTING applied. Two things that looked fine on paper and
// were not: `qwen/qwen3.7-flash` is Alibaba's and returns 404 "All providers
// have been ignored" against the routing below, and most models expand "Modi"
// to "Narendra Modi" — a proper noun the headline never contains, which the
// grounding gate then rejects. solar-pro4 stayed inside the source vocabulary.
//
// A fallback that sometimes fails the gate still beats one that always 429s:
// the gate is what guarantees quality, so a weaker writer costs a rejected
// sample, never a bad brief.
const INSIGHTS_FALLBACK_PRIMARY_MODEL = 'upstage/solar-pro4';
const INSIGHTS_FALLBACK_BACKUP_MODEL = 'meta-llama/llama-4-maverick';

const LLM_PROVIDERS = [
  {
    name: 'ollama',
    envKey: 'OLLAMA_API_URL',
    apiUrlFn: (baseUrl) => new URL('/v1/chat/completions', baseUrl).toString(),
    model: () => process.env.OLLAMA_MODEL || 'llama3.1:8b',
    headers: (_key) => {
      const h = { 'Content-Type': 'application/json', 'User-Agent': CHROME_UA };
      const apiKey = process.env.OLLAMA_API_KEY;
      if (apiKey) h.Authorization = `Bearer ${apiKey}`;
      return h;
    },
    extraBody: { think: false },
    timeout: 25_000,
  },
  {
    name: 'openrouter',
    envKey: 'OPENROUTER_API_KEY',
    apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'deepseek/deepseek-v4-flash',
    headers: (key) => ({ 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://worldmonitor.app', 'X-Title': 'World Monitor', 'User-Agent': CHROME_UA }),
    extraBody: { reasoning: { enabled: false }, provider: OPENROUTER_PROVIDER_ROUTING },
    timeout: 20_000,
  },
  {
    name: 'openrouter-free',
    envKey: 'OPENROUTER_API_KEY',
    apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
    model: INSIGHTS_FALLBACK_PRIMARY_MODEL,
    headers: (key) => ({ 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://worldmonitor.app', 'X-Title': 'World Monitor', 'User-Agent': CHROME_UA }),
    extraBody: { reasoning: { enabled: false }, provider: OPENROUTER_PROVIDER_ROUTING },
    timeout: 20_000,
    maxRetries: 0,
  },
  {
    name: 'openrouter-free-backup',
    envKey: 'OPENROUTER_API_KEY',
    apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
    model: INSIGHTS_FALLBACK_BACKUP_MODEL,
    headers: (key) => ({ 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://worldmonitor.app', 'X-Title': 'World Monitor', 'User-Agent': CHROME_UA }),
    extraBody: { reasoning: { enabled: false }, provider: OPENROUTER_PROVIDER_ROUTING },
    timeout: 20_000,
    maxRetries: 0,
  },
  {
    name: 'groq',
    envKey: 'GROQ_API_KEY',
    apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
    model: GROQ_DEFAULT_MODEL,
    headers: (key) => ({ 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': CHROME_UA }),
    // GROQ_DEFAULT_MODEL (openai/gpt-oss-*) is a reasoning model: without this
    // it spends the whole max_tokens budget on reasoning tokens and returns
    // finish_reason: "length" with an EMPTY message.content, which this file
    // logs as "groq: empty response" and treats as a provider failure. Groq has
    // no equivalent of OpenRouter's reasoning.enabled:false — the only lever is
    // reasoning_effort, and the API rejects "none" (low|medium|high only).
    extraBody: { reasoning_effort: 'low' },
    timeout: 15_000,
  },
];

// Bounded retry for the brief LLM call. seed-insights holds a 120s seed lock,
// and since #6001 a run may walk the whole provider chain for L1 and then make
// a second callLLM for the L2 fallback — so the budget below is threaded as a
// RUN-level remainder (see fetchInsights) rather than spent twice. Honor a
// provider's Retry-After (429/503) instead of dropping straight to the next
// provider, but never sleep/fetch past the remaining call budget.
const INSIGHTS_LLM_MAX_RETRIES = 2;
// Near-greedy for the first draw: a world brief should be the same brief given
// the same corpus. The resample deliberately is not — see the queue loop.
const INSIGHTS_TEMPERATURE = 0.1;
const INSIGHTS_RESAMPLE_TEMPERATURE = 0.7;
const INSIGHTS_LLM_RETRY_BASE_MS = 1_000;
const INSIGHTS_LLM_RETRY_AFTER_MAX_MS = 10_000;
const INSIGHTS_LLM_CALL_BUDGET_MS = 60_000;
const INSIGHTS_LLM_CALL_BUDGET_GUARD_MS = 5_000;

let insightsLlmFetchForTests = null;
function __setInsightsLlmTransportForTests(overrides = null) {
  insightsLlmFetchForTests = typeof overrides?.fetch === 'function' ? overrides.fetch : null;
}

async function callLLM(headline, options = {}) {
  // #4921: callers may supply explicit prompts (the top-8 synthesis call);
  // the headline default keeps the legacy single-headline path and its
  // retry tests unchanged.
  const systemPrompt = options.systemPrompt
    ?? briefSystemPrompt(new Date().toISOString().split('T')[0]);
  const userPrompt = options.userPrompt ?? briefUserPrompt(headline);
  const maxTokens = Number.isFinite(options.maxTokens) ? options.maxTokens : 300;

  const insightsFetch = insightsLlmFetchForTests || ((...args) => globalThis.fetch(...args));
  const callBudgetMs = Number.isFinite(options.callBudgetMs)
    ? Math.max(0, Math.floor(options.callBudgetMs))
    : INSIGHTS_LLM_CALL_BUDGET_MS;
  const retryDelayMs = Number.isFinite(options.retryDelayMs)
    ? Math.max(0, Math.floor(options.retryDelayMs))
    : INSIGHTS_LLM_RETRY_BASE_MS;
  const budgetStartedAtMs = Date.now();
  const usableBudgetMs = () => Math.max(0, budgetStartedAtMs + callBudgetMs - Date.now() - INSIGHTS_LLM_CALL_BUDGET_GUARD_MS);

  // llm_call telemetry (#4944 U5): one event per provider OUTCOME (the
  // withRetry duration covers in-provider retries), unified with the
  // Vercel-side stream via scripts/lib/llm-telemetry.cjs.
  const promptChars = (systemPrompt?.length ?? 0) + (userPrompt?.length ?? 0);
  const events = [];
  let attemptIndex = 0;

  // #6001: the chain used to fall through on TRANSPORT failures only. A model
  // that reliably returns well-formed text the brief composer then rejects on
  // its editorial gates would strand the run on `degraded` forever without
  // ever trying a fallback model that passes — measured against a live digest,
  // the primary composed 2/6 while the fallback composed 6/6, yet only the
  // primary was ever asked. `accept` lets the caller veto a response and keep
  // the chain moving. When every provider is vetoed we return the LAST
  // response rather than null, so the caller still classifies the failure by
  // its real stage (parse/gate) instead of mislabelling it a provider outage.
  // Keep the FIRST rejection, not the last: the caller classifies the failure
  // stage from this response, and the primary model's stage is the actionable
  // one. A candidate whose acceptor THREW is held separately and only used if
  // nothing was cleanly rejected — handing back text the caller's own gate
  // chokes on would just move the fault downstream.
  const accept = typeof options.accept === 'function' ? options.accept : null;
  let firstRejected = null;
  let firstFaulted = null;
  const rejectedResult = () => firstRejected ?? firstFaulted;

  // A gate rejection is not evidence that the PROVIDER is unhealthy — it says
  // this SAMPLE was unusable. Advancing on it demotes the chain to a weaker
  // model, which is less likely to produce a grounded lead than a second sample
  // from the stronger one, so the strictness of an editorial gate was buying
  // worse published prose.
  //
  // Measured on seed-insights 2026-08-20 before this change: of 9 gate
  // rejections, the fallback rescued 2 and the other 7 reached the
  // single-headline brief anyway, while 5 of 14 shipped briefs came from
  // google/gemma-4-26b-a4b-it:free rather than deepseek-v4-flash. So the
  // demotion mostly did not save the run, and when it did it shipped the weaker
  // writer.
  //
  // Resample the SAME provider once, then fall through to the rest of the chain
  // exactly as before. Transport failures still advance immediately — withRetry
  // already covers transient ones, and a provider that is genuinely down should
  // not be asked twice.
  const queue = [...LLM_PROVIDERS];
  const resampled = new Set();
  while (queue.length > 0) {
    const provider = queue.shift();
    // The resample above is only a retry if the second draw CAN differ. At the
    // near-greedy temperature the first draw uses, asking the same provider for
    // the same prompt returns the sample its gate just rejected — so the run
    // spent a call, a rate-limit slot and the budget to be refused identically,
    // then demoted anyway. Observed 2026-09-01: seven consecutive cycles
    // rejected on the same lead, news:insights frozen for three hours. Widen
    // the temperature for that attempt only; the first draw stays as it was.
    const isResample = resampled.has(provider.name);
    const envVal = process.env[provider.envKey];
    if (!envVal) continue;

    const apiUrl = provider.apiUrlFn ? provider.apiUrlFn(envVal) : provider.apiUrl;
    const model = typeof provider.model === 'function' ? provider.model() : provider.model;
    const t0 = Date.now();
    const record = (ok, extra = {}) => {
      events.push(buildLlmCallEvent({
        provider: provider.name, model, stage: 'seed-insights', ok,
        durationMs: Date.now() - t0, promptChars, maxTokens,
        fallbackIndex: attemptIndex++,
        ...extra,
      }));
    };

    try {
      const resp = await withRetry(async () => {
        const usable = usableBudgetMs();
        if (usable <= 0) throw createLlmBudgetError('insights llm budget exhausted');
        const response = await insightsFetch(apiUrl, {
          method: 'POST',
          headers: provider.headers(envVal),
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            max_tokens: maxTokens,
            temperature: isResample ? INSIGHTS_RESAMPLE_TEMPERATURE : INSIGHTS_TEMPERATURE,
            ...provider.extraBody,
          }),
          signal: AbortSignal.timeout(Math.max(1, Math.min(provider.timeout, usable))),
        });
        if (!response.ok) {
          // #6110: `usableBudgetMs()` is a real remaining wall clock, so pass it
          // as `remainingBudgetMs` — a hint longer than that (groq's daily-quota
          // 429 asks for ~20 minutes) makes the error nonRetryable and we fall
          // through to the next provider immediately, instead of clamping the
          // hint to the ceiling and sleeping it away twice.
          throw httpRetryError(response, {
            maxRetryAfterMs: INSIGHTS_LLM_RETRY_AFTER_MAX_MS,
            remainingBudgetMs: usableBudgetMs(),
          });
        }
        return response;
      }, provider.maxRetries ?? INSIGHTS_LLM_MAX_RETRIES, retryDelayMs);

      const json = await resp.json();
      const usage = {
        tokensTotal: json.usage?.total_tokens ?? 0,
        tokensPrompt: json.usage?.prompt_tokens ?? 0,
        tokensCompletion: json.usage?.completion_tokens ?? 0,
      };
      const rawText = json.choices?.[0]?.message?.content?.trim();
      if (!rawText) {
        console.warn(`  ${provider.name}: empty response`);
        record(false, { ...usage, reason: 'empty' });
        continue;
      }

      const text = stripReasoningPreamble(rawText)
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<\|thinking\|>[\s\S]*?<\|\/thinking\|>/gi, '')
        .replace(/<think>[\s\S]*/gi, '')
        .trim();

      if (text.length < 20) {
        console.warn(`  ${provider.name}: output too short (${text.length} chars)`);
        record(false, { ...usage, reason: 'too_short' });
        continue;
      }

      const candidate = { text, model: json.model || model, provider: provider.name };

      if (accept) {
        let accepted = null;
        let faulted = false;
        try {
          accepted = accept(text);
        } catch (acceptErr) {
          // A faulty acceptor must never mark unvalidated output as good.
          faulted = true;
          console.warn(`  ${provider.name}: output acceptor threw (${acceptErr.message})`);
        }
        if (!accepted) {
          if (!faulted) console.warn(`  ${provider.name}: output rejected by caller gates`);
          // `validate_reject` is the shared vocabulary from server/_shared/usage.ts,
          // so these unify with the Vercel-side llm_call stream in one query.
          record(false, { ...usage, model: json.model || model, reason: 'validate_reject' });
          if (faulted) { if (!firstFaulted) firstFaulted = candidate; }
          else if (!firstRejected) firstRejected = candidate;
          // One resample before demoting (see the queue comment above). A
          // FAULTED acceptor is excluded deliberately: that fault is in our own
          // gate, not in the sample, so a second identical call would throw
          // identically and only burn budget.
          if (!faulted && !resampled.has(provider.name)) {
            resampled.add(provider.name);
            queue.unshift(provider);
            console.warn(`  ${provider.name}: resampling once before falling back to a weaker model`);
          }
          continue;
        }
      }

      record(true, { ...usage, model: json.model || model });
      void emitLlmEvents(events); // fire-and-forget: telemetry never delays the return path
      return candidate;
    } catch (err) {
      console.warn(`  ${provider.name} failed: ${err.message}`);
      const httpMatch = /HTTP (\d{3})/.exec(err.message || '');
      record(false, {
        reason: isLlmBudgetError(err) ? 'budget_exhausted'
          : err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout'
          : httpMatch ? `http_${httpMatch[1]}`
          : 'fetch_error',
      });
      // Budget spent — give up rather than burning the next provider's timeout.
      if (isLlmBudgetError(err)) {
        void emitLlmEvents(events); // fire-and-forget: telemetry never delays the return path
        return rejectedResult();
      }
    }
  }

  void emitLlmEvents(events); // fire-and-forget: telemetry never delays the return path
  return rejectedResult();
}

function categorizeStory(title) {
  const lower = (title || '').toLowerCase();
  const categories = [
    { keywords: ['war', 'attack', 'missile', 'troops', 'airstrike', 'combat', 'military'], cat: 'conflict', threat: 'critical' },
    { keywords: ['killed', 'dead', 'casualties', 'massacre', 'shooting'], cat: 'violence', threat: 'high' },
    { keywords: ['protest', 'uprising', 'riot', 'unrest', 'coup'], cat: 'unrest', threat: 'high' },
    { keywords: ['sanctions', 'tensions', 'escalation', 'threat'], cat: 'geopolitical', threat: 'elevated' },
    { keywords: ['crisis', 'emergency', 'disaster', 'collapse'], cat: 'crisis', threat: 'high' },
    { keywords: ['earthquake', 'flood', 'hurricane', 'wildfire', 'tsunami'], cat: 'natural_disaster', threat: 'elevated' },
    { keywords: ['election', 'vote', 'parliament', 'legislation'], cat: 'political', threat: 'moderate' },
    { keywords: ['market', 'economy', 'trade', 'tariff', 'inflation'], cat: 'economic', threat: 'moderate' },
  ];

  for (const { keywords, cat, threat } of categories) {
    if (keywords.some(kw => lower.includes(kw))) {
      return { category: cat, threatLevel: threat };
    }
  }
  return { category: 'general', threatLevel: 'moderate' };
}

function normalizedSignalText(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function clusterHasDiplomacySignal(cluster) {
  const titles = Array.isArray(cluster.memberTitles) && cluster.memberTitles.length > 0
    ? cluster.memberTitles
    : [cluster.primaryTitle];
  return titles.some((title) => {
    const text = normalizedSignalText(title);
    return DIPLOMACY_KEYWORDS.some((kw) => text.includes(kw)) ||
      ENTITY_BIGRAMS.some(([entity, action]) => text.includes(entity) && text.includes(action));
  });
}

function percentile(sortedNumbers, pct) {
  if (sortedNumbers.length === 0) return 0;
  const idx = Math.min(sortedNumbers.length - 1, Math.floor((sortedNumbers.length - 1) * pct));
  return sortedNumbers[idx];
}

function buildImportanceObservability(clusters, topStories) {
  const clusterSizes = clusters.map(c => Number(c.sourceCount) || 1).sort((a, b) => a - b);
  return {
    llmDrivenRanked: topStories.filter(s => s.threat?.source === 'llm').length,
    keywordFallbackRanked: topStories.filter(s => s.threat?.source !== 'llm' && !s.upstreamImportanceScore).length,
    diplomacyHits: clusters.filter(clusterHasDiplomacySignal).length,
    corroborationHits: clusters.filter(c => c.entityCorroboration === true).length,
    clusterSizeP50: percentile(clusterSizes, 0.5),
    clusterSizeP90: percentile(clusterSizes, 0.9),
  };
}

async function warmDigestCache(language = 'en') {
  const apiBase = process.env.API_BASE_URL || 'https://api.worldmonitor.app';
  const headers = {
    'User-Agent': CHROME_UA,
    Origin: 'https://worldmonitor.app',
  };
  if (RELAY_API_KEY) headers['X-WorldMonitor-Key'] = RELAY_API_KEY;
  try {
    const resp = await fetch(`${apiBase}/api/news/v1/list-feed-digest?variant=full&lang=${encodeURIComponent(language)}`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (resp.ok) console.log(`  ${language} digest cache warmed via RPC`);
    else {
      const keyNote = RELAY_API_KEY ? '' : ' (WORLDMONITOR_RELAY_KEY not set — Origin-only auth)';
      console.warn(`  Digest warm failed: HTTP ${resp.status}${keyNote}`);
    }
  } catch (err) {
    console.warn(`  Digest warm failed: ${err.message}`);
  }
}

// Readback schedule after a cache warm: 3s, then 3s, then 5s. Bounded at ~11s
// so a genuinely missing digest still fails fast enough for the caller's own
// retry loop to matter.
const DIGEST_READBACK_BACKOFF_MS = [3_000, 3_000, 5_000];

async function readOrWarmDigest(language) {
  const key = digestKeyForLanguage(language);
  let digest = await readDigestFromRedis(key);
  if (digest) return digest;
  console.log(`  ${language} digest not in Redis, warming cache via RPC...`);
  await warmDigestCache(language);
  // Poll for the Edge write rather than guessing at it. The old fixed 3s wait
  // was a guess about propagation, and on 2026-09-01 the warm itself took 20
  // seconds — the readback then landed on a key the write had not finished
  // settling, and the run was lost. Same total patience as before in the happy
  // case, because the first poll fires at 3s and usually succeeds.
  for (const waitMs of DIGEST_READBACK_BACKOFF_MS) {
    await new Promise((r) => setTimeout(r, waitMs));
    digest = await readDigestFromRedis(key);
    if (digest) return digest;
  }
  return null;
}

async function readChinaNewsDigest() {
  try {
    return await readOrWarmDigest(CHINA_NEWS_DIGEST_LANGUAGE);
  } catch (err) {
    // China-source coverage must degrade independently. A Redis or Edge
    // failure for the supplemental locale digest must not suppress the global
    // insights payload that the existing English path can still publish.
    console.warn(`  ${CHINA_NEWS_DIGEST_LANGUAGE} digest coverage check failed: ${err.message}`);
    return null;
  }
}

// A degraded global brief may reuse the last known-good public payload even
// though this run obtained fresh per-source digest evidence. Keep that audit
// projection attached for afterPublish; publishTransform still prevents it
// from entering the public insights cache.
export function preserveChinaNewsCoverageInLkg(existing, chinaNewsCoverage) {
  return chinaNewsCoverage ? { ...existing, chinaNewsCoverage } : existing;
}

export function normalizeDigestItemsForInsights(items) {
  return items.map(item => ({
    title: sanitizeTitle(item.title || item.headline || ''),
    source: item.source || item.feed || '',
    link: item.link || item.url || '',
    pubDate: item.pubDate || item.publishedAt || item.date || new Date().toISOString(),
    isAlert: item.isAlert || false,
    tier: item.tier,
    threat: normalizeThreat(item.threat),
    importanceScore: item.importanceScore,
    ...(Number.isFinite(item.credibilityScore) ? { credibilityScore: item.credibilityScore } : {}),
    corroborationCount: item.corroborationCount ?? item.storyMeta?.sourceCount,
    storyMeta: item.storyMeta,
  })).filter(item => item.title.length > 10);
}

async function fetchInsights() {
  const digest = await readOrWarmDigest('en');
  if (!digest) {
    // LKG fallback: reuse existing insights if digest is unavailable
    const existing = await readExistingInsights();
    if (existing?.topStories?.length) {
      console.log('  Digest unavailable — reusing existing insights (LKG)');
      return decorateInsightsRun(existing, {
        outcome: INSIGHTS_RUN_OUTCOMES.LKG_PRESERVED,
        failureCode: INSIGHTS_SYNTHESIS_FAILURE_CODES.PROVIDER,
      });
    }
    throw new Error('No news digest found in Redis');
  }

  // The global top-eight list is intentionally rank-limited and cannot prove
  // that a China source completed. Preserve the digest's per-feed outcome as
  // a compact, audit-only projection before the global ranking can discard it.
  const chinaNewsCoverage = buildChinaNewsCoverage({
    en: digest,
    [CHINA_NEWS_DIGEST_LANGUAGE]: await readChinaNewsDigest(),
  });

  // Digest shape: { categories: { politics: { items: [...] }, ... }, feedStatuses, generatedAt }
  let items;
  if (Array.isArray(digest)) {
    items = digest;
  } else if (digest.categories && typeof digest.categories === 'object') {
    items = [];
    for (const bucket of Object.values(digest.categories)) {
      if (Array.isArray(bucket.items)) items.push(...bucket.items);
    }
  } else {
    items = digest.items || digest.articles || digest.headlines || [];
  }

  if (items.length === 0) {
    const keys = typeof digest === 'object' && digest !== null ? Object.keys(digest).join(', ') : typeof digest;
    throw new Error(`Digest has no items (shape: ${keys})`);
  }

  console.log(`  Digest items: ${items.length}`);

  const normalizedItems = normalizeDigestItemsForInsights(items);

  const clusters = clusterItems(normalizedItems);
  console.log(`  Clusters: ${clusters.length}`);

  // #4920 coverage ledger: capture what the selection gates dropped.
  const selectionStats = {};
  const topStories = selectTopStories(clusters, 8, selectionStats);
  console.log(`  Top stories: ${topStories.length}`);
  const observability = buildImportanceObservability(clusters, topStories);
  console.log(
    `  Importance signals: llm=${observability.llmDrivenRanked} ` +
      `keywordFallback=${observability.keywordFallbackRanked} ` +
      `diplomacy=${observability.diplomacyHits} ` +
      `entityCorroboration=${observability.corroborationHits} ` +
      `clusterSizeP50=${observability.clusterSizeP50} ` +
      `clusterSizeP90=${observability.clusterSizeP90}`,
  );

  if (topStories.length === 0) throw new Error('No top stories after scoring');

  // Corroboration gate: only brief a story at least two outlets have reported.
  // See pickBriefCluster() in _insights-brief.mjs for rationale + unit tests.
  // Note: this gates ONLY brief generation — the topStories payload itself
  // continues to include single-source clusters, rendered as the headline list
  // under the brief. The brief paragraph is the one surface where corroboration
  // matters; the list is already visually marked with per-story sourceCount.
  // #4921/#4928: L1 = top-8 synthesis via the pure composer (parse +
  // corroboration gate + lead noun/anchor gates + per-line enforcement +
  // citation verification + index-locked sources — all unit-tested in
  // _insights-brief.mjs). L2 = legacy single-headline brief. Degraded last.
  // The brief always ships.
  let worldBrief = '';
  let briefProvider = '';
  let briefModel = '';
  let briefStoryLines = [];
  let worldBriefSources = [];
  let status = 'ok';
  let synthesisFailureCode = null;

  const briefCluster = pickBriefCluster(topStories);
  const hasBriefCluster = briefCluster != null;
  // #5947: a MISSING_CLUSTER rejection is only legitimate when the corpus had
  // nothing corroborated to lead with. Log the corpus count (and whether the
  // reservation had to fire) so a recurrence is diagnosable from the run log
  // and seed-meta alone.
  // Do NOT default to 0 here: 0 is the meaningful value "the corpus had nothing
  // corroborated to lead with". Substituting it for absent stats would make a
  // telemetry failure read exactly like a benign bare-corpus run.
  const briefEligibleClusters = typeof selectionStats.briefEligibleConsidered === 'number'
    ? selectionStats.briefEligibleConsidered
    : null;
  if (selectionStats.briefEligiblePromoted) {
    console.log(
      `  Brief lead reserved: promoted a corroborated cluster into top-${topStories.length} ` +
        `(${briefEligibleClusters ?? 'unknown'} eligible in corpus, source=${briefCluster?.primarySource ?? 'unknown'})`,
    );
  } else if (!hasBriefCluster) {
    console.warn(`  [brief_synthesis] no corroborated cluster in corpus (eligible=${briefEligibleClusters ?? 'unknown'})`);
  }
  // The acceptance gate is the composer itself (#6001), so the chain can never
  // accept output the composer would later reject.
  const synthesisComposerOptions = {
    briefCluster,
    validatorMode: BRIEF_VALIDATOR_MODE,
    sanitizeTitle,
    sourceFromStory: briefSourceFromStory,
  };
  const composeFromText = (text) =>
    composeInsightsSynthesis(text, topStories, synthesisComposerOptions).brief;

  // #6001: L1 may now walk the whole provider chain, and L2 below makes a
  // SECOND callLLM. Stamp the run's LLM start so L2 gets only the remainder —
  // otherwise two full 60s budgets could outlast the 120s seed lock.
  const llmRunStartedAtMs = Date.now();
  const synthesisResult = hasBriefCluster
    ? await callLLM(null, {
        systemPrompt: synthesisSystemPrompt(new Date().toISOString().split('T')[0]),
        userPrompt: synthesisUserPrompt(topStories),
        maxTokens: 900,
        // A model whose output trips the editorial gates must not strand the
        // run. callLLM resamples this model once before demoting to a weaker
        // one, so a single unusable sample no longer costs the better writer.
        accept: composeFromText,
      })
    : null;
  const { composed, failureCode, failureDetail } = resolveInsightsSynthesis({
    synthesisResult,
    topStories,
    ...synthesisComposerOptions,
  });
  synthesisFailureCode = failureCode;

  if (composed) {
    worldBrief = composed.lead;
    briefStoryLines = composed.lines;
    worldBriefSources = composed.sources;
    briefProvider = synthesisResult.provider;
    briefModel = synthesisResult.model;
    if (composed.strippedCitations > 0) {
      console.warn(`  [brief_citation ENFORCE] stripped ${composed.strippedCitations} out-of-range citation(s)`);
    }
    if (composed.hallucinatedLines > 0) {
      console.warn(`  [brief_hallucination ${BRIEF_VALIDATOR_MODE.toUpperCase()}] ${composed.hallucinatedLines}/${topStories.length} synthesis lines flagged`);
    }
    if (composed.droppedLeadSentences > 0) {
      // #6521: a lead sentence that fails a gate is now dropped rather than
      // costing the whole brief, so this counter is the ONLY signal that a gate
      // fired on the lead at all — the run no longer reports a rejection. A
      // brief that quietly sheds a sentence every tick is a prompt or corpus
      // problem; without this it looks like a clean run. The offending text is
      // deliberately not logged (these reach seed-meta and Railway logs).
      console.warn(`  [brief_lead_drop ${BRIEF_VALIDATOR_MODE.toUpperCase()}] dropped ${composed.droppedLeadSentences} ungrounded lead sentence(s); published the rest`);
    }
    if (composed.sourceAttributions > 0) {
      // Accept-side counterpart to the `validate_reject` reason below: how many
      // lead sentences named their own outlet. Only the reject path was ever
      // reported, so a quiet alarm could not be told apart from a gate that had
      // started accepting too much. A count is enough to see that — the reason
      // vocabulary stays a bounded literal on purpose (these reach seed-meta and
      // Railway logs, where the payload may be sensitive), so no offending text
      // is logged here either.
      console.log(`  [brief_attribution] ${composed.sourceAttributions} lead sentence(s) named their source outlet`);
    }
    console.log(`  Brief synthesized (top-${topStories.length}) via ${briefProvider} (${briefModel})`);
  } else {
    console.warn(
      `  [brief_synthesis] rejected (${synthesisFailureCode || INSIGHTS_SYNTHESIS_FAILURE_CODES.PROVIDER})`
      + `${failureDetail ? ` on "${failureDetail}"` : ''} — `
      + 'falling back to single-headline brief',
    );
    const legacy = await generateLegacySingleHeadlineBrief(topStories, {
      callBudgetMs: Math.max(0, INSIGHTS_LLM_CALL_BUDGET_MS - (Date.now() - llmRunStartedAtMs)),
    });
    worldBrief = legacy.worldBrief;
    briefProvider = legacy.briefProvider;
    briefModel = legacy.briefModel;
    worldBriefSources = legacy.worldBriefSources;
    // A usable L2 headline must not clear an L1 synthesis failure. Keep this
    // run degraded so an existing LKG remains the freshness anchor and the
    // bounded failure metadata advances until L1 publishes successfully.
    status = resolveInsightsFallbackStatus({
      synthesisFailureCode,
      legacyStatus: legacy.status,
      // Read here rather than at the preservation branch below: the decision
      // this feeds is whether the fallback may keep its own status at all, and
      // that has to be made before the branch can be reached.
      lkgAgeMs: insightsLkgAgeMs(await readExistingInsights().catch(() => null)),
    });
  }

  // #6428: "multi-source" is a claim about publishers. Counting c.sources
  // counted feed labels, so a cluster carried only by one newsroom's own
  // editions was published as multi-source. clusterItems already resolved the
  // families onto the cluster — read it rather than recomputing.
  const multiSourceCount = clusters.filter(
    c => (c.uniquePublisherCount ?? 0) >= MIN_CORROBORATING_PUBLISHERS
      || c.entityCorroboration === true,
  ).length;
  const fastMovingCount = 0; // velocity not available in digest items

  const enrichedStories = topStories.map(story => {
    // Use digest threat when present and not keyword-sourced (keyword threat uses old taxonomy).
    // Fall back to categorizeStory() for legacy/incomplete payloads.
    const hasDigestThreat = story.threat?.level && story.threat?.source !== 'keyword';
    const { category, threatLevel } = hasDigestThreat
      ? { category: story.threat.category ?? 'general', threatLevel: story.threat.level }
      : categorizeStory(story.primaryTitle);
    const countryCode = extractCountryCode(story.primaryTitle) ?? null;
    return {
      primaryTitle: story.primaryTitle,
      primarySource: story.primarySource,
      primaryLink: story.primaryLink,
      pubDate: story.pubDate,
      sourceCount: story.sourceCount,
      // #6428: uniqueSourceCount is the corroboration breadth number every
      // consumer (InsightsPanel badge, MCP get_news_intelligence) quotes back
      // to a user, so it counts PUBLISHERS. `sources` stays the label list —
      // it is what the UI credits and links, and collapsing it would drop
      // attribution the publisher is owed.
      uniqueSourceCount: story.uniquePublisherCount ?? 0,
      sources: Array.isArray(story.sources) ? story.sources : [],
      lastUpdated: story.lastUpdated,
      memberTitles: Array.isArray(story.memberTitles) ? story.memberTitles : [story.primaryTitle],
      sourceTier: story.sourceTier,
      upstreamImportanceScore: story.upstreamImportanceScore,
      entityCorroboration: story.entityCorroboration === true,
      corroborationSourceCount: story.corroborationSourceCount ?? 0,
      importanceScore: story.importanceScore,
      effectiveImportanceScore: story.effectiveImportanceScore,
      ...(Number.isFinite(story.credibilityScore) ? { credibilityScore: story.credibilityScore } : {}),
      velocity: { level: 'normal', sourcesPerHour: 0 },
      isAlert: story.isAlert,
      category,
      threatLevel,
      countryCode,
    };
  });

  // #4920: user-facing provenance — "compiled from N stories across M
  // sources" — plus the selection-gate drop counts. Read by
  // insights-loader/InsightsPanel; no proto involved (plain Redis JSON).
  const provenance = {
    storiesConsidered: normalizedItems.length,
    sourcesConsidered: new Set(normalizedItems.map(item => item.source).filter(Boolean)).size,
    selectionDrops: {
      admissibility: selectionStats.admissibilityDropped ?? 0,
      sourceCap: selectionStats.sourceCapDropped ?? 0,
      overflow: selectionStats.overflowDropped ?? 0,
    },
  };
  console.log(
    `  Provenance: ${provenance.storiesConsidered} stories / ${provenance.sourcesConsidered} sources; ` +
      `drops adm=${provenance.selectionDrops.admissibility} srcCap=${provenance.selectionDrops.sourceCap} overflow=${provenance.selectionDrops.overflow}`,
  );

  // #4921 staleness footer: the age window of the BRIEF'S OWN material —
  // the top stories the synthesis cites — not the whole digest pool
  // (#4928 external review: an unrelated fresh item made the footer claim
  // the brief's sources were fresher than they are).
  const pubTimes = topStories
    .map(story => new Date(story.pubDate).getTime())
    .filter(Number.isFinite);
  const sourceAgeRange = pubTimes.length > 0
    ? { newestMs: Math.max(...pubTimes), oldestMs: Math.min(...pubTimes) }
    : null;

  const payload = {
    worldBrief,
    briefStoryLines,
    sourceAgeRange,
    worldBriefSources,
    briefProvider,
    briefModel,
    status,
    topStories: enrichedStories,
    generatedAt: new Date().toISOString(),
    clusterCount: clusters.length,
    multiSourceCount,
    fastMovingCount,
    importanceSignals: observability,
    provenance,
    chinaNewsCoverage,
  };

  // LKG preservation: don't overwrite "ok" with "degraded"
  if (status === 'degraded') {
    const existing = await readExistingInsights();
    if (existing?.status === 'ok') {
      console.log('  LKG preservation: existing payload is "ok", skipping degraded overwrite');
      return decorateInsightsRun(
        preserveChinaNewsCoverageInLkg(existing, chinaNewsCoverage),
        {
          outcome: INSIGHTS_RUN_OUTCOMES.LKG_PRESERVED,
          failureCode: synthesisFailureCode || INSIGHTS_SYNTHESIS_FAILURE_CODES.PROVIDER,
          briefEligibleClusters,
        },
      );
    }
  }

  return decorateInsightsRun(payload, {
    outcome: status === 'ok' ? INSIGHTS_RUN_OUTCOMES.PUBLISHED : INSIGHTS_RUN_OUTCOMES.DEGRADED,
    failureCode: synthesisFailureCode,
    briefEligibleClusters,
  });
}

export function declareRecords(data) {
  return Array.isArray(data?.topStories) ? data.topStories.length : 0;
}

async function writeInsightsChinaCoverage(data) {
  if (!data?.chinaNewsCoverage) {
    // LKG fallback predates the projection. Keep its timestamp honest: an
    // extended old projection will become CONTENT_STALE rather than green.
    await extendExistingTtl([CHINA_COVERAGE_KEY], CACHE_TTL);
    return;
  }
  await writeExtraKey(CHINA_COVERAGE_KEY, data.chinaNewsCoverage, CACHE_TTL);
}

/**
 * Project a decorated run's non-serialized metadata onto the freshness-patch
 * inputs. Exported so the run-meta -> seed-meta seam is unit-testable without
 * Redis I/O: a source-text guard over finalizeInsightsRun would still pass
 * with the wiring cut, so the mapping lives here as a pure function instead.
 */
export function insightsFreshnessPatchArgs(data, outcome, previousMeta, nowMs = Date.now()) {
  const runMeta = insightsRunMeta(data);
  return {
    previousMeta,
    outcome,
    failureCode: runMeta?.failureCode,
    nowMs,
    servedGeneratedAt: data?.generatedAt,
    briefEligibleClusters: runMeta?.briefEligibleClusters ?? null,
  };
}

async function finalizeInsightsRun(data, outcome, { previousMeta } = {}) {
  const [resolvedPreviousMeta] = await Promise.all([
    previousMeta === undefined
      ? readExistingSeedMeta('news', 'insights')
      : Promise.resolve(previousMeta),
    writeInsightsChinaCoverage(data),
  ]);
  return {
    freshnessMetaPatch: buildInsightsFreshnessMetaPatch(
      insightsFreshnessPatchArgs(data, outcome, resolvedPreviousMeta, Date.now()),
    ),
  };
}

/**
 * Tell iOS devices a fresh AI World Brief is up.
 *
 * Swallows everything: this cron's job is to publish a brief, and a push
 * failure must never turn a good brief into a failed run. The notifier itself
 * is disarmed unless BRIEF_PUSH_ENABLED=1 and dry-run unless
 * BRIEF_PUSH_DRY_RUN=0, so importing it costs nothing until it is configured.
 * See scripts/lib/brief-push.cjs.
 */
export async function announceBriefPublished(data) {
  try {
    if (process.env.BRIEF_PUSH_ENABLED !== '1') return { action: 'disabled' };
    const creds = getRedisCredentials();
    if (!creds) return { action: 'disabled', reason: 'no Redis' };
    const { url, token } = creds;
    const notifier = briefPush.createBriefPushNotifier({
      env: process.env,
      redis: {
        // Upstash answers "OK" for a fresh key and null for an existing one;
        // anything else (a thrown fetch, an error body) is reported as 'error'
        // so the notifier's fail-closed guard suppresses rather than sends.
        setNx: async (key, value, ttl) => {
          try {
            const res = await redisCommand(url, token, ['SET', key, value, 'NX', 'EX', String(ttl)]);
            if (res === 'OK') return 'new';
            if (res === null) return 'duplicate';
            return 'error';
          } catch {
            return 'error';
          }
        },
        del: (key) => redisCommand(url, token, ['DEL', key]),
      },
      log: console,
    });
    return await notifier.notifyPublished({ generatedAt: data?.generatedAt });
  } catch (err) {
    console.warn('  [BriefPush] skipped:', err?.message || err);
    return { action: 'error', reason: err?.message || String(err) };
  }
}

export { callLLM, __setInsightsLlmTransportForTests };

if (_isDirectRun) {
  runSeed('news', 'insights', CANONICAL_KEY, fetchInsights, {
    validateFn: validateInsightsPayload,
    ttlSeconds: CACHE_TTL,
    sourceVersion: INSIGHTS_SOURCE_VERSION,

    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 30,
    // The source-status projection is not user-facing digest content. It is
    // retained separately so the China audit can distinguish an unavailable
    // source from a globally outranked one without changing the public payload.
    preserveKeys: [CHINA_COVERAGE_KEY],
    publishTransform: publishInsightsPayload,
    afterPublish: async (data) => {
      const runMeta = insightsRunMeta(data);
      const outcome = runMeta?.outcome === INSIGHTS_RUN_OUTCOMES.PUBLISHED
        ? INSIGHTS_RUN_OUTCOMES.PUBLISHED
        : INSIGHTS_RUN_OUTCOMES.DEGRADED;
      // Only a real publish is worth announcing. A DEGRADED run means the
      // synthesis failed and the card is thinner than usual, and an
      // LKG_PRESERVED run never reaches here at all — telling users a brief
      // refreshed when it did not is worse than staying silent.
      if (outcome === INSIGHTS_RUN_OUTCOMES.PUBLISHED) {
        await announceBriefPublished(data);
      }
      return finalizeInsightsRun(data, outcome);
    },
    afterValidationSkip: async (data, context) => {
      return finalizeInsightsRun(data, INSIGHTS_RUN_OUTCOMES.LKG_PRESERVED, {
        previousMeta: context.existingSeedMeta,
      });
    },
  }).catch(async (err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
    // Exit gracefully for cron — health endpoint flags stale data via
    // seed-meta. process.exit does not drain in-flight promises — flush
    // llm_call telemetry first (bounded by the 1.5s fetch timeout).
    await flushPendingLlmEvents();
    process.exit(0);
  });
}
