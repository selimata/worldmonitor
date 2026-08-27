import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// The gate this covers is an authorization decision, and the only reason it is
// asserted against source rather than a live request is that exercising the
// gateway needs Clerk, Convex and Redis. What matters here is the shape: the
// exemption must stay pinned to one path, one method, and an explicit opt-in.
const gateway = readFileSync(new URL('../server/gateway.ts', import.meta.url), 'utf8');

function block(name: string): string {
  const start = gateway.indexOf(`const ${name} =`);
  assert.notEqual(start, -1, `${name} is missing from gateway.ts`);
  return gateway.slice(start, gateway.indexOf(';', start));
}

test('the public country brief is limited to one path and one method', () => {
  const decl = block('isCountryBriefPublic');
  assert.match(decl, /pathname === COUNTRY_INTEL_BRIEF_PATH/);
  assert.match(decl, /request\.method === 'GET'/);
});

test('opening the brief requires an explicit opt-in, never a default', () => {
  const decl = block('isCountryBriefPublic');
  assert.match(decl, /process\.env\.WM_COUNTRY_BRIEF_PUBLIC === '1'/);
  // An absent variable must not read as enabled: no truthiness checks, no
  // `!== '0'`, no default that opens the route when nothing is configured.
  assert.doesNotMatch(decl, /WM_COUNTRY_BRIEF_PUBLIC\s*(\?\?|\|\||!==)/);
});

test('the Docker self-host exemption still applies', () => {
  assert.match(block('isCountryBriefPublic'), /LOCAL_API_MODE === 'docker'/);
});

test('opening the route drops the key gate and the entitlement lookup together', () => {
  // Skipping one without the other leaves the route rejecting for the other
  // reason, which reads as "the flag does nothing".
  assert.match(gateway, /forceKey: \(\(isTierGated && !sessionUserId\) \|\| needsLegacyProBearerGate\)\s*\n\s*&& !isCountryBriefPublic,/);
  assert.match(gateway, /!countryBriefSessionAuthorized &&\s*\n\s*!isEnterpriseAuth &&/);
});

test('only a valid anonymous session is authorized, not the absence of one', () => {
  const decl = block('countryBriefSessionAuthorized');
  assert.match(decl, /keyCheck\.valid/);
  assert.match(decl, /keyCheck\.kind === 'session'/);
});

test('spend attribution stays Docker-only', () => {
  // On a hosted deployment there is no nginx to supply a trusted address, so an
  // opened brief must fall through to the anonymous IP bucket rather than mint
  // a 'docker:' principal for something this deployment does not run.
  assert.match(block('dockerSelfHostSessionAuthorized'), /LOCAL_API_MODE === 'docker'/);
});
