import http from "node:http";
import { execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { requestRemote, validateRemoteUrl } from "./media.js";
import { createTranscoder, describeProbe, detectEncoder, DEFAULT_PROFILE, fileProbeArguments, profileForHeight } from "./transcoder.js";

// TesPlay transcoder: a small service for a machine with a GPU (for example an
// Intel mini PC). For car mode, TesPlay posts a live channel's address; this
// service opens it, converts it to 720p30 H.264 with stereo AAC and streams
// MPEG-TS back. For IPTV movies and episodes the browser cannot decode (such as
// H.265), it describes the file (/probe) and converts it from any start
// position. Only requests carrying TRANSCODER_TOKEN are served, so it is not an
// open relay.

const MAX_BODY_BYTES = 16 * 1024;
const FIRST_BYTES_MS = 30_000;
const number = (value, fallback, min, max) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};
const digest = (value) => createHash("sha256").update(String(value)).digest();

export function transcoderConfig(env = process.env) {
  return {
    token: env.TRANSCODER_TOKEN || "",
    port: number(env.TRANSCODER_PORT, 4190, 1, 65535),
    ffmpeg: env.FFMPEG_PATH || "ffmpeg",
    ffprobe: env.FFPROBE_PATH || "ffprobe",
    device: env.TRANSCODER_DEVICE || "/dev/dri/renderD128",
    encoder: ["auto", "vaapi", "vaapi-lp", "software"].includes(env.TRANSCODER_ENCODER) ? env.TRANSCODER_ENCODER : "auto",
    limit: number(env.TRANSCODE_LIMIT, 3, 1, 32),
    // Seconds of converted output held back at the start and then sent at once,
    // so the player begins with a buffer instead of playing at the live edge.
    prebufferMs: number(env.TRANSCODE_PREBUFFER_MS, 3000, 0, 10000),
    // Provider addresses on a private network are refused unless listed here.
    allowedPrivateHosts: String(env.TRANSCODER_ALLOWED_PRIVATE_HOSTS || "").split(",").map((host) => host.trim()).filter(Boolean),
    profile: {
      height: number(env.TRANSCODE_HEIGHT, DEFAULT_PROFILE.height, 144, 1080),
      fps: number(env.TRANSCODE_FPS, DEFAULT_PROFILE.fps, 10, 60),
      videoKbps: number(env.TRANSCODE_VIDEO_KBPS, DEFAULT_PROFILE.videoKbps, 300, 20000),
      audioKbps: number(env.TRANSCODE_AUDIO_KBPS, DEFAULT_PROFILE.audioKbps, 64, 320),
    },
  };
}

function authorized(req, token) {
  const match = /^Bearer (.+)$/.exec(String(req.headers.authorization || ""));
  return !!match && timingSafeEqual(digest(match[1]), digest(token));
}

async function readJson(req) {
  let size = 0;
  const parts = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Request is too large."), { status: 413 });
    parts.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")); }
  catch { throw Object.assign(new Error("Send a JSON body."), { status: 400 }); }
}

/**
 * Movies and episodes must be read by byte range so FFmpeg can seek. FFmpeg
 * reads them from this loopback relay, one random address per job, and the
 * relay makes every provider request itself through the usual address checks
 * (private networks refused, redirects validated). FFmpeg never sees the
 * provider's address or connects anywhere else.
 */
