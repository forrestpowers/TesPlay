import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { createApp } from '../server/index.js';

async function load(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  return import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
}
const layout = await load('../src/home-layout.ts');

test('the saved home order applies, and new sections keep their default place', () => {
  const defaults = ['libraries', 'continue:iptv', 'continue:youtube', 'shelf:a', 'shelf:b', 'my-list', 'youtube-card'];
  assert.deepEqual(layout.arrangeHomeSections(defaults, null), defaults);
  // Saved before shelf:b and continue:youtube existed.
  const saved = { order: ['my-list', 'shelf:a', 'libraries', 'continue:iptv', 'youtube-card'], hidden: [] };
  assert.deepEqual(layout.arrangeHomeSections(defaults, saved), ['my-list', 'shelf:a', 'shelf:b', 'libraries', 'continue:iptv', 'continue:youtube', 'youtube-card']);
  // Sections that no longer exist are ignored, and duplicates are dropped.
  assert.deepEqual(layout.arrangeHomeSections(['libraries', 'my-list'], { order: ['gone', 'my-list', 'my-list', 'libraries'], hidden: [] }), ['my-list', 'libraries']);
});

test('moving and hiding sections', () => {
  const order = ['a', 'b', 'c'];
  assert.deepEqual(layout.moveHomeSection(order, 'b', -1), ['b', 'a', 'c']);
  assert.deepEqual(layout.moveHomeSection(order, 'b', 1), ['a', 'c', 'b']);
  assert.equal(layout.moveHomeSection(order, 'a', -1), order, 'the first cannot move up');
  assert.equal(layout.moveHomeSection(order, 'c', 1), order, 'the last cannot move down');
  assert.deepEqual(layout.toggleHomeSection(['x'], 'y'), ['x', 'y']);
  assert.deepEqual(layout.toggleHomeSection(['x', 'y'], 'x'), ['y']);
});

test('saving keeps sections that are absent right now where they were', () => {
  // continue:youtube is empty today; the user moves my-list to the top.
  const saved = ['continue:youtube', 'libraries', 'shelf:a', 'my-list'];
  assert.deepEqual(layout.persistHomeOrder(saved, ['my-list', 'libraries', 'shelf:a']), ['continue:youtube', 'my-list', 'libraries', 'shelf:a']);
  assert.deepEqual(layout.persistHomeOrder(['libraries', 'continue:youtube', 'shelf:a'], ['shelf:a', 'libraries']), ['shelf:a', 'libraries', 'continue:youtube']);
  assert.deepEqual(layout.persistHomeOrder(undefined, ['a', 'b']), ['a', 'b']);
});

test('only IPTV and YouTube are offered; retired connection types keep a name so they can be removed', async () => {
  const catalog = await load('../src/catalog.ts');
  assert.deepEqual(catalog.services.map((s) => s.id), ['xtream', 'youtube']);
  for (const type of ['plex', 'stremio', 'drive', 'local']) assert.ok(catalog.isRetiredService(type) && catalog.retiredServices[type], type);
  assert.equal(catalog.isRetiredService('xtream'), false);
});

test('the home arrangement is saved with the account, validated and can be reset', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tesplay-home-'));
  const instance = await createApp({ dataDir, setupToken: 'fixture-owner-setup', quiet: true });
  const server = instance.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); instance.close(); await rm(dataDir, { recursive: true, force: true }); });
  let cookie = '';
  const request = async (path, body, method = body ? 'POST' : 'GET') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const set = response.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: response.status, data: await response.json().catch(() => null) };
  };
  await request('/api/auth/setup', { name: 'Owner', email: 'owner@tesplay.test', password: 'owner password for home', setupToken: 'fixture-owner-setup' });
  const homeLayout = { order: ['my-list', 'libraries', 'shelf:abc:category:1'], hidden: ['youtube-card'] };
  assert.equal((await request('/api/settings', { preferences: { homeLayout } }, 'PATCH')).status, 200);
  await request('/api/settings', { preferences: { carMode: '720' } }, 'PATCH');
  assert.deepEqual((await request('/api/settings')).data.preferences, { autoPlayNext: true, carMode: '720', homeLayout }, 'other preferences leave it alone');
  for (const invalid of [{ order: 'x', hidden: [] }, { order: [], hidden: [1] }, { order: [], hidden: [], extra: 1 }, [], 'layout'])
    assert.equal((await request('/api/settings', { preferences: { homeLayout: invalid } }, 'PATCH')).status, 400, JSON.stringify(invalid));
  assert.equal((await request('/api/settings', { preferences: { homeLayout: null } }, 'PATCH')).status, 200);
  assert.deepEqual((await request('/api/settings')).data.preferences, { autoPlayNext: true, carMode: '720' }, 'reset to the default arrangement');
});
