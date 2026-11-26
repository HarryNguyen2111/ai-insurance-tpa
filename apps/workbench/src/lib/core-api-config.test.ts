import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CORE_API_ORIGIN, parseCoreApiOrigin } from './core-api-config.ts';

test('defaults to the documented loopback core-api origin when unset or blank', () => {
  assert.deepEqual(parseCoreApiOrigin(undefined), { ok: true, origin: DEFAULT_CORE_API_ORIGIN });
  assert.deepEqual(parseCoreApiOrigin('   '), { ok: true, origin: DEFAULT_CORE_API_ORIGIN });
});

test('accepts only plain-HTTP loopback origins and normalises them', () => {
  assert.deepEqual(parseCoreApiOrigin('http://127.0.0.1:4010'), { ok: true, origin: 'http://127.0.0.1:4010' });
  assert.deepEqual(parseCoreApiOrigin('http://localhost:4010/'), { ok: true, origin: 'http://localhost:4010' });
  assert.deepEqual(parseCoreApiOrigin('http://[::1]:4010'), { ok: true, origin: 'http://[::1]:4010' });
});

test('rejects non-loopback hosts so the probe cannot be pointed at other systems', () => {
  for (const raw of ['http://10.0.0.5:3000', 'http://example.com', 'http://127.0.0.1.nip.io:3000', 'http://0.0.0.0:3000', 'http://169.254.169.254']) {
    assert.deepEqual(parseCoreApiOrigin(raw), { ok: false, reason: 'NOT_LOOPBACK' }, raw);
  }
});

test('rejects credentials, paths, queries, fragments, other schemes and garbage', () => {
  for (const raw of ['http://u:p@127.0.0.1:3000', 'http://127.0.0.1:3000/v1/claims', 'http://127.0.0.1:3000?x=1', 'http://127.0.0.1:3000#a', 'https://127.0.0.1:3000', 'file:///etc/passwd']) {
    assert.deepEqual(parseCoreApiOrigin(raw), { ok: false, reason: 'UNSUPPORTED_FORM' }, raw);
  }
  assert.deepEqual(parseCoreApiOrigin('not a url'), { ok: false, reason: 'INVALID_URL' });
});
