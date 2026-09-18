// docker/redis-rest-proxy.mjs connects to Redis and listens on import, so run its
// source with only createClient mocked and a real http server on an ephemeral port.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '../docker/redis-rest-proxy.mjs'), 'utf8')
  .replace(/^#!.*\n/, '')
  .replace(/^import .*;\n/gm, '');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const BIG = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ id: i, title: `story ${i}` })) });
const SMALL = '{"ok":true}';

let server;
let base;

before(async () => {
  let captured;
  const httpMock = {
    createServer(handler) {
      server = http.createServer(handler);
      captured = server;
      return { listen: (_port, _host, cb) => server.listen(0, '127.0.0.1', cb), once() {} };
    },
  };
  const client = {
    on() {},
    async connect() {},
    async sendCommand([cmd, key]) {
      if (cmd === 'GET') return key === 'big' ? BIG : SMALL;
      return 'PONG';
    },
    multi() { return { sendCommand() {}, async exec() { return []; } }; },
  };
  const run = new AsyncFunction('process', 'http', 'crypto', 'zlib', 'createClient', 'console', source);
  await run({ env: { PORT: '0', SRH_TOKEN: 'tok' }, exit() {} }, httpMock, crypto, zlib, () => client, { log() {}, error() {}, warn() {} });
  await new Promise((r) => setTimeout(r, 20));
  base = `http://127.0.0.1:${captured.address().port}`;
});

after(() => server?.close());

async function rawGet(path, headers) {
  return new Promise((resolvePromise, reject) => {
    http.get(`${base}${path}`, { headers: { authorization: 'Bearer tok', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolvePromise({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

describe('redis-rest-proxy gzip', () => {
  it('gzips a large body when the client accepts gzip, and inflates to identical JSON', async () => {
    const plain = await rawGet('/get/big', {});
    const gz = await rawGet('/get/big', { 'accept-encoding': 'gzip, deflate' });
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(gz.headers.vary, 'accept-encoding');
    assert.ok(gz.body.length < plain.body.length / 3, `gzip ${gz.body.length} vs plain ${plain.body.length}`);
    assert.equal(zlib.gunzipSync(gz.body).toString(), plain.body.toString());
    assert.deepEqual(JSON.parse(plain.body.toString()), { result: BIG });
  });

  it('leaves small bodies and non-gzip clients untouched', async () => {
    const small = await rawGet('/get/small', { 'accept-encoding': 'gzip' });
    assert.equal(small.headers['content-encoding'], undefined);
    assert.equal(small.body.toString(), JSON.stringify({ result: SMALL }));
    const br = await rawGet('/get/big', { 'accept-encoding': 'br' });
    assert.equal(br.headers['content-encoding'], undefined);
    assert.equal(br.body.toString(), JSON.stringify({ result: BIG }));
  });

  it('fetch inflates transparently (what Vercel/Node callers see)', async () => {
    const res = await fetch(`${base}/get/big`, { headers: { authorization: 'Bearer tok' } });
    assert.deepEqual(await res.json(), { result: BIG });
  });

  it('does not touch error and 401 responses', async () => {
    const unauth = await rawGet('/get/big', { authorization: 'Bearer nope', 'accept-encoding': 'gzip' });
    assert.equal(unauth.status, 401);
    assert.equal(unauth.headers['content-encoding'], undefined);
  });
});
