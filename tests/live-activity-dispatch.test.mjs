/**
 * Live Activity dispatcher — start / update / end decisions, the restart-safe
 * Redis dedupe, the one-active-alert rule, the 4h / stale sweep, dead-token
 * removal, and the relay wiring (source assertions, same pattern as
 * tests/relay-importance-recompute.test.mjs).
 *
 * Run: node --test tests/live-activity-dispatch.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const dispatch = require('../scripts/lib/live-activity-dispatch.cjs');
const { deriveAlertId } = require('../scripts/lib/apns-live-activity.cjs');

const HOUR = 60 * 60 * 1000;
const T0 = 1_800_000_000_000;

/** Minimal in-memory Redis speaking the Upstash pipeline result shapes. */
function fakeRedis() {
  const store = new Map();
  const calls = [];
  let failing = null;
  function exec(args) {
    const [cmd, key, ...rest] = args.map(String);
    switch (cmd) {
      case 'GET': return store.has(key) && typeof store.get(key) === 'string' ? store.get(key) : null;
      case 'SET': {
        const nx = rest.includes('NX');
        if (nx && store.has(key)) return null;
        store.set(key, rest[0]);
        return 'OK';
      }
      case 'DEL': { let n = 0; for (const k of [key, ...rest]) if (store.delete(k)) n++; return n; }
      case 'EXPIRE': return store.has(key) ? 1 : 0;
      case 'HSET': { const h = store.get(key) instanceof Map ? store.get(key) : new Map(); h.set(rest[0], rest[1]); store.set(key, h); return 1; }
      case 'HDEL': { const h = store.get(key); return h instanceof Map && h.delete(rest[0]) ? 1 : 0; }
      case 'HKEYS': { const h = store.get(key); return h instanceof Map ? [...h.keys()] : []; }
      case 'HLEN': { const h = store.get(key); return h instanceof Map ? h.size : 0; }
      case 'ZADD': { const z = store.get(key) instanceof Map ? store.get(key) : new Map(); z.set(rest[1], Number(rest[0])); store.set(key, z); return 1; }
      case 'ZREM': { const z = store.get(key); return z instanceof Map && z.delete(rest[0]) ? 1 : 0; }
      case 'ZRANGE': { const z = store.get(key); return z instanceof Map ? [...z.entries()].sort((a, b) => a[1] - b[1]).map(([m]) => m) : []; }
      case 'ZREMRANGEBYSCORE': {
        const z = store.get(key);
        if (!(z instanceof Map)) return 0;
        const max = rest[1] === '+inf' ? Infinity : Number(rest[1]);
        let n = 0;
        for (const [m, s] of [...z.entries()]) if (s <= max) { z.delete(m); n++; }
        return n;
      }
      default: throw new Error(`fakeRedis: unsupported ${cmd}`);
    }
  }
  return {
    store,
    calls,
    fail(err) { failing = err; },
    async pipeline(commands) {
      if (failing) throw failing;
      calls.push(...commands);
      return commands.map(exec);
    },
    async command(args) {
      if (failing) throw failing;
      calls.push(args);
      return exec(args);
    },
    seedPushToStart(tokens, at = T0) {
      for (const t of tokens) exec(['ZADD', dispatch.KEY_PUSH_TO_START, String(at), t]);
    },
    seedUpdateTokens(alertId, tokens, at = T0) {
      for (const t of tokens) exec(['HSET', dispatch.updateTokensKey(alertId), t, String(at)]);
    },
    hashKeys(key) { return exec(['HKEYS', key]); },
    zset(key) { return exec(['ZRANGE', key, '0', '-1']); },
  };
}

function fakeSender({ removeTokens = new Set(), throwFor = new Set() } = {}) {
  const sent = [];
  const record = (kind, token, extra) => {
    if (throwFor.has(token)) throw new Error(`boom ${token}`);
    sent.push({ kind, token, ...extra });
    return { ok: !removeTokens.has(token), dryRun: false, status: removeTokens.has(token) ? 410 : 200, reason: removeTokens.has(token) ? 'Unregistered' : null, removeToken: removeTokens.has(token) };
  };
  return {
    sent,
    enabled: true,
    async sendStart(token, { alertId, startedAt, contentState }) { return record('start', token, { alertId, startedAt, contentState }); },
    async sendUpdate(token, contentState) { return record('update', token, { contentState }); },
    async sendEnd(token, contentState, dismissalDate) { return record('end', token, { contentState, dismissalDate }); },
  };
}

