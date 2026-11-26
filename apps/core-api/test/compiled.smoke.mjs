import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

test('compiled bootstrap serves process health and shuts down on SIGTERM', { timeout: 15000 }, async () => {
  const child = spawn(process.execPath, ['dist/main.js'], {
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Bootstrap timed out: ${output}`)), 8000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`Early exit: ${output}`)); });
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/Listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await response.json(), { status: 'ok' });
    console.log(`GET /health -> ${response.status} {"status":"ok"} (compiled process, ephemeral port)`);
    child.kill('SIGTERM');
    const [code, signal] = await Promise.race([
      exited,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('SIGTERM shutdown timed out')), 3000);
        timer.unref();
      }),
    ]);
    // Nest cleans up and re-raises the shutdown signal on Linux.
    assert.ok(code === 0 || signal === 'SIGTERM');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }
});

test('compiled bootstrap failure exits without leaking the supplied host in errors', { timeout: 15000 }, async () => {
  const marker = 'SYNTHETIC_PII_BOOTSTRAP_FAILURE_MARKER';
  const child = spawn(process.execPath, ['dist/main.js'], {
    env: { ...process.env, PORT: '0', HOST: `${marker}/invalid`, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    const [code, signal] = await Promise.race([
      once(child, 'exit'),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Failure shutdown timed out')), 10000);
        timer.unref();
      }),
    ]);
    assert.equal(code, 1);
    assert.equal(signal, null);
    assert.equal(output.includes(marker), false);
    assert.match(output, /REDACTED_LOG/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
});
