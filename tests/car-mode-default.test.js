import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { createApp } from '../server/index.js';

async function fixture(t, env = {}) {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const dataDir = await mkdtemp(join(tmpdir(), 'tesplay-carmode-'));
  const instance = await createApp({ dataDir, setupToken: 'fixture-owner-setup', quiet: true });
  for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
  const server = instance.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); instance.close(); await rm(dataDir, { recursive: true, force: true }); });
  let cookie = '';
  const request = async (path, body, method = body ? 'POST' : 'GET') => {
    const response = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const set = response.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: response.status, data: await response.json().catch(() => null) };
  };
  await request('/api/auth/setup', { name: 'Owner', email: 'owner@tesplay.test', password: 'owner password for car mode', setupToken: 'fixture-owner-setup' });
  return request;
}

test('the account car mode default is saved, validated and kept with the other preferences', async (t) => {
  const request = await fixture(t);
  const initial = (await request('/api/settings')).data;
  assert.equal(initial.carModeAvailable, false, 'no transcoder configured');
  assert.equal(initial.preferences.carMode, undefined, 'unset means off');
  assert.equal((await request('/api/settings', { preferences: { carMode: '480' } }, 'PATCH')).status, 200);
  assert.equal((await request('/api/settings')).data.preferences.carMode, '480');
  // Another preference change leaves the car mode default alone, and vice versa.
  await request('/api/settings', { preferences: { autoPlayNext: false } }, 'PATCH');
  assert.deepEqual((await request('/api/settings')).data.preferences, { autoPlayNext: false, carMode: '480' });
  await request('/api/settings', { preferences: { carMode: 'off' } }, 'PATCH');
  assert.deepEqual((await request('/api/settings')).data.preferences, { autoPlayNext: false, carMode: 'off' });
  for (const invalid of ['1080', 480, true, '']) assert.equal((await request('/api/settings', { preferences: { carMode: invalid } }, 'PATCH')).status, 400, String(invalid));
});

test('settings report car mode as available once a transcoder is configured', async (t) => {
  const request = await fixture(t, { TRANSCODER_URL: 'https://transcode.example.com', TRANSCODER_TOKEN: 'car-mode-default-token-0123456789' });
  assert.equal((await request('/api/settings')).data.carModeAvailable, true);
});

test('a channel uses its own car mode choice first, then the account default', async () => {
  const source = await readFile(new URL('../src/device-preferences.ts', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  const m = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
  assert.equal(m.effectiveCarMode('a', undefined), null);
  assert.equal(m.effectiveCarMode('a', 'off'), null);
  assert.equal(m.effectiveCarMode('a', '720'), 720);
  assert.equal(m.effectiveCarMode('a', '480'), 480);
  m.writeCarModeOverride('a', 'off');
  assert.equal(m.effectiveCarMode('a', '720'), null, 'turning it off for this channel beats the default');
  assert.equal(m.effectiveCarMode('b', '720'), 720, 'another channel starts from the default');
  m.writeCarModeOverride('a', 480);
  assert.equal(m.effectiveCarMode('a', 'off'), 480, 'choosing a size for this channel beats an off default');
  m.clearCarMode();
  assert.equal(m.effectiveCarMode('a', '720'), 720, 'closing the player returns to the default');
});