function quietLog() {
  const lines = [];
  return { lines, log: (m) => lines.push(['log', String(m)]), warn: (m) => lines.push(['warn', String(m)]) };
}

function harness({ redis = fakeRedis(), sender = fakeSender(), now } = {}) {
  const clock = { now: T0 };
  const dispatcher = dispatch.createLiveActivityDispatcher({
    redis,
    sender,
    log: quietLog(),
    now: now || (() => clock.now),
  });
  return { redis, sender, dispatcher, clock };
}

const ALERT = {
  title: 'Iran closes Strait of Hormuz',
  link: 'https://example.com/hormuz',
  source: 'Reuters',
  location: 'Strait of Hormuz',
  reports: 2,
  publishedAt: T0 - 5 * 60 * 1000,
};
const ALERT_ID = deriveAlertId(ALERT.link, ALERT.title);
const PTS = ['aa'.repeat(40), 'bb'.repeat(40), 'cc'.repeat(40)];

describe('observeCriticalAlert — start', () => {
  it('pushes start to every registered push-to-start token and records the active alert', async () => {
    const { redis, sender, dispatcher } = harness();
    redis.seedPushToStart(PTS);

    const result = await dispatcher.observeCriticalAlert(ALERT);
    assert.equal(result.action, 'started');
    assert.equal(result.alertId, ALERT_ID);
    assert.equal(result.sent, 3);
    assert.equal(result.superseded, null);

    assert.deepEqual(sender.sent.map((s) => s.kind), ['start', 'start', 'start']);
    assert.deepEqual(new Set(sender.sent.map((s) => s.token)), new Set(PTS));
    const first = sender.sent[0];
    assert.equal(first.alertId, ALERT_ID);
    assert.equal(first.startedAt, Math.floor(T0 / 1000));
    assert.deepEqual(first.contentState, {
      title: ALERT.title, source: 'Reuters', location: 'Strait of Hormuz', link: ALERT.link, level: 'critical', reports: 2, updatedAt: Math.floor(T0 / 1000),
    });

    const active = await dispatcher.readActive();
    assert.equal(active.alertId, ALERT_ID);
    assert.equal(active.reports, 2);
    assert.equal(active.startedAtMs, T0);
    assert.equal(redis.store.get(dispatch.startedKey(ALERT_ID)), String(T0));
  });

  it('prunes push-to-start tokens older than 30 days before fanning out', async () => {
    const { redis, sender, dispatcher } = harness();
    redis.seedPushToStart([PTS[0]], T0 - 31 * 24 * HOUR);
    redis.seedPushToStart([PTS[1]], T0 - 1 * 24 * HOUR);
    const result = await dispatcher.observeCriticalAlert(ALERT);
    assert.equal(result.attempted, 1);
    assert.deepEqual(sender.sent.map((s) => s.token), [PTS[1]]);
    assert.deepEqual(redis.zset(dispatch.KEY_PUSH_TO_START), [PTS[1]]);
  });

  it('skips an empty title and an alert published outside the start window', async () => {
    const { dispatcher, sender } = harness();
    assert.equal((await dispatcher.observeCriticalAlert({ title: '  ' })).action, 'skipped');
    const stale = await dispatcher.observeCriticalAlert({ ...ALERT, publishedAt: T0 - 2 * HOUR });
    assert.equal(stale.action, 'noop');
    assert.equal(stale.reason, 'outside-start-window');
    assert.equal(sender.sent.length, 0);
  });

  it('does not re-start an alert that already has update tokens (activity already running on devices)', async () => {
    const { redis, dispatcher, sender } = harness();
    redis.seedPushToStart(PTS);
    redis.seedUpdateTokens(ALERT_ID, ['dd'.repeat(40)]);
    const result = await dispatcher.observeCriticalAlert(ALERT);
    assert.equal(result.action, 'noop');
    assert.equal(result.reason, 'activity-already-running');
    assert.equal(sender.sent.length, 0);
  });
});

