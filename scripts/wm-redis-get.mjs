#!/usr/bin/env node
/**
 * Read-only look into the production cache (Railway `redis-rest`).
 *
 * Credentials are read here, from ~/.worldmonitor-redis-migration.json
 * (REDIS_TOKEN + PUBLIC_DOMAIN, written by railway-provision-redis.mjs), and
 * never printed — so a caller can be allowed to run this without ever holding
 * the token. Only commands in READ_ONLY go out; anything else is refused
 * before a request is made.
 *
 *   node scripts/wm-redis-get.mjs news <regex> [--variant full] [--lang en]
 *       Search the live feed digest (news:digest:v1:<variant>:<lang>) by title.
 *   node scripts/wm-redis-get.mjs pool [--hours 12] [--out file.json]
 *       Every headline of the last N hours from the daily-brief pool
 *       (news:brief-pool:v1:<day>, written by the relay), newest first.
 *   node scripts/wm-redis-get.mjs <COMMAND> [args...] [--max <chars>]
 *       e.g. GET live-activity:active:v1 · TTL news:insights:v1 · HGETALL <key>
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SECRETS_FILE = path.join(os.homedir(), '.worldmonitor-redis-migration.json');

const READ_ONLY = new Set([
  'GET', 'MGET', 'STRLEN', 'EXISTS', 'TYPE', 'TTL', 'PTTL',
  'HGET', 'HMGET', 'HGETALL', 'HKEYS', 'HLEN',
  'ZRANGE', 'ZCARD', 'ZSCORE', 'SMEMBERS', 'SCARD', 'LRANGE', 'LLEN',
]);

function fail(msg) {
  console.error(`wm-redis-get: ${msg}`);
  process.exit(1);
}

function takeFlag(args, name, fallback) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const value = args[i + 1];
  args.splice(i, 2);
  return value ?? fallback;
}

function loadEndpoint() {
  let secrets;
  try {
    secrets = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
  } catch {
    fail(`cannot read ${SECRETS_FILE}`);
  }
  if (!secrets.REDIS_TOKEN || !secrets.PUBLIC_DOMAIN) fail(`${SECRETS_FILE} lacks REDIS_TOKEN or PUBLIC_DOMAIN`);
  return { url: `https://${secrets.PUBLIC_DOMAIN}`, token: secrets.REDIS_TOKEN };
}

async function command(endpoint, args) {
  const verb = String(args[0] || '').toUpperCase();
  if (!READ_ONLY.has(verb)) fail(`refusing ${verb || '(none)'}: read-only commands are ${[...READ_ONLY].join(', ')}`);
  let res;
  try {
    res = await fetch(endpoint.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([verb, ...args.slice(1)]),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    // The cause can carry the host; the message alone is enough to act on.
    fail(`request failed: ${e?.name || 'error'}`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.error) fail(`HTTP ${res.status}${body?.error ? `: ${body.error}` : ''}`);
  return body.result;
}

/** Every object carrying a title and a link, wherever the digest nests it. */
function collectItems(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => collectItems(n, out));
  else if (node && typeof node === 'object') {
    if (typeof node.title === 'string' && typeof node.link === 'string') out.push(node);
    Object.values(node).forEach((n) => collectItems(n, out));
  }
  return out;
}

function isoOf(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString().slice(0, 16) + 'Z' : '?';
}

async function searchNews(endpoint, args) {
  const variant = takeFlag(args, '--variant', 'full');
  const lang = takeFlag(args, '--lang', 'en');
  const pattern = args.join(' ');
  if (!pattern) fail('usage: news <regex> [--variant full] [--lang en]');
  const re = new RegExp(pattern, 'i');
  const key = `news:digest:v1:${variant}:${lang}`;
  const [raw, ttl] = [await command(endpoint, ['GET', key]), await command(endpoint, ['TTL', key])];
  if (raw == null) fail(`${key} is empty (TTL ${ttl})`);
  const digest = JSON.parse(raw);
  const items = collectItems(digest.categories ?? digest);
  const hits = items.filter((it) => re.test(it.title));
  console.log(`${key}: generatedAt ${digest.generatedAt ?? '?'}, TTL ${ttl}s, ${items.length} items, ${hits.length} match /${pattern}/i`);
  for (const it of hits.sort((a, b) => Number(b.publishedAt) - Number(a.publishedAt))) {
    const level = it.threat?.level ?? '-';
    console.log(`${isoOf(it.publishedAt)} | ${level} | ${it.source ?? '?'} | ${it.title} | ${it.link}`);
  }
}

async function readPool(endpoint, args) {
  const hours = Number(takeFlag(args, '--hours', '12'));
  const out = takeFlag(args, '--out', '');
  if (!Number.isFinite(hours) || hours <= 0 || hours > 48) fail('--hours must be between 0 and 48');
  const now = Date.now();
  const since = now - hours * 3600e3;
  const days = [...new Set([since, now].map((ms) => new Date(ms).toISOString().slice(0, 10)))];
  const items = [];
  for (const day of days) {
    const flat = (await command(endpoint, ['HGETALL', `news:brief-pool:v1:${day}`])) || [];
    // The REST proxy returns HGETALL as [field, value, field, value, …].
    for (let i = 1; i < flat.length; i += 2) {
      try {
        const it = JSON.parse(flat[i]);
        if (Number(it.publishedAt) >= since) items.push(it);
      } catch { /* a malformed entry is skipped, not fatal */ }
    }
  }
  items.sort((a, b) => Number(b.publishedAt) - Number(a.publishedAt));
  const text = JSON.stringify(items, null, out ? 0 : 2);
  if (out) fs.writeFileSync(out, text);
  else console.log(text);
  const oldest = items.length ? isoOf(items[items.length - 1].publishedAt) : '-';
  console.error(`pool: ${items.length} items from ${days.join(', ')}, last ${hours}h (oldest ${oldest})${out ? ` → ${out}` : ''}`);
}

const args = process.argv.slice(2);
if (!args.length) fail('usage: news <regex> | pool [--hours N] [--out file] | <READ_ONLY COMMAND> [args...] [--max <chars>]');
const endpoint = loadEndpoint();

if (args[0] === 'news') {
  await searchNews(endpoint, args.slice(1));
} else if (args[0] === 'pool') {
  await readPool(endpoint, args.slice(1));
} else {
  const max = Number(takeFlag(args, '--max', '4000'));
  const result = await command(endpoint, args);
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  console.log(text.length > max ? `${text.slice(0, max)}\n… (${text.length} chars, raise --max)` : text);
}
