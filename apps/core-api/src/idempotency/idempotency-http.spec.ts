import {
  IDEMPOTENCY_KEY_HEADER, invalidIdempotencyKey, readIdempotencyKey, toIdempotencyHttpResult, type IdempotencyOutcome,
} from './idempotency-http';

const correlationId = '3f1d1a52-7a8e-4c8f-9a51-2f0c1b6f9e10';
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('Idempotency-Key header (OpenAPI IdempotencyKeyValue)', () => {
  it('accepts 16..100 chars of [A-Za-z0-9._:-] and rejects everything else', () => {
    expect(IDEMPOTENCY_KEY_HEADER).toBe('idempotency-key');
    expect(readIdempotencyKey('A'.repeat(16))).toBe('A'.repeat(16));
    expect(readIdempotencyKey('a.b_c:d-e'.padEnd(100, '0'))).toBe('a.b_c:d-e'.padEnd(100, '0'));
    for (const bad of [undefined, '', 'k'.repeat(15), 'k'.repeat(101), 'has space key 00001', 'slash/key/000000001',
      'unicodé-key-000000001', ['dup-key-0000000001', 'dup-key-0000000001']]) {
      expect(readIdempotencyKey(bad)).toBeNull();
    }
  });

  it('invalid key maps to 422 VALIDATION_FAILED without echoing the raw value', () => {
    const result = invalidIdempotencyKey(correlationId);
    expect(result).toEqual({
      status: 422, headers: { 'Cache-Control': 'no-store' },
      body: { code: 'VALIDATION_FAILED', messageVi: expect.any(String), correlationId },
    });
    expect(uuidV4.test((invalidIdempotencyKey().body as { correlationId: string }).correlationId)).toBe(true);
  });
});

describe('idempotency outcome -> HTTP (Error409 + Retry-After, no-store)', () => {
  const response = { status: 201, body: { claimId: 'synthetic', totalRequested: '720000.00' } };

  it('executed and replayed return the original status/body; replay is marked', () => {
    expect(toIdempotencyHttpResult({ kind: 'executed', response, attempt: 1 }, correlationId))
      .toEqual({ status: 201, headers: { 'Cache-Control': 'no-store' }, body: response.body });
    expect(toIdempotencyHttpResult({ kind: 'replayed', response }, correlationId))
      .toEqual({ status: 201, headers: { 'Cache-Control': 'no-store', 'Idempotent-Replayed': 'true' }, body: response.body });
    const domain = { status: 422, body: { code: 'DOMAIN_VIOLATION' } };
    expect(toIdempotencyHttpResult({ kind: 'replayed', response: domain }, correlationId).status).toBe(422);
  });

  it('different payload and expired key are 409 IDEMPOTENCY_CONFLICT without Retry-After', () => {
    for (const kind of ['conflict', 'expired'] as const) {
      const result = toIdempotencyHttpResult({ kind }, correlationId);
      expect(result).toEqual({
        status: 409, headers: { 'Cache-Control': 'no-store' },
        body: { code: 'IDEMPOTENCY_CONFLICT', messageVi: expect.any(String), correlationId },
      });
      expect(result.headers['Retry-After']).toBeUndefined();
    }
  });

  it('in-progress is 409 OPERATION_IN_PROGRESS with integer Retry-After >= 1', () => {
    expect(toIdempotencyHttpResult({ kind: 'in_progress', retryAfterSeconds: 7 }, correlationId)).toEqual({
      status: 409, headers: { 'Cache-Control': 'no-store', 'Retry-After': '7' },
      body: { code: 'OPERATION_IN_PROGRESS', messageVi: expect.any(String), correlationId },
    });
    for (const retryAfterSeconds of [0, -3, 1.5, Number.NaN]) {
      expect(toIdempotencyHttpResult({ kind: 'in_progress', retryAfterSeconds }, correlationId).headers['Retry-After']).toBe('1');
    }
  });

  it('error bodies carry only contract fields and an unknown outcome fails closed', () => {
    const body = toIdempotencyHttpResult({ kind: 'conflict' }, correlationId).body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['code', 'correlationId', 'messageVi']);
    expect((body.messageVi as string).length).toBeLessThanOrEqual(500);
    expect(() => toIdempotencyHttpResult({ kind: 'bogus' } as unknown as IdempotencyOutcome)).toThrow('Unhandled idempotency outcome');
  });
});