describe('observeCriticalAlert — restart-safe dedupe', () => {
  it('a second dispatcher over the same Redis (relay restart) does not fire start again', async () => {
    const redis = fakeRedis();
    redis.seedPushToStart(PTS);
    const first = harness({ redis });
    assert.equal((await first.dispatcher.observeCriticalAlert(ALERT)).action, 'started');

    // Simulate a restart that lost the active record but kept the dedupe marker.
    redis.store.delete(dispatch.KEY_ACTIVE);
    // Past the start cooldown, so the marker is what refuses this — not the
    // time gate, which would pass the assertion for the wrong reason.
    const after = T0 + dispatch.LIVE_ACTIVITY_START_COOLDOWN_MS + 1;
    const second = harness({ redis, sender: fakeSender(), now: () => after });
    const result = await second.dispatcher.observeCriticalAlert({ ...ALERT, publishedAt: after - 60_000 });
    assert.equal(result.action, 'noop');
    assert.equal(result.reason, 'already-started');
    assert.equal(second.sender.sent.length, 0);
  });

  it('a different story raised inside the cooldown is HELD, not started', async () => {
    const { redis, sender, dispatcher, clock } = harness();
    redis.seedPushToStart(PTS);
    assert.equal((await dispatcher.observeCriticalAlert(ALERT)).action, 'started');
    sender.sent.length = 0;

    clock.now = T0 + 60_000;
    const other = {
      ...ALERT, title: 'Coup attempt underway in Lagos',
      link: 'https://example.com/lagos', publishedAt: clock.now - 60_000,
    };
    const held = await dispatcher.observeCriticalAlert(other);
    assert.equal(held.action, 'noop');
    assert.equal(held.reason, 'start-cooldown');
    assert.equal(sender.sent.length, 0, 'nothing may reach APNs while held');

    // A held story must keep its chance: no dedupe marker, so once the
    // cooldown lapses the same story starts normally.
    const heldId = deriveAlertId(other.link, other.title);
    assert.equal(redis.store.get(dispatch.startedKey(heldId)), undefined);

    clock.now = T0 + dispatch.LIVE_ACTIVITY_START_COOLDOWN_MS + 1;
    const later = await dispatcher.observeCriticalAlert({ ...other, publishedAt: clock.now - 60_000 });
    assert.equal(later.action, 'started');
  });

  it('the cooldown never blocks an UPDATE to the running alert', async () => {
    const { redis, sender, dispatcher, clock } = harness();
    redis.seedPushToStart(PTS);
    await dispatcher.observeCriticalAlert(ALERT);
    redis.seedUpdateTokens(ALERT_ID, ['ee'.repeat(40)]);
    sender.sent.length = 0;

    clock.now = T0 + 60_000;
    const grown = await dispatcher.observeCriticalAlert({ ...ALERT, reports: 9 });
    assert.equal(grown.action, 'updated', 'corroboration growth is not a new start');
    assert.equal(sender.sent[0].kind, 'update');
  });

  it('the cooldown is stamped before the fan-out, so a same-second second story is held', async () => {
    const { redis, sender, dispatcher } = harness();
    redis.seedPushToStart(PTS);
    await dispatcher.observeCriticalAlert(ALERT);
    const stamp = redis.calls.find((c) => c[0] === 'SET' && c[1] === dispatch.KEY_LAST_START);
    assert.ok(stamp, 'a start must record when it happened');
    assert.deepEqual(stamp.slice(3), ['PX', String(dispatch.LIVE_ACTIVITY_START_COOLDOWN_MS)]);
    // 2026-09-01: three starts landed inside two seconds. Same clock value here.
    sender.sent.length = 0;
    const sameSecond = await dispatcher.observeCriticalAlert({
      ...ALERT, title: 'Death toll tops 1,000 after Nepal flooding', link: 'https://example.com/nepal',
    });
    assert.equal(sameSecond.reason, 'start-cooldown');
    assert.equal(sender.sent.length, 0);
  });

  it('the dedupe marker is SET NX with the started TTL', async () => {
    const { redis, dispatcher } = harness();
    await dispatcher.observeCriticalAlert(ALERT);
    const setNx = redis.calls.find((c) => c[0] === 'SET' && c[1] === dispatch.startedKey(ALERT_ID));
    assert.deepEqual(setNx.slice(3), ['NX', 'EX', String(dispatch.LIVE_ACTIVITY_STARTED_TTL_S)]);
    // 36h, not 6h: at 6h a story the feed keeps republishing raised a fresh
    // card four times a day (CrisisWatch's Gaza ceasefire piece, for days).
    assert.equal(dispatch.LIVE_ACTIVITY_STARTED_TTL_S, 36 * 60 * 60);
  });
});

