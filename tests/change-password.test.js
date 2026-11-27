import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.js';

const original = 'original owner password';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'tesplay-password-'));
  const instance = await createApp({ dataDir, setupToken: 'fixture-owner-setup', quiet: true });
  const server = instance.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); instance.close(); await rm(dataDir, { recursive: true, force: true }); });
  const client = () => {
    let cookie = '';
    const request = async (path, body, method = body ? 'POST' : 'GET') => {
      const response = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const set = response.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: response.status, data: await response.json().catch(() => null) };
    };
    request.signedIn = async () => (await request('/api/auth/status')).data.user !== null;
    return request;
  };
  const owner = client();
  await owner('/api/auth/setup', { name: 'Owner', email: 'owner@tesplay.test', password: original, setupToken: 'fixture-owner-setup' });
  return { client, owner };
}

test('an owner changes their own password; this device stays signed in and others sign out', async (t) => {
  const { client, owner } = await fixture(t);
  const car = client();
  assert.equal((await car('/api/auth/login', { email: 'owner@tesplay.test', password: original })).status, 200);

  const wrong = await owner('/api/account/password', { currentPassword: 'not the password', newPassword: 'a brand new password' });
  assert.equal(wrong.status, 400, 'a wrong current password is not a session error');
  assert.equal(wrong.data.error, 'Your current password is incorrect.');
  assert.equal((await owner('/api/account/password', { currentPassword: original, newPassword: 'short' })).status, 400);
  const same = await owner('/api/account/password', { currentPassword: original, newPassword: original });
  assert.match(same.data.error, /differs from your current one/);
  assert.equal(await car.signedIn(), true, 'failed attempts change nothing');

  const changed = await owner('/api/account/password', { currentPassword: original, newPassword: 'a brand new password' });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.data, { ok: true, signedOut: 1 });
  assert.equal(await owner.signedIn(), true, 'the device that changed it stays signed in');
  assert.equal(await car.signedIn(), false, 'other devices are signed out');
  const fresh = client();
  assert.equal((await fresh('/api/auth/login', { email: 'owner@tesplay.test', password: original })).status, 401);
  assert.equal((await fresh('/api/auth/login', { email: 'owner@tesplay.test', password: 'a brand new password' })).status, 200);
});

test('household members change their own password, and signed-out requests are refused', async (t) => {
  const { client, owner } = await fixture(t);
  const created = await owner('/api/accounts', { name: 'Passenger', username: 'passenger', password: 'member starting password', grants: [] });
  assert.equal(created.status, 201);
  const member = client();
  assert.equal((await member('/api/auth/login', { username: 'passenger', password: 'member starting password' })).status, 200);
  assert.equal((await member('/api/account/password', { currentPassword: 'member starting password', newPassword: 'member chosen password' })).status, 200);
  assert.equal((await client()('/api/auth/login', { username: 'passenger', password: 'member chosen password' })).status, 200);
  assert.equal((await client()('/api/account/password', { currentPassword: 'x', newPassword: 'whatever password' })).status, 401);
});