export function createInputRelay({ request = requestRemote, allowedPrivateHosts = [] } = {}) {
  const jobs = new Map();
  const server = http.createServer(async (req, res) => {
    const job = jobs.get(String(req.url || "").slice(1));
    if (!job || !["GET", "HEAD"].includes(req.method)) return res.writeHead(404).end();
    const controller = new AbortController();
    res.once("close", () => controller.abort());
    try {
      const upstream = await request(job.url, {
        method: req.method, headers: req.headers.range ? { Range: req.headers.range } : {},
        allowedPrivateHosts, timeout: 45000, signal: controller.signal,
      });
      const headers = {};
      for (const name of ["content-type", "content-length", "content-range", "accept-ranges"])
        if (upstream.headers[name]) headers[name] = upstream.headers[name];
      res.writeHead(upstream.statusCode, headers);
      if (req.method === "HEAD") { upstream.destroy(); return res.end(); }
      upstream.once("error", () => res.destroy());
      upstream.pipe(res);
    } catch {
      if (res.headersSent) res.destroy(); else res.writeHead(502).end();
    }
  });
  const ready = new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    async register(url) {
      await ready;
      const id = randomBytes(18).toString("base64url");
      jobs.set(id, { url });
      return { url: `http://127.0.0.1:${server.address().port}/${id}`, release: () => jobs.delete(id) };
    },
    get open() { return jobs.size; },
    close() { server.close(); server.closeAllConnections(); },
  };
}

/** Reads a file's duration and codecs through the relay. */
export function createFileProbe({ ffprobe = "ffprobe", run = execFile } = {}) {
  return (url) => new Promise((resolve, reject) =>
    run(ffprobe, fileProbeArguments(url), { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) return reject(Object.assign(new Error("This title could not be read."), { status: 502 }));
      try { resolve(describeProbe(JSON.parse(stdout))); }
      catch { reject(Object.assign(new Error("This title could not be read."), { status: 502 })); }
    }));
}

export function createTranscoderHandler({ token, transcoder, profile = DEFAULT_PROFILE, allowedPrivateHosts = [], prebufferMs = 0, relay = null, probe = null, request = requestRemote, log = console }) {
  const json = (res, status, body) => {
    if (res.headersSent) return res.destroy();
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
  };
  return async (req, res) => {
    const controller = new AbortController();
    res.once("close", () => { if (!res.writableFinished) controller.abort(); });
    try {
      if (req.method === "GET" && req.url === "/health")
        return json(res, 200, { ok: true, encoder: transcoder.encoder, active: transcoder.active, limit: transcoder.limit });
      if (req.method !== "POST" || !["/transcode", "/probe"].includes(req.url)) return json(res, 404, { error: "Not found" });
      if (!authorized(req, token)) return json(res, 401, { error: "A valid transcoder token is required." });
      const body = await readJson(req);
      let source;
      try { source = validateRemoteUrl(String(body?.url || "")); }
      catch { return json(res, 400, { error: "Send the title's http(s) address." }); }
      // Movies and episodes: describe the file so TesPlay can decide whether it needs converting.
      if (req.url === "/probe") {
        if (!relay || !probe) return json(res, 404, { error: "This transcoder does not convert movies." });
        const entry = await relay.register(source.toString());
        try { return json(res, 200, await probe(entry.url)); }
        finally { entry.release(); }
      }
      const vod = body?.mode === "vod";
      if (vod && !relay) return json(res, 404, { error: "This transcoder does not convert movies." });
      if (transcoder.active >= transcoder.limit)
        return json(res, 503, { error: "Too many titles are converting right now. Try again shortly." });
      // The player chooses the size; the bitrate follows it. Files keep their own
      // frame rate unless TesPlay asks for 30 (a 50/60 fps source).
      const sized = profileForHeight(profile, body?.height);
      let job, entry = null;
      if (vod) {
        const start = Number(body?.start);
        entry = await relay.register(source.toString());
        job = transcoder.start({
          file: { url: entry.url, start: Number.isFinite(start) && start > 0 && start < 86400 ? start : 0 },
          signal: controller.signal,
          profile: { ...sized, fps: Number(body?.fps) === 30 ? 30 : null },
        });
        job.exit.finally(() => entry.release());
      } else {
        const upstream = await request(source.toString(), {
          allowedPrivateHosts, timeout: 45000, signal: controller.signal,
        });
        if (upstream.statusCode >= 400) {
          upstream.resume();
          return json(res, 502, { error: `Media provider returned HTTP ${upstream.statusCode}.` });
        }
        const contentType = String(upstream.headers["content-type"] || "application/octet-stream");
        if (!/^(?:video\/|audio\/|application\/octet-stream(?:;|$))/i.test(contentType)) {
          upstream.destroy();
          return json(res, 502, { error: "The provider returned an unsupported media response." });
        }
        job = transcoder.start({ input: upstream, signal: controller.signal, profile: sized });
      }
      let sent = 0;
      // A live conversion arrives in real time, so the player can only stay as
      // far ahead as it starts. Hold the first seconds and send them at once.
      // A file converts faster than real time and needs no head start.
      let held = prebufferMs > 0 && !vod ? [] : null;
      let holdTimer;
      const release = () => {
        clearTimeout(holdTimer);
        if (!held) return;
        for (const chunk of held) res.write(chunk);
        held = null;
      };
      job.output.on("data", (chunk) => {
        sent += chunk.length;
        if (!res.headersSent) res.writeHead(200, { "content-type": "video/mp2t", "cache-control": "no-store" });
        if (held) {
          held.push(chunk);
          holdTimer ??= setTimeout(release, prebufferMs);
          return;
        }
        if (!res.write(chunk)) {
          job.output.pause();
          res.once("drain", () => job.output.resume());
        }
      });
      // A conversion that never produces output is stuck on the provider.
      const watchdog = setTimeout(() => { if (!sent) job.stop(); }, FIRST_BYTES_MS);
      res.once("close", () => { clearTimeout(watchdog); clearTimeout(holdTimer); job.stop(); });
      const { error, code, stderr } = await job.exit;
      clearTimeout(watchdog);
      release();
      if (controller.signal.aborted || res.writableFinished) return;
      if (sent) return res.end();
      // FFmpeg only sees pipes, so its messages name no provider address or credential.
      log.warn?.(`Car-mode conversion ended (exit ${code ?? error?.code ?? "?"}): ${String(stderr || "").trim().slice(0, 500)}`);
      return json(res, error?.code === "ENOENT" ? 503 : 502, { error: error?.code === "ENOENT" ? "FFmpeg is not installed on the transcoder." : vod ? "This title could not be converted." : "This channel could not be converted." });
    } catch (error) {
      if (controller.signal.aborted) return;
      json(res, error.status && error.status < 600 ? error.status : 502, { error: error.message || "The transcoder failed." });
    }
  };
}

