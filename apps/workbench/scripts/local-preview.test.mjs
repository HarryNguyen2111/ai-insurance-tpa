// Exercises the real launcher against the compiled core-api and production Next build.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const launcher = new URL('./local-preview.mjs', import.meta.url).pathname;

async function freePort() {
  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await new Promise(r => server.close(r));
  return port;
}

const isAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function waitGone(pids, ms = 10000) {
  const deadline = Date.now() + ms;
  while (pids.some(isAlive) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
  return pids.every(p => !isAlive(p));
}

function startLauncher(env, args = []) {
  const child = spawn(process.execPath, [launcher, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', c => { output += c; });
  child.stderr.on('data', c => { output += c; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no READY: ${output}`)), 90000);
    child.stdout.on('data', () => {
      const m = output.match(/READY (http:\/\/127\.0\.0\.1:\d+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`launcher exited ${code}: ${output}`)); });
  });
  return { child, ready, output: () => output };
}

async function setup() {
  const stateDir = mkdtempSync(join(tmpdir(), 'tpa-preview-test-'));
  const env = {
    TPA_PREVIEW_STATE_DIR: stateDir,
    TPA_PREVIEW_API_PORT: String(await freePort()),
    TPA_PREVIEW_WEB_PORT: String(await freePort()),
  };
  return { stateDir, env };
}

test('starts compiled API + production web on loopback, confirms READY, cleans up on SIGTERM', { timeout: 120000 }, async () => {
  const { stateDir, env } = await setup();
  const run = startLauncher(env);
  try {
    const webUrl = await run.ready;
    assert.equal(webUrl, `http://127.0.0.1:${env.TPA_PREVIEW_WEB_PORT}`);
    const state = JSON.parse(readFileSync(join(stateDir, 'preview.json'), 'utf8'));
    assert.equal(state.launcherPid, run.child.pid);
    assert.ok(isAlive(state.api.pid) && isAlive(state.web.pid));

    const page = await fetch(`${webUrl}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Không gian làm việc TPA/);
    const link = await (await fetch(`${webUrl}/api/backend-health`)).json();
    assert.equal(link.state, 'ONLINE');
    const health = await fetch(`http://127.0.0.1:${env.TPA_PREVIEW_API_PORT}/health`);
    assert.deepEqual(await health.json(), { status: 'ok' });
    assert.match(run.output(), /\[core-api\] .*Listening on http:\/\/127\.0\.0\.1:/);
    assert.ok(existsSync(join(stateDir, 'logs/workbench.log')));

    run.child.kill('SIGTERM');
    const [code] = await once(run.child, 'exit');
    assert.equal(code, 0);
    assert.ok(await waitGone([state.api.pid, state.web.pid]), 'owned children must be gone');
    assert.equal(existsSync(join(stateDir, 'preview.json')), false);
    await assert.rejects(fetch(`${webUrl}/`, { signal: AbortSignal.timeout(1000) }));
  } finally {
    if (run.child.exitCode === null) run.child.kill('SIGKILL');
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('--stop stops a running launcher and all of its recorded children', { timeout: 120000 }, async () => {
  const { stateDir, env } = await setup();
  const run = startLauncher(env);
  try {
    await run.ready;
    const state = JSON.parse(readFileSync(join(stateDir, 'preview.json'), 'utf8'));
    const second = startLauncher(env);
    await assert.rejects(second.ready, /đã chạy/, 'a second launcher must refuse to start');
    const stop = spawn(process.execPath, [launcher, '--stop'], { env: { ...process.env, ...env }, stdio: 'ignore' });
    const [stopCode] = await once(stop, 'exit');
    assert.equal(stopCode, 0);
    assert.ok(await waitGone([run.child.pid, state.api.pid, state.web.pid]));
    assert.equal(existsSync(join(stateDir, 'preview.json')), false);
  } finally {
    if (run.child.exitCode === null) run.child.kill('SIGKILL');
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('refuses to start when a port is taken and never touches the foreign process', { timeout: 30000 }, async () => {
  const { stateDir, env } = await setup();
  const blocker = createServer();
  await new Promise(r => blocker.listen(Number(env.TPA_PREVIEW_API_PORT), '127.0.0.1', r));
  try {
    const run = startLauncher(env);
    await assert.rejects(run.ready, /đang bị chiếm/);
    assert.notEqual(run.child.exitCode, 0);
    assert.equal(blocker.listening, true);
    assert.equal(existsSync(join(stateDir, 'preview.json')), false);
  } finally {
    await new Promise(r => blocker.close(r));
    rmSync(stateDir, { recursive: true, force: true });
  }
});
