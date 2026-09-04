#!/usr/bin/env node
/**
 * Upstash-compatible Redis REST proxy.
 * Translates REST URL paths to raw Redis commands via redis npm package.
 *
 * Supports:
 *   GET  /{command}/{arg1}/{arg2}/...  → Redis command
 *   POST /                            → JSON body ["COMMAND", "arg1", ...]
 *   POST /pipeline                    → JSON body [["CMD1",...], ["CMD2",...]]
 *   POST /multi-exec                  → JSON body [["CMD1",...], ["CMD2",...]]
 *
 * Env:
 *   REDIS_URL  - Redis connection string (default: redis://redis:6379)
 *   SRH_TOKEN  - Bearer token for auth (default: none)
 *   PORT       - Listen port (default: 80)
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { createClient } from 'redis';

const REDIS_URL = process.env.SRH_CONNECTION_STRING || process.env.REDIS_URL || 'redis://redis:6379';
const TOKEN = process.env.SRH_TOKEN || '';
const PORT = parseInt(process.env.PORT || '80', 10);

// Redact userinfo before a connection string ever reaches stdout — REDIS_URL
// carries the Redis password (SRH_CONNECTION_STRING: redis://:<password>@host:port)
// and docker logs are readable by anyone with docker/compose access.
function maskRedisUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.password) parsed.password = '***';
    if (parsed.username) parsed.username = '***';
    return parsed.toString();
  } catch {
    return '<unparsable redis URL>';
  }
}

const client = createClient({ url: REDIS_URL });
client.on('error', (err) => console.error('Redis error:', err.message));
await client.connect();
console.log(`Connected to Redis at ${maskRedisUrl(REDIS_URL)}`);

function checkAuth(req) {
  if (!TOKEN) return true;
  const auth = req.headers.authorization || '';
  const prefix = 'Bearer ';
  if (!auth.startsWith(prefix)) return false;
  const provided = auth.slice(prefix.length);
  if (provided.length !== TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(TOKEN));
}

// Command safety: allowlist of expected Redis commands.
// Blocks destructive/admin operations: FLUSHALL, FLUSHDB, CONFIG, DEBUG, SLAVEOF,
// REPLICAOF, SHUTDOWN, KEYS, MIGRATE, CLUSTER.
//
// EVAL is ALLOWED, deliberately. It is not a safety regression: Upstash's REST API —
// which this proxy is a drop-in replacement for — permits EVAL too, so denying it
// here breaks parity rather than adding protection. Every EVAL in this repo is a
// compare-and-delete / compare-and-set lock primitive with no non-Lua equivalent
// (scripts/_seed-utils.mjs releaseLock, scripts/ais-relay.cjs, scripts/seed-forecasts.mjs,
// scripts/seed-military-bases.mjs, server/_shared/redis.ts). Denying it does not fail
// loudly everywhere either — pipeline callers surface it as a per-command {error} and
// swallow it, so story tracking would silently stop incrementing. The trust boundary
// is the bearer token above (timing-safe compare) plus keeping this proxy on the
// private network wherever the caller can reach it privately — not this list.
const ALLOWED_COMMANDS = new Set([
  'GET', 'SET', 'DEL', 'MGET', 'MSET', 'SCAN',
  'TTL', 'EXPIRE', 'PEXPIRE', 'PERSIST', 'EXISTS', 'TYPE', 'COPY',
  'HGET', 'HSET', 'HSETNX', 'HDEL', 'HGETALL', 'HMGET', 'HMSET', 'HKEYS', 'HVALS', 'HEXISTS', 'HLEN', 'HINCRBY',
  'LPUSH', 'RPUSH', 'LPOP', 'RPOP', 'LRANGE', 'LLEN', 'LTRIM', 'LREM',
  'SADD', 'SREM', 'SMEMBERS', 'SISMEMBER', 'SCARD',
  'ZADD', 'ZREM', 'ZRANGE', 'ZRANGEBYSCORE', 'ZREVRANGE', 'ZREVRANGEBYSCORE',
  'ZSCORE', 'ZCARD', 'ZCOUNT', 'ZRANDMEMBER', 'ZREMRANGEBYSCORE', 'ZREMRANGEBYRANK',
  'GEOADD', 'GEOSEARCH', 'GEOPOS', 'GEODIST',
  'INCR', 'DECR', 'INCRBY', 'DECRBY',
  'PING', 'ECHO', 'INFO', 'DBSIZE',
  'PUBLISH', 'SUBSCRIBE',
  'SETNX', 'SETEX', 'PSETEX', 'GETSET',
  'APPEND', 'STRLEN',
  'EVAL',
]);

async function runCommand(args) {
  const cmd = args[0].toUpperCase();
  if (!ALLOWED_COMMANDS.has(cmd)) {
    throw new Error(`Command not allowed: ${cmd}`);
  }
  const cmdArgs = args.slice(1);
  return client.sendCommand([cmd, ...cmdArgs.map(String)]);
}

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

async function readBody(req) {
  const chunks = [];
  let totalLength = 0;
  for await (const chunk of req) {
    totalLength += chunk.length;
    if (totalLength > MAX_BODY_BYTES) {
      req.destroy();
      throw new Error('Request body too large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

const server = http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');

  if (!checkAuth(req)) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  try {
    // POST / — single command
    if (req.method === 'POST' && (req.url === '/' || req.url === '')) {
      const body = JSON.parse(await readBody(req));
      const result = await runCommand(body);
      res.writeHead(200);
      res.end(JSON.stringify({ result }));
      return;
    }

    // POST /pipeline — batch commands
    if (req.method === 'POST' && req.url === '/pipeline') {
      const commands = JSON.parse(await readBody(req));
      const results = [];
      for (const cmd of commands) {
        try {
          const result = await runCommand(cmd);
          results.push({ result });
        } catch (err) {
          results.push({ error: err.message });
        }
      }
      res.writeHead(200);
      res.end(JSON.stringify(results));
      return;
    }

    // POST /multi-exec — transaction
    if (req.method === 'POST' && req.url === '/multi-exec') {
      const commands = JSON.parse(await readBody(req));
      const multi = client.multi();
      for (const cmd of commands) {
        const cmdName = cmd[0].toUpperCase();
        if (!ALLOWED_COMMANDS.has(cmdName)) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: `Command not allowed: ${cmdName}` }));
          return;
        }
        multi.sendCommand(cmd.map(String));
      }
      const results = await multi.exec();
      res.writeHead(200);
      res.end(JSON.stringify(results.map((r) => ({ result: r }))));
      return;
    }

    // GET / — welcome
    if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
      res.writeHead(200);
      res.end('"Welcome to Serverless Redis HTTP!"');
      return;
    }

    // GET /{command}/{args...} — REST style
    if (req.method === 'GET') {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const parts = pathname.slice(1).split('/').map(decodeURIComponent);
      if (parts.length === 0 || !parts[0]) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'No command specified' }));
        return;
      }
      const result = await runCommand(parts);
      res.writeHead(200);
      res.end(JSON.stringify({ result }));
      return;
    }

    // POST /{command}/{args...} — Upstash-compatible path-based POST
    // Used by setCachedJson(): POST /set/<key>/<value>/EX/<ttl>
    if (req.method === 'POST') {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const parts = pathname.slice(1).split('/').map(decodeURIComponent);
      if (parts.length === 0 || !parts[0]) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'No command specified' }));
        return;
      }
      const result = await runCommand(parts);
      res.writeHead(200);
      res.end(JSON.stringify({ result }));
      return;
    }

    // OPTIONS
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

// Bind dual-stack. Railway's private network is IPv6-only, so a service reached at
// <name>.railway.internal never connects to a listener bound to 0.0.0.0 — it just
// hangs until the caller's timeout, which looks like "Redis is down" rather than a
// bind problem. Binding '::' with ipv6Only unset (Node's default) accepts IPv4 too,
// so the public ingress keeps working.
//
// Fall back to 0.0.0.0 where IPv6 is unavailable: the default docker-compose bridge
// has no IPv6, and there listen('::') fails outright with EAFNOSUPPORT.
const BIND_HOST = process.env.BIND_HOST || '::';

function listen(host, isFallback = false) {
  server.once('error', (err) => {
    if (!isFallback && (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL' || err.code === 'EINVAL')) {
      console.warn(`IPv6 bind unavailable (${err.code}); falling back to 0.0.0.0`);
      listen('0.0.0.0', true);
      return;
    }
    console.error(`Failed to bind ${host}:${PORT}:`, err.message);
    process.exit(1);
  });
  server.listen(PORT, host, () => {
    console.log(`Redis REST proxy listening on ${host}:${PORT}`);
  });
}

listen(BIND_HOST);
