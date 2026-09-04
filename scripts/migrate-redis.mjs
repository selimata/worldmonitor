#!/usr/bin/env node
/**
 * Copy a Redis keyspace between two Upstash-REST-compatible endpoints.
 *
 * Used to move off managed Upstash onto a self-hosted redis + docker/redis-rest-proxy.mjs
 * (same wire protocol, so both sides speak the identical REST API and this script does
 * not care which is which).
 *
 * Value-level, NOT DUMP/RESTORE. DUMP payloads are serialization-version specific — a
 * payload from Redis 8.x cannot be RESTOREd into 7.x — so a type-aware read/write is the
 * only version-agnostic copy. It is also the only one that works through the REST proxy,
 * whose allowlist has no DUMP/RESTORE.
 *
 * TTLs are preserved. Keys that expire mid-run are skipped (TTL -2), not resurrected
 * without an expiry.
 *
 * Usage:
 *   SRC_URL=... SRC_TOKEN=... DST_URL=... DST_TOKEN=... node scripts/migrate-redis.mjs [flags]
 *
 * Source credentials fall back to UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
 * (and to a local .env file) so the common direction needs only DST_* set.
 *
 * Flags:
 *   --match <glob>   Only copy keys matching a Redis glob (repeatable).
 *                    e.g. --match 'live-activity:*'
 *   --dry-run        Report what would be copied; write nothing.
 *   --overwrite      Copy keys that already exist on the destination.
 *                    Default is to skip them, which makes the script resumable.
 *   --limit <n>      Stop after n keys (smoke test).
 *
 * Cost note: this reads ~3 commands per key from the source. A 78k-key keyspace is
 * ~240k commands — about $0.50 at Upstash pay-as-you-go rates. Budget for one run.
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- credentials

function loadDotEnv() {
  const file = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

const dotEnv = loadDotEnv();
const env = (k) => process.env[k] || dotEnv[k];

const SRC = {
  url: env('SRC_URL') || env('UPSTASH_REDIS_REST_URL'),
  token: env('SRC_TOKEN') || env('UPSTASH_REDIS_REST_TOKEN'),
};
const DST = { url: env('DST_URL'), token: env('DST_TOKEN') };

// ---------------------------------------------------------------------- flags

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const flagValues = (name) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === name && argv[i + 1]) out.push(argv[i + 1]);
  return out;
};
const flagValue = (name) => flagValues(name)[0];

const MATCHES = flagValues('--match');
const DRY_RUN = flag('--dry-run');
const OVERWRITE = flag('--overwrite');
const LIMIT = Number(flagValue('--limit') || 0) || Infinity;

// ------------------------------------------------------------------ transport

async function call(target, body, endpoint = '') {
  const res = await fetch(`${target.url}${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${target.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
  return res.json();
}

async function cmd(target, args) {
  const j = await call(target, args);
  if (j.error) throw new Error(String(j.error).slice(0, 300));
  return j.result;
}

/** Pipeline a batch; returns per-command {result}|{error} envelopes, order preserved. */
async function pipeline(target, commands) {
  if (commands.length === 0) return [];
  return call(target, commands, '/pipeline');
}

// Retry only transport-level failures. A rejected command (bad type, denied verb) is a
// bug in this script or a proxy allowlist gap — retrying it just hides the problem.
async function withRetry(fn, label) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      if (!/HTTP 5|timeout|aborted|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg)) throw err;
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
  }
  throw new Error(`${label}: ${lastErr?.message || lastErr}`);
}

// ----------------------------------------------------------------- key copying

const CHUNK = 400; // members per write command — keeps each pipeline well under limits

