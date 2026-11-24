import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import express from 'express';
import { createSabrBridge, Spool } from '../server/youtube-sabr.js';
import { createMediaService } from '../server/media.js';

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tesplay-sabr-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const collect = async (iterator) => { const parts = []; for await (const chunk of iterator) parts.push(Buffer.from(chunk)); return Buffer.concat(parts); };

test('a spool lets readers follow the file while it is still being written', async t => {
  const dir = await tempDir(t);
  const spool = new Spool(path.join(dir, 'track.mp4'));
  await spool.openForWriting();
  const reading = collect(spool.read());
  await spool.write(Buffer.from('ftyp'));
  await new Promise(resolve => setTimeout(resolve, 20));
  await spool.write(Buffer.from('moof-mdat'));
  await spool.finish();
  assert.equal((await reading).toString(), 'ftypmoof-mdat');
  // A late reader gets everything from the start; a reader from an offset gets the rest.
  assert.equal((await collect(spool.read())).toString(), 'ftypmoof-mdat');
  assert.equal((await collect(spool.read(undefined, 4))).toString(), 'moof-mdat');
  // Failure before any byte surfaces to readers; after bytes arrived they simply end.
  const broken = new Spool(path.join(dir, 'broken.mp4'));
  await broken.openForWriting();
  await broken.fail(new Error('upstream gone'));
  await assert.rejects(collect(broken.read()), /upstream gone/);
  const partial = new Spool(path.join(dir, 'partial.mp4'));
  await partial.openForWriting();
  await partial.write(Buffer.from('abc'));
  await partial.fail(new Error('cut'));
  assert.equal((await collect(partial.read())).toString(), 'abc');
  // Readers stop when their signal aborts instead of waiting forever.
  const open = new Spool(path.join(dir, 'open.mp4'));
  await open.openForWriting();
  const controller = new AbortController();
  const waiting = collect(open.read(controller.signal));
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(waiting, { name: 'AbortError' });
  await open.discard();
});

test('the bridge shares one download per key, cleans the cache folder on start and discards idle or failed sessions', async t => {
  const dir = await tempDir(t);
  await writeFile(path.join(dir, 'stale.mp4'), 'old');
  let clock = 1000;
  const bridge = createSabrBridge({ cacheDir: dir, now: () => clock, keepFor: 500, sweepInterval: 3600000, log: { info: () => {} } });
  t.after(() => bridge.close());
  let runs = 0;
  const run = async session => { runs++; await session.video.write(Buffer.from('video')); await session.audio.write(Buffer.from('audio')); await session.video.finish(); await session.audio.finish(); session.finished = true; return { video: { itag: 137 }, audio: { itag: 140 } }; };
  const first = await bridge.open('c1:vid:1080', run);
  assert.ok(!(await readdir(dir)).includes('stale.mp4'), 'leftover files are removed on first use');
  await first.started;
  assert.deepEqual(first.selected, { video: { itag: 137 }, audio: { itag: 140 } });
  assert.equal((await collect(first.video.read())).toString(), 'video');
  const again = await bridge.open('c1:vid:1080', run);
  assert.equal(again, first, 'the same session serves a second reader');
  assert.equal(runs, 1);
  const failing = await bridge.open('c1:bad:1080', async () => { throw new Error('no formats'); });
  await assert.rejects(failing.started, /no formats/);
  assert.equal(failing.failed, true);
  await assert.rejects(collect(failing.video.read()), /no formats/);
  const retried = await bridge.open('c1:bad:1080', run);
  assert.notEqual(retried, failing, 'a failed session is replaced on the next open');
  await retried.started;
  clock += 1000;
  await bridge.sweep();
  assert.equal(bridge.sessions.size, 0, 'idle sessions are discarded');
  assert.deepEqual(await readdir(dir), []);
});

test('the media proxy streams a spool as a growing response and refuses a spool that failed before any byte', async t => {
  const dir = await tempDir(t);
  const spool = new Spool(path.join(dir, 'video.mp4'));
  await spool.openForWriting();
  const app = express();
  app.use((req, _res, next) => { req.user = { id: 'owner' }; next(); });
  const media = createMediaService({ getProfileId: () => 'p1', getConnection: () => null });
  app.get('/api/media/:token', media.handler);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = { user: { id: 'owner' } };
  const url = media.register(req, null, { kind: 'video', spool, contentType: 'video/mp4' });
  const response = fetch(base + url, { headers: { Range: 'bytes=0-' } });
  await spool.write(Buffer.from('ftyp'));
  const res = await response;
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(res.headers.get('accept-ranges'), 'none');
  await spool.write(Buffer.from('moof'));
  await spool.finish();
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'ftypmoof');
  const dead = new Spool(path.join(dir, 'dead.mp4'));
  await dead.openForWriting();
  await dead.fail(new Error('nope'));
  const refused = await fetch(base + media.register(req, null, { kind: 'video', spool: dead }));
  assert.equal(refused.status, 502);
});
