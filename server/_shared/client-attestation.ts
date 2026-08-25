/**
 * Client attestation — marks a request as coming from a first-party app build.
 *
 * WHAT THIS IS NOT: proof of anything. The signing secret ships inside the app
 * binary, so whoever extracts it can sign whatever they like. This raises the
 * cost of impersonation from `strings App.ipa` (seconds, no skill) to reversing
 * the signing routine and tracking the timestamp window (hours, some skill). It
 * is friction, deliberately chosen over a static bearer token, and it must never
 * be the only thing standing between a caller and something that matters.
 *
 * Real unforgeable client attestation on iOS is App Attest: the key lives in the
 * Secure Enclave and cannot leave the device. Reach for that before gating
 * anything with revenue attached to it.
 *
 * WHAT IT IS FOR: telling our own traffic apart from everyone else's — abuse
 * triage, per-client rate policy, honest analytics — and stopping a passer-by
 * from *claiming* to be the app. A caller who simply omits these headers is not
 * refused; they get the ordinary public surface like any other client.
 *
 * Payload bound to the signature (newline-joined, order fixed):
 *   clientId \n unixSeconds \n METHOD \n pathname \n canonicalQuery
 *
 * The method and path are inside the signature so a captured header pair cannot
 * be lifted onto a different route. The body is not: this is a first-party
 * marker, not an integrity check, and hashing every upload to re-sign it would
 * cost more than the property is worth.
 */
import { canonicalQueryString, hmacSha256Base64Url } from './mcp-internal-hmac';

/** Names the claimed client, e.g. `ios`. Presence is what arms verification. */
export const CLIENT_ID_HEADER = 'X-WM-Client';
/** `<unixSeconds>.<base64url-sig>`. */
export const CLIENT_SIGNATURE_HEADER = 'X-WM-Client-Signature';

/**
 * Accepted clock skew, each way. Far wider than the internal-MCP window (30s)
 * on purpose: that one is server-to-server on NTP-synced hosts, this one is a
 * handset whose clock the user can set by hand. Five minutes is the usual
 * allowance for exactly this reason, and the window only has to be tight enough
 * that a captured signature stops being useful before anyone notices it.
 */
export const CLIENT_TIMESTAMP_WINDOW_SECONDS = 300;

/** Bounded on both ends so a hostile header cannot become a large allocation. */
const MAX_CLIENT_ID_LENGTH = 32;
const CLIENT_ID_SHAPE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export type ClientAttestation =
  | { ok: true; clientId: string }
  | { ok: false; reason: 'malformed' | 'bad-client-id' | 'stale' | 'mismatch' };

export function clientAttestationPayload(
  clientId: string,
  unixSeconds: number,
  method: string,
  pathname: string,
  search: string | URL,
): string {
  return [
    clientId,
    String(unixSeconds),
    method.toUpperCase(),
    pathname,
    canonicalQueryString(search),
  ].join('\n');
}

/** Compare without leaking, through timing, how much of the signature matched. */
function equalsConstantTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyClientAttestation(
  request: Request,
  secret: string,
  nowMs: number = Date.now(),
): Promise<ClientAttestation> {
  const clientId = (request.headers.get(CLIENT_ID_HEADER) ?? '').trim().toLowerCase();
  const raw = (request.headers.get(CLIENT_SIGNATURE_HEADER) ?? '').trim();
  if (!clientId || clientId.length > MAX_CLIENT_ID_LENGTH || !raw) return { ok: false, reason: 'malformed' };
  if (!CLIENT_ID_SHAPE.test(clientId)) return { ok: false, reason: 'bad-client-id' };

  // Split on the FIRST dot only: base64url never contains one, so anything
  // after it belongs to the signature and a second dot is simply invalid input.
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return { ok: false, reason: 'malformed' };
  const tsPart = raw.slice(0, dot);
  const provided = raw.slice(dot + 1);
  if (!/^\d{1,15}$/.test(tsPart)) return { ok: false, reason: 'malformed' };

  const unixSeconds = Number(tsPart);
  const skewSeconds = Math.abs(nowMs / 1000 - unixSeconds);
  // Rejected in both directions: a future timestamp is how a signature captured
  // now would be stockpiled for later.
  if (skewSeconds > CLIENT_TIMESTAMP_WINDOW_SECONDS) return { ok: false, reason: 'stale' };

  const url = new URL(request.url);
  const expected = await hmacSha256Base64Url(
    secret,
    clientAttestationPayload(clientId, unixSeconds, request.method, url.pathname, url),
  );
  if (!equalsConstantTime(expected, provided)) return { ok: false, reason: 'mismatch' };
  return { ok: true, clientId };
}
