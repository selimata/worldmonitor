#!/usr/bin/env node
/**
 * Provision a self-hosted Redis + REST proxy pair on Railway, replacing managed Upstash.
 *
 * Creates two services in the project the token is scoped to:
 *   redis       docker.io/redis:8-alpine, /data volume, AOF on, noeviction
 *   redis-rest  built from docker/Dockerfile.redis-rest — speaks the Upstash REST API,
 *               so no application code changes; only UPSTASH_REDIS_REST_URL/TOKEN move.
 *
 * Idempotent: re-running skips services that already exist and reuses the generated
 * credentials, so it is safe to run again after a partial failure.
 *
 * Generated secrets are written OUTSIDE the repo, to:
 *   ~/.worldmonitor-redis-migration.json   (mode 0600)
 * They are needed by scripts/migrate-redis.mjs and for the cutover, so keep the file
 * until the migration is done.
 *
 * Usage:
 *   RAILWAY_PROJECT_TOKEN=<project token> node scripts/railway-provision-redis.mjs
 *
 * Notes:
 *   - Redis binds "0.0.0.0 -::" because Railway's private network is IPv6-only; a
 *     listener bound to IPv4 alone is unreachable at redis.railway.internal and the
 *     caller just hangs. The "-" prefix makes the IPv6 bind optional so it still boots
 *     where IPv6 is absent.
 *   - This script only CREATES the new services. It deliberately does not repoint any
 *     existing service at them: a partial cutover (Railway flipped, Vercel not) means
 *     seeders write to the new Redis while the API reads the old one. Flip every
 *     consumer together, after the data copy.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN = process.env.RAILWAY_PROJECT_TOKEN;
if (!TOKEN) {
  console.error('Set RAILWAY_PROJECT_TOKEN (Railway → project → Settings → Tokens).');
  process.exit(1);
}

const API = 'https://backboard.railway.app/graphql/v2';
const SECRETS_FILE = path.join(os.homedir(), '.worldmonitor-redis-migration.json');
const REPO = process.env.RAILWAY_SOURCE_REPO || 'selimata/worldmonitor';

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

function loadSecrets() {
  if (!fs.existsSync(SECRETS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveSecrets(obj) {
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

async function main() {
  const scope = await gql('{ projectToken { projectId environmentId } }');
  const projectId = scope.projectToken.projectId;
  const environmentId = scope.projectToken.environmentId;

  // A volume's service attachment lives on VolumeInstance, not Volume itself.
  const project = await gql(
    `query($id:String!){ project(id:$id){ name
       services{edges{node{id name}}}
       volumes{edges{node{id name volumeInstances{edges{node{serviceId mountPath}}}}}} } }`,
    { id: projectId },
  );
  const existing = new Map(project.project.services.edges.map((e) => [e.node.name, e.node.id]));
  const volumeServiceIds = new Set(
    (project.project.volumes?.edges ?? [])
      .flatMap((v) => v.node.volumeInstances?.edges ?? [])
      .map((i) => i.node.serviceId)
      .filter(Boolean),
  );
  console.log(`project: ${project.project.name}`);
  console.log(`existing services: ${[...existing.keys()].join(', ')}\n`);

  const secrets = loadSecrets();
  secrets.REDIS_PASSWORD ||= crypto.randomBytes(32).toString('hex');
  secrets.REDIS_TOKEN ||= crypto.randomBytes(32).toString('hex');
  saveSecrets(secrets);

  // ---------------------------------------------------------------- redis
  // Create-if-missing, then ALWAYS re-apply config. Doing the config inside an else
  // branch would mean a failure between create and configure leaves a half-built
  // service that a re-run silently skips.
  let redisId = existing.get('redis');
  if (redisId) {
    console.log(`redis: already exists (${redisId})`);
  } else {
    const created = await gql(
      'mutation($i:ServiceCreateInput!){ serviceCreate(input:$i){ id } }',
      {
        i: {
          projectId,
          environmentId,
          name: 'redis',
          source: { image: 'redis:8-alpine' },
          variables: { REDIS_PASSWORD: secrets.REDIS_PASSWORD },
        },
      },
    );
    redisId = created.serviceCreate.id;
    console.log(`redis: created ${redisId}`);
  }

  await gql(
    'mutation($s:String!,$e:String!,$i:ServiceInstanceUpdateInput!){ serviceInstanceUpdate(serviceId:$s,environmentId:$e,input:$i) }',
    {
      s: redisId,
      e: environmentId,
      i: {
        startCommand:
          'redis-server --requirepass "$REDIS_PASSWORD" --bind "0.0.0.0 -::"'
          + ' --maxmemory 1gb --maxmemory-policy noeviction --appendonly yes --dir /data',
        restartPolicyType: 'ALWAYS',
      },
    },
  );
  console.log('redis: start command applied');

  if (volumeServiceIds.has(redisId)) {
    console.log('redis: volume already attached');
  } else {
    // Non-fatal: everything else is already provisioned by this point, and a volume
    // is attachable from the dashboard in two clicks. Losing the whole run over it
    // would mean re-running just to reach the steps after this one.
    try {
      await gql('mutation($i:VolumeCreateInput!){ volumeCreate(input:$i){ id } }', {
        i: { projectId, environmentId, serviceId: redisId, mountPath: '/data' },
      });
      console.log('redis: /data volume attached');
    } catch (err) {
      console.warn(`redis: could not attach volume — ${err.message}`);
      console.warn('  Attach manually: Railway → redis → Settings → Volumes → mount at /data');
      console.warn('  Without it the cache is lost on every redeploy (it still reseeds).');
    }
  }

  // ----------------------------------------------------------- redis-rest
  let proxyId = existing.get('redis-rest');
  if (proxyId) {
    console.log(`redis-rest: already exists (${proxyId})`);
  } else {
    const created = await gql(
      'mutation($i:ServiceCreateInput!){ serviceCreate(input:$i){ id } }',
      {
        i: {
          projectId,
          environmentId,
          name: 'redis-rest',
          source: { repo: REPO },
          variables: {
            SRH_TOKEN: secrets.REDIS_TOKEN,
            SRH_CONNECTION_STRING: `redis://:${secrets.REDIS_PASSWORD}@redis.railway.internal:6379`,
          },
        },
      },
    );
    proxyId = created.serviceCreate.id;
    console.log(`redis-rest: created ${proxyId}`);
  }

  await gql(
    'mutation($s:String!,$e:String!,$i:ServiceInstanceUpdateInput!){ serviceInstanceUpdate(serviceId:$s,environmentId:$e,input:$i) }',
    {
      s: proxyId,
      e: environmentId,
      i: {
        rootDirectory: 'docker',
        dockerfilePath: 'Dockerfile.redis-rest',
        restartPolicyType: 'ALWAYS',
        // Only rebuild when the proxy itself changes, not on every app commit.
        watchPatterns: 'docker/**',
      },
    },
  );
  console.log('redis-rest: build config applied (docker/Dockerfile.redis-rest)');

  // Public domain — Vercel functions reach the proxy over the internet; the four
  // Railway services should use redis-rest.railway.internal instead (no egress).
  let domain = secrets.PUBLIC_DOMAIN;
  if (!domain) {
    try {
      const d = await gql(
        'mutation($i:ServiceDomainCreateInput!){ serviceDomainCreate(input:$i){ domain } }',
        { i: { environmentId, serviceId: proxyId, targetPort: 80 } },
      );
      domain = d.serviceDomainCreate.domain;
      console.log(`redis-rest: public domain ${domain}`);
    } catch (err) {
      console.warn(`redis-rest: could not create public domain — ${err.message}`);
      console.warn('  Create it manually: Railway → redis-rest → Settings → Networking → Generate Domain');
    }
  }

  secrets.projectId = projectId;
  secrets.environmentId = environmentId;
  secrets.redisId = redisId;
  secrets.proxyId = proxyId;
  if (domain) secrets.PUBLIC_DOMAIN = domain;
  saveSecrets(secrets);

  const publicUrl = domain ? `https://${domain}` : '<generate a domain, then https://…>';

  console.log(`\nSecrets written to ${SECRETS_FILE} (mode 0600).`);
  console.log('\n--- next ---');
  console.log('1. Wait for both services to go green in the Railway dashboard.');
  console.log('2. Smoke-test the proxy:');
  console.log(`     curl -s -X POST ${publicUrl} \\`);
  console.log('       -H "Authorization: Bearer $(jq -r .REDIS_TOKEN ~/.worldmonitor-redis-migration.json)" \\');
  console.log('       -H \'Content-Type: application/json\' -d \'["PING"]\'');
  console.log('   Expect: {"result":"PONG"}');
  console.log('3. Copy the keyspace (source creds come from .env):');
  console.log(`     DST_URL=${publicUrl} \\`);
  console.log('     DST_TOKEN=$(jq -r .REDIS_TOKEN ~/.worldmonitor-redis-migration.json) \\');
  console.log('     node scripts/migrate-redis.mjs');
  console.log('4. Cut over EVERY consumer together (Vercel + the 4 Railway services):');
  console.log('     UPSTASH_REDIS_REST_TOKEN = <REDIS_TOKEN from the secrets file>');
  console.log(`     UPSTASH_REDIS_REST_URL   = ${publicUrl}   (Vercel)`);
  console.log('     UPSTASH_REDIS_REST_URL   = http://redis-rest.railway.internal   (Railway services — no egress)');
  console.log('5. Keep the Upstash database for 24h as a rollback path before deleting it.');
}

main().catch((err) => {
  console.error('provisioning failed:', err.message);
  process.exit(1);
});
