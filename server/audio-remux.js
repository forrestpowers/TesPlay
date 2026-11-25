import { spawn } from "node:child_process";
import { httpError } from "./security.js";

// Live IPTV channels sometimes carry only an AC-3 (Dolby Digital) audio
// track, which browsers cannot decode with WebCodecs. The media proxy opens
// and validates the provider connection, then feeds the continuous MPEG-TS
// through FFmpeg: video is copied untouched and only the audio is re-encoded
// to stereo AAC. FFmpeg is limited to pipes, so it never resolves names or
// opens sockets of its own, and nothing is written to disk.
export function audioRemuxArguments() {
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-protocol_whitelist", "pipe", "-f", "mpegts",
    "-analyzeduration", "2000000", "-probesize", "2000000",
    "-i", "pipe:0",
    "-map", "0:v:0", "-map", "0:a:0", "-sn", "-dn", "-map_metadata", "-1",
    "-c:v", "copy",
    "-c:a", "aac", "-b:a", "160k", "-ac", "2", "-ar", "48000",
    "-threads", "1", "-muxdelay", "0", "-muxpreload", "0",
    "-f", "mpegts", "pipe:1",
  ];
}

export function createAudioRemuxer({
  ffmpeg = process.env.FFMPEG_PATH || "ffmpeg",
  limit = Math.max(1, Number(process.env.AUDIO_REMUX_LIMIT) || 4),
  spawnProcess = spawn,
} = {}) {
  let active = 0;
  return {
    get active() {
      return active;
    },
    // Starts FFmpeg on `input` (a readable MPEG-TS stream) and returns its
    // output stream. `stop` ends the conversion; `exit` resolves once the
    // process has finished, with its bounded stderr for server-side logging.
    start({ input, signal }) {
      if (active >= limit)
        throw httpError(503, "Too many channels are converting audio right now. Try again shortly.");
      active++;
      const child = spawnProcess(ffmpeg, audioRemuxArguments(), {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        if (stderr.length < 4096) stderr += chunk.toString("utf8").slice(0, 4096 - stderr.length);
      });
      const stop = () => {
        input.destroy();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      };
      const exit = new Promise((resolve) => {
        child.once("error", (error) => resolve({ error, stderr }));
        child.once("exit", (code, signalName) => resolve({ code, signal: signalName, stderr }));
      }).finally(() => {
        active--;
      });
      // FFmpeg closes its input after a fatal error; the broken pipe is reported through `exit`.
      child.stdin.on("error", () => {});
      input.once("error", stop);
      input.pipe(child.stdin);
      signal?.addEventListener("abort", stop, { once: true });
      exit.then(() => signal?.removeEventListener("abort", stop));
      return { output: child.stdout, exit, stop };
    },
  };
}
