import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildBriefPoolCommands, BRIEF_POOL_TTL_SECONDS } = require('../scripts/lib/brief-pool.cjs');

const NOW = Date.parse('2026-09-30T02:00:00Z');
const item = (link, publishedAt, extra = {}) => ({ title: `t ${link}`, link, source: 'S', publishedAt, ...extra });

describe('buildBriefPoolCommands', () => {
  it('groups items into one hash per UTC day of publication, with a TTL', () => {
    const cmds = buildBriefPoolCommands({
      categories: {
        europe: { items: [item('a', Date.parse('2026-09-30T01:00:00Z'))] },
        us: { items: [item('b', Date.parse('2026-09-29T20:00:00Z'), { threat: { level: 'THREAT_LEVEL_HIGH', category: 'conflict', confidence: 1 } })] },
      },
    }, NOW);
    assert.deepEqual(cmds.map((c) => c.slice(0, 2)), [
      ['HSET', 'news:brief-pool:v1:2026-09-30'], ['EXPIRE', 'news:brief-pool:v1:2026-09-30'],
      ['HSET', 'news:brief-pool:v1:2026-09-29'], ['EXPIRE', 'news:brief-pool:v1:2026-09-29'],
    ]);
    assert.equal(cmds[1][2], String(BRIEF_POOL_TTL_SECONDS));
    assert.equal(cmds[2][2], 'b');
    const stored = JSON.parse(cmds[2][3]);
    assert.equal(stored.category, 'us');
    assert.deepEqual(stored.threat, { level: 'THREAT_LEVEL_HIGH', category: 'conflict' });
  });

  it('skips old, future-dated and incomplete items', () => {
    const cmds = buildBriefPoolCommands({
      categories: {
        x: { items: [
          item('old', NOW - 40 * 3600e3),
          item('future', NOW + 2 * 3600e3),
          { title: 'no link', publishedAt: NOW },
          item('nodate', undefined),
        ] },
      },
    }, NOW);
    assert.deepEqual(cmds, []);
  });

  it('tolerates a missing digest', () => {
    assert.deepEqual(buildBriefPoolCommands(null, NOW), []);
  });
});
