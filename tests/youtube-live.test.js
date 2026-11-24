import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createLiveSession, segmentPayload } from '../server/youtube-live.js';
import { createMediaService } from '../server/media.js';
import { splitBoxes } from '../server/fmp4-index.js';

const box = (type, payload = Buffer.alloc(4)) => { const header = Buffer.alloc(8); header.writeUInt32BE(8 + payload.length, 0); header.write(type, 4, 'latin1'); return Buffer.concat([header, payload]); };
// A YouTube live segment: its own init segment, an event message, then one fragment.
const segment = (track, sq) => Buffer.concat([box('ftyp'), box('moov', Buffer.from(`${track}-init`)), box('emsg', Buffer.from(`event-${sq}`)), box('moof', Buffer.from(`${track}-moof-${sq}`)), box('mdat', Buffer.from(`${track}-data-${sq}`))]);
const types = buffer => splitBoxes(buffer).boxes.map(b => b.type);
const payloads = buffer => splitBoxes(buffer).boxes.filter(b => b.type === 'mdat').map(b => b.data.subarray(8).toString());
const collect = async (iterator, limit = Infinity) => { const parts = []; for await (const chunk of iterator) { parts.push(Buffer.from(chunk)); if (parts.length >= limit) break; } return Buffer.concat(parts); };

/** A googlevideo stand-in: `head` is the newest segment, `last` ends the broadcast. */
function fakeHost({ head = 100, last = Infinity, oldest = 0, expiredUntil = 0 } = {}) {
  const state = { head, calls: [], expiredUntil };
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const track = u.searchParams.get('itag') === '140' ? 'audio' : 'video';
    const generation = Number(u.searchParams.get('gen') || 0);
    const sq = u.searchParams.has('sq') ? Number(u.searchParams.get('sq')) : state.head;
    state.calls.push(`${track}:${u.searchParams.has('sq') ? sq : 'head'}${generation ? `:g${generation}` : ''}`);
    const headers = new Headers({ 'x-head-seqnum': String(state.head), 'x-sequence-num': String(sq) });
    if (generation < state.expiredUntil) return new Response('', { status: 403, headers });
    if (u.searchParams.has('sq') && (sq > last || sq < oldest)) return new Response('', { status: 404, headers });
    if (sq > state.head) state.head = sq; // the host holds the request until the segment exists
    return new Response(segment(track, sq), { status: 200, headers });
  };
  return { state, fetchImpl };
}
const urls = (generation = 0) => ({ video: { url: `https://rr1---sn-test.googlevideo.com/videoplayback?itag=136&live=1${generation ? `&gen=${generation}` : ''}` }, audio: { url: `https://rr1---sn-test.googlevideo.com/videoplayback?itag=140&live=1${generation ? `&gen=${generation}` : ''}` } });

test('a live segment keeps its init segment once and drops event messages', () => {
  assert.deepEqual(types(segmentPayload(segment('video', 1), { withInit: true })), ['ftyp', 'moov', 'moof', 'mdat']);
  assert.deepEqual(types(segmentPayload(segment('video', 2), { withInit: false })), ['moof', 'mdat']);
  assert.equal(segmentPayload(Buffer.concat([box('ftyp'), box('moov')]), { withInit: true }), null, 'a segment without a fragment is not relayed');
  assert.equal(segmentPayload(Buffer.concat([box('moof'), box('mdat')]), { withInit: true }), null, 'the first segment must carry the track header');
});

test('both tracks start at the same segment behind the live edge and read on as one growing fragmented MP4 each', async () => {
  const host = fakeHost({ head: 100 });
  const session = createLiveSession({ ...urls(), fetchImpl: host.fetchImpl, behindSegments: 2 });
  const [video, audio] = await Promise.all([collect(session.read('video'), 4), collect(session.read('audio'), 4)]);
  assert.deepEqual(types(video), ['ftyp', 'moov', 'moof', 'mdat', 'moof', 'mdat', 'moof', 'mdat', 'moof', 'mdat']);
  assert.deepEqual(payloads(video), ['video-data-98', 'video-data-99', 'video-data-100', 'video-data-101'], 'starts two segments behind the head and follows the edge');
  assert.deepEqual(payloads(audio), ['audio-data-98', 'audio-data-99', 'audio-data-100', 'audio-data-101'], 'audio starts at the same segment as video');
  assert.equal(host.state.calls.filter(c => c.endsWith(':head')).length, 1, 'the head is asked once for both tracks');
});

test('a broadcast that stops publishing ends the track, and a start that fell out of the window jumps back near the edge', async () => {
  const ended = fakeHost({ head: 10, last: 11 });
  const session = createLiveSession({ ...urls(), fetchImpl: ended.fetchImpl, behindSegments: 1, maxMisses: 2, targetDurationSec: 0.001 });
  assert.deepEqual(payloads(await collect(session.read('video'))), ['video-data-9', 'video-data-10', 'video-data-11']);
  // The shared start was taken at head 300; by the time a reader asks, only 490 and later remain.
  const moved = fakeHost({ head: 300, oldest: 490 });
  const late = createLiveSession({ ...urls(), fetchImpl: moved.fetchImpl, behindSegments: 2, startLifetime: Infinity });
  assert.equal(await late.startSequence(), 298);
  moved.state.head = 500;
  assert.deepEqual(payloads(await collect(late.read('video'), 1)), ['video-data-498']);
});

test('expired stream URLs are renewed once through the refresh callback', async () => {
  const host = fakeHost({ head: 20, expiredUntil: 1 });
  let refreshes = 0;
  const session = createLiveSession({ ...urls(), fetchImpl: host.fetchImpl, behindSegments: 0, refresh: async () => { refreshes++; return urls(1); } });
  assert.deepEqual(payloads(await collect(session.read('video'), 2)), ['video-data-20', 'video-data-21']);
  assert.equal(refreshes, 1);
  assert.deepEqual(host.state.calls.slice(0, 3), ['video:head', 'video:head:g1', 'video:20:g1'], 'the refused head request renews the URLs and asks again');
  const refused = createLiveSession({ ...urls(), fetchImpl: fakeHost({ head: 5, expiredUntil: 9 }).fetchImpl, refresh: async () => null });
  await assert.rejects(collect(refused.read('video')), { status: 403 });
});

test('the media proxy relays a live track without a length and reports a broadcast that never starts', async t => {
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
  const session = createLiveSession({ ...urls(), fetchImpl: fakeHost({ head: 30, last: 31 }).fetchImpl, behindSegments: 1, maxMisses: 1, targetDurationSec: 0.001 });
  const res = await fetch(base + media.register(req, null, { kind: 'video', live: { session, track: 'audio' }, contentType: 'audio/mp4' }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/mp4');
  assert.equal(res.headers.get('content-length'), null);
  assert.equal(res.headers.get('accept-ranges'), null);
  assert.deepEqual(payloads(Buffer.from(await res.arrayBuffer())), ['audio-data-29', 'audio-data-30', 'audio-data-31']);
  const broken = createLiveSession({ ...urls(), fetchImpl: async () => new Response('', { status: 500 }) });
  assert.equal((await fetch(base + media.register(req, null, { kind: 'video', live: { session: broken, track: 'video' } }))).status, 502);
});