describe('observeCriticalAlert — update', () => {
  it('sends update to the alert\'s update tokens only when the report count grows', async () => {
    const { redis, sender, dispatcher, clock } = harness();
    redis.seedPushToStart(PTS);
    await dispatcher.observeCriticalAlert(ALERT);
    sender.sent.length = 0;
    const UPD = ['ee'.repeat(40), 'ff'.repeat(40)];
    redis.seedUpdateTokens(ALERT_ID, UPD);

    clock.now = T0 + 15 * 60 * 1000;
    const same = await dispatcher.observeCriticalAlert({ ...ALERT, reports: 2 });
    assert.equal(same.action, 'noop');
    assert.equal(same.reason, 'no-new-reports');
    assert.equal(sender.sent.length, 0);
    assert.equal((await dispatcher.readActive()).lastSeenAt, clock.now, 'still-observed alert refreshes lastSeenAt');

    clock.now = T0 + 30 * 60 * 1000;
    const grew = await dispatcher.observeCriticalAlert({ ...ALERT, reports: 5 });
    assert.equal(grew.action, 'updated');
    assert.equal(grew.reports, 5);
    assert.equal(grew.sent, 2);
    assert.deepEqual(sender.sent.map((s) => s.kind), ['update', 'update']);
    assert.deepEqual(new Set(sender.sent.map((s) => s.token)), new Set(UPD));
    assert.equal(sender.sent[0].contentState.reports, 5);
    assert.equal(sender.sent[0].contentState.updatedAt, Math.floor(clock.now / 1000));
    assert.equal((await dispatcher.readActive()).reports, 5);

    // A lower count later (a variant with fewer merged feeds) never downgrades.
    const lower = await dispatcher.observeCriticalAlert({ ...ALERT, reports: 3 });
    assert.equal(lower.action, 'noop');
    assert.equal((await dispatcher.readActive()).reports, 5);
  });
});

describe('observeCriticalAlert — one active alert at a time', () => {
  it('starting a new critical alert ends the previous one first', async () => {
    const { redis, sender, dispatcher, clock } = harness();
    redis.seedPushToStart(PTS);
    await dispatcher.observeCriticalAlert(ALERT);
    redis.seedUpdateTokens(ALERT_ID, ['ee'.repeat(40)]);
    sender.sent.length = 0;

    // Past the start cooldown — this test is about superseding, not the gate.
    clock.now = T0 + dispatch.LIVE_ACTIVITY_START_COOLDOWN_MS + 60_000;
    const next = { ...ALERT, title: 'Coup attempt underway in Lagos', link: 'https://example.com/lagos', publishedAt: clock.now - 60_000 };
    const nextId = deriveAlertId(next.link, next.title);
    const result = await dispatcher.observeCriticalAlert(next);
    assert.equal(result.action, 'started');
    assert.equal(result.superseded, ALERT_ID);

    assert.equal(sender.sent[0].kind, 'end');
    assert.equal(sender.sent[0].token, 'ee'.repeat(40));
    // Superseded: dismissed at once, so it does not sit next to its replacement.
    assert.equal(sender.sent[0].dismissalDate, Math.floor(clock.now / 1000));
    assert.equal(sender.sent[0].contentState.title, ALERT.title);
    assert.deepEqual(sender.sent.slice(1).map((s) => s.kind), ['start', 'start', 'start']);
    assert.equal(sender.sent[1].alertId, nextId);

    assert.equal((await dispatcher.readActive()).alertId, nextId);
    assert.deepEqual(redis.hashKeys(dispatch.updateTokensKey(ALERT_ID)), [], 'previous update tokens are cleared');
  });
});

