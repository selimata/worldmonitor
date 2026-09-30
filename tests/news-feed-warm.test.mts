import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  FEED_WARM_MAX_AGE_S,
  selectStaleFeeds,
  warmFeedCache,
} from '../server/worldmonitor/news/v1/list-feed-digest';
import type { ServerFeed } from '../server/worldmonitor/news/v1/_feeds';

const feed = (name: string): ServerFeed => ({ name, url: `https://feeds.test/${name}` }) as ServerFeed;
const ttl = (result: unknown) => ({ result });

describe('selectStaleFeeds', () => {
  it('keeps rows younger than the max age, returns the rest stalest first', () => {
    const feeds = ['fresh', 'old', 'missing', 'failed', 'forever', 'unreadable'].map(feed);
    const stale = selectStaleFeeds(feeds, [
      ttl(3600 - 60), // written a minute ago
      ttl(3600 - 1800), // half an hour old
      ttl(-2), // never cached
      ttl(120), // a failure row (300s TTL)
      ttl(-1), // no expiry: not ours to refresh
      {} as { result?: unknown }, // TTL unreadable
    ], FEED_WARM_MAX_AGE_S);
    assert.deepEqual(stale.map((f) => f.name), ['missing', 'unreadable', 'failed', 'old']);
  });
});

describe('warmFeedCache', () => {
  it('refreshes only stale feeds and reports what happened', async () => {
    const refreshed: string[] = [];
    const result = await warmFeedCache('full', 'en', {
      // Every other feed is stale; the odd ones were written just now.
      pipeline: async (commands) => commands.map((_, i) => ttl(i % 2 === 0 ? -2 : 3590)),
      refresh: async (f) => {
        refreshed.push(f.url);
        return { items: [], parsedTotal: refreshed.length % 3 === 0 ? 0 : 5, droppedUndated: 0 };
      },
    });
    assert.equal(result.redis, true);
    assert.ok(result.feeds > 100, 'the full/en inventory');
    assert.equal(result.stale, Math.ceil(result.feeds / 2));
    assert.equal(refreshed.length, result.stale);
    assert.equal(new Set(refreshed).size, refreshed.length, 'no feed twice');
    assert.equal(result.refreshed + result.failed, result.stale);
    assert.equal(result.notStarted, 0);
  });

  it('starts nothing new once the budget is spent', async () => {
    let clock = 0;
    let started = 0;
    const result = await warmFeedCache('full', 'en', {
      startBudgetMs: 1_000,
      now: () => clock,
      pipeline: async (commands) => commands.map(() => ttl(-2)),
      refresh: async () => {
        started++;
        clock += 300;
        return { items: [], parsedTotal: 1, droppedUndated: 0 };
      },
    });
    assert.ok(started < result.stale);
    assert.equal(result.notStarted, result.stale - started);
  });

  it('does nothing without Redis', async () => {
    let refreshes = 0;
    const result = await warmFeedCache('full', 'en', {
      pipeline: async () => [],
      refresh: async () => { refreshes++; return { items: [], parsedTotal: 1, droppedUndated: 0 }; },
    });
    assert.equal(result.redis, false);
    assert.equal(refreshes, 0);
  });
});

describe('warmFeedCache against the real fetch path', () => {
  const realFetch = globalThis.fetch;
  const env = { ...process.env };
  let writes: string[];

  beforeEach(() => {
    writes = [];
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 't';
    delete process.env.VERCEL_ENV;
    delete process.env.WS_RELAY_URL;
    delete process.env.RELAY_URL;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    process.env = { ...env };
  });

  it('rewrites a feed that parsed and leaves a failing feed\'s cached row alone', async () => {
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://redis.test/pipeline') {
        const commands = JSON.parse(String(init?.body)) as string[][];
        // Two stale feeds, the rest fresh.
        return new Response(JSON.stringify(commands.map((_, i) => ({ result: i < 2 ? 1000 : 3590 }))));
      }
      if (url === 'https://redis.test/') {
        const [, key] = JSON.parse(String(init?.body)) as string[];
        writes.push(key!);
        return new Response(JSON.stringify({ result: 'OK' }));
      }
      calls++;
      // First stale feed parses, second is throttled.
      if (calls === 1) {
        return new Response(
          '<rss><channel><item><title>Flight diverted after distress signal</title>' +
          `<link>https://example.com/a</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`,
        );
      }
      return new Response('Too Many Requests', { status: 429 });
    }) as typeof fetch;

    const result = await warmFeedCache('full', 'en');
    assert.equal(result.stale, 2);
    assert.equal(result.refreshed, 1);
    assert.equal(result.failed, 1);
    assert.equal(writes.length, 1, 'only the good parse is written');
    assert.match(writes[0]!, /^rss:feed:v9:full:/);
  });
});
