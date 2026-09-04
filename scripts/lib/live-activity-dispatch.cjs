'use strict';

/**
 * Live Activity dispatcher — decides WHEN to push (start / update / end) for
 * CRITICAL news alerts detected by scripts/ais-relay.cjs, and keeps that
 * decision durable in Redis so a relay restart never re-fires a start.
 *
 * Redis layout (keys are shared verbatim with api/live-activity/register.js —
 * deliberately NOT prefixed with RELAY_ENV, the Vercel route writes them):
 *
 *   live-activity:push-to-start:v1            ZSET  token -> registeredAt ms
 *   live-activity:update:v1:<alertId>         HASH  token -> registeredAt ms
 *   live-activity:started:v1:<alertId>        STRING (SET NX, 6h) start dedupe
 *   live-activity:active:v1                   STRING JSON of the ONE active alert
 *
 * Rules (see docs/live-activity-push.md):
 *   - A critical alert that has not been started (no dedupe marker, no update
 *     tokens) and was published within the start window -> push-to-start to
 *     every registered push-to-start token. At most ONE active alert: starting
 *     a new one ends the previous one first.
 *   - The active alert gaining more related reports -> update to its update
 *     tokens (registered by the iOS app once the activity is running).
 *   - sweep(): end after LIVE_ACTIVITY_MAX_ACTIVE_MS, or when the alert has not
 *     been observed as critical for LIVE_ACTIVITY_STALE_MS ("no longer critical").
 *
 * Every public method resolves — never rejects — so the relay hook stays a
 * one-liner. Failures are logged and reported in the returned `action`.
 */

const { createHash } = require('node:crypto');
const { buildContentState, deriveAlertId, maskToken } = require('./apns-live-activity.cjs');

const KEY_PUSH_TO_START = 'live-activity:push-to-start:v1';
const KEY_ACTIVE = 'live-activity:active:v1';
const KEY_UPDATE_PREFIX = 'live-activity:update:v1:';
const KEY_STARTED_PREFIX = 'live-activity:started:v1:';
const KEY_LANG = 'live-activity:lang:v1';
const KEY_LAST_START = 'live-activity:last-start:v1';
// Mirrors TITLE_MAX_CHARS in apns-live-activity.cjs: a translated headline is
// subject to the same payload budget as the English one.
const TRANSLATED_TITLE_MAX_CHARS = 200;

const LIVE_ACTIVITY_MAX_ACTIVE_MS = 4 * 60 * 60 * 1000;
const LIVE_ACTIVITY_STALE_MS = 60 * 60 * 1000;
const LIVE_ACTIVITY_START_WINDOW_MS = 60 * 60 * 1000;
// Minimum spacing between two STARTS. Nothing else in this file limits how
// often a new activity may be raised, and the identity is the headline hash —
// so one story carried by four outlets under four wordings is four alerts, and
// they arrive in the same second. Observed 2026-09-01: 24 starts in 15 hours,
// three of them inside two seconds, on devices that cannot dismiss any of them
// (see the `end sent to 0/0 update tokens` lines — a push-started activity only
// becomes endable if the app happened to be running). They stack until iOS
// stops accepting new ones, and the reader sees nothing further.
//
// A time gate bounds that without needing to decide which headlines are the
// same story, which is the harder problem and the one that can merge two real
// events by mistake. A held story is not consumed: no dedupe marker is written
// for it, so it competes again on the next classify pass.
const LIVE_ACTIVITY_START_COOLDOWN_MS = 30 * 60 * 1000;
/**
 * How long a story stays "already started".
 *
 * Was 6h, which meant a story the feed keeps republishing raised a fresh card
 * four times a day. CrisisWatch's Gaza ceasefire piece did exactly that for
 * days. A day and a half covers a story's news cycle without pinning a genuine
 * follow-up: a real development arrives with its own headline and link.
 */
const LIVE_ACTIVITY_STARTED_TTL_S = 36 * 60 * 60;
const LIVE_ACTIVITY_ACTIVE_TTL_S = 5 * 60 * 60;
const PUSH_TO_START_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const END_DISMISSAL_DELAY_S = 30 * 60;
const SEND_CONCURRENCY = 8;

function updateTokensKey(alertId) {
  return `${KEY_UPDATE_PREFIX}${alertId}`;
}

function startedKey(alertId) {
  return `${KEY_STARTED_PREFIX}${alertId}`;
}