describe('sweep — end after 4h or when no longer observed as critical', () => {
  it('ends the active alert after LIVE_ACTIVITY_MAX_ACTIVE_MS (4h)', async () => {
    const { redis, sender, dispatcher, clock } = harness();
    redis.seedPushToStart(PTS);
    await dispatcher.observeCriticalAlert(ALERT);
    redis.seedUpdateTokens(ALERT_ID, ['ee'.repeat(40)]);
    sender.sent.length = 0;
    assert.equal(dispatch.LIVE_ACTIVITY_MAX_ACTIVE_MS, 4 * HOUR);

    clock.now = T0 + 30 * 60 * 1000;
    await dispatcher.observeCriticalAlert(ALERT); // keep it fresh
    clock.now = T0 + 3 * HOUR;
    await dispatcher.observeCriticalAlert(ALERT);
    assert.equal((await dispatcher.sweep()).action, 'noop');

    clock.now = T0 + 4 * HOUR + 1;
    const ended = await dispatcher.sweep();
    assert.equal(ended.action, 'ended');
    assert.equal(ended.reason, 'max-age');
    assert.deepEqual(sender.sent.map((s) => s.kind), ['end']);
    assert.equal(await dispatcher.readActive(), null);
    assert.equal((await dispatcher.sweep()).action, 'noop');
  });

  it('ends early when the alert stops being observed for LIVE_ACTIVITY_STALE_MS', async () => {
    const { redis, sender, dispatcher, clock } = harness();
    redis.seedPushToStart(PTS);
    await dispatcher.observeCriticalAlert(ALERT);
    sender.sent.length = 0;
    assert.equal(dispatch.LIVE_ACTIVITY_STALE_MS, HOUR);

    clock.now = T0 + 59 * 60 * 1000;
    assert.equal((await dispatcher.sweep()).action, 'noop');
    clock.now = T0 + HOUR;
    const ended = await dispatcher.sweep();
    assert.equal(ended.action, 'ended');
    assert.equal(ended.reason, 'no-longer-critical');
    assert.equal(await dispatcher.readActive(), null);
  });
});

describe('dead-token handling and error safety', () => {
  it('removes tokens APNs reports as gone (push-to-start ZREM, update HDEL)', async () => {
    const dead = new Set([PTS[1], 'ff'.repeat(40)]);
    const redis = fakeRedis();
    const { dispatcher, clock } = harness({ redis, sender: fakeSender({ removeTokens: dead }) });
    redis.seedPushToStart(PTS);
    const started = await dispatcher.observeCriticalAlert(ALERT);
    assert.equal(started.removed, 1);
    assert.deepEqual(redis.zset(dispatch.KEY_PUSH_TO_START), [PTS[0], PTS[2]]);

    redis.seedUpdateTokens(ALERT_ID, ['ee'.repeat(40), 'ff'.repeat(40)]);
    clock.now = T0 + 60_000;
    const updated = await dispatcher.observeCriticalAlert({ ...ALERT, reports: 9 });
    assert.equal(updated.removed, 1);
    assert.deepEqual(redis.hashKeys(dispatch.updateTokensKey(ALERT_ID)), ['ee'.repeat(40)]);
  });

  it('resolves with action=error instead of throwing when Redis fails', async () => {
    const redis = fakeRedis();
    redis.fail(new Error('upstash down'));
    const { dispatcher } = harness({ redis });
    const observed = await dispatcher.observeCriticalAlert(ALERT);
    assert.equal(observed.action, 'error');
    assert.match(observed.reason, /upstash down/);
    const swept = await dispatcher.sweep();
    assert.equal(swept.action, 'error');
  });

  it('a throwing sender never aborts the fan-out', async () => {
    const redis = fakeRedis();
    redis.seedPushToStart(PTS);
    const { dispatcher, sender } = harness({ redis, sender: fakeSender({ throwFor: new Set([PTS[0]]) }) });
    const result = await dispatcher.observeCriticalAlert(ALERT);
    assert.equal(result.action, 'started');
    assert.equal(result.attempted, 3);
    assert.equal(result.sent, 2);
    assert.equal(sender.sent.length, 2);
  });

  it('serializes overlapping observe calls so a burst cannot double-start', async () => {
    const { redis, sender, dispatcher } = harness();
    redis.seedPushToStart(PTS);
    const results = await Promise.all([
      dispatcher.observeCriticalAlert(ALERT),
      dispatcher.observeCriticalAlert(ALERT),
      dispatcher.observeCriticalAlert(ALERT),
    ]);
    assert.deepEqual(results.map((r) => r.action), ['started', 'noop', 'noop']);
    assert.equal(sender.sent.filter((s) => s.kind === 'start').length, 3, 'one start per token, not per observe');
  });
});

