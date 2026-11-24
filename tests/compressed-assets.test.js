import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import express from 'express';
import { compressedAssets } from '../server/compressed-assets.js';

test('built scripts are served compressed with a year of caching, falling back to retained chunks and plain files', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tesplay-compressed-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const current = join(root, 'assets'), retained = join(root, 'retained');
  mkdirSync(current); mkdirSync(retained);
  const script = 'export const player = "' + 'tesplay '.repeat(4000) + '";\n';
  writeFileSync(join(current, 'Player-abc123.js'), script);
  writeFileSync(join(retained, 'Player-old999.js'), script);
  writeFileSync(join(current, 'tiny-1.js'), 'x');
  writeFileSync(join(current, 'image-1.png'), Buffer.alloc(4096));
  writeFileSync(join(root, 'secret.js'), script);
  const app = express();
  app.use('/assets', compressedAssets([current, retained]));
  app.use('/assets', express.static(current), (_req, res) => res.sendStatus(404));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  // fetch() decompresses on its own; use http.get to see the bytes on the wire.
  const get = (path, encoding) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: server.address().port, path, headers: encoding ? { 'Accept-Encoding': encoding } : {} }, res => {
    const parts = []; res.on('data', part => parts.push(part)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
  }).on('error', reject));

  const br = await get('/assets/Player-abc123.js', 'gzip, deflate, br');
  assert.equal(br.status, 200);
  assert.equal(br.headers['content-encoding'], 'br');
  assert.equal(br.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(br.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(br.headers.vary, 'Accept-Encoding');
  assert.ok(br.body.length < script.length / 10);
  assert.equal(brotliDecompressSync(br.body).toString(), script);
  const gz = await get('/assets/Player-old999.js', 'gzip');
  assert.equal(gz.headers['content-encoding'], 'gzip', 'a chunk kept for open tabs from an earlier deployment');
  assert.equal(gunzipSync(gz.body).toString(), script);
  const plain = await get('/assets/Player-abc123.js');
  assert.equal(plain.headers['content-encoding'], undefined, 'browsers without compression get the file as built');
  assert.equal(plain.body.toString(), script);
  assert.equal((await get('/assets/tiny-1.js', 'br')).headers['content-encoding'], undefined, 'tiny files are not worth compressing');
  assert.equal((await get('/assets/image-1.png', 'br')).headers['content-encoding'], undefined, 'images are already compressed');
  assert.equal((await get('/assets/missing-1.js', 'br')).status, 404);
  assert.equal((await get('/assets/..%2Fsecret.js', 'br')).status, 404, 'paths cannot leave the asset directory');
});
