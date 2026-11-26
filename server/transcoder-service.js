import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { requestRemote, validateRemoteUrl } from "./media.js";
import { createTranscoder, detectEncoder, DEFAULT_PROFILE, profileForHeight } from "./transcoder.js";

// Car-mode transcoder: a small service for a machine with a GPU (for example an
// Intel mini PC). TesPlay posts a live channel's address; this service opens it,
// converts it to 720p30 H.264 with stereo AAC and streams MPEG-TS back.
// Only requests carrying TRANSCODER_TOKEN are served, so it is not an open relay.

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
    device: env.TRANSCODER_DEVICE || "/dev/dri/renderD128",
    encoder: ["auto", "vaapi", "vaapi-lp", "software"].includes(env.TRANSCODER_ENCODER) ? env.TRANSCODER_ENCODER : "auto",
    limit: number(env.TRANSCODE_LIMIT, 3, 1, 32),
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

export function createTranscoderHandler({ token, transcoder, profile = DEFAULT_PROFILE, allowedPrivateHosts = [], request = requestRemote, log = console }) {
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
      if (req.method !== "POST" || req.url !== "/transcode") return json(res, 404, { error: "Not found" });
      if (!authorized(req, token)) return json(res, 401, { error: "A valid transcoder token is required." });
      const body = await readJson(req);
      let source;
      try { source = validateRemoteUrl(String(body?.url || "")); }
      catch { return json(res, 400, { error: "Send the channel's http(s) address." }); }
      if (transcoder.active >= transcoder.limit)
        return json(res, 503, { error: "Too many channels are in car mode right now. Try again shortly." });
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
      // The player chooses the size (720p or 480p); the bitrate follows it.
      const job = transcoder.start({ input: upstream, signal: controller.signal, profile: profileForHeight(profile, body?.height) });
      let sent = 0;
      job.output.once("data", () => {
        if (!res.headersSent) res.writeHead(200, { "content-type": "video/mp2t", "cache-control": "no-store" });
      });
      job.output.on("data", (chunk) => { sent += chunk.length; });
      job.output.pipe(res, { end: false });
      // A conversion that never produces output is stuck on the provider.
      const watchdog = setTimeout(() => { if (!sent) job.stop(); }, FIRST_BYTES_MS);
      res.once("close", () => { clearTimeout(watchdog); job.stop(); });
      const { error, code, stderr } = await job.exit;
      clearTimeout(watchdog);
      if (controller.signal.aborted || res.writableFinished) return;
      if (sent) return res.end();
      // FFmpeg only sees pipes, so its messages name no provider address or credential.
      log.warn?.(`Car-mode conversion ended (exit ${code ?? error?.code ?? "?"}): ${String(stderr || "").trim().slice(0, 500)}`);
      return json(res, error?.code === "ENOENT" ? 503 : 502, { error: error?.code === "ENOENT" ? "FFmpeg is not installed on the transcoder." : "This channel could not be converted." });
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
  const server = http.createServer(createTranscoderHandler({ token: config.token, transcoder, profile: config.profile, allowedPrivateHosts: config.allowedPrivateHosts }));
  server.listen(config.port, "0.0.0.0", () =>
    console.log(`TesPlay car-mode transcoder on port ${config.port}: ${detected.encoder} encoder, ${config.profile.height}p${config.profile.fps}, up to ${config.limit} channels`));
  const stop = () => { server.close(); server.closeAllConnections(); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
