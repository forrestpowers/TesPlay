// SABR bridge: YouTube's server-side adaptive streaming (the protocol the signed-in TV
// client is limited to) spooled to disk track by track. Each track's `sidx` index gives
// the byte range and duration of every segment, so a track is addressable by byte range
// while it downloads: the media proxy serves ranges from the spool, and a request for a
// part that has not arrived yet restarts the SABR stream at that time.
import { EventEmitter, once } from 'node:events';
import { mkdir, open as openFile, readdir, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { buildLayout, moofDecodeTime, parseSidx, segmentAtByte, segmentAtTime, splitBoxes } from './fmp4-index.js';

const INIT_TYPES = new Set(['ftyp', 'styp', 'moov', 'sidx', 'free', 'skip']);

/** One track's file, written at the byte offsets its index dictates, readable by range as it fills. */
export class IndexedSpool extends EventEmitter {
  constructor(file, { onNeed = () => {}, label = 'track' } = {}) {
    super();
    this.setMaxListeners(128);
    this.file = file;
    this.label = label;
    this.onNeed = onNeed;
    this.layout = null;
    this.present = new Set();
    this.initWritten = false;
    this.lastIngested = -1;
    this.error = null;
    this.handle = null;
    this.pending = Buffer.alloc(0);
    this.initBoxes = [];
    this.fragment = [];
    this.writes = Promise.resolve();
    this.bytes = 0;
  }
  async openForWriting() { this.handle = await openFile(this.file, 'w+'); }
  get total() { return this.layout?.total ?? null; }
  get complete() { return Boolean(this.layout) && this.initWritten && this.present.size === this.layout.sizes.length; }
  /** Feed bytes from the SABR track stream; boxes are written where the index places them. */
  ingest(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.writes = this.writes.then(() => this.#consume(bytes)).catch(error => this.fail(error));
    return this.writes;
  }
  async #consume(bytes) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, bytes]) : bytes;
    const { boxes, rest } = splitBoxes(this.pending);
    this.pending = Buffer.from(rest);
    for (const box of boxes) {
      if (!this.layout) {
        if (box.type === 'moof' || box.type === 'mdat') throw new Error(`${this.label}: media arrived before its segment index`);
        if (!INIT_TYPES.has(box.type)) continue;
        this.initBoxes.push(box.data);
        if (box.type !== 'sidx') continue;
        const initLength = this.initBoxes.reduce((n, b) => n + b.length, 0);
        this.layout = buildLayout(initLength, parseSidx(box.data));
        await this.#write(Buffer.concat(this.initBoxes), 0);
        this.initWritten = true;
        this.initBoxes = [];
        this.emit('index');
        continue;
      }
      if (INIT_TYPES.has(box.type)) continue; // a repeated initialisation segment after a restart
      this.fragment.push(box);
      if (box.type !== 'mdat') continue;
      const moof = this.fragment.find(b => b.type === 'moof');
      const data = Buffer.concat(this.fragment.map(b => b.data));
      this.fragment = [];
      const time = moof ? moofDecodeTime(moof.data) : null;
      let index = time === null ? this.lastIngested + 1 : segmentAtTime(this.layout, time);
      // Sizes are authoritative; a time that lands on the wrong neighbour is corrected by them.
      if (this.layout.sizes[index] !== data.length) {
        const near = [index - 1, index + 1, index + 2].find(i => this.layout.sizes[i] === data.length && (time === null || Math.abs(this.layout.starts[i] - time) < this.layout.timescale));
        if (near !== undefined) index = near;
      }
      if (index < 0 || index >= this.layout.sizes.length) continue;
      await this.#write(data.subarray(0, this.layout.sizes[index]), this.layout.offsets[index]);
      this.present.add(index);
      this.lastIngested = index;
      this.emit('data');
    }
  }
  async #write(data, position) {
    if (!this.handle) return;
    let written = 0;
    while (written < data.length) {
      const result = await this.handle.write(data, written, data.length - written, position + written);
      written += result.bytesWritten;
    }
    this.bytes += data.length;
  }
  async fail(error) {
    if (this.error) return;
    this.error = error instanceof Error ? error : new Error(String(error));
    this.emit('data');
    this.emit('index');
  }
  /** Resolves once the index is known (the first kilobytes of the stream). */
  async ready(signal) {
    while (!this.layout) {
      if (this.error) throw this.error;
      await once(this, 'index', { signal });
    }
    return this.layout;
  }
  #region(index) {
    if (index === -1) return [0, this.layout.initLength - 1];
    return [this.layout.offsets[index], this.layout.offsets[index] + this.layout.sizes[index] - 1];
  }
  has(index) { return index === -1 ? this.initWritten : this.present.has(index); }
  /** Bytes `start..end` inclusive, waiting for (and requesting) parts that have not arrived. */
  /** Wake readers waiting for data so they re-evaluate what they need. */
  poke() { this.emit('data'); }
  /** Media time (ms) of the newest segment written, or -1 before any. */
  get ingestedMs() { return this.lastIngested < 0 ? -1 : this.timeOf(this.lastIngested); }
  async *read(signal, start = 0, end) {
    const layout = await this.ready(signal);
    const last = Math.min(end ?? layout.total - 1, layout.total - 1);
    const handle = this.handle;
    if (!handle) throw new Error(`${this.label}: spool is closed`);
    try {
      let position = start;
      while (position <= last && !signal?.aborted) {
        const index = segmentAtByte(layout, position);
        if (index === null) return;
        while (!this.has(index)) {
          if (this.error) throw this.error;
          this.onNeed(Math.max(index, 0));
          await once(this, 'data', { signal });
        }
        const [, regionEnd] = this.#region(index);
        const stop = Math.min(regionEnd, last);
        let cursor = position;
        while (cursor <= stop) {
          const length = Math.min(stop - cursor + 1, 1 << 20);
          const buffer = Buffer.allocUnsafe(length);
          const { bytesRead } = await handle.read(buffer, 0, length, cursor);
          if (!bytesRead) throw new Error(`${this.label}: spool read past its data`);
          cursor += bytesRead;
          yield buffer.subarray(0, bytesRead);
        }
        position = stop + 1;
      }
    } finally {
      /* the spool's handle stays open until it is discarded */
    }
  }
  /** Milliseconds at which segment `index` starts. */
  timeOf(index) { return this.layout ? Math.floor(this.layout.starts[index] / this.layout.timescale * 1000) : 0; }
  /** Milliseconds at which the track ends. */
  get endMs() { return this.layout ? Math.floor(this.layout.endTime / this.layout.timescale * 1000) : 0; }
  /** Index of the last segment. */
  get lastIndex() { return this.layout ? this.layout.sizes.length - 1 : -1; }
  async discard() {
    await this.writes.catch(() => {});
    await this.handle?.close().catch(() => {});
    this.handle = null;
    await rm(this.file, { force: true }).catch(() => {});
  }
}

