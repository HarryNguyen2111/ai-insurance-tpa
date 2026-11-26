import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createServer, type AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';

const workbenchDir = resolve(import.meta.dirname, '..');
const coreApiDir = resolve(workbenchDir, '../core-api');
const nextBin = createRequire(join(workbenchDir, 'package.json')).resolve('next/dist/bin/next');

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>(r => server.close(() => r()));
  return port;
}

export interface Owned { name: string; child: ChildProcess; output: () => string }

function launch(name: string, args: string[], cwd: string, env: Record<string, string>, readyPattern: RegExp): Promise<Owned> {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let output = '';
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', c => { output += c; });
  return new Promise((resolveOwned, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} not ready: ${output}`)), 30_000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`${name} exited ${code}: ${output}`)); });
    child.stdout!.on('data', c => {
      output += c;
      if (readyPattern.test(output)) { clearTimeout(timer); child.removeAllListeners('exit'); resolveOwned({ name, child, output: () => output }); }
    });
  });
}

export function startCoreApi(port: number): Promise<Owned> {
  return launch('core-api', ['dist/main.js'], coreApiDir, { PORT: String(port), HOST: '127.0.0.1' }, /Listening on http:\/\/127\.0\.0\.1:\d+/);
}

export function startWeb(port: number, coreApiUrl: string): Promise<Owned> {
  return launch('workbench', [nextBin, 'start', '--hostname', '127.0.0.1', '--port', String(port)], workbenchDir,
    { NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', CORE_API_INTERNAL_URL: coreApiUrl }, /Ready in/);
}

// Stops only the process group this helper started.
export async function stop(owned: Owned | undefined): Promise<void> {
  if (!owned || owned.child.exitCode !== null || owned.child.signalCode !== null) return;
  const exited = once(owned.child, 'exit');
  try { process.kill(-owned.child.pid!, 'SIGTERM'); } catch { owned.child.kill('SIGTERM'); }
  const timer = setTimeout(() => { try { process.kill(-owned.child.pid!, 'SIGKILL'); } catch { /* gone */ } }, 5000);
  await exited;
  clearTimeout(timer);
}
