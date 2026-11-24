// SABR bridge: YouTube's server-side adaptive streaming (the protocol the signed-in TV
// client is limited to) spooled to disk track by track, so the media proxy can serve each
// track as a growing fragmented MP4 that TesPlayer reads sequentially.
import { EventEmitter, once } from 'node:events';
import { mkdir, open as openFile, readdir, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

/** A file that grows while a track downloads; readers follow it to the end. */
export class Spool extends EventEmitter {
  constructor(file) {
    super();
    this.setMaxListeners(64);
    this.file = file;
    this.size = 0;
    this.done = false;
    this.error = null;
    this.handle = null;
    this.writes = Promise.resolve();
  }
  async openForWriting() { this.handle = await openFile(this.file, 'w'); }
  write(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.writes = this.writes.then(async () => {
      if (!this.handle || this.done) return;
      await this.handle.write(bytes, 0, bytes.length, this.size);
      this.size += bytes.length;
      this.emit('data');
    }).catch(error => this.fail(error));
    return this.writes;
  }
  async finish() {
    await this.writes.catch(() => {});
    if (this.done) return;
    this.done = true;
    await this.handle?.close().catch(() => {});
    this.handle = null;
    this.emit('data');
  }
  async fail(error) {
    if (this.done) return;
    this.error = error instanceof Error ? error : new Error(String(error));
    await this.finish();
  }
  /** Bytes from `offset` onwards, waiting for more while the download runs. */
  async *read(signal, offset = 0) {
    const handle = await openFile(this.file, 'r');
    try {
      while (!signal?.aborted) {
        if (offset < this.size) {
          const length = Math.min(this.size - offset, 1 << 20);
          const buffer = Buffer.allocUnsafe(length);
          const { bytesRead } = await handle.read(buffer, 0, length, offset);
          if (!bytesRead) { await once(this, 'data', { signal }); continue; }
          offset += bytesRead;
          yield buffer.subarray(0, bytesRead);
        } else if (this.done) {
          if (this.error && offset === 0) throw this.error;
          return;
        } else {
          await once(this, 'data', { signal });
        }
      }
    } finally {
      await handle.close().catch(() => {});
    }
  }
  async discard() {
    await this.finish();
    await rm(this.file, { force: true }).catch(() => {});
  }
}

/**
 * Keeps one download session per video, shared by every reader (the player fetches each
 * track at least once and may retry), and cleans up idle sessions and the cache folder.
 */
export function createSabrBridge({ cacheDir, log = console, now = Date.now, maxSessions = 4, keepFor = 2 * 3600000, sweepInterval = 60000 } = {}) {
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
   * Start (or reuse) the download for `key`. `run(session)` creates the SABR stream, pipes
   * its tracks into `session.video` / `session.audio`, and may set `session.abortStream`.
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
      id, key, createdAt: now(), lastAccess: now(), failed: false, finished: false, selected: null, abortStream: null,
      video: new Spool(path.join(cacheDir, `${id}.video.mp4`)), audio: new Spool(path.join(cacheDir, `${id}.audio.mp4`)),
      touch() { session.lastAccess = now(); },
    };
    await Promise.all([session.video.openForWriting(), session.audio.openForWriting()]);
    sessions.set(key, session);
    session.started = (async () => {
      try {
        session.selected = await run(session);
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