describe('createUpstashCommandClient', () => {
  it('posts stringified commands to /pipeline with the bearer token and unwraps results', async () => {
    const requests = [];
    const fetchImpl = async (url, init) => {
      requests.push({ url, init });
      return { ok: true, status: 200, json: async () => [{ result: 'OK' }, { result: ['a', 'b'] }] };
    };
    const client = dispatch.createUpstashCommandClient({ url: 'https://redis.example.test/', token: 'tok', fetchImpl });
    const results = await client.pipeline([['SET', 'k', 'v', 'EX', 60], ['ZRANGE', 'z', 0, -1]]);
    assert.deepEqual(results, ['OK', ['a', 'b']]);
    assert.equal(requests[0].url, 'https://redis.example.test/pipeline');
    assert.equal(requests[0].init.headers.Authorization, 'Bearer tok');
    assert.deepEqual(JSON.parse(requests[0].init.body), [['SET', 'k', 'v', 'EX', '60'], ['ZRANGE', 'z', '0', '-1']]);
    assert.ok(requests[0].init.signal instanceof AbortSignal);
  });

  it('throws on HTTP failure, malformed bodies, and per-command errors', async () => {
    const make = (impl) => dispatch.createUpstashCommandClient({ url: 'https://r.test', token: 't', fetchImpl: impl });
    await assert.rejects(make(async () => ({ ok: false, status: 500, json: async () => ({}) })).command(['GET', 'k']), /HTTP 500/);
    await assert.rejects(make(async () => ({ ok: true, status: 200, json: async () => ({}) })).command(['GET', 'k']), /malformed/);
    await assert.rejects(make(async () => ({ ok: true, status: 200, json: async () => [{ error: 'WRONGTYPE' }] })).command(['GET', 'k']), /WRONGTYPE/);
    assert.throws(() => dispatch.createUpstashCommandClient({ url: '', token: '' }), /required/);
  });
});

