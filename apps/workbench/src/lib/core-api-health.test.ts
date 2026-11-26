import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { checkCoreApiHealth } from './core-api-health.ts';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function withServer(handler: Handler, run: (origin: string, seen: string[]) => Promise<void>): Promise<void> {
  const seen: string[] = [];
  const server: Server = createServer((req, res) => { seen.push(`${req.method} ${req.url}`); handler(req, res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, seen);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

const json = (status: number, body: string): Handler => (_req, res) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
};

test('ONLINE only for GET /health -> 200 {"status":"ok"}, reported as liveness scope', async () => {
  await withServer(json(200, '{"status":"ok"}'), async (origin, seen) => {
    const report = await checkCoreApiHealth({ ok: true, origin }, { now: () => new Date('2026-11-26T04:00:00Z') });
    assert.equal(report.state, 'ONLINE');
    assert.equal(report.scope, 'PROCESS_LIVENESS_ONLY');
    assert.equal(report.httpStatus, 200);
    assert.equal(report.checkedAt, '2026-11-26T04:00:00.000Z');
    assert.equal(typeof report.latencyMs, 'number');
    assert.deepEqual(seen, ['GET /health']);
    assert.equal(JSON.stringify(report).includes(origin), false, 'internal address must not be echoed');
  });
});

test('UNEXPECTED_RESPONSE for non-200, redirects, wrong bodies, invalid JSON and oversized bodies', async () => {
  const cases: [Handler, string][] = [
    [json(500, '{"status":"ok"}'), 'NON_200_STATUS'],
    [json(404, '{"statusCode":404}'), 'NON_200_STATUS'],
    [(_q, r) => { r.writeHead(302, { location: 'http://example.com/' }); r.end(); }, 'NON_200_STATUS'],
    [json(200, '{"status":"degraded"}'), 'UNEXPECTED_BODY'],
    [json(200, '{"status":"ok","db":"ok"}'), 'UNEXPECTED_BODY'],
    [json(200, '["ok"]'), 'UNEXPECTED_BODY'],
    [json(200, '<html>'), 'INVALID_JSON'],
    [json(200, `{"status":"ok","pad":"${'x'.repeat(4096)}"}`), 'BODY_TOO_LARGE'],
  ];
  for (const [handler, detail] of cases) {
    await withServer(handler, async origin => {
      const report = await checkCoreApiHealth({ ok: true, origin });
      assert.equal(report.state, 'UNEXPECTED_RESPONSE', detail);
      assert.equal(report.detail, detail);
    });
  }
});

test('UNREACHABLE on timeout without waiting for a hung backend', async () => {
  await withServer(() => { /* never respond */ }, async origin => {
    const started = Date.now();
    const report = await checkCoreApiHealth({ ok: true, origin }, { timeoutMs: 200 });
    assert.equal(report.state, 'UNREACHABLE');
    assert.equal(report.detail, 'TIMEOUT');
    assert.ok(Date.now() - started < 2000);
  });
});

test('UNREACHABLE when nothing listens on the configured port', async () => {
  let origin = '';
  await withServer(json(200, '{}'), async o => { origin = o; });
  const report = await checkCoreApiHealth({ ok: true, origin });
  assert.equal(report.state, 'UNREACHABLE');
  assert.equal(report.detail, 'CONNECTION_FAILED');
  assert.equal(report.httpStatus, null);
});

test('MISCONFIGURED never performs a request', async () => {
  let called = false;
  const report = await checkCoreApiHealth({ ok: false, reason: 'NOT_LOOPBACK' }, {
    fetchImpl: async () => { called = true; throw new Error('must not fetch'); },
  });
  assert.equal(called, false);
  assert.equal(report.state, 'MISCONFIGURED');
  assert.equal(report.detail, 'CONFIG_NOT_LOOPBACK');
});