/**
 * Second identity for the same story: its article URL.
 *
 * deriveAlertId hashes the headline, which the digest makes stable ACROSS
 * outlets but not across re-wordings of one article. Observed 2026-09-03: one
 * CrisisWatch piece started two cards seven hours apart as "Empty promises:
 * ceasefire in Gaza restarted" and "Hollow Promises: Resetting Gaza's
 * Ceasefire", plus Hebrew and Arabic renderings earlier — four cards, one
 * article. A URL survives every re-wording and every translation.
 *
 * Checked IN ADDITION to the title key, never instead: a link is missing often
 * enough that it cannot be the only identity, and a digest-merged cluster still
 * dedupes correctly on its title.
 */
function startedLinkKey(link) {
  const normalized = String(link || '').trim().toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (!normalized) return '';
  return `${KEY_STARTED_PREFIX}link:${createHash('sha256').update(normalized).digest('hex').slice(0, 24)}`;
}

/**
 * Upstash REST client exposing raw Redis commands. Uses global fetch (Node >= 18)
 * so it also works against the plain-http self-hosted proxy the relay supports.
 */
function createUpstashCommandClient({ url, token, fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const base = String(url || '').replace(/\/$/, '');
  if (!base || !token) throw new Error('createUpstashCommandClient: url and token are required');

  async function pipeline(commands) {
    if (!Array.isArray(commands) || commands.length === 0) return [];
    const resp = await fetchImpl(`${base}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands.map((cmd) => cmd.map((part) => String(part)))),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) throw new Error(`Upstash pipeline HTTP ${resp.status}`);
    const entries = await resp.json();
    if (!Array.isArray(entries) || entries.length !== commands.length) {
      throw new Error('Upstash pipeline returned a malformed response');
    }
    return entries.map((entry, i) => {
      if (entry && typeof entry === 'object' && entry.error) {
        throw new Error(`Upstash ${commands[i][0]} failed: ${entry.error}`);
      }
      return entry?.result ?? null;
    });
  }

  async function command(args) {
    const [result] = await pipeline([args]);
    return result;
  }

  return { command, pipeline };
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

function createLiveActivityDispatcher({
  redis,
  sender,
  // (title, langs) => Promise<Record<lang, translatedTitle>>. Absent (unit
  // tests, a relay with no LLM provider) means everyone keeps the English
  // headline, which is exactly what shipped before.
  translate = null,
  log = console,
  now = Date.now,
  maxActiveMs = LIVE_ACTIVITY_MAX_ACTIVE_MS,
  staleMs = LIVE_ACTIVITY_STALE_MS,
  startWindowMs = LIVE_ACTIVITY_START_WINDOW_MS,
  startCooldownMs = LIVE_ACTIVITY_START_COOLDOWN_MS,
  startedTtlS = LIVE_ACTIVITY_STARTED_TTL_S,
  pushToStartTokenTtlMs = PUSH_TO_START_TOKEN_TTL_MS,
} = {}) {
  if (!redis || typeof redis.command !== 'function' || typeof redis.pipeline !== 'function') {
    throw new TypeError('createLiveActivityDispatcher: redis client with command()/pipeline() is required');
  }
  if (!sender || typeof sender.sendStart !== 'function') {
    throw new TypeError('createLiveActivityDispatcher: sender is required');
  }

  // Serialize observe/sweep/end so two overlapping classify cycles (or a sweep
  // racing an observe) cannot both start an alert or end one twice.
  let chain = Promise.resolve();
  function serialized(task) {
    const run = chain.then(task, task);
    chain = run.catch(() => {});
    return run;
  }

  async function readActive() {
    const raw = await redis.command(['GET', KEY_ACTIVE]);
    if (!raw) return null;
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return parsed && typeof parsed === 'object' && parsed.alertId ? parsed : null;
    } catch {
      return null;
    }
  }

  async function writeActive(record) {
    await redis.command(['SET', KEY_ACTIVE, JSON.stringify(record), 'EX', String(LIVE_ACTIVITY_ACTIVE_TTL_S)]);
  }

  async function listPushToStartTokens() {
    const cutoff = now() - pushToStartTokenTtlMs;
    const [, tokens] = await redis.pipeline([
      ['ZREMRANGEBYSCORE', KEY_PUSH_TO_START, '-inf', String(cutoff)],
      ['ZRANGE', KEY_PUSH_TO_START, '0', '-1'],
    ]);
    return Array.isArray(tokens) ? tokens.filter((t) => typeof t === 'string' && t) : [];
  }

  async function listUpdateTokens(alertId) {
    const tokens = await redis.command(['HKEYS', updateTokensKey(alertId)]);
    return Array.isArray(tokens) ? tokens.filter((t) => typeof t === 'string' && t) : [];
  }

  async function hasUpdateTokens(alertId) {
    const count = await redis.command(['HLEN', updateTokensKey(alertId)]);
    return Number(count) > 0;
  }

  function contentStateFor(record) {
    return buildContentState({
      title: record.title,
      source: record.source,
      location: record.location,
      link: record.link,
      reports: record.reports,
      updatedAt: record.updatedAt || record.startedAtMs,
    }, now());
  }

  const LANG_RE = /^[a-z]{2,3}$/;

  /** token -> ISO 639-1, defaulting to English for anything unregistered. */
  async function langsForTokens(tokens) {
    const byToken = new Map();
    if (tokens.length === 0) return byToken;
    if (typeof translate !== 'function') {
      // Nothing can be translated, so the lookup would only cost a round trip.
      for (const token of tokens) byToken.set(token, 'en');
      return byToken;
    }
    let values = [];
    try {
      values = await redis.command(['HMGET', KEY_LANG, ...tokens]);
    } catch (e) {
      log.warn(`[LiveActivity] lang lookup failed: ${e?.message || e}`);
    }
    tokens.forEach((token, i) => {
      const v = Array.isArray(values) ? values[i] : null;
      byToken.set(token, typeof v === 'string' && LANG_RE.test(v) ? v : 'en');
    });
    return byToken;
  }

  /**
   * One ContentState per token: English on the wire, the headline translated
   * into each language actually registered. One translate call covers them
   * all, and any failure falls back to English rather than dropping the push.
   */
  async function statesByToken(record, tokens) {
    const raw = contentStateFor(record);
    const langByToken = await langsForTokens(tokens);
    // 'en' is a translation TARGET like any other. The raw title is whatever
    // language the source wrote it in — "English on the wire" became a lie the
    // moment a Hebrew feed item was the story, and every token registered 'en'
    // (which today is all of them) received raw Hebrew. One call still covers
    // every language, and an already-English title translates to itself.
    const targets = [...new Set([...langByToken.values(), 'en'])];
    let titles = {};
    if (typeof translate === 'function') {
      try {
        titles = (await translate(raw.title, targets)) || {};
      } catch (e) {
        log.warn(`[LiveActivity] translate failed: ${e?.message || e}`);
      }
    }
    const clamp = (t) => ({ ...raw, title: t.trim().slice(0, TRANSLATED_TITLE_MAX_CHARS) });
    // The English rendering is also the fallback for a language whose own
    // translation failed — English-instead-of-Turkish beats Hebrew-instead-of-
    // Turkish. Raw survives only if even the 'en' translation failed.
    const base = typeof titles.en === 'string' && titles.en.trim() ? clamp(titles.en) : raw;
    const byLang = new Map([['en', base]]);
    for (const lang of targets) {
      if (lang === 'en') continue;
      const t = titles[lang];
      byLang.set(lang, typeof t === 'string' && t.trim() ? clamp(t) : base);
    }
    const out = new Map();
    for (const [token, lang] of langByToken) out.set(token, byLang.get(lang) || base);
    return { base, out };
  }

  async function fanOut(tokens, kind, sendOne, removeOne) {
    const outcomes = await mapWithConcurrency(tokens, SEND_CONCURRENCY, async (token) => {
      let result;
      try {
        result = await sendOne(token);
      } catch (e) {
        result = { ok: false, reason: e?.message || String(e), removeToken: false };
      }
      if (result?.removeToken) {
        try {
          await removeOne(token);
          log.log(`[LiveActivity] removed dead ${kind} token ${maskToken(token)} (${result.reason || result.status})`);
        } catch (e) {
          log.warn(`[LiveActivity] failed to remove ${kind} token ${maskToken(token)}: ${e?.message || e}`);
        }
      }
      return result;
    });
    const sent = outcomes.filter((r) => r?.ok).length;
    const dryRun = outcomes.some((r) => r?.dryRun);
    return { attempted: tokens.length, sent, removed: outcomes.filter((r) => r?.removeToken).length, dryRun };
  }

  async function endRecord(record, reason) {
    const alertId = record.alertId;
    const tokens = await listUpdateTokens(alertId);
    // A superseded alert is replaced on screen the same second; only one that
    // ended on its own is worth leaving up to be read.
    const dismissalDate = Math.floor(now() / 1000) + (reason === 'superseded' ? 0 : END_DISMISSAL_DELAY_S);
    const { base, out: stateByToken } = await statesByToken(record, tokens);
    const stats = await fanOut(
      tokens,
      'update',
      (token) => sender.sendEnd(token, stateByToken.get(token) || base, dismissalDate),
      (token) => redis.pipeline([['HDEL', updateTokensKey(alertId), token], ['HDEL', KEY_LANG, token]]),
    );
    // Only clear the active slot if it still points at this alert.
    const current = await readActive();
    const commands = [['DEL', updateTokensKey(alertId)]];
    if (current && current.alertId === alertId) commands.push(['DEL', KEY_ACTIVE]);
    await redis.pipeline(commands);
    log.log(`[LiveActivity] ended ${alertId} (${reason}) — end sent to ${stats.sent}/${stats.attempted} update tokens${stats.dryRun ? ' [dry-run]' : ''}`);
    return { action: 'ended', alertId, reason, ...stats };
  }

  async function startRecord(record, previous) {
    const alertId = record.alertId;
    if (previous) await endRecord(previous, 'superseded');
    await writeActive(record);
    // Stamped before the fan-out, not after: the send can take seconds across
    // dozens of tokens, and a second alert observed meanwhile must already see
    // the cooldown. TTL is the window itself — an expired key reads as "no
    // recent start", which is exactly what it means.
    await redis.command([
      'SET', KEY_LAST_START, String(now()), 'PX', String(Math.max(1, startCooldownMs)),
    ]);
    const tokens = await listPushToStartTokens();
    const { base, out: stateByToken } = await statesByToken(record, tokens);
    const stats = await fanOut(
      tokens,
      'push-to-start',
      (token) => sender.sendStart(token, { alertId, startedAt: record.startedAt, contentState: stateByToken.get(token) || base }),
      (token) => redis.pipeline([['ZREM', KEY_PUSH_TO_START, token], ['HDEL', KEY_LANG, token]]),
    );
    log.log(`[LiveActivity] started ${alertId} "${base.title.slice(0, 80)}" — push-to-start sent to ${stats.sent}/${stats.attempted} tokens${stats.dryRun ? ' [dry-run]' : ''}`);
    return { action: 'started', alertId, superseded: previous ? previous.alertId : null, ...stats };
  }

  async function updateRecord(record) {
    const alertId = record.alertId;
    await writeActive(record);
    const tokens = await listUpdateTokens(alertId);
    const { base, out: stateByToken } = await statesByToken(record, tokens);
    const stats = await fanOut(
      tokens,
      'update',
      (token) => sender.sendUpdate(token, stateByToken.get(token) || base),
      (token) => redis.pipeline([['HDEL', updateTokensKey(alertId), token], ['HDEL', KEY_LANG, token]]),
    );
    log.log(`[LiveActivity] updated ${alertId} reports=${record.reports} — update sent to ${stats.sent}/${stats.attempted} tokens${stats.dryRun ? ' [dry-run]' : ''}`);
    return { action: 'updated', alertId, reports: record.reports, ...stats };
  }

  /**
   * @param {{ title: string, link?: string, source?: string, location?: string|null, reports?: number, publishedAt?: number }} alert
   */
  function observeCriticalAlert(alert) {
    return serialized(async () => {
      const title = String(alert?.title || '').trim();
      if (!title) return { action: 'skipped', reason: 'empty-title', alertId: '' };
      const alertId = deriveAlertId(alert.link, title);
      const t = now();
      const reports = Math.max(1, Math.floor(Number(alert.reports)) || 1);

      try {
        const active = await readActive();

        if (active && active.alertId === alertId) {
          active.lastSeenAt = t;
          if (reports > (Number(active.reports) || 1)) {
            active.reports = reports;
            active.updatedAt = t;
            return await updateRecord(active);
          }
          await writeActive(active);
          return { action: 'noop', reason: 'no-new-reports', alertId };
        }

        const publishedAt = Number(alert.publishedAt);
        if (Number.isFinite(publishedAt) && publishedAt > 0 && t - publishedAt > startWindowMs) {
          return { action: 'noop', reason: 'outside-start-window', alertId };
        }
        if (await hasUpdateTokens(alertId)) {
          return { action: 'noop', reason: 'activity-already-running', alertId };
        }
        // Deliberately ahead of the dedupe marker below: a story held here must
        // not burn its one chance, so nothing is written for it and it is
        // re-observed on the next pass.
        if (startCooldownMs > 0) {
          const lastStart = Number(await redis.command(['GET', KEY_LAST_START])) || 0;
          const since = t - lastStart;
          if (lastStart > 0 && since >= 0 && since < startCooldownMs) {
            // Logged, not silent. Every other noop here is invisible, and a
            // silent hold is indistinguishable from a dead pipeline — which is
            // how the loc-key outage went unnoticed for eighteen hours.
            log.log(
              `[LiveActivity] holding ${alertId} "${title.slice(0, 60)}" — `
              + `${Math.ceil((startCooldownMs - since) / 60000)}min left of start cooldown`,
            );
            return { action: 'noop', reason: 'start-cooldown', alertId };
          }
        }

        const won = await redis.command(['SET', startedKey(alertId), String(t), 'NX', 'EX', String(startedTtlS)]);
        if (won !== 'OK') return { action: 'noop', reason: 'already-started', alertId };

        // The article's URL is claimed too, so the next re-wording of this same
        // piece loses here instead of raising a second card. Releasing the
        // title key on the way out keeps the two identities consistent: this
        // story is "not started", by either name.
        const linkKey = startedLinkKey(alert.link);
        if (linkKey) {
          const wonLink = await redis.command(['SET', linkKey, String(t), 'NX', 'EX', String(startedTtlS)]);
          if (wonLink !== 'OK') {
            await redis.command(['DEL', startedKey(alertId)]);
            return { action: 'noop', reason: 'already-started-link', alertId };
          }
        }

        const record = {
          alertId,
          title,
          link: String(alert.link || ''),
          source: String(alert.source || ''),
          location: typeof alert.location === 'string' && alert.location ? alert.location : null,
          reports,
          startedAt: Math.floor(t / 1000),
          startedAtMs: t,
          updatedAt: t,
          lastSeenAt: t,
        };
        return await startRecord(record, active);
      } catch (e) {
        log.warn(`[LiveActivity] observe error for ${alertId}: ${e?.message || e}`);
        return { action: 'error', reason: e?.message || String(e), alertId };
      }
    });
  }

  function sweep() {
    return serialized(async () => {
      try {
        const active = await readActive();
        if (!active) return { action: 'noop', reason: 'no-active-alert' };
        const t = now();
        const age = t - (Number(active.startedAtMs) || 0);
        const idle = t - (Number(active.lastSeenAt) || Number(active.startedAtMs) || 0);
        if (age >= maxActiveMs) return await endRecord(active, 'max-age');
        if (idle >= staleMs) return await endRecord(active, 'no-longer-critical');
        return { action: 'noop', reason: 'active', alertId: active.alertId, ageMs: age };
      } catch (e) {
        log.warn(`[LiveActivity] sweep error: ${e?.message || e}`);
        return { action: 'error', reason: e?.message || String(e) };
      }
    });
  }

  function endActive(reason = 'manual') {
    return serialized(async () => {
      try {
        const active = await readActive();
        if (!active) return { action: 'noop', reason: 'no-active-alert' };
        return await endRecord(active, reason);
      } catch (e) {
        log.warn(`[LiveActivity] end error: ${e?.message || e}`);
        return { action: 'error', reason: e?.message || String(e) };
      }
    });
  }

  return { observeCriticalAlert, sweep, endActive, readActive };
}

module.exports = {
  KEY_ACTIVE,
  KEY_LANG,
  KEY_LAST_START,
  KEY_PUSH_TO_START,
  KEY_STARTED_PREFIX,
  KEY_UPDATE_PREFIX,
  LIVE_ACTIVITY_MAX_ACTIVE_MS,
  LIVE_ACTIVITY_STALE_MS,
  LIVE_ACTIVITY_START_COOLDOWN_MS,
  LIVE_ACTIVITY_START_WINDOW_MS,
  LIVE_ACTIVITY_STARTED_TTL_S,
  PUSH_TO_START_TOKEN_TTL_MS,
  createLiveActivityDispatcher,
  createUpstashCommandClient,
  startedKey,
  updateTokensKey,
};
