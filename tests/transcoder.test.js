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
import { createTranscoder, DEFAULT_PROFILE, detectEncoder, probeArguments, profileForHeight, transcodeArguments } from "../server/transcoder.js";
import { createTranscoderHandler, transcoderConfig } from "../server/transcoder-service.js";
import { carModeTranscoder, createMediaService, requestRemote } from "../server/media.js";

const run = promisify(execFile);
const hasFfmpeg = await run("ffmpeg", ["-version"]).then(() => true, () => false);
const TOKEN = "car-mode-test-token-0123456789";

test("car mode converts to 720p30 H.264 with stereo AAC through pipes only", () => {
  for (const encoder of ["software", "vaapi", "vaapi-lp"]) {
    const args = transcodeArguments({ encoder });
    assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "pipe");
    assert.equal(args[args.indexOf("-i") + 1], "pipe:0");
    assert.equal(args.at(-1), "pipe:1");
    assert.equal(args[args.indexOf("-c:a") + 1], "aac");
    assert.equal(args[args.indexOf("-ac") + 1], "2");
    const filters = args[args.indexOf("-vf") + 1];
    assert.match(filters, /fps=30/);
    assert.match(filters, /h=min\(ih\\,720\)/, "never upscales past 720 lines");
    assert.ok(!args.some((arg) => /^https?:/.test(arg)));
  }
  assert.equal(transcodeArguments({ encoder: "software" })[transcodeArguments({ encoder: "software" }).indexOf("-c:v") + 1], "libx264");
  const gpu = transcodeArguments({ encoder: "vaapi", device: "/dev/dri/renderD129" });
  assert.equal(gpu[gpu.indexOf("-c:v") + 1], "h264_vaapi");
  assert.ok(gpu.includes("vaapi=gpu:/dev/dri/renderD129"));
  assert.ok(!gpu.includes("-low_power"));
  assert.deepEqual(transcodeArguments({ encoder: "vaapi-lp" }).slice(transcodeArguments({ encoder: "vaapi-lp" }).indexOf("-low_power"), transcodeArguments({ encoder: "vaapi-lp" }).indexOf("-low_power") + 2), ["-low_power", "1"]);
  // The startup check exercises the same GPU filters as a real conversion.
  assert.match(probeArguments("vaapi")[probeArguments("vaapi").indexOf("-vf") + 1], /deinterlace_vaapi.*scale_vaapi/);
});

test("the transcoder picks the first encoder that works and reports why others failed", async () => {
  const kind = (args) => args.includes("libx264") ? "software" : args.includes("-low_power") ? "vaapi-lp" : "vaapi";
  const fakeRun = (working) => (_binary, args, _options, done) =>
    kind(args) === working ? done(null, "", "") : done(new Error("failed"), "", "No VA display found");
  assert.equal((await detectEncoder({ run: fakeRun("vaapi") })).encoder, "vaapi");
  const lowPower = await detectEncoder({ run: fakeRun("vaapi-lp") });
  assert.equal(lowPower.encoder, "vaapi-lp");
  assert.match(lowPower.failures.vaapi, /No VA display/);
  assert.equal((await detectEncoder({ run: fakeRun("software") })).encoder, "software");
  assert.equal((await detectEncoder({ run: fakeRun("none") })).encoder, null);
  assert.equal((await detectEncoder({ run: fakeRun("vaapi"), preference: "software" })).encoder, null, "a forced encoder is not substituted");
});

test("car mode sizes scale the bitrate with the picture and ignore unknown heights", () => {
  assert.equal(profileForHeight(DEFAULT_PROFILE, undefined), DEFAULT_PROFILE);
  assert.equal(profileForHeight(DEFAULT_PROFILE, 720), DEFAULT_PROFILE);
  assert.equal(profileForHeight(DEFAULT_PROFILE, 999), DEFAULT_PROFILE);
  assert.equal(profileForHeight(DEFAULT_PROFILE, "../etc"), DEFAULT_PROFILE);
  const small = profileForHeight(DEFAULT_PROFILE, 480);
  assert.deepEqual({ height: small.height, fps: small.fps, videoKbps: small.videoKbps }, { height: 480, fps: 30, videoKbps: 1333 });
  const args = transcodeArguments({ profile: small });
  assert.match(args[args.indexOf("-vf") + 1], /h=min\(ih\\,480\)/);
  assert.equal(args[args.indexOf("-b:v") + 1], "1333k");
});

