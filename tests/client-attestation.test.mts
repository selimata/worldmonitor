import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CLIENT_ID_HEADER,
  CLIENT_SIGNATURE_HEADER,
  CLIENT_TIMESTAMP_WINDOW_SECONDS,
  clientAttestationPayload,
  verifyClientAttestation,
} from '../server/_shared/client-attestation';
import { hmacSha256Base64Url } from '../server/_shared/mcp-internal-hmac';

const SECRET = 'test-secret-value-at-least-32-chars-long';
const NOW_MS = 1_787_600_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);

async function signed(opts: {
  url?: string; method?: string; clientId?: string; ts?: number; secret?: string;
} = {}): Promise<Request> {
  const url = opts.url ?? 'https://example.test/api/intelligence/v1/get-pizzint-status';
  const method = opts.method ?? 'GET';
  const clientId = opts.clientId ?? 'ios';
  const ts = opts.ts ?? NOW_S;
  const parsed = new URL(url);
  const sig = await hmacSha256Base64Url(
    opts.secret ?? SECRET,
    clientAttestationPayload(clientId, ts, method, parsed.pathname, parsed),
  );
  return new Request(url, {
    method,
    headers: { [CLIENT_ID_HEADER]: clientId, [CLIENT_SIGNATURE_HEADER]: `${ts}.${sig}` },
  });
}

// A mismatch also carries a fingerprint of the CONFIGURED secret, so assert the
// shape rather than deep-equality: the fingerprint is the field that tells a
// wrong-secret deploy apart from a wrong client, and it must actually be there.
function assertMismatch(result: Awaited<ReturnType<typeof verifyClientAttestation>>): void {
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'mismatch');
  assert.match(result.ok === false ? result.configFingerprint ?? '' : '', /^[0-9a-f]{8}$/);
}

