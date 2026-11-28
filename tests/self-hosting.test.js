import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../server/index.js';

test('self-hosted playback works across browsers without a plan, lease or public signup', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tesplay-self-hosting-'));
  // Old deployment flags must never bring back a payment requirement.
  const instance = await createApp({dataDir, setupToken: 'fixture-setup', quiet: true,
    registrationEnabled: true, billingEnabled: true, streamLimitsEnabled: true});
  const server = instance.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    instance.close();
    await rm(dataDir, {recursive: true, force: true});
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const credentials = {username: 'owner', password: 'self hosted fixture password'};
  const setup = await fetch(origin + '/api/auth/setup', {method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({...credentials, name: 'Owner', setupToken: 'fixture-setup'})});
  assert.equal(setup.status, 201);
  const auth = await setup.json();
  assert.equal(Object.hasOwn(auth, 'registrationEnabled'), false);
  const cookies = [setup.headers.get('set-cookie').split(';')[0]];
  const login = await fetch(origin + '/api/auth/login', {method: 'POST',
    headers: {'Content-Type': 'application/json'}, body: JSON.stringify(credentials)});
  assert.equal(login.status, 200);
  cookies.push(login.headers.get('set-cookie').split(';')[0]);
  // Two browsers of one account each get their own playback ticket at the same time.
  const content = '#EXTM3U\n#EXTINF:-1 group-title="News",News\nhttps://streams.example.test/news.ts';
  const connection = instance.store.saveConnection(auth.user.id,
    {type: 'm3u', name: 'Own TV', config: {content}});
  const channel = (await (await fetch(origin + `/api/catalog?connectionId=${connection.id}&kind=live`, {headers: {cookie: cookies[0]}})).json()).items[0];
  const path = `/api/playback?connectionId=${connection.id}&itemId=${encodeURIComponent(channel.id)}&kind=live`;
  const playback = await Promise.all(cookies.map(cookie => fetch(origin + path, {headers: {cookie}})));
  assert.deepEqual(playback.map(response => response.status), [200, 200]);
  const tickets = await Promise.all(playback.map(response => response.json()));
  for (const ticket of tickets) assert.match(ticket.url, /^\/api\/media\//);
  assert.notEqual(tickets[0].url, tickets[1].url);
  for (const [endpoint, method] of [['/auth/register', 'POST'], ['/billing', 'GET'],
    ['/billing/checkout', 'POST'], ['/billing/cancel', 'POST'], ['/billing/webhook', 'POST'], ['/streams/acquire', 'POST']]) {
    const response = await fetch(origin + '/api' + endpoint, {method, headers: {cookie: cookies[0], ...(method === 'POST' ? {'Content-Type': 'application/json'} : {})}, ...(method === 'POST' ? {body: '{}'} : {})});
    assert.equal(response.status, 404, endpoint);
  }
  const tables = instance.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  for (const name of ['subscriptions', 'subscription_payments', 'stream_leases']) assert.ok(!tables.includes(name));
});
