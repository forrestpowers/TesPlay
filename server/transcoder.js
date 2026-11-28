import { spawn, execFile } from "node:child_process";
import { httpError } from "./security.js";

// Car mode: a live IPTV channel is converted to a lighter stream for screens
// that struggle with 1080p or 60 fps video, such as a car browser on LTE.
// Video becomes H.264 at up to 720p and 30 fps, audio becomes stereo AAC, in
// one continuous MPEG-TS stream. FFmpeg reads and writes pipes only: the
// service opens and validates the provider connection itself, so FFmpeg never
// resolves names or opens sockets, and nothing is written to disk.

export const DEFAULT_PROFILE = Object.freeze({ height: 720, fps: 30, videoKbps: 3000, audioKbps: 128 });
/** Output heights a request may ask for; the player offers 720p and 480p. */
export const CAR_MODE_HEIGHTS = Object.freeze([360, 480, 540, 720, 1080]);

/**
 * The profile for one request. A requested height scales the configured
 * bitrate with the picture area (720p at 3000 kbps gives 480p about 1330 kbps);
 * an unknown or missing height keeps the configured profile.
 */
export function profileForHeight(base = DEFAULT_PROFILE, height) {
  const requested = Number(height);
  if (!CAR_MODE_HEIGHTS.includes(requested) || requested === base.height) return base;
  const scale = (requested / base.height) ** 2;
  return { ...base, height: requested, videoKbps: Math.min(20000, Math.max(300, Math.round(base.videoKbps * scale))) };
}

const input = ["-nostdin", "-hide_banner", "-loglevel", "error",
  "-protocol_whitelist", "pipe", "-f", "mpegts",
  "-analyzeduration", "3000000", "-probesize", "3000000"];
/**
 * Movies and episodes are files that FFmpeg must seek in, so it reads them by
 * byte range from the service's loopback relay, which validates every
 * provider request. Only ordinary video containers are accepted, so a "movie"
 * that is really a playlist cannot make FFmpeg fetch other addresses.
 */
export const FILE_FORMATS = "mov,matroska,webm,mpegts,avi,flv,mpeg";
function fileInput(source) {
  const start = Number(source.start) > 0 ? ["-ss", String(Math.floor(Number(source.start)))] : [];
  return ["-protocol_whitelist", "http,tcp", "-format_whitelist", FILE_FORMATS, ...start, "-i", source.url];
}

function output(profile) {
  const kbps = Math.round(profile.videoKbps);
  return [
    "-b:v", `${kbps}k`, "-maxrate", `${Math.round(kbps * 1.2)}k`, "-bufsize", `${kbps * 2}k`,
    // A keyframe about every two seconds lets the player join and recover quickly.
    "-g", String((profile.fps || 30) * 2),
    // IPTV audio often has small timestamp gaps or jumps; resample against the
    // timestamps so the player gets continuous sound instead of clicks.
    "-af", "aresample=async=1000",
    "-c:a", "aac", "-b:a", `${Math.round(profile.audioKbps)}k`, "-ac", "2", "-ar", "48000",
    "-muxdelay", "0", "-muxpreload", "0", "-f", "mpegts", "pipe:1",
  ];
}

/**
 * FFmpeg arguments for one conversion.
 * encoder: "vaapi" (Intel/AMD GPU), "vaapi-lp" (low-power GPU encoder, which
 * some Intel chips such as the N97 offer exclusively) or "software" (libx264).
 */
export function transcodeArguments({ encoder = "software", device = "/dev/dri/renderD128", profile = DEFAULT_PROFILE, source = null } = {}) {
  const map = ["-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", "-map_metadata", "-1"];
  // Never upscale: a source already at or below the target height keeps its size.
  const height = `min(ih\\,${profile.height})`;
  // Live channels are capped at 30 fps; files keep their own rate unless it is higher.
  const fps = profile.fps ? `fps=${profile.fps},` : "";
  const reading = source ? fileInput(source) : [...input.slice(4), "-i", "pipe:0"];
  if (encoder === "vaapi" || encoder === "vaapi-lp") {
    return [
      "-nostdin", "-hide_banner", "-loglevel", "error",
      "-init_hw_device", `vaapi=gpu:${device}`, "-filter_hw_device", "gpu",
      "-hwaccel", "vaapi", "-hwaccel_device", "gpu", "-hwaccel_output_format", "vaapi",
      ...reading, ...map,
      // Frames the GPU could not decode arrive in memory; upload those too.
      // Films are progressive; live TV may be interlaced. 10-bit HEVC becomes 8-bit here.
      "-vf", `format=nv12|vaapi,hwupload,${source ? "" : "deinterlace_vaapi=auto=1,"}${fps}scale_vaapi=w=-2:h=${height}:format=nv12`,
      "-c:v", "h264_vaapi", "-profile:v", "high",
      ...(encoder === "vaapi-lp" ? ["-low_power", "1"] : []),
      ...output(profile),
    ];
  }
  return [
    ...(source ? ["-nostdin", "-hide_banner", "-loglevel", "error", ...reading] : [...input, "-i", "pipe:0"]), ...map,
    "-vf", `yadif=mode=send_frame:deint=interlaced,${fps}scale=w=-2:h=${height}`,
    "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", "-pix_fmt", "yuv420p",
    ...output(profile),
  ];
}