describe('verifyClientAttestation', () => {
  it('accepts a signature this secret produced', async () => {
    assert.deepEqual(await verifyClientAttestation(await signed(), SECRET, NOW_MS),
      { ok: true, clientId: 'ios' });
  });

  it('refuses a signature from a different secret', async () => {
    const req = await signed({ secret: 'someone-elses-secret-value-32-chars!' });
    assertMismatch(await verifyClientAttestation(req, SECRET, NOW_MS));
  });

  // The point of binding method and path: a header pair captured from one call
  // must not be liftable onto another.
  it('refuses a signature replayed onto a different path', async () => {
    const req = await signed({ url: 'https://example.test/api/a' });
    const moved = new Request('https://example.test/api/b', { method: 'GET', headers: req.headers });
    assertMismatch(await verifyClientAttestation(moved, SECRET, NOW_MS));
  });

  it('refuses a signature replayed onto a different method', async () => {
    const req = await signed({ method: 'GET' });
    const moved = new Request(req.url, { method: 'POST', headers: req.headers });
    assertMismatch(await verifyClientAttestation(moved, SECRET, NOW_MS));
  });

  it('tolerates ordinary handset clock drift', async () => {
    const early = await signed({ ts: NOW_S - (CLIENT_TIMESTAMP_WINDOW_SECONDS - 10) });
    assert.equal((await verifyClientAttestation(early, SECRET, NOW_MS)).ok, true);
    const late = await signed({ ts: NOW_S + (CLIENT_TIMESTAMP_WINDOW_SECONDS - 10) });
    assert.equal((await verifyClientAttestation(late, SECRET, NOW_MS)).ok, true);
  });

  it('refuses a signature outside the window in BOTH directions', async () => {
    const old = await signed({ ts: NOW_S - (CLIENT_TIMESTAMP_WINDOW_SECONDS + 10) });
    assert.deepEqual(await verifyClientAttestation(old, SECRET, NOW_MS), { ok: false, reason: 'stale' });
    // A future stamp is how a captured signature would be stockpiled.
    const future = await signed({ ts: NOW_S + (CLIENT_TIMESTAMP_WINDOW_SECONDS + 10) });
    assert.deepEqual(await verifyClientAttestation(future, SECRET, NOW_MS), { ok: false, reason: 'stale' });
  });

  it('survives query reordering by a proxy or CDN', async () => {
    const req = await signed({ url: 'https://example.test/api/x?b=2&a=1' });
    const reordered = new Request('https://example.test/api/x?a=1&b=2', { method: 'GET', headers: req.headers });
    assert.equal((await verifyClientAttestation(reordered, SECRET, NOW_MS)).ok, true);
  });

  it('still binds query VALUES', async () => {
    const req = await signed({ url: 'https://example.test/api/x?id=1' });
    const tampered = new Request('https://example.test/api/x?id=2', { method: 'GET', headers: req.headers });
    assertMismatch(await verifyClientAttestation(tampered, SECRET, NOW_MS));
  });

  it('rejects malformed and hostile header shapes without throwing', async () => {
    const cases: Array<[string, string]> = [
      ['ios', ''], ['', 'x.y'], ['ios', 'nodot'], ['ios', '.sig'], ['ios', '123.'],
      ['ios', 'notanumber.sig'], ['ios', `${'9'.repeat(20)}.sig`],
      ['a'.repeat(64), '123.sig'], ['ios!', '123.sig'], ['IOS', '123.sig'],
    ];
    for (const [id, sig] of cases) {
      const req = new Request('https://example.test/api/x', {
        headers: { [CLIENT_ID_HEADER]: id, [CLIENT_SIGNATURE_HEADER]: sig },
      });
      const out = await verifyClientAttestation(req, SECRET, NOW_MS);
      assert.equal(out.ok, false, `${JSON.stringify([id, sig])} must not verify`);
    }
  });

  // The secret comes from an env var someone pasted into a dashboard; a
  // trailing newline there produced a bare "mismatch", which reads as the wrong
  // secret rather than an invisible character.
  it('tolerates whitespace around the configured secret', async () => {
    const req = await signed();
    for (const padded of [`${SECRET}\n`, ` ${SECRET} `, `\n${SECRET}\r\n`]) {
      assert.equal((await verifyClientAttestation(req, padded, NOW_MS)).ok, true,
        `padded secret ${JSON.stringify(padded)} must still verify`);
    }
  });

  it('refuses everything when no secret is configured', async () => {
    const req = await signed();
    for (const empty of ['', '   ', '\n']) {
      assert.equal((await verifyClientAttestation(req, empty, NOW_MS)).ok, false);
    }
  });

  // Production 2026-08-26: every signed request 403'd because Vercel serves each
  // domain gateway from api/<domain>/v1/[rpc].ts and hands the matched segment to
  // the function as a query parameter. The client signs the query it sent; the
  // server saw an extra `rpc=` it could never have signed.
  it('ignores the route parameter the platform injects', async () => {
    const req = await signed({ url: 'https://example.test/api/news/v1/list-feed-digest?variant=full&lang=en' });
    const asVercelSeesIt = new Request(
      'https://example.test/api/news/v1/list-feed-digest?variant=full&lang=en&rpc=list-feed-digest',
      { method: 'GET', headers: req.headers },
    );
    assert.equal((await verifyClientAttestation(asVercelSeesIt, SECRET, NOW_MS)).ok, true);
  });

  // The exemption is narrow on purpose: it is the platform's echo of the route
  // only when the value IS the route. Anything else a caller puts in `rpc` stays
  // signed, or the filter would become a hole to smuggle a parameter through.
  it('still binds an rpc parameter that is not the route echo', async () => {
    const req = await signed({ url: 'https://example.test/api/news/v1/list-feed-digest?variant=full' });
    const tampered = new Request(
      'https://example.test/api/news/v1/list-feed-digest?variant=full&rpc=something-else',
      { method: 'GET', headers: req.headers },
    );
    assertMismatch(await verifyClientAttestation(tampered, SECRET, NOW_MS));
  });

  it('normalises the client id case rather than rejecting the caller', async () => {
    const req = await signed({ clientId: 'ios' });
    const upper = new Request(req.url, {
      headers: { [CLIENT_ID_HEADER]: '  IOS  ', [CLIENT_SIGNATURE_HEADER]: req.headers.get(CLIENT_SIGNATURE_HEADER)! },
    });
    assert.deepEqual(await verifyClientAttestation(upper, SECRET, NOW_MS), { ok: true, clientId: 'ios' });
  });
});
