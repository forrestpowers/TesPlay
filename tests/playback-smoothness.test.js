import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { skipForHalfFrameRate } from '../vendor/tesplayer/packages/player/dist/engine.js';
import { DEFAULT_PLAYER_POLICY, PlayerPolicySchema } from '../vendor/tesplayer/packages/contracts/dist/index.js';

const sixty = 1001 / 60000;

test('half frame rate presents every other frame of a 60 fps source on an even cadence', () => {
  const presented = [];
  let last = null;
  for (let index = 0; index < 12; index++) {
    const timestamp = 10 + index * sixty;
    if (skipForHalfFrameRate(sixty, last, timestamp)) continue;
    presented.push(index);
    last = timestamp;
  }
  assert.deepEqual(presented, [0, 2, 4, 6, 8, 10]);
});

test('half frame rate never thins 30 fps or slower sources, nor the first frame or a jump', () => {
  assert.equal(skipForHalfFrameRate(1 / 30, 10, 10 + 1 / 30), false);
  assert.equal(skipForHalfFrameRate(1 / 25, 10, 10 + 1 / 25), false);
  assert.equal(skipForHalfFrameRate(null, 10, 10.01), false);
  assert.equal(skipForHalfFrameRate(sixty, null, 10), false);
  // A timestamp discontinuity backwards, or a gap after missing frames, presents.
  assert.equal(skipForHalfFrameRate(sixty, 10, 9), false);
  assert.equal(skipForHalfFrameRate(sixty, 10, 10 + 3 * sixty), false);
});

test('the frame-rate policy options validate and stay off by default', () => {
  assert.equal(DEFAULT_PLAYER_POLICY.halfFrameRate, false);
  assert.equal(DEFAULT_PLAYER_POLICY.adaptiveFrameRate, false);
  assert.equal(PlayerPolicySchema.parse({ ...DEFAULT_PLAYER_POLICY, halfFrameRate: true }).halfFrameRate, true);
  const { halfFrameRate: _half, adaptiveFrameRate: _adaptive, ...older } = DEFAULT_PLAYER_POLICY;
  assert.ok(PlayerPolicySchema.parse(older));
});

test('playback stats derive source, shown, dropped and skipped frame rates', async () => {
  const source = readFileSync(new URL('../src/PlaybackStats.tsx', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
  const { frameRates } = await import('data:text/javascript;base64,' + Buffer.from(outputText.replace(/^import .*$/gm, '')).toString('base64'));
  const rates = frameRates({ at: 0, rendered: 100, dropped: 10, skipped: 0 }, { at: 2000, rendered: 160, dropped: 20, skipped: 40 });
  assert.deepEqual(rates, { source: 55, shown: 30, dropped: 5, skipped: 20 });
  assert.equal(frameRates({ at: 1000, rendered: 0, dropped: 0, skipped: 0 }, { at: 1000, rendered: 0, dropped: 0, skipped: 0 }), null);
  assert.equal(frameRates({ at: 0, rendered: 0, dropped: 0, skipped: 0 }, { at: 1000, rendered: 0, dropped: 0, skipped: 0 }).source, null);
});

test('after an on-demand start or seek, audio waits for the first video frame at the new position', () => {
  // Long-GOP sources (YouTube) decode seconds of video before the seek point while audio is
  // ready at once; the engine holds the first sound until that frame is decoded (bounded).
  const engine = readFileSync(new URL('../vendor/tesplayer/packages/player/src/engine.ts', import.meta.url), 'utf8');
  const play = engine.slice(engine.indexOf('  private async play('), engine.indexOf('  private async pause('));
  assert.match(play, /pipeline\.videoTrack && pipeline\.audioTrack && !this\.state\.isLive/);
  const video = engine.slice(engine.indexOf('  private async runVideo('), engine.indexOf('  private async waitUntilVideoDue('));
  assert.ok(video.indexOf('mediaTimestamp < start) continue;') < video.indexOf('operation.markVideoReady?.();'), 'ready only after preroll frames are skipped');
  assert.match(video, /finally \{\s*\/\/ TesPlay patch[^\n]*\n\s*operation\.markVideoReady\?\.\(\);/, 'a finished or failed video track releases audio');
  const audio = engine.slice(engine.indexOf('  private async runAudio('), engine.indexOf('  private async runMp2Audio('));
  assert.ok(audio.indexOf('await this.waitForVideoReady(operation);') < audio.indexOf('this.scheduleAudioBuffer('), 'the first buffer waits before it is scheduled');
  assert.match(engine, /const VIDEO_READY_TIMEOUT_MS = 8000;/);
});
