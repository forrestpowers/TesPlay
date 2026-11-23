import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { createMediaService } from '../server/media.js';

// A stand-in for YouTube's videoplayback hosts: only bounded ranges of at most
// one mebibyte are served; open-ended or larger requests get HTTP 403.
async function upstream(size, limit = 1024 * 1024) {
  const body = randomBytes(size);
  const log = [];
  const server = http.createServer((req, res) => {
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    log.push(req.headers.range || '(none)');
    if (!match || match[2] === '' || Number(match[2]) - Number(match[1]) + 1 > limit) { res.writeHead(403).end(); return; }
    const start = Number(match[1]);
    if (start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
    const end = Math.min(Number(match[2]), size - 1);
    res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
    res.end(body.subarray(start, end + 1));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // The proxy refuses loopback destinations, so route a public-looking host to this server.
  const original = http.request;
  http.request = (url, options, callback) => original(new URL(`http://127.0.0.1:${server.address().port}${url.pathname}`), { ...options, lookup: undefined }, callback);
  return { body, log, url: 'http://203.0.113.20/videoplayback', close: () => { http.request = original; return new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); } };
}

async function proxy(t, remote) {
  const app = express();
  app.use((req, _res, next) => { req.user = { id: 'owner' }; next(); });
  const media = createMediaService({ getProfileId: () => 'p1', getConnection: () => null });
  app.get('/api/media/:token', media.handler);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const path = media.register({ user: { id: 'owner' } }, null, { url: remote.url, headers: {}, kind: 'video', chunkBytes: 1024 * 1024 });
  return { fetch: (range, init = {}) => fetch(base + path, { ...init, headers: { ...(range ? { Range: range } : {}), ...init.headers } }) };
}

test('chunked proxy serves open-ended and large ranges through bounded upstream range requests', async t => {
  const remote = await upstream(2.5 * 1024 * 1024);
  t.after(remote.close);
  const p = await proxy(t, remote);
  const open = await p.fetch('bytes=0-');
  assert.equal(open.status, 206, await open.clone().text());
  assert.equal(open.headers.get('content-range'), `bytes 0-${remote.body.length - 1}/${remote.body.length}`);
  assert.equal(open.headers.get('content-length'), String(remote.body.length));
  assert.equal(open.headers.get('content-type'), 'video/mp4');
  assert.ok(open.headers.get('x-csp-representation-id')?.startsWith('mr1_'));
  assert.ok(Buffer.from(await open.arrayBuffer()).equals(remote.body));
  assert.deepEqual(remote.log, ['bytes=0-1048575', 'bytes=1048576-2097151', 'bytes=2097152-2621439']);
  remote.log.length = 0;
  const middle = await p.fetch('bytes=1048000-1049999');
  assert.equal(middle.status, 206);
  assert.equal(middle.headers.get('content-range'), `bytes 1048000-1049999/${remote.body.length}`);
  assert.ok(Buffer.from(await middle.arrayBuffer()).equals(remote.body.subarray(1048000, 1050000)));
  assert.deepEqual(remote.log, ['bytes=1048000-1049999']);
  const tail = await p.fetch(`bytes=${remote.body.length - 10}-${remote.body.length + 500}`);
  assert.equal(tail.headers.get('content-length'), '10');
  assert.equal((await tail.arrayBuffer()).byteLength, 10);
  const none = await p.fetch(undefined);
  assert.equal(none.status, 206);
  assert.equal((await none.arrayBuffer()).byteLength, remote.body.length);
  const head = await p.fetch('bytes=0-', { method: 'HEAD' });
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('content-length'), String(remote.body.length));
  assert.equal((await p.fetch(`bytes=${remote.body.length + 5}-`)).status, 416);
});

test('chunked proxy reports an upstream refusal as a gateway error before any byte is sent', async t => {
  const remote = await upstream(512 * 1024, 1024);
  t.after(remote.close);
  const p = await proxy(t, remote);
  const response = await p.fetch('bytes=0-');
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /HTTP 403/);
});
