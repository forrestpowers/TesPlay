import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import express from 'express';
import { createSabrBridge, IndexedSpool } from '../server/youtube-sabr.js';
import { buildLayout, moofDecodeTime, parseSidx, segmentAtByte, segmentAtTime, splitBoxes } from '../server/fmp4-index.js';
import { createMediaService } from '../server/media.js';

// A tiny fragmented MP4: ftyp, moov, sidx, then moof+mdat per segment with a tfdt decode time.
const box = (type, payload) => { const header = Buffer.alloc(8); header.writeUInt32BE(8 + payload.length, 0); header.write(type, 4, 'latin1'); return Buffer.concat([header, payload]); };
const fullBox = (type, version, payload) => box(type, Buffer.concat([Buffer.from([version, 0, 0, 0]), payload]));
const TIMESCALE = 1000;
function track(segments) {
  const ftyp = box('ftyp', Buffer.from('dash'));
  const moov = box('moov', Buffer.alloc(40, 1));
  let time = 0;
  const fragments = segments.map(s => {
    const tfdtPayload = Buffer.alloc(4); tfdtPayload.writeUInt32BE(time, 0);
    const moof = box('moof', box('traf', fullBox('tfdt', 0, tfdtPayload)));
    time += s.duration;
    return Buffer.concat([moof, box('mdat', s.data)]);
  });
  const entries = Buffer.concat(segments.map((s, i) => { const b = Buffer.alloc(12); b.writeUInt32BE(fragments[i].length, 0); b.writeUInt32BE(s.duration, 4); b.writeUInt32BE(0x90000000, 8); return b; }));
  const head = Buffer.alloc(16); head.writeUInt32BE(1, 0); head.writeUInt32BE(TIMESCALE, 4); head.writeUInt32BE(0, 8); head.writeUInt32BE(0, 12);
  const count = Buffer.alloc(4); count.writeUInt16BE(0, 0); count.writeUInt16BE(segments.length, 2);
  const sidx = fullBox('sidx', 0, Buffer.concat([head, count, entries]));
  const init = Buffer.concat([ftyp, moov, sidx]);
  return { init, fragments, file: Buffer.concat([init, ...fragments]) };
}
const SEGMENTS = [{ duration: 2000, data: Buffer.alloc(300, 'a') }, { duration: 2000, data: Buffer.alloc(500, 'b') }, { duration: 1500, data: Buffer.alloc(200, 'c') }, { duration: 2500, data: Buffer.alloc(700, 'd') }];

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tesplay-sabr-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const collect = async iterator => { const parts = []; for await (const chunk of iterator) parts.push(Buffer.from(chunk)); return Buffer.concat(parts); };

test('the fragmented MP4 helpers read the segment index and fragment decode times', () => {
  const { init, fragments, file } = track(SEGMENTS);
  const { boxes, rest } = splitBoxes(file);
  assert.equal(rest.length, 0);
  assert.deepEqual(boxes.map(b => b.type), ['ftyp', 'moov', 'sidx', 'moof', 'mdat', 'moof', 'mdat', 'moof', 'mdat', 'moof', 'mdat']);
  const sidx = parseSidx(boxes[2].data);
  assert.equal(sidx.timescale, TIMESCALE);
  assert.deepEqual(sidx.segments.map(s => s.size), fragments.map(f => f.length));
  const layout = buildLayout(init.length, sidx);
  assert.equal(layout.total, file.length);
  assert.deepEqual(layout.starts, [0, 2000, 4000, 5500]);
  assert.equal(layout.offsets[1], init.length + fragments[0].length);
  assert.equal(moofDecodeTime(boxes[7].data), 4000);
  assert.equal(segmentAtByte(layout, 3), -1);
  assert.equal(segmentAtByte(layout, layout.offsets[2] + 5), 2);
  assert.equal(segmentAtByte(layout, layout.total), null);
  assert.equal(segmentAtTime(layout, 5600), 3);
  assert.equal(segmentAtTime(layout, 1999), 0);
  // Partial trailing box stays pending.
  const partial = splitBoxes(file.subarray(0, init.length + 10));
  assert.equal(partial.boxes.length, 3); assert.equal(partial.rest.length, 10);
});

test('an indexed spool places fragments by their decode time, serves ranges as they arrive and asks for what it lacks', async t => {
  const dir = await tempDir(t);
  const needs = [];
  const spool = new IndexedSpool(path.join(dir, 'video.mp4'), { onNeed: index => needs.push(index), label: 'video' });
  await spool.openForWriting();
  const { init, fragments, file } = track(SEGMENTS);
  // Index arrives in two pieces; readers wait for it.
  const whole = collect(spool.read(undefined, 0));
  await spool.ingest(init.subarray(0, 20));
  assert.equal(spool.layout, null);
  await spool.ingest(init.subarray(20));
  assert.equal(spool.total, file.length);
  assert.equal(spool.initWritten, true);
  // Fragments out of order (as after a restart): segment 2 then 3, then 0 and 1.
  await spool.ingest(fragments[2]);
  await spool.ingest(Buffer.concat([fragments[3].subarray(0, 50)]));
  await spool.ingest(fragments[3].subarray(50));
  assert.deepEqual([...spool.present].sort(), [2, 3]);
  const tail = await collect(spool.read(undefined, spool.layout.offsets[2], file.length - 1));
  assert.ok(tail.equals(file.subarray(spool.layout.offsets[2])));
  assert.ok(needs.length >= 1 && needs.every(n => n === 0), 'the whole-file reader asked for segment 0 while it waited');
  await spool.ingest(fragments[0]);
  await spool.ingest(fragments[1]);
  assert.equal(spool.complete, true);
  assert.ok((await whole).equals(file), 'the reader that waited from the start gets the full file in order');
  // A repeated initialisation segment after a restart is ignored.
  await spool.ingest(init);
  assert.ok((await collect(spool.read(undefined, 0, init.length + 5))).equals(file.subarray(0, init.length + 6)));
  assert.equal(spool.timeOf(3), 5500);
  // Aborting a waiting reader stops it; a failure before the index surfaces to readers.
  const controller = new AbortController();
  const stuck = new IndexedSpool(path.join(dir, 'stuck.mp4'));
  await stuck.openForWriting();
  const waiting = collect(stuck.read(controller.signal, 0));
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(waiting, { name: 'AbortError' });
  await stuck.fail(new Error('no stream'));
  await assert.rejects(collect(stuck.read(undefined, 0)), /no stream/);
  await stuck.discard(); await spool.discard();
  assert.deepEqual(await readdir(dir), []);
});

