import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
function moduleUrl(path, replacements = {}) {
  let code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  for (const [name, url] of Object.entries(replacements)) code = code.replaceAll(`'${name}'`, `'${url}'`).replaceAll(`"${name}"`, `"${url}"`);
  return 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
}
const apiUrl = moduleUrl('../src/api.ts');
const preferencesUrl = moduleUrl('../src/player-preferences.ts');
const { playbackPath, resolvePlayback, readYouTubeHeight, writeYouTubeHeight } = await import(moduleUrl('../src/playback-selection.ts', { './api': apiUrl, './player-preferences': preferencesUrl, mediabunny: import.meta.resolve('mediabunny') }));
const defaults = { audioLanguage: null, subtitleLanguage: null, subtitlesEnabled: false, qualityId: 'auto' };

test('the YouTube size chosen on this screen is kept and sent with later YouTube videos only', async (t) => {
  const saved = new Map(), requests = [];
  const old = { fetch: globalThis.fetch, location: globalThis.location, localStorage: globalThis.localStorage };
  globalThis.localStorage = { getItem: (k) => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, String(v)), removeItem: (k) => saved.delete(k) };
  globalThis.location = { origin: 'https://tesplay.test', href: 'https://tesplay.test/' };
  globalThis.fetch = async (input) => { requests.push(String(input)); return Response.json({ url: '/api/media/x', type: 'video' }); };
  t.after(() => { for (const [k, v] of Object.entries(old)) if (v === undefined) delete globalThis[k]; else globalThis[k] = v; });

  assert.equal(readYouTubeHeight(), null, 'automatic until chosen');
  writeYouTubeHeight(1080); assert.equal(readYouTubeHeight(), 1080);
  writeYouTubeHeight(2160); assert.equal(readYouTubeHeight(), null, 'only sizes YouTube offers in H.264');
  writeYouTubeHeight(480);

  const video = { id: 'abcdefghijk', type: 'video', connectionId: 'yt1', providerType: 'youtube' };
  await resolvePlayback(video, {}, new AbortController().signal, defaults);
  assert.equal(new URL(requests.at(-1), 'https://tesplay.test').searchParams.get('height'), '480');
  await resolvePlayback({ id: 'link', type: 'video', playbackUrl: 'https://youtu.be/abcdefghijk' }, {}, new AbortController().signal, defaults);
  assert.equal(requests.at(-1), '/api/youtube/resolve/abcdefghijk?height=480');
  await resolvePlayback({ id: '42', type: 'live', connectionId: 'tv', providerType: 'xtream' }, {}, new AbortController().signal, defaults);
  assert.equal(new URL(requests.at(-1), 'https://tesplay.test').searchParams.has('height'), false, 'IPTV is unaffected');
  writeYouTubeHeight(null);
  await resolvePlayback(video, {}, new AbortController().signal, defaults);
  assert.equal(new URL(requests.at(-1), 'https://tesplay.test').searchParams.has('height'), false, 'back to automatic');
  assert.equal(new URL(playbackPath(video, { youtubeHeight: 720 }), 'https://tesplay.test').searchParams.get('height'), '720');
});
