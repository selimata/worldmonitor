import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

const ORIGINAL = process.env.WORLDMONITOR_VALID_KEYS;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.WORLDMONITOR_VALID_KEYS;
  else process.env.WORLDMONITOR_VALID_KEYS = ORIGINAL;
});

const KEY = '57e94def0699da2a338d0008764253cf';

async function validate(headerKey: string) {
  const { validateApiKey } = await import('../api/_api-key.js');
  return validateApiKey(new Request('https://x.test/api/x', {
    headers: { 'X-WorldMonitor-Key': headerKey },
  }));
}

// Two readers parsed WORLDMONITOR_VALID_KEYS differently: wm-session.js trimmed
// through envList(), _api-key.js did not. A key installed as `old, new` then
// authenticated on one route and answered "Invalid API key" on the other —
// which reads as a bad key rather than a bad separator, and costs an hour.
describe('WORLDMONITOR_VALID_KEYS parsing', () => {
  it('accepts a key added with a space after the comma', async () => {
    process.env.WORLDMONITOR_VALID_KEYS = `oldkey123456789, ${KEY}`;
    const result = await validate(KEY);
    assert.equal(result.valid, true, 'a space after the comma must not invalidate the key');
    assert.equal(result.kind, 'enterprise');
  });

  it('accepts surrounding whitespace and newlines from a pasted value', async () => {
    process.env.WORLDMONITOR_VALID_KEYS = `\n  oldkey123456789 ,\t${KEY}\n`;
    assert.equal((await validate(KEY)).valid, true);
  });

  it('still refuses a key that is genuinely absent', async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'oldkey123456789, someotherkey';
    const result = await validate(KEY);
    assert.equal(result.valid, false);
    assert.equal(result.error, 'Invalid API key');
  });

  it('does not turn an empty or blank list into a wildcard', async () => {
    for (const value of ['', '   ', ',', ' , , ']) {
      process.env.WORLDMONITOR_VALID_KEYS = value;
      const result = await validate(KEY);
      assert.equal(result.valid, false, `list ${JSON.stringify(value)} must authenticate nobody`);
    }
  });
});