test('the bridge shares one session per key, restarts the stream where a reader needs data, and discards idle or failed sessions', async t => {
  const dir = await tempDir(t);
  await writeFile(path.join(dir, 'stale.mp4'), 'old');
  let clock = 1000;
  const bridge = createSabrBridge({ cacheDir: dir, now: () => clock, keepFor: 500, sweepInterval: 3600000, lookaheadMs: 1000, restartDelay: 0, tailMs: 0, log: { info: () => {}, warn: () => {} } });
  t.after(() => bridge.close());
  const video = track(SEGMENTS), audio = track(SEGMENTS);
  const launches = [];
  const run = async session => ({
    selected: { video: { itag: 137 }, audio: { itag: 140 } },
    launch: async startTimeMs => {
      launches.push(startTimeMs);
      const from = segmentAtTime({ starts: [0, 2000, 4000, 5500] }, startTimeMs);
      const handle = { ended: false, abort: async () => { handle.ended = true; } };
      // Deliver the index and only the first segment from the start point, like a slow stream.
      await session.video.ingest(video.init); await session.audio.ingest(audio.init);
      await session.video.ingest(video.fragments[from]); await session.audio.ingest(audio.fragments[from]);
      return handle;
    },
  });
  const session = await bridge.open('c1:vid:1080', run);
  assert.ok(!(await readdir(dir)).includes('stale.mp4'), 'leftover files are removed on first use');
  await session.started;
  assert.deepEqual(launches, [0]);
  assert.equal(session.video.total, video.file.length);
  assert.ok((await collect(session.video.read(undefined, 0, session.video.layout.offsets[1] - 1))).equals(video.file.subarray(0, session.video.layout.offsets[1])));
  // A reader far ahead triggers a restart at that segment's time; the restarted stream delivers it.
  const far = collect(session.video.read(undefined, session.video.layout.offsets[3], video.file.length - 1));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(launches, [0, 5500]);
  assert.ok((await far).equals(video.fragments[3]));
  // After serving the end, a need near the start restarts there instead of counting as "about to arrive".
  const early = collect(session.video.read(undefined, session.video.layout.offsets[1], session.video.layout.offsets[2] - 1));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(launches, [0, 5500, 2000]);
  assert.ok((await early).equals(video.fragments[1]));
  const again = await bridge.open('c1:vid:1080', run);
  assert.equal(again, session, 'the same session serves a second reader');
  const failing = await bridge.open('c1:bad:1080', async () => { throw new Error('no formats'); });
  await assert.rejects(failing.started, /no formats/);
  assert.equal(failing.failed, true);
  await assert.rejects(collect(failing.video.read(undefined, 0)), /no formats/);
  const retried = await bridge.open('c1:bad:1080', run);
  assert.notEqual(retried, failing, 'a failed session is replaced on the next open');
  await retried.started;
  clock += 1000;
  await bridge.sweep();
  assert.equal(bridge.sessions.size, 0, 'idle sessions are discarded');
  assert.deepEqual(await readdir(dir), []);
});

test('the media proxy serves an indexed spool by byte range with a known length and waits for missing parts', async t => {
  const dir = await tempDir(t);
  const { init, fragments, file } = track(SEGMENTS);
  const needs = [];
  const spool = new IndexedSpool(path.join(dir, 'video.mp4'), { onNeed: index => needs.push(index) });
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
  const pending = fetch(base + url, { headers: { Range: 'bytes=0-' } });
  await spool.ingest(init);
  for (const fragment of fragments) await spool.ingest(fragment);
  const res = await pending;
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 0-${file.length - 1}/${file.length}`);
  assert.equal(res.headers.get('content-length'), String(file.length));
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.ok(res.headers.get('x-csp-representation-id')?.startsWith('mr1_'));
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(file));
  const slice = await fetch(base + url, { headers: { Range: `bytes=${init.length + 10}-${init.length + 19}` } });
  assert.equal(slice.headers.get('content-length'), '10');
  assert.ok(Buffer.from(await slice.arrayBuffer()).equals(file.subarray(init.length + 10, init.length + 20)));
  assert.equal((await fetch(base + url, { headers: { Range: `bytes=${file.length}-` } })).status, 416);
  const head = await fetch(base + url, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(file.length));
  const dead = new IndexedSpool(path.join(dir, 'dead.mp4'));
  await dead.openForWriting();
  await dead.fail(new Error('nope'));
  assert.equal((await fetch(base + media.register(req, null, { kind: 'video', spool: dead }))).status, 502);
});
