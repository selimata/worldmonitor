import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { wasDigestBuildTruncated } from '../server/worldmonitor/news/v1/list-feed-digest';
import { VARIANT_FEEDS } from '../server/worldmonitor/news/v1/_feeds';

const inventory = (variant: string): number =>
  Object.values(VARIANT_FEEDS[variant] ?? {}).reduce((total, feeds) => total + feeds.length, 0);

const statuses = (counts: Record<string, number>): Record<string, string> => {
  const out: Record<string, string> = {};
  let n = 0;
  for (const [status, count] of Object.entries(counts)) {
    for (let i = 0; i < count; i += 1) { out[`feed-${n}`] = status; n += 1; }
  }
  return out;
};

// Production 2026-08-25: a cached truncated build (230 items / 53 sources against
// 290 / 105 on a complete one) starved the brief of corroborated clusters and
// failed the run with eligible=0. These pin the signal that retires such a build
// early — and, just as importantly, the shape that must NOT trip it.
describe('wasDigestBuildTruncated', () => {
  it('flags a build where a quarter of the inventory never ran', () => {
    const total = inventory('full');
    assert.ok(total > 0, 'full variant must carry feeds');
    assert.equal(
      wasDigestBuildTruncated('full', statuses({ timeout: Math.ceil(total * 0.25) })),
      true,
    );
  });

  it('leaves an ordinary build alone no matter how many feeds simply had nothing', () => {
    const total = inventory('full');
    // The common healthy case: most feeds complete carrying no fresh item.
    // Counting these as failures would retire every build on the platform.
    assert.equal(
      wasDigestBuildTruncated('full', statuses({
        empty: total - 10,
        'partial-undated': 5,
        'all-undated': 5,
      })),
      false,
    );
  });

  it('does not trip just below the ratio', () => {
    const total = inventory('full');
    assert.equal(
      wasDigestBuildTruncated('full', statuses({ timeout: Math.floor(total * 0.25) - 1 })),
      false,
    );
  });

  it('treats an absent or empty status map as a complete build', () => {
    assert.equal(wasDigestBuildTruncated('full', undefined), false);
    assert.equal(wasDigestBuildTruncated('full', {}), false);
  });

  it('cannot divide by an empty inventory', () => {
    assert.equal(wasDigestBuildTruncated('no-such-variant', statuses({ timeout: 50 })), false);
  });
});
