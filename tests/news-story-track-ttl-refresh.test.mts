import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { __resetKeyPrefixCacheForTests } from "../server/_shared/redis.ts";
import { __testing__ } from "../server/worldmonitor/news/v1/list-feed-digest.ts";

const { writeStoryTracking, STORY_TTL_REFRESH_MS } = __testing__;

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  __resetKeyPrefixCacheForTests();
});

type Cmd = Array<string | number>;

/** Capture every command writeStoryTracking pipelines, across all batches. */
async function capture(
  items: unknown[],
  hashes: string[],
  tracks?: Map<string, unknown>,
  members?: Map<string, Set<string>>,
): Promise<Cmd[]> {
  const sent: Cmd[] = [];
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  delete process.env.VERCEL_ENV;
  __resetKeyPrefixCacheForTests();

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "[]")) as Cmd[];
    sent.push(...body);
    return new Response(JSON.stringify(body.map(() => ({ result: 1 }))), { status: 200 });
  }) as typeof fetch;

  await writeStoryTracking(items as never, "full", "en", hashes, members as never, tracks as never);
  // Drop the once-per-build accumulator TTL refresh. It is a single command for the
  // whole digest, not per story, and is deliberately outside this gating — counting
  // it here would hide the per-story numbers these tests exist to pin down.
  return sent.filter((c) => !(c[0] === "EXPIRE" && String(c[1]).startsWith("digest:accumulator:")));
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    source: "Reuters",
    originPublisher: "Reuters",
    title: "Strait of Hormuz closure threat",
    link: "https://example.com/a",
    publishedAt: 1_700_000_000_000,
    isAlert: false,
    level: "high",
    category: "geopolitics",
    confidence: 0.9,
    classSource: "keyword",
    importanceScore: 80,
    credibilityScore: 70,
    corroborationCount: 2,
    entityCorroborationCount: 1,
    lang: "en",
    description: "desc",
    ...overrides,
  };
}

const HASH = "0123456789abcdef0123456789abcdef";
const verbsFor = (cmds: Cmd[], verb: string) => cmds.filter((c) => c[0] === verb);

describe("story:track TTL refresh gating", () => {
  it("a known story with a fresh ttlAt emits no EXPIRE at all", async () => {
    const tracks = new Map([[HASH, {
      firstSeen: 1, lastSeen: 2, mentionCount: 3, sourceCount: 1,
      currentScore: 10, peakScore: 20, ttlAt: Date.now(),
    }]]);
    const cmds = await capture([item()], [HASH], tracks);

    assert.equal(verbsFor(cmds, "EXPIRE").length, 0,
      "the 7-day TTL was refreshed within the interval — re-EXPIREing is the waste this gating removes");
    assert.equal(verbsFor(cmds, "HSETNX").length, 0,
      "firstSeen is immutable and already on the row");
    // HINCRBY + HSET + ZADD(acc) + ZADD(peak) + SADD
    assert.equal(cmds.length, 5, `expected the steady-state 5 commands, got ${JSON.stringify(cmds.map((c) => c[0]))}`);
  });

  it("a known story with a stale ttlAt refreshes all three keys and restamps ttlAt", async () => {
    const tracks = new Map([[HASH, {
      firstSeen: 1, lastSeen: 2, mentionCount: 3, sourceCount: 1,
      currentScore: 10, peakScore: 20, ttlAt: Date.now() - STORY_TTL_REFRESH_MS - 1,
    }]]);
    const cmds = await capture([item()], [HASH], tracks);

    assert.equal(verbsFor(cmds, "EXPIRE").length, 3, "track + sources + peak");
    const hset = cmds.find((c) => c[0] === "HSET");
    assert.ok(hset?.includes("ttlAt"), "the refresh must record when it happened, or every cycle refreshes");
  });

  it("a brand-new story still gets HSETNX and its TTLs", async () => {
    const cmds = await capture([item()], [HASH], new Map());

    assert.equal(verbsFor(cmds, "HSETNX").length, 1,
      "a concurrent build may have written firstSeen first — NX keeps the earlier one");
    assert.equal(verbsFor(cmds, "EXPIRE").length, 3);
    const hset = cmds.find((c) => c[0] === "HSET");
    assert.ok(hset?.includes("ttlAt"));
  });

  it("an absent ttlAt on a legacy row reads as stale and self-heals", async () => {
    const tracks = new Map([[HASH, {
      firstSeen: 1, lastSeen: 2, mentionCount: 3, sourceCount: 1,
      currentScore: 10, peakScore: 20, // no ttlAt — rows written before this field
    }]]);
    const cmds = await capture([item()], [HASH], tracks);
    assert.equal(verbsFor(cmds, "EXPIRE").length, 3, "legacy rows must refresh, not drift to expiry");
  });

  it("EXPIRE follows the SADD/ZADD that create sources/peak (#4924 ordering)", async () => {
    const cmds = await capture([item()], [HASH], new Map());
    const flat = cmds.map((c) => `${c[0]} ${String(c[1]).split(":").slice(0, 3).join(":")}`);
    for (const prefix of ["story:sources:v1", "story:peak:v1"]) {
      const create = flat.findIndex((f) => /^(SADD|ZADD)/.test(f) && f.includes(prefix));
      const expire = flat.findIndex((f) => f.startsWith("EXPIRE") && f.includes(prefix));
      assert.ok(create > -1 && expire > create,
        `EXPIRE on ${prefix} must come after the write that creates it — on a missing key it is a no-op`);
    }
  });

  it("multi-member stories emit per-hash writes once and per-member writes per item", async () => {
    const items = [item({ source: "Reuters" }), item({ source: "AP" }), item({ source: "AFP" })];
    const cmds = await capture(items, [HASH, HASH, HASH], new Map());

    assert.equal(verbsFor(cmds, "HINCRBY").length, 1,
      "mentionCount is +1 per cycle, not +1 per wording variant");
    assert.equal(verbsFor(cmds, "SADD").length, 3, "distinct-source set is the point of corroboration");
    assert.equal(verbsFor(cmds, "EXPIRE").length, 3,
      "sources/peak are per-story keys — the other members were re-EXPIREing the same two");
  });

  it("steady state costs materially fewer commands per item than a refresh cycle", async () => {
    const items = [item(), item({ source: "AP" })];
    const hashes = [HASH, HASH];
    const fresh = new Map([[HASH, {
      firstSeen: 1, lastSeen: 2, mentionCount: 3, sourceCount: 1,
      currentScore: 10, peakScore: 20, ttlAt: Date.now(),
    }]]);

    const steady = await capture(items, hashes, fresh);
    const cold = await capture(items, hashes, new Map());
    assert.ok(steady.length < cold.length,
      `steady state (${steady.length}) must be cheaper than a cold/refresh cycle (${cold.length})`);
  });
});
