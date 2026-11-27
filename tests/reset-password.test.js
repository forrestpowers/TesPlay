import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../server/index.js';

const run = promisify(execFile);
const script = new URL('../scripts/reset-password.mjs', import.meta.url).pathname;
const original = 'original owner password';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'tesplay-reset-'));
  const instance = await createApp({ dataDir, setupToken: 'fixture-owner-setup', quiet: true });
  const server = instance.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, cookie = '') => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body) });
  const setup = await post('/api/auth/setup', { name: 'Owner', email: 'owner@tesplay.test', password: original, setupToken: 'fixture-owner-setup' });
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); instance.close(); await rm(dataDir, { recursive: true, force: true }); });
  const login = (password) => post('/api/auth/login', { email: 'owner@tesplay.test', password });
  const signedIn = async () => (await (await fetch(base + '/api/auth/status', { headers: { cookie } })).json()).user !== null;
  return { dataDir, login, signedIn };
}

test('the reset script gives the owner a new generated password and signs them out', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.signedIn(), true);
  const { stdout } = await run('node', [script, 'OWNER@tesplay.test'], { env: { ...process.env, DATA_DIR: f.dataDir } });
  assert.match(stdout, /Password updated for Owner \(.+, owner\)\. Signed out of 1 session\./);
  const generated = /New password: (\S+)/.exec(stdout)[1];
  assert.equal(generated.length, 20);
  assert.equal((await f.login(original)).status, 401);
  assert.equal((await f.login(generated)).status, 200);
  assert.equal(await f.signedIn(), false, 'existing sessions end');
});

test('the reset script accepts a chosen password on standard input and validates it', async (t) => {
  const f = await fixture(t);
  const env = { ...process.env, DATA_DIR: f.dataDir };
  const chosen = 'a chosen replacement password';
  const child = execFile('node', [script, 'owner@tesplay.test', '--stdin'], { env });
  child.stdin.end(chosen + '\n');
  const stdout = await new Promise((resolve, reject) => { let out = ''; child.stdout.on('data', (d) => { out += d; }); child.once('exit', (code) => code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))); });
  assert.ok(!stdout.includes(chosen), 'a chosen password is never printed');
  assert.equal((await f.login(chosen)).status, 200);
  const short = execFile('node', [script, 'owner@tesplay.test', '--stdin'], { env });
  short.stdin.end('too short');
  assert.equal(await new Promise((resolve) => short.once('exit', resolve)), 1);
  await assert.rejects(run('node', [script, 'nobody'], { env }), (error) => /No account "nobody"\. Accounts: .+ \(owner\)/.test(error.stderr));
});
