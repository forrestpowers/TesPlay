import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { audioRemuxArguments, createAudioRemuxer } from "../server/audio-remux.js";
import { createMediaService } from "../server/media.js";

const run = promisify(execFile);
const hasFfmpeg = await run("ffmpeg", ["-version"]).then(() => true, () => false);

test("FFmpeg only reads and writes pipes, copies the video and encodes stereo AAC", () => {
  const args = audioRemuxArguments();
  assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "pipe");
  assert.equal(args[args.indexOf("-i") + 1], "pipe:0");
  assert.equal(args.at(-1), "pipe:1");
  assert.equal(args[args.indexOf("-c:v") + 1], "copy");
  assert.equal(args[args.indexOf("-c:a") + 1], "aac");
  assert.equal(args[args.indexOf("-ac") + 1], "2");
  assert.ok(!args.some((arg) => /^https?:/.test(arg)));
});

// Serves `body` for every request, routed through the media proxy's DNS and
// address validation by rewriting the transport destination only.
async function viewerFor(t, remuxer, body, { drip = false } = {}) {
  const provider = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "video/mp2t" });
    if (!drip) return res.end(body);
    let offset = 0;
    const timer = setInterval(() => {
      if (offset >= body.length) offset = 0;
      res.write(body.subarray(offset, offset + 4096));
      offset += 4096;
    }, 5);
    res.once("close", () => clearInterval(timer));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const original = http.request;
  http.request = (url, options, callback) => original(new URL(`http://127.0.0.1:${provider.address().port}${url.pathname}`), { ...options, agent: false, lookup: undefined }, callback);
  const service = createMediaService({ getProfileId: () => "profile", getConnection: () => null, audioRemuxer: remuxer });
  const app = express();
  app.use((req, _res, next) => { req.user = { id: "viewer" }; next(); });
  app.get("/api/media/:token", service.handler);
  app.head("/api/media/:token", service.handler);
  app.delete("/api/media/:token", service.releaseHandler);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const viewer = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => viewer.once("listening", resolve));
  t.after(async () => {
    http.request = original;
    provider.closeAllConnections(); viewer.closeAllConnections();
    await Promise.all([new Promise((resolve) => provider.close(resolve)), new Promise((resolve) => viewer.close(resolve))]);
  });
  const path = service.register({ user: { id: "viewer" } }, null, { url: "http://203.0.113.21/live/user/secret/7.ts", kind: "video", remux: "audio" });
  return { base: `http://127.0.0.1:${viewer.address().port}`, path, service };
}

async function fixtureTs(directory) {
  const input = join(directory, "ac3.ts");
  await run("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=128x96:rate=12",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "2", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "ac3", "-ac", "6", "-y", "-f", "mpegts", input,
  ], { timeout: 20_000 });
  return readFile(input);
}

test("an AC-3 live channel is served as H.264 with stereo AAC in one continuous MPEG-TS stream", { skip: !hasFfmpeg }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tesplay-remux-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remuxer = createAudioRemuxer();
  const { base, path } = await viewerFor(t, remuxer, await fixtureTs(directory));
  const head = await fetch(base + path, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-type"), "video/mp2t");
  assert.equal(remuxer.active, 0, "a HEAD probe must not start a conversion");
  const response = await fetch(base + path);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "video/mp2t");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const output = join(directory, "converted.ts");
  await writeFile(output, Buffer.from(await response.arrayBuffer()));
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_streams", "-of", "json", output]);
  const streams = JSON.parse(stdout).streams;
  assert.deepEqual(streams.map((stream) => stream.codec_name).sort(), ["aac", "h264"]);
  assert.equal(streams.find((stream) => stream.codec_type === "audio").channels, 2);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(remuxer.active, 0);
});

test("a viewer who leaves stops FFmpeg, and the conversion limit answers 503", { skip: !hasFfmpeg }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tesplay-remux-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const children = [];
  const remuxer = createAudioRemuxer({ limit: 1, spawnProcess: (...args) => { const child = spawn(...args); children.push(child); return child; } });
  const { base, path } = await viewerFor(t, remuxer, await fixtureTs(directory), { drip: true });
  const controller = new AbortController();
  const response = await fetch(base + path, { signal: controller.signal });
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.ok(first.value?.length > 0, "converted bytes must stream before the source ends");
  assert.equal(remuxer.active, 1);
  const refused = await fetch(base + path);
  assert.equal(refused.status, 503);
  assert.match((await refused.json()).error, /converting audio/);
  controller.abort();
  const child = children[0];
  await new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("exit", resolve)));
  assert.equal(child.signalCode, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(remuxer.active, 0);
});

test("a server without FFmpeg reports the missing dependency instead of a generic failure", async (t) => {
  const remuxer = createAudioRemuxer({ ffmpeg: join(tmpdir(), "tesplay-missing-ffmpeg-binary") });
  const { base, path } = await viewerFor(t, remuxer, Buffer.alloc(188 * 4, 0x47));
  const response = await fetch(base + path);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /requires FFmpeg/);
});