describe('ais-relay wiring (source assertions)', () => {
  const relaySrc = readFileSync(resolve(__dirname, '..', 'scripts', 'ais-relay.cjs'), 'utf-8');
  const dockerfile = readFileSync(resolve(__dirname, '..', 'Dockerfile.relay'), 'utf-8');

  it('requires the sender and dispatcher modules', () => {
    assert.match(relaySrc, /require\('\.\/lib\/apns-live-activity\.cjs'\)/);
    assert.match(relaySrc, /require\('\.\/lib\/live-activity-dispatch\.cjs'\)/);
  });

  it('observes CRITICAL alerts from both the LLM branch and cached hits, after the notification publish', () => {
    const branchStart = relaySrc.indexOf("if (level === 'critical' || level === 'high')");
    const publishAt = relaySrc.indexOf('[Notify] Classify publish error', branchStart);
    const llmHook = relaySrc.indexOf('observeCriticalSurfaces(chunk[idx], meta, level, variant);', publishAt);
    assert.ok(branchStart !== -1 && publishAt !== -1, 'classify critical/high branch not found');
    assert.ok(llmHook !== -1 && llmHook - publishAt < 400, 'LLM-branch hook must follow the notification publish inside the same block');
    assert.match(relaySrc, /observeCriticalSurfaces\(titleArr\[i\], allTitles\.get\(titleArr\[i\]\), level, variant\);/);
  });

  it('gates observations on the same source-tier policy as notifications', () => {
    const fn = relaySrc.slice(relaySrc.indexOf('function liveActivityObserve('), relaySrc.indexOf('function startLiveActivitySweeper('));
    assert.match(fn, /shouldDropRelaySourceForTier\(RELAY_GATES_READY, source, RELAY_TIER4_SOURCES\)/);
    assert.match(fn, /\.catch\(/, 'observe promise must be caught so a failure never reaches the classify loop');
  });

  it('starts the sweeper from the listen callback (never a seed loop; skipped in RELAY_TEST_MODE)', () => {
    const listenAt = relaySrc.indexOf('server.listen(PORT, () => {');
    const testModeReturn = relaySrc.indexOf('background seed loops are disabled', listenAt);
    const sweeperCall = relaySrc.indexOf('startLiveActivitySweeper();', listenAt);
    assert.ok(sweeperCall > testModeReturn && testModeReturn > listenAt);
    assert.doesNotMatch(relaySrc, /function\s+startLiveActivity\w*(?:SeedLoop|WarmPingLoop)\s*\(/);
    assert.match(relaySrc, /const timer = setInterval\(\(\) => \{\s*liveActivityDispatcher\.sweep\(\)/);
  });

  it('ships both modules in the relay image', () => {
    assert.match(dockerfile, /^COPY scripts\/lib\/apns-live-activity\.cjs \.\/scripts\/lib\/apns-live-activity\.cjs$/m);
    assert.match(dockerfile, /^COPY scripts\/lib\/live-activity-dispatch\.cjs \.\/scripts\/lib\/live-activity-dispatch\.cjs$/m);
  });
});

describe('statesByToken never ships the raw source language', () => {
  const src = readFileSync(new URL('../scripts/lib/live-activity-dispatch.cjs', import.meta.url), 'utf-8');

  it("treats 'en' as a translation target, not as the wire default", () => {
    assert.match(src, /new Set\(\[\.\.\.langByToken\.values\(\), 'en'\]\)/,
      "every token registered 'en' (today: all of them) received raw Hebrew when the source was Hebrew");
  });

  it('falls back failed translations to the English rendering, raw only as last resort', () => {
    assert.match(src, /const base = typeof titles\.en === 'string' && titles\.en\.trim\(\) \? clamp\(titles\.en\) : raw;/);
    assert.match(src, /byLang\.set\(lang, typeof t === 'string' && t\.trim\(\) \? clamp\(t\) : base\);/);
  });
});

describe('one article, one card', () => {
  const src = readFileSync(new URL('../scripts/lib/live-activity-dispatch.cjs', import.meta.url), 'utf-8');

  it('claims the article URL as a second identity, so a re-wording cannot restart it', () => {
    assert.match(src, /function startedLinkKey\(link\)/,
      'deriveAlertId hashes the headline, which does not survive a re-wording or a translation');
    assert.match(src, /already-started-link/);
  });

  it('normalises the URL so query strings and trailing slashes do not fork the identity', () => {
    assert.match(src, /replace\(\/\[\?#\]\.\*\$\/, ''\)/);
  });

  it('releases the title key when the link key loses — both identities stay consistent', () => {
    const i = src.indexOf('already-started-link');
    const window = src.slice(i - 400, i);
    assert.match(window, /DEL', startedKey\(alertId\)/,
      'keeping the title key would leave the story half-started under one name');
  });

  it('imports createHash — startedLinkKey would throw at first use otherwise', () => {
    assert.match(src, /require\('node:crypto'\)/);
  });

  it('keeps a started story marked long enough to outlive a republishing feed', () => {
    assert.match(src, /LIVE_ACTIVITY_STARTED_TTL_S = 36 \* 60 \* 60/,
      '6h let a story the feed keeps republishing raise a fresh card four times a day');
  });
});