test("the transcoder service converts at the size each request asks for", async (t) => {
  const started = [];
  const transcoder = { encoder: "software", active: 0, limit: 3, start({ profile }) {
    started.push(profile.height);
    const output = Readable.from([Buffer.alloc(188, 0x47)]);
    return { output, stop() {}, exit: new Promise((resolve) => output.once("end", () => setTimeout(() => resolve({ code: 0 }), 5))) };
  } };
  const base = await serve(t, createTranscoderHandler({ token: TOKEN, transcoder,
    request: async () => Object.assign(Readable.from([Buffer.alloc(188, 0x47)]), { statusCode: 200, headers: { "content-type": "video/mp2t" } }) }));
  for (const height of [480, undefined, 9999]) {
    const response = await fetch(`${base}/transcode`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ url: "http://203.0.113.5/live/u/p/1.ts", height }) });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  assert.deepEqual(started, [480, 720, 720]);
});

test("transcoder settings are bounded and private provider addresses stay refused by default", () => {
  const config = transcoderConfig({ TRANSCODER_TOKEN: TOKEN, TRANSCODE_LIMIT: "500", TRANSCODE_HEIGHT: "4000", TRANSCODER_ENCODER: "bogus" });
  assert.equal(config.limit, 32);
  assert.equal(config.profile.height, 1080);
  assert.equal(config.encoder, "auto");
  assert.deepEqual(config.allowedPrivateHosts, []);
  assert.equal(config.port, 4190);
});

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("the transcoder service requires its token, validates the address and respects its limit", async (t) => {
  const requested = [];
  const transcoder = { encoder: "software", active: 0, limit: 1, start() { throw new Error("not started"); } };
  const base = await serve(t, createTranscoderHandler({ token: TOKEN, transcoder, request: async (url) => { requested.push(url); throw new Error("unreachable"); } }));
  const post = (body, token = TOKEN) => fetch(`${base}/transcode`, { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) });
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true, encoder: "software", active: 0, limit: 1 });
  assert.equal((await post({ url: "http://203.0.113.5/live/1.ts" }, "")).status, 401);
  assert.equal((await post({ url: "http://203.0.113.5/live/1.ts" }, "wrong-token-0123456789-abcdef")).status, 401);
  assert.equal((await post({ url: "file:///etc/passwd" })).status, 400);
  transcoder.active = 1;
  assert.equal((await post({ url: "http://203.0.113.5/live/1.ts" })).status, 503);
  assert.deepEqual(requested, [], "rejected requests never reach the provider");
});

test("the transcoder service converts a provider stream into 720p-capped H.264 and AAC", { skip: !hasFfmpeg }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tesplay-car-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "source.ts");
  await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=60", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "2", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "ac3", "-ac", "6", "-y", "-f", "mpegts", input], { timeout: 20_000 });
  const body = await readFile(input);
  const transcoder = createTranscoder({ encoder: "software", limit: 1 });
  const base = await serve(t, createTranscoderHandler({
    token: TOKEN, transcoder,
    request: async () => Object.assign(Readable.from([body]), { statusCode: 200, headers: { "content-type": "video/mp2t" } }),
  }));
  const response = await fetch(`${base}/transcode`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ url: "http://203.0.113.5/live/u/p/1.ts" }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "video/mp2t");
  const output = join(directory, "car.ts");
  await writeFile(output, Buffer.from(await response.arrayBuffer()));
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,height,avg_frame_rate,channels", "-of", "json", output]);
  const streams = JSON.parse(stdout).streams;
  assert.deepEqual(streams.find((s) => s.codec_name === "h264") && { height: streams.find((s) => s.codec_name === "h264").height, fps: streams.find((s) => s.codec_name === "h264").avg_frame_rate }, { height: 180, fps: "30/1" });
  assert.equal(streams.find((s) => s.codec_name === "aac")?.channels, 2);
  assert.equal(transcoder.active, 0);
});

test("car mode needs both a transcoder address and a long token", () => {
  assert.equal(carModeTranscoder("", TOKEN), null);
  assert.equal(carModeTranscoder("https://transcode.example.com", "short"), null);
  const configured = carModeTranscoder("https://transcode.example.com/base", TOKEN);
  assert.equal(configured.endpoint, "https://transcode.example.com/base/transcode");
  assert.deepEqual(configured.allowedPrivateHosts, ["transcode.example.com"]);
  assert.throws(() => carModeTranscoder("ftp://transcode.example.com", TOKEN));
  assert.equal(carModeTranscoder("https://transcode.example.com", TOKEN).connectHost, undefined);
  assert.equal(carModeTranscoder("https://transcode.example.com", TOKEN, " gerbil ").connectHost, "gerbil");
});