async function main() {
  const config = transcoderConfig();
  if (config.token.length < 24) {
    console.error("Set TRANSCODER_TOKEN to a random secret of at least 24 characters (for example: openssl rand -hex 32).");
    process.exit(1);
  }
  const detected = await detectEncoder({ ffmpeg: config.ffmpeg, device: config.device, preference: config.encoder });
  if (!detected.encoder) {
    console.error("No working video encoder:", JSON.stringify(detected.failures));
    process.exit(1);
  }
  for (const [name, reason] of Object.entries(detected.failures)) console.warn(`Encoder ${name} unavailable: ${reason}`);
  const transcoder = createTranscoder({ ffmpeg: config.ffmpeg, limit: config.limit, encoder: detected.encoder, device: config.device, profile: config.profile });
  const relay = createInputRelay({ allowedPrivateHosts: config.allowedPrivateHosts });
  const probe = createFileProbe({ ffprobe: config.ffprobe });
  const server = http.createServer(createTranscoderHandler({ token: config.token, transcoder, profile: config.profile, allowedPrivateHosts: config.allowedPrivateHosts, prebufferMs: config.prebufferMs, relay, probe }));
  server.listen(config.port, "0.0.0.0", () =>
    console.log(`TesPlay car-mode transcoder on port ${config.port}: ${detected.encoder} encoder, ${config.profile.height}p${config.profile.fps}, up to ${config.limit} channels`));
  const stop = () => { server.close(); server.closeAllConnections(); relay.close(); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
