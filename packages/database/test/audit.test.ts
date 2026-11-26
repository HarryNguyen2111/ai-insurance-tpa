import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { canonicalAudit, auditHash, validateAuditInput, verifyAuditChain, GENESIS_HASH, type AuditRecord } from '../src/audit.ts';
const id = '11111111-1111-4111-8111-111111111111';
const input = { entityType: 'SYNTHETIC', entityId: id, actorType: 'SYSTEM' as const,
  actorId: id, action: 'CHANGE', payload: {} };
const body = { tenant_id: id, entity_type: 'SYNTHETIC', entity_id: id, actor_type: 'SYSTEM',
  actor_id: id, action: 'CHANGE', payload_diff: {}, sequence: '1', version: '1',
  occurred_at: '2026-11-26T00:00:00.000Z', prev_hash: GENESIS_HASH };
const row: AuditRecord = { ...body, curr_hash: auditHash(body) };
test('canonical v1 fixed bytes, Unicode/escaping and SHA256 standard vector', () => {
  assert.equal(canonicalAudit({ z: 'Việt\n"', a: { b: '720000.00' } }), '{"a":{"b":"720000.00"},"z":"Việt\\n\\\""}');
  assert.equal(createHash('sha256').update('abc').digest('hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(canonicalAudit({ b: '2', a: '1' }), canonicalAudit({ a: '1', b: '2' }));
  for (const value of [null, undefined, 1, 1n, [], new Date(), { a: 1 }, { a: undefined }]) assert.throws(() => canonicalAudit(value));
});
test('PT17 audit subset rejects raw PII/unknown keys and invalid commitments without echo', () => {
  for (const payload of [{ phone: 'SYNTHETIC_PII_MARKER' }, { before_hash: 'SYNTHETIC_PII_MARKER' },
    { after_hash: 123 }, { document: { raw: 'SYNTHETIC_PII_MARKER' } }, [], null]) {
    assert.throws(() => validateAuditInput({ ...input, payload } as never), error => {
      assert.equal((error as Error).message, 'Invalid minimal audit metadata'); return true;
    });
  }
  validateAuditInput({ ...input, payload: { after_hash: 'a'.repeat(64) } });
});
test('verification detects changes to every committed field, gaps, fork, truncation and invalid UTC/version', () => {
  const expected = { sequence: '1', curr_hash: row.curr_hash };
  assert.equal(verifyAuditChain([row], expected), true);
  for (const key of Object.keys(row)) {
    assert.equal(verifyAuditChain([{ ...row, [key]: key === 'payload_diff' ? { after_hash: 'a'.repeat(64) } : 'tampered' }], expected), false, key);
  }
  assert.equal(verifyAuditChain([], expected), false);
  assert.equal(verifyAuditChain([row, row], expected), false);
  const invalid = { ...body, occurred_at: '2026-11-26T07:00:00+07:00' };
  assert.equal(verifyAuditChain([{ ...invalid, curr_hash: auditHash(invalid) }], expected), false);
});