function chunked(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Build the destination write commands for one key.
 * Returns [] when the key vanished or holds an unsupported type.
 */
function buildWrites(key, type, ttl, value) {
  const expire = ttl > 0 ? [['EXPIRE', key, String(ttl)]] : [];

  switch (type) {
    case 'string':
      if (value === null) return [];
      // Single command carries the TTL — no window where the key exists unexpiring.
      return ttl > 0 ? [['SET', key, value, 'EX', String(ttl)]] : [['SET', key, value]];

    case 'hash': {
      // HGETALL returns a flat [field, value, ...] array over REST.
      const flat = Array.isArray(value) ? value : Object.entries(value ?? {}).flat();
      if (flat.length === 0) return [];
      const pairs = [];
      for (let i = 0; i < flat.length; i += 2) pairs.push([flat[i], flat[i + 1]]);
      return [...chunked(pairs, CHUNK).map((c) => ['HSET', key, ...c.flat()]), ...expire];
    }

    case 'set':
      if (!value?.length) return [];
      return [...chunked(value, CHUNK).map((c) => ['SADD', key, ...c]), ...expire];

    case 'zset': {
      // ZRANGE ... WITHSCORES returns flat [member, score, ...].
      if (!value?.length) return [];
      const scored = [];
      for (let i = 0; i < value.length; i += 2) scored.push([value[i + 1], value[i]]); // ZADD wants score first
      return [...chunked(scored, CHUNK).map((c) => ['ZADD', key, ...c.flat()]), ...expire];
    }

    case 'list':
      if (!value?.length) return [];
      return [...chunked(value, CHUNK).map((c) => ['RPUSH', key, ...c]), ...expire];

    default:
      return null; // unsupported type — caller reports it
  }
}

const READ_BY_TYPE = {
  string: (k) => ['GET', k],
  hash: (k) => ['HGETALL', k],
  set: (k) => ['SMEMBERS', k],
  zset: (k) => ['ZRANGE', k, '0', '-1', 'WITHSCORES'],
  list: (k) => ['LRANGE', k, '0', '-1'],
};

// ----------------------------------------------------------------------- main

async function main() {
  for (const [label, target] of [['source', SRC], ['destination', DST]]) {
    if (!target.url || !target.token) {
      if (label === 'destination' && DRY_RUN) continue;
      console.error(
        `Missing ${label} credentials. Set ${label === 'source' ? 'SRC_URL/SRC_TOKEN (or UPSTASH_REDIS_REST_*)' : 'DST_URL/DST_TOKEN'}.`,
      );
      process.exit(1);
    }
  }

  console.log(`source      : ${new URL(SRC.url).host}`);
  console.log(`destination : ${DRY_RUN ? '(dry run — no writes)' : new URL(DST.url).host}`);
  if (MATCHES.length) console.log(`match       : ${MATCHES.join(', ')}`);
  console.log(`mode        : ${OVERWRITE ? 'overwrite' : 'skip keys already on destination'}\n`);

  if (!DRY_RUN) {
    // Fail fast and loudly if the destination proxy rejects a verb we depend on,
    // rather than 40k keys into the run.
    const probeKey = `migrate-redis:probe:${Date.now()}`;
    const probe = await pipeline(DST, [
      ['SET', probeKey, 'ok', 'EX', '60'],
      ['HSET', probeKey + ':h', 'f', 'v'],
      ['ZADD', probeKey + ':z', '1', 'm'],
      ['SADD', probeKey + ':s', 'm'],
      ['RPUSH', probeKey + ':l', 'm'],
      ['EXPIRE', probeKey + ':h', '60'],
      ['EXPIRE', probeKey + ':z', '60'],
      ['EXPIRE', probeKey + ':s', '60'],
      ['EXPIRE', probeKey + ':l', '60'],
    ]);
    const denied = probe.map((p, i) => (p?.error ? `#${i}: ${p.error}` : null)).filter(Boolean);
    if (denied.length) {
      console.error('Destination rejected required write commands:\n  ' + denied.join('\n  '));
      console.error('\nIf this is docker/redis-rest-proxy.mjs, add the verbs to ALLOWED_COMMANDS.');
      process.exit(1);
    }
  }

  const patterns = MATCHES.length ? MATCHES : ['*'];
  const stats = { scanned: 0, copied: 0, skipped: 0, expired: 0, unsupported: 0, failed: 0 };
  const problems = [];
  const seen = new Set();
  let stop = false;

  for (const pattern of patterns) {
    let cursor = '0';
    do {
      const scanArgs = ['SCAN', cursor, 'COUNT', '500'];
      if (pattern !== '*') scanArgs.push('MATCH', pattern);
      const [next, keys] = await withRetry(() => cmd(SRC, scanArgs), 'SCAN');
      cursor = next;

      // SCAN can return the same key twice across cursor iterations.
      const batch = keys.filter((k) => !seen.has(k) && (seen.add(k), true));
      if (batch.length === 0) continue;
      stats.scanned += batch.length;

      let todo = batch;
      if (!OVERWRITE) {
        const exists = await withRetry(() => pipeline(DST, todo.map((k) => ['EXISTS', k])), 'EXISTS');
        todo = todo.filter((k, i) => {
          if (exists[i]?.result === 1) { stats.skipped++; return false; }
          return true;
        });
        if (todo.length === 0) continue;
      }

      // TYPE + TTL for the batch, then the type-specific read.
      const meta = await withRetry(
        () => pipeline(SRC, todo.flatMap((k) => [['TYPE', k], ['TTL', k]])),
        'TYPE/TTL',
      );

      const reads = [];
      const pending = [];
      todo.forEach((key, i) => {
        const type = meta[i * 2]?.result;
        const ttl = meta[i * 2 + 1]?.result;
        if (ttl === -2 || type === 'none') { stats.expired++; return; }
        const reader = READ_BY_TYPE[type];
        if (!reader) {
          stats.unsupported++;
          problems.push(`${key}: unsupported type ${type}`);
          return;
        }
        pending.push({ key, type, ttl });
        reads.push(reader(key));
      });
      if (pending.length === 0) continue;

      const values = await withRetry(() => pipeline(SRC, reads), 'value read');

      const writes = [];
      const written = [];
      pending.forEach(({ key, type, ttl }, i) => {
        if (values[i]?.error) {
          stats.failed++;
          problems.push(`${key}: read failed — ${values[i].error}`);
          return;
        }
        const cmds = buildWrites(key, type, ttl, values[i]?.result);
        if (cmds === null) {
          stats.unsupported++;
          problems.push(`${key}: unsupported type ${type}`);
          return;
        }
        if (cmds.length === 0) { stats.expired++; return; }
        writes.push(...cmds);
        written.push(key);
      });

      if (writes.length && !DRY_RUN) {
        const res = await withRetry(() => pipeline(DST, writes), 'write');
        const errs = res.filter((r) => r?.error);
        if (errs.length) {
          stats.failed += errs.length;
          for (const e of errs.slice(0, 5)) problems.push(`write failed — ${e.error}`);
        }
      }
      stats.copied += written.length;

      if (stats.scanned % 5000 < 500) {
        process.stdout.write(
          `  scanned ${stats.scanned}  copied ${stats.copied}  skipped ${stats.skipped}  expired ${stats.expired}\n`,
        );
      }
      if (stats.copied >= LIMIT) { stop = true; break; }
    } while (cursor !== '0');
    if (stop) break;
  }

  console.log('\n--- summary ---');
  for (const [k, v] of Object.entries(stats)) console.log(`${k.padEnd(12)} ${v}`);
  if (problems.length) {
    console.log(`\nproblems (${problems.length}, first 20):`);
    for (const p of problems.slice(0, 20)) console.log('  ' + p);
  }
  // A partial copy that reports success is the failure mode worth guarding against.
  if (stats.failed > 0 || stats.unsupported > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('migration failed:', err?.message || err);
  process.exit(1);
});