/**
 * Keeps one download session per video, shared by every reader (the player fetches each
 * track by range and may retry), restarts the stream where a reader needs data, and
 * cleans up idle sessions and the cache folder.
 */
export function createSabrBridge({ cacheDir, log = console, now = Date.now, maxSessions = 4, keepFor = 2 * 3600000, sweepInterval = 60000, lookaheadMs = 20000, restartDelay = 1500, tailMs = 6000, tailWait = 12000 } = {}) {
  const sessions = new Map();
  let ready = null;
  async function prepare() {
    ready ??= (async () => {
      await mkdir(cacheDir, { recursive: true });
      for (const name of await readdir(cacheDir).catch(() => [])) await rm(path.join(cacheDir, name), { force: true, recursive: true }).catch(() => {});
    })();
    return ready;
  }
  async function discard(session, reason) {
    sessions.delete(session.key);
    try { await session.abortStream?.(); } catch { /* already stopped */ }
    await Promise.all([session.video.discard(), session.audio.discard()]);
    log.info?.(`YouTube SABR session ${session.id} discarded (${reason}).`);
  }
  async function sweep() {
    for (const session of [...sessions.values()]) {
      if (now() - session.lastAccess > keepFor) await discard(session, 'idle');
    }
  }
  const timer = setInterval(() => { sweep().catch(() => {}); }, sweepInterval);
  timer.unref?.();
  /**
   * Start (or reuse) the download for `key`. `run(session)` must return `{ selected, launch }`
   * where `launch(startTimeMs)` starts a SABR stream at that time, piping its tracks into
   * `session.video` / `session.audio`, and returns `{ abort }`.
   */
  async function open(key, run) {
    await prepare();
    const existing = sessions.get(key);
    if (existing && !existing.failed) { existing.lastAccess = now(); return existing; }
    if (existing) await discard(existing, 'retry');
    if (sessions.size >= maxSessions) {
      const oldest = [...sessions.values()].sort((a, b) => a.lastAccess - b.lastAccess)[0];
      if (oldest) await discard(oldest, 'session limit');
    }
    const id = randomBytes(8).toString('base64url');
    const session = {
      id, key, createdAt: now(), lastAccess: now(), failed: false, selected: null, abortStream: null, current: null, restarting: null, lastRestart: 0, lastTarget: -1,
      touch() { session.lastAccess = now(); },
    };
    // A reader asked for a segment that has not arrived. The one SABR stream carries both
    // tracks from the time it started, so decide in media time: wait when the stream is
    // about to deliver it, otherwise restart the stream at that time.
    const restart = async (timeMs, why) => {
      session.lastRestart = now();
      session.restarting = (async () => {
        try {
          await session.current?.abort?.();
          // Progress is measured from this start; what earlier streams wrote stays in `present`.
          session.video.lastIngested = -1; session.audio.lastIngested = -1;
          session.current = await session.launch(timeMs);
          session.current.startTimeMs = timeMs;
          log.info?.(`YouTube SABR session ${session.id}: ${why}, stream restarted at ${(timeMs / 1000).toFixed(1)} s.`);
        } catch (error) {
          log.warn?.(`YouTube SABR session ${session.id}: restart failed: ${error.message}`);
        } finally { session.restarting = null; session.video.poke(); session.audio.poke(); }
      })();
      return session.restarting;
    };
    const need = track => index => {
      const needMs = track.timeOf(index);
      const current = session.current;
      if (current && !current.ended) {
        const from = current.startTimeMs ?? 0;
        const reached = Math.max(from, session.video.ingestedMs, session.audio.ingestedMs);
        if (needMs >= from - 1000 && needMs <= reached + lookaheadMs) return;
      }
      if (session.restarting || now() - session.lastRestart < restartDelay) return;
      void restart(needMs, `${track.label} needs segment ${index}`);
    };
    session.video = new IndexedSpool(path.join(cacheDir, `${id}.video.mp4`), { label: 'video' });
    session.audio = new IndexedSpool(path.join(cacheDir, `${id}.audio.mp4`), { label: 'audio' });
    session.video.onNeed = need(session.video);
    session.audio.onNeed = need(session.audio);
    await Promise.all([session.video.openForWriting(), session.audio.openForWriting()]);
    sessions.set(key, session);
    const prepared = run(session);
    // What the session plays and the sizes it could play instead, once the tracks are chosen.
    session.selection = prepared.then(({ selected, qualities }) => ({ selected, qualities: qualities || [] }));
    session.selection.catch(() => {});
    session.started = (async () => {
      try {
        const { selected, launch } = await prepared;
        session.launch = launch;
        session.selected = selected;
        session.current = await launch(0);
        session.current.startTimeMs = 0;
        session.abortStream = async () => { await session.restarting; await session.current?.abort?.(); };
        // The player reads the end of each file while it inspects it. Fetch that tail once, up
        // front, so startup does not bounce the stream between the end and the beginning.
        try {
          await Promise.all([session.video.ready(), session.audio.ready()]);
          const endMs = Math.max(session.video.endMs, session.audio.endMs);
          const tailPresent = session.video.has(session.video.lastIndex) && session.audio.has(session.audio.lastIndex);
          if (endMs > tailMs * 2 && tailMs > 0 && !tailPresent) {
            await restart(Math.max(0, endMs - tailMs), 'prefetching the tail');
            const until = now() + tailWait;
            while (!(session.video.has(session.video.lastIndex) && session.audio.has(session.audio.lastIndex)) && now() < until && !session.current.ended)
              await Promise.race([once(session.video, 'data'), once(session.audio, 'data'), new Promise(resolve => setTimeout(resolve, 250))]);
            await restart(0, 'tail prefetched');
          }
        } catch (error) {
          log.warn?.(`YouTube SABR session ${session.id}: tail prefetch skipped: ${error.message}`);
        }
      } catch (error) {
        session.failed = true;
        await Promise.all([session.video.fail(error), session.audio.fail(error)]);
        throw error;
      }
    })();
    session.started.catch(() => {});
    return session;
  }
  async function close() {
    clearInterval(timer);
    for (const session of [...sessions.values()]) await discard(session, 'shutdown');
  }
  return { open, close, sweep, sessions };
}
