import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import express from "express";
import { createTranscoder, describeProbe, fileProbeArguments, transcodeArguments, FILE_FORMATS } from "../server/transcoder.js";
import { createFileProbe, createInputRelay, createTranscoderHandler } from "../server/transcoder-service.js";
import { createMediaService } from "../server/media.js";
import { titleNeedsConversion } from "../server/providers.js";

const run = promisify(execFile);
const hasFfmpeg = await run("ffmpeg", ["-version"]).then(() => true, () => false);
const TOKEN = "vod-transcode-test-token-0123456789";

test("files are read through the relay from a start position, with only ordinary containers", () => {
  for (const encoder of ["software", "vaapi", "vaapi-lp"]) {
    const args = transcodeArguments({ encoder, source: { url: "http://127.0.0.1:9/job", start: 754.9 }, profile: { height: 1080, fps: null, videoKbps: 6750, audioKbps: 128 } });
    assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "http,tcp");
    assert.equal(args[args.indexOf("-format_whitelist") + 1], FILE_FORMATS);
    assert.equal(args[args.indexOf("-ss") + 1], "754");
    assert.ok(args.indexOf("-ss") < args.indexOf("-i"), "input seeking, before the input");
    assert.equal(args[args.indexOf("-i") + 1], "http://127.0.0.1:9/job");
    const filters = args[args.indexOf("-vf") + 1];
    assert.ok(!/fps=/.test(filters), "a film keeps its own frame rate");
    assert.ok(!/deinterlace_vaapi/.test(filters));
    assert.match(filters, /min\(ih\\,1080\)/);
    assert.equal(args.at(-1), "pipe:1");
  }
  const capped = transcodeArguments({ encoder: "software", source: { url: "http://127.0.0.1:9/job", start: 0 }, profile: { height: 1080, fps: 30, videoKbps: 6750, audioKbps: 128 } });
  assert.match(capped[capped.indexOf("-vf") + 1], /fps=30,/);
  assert.ok(!capped.includes("-ss"), "no seek from the start");
  assert.deepEqual(fileProbeArguments("http://127.0.0.1:9/job").slice(1, 6), ["error", "-protocol_whitelist", "http,tcp", "-format_whitelist", FILE_FORMATS]);
});

test("a probe report becomes duration and codecs", () => {
  assert.deepEqual(describeProbe({ format: { duration: "7265.4" }, streams: [
    { codec_type: "video", codec_name: "hevc", height: 2160, avg_frame_rate: "24000/1001" },
    { codec_type: "audio", codec_name: "eac3" }, { codec_type: "audio", codec_name: "aac" },
  ] }), { durationSeconds: 7265, video: { codec: "hevc", height: 2160, fps: 24000 / 1001 }, audio: { codec: "eac3" } });
  assert.deepEqual(describeProbe({}), { durationSeconds: null, video: null, audio: null });
});

test("only titles the browser cannot decode are converted", () => {
  assert.equal(titleNeedsConversion({ video: { codec: "hevc" }, audio: { codec: "aac" } }), true);
  assert.equal(titleNeedsConversion({ video: { codec: "h264" }, audio: { codec: "ac3" } }), true);
  assert.equal(titleNeedsConversion({ video: { codec: "h264" }, audio: { codec: "eac3" } }), true);
  assert.equal(titleNeedsConversion({ video: { codec: "h264" }, audio: { codec: "aac" } }), false);
  assert.equal(titleNeedsConversion({ video: { codec: "h264" }, audio: null }), false);
  assert.equal(titleNeedsConversion({ video: null, audio: { codec: "aac" } }), false, "nothing to convert without video");
});

