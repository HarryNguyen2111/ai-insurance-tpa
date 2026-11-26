#!/usr/bin/env node
// Local preview launcher (issue #68): starts the COMPILED Nest core-api and the
// PRODUCTION Next.js workbench on 127.0.0.1 only, waits until both really respond,
// prints READY with the URL, and owns cleanup of exactly the processes it started.
//
//   pnpm preview:local   (root: builds, then runs this)      Ctrl+C stops both
//   pnpm preview:stop    (root: stops a running launcher recorded in the state file)
//
// Env: TPA_PREVIEW_API_PORT (3000), TPA_PREVIEW_WEB_PORT (3100),
//      TPA_PREVIEW_STATE_DIR (<repo>/.preview), TPA_PREVIEW_READY_TIMEOUT_MS (60000).
// Host is fixed to 127.0.0.1 and cannot be overridden. No Docker is used; this
// demonstrates process liveness only, not dependency/platform readiness.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const scriptDir = dirname(fileURLToPath(import.meta.url));
const workbenchDir = resolve(scriptDir, '..');
const repoRoot = resolve(workbenchDir, '../..');
const coreApiDir = join(repoRoot, 'apps/core-api');
const stateDir = process.env.TPA_PREVIEW_STATE_DIR ? resolve(process.env.TPA_PREVIEW_STATE_DIR) : join(repoRoot, '.preview');
const stateFile = join(stateDir, 'preview.json');
const logDir = join(stateDir, 'logs');

function log(message) {
  process.stdout.write(`[preview] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[preview] LỖI / ERROR: ${message}\n`);
  process.exit(1);
}

function parsePort(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail(`${name} phải là số nguyên 1024–65535`);
  return port;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function cmdlineOf(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
  } catch {
    return null; // non-Linux or gone; callers then rely on the PID alone
  }
}

// Only signal a PID if it is still the process we started (guards against PID reuse).
function ownsPid(pid, marker) {
  if (!isAlive(pid)) return false;
  const cmd = cmdlineOf(pid);
  return cmd === null || cmd.includes(marker);
}

function readState() {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

async function portIsFree(port) {
  return new Promise(resolvePort => {
    const server = createServer();
    server.once('error', () => resolvePort(false));
    server.listen(port, HOST, () => server.close(() => resolvePort(true)));
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForExit(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(isAlive) && Date.now() < deadline) await sleep(100);
  return pids.every(pid => !isAlive(pid));
}

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}

async function stopCommand() {
  const state = readState();
  if (!state) {
    log('Không có bản xem trước nào đang chạy (không có tệp trạng thái).');
    return;
  }
  if (ownsPid(state.launcherPid, 'local-preview.mjs')) {
    log(`Gửi SIGTERM tới launcher PID ${state.launcherPid}…`);
    process.kill(state.launcherPid, 'SIGTERM');
    await waitForExit([state.launcherPid], 15000);
  }
  // If the launcher was killed hard, its detached children may survive: clean them up.
  const leftovers = [
    [state.api?.pid, 'dist/main.js'],
    [state.web?.pid, 'next'],
  ].filter(([pid, marker]) => pid && ownsPid(pid, marker));
  for (const [pid] of leftovers) killGroup(pid, 'SIGTERM');
  if (!(await waitForExit(leftovers.map(([pid]) => pid), 5000))) {
    for (const [pid] of leftovers) killGroup(pid, 'SIGKILL');
  }
  rmSync(stateFile, { force: true });
  log('Đã dừng. Stopped.');
}

function pipeWithPrefix(stream, prefix, file) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    file.write(chunk);
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) process.stdout.write(`${prefix} ${line}\n`);
  });
}

async function probe(url, check) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'manual' });
    return await check(res);
  } catch {
    return false;
  }
}

