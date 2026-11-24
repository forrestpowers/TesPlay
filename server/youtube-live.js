// YouTube live streams for the signed-in TV client arrive as per-segment URLs: the player
// response lists one videoplayback URL per itag (`live=1`), and `&sq=N` asks for segment N.
// Each segment is a complete fragmented MP4 (ftyp, moov, emsg, moof, mdat). Without `sq`
// the host returns the newest segment and reports the head sequence number in
// `X-Head-Seqnum`. A track is relayed as one growing fragmented MP4: the first segment
// whole (minus emsg), then only moof+mdat of every following segment.
import { splitBoxes } from './fmp4-index.js';

const MEDIA_BOXES = new Set(['moof', 'mdat']);
const INIT_BOXES = new Set(['ftyp', 'moov']);

/** The boxes of one live segment worth relaying: the init segment once, then fragments. */
export function segmentPayload(buffer, { withInit }) {
  const { boxes } = splitBoxes(buffer);
  const kept = boxes.filter(box => MEDIA_BOXES.has(box.type) || (withInit && INIT_BOXES.has(box.type)));
  if (!kept.some(box => box.type === 'moof') || !kept.some(box => box.type === 'mdat')) return null;
  if (withInit && !kept.some(box => box.type === 'moov')) return null;
  return Buffer.concat(kept.map(box => box.data));
}

const segmentUrl = (url, sq) => `${url}${url.includes('?') ? '&' : '?'}sq=${sq}`;
const wait = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

/**
 * One live broadcast's two tracks. Both readers start at the same segment, a few segments
 * behind the live edge, so audio and video line up from the first frame.
 */
export function createLiveSession({
  video, audio, targetDurationSec = 5, fetchImpl = fetch, now = Date.now, log = console,
  refresh = null, behindSegments = 2, startLifetime = 20000, requestTimeout = null, maxMisses = 6,
}) {
  const urls = { video: video.url, audio: audio.url };
  const segmentMs = Math.max(1, Number(targetDurationSec) || 5) * 1000;
  const timeoutMs = requestTimeout ?? segmentMs * 3 + 5000;
  let start = null; // { promise, at }
  let refreshing = null;

  async function get(url, signal) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    return response;
  }
  async function headSequence(signal, renewed = false) {
    const response = await get(urls.video, signal);
    const head = Number(response.headers.get('x-head-seqnum') ?? response.headers.get('x-sequence-num'));
    await response.body?.cancel?.().catch(() => {});
    if (response.status === 403 && !renewed && await renew()) return headSequence(signal, true);
    if (!response.ok || !Number.isFinite(head)) throw Object.assign(new Error(`YouTube live head request answered ${response.status}`), { status: response.status });
    return head;
  }
  /** The shared first segment: readers opening within a few seconds of each other agree on it. */
  function startSequence(signal) {
    if (start && now() - start.at < startLifetime) return start.promise;
    const promise = headSequence(signal).then(head => Math.max(0, head - behindSegments));
    const entry = { promise, at: now() };
    start = entry;
    promise.catch(() => { if (start === entry) start = null; });
    return promise;
  }
  async function renew() {
    if (!refresh) return false;
    refreshing ??= (async () => {
      try {
        const fresh = await refresh();
        if (fresh?.video?.url && fresh?.audio?.url) { urls.video = fresh.video.url; urls.audio = fresh.audio.url; return true; }
        return false;
      } catch (error) { log.warn?.('YouTube live: could not refresh stream URLs:', error.message); return false; }
      finally { setTimeout(() => { refreshing = null; }, 0); }
    })();
    return refreshing;
  }

  /** Bytes of one track from the shared start segment on, until the broadcast ends or the reader leaves. */
  async function* read(track, signal) {
    let sq = await startSequence(signal);
    let withInit = true, misses = 0, renewed = false;
    while (!signal?.aborted) {
      let response;
      try { response = await get(segmentUrl(urls[track], sq), signal); }
      catch (error) {
        if (signal?.aborted) return;
        if (++misses > maxMisses) throw error;
        await wait(Math.min(segmentMs, 2000), signal); continue;
      }
      if (response.status === 403 && !renewed) {
        await response.body?.cancel?.().catch(() => {});
        // Stream URLs expire after a few hours; ask for fresh ones once per failure run.
        renewed = true;
        if (await renew()) continue;
        throw Object.assign(new Error('YouTube refused the live stream URL.'), { status: 403 });
      }
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {});
        const head = Number(response.headers.get('x-head-seqnum'));
        // Past the head: the segment is not cut yet. Behind the window: jump to the head.
        if (Number.isFinite(head) && sq < head - 1 && response.status === 404) { sq = Math.max(sq + 1, head - behindSegments); misses = 0; continue; }
        if (++misses > maxMisses) return; // The broadcast has ended or stopped publishing.
        await wait(Math.min(segmentMs, 2000), signal); continue;
      }
      const payload = segmentPayload(Buffer.from(await response.arrayBuffer()), { withInit });
      if (!payload) { if (++misses > maxMisses) return; sq++; continue; }
      misses = 0; renewed = false; withInit = false; sq++;
      yield payload;
    }
  }
  return { read, startSequence, urls };
}