// The media proxy relays the transcoder: route its outbound request to a local
// fake transcoder by rewriting only the transport destination.
async function proxyFor(t, transcoderHandler, configured = true) {
  const received = [];
  const fake = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    received.push({ path: req.url, authorization: req.headers.authorization, body: text ? JSON.parse(text) : null });
    transcoderHandler(req, res);
  });
  await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const original = http.request;
  http.request = (url, options, callback) => original(new URL(`http://127.0.0.1:${fake.address().port}${url.pathname}`), { ...options, agent: false, lookup: undefined }, callback);
  const service = createMediaService({ getProfileId: () => "profile", getConnection: () => null,
    ...(configured ? { transcoderUrl: "http://203.0.113.40:4190", transcoderToken: TOKEN } : { transcoderUrl: "", transcoderToken: "" }) });
  const app = express();
  app.use((req, _res, next) => { req.user = { id: "viewer" }; next(); });
  app.get("/api/media/:token", service.handler);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const viewer = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => viewer.once("listening", resolve));
  t.after(async () => {
    http.request = original;
    fake.closeAllConnections(); viewer.closeAllConnections();
    await Promise.all([new Promise((resolve) => fake.close(resolve)), new Promise((resolve) => viewer.close(resolve))]);
  });
  const path = service.register({ user: { id: "viewer" } }, null, { url: "http://203.0.113.21/live/user/secret/7.ts", kind: "video", remux: "video", transcodeHeight: 480 });
  return { base: `http://127.0.0.1:${viewer.address().port}`, path, service, received };
}

test("the media proxy relays car mode through the transcoder with its token", async (t) => {
  const { base, path, service, received } = await proxyFor(t, (_req, res) => {
    res.writeHead(200, { "content-type": "video/mp2t" });
    res.end(Buffer.alloc(188 * 3, 0x47));
  });
  assert.equal(service.carModeAvailable, true);
  const response = await fetch(base + path);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "video/mp2t");
  assert.equal((await response.arrayBuffer()).byteLength, 188 * 3);
  assert.equal(received.length, 1);
  assert.equal(received[0].path, "/transcode");
  assert.equal(received[0].authorization, `Bearer ${TOKEN}`);
  assert.equal(received[0].body.url, "http://203.0.113.21/live/user/secret/7.ts");
  assert.equal(received[0].body.height, 480);
});

test("car mode failures name the cause without exposing the provider address", async (t) => {
  const { base, path } = await proxyFor(t, (_req, res) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Too many channels are in car mode right now. Try again shortly." }));
  });
  const response = await fetch(base + path);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.match(body.error, /^Car mode is unavailable: Too many channels/);
  assert.ok(!JSON.stringify(body).includes("secret"));
});

test("without a transcoder, a car-mode stream reports that it needs one", async (t) => {
  const { base, path, service, received } = await proxyFor(t, () => {}, false);
  assert.equal(service.carModeAvailable, false);
  const response = await fetch(base + path);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /needs a transcoder/);
  assert.equal(received.length, 0);
});

test("car mode explains a wrong transcoder token", async (t) => {
  const { base, path } = await proxyFor(t, (_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "A valid transcoder token is required." }));
  });
  const response = await fetch(base + path);
  // The player reads the explanation only from a JSON response.
  assert.match(response.headers.get("content-type"), /application\/json/);
  const body = await response.json();
  assert.equal(body.error, "Car mode is unavailable: A valid transcoder token is required.");
});

test("car mode explains a login page in place of the transcoder", async (t) => {
  const { base, path } = await proxyFor(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html>Sign in to Pangolin</html>");
  });
  const response = await fetch(base + path);
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.match(body.error, /web page instead of video.*Pangolin login/);
  assert.ok(!JSON.stringify(body).includes("secret"));
});

test("car mode explains an unreachable transcoder", async (t) => {
  const { base, path } = await proxyFor(t, (req) => req.socket.destroy());
  const body = await (await fetch(base + path)).json();
  assert.match(body.error, /cannot reach the transcoder at 203\.0\.113\.40:4190 \(ECONNRESET\)\..*TRANSCODER_CONNECT_HOST/);
});

test("a connection address replaces DNS for the configured host only", async () => {
  // The URL names a public address, but the connection goes to the configured host.
  await assert.rejects(requestRemote("http://203.0.113.40:4190/health", { connectHost: "transcoder.invalid", timeout: 2000 }), /could not be resolved/);
});

test("car mode explains a Pangolin sign-in redirect", async (t) => {
  const { base, path } = await proxyFor(t, (_req, res) => {
    res.writeHead(302, { location: "https://pangolin.example.com/auth/resource/1" });
    res.end();
  });
  const body = await (await fetch(base + path)).json();
  assert.match(body.error, /redirected TesPlay to a sign-in page\. Turn off the Pangolin login/);
});