async function startCommand() {
  const apiPort = parsePort('TPA_PREVIEW_API_PORT', 3000);
  const webPort = parsePort('TPA_PREVIEW_WEB_PORT', 3100);
  if (apiPort === webPort) fail('Cổng API và web phải khác nhau');
  const readyTimeoutMs = Number(process.env.TPA_PREVIEW_READY_TIMEOUT_MS ?? 60000);

  const apiMain = join(coreApiDir, 'dist/main.js');
  if (!existsSync(apiMain)) fail(`Thiếu ${apiMain}. Chạy "pnpm preview:local" từ thư mục gốc (tự build trước).`);
  if (!existsSync(join(workbenchDir, '.next/BUILD_ID'))) fail('Thiếu bản build Next.js. Chạy "pnpm preview:local" từ thư mục gốc.');

  const existing = readState();
  if (existing && ownsPid(existing.launcherPid, 'local-preview.mjs')) {
    fail(`Bản xem trước đã chạy (launcher PID ${existing.launcherPid}, ${existing.webUrl}). Dừng bằng "pnpm preview:stop".`);
  }
  for (const [label, port] of [['API', apiPort], ['web', webPort]]) {
    if (!(await portIsFree(port))) fail(`Cổng ${label} ${HOST}:${port} đang bị chiếm. Không dừng tiến trình không thuộc launcher; chọn cổng khác qua TPA_PREVIEW_${label === 'API' ? 'API' : 'WEB'}_PORT.`);
  }

  mkdirSync(logDir, { recursive: true });
  const apiUrl = `http://${HOST}:${apiPort}`;
  const webUrl = `http://${HOST}:${webPort}`;
  const nextBin = createRequire(join(workbenchDir, 'package.json')).resolve('next/dist/bin/next');
  const children = new Map();
  let shuttingDown = false;
  let ready = false;

  const shutdown = async (code, reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Đang dừng (${reason})…`);
    const pids = [...children.values()].map(c => c.pid).filter(isAlive);
    for (const pid of pids) killGroup(pid, 'SIGTERM');
    if (!(await waitForExit(pids, 5000))) {
      log('Tiến trình con chưa thoát sau 5s, gửi SIGKILL.');
      for (const pid of pids) killGroup(pid, 'SIGKILL');
      await waitForExit(pids, 2000);
    }
    rmSync(stateFile, { force: true });
    log(`Đã dừng toàn bộ tiến trình do launcher sở hữu (${pids.join(', ') || 'không còn'}). Stopped.`);
    process.exit(code);
  };

  const launch = (name, args, cwd, env) => {
    const file = createWriteStream(join(logDir, `${name}.log`), { flags: 'w' });
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, ...env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group so cleanup reaches Next's workers too
    });
    pipeWithPrefix(child.stdout, `[${name}]`, file);
    pipeWithPrefix(child.stderr, `[${name}]`, file);
    child.on('exit', (code, signal) => {
      file.end();
      if (shuttingDown) return;
      if (name === 'core-api' && ready) {
        log(`core-api đã dừng (code=${code}, signal=${signal}). Web vẫn chạy và sẽ hiển thị "Không kết nối được Core API".`);
        return;
      }
      void shutdown(1, `${name} thoát bất ngờ (code=${code}, signal=${signal})`);
    });
    children.set(name, child);
    return child;
  };

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => void shutdown(0, signal));

  const api = launch('core-api', [apiMain], coreApiDir, { PORT: String(apiPort), HOST });
  const web = launch('workbench', [nextBin, 'start', '--hostname', HOST, '--port', String(webPort)], workbenchDir, {
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    CORE_API_INTERNAL_URL: apiUrl,
  });
  writeFileSync(stateFile, JSON.stringify({
    launcherPid: process.pid,
    api: { pid: api.pid, url: apiUrl },
    web: { pid: web.pid, url: webUrl },
    webUrl,
    logs: logDir,
    startedAt: new Date().toISOString(),
  }, null, 2));
  log(`Launcher PID ${process.pid}; core-api PID ${api.pid}; workbench PID ${web.pid}; logs: ${logDir}`);

  const deadline = Date.now() + readyTimeoutMs;
  for (;;) {
    if (shuttingDown) return;
    const apiOk = await probe(`${apiUrl}/health`, async r => r.status === 200 && (await r.json()).status === 'ok');
    const webOk = await probe(`${webUrl}/`, async r => r.status === 200);
    const linkOk = await probe(`${webUrl}/api/backend-health`, async r => r.status === 200 && (await r.json()).state === 'ONLINE');
    if (apiOk && webOk && linkOk) break;
    if (Date.now() > deadline) return shutdown(1, `chưa sẵn sàng sau ${readyTimeoutMs}ms (api=${apiOk}, web=${webOk}, web→api=${linkOk})`);
    await sleep(300);
  }
  ready = true;
  log(`Core API (liveness): ${apiUrl}/health -> 200 {"status":"ok"}`);
  log(`Web -> Core API qua ${webUrl}/api/backend-health: ONLINE`);
  log(`READY ${webUrl}`);
  log('Mở URL trên trong trình duyệt. Ctrl+C hoặc "pnpm preview:stop" để dừng.');
}

if (process.argv.includes('--stop')) {
  await stopCommand();
} else {
  await startCommand();
}
