#!/usr/bin/env node
/**
 * Point the Railway services at the self-hosted Redis REST proxy — or put them back.
 *
 * This is HALF a cutover. The Vercel functions read the same cache and must be flipped
 * in the same window; if only Railway moves, seeders write to the new Redis while the
 * API still reads Upstash and panels go blank. Set these on Vercel and redeploy:
 *
 *   UPSTASH_REDIS_REST_URL   = https://<proxy public domain>
 *   UPSTASH_REDIS_REST_TOKEN = <REDIS_TOKEN from ~/.worldmonitor-redis-migration.json>
 *
 * Railway services use the PRIVATE domain instead, so their traffic never leaves the
 * project and is not billed as egress.
 *
 * UPSTASH_ALLOW_INSECURE_HTTP=true is required because the private URL is http://.
 * scripts/ais-relay.cjs (line ~288) disables Redis outright for a non-https URL without
 * that opt-in — silently, which is how "every seed loop stopped for 4+ days" happened
 * before. Set on all four services: harmless where the guard does not exist.
 *
 * The previous UPSTASH_* values are snapshotted into the secrets file on first run, so
 * --rollback is exact rather than reconstructed.
 *
 * Usage:
 *   RAILWAY_PROJECT_TOKEN=<token> node scripts/railway-cutover-redis.mjs [--dry-run]
 *   RAILWAY_PROJECT_TOKEN=<token> node scripts/railway-cutover-redis.mjs --rollback
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN = process.env.RAILWAY_PROJECT_TOKEN;
if (!TOKEN) {
  console.error('Set RAILWAY_PROJECT_TOKEN.');
  process.exit(1);
}

const SECRETS_FILE = path.join(os.homedir(), '.worldmonitor-redis-migration.json');
const API = 'https://backboard.railway.app/graphql/v2';
const DRY_RUN = process.argv.includes('--dry-run');
const ROLLBACK = process.argv.includes('--rollback');

// Services that read the cache. The proxy and Redis itself are excluded.
const CONSUMERS = ['ais-relay', 'worldmonitor', 'seed-wildfires', 'seed-pizzint'];

async function gql(query, variables = {}) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Project-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  if (json.errors) throw new Error(json.errors.map((e) => e.message).join('; '));
  return json.data;
}

async function main() {
  const secrets = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
  if (!secrets.REDIS_TOKEN) throw new Error('REDIS_TOKEN missing from the secrets file');

  const { projectToken: scope } = await gql('{ projectToken { projectId environmentId } }');
  const { projectId, environmentId } = scope;

  const project = await gql('query($id:String!){ project(id:$id){ services{edges{node{id name}}} } }', { id: projectId });
  const byName = new Map(project.project.services.edges.map((e) => [e.node.name, e.node.id]));

  const targets = CONSUMERS.filter((n) => byName.has(n));
  const absent = CONSUMERS.filter((n) => !byName.has(n));
  if (absent.length) console.warn(`not found, skipping: ${absent.join(', ')}`);

  // Snapshot the current values BEFORE the first write, so rollback restores reality.
  secrets.rollback ??= {};
  for (const name of targets) {
    if (secrets.rollback[name]) continue;
    const v = await gql(
      'query($p:String!,$e:String!,$s:String!){ variables(projectId:$p,environmentId:$e,serviceId:$s) }',
      { p: projectId, e: environmentId, s: byName.get(name) },
    );
    secrets.rollback[name] = {
      UPSTASH_REDIS_REST_URL: v.variables?.UPSTASH_REDIS_REST_URL ?? '',
      UPSTASH_REDIS_REST_TOKEN: v.variables?.UPSTASH_REDIS_REST_TOKEN ?? '',
      UPSTASH_ALLOW_INSECURE_HTTP: v.variables?.UPSTASH_ALLOW_INSECURE_HTTP ?? '',
    };
  }
  if (!DRY_RUN) fs.writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2), { mode: 0o600 });

  for (const name of targets) {
    const vars = ROLLBACK
      ? secrets.rollback[name]
      : {
        UPSTASH_REDIS_REST_URL: 'http://redis-rest.railway.internal:80',
        UPSTASH_REDIS_REST_TOKEN: secrets.REDIS_TOKEN,
        UPSTASH_ALLOW_INSECURE_HTTP: 'true',
      };

    console.log(`${name}: UPSTASH_REDIS_REST_URL -> ${vars.UPSTASH_REDIS_REST_URL || '(empty)'}`);
    if (DRY_RUN) continue;

    await gql('mutation($i:VariableCollectionUpsertInput!){ variableCollectionUpsert(input:$i) }', {
      i: {
        projectId,
        environmentId,
        serviceId: byName.get(name),
        variables: vars,
        replace: false,
        // A variable change already triggers a redeploy; skipping the implicit one keeps
        // all four services flipping together rather than restarting mid-write.
        skipDeploys: true,
      },
    });
  }

  if (DRY_RUN) {
    console.log('\ndry run — nothing written');
    return;
  }

  console.log('\nvariables set. Now redeploy all four so they pick them up:');
  for (const name of targets) {
    await gql('mutation($s:String!,$e:String!){ serviceInstanceRedeploy(serviceId:$s,environmentId:$e) }', {
      s: byName.get(name), e: environmentId,
    });
    console.log(`  ${name}: redeploy triggered`);
  }

  console.log(ROLLBACK
    ? '\nRolled back to the snapshotted Upstash values.'
    : `\nRailway side done. Set these on Vercel and redeploy, or the API keeps reading Upstash:
  UPSTASH_REDIS_REST_URL   = https://${secrets.PUBLIC_DOMAIN}
  UPSTASH_REDIS_REST_TOKEN = (REDIS_TOKEN in ${SECRETS_FILE})

Rollback:  node scripts/railway-cutover-redis.mjs --rollback`);
}

main().catch((err) => {
  console.error('cutover failed:', err.message);
  process.exit(1);
});