/** Arguments for a one-second synthetic encode that shows whether an encoder works here. */
export function probeArguments(encoder, device = "/dev/dri/renderD128") {
  const source = ["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-t", "1"];
  if (encoder === "software")
    return ["-nostdin", "-hide_banner", "-loglevel", "error", ...source, "-c:v", "libx264", "-preset", "veryfast", "-f", "null", "-"];
  // Exercise the same GPU filters as a real conversion, so an unsupported
  // filter falls back at startup instead of failing every channel.
  return ["-nostdin", "-hide_banner", "-loglevel", "error",
    "-init_hw_device", `vaapi=gpu:${device}`, "-filter_hw_device", "gpu", ...source,
    "-vf", `format=nv12,hwupload,deinterlace_vaapi=auto=1,fps=30,scale_vaapi=w=-2:h=min(ih\\,${DEFAULT_PROFILE.height}):format=nv12`,
    "-c:v", "h264_vaapi",
    ...(encoder === "vaapi-lp" ? ["-low_power", "1"] : []), "-f", "null", "-"];
}

/** Picks the first encoder that completes a short test encode. */
export async function detectEncoder({ ffmpeg = "ffmpeg", device = "/dev/dri/renderD128", preference = "auto", run = execFile } = {}) {
  const candidates = preference === "auto" ? ["vaapi", "vaapi-lp", "software"] : [preference];
  const failures = {};
  for (const encoder of candidates) {
    const error = await new Promise((resolve) =>
      run(ffmpeg, probeArguments(encoder, device), { timeout: 20000, windowsHide: true }, (failure, _stdout, stderr) =>
        resolve(failure ? String(stderr || failure.message).trim().slice(0, 300) : null)));
    if (error === null) return { encoder, failures };
    failures[encoder] = error;
  }
  return { encoder: null, failures };
}

export function createTranscoder({
  ffmpeg = process.env.FFMPEG_PATH || "ffmpeg",
  limit = Math.max(1, Number(process.env.TRANSCODE_LIMIT) || 3),
  encoder = "software",
  device = "/dev/dri/renderD128",
  profile = DEFAULT_PROFILE,
  spawnProcess = spawn,
} = {}) {
  let active = 0;
  return {
    get active() { return active; },
    get limit() { return limit; },
    get encoder() { return encoder; },
    // Starts FFmpeg on `input` (a readable MPEG-TS stream) and returns its
    // output stream. `stop` ends the conversion; `exit` resolves once the
    // process has finished, with its bounded stderr for logging.
    start({ input: source, file = null, signal, profile: requested = profile }) {
      if (active >= limit)
        throw httpError(503, "Too many channels are in car mode right now. Try again shortly.");
      active++;
      const child = spawnProcess(ffmpeg, transcodeArguments({ encoder, device, profile: requested, source: file }), {
        stdio: [file ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        if (stderr.length < 4096) stderr += chunk.toString("utf8").slice(0, 4096 - stderr.length);
      });
      const stop = () => {
        source?.destroy();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      };
      const exit = new Promise((resolve) => {
        child.once("error", (error) => resolve({ error, stderr }));
        child.once("exit", (code, signalName) => resolve({ code, signal: signalName, stderr }));
      }).finally(() => { active--; });
      if (source) {
        // FFmpeg closes its input after a fatal error; the broken pipe is reported through `exit`.
        child.stdin.on("error", () => {});
        source.once("error", stop);
        source.pipe(child.stdin);
      }
      signal?.addEventListener("abort", stop, { once: true });
      exit.then(() => signal?.removeEventListener("abort", stop));
      return { output: child.stdout, exit, stop };
    },
  };
}

/**
 * ffprobe arguments that describe a file: its duration and first video and
 * audio streams. It reads through the same relay and container list as a
 * conversion.
 */
export function fileProbeArguments(url) {
  return ["-v", "error", "-protocol_whitelist", "http,tcp", "-format_whitelist", FILE_FORMATS,
    "-show_entries", "format=duration:stream=codec_type,codec_name,height,avg_frame_rate,r_frame_rate",
    "-of", "json", url];
}

const rate = (value) => {
  const [n, d] = String(value || "").split("/").map(Number);
  return d > 0 && n > 0 ? n / d : null;
};
/** The parts of ffprobe's report TesPlay needs to choose between direct play and conversion. */
export function describeProbe(report) {
  const streams = Array.isArray(report?.streams) ? report.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const duration = Number(report?.format?.duration);
  return {
    durationSeconds: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
    video: video ? { codec: String(video.codec_name || ""), height: Number(video.height) || null, fps: rate(video.avg_frame_rate) ?? rate(video.r_frame_rate) } : null,
    audio: audio ? { codec: String(audio.codec_name || "") } : null,
  };
}