test("the relay forwards byte ranges through the address checks and serves only live jobs", async (t) => {
  const asked = [];
  const relay = createInputRelay({
    request: async (url, options) => {
      asked.push({ url, range: options.headers.Range ?? null, privateHosts: options.allowedPrivateHosts });
      return Object.assign(Readable.from([Buffer.from("abcd")]), { statusCode: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 10-13/100", "content-length": "4", "set-cookie": "secret" } });
    },
    allowedPrivateHosts: ["nas.local"],
  });
  t.after(() => relay.close());
  const job = await relay.register("http://203.0.113.9/movie/user/secret/1.mp4");
  assert.match(job.url, /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{24}$/);
  const response = await fetch(job.url, { headers: { Range: "bytes=10-13" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 10-13/100");
  assert.equal(response.headers.get("set-cookie"), null, "only media headers pass");
  assert.equal(await response.text(), "abcd");
  assert.deepEqual(asked, [{ url: "http://203.0.113.9/movie/user/secret/1.mp4", range: "bytes=10-13", privateHosts: ["nas.local"] }]);
  job.release();
  assert.equal((await fetch(job.url)).status, 404, "a finished job's address stops working");
  assert.equal((await fetch(job.url.replace(/\/[^/]+$/, "/guess"))).status, 404);
});

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("the service probes files and converts them from the requested position without a head start", async (t) => {
  const started = [];
  const transcoder = { encoder: "software", active: 0, limit: 3, start({ file, profile }) {
    started.push({ start: file.start, fps: profile.fps, height: profile.height, relay: /^http:\/\/127\.0\.0\.1:/.test(file.url) });
    const output = Readable.from([Buffer.alloc(188, 0x47)]);
    return { output, stop() {}, exit: new Promise((resolve) => output.once("end", () => setTimeout(() => resolve({ code: 0 }), 5))) };
  } };
  const relay = createInputRelay({ request: async () => { throw new Error("not used"); } });
  t.after(() => relay.close());
  const base = await serve(t, createTranscoderHandler({ token: TOKEN, transcoder, relay, prebufferMs: 5000,
    probe: async (url) => ({ durationSeconds: 5400, video: { codec: "hevc", height: 2160, fps: 23.976 }, audio: { codec: "eac3" }, readThrough: /^http:\/\/127\.0\.0\.1:/.test(url) }) }));
  const post = (path, body) => fetch(base + path, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
  assert.equal((await fetch(base + "/probe", { method: "POST", body: "{}" })).status, 401);
  assert.deepEqual(await (await post("/probe", { url: "http://203.0.113.9/movie/u/p/1.mkv" })).json(),
    { durationSeconds: 5400, video: { codec: "hevc", height: 2160, fps: 23.976 }, audio: { codec: "eac3" }, readThrough: true });
  assert.equal(relay.open, 0, "the probe's relay address is released");
  const began = performance.now();
  const response = await post("/transcode", { url: "http://203.0.113.9/movie/u/p/1.mkv", mode: "vod", start: 1800, height: 1080 });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.ok(performance.now() - began < 2000, "no live head start for files");
  await post("/transcode", { url: "http://203.0.113.9/movie/u/p/2.mkv", mode: "vod", start: -5, height: 1080, fps: 30 });
  assert.deepEqual(started, [{ start: 1800, fps: null, height: 1080, relay: true }, { start: 0, fps: 30, height: 1080, relay: true }]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(relay.open, 0, "conversion relay addresses are released when they end");
});

test("an H.265 movie with its index at the end converts from a later position", { skip: !hasFfmpeg }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tesplay-vod-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "movie.mp4");
  // No faststart: the index sits at the end, so reading it needs byte ranges.
  await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "8", "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error", "-tag:v", "hvc1", "-c:a", "ac3", "-y", source], { timeout: 60_000 }).catch(() => t.skip("FFmpeg without libx265"));
  const body = await readFile(source).catch(() => null);
  if (!body) return;
  const ranges = [];
  const provider = await serve(t, (req, res) => {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
    ranges.push(req.headers.range || "full");
    const start = m ? Number(m[1]) : 0, end = m && m[2] ? Number(m[2]) : body.length - 1;
    res.writeHead(m ? 206 : 200, { "content-type": "video/mp4", "content-length": end - start + 1, "accept-ranges": "bytes", ...(m ? { "content-range": `bytes ${start}-${end}/${body.length}` } : {}) });
    res.end(body.subarray(start, end + 1));
  });
  // The relay's checks refuse loopback; route its requests to the local provider instead.
  const relay = createInputRelay({ request: (url, options) => new Promise((resolve, reject) => {
    const target = new URL(new URL(url).pathname, provider);
    http.request(target, { method: options.method, headers: options.headers }, resolve).on("error", reject).end();
  }) });
  t.after(() => relay.close());
  const base = await serve(t, createTranscoderHandler({ token: TOKEN, transcoder: createTranscoder({ encoder: "software", limit: 1 }), relay, probe: createFileProbe() }));
  const post = (path, payload) => fetch(base + path, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(payload) });
  const probed = await (await post("/probe", { url: "http://203.0.113.9/movie/u/p/1.mp4" })).json();
  assert.equal(probed.video.codec, "hevc");
  assert.equal(probed.audio.codec, "ac3");
  assert.equal(probed.durationSeconds, 8);
  const response = await post("/transcode", { url: "http://203.0.113.9/movie/u/p/1.mp4", mode: "vod", start: 5, height: 1080 });
  assert.equal(response.status, 200);
  const output = join(directory, "out.ts");
  await writeFile(output, Buffer.from(await response.arrayBuffer()));
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,height,avg_frame_rate,channels:format=duration", "-of", "json", output]);
  const report = JSON.parse(stdout);
  const video = report.streams.find((s) => s.codec_name === "h264");
  assert.deepEqual({ height: video.height, fps: video.avg_frame_rate }, { height: 180, fps: "24/1" });
  assert.equal(report.streams.find((s) => s.codec_name === "aac")?.channels, 2);
  assert.ok(Number(report.format.duration) > 2 && Number(report.format.duration) < 4, `about 3 s from 0:05, got ${report.format.duration}`);
  assert.ok(ranges.some((range) => range !== "full" && range !== "bytes=0-"), "the index at the end was read by range");
});

test("the media proxy asks the transcoder for a file conversion from the saved position", async (t) => {
  const received = [];
  const fake = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    received.push(JSON.parse(text));
    res.writeHead(200, { "content-type": "video/mp2t" });
    res.end(Buffer.alloc(188, 0x47));
  });
  await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const original = http.request;
  http.request = (url, options, callback) => original(new URL(`http://127.0.0.1:${fake.address().port}${url.pathname}`), { ...options, agent: false, lookup: undefined }, callback);
  const service = createMediaService({ getProfileId: () => "profile", getConnection: () => null, transcoderUrl: "http://203.0.113.40:4190", transcoderToken: TOKEN });
  const app = express();
  app.use((req, _res, next) => { req.user = { id: "viewer" }; next(); });
  app.get("/api/media/:token", service.handler);
  const viewer = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => viewer.once("listening", resolve));
  t.after(async () => { http.request = original; fake.closeAllConnections(); viewer.closeAllConnections(); await Promise.all([new Promise((r) => fake.close(r)), new Promise((r) => viewer.close(r))]); });
  const path = service.register({ user: { id: "viewer" } }, null, { url: "http://203.0.113.21/movie/user/secret/7.mkv", kind: "video", remux: "vod", transcodeStart: 1234, transcodeHeight: 1080, transcodeFps: 30 });
  const response = await fetch(`http://127.0.0.1:${viewer.address().port}${path}`);
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.deepEqual(received, [{ url: "http://203.0.113.21/movie/user/secret/7.mkv", height: 1080, mode: "vod", start: 1234, fps: 30 }]);
});
